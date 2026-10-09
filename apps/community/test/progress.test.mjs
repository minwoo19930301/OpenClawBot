import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCommunity } from "../server.mjs";

function deferredModel() {
  const started = Promise.withResolvers();
  const completion = Promise.withResolvers();
  return {
    started: started.promise,
    finish: completion.resolve,
    fail: completion.reject,
    llm: {
      name: "controlled-test-model",
      async complete(request, signal) {
        started.resolve(request);
        const abort = () => completion.reject(signal.reason);
        signal?.addEventListener("abort", abort, { once: true });
        try { return await completion.promise; }
        finally { signal?.removeEventListener("abort", abort); }
      },
    },
  };
}

async function fixture(t, llm) {
  const dataDir = await mkdtemp(join(tmpdir(), "community-progress-"));
  const app = await startCommunity({
    dataDir,
    port: 0,
    env: { COMMUNITY_BOOTSTRAP_TOKEN: "test-bootstrap" },
    llm: llm ?? { name: "test-model", complete: async () => 'SendMessage: {"type":"text","content":"완료"}' },
  });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  async function call(path, { auth, body, csrf = true } = {}) {
    const headers = { "content-type": "application/json" };
    if (auth) {
      headers.cookie = auth.cookie;
      if (csrf) headers["x-csrf-token"] = auth.csrf;
    }
    const response = await fetch(app.url + path, {
      method: body === undefined ? "GET" : "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    return { status: response.status, data: await response.json(), response };
  }
  async function register(username, admin) {
    const inviteToken = admin
      ? (await call("/api/admin/invites", { auth: admin, body: {} })).data.token
      : "test-bootstrap";
    const result = await call("/api/register", { body: {
      username, displayName: username, password: "progress-test-password", inviteToken,
    } });
    assert.equal(result.status, 201);
    return {
      id: result.data.user.id,
      cookie: result.response.headers.get("set-cookie").split(";", 1)[0],
      csrf: result.data.csrfToken,
    };
  }
  async function room(auth, name = "진행 상태 확인") {
    const result = await call("/api/rooms", { auth, body: { name } });
    assert.equal(result.status, 201);
    return result.data.room.id;
  }
  async function send(auth, id, botIds = ["bot-analyst"]) {
    return call(`/api/rooms/${id}/messages`, { auth, body: {
      text: "공개할 필요 없는 사용자 메시지", clientNonce: randomUUID(), botIds,
    } });
  }
  async function stream(auth, id) {
    const response = await fetch(`${app.url}/api/rooms/${id}/progress`, {
      headers: { cookie: auth.cookie }, signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /^text\/event-stream/);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    return {
      async next() {
        while (true) {
          const boundary = buffer.indexOf("\n\n");
          if (boundary !== -1) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            if (frame.startsWith(":")) continue;
            const event = frame.match(/^event: (.+)$/m)?.[1];
            const data = frame.match(/^data: (.+)$/m)?.[1];
            assert.ok(event && data, "SSE events include an event name and JSON data");
            return { event, data: JSON.parse(data) };
          }
          const chunk = await reader.read();
          if (chunk.done) {
            assert.equal(buffer, "", "SSE closes without a partial frame");
            return null;
          }
          buffer += decoder.decode(chunk.value, { stream: true });
        }
      },
      cancel: () => reader.cancel(),
    };
  }
  return { app, call, register, room, send, stream };
}

test("room progress requires membership and streams real work before completion, then closes", async t => {
  const model = deferredModel();
  const f = await fixture(t, model.llm);
  const owner = await f.register("progress_owner");
  const outsider = await f.register("progress_outsider", owner);
  const id = await f.room(owner);
  assert.equal((await f.call(`/api/rooms/${id}/progress`)).status, 401);
  assert.equal((await f.call(`/api/rooms/${id}/progress`, { auth: outsider })).status, 404);
  assert.equal((await f.send(owner, id)).status, 202);
  const request = await model.started;
  const stream = await f.stream(owner, id);
  const stages = [];
  while (!stages.includes("model")) {
    const event = await stream.next();
    assert.equal(event.event, "progress");
    assert.deepEqual(Object.keys(event.data).sort(), ["at", "label", "stage"]);
    assert.equal(typeof event.data.label, "string");
    assert.ok(Number.isFinite(event.data.at));
    assert.doesNotMatch(event.data.label, /공개할 필요 없는/);
    stages.push(event.data.stage);
  }
  assert.ok(stages.includes("accepted"));
  assert.ok(stages.includes("context"));
  assert.equal((await f.call(`/api/rooms/${id}`, { auth: owner })).data.busy, true);
  assert.equal((await f.call("/api/sessions/reset", { auth: owner, body: {} })).status, 409);
  request.onProgress("tool", "브라우저에서 요청한 작업을 실행하고 있습니다.");
  assert.deepEqual((await stream.next()).data.stage, "tool");
  model.finish('SendMessage: {"type":"text","content":"실제 완료된 답변"}');
  const finalEvents = [];
  for (let event; (event = await stream.next());) finalEvents.push(event);
  assert.equal(finalEvents.filter(event => event.event === "done").length, 1);
  assert.equal(finalEvents.at(-1).event, "done");
  assert.ok(finalEvents.some(event => event.data.stage === "answer"));
  const completed = await f.call(`/api/rooms/${id}`, { auth: owner });
  assert.equal(completed.data.busy, false);
  assert.deepEqual(completed.data.progress, []);
  assert.equal(completed.data.messages.at(-1).text, "실제 완료된 답변");
});

test("failed model work emits an error status and still terminates the progress stream", async t => {
  const model = deferredModel();
  const f = await fixture(t, model.llm);
  const owner = await f.register("progress_failure");
  const id = await f.room(owner);
  assert.equal((await f.send(owner, id)).status, 202);
  await model.started;
  const stream = await f.stream(owner, id);
  model.fail(new Error("private transport failure detail"));
  const events = [];
  for (let event; (event = await stream.next());) events.push(event);
  assert.ok(events.some(event => event.data.stage === "error"));
  assert.equal(events.at(-1).event, "done");
  assert.doesNotMatch(JSON.stringify(events), /private transport failure detail/);
  assert.equal((await f.call(`/api/rooms/${id}`, { auth: owner })).data.busy, false);
});

test("session reset archives only caller preferences, preserves shared history, and opens a private admin session", async t => {
  const f = await fixture(t);
  const owner = await f.register("reset_owner");
  const member = await f.register("reset_member", owner);
  const shared = await f.room(owner, "함께 쓰는 방");
  const privateRoom = await f.room(owner, "이전 대화");
  const invite = await f.call(`/api/rooms/${shared}/invites`, { auth: owner, body: {} });
  assert.equal((await f.call("/api/rooms/join", { auth: member, body: { token: invite.data.token } })).status, 200);
  assert.equal((await f.send(owner, shared, [])).status, 202);
  assert.equal((await f.send(owner, privateRoom, [])).status, 202);
  await f.call(`/api/rooms/${shared}/preferences`, { auth: member, body: { pinned: true, archived: false } });
  await f.call(`/api/rooms/${privateRoom}/preferences`, { auth: owner, body: { pinned: true, archived: false } });
  const ownerBefore = (await f.call("/api/rooms", { auth: owner })).data.rooms;
  const memberBefore = (await f.call("/api/rooms", { auth: member })).data.rooms;
  const historyBefore = (await f.call(`/api/rooms/${shared}`, { auth: member })).data;
  assert.equal((await f.call("/api/sessions/reset", { body: {} })).status, 401);
  assert.equal((await f.call("/api/sessions/reset", { auth: owner, csrf: false, body: {} })).status, 403);
  const reset = await f.call("/api/sessions/reset", { auth: owner, body: {} });
  assert.equal(reset.status, 201);
  assert.equal(reset.data.archived, ownerBefore.length);
  assert.equal(reset.data.room.personal, true);
  assert.equal(reset.data.room.name, "새 대화");
  const newId = reset.data.room.id;
  const newRoom = (await f.call(`/api/rooms/${newId}`, { auth: owner })).data;
  assert.deepEqual(newRoom.messages, []);
  assert.equal(newRoom.context.usedChars, 0);
  assert.deepEqual(newRoom.members.map(item => item.id), [owner.id]);
  assert.equal((await f.call(`/api/rooms/${newId}`, { auth: member })).status, 404);
  assert.equal((await f.call(`/api/rooms/${newId}/invites`, { auth: owner, body: {} })).status, 403);
  const ownerAfter = (await f.call("/api/rooms", { auth: owner })).data.rooms;
  for (const oldRoom of ownerBefore) {
    const archived = ownerAfter.find(item => item.id === oldRoom.id);
    assert.equal(archived.archived, true);
    assert.equal(archived.pinned, false);
  }
  assert.deepEqual((await f.call("/api/rooms", { auth: member })).data.rooms, memberBefore);
  const historyAfter = (await f.call(`/api/rooms/${shared}`, { auth: member })).data;
  assert.deepEqual(historyAfter.messages, historyBefore.messages);
  assert.deepEqual(historyAfter.members, historyBefore.members);
  assert.equal((await f.call(`/api/rooms/${privateRoom}`, { auth: owner })).data.messages.length, 1);
  assert.equal((await f.call(`/api/rooms/${shared}/preferences`, { auth: owner, body: { pinned: false, archived: false } })).status, 200);
  assert.equal((await f.call("/api/rooms", { auth: owner })).data.rooms.find(item => item.id === shared).archived, false);
});

test("non-admin session reset creates an accessible ordinary empty session", async t => {
  const f = await fixture(t);
  const admin = await f.register("reset_admin");
  const member = await f.register("reset_regular", admin);
  const oldId = await f.room(member);
  const reset = await f.call("/api/sessions/reset", { auth: member, body: {} });
  assert.equal(reset.status, 201);
  assert.equal(reset.data.room.personal, false);
  assert.equal((await f.call(`/api/rooms/${reset.data.room.id}`, { auth: member })).status, 200);
  assert.equal((await f.call(`/api/rooms/${reset.data.room.id}`, { auth: admin })).status, 404);
  assert.equal((await f.call("/api/rooms", { auth: member })).data.rooms.find(item => item.id === oldId).archived, true);
});
