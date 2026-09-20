import { createDesktopUI } from "/desktop.js";
import { createPwaController } from "/pwa.js";

const state = {
  session: null,
  rooms: [],
  bots: [],
  selectedRoom: null,
  roomData: null,
  selectedBots: [],
  pollTimer: null,
  pollBusy: false,
  sending: false,
  pendingSend: null,
  roomRequest: 0,
  pendingAttachments: [],
  recording: null,
  recordingPending: false,
  recordingCancelled: false,
  attachmentGeneration: 0,
};
let desktopUI;
let pwaUI;
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const els = {
  auth: $("#auth-view"),
  workspace: $("#workspace-view"),
  authMessage: $("#auth-message"),
  login: $("#login-form"),
  register: $("#register-form"),
  roomList: $("#room-list"),
  empty: $("#empty-state"),
  roomView: $("#room-view"),
  roomTitle: $("#room-title"),
  mobileRoomTitle: $("#mobile-room-title"),
  roomDescription: $("#room-description"),
  roomKicker: $("#room-kicker"),
  messages: $("#message-list"),
  memberList: $("#member-list"),
  memberCount: $("#member-count"),
  memberPanel: $("#member-panel"),
  modelWarning: $("#model-warning"),
  demoBadge: $("#demo-badge"),
  modelStatus: $("#model-status"),
  usage: $("#usage-label"),
  sendingStatus: $("#sending-status"),
  toast: $("#toast"),
};
const api = async (path, options = {}, retry = 0) => {
  const isFormData = options.body instanceof FormData;
  const headers = {
    Accept: "application/json",
    ...(options.body && !isFormData ? { "Content-Type": "application/json" } : {}),
    ...(state.session?.csrfToken
      ? { "X-CSRF-Token": state.session.csrfToken }
      : {}),
    ...(options.headers || {}),
  };
  let response;
  try {
    response = await fetch(path, {
      ...options,
      headers,
      credentials: "same-origin",
    });
  } catch (error) {
    if (retry < 1 && options.retryable) return api(path, options, retry + 1);
    throw error;
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || "요청을 처리하지 못했습니다.");
    error.status = response.status;
    throw error;
  }
  return payload;
};
const setBusy = (button, busy, label) => {
  if (!button) return;
  button.disabled = busy;
  if (busy) {
    button.dataset.previousLabel = button.textContent;
    button.textContent = label;
  } else if (button.dataset.previousLabel) {
    button.textContent = button.dataset.previousLabel;
    delete button.dataset.previousLabel;
  }
};
const formDataObject = (form) =>
  Object.fromEntries(new FormData(form).entries());
const showMessage = (target, message, type = "error") => {
  target.textContent = message || "";
  target.className = `form-message ${type}`;
};
const toast = (message) => {
  els.toast.textContent = message;
  els.toast.classList.add("is-visible");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(
    () => els.toast.classList.remove("is-visible"),
    2800,
  );
};
const initials = (name) => (name || "?").trim().slice(0, 1).toUpperCase();
function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", "#i-" + name);
  svg.append(use);
  return svg;
}
const formatDate = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("ko-KR", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
};
function switchAuth(tab) {
  const login = tab === "login";
  $$(".tab-button").forEach((button) => {
    const active = button.dataset.authTab === tab;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
  });
  els.login.classList.toggle("is-hidden", !login);
  els.register.classList.toggle("is-hidden", login);
  showMessage(els.authMessage, "");
  (login ? $("#login-username") : $("#register-display")).focus();
}
async function loadSession() {
  try {
    state.session = await api("/api/session");
    if (state.session.user) await enterWorkspace();
    else showAuth();
  } catch {
    showAuth();
    showMessage(
      els.authMessage,
      "서버에 연결할 수 없습니다. 잠시 후 다시 시도해주세요.",
    );
  }
}
function showAuth() {
  cancelActiveRecording();
  pwaUI?.setSession(null);
  els.auth.classList.remove("is-hidden");
  els.workspace.classList.add("is-hidden");
  stopPolling();
  state.selectedRoom = null;
  state.roomData = null;
  state.rooms = [];
  state.bots = [];
  state.selectedBots = [];
  state.pendingSend = null;
  clearPendingAttachments();
  desktopUI?.reset();
  state.roomRequest += 1;
  state.pollBusy = false;
  els.messages.replaceChildren();
  els.memberList.replaceChildren();
  els.roomList.replaceChildren();
  $("#message-input").value = "";
  $("#room-search").value = "";
  els.memberPanel.classList.remove("is-open");
  closeSidebar();
  $$("dialog[open]").forEach((dialog) => dialog.close());
  $("#invite-token").textContent = "";
  setTimeout(() => $("#login-username")?.focus(), 0);
}
async function enterWorkspace() {
  els.auth.classList.add("is-hidden");
  els.workspace.classList.remove("is-hidden");
  const user = state.session.user;
  $("#profile-name").textContent = user.displayName || user.username;
  $("#profile-role").textContent =
    user.role === "admin" ? "사이트 관리자" : "멤버";
  $("#profile-avatar").textContent = initials(
    user.displayName || user.username,
  );
  $("#site-invite-button").classList.toggle("is-hidden", user.role !== "admin");
  const model = state.session.model || {};
  els.demoBadge.classList.toggle("is-hidden", !model.demo);
  els.modelWarning.classList.toggle("is-hidden", Boolean(model.configured));
  els.modelStatus.classList.toggle("is-hidden", !model.configured || Boolean(model.demo));
  els.modelStatus.textContent = model.configured
    ? model.backend === "openclaw"
      ? "OpenClaw 연결됨"
      : "AI 연결됨"
      : "";
  pwaUI?.setSession(state.session);
  await loadRooms();
}
async function loadRooms() {
  try {
    const data = await api("/api/rooms");
    state.rooms = data.rooms || [];
    state.bots = data.bots || [];
    els.usage.textContent = data.usage
      ? `오늘 ${data.usage.used} / ${data.usage.limit}회`
      : "";
    renderRooms();
    renderBotPicker();
    if (!state.rooms.length) showEmpty();
    else if (
      !state.selectedRoom ||
      !state.rooms.some((room) => room.id === state.selectedRoom)
    ) {
      let last;
      try {
        last = sessionStorage.getItem(
          "community-room:" + state.session.user.id,
        );
      } catch {}
      const requested = new URLSearchParams(window.location.search).get("room");
      await selectRoom(
        state.rooms.some((room) => room.id === requested)
          ? requested
          : state.rooms.some((room) => room.id === last)
            ? last
            : state.rooms[0].id,
      );
    }
  } catch (error) {
    toast(error.message);
  }
}
function renderRooms() {
  els.roomList.replaceChildren();
  const query = $("#room-search").value.trim().toLocaleLowerCase();
  const visibleRooms = state.rooms.filter((room) =>
    (room.name + " " + room.description).toLocaleLowerCase().includes(query),
  );
  if (query && !visibleRooms.length) {
    const empty = document.createElement("p");
    empty.className = "search-empty";
    empty.textContent = "검색 결과가 없습니다.";
    els.roomList.append(empty);
  }
  visibleRooms.forEach((room) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `room-item ${room.id === state.selectedRoom ? "is-active" : ""}`;
    button.dataset.roomId = room.id;
    const roomIcon = document.createElement("span");
    roomIcon.className = "room-icon";
    roomIcon.append(icon("people"));
    const copy = document.createElement("span");
    copy.className = "room-item-copy";
    const name = document.createElement("strong");
    name.textContent = room.name;
    const meta = document.createElement("small");
    meta.textContent = `${room.memberCount || 0}명 · ${room.description || "공동 대화"}`;
    copy.append(name, meta);
    button.append(roomIcon, copy);
    button.addEventListener("click", () => {
      selectRoom(room.id);
      closeSidebar();
    });
    els.roomList.append(button);
  });
}
function showEmpty() {
  state.selectedRoom = null;
  stopPolling();
  els.empty.classList.remove("is-hidden");
  els.roomView.classList.add("is-hidden");
  $("#room-invite-button").classList.add("is-hidden");
  els.mobileRoomTitle.textContent = "대화를 선택하세요";
  renderRooms();
}
async function selectRoom(id) {
  if (!id) return;
  state.selectedRoom = id;
  try {
    sessionStorage.setItem("community-room:" + state.session.user.id, id);
  } catch {}
  state.roomData = null;
  cancelActiveRecording();
  clearPendingAttachments();
  desktopUI?.setRoom(id);
  els.messages.replaceChildren();
  els.memberList.replaceChildren();
  els.memberCount.textContent = "0";
  renderRooms();
  els.empty.classList.add("is-hidden");
  els.roomView.classList.remove("is-hidden");
  const room = state.rooms.find((item) => item.id === id);
  if (room) {
    els.roomTitle.textContent = room.name;
    els.mobileRoomTitle.textContent = room.name;
    els.roomDescription.textContent = room.description || "";
    const canInvite =
      room.role === "owner" || state.session.user.role === "admin";
    els.roomKicker.textContent = canInvite ? "방장" : "공동 대화";
    $("#room-invite-button").classList.toggle("is-hidden", !canInvite);
  }
  await refreshRoom(true);
  startPolling();
}
async function refreshRoom(force = false) {
  const roomId = state.selectedRoom,
    userId = state.session?.user?.id;
  if (!roomId || (state.pollBusy && !force)) return;
  const request = ++state.roomRequest;
  state.pollBusy = true;
  const nearBottom =
    els.messages.scrollHeight -
      els.messages.scrollTop -
      els.messages.clientHeight <
    90;
  const scrollTop = els.messages.scrollTop;
  try {
    const data = await api(`/api/rooms/${encodeURIComponent(roomId)}`);
    if (
      state.selectedRoom !== roomId ||
      state.session?.user?.id !== userId ||
      request !== state.roomRequest
    )
      return;
    const unchanged = JSON.stringify(state.roomData) === JSON.stringify(data);
    state.roomData = data;
    if (!unchanged) {
      renderRoom(data);
      els.messages.scrollTop = nearBottom
        ? els.messages.scrollHeight
        : scrollTop;
    }
  } catch (error) {
    if (request !== state.roomRequest) return;
    if (error.status === 401) {
      state.session = null;
      showAuth();
    } else toast(error.message);
  } finally {
    if (request === state.roomRequest) state.pollBusy = false;
  }
}
function startPolling() {
  stopPolling();
  state.pollTimer = setInterval(refreshRoom, 3000);
}
function stopPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = null;
}
function renderRoom(data) {
  els.messages.replaceChildren();
  const messages = data.messages || [];
  if (!messages.length) {
    const empty = document.createElement("div");
    empty.className = "message-empty";
    const title = document.createElement("strong");
    title.textContent = "아직 메시지가 없습니다.";
    const note = document.createElement("span");
    note.textContent = "메시지를 보내 대화를 시작하세요.";
    empty.append(title, note);
    els.messages.append(empty);
  } else
    messages.forEach((message) => els.messages.append(createMessage(message)));
  const members = data.members || [];
  els.memberCount.textContent = members.length;
  els.memberList.replaceChildren();
  members.forEach((member) => {
    const row = document.createElement("div");
    row.className = "member-row";
    const avatar = document.createElement("span");
    avatar.className = `avatar ${member.role === "owner" || member.role === "admin" ? "avatar-accent" : ""}`;
    avatar.textContent = initials(member.displayName);
    const copy = document.createElement("span");
    copy.className = "member-copy";
    const name = document.createElement("strong");
    name.textContent = member.displayName;
    const role = document.createElement("small");
    role.textContent =
      member.role === "owner"
        ? "방장"
        : member.role === "admin"
          ? "관리자"
          : "멤버";
    copy.append(name, role);
    row.append(avatar, copy);
    els.memberList.append(row);
  });
  if (data.busy) {
    els.sendingStatus.textContent = "봇이 답변을 준비하고 있어요…";
    els.sendingStatus.classList.add("is-visible");
  } else {
    els.sendingStatus.textContent = "";
    els.sendingStatus.classList.remove("is-visible");
  }
}
function createMessage(message) {
  const article = document.createElement("article");
  const own =
    message.kind === "human" && message.authorId === state.session?.user?.id;
  article.className = `message message-${message.kind}${own ? " message-own" : ""}`;
  const avatar = document.createElement("div");
  avatar.className = `avatar ${message.kind === "bot" ? "avatar-bot" : ""}`;
  if (message.kind === "bot") avatar.append(icon("bot"));
  else avatar.textContent = initials(message.author);
  const body = document.createElement("div");
  body.className = "message-body";
  const meta = document.createElement("div");
  meta.className = "message-meta";
  const author = document.createElement("strong");
  author.textContent =
    message.author || (message.kind === "system" ? "안내" : "알 수 없음");
  const time = document.createElement("time");
  time.textContent = new Intl.DateTimeFormat("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(message.createdAt));
  time.dateTime = new Date(message.createdAt).toISOString();
  time.title = formatDate(message.createdAt);
  meta.append(author, time);
  if (message.text) {
    const text = document.createElement("p");
    text.textContent = message.text;
    body.append(text);
  }
  if (Array.isArray(message.attachments)) {
    const attachments = document.createElement("div");
    attachments.className = "message-attachments";
    message.attachments.forEach((attachment) => {
      if (!attachment || !attachment.url) return;
      if (attachment.kind === "image") {
        const image = document.createElement("img");
        image.src = attachment.url;
        image.alt = attachment.name || "첨부 이미지";
        image.loading = "lazy";
        image.addEventListener("click", () => {
          $("#image-dialog-image").src = attachment.url;
          $("#image-dialog-image").alt = attachment.name || "첨부 이미지";
          openDialog($("#image-dialog"));
        });
        attachments.append(image);
      } else if (attachment.kind === "audio") {
        const audio = document.createElement("audio");
        audio.controls = true;
        audio.preload = "metadata";
        audio.src = attachment.url;
        audio.setAttribute("aria-label", attachment.name || "첨부 음성");
        attachments.append(audio);
      }
    });
    if (attachments.childElementCount) body.append(attachments);
  }
  article.append(avatar, body);
  return article;
}
function renderBotPicker() {
  const picker = $("#bot-picker");
  picker.replaceChildren();
  if (!state.bots.length) {
    const note = document.createElement("span");
    note.className = "picker-note";
    note.textContent = "사용 가능한 봇이 없습니다.";
    picker.append(note);
    return;
  }
  state.bots.forEach((bot) => {
    const label = document.createElement("label");
    label.className = "bot-option";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = bot.id;
    checkbox.checked = state.selectedBots.includes(bot.id);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked && state.selectedBots.length >= 3) {
        checkbox.checked = false;
        toast("한 번에 최대 3개의 봇을 선택할 수 있어요.");
        return;
      }
      state.selectedBots = $$(".bot-option input:checked", picker).map(
        (input) => input.value,
      );
      updateBotLabel();
    });
    const copy = document.createElement("span");
    const name = document.createElement("strong");
    name.textContent = bot.name;
    const desc = document.createElement("small");
    desc.textContent = bot.description || "";
    copy.append(name, desc);
    label.append(checkbox, copy);
    picker.append(label);
  });
  updateBotLabel();
}
function updateBotLabel() {
  const selected = state.selectedBots
    .map((id) => state.bots.find((bot) => bot.id === id)?.name)
    .filter(Boolean);
  $("#bot-picker-label").textContent = selected.length
    ? selected.join(", ")
    : "봇 없이 보내기";
}
function clearPendingAttachments() {
  state.attachmentGeneration += 1;
  state.pendingAttachments.forEach((item) => item.previewUrl && URL.revokeObjectURL(item.previewUrl));
  state.pendingAttachments = [];
  renderPendingAttachments();
}
function cancelActiveRecording() {
  if (!state.recording) return;
  state.recordingCancelled = true;
  try { state.recording.stop(); } catch {}
}
function renderPendingAttachments() {
  const list = $("#attachment-list");
  if (!list) return;
  list.replaceChildren();
  state.pendingAttachments.forEach((item) => {
    const card = document.createElement("div");
    card.className = `attachment-card${item.error ? " is-error" : ""}`;
    if (item.kind === "image" && item.previewUrl) {
      const image = document.createElement("img");
      image.src = item.previewUrl;
      image.alt = item.name;
      card.append(image);
    } else if (item.kind === "audio" && item.previewUrl && !item.error) {
      const audio = document.createElement("audio");
      audio.controls = true;
      audio.src = item.previewUrl;
      card.append(audio);
    }
    const name = document.createElement("span");
    name.className = "attachment-name";
    name.textContent = item.error || (item.uploading ? `${item.name} · 업로드 중…` : item.name);
    card.append(name);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "attachment-remove";
    remove.setAttribute("aria-label", `${item.name} 첨부 제거`);
    remove.append(icon("close"));
    remove.addEventListener("click", () => {
      const index = state.pendingAttachments.indexOf(item);
      if (index < 0) return;
      state.pendingAttachments.splice(index, 1);
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      renderPendingAttachments();
    });
    card.append(remove);
    list.append(card);
  });
}
async function uploadAttachments(files) {
  const roomId = state.selectedRoom;
  const generation = state.attachmentGeneration;
  const accepted = [...files].filter((file) => /^(image|audio)\//.test(file.type));
  if (accepted.length !== files.length) toast("사진 또는 음성 파일만 첨부할 수 있어요.");
  if (state.pendingAttachments.length + accepted.length > 4) {
    toast("메시지 하나에 최대 4개까지 첨부할 수 있어요.");
    return;
  }
  for (const file of accepted) {
    if (file.size > 12 * 1024 * 1024) {
      toast(`${file.name}: 파일은 12MB 이하만 첨부할 수 있어요.`);
      continue;
    }
    const item = {
      roomId,
      name: file.name,
      kind: file.type.startsWith("image/") ? "image" : "audio",
      previewUrl: URL.createObjectURL(file),
      uploading: true,
      attachment: null,
    };
    state.pendingAttachments.push(item);
    renderPendingAttachments();
    const form = new FormData();
    form.append("file", file, file.name);
    try {
      const data = await api(`/api/rooms/${encodeURIComponent(roomId)}/attachments`, {
        method: "POST",
        body: form,
      });
      if (state.selectedRoom !== roomId || state.attachmentGeneration !== generation) return;
      item.attachment = data.attachment;
      item.uploading = false;
      item.name = data.attachment?.name || item.name;
    } catch (error) {
      if (state.selectedRoom !== roomId || state.attachmentGeneration !== generation) return;
      item.uploading = false;
      item.error = error.message || "업로드하지 못했습니다.";
    }
    renderPendingAttachments();
  }
}
async function toggleRecording() {
  const button = $("#record-button");
  if (state.recordingPending) return;
  if (state.recording) {
    state.recording.stop();
    button.disabled = true;
    button.textContent = "처리 중…";
    return;
  }
  if (!window.MediaRecorder || !navigator.mediaDevices?.getUserMedia) {
    toast("이 브라우저에서는 음성 녹음을 사용할 수 없어요. 음성 파일을 첨부해주세요.");
    return;
  }
  const roomId = state.selectedRoom;
  const attachmentGeneration = state.attachmentGeneration;
  state.recordingPending = true;
  button.disabled = true;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (error) {
    state.recordingPending = false;
    button.disabled = false;
    toast(error?.name === "NotAllowedError" ? "마이크 권한이 필요합니다." : "마이크를 사용할 수 없습니다.");
    return;
  }
  if (roomId !== state.selectedRoom || attachmentGeneration !== state.attachmentGeneration) {
    stream.getTracks().forEach((track) => track.stop());
    state.recordingPending = false;
    button.disabled = false;
    return;
  }
  const chunks = [];
  let recordedBytes = 0;
  let tooLarge = false;
  let recorder;
  const mimeType = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus", "audio/webm"].find((type) => MediaRecorder.isTypeSupported?.(type));
  try { recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined); } catch {
    stream.getTracks().forEach((track) => track.stop());
    state.recordingPending = false;
    button.disabled = false;
    toast("이 브라우저에서 지원하는 녹음 형식이 없습니다.");
    return;
  }
  state.recording = recorder;
  state.recordingPending = false;
  state.recordingCancelled = false;
  button.classList.add("is-recording");
  $("#record-cancel-button").hidden = false;
  button.setAttribute("aria-label", "음성 녹음 중지");
  button.title = "녹음 중지";
  recorder.addEventListener("dataavailable", (event) => { if (event.data.size) chunks.push(event.data); });
  recorder.addEventListener("dataavailable", (event) => {
    recordedBytes += event.data.size;
    if (recordedBytes > 12 * 1024 * 1024 && recorder.state === "recording") {
      tooLarge = true;
      state.recordingCancelled = true;
      recorder.stop();
      toast("녹음이 12MB에 도달해 중지되었습니다.");
    }
  });
  recorder.addEventListener("error", () => {
    state.recordingCancelled = true;
    tooLarge = false;
    stream.getTracks().forEach((track) => track.stop());
    toast("음성 녹음 중 오류가 발생했습니다.");
    if (recorder.state === "recording") {
      try { recorder.stop(); } catch {}
    }
  });
  recorder.addEventListener("stop", async () => {
    clearTimeout(recorder.timeout);
    stream.getTracks().forEach((track) => track.stop());
    state.recording = null;
    const cancelled = state.recordingCancelled;
    state.recordingCancelled = false;
    $("#record-cancel-button").hidden = true;
    button.disabled = false;
    button.classList.remove("is-recording");
    button.textContent = "";
    button.append(icon("mic"));
    button.setAttribute("aria-label", "음성 녹음 시작");
    button.title = "음성 녹음";
    if (cancelled || tooLarge || !chunks.length) return;
    if (roomId !== state.selectedRoom || attachmentGeneration !== state.attachmentGeneration) return;
    const extension = recorder.mimeType.includes("mp4") ? "mp4" : recorder.mimeType.includes("ogg") ? "ogg" : "webm";
    await uploadAttachments([new File([new Blob(chunks, { type: recorder.mimeType })], `voice-${Date.now()}.${extension}`, { type: recorder.mimeType })]);
  });
  recorder.start(1000);
  button.disabled = false;
  recorder.timeout = setTimeout(() => {
    if (recorder.state === "recording") {
      recorder.stop();
      toast("녹음은 최대 120초까지 가능합니다.");
    }
  }, 120000);
  toast("녹음 중… 다시 눌러 녹음을 첨부합니다.");
}
async function submitMessage(event) {
  event.preventDefault();
  if (state.sending || !state.selectedRoom) return;
  const input = $("#message-input"),
    text = input.value.trim();
  const attachments = state.pendingAttachments.filter((item) => item.attachment && !item.error);
  if (!text && !attachments.length) return;
  const roomId = state.selectedRoom,
    botIds = [...state.selectedBots];
  if (state.pendingAttachments.some((item) => item.uploading)) {
    toast("첨부 파일 업로드가 끝날 때까지 기다려주세요.");
    return;
  }
  const attachmentIds = attachments.map((item) => item.attachment.id);
  const signature = JSON.stringify({ roomId, text, botIds, attachmentIds });
  if (state.pendingSend?.signature !== signature)
    state.pendingSend = { signature, nonce: crypto.randomUUID() };
  const payload = JSON.stringify({
    text,
    botIds,
    attachmentIds,
    clientNonce: state.pendingSend.nonce,
  });
  state.sending = true;
  $("#send-button").disabled = true;
  input.disabled = true;
  els.sendingStatus.textContent = "메시지를 보내는 중…";
  els.sendingStatus.classList.add("is-visible");
  try {
    await api(`/api/rooms/${encodeURIComponent(roomId)}/messages`, {
      method: "POST",
      body: payload,
      retryable: true,
    });
    state.pendingSend = null;
    clearPendingAttachments();
    input.value = "";
    input.style.height = "";
    await refreshRoom(true);
    await loadRooms();
  } catch (error) {
    toast(error.message);
  } finally {
    state.sending = false;
    $("#send-button").disabled = false;
    input.disabled = false;
    if (!state.roomData?.busy) els.sendingStatus.classList.remove("is-visible");
    input.focus();
  }
}
async function authSubmit(event, endpoint, buttonLabel) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $('button[type="submit"]', form);
  const message = els.authMessage;
  showMessage(message, "");
  setBusy(button, true, "확인 중…");
  try {
    state.session = await api(endpoint, {
      method: "POST",
      body: JSON.stringify(formDataObject(form)),
    });
    form.reset();
    await enterWorkspace();
  } catch (error) {
    showMessage(message, error.message);
  } finally {
    setBusy(button, false, buttonLabel);
  }
}
function openDialog(dialog) {
  dialog.showModal();
  const first = dialog.querySelector(
    "input, textarea, button:not(.modal-close)",
  );
  setTimeout(() => first?.focus(), 0);
}
function closeDialog(dialog) {
  if (dialog?.open) dialog.close();
}
async function createRoom(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $('button[type="submit"]', form);
  showMessage($("#room-form-message"), "");
  setBusy(button, true, "만드는 중…");
  try {
    const data = await api("/api/rooms", {
      method: "POST",
      body: JSON.stringify({
        name: $("#room-name").value.trim(),
        description: $("#room-description-input").value.trim(),
      }),
    });
    closeDialog($("#room-dialog"));
    await loadRooms();
    await selectRoom(data.room.id);
    toast("대화를 만들었습니다.");
  } catch (error) {
    showMessage($("#room-form-message"), error.message);
  } finally {
    setBusy(button, false, "만들기");
  }
}
async function joinRoom(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $('button[type="submit"]', form);
  showMessage($("#join-form-message"), "");
  setBusy(button, true, "참여 중…");
  try {
    const data = await api("/api/rooms/join", {
      method: "POST",
      body: JSON.stringify({ token: $("#join-token").value.trim() }),
    });
    closeDialog($("#join-dialog"));
    await loadRooms();
    await selectRoom(data.room.id);
    toast("대화에 참여했습니다.");
  } catch (error) {
    showMessage($("#join-form-message"), error.message);
  } finally {
    setBusy(button, false, "참여하기");
  }
}
async function makeInvite(path, title) {
  try {
    const data = await api(path, { method: "POST", body: "{}" });
    $("#invite-token").textContent = data.token;
    $("#invite-expires").textContent = data.expiresAt
      ? `만료: ${formatDate(data.expiresAt)}`
      : "";
    $(".invite-modal h2").textContent =
      title === "site" ? "가입 초대 코드" : "대화 초대 코드";
    $(".invite-modal .eyebrow").textContent =
      title === "site" ? "SITE INVITATION" : "ROOM INVITATION";
    $("#invite-dialog").dataset.title = title;
    openDialog($("#invite-dialog"));
  } catch (error) {
    toast(error.message);
  }
}
function closeSidebar() {
  $("#sidebar").classList.remove("is-open");
  $("#sidebar-scrim").classList.remove("is-visible");
}
function bind() {
  $("#room-search").addEventListener("input", renderRooms);
  document.addEventListener("keydown", (event) => {
    if (
      event.key === "/" &&
      state.session?.user &&
      !event.target.matches("input, textarea") &&
      !document.querySelector("dialog[open]")
    ) {
      event.preventDefault();
      $("#sidebar").classList.add("is-open");
      $("#sidebar-scrim").classList.add("is-visible");
      $("#room-search").focus();
    }
    if (event.key === "Escape") {
      $("#bot-picker").classList.add("is-hidden");
      $("#bot-picker-button").setAttribute("aria-expanded", "false");
      els.memberPanel.classList.remove("is-open");
      closeSidebar();
    }
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest("#bot-picker, #bot-picker-button")) {
      $("#bot-picker").classList.add("is-hidden");
      $("#bot-picker-button").setAttribute("aria-expanded", "false");
    }
  });
  $$("[data-auth-tab]").forEach((button) =>
    button.addEventListener("click", () => switchAuth(button.dataset.authTab)),
  );
  els.login.addEventListener("submit", (event) =>
    authSubmit(event, "/api/login", "로그인"),
  );
  els.register.addEventListener("submit", (event) =>
    authSubmit(event, "/api/register", "계정 만들기"),
  );
  $("#logout-button").addEventListener("click", async () => {
    try {
      await pwaUI?.clearSession({ keepSession: true });
      await api("/api/logout", { method: "POST", body: "{}" });
      await pwaUI?.clearSession();
      state.session = null;
      showAuth();
    } catch (error) {
      toast(error.message);
    }
  });
  ["#create-room-button", "#empty-create-button"].forEach((selector) =>
    $(selector).addEventListener("click", () => openDialog($("#room-dialog"))),
  );
  $("#join-room-button").addEventListener("click", () =>
    openDialog($("#join-dialog")),
  );
  $("#room-form").addEventListener("submit", createRoom);
  $("#join-form").addEventListener("submit", joinRoom);
  $("#composer-form").addEventListener("submit", submitMessage);
  $("#attach-button").addEventListener("click", () => $("#attachment-input").click());
  $("#attachment-input").addEventListener("change", (event) => {
    uploadAttachments(event.target.files);
    event.target.value = "";
  });
  $("#record-button").addEventListener("click", toggleRecording);
  $("#record-cancel-button").addEventListener("click", () => {
    if (!state.recording) return;
    state.recordingCancelled = true;
    state.recording.stop();
    toast("녹음을 취소했습니다.");
  });
  $("#message-input").addEventListener("keydown", (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      $("#composer-form").requestSubmit();
    }
  });
  $("#message-input").addEventListener("input", (event) => {
    event.target.style.height = "auto";
    event.target.style.height = `${Math.min(event.target.scrollHeight, 140)}px`;
  });
  $("#bot-picker-button").addEventListener("click", () => {
    const picker = $("#bot-picker");
    const hidden = picker.classList.toggle("is-hidden");
    $("#bot-picker-button").setAttribute("aria-expanded", String(!hidden));
  });
  $("#members-toggle").addEventListener("click", () =>
    els.memberPanel.classList.toggle("is-open"),
  );
  $("#member-close").addEventListener("click", () =>
    els.memberPanel.classList.remove("is-open"),
  );
  $("#room-invite-button").addEventListener("click", () =>
    makeInvite(
      `/api/rooms/${encodeURIComponent(state.selectedRoom)}/invites`,
      "room",
    ),
  );
  $("#site-invite-button").addEventListener("click", () =>
    makeInvite("/api/admin/invites", "site"),
  );
  $("#copy-invite").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("#invite-token").textContent);
      toast("초대 코드를 복사했습니다.");
    } catch {
      toast("복사하지 못했습니다. 코드를 직접 선택해주세요.");
    }
  });
  $("#mobile-menu").addEventListener("click", () => {
    $("#sidebar").classList.add("is-open");
    $("#sidebar-scrim").classList.add("is-visible");
  });
  $("#mobile-close").addEventListener("click", closeSidebar);
  $("#sidebar-scrim").addEventListener("click", closeSidebar);
  $$(".modal-close, .modal-cancel").forEach((button) =>
    button.addEventListener("click", () =>
      closeDialog(button.closest("dialog")),
    ),
  );
  $("#image-dialog-close").addEventListener("click", () => closeDialog($("#image-dialog")));
  $$("dialog").forEach((dialog) =>
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) closeDialog(dialog);
    }),
  );
}
bind();
pwaUI = createPwaController({ api, getSession: () => state.session, toast });
desktopUI = createDesktopUI({ api, getRoomId: () => state.selectedRoom, toast });
loadSession();
