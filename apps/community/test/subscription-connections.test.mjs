import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,chmodSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SUBSCRIPTION_CONNECTIONS,getSubscriptionConnections} from '../subscription-connections.mjs';
import {parseArgs,gatewayCommand,checkLocalStorage,runConnection} from '../scripts/connect-subscription.mjs';

test('catalog separates official CLI login from verified Gateway subscription support',()=>{
  assert.equal(SUBSCRIPTION_CONNECTIONS.length,3);
  for (const item of SUBSCRIPTION_CONNECTIONS) {
    assert.ok(item.docsUrl.startsWith('https://'));assert.ok(item.steps.length);assert.ok(item.command.endsWith('--check'));
  }
  assert.deepEqual(SUBSCRIPTION_CONNECTIONS.filter(item=>item.gatewaySupported).map(item=>item.id),['codex']);
  assert.equal(getSubscriptionConnections({gatewayVersion:'2026.9.5'})[0].gatewayVersionVerified,true);
  assert.equal(getSubscriptionConnections({gatewayVersion:'2099.1.1'})[0].gatewayVersionVerified,false);
  const copy=getSubscriptionConnections();copy[0].steps.length=0;
  assert.ok(SUBSCRIPTION_CONNECTIONS[0].steps.length);
});

test('helper rejects unverified provider forwarding and malformed command selectors',()=>{
  for (const args of [[],['codex;id'],['claude','--gateway','local'],['gemini','--gateway','compose'],
    ['codex','--gateway','other'],['codex','--token','secret'],['codex','--gateway','compose'],
    ['codex','--gateway','compose','--project-directory','/deploy','--compose-file','/compose.yml','--service','openclaw;id']]) {
    assert.throws(()=>parseArgs(args));
  }
});

test('Compose executes argv without shell and includes interpolation env and private service user',()=>{
  const options=parseArgs(['codex','--gateway','compose','--project-directory','/srv/deploy space',
    '--compose-file','/srv/base.yml','--compose-file','/srv/subscription.yml','--project-name','example']);
  const command=gatewayCommand(options,['--version']);
  assert.equal(command.file,'docker');
  assert.deepEqual(command.args,['compose','--project-directory','/srv/deploy space','--env-file','/srv/deploy space/.env.production',
    '-f','/srv/base.yml','-f','/srv/subscription.yml','-p','example','exec','-T','--user','node','openclaw','node','openclaw.mjs','--version']);
  assert.ok(!gatewayCommand(options,['models','auth','login'],true).args.includes('-T'));
});

test('check diagnoses only; it does not login, copy credentials, or run a model',()=>{
  for (const provider of ['codex','claude','gemini']) {
    const calls=[];const result=runConnection(parseArgs([provider,'--check']),{run:(file,args)=>{calls.push({file,args});return {status:0,stdout:'CLI 1.0'};},log:()=>{}});
    assert.equal(result.loggedIn,false);assert.deepEqual(calls,[{file:provider,args:['--version']}]);
  }
});

test('Gateway check validates runtime version and private storage before any OAuth',()=>{
  const options=parseArgs(['codex','--gateway','compose','--project-directory','/srv/deploy','--compose-file','/srv/compose.yml','--check']);
  const calls=[];
  const result=runConnection(options,{run:(file,args)=>{calls.push({file,args});return {status:0,stdout:args.includes('--version')?'OpenClaw 2026.9.5':'ready'};},log:()=>{}});
  assert.equal(result.loggedIn,false);assert.equal(calls.length,2);assert.ok(calls[1].args.includes('-e'));
  assert.ok(calls.every(call=>!call.args.includes('login')));
  for (const version of ['2026.3.12','2026.9.6','unexpected secret-like output']) {
    assert.throws(()=>runConnection(options,{run:()=>({status:0,stdout:version}),log:()=>{}}),/not been verified/);
  }
});

test('verified Gateway versions use their own provider id and preserve terminal OAuth',()=>{
  for (const [version,provider] of [['2026.3.13','openai-codex'],['2026.3.13-1','openai-codex'],['2026.9.5','openai']]) {
    const calls=[];let storageChecks=0;
    runConnection(parseArgs(['codex','--gateway','local']),{run:(file,args,options)=>{calls.push({file,args,options});return {status:0,stdout:version};},checkStorage:()=>storageChecks++,isTTY:true,log:()=>{}});
    assert.equal(storageChecks,1);assert.deepEqual(calls[1],{file:'openclaw',args:['models','auth','login','--provider',provider,...(version==='2026.9.5'?['--device-code']:[]),'--set-default'],options:{interactive:true}});
  }
});

test('standalone login uses only official CLI commands and requires an interactive terminal',()=>{
  for (const [provider,args] of [['codex',['login','--device-auth']],['claude',['auth','login']],['gemini',[]]]) {
    const calls=[];const run=(file,argv,options)=>{calls.push({file,args:argv,options});return {status:0,stdout:'1.0'};};
    assert.throws(()=>runConnection(parseArgs([provider]),{run,isTTY:false,log:()=>{}}),/interactive host terminal/);
    assert.equal(calls.length,1);calls.length=0;
    runConnection(parseArgs([provider]),{run,isTTY:true,log:()=>{}});
    assert.deepEqual(calls[1],{file:provider,args,options:{interactive:true}});
  }
});

test('existing auth state is inspected by metadata and never replaced or loosened',()=>{
  const temporary=mkdtempSync(join(tmpdir(),'subscription-storage-'));const state=join(temporary,'state'),config=join(state,'openclaw.json');
  try {
    mkdirSync(state,{mode:0o700});writeFileSync(config,'existing private config',{mode:0o600});
    const env={OPENCLAW_STATE_DIR:state,OPENCLAW_CONFIG_PATH:config};
    assert.doesNotThrow(()=>checkLocalStorage(env));
    chmodSync(config,0o644);assert.throws(()=>checkLocalStorage(env),/private state/);chmodSync(config,0o600);
    const alias=join(temporary,'alias');symlinkSync(config,alias);assert.throws(()=>checkLocalStorage({...env,OPENCLAW_CONFIG_PATH:alias}),/private state/);
    chmodSync(state,0o755);assert.throws(()=>checkLocalStorage(env),/private state/);
  } finally {rmSync(temporary,{recursive:true,force:true});}
});

test('failed preflight or login never prints captured provider output and restores umask',()=>{
  const messages=[],secret='synthetic-secret-that-must-not-be-logged',mask=process.umask();
  assert.throws(()=>runConnection(parseArgs(['codex','--check']),{run:()=>({status:1,stdout:secret}),log:line=>messages.push(line)}),/unavailable/);
  assert.throws(()=>runConnection(parseArgs(['codex']),{run:(_file,args)=>({status:args.includes('--version')?0:1,stdout:secret}),isTTY:true,log:line=>messages.push(line)}),/did not complete/);
  assert.ok(!messages.join('\n').includes(secret));assert.equal(process.umask(),mask);
});
