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
