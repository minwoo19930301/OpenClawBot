import test from "node:test";
import assert from "node:assert/strict";
import { OpenClawHttpAdapter, createOpenClawFromEnv } from "../lib/backend/openclaw-http.mjs";

test("OpenClaw adapter uses documented OpenResponses shape and isolated server session key", async () => {
  let captured;
  const adapter = new OpenClawHttpAdapter({ baseUrl: "http://127.0.0.1:18789", token: "gateway-secret-token", agentId: "community", fetchImpl: async (url, init) => {
    captured = { url, init };
    return new Response(JSON.stringify({ output_text: "safe answer" }), { status: 200, headers: { "content-type": "application/json" } });
  } });
  const result = await adapter.complete({ system: "system", context: "room history", user: "hello", isolation: { userId: "user-a", roomId: "room-a", botId: "bot-1" } });
  assert.equal(result, 'SendMessage: {"type":"text","content":"safe answer"}');
  assert.equal(String(captured.url), "http://127.0.0.1:18789/v1/responses");
  assert.equal(captured.init.headers.authorization, "Bearer gateway-secret-token");
  assert.equal(captured.init.headers["x-openclaw-agent-id"], "community");
  assert.match(captured.init.headers["x-openclaw-session-key"], /^community:[a-f0-9]{64}$/);
  const body = JSON.parse(captured.init.body);
  assert.equal(body.model, "openclaw/community");
  assert.equal(body.max_output_tokens, 512);
  assert.deepEqual(body.tools, []);
  assert.equal(body.tool_choice, "none");
  assert.ok(body.input.every((item) => item.type === "message"));
  const keyA = adapter.sessionKey({ userId: "user-a", roomId: "room-a", botId: "bot-1" });
  const keyB = adapter.sessionKey({ userId: "user-a", roomId: "room-b", botId: "bot-1" });
  const keyC = adapter.sessionKey({ userId: "user-b", roomId: "room-a", botId: "bot-1" });
  assert.notEqual(keyA, keyB);
  assert.notEqual(keyA, keyC);
});

test("adapter rejects unsafe endpoints, weak credentials, and missing isolation", () => {
  assert.throws(() => new OpenClawHttpAdapter({ baseUrl: "http://gateway.example", token: "gateway-secret-token" }), /HTTPS/);
  assert.throws(() => new OpenClawHttpAdapter({ baseUrl: "http://127.0.0.1:18789", token: "short" }), /token/);
  const adapter = new OpenClawHttpAdapter({ baseUrl: "http://127.0.0.1:18789", token: "gateway-secret-token" });
  assert.throws(() => adapter.sessionKey({ userId: "u", roomId: "r" }), /identifiers/);
});

test("environment factory stays disabled unless server-only OpenClaw credentials are explicit", () => {
  assert.equal(createOpenClawFromEnv({}), null);
  assert.equal(createOpenClawFromEnv({ COMMUNITY_OPENCLAW_BASE_URL: "http://127.0.0.1:18789", COMMUNITY_OPENCLAW_TOKEN: "gateway-secret-token" }).name, "openclaw:default");
});

test("OpenResponses client browser tools are bounded and quota callback precedes continuation", async () => {
  const requests = [];
  const replies = [
    { output: [{ type: "function_call", call_id: "call-1", name: "browser_snapshot", arguments: "{}" }] },
    { output_text: "SendMessage: {\"type\":\"text\",\"content\":\"done\"}" },
  ];
  const adapter = new OpenClawHttpAdapter({ baseUrl: "http://127.0.0.1:18789", token: "gateway-secret-token", fetchImpl: async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return new Response(JSON.stringify(replies.shift()), { status: 200 });
  } });
  let quotaCalls = 0;
  const result = await adapter.complete({
    system: "system", user: "hello", isolation: { userId: "u", roomId: "r", botId: "b" },
    browser: async (name) => `${name} result`,
    beforeAdditionalModelCall: async () => { quotaCalls += 1; },
  });
  assert.match(result, /done/);
  assert.equal(requests.length, 2);
  assert.equal(quotaCalls, 1);
  assert.equal(requests[0].tools.length, 6);
  assert.equal(requests[1].input.at(-1).type, "function_call_output");
});

test("raw OpenClaw text is normalized and oversized responses are rejected", async () => {
  const adapter = (body) => new OpenClawHttpAdapter({ baseUrl: "http://127.0.0.1:18789", token: "gateway-secret-token", fetchImpl: async () => new Response(body, { status: 200 }) });
  const result = await adapter(JSON.stringify({ output_text: "plain" })).complete({ user: "hi", isolation: { userId: "u", roomId: "r", botId: "b" } });
  assert.equal(result, 'SendMessage: {"type":"text","content":"plain"}');
  await assert.rejects(() => adapter("x".repeat(128 * 1024 + 1)).complete({ user: "hi", isolation: { userId: "u", roomId: "r", botId: "b" } }), /too large/);
});
