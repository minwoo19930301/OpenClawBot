import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createMailAgent} from '../mail-agent.mjs';

const START = Date.parse('2026-10-11T01:00:00Z');
const A = {email:'owner@example.net',userId:'user-a'};
const B = {email:'member@example.net',userId:'user-b'};
const id = number => number.toString(16).padStart(64,'0');

function fixture(t, overrides = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT,display_name TEXT,created_at INTEGER);');
  db.prepare('INSERT INTO users VALUES(?,?,?,?)').run('user-a','owner','Owner',START);
  db.prepare('INSERT INTO users VALUES(?,?,?,?)').run('user-b','member','Member',START);
  const records = new Map(), calls = {list:[],read:[],raw:[],verify:[],run:[],send:[]};
  const state = {now:START,sendFailure:false,busy:false};
  const mailbox = {
    configured:overrides.configured ?? true,
    async list(cursor) {
      calls.list.push(cursor);
      if (overrides.list) return overrides.list(cursor, records);
      return {messages:[...records.values()].map(({message})=>message),cursor:null};
    },
    async read(mailId) { calls.read.push(mailId); return records.get(mailId).message; },
    async raw(mailId) { calls.raw.push(mailId); return 'raw-fixture:' + mailId; },
    async send(input) {
      calls.send.push(input);
      if (state.sendFailure) throw new Error('PRIVATE upstream secret and body');
      return {accepted:true,id:'provider-fixture'};
    },
  };
  const options = {
    db, mailbox, now:()=>state.now,
    env:overrides.env ?? {COMMUNITY_MAIL_AGENT_ENABLED:'1',COMMUNITY_MAIL_AGENT_USERS:JSON.stringify([A,B])},
    canRunTask:async()=>!state.busy,
    verifyMail:async(raw, input)=> {
      calls.verify.push({raw,input});
      const record = records.get(raw.slice('raw-fixture:'.length));
      return record.verification;
    },
    runTask:async(input)=> {
      calls.run.push(input);
      if (overrides.runTask) return overrides.runTask(input);
      return {text:'Task result for '+input.id,roomId:input.roomId || 'room-'+input.id};
    },
  };
  const f = {db,records,calls,state,mailbox,options,agent:createMailAgent(options)};
  f.add = (number, input = {}) => {
    const mailId=id(number), from=input.from || A.email;
    const message = {id:mailId,from,to:'flaming@example.org',subject:'Fixture task',text:'Please do the fixture task.',receivedAt:new Date(state.now+1).toISOString(),...input.message};
    const verification = {verified:true,from,messageId:`<fixture-${number}@example.net>`,inReplyTo:'',references:'',subject:message.subject,date:message.receivedAt,...input.verification};
    records.set(mailId,{message,verification}); return mailId;
  };
  f.advance = milliseconds => { state.now += milliseconds; };
  f.restart = async env => { await f.agent.close(); f.agent=createMailAgent({...options,...(env ? {env} : {})}); };
  t.after(async()=>{await f.agent.close();db.close();});
  return f;
}

test('default installation is disabled and performs no mailbox operations; config validates users and canonical addresses', async t => {
  const f=fixture(t,{env:{}});
  f.add(1);
  await f.agent.poll();
  assert.equal(f.agent.view().enabled,false);
  assert.equal(f.calls.list.length,0);
  const view=f.agent.configure({enabled:true,senders:[{email:' OWNER@Example.net ',userId:A.userId}]});
  assert.deepEqual(view.senders,[{...A,username:'owner',displayName:'Owner'}]);
  assert.equal(view.users.length,2);
  assert.equal(view.pollIntervalSeconds,60);
  for (const senders of [[],[{email:A.email,userId:'unknown'}],[A,{...A,email:'OWNER@EXAMPLE.NET'}],[{email:'owner@example.net\nBcc: x',userId:A.userId}],Array(51).fill(A)]) {
    assert.throws(()=>f.agent.configure({enabled:true,senders}));
  }
  assert.equal(f.agent.view().senders.length,1,'invalid changes do not replace persisted config');
});

test('unconfigured transport cannot be enabled and unknown env identities fail closed', async t => {
  const f=fixture(t,{env:{},configured:false});
  assert.equal(f.agent.view().configured,false);
  assert.throws(()=>f.agent.configure({enabled:true,senders:[A]}),{status:409});
  const empty = new DatabaseSync(':memory:');
  empty.exec('CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT,display_name TEXT,created_at INTEGER);');
  try {
    assert.throws(()=>createMailAgent({...f.options,db:empty,env:{COMMUNITY_MAIL_AGENT_ENABLED:'1',COMMUNITY_MAIL_AGENT_USERS:JSON.stringify([A])}}),{status:400});
  } finally {empty.close();}
});

test('first activation cutoff and explicit configuration survive restart and later environment changes', async t => {
  const f=fixture(t,{env:{}});
  f.add(1,{message:{receivedAt:new Date(START-1000).toISOString()}});
  f.agent.configure({enabled:true,senders:[A]});
  f.add(2);
  await f.agent.poll();
  assert.deepEqual(f.calls.run.map(call=>call.id),[id(2)]);
  f.advance(86400000);
  await f.restart({COMMUNITY_MAIL_AGENT_ENABLED:'0',COMMUNITY_MAIL_AGENT_USERS:'invalid JSON ignored after first config'});
  assert.equal(f.agent.view().enabled,true);
  assert.equal(f.db.prepare('SELECT first_enabled_at FROM mail_agent_config').get().first_enabled_at,START);
  await f.agent.poll();
  assert.equal(f.calls.run.length,1);
});

test('authenticated task uses the mapped user and sends only its persisted reply with a stable idempotency key', async t => {
  const f=fixture(t); f.add(1);
  await f.agent.poll();
  assert.equal(f.calls.run.length,1);
  const input=f.calls.run[0];
  assert.equal(input.userId,A.userId);assert.equal(input.roomId,null);
  assert.equal(input.message.messageId,'<fixture-1@example.net>');
  assert.ok(input.signal instanceof AbortSignal);
  assert.deepEqual(f.calls.verify[0].input,{expectedFrom:A.email,expectedTo:'flaming@example.org',now:START});
  assert.deepEqual(f.calls.send[0],{action:'reply',id:id(1),text:'Task result for '+id(1),requestId:'mail-agent-'+id(1),automatic:true});
  assert.equal(f.agent.view().jobs[0].status,'sent');
  assert.equal(f.agent.view().jobs[0].roomId,'room-'+id(1));
  assert.equal(f.agent.view().lastCheckedAt,new Date(START).toISOString());
});

test('both inbound-hash replay and signed Message-ID replay with a different hash execute and reply only once', async t => {
  const f=fixture(t);f.add(1);
  await f.agent.poll();
  f.add(2,{verification:{messageId:'<fixture-1@example.net>'}});
  await f.agent.poll();await f.agent.poll();
  assert.equal(f.calls.run.length,1);assert.equal(f.calls.send.length,1);
  assert.equal(f.agent.view().jobs.find(job=>job.id===id(2)).reason,'duplicate_message');
});

test('unmapped, unauthenticated, automated, mismatched sender and self-mail never run or auto-reply', async t => {
  const f=fixture(t);
  f.add(1,{from:'unknown@example.net'});
  f.add(2,{verification:{verified:false,reason:'PRIVATE raw failure'}});
  f.add(3,{verification:{verified:false,reason:'skipped_automated'}});
  f.add(4,{verification:{from:B.email}});
  f.add(5,{message:{to:A.email}});
  f.add(6,{message:{to:''}});
  f.add(7,{verification:{messageId:'invalid'}});
  await f.agent.poll();
  assert.equal(f.calls.run.length,0);assert.equal(f.calls.send.length,0);
  assert.ok(f.agent.view().jobs.every(job=>job.status==='ignored'));
  assert.ok(!JSON.stringify(f.agent.view()).includes('PRIVATE'));
  assert.ok(!f.calls.read.includes(id(1)),'unmapped messages need not expose the body to the runner');
});

test('signed references keep only the same mapped user in the thread, with no subject-based matching', async t => {
  const f=fixture(t);f.add(1);await f.agent.poll();
  f.add(2,{from:B.email,verification:{references:'<fixture-1@example.net>'}});
  f.add(3,{verification:{inReplyTo:'<fixture-1@example.net>'}});
  f.add(4); // Same subject, no authenticated reference.
  await f.agent.poll();
  const runs=new Map(f.calls.run.map(call=>[call.id,call]));
  assert.equal(runs.get(id(2)).roomId,null,'another user cannot attach a forged reference to the owner thread');
  assert.equal(runs.get(id(3)).roomId,'room-'+id(1));
  assert.equal(runs.get(id(4)).roomId,null,'same subject is not a thread identity');
});

test('body length limit produces a safe reply without running agent tools', async t => {
  const f=fixture(t);f.add(1,{message:{text:'x'.repeat(8001)}});
  await f.agent.poll();
  assert.equal(f.calls.run.length,0);assert.equal(f.calls.send.length,1);
  assert.match(f.calls.send[0].text,/8,000/);
  assert.equal(f.agent.view().jobs[0].reason,'body_size_limit');
});

test('failed reply is retried after restart from persisted text without re-running a task', async t => {
  const f=fixture(t);f.add(1);f.state.sendFailure=true;
  await f.agent.poll();
  assert.equal(f.agent.view().jobs[0].status,'reply_pending');
  assert.ok(!JSON.stringify(f.agent.view()).includes('PRIVATE'));
  await f.restart();f.state.sendFailure=false;f.advance(61000);
  await f.agent.poll();
  assert.equal(f.calls.run.length,1);assert.equal(f.calls.send.length,2);
  assert.deepEqual(f.calls.send[1],f.calls.send[0]);
  assert.equal(f.agent.view().jobs[0].status,'sent');
});

test('reply attempts stop after five failures or the 23-hour safe retry window', async t => {
  const f=fixture(t);f.add(1);f.state.sendFailure=true;
  await f.agent.poll();
  for(let attempt=1;attempt<6;attempt++){f.advance(900001);await f.agent.poll();}
  assert.equal(f.calls.send.length,5);assert.equal(f.calls.run.length,1);
  assert.equal(f.agent.view().jobs[0].status,'uncertain');
  f.add(2);await f.agent.poll();const sent=f.calls.send.length;
  f.advance(23*60*60*1000);await f.agent.poll();
  assert.equal(f.calls.send.length,sent);
  assert.equal(f.agent.view().jobs.find(job=>job.id===id(2)).status,'uncertain');
});

test('startup interrupted tool executions are never automatically replayed', async t => {
  const f=fixture(t);f.state.busy=true;f.add(1);await f.agent.poll();
  f.db.prepare("UPDATE mail_agent_jobs SET status='running',started_at=? WHERE id=?").run(START,id(1));
  await f.restart();f.state.busy=false;await f.agent.poll();
  assert.equal(f.calls.run.length,0);assert.equal(f.calls.send.length,0);
  assert.equal(f.agent.view().jobs[0].status,'interrupted');
  assert.equal(f.agent.view().jobs[0].reason,'process_restarted');
});

test('capacity guard leaves tasks queued and polling coalesces while agent work is running', async t => {
  let release, entered;
  const running=new Promise(resolve=>{entered=resolve;});
  const f=fixture(t,{runTask:async input=>{
    entered();await new Promise(resolve=>{release=resolve;});
    return {text:'Finished',roomId:'room-'+input.id};
  }});
  f.state.busy=true;f.add(1);await f.agent.poll();
  assert.equal(f.agent.view().jobs[0].status,'queued');assert.equal(f.calls.raw.length,0);
  f.state.busy=false;const poll=f.agent.poll();await running;
  assert.equal(f.agent.poll(),poll);assert.equal(f.calls.run.length,1);
  release();await poll;
  assert.equal(f.calls.send.length,1);
});

test('disabling mid-run aborts the task and prevents its result from being emailed', async t => {
  let entered;
  const running=new Promise(resolve=>{entered=resolve;});
  const f=fixture(t,{runTask:input=>new Promise((resolve,reject)=>{
    input.signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});entered();
  })});
  f.add(1);const poll=f.agent.poll();await running;
  f.agent.configure({enabled:false,senders:[A,B]});await poll;
  assert.equal(f.calls.send.length,0);
  assert.equal(f.agent.view().jobs[0].status,'interrupted');
});

test('revoking a sender also blocks an already-computed pending reply', async t => {
  const f=fixture(t);f.add(1);f.state.sendFailure=true;await f.agent.poll();
  f.agent.configure({enabled:true,senders:[B]});f.advance(61000);await f.agent.poll();
  assert.equal(f.calls.send.length,1);
  assert.equal(f.agent.view().jobs[0].status,'ignored');
});

test('rolling pagination persists the next cursor and reads at most four pages per poll', async t => {
  const f=fixture(t,{list:async cursor=>{
    const page=cursor ? Number(cursor) : 0;
    return {messages:[],cursor:page<5 ? String(page+1) : null};
  }});
  await f.agent.poll();assert.deepEqual(f.calls.list,[undefined,'1','2','3']);
  await f.restart();await f.agent.poll();assert.deepEqual(f.calls.list,[undefined,'1','2','3','4','5']);
  await f.agent.poll();assert.equal(f.calls.list[6],undefined);
});

test('only ten tasks run per tick and daily quota for one user does not consume another user allowance', async t => {
  const f=fixture(t);
  for(let n=1;n<=12;n++)f.add(n);
  await f.agent.poll();assert.equal(f.calls.run.length,10);
  await f.agent.poll();assert.equal(f.calls.run.length,12);
  const insert=f.db.prepare(`INSERT INTO mail_agent_jobs(id,user_id,sender,subject,received_at,received_ms,status,started_at,created_at,updated_at) VALUES(?,?,?,?,?,?,'failed',?,?,?)`);
  for(let n=1000;n<1088;n++)insert.run(id(n),A.userId,A.email,'Prior task',new Date(START).toISOString(),START,START,START,START);
  f.add(13);f.add(14,{from:B.email});await f.agent.poll();
  assert.equal(f.calls.run.length,13);
  assert.equal(f.calls.run.at(-1).userId,B.userId);
  assert.equal(f.agent.view().jobs.find(job=>job.id===id(13)).reason,'daily_limit');
  assert.equal(f.agent.view().jobs.length,25);
});

test('close aborts the active task and future polling performs no work', async t => {
  let entered;const running=new Promise(resolve=>{entered=resolve;});
  const f=fixture(t,{runTask:input=>new Promise((resolve,reject)=>{
    input.signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});entered();
  })});
  f.add(1);const poll=f.agent.poll();await running;await f.agent.close();await poll;
  const listCalls=f.calls.list.length;await f.agent.poll();
  assert.equal(f.calls.list.length,listCalls);assert.equal(f.calls.send.length,0);
  assert.equal(f.agent.view().jobs[0].status,'interrupted');
});

test('a runner-certified capacity race stays queued without consuming the daily task allowance', async t => {
  let busy = true;
  const f=fixture(t,{runTask:async input=>{
    if(busy)throw Object.assign(new Error('PRIVATE internal capacity detail'),{safeToRetry:true});
    return {text:'Finished once capacity is free',roomId:'room-'+input.id};
  }});
  f.add(1);await f.agent.poll();
  assert.equal(f.agent.view().jobs[0].status,'queued');
  assert.equal(f.agent.view().jobs[0].reason,'agent_busy');
  assert.equal(f.db.prepare('SELECT started_at FROM mail_agent_jobs WHERE id=?').get(id(1)).started_at,null);
  assert.equal(f.calls.send.length,0);
  busy=false;await f.agent.poll();
  assert.equal(f.calls.send.length,1);assert.equal(f.agent.view().jobs[0].status,'sent');
  await f.agent.poll();assert.equal(f.calls.run.length,2);
});

test('three-minute execution deadline interrupts a task permanently instead of rerunning it', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  let entered;const running=new Promise(resolve=>{entered=resolve;});
  const f=fixture(t,{runTask:input=>new Promise((resolve,reject)=>{
    input.signal.addEventListener('abort',()=>reject(new Error('deadline')),{once:true});entered();
  })});
  f.add(1);const poll=f.agent.poll();await running;
  t.mock.timers.tick(180000);await poll;
  assert.equal(f.agent.view().jobs[0].status,'interrupted');
  assert.equal(f.calls.send.length,0);
  await f.agent.poll();assert.equal(f.calls.run.length,1);
});
