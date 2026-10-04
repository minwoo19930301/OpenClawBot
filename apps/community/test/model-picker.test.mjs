import test from 'node:test';import assert from 'node:assert/strict';
import {recommendedModels,filterModels,modelLabel} from '../public/model-picker.mjs';
const model=(id,providers=['groq'])=>({id,value:id,name:id,providers});
test('recommendations stay within live catalog, bounded and prefer useful distinct families',()=>{
 const catalog=[model('unused-preview'),model('gemini-3.8-flash',['gemini']),model('openai/gpt-oss-120b'),model('openai/gpt-oss-20b'),model('command-a-03-2025',['cohere']),...Array.from({length:100},(_,i)=>model('other-'+i))];
 const picks=recommendedModels(catalog);assert.equal(picks.length,5);assert.equal(new Set(picks).size,5);assert.equal(picks[0].id,'gemini-3.8-flash');assert.ok(picks.every(p=>catalog.includes(p)));assert.ok(!picks.some(p=>p.id==='unused-preview'));
 assert.deepEqual(recommendedModels([]),[]);
});
test('full model search matches all query terms across ID and providers without altering catalog',()=>{
 const catalog=[model('openai/gpt-oss-120b',['groq','huggingface']),model('gemini-3.8-flash',['gemini'])];
 assert.deepEqual(filterModels(catalog,' GROQ 120B '),[catalog[0]]);assert.deepEqual(filterModels(catalog,'missing'),[]);assert.equal(filterModels(catalog,'').length,2);assert.equal(modelLabel(catalog[1]),'Gemini 3.8 Flash');
});

import {safeLink} from '../public/message-format.mjs';
test('message links never enable scripts, data URLs or embedded credentials',()=>{
 for(const url of ['javascript:alert(1)','data:text/html,test','https://user:password@example.com','//example.com'])assert.equal(safeLink(url),null);
 assert.equal(safeLink('https://example.com/docs'),'https://example.com/docs');
});
