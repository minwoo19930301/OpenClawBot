import { createHash, randomUUID } from "node:crypto";
import { BROWSER_TOOL_DEFINITIONS } from "../../browser-tools.mjs";
import { normalizeBotOutput } from "../../model-output.mjs";

const MAX_TEXT = 8000;

/**
 * Small server-only adapter for OpenClaw's documented OpenResponses endpoint.
 * It deliberately exposes no Gateway session listing, tools, files, or browser
 * access. Each turn has a fresh session key scoped to user, room, and bot.
 * Only validated application-owned browser client tools can be dispatched.
 * The dedicated Gateway must separately deny its built-in tools.
 */
export class OpenClawHttpAdapter {
  constructor({ baseUrl, token, agentId = "default", fetchImpl = fetch, timeoutMs = 20_000, allowPrivateHttp = false } = {}) {
    if (typeof baseUrl !== "string" || !baseUrl) throw new Error("OpenClaw base URL is required");
    const endpoint = new URL(baseUrl.replace(/\/+$/, "") + "/v1/responses");
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
        (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" &&
        (["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname) || (allowPrivateHttp && endpoint.hostname === "openclaw"))))) {
      throw new Error("OpenClaw endpoint must use HTTPS");
    }
    if (typeof token !== "string" || token.length < 16) throw new Error("OpenClaw gateway token is required");
    if (!/^[\w.-]{1,80}$/.test(agentId)) throw new Error("OpenClaw agent id is invalid");
    this.name = `openclaw:${agentId}`;
    this.endpoint = endpoint;
    this.token = token;
    this.agentId = agentId;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  sessionKey({ userId, roomId, botId, turnNonce = randomUUID() }) {
    if (![userId, roomId, botId].every((value) => typeof value === "string" && value.length > 0)) {
      throw new Error("OpenClaw isolation identifiers are required");
    }
    const digest = createHash("sha256").update(`${userId}\0${roomId}\0${botId}\0${turnNonce}`).digest("hex");
    return `community:${digest}`;
  }

  async complete(request, signal) {
    if (signal?.aborted) throw new Error("OpenClaw request was cancelled");
    const isolation = request?.isolation;
    const sessionKey = this.sessionKey({ ...(isolation ?? {}), turnNonce: randomUUID() });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const input = [
        ...(request.system ? [{ type: "message", role: "system", content: String(request.system).slice(0, MAX_TEXT) }] : []),
        ...(request.context ? [{ type: "message", role: "developer", content: String(request.context).slice(0, MAX_TEXT) }] : []),
        { type: "message", role: "user", content: String(request.user ?? "").slice(0, MAX_TEXT) },
      ];
      const browser = request?.browser;
      let actions = 0;
      for (let callCount = 0; callCount < 5; callCount += 1) {
      const tools = browser && actions < 4 && callCount < 4 ? BROWSER_TOOL_DEFINITIONS.map((tool) => ({ type: "function", name: tool.function.name, description: tool.function.description, parameters: tool.function.parameters })) : [];
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${this.token}`, "x-openclaw-agent-id": this.agentId, "x-openclaw-session-key": sessionKey },
        body: JSON.stringify({ model: `openclaw/${this.agentId}`, input, max_output_tokens: 512, store: false, tools, tool_choice: tools.length ? "auto" : "none" }),
      });
      if (!response.ok) { await response.body?.cancel?.(); throw new Error("OpenClaw gateway rejected request"); }
      const payload = await readJsonLimited(response, 128 * 1024);
      const calls = Array.isArray(payload?.output) ? payload.output.filter((item) => item?.type === "function_call") : [];
      if (calls.length) {
        if (!browser || calls.length > 4 - actions) throw new Error("OpenClaw browser action budget exceeded");
        if (callCount >= 4 || typeof request.beforeAdditionalModelCall !== "function") throw new Error("OpenClaw continuation quota is unavailable");
        input.push(...(Array.isArray(payload.output) ? payload.output : []));
        for (const call of calls) {
          if (typeof call.call_id !== "string" || call.call_id.length > 200 || typeof call.name !== "string" || !BROWSER_TOOL_DEFINITIONS.some((tool) => tool.function.name === call.name) || typeof call.arguments !== "string" || call.arguments.length > 10000) throw new Error("Invalid OpenClaw browser tool call");
          let args; try { args = JSON.parse(call.arguments); } catch { throw new Error("Invalid OpenClaw browser tool arguments"); }
          actions += 1;
          let output;
          try { output = await browser(call.name, args, { signal }); } catch (error) { output = error?.status ? error.message : "The browser action failed."; }
          input.push({ type: "function_call_output", call_id: call.call_id, output: String(output).slice(0, 8000) });
        }
        await request.beforeAdditionalModelCall();
        continue;
      }
      const text = extractText(payload);
      if (!text) throw new Error("OpenClaw gateway returned no text");
      return normalizeBotOutput(text);
      }
      throw new Error("OpenClaw browser turn budget exhausted");
    } catch (error) {
      if (controller.signal.aborted && !signal?.aborted) throw new Error("OpenClaw gateway request timed out");
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }
}

async function readJsonLimited(response, maxBytes) {
  if (!response.body) {
    const raw = await response.arrayBuffer();
    if (raw.byteLength > maxBytes) throw new Error("OpenClaw response too large");
    return JSON.parse(Buffer.from(raw).toString("utf8"));
  }
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) throw new Error("OpenClaw response too large");
      chunks.push(Buffer.from(next.value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function extractText(payload) {
  if (typeof payload?.output_text === "string") return payload.output_text;
  if (!Array.isArray(payload?.output)) return "";
  return payload.output.flatMap((item) => Array.isArray(item?.content) ? item.content : [])
    .map((part) => typeof part?.text === "string" ? part.text : "")
    .join("");
}

export function createOpenClawFromEnv(env = process.env, fetchImpl = fetch) {
  if (!(env.COMMUNITY_OPENCLAW_BASE_URL && env.COMMUNITY_OPENCLAW_TOKEN)) return null;
  return new OpenClawHttpAdapter({ baseUrl: env.COMMUNITY_OPENCLAW_BASE_URL, token: env.COMMUNITY_OPENCLAW_TOKEN, agentId: env.COMMUNITY_OPENCLAW_AGENT_ID ?? "default", fetchImpl, allowPrivateHttp: env.COMMUNITY_OPENCLAW_ALLOW_PRIVATE_HTTP === "1" });
}
