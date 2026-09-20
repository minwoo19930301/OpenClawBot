import test from "node:test";
import assert from "node:assert/strict";
import { createECDH, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { startCommunity } from "../server.mjs";

const password = "push-test-password";
function keyPair() {
  const key = createECDH("prime256v1");
  key.generateKeys();
  return { publicKey: key.getPublicKey().toString("base64url"), privateKey: key.getPrivateKey().toString("base64url") };
}
function subscription(label) {
  return { endpoint: `https://fcm.googleapis.com/fcm/send/${label}`, keys: { p256dh: keyPair().publicKey, auth: randomBytes(16).toString("base64url") } };
}
async function fixture(t, send) {
  const dataDir = await mkdtemp(join(tmpdir(), "community-push-http-"));
  const keys = keyPair();
  const sent = [];
  const app = await startCommunity({ dataDir, port: 0, pushSendImpl: send ?? (async (sub, payload) => { sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) }); }), env: {
    COMMUNITY_BOOTSTRAP_TOKEN: "test-bootstrap",
    COMMUNITY_DEMO: "1",
    COMMUNITY_PUSH_PUBLIC_KEY: keys.publicKey,
    COMMUNITY_PUSH_PRIVATE_KEY: keys.privateKey,
    COMMUNITY_PUSH_SUBJECT: "https://example.com",
  } });
  const db = new DatabaseSync(join(dataDir, "community.sqlite"));
  t.after(async () => { await app.close(); db.close(); await rm(dataDir, { recursive: true, force: true }); });
  async function call(path, { method = "GET", body, auth, csrf = true } = {}) {
    const headers = { "content-type": "application/json" };
    if (auth) { headers.cookie = auth.cookie; if (csrf) headers["x-csrf-token"] = auth.csrf; }
    const response = await fetch(app.url + path, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body ?? {}), signal: AbortSignal.timeout(3000) });
    const data = await response.json();
    return { status: response.status, data, response };
  }
  async function register(name, admin) {
    const inviteToken = admin ? (await call("/api/admin/invites", { method: "POST", auth: admin })).data.token : "test-bootstrap";
    const value = await call("/api/register", { method: "POST", body: { username: name, displayName: name, password, inviteToken } });
    assert.equal(value.status, 201);
    return { id: value.data.user.id, cookie: value.response.headers.get("set-cookie").split(";", 1)[0], csrf: value.data.csrfToken };
  }
  async function subscribe(auth, sub) { return call("/api/push/subscriptions", { method: "POST", auth, body: { subscription: sub } }); }
  async function flush() {
    // Let the queued send callbacks run; all transport is local and deterministic.
    for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 10));
  }
  return { app, db, sent, call, register, subscribe, flush };
}

test("push HTTP routes enforce authentication, CSRF, ownership, and DELETE body parsing", async t => {
  const f = await fixture(t);
  const owner = await f.register("push_owner");
  const other = await f.register("push_other", owner);
  const sub = subscription("owner-device");
  assert.equal((await f.call("/api/push/config")).status, 401);
  assert.equal((await f.call("/api/push/config", { auth: owner })).data.configured, true);
  assert.equal((await f.call("/api/push/subscriptions", { method: "POST", auth: owner, csrf: false, body: { subscription: sub } })).status, 403);
  assert.equal((await f.subscribe(owner, sub)).status, 201);
  assert.equal((await f.subscribe(other, sub)).status, 409);
  assert.equal((await f.call("/api/push/test", { method: "POST", auth: other, body: { endpoint: sub.endpoint } })).status, 404);
  await f.call("/api/push/subscriptions", { method: "DELETE", auth: other, body: { endpoint: sub.endpoint } });
  assert.equal(f.db.prepare("SELECT count(*) n FROM push_subscriptions").get().n, 1);
  assert.equal((await f.call("/api/push/subscriptions", { method: "DELETE", auth: owner, body: { endpoint: sub.endpoint } })).status, 200);
  assert.equal(f.db.prepare("SELECT count(*) n FROM push_subscriptions").get().n, 0);
});

test("room pushes exclude sender and outsiders, protect content, and stop after membership/session loss", async t => {
  const f = await fixture(t);
  const owner = await f.register("push_room_owner");
  const member = await f.register("push_room_member", owner);
  const outsider = await f.register("push_room_outsider", owner);
  const room = (await f.call("/api/rooms", { method: "POST", auth: owner, body: { name: "PRIVATE ROOM NAME" } })).data.room.id;
  const invite = (await f.call(`/api/rooms/${room}/invites`, { method: "POST", auth: owner })).data.token;
  await f.call("/api/rooms/join", { method: "POST", auth: member, body: { token: invite } });
  const ownerSub = subscription("sender");
  const memberSub = subscription("member");
  const outsiderSub = subscription("outsider");
  for (const [auth, sub] of [[owner, ownerSub], [member, memberSub], [outsider, outsiderSub]]) assert.equal((await f.subscribe(auth, sub)).status, 201);
  async function message(extra = {}) { return f.call(`/api/rooms/${room}/messages`, { method: "POST", auth: owner, body: { text: "PRIVATE MESSAGE CONTENT", botIds: [], clientNonce: randomUUID(), ...extra } }); }
  assert.equal((await message()).status, 202);
  await f.flush();
  assert.deepEqual(f.sent.map(x => x.endpoint), [memberSub.endpoint]);
  assert.equal(f.sent[0].payload.url, `/?room=${room}`);
  assert.doesNotMatch(JSON.stringify(f.sent[0].payload), /PRIVATE|push_room_/);
  f.sent.length = 0;
  assert.equal((await message({ botIds: ["bot-analyst"] })).status, 202);
  for (let i = 0; i < 100 && f.sent.length < 3; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.sent.length, 3, "human message reaches member; bot reply reaches both members");
  assert.equal(f.sent.filter(item => item.endpoint === ownerSub.endpoint).length, 1);
  assert.equal(f.sent.filter(item => item.endpoint === outsiderSub.endpoint).length, 0);
  f.sent.length = 0;
  assert.equal((await message({ attachmentIds: [randomUUID()] })).status, 400);
  await f.flush();
  assert.equal(f.sent.length, 0, "rolled-back attachment message must not notify");
  f.db.prepare("DELETE FROM room_members WHERE room_id=? AND user_id=?").run(room, member.id);
  await message(); await f.flush();
  assert.equal(f.sent.length, 0);
  f.db.prepare("INSERT INTO room_members VALUES(?,?,?)").run(room, member.id, "member");
  f.db.prepare("UPDATE sessions SET expires_at=0 WHERE user_id=?").run(member.id);
  await message(); await f.flush();
  assert.equal(f.sent.length, 0, "expired sessions must not receive pushes");
});

test("logout removes only current-session push subscriptions and test delivery reports failure", async t => {
  const f = await fixture(t, async () => { throw new Error("transport unavailable"); });
  const user = await f.register("push_sessions");
  const first = subscription("first-session");
  await f.subscribe(user, first);
  const login = await f.call("/api/login", { method: "POST", body: { username: "push_sessions", password } });
  const secondSession = { cookie: login.response.headers.get("set-cookie").split(";", 1)[0], csrf: login.data.csrfToken };
  const second = subscription("second-session");
  await f.subscribe(secondSession, second);
  assert.equal((await f.call("/api/push/test", { method: "POST", auth: user, body: { endpoint: first.endpoint } })).status, 502);
  assert.equal((await f.call("/api/logout", { method: "POST", auth: user })).status, 200);
  assert.deepEqual(f.db.prepare("SELECT endpoint FROM push_subscriptions").all().map(x => x.endpoint), [second.endpoint]);
});
