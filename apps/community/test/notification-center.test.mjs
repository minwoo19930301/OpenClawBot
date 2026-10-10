import test from 'node:test';
import assert from 'node:assert/strict';
import { createNotificationStore, createNotificationCenter } from '../public/notification-center.js';

const roomId = '12345678-1234-4234-8234-123456789012';
const user = (id) => ({ user: { id } });
const message = (id, at, options = {}) => ({ id, createdAt: at, kind: 'bot', text: `answer ${id}`, ...options });
const data = (messages, progress = []) => ({ room: { id: roomId, name: 'Private room' }, messages, progress });

test('initial snapshots and older history do not notify; new replies deduplicate', () => {
  const store = createNotificationStore();
  store.setSession(user('one'));
  store.observeRoom(data([message('old', 10)]), { userId: 'one' });
  assert.equal(store.snapshot().unread, 0);
  const next = data([message('older', 5), message('old', 10), message('self', 12, { kind: 'human', authorId: 'one' }), message('reply', 13)]);
  store.observeRoom(next, { userId: 'one' });
  store.observeRoom(next, { userId: 'one' });
  assert.equal(store.snapshot().unread, 1);
  assert.equal(store.snapshot().items[0].text, 'answer reply');
  store.markRoomRead(roomId);
  assert.equal(store.snapshot().unread, 0);
});

test('logout and account switches clear private data and reject stale responses', () => {
  const store = createNotificationStore();
  store.setSession(user('one'));
  store.observeRoom(data([]), { userId: 'one' });
  store.observeRoom(data([message('new', 1)]), { userId: 'one' });
  store.setSession(user('two'));
  store.observeRoom(data([message('leak', 2)]), { userId: 'one' });
  assert.deepEqual(store.snapshot().items, []);
  store.observeRoom(data([]), { userId: 'two' });
  store.observeRoom(data([message('two', 3)]), { userId: 'two' });
  assert.equal(store.snapshot().unread, 1);
  store.reset();
  assert.deepEqual(store.snapshot(), { userId: null, items: [], unread: 0 });
});

test('progress must have room baseline; history and active steps do not create fake notifications', () => {
  const store = createNotificationStore();
  store.setSession(user('one'));
  const event = { stage: 'error', label: 'Could not complete', at: 10 };
  store.observeProgress(roomId, event, { userId: 'one' });
  store.observeRoom(data([], [event]), { userId: 'one' });
  store.observeProgress(roomId, event, { userId: 'one' });
  store.observeProgress(roomId, { stage: 'thinking', label: 'Working', at: 11 }, { userId: 'one' });
  assert.equal(store.snapshot().unread, 0);
  store.observeProgress(roomId, { ...event, at: 20 }, { userId: 'one' });
  store.observeProgress(roomId, { ...event, at: 20 }, { userId: 'one' });
  store.observeRoom(data([message('system', 21, { kind: 'system' })]), { userId: 'one' });
  assert.equal(store.snapshot().unread, 1);
});

test('bounded history and mark-all; malformed room ids cannot become navigation targets', () => {
  const store = createNotificationStore();
  store.setSession(user('one'));
  store.observeRoom({ room: { id: 'javascript:alert(1)' }, messages: [] }, { userId: 'one' });
  store.observeRoom(data([]), { userId: 'one' });
  store.observeRoom(data(Array.from({ length: 70 }, (_, i) => message(String(i), i + 1))), { userId: 'one' });
  assert.equal(store.snapshot().items.length, 50);
  store.markAllRead();
  assert.equal(store.snapshot().unread, 0);
});

class Element {
  constructor(doc, tag) { this.ownerDocument = doc; this.tagName = tag; this.children = []; this.dataset = {}; this.attrs = {}; this.handlers = {}; this.scrollTop = 0; this.textContent = ''; this.classList = { add() {} }; }
  append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(k, fn) { this.handlers[k] = fn; }
  removeEventListener(k) { delete this.handlers[k]; }
  focus() { this.ownerDocument.activeElement = this; }
  contains(node) { return node === this || this.children.some((child) => child.contains(node)); }
}
test('popup supports Escape and removes rendered private previews on logout', () => {
  const doc = { handlers: {}, createElement(tag) { return new Element(this, tag); }, createElementNS(_ns, tag) { return this.createElement(tag); }, addEventListener(k, fn) { this.handlers[k] = fn; }, removeEventListener(k) { delete this.handlers[k]; } };
  const mount = doc.createElement('div');
  const ui = createNotificationCenter({ mount, openRoom: async () => {} });
  ui.setSession(user('one'));
  ui.observeRoom(data([]), { userId: 'one' });
  ui.observeRoom(data([message('new', 1)]), { userId: 'one' });
  const [bell, panel] = mount.children;
  bell.handlers.click();
  assert.equal(panel.hidden, false);
  assert.equal(panel.children[3].children.length, 1);
  doc.handlers.keydown({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
  assert.equal(panel.hidden, true);
  assert.equal(doc.activeElement, bell);
  ui.reset();
  assert.equal(panel.children[3].children.length, 0);
  assert.equal(mount.hidden, true);
  ui.destroy();
  assert.equal(Object.keys(doc.handlers).length, 0);
});
