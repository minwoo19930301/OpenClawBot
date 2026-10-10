const roomPattern = /^[a-f0-9-]{36}$/i;
const clean = (value, max = 180) => typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";

// Intentionally memory-only: account changes and logout discard private previews.
export function createNotificationStore() {
  let userId = null;
  let items = [];
  const rooms = new Map();
  const matches = (options) => Boolean(userId && options?.userId === userId);
  const add = (item) => {
    if (items.some((entry) => entry.id === item.id)) return false;
    items = [{ ...item, read: false }, ...items].slice(0, 50);
    return true;
  };
  const progress = (roomId, event, options) => {
    const room = rooms.get(roomId);
    if (!matches(options) || !room || !Number.isFinite(event?.at)) return false;
    const key = `${event.stage}:${event.at}:${clean(event.label)}`;
    if (room.progress.has(key)) return false;
    room.progress.add(key);
    if (room.progress.size > 100) room.progress.delete(room.progress.values().next().value);
    const old = event.at < room.progressAt;
    room.progressAt = Math.max(room.progressAt, event.at);
    if (old || event.stage !== "error") return false;
    if (items.some((item) => item.roomId === roomId && item.kind === "system" && Math.abs(item.at - event.at) < 5000)) return false;
    return add({ id: `progress:${roomId}:${event.at}`, roomId, roomName: room.name, kind: "error", title: "작업을 완료하지 못했어요", text: clean(event.label) || "대화에서 작업 상태를 확인해주세요.", at: event.at });
  };
  return {
    setSession(session) {
      const nextId = session?.user?.id || null;
      if (nextId === userId) return;
      userId = nextId;
      items = [];
      rooms.clear();
    },
    reset() { userId = null; items = []; rooms.clear(); },
    snapshot() { return { userId, items: items.map((item) => ({ ...item })), unread: items.filter((item) => !item.read).length }; },
    markAllRead() { items.forEach((item) => { item.read = true; }); },
    markRoomRead(id) { items.forEach((item) => { if (item.roomId === id) item.read = true; }); },
    forgetRoom(id) { rooms.delete(id); items = items.filter((item) => item.roomId !== id); },
    observeProgress: progress,
    observeRoom(data, options) {
      const id = data?.room?.id;
      if (!matches(options) || !roomPattern.test(id || "") || !Array.isArray(data.messages)) return false;
      const messages = data.messages.filter((message) => typeof message.id === "string" && message.id.length <= 120 && Number.isFinite(message.createdAt));
      const events = Array.isArray(data.progress) ? data.progress : [];
      const name = clean(data.room.name, 80) || "대화";
      let room = rooms.get(id);
      if (!room) {
        rooms.set(id, { name, seen: new Set(messages.map((message) => message.id)), at: Math.max(0, ...messages.map((message) => message.createdAt)), progress: new Set(events.map((event) => `${event.stage}:${event.at}:${clean(event.label)}`)), progressAt: Math.max(0, ...events.map((event) => Number(event.at) || 0)) });
        if (rooms.size > 100) rooms.delete(rooms.keys().next().value);
        return false;
      }
      room.name = name;
      let changed = false;
      for (const message of [...messages].sort((a, b) => a.createdAt - b.createdAt)) {
        if (room.seen.has(message.id)) continue;
        room.seen.add(message.id);
        if (message.createdAt < room.at) continue;
        room.at = Math.max(room.at, message.createdAt);
        if (!["bot", "human", "system"].includes(message.kind) || (message.kind === "human" && message.authorId === userId)) continue;
        if (message.kind === "system" && items.some((item) => item.roomId === id && item.kind === "error" && Math.abs(item.at - message.createdAt) < 5000)) continue;
        changed = add({ id: `message:${id}:${message.id}`, roomId: id, roomName: name, kind: message.kind, title: message.kind === "bot" ? "답변이 도착했어요" : message.kind === "system" ? "대화 안내" : `${clean(message.author, 40) || "참여자"}님의 새 메시지`, text: clean(message.text) || (message.attachments?.length ? "첨부 파일을 보냈어요." : "새 메시지가 도착했어요."), at: message.createdAt }) || changed;
      }
      if (room.seen.size > 400) room.seen = new Set([...room.seen].slice(-200));
      for (const event of events) changed = progress(id, event, options) || changed;
      return changed;
    },
  };
}

export function createNotificationCenter({ mount, openRoom, toast = () => {} }) {
  const store = createNotificationStore();
  if (!mount) return { ...store, destroy() { store.reset(); } };
  const doc = mount.ownerDocument;
  let generation = 0;
  let opened = false;
  let lastUnread = 0;
  const element = (tag, className, text) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  };
  const button = (className, text) => { const node = element("button", className, text); node.type = "button"; return node; };
  mount.classList.add("notification-center");
  const bell = button("notification-bell");
  bell.id = "notification-bell";
  bell.setAttribute("aria-controls", "notification-panel");
  bell.setAttribute("aria-haspopup", "dialog");
  const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.7");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const path = doc.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4");
  svg.append(path);
  const badge = element("span", "notification-badge");
  badge.setAttribute("aria-hidden", "true");
  bell.append(svg, badge);
  const panel = element("section", "notification-panel");
  panel.id = "notification-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-labelledby", "notification-title");
  const header = element("div", "notification-head");
  const title = element("h2", "", "알림");
  title.id = "notification-title";
  const closeButton = button("notification-close", "×");
  closeButton.setAttribute("aria-label", "알림 닫기");
  header.append(title, closeButton);
  const settings = element("div", "notification-settings");
  const push = button("notification-setting-button", "알림 켜기");
  push.id = "push-button";
  const test = button("notification-setting-button is-hidden", "알림 테스트");
  test.id = "test-push-button";
  const status = element("p", "notification-push-status");
  status.id = "push-status";
  settings.append(push, test, status);
  const actions = element("div", "notification-actions");
  const markAll = button("notification-mark-read", "모두 읽음");
  actions.append(element("span", "", "새 답변과 대화 활동"), markAll);
  const list = element("ul", "notification-list");
  list.setAttribute("aria-label", "최근 알림");
  const live = element("span", "notification-sr-only");
  live.setAttribute("role", "status");
  live.setAttribute("aria-live", "polite");
  panel.append(header, settings, actions, list);
  mount.replaceChildren(bell, panel, live);
  const close = (restoreFocus = false) => {
    opened = false;
    panel.hidden = true;
    bell.setAttribute("aria-expanded", "false");
    if (restoreFocus) bell.focus();
  };
  const render = () => {
    const snapshot = store.snapshot();
    mount.hidden = !snapshot.userId;
    bell.setAttribute("aria-label", snapshot.unread ? `알림, 읽지 않은 알림 ${snapshot.unread}개` : "알림");
    bell.setAttribute("aria-expanded", String(opened));
    badge.hidden = !snapshot.unread;
    badge.textContent = String(snapshot.unread);
    panel.hidden = !opened;
    markAll.disabled = !snapshot.unread;
    if (snapshot.unread !== lastUnread) live.textContent = snapshot.unread ? `읽지 않은 알림 ${snapshot.unread}개` : "";
    lastUnread = snapshot.unread;
    if (!opened) return;
    const focusedId = doc.activeElement?.dataset?.notificationId;
    const scroll = list.scrollTop;
    list.replaceChildren();
    if (!snapshot.items.length) {
      const empty = element("li", "notification-empty");
      empty.append(element("strong", "", "새 알림이 없어요"), element("span", "", "열어둔 대화의 새 답변과 활동이 여기에 표시돼요."));
      list.append(empty);
    }
    for (const item of snapshot.items) {
      const row = element("li");
      const entry = button(`notification-item${item.read ? "" : " is-unread"}`);
      entry.dataset.notificationId = item.id;
      const meta = element("span", "notification-item-meta");
      const time = element("time", "", new Date(item.at).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" }));
      time.dateTime = new Date(item.at).toISOString();
      meta.append(element("strong", "", item.roomName), time);
      entry.append(meta, element("span", "notification-item-title", item.title), element("span", "notification-item-text", item.text));
      entry.addEventListener("click", async () => {
        const current = generation;
        entry.disabled = true;
        try {
          await openRoom(item.roomId);
          if (current !== generation) return;
          store.markRoomRead(item.roomId);
          close();
        } catch (error) {
          if (current !== generation) return;
          if (error?.status === 403 || error?.status === 404) store.forgetRoom(item.roomId);
          toast("대화를 열지 못했어요. 대화 목록에서 다시 확인해주세요.");
        } finally { if (current === generation) render(); }
      });
      row.append(entry);
      list.append(row);
      if (focusedId === item.id) entry.focus({ preventScroll: true });
    }
    list.scrollTop = scroll;
  };
  bell.addEventListener("click", () => { opened = !opened; render(); if (opened) closeButton.focus(); });
  closeButton.addEventListener("click", () => close(true));
  markAll.addEventListener("click", () => { store.markAllRead(); render(); });
  const onOutside = (event) => { if (opened && !mount.contains(event.target)) close(); };
  const onKey = (event) => { if (opened && event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); } };
  doc.addEventListener("pointerdown", onOutside);
  doc.addEventListener("focusin", onOutside);
  doc.addEventListener("keydown", onKey);
  render();
  return {
    setSession(session) { const before = store.snapshot().userId; store.setSession(session); if (before !== store.snapshot().userId) { generation++; close(); list.replaceChildren(); live.textContent = ""; } render(); },
    observeRoom(data, options) { if (store.observeRoom(data, options)) render(); },
    observeProgress(id, event, options) { if (store.observeProgress(id, event, options)) render(); },
    markRoomRead(id) { store.markRoomRead(id); render(); },
    reset() { generation++; store.reset(); close(); list.replaceChildren(); live.textContent = ""; render(); },
    destroy() { generation++; store.reset(); doc.removeEventListener("pointerdown", onOutside); doc.removeEventListener("focusin", onOutside); doc.removeEventListener("keydown", onKey); mount.replaceChildren(); },
  };
}
