import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { EventEmitter } from "node:events";
import { createECDH } from "node:crypto";
import webpush from "web-push";
import { createPushService, sendNotificationBounded, validateSubscription } from "../push.mjs";

const endpoint = "https://fcm.googleapis.com/fcm/send/example";
const ecdh = createECDH("prime256v1"); ecdh.generateKeys();
const keys = { p256dh: ecdh.getPublicKey().toString("base64url"), auth: Buffer.alloc(16, 7).toString("base64url") };
function subscription(extra = {}) { return { endpoint, keys, ...extra }; }
function dbFixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE users(id TEXT PRIMARY KEY); CREATE TABLE sessions(id_hash TEXT PRIMARY KEY,user_id TEXT,expires_at INTEGER); CREATE TABLE rooms(id TEXT PRIMARY KEY); CREATE TABLE room_members(room_id TEXT,user_id TEXT); CREATE TABLE push_subscriptions(endpoint TEXT PRIMARY KEY,user_id TEXT,session_hash TEXT,room_id TEXT,p256dh TEXT,auth TEXT,expiration_time INTEGER);`);
  db.prepare("INSERT INTO users VALUES(?)").run("u1"); db.prepare("INSERT INTO sessions VALUES(?,?,?)").run("s1", "u1", Date.now() + 60000); db.prepare("INSERT INTO rooms VALUES(?)").run("r1"); db.prepare("INSERT INTO room_members VALUES(?,?)").run("r1", "u1");
  db.prepare("INSERT INTO push_subscriptions VALUES(?,?,?,?,?,?,?)").run(endpoint, "u1", "s1", null, keys.p256dh, keys.auth, null);
  return db;
}

test("push endpoint and cryptographic key validation is strict", () => {
  assert.equal(validateSubscription(subscription()).endpoint, endpoint);
  assert.throws(() => validateSubscription(subscription({ endpoint: "https://127.0.0.1/x" })));
  assert.throws(() => validateSubscription(subscription({ keys: { p256dh: "x", auth: "x" } })));
  assert.throws(() => validateSubscription(subscription({ expirationTime: Date.now() - 1 })));
});

test("stale subscriptions are cleaned after a provider 410", async () => {
  const db = dbFixture(); let active = 0; let peak = 0; let calls = 0;
  const vapid = webpush.generateVAPIDKeys();
  const service = createPushService({ db, env: { COMMUNITY_PUSH_PUBLIC_KEY: vapid.publicKey, COMMUNITY_PUSH_PRIVATE_KEY: vapid.privateKey, COMMUNITY_PUSH_SUBJECT: "https://example.com" }, concurrency: 4, sendImpl: async () => { active++; peak = Math.max(peak, active); calls++; await new Promise((resolve) => setTimeout(resolve, 5)); active--; throw Object.assign(new Error("gone"), { statusCode: 410 }); } });
  await service.notifyRoom("r1", "bot", null);
  assert.equal(calls, 1); assert.equal(peak, 1); assert.equal(db.prepare("SELECT count(*) n FROM push_subscriptions").get().n, 0);
  await service.close(); db.close();
});

test("concurrent room events share four send slots and queued sends recheck membership", async () => {
  const db = dbFixture();
  for (let i = 0; i < 7; i++) db.prepare("INSERT INTO push_subscriptions VALUES(?,?,?,?,?,?,?)").run(`${endpoint}-${i}`, "u1", "s1", null, keys.p256dh, keys.auth, null);
  const vapid = webpush.generateVAPIDKeys();
  const releases = [];
  let calls = 0;
  const service = createPushService({ db, env: { COMMUNITY_PUSH_PUBLIC_KEY: vapid.publicKey, COMMUNITY_PUSH_PRIVATE_KEY: vapid.privateKey, COMMUNITY_PUSH_SUBJECT: "https://example.com" }, sendImpl: async () => { calls++; await new Promise(resolve => releases.push(resolve)); } });
  const jobs = [service.notifyRoom("r1", "bot", null), service.notifyRoom("r1", "bot", null)];
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 4, "parallel events must share a global send limit");
  db.prepare("DELETE FROM room_members WHERE room_id=?").run("r1");
  releases.forEach(resolve => resolve());
  await Promise.all(jobs);
  assert.equal(calls, 4, "queued notifications must stop once membership is revoked");
  await service.close(); db.close();
});

test("bounded transport encrypts payload and enforces absolute timeout", async () => {
  const vapid = webpush.generateVAPIDKeys(); let sentBody; let sentHeaders;
  const requestImpl = (_url, options, callback) => { sentHeaders = options.headers; const req = new EventEmitter(); req.end = (body) => { sentBody = body; const response = new EventEmitter(); response.statusCode = 201; callback(response); queueMicrotask(() => response.emit("end")); }; req.destroy = (error) => queueMicrotask(() => req.emit("error", error)); return req; };
  await sendNotificationBounded(subscription(), "secret text", { subject: "https://example.com", publicKey: vapid.publicKey, privateKey: vapid.privateKey }, { requestImpl });
  const header = (name) => sentHeaders[name] ?? sentHeaders[name.toLowerCase()] ?? sentHeaders[Object.keys(sentHeaders).find((key) => key.toLowerCase() === name.toLowerCase())];
  assert.ok(header("authorization")); assert.ok(header("content-encoding")); assert.ok(!sentBody.includes("secret text"));
  const slowRequest = (_url, _options, _callback) => { const req = new EventEmitter(); req.end = () => {}; req.destroy = (error) => queueMicrotask(() => req.emit("error", error)); return req; };
  await assert.rejects(() => sendNotificationBounded(subscription(), "x", { subject: "https://example.com", publicKey: vapid.publicKey, privateKey: vapid.privateKey }, { requestImpl: slowRequest, timeoutMs: 10 }), /timed out/);
});
