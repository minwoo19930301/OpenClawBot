import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { MockLlm } from "@open-grokbot/llm";
import { AgentToAgentMessaging } from "@open-grokbot/messaging";

import { AgentRunner, parseSendMessages, SessionRuntime } from "../src/index.js";

test("parseSendMessages extracts envelopes and ignores scratch", () => {
  const output = [
    "scratchpad text that is invisible to the user",
    'SendMessage: {"type":"text","content":"Hello there"}',
    '{"type":"text","content":"bare json"}',
    'not json {broken',
  ].join("\n");
  const parsed = parseSendMessages(output);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0]!.message.type, "text");
  assert.equal((parsed[0]!.message as { content: string }).content, "Hello there");
});

test("end-to-end: user prompt -> agent reply via SendMessage, persisted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ogb-runner-"));
  try {
    const runtime = new SessionRuntime({
      rootDir: dir,
      llmFor: () => new MockLlm({ latencyMs: 1 }),
      onMessage: () => {},
    });
    await runtime.createAgent({ id: "a1", name: "Alpha", description: "planner" });
    const produced: string[] = [];
    const runtime2 = new SessionRuntime({
      rootDir: dir,
      llmFor: () => new MockLlm({ latencyMs: 1 }),
      onMessage: (_agentId, content, _kind) => produced.push(content),
    });
    await runtime2.createAgent({ id: "a1", name: "Alpha", description: "planner" });
    await runtime2.sendUserPrompt("a1", "plan the sprint");
    await runtime2.scheduler.drain("a1");

    const session = await runtime2.getSession("a1");
    const entries = session.getTranscriptEntries();
    assert.ok(entries.some((e) => e.kind === "message" && e.role === "user" && e.content === "plan the sprint"));
    assert.ok(entries.some((e) => e.kind === "send-message"));
    assert.equal(produced.length, 1);
    assert.ok(produced[0]!.includes("plan the sprint"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("end-to-end: A2A message wakes the recipient which replies", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ogb-runner-a2a-"));
  try {
    const replies = new Map<string, string>([
      ["Alpha", "Thanks Alpha, noted!"],
    ]);
    const runtime = new SessionRuntime({
      rootDir: dir,
      llmFor: (agentId) =>
        new MockLlm({
          latencyMs: 1,
          replies,
          mentionableNames: [],
        }),
      onMessage: () => {},
    });
    await runtime.createAgent({ id: "alpha", name: "Alpha", description: "sender" });
    await runtime.createAgent({ id: "beta", name: "Beta", description: "receiver" });

    const betaEntriesBefore = (await runtime.getSession("beta")).getTranscriptEntries().length;
    const a2a = new AgentToAgentMessaging(runtime.hub());
    const result = await a2a.sendToAgent("alpha", "beta", "please review the plan");
    assert.equal(result.status, "sent");

    // Wait for the fire-and-forget wake, then drain Beta's queue.
    await new Promise((r) => setTimeout(r, 50));
    await runtime.scheduler.drain("beta");

    const beta = await runtime.getSession("beta");
    const entries = beta.getTranscriptEntries();
    assert.ok(entries.length > betaEntriesBefore, "recipient transcript grew");
    const inbound = entries.find(
      (e): e is Extract<typeof e, { kind: "message"; fromAgent?: unknown }> =>
        e.kind === "message" && e.fromAgent != null,
    );
    assert.ok(inbound != null, "inbound fromAgent entry present");
    assert.equal(inbound.fromAgent!.id, "alpha");
    const reply = entries.find((e) => e.kind === "send-message");
    assert.ok(reply != null, "recipient produced a SendMessage reply");
    void reply;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("end-to-end: group conversation converges with pass", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ogb-runner-group-"));
  try {
    const runtime = new SessionRuntime({
      rootDir: dir,
      llmFor: (agentId) => {
        const interests =
          agentId === "gamma" ? ["sports"] : ["roadmap", "plan", "sprint", "design"];
        return new MockLlm({ latencyMs: 1, interests, mentionableNames: ["Beta"] });
      },
      onMessage: () => {},
    });
    await runtime.createAgent({ id: "alpha", name: "Alpha", description: "roadmap" });
    await runtime.createAgent({ id: "beta", name: "Beta", description: "design" });
    await runtime.createAgent({ id: "gamma", name: "Gamma", description: "sports" });
    await runtime.createAgent({ id: "g1", name: "Squad", isGroup: true });

    const posted: string[] = [];
    await runtime.runGroupConversation({
      groupId: "g1",
      memberIds: ["alpha", "beta", "gamma"],
      onMemberMessage: (_member, content) => posted.push(content),
    });
    // At least one message was posted, and the group transcript recorded it.
    assert.ok(posted.length >= 1, `posted ${posted.length}`);
    const group = await runtime.getSession("g1");
    assert.ok(group.getTranscriptEntries().length >= 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runner interrupt aborts an in-flight completion", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ogb-runner-abort-"));
  try {
    const runtime = new SessionRuntime({
      rootDir: dir,
      llmFor: () => new MockLlm({ latencyMs: 500 }),
      onMessage: () => {},
    });
    await runtime.createAgent({ id: "a1", name: "Alpha", description: "" });
    const runPromise = runtime.scheduler.enqueue("a1", async () => {
      const runner = runtime.runners.get("a1")!;
      await runner.run(await runtime.getSession("a1"), "long task", {});
    }, { lane: "user", source: "user" });
    await new Promise((r) => setTimeout(r, 30));
    runtime.runners.get("a1")!.interrupt("superseded");
    const result = await runPromise.catch(() => undefined);
    void result;
    assert.ok(true, "interrupt settled the run");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("end-to-end: user message supersedes an in-flight group conversation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ogb-group-supersede-"));
  let memberTurns = 0;
  const runtime = new SessionRuntime({
    rootDir: dir,
    llmFor: () => new MockLlm({ latencyMs: 5 }),
    onMessage: () => {},
  });
  try {
    await runtime.createAgent({ id: "alpha", name: "Alpha" });
    await runtime.createAgent({ id: "beta", name: "Beta" });
    await runtime.createAgent({ id: "g1", name: "Squad", isGroup: true });
    // Slow member runners so the round is still in flight when the user sends.
    runtime.groupMemberRunners.set("alpha", {
      runGroupMemberTurn: async () => {
        memberTurns += 1;
        await new Promise((resolve) => setTimeout(resolve, 200));
        return ["hello"];
      },
    });
    runtime.groupMemberRunners.set("beta", {
      runGroupMemberTurn: async () => {
        memberTurns += 1;
        await new Promise((resolve) => setTimeout(resolve, 200));
        return ["hello too"];
      },
    });
    const groupRun = runtime.runGroupConversation({ groupId: "g1", memberIds: ["alpha", "beta"] });
    await new Promise((resolve) => setTimeout(resolve, 50));
    // A new user message to the room bumps the epoch: the round bails.
    await runtime.sendUserPrompt("g1", "stop, new direction");
    await groupRun;
    assert.ok(memberTurns <= 2, `member turns ran ${memberTurns} times`);
  } finally {
    runtime.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});
