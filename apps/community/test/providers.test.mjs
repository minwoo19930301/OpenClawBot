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
  }, async (url) => modelsResponse(url.includes("groq") ? ["groq-model"] : ["route-model:free"]));
  assert.equal(pool.choose("", ""), null);
  await pool.listModels();
  const picks = [pool.choose("", ""), pool.choose("", "")];
  assert.deepEqual(picks.map((pick) => pick.model).sort(), ["groq-model", "route-model:free"]);
  assert.equal(new Set(picks.map((pick) => pick.apiKey)).size, 2);
});

test("chat catalog excludes audio and moderation models and keeps automatic choice stable", async () => {
  const pool = createProviderPool({GROQ_API_KEY:"test-key"}, async () => modelsResponse(["whisper-large-v3", "canopylabs/orpheus-v1-english", "meta-llama/llama-prompt-guard-2-22m", "openai/gpt-oss-20b", "openai/gpt-oss-120b"]));
  const listed = await pool.listModels();
  assert.equal(listed.models.length, 2);
  assert.equal(pool.choose("", "").model, "openai/gpt-oss-120b");
});

test('HF token aliases and provider failover exclude cooled keys and paid auto routes', async()=>{
 const pool=createProviderPool({HUGGINGFACE_TOKEN_2:'hf',GROQ_API_KEY:'g',OPENROUTER_API_KEY:'o'}, async url=>modelsResponse(url.includes('openrouter')?['paid-model','free-model:free']:['chat-model']));
 await pool.listModels(); const choice=pool.choose('','');
 assert.equal(choice.attempts.length,3);assert.equal(choice.attempts.some(p=>p.model==='paid-model'),false);
 choice.onProviderFailure(choice.attempts[0],429,90000);
 assert.equal(pool.choose('','').attempts.some(p=>p.slot===choice.slot),false);
 assert.equal(pool.choose('paid-model','').provider,'openrouter');
});
