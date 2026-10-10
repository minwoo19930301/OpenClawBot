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

test('explicit model prefers its direct provider over a paid router duplicate',async()=>{
 const pool=createProviderPool({GROQ_API_KEY:'groq',OPENROUTER_API_KEY:'router'},async()=>modelsResponse(['qwen/test']));
 await pool.listModels();for(let i=0;i<5;i++)assert.deepEqual(pool.choose('qwen/test','').attempts.map(p=>p.provider),['groq']);
});

test('each custom endpoint keeps its own configured model ahead of shared defaults',async()=>{
 const env={COMMUNITY_LLM_MODEL:'shared-default',CUSTOM_MODEL:'shared-default',COMMUNITY_LLM_PROVIDERS:JSON.stringify([
  {name:'custom',baseUrl:'https://first.example/v1',apiKey:'first-private-key',model:'first-chat'},
  {name:'custom',baseUrl:'https://second.example/v1',apiKey:'second-private-key',model:'second-chat'},
 ])};
 const pool=createProviderPool(env,async()=>modelsResponse(['shared-default','first-chat','second-chat']));
 await pool.listModels();
 assert.deepEqual(pool.providers.map(p=>p.model),['first-chat','second-chat']);
 assert.deepEqual(pool.choose('','').attempts.map(p=>[p.baseUrl,p.model]),[
  ['https://first.example/v1','first-chat'],['https://second.example/v1','second-chat'],
 ]);
});

test('missing discovery endpoints expose configured models without claiming a verified catalog',async()=>{
 for (const status of [404,405,501]) {
  const pool=createProviderPool({COMMUNITY_LLM_PROVIDERS:JSON.stringify([
   {name:'first',baseUrl:'https://first.example/v1',apiKey:'first-private-key',model:'first-chat'},
   {name:'second',baseUrl:'https://second.example/v1',apiKey:'second-private-key',model:'second-chat'},
  ])},async()=>modelsResponse([],status));
  const listed=await pool.listModels();
  assert.equal(listed.failures.length,2);assert.equal(listed.models.length,2);
  assert.ok(listed.models.every(model=>model.configured===true));
  assert.deepEqual(pool.choose('first-chat','').attempts.map(p=>p.apiKey),['first-private-key']);
  assert.deepEqual(pool.choose('second-chat','').attempts.map(p=>p.apiKey),['second-private-key']);
  assert.ok(publicModels(listed).every(model=>model.configured===true));
  assert.match(formatModelList(listed),/수동 설정/);
  assert.ok(!JSON.stringify(publicModels(listed)).includes('private-key'));
 }
});

test('an explicitly empty successful catalog permits only the administrator configured model',async()=>{
 const pool=createProviderPool({COMMUNITY_LLM_PROVIDERS:JSON.stringify([
  {name:'custom',baseUrl:'https://custom.example/v1',apiKey:'private-key',model:'known-deployment'},
 ])},async()=>modelsResponse([]));
 const listed=await pool.listModels();
 assert.equal(listed.models[0].configured,true);assert.equal(listed.failures.length,1);
 assert.equal(pool.choose('','').model,'known-deployment');assert.equal(pool.choose('other',''),null);
});

test('auth, quota, server, network and invalid payload failures never use configured discovery fallback',async()=>{
 const env={COMMUNITY_LLM_PROVIDERS:JSON.stringify([{name:'custom',baseUrl:'https://custom.example/v1',apiKey:'private-key',model:'known-deployment'}])};
 const fetches=[...([401,403,429,500,503].map(status=>async()=>modelsResponse([],status))),
  async()=>{throw Error('network unavailable');},async()=>({ok:true,status:200,json:async()=>({unexpected:true})})];
 for (const fetchImpl of fetches) {
  const pool=createProviderPool(env,fetchImpl);const listed=await pool.listModels();
  assert.equal(listed.models.length,0);assert.equal(pool.choose('known-deployment',''),null);
 }
});

test('configured fallback respects authentication/quota cooldown across catalog refresh',async()=>{
 for (const status of [401,403,429]) {
  const pool=createProviderPool({COMMUNITY_LLM_PROVIDERS:JSON.stringify([{name:'custom',baseUrl:'https://custom.example/v1',apiKey:'private-key',model:'known-deployment'}])},async()=>modelsResponse([],404));
  await pool.listModels();const choice=pool.choose('','');
  choice.onProviderFailure(choice,status,60000);
  await pool.listModels();assert.equal(pool.choose('',''),null);assert.equal(pool.choose('known-deployment',''),null);
 }
});

test('OpenRouter configured paid models remain excluded from automatic fallback',async()=>{
 const pool=createProviderPool({OPENROUTER_API_KEY:'router-key',OPENROUTER_MODEL:'paid-model'},async()=>modelsResponse([],404));
 const listed=await pool.listModels();assert.equal(listed.models[0].configured,true);
 assert.equal(pool.choose('',''),null);assert.equal(pool.choose('paid-model','').model,'paid-model');
});

test('a discovered duplicate makes the public model verified while manual-only entries stay marked',()=>{
 const models=publicModels({models:[
  {id:'same',name:'same',provider:'manual',configured:true},
  {id:'same',name:'same',provider:'discovered'},
  {id:'manual-only',name:'manual-only',provider:'manual',configured:true},
 ]});
 assert.equal(models[0].configured,undefined);assert.equal(models[1].configured,true);
});

test('provider-specific models survive deduplication and invalid model identifiers are not used',()=>{
 const providers=readProviders({COMMUNITY_LLM_BASE_URL:'https://custom.example/v1',COMMUNITY_LLM_API_KEY:'private-key',COMMUNITY_LLM_MODEL:'old-model',
  COMMUNITY_LLM_PROVIDERS:JSON.stringify([
   {name:'custom',baseUrl:'https://custom.example/v1',apiKey:'private-key',model:'provider-model'},
   {name:'invalid',baseUrl:'https://other.example/v1',apiKey:'other-key',model:'bad\nmodel'},
  ])});
 assert.equal(providers.length,2);assert.equal(providers[0].model,'provider-model');assert.equal(providers[1].model,undefined);
});
