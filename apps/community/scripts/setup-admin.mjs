// Local, one-time administrator setup. Credentials are forwarded over HTTPS and
// kept in memory only; this command never prints the bootstrap invitation.
// Example (use your own values, never commit them):
// COMMUNITY_SETUP_SITE=https://example.invalid \
// COMMUNITY_SETUP_SSH_HOST=opc@example.invalid \
// COMMUNITY_SETUP_SSH_KEY=/absolute/path/to/key \
// COMMUNITY_SETUP_REMOTE_ENV=/absolute/path/to/.env.production \
// node apps/community/scripts/setup-admin.mjs
import {createServer} from 'node:http';
import {execFile} from 'node:child_process';
import {accessSync, constants} from 'node:fs';
import {isAbsolute} from 'node:path';
import {promisify} from 'node:util';
import {randomBytes} from 'node:crypto';
const execute=promisify(execFile);
const origin='http://127.0.0.1:8788';
const required=(name)=>{const value=process.env[name]?.trim();if(!value)throw new Error(`${name} is required`);return value;};
const siteValue=required('COMMUNITY_SETUP_SITE');
let siteUrl;try{siteUrl=new URL(siteValue);}catch{throw new Error('COMMUNITY_SETUP_SITE must be a valid HTTPS URL or localhost URL');}
const localhost=['localhost','127.0.0.1','[::1]'].includes(siteUrl.hostname);
if(siteUrl.protocol!=='https:'&&!localhost)throw new Error('COMMUNITY_SETUP_SITE must use HTTPS unless it targets localhost');
if(siteUrl.username||siteUrl.password||siteUrl.search||siteUrl.hash)throw new Error('COMMUNITY_SETUP_SITE must not contain credentials, query, or fragment');
siteUrl.pathname=siteUrl.pathname.replace(/\/$/,'');
const site=siteUrl.href.replace(/\/$/,'');
const sshHost=required('COMMUNITY_SETUP_SSH_HOST');
if(!/^[A-Za-z0-9_.:@\-\[\]]+$/.test(sshHost)||sshHost.startsWith('-'))throw new Error('COMMUNITY_SETUP_SSH_HOST contains unsupported shell characters');
const sshKey=required('COMMUNITY_SETUP_SSH_KEY');
if(!isAbsolute(sshKey)||/[\r\n]/.test(sshKey))throw new Error('COMMUNITY_SETUP_SSH_KEY must be an absolute path without newlines');
try{accessSync(sshKey,constants.R_OK);}catch{throw new Error('COMMUNITY_SETUP_SSH_KEY is not readable');}
const remoteEnv=required('COMMUNITY_SETUP_REMOTE_ENV');
if(!isAbsolute(remoteEnv)||remoteEnv.split('/').includes('..')||!/^[A-Za-z0-9_./-]+$/.test(remoteEnv))throw new Error('COMMUNITY_SETUP_REMOTE_ENV must be a safe absolute path');
const session=randomBytes(32).toString('hex');
const remoteRead=`python3 -c 'from pathlib import Path; p=Path("${remoteEnv}"); print(next(l.split("=",1)[1] for l in p.read_text().splitlines() if l.startswith("COMMUNITY_BOOTSTRAP_TOKEN=")))'`;
const {stdout}=await execute('ssh',['-o','BatchMode=yes','-o','ConnectTimeout=10','-o','StrictHostKeyChecking=yes','-i',sshKey,sshHost,remoteRead],{maxBuffer:4096,timeout:15000});
let invite=stdout.trim();
if(!invite)throw new Error('Bootstrap invitation unavailable');
let used=false,attempts=0,busy=false;
const esc=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const html=(error='')=>`<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Open Grokbot 관리자 설정</title><style>body{background:#111;color:#eee;font:14px system-ui;max-width:420px;margin:12vh auto;padding:24px}label{display:block;margin:18px 0 6px}input,button{box-sizing:border-box;width:100%;padding:12px;background:#222;color:#eee;border:1px solid #444;border-radius:6px}button{margin-top:24px;cursor:pointer}p{line-height:1.7;color:#aaa}strong{color:#ddd}</style><h1>관리자 계정 만들기</h1><p>배포된 <strong>Open Grokbot</strong>에서 사용할 계정입니다. 초대 코드는 자동으로 적용됩니다.</p>${error?`<p role="alert">${esc(error)}</p>`:''}<form method="post" action="/register"><input type="hidden" name="csrf" value="${session}"><label for="username">아이디</label><input id="username" name="username" autocomplete="username" pattern="[a-z0-9_]{3,40}" minlength="3" maxlength="40" required><label for="displayName">표시 이름</label><input id="displayName" name="displayName" maxlength="80" required><label for="password">비밀번호 · 10자 이상</label><input id="password" name="password" type="password" autocomplete="new-password" minlength="10" maxlength="256" required><button>계정 만들기</button></form><p>등록 후 <a style="color:#ddd" href="${site}">실제 웹사이트</a>의 로그인 화면으로 이동합니다.</p></html>`;
const server=createServer(async(req,res)=>{
 res.setHeader('cache-control','no-store');res.setHeader('referrer-policy','no-referrer');res.setHeader('x-content-type-options','nosniff');
 res.setHeader('content-security-policy',"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
 if(req.headers.host!=='127.0.0.1:8788'||req.headers['sec-fetch-site']==='cross-site'||req.headers.origin&&req.headers.origin!==origin){res.writeHead(403);res.end();return;}
 if(used){res.writeHead(303,{location:site});res.end();return;}
 if(req.method==='GET'&&req.url==='/'){res.writeHead(200,{'content-type':'text/html; charset=utf-8','set-cookie':`setup_session=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=1800`});res.end(html());return;}
 if(req.method!=='POST'||req.url!=='/register'){res.writeHead(404);res.end();return;}
 if(busy||attempts>=10){res.writeHead(429);res.end('잠시 후 다시 시도해주세요.');return;}
 try {
  let bytes=0,chunks=[];for await(const chunk of req){bytes+=chunk.length;if(bytes>4096)throw new Error('입력이 너무 깁니다.');chunks.push(chunk);}
  const data=new URLSearchParams(Buffer.concat(chunks).toString());
  if(!req.headers.cookie?.split(';').map(x=>x.trim()).includes('setup_session='+session)||data.get('csrf')!==session)throw new Error('설정 화면을 새로고침해주세요.');
  attempts++;busy=true;
  const response=await fetch(site+'/api/register',{method:'POST',headers:{'content-type':'application/json',origin:siteUrl.origin},signal:AbortSignal.timeout(15000),body:JSON.stringify({username:data.get('username'),displayName:data.get('displayName'),password:data.get('password'),inviteToken:invite})});
  const result=await response.json();
  if(!response.ok)throw new Error(result.error||'등록하지 못했습니다.');
  used=true;invite='';res.writeHead(303,{location:site,'set-cookie':'setup_session=; Max-Age=0; Path=/'});res.end();
  console.log('Administrator setup completed. Sign in at '+site);
  setTimeout(()=>server.close(),1000).unref();
 }catch(error){res.writeHead(400,{'content-type':'text/html; charset=utf-8'});res.end(html(error.message));}
 finally{busy=false;}
});
server.requestTimeout=15000;server.headersTimeout=10000;
server.listen(8788,'127.0.0.1',()=>console.log('Private administrator setup ready at '+origin));
setTimeout(()=>{invite='';server.close();},30*60*1000).unref();
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{invite='';server.close();});
