import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readCdpVersion } from "../cdp.mjs";

test("CDP discovery sends an actual localhost Host header", async (t) => {
  let seenHost = "";
  const server = createServer((req, res) => {
    seenHost = req.headers.host;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ webSocketDebuggerUrl: "ws://desktop/devtools/browser/test" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const port = server.address().port;
  const value = await readCdpVersion(`http://127.0.0.1:${port}/json/version`);
  assert.equal(seenHost, "localhost");
  assert.equal(value.webSocketDebuggerUrl, "ws://desktop/devtools/browser/test");
});

test("CDP discovery bounds oversized responses", async (t) => {
  const server = createServer((_req, res) => res.end("x".repeat(64 * 1024 + 1)));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  await assert.rejects(() => readCdpVersion(`http://127.0.0.1:${server.address().port}/json/version`), /too large/);
});

test("CDP discovery has an absolute deadline even while bytes arrive", async (t) => {
  const server = createServer((_req, res) => {
    res.write('{');
    const timer = setInterval(() => res.write(' '), 10);
    res.on('close', () => clearInterval(timer));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  await assert.rejects(() => readCdpVersion(`http://127.0.0.1:${server.address().port}/json/version`, {timeoutMs:100}), /timed out/);
});
