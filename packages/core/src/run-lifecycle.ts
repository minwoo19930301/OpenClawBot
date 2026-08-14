import type { RunScheduler, EnqueueOptions } from "./run-scheduler.js";

/** Tracks per-session run windows and ack obligations. A "run window" spans
 * beginSessionRun..endSessionRun; overlapping begins collapse into one
 * window, and ack obligations are retired when the answering run settles. */
export interface AckObligation {
  readonly agentId: string;
  readonly token: string;
  readonly createdAtMs: number;
  coalescedCount: number;
}

export interface RunLifecycleOptions {
  readonly now?: () => number;
  /** Called when a run window completes (telemetry). */
  readonly onTurnCompleted?: (info: {
    agentId: string;
    startedAtMs: number;
    sources: readonly string[];
  }) => void;
  /** Called when an ack obligation is minted. */
  readonly onAckMinted?: (obligation: AckObligation) => void;
  /** Called when an ack obligation is retired. */
  readonly onAckRetired?: (obligation: AckObligation) => void;
  /** Called when an idle agent still owes acks (bounded re-drive hook). */
  readonly onAckRedriveScheduled?: (agentId: string, outstanding: number) => void;
}

export class RunLifecycle {
  private readonly runWindowStartedAt = new Map<string, number>();
  private readonly runSources = new Map<string, Set<string>>();
  private readonly inFlightRunCounts = new Map<string, number>();
  private readonly acks = new Map<string, AckObligation>();
  private readonly now: () => number;
  private readonly onTurnCompleted?: RunLifecycleOptions["onTurnCompleted"];
  private readonly onAckMinted?: RunLifecycleOptions["onAckMinted"];
  private readonly onAckRetired?: RunLifecycleOptions["onAckRetired"];
  private readonly onAckRedriveScheduled?: RunLifecycleOptions["onAckRedriveScheduled"];

  constructor(options: RunLifecycleOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.onTurnCompleted = options.onTurnCompleted;
    this.onAckMinted = options.onAckMinted;
    this.onAckRetired = options.onAckRetired;
    this.onAckRedriveScheduled = options.onAckRedriveScheduled;
  }

  beginSessionRun(agentId: string, source: string): void {
    const inFlight = this.inFlightRunCounts.get(agentId) ?? 0;
    if (inFlight === 0) {
      this.runWindowStartedAt.set(agentId, this.now());
      this.runSources.set(agentId, new Set());
    }
    this.runSources.get(agentId)?.add(source);
    this.inFlightRunCounts.set(agentId, inFlight + 1);
  }

  endSessionRun(agentId: string): void {
    const remaining = (this.inFlightRunCounts.get(agentId) ?? 1) - 1;
    if (remaining > 0) {
      this.inFlightRunCounts.set(agentId, remaining);
      return;
    }
    this.inFlightRunCounts.delete(agentId);
    const startedAtMs = this.runWindowStartedAt.get(agentId);
    this.runWindowStartedAt.delete(agentId);
    const sources = [...(this.runSources.get(agentId) ?? [])];
    this.runSources.delete(agentId);
    if (startedAtMs != null) {
      this.onTurnCompleted?.({ agentId, startedAtMs, sources });
    }
  }

  isRunning(agentId: string): boolean {
    return (this.inFlightRunCounts.get(agentId) ?? 0) > 0;
  }

  runningAgentIds(): ReadonlySet<string> {
    return new Set(this.inFlightRunCounts.keys());
  }

  /** Mint an ack obligation: the user-facing acknowledgement owed for a send. */
  mintAck(agentId: string, token: string): AckObligation {
    const existing = this.acks.get(token);
    if (existing != null) {
      existing.coalescedCount += 1;
      return existing;
    }
    const obligation: AckObligation = {
      agentId,
      token,
      createdAtMs: this.now(),
      coalescedCount: 0,
    };
    this.acks.set(token, obligation);
    this.onAckMinted?.(obligation);
    return obligation;
  }

  /** Retire an ack obligation (the answering run settled). */
  retireAck(token: string): AckObligation | undefined {
    const obligation = this.acks.get(token);
    if (obligation == null) return undefined;
    this.acks.delete(token);
    this.onAckRetired?.(obligation);
    return obligation;
  }

  outstandingAcks(): readonly AckObligation[] {
    return [...this.acks.values()];
  }

  /** Ack obligations still owed by an agent. */
  outstandingAcksFor(agentId: string): readonly AckObligation[] {
    return this.outstandingAcks().filter((obligation) => obligation.agentId === agentId);
  }

  /** Bounded re-drive hook (mirrors scheduleAckRedriveAfterIdle): when the
   * agent just went fully idle and still owes acks, ask the owner to re-drive
   * the delivery. The owner decides whether and how to retry. */
  scheduleAckRedriveAfterIdle(agentId: string): void {
    if (this.isRunning(agentId)) return;
    const outstanding = this.outstandingAcksFor(agentId);
    if (outstanding.length === 0) return;
    this.onAckRedriveScheduled?.(agentId, outstanding.length);
  }

  /** Wire the lifecycle into a scheduler: every enqueue begins a run window,
   * and completion retires the ack token the enqueue carried. */
  attach(scheduler: RunScheduler): () => void {
    const originalEnqueue = scheduler.enqueue.bind(scheduler);
    const self = this;
    scheduler.enqueue = (
      agentId: string,
      task: () => Promise<void>,
      options: EnqueueOptions,
    ): Promise<void> => {
      self.beginSessionRun(agentId, options.source);
      return originalEnqueue(agentId, async () => {
        try {
          await task();
        } finally {
          if (options.ackToken != null) self.retireAck(options.ackToken);
          self.endSessionRun(agentId);
        }
      }, options);
    };
    return () => {
      scheduler.enqueue = originalEnqueue;
    };
  }
}
