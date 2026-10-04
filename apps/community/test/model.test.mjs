import test from "node:test";
import assert from "node:assert/strict";
import { ApiLlm } from "../model.mjs";

const response = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const call = (name, args = "{}", id = "call-1") => ({ id, type: "function", function: { name, arguments: args } });
const request = (overrides = {}) => ({ system: "system", user: "hello", browser: null, beforeAdditionalModelCall: async () => {}, ...overrides });

async function withFetch(sequence, run) {
  const original = globalThis.fetch;
  const bodies = [];
  let index = 0;
  globalThis.fetch = async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    const next = sequence[Math.min(index++, sequence.length - 1)];
    return response({ choices: [{ message: next }] });
  };
  try { return await run(bodies); } finally { globalThis.fetch = original; }
}

const llm = () => new ApiLlm({ COMMUNITY_LLM_MODEL: "fixture", COMMUNITY_LLM_BASE_URL: "http://127.0.0.1:1", COMMUNITY_LLM_API_KEY: "test" });

test("ApiLlm executes browser tool calls and returns the final text envelope", async () => {
  const { result, bodies } = await withFetch([
    { content: null, tool_calls: [call("browser_snapshot", "{}", "snap-1")] },
    { content: "The page is ready." },
  ], async (bodies) => ({ result: await llm().complete(request({ browser: async (name, args) => `${name}:${JSON.stringify(args)} result` })), bodies }));
  assert.deepEqual(JSON.parse(result.slice("SendMessage: ".length)), { type: "text", content: "The page is ready." });
  assert.equal(bodies[0].tools.length, 6);
  assert.equal(bodies[1].messages.at(-1).role, "tool");
});

test("additional model quota is called exactly once and blocks the next provider request", async () => {
  let quotaCalls = 0;
  await assert.rejects(() => withFetch([{ content: null, tool_calls: [call("browser_snapshot")] }], async () => llm().complete(request({ browser: async () => "ok", beforeAdditionalModelCall: async () => { quotaCalls++; throw new Error("quota"); } }))), /quota/);
  assert.equal(quotaCalls, 1);
});

test("unknown tools, invalid arguments, and action budgets are rejected before execution", async () => {
  await assert.rejects(() => withFetch([{ content: null, tool_calls: [call("browser_secret")] }], async () => llm().complete(request({ browser: async () => "bad" }))), /Invalid browser tool call/);
  await assert.rejects(() => withFetch([{ content: null, tool_calls: [call("browser_click", "x".repeat(10001))] }], async () => llm().complete(request({ browser: async () => "bad" }))), /Invalid browser tool call/);
  const calls = Array.from({ length: 5 }, (_, i) => call("browser_snapshot", "{}", `c-${i}`));
  await assert.rejects(() => withFetch([{ content: null, tool_calls: calls }], async () => llm().complete(request({ browser: async () => "bad" }))), /Browser action budget exceeded/);
});

test("selected effort is sent with the provider request", async () => {
  await withFetch([{ content: "effort response" }], async (bodies) => {
    await llm().complete(request({ effort: "high", model: "picked-model" }));
    assert.equal(bodies[0].reasoning_effort, "high");
    assert.equal(bodies[0].model, "picked-model");
  });
});

test("plain requests omit browser tools and preserve a plain text response", async () => {
  const result = await withFetch([{ content: "plain response" }], async (bodies) => {
    const text = await llm().complete(request());
    assert.equal(bodies[0].tools, undefined);
    return text;
  });
  assert.deepEqual(JSON.parse(result.slice("SendMessage: ".length)), { type: "text", content: "plain response" });
});

test('429 fails over before executing tools, extra calls are charged, cancellation never retries',async()=>{
 const old=globalThis.fetch;let calls=0,charged=0,failed=0;
 const llm=new ApiLlm({COMMUNITY_LLM_MODEL:'a',COMMUNITY_LLM_BASE_URL:'https://one.test',COMMUNITY_LLM_API_KEY:'first'});
 const request={system:'test',user:'test',attempts:[{model:'a',baseUrl:'https://one.test',apiKey:'first'},{model:'b',baseUrl:'https://two.test',apiKey:'second'}],beforeAdditionalModelCall:async()=>{charged++;},onProviderFailure:()=>{failed++;}};
 try{
  globalThis.fetch=async()=>++calls===1?new Response('',{status:429,headers:{'retry-after':'60'}}):Response.json({choices:[{message:{content:'success'}}]});
  await llm.complete(request);assert.equal(calls,2);assert.equal(charged,1);assert.equal(failed,1);
  const controller=new AbortController();controller.abort();calls=0;
  await assert.rejects(llm.complete(request,controller.signal));assert.equal(calls,0);
 }finally{globalThis.fetch=old;}
});

test('private service tools use only supplied definitions and never replay completed reads on failover',async()=>{
 const original=globalThis.fetch;let count=0,reads=0;const keys=[];
 try{globalThis.fetch=async(_url,opts)=>{keys.push(opts.headers.authorization);const n=++count;if(n===1||n===3)return new Response('',{status:429});return response({choices:[{message:n===2?{tool_calls:[call('read_connected_service','{"id":"meta","action":"profile"}')]}:{content:'done'}}]});};
 const result=await llm().complete(request({attempts:[{model:'a',baseUrl:'https://a.test',apiKey:'a'},{model:'b',baseUrl:'https://b.test',apiKey:'b'},{model:'c',baseUrl:'https://c.test',apiKey:'c'}],toolDefinitions:[{type:'function',function:{name:'read_connected_service'}}],browser:async()=>{reads++;return 'profile';}}));
 assert.match(result,/done/);assert.equal(reads,1);assert.deepEqual(keys,['Bearer a','Bearer b','Bearer b','Bearer c']);
 }finally{globalThis.fetch=original;}
});
