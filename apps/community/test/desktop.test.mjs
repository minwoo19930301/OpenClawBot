import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";
import { parseDesktops, createDesktopHub } from "../desktop.mjs";
import { startCommunity } from "../server.mjs";

const password = "correct horse battery staple";
const id = () => randomUUID();

test("desktop map rejects shared and external endpoints", () => {
  const room = id();
  const other = id();
  const map = (a, b) => JSON.stringify({
    [room]: { wsUrl: a, cdpUrl: "http://127.0.0.1:9001" },
    [other]: { wsUrl: b, cdpUrl: "http://127.0.0.1:9002" },
  });
  assert.throws(() => parseDesktops(map("ws://127.0.0.1:9000", "ws://127.0.0.1:9000")), /cannot be shared/);
  assert.throws(() => parseDesktops(map("ws://example.test:9000", "ws://127.0.0.1:9003")), /dedicated loopback/);
  assert.throws(() => parseDesktops(JSON.stringify({ [room]: { wsUrl: "ws://desktop.example:9000", cdpUrl: "http://127.0.0.1:9001" } })), /dedicated loopback/);
});

async function upstreamFixture() {
  const server = createServer((req, res) => {
    if (req.url === "/json/version") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ Browser: "fixture" }));
    } else { res.writeHead(404); res.end(); }
  });
  const wss = new WebSocketServer({ noServer: true });
  const received = [];
  wss.on("connection", (socket) => socket.on("message", (data, binary) => {
    received.push({ data: Buffer.from(data), binary });
    socket.send(data, { binary });
  }));
  server.on("upgrade", (req, socket, head) => {
    if (req.url === "/vnc") wss.handleUpgrade(req, socket, head, (client) => wss.emit("connection", client, req));
    else socket.destroy();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return {
    wsUrl: `ws://127.0.0.1:${port}/vnc`,
    cdpUrl: `http://127.0.0.1:${port}`,
    received,
    close: async () => { wss.close(); await new Promise((resolve) => server.close(resolve)); },
  };
}

async function register(app, username, inviteToken = "bootstrap") {
  const response = await fetch(`${app.url}/api/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, displayName: username, password, inviteToken }),
  });
  const data = await response.json();
  return { response, data, cookie: response.headers.get("set-cookie").split(";", 1)[0], csrf: data.csrfToken };
}

async function desktopRequest(app, path, { method = "GET", cookie, csrf, origin, body = {} } = {}) {
  const headers = { cookie, "x-csrf-token": csrf, origin };
  if (method !== "GET") headers["content-type"] = "application/json";
  const response = await fetch(`${app.url}${path}`, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body) });
  return { response, data: await response.json().catch(() => null) };
}

function socketAttempt(url, { cookie, origin }) {
  return new Promise((resolve) => {
    const socket = new WebSocket(url, { headers: { cookie, origin } });
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve({ socket, ...value }); } };
    socket.once("open", () => finish({ open: true }));
    socket.once("unexpected-response", (_request, response) => finish({ open: false, status: response.statusCode }));
    socket.once("error", () => finish({ open: false, status: 0 }));
    setTimeout(() => finish({ open: false, status: 0 }), 2000).unref();
  });
}

test("desktop ticket is CSRF/member/origin/session bound and proxies binary frames", async (t) => {
  const upstream = await upstreamFixture();
  const room = id();
  const dataDir = await mkdtemp(join(tmpdir(), "community-desktop-"));
  const app = await startCommunity({
    dataDir,
    port: 0,
    env: {
      COMMUNITY_BOOTSTRAP_TOKEN: "bootstrap",
      COMMUNITY_INITIAL_ROOM_ID: room,
      COMMUNITY_DESKTOP_MAP: JSON.stringify({ [room]: { wsUrl: upstream.wsUrl, cdpUrl: upstream.cdpUrl } }),
    },
  });
  t.after(async () => { await app.close(); await upstream.close(); await rm(dataDir, { recursive: true, force: true }); });
  const admin = await register(app, "desktop_admin");
  const origin = app.url;
  const status = await desktopRequest(app, `/api/rooms/${room}/desktop`, { cookie: admin.cookie, csrf: admin.csrf, origin });
  assert.deepEqual(status.data, { configured: true, available: true, browserEnabled: true });
  const csrfBlocked = await desktopRequest(app, `/api/rooms/${room}/desktop/ticket`, { method: "POST", cookie: admin.cookie, csrf: "wrong", origin });
  assert.equal(csrfBlocked.response.status, 403);
  const ticketResult = await desktopRequest(app, `/api/rooms/${room}/desktop/ticket`, { method: "POST", cookie: admin.cookie, csrf: admin.csrf, origin });
  assert.equal(ticketResult.response.status, 201);
  const wsPath = `${app.url.replace(/^http/, "ws")}${ticketResult.data.websocketPath}`;
  const connected = await socketAttempt(wsPath, { cookie: admin.cookie, origin });
  assert.equal(connected.open, true);
  const frame = Buffer.from([0, 1, 2, 255]);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const echoed = new Promise((resolve, reject) => {
    connected.socket.once("message", (data, binary) => resolve({ data: Buffer.from(data), binary }));
    setTimeout(() => reject(new Error("upstream binary frame timeout")), 2000).unref();
  });
  connected.socket.send(frame);
  assert.deepEqual(await echoed, { data: frame, binary: true });
  assert.deepEqual(upstream.received[0], { data: frame, binary: true });
  connected.socket.close();
  const replay = await socketAttempt(wsPath, { cookie: admin.cookie, origin });
  assert.equal(replay.open, false);
  const wrongOriginTicket = await desktopRequest(app, `/api/rooms/${room}/desktop/ticket`, { method: "POST", cookie: admin.cookie, csrf: admin.csrf, origin: "http://evil.test" });
  assert.equal(wrongOriginTicket.response.status, 403);
  const originTicket = await desktopRequest(app, `/api/rooms/${room}/desktop/ticket`, { method: "POST", cookie: admin.cookie, csrf: admin.csrf, origin });
  const wrongOriginSocket = await socketAttempt(`${app.url.replace(/^http/, "ws")}${originTicket.data.websocketPath}`, { cookie: admin.cookie, origin: "http://evil.test" });
  assert.equal(wrongOriginSocket.open, false);
  const inviteResponse = await desktopRequest(app, "/api/admin/invites", { method: "POST", cookie: admin.cookie, csrf: admin.csrf, origin });
  const member = await register(app, "desktop_member", inviteResponse.data.token);
  const outsiderTicket = await desktopRequest(app, `/api/rooms/${room}/desktop/ticket`, { method: "POST", cookie: member.cookie, csrf: member.csrf, origin });
  assert.equal(outsiderTicket.response.status, 404);
  const sessionTicket = await desktopRequest(app, `/api/rooms/${room}/desktop/ticket`, { method: "POST", cookie: admin.cookie, csrf: admin.csrf, origin });
  assert.equal(sessionTicket.response.status, 201);
  const logout = await desktopRequest(app, "/api/logout", { method: "POST", cookie: admin.cookie, csrf: admin.csrf, origin });
  assert.equal(logout.response.status, 200);
  const afterLogout = await socketAttempt(`${app.url.replace(/^http/, "ws")}${sessionTicket.data.websocketPath}`, { cookie: admin.cookie, origin });
  assert.equal(afterLogout.open, false);
});

test("startup initial room is created for the first admin", async (t) => {
  const upstream = await upstreamFixture();
  const room = id();
  const dataDir = await mkdtemp(join(tmpdir(), "community-desktop-initial-"));
  const app = await startCommunity({ dataDir, port: 0, env: { COMMUNITY_BOOTSTRAP_TOKEN: "bootstrap", COMMUNITY_INITIAL_ROOM_ID: room, COMMUNITY_DESKTOP_MAP: JSON.stringify({ [room]: { wsUrl: upstream.wsUrl, cdpUrl: upstream.cdpUrl } }) } });
  t.after(async () => { await app.close(); await upstream.close(); await rm(dataDir, { recursive: true, force: true }); });
  const admin = await register(app, "initial_admin");
  const rooms = await desktopRequest(app, "/api/rooms", { cookie: admin.cookie, csrf: admin.csrf, origin: app.url });
  assert.equal(rooms.response.status, 200);
  assert.ok(rooms.data.rooms.some((entry) => entry.id === room));
});

test("hub issueTicket requires configured desktop", () => {
  const server = createServer();
  const hub = createDesktopHub({ server, desktops: new Map(), userFor: () => null, roomFor: () => {}, originFor: () => "http://local" });
  assert.throws(() => hub.issueTicket({ id: "u", sessionHash: "s" }, id()), /OCI/);
  hub.close();
});
