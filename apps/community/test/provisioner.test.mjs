import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProvisioner } from '../provisioner.mjs';
import { startCommunity } from '../server.mjs';

test('provisioner deduplicates startup and rejects unexpected endpoint', async()=>{
 const dir=await mkdtemp(join(tmpdir(),'provision-')); const sock=join(dir,'control.sock');let calls=0,bad=false;
 const server=createServer((req,res)=>{calls++;const room=req.url.split('/')[2];res.end(JSON.stringify({wsUrl:bad?'ws://169.254.169.254/':`ws://desktop-${room}:6080/`,cdpUrl:`http://desktop-${room}:9222/`}));});
 await new Promise(r=>server.listen(sock,r));const map=new Map(),broker=createProvisioner(sock,map); const room='12345678-1234-1234-1234-123456789abc';
 try{await Promise.all([broker.ensure(room),broker.ensure(room)]);assert.equal(calls,1);assert.equal(map.size,1);bad=true;await assert.rejects(broker.ensure(room),/Unexpected/);}finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
test('desktop creation requires authenticated room membership and CSRF',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'provision-auth-'));const app=await startCommunity({dataDir:dir,port:0,env:{COMMUNITY_BOOTSTRAP_TOKEN:'bootstrap',COMMUNITY_PROVISIONER_SOCKET:join(dir,'must-not-be-called')}});
 function client(){let cookie='',csrf='';return async(path,body)=>{const r=await fetch(app.url+path,{method:body?'POST':'GET',headers:{cookie,'content-type':'application/json','x-csrf-token':csrf},body:body?JSON.stringify(body):undefined});const v=await r.json();if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];if(v.csrfToken)csrf=v.csrfToken;return{status:r.status,...v};};}
 try{const owner=client(),other=client();const reg=(username,inviteToken)=>({username,inviteToken,displayName:username,password:'test-password-long'});await owner('/api/register',reg('owner','bootstrap'));const room=(await owner('/api/rooms',{name:'private'})).room.id;const invite=await owner('/api/admin/invites',{});await other('/api/register',reg('other',invite.token));assert.equal((await other(`/api/rooms/${room}/desktop/start`,{})).status,404);assert.equal((await fetch(app.url+`/api/rooms/${room}/desktop/start`,{method:'POST'})).status,401);assert.equal((await owner(`/api/rooms/${room}/desktop/start`,{})).status,503);}finally{await app.close();await rm(dir,{recursive:true,force:true});}
});
