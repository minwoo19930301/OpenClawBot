import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startCommunity} from '../server.mjs';
test('automatic title, compact, fork preserve context and isolate membership',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'session-tools-'));
 const app=await startCommunity({dataDir:dir,port:0,env:{COMMUNITY_BOOTSTRAP_TOKEN:'bootstrap'},llm:{complete:async()=> 'SendMessage: '+JSON.stringify({content:'목표: 출시 계획. 결정: 금요일 배포. 제약: 기존 키 보존.'})}});
 function client(){let cookie='',csrf='';return async(path,body)=>{const r=await fetch(app.url+path,{method:body?'POST':'GET',headers:{cookie,'content-type':'application/json','x-csrf-token':csrf},body:body?JSON.stringify(body):undefined});const v=await r.json();if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];if(v.csrfToken)csrf=v.csrfToken;return {status:r.status,...v};};}
 const admin=client(),other=client();
 try{
 await admin('/api/register',{username:'admin',displayName:'Admin',password:'long-test-password',inviteToken:'bootstrap'});
 const invite=await admin('/api/admin/invites',{});
 await other('/api/register',{username:'other',displayName:'Other',password:'long-test-password',inviteToken:invite.token});
 const created=await admin('/api/rooms',{});assert.equal(created.status,201);const id=created.room.id;
 const content='출시 계획을 정리해주세요. 금요일에 배포하고 기존 키는 보존합니다. '.repeat(20);
 assert.equal((await admin(`/api/rooms/${id}/messages`,{text:content,clientNonce:'first',botIds:[]})).status,202);
 const before=await admin(`/api/rooms/${id}`);assert.notEqual(before.room.name,'새 대화');assert.ok(before.context.usedChars>500);
 assert.equal((await other(`/api/rooms/${id}/fork`,{})).status,404);
 const compact=await admin(`/api/rooms/${id}/compact`,{});assert.equal(compact.status,200);assert.ok(compact.context.usedChars<before.context.usedChars);
 const fork=await admin(`/api/rooms/${id}/fork`,{});assert.equal(fork.status,201);
 const child=await admin(`/api/rooms/${fork.room.id}`);assert.equal(child.messages.length,before.messages.length);assert.equal(child.context.usedChars,compact.context.usedChars);assert.equal(child.members.length,1);
 assert.equal((await other(`/api/rooms/${fork.room.id}`)).status,404);
 assert.equal((await admin(`/api/rooms/${id}`)).messages.length,before.messages.length);
 }finally{await app.close();await rm(dir,{recursive:true,force:true});}
});
