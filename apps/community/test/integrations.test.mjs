import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createIntegrations} from '../integrations.mjs';import {startCommunity} from '../server.mjs';
test('service catalog never returns credentials and app-only Meta never pretends user access',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'integrations-'));const path=join(dir,'keys.json');
 try{await writeFile(path,JSON.stringify({META_APP_ACCESS_TOKEN:'secret-value',META_APP_ID:'123'}));
 let endpoint;const service=createIntegrations({path,fetchImpl:async url=>{endpoint=url;return Response.json({id:'123',name:'test'});}});
 assert.equal(JSON.stringify(await service.list()).includes('secret-value'),false);
 assert.equal((await service.execute('meta','profile')).personalAccess,false);assert.match(endpoint,/\/123\?/);
 await assert.rejects(service.execute('meta','publish'),{status:404});
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('personal integrations require admin and CSRF, independent of room membership',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'integration-auth-'));let executions=0;
 const app=await startCommunity({dataDir:dir,port:0,env:{COMMUNITY_BOOTSTRAP_TOKEN:'test-bootstrap'},integrations:{list:async()=>[],execute:async()=>{executions++;return {};}}});
 async function call(path,body,auth={}){const r=await fetch(app.url+path,{method:body?'POST':'GET',headers:{'content-type':'application/json',...auth},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};}
 try{
 assert.equal((await call('/api/admin/integrations')).status,401);
 const admin=await call('/api/register',{username:'admin',password:'longpassword123',displayName:'Admin',inviteToken:'test-bootstrap'});
 const headers={cookie:admin.cookie,'x-csrf-token':admin.data.csrfToken};
 assert.equal((await call('/api/admin/integrations',null,headers)).status,200);
 assert.equal((await call('/api/admin/integrations/meta/profile',{}, {cookie:admin.cookie})).status,403);
 const invite=await call('/api/admin/invites',{},headers);
 const member=await call('/api/register',{username:'member',password:'longpassword123',displayName:'Member',inviteToken:invite.data.token});
 assert.equal((await call('/api/admin/integrations/meta/profile',{}, {cookie:member.cookie,'x-csrf-token':member.data.csrfToken})).status,403);
 assert.equal((await call('/api/admin/integrations/meta/profile',{},headers)).status,200);assert.equal(executions,1);
 }finally{await app.close();await rm(dir,{recursive:true,force:true});}
});

test('commerce auth never returns its token and public model discovery is labeled honestly',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'commerce-'));const path=join(dir,'keys.json');
 try{await writeFile(path,JSON.stringify({NAVER_COMMERCE_CLIENT_ID:'id',NAVER_COMMERCE_CLIENT_SECRET:'$2a$04$abcdefghijklmnopqrstuu',FAL_KEY:'secret'}));
 const service=createIntegrations({path,fetchImpl:async url=>Response.json(url.includes('naver')?{access_token:'private-access',expires_in:100}:{models:[]})});
 const result=await service.execute('naver-commerce','auth');assert.equal(result.authenticated,true);assert.equal(JSON.stringify(result).includes('private-access'),false);
 assert.match((await service.execute('fal','models')).note,/공개 모델 목록/);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('personal chat can use registered services while shared rooms and other users cannot',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'personal-chat-'));let executions=0;const requests=[];
 const app=await startCommunity({dataDir:dir,port:0,env:{COMMUNITY_BOOTSTRAP_TOKEN:'bootstrap'},integrations:{
  list:async()=>[{id:'naver-mail',name:'네이버 메일',configured:true,actions:['inbox']}],
  execute:async(id,action)=>{assert.equal(id,'naver-mail');assert.equal(action,'inbox');executions++;return {messages:[{subject:'private fixture'}]};}
 },llm:{name:'test',complete:async request=>{
  requests.push(request);
  const tool=request.toolDefinitions.find(t=>t.function.name==='read_connected_service');
  if(tool){const result=await request.browser(tool.function.name,{id:'naver-mail',action:'inbox'});assert.match(result,/private fixture/);}
  return 'SendMessage: '+JSON.stringify({type:'text',content:tool?'메일 조회 완료':'공동 대화'});
 }}});
 function client(){let cookie='',csrf='';return async(path,body)=>{
  const r=await fetch(app.url+path,{method:body?'POST':'GET',headers:{'content-type':'application/json',cookie,'x-csrf-token':csrf},...(body?{body:JSON.stringify(body)}:{})});
  const sc=r.headers.get('set-cookie');if(sc)cookie=sc.split(';')[0];const data=await r.json();if(data.csrfToken)csrf=data.csrfToken;return {status:r.status,data};
 };}
 try{
  const admin=client();await admin('/api/register',{username:'admin',displayName:'Admin',password:'longpassword123',inviteToken:'bootstrap'});
  const rooms=(await admin('/api/rooms')).data.rooms, personal=rooms.find(r=>r.personal);
  assert.ok(personal);
  assert.equal((await admin('/api/rooms/'+personal.id+'/invites',{})).status,403);
  const invite=await admin('/api/admin/invites',{});
  const member=client();await member('/api/register',{username:'member',displayName:'Member',password:'longpassword123',inviteToken:invite.data.token});
  assert.equal((await member('/api/rooms/'+personal.id)).status,404);
  assert.equal((await member('/api/rooms')).data.rooms.some(r=>r.personal),false);
  const shared=(await admin('/api/rooms',{name:'shared'})).data.room;
  for(const r of [personal,shared]){
   assert.equal((await admin('/api/rooms/'+r.id+'/messages',{text:'메일 확인',botIds:['bot-analyst'],clientNonce:r.id})).status,202);
   let messages=[];
   for(let i=0;i<100;i++){messages=(await admin('/api/rooms/'+r.id)).data.messages;if(messages.some(m=>m.kind==='bot'))break;await new Promise(resolve=>setTimeout(resolve,10));}
   assert.ok(messages.some(m=>m.kind==='bot'));
  }
  assert.equal(executions,1);
  assert.match(requests[0].system,/비밀번호나 인증 코드를 요구하지/);
  assert.equal(requests[1].toolDefinitions.some(t=>t.function.name==='read_connected_service'),false);
  assert.equal((await admin('/api/rooms')).data.rooms.filter(r=>r.personal).length,1);
 }finally{await app.close();await rm(dir,{recursive:true,force:true});}
});
