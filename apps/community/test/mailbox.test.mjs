import test from 'node:test';
import assert from 'node:assert/strict';
import { createMailbox } from '../mailbox.mjs';

const id='a'.repeat(64), privateToken='fixture-server-only-mail-token';
const env={COMMUNITY_MAIL_URL:'https://mail.example/api/bot-mail',COMMUNITY_MAIL_TOKEN:privateToken};
const send={action:'send',to:'reader@example.com',subject:'Test subject',text:'Test content',requestId:'fixture-send-request-001'};

test('mail transport keeps its token server-side and allowlists untrusted inbox/message fields', async()=>{
  const calls=[];
  const mailbox=createMailbox({env,fetchImpl:async(url,options)=>{
    calls.push({url,options});
    if(new URL(url).searchParams.has('id'))return Response.json({
      id,from:'sender@example.com',to:'bot@example.com',subject:'<img src=x onerror=alert(1)>',
      text:'Untrusted plain text <script>alert(1)</script>',receivedAt:'2026-10-10T00:00:00Z',
      html:'<script>unsafe</script>',raw:'raw private transport content',token:privateToken,
      attachments:[{filename:'file.txt',mimeType:'text/plain',content:'hidden attachment bytes'}],
    });
    return Response.json({address:'bot@example.com',messages:[{id,from:'sender@example.com',subject:'Hello',receivedAt:'2026-10-10T00:00:00Z',token:privateToken},{id:'invalid'}],cursor:'next+page/=',token:privateToken});
  }});
  assert.equal(mailbox.configured,true);
  const list=await mailbox.list('page+one/=');
  assert.equal(list.messages.length,1); assert.equal(list.cursor,'next+page/=');
  assert.deepEqual(Object.keys(list.messages[0]).sort(),['from','id','receivedAt','subject']);
  assert.equal(new URL(calls[0].url).searchParams.get('cursor'),'page+one/=');
  const message=await mailbox.read(id);
  assert.equal(message.text,'Untrusted plain text <script>alert(1)</script>','mail text is data, not executable HTML');
  assert.equal(message.contentTrust,'untrusted-email-content');
  assert.deepEqual(message.attachments,[{filename:'file.txt',mimeType:'text/plain'}]);
  assert.equal(message.html,undefined); assert.equal(message.raw,undefined);
  assert.ok(!JSON.stringify([list,message]).includes(privateToken));
  for(const call of calls){
    assert.equal(call.options.headers.authorization,'Bearer '+privateToken);
    assert.equal(call.options.redirect,'error');
    assert.ok(call.options.signal instanceof AbortSignal);
    assert.ok(!call.url.includes(privateToken));
  }
});

test('send and reply keep the same idempotency ID and ignore forged sender, headers and HTML',async()=>{
  const calls=[];
  const mailbox=createMailbox({env,fetchImpl:async(url,options)=>{
    calls.push(JSON.parse(options.body));
    return Response.json({accepted:true,id:'provider-id',from:'bot@example.com',token:privateToken});
  }});
  const result=await mailbox.send({...send,from:'spoof@example.com',html:'unsafe',headers:{bcc:'hidden@example.com'}});
  assert.deepEqual(calls[0],send);
  assert.deepEqual(result,{accepted:true,id:'provider-id',from:'bot@example.com'});
  await mailbox.send({...send});
  assert.deepEqual(calls[1],calls[0],'a retry must forward the caller request ID unchanged');
  await mailbox.send({action:'reply',id,text:'Reply',requestId:'fixture-reply-request-001',to:'spoof@example.com',subject:'forged'});
  assert.deepEqual(calls[2],{action:'reply',id,text:'Reply',requestId:'fixture-reply-request-001'});
});

test('malformed and oversized operations never reach the upstream',async()=>{
  let calls=0;
  const mailbox=createMailbox({env,fetchImpl:async()=>{calls++;return Response.json({accepted:true});}});
  for(const input of [
    {...send,action:'delete'}, {...send,to:'reader@example.com\r\nbcc:steal@example.com'},
    {...send,to:'one@example.com two@example.com'}, {...send,subject:'Title\r\nBcc:steal@example.com'},
    {...send,text:''}, {...send,text:'x'.repeat(40001)}, {...send,requestId:'short'},
    {...send,requestId:'not/a/valid/request-id'}, {...send,action:'reply',id:'../private'},
  ])await assert.rejects(mailbox.send(input),{status:400});
  await assert.rejects(mailbox.send({...send,text:'한'.repeat(30000)}),{status:413});
  for(const value of ['../private',id+'f',''])await assert.rejects(mailbox.read(value),{status:400});
  for(const value of [7,'x'.repeat(2049),'cursor\n'])await assert.rejects(mailbox.list(value),{status:400});
  assert.equal(calls,0);
});

test('unconfigured and invalid endpoints stay offline; transport errors and redirects never reveal upstream secrets',async()=>{
  let calls=0;
  for(const invalidEnv of [{}, {...env,COMMUNITY_MAIL_URL:'http://mail.example/api'}, {...env,COMMUNITY_MAIL_URL:'https://user:password@mail.example/api'}, {...env,COMMUNITY_MAIL_URL:'https://mail.example/api?token=private'}]){
    const mailbox=createMailbox({env:invalidEnv,fetchImpl:async()=>{calls++;throw new Error('must not call');}});
    assert.equal(mailbox.configured,false);
    assert.deepEqual(await mailbox.list(),{configured:false,address:'',messages:[],cursor:null});
    await assert.rejects(mailbox.read(id),{status:409});
    await assert.rejects(mailbox.send(send),{status:409});
  }
  assert.equal(calls,0);
  for(const [status,expected] of [[302,502],[401,409],[403,409],[404,404],[500,502]]){
    const mailbox=createMailbox({env,fetchImpl:async(_url,options)=>{
      assert.equal(options.redirect,'error');
      return new Response(privateToken,{status,headers:{location:'https://attacker.example/'}});
    }});
    await assert.rejects(mailbox.list(),error=>{assert.equal(error.status,expected);assert.ok(!error.message.includes(privateToken));return true;});
  }
  const mailbox=createMailbox({env,fetchImpl:async()=>{throw new Error(privateToken);}});
  await assert.rejects(mailbox.send(send),error=>{assert.equal(error.status,502);assert.ok(!error.message.includes(privateToken));return true;});
});

test('invalid, mismatched and oversized successful upstream responses fail closed',async()=>{
  for(const body of ['not-json',JSON.stringify({messages:null}),JSON.stringify({messages:[],extra:'x'.repeat(2*1024*1024)})]){
    const mailbox=createMailbox({env,fetchImpl:async()=>new Response(body)});
    await assert.rejects(mailbox.list(),{status:502});
  }
  const mailbox=createMailbox({env,fetchImpl:async()=>Response.json({id:'b'.repeat(64),accepted:false})});
  await assert.rejects(mailbox.read(id),{status:502});
  await assert.rejects(mailbox.send(send),{status:502});
});

test('original MIME remains internal and bounded while automatic replies preserve their marker',async()=>{
  const mime='From: sender@example.com\r\nTo: bot@example.com\r\n\r\nRequest';
  const calls=[];
  const mailbox=createMailbox({env,fetchImpl:async(url,options)=>{
    calls.push({url,options});
    if(options.method==='POST')return Response.json({accepted:true,id:'reply',from:'bot@example.com'});
    return new Response(mime,{headers:{'content-type':'message/rfc822'}});
  }});
  assert.equal((await mailbox.raw(id)).toString(),mime);
  assert.equal(new URL(calls[0].url).searchParams.get('raw'),'1');
  assert.equal(calls[0].options.headers.authorization,'Bearer '+privateToken);
  await mailbox.send({action:'reply',id,text:'Result',requestId:'mail-agent-'+id,automatic:true});
  assert.equal(JSON.parse(calls[1].options.body).automatic,true);
  await assert.rejects(mailbox.raw('../private'),{status:400});
  const oversized=createMailbox({env,fetchImpl:async()=>new Response('x'.repeat(10*1024*1024+1))});
  await assert.rejects(oversized.raw(id),{status:502});
});
