import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeBotOutput} from '../model-output.mjs';

test('bare and prefixed model envelopes become readable chat text', () => {
  for (const value of ['hello', '{"type":"text","content":"hello"}', 'SendMessage: {"type":"text","content":"hello"}']) {
    assert.deepEqual(JSON.parse(normalizeBotOutput(value).slice(12)), {type:'text',content:'hello'});
  }
  const jsonAnswer='{"temperature":24}';
  assert.equal(JSON.parse(normalizeBotOutput(jsonAnswer).slice(12)).content,jsonAnswer);
});

test('long structured replies stay valid JSON after bounding content', () => {
  const result=normalizeBotOutput('SendMessage: '+JSON.stringify({type:'text',content:'"'.repeat(9000)}));
  assert.equal(JSON.parse(result.slice(12)).content.length,4000);
});
