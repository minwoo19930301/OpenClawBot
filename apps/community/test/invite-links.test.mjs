import test from 'node:test';
import assert from 'node:assert/strict';
import {createInviteLink, createInviteLinks, parseInviteFragment, validInviteToken} from '../public/invite-links.mjs';

const SITE = 'Site_0123456789-abcdefghijklmnopqrstuvwxyz12';
const ROOM = 'Room_0123456789-abcdefghijklmnopqrstuvwxyz12';
function browser(url, saved = new Map(), now = () => 1700000000000) {
  const location = new URL(url), events = [];
  const storage = {
    getItem: key => saved.get(key) ?? null,
    setItem: (key, value) => { events.push('storage'); saved.set(key, value); },
    removeItem: key => saved.delete(key),
  };
  const history = {
    state:{navigation:'existing'},
    replaceState(state, title, href) {
      assert.equal(state, this.state);
      events.push('scrub');
      location.href = new URL(href, location).href;
    },
  };
  return {location, history, storage, now, saved, events};
}

test('sharing uses the current origin and fragment, stripping unrelated paths and query parameters', () => {
  const site = new URL(createInviteLink('site', SITE, 'https://fork.example:8443/settings?room=private#old'));
  assert.equal(site.href, `https://fork.example:8443/#invite=${SITE}`);
  assert.equal(site.search, '');
  assert.deepEqual(parseInviteFragment(site.hash), {kind:'site', token:SITE});
  assert.equal(createInviteLink('room', ROOM, 'http://localhost:8787/'), `http://localhost:8787/#join=${ROOM}`);
  for (const origin of ['javascript:alert(1)', 'file:///app.html', 'https://user:password@example.test/']) assert.throws(() => createInviteLink('site', SITE, origin));
  assert.throws(() => createInviteLink('redirect', SITE, 'https://example.test/'));
});

test('ambiguous, malformed, oversized, and executable invitation inputs are rejected', () => {
  for (const hash of [
    `#invite=${SITE}&join=${ROOM}`, `#invite=${SITE}&invite=${SITE}`, `#invite=${SITE}&next=https://evil.example`,
    '#invite=', '#invite=short', '#invite=%E0%A4%A', '#join=javascript:alert(1)',
    '#join=' + 'A'.repeat(201), '#invite=' + '%41'.repeat(1000), '#section',
  ]) assert.equal(parseInviteFragment(hash), null, hash.slice(0, 100));
  for (const token of [null, 100, ' token01234567890123', '<script>1234567890', 'A'.repeat(201), 'A'.repeat(15)]) {
    assert.equal(validInviteToken(token), false);
    assert.throws(() => createInviteLink('site', token, 'https://example.test/'));
  }
  assert.equal(validInviteToken('A'.repeat(200)), true);
  assert.deepEqual(parseInviteFragment('#%69nvite=' + SITE), {kind:'site', token:SITE});
});

test('boot scrubs the fragment before retaining it and auth/reload does not consume the pending link', () => {
  const env = browser('https://example.test/?room=existing#invite=' + SITE);
  const links = createInviteLinks(env);
  assert.equal(env.location.href, 'https://example.test/?room=existing');
  assert.equal(env.events[0], 'scrub', 'the URL is scrubbed before retaining the token');
  assert.equal(links.get('site'), SITE);
  assert.equal(links.get('site'), SITE, 'reading it for a registration form is not consumption');
  const reloaded = createInviteLinks(browser(env.location.href, env.saved));
  assert.equal(reloaded.get('site'), SITE, 'failed login/registration or reload preserves the invitation');
  reloaded.clear('site');
  assert.equal(createInviteLinks(browser(env.location.href, env.saved)).get('site'), null);
});

test('room and signup links coexist until their corresponding explicit POST succeeds', () => {
  const env = browser('https://example.test/#join=' + ROOM);
  const links = createInviteLinks(env);
  assert.equal(links.get('room'), ROOM);
  env.location.hash = 'invite=' + SITE;
  assert.deepEqual(links.capture(), {kind:'site', token:SITE});
  assert.equal(env.location.hash, '');
  links.clear('site');
  assert.equal(links.get('room'), ROOM, 'registration success must not consume the room invitation');
  assert.equal(links.capture(), null);
  links.clear('room');
  assert.equal(links.get('room'), null);
  assert.equal(env.saved.size, 0);
});

test('invalid invitation links are scrubbed without replacing existing pending links or normal anchors', () => {
  const env = browser('https://example.test/#join=' + ROOM), links = createInviteLinks(env);
  env.location.hash = `invite=${SITE}&join=${ROOM}`;
  assert.equal(links.capture(), null);
  assert.equal(env.location.hash, '');
  assert.equal(links.get('room'), ROOM);
  assert.equal(links.get('site'), null);
  env.location.hash = 'section';
  assert.equal(links.capture(), null);
  assert.equal(env.location.hash, '#section');
});

test('tab retention expires after 24 hours and a reload or duplicate link does not extend it', () => {
  let time = 1700000000000;
  const env = browser('https://example.test/#invite=' + SITE, new Map(), () => time);
  const links = createInviteLinks(env);
  time += 23 * 3600000;
  env.location.hash = 'invite=' + SITE;
  links.capture();
  const reloaded = createInviteLinks(browser(env.location.href, env.saved, () => time));
  assert.equal(reloaded.get('site'), SITE);
  time += 3600000;
  assert.equal(reloaded.get('site'), null);
  assert.equal(links.get('site'), null);
  assert.equal(env.saved.size, 0);
});

test('blocked storage retains the invitation in memory; history failure never retains a new one', () => {
  const env = browser('https://example.test/#join=' + ROOM);
  env.storage = new Proxy({}, {get() { throw new Error('storage blocked'); }});
  const links = createInviteLinks(env);
  assert.equal(env.location.hash, '');
  assert.equal(links.get('room'), ROOM);
  links.clear('room');
  assert.equal(links.get('room'), null);
  const failed = browser('https://example.test/#join=' + ROOM);
  failed.history.replaceState = () => { throw new Error('history blocked'); };
  assert.equal(createInviteLinks(failed).get('room'), null);
  assert.equal(failed.saved.size, 0);
});

test('corrupt or implausibly long-lived stored invitations cannot survive restore', () => {
  const key = 'community-pending-invites:v1', time = 1700000000000;
  for (const value of ['not json', JSON.stringify({version:2, site:{token:SITE, expiresAt:time+1000}}),
    JSON.stringify({version:1, site:{token:SITE, expiresAt:time+25*3600000}}),
    JSON.stringify({version:1, site:{token:SITE, expiresAt:time-1}}),
    JSON.stringify({version:1, room:{token:'<script>', expiresAt:time+1000}}), ' '.repeat(2000)]) {
    const env = browser('https://example.test/', new Map([[key, value]]), () => time);
    const links = createInviteLinks(env);
    assert.equal(links.get('site'), null);
    assert.equal(links.get('room'), null);
    assert.equal(env.saved.size, 0);
  }
});
