import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCommunity } from "../server.mjs";

const password = "correct horse battery staple";
async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), "community-media-access-"));
  const app = await startCommunity({ dataDir, port: 0, env: { COMMUNITY_BOOTSTRAP_TOKEN: "bootstrap", COMMUNITY_MEDIA_MAX_BYTES: "128" } });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  return app;
}
async function register(app, username, inviteToken = "bootstrap") {
  const response = await fetch(`${app.url}/api/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, displayName: username, password, inviteToken }) });
  const data = await response.json();
  return { cookie: response.headers.get("set-cookie").split(";", 1)[0], csrf: data.csrfToken, data };
}
async function json(app, path, { method = "GET", auth, body } = {}) {
  const headers = {};
  if (auth) { headers.cookie = auth.cookie; headers["x-csrf-token"] = auth.csrf; }
  if (method !== "GET") headers["content-type"] = "application/json";
  const response = await fetch(`${app.url}${path}`, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
  return { response, data: await response.json().catch(() => null) };
}
function uploadForm(bytes, name = "voice.ogg", mime = "audio/ogg") { const form = new FormData(); form.append("file", new Blob([bytes], { type: mime }), name); return form; }

test("attachments are unauthenticated/member protected, bind on post, and support audio suffix ranges", async (t) => {
  const app = await fixture(t);
  const owner = await register(app, "media_owner_access");
  const roomResult = await json(app, "/api/rooms", { method: "POST", auth: owner, body: { name: "media room", description: "" } });
  const room = roomResult.data.room.id;
  const bytes = Buffer.concat([Buffer.from("OggS"), Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])]);
  const unauth = await fetch(`${app.url}/api/rooms/${room}/attachments/${"0".repeat(36)}`);
  assert.equal(unauth.status, 401);
  const upload = await fetch(`${app.url}/api/rooms/${room}/attachments`, { method: "POST", headers: { cookie: owner.cookie, "x-csrf-token": owner.csrf }, body: uploadForm(bytes) });
  assert.equal(upload.status, 201);
  const attachment = (await upload.json()).attachment;
  assert.equal(Object.hasOwn(attachment, "path"), false);
  const siteInvite = await json(app, "/api/admin/invites", { method: "POST", auth: owner });
  const invite = await json(app, `/api/rooms/${room}/invites`, { method: "POST", auth: owner });
  const member = await register(app, "media_member_access", siteInvite.data.token);
  const memberJoin = await json(app, "/api/rooms/join", { method: "POST", auth: member, body: { token: invite.data.token } });
  assert.equal(memberJoin.response.status, 200);
  const unboundMember = await fetch(`${app.url}${attachment.url}`, { headers: { cookie: member.cookie } });
  assert.equal(unboundMember.status, 404);
  const post = await json(app, `/api/rooms/${room}/messages`, { method: "POST", auth: owner, body: { text: "", botIds: [], attachmentIds: [attachment.id], clientNonce: "media-access" } });
  assert.equal(post.response.status, 202);
  const memberFile = await fetch(`${app.url}${attachment.url}`, { headers: { cookie: member.cookie } });
  assert.equal(memberFile.status, 200);
  assert.deepEqual(Buffer.from(await memberFile.arrayBuffer()), bytes);
  const suffix = await fetch(`${app.url}${attachment.url}`, { headers: { cookie: member.cookie, range: "bytes=-4" } });
  assert.equal(suffix.status, 206);
  assert.equal(suffix.headers.get("content-range"), `bytes ${bytes.length - 4}-${bytes.length - 1}/${bytes.length}`);
  assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), bytes.subarray(-4));
  const outsiderResponse = await fetch(`${app.url}/api/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "media_outsider_access", displayName: "outsider", password, inviteToken: "bootstrap" }) });
  assert.equal(outsiderResponse.status, 403);
});
