/** Session runtime: the composition root wiring state, scheduling, messaging
 * and runners into one host (corresponds to the host composition of the
 * original platform, in-process form). The demo and integration tests build
 * one of these and drive it through the same messaging surfaces the real
 * product exposes. */

import { RunLifecycle, RunScheduler } from "@open-grokbot/core";
import type { AgentSession, AgentSessionRegistry, GroupMemberRunner, MessagingHub, TurnRunner } from "@open-grokbot/messaging";
import { AgentToAgentMessaging, BroadcastMessaging, GroupChatOrchestrator } from "@open-grokbot/messaging";
import { AgentStore, AutomationScheduler, AutomationStore, MemoryStore, nextEntryId, TranscriptStore, type SandTranscriptEntry } from "@open-grokbot/state";

import { AgentRunner } from "./agent-runner.js";
import type { Llm } from "@open-grokbot/llm";

export interface SessionRuntimeOptions {
  readonly rootDir: string;
  readonly llmFor: (agentId: string) => Llm;
  readonly onMessage?: (agentId: string, content: string, kind: string) => void;
  readonly now?: () => number;
}

export class SessionRuntime implements AgentSessionRegistry {
  readonly agentStore: AgentStore;
  readonly scheduler = new RunScheduler();
  readonly lifecycle = new RunLifecycle();
  readonly runners = new Map<string, TurnRunner>();
  readonly groupMemberRunners = new Map<string, GroupMemberRunner>();
  private readonly sessions = new Map<string, RuntimeSession>();
  private readonly transcripts = new Map<string, TranscriptStore>();
  private readonly memories = new Map<string, MemoryStore>();
  private readonly automationStore: AutomationStore;
  private readonly automationScheduler: AutomationScheduler;
  private readonly a2a: AgentToAgentMessaging;
  private readonly broadcast: BroadcastMessaging;
  readonly groupChat = new GroupChatOrchestrator(this.hub());
  private readonly llmFor: (agentId: string) => Llm;
  private readonly onMessage?: (agentId: string, content: string, kind: string) => void;
  /** In-flight send merging: same clientNonce reuses the pending promise
   * (the synchronous first line of the original's idempotency chain). */
  private readonly inFlightSends = new Map<string, Promise<void>>();
  /** Per-agent user-turn epoch: bumped on every new user message; queued
   * turns check the epoch before executing (supersede skips stale turns). */
  private readonly epochs = new Map<string, number>();
  /** Prepended recovery: user messages skipped by supersede land here and are
   * re-enqueued once the agent drains (prepend-recovery with break epochs). */
  private readonly latestRecoverySends = new Map<string, { content: string; timestampMs: number }>();
  private readonly recoveryBreakEpochs = new Set<string>();

  constructor(options: SessionRuntimeOptions) {
    this.agentStore = new AgentStore({ rootDir: options.rootDir, now: options.now });
    this.llmFor = options.llmFor;
    this.onMessage = options.onMessage;
    this.lifecycle.attach(this.scheduler);
    this.a2a = new AgentToAgentMessaging(this.hub());
    this.broadcast = new BroadcastMessaging(this.hub());
    this.automationStore = new AutomationStore({ dir: options.rootDir, now: options.now });
    this.automationScheduler = new AutomationScheduler(
      this.automationStore,
      async (automation) => {
        const session = await this.getSession(automation.agentId).catch(() => undefined);
        if (session == null) return;
        const runner = this.runners.get(automation.agentId);
        if (runner == null) return;
        await this.scheduler.enqueue(
          automation.agentId,
          async () => {
            await runner.run(session, automation.prompt, { hidden: true, isSilenceAllowed: true });
          },
          { lane: "background", source: "automation" },
        );
      },
      { intervalMs: 30_000, now: options.now },
    );
  }

  /** The messaging hub view of this runtime. */
  hub(): MessagingHub {
    return {
      sessions: this,
      runners: this.runners,
      groupMemberRunners: this.groupMemberRunners,
      queue: {
        enqueue: (agentId, task, options) => this.scheduler.enqueue(agentId, task, options),
        getActiveLane: (agentId) => this.scheduler.getActiveLane(agentId),
      },
      postToGroup: async (fromAgentId, groupAgentId, content) => {
        const group = await this.getSession(groupAgentId).catch(() => undefined);
        if (group == null) return "Group not found.";
        await group.appendTranscriptEntry({
          kind: "message",
          id: nextEntryId(group.getTranscriptEntries(), "user-message"),
          role: "user",
          content,
          timestampMs: Date.now(),
          fromAgent: { id: fromAgentId, name: fromAgentId },
        });
        this.onMessage?.(groupAgentId, content, "group");
        return "Posted to the group.";
      },
      emitAgentUpdate: () => {},
    };
  }

  get a2aMessaging(): AgentToAgentMessaging {
    return this.a2a;
  }

  get broadcastMessaging(): BroadcastMessaging {
    return this.broadcast;
  }

  /** Create an agent and its session/runner; optionally a group. */
  async createAgent(input: {
    id: string;
    name: string;
    description?: string;
    isGroup?: boolean;
    memberIds?: readonly string[];
    llm?: Llm;
  }): Promise<RuntimeSession> {
    await this.agentStore.create({
      id: input.id,
      name: input.name,
      description: input.description,
      ...(input.isGroup === true ? { isGroup: true, memberIds: input.memberIds ?? [] } : {}),
    });
    const dir = this.agentStore.agentDir(input.id);
    const transcript = new TranscriptStore({ agentId: input.id, dir });
    await transcript.load();
    this.transcripts.set(input.id, transcript);
    const memory = new MemoryStore({ agentId: input.id, dir });
    await memory.load();
    this.memories.set(input.id, memory);
    const session = new RuntimeSession(
      input.id,
      input.name,
      input.isGroup === true,
      transcript,
    );
    this.sessions.set(input.id, session);
    if (input.isGroup !== true) {
      const llm = input.llm ?? this.llmFor(input.id);
      const runner = new AgentRunner({
        llm,
        readMemory: async (agentId) => (await this.memories.get(agentId)?.list())?.map((m) => m.text).join("\n") ?? "",
        onProducedMessage: (agentId, message, entry) => {
          if (message.type === "text") {
            this.onMessage?.(agentId, message.content, "send-message");
          }
          void entry;
        },
      });
      this.runners.set(input.id, runner);
      this.groupMemberRunners.set(input.id, {
        runGroupMemberTurn: async (request) => {
          const produced: string[] = [];
          const inner = new AgentRunner({
            llm,
            readMemory: async (agentId) => (await this.memories.get(agentId)?.list())?.map((m) => m.text).join("\n") ?? "",
            onProducedMessage: (_agentId, message) => {
              if (message.type === "text") produced.push(message.content);
            },
          });
          await inner.run(request.session, `${request.systemPrompt}\n\n${request.prompt}`, {
            hidden: true,
            isSilenceAllowed: true,
          });
          return produced;
        },
      });
    }
    return session;
  }

  sendUserPrompt(agentId: string, prompt: string, options?: { clientNonce?: string }): Promise<void> {
    const nonce = options?.clientNonce;
    // Idempotency first line: merge a duplicate nonce into the in-flight send.
    if (nonce != null) {
      const inFlight = this.inFlightSends.get(nonce);
      if (inFlight != null) return inFlight;
    }
    const send = this.doUserPrompt(agentId, prompt, nonce);
    if (nonce != null) {
      this.inFlightSends.set(nonce, send);
      void send.finally(() => this.inFlightSends.delete(nonce));
    }
    return send;
  }

  private async doUserPrompt(agentId: string, prompt: string, nonce?: string): Promise<void> {
    const session = await this.getSession(agentId);
    const entry: SandTranscriptEntry = {
      kind: "message",
      id: nextEntryId(session.getTranscriptEntries(), "user-message"),
      role: "user",
      content: prompt,
      timestampMs: Date.now(),
      ...(nonce != null ? { clientNonce: nonce } : {}),
    };
    await session.appendTranscriptEntry(entry);
    // Supersede: bump the epoch FIRST (a room message supersedes an in-flight
    // group round even though rooms have no runner), then interrupt an
    // in-flight user turn, then let queued stale turns skip themselves.
    const epoch = (this.epochs.get(agentId) ?? 0) + 1;
    this.epochs.set(agentId, epoch);
    const runner = this.runners.get(agentId);
    if (runner == null) return;

    if (this.scheduler.getActiveLane(agentId) === "user") {
      const interrupted = runner.interrupt("superseded");
      if (interrupted) {
        // Prepended recovery: remember the skipped message so it can be
        // re-enqueued after the queue drains (break-epoch recovery).
        this.latestRecoverySends.set(agentId, { content: prompt, timestampMs: Date.now() });
        this.recoveryBreakEpochs.add(agentId);
      }
    }
    await this.scheduler.enqueue(
      agentId,
      async () => {
        // Stale turn (a newer user message superseded us): skip.
        if (this.epochs.get(agentId) !== epoch) return;
        await runner.run(session, prompt, {});
        this.recoveryBreakEpochs.delete(agentId);
      },
      { lane: "user", source: "user" },
    );
  }

  /** Prepended recovery: re-enqueue messages that supersede skipped, once the
   * agent's queue is drained (mirrors latestRecoverySends semantics). */
  async recoverSkippedMessages(agentId: string): Promise<number> {
    const skipped = this.latestRecoverySends.get(agentId);
    if (skipped == null) return 0;
    if (this.scheduler.getActiveLane(agentId) != null) return 0; // still busy
    this.latestRecoverySends.delete(agentId);
    this.recoveryBreakEpochs.delete(agentId);
    await this.doUserPrompt(agentId, skipped.content);
    return 1;
  }

  /** Diagnostics for the idempotency/supersede machinery. */
  sendDiagnostics(): {
    inFlightSends: number;
    epochs: Record<string, number>;
    recoveryBreakEpochs: string[];
    latestRecoverySends: string[];
  } {
    return {
      inFlightSends: this.inFlightSends.size,
      epochs: Object.fromEntries(this.epochs),
      recoveryBreakEpochs: [...this.recoveryBreakEpochs],
      latestRecoverySends: [...this.latestRecoverySends.keys()],
    };
  }

  async runGroupConversation(args: {
    groupId: string;
    memberIds: readonly string[];
    onMemberMessage?: (member: string, content: string) => void;
  }): Promise<void> {
    const group = await this.getSession(args.groupId);
    // Supersede guard: a new user message bumps the group's epoch; the
    // orchestrator bails at the next member boundary (user supersede).
    const epochAtStart = this.epochs.get(args.groupId) ?? 0;
    await this.groupChat.run({
      group: { name: group.name, description: "" },
      memberIds: args.memberIds,
      isCurrent: () => (this.epochs.get(args.groupId) ?? 0) === epochAtStart,
      onMemberMessage: async (member, content) => {
        // Every posted member message lands on the room transcript, tagged
        // with the speaking member (fromAgent) so the room reads as a chat.
        await group.appendTranscriptEntry({
          kind: "message",
          id: nextEntryId(group.getTranscriptEntries(), "user-message"),
          role: "user",
          content,
          timestampMs: Date.now(),
          fromAgent: { id: member.id, name: member.name },
        });
        this.onMessage?.(args.groupId, `${member.name}: ${content}`, "group");
        args.onMemberMessage?.(member.id, content);
      },
    });
  }

  // --- AgentSessionRegistry ---

  async getSession(agentId: string): Promise<AgentSession> {
    const session = this.sessions.get(agentId);
    if (session == null) throw new Error(`no session ${agentId}`);
    return session;
  }

  async hasSession(agentId: string): Promise<boolean> {
    return this.sessions.has(agentId);
  }

  async isAgentGone(agentId: string): Promise<boolean> {
    return !this.sessions.has(agentId);
  }

  async listAgentIds(): Promise<readonly string[]> {
    return [...this.sessions.keys()];
  }

  startAutomations(): void {
    this.automationScheduler.start();
  }

  stopAutomations(): void {
    this.automationScheduler.stop();
  }

  dispose(): void {
    this.stopAutomations();
    this.scheduler.dispose();
  }
}

/** In-process agent session backed by a TranscriptStore. */
export class RuntimeSession implements AgentSession {
  readonly id: string;
  readonly name: string;
  readonly isGroup: boolean;
  readonly isRemoteRoom = false;

  constructor(
    id: string,
    name: string,
    isGroup: boolean,
    private readonly transcript: TranscriptStore,
  ) {
    this.id = id;
    this.name = name;
    this.isGroup = isGroup;
  }

  getTranscriptEntries(): readonly SandTranscriptEntry[] {
    return this.transcript.getAll();
  }

  async appendTranscriptEntry(entry: SandTranscriptEntry): Promise<void> {
    await this.transcript.append(entry);
  }

  async clearTranscript(): Promise<void> {
    await this.transcript.clear();
  }
}
