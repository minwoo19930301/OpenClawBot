import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCommunity } from "../server.mjs";

const password = "a sufficiently long password";

async function fixture(env = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "community-review-"));
  const app = await startCommunity({
    dataDir,
    port: 0,
    env: {
      ...env,
      COMMUNITY_BOOTSTRAP_TOKEN:
        env.COMMUNITY_BOOTSTRAP_TOKEN ?? "bootstrap-secret",
    },
  });
  const close = async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  };
  return { app, close };
}

async function call(
  app,
  path,
  { method = "GET", body, cookie, csrf, origin } = {},
) {
  const headers = {};
  if (body !== undefined || method === "POST")
    headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  if (csrf) headers["x-csrf-token"] = csrf;
  if (origin) headers.origin = origin;
  const response = await fetch(`${app.url}${path}`, {
    method,
    headers,
    body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
    signal: AbortSignal.timeout(1500),
  });
  const text = await response.text();
  return { response, data: text ? JSON.parse(text) : null };
}

async function register(app, username, inviteToken = "bootstrap-secret") {
  const result = await call(app, "/api/register", {
    method: "POST",
    body: { username, displayName: username, password, inviteToken },
  });
  const cookie = result.response.headers.get("set-cookie")?.split(";", 1)[0];
  return { ...result, cookie, csrf: result.data?.csrfToken };
}

test("concurrent bootstrap registration creates at most one admin", async () => {
  const { app, close } = await fixture();
  try {
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => register(app, `first_${i}`)),
    );
    assert.equal(results.filter((r) => r.response.status === 201).length, 1);
    assert.equal(
      results.filter((r) => r.data?.user?.role === "admin").length,
      1,
    );
  } finally {
    await close();
  }
});

test("a site invitation can be redeemed exactly once under concurrency", async () => {
  const { app, close } = await fixture();
  try {
    const admin = await register(app, "admin_one");
    const invitation = await call(app, "/api/admin/invites", {
      method: "POST",
      cookie: admin.cookie,
      csrf: admin.csrf,
    });
    assert.equal(invitation.response.status, 201);
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        register(app, `member_${i}`, invitation.data.token),
      ),
    );
    assert.equal(results.filter((r) => r.response.status === 201).length, 1);
  } finally {
    await close();
  }
});

test("unauthenticated POST returns 401 promptly and CSRF is enforced", async () => {
  const { app, close } = await fixture();
  try {
    const unauth = await call(app, "/api/rooms", {
      method: "POST",
      body: { name: "blocked" },
    });
    assert.equal(unauth.response.status, 401);
    const user = await register(app, "csrf_user");
    const missing = await call(app, "/api/rooms", {
      method: "POST",
      body: { name: "blocked" },
      cookie: user.cookie,
    });
    assert.equal(missing.response.status, 403);
    const valid = await call(app, "/api/rooms", {
      method: "POST",
      body: { name: "allowed" },
      cookie: user.cookie,
      csrf: user.csrf,
    });
    assert.equal(valid.response.status, 201);
  } finally {
    await close();
  }
});

test("non-member cannot read, write, or invite in another room", async () => {
  const { app, close } = await fixture();
  try {
    const owner = await register(app, "room_owner");
    const outsider = await register(
      app,
      "room_outsider",
      (
        await call(app, "/api/admin/invites", {
          method: "POST",
          cookie: owner.cookie,
          csrf: owner.csrf,
        })
      ).data.token,
    );
    const made = await call(app, "/api/rooms", {
      method: "POST",
      body: { name: "private" },
      cookie: owner.cookie,
      csrf: owner.csrf,
    });
    const roomId = made.data.room.id;
    const read = await call(app, `/api/rooms/${roomId}`, {
      cookie: outsider.cookie,
    });
    const write = await call(app, `/api/rooms/${roomId}/messages`, {
      method: "POST",
      body: { text: "intrusion", clientNonce: "n1" },
      cookie: outsider.cookie,
      csrf: outsider.csrf,
    });
    const invite = await call(app, `/api/rooms/${roomId}/invites`, {
      method: "POST",
      cookie: outsider.cookie,
      csrf: outsider.csrf,
    });
    assert.equal(read.response.status, 404);
    assert.equal(write.response.status, 404);
    assert.equal(invite.response.status, 404);
  } finally {
    await close();
  }
});

test("origin policy rejects a mismatched browser origin", async () => {
  const { app, close } = await fixture({
    COMMUNITY_ORIGIN: "https://community.example",
  });
  try {
    const result = await call(app, "/api/health", {
      origin: "https://evil.example",
    });
    assert.equal(result.response.status, 403);
  } finally {
    await close();
  }
});

test("global daily quota applies across users and duplicate nonce is idempotent", async () => {
  const { app, close } = await fixture({
    COMMUNITY_DEMO: "1",
    COMMUNITY_GLOBAL_DAILY_TURNS: "1",
    COMMUNITY_DAILY_TURNS: "10",
  });
  try {
    const first = await register(app, "quota_first");
    const siteInvite = await call(app, "/api/admin/invites", {
      method: "POST",
      cookie: first.cookie,
      csrf: first.csrf,
    });
    const second = await register(app, "quota_second", siteInvite.data.token);
    const room = await call(app, "/api/rooms", {
      method: "POST",
      body: { name: "quota" },
      cookie: first.cookie,
      csrf: first.csrf,
    });
    const message = {
      text: "hello",
      botIds: ["bot-analyst"],
      clientNonce: "once",
    };
    const one = await call(app, `/api/rooms/${room.data.room.id}/messages`, {
      method: "POST",
      body: message,
      cookie: first.cookie,
      csrf: first.csrf,
    });
    const duplicate = await call(
      app,
      `/api/rooms/${room.data.room.id}/messages`,
      { method: "POST", body: message, cookie: first.cookie, csrf: first.csrf },
    );
    assert.equal(one.response.status, 202);
    assert.equal(duplicate.response.status, 202);
    const view = await call(app, `/api/rooms/${room.data.room.id}`, {
      cookie: first.cookie,
    });
    assert.equal(
      view.data.messages.filter((m) => m.kind === "human" && m.text === "hello")
        .length,
      1,
    );
    const otherRoom = await call(app, "/api/rooms", {
      method: "POST",
      body: { name: "second" },
      cookie: second.cookie,
      csrf: second.csrf,
    });
    const over = await call(
      app,
      `/api/rooms/${otherRoom.data.room.id}/messages`,
      {
        method: "POST",
        body: { text: "over", botIds: ["bot-analyst"], clientNonce: "other" },
        cookie: second.cookie,
        csrf: second.csrf,
      },
    );
    assert.equal(over.response.status, 429);
  } finally {
    await close();
  }
});

test("bot request without configured LLM returns a clear service error", async () => {
  const { app, close } = await fixture();
  try {
    const user = await register(app, "no_llm_user");
    const room = await call(app, "/api/rooms", {
      method: "POST",
      body: { name: "bots" },
      cookie: user.cookie,
      csrf: user.csrf,
    });
    const result = await call(app, `/api/rooms/${room.data.room.id}/messages`, {
      method: "POST",
      body: { text: "run", botIds: ["bot-analyst"], clientNonce: "llm" },
      cookie: user.cookie,
      csrf: user.csrf,
    });
    assert.equal(result.response.status, 503);
    assert.match(result.data.error, /LLM|설정|모델|model/i);
    const after = await call(app, "/api/rooms", { cookie: user.cookie });
    assert.equal(after.data.usage.used, 0);
    const view = await call(app, `/api/rooms/${room.data.room.id}`, {
      cookie: user.cookie,
    });
    assert.equal(view.data.messages.length, 0);
  } finally {
    await close();
  }
});
