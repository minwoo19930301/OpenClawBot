let rfbModulePromise;

const icon = (name) => {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.className.baseVal = "desktop-icon";
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("viewBox", "0 0 24 24");
  if (name === "monitor") {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M4 4h16v11H4zM9 20h6M12 15v5");
    svg.append(path);
  } else {
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", `#i-${name}`);
    svg.append(use);
  }
  return svg;
};

const websocketUrl = (path) => {
  const url = new URL(path, window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
};

const loadRFB = async () => {
  if (!rfbModulePromise) rfbModulePromise = import("/vendor/novnc.js");
  const module = await rfbModulePromise;
  return module.default || module.RFB || module;
};

export function createDesktopUI({ api, getRoomId, toast = () => {} }) {
  const state = {
    roomId: null,
    request: 0,
    status: null,
    rfb: null,
    connecting: false,
    generation: 0,
    viewOnly: true,
  };
  const topbar = document.querySelector(".topbar-actions");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "icon-button desktop-button";
  button.title = "OCI 데스크톱";
  button.setAttribute("aria-label", "OCI 데스크톱 열기");
  button.append(icon("monitor"));
  topbar?.append(button);

  const panel = document.createElement("aside");
  panel.className = "desktop-panel";
  panel.setAttribute("aria-label", "OCI 데스크톱");
  panel.hidden = true;
  const head = document.createElement("div");
  head.className = "desktop-head";
  const title = document.createElement("strong");
  title.textContent = "OCI 데스크톱";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "icon-button";
  close.title = "닫기";
  close.setAttribute("aria-label", "OCI 데스크톱 닫기");
  close.append(icon("close"));
  head.append(title, close);
  const status = document.createElement("p");
  status.className = "desktop-status";
  const preview = document.createElement("div");
  preview.className = "desktop-preview";
  const previewCover = document.createElement("button");
  previewCover.type = "button";
  previewCover.className = "desktop-preview-open";
  previewCover.setAttribute("aria-label", "OCI 데스크톱 미리보기 확대");
  previewCover.title = "확대하여 조종";
  const previewMessage = document.createElement("span");
  previewMessage.className = "desktop-preview-message";
  preview.append(previewMessage);
  const controls = document.createElement("div");
  controls.className = "desktop-controls";
  const control = document.createElement("button");
  control.type = "button";
  control.className = "outline-button desktop-control";
  control.textContent = "제어하기";
  const fullscreen = document.createElement("button");
  fullscreen.type = "button";
  fullscreen.className = "outline-button desktop-control";
  fullscreen.textContent = "전체 화면";
  controls.append(control, fullscreen);
  const sharedNote = document.createElement("p");
  sharedNote.className = "desktop-status";
  sharedNote.textContent = "이 대화의 참여자가 같은 화면을 보고 조종합니다.";
  panel.append(head, status, preview, controls, sharedNote);
  document.body.append(panel);

  const dialog = document.createElement("dialog");
  dialog.className = "desktop-dialog";
  const dialogHead = document.createElement("div");
  dialogHead.className = "desktop-head";
  const dialogTitle = document.createElement("strong");
  dialogTitle.textContent = "OCI 데스크톱";
  const dialogControl = document.createElement("button");
  dialogControl.type = "button";
  dialogControl.className = "outline-button desktop-control";
  dialogControl.textContent = "제어하기";
  const dialogClose = close.cloneNode(true);
  dialogHead.append(dialogTitle, dialogControl, dialogClose);
  const dialogView = document.createElement("div");
  dialogView.className = "desktop-dialog-view";
  dialog.append(dialogHead, dialogView);
  document.body.append(dialog);

  const setStatus = (message, kind = "") => {
    status.textContent = message || "";
    status.dataset.kind = kind;
  };
  const disconnect = () => {
    state.generation += 1;
    if (state.rfb) try { state.rfb.disconnect(); } catch {}
    state.rfb = null;
    state.connecting = false;
  };
  const hideDialog = () => {
    disconnect();
    if (dialog.open) dialog.close();
    dialogView.replaceChildren();
  };
  const resetView = () => {
    disconnect();
    preview.replaceChildren(previewMessage);
    previewMessage.textContent = "OCI 데스크톱을 확인하는 중…";
    control.disabled = true;
    fullscreen.disabled = true;
    setStatus("");
  };
  const connect = async (target, viewOnly) => {
    const roomId = state.roomId;
    const generation = state.generation;
    if (!roomId || state.connecting || state.rfb) return;
    state.connecting = true;
    setStatus("연결 중…");
    try {
      const ticket = await api(`/api/rooms/${encodeURIComponent(roomId)}/desktop/ticket`, { method: "POST", body: "{}" });
      if (roomId !== state.roomId || generation !== state.generation) { state.connecting = false; return; }
      const ticketUrl = new URL(ticket.websocketPath, window.location.href);
      const expectedPath = `/api/rooms/${encodeURIComponent(roomId)}/desktop/ws`;
      if (ticketUrl.origin !== window.location.origin || ticketUrl.pathname !== expectedPath || !ticketUrl.searchParams.has("ticket")) {
        throw new Error("데스크톱 연결 경로가 올바르지 않습니다.");
      }
      const RFB = await loadRFB();
      if (roomId !== state.roomId || generation !== state.generation) { state.connecting = false; return; }
      target.replaceChildren();
      const rfb = new RFB(target, websocketUrl(ticketUrl.pathname + ticketUrl.search), { shared: true });
      rfb.viewOnly = viewOnly;
      rfb.scaleViewport = true;
      rfb.resizeSession = false;
      rfb.focusOnClick = true;
      rfb.addEventListener("connect", () => setStatus(viewOnly ? "미리보기 연결됨" : "제어 연결됨", "ready"));
      rfb.addEventListener("disconnect", () => {
        if (state.rfb === rfb) {
          state.rfb = null;
          state.connecting = false;
          if (target === preview) {
            preview.replaceChildren(previewMessage);
            previewMessage.textContent = "데스크톱 연결이 종료되었습니다. 다시 열어보세요.";
          }
          setStatus("연결이 종료되었습니다.");
        }
      });
      rfb.addEventListener("credentialsrequired", () => {
        setStatus("데스크톱 인증에 실패했습니다.", "error");
        toast("데스크톱 인증에 실패했습니다.");
        try { rfb.disconnect(); } catch {}
      });
      rfb.addEventListener("securityfailure", () => setStatus("데스크톱 보안 연결에 실패했습니다.", "error"));
      if (target === preview) target.append(previewCover);
      state.rfb = rfb;
      state.connecting = false;
    } catch (error) {
      if (roomId !== state.roomId || generation !== state.generation) return;
      state.connecting = false;
      const message = error.message || "데스크톱에 연결하지 못했습니다.";
      if (target === preview) {
        preview.replaceChildren(previewMessage);
        previewMessage.textContent = message;
      }
      setStatus(message, "error");
      toast(message);
    }
  };
  const openDialog = async (viewOnly = true) => {
    if (!state.status?.configured || !state.status.available) return;
    hideDialog();
    dialogView.replaceChildren();
    dialog.showModal();
    state.viewOnly = viewOnly;
    dialogControl.disabled = false;
    dialogControl.textContent = viewOnly ? "제어하기" : "보기로 전환";
    await connect(dialogView, viewOnly);
  };
  const refreshStatus = async () => {
    const roomId = state.roomId;
    const request = ++state.request;
    resetView();
    if (!roomId) return;
    try {
      const data = await api(`/api/rooms/${encodeURIComponent(roomId)}/desktop`);
      if (request !== state.request || roomId !== state.roomId) return;
      state.status = data;
      if (!data.configured) {
        previewMessage.textContent = "OCI 데스크톱이 연결되지 않았습니다.";
        setStatus("사용할 수 없음");
      } else if (!data.available || data.browserEnabled === false) {
        previewMessage.textContent = "OCI 데스크톱을 사용할 수 없습니다.";
        setStatus("현재 사용할 수 없음");
      } else {
        previewMessage.textContent = "클릭하여 라이브 미리보기 연결";
        setStatus("준비됨", "ready");
        control.disabled = false;
        fullscreen.disabled = false;
        if (!panel.hidden && !state.rfb && !state.connecting) connect(preview, true);
      }
    } catch (error) {
      if (request !== state.request || roomId !== state.roomId) return;
      state.status = null;
      previewMessage.textContent = "데스크톱 상태를 확인하지 못했습니다.";
      setStatus(error.message || "상태 확인 실패", "error");
    }
  };
  const openPanel = () => {
    panel.hidden = false;
    button.setAttribute("aria-expanded", "true");
    if (state.status?.configured && state.status.available && !state.rfb) connect(preview, true);
  };
  const togglePanel = () => {
    if (panel.hidden) openPanel();
    else { disconnect(); panel.hidden = true; button.setAttribute("aria-expanded", "false"); }
  };
  button.setAttribute("aria-expanded", "false");
  button.addEventListener("click", togglePanel);
  close.addEventListener("click", () => { disconnect(); panel.hidden = true; button.setAttribute("aria-expanded", "false"); });
  previewCover.addEventListener("click", () => openDialog(true));
  control.addEventListener("click", () => openDialog(false));
  fullscreen.addEventListener("click", () => {
    if (!state.status?.configured || !state.status.available) return;
    hideDialog();
    dialogView.replaceChildren();
    dialog.showModal();
    state.viewOnly = true;
    dialogControl.disabled = false;
    dialogControl.textContent = "제어하기";
    dialog.requestFullscreen?.().catch(() => {});
    connect(dialogView, true);
  });
  dialogControl.addEventListener("click", () => {
    if (!state.rfb) return;
    state.viewOnly = !state.viewOnly;
    state.rfb.viewOnly = state.viewOnly;
    dialogControl.textContent = state.viewOnly ? "제어하기" : "보기로 전환";
  });
  dialogClose.addEventListener("click", hideDialog);
  dialog.addEventListener("cancel", hideDialog);
  dialog.addEventListener("close", hideDialog);

  return {
    setRoom(roomId) {
      if (roomId === state.roomId) return;
      hideDialog();
      state.roomId = roomId || null;
      state.generation += 1;
      state.status = null;
      refreshStatus();
    },
    reset() {
      state.request += 1;
      state.generation += 1;
      state.roomId = null;
      state.status = null;
      hideDialog();
      panel.hidden = true;
      button.setAttribute("aria-expanded", "false");
      resetView();
    },
  };
}
