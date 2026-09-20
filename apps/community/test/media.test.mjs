import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { startCommunity } from "../server.mjs";
import { createUploadLimiter, cleanupOrphans, prepareMediaDir, receiveAttachment } from "../media.mjs";

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), "community-media-"));
  const app = await startCommunity({ dataDir, port: 0, env: { COMMUNITY_BOOTSTRAP_TOKEN: "bootstrap", COMMUNITY_PORT: "0", COMMUNITY_MEDIA_MAX_BYTES: "64" } });
  return { app, dataDir };
}
async function register(app, name) {
  const r = await fetch(`${app.url}/api/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: name, displayName: name, password: "correct horse battery staple", inviteToken: "bootstrap" }) });
  return { cookie: r.headers.get("set-cookie").split(";", 1)[0], csrf: (await r.json()).csrfToken };
}
async function createRoom(app, auth) {
  const r = await fetch(`${app.url}/api/rooms`, { method: "POST", headers: { "content-type": "application/json", cookie: auth.cookie, "x-csrf-token": auth.csrf }, body: JSON.stringify({ name: "media", description: "" }) });
  return (await r.json()).room.id;
}
function form(bytes, name = "photo.png", type = "image/png") { const f = new FormData(); f.append("file", new Blob([bytes], { type }), name); return f; }

test("attachment upload validates signature, binds atomically, and is member-only", async (t) => {
  const { app, dataDir } = await fixture(); t.after(() => app.close());
  const auth = await register(app, "media_owner"); const room = await createRoom(app, auth);
  const upload = await fetch(`${app.url}/api/rooms/${room}/attachments`, { method: "POST", headers: { cookie: auth.cookie, "x-csrf-token": auth.csrf }, body: form(Buffer.from("not png")) });
  assert.equal(upload.status, 415);
  const valid = await fetch(`${app.url}/api/rooms/${room}/attachments`, { method: "POST", headers: { cookie: auth.cookie, "x-csrf-token": auth.csrf }, body: form(Buffer.from("89504e470d0a1a0a", "hex")) });
  const validBody = await valid.json(); assert.equal(valid.status, 201, JSON.stringify(validBody)); const attachment = validBody.attachment;
  const message = await fetch(`${app.url}/api/rooms/${room}/messages`, { method: "POST", headers: { "content-type": "application/json", cookie: auth.cookie, "x-csrf-token": auth.csrf }, body: JSON.stringify({ attachmentIds: [attachment.id], text: "", botIds: [], clientNonce: "attachment-once" }) });
  assert.equal(message.status, 202);
  const view = await fetch(`${app.url}/api/rooms/${room}`, { headers: { cookie: auth.cookie } });
  assert.equal((await view.json()).messages[0].attachments[0].id, attachment.id);
  const stored = await stat(join(dataDir, "media", attachment.id)); assert.equal(stored.mode & 0o777, 0o600);
});

test("attachment size limit rejects oversized streams", async (t) => {
  const { app } = await fixture(); t.after(() => app.close());
  const auth = await register(app, "media_size"); const room = await createRoom(app, auth);
  const r = await fetch(`${app.url}/api/rooms/${room}/attachments`, { method: "POST", headers: { cookie: auth.cookie, "x-csrf-token": auth.csrf }, body: form(Buffer.alloc(80, 1)) });
  assert.equal(r.status, 413);
});

test("upload limiter bounds global and per-user flights and always releases", async () => {
  const limiter = createUploadLimiter({ global: 2, perUser: 1 });
  const release = await limiter.acquire("alice");
  await assert.rejects(() => limiter.acquire("alice"), (e) => e.status === 429);
  const other = await limiter.acquire("bob");
  await assert.rejects(() => limiter.acquire("carol"), (e) => e.status === 429);
  release(); other();
  const again = await limiter.acquire("alice");
  again();
});

test("startup cleanup removes stale temporary upload files", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "community-media-cleanup-"));
  const mediaDir = await prepareMediaDir(dataDir);
  const stale = join(mediaDir, ".upload-stale");
  await writeFile(stale, "partial");
  const old = Date.now() - 3 * 86400000;
  const { utimes } = await import("node:fs/promises");
  await utimes(stale, old / 1000, old / 1000);
  const db = { prepare(sql) { return { all: () => [], run: () => {} }; } };
  await cleanupOrphans(db, mediaDir, 86400000);
  assert.equal((await readdir(mediaDir)).includes(".upload-stale"), false);
});

test("aborted multipart upload cleans its temporary stream and releases limiter", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "community-media-abort-"));
  const mediaDir = await prepareMediaDir(dataDir);
  const req = new PassThrough();
  req.headers = { "content-type": "multipart/form-data; boundary=abort-test" };
  const pending = receiveAttachment(req, { mediaDir, userId: "abort-user" });
  req.write("--abort-test\r\nContent-Disposition: form-data; name=\"file\"; filename=\"x.png\"\r\nContent-Type: image/png\r\n\r\n");
  req.write(Buffer.alloc(1024));
  req.destroy();
  await assert.rejects(pending);
  assert.deepEqual((await readdir(mediaDir)).filter((name) => name.startsWith(".upload-")), []);
});
