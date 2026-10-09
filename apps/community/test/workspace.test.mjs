import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import WebSocket,{WebSocketServer} from 'ws';
import {startCommunity} from '../server.mjs';
import {workspacePath,workspaceEndpoint} from '../workspace.mjs';

async function fixture(t){
  const requests=[],actions=[];
  const upstream=createServer((req,res)=>{
    requests.push({url:req.url,cookie:req.headers.cookie});
    res.setHeader('content-type','application/json');
    if(req.url==='/health')res.end(JSON.stringify({ok:true,terminal:true,files:true}));
    else if(req.url.startsWith('/files?'))res.end(JSON.stringify({path:'',entries:[{name:'hello.txt',path:'hello.txt',type:'file',size:5,modified:0}]}));
    else if(req.url.startsWith('/file?'))res.end('hello');
    else {res.statusCode=404;res.end('{}');}
  });
  const wss=new WebSocketServer({server:upstream});
  wss.on('connection',(ws,req)=>{requests.push({url:req.url,cookie:req.headers.cookie,origin:req.headers.origin});ws.on('message',data=>ws.send(data,{binary:false}));});
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${upstream.address().port}/`,shared=randomUUID();
  const dir=await mkdtemp(join(tmpdir(),'workspace-test-'));
  const app=await startCommunity({dataDir:dir,port:0,env:{COMMUNITY_BOOTSTRAP_TOKEN:'bootstrap',COMMUNITY_SHARED_DESKTOP_ROOM:shared,COMMUNITY_DESKTOP_MAP:JSON.stringify({[shared]:{wsUrl:'ws://127.0.0.1:6080/',cdpUrl:base,workspaceUrl:base}})},browserTools:{configured:()=>true,frame:async()=>({image:'data:image/jpeg;base64,eA==',width:1280,height:800,url:'https://example.com/',title:'Example'}),action:async(room,args)=>{actions.push({room,args});return {ok:true};},close:async()=>{}}});
  t.after(async()=>{await app.close();for(const ws of wss.clients)ws.terminate();await new Promise(resolve=>wss.close(resolve));await new Promise(resolve=>upstream.close(resolve));await rm(dir,{recursive:true,force:true});});
  async function call(path,{auth,body,method=body===undefined?'GET':'POST',csrf=true}={}){
    const response=await fetch(app.url+path,{method,headers:{'content-type':'application/json',...(auth?{cookie:auth.cookie,...(csrf?{'x-csrf-token':auth.csrf}: {})}: {})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(5000)});
    return {status:response.status,response,data:await response.json().catch(()=>null)};
  }
  async function register(name,admin){const invite=admin?(await call('/api/admin/invites',{auth:admin,body:{}})).data.token:'bootstrap';const result=await call('/api/register',{body:{username:name,displayName:name,password:'workspace-test-password',inviteToken:invite}});assert.equal(result.status,201);return {cookie:result.response.headers.get('set-cookie').split(';')[0],csrf:result.data.csrfToken};}
  const owner=await register('owner'),outsider=await register('outsider',owner);
  const room=(await call('/api/rooms',{auth:owner,body:{name:'Workspace'}})).data.room.id;
  return {app,owner,outsider,room,call,requests,actions,upstreamClients:wss.clients};
}

test('workspace paths and endpoints cannot target outside configured shared computer',()=>{
  for(const path of ['/etc/passwd','../env','a/../../secret','a\\b','a\0b'])assert.throws(()=>workspacePath(path));
  assert.equal(workspacePath('Downloads/./report.txt'),'Downloads/report.txt');
  assert.equal(workspaceEndpoint({cdpUrl:'http://desktop-test:9222/'}).port,'6083');
  assert.throws(()=>workspaceEndpoint({cdpUrl:'http://127.0.0.1:9222/',workspaceUrl:'http://169.254.169.254/'}));
});

test('sidebar groups are per-user, membership is validated, deleting groups preserves chats and pin state',async t=>{
  const f=await fixture(t),group=randomUUID();
  const body={width:350,groups:[{id:group,name:'업무',collapsed:false}]};
  assert.equal((await f.call('/api/sidebar',{body,method:'PUT'})).status,401);
  assert.equal((await f.call('/api/sidebar',{auth:f.owner,body,method:'PUT',csrf:false})).status,403);
  assert.equal((await f.call('/api/sidebar',{auth:f.owner,body,method:'PUT'})).status,200);
  assert.deepEqual((await f.call('/api/sidebar',{auth:f.outsider})).data,{width:280,groups:[]});
  assert.equal((await f.call(`/api/rooms/${f.room}/preferences`,{auth:f.owner,body:{pinned:true,archived:false,groupId:group}})).status,200);
  assert.equal((await f.call(`/api/rooms/${f.room}/preferences`,{auth:f.owner,body:{pinned:true,archived:false,groupId:randomUUID()}})).status,400);
  assert.equal((await f.call('/api/sidebar',{auth:f.owner,body:{width:300,groups:[]},method:'PUT'})).status,200);
  const room=(await f.call('/api/rooms',{auth:f.owner})).data.rooms.find(r=>r.id===f.room);
  assert.equal(room.groupId,null);assert.equal(room.pinned,true);assert.equal(room.archived,false);
  assert.equal((await f.call('/api/sidebar',{auth:f.owner,body:{...body,width:900},method:'PUT'})).status,400);
});

test('workspace browser and files require membership; browser actions and terminal tickets require CSRF',async t=>{
  const f=await fixture(t),root=`/api/rooms/${f.room}/workspace`;
  for(const path of ['', '/browser/frame','/files','/file?path=hello.txt']){
    assert.equal((await f.call(root+path)).status,401);assert.equal((await f.call(root+path,{auth:f.outsider})).status,404);
  }
  assert.deepEqual((await f.call(root,{auth:f.owner})).data,{browser:true,terminal:true,files:true,shared:true});
  assert.equal((await f.call(root+'/browser/action',{auth:f.owner,body:{type:'reload'},csrf:false})).status,403);
  assert.equal((await f.call(root+'/terminal/ticket',{auth:f.owner,body:{},csrf:false})).status,403);
  assert.equal((await f.call(root+'/browser/action',{auth:f.owner,body:{type:'reload'}})).status,200);
  assert.equal(f.actions[0].room,f.room);
  assert.equal((await f.call(root+'/files',{auth:f.owner})).data.entries[0].name,'hello.txt');
  assert.equal((await f.call(root+'/file?path=../secret',{auth:f.owner})).status,400);
  const download=await fetch(f.app.url+root+'/file?path=hello.txt',{headers:{cookie:f.owner.cookie}});
  assert.equal(download.headers.get('content-type'),'application/octet-stream');assert.match(download.headers.get('content-disposition'),/^attachment/);assert.equal(await download.text(),'hello');
  assert.ok(f.requests.every(req=>!req.cookie));
});

function rejectedWs(url,headers){return new Promise((resolve,reject)=>{const ws=new WebSocket(url,{headers});ws.on('unexpected-response',(request,response)=>{response.resume();resolve(response.statusCode);request.destroy();});ws.on('error',reject);ws.on('open',()=>{ws.terminate();reject(new Error('Unexpected WebSocket acceptance'));});});}
test('terminal tickets are single-use, room/session-bound and Origin checked; only shell messages are proxied',{timeout:15000},async t=>{
  const f=await fixture(t),root=`/api/rooms/${f.room}/workspace`;
  const ticket=(await f.call(root+'/terminal/ticket',{auth:f.owner,body:{}})).data;
  const url=f.app.url.replace('http:','ws:')+ticket.websocketPath;
  assert.equal(await rejectedWs(url,{cookie:f.owner.cookie,origin:'https://elsewhere.test'}),403);
  assert.equal(await rejectedWs(url,{cookie:f.outsider.cookie,origin:f.app.url}),403);
  const ws=new WebSocket(url,{headers:{cookie:f.owner.cookie,origin:f.app.url}});t.after(()=>ws.terminate());
  await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
  const message=new Promise((resolve,reject)=>{ws.once('message',data=>resolve(JSON.parse(data)));ws.once('close',()=>reject(new Error('Terminal closed before output')));});
  ws.send(JSON.stringify({type:'input',data:'echo hello\r'}));
  assert.deepEqual(await message,{type:'input',data:'echo hello\r'});
  assert.equal(await rejectedWs(url,{cookie:f.owner.cookie,origin:f.app.url}),403);
  const upstream=f.requests.find(req=>req.url.startsWith('/terminal?'));
  assert.match(upstream.url,/session=[a-f0-9]{64}$/);assert.equal(upstream.cookie,undefined);assert.equal(upstream.origin,undefined);
  const closed=new Promise(resolve=>ws.once('close',resolve));ws.send(JSON.stringify({type:'exec',command:'not-supported'}));await closed;
});

async function connectedTerminal(t,f){
  const ticket=(await f.call(`/api/rooms/${f.room}/workspace/terminal/ticket`,{auth:f.owner,body:{}})).data;
  const ws=new WebSocket(f.app.url.replace('http:','ws:')+ticket.websocketPath,{headers:{cookie:f.owner.cookie,origin:f.app.url}});
  t.after(()=>ws.terminate());
  await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
  const echo=new Promise((resolve,reject)=>{ws.once('message',resolve);ws.once('close',()=>reject(new Error('Terminal closed before upstream readiness')));});
  ws.send(JSON.stringify({type:'input',data:'ready'}));
  await echo;
  return ws;
}

function closedWithoutOutput(ws){
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>finish(new Error('Revoked terminal remained open until the periodic check')),5000);
    const leaked=()=>finish(new Error('Terminal forwarded data after access was revoked'));
    const closed=()=>finish();
    function finish(error){clearTimeout(timer);ws.off('message',leaked);ws.off('close',closed);if(error)reject(error);else resolve();}
    ws.on('message',leaked);ws.once('close',closed);
  });
}

test('terminal input is refused immediately after logout, before the periodic membership timer',{timeout:10000},async t=>{
  const f=await fixture(t),ws=await connectedTerminal(t,f);
  assert.equal((await f.call('/api/logout',{auth:f.owner,body:{}})).status,200);
  const closed=closedWithoutOutput(ws);
  ws.send(JSON.stringify({type:'input',data:'must not reach the shell'}));
  await closed;
});

test('terminal output is refused immediately after room membership is removed',{timeout:10000},async t=>{
  const f=await fixture(t),ws=await connectedTerminal(t,f);
  f.app.db.prepare('DELETE FROM room_members WHERE room_id=?').run(f.room);
  const closed=closedWithoutOutput(ws);
  for(const upstream of f.upstreamClients)upstream.send(JSON.stringify({type:'output',data:'revoked room data'}),{binary:false});
  await closed;
});

test('application shutdown closes active terminal transports without waiting for their idle lifetime',{timeout:10000},async t=>{
  const f=await fixture(t),ws=await connectedTerminal(t,f);
  const closed=new Promise(resolve=>ws.once('close',resolve));
  await f.app.close();
  await closed;
  assert.equal(ws.readyState,WebSocket.CLOSED);
});
