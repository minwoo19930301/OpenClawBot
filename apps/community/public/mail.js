function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function action(text, handler, className = "outline-button") {
  const button = node("button", className, text); button.type = "button";
  if (handler) button.addEventListener("click", handler);
  return button;
}
function dateLabel(value) {
  const date = new Date(value);
  return value && !Number.isNaN(date.getTime()) ? date.toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "날짜 없음";
}

export function createMailUI({ api, getSession, toast }) {
  let dialog, mailbox, list, detail, status, address, count, more, refresh, compose;
  let epoch = 0, listRequest = 0, detailRequest = 0, configured = false, loading = false, sending = false;
  let messages = [], cursor = null, selectedId = null, selectedMessage = null, pendingSend = null;
  const isAdmin = () => getSession()?.user?.role === "admin";
  const current = (requestEpoch, userId) => requestEpoch === epoch && dialog?.open && isAdmin() && getSession()?.user?.id === userId;
  function clearPrivateState() {
    epoch += 1; listRequest += 1; detailRequest += 1;
    configured = false; loading = false; sending = false;
    messages = []; cursor = null; selectedId = null; selectedMessage = null; pendingSend = null;
    list?.replaceChildren(); detail?.replaceChildren();
    if (address) address.textContent = "";
    if (status) status.textContent = "";
  }
  function reset() {
    clearPrivateState();
    if (dialog?.open) dialog.close();
  }
  function ensureDialog() {
    if (dialog) return;
    dialog = node("dialog", "mail-dialog"); dialog.id = "mail-dialog"; dialog.setAttribute("aria-labelledby", "mail-title");
    const header = node("header", "mail-header"), copy = node("div", "mail-heading");
    const title = node("h2", "", "메일"); title.id = "mail-title";
    address = node("p", "mail-address"); copy.append(title, address);
    const actions = node("div", "mail-header-actions");
    refresh = action("새로고침", () => void loadInbox());
    compose = action("메일 쓰기", () => startCompose(), "primary-button");
    const close = action("×", reset, "icon-button mail-close"); close.setAttribute("aria-label", "메일 닫기");
    actions.append(refresh, compose, close); header.append(copy, actions);
    status = node("p", "mail-status"); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
    mailbox = node("div", "mail-workspace");
    const inbox = node("section", "mail-inbox"); inbox.setAttribute("aria-label", "받은 메일 목록");
    count = node("p", "mail-count");
    list = node("div", "mail-list");
    more = action("더 불러오기", () => void loadInbox(true), "text-button mail-more"); more.hidden = true;
    inbox.append(count, list, more);
    detail = node("section", "mail-detail"); detail.setAttribute("aria-label", "메일 내용");
    mailbox.append(inbox, detail); dialog.append(header, status, mailbox);
    dialog.addEventListener("cancel", event => { event.preventDefault(); reset(); });
    dialog.addEventListener("close", () => { if (!dialog.open) clearPrivateState(); });
    document.body.append(dialog);
  }
  function updateControls() {
    refresh.disabled = loading || sending;
    compose.disabled = !configured || sending;
    more.disabled = loading || sending;
    more.hidden = !cursor || !configured;
    dialog?.querySelectorAll(".mail-item").forEach(button => { button.disabled = sending; });
  }
  function emptyDetail(title, text) {
    detail.replaceChildren();
    const empty = node("div", "mail-empty"); empty.append(node("h3", "", title), node("p", "", text)); detail.append(empty);
  }
  function renderList() {
    list.replaceChildren();
    count.textContent = configured ? `받은 메일 · 불러온 ${messages.length}개` : "받은 메일";
    for (const message of messages) {
      const button = action("", () => void selectMessage(message.id), "mail-item");
      button.dataset.mailId = message.id;
      button.classList.toggle("is-selected", selectedId === message.id);
      button.setAttribute("aria-pressed", String(selectedId === message.id));
      const top = node("span", "mail-item-top");
      top.append(node("span", "mail-from", message.from || "발신자 없음"), node("time", "mail-date", dateLabel(message.receivedAt)));
      button.append(top, node("strong", "mail-subject", message.subject || "(제목 없음)"));
      list.append(button);
    }
    if (configured && !messages.length) list.append(node("p", "mail-list-empty", "아직 받은 메일이 없습니다."));
    updateControls();
  }
  async function loadInbox(append = false) {
    if (!isAdmin() || loading || sending || !dialog?.open) return;
    if (append && !cursor) return;
    const requestEpoch = epoch, userId = getSession().user.id, sequence = ++listRequest;
    loading = true; status.textContent = "받은 메일을 불러오고 있어요…"; updateControls();
    try {
      const data = await api("/api/admin/mail" + (append ? `?cursor=${encodeURIComponent(cursor)}` : ""));
      if (!current(requestEpoch, userId) || sequence !== listRequest) return;
      configured = data.configured === true;
      address.textContent = configured ? data.address || "서버에 연결된 메일함" : "메일함 미연결";
      if (!configured) {
        messages = []; cursor = null; selectedId = null; selectedMessage = null; pendingSend = null; detailRequest += 1;
        emptyDetail("메일함을 연결해 주세요", "이 서버에 메일 연결 정보가 아직 등록되지 않았습니다. 설정의 ‘운영 메일’은 연락처 기록이며 메일함 연결은 별도로 필요합니다.");
        status.textContent = "관리자 메일 연결이 필요합니다.";
      } else {
        const all = append ? [...messages, ...(Array.isArray(data.messages) ? data.messages : [])] : (Array.isArray(data.messages) ? data.messages : []);
        messages = [...new Map(all.filter(item => item && typeof item.id === "string").map(item => [item.id, item])).values()].sort((a, b) => (Date.parse(b.receivedAt) || 0) - (Date.parse(a.receivedAt) || 0));
        cursor = typeof data.cursor === "string" && data.cursor ? data.cursor : null;
        if (!detail.childElementCount) emptyDetail(messages.length ? "메일을 선택하세요" : "받은 메일이 없습니다", "왼쪽 목록에서 메일을 선택하면 텍스트 본문을 볼 수 있습니다.");
        status.textContent = "";
      }
      renderList();
    } catch (error) {
      if (!current(requestEpoch, userId) || sequence !== listRequest) return;
      status.textContent = error.message || "메일함을 불러오지 못했습니다. 다시 시도해 주세요.";
      if (!configured) emptyDetail("메일함을 불러오지 못했습니다", "연결 정보 또는 권한을 확인한 뒤 새로고침해 주세요.");
    } finally {
      if (current(requestEpoch, userId) && sequence === listRequest) { loading = false; updateControls(); }
    }
  }
  async function selectMessage(id) {
    if (!configured || sending || !isAdmin() || !dialog?.open) return;
    const requestEpoch = epoch, userId = getSession().user.id, sequence = ++detailRequest;
    selectedId = id; selectedMessage = null; pendingSend = null;
    renderList(); emptyDetail("메일을 불러오고 있어요…", "");
    try {
      const message = await api(`/api/admin/mail/messages/${encodeURIComponent(id)}`);
      if (!current(requestEpoch, userId) || sequence !== detailRequest) return;
      selectedMessage = message;
      renderMessage(message);
    } catch (error) {
      if (current(requestEpoch, userId) && sequence === detailRequest) emptyDetail("메일을 불러오지 못했습니다", error.message || "다시 선택해 주세요.");
    }
  }
  function renderMessage(message) {
    detail.replaceChildren();
    const header = node("div", "mail-message-header");
    header.append(node("h3", "", message.subject || "(제목 없음)"));
    const metadata = node("dl", "mail-metadata");
    for (const [label, value] of [["보낸 사람", message.from], ["받는 사람", message.to], ["받은 시간", dateLabel(message.receivedAt)]]) {
      metadata.append(node("dt", "", label), node("dd", "", value || "—"));
    }
    header.append(metadata, action("답장", () => startCompose(message)));
    const body = node("div", "mail-text", message.text || "텍스트 본문이 없습니다.");
    detail.append(header, body);
    if (Array.isArray(message.attachments) && message.attachments.length) {
      const attachments = node("section", "mail-attachments"); attachments.append(node("h4", "", "첨부 파일"));
      const files = node("ul");
      for (const item of message.attachments) files.append(node("li", "", item.filename || "이름 없는 첨부 파일"));
      attachments.append(files, node("p", "mail-note", "첨부 파일은 이름만 표시합니다. 이 화면에서 다운로드는 지원하지 않습니다.")); detail.append(attachments);
    }
  }
  function startCompose(reply = null) {
    if (!configured || sending || !isAdmin()) return;
    detailRequest += 1; pendingSend = null; selectedId = reply?.id || null; renderList(); detail.replaceChildren();
    const header = node("div", "mail-compose-header"); header.append(node("h3", "", reply ? "답장 쓰기" : "새 메일"));
    const form = node("form", "mail-compose");
    const fields = node("fieldset");
    function input(labelText, name, type, value = "") {
      const label = node("label", "mail-field"), control = node(type === "textarea" ? "textarea" : "input");
      control.name = name; control.value = value; control.required = true; control.autocomplete = "off";
      if (type !== "textarea") control.type = type;
      label.append(node("span", "", labelText), control); fields.append(label); return control;
    }
    const to = input("받는 사람", "to", "email", reply?.from || ""); to.maxLength = 254; to.readOnly = Boolean(reply);
    const subject = input("제목", "subject", "text", reply ? (/^re:/i.test(reply.subject || "") ? reply.subject : `Re: ${reply.subject || ""}`) : ""); subject.maxLength = 1000; subject.readOnly = Boolean(reply);
    const text = input("내용", "text", "textarea"); text.maxLength = 40000; text.rows = 12;
    const result = node("p", "mail-compose-status"); result.setAttribute("role", "status"); result.setAttribute("aria-live", "polite");
    const buttons = node("div", "mail-compose-actions");
    const cancel = action("취소", () => { pendingSend = null; if (reply) renderMessage(reply); else emptyDetail("메일을 선택하세요", "받은 메일을 선택하거나 새 메일을 작성하세요."); });
    const send = action("메일 보내기", null, "primary-button"); send.type = "submit"; buttons.append(cancel, send);
    form.append(fields, result, buttons);
    form.addEventListener("submit", async event => {
      event.preventDefault();
      if (sending || !isAdmin() || !dialog.open || !text.value.trim()) return;
      const requestEpoch = epoch, userId = getSession().user.id, sequence = detailRequest;
      const payload = reply ? { action: "reply", id: reply.id, text: text.value } : { action: "send", to: to.value.trim(), subject: subject.value, text: text.value };
      const signature = JSON.stringify(payload);
      if (pendingSend?.signature !== signature) pendingSend = { signature, requestId: crypto.randomUUID() };
      sending = true; fields.disabled = true; send.disabled = true; cancel.disabled = true; updateControls(); result.textContent = "전송 요청을 보내고 있어요…";
      try {
        const data = await api("/api/admin/mail/send", { method: "POST", body: JSON.stringify({ ...payload, requestId: pendingSend.requestId }) });
        if (!current(requestEpoch, userId) || sequence !== detailRequest) return;
        if (data.accepted !== true) throw new Error("전송 요청이 접수됐는지 확인하지 못했습니다.");
        pendingSend = null; form.reset();
        emptyDetail("전송 요청이 접수되었습니다", "수신자에게 최종 배달됐는지는 메일 공급자의 처리 결과를 따릅니다.");
        status.textContent = "메일 전송 요청이 접수되었습니다.";
      } catch (error) {
        if (current(requestEpoch, userId) && sequence === detailRequest) result.textContent = error.message || "발송 여부를 확인하지 못했습니다. 같은 내용으로 다시 시도할 수 있습니다.";
      } finally {
        if (current(requestEpoch, userId) && sequence === detailRequest) { sending = false; fields.disabled = false; send.disabled = false; cancel.disabled = false; updateControls(); }
      }
    });
    detail.append(header, form); (reply ? text : to).focus();
  }
  async function open() {
    if (!isAdmin()) { toast?.("관리자만 메일함을 볼 수 있습니다."); return; }
    ensureDialog();
    if (dialog.open) { dialog.focus(); return; }
    clearPrivateState(); count.textContent = "받은 메일"; updateControls(); dialog.showModal();
    await loadInbox();
  }
  return { open, reset };
}
