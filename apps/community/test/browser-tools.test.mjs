import test from "node:test";
import assert from "node:assert/strict";
import { createBrowserTools, assertSafeUrl, isPrivateAddress, BROWSER_TOOL_DEFINITIONS } from "../browser-tools.mjs";

test("browser URL validation blocks credentials, private DNS, and metadata ranges", async () => {
  assert.equal(isPrivateAddress("127.0.0.1"), true);
  assert.equal(isPrivateAddress("169.254.169.254"), true);
  assert.equal(isPrivateAddress("100.100.10.1"), true);
  assert.equal(isPrivateAddress("::1"), true);
  assert.equal(isPrivateAddress("2001:db8::1"), true);
  assert.equal(isPrivateAddress("2002:c000:0204::1"), true);
  await assert.rejects(() => assertSafeUrl("http://user:pass@example.com", async () => [{ address: "93.184.216.34" }]), /not allowed/);
  await assert.rejects(() => assertSafeUrl("http://example.com", async () => [{ address: "10.0.0.4" }]), /private/);
  assert.equal(await assertSafeUrl("https://example.com/path", async () => [{ address: "93.184.216.34" }]), "https://example.com/path");
});

test("unconfigured rooms return 503 and definitions stay bounded", async () => {
  const tools = createBrowserTools({ desktops: new Map() });
  assert.equal(tools.configured("missing"), false);
  await assert.rejects(() => tools.execute("missing", "browser_snapshot"), (e) => e.status === 503);
  assert.equal(BROWSER_TOOL_DEFINITIONS.length, 6);
  assert.ok(BROWSER_TOOL_DEFINITIONS.every((d) => d.function.parameters.additionalProperties === false));
  await tools.close();
});

test("fake CDP browser keeps one page per room and refs are snapshot scoped", async () => {
  const nodes = [
    { tagName: "BUTTON", innerText: "Send", getAttribute: (k) => k === "aria-label" ? "Send" : null },
    { tagName: "INPUT", value: "", getAttribute: (k) => k === "type" ? "text" : null },
  ];
  const page = {
    closed: false, isClosed() { return this.closed; }, async bringToFront() {},
    url() { return "https://example.com"; },
    locator(selector) { return { async evaluateAll() { return []; }, async evaluate(fn) { return fn({innerText:"hello"}); }, async elementHandles() { return nodes.map((node, i) => ({ async evaluate(fn) { return String(fn).includes("getComputedStyle") ? { i, tag: node.tagName.toLowerCase(), role: "", text: node.innerText || "", href: "", type: node.getAttribute("type") || "", visible: true } : true; }, async click() { this.clicked = i; }, async fill(text) { nodes[i].value = text; }, async dispose() {} })); }, async innerText() { return "hello"; }, nth(i) { return { async click() { this.clicked = i; }, async fill(text) { nodes[i].value = text; } }; } }; },
    async screenshot() { return Buffer.from("png"); }, async goto(url) { this.url = url; }, keyboard: { async press() {} }, mouse: { async wheel() {} },
  };
  const context = { pages: () => [page], async setDefaultTimeout() {}, async setDefaultNavigationTimeout() {}, async addInitScript() {}, async route() {}, async unroute() {} };
  const browser = { contexts: () => [context], isConnected: () => true, async close() {} };
  const tools = createBrowserTools({ desktops: new Map([["room", { cdpUrl: "http://cdp", wsUrl: "ws://127.0.0.1:6080/websockify" }]]), fetchImpl: async () => ({ ok: true, async json() { return { webSocketDebuggerUrl: "ws://127.0.0.1:9223/devtools/browser/fake-id" }; } }), playwright: { chromium: { async connectOverCDP() { return browser; } } } });
  const snapshot = await tools.execute("room", "browser_snapshot");
  assert.match(snapshot, /\[s1-0\]/);
  await tools.execute("room", "browser_type", { ref: "s1-1", text: "hello" });
  assert.equal(nodes[1].value, "hello");
  await tools.close();
});
