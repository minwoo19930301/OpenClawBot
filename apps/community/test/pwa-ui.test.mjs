import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { installationHelp } from '../public/pwa.js';

const source = readFileSync(new URL('../public/pwa.js', import.meta.url), 'utf8').replaceAll('export function ', 'function ');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
function setup({ supported = false, api, requestPermission } = {}) {
  const nodes = new Map();
  for (const id of ['install-button', 'auth-install-button', 'push-button', 'test-push-button', 'push-status', 'pwa-dialog', 'pwa-dialog-title', 'pwa-dialog-message']) {
    const classes = new Set(['is-hidden']);
    nodes.set(id, { textContent: '', handlers: {}, classList: { remove(k) { classes.delete(k); }, toggle(k, on) { on ? classes.add(k) : classes.delete(k); }, contains(k) { return classes.has(k); } }, addEventListener(k, fn) { this.handlers[k] = fn; }, removeEventListener(k) { delete this.handlers[k]; }, showModal() { this.open = true; }, close() { this.open = false; } });
  }
  let session = null;
  const calls = [];
  let subscribed = 0;
  const registration = { pushManager: { getSubscription: async () => null, subscribe: async () => { subscribed++; return { toJSON: () => ({}), unsubscribe: async () => {}, endpoint: 'https://push.example/sub' }; } } };
  const navigator = { userAgent: 'Chrome/140', platform: 'Linux', maxTouchPoints: 0 };
  const window = { handlers: {}, isSecureContext: true, matchMedia: () => ({ matches: false }), addEventListener(k, fn) { this.handlers[k] = fn; }, removeEventListener(k) { delete this.handlers[k]; } };
  const Notification = { permission: 'default', requestPermission: requestPermission || (async () => { throw Error('unsolicited permission'); }) };
  if (supported) { navigator.serviceWorker = { register: async () => registration, ready: Promise.resolve(registration) }; window.PushManager = {}; window.Notification = Notification; }
  const context = { navigator, window, Notification, document: { querySelector: (selector) => nodes.get(selector.slice(1)) }, Uint8Array, atob: (v) => Buffer.from(v, 'base64').toString('binary') };
  vm.runInNewContext(source + '\nthis.createPwaController = createPwaController;', context);
  const controller = context.createPwaController({ api: async (...args) => { calls.push(args); return api ? api(...args) : { configured: true, publicKey: 'AQID' }; }, getSession: () => session, toast() {} });
  return { nodes, window, calls, controller, get subscribed() { return subscribed; }, setSession(id) { session = id ? { user: { id } } : null; controller.setSession(session); } };
}

test('install action stays visible without beforeinstallprompt and gives honest browser instructions', async () => {
  const app = setup();
  for (const id of ['install-button', 'auth-install-button']) assert.equal(app.nodes.get(id).classList.contains('is-hidden'), false);
  await app.nodes.get('install-button').handlers.click();
  assert.equal(app.nodes.get('pwa-dialog').open, true);
  assert.match(app.nodes.get('pwa-dialog-message').textContent, /Chrome 메뉴/);
  assert.match(installationHelp({ userAgent: 'iPhone' }).message, /홈 화면/);
  assert.match(installationHelp({ userAgent: 'Safari', platform: 'MacIntel' }).message, /Sonoma 14/);
  assert.match(installationHelp({ userAgent: 'Firefox' }).message, /직접 열 수 없어요/);
  assert.equal(app.calls.length, 0);
});

test('install prompt only runs on click once and dismissal keeps the help button', async () => {
  const app = setup();
  let prompts = 0;
  app.window.handlers.beforeinstallprompt({ preventDefault() {}, prompt: async () => { prompts++; }, userChoice: Promise.resolve({ outcome: 'dismissed' }) });
  assert.equal(prompts, 0);
  await app.nodes.get('install-button').handlers.click();
  assert.equal(prompts, 1);
  assert.equal(app.nodes.get('install-button').textContent, '앱으로 만들기');
  await app.nodes.get('install-button').handlers.click();
  assert.equal(prompts, 1);
  app.window.handlers.appinstalled();
  assert.equal(app.nodes.get('install-button').textContent, '앱 설치됨');
});

test('stale config and permission responses cannot subscribe after account change', async () => {
  const first = deferred();
  let configs = 0;
  const app = setup({ supported: true, api: async () => ++configs === 1 ? first.promise : { configured: false } });
  app.setSession('one');
  app.setSession('two');
  await tick();
  first.resolve({ configured: true, publicKey: 'AQID' });
  await tick();
  await app.nodes.get('push-button').handlers.click();
  assert.equal(app.subscribed, 0);
  assert.equal(app.calls.some(([path]) => path === '/api/push/subscriptions'), false);
  const permission = deferred();
  const pending = setup({ supported: true, requestPermission: () => permission.promise });
  pending.setSession('one');
  await tick();
  const enable = pending.nodes.get('push-button').handlers.click();
  pending.setSession(null);
  permission.resolve('granted');
  await enable;
  assert.equal(pending.subscribed, 0);
  assert.equal(pending.calls.some(([path]) => path === '/api/push/subscriptions'), false);
});

test('unsupported browser retains notification guidance without sending a test push', async () => {
  const app = setup();
  app.setSession('one');
  assert.equal(app.nodes.get('push-button').classList.contains('is-hidden'), false);
  assert.equal(app.nodes.get('test-push-button').classList.contains('is-hidden'), true);
  await app.nodes.get('push-button').handlers.click();
  assert.match(app.nodes.get('pwa-dialog-message').textContent, /앱 안의 알림함/);
  assert.equal(app.calls.length, 0);
});
