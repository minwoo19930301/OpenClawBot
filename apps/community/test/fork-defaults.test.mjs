import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadOperatorContext} from '../operator-context.mjs';
import {createProviderPool} from '../providers.mjs';
import {createOpenClawFromEnv} from '../lib/backend/openclaw-http.mjs';
import {createIntegrations} from '../integrations.mjs';
import {parseDesktops} from '../desktop.mjs';

test('a fresh fork has no provider, gateway, computer, or connected account',async()=>{
  assert.equal(createProviderPool({}).configured,false);
  assert.equal(createOpenClawFromEnv({}),null);
  assert.equal(parseDesktops().size,0);
  const path=new URL('../integrations.example.json',import.meta.url);
  const example=JSON.parse(await readFile(path,'utf8'));
  assert.ok(Object.keys(example).length>0);
  assert.ok(Object.values(example).every(value=>value===''));
  assert.ok((await createIntegrations({path}).list()).every(service=>!service.configured));
  assert.equal(await loadOperatorContext(), '');
  assert.equal(await loadOperatorContext(''), '');
});

test('operator context is explicit, bounded, and does not disclose private paths on errors',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'operator-context-'));
  const path=join(dir,'private-context.txt');
  try {
    await writeFile(path,'private fixture');
    assert.equal(await loadOperatorContext(path),'private fixture');
    await assert.rejects(loadOperatorContext('BUSINESS_CONTEXT.md'),/absolute private file path/);
    for(const invalid of [dir,join(dir,'missing')]) {
      await assert.rejects(loadOperatorContext(invalid),error=>
        /Unable to load operator context/.test(error.message)&&!error.message.includes(dir));
    }
    await writeFile(path,Buffer.alloc(65536,65));
    assert.equal((await loadOperatorContext(path)).length,65536);
    await writeFile(path,Buffer.alloc(65537,65));
    await assert.rejects(loadOperatorContext(path),/at most 64 KiB/);
  } finally {await rm(dir,{recursive:true,force:true});}
});
