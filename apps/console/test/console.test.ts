/**
 * Console tests: HTTP API + SSE live feed over a running console instance.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { MockLlm } from "@open-grokbot/llm";
import { startConsole } from "../src/index.js";

test("console: agents, transcript, send flow end to end", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ogb-console-"));
  const console = await startConsole({
    dataDir: dir,
    llm: new MockLlm({ latencyMs: 1 }),
    seedAgents: [{ id: "alpha", name: "Alpha" }],
  });
  try {
    const base = console.url;
    const agents = (await (await fetch(`${base}/api/agents`)).json()) as { id: string; name: string }[];
    assert.deepEqual(agents.map((a) => a.id), ["alpha"]);
    const before = (await (await fetch(`${base}/api/transcript?agent=alpha`)).json()) as { entries: unknown[] };
    assert.equal(before.entries.length, 0);
    const send = await fetch(`${base}/api/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: "alpha", prompt: "hello console" }),
    });
    assert.equal(send.status, 200);
    await console.runtime.scheduler.drain("alpha");
    const after = (await (await fetch(`${base}/api/transcript?agent=alpha`)).json()) as {
      entries: { kind: string; role?: string; content?: string }[];
    };
    assert.ok(after.entries.some((e) => e.kind === "message" && e.role === "user" && e.content === "hello console"));
  } finally {
    await console.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("console: broadcast and a2a endpoints respond", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ogb-console2-"));
  const console = await startConsole({
    dataDir: dir,
    llm: new MockLlm({ latencyMs: 1 }),
    seedAgents: [
      { id: "alpha", name: "Alpha" },
      { id: "beta", name: "Beta" },
    ],
  });
  try {
    const base = console.url;
    const broadcast = await fetch(`${base}/api/broadcast`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "status check" }),
    });
    assert.equal(broadcast.status, 200);
    const a2a = await fetch(`${base}/api/a2a`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: "alpha", to: "beta", text: "review please" }),
    });
    assert.equal(a2a.status, 200);
    // Fire-and-forget wakes enqueue asynchronously; give them a tick, then drain.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await console.runtime.scheduler.drain("alpha");
    await console.runtime.scheduler.drain("beta");
  } finally {
    await console.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("console: SSE live feed streams send events", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ogb-console3-"));
  const console = await startConsole({
    dataDir: dir,
    llm: new MockLlm({ latencyMs: 1 }),
    seedAgents: [{ id: "alpha", name: "Alpha" }],
  });
  try {
    const base = console.url;
    const events: string[] = [];
    const abort = new AbortController();
    const streamPromise = (async () => {
      const res = await fetch(`${base}/events`, { signal: abort.signal });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        events.push(decoder.decode(value));
        if (events.join("").includes("live-event")) break;
      }
    })();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await fetch(`${base}/api/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: "alpha", prompt: "live-event" }),
    });
    await Promise.race([streamPromise, new Promise((resolve) => setTimeout(resolve, 2000))]);
    abort.abort();
    const joined = events.join("");
    assert.ok(joined.includes("live-event"), joined);
    assert.ok(joined.startsWith("retry: 1000"), joined.slice(0, 40));
  } finally {
    await console.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("console: SSE stream seeds the roster on connect", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ogb-console-seed-"));
  const console = await startConsole({
    dataDir: dir,
    llm: new MockLlm({}),
    seedAgents: [{ id: "alpha", name: "Alpha" }],
  });
  try {
    const base = console.url;
    const abort = new AbortController();
    const res = await fetch(`${base}/events`, { signal: abort.signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let joined = "";
    for (let i = 0; i < 10; i += 1) {
      const { done, value } = await reader.read();
      if (done) break;
      joined += decoder.decode(value);
      if (joined.includes("roster-seed")) break;
    }
    abort.abort();
    assert.ok(joined.includes("roster-seed"), joined);
    assert.ok(joined.includes("alpha"), joined);
  } finally {
    await console.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
