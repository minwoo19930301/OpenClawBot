import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSetupVault } from '../setup-vault.mjs';

test('fresh setup is empty; encrypted Vault survives reopen and retains environment keys', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'setup-vault-'));
  try {
    const env = { GROQ_API_KEY: 'fixture-existing-groq' }, vault = createSetupVault(dir, env);
    assert.equal(vault.name, 'CustomCloudBot');
    assert.equal(createSetupVault(dir).view().providers.length, 0);
    assert.equal(vault.view({configured:true}).setupRequired, false);
    vault.profile({displayName:'My Cloud',cloud:'local'});
    vault.provider({provider:'gemini',apiKey:'fixture-new-gemini'});
    const id = vault.view().providers.find(p=>p.source==='vault').id;
    vault.provider({id,provider:'gemini',apiKey:'',model:'gemini-test'});
    const disk = await readFile(join(dir, 'setup-vault.json'), 'utf8');
    assert.ok(!disk.includes('fixture-new-gemini'));
    assert.ok(!JSON.stringify(vault.view()).includes('fixture-'));
    assert.equal((await stat(join(dir,'setup-vault.json'))).mode & 0o777,0o600);
    assert.equal((await stat(join(dir,'setup-vault.key'))).mode & 0o777,0o600);
    const reopened = createSetupVault(dir,env);
    assert.equal(reopened.name,'My Cloud');
    assert.equal(reopened.runtimeEnv().GROQ_API_KEY,'fixture-existing-groq');
    assert.equal(JSON.parse(reopened.runtimeEnv().COMMUNITY_LLM_PROVIDERS)[0].apiKey,'fixture-new-gemini');
    assert.equal(env.GROQ_API_KEY,'fixture-existing-groq');
    assert.equal(reopened.view().setupRequired,false);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('existing secrets cannot be silently forwarded to a changed endpoint', async () => {
  const dir=await mkdtemp(join(tmpdir(),'setup-vault-'));
  try {
    const vault=createSetupVault(dir,{COMMUNITY_OPENCLAW_BASE_URL:'https://gateway.example',COMMUNITY_OPENCLAW_TOKEN:'fixture-gateway-token-long'});
    vault.provider({provider:'custom',baseUrl:'https://model.example/v1',apiKey:'fixture-key'});
    const id=vault.view().providers[0].id;
    assert.throws(()=>vault.provider({id,provider:'custom',baseUrl:'https://changed.example/v1',apiKey:''}),/새 인증/);
    assert.throws(()=>vault.gateway({baseUrl:'https://changed.example',token:''}),/새 Gateway/);
    assert.throws(()=>vault.provider({provider:'custom',baseUrl:'http://169.254.169.254',apiKey:'fixture'}),/HTTPS/);
    vault.gateway({baseUrl:'https://gateway.example',token:'',agentId:'community'});
    vault.selectBackend('gateway');
    assert.equal(vault.backend,'gateway');
    assert.equal(vault.runtimeEnv().COMMUNITY_OPENCLAW_TOKEN,'fixture-gateway-token-long');
    assert.ok(!JSON.stringify(vault.view()).includes('fixture-gateway'));
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('corrupt or missing encryption key fails closed without replacing saved credentials',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'setup-vault-'));
  try {
    const vault=createSetupVault(dir);vault.provider({provider:'groq',apiKey:'fixture-secret'});
    const before=await readFile(join(dir,'setup-vault.json'));
    await writeFile(join(dir,'setup-vault.key'),Buffer.alloc(32));
    assert.throws(()=>createSetupVault(dir),/함께 복구/);
    assert.deepEqual(await readFile(join(dir,'setup-vault.json')),before);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('the maximum permitted provider slots and key lengths remain readable after restart',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'setup-vault-'));
  try {
    const vault=createSetupVault(dir);
    for(let i=0;i<32;i++) vault.provider({provider:'custom',baseUrl:`https://model-${i}.example/v1`,apiKey:'x'.repeat(8192),model:`model-${i}`});
    const reopened=createSetupVault(dir);
    assert.equal(reopened.view().providers.length,32);
    const providers=JSON.parse(reopened.runtimeEnv().COMMUNITY_LLM_PROVIDERS);
    assert.equal(providers[0].model,'model-0');
    assert.equal(providers[31].model,'model-31');
    assert.throws(()=>vault.provider({provider:'groq',apiKey:'extra-key'}),/32/);
  } finally {await rm(dir,{recursive:true,force:true});}
});
