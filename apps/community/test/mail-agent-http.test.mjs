import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startCommunity} from '../server.mjs';

function client(app) {
  let cookie='',csrf='';
  return async(path,body,extra={})=>{
    const response=await fetch(app.url+path,{method:body===undefined?'GET':'POST',
      headers:{'content-type':'application/json',cookie,'x-csrf-token':csrf,...extra},
      ...(body===undefined?{}:{body:JSON.stringify(body)})});
    if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];
    const data=await response.json();if(data.csrfToken)csrf=data.csrfToken;
    return {status:response.status,data};
  };
}

test('approved email tasks use the existing agent, private per-user threads and automatic replies',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'mail-agent-http-'));
  const inbox=[],sent=[],modelRequests=[];
  const mailbox={configured:true,
    async list(){return {configured:true,address:'agent@example.com',messages:inbox,cursor:null};},
    async read(id){return inbox.find(item=>item.id===id);},
    async raw(id){return Buffer.from(id);},
    async send(input){sent.push(input);return {accepted:true,id:'sent-'+input.id,from:'agent@example.com'};},
  };
  const app=await startCommunity({dataDir:dir,port:0,mailbox,
    env:{COMMUNITY_BOOTSTRAP_TOKEN:'bootstrap'},
    llm:{name:'fixture',async complete(request){modelRequests.push(request);return 'SendMessage: '+JSON.stringify({type:'text',content:'요청한 내용을 정리했습니다.'});}},
    verifyMail:async(raw,{expectedFrom,expectedTo})=>{
      const item=inbox.find(m=>m.id===raw.toString());
      assert.equal(expectedTo,'agent@example.com');
      return {verified:true,from:expectedFrom,messageId:item.messageId,inReplyTo:item.inReplyTo||'',references:item.references||[],subject:item.subject,date:Date.now()};
    },
  });
  try {
    const admin=client(app),member=client(app),anonymous=client(app);
    const registered=await admin('/api/register',{username:'admin',displayName:'Owner',password:'long-fixture-password',inviteToken:'bootstrap'});
    assert.equal(registered.status,201);
    const invite=await admin('/api/admin/invites',{});
    const invited=await member('/api/register',{username:'member',displayName:'Member',password:'long-fixture-password',inviteToken:invite.data.token});
    assert.equal(invited.status,201);
    assert.equal((await anonymous('/api/admin/mail/agent')).status,401);
    assert.equal((await member('/api/admin/mail/agent')).status,403);
    assert.equal((await admin('/api/admin/mail/agent',{enabled:true,senders:[]},{'x-csrf-token':''})).status,403);
    const senders=[{email:'owner@example.com',userId:registered.data.user.id},{email:'member@example.com',userId:invited.data.user.id}];
    assert.equal((await admin('/api/admin/mail/agent',{enabled:true,senders})).status,200);

    const add=(char,from,extra={})=>inbox.push({id:char.repeat(64),from,to:'agent@example.com',subject:'현재 작업',text:'이 내용을 정리해 주세요.',receivedAt:new Date(Date.now()+10).toISOString(),messageId:`<${char}@example.com>`,...extra});
    add('a','owner@example.com');
    await app.mailAgent.poll();
    assert.equal(modelRequests.length,1);assert.equal(sent.length,1);
    assert.equal(sent[0].action,'reply');assert.equal(sent[0].automatic,true);
    assert.match(sent[0].text,/정리했습니다/);
    const first=app.mailAgent.view().jobs.find(job=>job.id==='a'.repeat(64));
    assert.ok(first.roomId);
    assert.equal((await admin(`/api/rooms/${first.roomId}`)).status,200);
    assert.equal((await member(`/api/rooms/${first.roomId}`)).status,404);
    assert.equal((await admin(`/api/rooms/${first.roomId}/invites`,{})).status,403);
    assert.equal(modelRequests[0].isolation.userId,registered.data.user.id);
    assert.match(modelRequests[0].user,/이번 메일의 제목과 본문/);
    await app.mailAgent.poll();
    assert.equal(sent.length,1,'poll retries must not run/send a completed message twice');

    add('b','owner@example.com',{inReplyTo:'<a@example.com>',references:['<a@example.com>']});
    await app.mailAgent.poll();
    assert.equal(app.mailAgent.view().jobs.find(job=>job.id==='b'.repeat(64)).roomId,first.roomId);
    add('c','member@example.com',{inReplyTo:'<a@example.com>',references:['<a@example.com>']});
    await app.mailAgent.poll();
    const third=app.mailAgent.view().jobs.find(job=>job.id==='c'.repeat(64));
    assert.ok(third.roomId);assert.notEqual(third.roomId,first.roomId,'another sender cannot inherit owner context');
    assert.equal((await member(`/api/rooms/${third.roomId}`)).status,200);
    assert.equal((await admin(`/api/rooms/${third.roomId}`)).status,404);
    assert.equal((await member(`/api/rooms/${third.roomId}/invites`,{})).status,403);
    assert.match(modelRequests[2].system,/공동 대화에서는 개인 메일과 캘린더를 조회하지 않습니다/);
    assert.ok(!modelRequests[2].toolDefinitions.some(tool=>tool.function?.name==='read_connected_service'));
    assert.equal(sent.length,3);
    const fork=await member(`/api/rooms/${third.roomId}/fork`,{});
    assert.equal(fork.status,201);
    assert.equal((await member(`/api/rooms/${fork.data.room.id}/invites`,{})).status,403);
  } finally {await app.close();await rm(dir,{recursive:true,force:true});}
});
