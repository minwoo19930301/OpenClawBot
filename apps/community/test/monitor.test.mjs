import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startCommunity } from '../server.mjs';
import { MONITOR_ROOM, readMonitor, explainMonitor } from '../monitor.mjs';

test('monitor is admin-only, non-invitable, idempotent and never calls model', async () => {
  const dir=await mkdtemp(join(tmpdir(),'monitor-'));
  let calls=0;
  const app=await startCommunity({dataDir:dir,port:0,env:{COMMUNITY_BOOTSTRAP_TOKEN:'bootstrap',COMMUNITY_MONITOR_PATH:join(dir,'missing')},llm:{complete(){ calls++; throw new Error('must not call'); }}});
  function client(){let cookie='',csrf='';return async(path,body)=>{const r=await fetch(app.url+path,{method:body?'POST':'GET',headers:{cookie,'content-type':'application/json','x-csrf-token':csrf},body:body?JSON.stringify(body):undefined}); const v=await r.json(); if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];if(v.csrfToken)csrf=v.csrfToken;return {status:r.status,...v};};}
  const admin=client(),member=client();
  try {
    const register=(username,inviteToken)=>({username,displayName:username,password:'long-test-password',inviteToken});
    assert.equal((await admin('/api/register',register('admin','bootstrap'))).status,201);
    assert.ok((await admin('/api/rooms')).rooms.some(r=>r.id===MONITOR_ROOM));
    assert.equal((await admin(`/api/rooms/${MONITOR_ROOM}/invites`,{})).status,403);
    const inv=await admin('/api/admin/invites',{});
    await member('/api/register',register('member',inv.token));
    assert.equal((await member('/api/admin/monitor')).status,403);
    assert.equal((await member(`/api/rooms/${MONITOR_ROOM}`)).status,404);
    assert.ok(!(await member('/api/rooms')).rooms.some(r=>r.id===MONITOR_ROOM));
    const msg={text:'상태 알려줘',clientNonce:'once',botIds:['bot-analyst']};
    assert.equal((await admin(`/api/rooms/${MONITOR_ROOM}/messages`,msg)).status,202);
    const before=(await admin(`/api/rooms/${MONITOR_ROOM}`)).messages;
    await admin(`/api/rooms/${MONITOR_ROOM}/messages`,msg);
    assert.equal((await admin(`/api/rooms/${MONITOR_ROOM}`)).messages.length,before.length);
    assert.match(before.at(-1).text,/갱신되지/);
    assert.equal(calls,0);
    assert.equal((await admin('/api/rooms')).usage.used,0);
  } finally {await app.close();await rm(dir,{recursive:true,force:true});}
});
test('missing and stale snapshots never imply healthy or free',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'monitor-data-'));const path=join(dir,'status.json');
  try{
    assert.equal((await readMonitor(path)).available,false);
    await writeFile(path,JSON.stringify({timestamp:Date.now()-240000}));
    assert.equal((await readMonitor(path)).available,false);
    assert.match(explainMonitor(await readMonitor(path)),/판단할 수 없습니다/);
  }finally{await rm(dir,{recursive:true,force:true});}
});
