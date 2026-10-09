import test from "node:test";
import assert from "node:assert/strict";
import { ApiLlm } from "../model.mjs";
import { OpenClawHttpAdapter } from "../lib/backend/openclaw-http.mjs";

const llm = () => new ApiLlm({ COMMUNITY_LLM_MODEL: "fixture", COMMUNITY_LLM_BASE_URL: "http://127.0.0.1:1", COMMUNITY_LLM_API_KEY: "test-secret" });
const candidate = (slot = 0) => ({ provider: "groq", slot, model: "qwen/qwen3", baseUrl: "http://127.0.0.1:1", apiKey: "test-secret" });
const request = extra => ({ system: "system", user: "hello", attempts: [candidate()], beforeAdditionalModelCall: async () => {}, ...extra });

test("direct model emits exactly one usage observation per failed or successful provider response", async () => {
  const original = globalThis.fetch;
  const events = [];
  let calls = 0;
  globalThis.fetch = async () => ++calls === 1
    ? new Response("", { status: 429, headers: { "x-ratelimit-limit-requests": "30", "x-ratelimit-remaining-requests": "0", "x-ratelimit-reset-requests": "1m" } })
    : Response.json({ choices: [{ message: { content: "done" } }], usage: { prompt_tokens: 45, completion_tokens: 6 } }, { headers: { "x-ratelimit-remaining-tokens": "990" } });
  try {
    await llm().complete(request({ attempts: [candidate(0), candidate(1)], onUsage: value => events.push(value) }));
    assert.equal(events.length, 2);
    assert.equal(events[0].status, 429);
    assert.equal(events[0].limits.requests.remaining, 0);
    assert.equal(events[0].inputTokens, null);
    assert.equal(events[1].keySlot, 1);
    assert.equal(events[1].inputTokens, 45);
    assert.equal(events[1].outputTokens, 6);
    assert.equal(events[1].limits.tokens.remaining, 990);
    assert.doesNotMatch(JSON.stringify(events), /test-secret|apiKey|baseUrl/);
  } finally { globalThis.fetch = original; }
});

test("direct model accounts for every tool continuation and records headers when a response body is invalid", async () => {
  const original = globalThis.fetch;
  const events = [];
  let calls = 0;
  globalThis.fetch = async () => ++calls === 1
    ? Response.json({ choices: [{ message: { tool_calls: [{ id: "tool-1", function: { name: "browser_snapshot", arguments: "{}" } }] } }], usage: { prompt_tokens: 15, completion_tokens: 3 } })
    : Response.json({ choices: [{ message: { content: "done" } }], usage: { prompt_tokens: 30, completion_tokens: 7 } });
  try {
    await llm().complete(request({ browser: async () => "result", onUsage: value => events.push(value) }));
    assert.deepEqual(events.map(value => [value.inputTokens, value.outputTokens]), [[15, 3], [30, 7]]);
    events.length = 0;
    globalThis.fetch = async () => new Response("invalid JSON", { headers: { "x-ratelimit-remaining-tokens": "8" } });
    await assert.rejects(() => llm().complete(request({ onUsage: value => events.push(value) })));
    assert.equal(events.length, 1);
    assert.equal(events[0].inputTokens, null);
    assert.equal(events[0].limits.tokens.remaining, 8);
  } finally { globalThis.fetch = original; }
});

test("OpenResponses adapter emits actual usage once and also observes rejected response limits", async () => {
  const events = [];
  const make = response => new OpenClawHttpAdapter({ baseUrl: "http://127.0.0.1:18789", token: "private-gateway-token", fetchImpl: async () => response });
  const options = { user: "hello", isolation: { userId: "u", roomId: "r", botId: "b" }, onUsage: event => events.push(event) };
  await make(Response.json({ output_text: "done", usage: { input_tokens: 50, output_tokens: 0 } })).complete(options);
  assert.equal(events.length, 1);
  assert.equal(events[0].provider, "openclaw");
  assert.equal(events[0].keySlot, null);
  assert.equal(events[0].inputTokens, 50);
  assert.equal(events[0].outputTokens, 0);
  await assert.rejects(() => make(new Response("", { status: 429, headers: { "x-ratelimit-remaining-requests": "0" } })).complete(options), /rejected/);
  assert.equal(events.length, 2);
  assert.equal(events[1].status, 429);
  assert.equal(events[1].limits.requests.remaining, 0);
  assert.doesNotMatch(JSON.stringify(events), /private-gateway-token|session-key/);
});
