import assert from "node:assert/strict";
import { test } from "node:test";

import { ManualClock, RunScheduler, RunLifecycle, createRetryPolicy, createDeadlinePolicy, DeadlineExceededError } from "../src/index.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

test("lanes: user beats agent beats background", async () => {
  const scheduler = new RunScheduler({ clock: new ManualClock() });
  const order: string[] = [];
  const done = (name: string) => async () => {
    order.push(name);
  };
  await Promise.all([
    scheduler.enqueue("a1", done("bg"), { lane: "background", source: "bg" }),
    scheduler.enqueue("a1", done("agent"), { lane: "agent", source: "agent" }),
    scheduler.enqueue("a1", done("user"), { lane: "user", source: "user" }),
  ]);
  assert.deepEqual(order, ["user", "agent", "bg"]);
});

test("exclusivity: one active task per agent, queues serialize", async () => {
  const scheduler = new RunScheduler();
  let active = 0;
  let maxActive = 0;
  const work = async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 10));
    active -= 1;
  };
  await Promise.all([
    scheduler.enqueue("a1", work, { lane: "user", source: "user" }),
    scheduler.enqueue("a1", work, { lane: "user", source: "user" }),
    scheduler.enqueue("a1", work, { lane: "user", source: "user" }),
  ]);
  assert.equal(maxActive, 1);
  assert.equal(active, 0);
});

test("different agents run concurrently", async () => {
  const scheduler = new RunScheduler();
  let active = 0;
  let maxActive = 0;
  const work = async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 20));
    active -= 1;
  };
  await Promise.all([
    scheduler.enqueue("a1", work, { lane: "user", source: "user" }),
    scheduler.enqueue("a2", work, { lane: "user", source: "user" }),
    scheduler.enqueue("a3", work, { lane: "user", source: "user" }),
  ]);
  assert.equal(maxActive, 3);
});

test("watchdog: wedged run is escaped but drain waits for the zombie", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let finished = false;
  const escaped: string[] = [];
  // Short watchdog/grace so the test runs on real timers.
  const scheduler = new RunScheduler({
    watchdogMs: 20,
    graceMs: 10,
    onEscaped: (i) => escaped.push(i.source),
  });

  const taskPromise = scheduler.enqueue(
    "a1",
    async () => {
      await gate;
      finished = true;
    },
    { lane: "user", source: "user" },
  );

  // Let the task start, then run past watchdog (20ms) + grace (10ms).
  await sleep(5);
  await sleep(60);
  // Caller promise was resolved early via escape; the run is a zombie.
  assert.deepEqual(escaped, ["user"]);
  assert.equal(finished, false);
  await taskPromise;

  // drain must still wait for the zombie
  const drainPromise = scheduler.drain("a1");
  let drained = false;
  void drainPromise.then(() => (drained = true));
  await sleep(10);
  assert.equal(drained, false);

  release();
  await drainPromise;
  assert.equal(finished, true);
  assert.equal(drained, true);
});

test("rejection propagates to the caller", async () => {
  const scheduler = new RunScheduler();
  await assert.rejects(
    scheduler.enqueue("a1", async () => {
      throw new Error("boom");
    }, { lane: "user", source: "user" }),
    /boom/,
  );
});

test("diagnostics report queue depth and active run", async () => {
  const scheduler = new RunScheduler();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const run = scheduler.enqueue("a1", async () => {
    await gate;
  }, { lane: "user", source: "user" });
  await new Promise((r) => setTimeout(r, 5));
  void scheduler.enqueue("a1", async () => {}, { lane: "agent", source: "agent" });
  await new Promise((r) => setTimeout(r, 5));
  const diag = scheduler.getDiagnostics();
  assert.equal(diag.length, 1);
  assert.equal(diag[0]!.agentId, "a1");
  assert.equal(diag[0]!.depthAgent, 1);
  assert.equal(diag[0]!.active?.source, "user");
  release();
  await run;
});

test("retry policy backoff grows and caps", async () => {
  const policy = createRetryPolicy({
    name: "t",
    maxAttempts: Number.MAX_SAFE_INTEGER,
    initialDelayMs: 100,
    maxDelayMs: 800,
    backoffFactor: 2,
  });
  // measure via manual timers: first wait is ~100ms, second ~200ms
  const t0 = Date.now();
  await policy.schedule(1).elapsed;
  const t1 = Date.now();
  await policy.schedule(2).elapsed;
  const t2 = Date.now();
  assert.ok(t1 - t0 >= 90 && t1 - t0 < 400, `first delay ${t1 - t0}`);
  assert.ok(t2 - t1 >= 190 && t2 - t1 < 600, `second delay ${t2 - t1}`);
});

test("deadline policy rejects after timeout", async () => {
  const policy = createDeadlinePolicy({ name: "t", timeoutMs: 30 });
  await assert.rejects(
    policy.run(async () => {
      await new Promise((r) => setTimeout(r, 200));
    }),
    (e: unknown) => e instanceof DeadlineExceededError,
  );
});

test("run lifecycle: window collapse and ack retirement", async () => {
  const lifecycle = new RunLifecycle();
  const completions: string[] = [];
  const lc = new RunLifecycle({
    onTurnCompleted: (i) => completions.push(i.agentId),
  });
  lc.beginSessionRun("a1", "user");
  lc.beginSessionRun("a1", "agent");
  assert.equal(lc.isRunning("a1"), true);
  lc.endSessionRun("a1");
  assert.equal(lc.isRunning("a1"), true); // still one begin outstanding
  lc.endSessionRun("a1");
  assert.equal(lc.isRunning("a1"), false);
  assert.deepEqual(completions, ["a1"]);

  const ack = lc.mintAck("a1", "nonce-1");
  assert.equal(ack.coalescedCount, 0);
  lc.mintAck("a1", "nonce-1");
  assert.equal(ack.coalescedCount, 1);
  assert.equal(lc.outstandingAcks().length, 1);
  lc.retireAck("nonce-1");
  assert.equal(lc.outstandingAcks().length, 0);
});

test("lifecycle attaches to scheduler and retires acks", async () => {
  const scheduler = new RunScheduler();
  const lifecycle = new RunLifecycle();
  lifecycle.attach(scheduler);
  await scheduler.enqueue("a1", async () => {}, {
    lane: "user",
    source: "user",
    ackToken: "tok-1",
  });
  assert.equal(lifecycle.outstandingAcks().length, 0);
});

test("run lifecycle: ack re-drive fires only when idle and acks outstanding", () => {
  const redriven: string[] = [];
  const lc = new RunLifecycle({
    onAckRedriveScheduled: (agentId, count) => redriven.push(`${agentId}:${count}`),
  });
  lc.mintAck("a1", "nonce-1");
  lc.beginSessionRun("a1", "user");
  lc.scheduleAckRedriveAfterIdle("a1"); // busy -> no fire
  assert.deepEqual(redriven, []);
  lc.endSessionRun("a1"); // idle, ack still owed
  lc.scheduleAckRedriveAfterIdle("a1");
  assert.deepEqual(redriven, ["a1:1"]);
  lc.retireAck("nonce-1");
  lc.scheduleAckRedriveAfterIdle("a1"); // no ack -> no fire
  assert.deepEqual(redriven, ["a1:1"]);
});
