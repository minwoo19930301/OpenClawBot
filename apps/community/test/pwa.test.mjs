import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
function worker(windows = []) {
  const events = new Map();
  const notifications = [];
  const opened = [];
  const self = {
    location: { origin: "https://example.com" },
    addEventListener: (name, handler) => events.set(name, handler),
    skipWaiting: async () => {},
    registration: { showNotification: async (title, options) => notifications.push({ title, options }) },
    clients: { claim: async () => {}, matchAll: async () => windows, openWindow: async url => opened.push(url) },
  };
  vm.runInNewContext(source, { self, URL });
  return { events, notifications, opened };
}
async function dispatch(handler, detail) {
  const waiting = [];
  handler({ ...detail, waitUntil: promise => waiting.push(promise) });
  await Promise.all(waiting);
}

test("service worker does not intercept or cache private requests", () => {
  assert.equal(worker().events.has("fetch"), false);
  // The sandbox intentionally provides no CacheStorage; lifecycle/push must work without it.
});

test("push safely handles missing/malformed data and confines notification destinations", async () => {
  const w = worker();
  for (const value of [null, "unexpected", {}, { title: "New activity", body: "Message", url: "https://evil.example/?room=secret" }]) {
    await dispatch(w.events.get("push"), { data: { json: () => value } });
    assert.equal(w.notifications.at(-1).options.data.url, "https://example.com/");
  }
  await dispatch(w.events.get("push"), { data: { json() { throw new Error("invalid JSON"); } } });
  assert.equal(w.notifications.length, 5);
});

test("notification click opens the room, stripping arbitrary paths and query parameters", async () => {
  const room = "4bc4b8f0-1789-4afb-a927-e7adbcc7b9b9";
  const w = worker();
  await dispatch(w.events.get("notificationclick"), { notification: { close() {}, data: { url: `/?room=${room}&redirect=https://evil.example` } } });
  assert.deepEqual(w.opened, [`https://example.com/?room=${room}`]);
  await dispatch(w.events.get("notificationclick"), { notification: { close() {}, data: { url: "/api/logout" } } });
  assert.equal(w.opened.at(-1), "https://example.com/");
});

test("notification click reuses and focuses an existing app window", async () => {
  const actions = [];
  const w = worker([{ url: "https://example.com/", navigate: async url => actions.push(["navigate", url]), focus: async () => actions.push(["focus"]) }]);
  await dispatch(w.events.get("notificationclick"), { notification: { close() {}, data: { url: "/?room=example-room" } } });
  assert.deepEqual(actions, [["navigate", "https://example.com/?room=example-room"], ["focus"]]);
  assert.equal(w.opened.length, 0);
});

test("install manifest supplies same-origin standalone application and real PNG icons", async () => {
  const manifest = JSON.parse(await readFile(new URL("../public/manifest.webmanifest", import.meta.url), "utf8"));
  assert.equal(manifest.display, "standalone");
  assert.equal(new URL(manifest.start_url, "https://example.com").origin, "https://example.com");
  for (const size of [192, 512]) {
    const icon = manifest.icons.find(item => item.sizes === `${size}x${size}` && item.type === "image/png");
    assert.ok(icon, `PNG icon ${size} missing`);
    const bytes = await readFile(new URL(`../public${icon.src}`, import.meta.url));
    assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(bytes.readUInt32BE(16), size);
    assert.equal(bytes.readUInt32BE(20), size);
  }
});
