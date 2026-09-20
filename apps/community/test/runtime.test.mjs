import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCommunity } from "../server.mjs";

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), "community-runtime-"));
  const calls = [];
  const llm = {
    name: "test-provider",
    async complete(request) {
      calls.push(request);
      return `SendMessage: ${JSON.stringify({ type: "text", content: `[provider] ${request.user.slice(0, 120)}` })}`;
    },
  };
  const app = await startCommunity({
    dataDir,
    port: 0,
    llm,
    env: { COMMUNITY_BOOTSTRAP_TOKEN: "bootstrap", COMMUNITY_PORT: "0" },
  });
  return { app, calls, dataDir, llm };
}

function client(app) {
  let cookie = "";
  let csrf = "";
  return {
    async request(path, body, method = "POST") {
      const headers = { "content-type": "application/json" };
      if (cookie) {
        headers.cookie = cookie;
        headers["x-csrf-token"] = csrf;
      }
      const init = { method, headers };
      if (body !== undefined && method !== "GET")
        init.body = JSON.stringify(body);
      const response = await fetch(`${app.url}${path}`, init);
      const setCookie = response.headers.get("set-cookie");
      if (setCookie) cookie = setCookie.split(";", 1)[0];
      const value = await response.json();
      if (value.csrfToken) csrf = value.csrfToken;
      return { response, value };
    },
  };
}

async function register(c, username = "alice", inviteToken = "bootstrap") {
  const result = await c.request("/api/register", {
    username,
    displayName: username,
    password: "correct horse battery staple",
    inviteToken,
  });
  assert.equal(result.response.status, 201);
  return result;
}

async function createRoom(c, name) {
  const result = await c.request("/api/rooms", {
    name,
    description: `${name} room`,
  });
  assert.equal(result.response.status, 201);
  return result.value.room.id;
}

async function room(c, id) {
  const result = await c.request(`/api/rooms/${id}`, undefined, "GET");
  assert.equal(result.response.status, 200);
  return result.value;
}

async function waitForBot(c, id, expected = 1) {
  for (let i = 0; i < 30; i += 1) {
    const value = await room(c, id);
    if (
      value.messages.filter((message) => message.kind === "bot").length >=
      expected
    )
      return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return room(c, id);
}

test("selected bots receive one bounded call each with shared room context", async (t) => {
  const { app, calls } = await fixture();
  t.after(() => app.close());
  const c = client(app);
  await register(c);
  const roomId = await createRoom(c, "room-a");
  assert.equal(
    (
      await c.request(`/api/rooms/${roomId}/messages`, {
        text: "prior human context",
        botIds: [],
        clientNonce: "human-context",
      })
    ).response.status,
    202,
  );
  const sent = await c.request(`/api/rooms/${roomId}/messages`, {
    text: "private marker ROOM_A_ONLY",
    botIds: ["bot-analyst", "bot-reviewer"],
    clientNonce: "nonce-1",
  });
  assert.equal(sent.response.status, 202);
  const snapshot = await waitForBot(c, roomId, 2);
  assert.equal(
    snapshot.messages.filter((message) => message.kind === "bot").length,
    2,
  );
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.user.includes("ROOM_A_ONLY")));
  assert.ok(calls.every((call) => call.user.includes("prior human context")));
});

test("room context and bot output stay isolated between rooms", async (t) => {
  const { app, calls } = await fixture();
  t.after(() => app.close());
  const c = client(app);
  await register(c);
  const a = await createRoom(c, "room-a");
  const b = await createRoom(c, "room-b");
  await c.request(`/api/rooms/${a}/messages`, {
    text: "marker ROOM_A_SECRET",
    botIds: ["bot-analyst"],
    clientNonce: "a",
  });
  await waitForBot(c, a);
  await c.request(`/api/rooms/${b}/messages`, {
    text: "marker ROOM_B_PUBLIC",
    botIds: ["bot-analyst"],
    clientNonce: "b",
  });
  const snapshot = await waitForBot(c, b);
  assert.ok(
    snapshot.messages.every(
      (message) => !message.text.includes("ROOM_A_SECRET"),
    ),
  );
  const bCall = calls.at(-1);
  assert.ok(bCall.user.includes("ROOM_B_PUBLIC"));
  assert.ok(!bCall.user.includes("ROOM_A_SECRET"));
});

test("same client nonce replays the persisted message without another provider call", async (t) => {
  const { app, calls } = await fixture();
  t.after(() => app.close());
  const c = client(app);
  await register(c);
  const id = await createRoom(c, "idempotent");
  const payload = {
    text: "once",
    botIds: ["bot-creative"],
    clientNonce: "same-nonce",
  };
  assert.equal(
    (await c.request(`/api/rooms/${id}/messages`, payload)).response.status,
    202,
  );
  await waitForBot(c, id);
  const before = calls.length;
  assert.equal(
    (await c.request(`/api/rooms/${id}/messages`, payload)).response.status,
    202,
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls.length, before);
  assert.equal(
    (await room(c, id)).messages.filter((message) => message.kind === "human")
      .length,
    1,
  );
});

test("login and room messages survive shutdown and restart", async (t) => {
  const first = await fixture();
  const c1 = client(first.app);
  await register(c1);
  const id = await createRoom(c1, "persistent");
  await c1.request(`/api/rooms/${id}/messages`, {
    text: "persist this",
    botIds: [],
    clientNonce: "human-1",
  });
  await first.app.close();

  const second = await startCommunity({
    dataDir: first.dataDir,
    port: 0,
    llm: first.llm,
    env: { COMMUNITY_PORT: "0" },
  });
  t.after(() => second.close());
  const c2 = client(second);
  const login = await c2.request("/api/login", {
    username: "alice",
    password: "correct horse battery staple",
  });
  assert.equal(login.response.status, 200);
  const rooms = await c2.request("/api/rooms", undefined, "GET");
  assert.equal(rooms.response.status, 200);
  assert.equal(
    rooms.value.rooms.some((roomValue) => roomValue.id === id),
    true,
  );
  const messages = await room(c2, id);
  assert.equal(
    messages.messages.some((message) => message.text === "persist this"),
    true,
  );
});

test("startCommunity uses an injected OpenClaw adapter and persists its bot message", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "community-openclaw-"));
  const calls = [];
  const openClaw = {
    name: "openclaw:community",
    async complete(request) {
      calls.push(request);
      return 'SendMessage: {"type":"text","content":"OpenClaw fixture response"}';
    },
  };
  const app = await startCommunity({ dataDir, port: 0, openClaw, env: { COMMUNITY_BOOTSTRAP_TOKEN: "bootstrap", COMMUNITY_PORT: "0" } });
  t.after(() => app.close());
  const c = client(app);
  await register(c);
  const id = await createRoom(c, "openclaw-room");
  assert.equal((await c.request(`/api/rooms/${id}/messages`, { text: "hello gateway", botIds: ["bot-analyst"], clientNonce: "oc-1" })).response.status, 202);
  const snapshot = await waitForBot(c, id);
  assert.equal(calls.length, 1);
  assert.equal(snapshot.messages.some((message) => message.kind === "bot" && message.text === "OpenClaw fixture response"), true);
  assert.equal((await c.request("/api/session", undefined, "GET")).value.model.backend, "openclaw");
});
