import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIntegrations } from '../integrations.mjs';

test('imported service credentials work without a plaintext copy, including numbered keys',async()=>{
  const resources={
    FAL_KEY_2:'fixture-fal-key',NAVER_MAIL_USERNAME_2:'fixture-mail-user',NAVER_MAIL_PASSWORD_2:'fixture-mail-password',
    OCI_PRIVATE_KEY:'fixture-infrastructure-secret',GROQ_API_KEY:'fixture-model-secret',
  };
  const before=structuredClone(resources);
  let mailOpened=false,closed=false;
  const services=createIntegrations({getResources:()=>resources,fetchImpl:async(url,options)=>{
    assert.equal(url,'https://api.fal.ai/v1/models?limit=20');
    assert.equal(options.headers.authorization,'Key fixture-fal-key');
    return Response.json({models:[{endpoint_id:'fixture-model',metadata:{display_name:'Model'}}]});
  },imapFactory:options=>{
    assert.deepEqual(options.auth,{user:'fixture-mail-user',pass:'fixture-mail-password'});
    assert.equal(options.secure,true);assert.equal(options.logger,false);
    return {connect:async()=>{},mailboxOpen:async(name,options)=>{assert.equal(name,'INBOX');assert.equal(options.readOnly,true);mailOpened=true;},mailbox:{exists:0},close:()=>{closed=true;}};
  }});
  const list=await services.list();
  assert.equal(list.find(item=>item.id==='fal').configured,true);
  assert.equal(list.find(item=>item.id==='naver-mail').configured,true);
  for(const value of Object.values(resources))assert.ok(!JSON.stringify(list).includes(value));
  assert.equal((await services.execute('fal','models')).models[0].id,'fixture-model');
  assert.deepEqual(await services.execute('naver-mail','inbox'),{total:0,messages:[]});
  assert.equal(mailOpened,true);assert.equal(closed,true);
  assert.deepEqual(resources,before,'normalizing numbered aliases must not mutate the original Vault map');
});

test('private integration credentials win and Kakao refresh never copies unrelated Vault resources to plaintext',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'resource-refresh-')),path=join(dir,'integrations.json');
  const resources={KAKAO_ACCESS_TOKEN:'fixture-vault-old',KAKAO_REFRESH_TOKEN:'fixture-vault-refresh',KAKAO_CLIENT_ID:'fixture-vault-client',OCI_PRIVATE_KEY:'fixture-infrastructure-secret',GROQ_API_KEY:'fixture-ai-secret'};
  const before=structuredClone(resources);
  try {
    await writeFile(path,JSON.stringify({EXISTING_SERVICE_SETTING:'kept',KAKAO_ACCESS_TOKEN:'fixture-file-old',KAKAO_CLIENT_ID:'fixture-file-client'}),{mode:0o600});
    const seen=[];
    const services=createIntegrations({path,getResources:()=>resources,fetchImpl:async(url,options)=>{
      seen.push({url,options});
      if(url==='https://kauth.kakao.com/oauth/token'){
        assert.equal(options.body.get('client_id'),'fixture-file-client');
        assert.equal(options.body.get('refresh_token'),'fixture-vault-refresh');
        return Response.json({access_token:'fixture-refreshed-access',refresh_token:'fixture-refreshed-refresh'});
      }
      assert.equal(url,'https://kapi.kakao.com/v2/api/calendar/calendars');
      if(options.headers.authorization==='Bearer fixture-file-old')return Response.json({error:'expired'},{status:401});
      assert.equal(options.headers.authorization,'Bearer fixture-refreshed-access');
      return Response.json({calendars:[]});
    }});
    assert.deepEqual(await services.execute('kakao-calendar','calendars'),{calendars:[]});
    assert.equal(seen.length,3);
    const saved=JSON.parse(await readFile(path,'utf8'));
    assert.deepEqual(saved,{EXISTING_SERVICE_SETTING:'kept',KAKAO_ACCESS_TOKEN:'fixture-refreshed-access',KAKAO_CLIENT_ID:'fixture-file-client',KAKAO_REFRESH_TOKEN:'fixture-refreshed-refresh'});
    assert.ok(!JSON.stringify(saved).includes('fixture-infrastructure-secret'));
    assert.ok(!JSON.stringify(saved).includes('fixture-ai-secret'));
    assert.deepEqual(resources,before);
    assert.deepEqual(await services.execute('kakao-calendar','calendars'),{calendars:[]});
    assert.equal(seen.length,4,'persisted token should be reused without another refresh');
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('empty legacy credentials do not hide valid Vault service connections or change either source',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'resource-empty-legacy-')),path=join(dir,'integrations.json');
  const resources={FAL_KEY:'fixture-vault-fal',RESEND_API_KEY:'fixture-vault-resend'};
  const beforeResources=structuredClone(resources);
  try {
    const legacy=JSON.stringify({FAL_KEY:'',RESEND_API_KEY:null,UNRELATED_SETTING:'keep'});
    await writeFile(path,legacy,{mode:0o600});
    const requests=[];
    const services=createIntegrations({path,getResources:()=>resources,fetchImpl:async(url,options)=>{
      requests.push(url);
      if(url==='https://api.fal.ai/v1/models?limit=20'){
        assert.equal(options.headers.authorization,'Key fixture-vault-fal');
        return Response.json({models:[]});
      }
      assert.equal(url,'https://api.resend.com/domains');
      assert.equal(options.headers.authorization,'Bearer fixture-vault-resend');
      return Response.json({data:[]});
    }});
    const list=await services.list();
    assert.equal(list.find(item=>item.id==='fal').configured,true);
    assert.equal(list.find(item=>item.id==='resend').configured,true);
    assert.deepEqual((await services.execute('fal','models')).models,[]);
    assert.deepEqual(await services.execute('resend','domains'),{domains:[]});
    assert.equal(requests.length,2);
    assert.equal(await readFile(path,'utf8'),legacy);
    assert.deepEqual(resources,beforeResources);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('Vault-only Kakao refuses refresh before rotating a token that has no persistent destination',async()=>{
  const resources={KAKAO_ACCESS_TOKEN:'fixture-expired-access',KAKAO_REFRESH_TOKEN:'fixture-refresh',KAKAO_CLIENT_ID:'fixture-client'};
  const before=structuredClone(resources),requests=[];
  const services=createIntegrations({getResources:()=>resources,fetchImpl:async(url,options)=>{
    requests.push(url);
    if(url==='https://kauth.kakao.com/oauth/token')return Response.json({access_token:'fixture-rotated-access',refresh_token:'fixture-rotated-refresh'});
    assert.equal(url,'https://kapi.kakao.com/v2/api/calendar/calendars');
    assert.equal(options.headers.authorization,'Bearer fixture-expired-access');
    return Response.json({error:'expired'},{status:401});
  }});
  await assert.rejects(services.execute('kakao-calendar','calendars'),error=>{
    assert.equal(error.status,409);assert.match(error.message,/저장소/);return true;
  });
  assert.deepEqual(requests,['https://kapi.kakao.com/v2/api/calendar/calendars'],'refresh endpoint must not be called before a storage destination exists');
  assert.deepEqual(resources,before);
});
