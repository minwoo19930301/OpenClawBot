import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUsageStore, usageEvent } from "../usage.mjs";

const event = (extra = {}) => ({ provider: "groq", keySlot: 0, model: "qwen/qwen3", status: 200, at: 123456, ...extra });

test("usage extraction supports Chat Completions and Responses while preserving measured zero", () => {
  const chat = usageEvent(event({ usage: { prompt_tokens: 100, completion_tokens: 0, total_tokens: 100 } }));
  assert.equal(chat.inputTokens, 100);
  assert.equal(chat.outputTokens, 0);
  const responses = usageEvent(event({ usage: { input_tokens: 20, output_tokens: 3 } }));
  assert.equal(responses.inputTokens, 20);
  assert.equal(responses.outputTokens, 3);
  const absent = usageEvent(event());
  assert.equal(absent.inputTokens, null);
  assert.equal(absent.outputTokens, null);
  assert.deepEqual(absent.limits, { requests: null, tokens: null });
});

test("only allowlisted numeric rate limits and reset values are extracted, including 429", () => {
  const value = usageEvent(event({ status: 429, usage: { prompt_tokens: 999 }, headers: new Headers({
    "x-ratelimit-limit-requests": "30",
    "x-ratelimit-remaining-requests": "0",
    "x-ratelimit-reset-requests": "2m59.56s",
    "x-ratelimit-limit-tokens": "6000",
    "x-ratelimit-remaining-tokens": "2345",
    "x-ratelimit-reset-tokens": "7.66s",
    "authorization": "Bearer secret-api-key",
    "x-private-user": "private-user-detail",
  }) }));
  assert.deepEqual(value.limits.requests, { limit: 30, remaining: 0, reset: "2m59.56s" });
  assert.deepEqual(value.limits.tokens, { limit: 6000, remaining: 2345, reset: "7.66s" });
  assert.equal(value.inputTokens, null, "error response bodies do not add successful token usage");
  assert.doesNotMatch(JSON.stringify(value), /secret|private-user|authorization/);
  const invalid = usageEvent(event({ usage: { prompt_tokens: -1, completion_tokens: "40" }, headers: new Headers({
    "x-ratelimit-limit-requests": "NaN", "x-ratelimit-remaining-requests": "-1", "x-ratelimit-reset-requests": "Bearer secret",
    "x-ratelimit-limit-tokens": "1e100", "x-ratelimit-remaining-tokens": "1.5",
  }) }));
  assert.equal(invalid.inputTokens, null);
  assert.equal(invalid.outputTokens, null);
  assert.deepEqual(invalid.limits, { requests: null, tokens: null });
});

test("persistent usage is room-isolated, aggregates real token fields, and gates global provider snapshots", async t => {
  const dir = await mkdtemp(join(tmpdir(), "community-usage-"));
  let db = new DatabaseSync(join(dir, "usage.sqlite"));
  t.after(async () => { db.close(); await rm(dir, { recursive: true, force: true }); });
  let store = createUsageStore(db);
  assert.deepEqual([store.snapshot("room-a").inputTokens, store.snapshot("room-a").outputTokens], [null, null]);
  store.record("room-a", usageEvent(event({ usage: { prompt_tokens: 10, completion_tokens: 0 } })));
  store.record("room-a", usageEvent(event({ status: 429, headers: new Headers({ "x-ratelimit-remaining-requests": "0" }) })));
  store.record("room-a", usageEvent(event({ keySlot: 1, usage: { prompt_tokens: 8, completion_tokens: 3 } })));
  store.record("room-b", usageEvent(event({ provider: "openai", keySlot: 2, usage: { prompt_tokens: 40, completion_tokens: 5 } })));
  const snapshot = store.snapshot("room-a");
  assert.equal(snapshot.inputTokens, 18);
  assert.equal(snapshot.outputTokens, 3);
  assert.equal(snapshot.requests, 3, "one accounting event per HTTP response including 429");
  assert.deepEqual(snapshot.providers, []);
  assert.equal(snapshot.last.keySlot, 1);
  assert.equal(store.snapshot("room-b").inputTokens, 40);
  assert.equal(store.snapshot("room-a", { includeProviders: true }).providers.length, 3);
  assert.equal(store.snapshot("unknown-room").requests, 0);
  db.close();
  db = new DatabaseSync(join(dir, "usage.sqlite"));
  store = createUsageStore(db);
  assert.deepEqual(store.snapshot("room-a"), snapshot, "usage survives a server restart");
});

test("store rejects malformed observations and persists only explicit sanitized fields", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const store = createUsageStore(db);
    store.record("room", { ...event(), inputTokens: Infinity, outputTokens: -5, secret: "secret-value", apiKey: "secret-key",
      limits: { requests: { limit: 30, remaining: 0, reset: "1m", apiKey: "secret-value" }, tokens: { limit: -2, remaining: NaN, reset: "private-secret" } } });
    store.record("room", { status: NaN, inputTokens: 500 });
    store.record("room", null);
    const value = store.snapshot("room", { includeProviders: true });
    assert.equal(value.requests, 1);
    assert.equal(value.inputTokens, null);
    assert.equal(value.outputTokens, null);
    assert.deepEqual(value.last.limits.tokens, null);
    assert.deepEqual(value.last.limits.requests, { limit: 30, remaining: 0, reset: "1m" });
    assert.doesNotMatch(JSON.stringify(value), /secret|apiKey/);
    assert.doesNotMatch(db.prepare("SELECT last_json FROM model_usage_totals").get().last_json, /secret|apiKey/);
    store.record("room", { ...event(), inputTokens: 0, outputTokens: 0 });
    assert.equal(store.snapshot("room").inputTokens, 0);
    assert.equal(store.snapshot("room").outputTokens, 0);
  } finally { db.close(); }
});
