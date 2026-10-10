import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startCommunity } from '../server.mjs';
import { createMailbox } from '../mailbox.mjs';

const id='a'.repeat(64), privateToken='fixture-private-mail-transport-token';
const validSend={action:'send',to:'reader@example.com',subject:'Subject',text:'Message',requestId:'fixture-mail-request-001'};
function client(app) {
  let cookie='',csrf='';
  return async(path,body,options={})=>{
    const response=await fetch(app.url+path,{
      method:body!==undefined?'POST':'GET',
      headers:{'content-type':'application/json',cookie,...(options.csrf===false?{}:{'x-csrf-token':csrf}),...options.headers},
      ...(body!==undefined?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(10000),
    });
    if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];
    const data=await response.json();if(data.csrfToken)csrf=data.csrfToken;
    return {status:response.status,data,headers:response.headers};
  };
}
async function account(request,username,inviteToken='bootstrap') {
  const result=await request('/api/register',{username,password:'fixture-long-password',displayName:username,inviteToken});
  assert.equal(result.status,201); return result;
}

test('mail inbox, content and sending require admin; CSRF/origin/logout failures never contact the mailbox',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'mail-http-'));
  const requests=[];
  const env={COMMUNITY_BOOTSTRAP_TOKEN:'bootstrap',COMMUNITY_MAIL_URL:'https://mail.example/api/bot-mail',COMMUNITY_MAIL_TOKEN:privateToken};
  const mailbox=createMailbox({env,fetchImpl:async(url,options)=>{
    requests.push({url,options});
    assert.equal(options.headers.authorization,'Bearer '+privateToken);
    if(options.method==='POST')return Response.json({accepted:true,id:'accepted-fixture',from:'bot@example.com',token:privateToken});
    if(new URL(url).searchParams.has('id'))return Response.json({id,from:'sender@example.com',to:'bot@example.com',subject:'Private mail',text:'Private contents',token:privateToken});
    return Response.json({address:'bot@example.com',messages:[{id,from:'sender@example.com',subject:'Private mail',token:privateToken}],cursor:null,token:privateToken});
  }});
  const app=await startCommunity({dataDir:dir,port:0,env,mailbox});
  try {
    const anonymous=client(app),admin=client(app),member=client(app);
    const routes=[['/api/admin/mail',undefined],[`/api/admin/mail/messages/${id}`,undefined],['/api/admin/mail/send',validSend]];
    for(const [path,body] of routes)assert.equal((await anonymous(path,body)).status,401);
    await account(admin,'admin');
    const invite=await admin('/api/admin/invites',{});
    await account(member,'member',invite.data.token);
    for(const [path,body] of routes)assert.equal((await member(path,body)).status,403);
    assert.equal((await admin('/api/admin/mail/send',validSend,{csrf:false})).status,403);
    assert.equal((await admin('/api/admin/mail/send',validSend,{headers:{origin:'https://untrusted.example'}})).status,403);
    assert.equal((await admin('/api/admin/mail',undefined,{headers:{'sec-fetch-site':'cross-site'}})).status,403);
    assert.equal(requests.length,0);

    const inbox=await admin('/api/admin/mail?cursor=page%2B1');
    assert.equal(inbox.status,200);assert.equal(inbox.data.messages[0].subject,'Private mail');
    assert.equal(new URL(requests[0].url).searchParams.get('cursor'),'page+1');
    const message=await admin(`/api/admin/mail/messages/${id}`);
    assert.equal(message.status,200);assert.equal(message.data.text,'Private contents');
    const sent=await admin('/api/admin/mail/send',validSend);
    assert.equal(sent.status,200);assert.deepEqual(sent.data,{accepted:true,id:'accepted-fixture',from:'bot@example.com'});
    for(const response of [inbox,message,sent]){
      assert.ok(!JSON.stringify(response.data).includes(privateToken));
      assert.match(response.headers.get('cache-control'),/no-store/);
    }
    assert.equal(requests.length,3);
    assert.equal((await admin('/api/logout',{})).status,200);
    for(const [path,body] of routes)assert.equal((await admin(path,body)).status,401);
    assert.equal(requests.length,3,'revoked session must not access mail');
  } finally {await app.close();await rm(dir,{recursive:true,force:true});}
});

test('mail HTTP routes reject invalid and oversized messages before transport and expose disconnected state safely',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'mail-validation-'));
  let calls=0;
  const mailbox=createMailbox({env:{COMMUNITY_MAIL_URL:'https://mail.example/api/bot-mail',COMMUNITY_MAIL_TOKEN:privateToken},fetchImpl:async()=>{calls++;throw new Error('must not call');}});
  const app=await startCommunity({dataDir:dir,port:0,env:{COMMUNITY_BOOTSTRAP_TOKEN:'bootstrap'},mailbox});
  try {
    const admin=client(app);await account(admin,'admin');
    for(const body of [null,[],{...validSend,subject:'Injected\r\nBcc:other@example.com'},{...validSend,action:'delete'}])assert.equal((await admin('/api/admin/mail/send',body)).status,400);
    assert.equal((await admin('/api/admin/mail/send',{...validSend,text:'한'.repeat(30000)})).status,413);
    assert.equal((await admin('/api/admin/mail?cursor='+encodeURIComponent('bad\n'))).status,400);
    assert.equal((await admin('/api/admin/mail/messages/not-valid')).status,404);
    assert.equal(calls,0);
  } finally {await app.close();await rm(dir,{recursive:true,force:true});}

  const disconnectedDir=await mkdtemp(join(tmpdir(),'mail-disconnected-'));
  const disconnected=await startCommunity({dataDir:disconnectedDir,port:0,env:{COMMUNITY_BOOTSTRAP_TOKEN:'bootstrap'}});
  try {
    const admin=client(disconnected);await account(admin,'admin');
    const inbox=await admin('/api/admin/mail');
    assert.equal(inbox.status,200);assert.deepEqual(inbox.data,{configured:false,address:'',messages:[],cursor:null});
    assert.equal((await admin('/api/admin/mail/send',validSend)).status,409);
  } finally {await disconnected.close();await rm(disconnectedDir,{recursive:true,force:true});}
});
