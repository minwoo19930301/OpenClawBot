const KINDS = Object.freeze({site: 'invite', room: 'join'});
const STORAGE_KEY = 'community-pending-invites:v1';
const MAX_AGE = 24 * 60 * 60 * 1000;
const MAX_FRAGMENT_LENGTH = 2048;
const TOKEN = /^[A-Za-z0-9_-]{16,200}$/;

export const validInviteToken = value => typeof value === 'string' && TOKEN.test(value);

function requireKind(kind) {
  if (!Object.hasOwn(KINDS, kind)) throw new TypeError('Unknown invitation kind');
}

function fragmentInfo(hash) {
  if (typeof hash !== 'string') return {recognized:false, invite:null};
  const value = hash.startsWith('#') ? hash.slice(1) : hash;
  const params = new URLSearchParams(value.slice(0, MAX_FRAGMENT_LENGTH + 1));
  const recognized = params.has('invite') || params.has('join');
  if (!recognized || value.length > MAX_FRAGMENT_LENGTH || [...params].length !== 1) return {recognized, invite:null};
  const kind = params.has('invite') ? 'site' : 'room';
  const token = params.get(KINDS[kind]);
  return {recognized, invite:validInviteToken(token) ? {kind, token} : null};
}

export function parseInviteFragment(hash) {
  return fragmentInfo(hash).invite;
}

/** Always link to the current origin's app root, without query strings or userinfo. */
export function createInviteLink(kind, token, href = globalThis.window?.location?.href) {
  requireKind(kind);
  if (!validInviteToken(token)) throw new TypeError('Invalid invitation token');
  const current = new URL(href);
  if (!['https:', 'http:'].includes(current.protocol) || current.username || current.password) throw new TypeError('Invalid invitation origin');
  const link = new URL('/', current.origin);
  link.hash = KINDS[kind] + '=' + token;
  return link.href;
}

/**
 * Capture and scrub before the caller starts session/API requests. This controller
 * performs no network requests or membership changes. Clear only after a successful
 * registration/join POST (or an explicit discard), never merely after reading it.
 */
export function createInviteLinks(options = {}) {
  const location = options.location ?? globalThis.window?.location;
  const history = options.history ?? globalThis.window?.history;
  const now = options.now ?? Date.now;
  let storage = options.storage;
  if (!Object.hasOwn(options, 'storage')) {
    try { storage = globalThis.window?.sessionStorage; } catch { /* In-memory fallback. */ }
  }
  const pending = {site:null, room:null};
  function clock() {
    const value = Number(now());
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Invalid invitation clock');
    return value;
  }
  function persist() {
    try {
      if (pending.site || pending.room) storage?.setItem(STORAGE_KEY, JSON.stringify({version:1, ...pending}));
      else storage?.removeItem(STORAGE_KEY);
    } catch { /* The current tab still retains its pending invitation in memory. */ }
  }
  function get(kind) {
    requireKind(kind);
    const entry = pending[kind];
    if (entry && entry.expiresAt <= clock()) { pending[kind] = null; persist(); }
    return pending[kind]?.token ?? null;
  }
  function clear(kind) {
    requireKind(kind);
    pending[kind] = null;
    persist();
  }
  function capture() {
    const {recognized, invite} = fragmentInfo(location?.hash);
    if (!recognized) return null;
    // Remove even malformed invitation fragments; never navigate or reload.
    try {
      const clean = new URL(location.href);
      clean.hash = '';
      history.replaceState(history.state, '', clean.pathname + clean.search);
    } catch { return null; }
    if (!invite) return null;
    const previous = pending[invite.kind];
    // Re-opening the same link must not extend the local retention deadline.
    if (previous?.token !== invite.token || previous.expiresAt <= clock()) {
      pending[invite.kind] = {token:invite.token, expiresAt:clock() + MAX_AGE};
    }
    persist();
    return {...invite};
  }
  try {
    const serialized = storage?.getItem(STORAGE_KEY);
    const saved = typeof serialized === 'string' && serialized.length <= 1024 ? JSON.parse(serialized) : null;
    if (saved?.version === 1) for (const kind of Object.keys(KINDS)) {
      const entry = saved[kind], time = clock();
      if (validInviteToken(entry?.token) && Number.isSafeInteger(entry.expiresAt) && entry.expiresAt > time && entry.expiresAt <= time + MAX_AGE) {
        pending[kind] = {token:entry.token, expiresAt:entry.expiresAt};
      }
    }
  } catch { /* Ignore invalid/unavailable tab storage. */ }
  if (!capture()) persist();
  return {capture, get, clear};
}
