const MONITOR_ROOM = "00000000-0000-4000-8000-000000000001";
import { renderMessageText } from "/message-format.mjs";
import { recommendedModels, modelLabel, filterModels } from "/model-picker.mjs";
import { createDesktopUI } from "/desktop.js";
import { createPwaController } from "/pwa.js";

let dockRects = [{x:0,y:0,w:1,h:1}];
let pendingDock = null;
const state = {
  session: null,
  rooms: [],
  bots: [],
  selectedRoom: null,
  roomData: null,
  selectedBots: [],
  botChoiceTouched: false,
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
  layout: 1,
  extra: [],
  focusPane: 0,
  models: [],
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
function renderAgentLinks() {
  let links=$("#agent-workspaces");
  if(!links){links=document.createElement("div");links.id="agent-workspaces";links.className="agent-workspaces";els.roomList.before(links);}
  links.replaceChildren();
  if(state.session?.user?.role==="admin") {
    const hub=document.createElement("button");hub.textContent="통합 관리";hub.onclick=openCapabilityHub;links.append(hub);
  }
  for(const room of state.rooms.filter(r=>!r.archived&&r.id===MONITOR_ROOM)) {
    const button=document.createElement("button");button.type="button";
    button.append(icon("agent"));
    const label=document.createElement("span");label.textContent="대시보드";button.append(label);
    button.onclick=()=>selectRoom(room.id);links.append(button);
  }
}
function icon(name) {
  if (name === "agent" || name === "spark") {
    const image = document.createElement("img");
    image.className = "icon agent-art";
    image.src = "/icons/agent-bot-v2.png";
    image.alt = "";
    image.setAttribute("aria-hidden", "true");
    image.draggable = false;
    return image;
  }
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
  const startup = $("#startup-view");
  $("#startup-retry").classList.add("is-hidden");
  $("#startup-status").textContent = "내 공간을 불러오고 있어요";
  try {
    state.session = await api("/api/session", { signal: AbortSignal.timeout(15000) });
    if (state.session.user) void enterWorkspace().catch(() => toast("대화 목록을 불러오지 못했습니다. 새로고침해주세요."));
    else showAuth();
    startup.classList.add("is-ready");
    setTimeout(() => startup.classList.add("is-hidden"), 300);
  } catch {
    $("#startup-status").textContent = "연결이 잠시 늦어지고 있어요. 다시 시도해주세요.";
    $("#startup-retry").classList.remove("is-hidden");
  }
}
$("#startup-retry").addEventListener("click", loadSession);
function showAuth() {
  closeContextPopover();
  resetSidebarState();
  modelChanges.clear();
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
  state.botChoiceTouched = false;
  state.pendingSend = null;
  state.layout = 1;
  state.extra = [];
  state.focusPane = 0;
  state.models = [];
  dockRects = [{x:0,y:0,w:1,h:1}];
  pendingDock = null;
  const paneGrid = $("#pane-grid");
  if (paneGrid) {
    paneGrid.dataset.panes = "1";
    $$(".extra-pane", paneGrid).forEach((pane) => pane.remove());
  }
  $("#room-view").style.gridColumn = "";
  $("#room-view").classList.remove("is-focus");
  $$(".split-picker button").forEach((button) => {
    button.classList.remove("is-on");
    button.setAttribute("aria-pressed", "false");
  });
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
  els.modelWarning.classList.toggle("is-hidden", Boolean(model.configured) || Boolean(model.selectable));
  els.modelStatus.classList.toggle("is-hidden", !model.configured || Boolean(model.demo));
  const connected = model.configured
    ? model.backend === "openclaw"
      ? "OpenClaw 연결됨"
      : "AI 연결됨"
    : "";
  els.modelStatus.textContent = [connected, model.selectable ? "API 순환" : ""].filter(Boolean).join(" · ");
  els.modelStatus.classList.toggle("is-hidden", !els.modelStatus.textContent);
  pwaUI?.setSession(state.session);
  resetSidebarState(user.id);
  const workspaceEpoch=sidebarEpoch;
  await Promise.all([loadSidebar(),loadRooms()]);
  if(state.session?.user?.id!==user.id||sidebarEpoch!==workspaceEpoch)return;
  try {
    const catalog = await api("/api/models");
    if(state.session?.user?.id!==user.id||sidebarEpoch!==workspaceEpoch)return;
    applyModels(catalog.models);
    if (!catalog.models.length) toast(catalog.failures.length ? "모델 목록을 가져오지 못했습니다. 기본 모델로 연결됩니다." : "선택 가능한 API 모델이 없습니다. 기본 모델로 연결됩니다.");
  } catch (error) { toast(error.message || "모델 목록을 불러오지 못했습니다."); }
}
async function loadRooms() {
  const userId=state.session?.user?.id,epoch=sidebarEpoch;if(!userId)return;
  try {
    const data = await api("/api/rooms");
    if(userId!==state.session?.user?.id||epoch!==sidebarEpoch)return;
    state.rooms = data.rooms || [];
    state.bots = data.bots || [];
    if (
      state.session?.model?.configured &&
      state.bots.length &&
      !state.botChoiceTouched
    ) {
      state.selectedBots = [state.bots[0].id];
    }
    els.usage.textContent = "";
    els.usage.title = data.usage ? `앱의 하루 호출 사용량 ${data.usage.used} / ${data.usage.limit}회 · 공급자 잔여량과 별개` : "";
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
        state.rooms.some((room) => room.id === requested && !room.archived)
          ? requested
          : state.rooms.some((room) => room.id === last && !room.archived)
            ? last
            : (state.rooms.find(room=>!room.archived) || state.rooms[0]).id,
      );
    }
  } catch (error) {
    if(userId===state.session?.user?.id&&epoch===sidebarEpoch)toast(error.message);
  }
}
let showDeletedRooms=false;
let sidebarState={userId:null,groups:[],width:280,loaded:false};
let sidebarConfirmed={groups:[],width:280};
let sidebarEpoch=0,sidebarRevision=0,sidebarWriteQueue=Promise.resolve();
let sidebarPreviewWidth=null,sidebarWidthTimer=null;
function sidebarWidthBounds(viewport=innerWidth) {
  return {min:200,max:Math.max(200,Math.min(420,viewport-360))};
}
function boundedSidebarWidth(value,viewport=innerWidth) {
  const {min,max}=sidebarWidthBounds(viewport);return Math.max(min,Math.min(max,Math.round(Number(value)||280)));
}
function applySidebarWidth() {
  const width=boundedSidebarWidth(sidebarPreviewWidth??sidebarState.width),handle=$("#sidebar-resizer");
  els.workspace.style.setProperty("--sidebar-width",width+"px");
  handle.setAttribute("aria-valuenow",String(width));handle.setAttribute("aria-valuetext",width+"픽셀");handle.setAttribute("aria-valuemax",String(sidebarWidthBounds().max));
  handle.setAttribute("aria-disabled",String(!sidebarState.loaded));
}
function resetSidebarState(userId=null) {
  sidebarEpoch+=1;sidebarRevision=0;showDeletedRooms=false;
  clearTimeout(sidebarWidthTimer);sidebarWidthTimer=null;sidebarPreviewWidth=null;
  sidebarState={userId,groups:[],width:280,loaded:false};sidebarConfirmed={groups:[],width:280};
  els.workspace.classList.remove("sidebar-resizing","sidebar-collapsed");applySidebarWidth();
  $("#create-sidebar-group").disabled=true;
}
function sidebarConfig(value) {
  return {groups:Array.isArray(value?.groups)?value.groups.map(group=>({id:group.id,name:group.name,collapsed:!!group.collapsed})):[],width:Math.max(200,Math.min(420,Number(value?.width)||280))};
}
async function loadSidebar() {
  const userId=state.session?.user?.id,epoch=sidebarEpoch;if(!userId)return;
  try {
    const config=sidebarConfig(await api("/api/sidebar",{retryable:true}));
    if(epoch!==sidebarEpoch||state.session?.user?.id!==userId)return;
    sidebarConfirmed=config;sidebarState={...config,userId,loaded:true};applySidebarWidth();renderRooms();
  }catch(error){if(epoch===sidebarEpoch){toast("대화 그룹 설정을 불러오지 못했습니다. 새로고침해 다시 시도해주세요.");}}
}
function saveSidebar(next) {
  const userId=state.session?.user?.id,epoch=sidebarEpoch;if(!userId||!sidebarState.loaded)return Promise.resolve(false);
  const config=sidebarConfig(next),revision=++sidebarRevision;
  sidebarState={...config,userId,loaded:true};applySidebarWidth();renderRooms();
  const current=()=>epoch===sidebarEpoch&&state.session?.user?.id===userId;
  const pending=sidebarWriteQueue.then(async()=>{
    if(!current())return false;
    try {
      const saved=sidebarConfig(await api("/api/sidebar",{method:"PUT",body:JSON.stringify(config)}));
      if(!current())return false;
      sidebarConfirmed=saved;
      if(revision===sidebarRevision){sidebarState={...saved,userId,loaded:true};applySidebarWidth();renderRooms();}
      return true;
    }catch(error){
      if(current()){
        if(revision===sidebarRevision){sidebarState={...sidebarConfirmed,userId,loaded:true};applySidebarWidth();renderRooms();}
        toast(error.message||"대화 목록 설정을 저장하지 못했습니다.");
      }
      return false;
    }
  });
  sidebarWriteQueue=pending.catch(()=>false);return pending;
}
function commitSidebarWidth() {
  clearTimeout(sidebarWidthTimer);sidebarWidthTimer=null;
  if(sidebarPreviewWidth==null)return;
  const width=boundedSidebarWidth(sidebarPreviewWidth);sidebarPreviewWidth=null;
  if(sidebarState.loaded&&width!==sidebarState.width)void saveSidebar({...sidebarState,width});
  else applySidebarWidth();
}
function setupSidebarResize() {
  const handle=$("#sidebar-resizer");let drag=null;
  handle.addEventListener("pointerdown",event=>{
    if(event.button!==0||!sidebarState.loaded||matchMedia("(max-width:720px)").matches)return;
    event.preventDefault();event.stopPropagation();clearTimeout(sidebarWidthTimer);
    drag={pointerId:event.pointerId,startX:event.clientX,width:boundedSidebarWidth(sidebarPreviewWidth??sidebarState.width),epoch:sidebarEpoch};
    handle.setPointerCapture(event.pointerId);handle.focus();els.workspace.classList.add("sidebar-resizing");
  });
  handle.addEventListener("pointermove",event=>{
    if(!drag||event.pointerId!==drag.pointerId)return;
    if(drag.epoch!==sidebarEpoch){drag=null;return;}
    sidebarPreviewWidth=boundedSidebarWidth(drag.width+event.clientX-drag.startX);applySidebarWidth();
  });
  const finish=event=>{
    if(!drag||event.pointerId!==drag.pointerId)return;
    const same=drag.epoch===sidebarEpoch;drag=null;els.workspace.classList.remove("sidebar-resizing");
    if(handle.hasPointerCapture(event.pointerId))handle.releasePointerCapture(event.pointerId);
    if(same)commitSidebarWidth();
  };
  handle.addEventListener("pointerup",finish);handle.addEventListener("lostpointercapture",finish);
  handle.addEventListener("pointercancel",event=>{
    if(!drag||event.pointerId!==drag.pointerId)return;drag=null;sidebarPreviewWidth=null;els.workspace.classList.remove("sidebar-resizing");applySidebarWidth();
  });
  handle.addEventListener("keydown",event=>{
    if(!sidebarState.loaded||!["ArrowLeft","ArrowRight","Home","End"].includes(event.key))return;
    event.preventDefault();const {min,max}=sidebarWidthBounds(),step=event.shiftKey?40:10;
    sidebarPreviewWidth=boundedSidebarWidth(event.key==="Home"?min:event.key==="End"?max:(sidebarPreviewWidth??sidebarState.width)+(event.key==="ArrowRight"?step:-step));applySidebarWidth();
    clearTimeout(sidebarWidthTimer);sidebarWidthTimer=setTimeout(commitSidebarWidth,250);
  });
  window.addEventListener("resize",applySidebarWidth);applySidebarWidth();
}
function sidebarDialog(title) {
  const dialog=document.createElement("dialog");dialog.className="sidebar-dialog";dialog.setAttribute("aria-label",title);
  const heading=document.createElement("h2");heading.textContent=title;dialog.append(heading);
  dialog.addEventListener("close",()=>dialog.remove(),{once:true});document.body.append(dialog);return dialog;
}
function openSidebarGroupEditor(group=null) {
  if(!sidebarState.loaded)return;
  const epoch=sidebarEpoch,dialog=sidebarDialog(group?"그룹 이름 변경":"새 대화 그룹"),form=document.createElement("form");
  const label=document.createElement("label");label.textContent="그룹 이름";
  const input=document.createElement("input");input.name="name";input.maxLength=40;input.required=true;input.autocomplete="off";input.value=group?.name||"";label.append(input);
  const message=document.createElement("p");message.className="form-message";message.setAttribute("role","alert");
  const actions=document.createElement("div");actions.className="sidebar-dialog-actions";
  const cancel=document.createElement("button");cancel.type="button";cancel.textContent="취소";cancel.onclick=()=>dialog.close();
  const submit=document.createElement("button");submit.type="submit";submit.textContent=group?"저장":"만들기";actions.append(cancel,submit);form.append(label,message,actions);dialog.append(form);
  form.onsubmit=async event=>{
    event.preventDefault();if(submit.disabled||epoch!==sidebarEpoch)return;
    const name=input.value.trim();if(!name){message.textContent="그룹 이름을 입력해주세요.";return;}
    if(group&&!sidebarState.groups.some(item=>item.id===group.id)){dialog.close();return;}
    if(!group&&sidebarState.groups.length>=20){message.textContent="그룹은 최대 20개까지 만들 수 있습니다.";return;}
    setBusy(submit,true,"저장 중…");
    const groups=group?sidebarState.groups.map(item=>item.id===group.id?{...item,name}:item):[...sidebarState.groups,{id:crypto.randomUUID(),name,collapsed:false}];
    const saved=await saveSidebar({...sidebarState,groups});
    if(saved&&epoch===sidebarEpoch)dialog.close();else setBusy(submit,false);
  };
  dialog.showModal();input.focus();input.select();
}
function openSidebarGroupMenu(group) {
  const epoch=sidebarEpoch,dialog=sidebarDialog(group.name),rename=document.createElement("button"),remove=document.createElement("button"),cancel=document.createElement("button");
  rename.type=remove.type=cancel.type="button";rename.textContent="이름 변경";remove.textContent="그룹 삭제";cancel.textContent="닫기";
  rename.onclick=()=>{dialog.close();openSidebarGroupEditor(group);};cancel.onclick=()=>dialog.close();
  const note=document.createElement("p");note.className="sidebar-dialog-note";note.textContent="그룹을 삭제해도 대화는 유지되며 ‘그룹 없음’으로 이동합니다.";
  remove.onclick=async()=>{
    remove.disabled=true;
    const saved=await saveSidebar({...sidebarState,groups:sidebarState.groups.filter(item=>item.id!==group.id)});
    if(saved&&epoch===sidebarEpoch){for(const room of state.rooms)if(room.groupId===group.id)room.groupId=null;renderRooms();dialog.close();}
    else remove.disabled=false;
  };
  dialog.append(rename,remove,note,cancel);dialog.showModal();
}
function openRoomGroupPicker(room) {
  if(!sidebarState.loaded)return;
  const dialog=sidebarDialog("대화 그룹으로 이동"),epoch=sidebarEpoch;
  for(const group of [{id:null,name:"그룹 없음"},...sidebarState.groups]) {
    const button=document.createElement("button");button.type="button";button.className="sidebar-group-option";
    const selected=(room.groupId||null)===group.id;button.textContent=group.name+(selected?" ✓":"");button.setAttribute("aria-pressed",String(selected));
    button.onclick=async()=>{
      if(epoch!==sidebarEpoch)return;if(selected){dialog.close();return;}
      $$("button",dialog).forEach(item=>item.disabled=true);
      if(await updateRoomListPreference(room,{groupId:group.id}))dialog.close();
      else $$("button",dialog).forEach(item=>item.disabled=false);
    };dialog.append(button);
  }
  const close=document.createElement("button");close.type="button";close.textContent="취소";close.onclick=()=>dialog.close();dialog.append(close);dialog.showModal();
}
async function updateRoomListPreference(room, changes) {
  const userId=state.session?.user?.id,epoch=sidebarEpoch;
  try {
    const prefs=await api("/api/rooms/"+room.id+"/preferences",{method:"POST",body:JSON.stringify({pinned:!!room.pinned,archived:!!room.archived,groupId:room.groupId||null,...changes})});
    if(userId!==state.session?.user?.id||epoch!==sidebarEpoch)return false;
    const current=state.rooms.find(item=>item.id===room.id);if(!current)return false;Object.assign(current,prefs);
    if(prefs.archived && state.selectedRoom===room.id) {
      const next=state.rooms.find(r=>!r.archived);
      if(next) await selectRoom(next.id); else showEmpty();
    }
    if(prefs.archived) {
      state.extra=state.extra.filter(p=>p.roomId!==room.id);
      renderExtraPanes();
    }
    renderRooms();return true;
  } catch(error) {if(userId===state.session?.user?.id&&epoch===sidebarEpoch)toast(error.message);return false;}
}
function sidebarRoomButton(room) {
  const button=document.createElement("button");button.dataset.dockRoom=room.id;button.draggable=false;button.type="button";
  const openIds=new Set([state.selectedRoom,...state.extra.map(pane=>pane.roomId)]);button.className=`room-item ${openIds.has(room.id)?"is-active":""}`;button.dataset.roomId=room.id;
  const roomIcon=document.createElement("span");roomIcon.className="room-icon";roomIcon.append(icon("agent"));
  const copy=document.createElement("span");copy.className="room-item-copy";
  const name=document.createElement("strong");name.textContent=(room.pinned?"· ":"")+room.name;
  const meta=document.createElement("small");meta.textContent=`${room.memberCount||0}명 · ${room.description||"공동 대화"}`;
  copy.append(name,meta);button.append(roomIcon,copy);button.addEventListener("click",()=>{if(state.focusPane>0)assignExtra(state.focusPane-1,room.id);else selectRoom(room.id);closeSidebar();});return button;
}
function renderRooms() {
  const focused=els.roomList.contains(document.activeElement)?{roomId:document.activeElement.dataset.roomId,groupId:document.activeElement.dataset.groupId}:null;
  renderAgentLinks();els.roomList.replaceChildren();$("#create-sidebar-group").disabled=!sidebarState.loaded||sidebarState.groups.length>=20;
  const query=$("#room-search").value.trim().toLocaleLowerCase(),groups=sidebarState.groups;
  const visibleRooms=state.rooms.filter(room=>!!room.archived===showDeletedRooms&&(showDeletedRooms||room.id!==MONITOR_ROOM)&&[room.name,room.description,groups.find(group=>group.id===room.groupId)?.name].join(" ").toLocaleLowerCase().includes(query));
  if(query&&!visibleRooms.length){const empty=document.createElement("p");empty.className="search-empty";empty.textContent="검색 결과가 없습니다.";els.roomList.append(empty);}
  const appendRooms=(target,rooms)=>rooms.forEach(room=>target.append(sidebarRoomButton(room)));
  if(showDeletedRooms)appendRooms(els.roomList,visibleRooms);
  else {
    const pinned=visibleRooms.filter(room=>room.pinned);if(pinned.length){const heading=document.createElement("div");heading.className="room-section-label";heading.textContent="고정";els.roomList.append(heading);appendRooms(els.roomList,pinned);}
    for(const group of groups) {
      const rooms=visibleRooms.filter(room=>!room.pinned&&room.groupId===group.id);
      if(query&&!rooms.length)continue;
      const section=document.createElement("section");section.className="room-group";
      const header=document.createElement("div");header.className="room-group-header";
      const toggle=document.createElement("button");toggle.type="button";toggle.className="room-group-toggle";toggle.dataset.groupId=group.id;const expanded=!!query||!group.collapsed;toggle.setAttribute("aria-expanded",String(expanded));toggle.setAttribute("aria-controls","room-group-"+group.id);
      const name=document.createElement("span");name.textContent=group.name;const count=document.createElement("small");count.textContent=String(rooms.length);toggle.append(name,count);
      toggle.onclick=()=>{void saveSidebar({...sidebarState,groups:sidebarState.groups.map(item=>item.id===group.id?{...item,collapsed:!item.collapsed}:item)});};
      const menu=document.createElement("button");menu.type="button";menu.className="room-group-menu";menu.textContent="…";menu.setAttribute("aria-label",group.name+" 그룹 관리");menu.onclick=()=>openSidebarGroupMenu(group);header.append(toggle,menu);
      const list=document.createElement("div");list.id="room-group-"+group.id;list.hidden=!expanded;appendRooms(list,rooms);
      if(!rooms.length){const empty=document.createElement("p");empty.className="room-group-empty";empty.textContent="대화를 우클릭해 이 그룹으로 옮기세요.";list.append(empty);}
      section.append(header,list);els.roomList.append(section);
    }
    const ungrouped=visibleRooms.filter(room=>!room.pinned&&!groups.some(group=>group.id===room.groupId));
    if(groups.length&&ungrouped.length){const heading=document.createElement("div");heading.className="room-section-label";heading.textContent="그룹 없음";els.roomList.append(heading);}
    appendRooms(els.roomList,ungrouped);
  }
  const trash=document.createElement("button");trash.className="deleted-rooms-toggle";trash.textContent=showDeletedRooms?"← 대화 목록":"삭제한 대화"+(state.rooms.some(room=>room.archived)?" ("+state.rooms.filter(room=>room.archived).length+")":"");trash.onclick=()=>{showDeletedRooms=!showDeletedRooms;renderRooms();};els.roomList.append(trash);
  if(focused){const target=$$("button",els.roomList).find(button=>(focused.roomId&&button.dataset.roomId===focused.roomId)||(focused.groupId&&button.dataset.groupId===focused.groupId));target?.focus({preventScroll:true});}
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
  closeContextPopover();
  const previous = state.selectedRoom;
  if(previous!==id && !matchMedia("(prefers-reduced-motion: reduce)").matches) els.roomView.animate([{opacity:.35,transform:"translateY(7px)"},{opacity:1,transform:"translateY(0)"}],{duration:320,easing:"cubic-bezier(.2,.8,.2,1)"});
  state.extra.forEach((pane) => {
    if (pane.roomId === id) pane.roomId = previous && previous !== id ? previous : null;
  });
  state.selectedRoom = id;
  clearThinking(els.sendingStatus);
  const prefs = roomPreferences(id);
  $("#model-select").dataset.chosen = prefs.model || "";
  $("#effort-select").value = prefs.effort || "";
  applyModels(state.models);
  try {
    sessionStorage.setItem("community-room:" + state.session.user.id, id);
  } catch {}
  state.roomData = null;
  syncProgressStreams();
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
    els.roomTitle.textContent = room.id===MONITOR_ROOM?"대시보드":room.name;
    els.mobileRoomTitle.textContent = room.name;
    els.roomDescription.textContent = room.description || "";
    const canInvite = !room.personal && room.id !== MONITOR_ROOM &&
      (room.role === "owner" || state.session.user.role === "admin");
    els.roomKicker.textContent = room.personal ? "개인 비서 · 연결 서비스" : canInvite ? "방장" : "공동 대화";
    $("#room-invite-button").classList.toggle("is-hidden", !canInvite);
  }
  els.roomView.classList.toggle("is-host-dashboard", id === MONITOR_ROOM);
  updateBotLabel();
  if (state.layout > 1) {
    renderExtraPanes();
    refreshExtras();
  }
  await refreshRoom(true);
  startPolling();
}
function renderHostDashboard(snapshot) {
  const panel = document.createElement("section");
  panel.className = "host-dashboard";
  const element = (tag, text, className) => { const node=document.createElement(tag); node.textContent=text; if(className)node.className=className; return node; };
  panel.append(element("h2", "서버 대시보드"), element("p", "연결된 호스트 전체 사용량", "host-subtitle"));
  if (!snapshot.available || snapshot.scope !== "a1-host") {
    panel.append(element("p", "최신 서버 상태를 받지 못했습니다. 잠시 후 자동으로 다시 확인합니다.", "host-warning"));
  } else {
    const format = n => Number(n).toFixed(1);
    const cards = element("div", "", "host-cards");
    const metrics = [
      ["CPU", `${format(snapshot.cpuUsedPercent)}%`, `${snapshot.cpuCount} OCPU 전체`, snapshot.cpuUsedPercent],
      ["메모리", `${format(snapshot.memoryUsedGiB)} GiB`, `OS 사용 가능 ${format(snapshot.memoryTotalGiB)} GiB`, snapshot.memoryUsedGiB / snapshot.memoryTotalGiB * 100],
      ["전체 디스크", `${format(snapshot.diskUsedPercent)}%`, `${format(snapshot.diskUsedGiB)} / ${format(snapshot.diskTotalGiB)} GiB 사용`, snapshot.diskUsedPercent],
    ];
    for (const [label,value,detail,percent] of metrics) {
      const card=element("article", "", "host-card");
      card.append(element("h3",label),element("strong",value),element("p",detail));
      const meter=document.createElement("progress"); meter.max=100; meter.value=Math.min(100,Math.max(0,percent)); meter.setAttribute("aria-label",label+" 사용률");card.append(meter);cards.append(card);
    }
    panel.append(cards);
    const storage=element("section","","host-storage");
    storage.append(element("h3","디스크 공간"),element("p",`파일시스템 여유 ${format(snapshot.diskFreeGiB)} GiB · 미할당 ${format(snapshot.diskUnallocatedGiB)} GiB`));
    if(snapshot.diskUnallocatedGiB>1) storage.append(element("p","미할당 공간은 파티션 확장 전까지 파일 저장에 사용할 수 없습니다.","host-subtitle"));
    for (const fs of snapshot.filesystems) {
      const row=element("div","","host-filesystem");
      row.append(element("strong",fs.mount),element("span",`${format(fs.usedGiB)} / ${format(fs.totalGiB)} GiB · 여유 ${format(fs.freeGiB)} GiB`));
      if(fs.usedPercent>=85) row.append(element("span","공간 부족 주의","host-warning"));
      storage.append(row);
    }
    panel.append(storage,element("p",`최근 측정 ${new Date(snapshot.timestamp).toLocaleString('ko-KR')} · 자동 갱신`,"host-subtitle"));
  }
  els.messages.replaceChildren(panel);
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
    if (roomId === MONITOR_ROOM) {
      const snapshot = await api("/api/admin/monitor");
      if (state.selectedRoom === roomId && request === state.roomRequest) renderHostDashboard(snapshot);
      return;
    }
    const data = await api(`/api/rooms/${encodeURIComponent(roomId)}`);
    if (
      state.selectedRoom !== roomId ||
      state.session?.user?.id !== userId ||
      request !== state.roomRequest
    )
      return;
    const unchanged = JSON.stringify(state.roomData) === JSON.stringify(data);
    state.roomData = data;
    syncProgressStreams();
    if (!unchanged) {
      renderRoom(data);
      if(nearBottom) els.messages.scrollTo({top:els.messages.scrollHeight,behavior:force?"instant":"smooth"});
      else els.messages.scrollTop=scrollTop;
    }
  } catch (error) {
    if (request !== state.roomRequest) return;
    if (error.status === 401) {
      state.session = null;
      showAuth();
    } else {
      if (error.status === 403 || error.status === 404) {
        state.roomData = null;
        syncProgressStreams();
        clearThinking(els.sendingStatus);
      }
      toast(error.message);
    }
  } finally {
    if (request === state.roomRequest) state.pollBusy = false;
  }
}
function startPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = setInterval(() => {
    refreshRoom();
    refreshExtras();
  }, 3000);
}
function stopPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = null;
  stopProgressStreams();
}
function renderRoom(data) {
  if(data.room) {const room=state.rooms.find(r=>r.id===data.room.id);if(room&&room.name!==data.room.name){room.name=data.room.name;els.roomTitle.textContent=room.name;renderRooms();}}
  renderContextMeter(data.context);
  const previousNodes=new Map([...els.messages.children].filter(el=>el.dataset.messageId).map(el=>[el.dataset.messageId,el]));
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
    messages.forEach((message) => els.messages.append(previousNodes.get(message.id) || createMessage(message)));
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
  els.roomView.classList.toggle("agent-working",!!data.busy);
  if (data.busy) {
    els.messages.append(thinkingRow());
    clearThinking(els.sendingStatus);
  } else if (!state.sending) {
    clearThinking(els.sendingStatus);
  }
}
// Public execution milestones only: labels come from actual server operations.
const progressStreams = new Map();
function visibleProgressRooms() {
  const visible = new Map();
  if (state.session?.user && state.selectedRoom && state.selectedRoom !== MONITOR_ROOM && state.roomData?.busy)
    visible.set(state.selectedRoom, state.roomData);
  for (const pane of state.extra) {
    if (state.session?.user && pane.roomId && pane.data?.room?.id === pane.roomId && pane.data.busy)
      visible.set(pane.roomId, pane.data);
  }
  return visible;
}
function stopProgressStreams() {
  for (const entry of progressStreams.values()) entry.source?.close();
  progressStreams.clear();
  clearThinking(els.sendingStatus);
}
function addProgress(entry, event) {
  if (!event || typeof event.stage !== "string" || typeof event.label !== "string") return;
  const milestone = { stage: event.stage, label: event.label.slice(0, 240), at: event.at };
  if (entry.events.some(item => item.stage === milestone.stage && item.label === milestone.label && item.at === milestone.at)) return;
  entry.events.push(milestone);
  entry.events.sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0));
  entry.events = entry.events.slice(-40);
}
function refreshProgressRoom(roomId) {
  if (state.selectedRoom === roomId) void refreshRoom(true);
  state.extra.forEach((pane, index) => {
    if (pane.roomId === roomId) void refreshExtra(index);
  });
}
function syncProgressStreams() {
  const visible = visibleProgressRooms();
  for (const [roomId, entry] of progressStreams) {
    if (!visible.has(roomId)) {
      entry.source?.close();
      progressStreams.delete(roomId);
    }
  }
  for (const [roomId, data] of visible) {
    let entry = progressStreams.get(roomId);
    if (!entry) {
      entry = { events: [], source: null, retryAt: 0 };
      progressStreams.set(roomId, entry);
    }
    for (const event of Array.isArray(data.progress) ? data.progress : []) addProgress(entry, event);
    if (!entry.source && Date.now() >= entry.retryAt && typeof EventSource !== "undefined") {
      const source = new EventSource(`/api/rooms/${encodeURIComponent(roomId)}/progress`);
      entry.source = source;
      source.addEventListener("open", () => {
        if (progressStreams.get(roomId) !== entry || entry.source !== source) return;
        renderProgressRoom(roomId);
      });
      source.addEventListener("progress", event => {
        if (progressStreams.get(roomId) !== entry || entry.source !== source) return;
        try { addProgress(entry, JSON.parse(event.data)); } catch { return; }
        renderProgressRoom(roomId);
      });
      source.addEventListener("done", () => {
        if (progressStreams.get(roomId) !== entry || entry.source !== source) return;
        source.close();
        entry.source = null;
        entry.retryAt = Date.now() + 3000;
        refreshProgressRoom(roomId);
      });
      source.addEventListener("error", () => {
        if (progressStreams.get(roomId) !== entry || entry.source !== source) return;
        // Recheck membership/session through the API; polling controls bounded retries.
        source.close();
        entry.source = null;
        entry.retryAt = Date.now() + 6000;
        renderProgressRoom(roomId);
        refreshProgressRoom(roomId);
      });
    }
    renderProgressRoom(roomId);
  }
}
function renderProgressRoom(roomId) {
  for (const target of $$("[data-progress-room]")) {
    if (target.dataset.progressRoom === roomId) renderProgressTarget(target, roomId);
  }
}
function renderProgressTarget(target, roomId) {
  const entry = progressStreams.get(roomId);
  const events = entry?.events || [];
  const label = events.at(-1)?.label || "진행 상황을 연결하는 중";
  const line = $(".think-line", target);
  if (line && line.textContent !== label) line.textContent = label;
}
function thinkParts() {
  const mark = document.createElement("span");
  mark.className = "think-mark";
  mark.setAttribute("aria-hidden", "true");
  for (let i = 0; i < 3; i += 1) mark.append(document.createElement("i"));
  const line = document.createElement("span");
  line.className = "think-line";
  const caret = document.createElement("span");
  caret.className = "think-caret";
  caret.setAttribute("aria-hidden", "true");
  return [mark, line, caret];
}
function showThinking(target, fixed, roomId = state.selectedRoom) {
  target.replaceChildren();
  target.classList.add("is-visible");
  const [mark, line, caret] = thinkParts();
  target.append(mark, line, caret);
  if (fixed) {
    delete target.dataset.progressRoom;
    line.textContent = fixed;
  } else {
    target.dataset.progressRoom = roomId;
    renderProgressTarget(target, roomId);
  }
}
function clearThinking(target) {
  target.replaceChildren();
  target.classList.remove("is-visible");
  delete target.dataset.progressRoom;
}
function thinkingRow(roomId = state.selectedRoom) {
  const article = document.createElement("article");
  article.className = "message message-bot message-thinking";
  article.setAttribute("aria-label", "에이전트 진행 상황");
  const avatar = document.createElement("div");
  avatar.className = "avatar avatar-bot";
  avatar.append(icon("spark"));
  const body = document.createElement("div");
  body.className = "message-body";
  const bubble = document.createElement("div");
  bubble.className = "think-bubble";
  bubble.dataset.progressRoom = roomId;
  bubble.append(...thinkParts());
  renderProgressTarget(bubble, roomId);
  body.append(bubble);
  article.append(avatar, body);
  return article;
}
const animatedMessages = new Set();
function createMessage(message) {
  const article = document.createElement("article");
  if(message.id)article.dataset.messageId=message.id;
  const own =
    message.kind === "human" && message.authorId === state.session?.user?.id;
  article.className = `message message-${message.kind}${own ? " message-own" : ""}`;
  if(message.id && Date.now()-message.createdAt<15000 && !animatedMessages.has(message.id)){article.classList.add("message-enter");animatedMessages.add(message.id);if(animatedMessages.size>500)animatedMessages.delete(animatedMessages.values().next().value);}
  const avatar = document.createElement("div");
  avatar.className = `avatar ${message.kind === "bot" ? "avatar-bot" : ""}`;
  if (message.kind === "bot") avatar.append(icon("agent"));
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
    const text = message.kind === "bot" ? renderMessageText(message.text) : document.createElement("p");
    if(message.kind !== "bot")text.textContent = message.text;
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
      state.botChoiceTouched = true;
      updateBotLabel();
    });
    const copy = document.createElement("span");
    const name = document.createElement("strong");
    name.textContent = bot.name;
    const desc = document.createElement("small");
    desc.textContent = bot.description || "";
    copy.append(name, desc);
    label.append(checkbox, icon("agent"), copy);
    picker.append(label);
  });
  updateBotLabel();
}
function updateBotLabel() {
  $("#bot-picker-label").textContent = "";
  $("#bot-picker-label").hidden = true;
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
  if (!state.selectedRoom || roomContextOwner().busy) return;
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
    model: $("#model-select").value,
    effort: $("#effort-select").value,
  });
  state.sending = true;
  updateModelAvailability();
  $("#send-button").disabled = true;
  input.disabled = true;
  showThinking(els.sendingStatus, "메시지를 보내는 중");
  try {
    const result = await api(`/api/rooms/${encodeURIComponent(roomId)}/messages`, {
      method: "POST",
      body: payload,
      retryable: true,
    });
    if (Array.isArray(result.models)) applyModels(result.models);
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
    if (!state.roomData?.busy) clearThinking(els.sendingStatus);
    input.focus();
    updateModelAvailability();
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
let creatingSession=false;
async function startNewSession() {
  if(creatingSession)return;creatingSession=true;
  try {const data=await api("/api/rooms",{method:"POST",body:JSON.stringify({})});await loadRooms();await selectRoom(data.room.id);$("#message-input").focus();}
  catch(error){toast(error.message);}finally{creatingSession=false;}
}
async function openCapabilityHub() {
  let dialog=$("#capability-hub");
  if(!dialog){dialog=document.createElement("dialog");dialog.id="capability-hub";dialog.className="capability-hub";document.body.append(dialog);}
  dialog.replaceChildren();
  const title=document.createElement("h2");title.textContent="통합 관리";
  const close=document.createElement("button");close.textContent="닫기";close.onclick=()=>dialog.close();dialog.append(title,close);
  const sessions=document.createElement("section"), sessionTitle=document.createElement("h3"), sessionNote=document.createElement("p"), reset=document.createElement("button");
  sessionTitle.textContent="대화 세션";
  sessionNote.textContent="내 대화 목록을 비우고 새 세션을 시작합니다. 기존 기록은 ‘삭제한 대화’에서 복원할 수 있습니다.";
  reset.textContent="대화 목록 초기화";
  reset.onclick=async()=>{
    setBusy(reset,true,"초기화하는 중…");
    try {
      const data=await api("/api/sessions/reset",{method:"POST",body:"{}"});
      dialog.close();
      stopProgressStreams();
      if(state.layout>1)setLayout(state.layout);
      dockRects=[{x:0,y:0,w:1,h:1}];applyDockLayout();
      showDeletedRooms=false;$("#room-search").value="";$("#message-input").value="";state.pendingSend=null;
      await loadRooms();await selectRoom(data.room.id);
      toast(`${data.archived || 0}개 대화를 보관하고 새 세션을 시작했습니다.`);
    } catch(error){toast(error.message);} finally{setBusy(reset,false);}
  };
  sessions.append(sessionTitle,sessionNote,reset);dialog.append(sessions);dialog.showModal();
  try {
    const data=await api("/api/admin/capabilities");
    for(const [name,items] of [["API",[...new Set(data.providers.map(p=>p.name))]],["Vault",data.services.map(s=>`${s.name} · ${s.configured?"키 등록됨":"미등록"}`)],["MCP",["연결된 MCP 서버 없음"]],["스킬",["실행 연결된 스킬 없음"]]]) {
      const section=document.createElement("section"),h=document.createElement("h3");h.textContent=name;section.append(h);
      for(const text of items){const row=document.createElement("p");row.textContent=text;section.append(row);}dialog.append(section);
    }
    const note=document.createElement("p");note.textContent=data.note;dialog.append(note);
  }catch(error){const note=document.createElement("p");note.textContent=error.message;dialog.append(note);}
}
const modelChanges = new Map();
function roomContextOwner(pane = null) {
  const roomId=pane?pane.roomId:state.selectedRoom,data=pane?pane.data:state.roomData;
  const working=!!(data?.busy||(pane?pane.sending:state.sending));
  const role=data?.room?.role || state.rooms?.find(room=>room.id===roomId)?.role;
  return {roomId,data,working,busy:working||modelChanges.has(roomId),canManage:role==="owner"};
}
function contextOwnerCurrent(roomId, userId, pane = null) {
  return state.session?.user?.id === userId && (pane ? state.extra.includes(pane) && pane.roomId === roomId : state.selectedRoom === roomId);
}
async function refreshContextOwner(pane) {
  if (pane) await refreshExtra(state.extra.indexOf(pane));
  else await refreshRoom(true);
}
async function sessionAction(action, pane = null, button = null) {
  const {roomId, busy} = roomContextOwner(pane), userId=state.session?.user?.id;
  if (!roomId || roomId===MONITOR_ROOM || busy) return;
  if(action==="compact"&&!roomContextOwner(pane).canManage)return;
  button ||= $(action==="fork"?"#fork-session":"#compact-session");
  if (button) button.disabled=true;
  try {
    const data=await api(`/api/rooms/${encodeURIComponent(roomId)}/${action}`,{method:"POST",body:"{}"});
    if (!contextOwnerCurrent(roomId,userId,pane)) return;
    if(action==="fork") {
      await loadRooms();
      if (!contextOwnerCurrent(roomId,userId,pane)) return;
      if (pane) assignExtra(state.extra.indexOf(pane),data.room.id);
      else await selectRoom(data.room.id);
      toast("맥락을 이어받은 새 세션을 만들었습니다.");
    } else {
      await refreshContextOwner(pane);
      toast("기록은 보존하고 대화 맥락을 압축했습니다.");
    }
  } catch(error){toast(error.message);}
  finally {if(button?.isConnected){const owner=roomContextOwner(pane);button.disabled=owner.busy||(action==="compact"&&(!owner.canManage||!(owner.data?.context?.usedChars>=500)));}}
}
function contextNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value.toLocaleString("ko-KR") : "확인 불가";
}
function contextPercent(context) {
  return Math.min(100,Math.max(0,Math.round((context?.usedChars||0)/(context?.budgetChars||8000)*100)));
}
function contextElement(tag, text, className) {
  const element=document.createElement(tag);if(text!==undefined)element.textContent=text;if(className)element.className=className;return element;
}
function renderContextMeter(context, form = $("#composer-form"), pane = null) {
  if(!form)return;
  let bar=$(".context-controls",form);
  if(!bar) {
    bar=contextElement("div",undefined,"context-controls");
    const fork=contextElement("button","Fork","context-action");fork.type="button";fork.setAttribute("aria-label","맥락을 이어받아 새 세션 만들기");fork.onclick=()=>sessionAction("fork",pane,fork);
    const compact=contextElement("button","Compact","context-action");compact.type="button";compact.setAttribute("aria-label","대화 맥락 압축");compact.onclick=()=>sessionAction("compact",pane,compact);
    const trigger=contextElement("button",undefined,"context-trigger");trigger.type="button";trigger.setAttribute("aria-label","컨텍스트 및 API 사용량");trigger.setAttribute("aria-haspopup","dialog");trigger.setAttribute("aria-expanded","false");
    const ring=contextElement("span",undefined,"context-ring"),label=contextElement("span",undefined,"context-label");ring.setAttribute("aria-hidden","true");label.setAttribute("aria-hidden","true");trigger.append(ring,label);trigger.onclick=()=>openContextPopover(trigger,pane);
    bar.append(fork,compact,trigger);form.append(bar);
    if(!pane){bar.id="context-controls";fork.id="fork-session";compact.id="compact-session";trigger.id="context-usage-button";ring.id="context-ring";label.id="context-label";}
  }
  const percent=contextPercent(context), owner=roomContextOwner(pane);
  $(".context-ring",bar).style.setProperty("--context",percent+"%");
  $(".context-label",bar).textContent=percent+"%";
  bar.removeAttribute("title");
  const buttons=$$(".context-action",bar);buttons[0].disabled=owner.busy;buttons[1].disabled=owner.busy||!owner.canManage||!(context?.usedChars>=500);
  buttons[1].setAttribute("aria-label",owner.canManage?"대화 맥락 압축":"대화 맥락 압축 · 세션 소유자만 가능");
  $(".context-trigger",bar).disabled=!owner.roomId;
  if(contextPopover?.roomId===owner.roomId)renderPopoverContext(contextPopover.contextSection,context);
  updateModelAvailability();
}
let contextPopover = null;
function closeContextPopover() {
  const open=contextPopover;if(!open)return;contextPopover=null;
  open.cancelled=true;open.abort.abort();open.trigger.setAttribute("aria-expanded","false");
  window.removeEventListener("resize",open.position);window.removeEventListener("scroll",open.position,true);
  try {if(open.native)open.element.hidePopover();else if(open.element.open)open.element.close();} catch {}
  open.element.remove();
}
function renderPopoverContext(section, context) {
  section.replaceChildren();
  const heading=contextElement("h3","대화 맥락"),amount=contextElement("strong",`${contextPercent(context)}%`,"context-popover-percent");
  const top=contextElement("div",undefined,"context-section-heading");top.append(heading,amount);
  const meter=document.createElement("progress");meter.max=100;meter.value=contextPercent(context);meter.setAttribute("aria-label","앱 대화 맥락 추정 사용률");
  const tokens=contextElement("p",`약 ${contextNumber(context?.estimatedTokens)} / ${contextNumber(Math.round((context?.budgetChars||8000)/2))} 토큰 · 추정`,"context-muted");
  const breakdown=contextElement("div",undefined,"context-breakdown");
  for(const [label,value] of [["최근 대화",context?.messageTokens],["압축 요약",context?.summaryTokens]]) {
    const row=contextElement("div");row.append(contextElement("span",label),contextElement("span",`${contextNumber(value)} 토큰`));breakdown.append(row);
  }
  section.append(top,meter,tokens,breakdown,contextElement("p","앱이 다음 요청에 담는 대화 범위입니다. 시스템 지시·도구·이미지와 모델 전체 컨텍스트 창은 제외됩니다.","context-note"));
}
function usageTime(value) {
  const date=new Date(value);return value!=null&&!Number.isNaN(date.getTime())?date.toLocaleString("ko-KR",{month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"}):"시각 확인 불가";
}
function renderUsageSection(section, usage) {
  section.replaceChildren(contextElement("h3","이 대화의 API 기록"));
  const counts=contextElement("div",undefined,"context-usage-counts");
  for(const [label,value] of [["입력 토큰",usage.inputTokens],["출력 토큰",usage.outputTokens],["API 응답",usage.requests]]) {
    const item=contextElement("div");item.append(contextElement("strong",contextNumber(value)),contextElement("span",label));counts.append(item);
  }
  section.append(counts);
  if(usage.last) section.append(contextElement("p",`최근 ${usage.last.provider || "공급자 미제공"} · ${usage.last.model || "모델 미제공"}`,"context-note"));
  else section.append(contextElement("p","기록된 API 호출이 없습니다.","context-note"));
  const providers=(Array.isArray(usage.providers)?[...usage.providers]:[]).sort((a,b)=>new Date(b.at)-new Date(a.at));
  if(providers.length) {
    const quota=contextElement("section",undefined,"context-quota");quota.append(contextElement("h3","공급자 한도"));
    const selector=contextElement("select",undefined,"context-provider-select");selector.setAttribute("aria-label","공급자와 API 키 선택");
    providers.forEach((provider,index)=>{
      const slot=Number.isInteger(provider.keySlot)?provider.keySlot+1:"확인 불가";
      selector.append(new Option(`${provider.provider || "공급자"} · 키 ${slot}`,String(index)));
    });
    const values=contextElement("div");
    function showProvider() {
      const provider=providers[Number(selector.value)||0],groq=String(provider.provider).toLowerCase()==="groq";
      values.replaceChildren(contextElement("p",`${usageTime(provider.at)} 기준${groq?" · 조직 공유":""}`,"context-note"));
      for(const [key,label] of [["requests","요청"],["tokens","토큰"]]) {
        const limit=provider.limits?.[key],row=contextElement("div",undefined,"context-quota-row");
        const value=limit?`${contextNumber(limit.remaining)} / ${contextNumber(limit.limit)} 남음`:"공급자 미제공";
        row.append(contextElement("span",label+(groq?(key==="requests"?" / 일":" / 분"):"")),contextElement("span",value));values.append(row);
        if(limit?.reset!=null)values.append(contextElement("p",`갱신: ${String(limit.reset).slice(0,100)}`,"context-note"));
      }
      contextPopover?.position();
    }
    selector.onchange=showProvider;showProvider();quota.append(selector,values);section.append(quota);
  }
  const scope=contextElement("details",undefined,"context-scope-note");scope.append(contextElement("summary","집계 기준"));
  scope.append(contextElement("p","기록 시작 이후 이 대화의 API 응답만 집계합니다. 전체 계정 사용량이나 청구액은 아닙니다. 공급자 한도는 마지막 응답 시점의 값입니다.","context-note"));
  if(usage.quotaNote)scope.append(contextElement("p",usage.quotaNote,"context-note"));
  else if(!providers.length)scope.append(contextElement("p","제공된 공급자 잔여 한도 정보가 없습니다.","context-note"));
  scope.addEventListener("toggle",()=>contextPopover?.position());section.append(scope);
}
async function openContextPopover(trigger,pane) {
  if(contextPopover?.trigger===trigger){closeContextPopover();return;}
  closeContextPopover();
  const {roomId,data}=roomContextOwner(pane),userId=state.session?.user?.id;if(!roomId)return;
  const native=typeof HTMLElement.prototype.showPopover==="function";
  const element=contextElement(native?"div":"dialog",undefined,"context-popover");element.setAttribute("role","dialog");element.setAttribute("aria-label","컨텍스트 및 API 사용량");if(native)element.setAttribute("popover","auto");
  const header=contextElement("header"),title=contextElement("h2","컨텍스트 및 API 사용량"),close=contextElement("button","×","context-popover-close");close.type="button";close.setAttribute("aria-label","사용량 닫기");close.onclick=closeContextPopover;header.append(title,close);
  const contextSection=contextElement("section"),usageSection=contextElement("section",undefined,"context-api-section");renderPopoverContext(contextSection,data?.context);usageSection.append(contextElement("p","API 기록을 확인하는 중…","context-muted"));
  element.append(header,contextSection,usageSection);document.body.append(element);
  const open={element,trigger,roomId,pane,userId,native,contextSection,cancelled:false,abort:new AbortController()};
  open.position=()=>{
    if(!trigger.isConnected){closeContextPopover();return;}
    const rect=trigger.getBoundingClientRect(),width=element.offsetWidth,height=element.offsetHeight;
    element.style.left=Math.max(12,Math.min(innerWidth-width-12,rect.right-width))+"px";
    element.style.top=Math.max(12,Math.min(innerHeight-height-12,rect.top-height-10))+"px";
  };
  contextPopover=open;trigger.setAttribute("aria-expanded","true");
  if(native){element.addEventListener("toggle",event=>{if(event.newState==="closed"&&contextPopover===open)closeContextPopover();});element.showPopover();}
  else {element.addEventListener("close",()=>{if(contextPopover===open)closeContextPopover();});element.showModal();element.addEventListener("click",event=>{if(event.target===element){const r=element.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)closeContextPopover();}});}
  open.position();window.addEventListener("resize",open.position);window.addEventListener("scroll",open.position,true);
  try {
    const usage=await api(`/api/rooms/${encodeURIComponent(roomId)}/usage`,{signal:open.abort.signal});
    if(open.cancelled||contextPopover!==open||!contextOwnerCurrent(roomId,userId,pane))return;
    renderUsageSection(usageSection,usage);open.position();
  }catch(error){if(!open.cancelled){usageSection.replaceChildren(contextElement("p","API 기록을 불러오지 못했습니다. 다시 열어 확인해주세요.","context-note"));open.position();}}
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
function roomPreferences(id) {
  try { return JSON.parse(localStorage.getItem("community-model:" + state.session.user.id + ":" + id) || "{}"); } catch { return {}; }
}
function saveRoomPreferences(id, prefs) {
  if (!id) return;
  try { localStorage.setItem("community-model:" + state.session.user.id + ":" + id, JSON.stringify(prefs)); } catch {}
}
function updateModelAvailability() {
  for(const select of $$(".model-select")) {
    const pane=select._pane||null,owner=roomContextOwner(pane);
    const disabled=!owner.roomId||owner.busy;
    select.disabled=disabled;
    if(select._triggerButton)select._triggerButton.disabled=disabled;
    if(select._moreButton)select._moreButton.disabled=disabled||!state.models.length;
    const form=select.closest("form");
    if(form) {
      const send=$('button[type="submit"]',form);if(send)send.disabled=disabled;
      const actions=$$(".context-action",form);
      if(actions[0])actions[0].disabled=owner.busy;
      if(actions[1])actions[1].disabled=owner.busy||!owner.canManage||!(owner.data?.context?.usedChars>=500);
    }
  }
}
function confirmModelChange(label,canReset) {
  return new Promise(resolve=>{
    const dialog=contextElement("dialog",undefined,"model-change-dialog");dialog.setAttribute("aria-labelledby","model-change-title");
    const title=contextElement("h2","모델을 변경할까요?");title.id="model-change-title";
    const next=contextElement("p",label,"model-change-name");
    const note=contextElement("p","기록은 그대로 남습니다. 맥락을 초기화하면 이전 대화와 압축 요약을 다음 요청에 보내지 않습니다.","context-note");
    const actions=contextElement("div",undefined,"model-change-actions");
    let choice=null;
    for(const [value,text] of [["keep","맥락 유지하고 변경"],["reset","맥락 초기화 후 변경"],[null,"취소"]]) {
      const button=contextElement("button",text);button.type="button";button.disabled=value==="reset"&&!canReset;
      button.onclick=()=>{choice=value;dialog.close();};actions.append(button);
    }
    dialog.append(title,next,note);
    if(!canReset)dialog.append(contextElement("p","맥락 초기화는 세션 소유자만 할 수 있습니다.","context-note"));
    dialog.append(actions);dialog.addEventListener("close",()=>{dialog.remove();resolve(choice);},{once:true});
    document.body.append(dialog);dialog.showModal();
  });
}
async function requestModelChange(select, value) {
  const pane=select._pane||null,{roomId,busy}=roomContextOwner(pane),userId=state.session?.user?.id;
  const previous=select.dataset.chosen ?? select.value;
  select.value=previous;
  if(!roomId||!select.isConnected||busy||value===previous)return;
  const operation=Symbol("model-change");modelChanges.set(roomId,operation);select._changingModel=operation;updateModelAvailability();
  const stillCurrent=()=>select.isConnected&&contextOwnerCurrent(roomId,userId,pane);
  try {
    const model=state.models.find(item=>item.value===value);
    const choice=await confirmModelChange(value?(model?modelLabel(model):value):"자동 선택 · 추천",roomContextOwner(pane).canManage);
    if(!choice||!stillCurrent())return;
    if(roomContextOwner(pane).working){toast("답변이 끝난 뒤 모델을 변경해주세요.");return;}
    if(choice==="reset") {
      if(!roomContextOwner(pane).canManage)return;
      await api(`/api/rooms/${encodeURIComponent(roomId)}/context-reset`,{method:"POST",body:"{}"});
      if(!stillCurrent())return;
    }
    // Commit only after confirmation and, when requested, a successful server reset.
    select.dataset.chosen=value;
    if(pane)pane.model=value;
    const effort=pane?pane.effort||"":$("#effort-select").value;
    saveRoomPreferences(roomId,{model:value,effort});
    applyModels(state.models);
    if(choice==="reset")await refreshContextOwner(pane);
  } catch(error) {if(stillCurrent())toast(error.message);}
  finally {
    if(modelChanges.get(roomId)===operation)modelChanges.delete(roomId);
    if(select._changingModel===operation)select._changingModel=false;
    if(stillCurrent())select.value=select.dataset.chosen ?? previous;
    updateModelAvailability();
  }
}
function applyModels(models) {
  if (Array.isArray(models)) state.models = models;
  const recommended = recommendedModels(state.models);
  for (const select of $$(".model-select")) {
    const chosen = select.dataset.chosen ?? select.value;
    select.replaceChildren(new Option("자동 선택 · 추천", ""));
    const visible=[...recommended];
    const current=state.models.find(model=>model.value===chosen);
    if(current&&!visible.includes(current))visible.push(current);
    for(const model of visible)select.append(new Option(modelLabel(model)+(model===current&&!recommended.includes(model)?" · 선택됨":""),model.value));
    select.value=visible.some(model=>model.value===chosen)?chosen:"";
    select.dataset.chosen=select.value;
    if(!select._triggerButton){
      const trigger=document.createElement("button");trigger.type="button";trigger.className="model-trigger";trigger.setAttribute("aria-label","모델 선택");trigger.setAttribute("aria-haspopup","dialog");
      trigger.onclick=()=>openRecommendedModels(select,trigger);select.after(trigger);select._triggerButton=trigger;select.classList.add("custom-model-select");
    }
    select._triggerButton.textContent=(select.selectedOptions[0]?.textContent||"자동 선택 · 추천")+" ▾";
    select.title="추천 모델 · 자동 선택은 연결 상태에 따라 순환합니다";
    if(!select._moreButton){
      const more=document.createElement("button");more.type="button";more.className="model-more";more.textContent="더 보기";
      more.setAttribute("aria-label","전체 모델 검색");more.setAttribute("aria-haspopup","dialog");
      more.onclick=()=>openModelBrowser(select,more);
      select.parentElement.after(more);select._moreButton=more;
    }
    select._moreButton.disabled=!state.models.length;
  }
  updateModelAvailability();
}
function openRecommendedModels(select,trigger){
  if(select.disabled)return;
  const dialog=document.createElement("dialog");dialog.className="quick-model-picker";dialog.setAttribute("aria-label","추천 모델 선택");
  const title=document.createElement("h2");title.textContent="추천 모델";dialog.append(title);
  const entries=[{value:"",id:"",name:"자동 선택 · 추천"},...recommendedModels(state.models)];
  const current=state.models.find(m=>m.value===select.value);if(current&&!entries.some(m=>m.value===current.value))entries.push(current);
  for(const model of entries){const button=document.createElement("button");button.type="button";button.className="quick-model-option";button.textContent=(model.value?modelLabel(model):model.name)+(select.value===model.value?" ✓":"");button.setAttribute("aria-pressed",String(select.value===model.value));button.onclick=()=>{dialog.close();void requestModelChange(select,model.value);};dialog.append(button);}
  const more=document.createElement("button");more.type="button";more.className="quick-model-more";more.textContent="전체 모델 검색 →";more.onclick=()=>{dialog.close();openModelBrowser(select,trigger);};dialog.append(more);
  const close=document.createElement("button");close.type="button";close.className="quick-model-more";close.textContent="닫기";close.onclick=()=>dialog.close();dialog.append(close);
  dialog.onclose=()=>{dialog.remove();if(trigger.isConnected&&!$("dialog[open]"))trigger.focus();};
  dialog.addEventListener("click",event=>{if(event.target===dialog){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.close();}});
  document.body.append(dialog);dialog.showModal();
}
let modelBrowser;
function openModelBrowser(select,trigger) {
  if(select.disabled)return;
  if(!modelBrowser){
    modelBrowser=document.createElement("dialog");modelBrowser.className="model-browser";modelBrowser.setAttribute("aria-labelledby","model-browser-title");
    modelBrowser.innerHTML='<header><div><span class="picker-eyebrow">MODEL LIBRARY</span><h2 id="model-browser-title">어떤 모델과 대화할까요?</h2></div><button type="button" class="model-browser-close" aria-label="모델 선택 닫기">×</button></header><input class="model-search" type="search" placeholder="모델 또는 공급자 검색" aria-label="모델 또는 공급자 검색"><p class="model-count" role="status"></p><div class="model-results"></div><button class="model-load-more" type="button">더 불러오기</button>';
    document.body.append(modelBrowser);
    $(".model-browser-close",modelBrowser).onclick=()=>modelBrowser.close();
    modelBrowser.addEventListener("click",event=>{if(event.target===modelBrowser){const r=modelBrowser.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)modelBrowser.close();}});
  }
  const search=$(".model-search",modelBrowser), results=$(".model-results",modelBrowser), load=$(".model-load-more",modelBrowser);
  let count=60;
  const recommended=new Set(recommendedModels(state.models).map(m=>m.value));
  function render(){
    const matching=filterModels(state.models,search.value);
    results.replaceChildren();
    $(".model-count",modelBrowser).textContent=matching.length?`${matching.length}개 모델 · ${Math.min(count,matching.length)}개 표시`:"일치하는 모델이 없어요. 다른 이름이나 공급자로 검색해 보세요.";
    for(const model of matching.slice(0,count)){
      const button=document.createElement("button");button.type="button";button.className="model-card";button.setAttribute("aria-pressed",String(select.value===model.value));
      const name=document.createElement("strong"),detail=document.createElement("span"),badge=document.createElement("small");
      name.textContent=modelLabel(model);detail.textContent=(model.providers||[]).join(" · ");badge.textContent=select.value===model.value?"선택됨":recommended.has(model.value)?"추천":model.id;
      button.append(name,detail,badge);button.title=model.id;
      button.onclick=()=>{modelBrowser.close();void requestModelChange(select,model.value);};results.append(button);
    }
    load.hidden=count>=matching.length;
  }
  search.value="";search.oninput=()=>{count=60;render();};load.onclick=()=>{count+=60;render();};modelBrowser.onclose=()=>{if(trigger.isConnected&&!$("dialog[open]"))trigger.focus();};
  render();modelBrowser.showModal();search.focus();
}
function setLayout(count) {
  if (!state.selectedRoom || count < 2 || count > 8) return;
  if (state.layout === count) {
    state.layout = 1;
    state.extra = [];
    state.focusPane = 0;
    $("#pane-grid").dataset.panes = "1";
    $("#pane-grid").classList.remove("docked");
    $("#room-view").style.gridColumn = "";
    $("#room-view").classList.remove("is-focus");
    $$(".extra-pane").forEach((pane) => pane.remove());
    $$(".split-picker button").forEach((button) => {
      button.classList.remove("is-on");
      button.setAttribute("aria-pressed", "false");
    });
    renderRooms();
    syncProgressStreams();
    return;
  }
  state.layout = count;
  state.focusPane = 0;
  const ids = [state.selectedRoom];
  for (const room of state.rooms) {
    if (ids.length >= count) break;
    if (!ids.includes(room.id)) ids.push(room.id);
  }
  state.extra = ids.slice(1).map((roomId) => ({ roomId, data: null, busy: false, request: 0, model: "", effort: "" }));
  while (state.extra.length < count - 1) state.extra.push({ roomId: null, data: null, busy: false, request: 0, model: "", effort: "" });
  $("#pane-grid").dataset.panes = String(count);
  $$(".split-picker button").forEach((button) => {
    const on = Number(button.dataset.split) === count;
    button.classList.toggle("is-on", on);
    button.setAttribute("aria-pressed", on ? "true" : "false");
  });
  $("#room-view").classList.add("is-focus");
  renderExtraPanes();
  renderRooms();
  refreshExtras();
}
function renderExtraPanes() {
  if(contextPopover?.pane)closeContextPopover();
  syncProgressStreams();
  const grid = $("#pane-grid");
  const spans = { 5: [2, 2, 2, 3, 3], 7: [3, 3, 3, 3, 4, 4, 4] }[state.layout];
  $$(".extra-pane", grid).forEach((pane) => {pane._desktop?.destroy();pane.remove();});
  $("#room-view").style.gridColumn = spans ? "span " + spans[0] : "";
  state.extra.forEach((pane, index) => {
    Object.assign(pane, roomPreferences(pane.roomId));
    const room = state.rooms.find((item) => item.id === pane.roomId);
    const section = document.createElement("section");
    section.className = "room-view extra-pane" + (state.focusPane === index + 1 ? " is-focus" : "");
    if (spans) section.style.gridColumn = "span " + spans[index + 1];
    section.addEventListener("mousedown", () => {
      state.focusPane = index + 1;
      $("#room-view").classList.remove("is-focus");
      $$(".extra-pane").forEach((item, itemIndex) => item.classList.toggle("is-focus", itemIndex + 1 === state.focusPane));
    });
    const header = document.createElement("header");
    header.className = "pane-bar";
    const title = document.createElement("h2");
    title.textContent = room?.name || "대화 선택";
    header.append(title);
    const desktopButton = document.createElement("button");
    desktopButton.type = "button";
    desktopButton.textContent = "컴퓨터";
    desktopButton.disabled = !pane.roomId;
    desktopButton.addEventListener("click", () => desktopUI?.openRoom(pane.roomId));

    const list = document.createElement("div");
    list.className = "message-list";
    const messages = pane.data?.messages || [];
    if (messages.length) messages.forEach((message) => list.append(createMessage(message)));
    else {
      const empty = document.createElement("div");
      empty.className = "message-empty";
      const note = document.createElement("span");
      note.textContent = pane.roomId ? "메시지를 불러오는 중…" : "이 칸을 누른 뒤 왼쪽 대화를 고르세요.";
      empty.append(note);
      list.append(empty);
    }
    section.classList.toggle("agent-working", !!pane.data?.busy);
    if (pane.data?.busy && pane.data.room?.id === pane.roomId) list.append(thinkingRow(pane.roomId));
    const form = document.createElement("form");
    form.className = "composer pane-composer";
    form.addEventListener("submit", (event) => submitPane(event, index));
    const controls = document.createElement("div");
    controls.className = "model-controls";
    controls.append(modelSelect(pane), effortSelect(pane));
    const row = document.createElement("div");
    row.className = "composer-row";
    const input = document.createElement("textarea");
    input.rows = 1;
    input.value=pane.draft || "";
    input.addEventListener("input",()=>{pane.draft=input.value;});
    input.maxLength = 4000;
    input.placeholder = "메시지 보내기. model 이면 목록을 가져옵니다.";
    input.setAttribute("aria-label", (room?.name || "대화") + " 메시지");
    input.addEventListener("keydown", (event) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        form.requestSubmit();
      }
    });
    const send = document.createElement("button");
    send.type = "submit";
    send.className = "send-button";
    send.setAttribute("aria-label", "메시지 보내기");
    send.append(icon("arrow"));
    row.append(input, send);
    form.append(controls, row);
    renderContextMeter(pane.data?.context,form,pane);
    section.append(header, list, form);
    grid.append(section);
    section._desktop=createDesktopUI({api,getRoomId:()=>pane.roomId,toast,mount:section,initialView:pane.desktopView || "browser",onViewChange:view=>{pane.desktopView=view;}});
    section._desktop.setRoom(pane.roomId);
  });
  applyModels(state.models);
  applyDockLayout();
}
function modelSelect(pane) {
  const label = document.createElement("label");
  label.append(document.createTextNode("모델 "));
  const select = document.createElement("select");
  select.className = "model-select";
  select.setAttribute("aria-label", "모델");
  select.dataset.chosen = pane.model || "";
  select._pane=pane;
  select.addEventListener("change", () => { void requestModelChange(select,select.value); });
  label.append(select);
  return label;
}
function effortSelect(pane) {
  const label = document.createElement("label");
  label.append(document.createTextNode("effort "));
  const select = document.createElement("select");
  select.className = "effort-select";
  select.setAttribute("aria-label", "effort");
  for (const [value, text] of [["", "기본"], ["low", "low"], ["medium", "medium"], ["high", "high"], ["xhigh", "xhigh"]]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = text;
    select.append(option);
  }
  select.value = pane.effort || "";
  select.addEventListener("change", () => { pane.effort = select.value; saveRoomPreferences(pane.roomId, {model:pane.model || "", effort:pane.effort}); });
  label.append(select);
  return label;
}
async function submitPane(event, index) {
  event.preventDefault();
  const pane = state.extra[index];
  if (!pane?.roomId || roomContextOwner(pane).busy) return;
  const form = event.currentTarget;
  const input = $("textarea", form);
  const text = input.value.trim();
  if (!text) return;
  pane.sending = true;
  updateModelAvailability();
  try {
    const result = await api(`/api/rooms/${encodeURIComponent(pane.roomId)}/messages`, {
      method: "POST",
      body: JSON.stringify({
        text,
        botIds: state.selectedBots,
        attachmentIds: [],
        clientNonce: crypto.randomUUID(),
        model: $(".model-select", form).value,
        effort: $(".effort-select", form).value,
      }),
      retryable: true,
    });
    input.value = "";
    pane.draft = "";
    if (Array.isArray(result.models)) applyModels(result.models);
    await refreshExtra(index);
  } catch (error) {
    toast(error.message);
  } finally {
    pane.sending = false;
    updateModelAvailability();
  }
}
async function refreshExtra(index) {
  const pane = state.extra[index];
  if (!pane?.roomId || pane.busy) return;
  const request = ++pane.request;
  const roomId = pane.roomId;
  pane.busy = true;
  try {
    const data = await api(`/api/rooms/${encodeURIComponent(roomId)}`);
    if (state.extra[index] !== pane || pane.roomId !== roomId || pane.request !== request) return;
    const unchanged = JSON.stringify(pane.data) === JSON.stringify(data);
    pane.data = data;
    syncProgressStreams();
    if (unchanged) return;
    const section = $$(".extra-pane")[index];
    if (!section) return;
    renderContextMeter(data.context,$(".pane-composer",section),pane);
    const list = $(".message-list", section);
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 90;
    list.replaceChildren();
    const messages = data.messages || [];
    if (messages.length) messages.forEach((message) => list.append(createMessage(message)));
    else {
      const empty = document.createElement("div");
      empty.className = "message-empty";
      const note = document.createElement("span");
      note.textContent = "메시지를 보내 대화를 시작하세요.";
      empty.append(note);
      list.append(empty);
    }
    section.classList.toggle("agent-working", !!data.busy);
    if (data.busy) list.append(thinkingRow(roomId));
    if (nearBottom) list.scrollTop = list.scrollHeight;
    $("h2", section).textContent = data.room?.name || "대화";
  } catch (error) {
    if (pane.request !== request) return;
    if (error.status === 401) { state.session = null; showAuth(); }
    else {
      if (error.status === 403 || error.status === 404) { pane.data = null; syncProgressStreams(); }
      toast(error.message);
    }
  } finally {
    if (pane.request === request) pane.busy = false;
  }
}
function refreshExtras() {
  state.extra.forEach((_, index) => { void refreshExtra(index); });
}
function assignExtra(index, roomId) {
  const pane = state.extra[index];
  if (!pane || roomId === state.selectedRoom) return;
  state.extra.forEach((item, itemIndex) => {
    if (itemIndex !== index && item.roomId === roomId) item.roomId = pane.roomId;
  });
  pane.roomId = roomId;
  pane.data = null;
  pane.busy = false;
  renderExtraPanes();
  renderRooms();
  void refreshExtra(index);
}
function bind() {
  setupSidebarResize();
  $("#create-sidebar-group").addEventListener("click",()=>openSidebarGroupEditor());
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
    $(selector).addEventListener("click", startNewSession),
  );
  $("#join-room-button").addEventListener("click", () =>
    openDialog($("#join-dialog")),
  );
  $("#room-form").addEventListener("submit", createRoom);
  $("#join-form").addEventListener("submit", joinRoom);
  $("#composer-form").addEventListener("submit", submitMessage);
  $("#model-select").addEventListener("change",()=>{void requestModelChange($("#model-select"),$("#model-select").value);});
  $("#effort-select").addEventListener("change",()=>{
    saveRoomPreferences(state.selectedRoom,{model:$("#model-select").dataset.chosen || "",effort:$("#effort-select").value});
  });
  $("#room-view").addEventListener("mousedown", () => {
    if (state.layout < 2) return;
    state.focusPane = 0;
    desktopUI?.setRoom(state.selectedRoom);
    $("#room-view").classList.add("is-focus");
    $$(".extra-pane").forEach((pane) => pane.classList.remove("is-focus"));
  });
  $$(".split-picker button").forEach((button) => {
    button.addEventListener("click", () => setLayout(Number(button.dataset.split)));
  });
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
    if (matchMedia("(max-width: 720px)").matches) {
      const open = $("#sidebar").classList.toggle("is-open");
      $("#sidebar-scrim").classList.toggle("is-visible", open);
      $("#mobile-menu").setAttribute("aria-expanded", String(open));
    } else {
      const hidden = els.workspace.classList.toggle("sidebar-collapsed");
      $("#mobile-menu").setAttribute("aria-expanded", String(!hidden));
    }
  });
  setupDock();
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
const startupArtwork = document.querySelector(".startup-logo");
startupArtwork.decode().then(() => startupArtwork.classList.add("is-decoded")).catch(() => {});
loadSession();


// Docking changes only the arrangement; room identity and permissions stay unchanged.
function dockPanels() { return [$("#room-view"), ...$$(".extra-pane")]; }
function applyDockLayout() {
  const grid = $("#pane-grid");
  grid.classList.toggle("docked", dockRects.length > 1);
  dockPanels().forEach((panel, index) => {
    panel.dataset.dockIndex = index;
    let close=panel.querySelector(":scope > .pane-close");
    if(dockRects.length>1) {
      if(!close){close=document.createElement("button");close.className="pane-close";close.type="button";close.textContent="×";panel.append(close);}
      close.setAttribute("aria-label",(dockRoomAt(index)?state.rooms.find(r=>r.id===dockRoomAt(index))?.name || "대화":"빈")+" 분할 닫기");
      close.onclick=()=>closeDockPane(index);
    } else close?.remove();
    const rect = dockRects[index];
    if (rect && dockRects.length > 1) Object.assign(panel.style, {left:rect.x*100+"%", top:rect.y*100+"%", width:rect.w*100+"%", height:rect.h*100+"%", gridColumn:""});
    else for (const key of ["left","top","width","height"]) panel.style[key] = "";
    const handle = index ? panel.querySelector(".pane-bar") : $(".header-identity");
    if (handle) { handle.draggable = false; handle.dataset.dockIndex = index; handle.title = "드래그해서 이동 · 우클릭으로 분할"; }
  });
}
async function closeDockPane(index) {
  if(dockRects.length<2)return;
  if(index===0 ? $("#message-input").value.trim() : state.extra[index-1]?.draft?.trim()) {toast("작성 중인 메시지를 보내거나 비운 뒤 창을 닫아주세요.");return;}
  let promote;
  if(index===0){promote=state.extra.shift();} else state.extra.splice(index-1,1);
  const count=state.extra.length+1;
  dockRects=Array.from({length:count},(_,i)=>({x:i/count,y:0,w:1/count,h:1}));
  state.layout=count;state.focusPane=0;$("#pane-grid").dataset.panes=String(count);
  if(promote?.roomId) await selectRoom(promote.roomId);
  renderExtraPanes();renderRooms();applyDockLayout();
}
function dockRoomAt(index) { return index === 0 ? state.selectedRoom : state.extra[index-1]?.roomId; }
function dockZone(panel, event) {
  const r=panel.getBoundingClientRect(), x=(event.clientX-r.left)/r.width, y=(event.clientY-r.top)/r.height;
  const distances=[x,1-x,y,1-y], side=["left","right","top","bottom"][distances.indexOf(Math.min(...distances))];
  return Math.min(...distances) > .3 && pendingDock?.index !== undefined ? "center" : side;
}
function placeDock(index, side) {
  if (!pendingDock || !state.selectedRoom) return;
  const source = pendingDock; pendingDock = null;
  if (source.index !== undefined) {
    if (source.index === index) return;
    // Move existing panes without restarting their sessions.
    [dockRects[source.index],dockRects[index]]=[dockRects[index],dockRects[source.index]];
    applyDockLayout(); return;
  }
  if (dockRects.length >= 8) { toast("분할 화면은 최대 8개입니다."); return; }
  const r = dockRects[index], next={...r};
  if (side === "left" || side === "right") {
    next.w=r.w/2; r.w/=2;
    if (side === "left") r.x+=r.w; else next.x+=r.w;
  } else {
    next.h=r.h/2; r.h/=2;
    if (side === "top") r.y+=r.h; else next.y+=r.h;
  }
  dockRects.push(next);
  state.extra.push({roomId:source.roomId, data:null,busy:false,request:0,...roomPreferences(source.roomId)});
  state.layout=dockRects.length;
  $("#pane-grid").dataset.panes=String(state.layout);
  renderExtraPanes(); renderRooms(); refreshExtras(); applyDockLayout();
}
function setupDock() {
  const grid=$("#pane-grid"), preview=document.createElement("div"), menu=document.createElement("div");
  preview.className="dock-preview"; preview.hidden=true; preview.textContent="여기에 놓기"; document.body.append(preview);
  menu.className="dock-menu"; menu.hidden=true; menu.setAttribute("role","menu"); document.body.append(menu);
  const hide=()=>{preview.hidden=true; menu.hidden=true;};
  function previewAt(panel,event) {
    const side=dockZone(panel,event), r=panel.getBoundingClientRect();
    let x=r.left,y=r.top,w=r.width,h=r.height;
    if (pendingDock?.index === undefined) {
      if(side==="left"||side==="right"){w/=2;if(side==="right")x+=w;}
      else {h/=2;if(side==="bottom")y+=h;}
    }
    Object.assign(preview.style,{left:x+"px",top:y+"px",width:w+"px",height:h+"px"});preview.hidden=false;
    return side;
  }
  let pointerDock = null, suppressClick = false;
  document.addEventListener("pointerdown", event => {
    if (event.button !== 0 || pendingDock?.placing || event.target.closest("select,input,textarea")) return;
    const room = event.target.closest("[data-dock-room]"), handle = event.target.closest(".pane-bar[data-dock-index],.header-identity[data-dock-index]");
    if (!room && (!handle || event.target.closest("button"))) return;
    pointerDock = {x:event.clientX,y:event.clientY,source:room ? {roomId:room.dataset.dockRoom} : {index:Number(handle.dataset.dockIndex)}};
  });
  document.addEventListener("pointermove", event => {
    if (!pointerDock) return;
    if (!pointerDock.active && Math.hypot(event.clientX-pointerDock.x,event.clientY-pointerDock.y)<7) return;
    pointerDock.active=true;pendingDock=pointerDock.source;
    event.preventDefault();
    const panel=document.elementFromPoint(event.clientX,event.clientY)?.closest("#pane-grid > .room-view");
    if(panel) previewAt(panel,event); else preview.hidden=true;
  });
  document.addEventListener("pointerup", event => {
    if (!pointerDock) return;
    if(pointerDock.active){
      const panel=document.elementFromPoint(event.clientX,event.clientY)?.closest("#pane-grid > .room-view");
      if(panel) placeDock(Number(panel.dataset.dockIndex),dockZone(panel,event));
      pendingDock=null;hide();suppressClick=true;setTimeout(()=>{suppressClick=false;},0);
    }
    pointerDock=null;
  });
  document.addEventListener("click", event=>{if(suppressClick){event.preventDefault();event.stopImmediatePropagation();}},true);
  document.addEventListener("pointercancel",()=>{pointerDock=null;pendingDock=null;hide();});
  document.addEventListener("dragstart",event=>{
    const room=event.target.closest("[data-dock-room]"), handle=event.target.closest("[draggable=true][data-dock-index]");
    if(room) pendingDock={roomId:room.dataset.dockRoom};
    else if(handle) pendingDock={index:Number(handle.dataset.dockIndex)};
    else return;
    event.dataTransfer.setData("text/plain","openclaw-pane"); event.dataTransfer.effectAllowed="move";
  });
  grid.addEventListener("dragover",event=>{const panel=event.target.closest("[data-dock-index]");if(!panel||!pendingDock)return;event.preventDefault();previewAt(panel,event);});
  grid.addEventListener("drop",event=>{const panel=event.target.closest("[data-dock-index]");if(!panel||!pendingDock)return;event.preventDefault();placeDock(Number(panel.dataset.dockIndex),dockZone(panel,event));hide();});
  document.addEventListener("dragend",()=>{pendingDock=null;hide();});
  grid.addEventListener("pointermove",event=>{const panel=event.target.closest("[data-dock-index]");if(pendingDock?.placing&&panel)previewAt(panel,event);});
  grid.addEventListener("click",event=>{const panel=event.target.closest("[data-dock-index]");if(pendingDock?.placing&&panel){event.preventDefault();event.stopImmediatePropagation();placeDock(Number(panel.dataset.dockIndex),dockZone(panel,event));hide();}},true);
  const begin=roomId=>{pendingDock={roomId,placing:true};menu.hidden=true;toast("놓을 위치를 가리킨 뒤 클릭하세요. Esc로 취소합니다.");};
  document.addEventListener("contextmenu",event=>{
    const room=event.target.closest("[data-dock-room]"), panel=event.target.closest("[data-dock-index]");
    if(!room&&!panel)return;if(event.target.closest("textarea,input"))return;
    event.preventDefault();menu.replaceChildren();
    const action=document.createElement("button");action.type="button";action.setAttribute("role","menuitem");action.textContent="Split view로 열기";
    action.onclick=()=>begin(room?.dataset.dockRoom || dockRoomAt(Number(panel.dataset.dockIndex)));menu.append(action);
    const targetRoom=state.rooms.find(r=>r.id===(room?.dataset.dockRoom || dockRoomAt(Number(panel.dataset.dockIndex))));
    if(targetRoom) {
      const addAction=(label,handler)=>{const b=document.createElement("button");b.type="button";b.setAttribute("role","menuitem");b.textContent=label;b.onclick=()=>{menu.hidden=true;handler();};menu.append(b);};
      if(sidebarState.loaded&&targetRoom.id!==MONITOR_ROOM)addAction("그룹으로 이동",()=>openRoomGroupPicker(targetRoom));
      addAction(targetRoom.pinned?"고정 해제":"상단에 고정",()=>updateRoomListPreference(targetRoom,{pinned:!targetRoom.pinned}));
      addAction(targetRoom.archived?"대화 복원":"대화 삭제",()=>{
        if(targetRoom.archived) return updateRoomListPreference(targetRoom,{archived:false});
        const dialog=document.createElement("dialog");dialog.className="quick-model-picker";
        const text=document.createElement("p");text.textContent="내 대화 목록에서 삭제할까요? 삭제한 대화에서 복원할 수 있으며 다른 참여자의 대화는 유지됩니다.";
        const confirm=document.createElement("button");confirm.textContent="삭제";confirm.onclick=()=>{dialog.close();updateRoomListPreference(targetRoom,{archived:true});};
        const cancel=document.createElement("button");cancel.textContent="취소";cancel.onclick=()=>dialog.close();
        dialog.append(text,confirm,cancel);dialog.onclose=()=>dialog.remove();document.body.append(dialog);dialog.showModal();
      });
    }
    const reset=document.createElement("button");reset.type="button";reset.setAttribute("role","menuitem");reset.textContent="분할 닫기";reset.onclick=()=>{state.layout=2;setLayout(2);dockRects=[{x:0,y:0,w:1,h:1}];applyDockLayout();hide();};menu.append(reset);
    menu.hidden=false;Object.assign(menu.style,{left:Math.max(8,Math.min(event.clientX,innerWidth-menu.offsetWidth-8))+"px",top:Math.max(8,Math.min(event.clientY,innerHeight-menu.offsetHeight-8))+"px"});action.focus();
  });
  document.addEventListener("pointerdown",event=>{if(!menu.contains(event.target))menu.hidden=true;});
  document.addEventListener("keydown",event=>{if(event.key==="Escape"){pendingDock=null;hide();}});
  $("#split-add").addEventListener("click",()=>begin(state.selectedRoom));
  applyDockLayout();
}
