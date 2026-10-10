import test from 'node:test';
import assert from 'node:assert/strict';
import {request} from 'node:http';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startCommunity} from '../server.mjs';

// Use HTTP directly: fetch implementations may rewrite Sec-Fetch-Mode to cors.
function http(url, {method = 'GET', headers = {}} = {}) {
  return new Promise((resolve, reject) => {
    const req = request(url, {method, headers, agent:false}, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({status:res.statusCode, headers:res.headers, body:Buffer.concat(chunks).toString()}));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

test('webmail invitation navigation can load only the public top-level app document', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'invite-navigation-'));
  const app = await startCommunity({dataDir, port:0, env:{}});
  t.after(async () => { await app.close(); await rm(dataDir, {recursive:true, force:true}); });
  const navigation = {'sec-fetch-site':'cross-site', 'sec-fetch-mode':'navigate', 'sec-fetch-dest':'document'};
  for (const method of ['GET', 'HEAD']) {
    // Browsers omit the invitation fragment from this HTTP request.
    const response = await http(app.url + '/', {method, headers:navigation});
    assert.equal(response.status, 200, method);
    assert.match(response.headers['content-type'], /^text\/html/);
    assert.equal(response.headers['referrer-policy'], 'no-referrer');
    if (method === 'GET') assert.match(response.body, /id="register-form"/);
    else assert.equal(response.body, '');
  }
  assert.equal((await http(app.url + '/api/session')).status, 200, 'normal session checks remain available');
  const blocked = [
    ['/api/session', 'GET', navigation],
    ['/api/health', 'HEAD', navigation],
    ['/app.js', 'GET', navigation],
    ['/', 'POST', navigation],
    ['/api/rooms/join', 'POST', navigation],
    ['/api/register', 'POST', navigation],
    ['/', 'GET', {...navigation, 'sec-fetch-dest':'iframe'}],
    ['/', 'GET', {...navigation, 'sec-fetch-dest':'frame'}],
    ['/', 'GET', {...navigation, 'sec-fetch-dest':'script'}],
    ['/', 'GET', {...navigation, 'sec-fetch-mode':'cors'}],
    ['/', 'GET', {...navigation, 'sec-fetch-mode':'no-cors'}],
    ['/', 'GET', {'sec-fetch-site':'cross-site'}],
    ['/', 'GET', {...navigation, origin:'https://untrusted.example'}],
    ['/', 'HEAD', {...navigation, origin:'https://untrusted.example'}],
  ];
  for (const [path, method, headers] of blocked) {
    const response = await http(app.url + path, {method, headers});
    assert.equal(response.status, 403, JSON.stringify({path, method, headers}));
  }
});
