import test from "node:test";
import assert from "node:assert/strict";
import { ApiLlm } from "../model.mjs";

const response = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const call = (name, args = "{}", id = "call-1") => ({ id, type: "function", function: { name, arguments: args } });
const request = (overrides = {}) => ({ system: "system", user: "hello", browser: null, beforeAdditionalModelCall: async () => {}, ...overrides });

async function withFetch(sequence, run) {
  const original = globalThis.fetch;
  const bodies = [];
  let index = 0;
  globalThis.fetch = async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    const next = sequence[Math.min(index++, sequence.length - 1)];
    return response({ choices: [{ message: next }] });
  };
  try { return await run(bodies); } finally { globalThis.fetch = original; }
}

const llm = () => new ApiLlm({ COMMUNITY_LLM_MODEL: "fixture", COMMUNITY_LLM_BASE_URL: "http://127.0.0.1:1", COMMUNITY_LLM_API_KEY: "test" });

test("ApiLlm executes browser tool calls and returns the final text envelope", async () => {
  const { result, bodies } = await withFetch([
    { content: null, tool_calls: [call("browser_snapshot", "{}", "snap-1")] },
    { content: "The page is ready." },
  ], async (bodies) => ({ result: await llm().complete(request({ browser: async (name, args) => `${name}:${JSON.stringify(args)} result` })), bodies }));
  assert.deepEqual(JSON.parse(result.slice("SendMessage: ".length)), { type: "text", content: "The page is ready." });
  assert.equal(bodies[0].tools.length, 6);
  assert.equal(bodies[1].messages.at(-1).role, "tool");
});

test("additional model quota is called exactly once and blocks the next provider request", async () => {
  let quotaCalls = 0;
  await assert.rejects(() => withFetch([{ content: null, tool_calls: [call("browser_snapshot")] }], async () => llm().complete(request({ browser: async () => "ok", beforeAdditionalModelCall: async () => { quotaCalls++; throw new Error("quota"); } }))), /quota/);
  assert.equal(quotaCalls, 1);
});

test("unknown tools, invalid arguments, and action budgets are rejected before execution", async () => {
  await assert.rejects(() => withFetch([{ content: null, tool_calls: [call("browser_secret")] }], async () => llm().complete(request({ browser: async () => "bad" }))), /Invalid browser tool call/);
  await assert.rejects(() => withFetch([{ content: null, tool_calls: [call("browser_click", "x".repeat(10001))] }], async () => llm().complete(request({ browser: async () => "bad" }))), /Invalid browser tool call/);
  const calls = Array.from({ length: 5 }, (_, i) => call("browser_snapshot", "{}", `c-${i}`));
  await assert.rejects(() => withFetch([{ content: null, tool_calls: calls }], async () => llm().complete(request({ browser: async () => "bad" }))), /Browser action budget exceeded/);
});

test("plain requests omit browser tools and preserve a plain text response", async () => {
  const result = await withFetch([{ content: "plain response" }], async (bodies) => {
    const text = await llm().complete(request());
    assert.equal(bodies[0].tools, undefined);
    return text;
  });
  assert.deepEqual(JSON.parse(result.slice("SendMessage: ".length)), { type: "text", content: "plain response" });
});
