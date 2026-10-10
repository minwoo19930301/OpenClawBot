import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {startCommunity} from '../server.mjs';

test('agent videos support browser byte ranges and HEAD without exposing other files',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'agent-media-'));
  const app=await startCommunity({dataDir:dir,port:0,env:{}});
  try {
    const expected=await readFile(new URL('../public/media/agent/idle.mp4',import.meta.url));
    const url=app.url+'/media/agent/idle.mp4';
    const full=await fetch(url);
    assert.equal(full.status,200);
    assert.equal(full.headers.get('content-type'),'video/mp4');
    assert.equal(full.headers.get('accept-ranges'),'bytes');
    assert.deepEqual(Buffer.from(await full.arrayBuffer()),expected);
    const head=await fetch(url,{method:'HEAD'});
    assert.equal(head.status,200);
    assert.equal(Number(head.headers.get('content-length')),expected.length);
    assert.equal((await head.arrayBuffer()).byteLength,0);
    for(const [range,start,end] of [['bytes=0-99',0,99],['bytes=-10',expected.length-10,expected.length-1],['bytes=100-',100,expected.length-1]]) {
      const part=await fetch(url,{headers:{range}});
      assert.equal(part.status,206);
      assert.equal(part.headers.get('content-range'),`bytes ${start}-${end}/${expected.length}`);
      assert.deepEqual(Buffer.from(await part.arrayBuffer()),expected.subarray(start,end+1));
    }
    for(const range of ['bytes=999999999-','bytes=4-2','bytes=-0','bytes=-','bytes=0-1,2-3','items=0-1']) {
      const result=await fetch(url,{headers:{range}});
      assert.equal(result.status,416);
      assert.equal(result.headers.get('content-range'),`bytes */${expected.length}`);
    }
    assert.equal((await fetch(app.url+'/media/agent/unknown.mp4')).status,404);
    assert.equal((await fetch(app.url+'/media/agent/%2e%2e%2f%2e%2e%2fserver.mjs')).status,404);
    assert.equal((await fetch(app.url+'/media/agent/idle-poster.jpg')).headers.get('content-type'),'image/jpeg');
  } finally {await app.close();await rm(dir,{recursive:true,force:true});}
});
