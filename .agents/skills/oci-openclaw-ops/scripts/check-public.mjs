#!/usr/bin/env node
import assert from 'node:assert/strict';
const [site, expectedRelease] = process.argv.slice(2);
if (!site) throw new Error('Usage: check-public.mjs https://site.example [expected-git-sha]');
const origin = new URL(site);
assert.equal(origin.protocol, 'https:', 'Use the public HTTPS origin');
assert.ok(!origin.username && !origin.password && !origin.search && !origin.hash && origin.pathname === '/', 'Pass an origin without credentials or a path');
async function get(path) {
  const response = await fetch(new URL(path, origin), {redirect:'error', signal:AbortSignal.timeout(15000)});
  assert.equal(response.status, 200, `${path}: HTTP ${response.status}`);
  return response;
}
const [health, session, manifest, worker] = await Promise.all([
  get('/api/health').then(r=>r.json()),
  get('/api/session').then(r=>r.json()),
  get('/manifest.webmanifest').then(r=>r.json()),
  get('/sw.js').then(async r=>({type:r.headers.get('content-type'),text:await r.text()})),
]);
assert.equal(health.ok, true);
assert.ok(health.release && health.release !== 'development', 'Missing production release');
if (expectedRelease) assert.equal(health.release, expectedRelease);
assert.equal(session.user, null, 'Public check must not be authenticated');
assert.equal(session.model?.configured, true);
assert.equal(session.model?.backend, 'openclaw');
assert.equal(manifest.name, 'OpenClawBot');
assert.equal(manifest.start_url, '/');
assert.equal(manifest.scope, '/');
assert.match(worker.type || '', /javascript/);
assert.ok(worker.text.includes('push'), 'Push service worker missing');
console.log(JSON.stringify({origin:origin.origin,release:health.release,backend:session.model.backend,pwa:manifest.name,verified:'public HTTPS/configuration only'}, null, 2));
