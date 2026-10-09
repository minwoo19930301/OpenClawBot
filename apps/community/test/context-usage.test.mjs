import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCommunity } from "../server.mjs";

const envelope = content => "SendMessage: " + JSON.stringify({ type: "text", content });
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9WQAAAAASUVORK5CYII=", "base64");

async function fixture(t, complete) {
  const dataDir = await mkdtemp(join(tmpdir(), "context-usage-http-"));
  const calls = [];
  const app = await startCommunity({ dataDir, port: 0, env: { COMMUNITY_BOOTSTRAP_TOKEN: "bootstrap" }, llm: {
    name: "context-test-model",
    async complete(request, signal) {
      calls.push(request);
      if (complete) return complete(request, signal);
      const bot = request.isolation?.botId;
      const [inputTokens, outputTokens] = bot === "title" ? [2, 1] : bot === "compact" ? [30, 4] : [100, 10];
      request.onUsage?.({ provider: "groq", keySlot: 0, model: "fixture-" + bot, status: 200, at: Date.now(), inputTokens, outputTokens,
        limits: { requests: { limit: 1000, remaining: 998, reset: "1h" }, tokens: { limit: 6000, remaining: 5800, reset: "1m" } }, apiKey: "must-never-be-stored" });
      return envelope(bot === "compact" ? "COMPACT_SUMMARY_MARKER 요약된 결정" : bot === "title" ? "자동 생성 제목" : "완료된 답변");
    },
  } });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  async function call(path, { auth, body, csrf = true } = {}) {
    const headers = { "content-type": "application/json" };
    if (auth) { headers.cookie = auth.cookie; if (csrf) headers["x-csrf-token"] = auth.csrf; }
    const response = await fetch(app.url + path, { method: body === undefined ? "GET" : "POST", headers,
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    return { status: response.status, data: await response.json(), response };
  }
  async function register(username, admin) {
    const inviteToken = admin ? (await call("/api/admin/invites", { auth: admin, body: {} })).data.token : "bootstrap";
    const result = await call("/api/register", { body: { username, displayName: username, password: "context-test-password", inviteToken } });
    assert.equal(result.status, 201);
    return { id: result.data.user.id, cookie: result.response.headers.get("set-cookie").split(";", 1)[0], csrf: result.data.csrfToken };
  }
  async function room(auth, name = "맥락 테스트") {
    const result = await call("/api/rooms", { auth, body: name === null ? {} : { name } });
    assert.equal(result.status, 201);
    return result.data.room.id;
  }
  async function joinRoom(owner, member, id) {
    const invite = (await call(`/api/rooms/${id}/invites`, { auth: owner, body: {} })).data.token;
    assert.equal((await call("/api/rooms/join", { auth: member, body: { token: invite } })).status, 200);
  }
  async function send(auth, id, text, { botIds = [], attachmentIds = [] } = {}) {
    const result = await call(`/api/rooms/${id}/messages`, { auth, body: { text, botIds, attachmentIds, clientNonce: randomUUID() } });
    assert.equal(result.status, 202);
    return result;
  }
  async function finish(auth, id) {
    const response = await fetch(`${app.url}/api/rooms/${id}/progress`, { headers: { cookie: auth.cookie }, signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /event: done/);
  }
  async function bot(auth, id, text, options = {}) { await send(auth, id, text, { ...options, botIds: ["bot-analyst"] }); await finish(auth, id); }
  async function upload(auth, id) {
    const form = new FormData(); form.append("file", new Blob([PNG], { type: "image/png" }), "old-image.png");
    const response = await fetch(`${app.url}/api/rooms/${id}/attachments`, { method: "POST", headers: { cookie: auth.cookie, "x-csrf-token": auth.csrf }, body: form, signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 201);
    return (await response.json()).attachment;
  }
  return { app, calls, call, register, room, joinRoom, send, bot, finish, upload };
}

test("context reset enforces authentication, CSRF, membership, ownership, and in-flight protection", async t => {
  const started = Promise.withResolvers(), completion = Promise.withResolvers();
  const f = await fixture(t, async (request, signal) => {
    started.resolve(request);
    const abort = () => completion.reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    try { return await completion.promise; } finally { signal.removeEventListener("abort", abort); }
  });
  const owner = await f.register("context_owner");
  const member = await f.register("context_member", owner);
  const outsider = await f.register("context_outsider", owner);
  const id = await f.room(owner);
  await f.joinRoom(owner, member, id);
  await f.send(owner, id, "OLD_CONTEXT_MARKER");
  const path = `/api/rooms/${id}/context-reset`;
  assert.equal((await f.call(path, { body: {} })).status, 401);
  assert.equal((await f.call(path, { auth: owner, body: {}, csrf: false })).status, 403);
  assert.equal((await f.call(path, { auth: outsider, body: {} })).status, 404);
  assert.equal((await f.call(path, { auth: member, body: {} })).status, 403);
  await f.send(owner, id, "진행 중", { botIds: ["bot-analyst"] });
  await started.promise;
  assert.equal((await f.call(path, { auth: owner, body: {} })).status, 409);
  assert.ok((await f.call(`/api/rooms/${id}`, { auth: owner })).data.context.usedChars > 0);
  completion.resolve(envelope("완료"));
  await f.finish(owner, id);
  const before = (await f.call(`/api/rooms/${id}`, { auth: owner })).data.messages;
  const reset = await f.call(path, { auth: owner, body: {} });
  assert.equal(reset.status, 200);
  assert.equal(reset.data.context.usedChars, 0);
  assert.equal(reset.data.context.estimatedTokens, 0);
  assert.deepEqual((await f.call(`/api/rooms/${id}`, { auth: owner })).data.messages, before);
});

test("reset excludes old transcript from model context and fork inherits the empty-summary cutoff", async t => {
  const f = await fixture(t);
  const owner = await f.register("cutoff_owner");
  const id = await f.room(owner);
  await f.send(owner, id, "OLD_CONTEXT_MARKER 반드시 보존될 이전 대화");
  const before = (await f.call(`/api/rooms/${id}`, { auth: owner })).data.messages;
  assert.equal((await f.call(`/api/rooms/${id}/context-reset`, { auth: owner, body: {} })).status, 200);
  const fork = await f.call(`/api/rooms/${id}/fork`, { auth: owner, body: {} });
  assert.equal(fork.status, 201);
  const forkId = fork.data.room.id;
  const child = (await f.call(`/api/rooms/${forkId}`, { auth: owner })).data;
  assert.deepEqual(child.messages.map(item => item.text), before.map(item => item.text));
  assert.equal(child.context.usedChars, 0);
  assert.equal(child.context.compacted, false);
  await f.bot(owner, id, "NEW_ORIGINAL_MARKER");
  await f.bot(owner, forkId, "NEW_FORK_MARKER");
  for (const [roomId, marker] of [[id, "NEW_ORIGINAL_MARKER"], [forkId, "NEW_FORK_MARKER"]]) {
    const call = f.calls.find(item => item.isolation.roomId === roomId);
    assert.ok(call.user.includes(marker));
    assert.doesNotMatch(call.user, /OLD_CONTEXT_MARKER/);
    const transcript = (await f.call(`/api/rooms/${roomId}`, { auth: owner })).data.messages;
    assert.ok(transcript.some(item => item.text.includes("OLD_CONTEXT_MARKER")), "reset preserves visible history");
  }
});

test("context reset clears compacted summary without deleting history or observed usage", async t => {
  const f = await fixture(t);
  const owner = await f.register("compact_reset");
  const id = await f.room(owner);
  await f.send(owner, id, "OLD_COMPACT_INPUT 결정을 보존합니다. ".repeat(40));
  const before = (await f.call(`/api/rooms/${id}`, { auth: owner })).data.messages;
  const compact = await f.call(`/api/rooms/${id}/compact`, { auth: owner, body: {} });
  assert.equal(compact.status, 200);
  assert.equal(compact.data.context.compacted, true);
  assert.ok(compact.data.context.summaryTokens > 0);
  const usageBefore = (await f.call(`/api/rooms/${id}/usage`, { auth: owner })).data;
  assert.equal(usageBefore.requests, 1);
  assert.equal(usageBefore.inputTokens, 30);
  const reset = await f.call(`/api/rooms/${id}/context-reset`, { auth: owner, body: {} });
  assert.equal(reset.status, 200);
  assert.equal(reset.data.context.compacted, false);
  assert.equal(reset.data.context.summaryTokens, 0);
  assert.equal(reset.data.context.messageTokens, 0);
  assert.deepEqual((await f.call(`/api/rooms/${id}`, { auth: owner })).data.messages, before);
  assert.deepEqual((await f.call(`/api/rooms/${id}/usage`, { auth: owner })).data, usageBefore);
  await f.bot(owner, id, "NEW_AFTER_COMPACT_RESET");
  assert.doesNotMatch(f.calls.at(-1).user, /COMPACT_SUMMARY_MARKER|OLD_COMPACT_INPUT/);
});

test("images before the context cutoff remain downloadable but no longer enter OCR or model context", async t => {
  const f = await fixture(t);
  const owner = await f.register("image_cutoff");
  const id = await f.room(owner);
  const attachment = await f.upload(owner, id);
  await f.bot(owner, id, "OLD_IMAGE_MARKER", { attachmentIds: [attachment.id] });
  assert.match(f.calls.at(-1).user, /현재 사용 가능한 이미지 인식 모델이 없습니다/);
  assert.equal((await f.call(`/api/rooms/${id}/context-reset`, { auth: owner, body: {} })).status, 200);
  await f.bot(owner, id, "이제 텍스트만 확인하세요.");
  assert.doesNotMatch(f.calls.at(-1).user, /OLD_IMAGE_MARKER|현재 사용 가능한 이미지 인식 모델이 없습니다|첨부 이미지 판독 결과|첨부 이미지 판독에 실패/);
  const result = await fetch(f.app.url + attachment.url, { headers: { cookie: owner.cookie } });
  assert.equal(result.status, 200);
  assert.deepEqual(Buffer.from(await result.arrayBuffer()), PNG);
  const transcript = (await f.call(`/api/rooms/${id}`, { auth: owner })).data.messages;
  assert.equal(transcript.find(item => item.text === "OLD_IMAGE_MARKER").attachments[0].id, attachment.id);
});

test("usage endpoint isolates room totals and limits global provider visibility to administrators", async t => {
  let hiddenRoom;
  const f = await fixture(t, async request => {
    request.onUsage?.({ provider: request.isolation.roomId === hiddenRoom ? "openai" : "groq", keySlot: 0, model: "fixture", status: 200, at: Date.now(), inputTokens: 10, outputTokens: 2,
      apiKey: "private-provider-secret" });
    return envelope("완료");
  });
  const admin = await f.register("usage_admin");
  const member = await f.register("usage_member", admin);
  const outsider = await f.register("usage_outsider", admin);
  const shared = await f.room(admin);
  hiddenRoom = await f.room(admin, "관리자만 보는 대화");
  await f.joinRoom(admin, member, shared);
  await f.bot(admin, hiddenRoom, "관리자 요청");
  await f.bot(member, shared, "공동 요청");
  const path = `/api/rooms/${shared}/usage`;
  assert.equal((await f.call(path)).status, 401);
  assert.equal((await f.call(path, { auth: outsider })).status, 404);
  assert.equal((await f.call(`/api/rooms/${hiddenRoom}/usage`, { auth: member })).status, 404);
  const regular = await f.call(path, { auth: member });
  assert.equal(regular.status, 200);
  assert.equal(regular.data.inputTokens, 10);
  assert.equal(regular.data.outputTokens, 2);
  assert.equal(regular.data.requests, 1);
  assert.deepEqual(regular.data.providers, []);
  assert.doesNotMatch(JSON.stringify(regular.data), /openai|private-provider-secret/);
  const administrator = await f.call(path, { auth: admin });
  assert.equal(administrator.data.inputTokens, 10, "other room usage does not affect this room's total");
  assert.deepEqual(administrator.data.providers.map(item => item.provider).sort(), ["groq", "openai"]);
  assert.doesNotMatch(JSON.stringify(administrator.data), /private-provider-secret|apiKey/);
});

test("title, bot, and compact calls attribute actual usage to their room without leaking into another room", async t => {
  const f = await fixture(t);
  const owner = await f.register("usage_attribution");
  const id = await f.room(owner, null);
  const empty = await f.room(owner, "빈 대화");
  await f.bot(owner, id, "첫 대화의 긴 내용이며 요약할 결정을 포함합니다. ".repeat(40));
  assert.deepEqual(f.calls.map(item => item.isolation.botId).sort(), ["bot-analyst", "title"]);
  const before = (await f.call(`/api/rooms/${id}/usage`, { auth: owner })).data;
  assert.deepEqual([before.requests, before.inputTokens, before.outputTokens], [2, 102, 11]);
  assert.equal((await f.call(`/api/rooms/${id}/compact`, { auth: owner, body: {} })).status, 200);
  const after = (await f.call(`/api/rooms/${id}/usage`, { auth: owner })).data;
  assert.deepEqual([after.requests, after.inputTokens, after.outputTokens], [3, 132, 15]);
  assert.equal(after.last.model, "fixture-compact");
  const unused = (await f.call(`/api/rooms/${empty}/usage`, { auth: owner })).data;
  assert.deepEqual([unused.requests, unused.inputTokens, unused.outputTokens], [0, null, null]);
});
