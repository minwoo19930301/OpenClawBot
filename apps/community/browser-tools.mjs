import dns from "node:dns/promises";
import net from "node:net";
import { readCdpVersion } from "./cdp.mjs";

const MAX_TEXT = 8000;
const MAX_SCREENSHOT = 2 * 1024 * 1024;
const ACTION_TIMEOUT = 5000;
const NAV_TIMEOUT = 10000;
const PRIVATE_V4 = /^(0\.|10\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|127\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.0\.0\.|192\.0\.2\.|192\.168\.|192\.88\.99\.|198\.1[89]\.|198\.51\.100\.|203\.0\.113\.|22[4-9]\.|23\d\.|24\d\.|25[0-5]\.)/;

export const BROWSER_TOOL_DEFINITIONS = [
  { type: "function", function: { name: "browser_navigate", description: "Navigate the room browser to an approved HTTP(S) URL.", parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"], additionalProperties: false } } },
  { type: "function", function: { name: "browser_snapshot", description: "Read a bounded, untrusted text snapshot and interactive element refs.", parameters: { type: "object", properties: {}, additionalProperties: false } } },
  { type: "function", function: { name: "browser_click", description: "Click an interactive element by its current snapshot ref.", parameters: { type: "object", properties: { ref: { type: "string" } }, required: ["ref"], additionalProperties: false } } },
  { type: "function", function: { name: "browser_type", description: "Type text into an input by its current snapshot ref.", parameters: { type: "object", properties: { ref: { type: "string" }, text: { type: "string", maxLength: 4000 } }, required: ["ref", "text"], additionalProperties: false } } },
  { type: "function", function: { name: "browser_press", description: "Press a named keyboard key in the room browser.", parameters: { type: "object", properties: { key: { type: "string", maxLength: 40 } }, required: ["key"], additionalProperties: false } } },
  { type: "function", function: { name: "browser_scroll", description: "Scroll the room browser viewport up or down.", parameters: { type: "object", properties: { direction: { type: "string", enum: ["up", "down"] } }, required: ["direction"], additionalProperties: false } } },
];

export function isPrivateAddress(address) {
  const normalized = address.replace(/^\[|\]$/g, "").toLowerCase();
  if (net.isIPv4(normalized)) return PRIVATE_V4.test(normalized);
  if (net.isIPv6(normalized)) {
    const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    if (normalized.startsWith("2001:db8:") || normalized.startsWith("2002:")) return true;
    const first = Number.parseInt(normalized.split(":")[0] || "0", 16);
    return first < 0x2000 || first > 0x3fff;
  }
  return false;
}

export async function assertSafeUrl(value, lookup = dns.lookup) {
  let url;
  try { url = new URL(value); } catch { throw Object.assign(new Error("Browser URL is invalid"), { status: 400 }); }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.port && !/^\d+$/.test(url.port))
    throw Object.assign(new Error("Browser URL is not allowed"), { status: 400 });
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || isPrivateAddress(host))
    throw Object.assign(new Error("Browser URL host is not allowed"), { status: 403 });
  let records;
  let timer;
  try {
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("DNS timeout")), 3000); });
    records = await Promise.race([lookup(host, { all: true, verbatim: true }), timeout]);
  } catch { throw Object.assign(new Error("Browser URL host could not be resolved"), { status: 403 }); }
  finally { clearTimeout(timer); }
  if (!records?.length || records.some((r) => isPrivateAddress(r.address)))
    throw Object.assign(new Error("Browser URL resolves to a private address"), { status: 403 });
  return url.href;
}

const clipped = (value, max = MAX_TEXT) => String(value || "").slice(0, max);
function browserEndpoint(endpoint) {
  const base = typeof endpoint === "string" ? endpoint : endpoint?.cdpUrl;
  if (!base) return null;
  let origin;
  try { origin = new URL(base); } catch { return null; }
  if (!/^https?:$/.test(origin.protocol)) return null;
  return { base, origin, headers: { Host: "localhost" } };
}
async function contextAddBypassServiceWorker(session, page) {
  if (!session.context.newCDPSession || session.cdpPages.has(page)) return;
  try { const cdp = await session.context.newCDPSession(page); await cdp.send("Network.enable"); await cdp.send("Network.setBypassServiceWorker", { bypass: true }); session.cdpPages.add(page); session.cdpSessions.set(page, cdp); } catch {}
}

export function createBrowserTools({ desktops, playwright, fetchImpl } = {}) {
  if (!(desktops instanceof Map)) throw new TypeError("desktops must be a Map");
  const sessions = new Map();
  const connecting = new Map();
  const queues = new Map();
  const connector = playwright || null;
  let sequence = 0;
  const get = (roomId) => desktops.get(roomId);
  const fail = (status, message) => Object.assign(new Error(message), { status });
  const connect = async (roomId) => {
    const endpoint = get(roomId);
    if (!endpoint) throw fail(503, "Browser tools are not configured for this room");
    const existing = sessions.get(roomId);
    if (existing?.browser?.isConnected?.()) return existing;
    if (connecting.has(roomId)) return connecting.get(roomId);
    const pending = (async () => {
    const pw = connector || await import("playwright-core");
    if (!pw.chromium?.connectOverCDP) throw new Error("playwright-core is unavailable");
    const target = browserEndpoint(endpoint);
    if (!target) throw fail(503, "Browser endpoint is unavailable");
    const info = fetchImpl
      ? await fetchImpl(new URL("/json/version", target.base), { headers: target.headers, redirect: "error", signal: AbortSignal.timeout(3000) }).then(async (response) => response?.ok ? response.json() : null).catch(() => null)
      : await readCdpVersion(new URL("/json/version", target.base)).catch(() => null);
    if (!info) throw fail(503, "Browser CDP endpoint is unavailable");
    let ws;
    try { ws = new URL(info?.webSocketDebuggerUrl); } catch { throw fail(503, "Browser CDP endpoint is invalid"); }
    if (ws.username || ws.password || ws.search || ws.hash || !/^wss?:$/.test(ws.protocol) || !/^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(ws.pathname)) throw fail(503, "Browser CDP endpoint is invalid");
    ws.protocol = target.origin.protocol === "https:" ? "wss:" : "ws:";
    ws.hostname = target.origin.hostname;
    ws.port = target.origin.port;
    const browser = await pw.chromium.connectOverCDP(ws.href, { timeout: ACTION_TIMEOUT, headers: target.headers });
    const context = browser.contexts()[0];
    if (!context) { await browser.close().catch(() => {}); throw fail(503, "Browser context is unavailable"); }
    await context.setDefaultTimeout(ACTION_TIMEOUT);
    await context.setDefaultNavigationTimeout(NAV_TIMEOUT);
    await context.addInitScript(() => {
      try { navigator.serviceWorker.register = () => Promise.reject(new Error("service workers disabled")); } catch {}
    }).catch(() => {});
    const route = async (r) => {
      const requestUrl = r.request().url();
      try { if (/^(data:|blob:)/i.test(requestUrl)) return r.continue(); if (/^wss?:/i.test(new URL(requestUrl).protocol)) throw new Error("websocket blocked"); await assertSafeUrl(requestUrl); await r.continue(); } catch { await r.abort(); }
    };
    await context.route("**/*", route);
    const socketRoute = async (ws) => { try { await ws.close(); } catch {} };
    if (context.routeWebSocket) await context.routeWebSocket("**/*", socketRoute).catch(() => {});
    const session = { browser, context, pages: new Map(), refs: new Map(), generation: 0, route, socketRoute, cdpPages: new WeakSet(), cdpSessions: new Map() };
    sessions.set(roomId, session);
    return session;
    })();
    connecting.set(roomId, pending);
    try { return await pending; } finally { connecting.delete(roomId); }
  };
  const pageFor = async (roomId) => {
    const session = await connect(roomId);
    let page = session.pages.get(roomId);
    if (!page || page.isClosed()) {
      page = session.context.pages()[0] || await session.context.newPage();
      session.pages.set(roomId, page);
    }
    await contextAddBypassServiceWorker(session, page);
    await page.bringToFront();
    return { session, page };
  };
  const snapshot = async (roomId) => {
    const { session, page } = await pageFor(roomId);
    const id = `s${++sequence}`;
    const loc = page.locator("a,button,input,textarea,select,[role=button]");
    const allHandles = loc.elementHandles ? await loc.elementHandles() : [];
    const handles = allHandles.slice(0, 100);
    await Promise.all(allHandles.slice(100).map((handle) => handle.dispose?.().catch?.(() => {})));
    const elements = await Promise.all(handles.map((handle, i) => handle.evaluate((node, index) => { const s = getComputedStyle(node); const r = node.getBoundingClientRect(); return { i: index, tag: node.tagName.toLowerCase(), role: node.getAttribute("role") || "", text: (node.innerText || node.getAttribute("aria-label") || node.getAttribute("placeholder") || "").slice(0, 180), href: node.getAttribute("href") || "", type: node.getAttribute("type") || "", visible: s.display !== "none" && s.visibility !== "hidden" && r.width > 0 && r.height > 0 }; }, i).catch(() => null))).then((items) => items.filter((e) => e?.visible));
    const refs = new Map(elements.map((e, visibleIndex) => [`${id}-${visibleIndex}`, { ...e, handle: handles[e.i], pageUrl: page.url?.() || "" }]));
    await Promise.all([...session.refs.values()].map((item) => item.handle?.dispose?.().catch?.(() => {})));
    const kept = new Set([...refs.values()].map(item => item.handle));
    await Promise.all(handles.filter(handle => !kept.has(handle)).map(handle => handle.dispose?.().catch?.(() => {})));
    session.refs = refs;
    session.generation++;
    const body = clipped(await page.locator("body").evaluate(node => node.innerText.slice(0,5000)).catch(() => ""), 5000);
    const lines = [...refs.values()].map((e, i) => `[${id}-${i}] ${e.tag}${e.type ? ` type=${e.type}` : ""}${e.href ? ` href=${e.href}` : ""} ${e.text}`);
    return clipped(`[UNTRUSTED BROWSER SNAPSHOT]\n${body}\nInteractive elements:\n${lines.join("\n")}`);
  };
  const run = async (roomId, name, args = {}, { signal } = {}) => {
    if (signal?.aborted) throw fail(499, "Browser action cancelled");
    const { session, page } = await pageFor(roomId);
    if (name === "browser_snapshot") return snapshot(roomId);
    if (name === "browser_navigate") { const url = await assertSafeUrl(args.url); await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT }); return snapshot(roomId); }
    if (name === "browser_click" || name === "browser_type") {
      const item = session.refs.get(String(args.ref)); if (!item) throw fail(400, "Unknown or expired browser ref");
      if (!item.handle || (item.handle.evaluate && !(await item.handle.evaluate((el) => el.isConnected)))) throw fail(400, "Browser ref expired");
      if (item.pageUrl && page.url && page.url() !== item.pageUrl) throw fail(400, "Browser ref expired");
      if (name === "browser_click") await item.handle.click({ timeout: ACTION_TIMEOUT }); else { if (!/^(input|textarea|select)$/.test(item.tag)) throw fail(400, "Browser ref is not an input"); await item.handle.fill(String(args.text ?? "").slice(0, 4000)); }
      return snapshot(roomId);
    }
    if (name === "browser_press") { const key = String(args.key); if (!/^(Enter|Tab|Escape|Backspace|Delete|Arrow(?:Up|Down|Left|Right)|Home|End|PageUp|PageDown|Space|Control\+A)$/.test(key)) throw fail(400, "Key is not allowed"); await page.keyboard.press(key); return snapshot(roomId); }
    if (name === "browser_scroll") { if (!["up", "down"].includes(args.direction)) throw fail(400, "Invalid scroll direction"); await page.mouse.wheel(0, args.direction === "down" ? 600 : -600); return snapshot(roomId); }
    throw fail(400, "Unknown browser tool");
  };
  const execute = async (roomId, name, args = {}, options = {}) => {
    if (options.signal?.aborted) throw fail(499, "Browser action cancelled");
    const previous = queues.get(roomId) || Promise.resolve();
    const current = previous.catch(() => {}).then(() => run(roomId, name, args, options));
    const tracked = current.then(() => {}, () => {}).finally(() => { if (queues.get(roomId) === tracked) queues.delete(roomId); });
    queues.set(roomId, tracked);
    return current;
  };
  const screenshot = async (roomId) => { const { page } = await pageFor(roomId); const png = await page.screenshot({ type: "png", fullPage: false, animations: "disabled", timeout: ACTION_TIMEOUT }); if (png.length > MAX_SCREENSHOT) throw fail(413, "Browser screenshot is too large"); return png; };
  const close = async () => { await Promise.all([...queues.values()].map((q) => q.catch(() => {}))); await Promise.all([...connecting.values()].map((q) => q.catch(() => {}))); await Promise.all([...sessions.values()].map(async (s) => { await s.context.unroute("**/*", s.route).catch(() => {}); if (s.context.unrouteWebSocket) await s.context.unrouteWebSocket("**/*", s.socketRoute).catch(() => {}); for (const cdp of s.cdpSessions.values()) await cdp.detach?.().catch?.(() => {}); for (const item of s.refs.values()) await item.handle?.dispose?.().catch?.(() => {}); await s.browser.close().catch(() => {}); })); sessions.clear(); queues.clear(); connecting.clear(); };
  return { configured: (roomId) => desktops.has(roomId), execute, screenshot, close };
}
