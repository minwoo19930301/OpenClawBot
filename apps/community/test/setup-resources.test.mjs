import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSetupVault } from '../setup-vault.mjs';
import { readProviders } from '../providers.mjs';

test('resource collections remain encrypted and return only explicit metadata across restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vault-resources-'));
  try {
    const vault = createSetupVault(dir);
    vault.profile({displayName:'Preserved bot', cloud:'local'});
    vault.provider({provider:'groq',apiKey:'fixture-ui-secret'});
    const values = {
      NAVER_MAIL_PASSWORD:'fixture-mail-secret', OCI_PRIVATE_KEY:'fixture-pem\nsecond line',
      CLOUDFLARE_API_TOKEN:'fixture-cloud-secret', UNKNOWN_ACCOUNT_SECRET:'fixture-other-secret',
      EMPTY_KEY:'', GROQ_API_KEY:'fixture-imported-secret',
    };
    assert.deepEqual(vault.importResources({source:'imported-env',values}), {source:'imported-env',count:6,imported:6});
    const saved = await readFile(join(dir, 'setup-vault.json'), 'utf8');
    const publicView = JSON.stringify(vault.view());
    for (const value of Object.values(values).filter(Boolean)) {
      assert.ok(!saved.includes(value), 'resource value must not be plaintext on disk');
      assert.ok(!publicView.includes(value), 'resource value must not enter public setup metadata');
    }
    assert.ok(!saved.includes('NAVER_MAIL_PASSWORD'), 'credential variable names are encrypted on disk too');
    const reopened = createSetupVault(dir);
    assert.deepEqual(reopened.resourceEnv(),values);
    assert.equal(reopened.name,'Preserved bot');
    assert.ok(reopened.runtimeEnv().COMMUNITY_LLM_PROVIDERS.includes('fixture-ui-secret'));
    assert.deepEqual(reopened.view().resources.find(item=>item.name==='NAVER_MAIL_PASSWORD'), {
      name:'NAVER_MAIL_PASSWORD',hasValue:true,source:'imported-env',category:'mail',
    });
    assert.equal(reopened.view().resources.find(item=>item.name==='EMPTY_KEY').hasValue,false);
    for (const item of reopened.view().resources) assert.deepEqual(Object.keys(item).sort(),['category','hasValue','name','source']);
    for (const file of ['setup-vault.json','setup-vault.key']) assert.equal((await stat(join(dir,file))).mode&0o777,0o600);
    const detached = reopened.resourceEnv(); detached.GROQ_API_KEY='mutated';
    assert.equal(reopened.resourceEnv().GROQ_API_KEY,'fixture-imported-secret');
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('only parsed AI connections join the runtime and existing credentials remain intact without duplicate slots', async () => {
  const dir = await mkdtemp(join(tmpdir(),'vault-runtime-'));
  try {
    const env = {GROQ_API_KEY:'fixture-existing-secret',NODE_OPTIONS:'--existing-option'};
    const vault = createSetupVault(dir,env);
    vault.importResources({source:'imported-env',values:{
      GROQ_API_KEY:'fixture-existing-secret',GROQ_API_KEY_2:'fixture-extra-secret',GROQ_MODEL_2:'fixture-model',
      HUGGINGFACE_TOKEN:'fixture-hf-secret',OCI_PRIVATE_KEY:'fixture-infra-secret',
      NODE_OPTIONS:'--require malicious-fixture',COMMUNITY_OPENCLAW_BASE_URL:'https://unselected.example',
      COMMUNITY_OPENCLAW_TOKEN:'fixture-imported-gateway-token',
    }});
    const runtime=vault.runtimeEnv(), providers=readProviders(runtime);
    assert.equal(runtime.GROQ_API_KEY,env.GROQ_API_KEY);
    assert.equal(runtime.NODE_OPTIONS,'--existing-option');
    assert.equal(runtime.OCI_PRIVATE_KEY,undefined);
    assert.equal(runtime.COMMUNITY_OPENCLAW_BASE_URL,undefined);
    assert.equal(runtime.COMMUNITY_OPENCLAW_TOKEN,undefined);
    assert.deepEqual(providers.map(p=>p.apiKey).sort(),['fixture-existing-secret','fixture-extra-secret','fixture-hf-secret'].sort());
    assert.equal(providers.find(p=>p.apiKey==='fixture-extra-secret').model,'fixture-model');
    assert.equal(JSON.parse(runtime.COMMUNITY_LLM_PROVIDERS).length,2,'existing env slot must not be duplicated in added providers');
    assert.deepEqual(env,{GROQ_API_KEY:'fixture-existing-secret',NODE_OPTIONS:'--existing-option'});
    assert.equal(vault.view().providers.find(p=>p.model==='fixture-model').source,'imported');
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('imports preserve omitted keys, repeat idempotently and reject conflicting snapshots atomically', async () => {
  const dir = await mkdtemp(join(tmpdir(),'vault-conflict-'));
  try {
    const vault = createSetupVault(dir);
    vault.importResources({source:'imported-env',values:{PRIVATE_KEY:'fixture-original',OTHER:'fixture-retained'}});
    const before = await readFile(join(dir,'setup-vault.json'));
    vault.importResources({source:'imported-env',values:{PRIVATE_KEY:'fixture-original'}});
    assert.deepEqual(await readFile(join(dir,'setup-vault.json')),before,'reimport must not rewrite the encrypted snapshot');
    for (const source of ['imported-env','other-source']) {
      assert.throws(()=>vault.importResources({source,values:{PRIVATE_KEY:'fixture-replacement',NEW:'fixture-new'}}),error=>{
        assert.equal(error.status,409); assert.deepEqual(error.conflicts,['PRIVATE_KEY']);
        assert.ok(!error.message.includes('fixture-')); return true;
      });
      assert.deepEqual(await readFile(join(dir,'setup-vault.json')),before);
    }
    assert.deepEqual(vault.resourceEnv(),{PRIVATE_KEY:'fixture-original',OTHER:'fixture-retained'});
    vault.importResources({source:'second-file',values:{EXTRA:'fixture-extra'}});
    assert.equal(createSetupVault(dir).resourceEnv().EXTRA,'fixture-extra');
    assert.equal(vault.resourceEnv().OTHER,'fixture-retained');
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('invalid collections cannot inject prototypes or partially change the vault', async () => {
  const dir = await mkdtemp(join(tmpdir(),'vault-input-'));
  try {
    const vault = createSetupVault(dir);
    for (const values of [null,[],{GOOD:'x',BAD:4},{'INVALID NAME':'x'},JSON.parse('{"__proto__":"unsafe"}'),{SECRET:'x\0y'},{SECRET:'x'.repeat(131073)}]) {
      assert.throws(()=>vault.importResources({source:'imported-env',values}),{status:400});
      assert.deepEqual(vault.resourceEnv(),{});
    }
    assert.throws(()=>vault.importResources({source:'<unsafe>',values:{SECRET:'x'}}),{status:400});
    assert.equal({}.unsafe,undefined);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('adding a key beyond a full collection is rejected atomically and leaves the vault readable',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'vault-merged-limit-'));
  try {
    const vault=createSetupVault(dir);
    const values=Object.fromEntries(Array.from({length:2048},(_,index)=>['KEY_'+index,'fixture-value-'+index]));
    vault.importResources({source:'imported-env',values});
    const before=await readFile(join(dir,'setup-vault.json'));
    assert.throws(()=>vault.importResources({source:'imported-env',values:{EXTRA_KEY:'fixture-over-limit'}}),{status:400});
    assert.deepEqual(await readFile(join(dir,'setup-vault.json')),before,'a failed merge must not write an unreadable snapshot');
    assert.deepEqual(vault.resourceEnv(),values,'a failed merge must not modify in-memory resources');
    const reopened=createSetupVault(dir);
    assert.deepEqual(reopened.resourceEnv(),values);
    assert.equal(reopened.view().resources.length,2048);
    assert.deepEqual(reopened.importResources({source:'imported-env',values:{KEY_0:'fixture-value-0'}}),{source:'imported-env',count:2048,imported:1});
    assert.deepEqual(await readFile(join(dir,'setup-vault.json')),before);
  } finally {await rm(dir,{recursive:true,force:true});}
});
