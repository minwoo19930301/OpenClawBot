import webpush from "web-push";
import https from "node:https";
import { ECDH } from "node:crypto";

const HOSTS = ["push.services.mozilla.com", "fcm.googleapis.com", "android.googleapis.com", "web.push.apple.com"];
const allowedHost = host => HOSTS.some(allowed => host === allowed || host.endsWith(`.${allowed}`));
export function validateEndpoint(value) {
  if (typeof value !== "string" || value.length > 2048 || !value.startsWith("https://")) throw new Error("Invalid push endpoint");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.port || !allowedHost(url.hostname) || url.username || url.password || url.hash) throw new Error("Push endpoint is not allowed");
  return url.href;
}
function decodeKey(value, length) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value) || value.length > 128) throw new Error("Invalid push key");
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== length || decoded.toString("base64url") !== value) throw new Error("Invalid push key");
  return decoded;
}
export function validateSubscription(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid push subscription");
  const endpoint = validateEndpoint(value.endpoint);
  const p256dh = decodeKey(value.keys?.p256dh, 65);
  decodeKey(value.keys?.auth, 16);
  if (p256dh[0] !== 4) throw new Error("Invalid P-256 key");
  ECDH.convertKey(p256dh, "prime256v1");
  const expirationTime = value.expirationTime ?? null;
  if (expirationTime !== null && (!Number.isSafeInteger(expirationTime) || expirationTime <= Date.now())) throw new Error("Invalid push expiration");
  return { endpoint, p256dh: value.keys.p256dh, auth: value.keys.auth, expirationTime };
}
const asSubscription = row => ({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } });

export function createPushService({ db, env, concurrency = 4, sendImpl } = {}) {
  const values = [env.COMMUNITY_PUSH_PUBLIC_KEY, env.COMMUNITY_PUSH_PRIVATE_KEY, env.COMMUNITY_PUSH_SUBJECT];
  const configured = values.every(Boolean);
  if (values.some(Boolean) && !configured) throw new Error("Incomplete Web Push configuration");
  const vapidDetails = configured ? { publicKey: values[0], privateKey: values[1], subject: values[2] } : null;
  if (configured) webpush.getVapidHeaders("https://fcm.googleapis.com", values[2], values[0], values[1], "aes128gcm");
  const send = sendImpl ?? ((subscription, payload) => sendNotificationBounded(subscription, payload, vapidDetails));
  const queue = [], inFlight = new Set();
  let active = 0, closed = false;
  const parallelism = Math.max(1, Math.min(4, concurrency));
  function enqueue(task) {
    if (closed || queue.length >= 256) return Promise.reject(new Error("Push queue unavailable"));
    const result = new Promise((resolve, reject) => queue.push({ task, resolve, reject }));
    pump();
    return result;
  }
  function pump() {
    while (!closed && active < parallelism && queue.length) {
      const item = queue.shift();
      active++;
      const work = Promise.resolve().then(item.task).then(item.resolve, item.reject).finally(() => {
        active--; inFlight.delete(work); pump();
      });
      inFlight.add(work);
    }
  }
  function currentRow(row, roomId) {
    const current = db.prepare(`SELECT s.* FROM push_subscriptions s JOIN sessions x
      ON x.id_hash=s.session_hash AND x.user_id=s.user_id
      WHERE s.endpoint=? AND s.user_id=? AND s.session_hash=? AND x.expires_at>?
      AND (s.expiration_time IS NULL OR s.expiration_time>?)`).get(row.endpoint, row.user_id, row.session_hash, Date.now(), Date.now());
    if (!current) return null;
    if (roomId && ((current.room_id && current.room_id !== roomId) || !db.prepare("SELECT 1 FROM room_members WHERE room_id=? AND user_id=?").get(roomId, current.user_id))) return null;
    return current;
  }
  async function sendRow(row, payload, roomId) {
    const current = currentRow(row, roomId);
    if (!current) return false;
    try {
      await send(asSubscription(current), payload);
      return true;
    } catch (error) {
      if (error?.statusCode === 404 || error?.statusCode === 410) {
        db.prepare("DELETE FROM push_subscriptions WHERE endpoint=? AND session_hash=?").run(row.endpoint, row.session_hash);
        return false;
      }
      throw error;
    }
  }
  async function notifyRoom(roomId, kind, authorId) {
    if (!configured || closed || !["human", "bot"].includes(kind)) return;
    const rows = db.prepare(`SELECT s.* FROM push_subscriptions s JOIN sessions x ON x.id_hash=s.session_hash AND x.user_id=s.user_id
      JOIN room_members m ON m.room_id=? AND m.user_id=s.user_id
      WHERE x.expires_at>? AND (s.expiration_time IS NULL OR s.expiration_time>?)
      AND (s.room_id IS NULL OR s.room_id=?) LIMIT 256`).all(roomId, Date.now(), Date.now(), roomId);
    const payload = JSON.stringify({ title: "Open Grokbot", body: kind === "bot" ? "새로운 봇 답변이 도착했습니다." : "새로운 메시지가 도착했습니다.", url: `/?room=${encodeURIComponent(roomId)}`, tag: `room-${roomId}` });
    await Promise.allSettled(rows.filter(row => !(kind === "human" && row.user_id === authorId)).map(row => enqueue(() => sendRow(row, payload, roomId))));
  }
  async function sendTest(row) {
    if (!configured) throw new Error("Push is unavailable");
    return enqueue(() => sendRow(row, JSON.stringify({ title: "Open Grokbot", body: "푸시 알림 테스트입니다.", tag: "push-test", url: "/" })));
  }
  async function close() {
    closed = true;
    for (const item of queue.splice(0)) item.reject(new Error("Push service closed"));
    await Promise.allSettled([...inFlight]);
  }
  return { configured, notifyRoom, sendTest, close };
}

export function sendNotificationBounded(subscription, payload, vapidDetails, { requestImpl = https.request, timeoutMs = 3000 } = {}) {
  const details = webpush.generateRequestDetails(subscription, payload, { TTL: 60, urgency: "normal", vapidDetails });
  const target = new URL(validateEndpoint(details.endpoint));
  return new Promise((resolve, reject) => {
    let timer, settled = false;
    const finish = error => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(); };
    const request = requestImpl(target, { method: details.method, headers: details.headers }, response => {
      let bytes = 0;
      response.on("data", chunk => { bytes += chunk.length; if (bytes > 64 * 1024) request.destroy(new Error("Push response too large")); });
      response.on("end", () => finish(response.statusCode >= 200 && response.statusCode < 300 ? null : Object.assign(new Error("Push provider rejected request"), { statusCode: response.statusCode })));
      response.on("error", finish);
      response.on("aborted", () => finish(new Error("Push response aborted")));
    });
    timer = setTimeout(() => request.destroy(new Error("Push request timed out")), timeoutMs);
    request.on("error", finish);
    request.on("close", () => { if (!settled) finish(new Error("Push connection closed")); });
    request.end(details.body);
  });
}
