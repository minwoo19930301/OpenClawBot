import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { startCommunity } from '../server.mjs';
import { createProviderPool } from '../providers.mjs';

function client(app) {
  let cookie='',csrf='';
  const request=async(path,body,method=body?'POST':'GET',withCsrf=true)=>{
    const multipart=body instanceof FormData;
    const res=await fetch(app.url+path,{method,headers:{...(!multipart?{'content-type':'application/json'}:{}),...(cookie?{cookie}:{}),...(withCsrf?{'x-csrf-token':csrf}:{})},...(body?{body:multipart?body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(10000)});
    if(res.headers.get('set-cookie'))cookie=res.headers.get('set-cookie').split(';')[0];
    const value=await res.json();if(value.csrfToken)csrf=value.csrfToken;
    return {status:res.status,value};
  };
  request.finish=async roomId=>{
    const res=await fetch(app.url+`/api/rooms/${roomId}/progress`,{headers:{cookie},signal:AbortSignal.timeout(10000)});
    assert.equal(res.status,200);
    assert.match(await res.text(),/event: done/);
  };
  return request;
}
test('admin setup adds a live provider without restart, keeps credentials private and blocks non-admin/CSRF',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'setup-http-'));
  const requests=[];
  const provider=createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const body=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):null;
    requests.push({path:req.url,method:req.method,key:req.headers.authorization,body});
    const list=req.method==='GET'&&req.url==='/v1/models';
    const chat=req.method==='POST'&&req.url==='/v1/chat/completions';
    res.writeHead(list||chat?200:404,{'content-type':'application/json'});
    res.end(JSON.stringify(list?{data:[{id:'fixture-model'}]}:chat?{
      model:'fixture-model',choices:[{message:{role:'assistant',content:'LIVE_PROVIDER_RESPONSE'}}],
      usage:{prompt_tokens:21,completion_tokens:4},
    }:{error:'Unexpected fixture route'}));
  });
  await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
  let app;
  try {
    app=await startCommunity({dataDir:dir,port:0,env:{COMMUNITY_BOOTSTRAP_TOKEN:'bootstrap'}});
    const admin=client(app),anonymous=client(app);
    assert.equal((await anonymous('/api/admin/setup')).status,401);
    const registered=await admin('/api/register',{username:'admin',displayName:'Owner',password:'test-passphrase-fixture',inviteToken:'bootstrap'});
    assert.equal(registered.value.setupRequired,true);
    assert.equal((await admin('/api/admin/setup',{displayName:'Mine'},'POST',false)).status,403);
    assert.equal((await admin('/api/admin/setup',{displayName:'Mine',cloud:'other'})).status,200);
    const baseUrl=`http://127.0.0.1:${provider.address().port}/v1`;
    const saved=await admin('/api/admin/setup/providers',{provider:'custom',baseUrl,apiKey:'fixture-sensitive-key',model:'fixture-model'});
    assert.equal(saved.status,200);
    assert.ok(!JSON.stringify(saved.value).includes('fixture-sensitive-key'));
    const models=await admin('/api/models');
    assert.equal(models.value.models[0].id,'fixture-model');
    assert.equal(requests[0].key,'Bearer fixture-sensitive-key');
    assert.equal((await admin('/api/session')).value.model.configured,true);
    assert.equal((await admin('/api/admin/setup/backend',{backend:'api'})).status,200);
    const created=await admin('/api/rooms',{name:'Live setup test'});
    assert.equal(created.status,201);
    const roomId=created.value.room.id;
    const sent=await admin(`/api/rooms/${roomId}/messages`,{text:'LIVE_SETUP_REQUEST',botIds:['bot-analyst'],clientNonce:'live-provider-turn'});
    assert.equal(sent.status,202);
    await admin.finish(roomId);
    const transcript=await admin(`/api/rooms/${roomId}`);
    assert.equal(transcript.status,200);
    assert.deepEqual(transcript.value.messages.filter(message=>message.kind==='bot').map(message=>message.text),['LIVE_PROVIDER_RESPONSE']);
    assert.ok(transcript.value.messages.some(message=>message.kind==='human'&&message.text==='LIVE_SETUP_REQUEST'));
    const chats=requests.filter(request=>request.path==='/v1/chat/completions');
    assert.equal(chats.length,1,'saving a key should enable a real adapter request without restarting');
    assert.equal(chats[0].key,'Bearer fixture-sensitive-key');
    assert.equal(chats[0].body.model,'fixture-model');
    assert.ok(chats[0].body.messages.some(message=>message.role==='user'&&message.content.includes('LIVE_SETUP_REQUEST')));
    assert.ok(!JSON.stringify(transcript.value).includes('fixture-sensitive-key'));

    const exported=await admin('/api/admin/setup/recipe');
    assert.ok(!JSON.stringify(exported.value).includes('fixture-sensitive-key'));
    assert.equal((await anonymous('/api/brand')).value.name,'Mine');
    const manifest=await (await fetch(app.url+'/manifest.webmanifest')).json();assert.equal(manifest.name,'Mine');
    const invite=await admin('/api/admin/invites',{});
    // Registration route accepts one-time site invite tokens; no setup rights follow membership.
    const member=client(app);
    const token=invite.value.token ?? invite.value.inviteToken;
    if(token) {
      assert.equal((await member('/api/register',{username:'member',displayName:'Member',password:'test-passphrase-fixture',inviteToken:token})).status,201);
      assert.equal((await member('/api/admin/setup')).status,403);
    } else {
      throw new Error('Expected site invite token');
    }
  } finally {
    await app?.close();await new Promise(resolve=>provider.close(resolve));await rm(dir,{recursive:true,force:true});
  }
});


test('explicit Gateway mode bypasses a configured API pool for catalogs, chat and image handling',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'setup-gateway-'));
  const apiRequests=[];
  const provider=createServer((req,res)=>{
    apiRequests.push(req.url);
    res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'WRONG_API_RESPONSE'}}]}));
  });
  await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
  const env={
    COMMUNITY_BOOTSTRAP_TOKEN:'bootstrap',
    GROQ_API_KEY:'fixture-unused-api-key',GROQ_BASE_URL:`http://127.0.0.1:${provider.address().port}/v1`,
    COMMUNITY_OPENCLAW_BASE_URL:'http://openclaw:18890',
    COMMUNITY_OPENCLAW_TOKEN:'fixture-gateway-token-private',COMMUNITY_OPENCLAW_AGENT_ID:'community',
    COMMUNITY_OPENCLAW_ALLOW_PRIVATE_HTTP:'1',
  };
  let catalogFetches=0;
  const fetchImpl=async(url)=>{
    catalogFetches++;
    assert.equal(String(url),env.GROQ_BASE_URL+'/models');
    return Response.json({data:[{id:'fixture-api-model'},{id:'gemini-2.5-flash'}]});
  };
  const pool=createProviderPool(env,fetchImpl);
  const poolCalls={listModels:0,ensureModels:0,choose:0};
  for(const name of Object.keys(poolCalls)) {
    const original=pool[name];pool[name]=(...args)=>{poolCalls[name]++;return original(...args);};
  }
  const gatewayCalls=[];
  let app;
  try {
    app=await startCommunity({dataDir:dir,port:0,env,providerPool:pool,fetchImpl,openClaw:{
      name:'openclaw:fixture',
      async complete(request){gatewayCalls.push(request);return 'SendMessage: '+JSON.stringify({type:'text',content:'GATEWAY_RESPONSE'});},
    }});
    const admin=client(app);
    assert.equal((await admin('/api/register',{username:'gateway_admin',displayName:'Owner',password:'test-passphrase-fixture',inviteToken:'bootstrap'})).status,201);
    // Populate a viable API catalog before switching: a stale API choice must not win.
    assert.equal((await admin('/api/models')).value.models.length,2);
    assert.equal(catalogFetches,1);
    const selected=await admin('/api/admin/setup/backend',{backend:'gateway'});
    assert.equal(selected.status,200);
    assert.equal(selected.value.activeBackend,'gateway');
    for(const name of Object.keys(poolCalls))poolCalls[name]=0;
    catalogFetches=0;
    const listed=await admin('/api/models');
    assert.equal(listed.status,200);
    assert.deepEqual(listed.value.models,[]);
    assert.equal((await admin('/api/admin/setup/verify',{})).value.kind,'gateway');
    assert.equal((await admin('/api/admin/integrations/ask',{prompt:'Check a service'})).status,409);
    const created=await admin('/api/rooms',{name:'Gateway setup test'});
    assert.equal(created.status,201);
    const roomId=created.value.room.id;
    // The model shortcut must also respect the explicit backend.
    assert.equal((await admin(`/api/rooms/${roomId}/messages`,{text:'model',botIds:[],clientNonce:'gateway-model-list'})).status,202);
    const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9WQAAAAASUVORK5CYII=','base64');
    const form=new FormData();form.append('file',new Blob([png],{type:'image/png'}),'gateway.png');
    const upload=await admin(`/api/rooms/${roomId}/attachments`,form);
    assert.equal(upload.status,201);
    const sent=await admin(`/api/rooms/${roomId}/messages`,{
      text:'GATEWAY_ONLY_REQUEST',model:'fixture-api-model',botIds:['bot-analyst'],
      attachmentIds:[upload.value.attachment.id],clientNonce:'gateway-chat',
    });
    assert.equal(sent.status,202);
    await admin.finish(roomId);
    const transcript=await admin(`/api/rooms/${roomId}`);
    assert.equal(transcript.status,200);
    assert.ok(transcript.value.messages.some(message=>message.kind==='bot'&&message.text==='GATEWAY_RESPONSE'));
    assert.ok(!transcript.value.messages.some(message=>message.text==='WRONG_API_RESPONSE'));
    assert.equal(gatewayCalls.length,1);
    assert.match(gatewayCalls[0].user,/GATEWAY_ONLY_REQUEST/);
    assert.equal(gatewayCalls[0].isolation.roomId,roomId);
    assert.equal(gatewayCalls[0].apiKey,undefined);
    assert.equal(gatewayCalls[0].attempts,undefined);
    assert.deepEqual(poolCalls,{listModels:0,ensureModels:0,choose:0},'an explicit Gateway choice must not touch an API pool, including OCR');
    assert.equal(catalogFetches,0);
    assert.deepEqual(apiRequests,[],'chat and OCR must not reach the API adapter after selecting Gateway');
  } finally {
    await app?.close();await new Promise(resolve=>provider.close(resolve));await rm(dir,{recursive:true,force:true});
  }
});
