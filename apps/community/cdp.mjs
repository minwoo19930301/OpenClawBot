import http from "node:http";

/** Read-only bounded CDP discovery. Node's fetch normalizes Host for some
 * container hostnames; http.request sends the required localhost Host header. */
export function readCdpVersion(url, { timeoutMs = 3000, maxBytes = 64 * 1024 } = {}) {
  const target = url instanceof URL ? url : new URL(url);
  if (target.protocol !== "http:") throw new Error("CDP discovery requires HTTP");
  return new Promise((resolve, reject) => {
    let deadline;
    const fail = error => { clearTimeout(deadline); reject(error); };
    const request = http.request({ hostname: target.hostname.replace(/^\[|\]$/g, ''), port: target.port || 80, path: `${target.pathname}${target.search}`, method: "GET", headers: { Host: "localhost", Accept: "application/json" }, timeout: timeoutMs }, (response) => {
      const chunks = []; let size = 0;
      response.on("data", (chunk) => { size += chunk.length; if (size > maxBytes) { request.destroy(new Error("CDP response too large")); return; } chunks.push(chunk); });
      response.on("end", () => { clearTimeout(deadline); if (response.statusCode !== 200) return reject(new Error(`CDP discovery failed (${response.statusCode})`)); try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(new Error("CDP discovery returned invalid JSON")); } });
      response.on("error", fail);
    });
    request.on("timeout", () => request.destroy(new Error("CDP discovery timed out")));
    request.on("error", fail);
    deadline = setTimeout(() => request.destroy(new Error("CDP discovery timed out")), timeoutMs);
    request.end();
  });
}
