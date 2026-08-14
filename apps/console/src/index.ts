#!/usr/bin/env node
/**
 * Browser control plane (the non-Electron shell).
 *
 * A single Node process hosts the SessionRuntime and exposes:
 * - GET  /               embedded chat UI
 * - GET  /api/agents     roster
 * - GET  /api/transcript transcript of one agent
 * - POST /api/send       user prompt (clientNonce idempotent)
 * - POST /api/broadcast  fan-out to all/selected agents
 * - POST /api/a2a        agent-to-agent message
 * - POST /api/group      group conversation round
 * - GET  /events         SSE live feed (transcript/send-message/group events)
 *
 * The LLM comes from the environment (createLlmFromEnv); without keys it
 * falls back to the deterministic MockLlm so the console always runs.
 */

import { createServer as createHttpServer } from "node:http";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { MockLlm, createLlmFromEnv } from "@open-grokbot/llm";
import { AgentToAgentMessaging } from "@open-grokbot/messaging";
import { SessionRuntime } from "@open-grokbot/runner";
import type { Llm } from "@open-grokbot/llm";

import { UI_HTML } from "./ui.js";

export interface ConsoleOptions {
  port?: number;
  dataDir?: string;
  llm?: Llm;
  /** Seed agents created at boot (id/name/description). */
  seedAgents?: readonly { id: string; name: string; description?: string; isGroup?: boolean; memberIds?: string[] }[];
  onReady?: (info: { port: number; url: string }) => void;
}

export interface RunningConsole {
  readonly port: number;
  readonly url: string;
  readonly runtime: SessionRuntime;
  close(): Promise<void>;
}

export async function startConsole(options: ConsoleOptions = {}): Promise<RunningConsole> {
  const dataDir = options.dataDir ?? join(process.cwd(), ".open-grokbot-data");
  mkdirSync(dataDir, { recursive: true });
  let llm = options.llm;
  if (llm == null) {
    try {
      llm = createLlmFromEnv();
      console.log("[console] using LLM from environment");
    } catch (error) {
      console.log(`[console] env LLM unavailable (${String(error)}); falling back to MockLlm`);
      llm = new MockLlm({});
    }
  }
  const runtime = new SessionRuntime({
    rootDir: dataDir,
    llmFor: () => llm!,
    onMessage: (agentId, content, kind) => {
      broadcastSse({ agentId, who: kind === "group" ? "group" : "agent", text: content, kind });
    },
  });
  const a2a = new AgentToAgentMessaging(runtime.hub());

  const sseClients = new Set<import("node:http").ServerResponse>();
  function broadcastSse(event: { agentId: string; who: string; text: string; kind: string }): void {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of sseClients) {
      try {
        res.write(payload);
      } catch {
        sseClients.delete(res);
      }
    }
  }

  const server = createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (url.pathname === "/" && req.method === "GET") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(UI_HTML);
        return;
      }
      if (url.pathname === "/events" && req.method === "GET") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        res.write("retry: 1000\n\n");
        sseClients.add(res);
        // Roster re-seed on every (re)connect, mirroring the original's
        // agents-roster-seed: the client refreshes its agent list after any
        // stream drop and reconnect.
        void (async () => {
          try {
            const ids = await runtime.listAgentIds();
            const agents = [];
            for (const id of ids) {
              const session = await runtime.getSession(id);
              agents.push({ id, name: session.name, isGroup: session.isGroup });
            }
            res.write(`data: ${JSON.stringify({ kind: "roster-seed", agents })}\n\n`);
          } catch {
            // best-effort; the client re-requests /api/agents anyway
          }
        })();
        req.on("close", () => sseClients.delete(res));
        return;
      }
      if (url.pathname === "/api/agents" && req.method === "GET") {
        const ids = await runtime.listAgentIds();
        const agents = [];
        for (const id of ids) {
          const session = await runtime.getSession(id);
          agents.push({ id, name: session.name, isGroup: session.isGroup });
        }
        respond(res, 200, agents);
        return;
      }
      if (url.pathname === "/api/health" && req.method === "GET") {
        respond(res, 200, { ok: true, pid: process.pid });
        return;
      }
      if (url.pathname === "/api/transcript" && req.method === "GET") {
        const agentId = url.searchParams.get("agent") ?? "";
        const session = await runtime.getSession(agentId);
        respond(res, 200, { agentId, entries: session.getTranscriptEntries() });
        return;
      }
      if (url.pathname === "/api/send" && req.method === "POST") {
        const body = await readJson(req);
        await runtime.sendUserPrompt(String(body.agentId), String(body.prompt), {
          ...(typeof body.clientNonce === "string" ? { clientNonce: body.clientNonce } : {}),
        });
        broadcastSse({ agentId: String(body.agentId), who: "user", text: String(body.prompt), kind: "user" });
        respond(res, 200, { accepted: true });
        return;
      }
      if (url.pathname === "/api/broadcast" && req.method === "POST") {
        const body = await readJson(req);
        const result = await runtime.broadcastMessaging.broadcastToAgents(
          Array.isArray(body.targets) ? (body.targets as string[]) : "all",
          String(body.text),
        );
        respond(res, 200, result);
        return;
      }
      if (url.pathname === "/api/a2a" && req.method === "POST") {
        const body = await readJson(req);
        const result = await a2a.sendToAgent(String(body.from), String(body.to), String(body.text), {
          ...(body.priority === true ? { priority: true } : {}),
        });
        respond(res, 200, result);
        return;
      }
      if (url.pathname === "/api/group" && req.method === "POST") {
        const body = await readJson(req);
        await runtime.runGroupConversation({ groupId: String(body.roomId), memberIds: (body.memberIds as string[]) });
        respond(res, 200, { ok: true });
        return;
      }
      respond(res, 404, { error: "not found" });
    } catch (error) {
      respond(res, 500, { error: String(error) });
    }
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port ?? 0;
  const url = `http://127.0.0.1:${port}`;

  for (const seed of options.seedAgents ?? []) {
    if (!(await runtime.hasSession(seed.id))) {
      await runtime.createAgent({
        id: seed.id,
        name: seed.name,
        description: seed.description,
        ...(seed.isGroup === true ? { isGroup: true, memberIds: seed.memberIds ?? [] } : {}),
      });
      console.log(`[console] seeded agent ${seed.id} (${seed.name})`);
    }
  }

  options.onReady?.({ port, url });
  console.log(`[console] listening on ${url}`);
  return {
    port,
    url,
    runtime,
    close: () =>
      new Promise<void>((resolve) => {
        for (const res of sseClients) res.end();
        sseClients.clear();
        runtime.dispose();
        server.close(() => resolve());
      }),
  };
}

function respond(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readJson(req: import("node:http").IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(raw.length > 0 ? raw : "{}") as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

/** CLI entry: run the console with default seed agents. */
export async function main(): Promise<void> {
  await startConsole({
    seedAgents: [
      { id: "alpha", name: "Alpha", description: "roadmap planner" },
      { id: "beta", name: "Beta", description: "design lead" },
      { id: "gamma", name: "Gamma", description: "research analyst" },
      { id: "squad", name: "Squad", description: "the group room", isGroup: true, memberIds: ["alpha", "beta", "gamma"] },
    ],
  });
}

if (process.argv[1] != null && process.env.OPEN_GROKBOT_NO_CLI !== "1" && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, "/")}`).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
