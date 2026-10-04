import test from "node:test";
import assert from "node:assert/strict";
import { createProviderPool, formatModelList, publicModels, readProviders } from "../providers.mjs";

const modelsResponse = (ids, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => ({ data: ids.map((id) => ({ id })) }),
  body: { cancel: async () => {} },
});

test("provider reader keeps named keys and numbered keys, and drops secrets from duplicates", () => {
  const providers = readProviders({
    GROQ_API_KEY: "groq-a",
    GROQ_API_KEY_2: "groq-b",
    OPENROUTER_API_KEY: "route-a",
    COMMUNITY_LLM_BASE_URL: "https://api.groq.com/openai/v1",
    COMMUNITY_LLM_API_KEY: "groq-a",
    COMMUNITY_LLM_PROVIDERS: JSON.stringify([
      { name: "extra", baseUrl: "https://api.example.test/v1", apiKey: "extra-key" },
      { name: "bad", baseUrl: "http://example.test/v1", apiKey: "nope" },
    ]),
  });
  assert.deepEqual(providers.map((provider) => provider.name), ["groq", "groq", "openrouter", "extra"]);
  assert.equal(JSON.stringify(providers).includes("groq-a"), true);
});

test("model listing reads each API at call time and rotation stays on keys that have the model", async () => {
  const seen = [];
  const pool = createProviderPool({
    GROQ_API_KEY: "secret-one",
    GROQ_API_KEY_2: "secret-two",
    OPENAI_API_KEY: "secret-openai",
  }, async (url, options) => {
    seen.push({ url, authorization: options.headers.authorization });
    if (url.includes("openai.com")) return modelsResponse(["gpt-4o-mini"]);
    if (options.headers.authorization.endsWith("secret-two")) return modelsResponse([], 429);
    return modelsResponse(["llama-3.1-8b-instant", "openai/gpt-oss-120b"]);
  });
  const listed = await pool.listModels();
  assert.equal(seen.length, 3);
  assert.equal(seen.every((call) => call.url.endsWith("/models")), true);
  const text = formatModelList(listed);
  const published = publicModels(listed);
  assert.match(text, /llama-3\.1-8b-instant/);
  assert.equal(text.includes("secret-"), false);
  assert.equal(JSON.stringify(published).includes("secret-"), false);
  assert.equal(published.some((model) => model.id === "llama-3.1-8b-instant"), true);
  const first = pool.choose("llama-3.1-8b-instant", "high");
  const second = pool.choose("llama-3.1-8b-instant", "high");
  assert.equal(first.model, "llama-3.1-8b-instant");
  assert.equal(first.apiKey, "secret-one");
  assert.equal(second.apiKey, "secret-one");
  assert.equal(first.effort, "high");
  assert.equal(pool.choose("gpt-4o-mini", "").apiKey, "secret-openai");
});

test("automatic rotation starts after a live list when no single model is selected", async () => {
  const pool = createProviderPool({
    GROQ_API_KEY: "secret-one",
    OPENROUTER_API_KEY: "secret-two",
  }, async (url) => modelsResponse(url.includes("groq") ? ["groq-model"] : ["route-model"]));
  assert.equal(pool.choose("", ""), null);
  await pool.listModels();
  const picks = [pool.choose("", ""), pool.choose("", "")];
  assert.deepEqual(picks.map((pick) => pick.model).sort(), ["groq-model", "route-model"]);
  assert.equal(new Set(picks.map((pick) => pick.apiKey)).size, 2);
});
