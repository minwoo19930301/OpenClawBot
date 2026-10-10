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

export function createMailUI({ api, getSession, toast, openRoom }) {
  let dialog, mailbox, list, detail, status, address, count, more, refresh, compose;
  let epoch = 0, listRequest = 0, detailRequest = 0, configured = false, loading = false, sending = false;
  let messages = [], cursor = null, selectedId = null, selectedMessage = null, pendingSend = null;
  let agentSection, agentSummary, agentBody, agentForm, agentFields, agentRows, agentEnabled, agentSave, agentResult, agentJobs;
  let agentData = null, agentDirty = false, agentLoading = false, agentSaving = false, agentRequest = 0, agentTimer = null;
  const isAdmin = () => getSession()?.user?.role === "admin";
  const current = (requestEpoch, userId) => requestEpoch === epoch && dialog?.open && isAdmin() && getSession()?.user?.id === userId;
  function clearPrivateState() {
    epoch += 1; listRequest += 1; detailRequest += 1; agentRequest += 1;
    clearTimeout(agentTimer); agentTimer = null;
    agentData = null; agentDirty = false; agentLoading = false; agentSaving = false;
    agentBody?.replaceChildren();
    agentForm = agentFields = agentRows = agentEnabled = agentSave = agentResult = agentJobs = null;
    if (agentSection) agentSection.open = false;
    if (agentSummary) agentSummary.textContent = "메일로 작업 · 확인 중";
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
    refresh = action("새로고침", () => { void loadInbox(); void loadAgent(); });
    compose = action("메일 쓰기", () => startCompose(), "primary-button");
    const close = action("×", reset, "icon-button mail-close"); close.setAttribute("aria-label", "메일 닫기");
    actions.append(refresh, compose, close); header.append(copy, actions);
    status = node("p", "mail-status"); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
    agentSection = node("details", "mail-agent");
    agentSummary = node("summary", "mail-agent-summary", "메일로 작업 · 확인 중");
    agentBody = node("div", "mail-agent-body"); agentSection.append(agentSummary, agentBody);
    mailbox = node("div", "mail-workspace");
    const inbox = node("section", "mail-inbox"); inbox.setAttribute("aria-label", "받은 메일 목록");
    count = node("p", "mail-count");
    list = node("div", "mail-list");
    more = action("더 불러오기", () => void loadInbox(true), "text-button mail-more"); more.hidden = true;
    inbox.append(count, list, more);
    detail = node("section", "mail-detail"); detail.setAttribute("aria-label", "메일 내용");
    mailbox.append(inbox, detail); dialog.append(header, agentSection, status, mailbox);
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
  function jobStateLabel(status) {
    const labels = { queued: "대기", running: "작업 중", reply_pending: "답장 대기", sent: "답장 요청 접수", failed: "실패", interrupted: "중단됨", uncertain: "답장 확인 필요", ignored: "보관만 함" };
    return Object.hasOwn(labels, status) ? labels[status] : "상태 확인 필요";
  }
  function updateAgentSummary() {
    const latest = Array.isArray(agentData?.jobs) ? agentData.jobs[0] : null;
    agentSummary.textContent = `메일로 작업 · ${agentStateLabel()}${latest ? ` · 최근 ${jobStateLabel(latest.status)}` : ""}`;
  }
  function agentStateLabel() {
    if (!agentData) return "확인 중";
    if (!agentData.configured) return "연결 필요";
    return agentData.enabled ? `켜짐 · 등록 발신자 ${agentData.senders?.length || 0}명` : "꺼짐";
  }
  function updateAgentControls() {
    if (!agentForm) return;
    agentFields.disabled = agentSaving;
    agentEnabled.disabled = agentSaving || !agentData?.configured;
    agentSave.disabled = agentSaving || !agentDirty;
    agentSave.textContent = agentSaving ? "저장 중…" : "설정 저장";
  }
  function markAgentDirty() {
    agentDirty = true;
    if (agentResult) agentResult.textContent = "변경한 설정을 저장해 주세요.";
    updateAgentControls();
  }
  function addSender(sender = {}) {
    const row = node("div", "mail-agent-sender");
    const email = node("input"); email.type = "email"; email.required = true; email.maxLength = 254;
    email.autocomplete = "off"; email.placeholder = "발신자 이메일"; email.value = sender.email || "";
    email.setAttribute("aria-label", "작업을 요청할 발신자 이메일");
    const user = node("select"); user.required = true; user.setAttribute("aria-label", "작업을 실행할 사용자");
    const placeholder = node("option", "", "사용자 선택"); placeholder.value = ""; placeholder.disabled = true; user.append(placeholder);
    const users = Array.isArray(agentData?.users) ? agentData.users : [];
    for (const item of users) {
      const label = item.displayName && item.displayName !== item.username ? `${item.displayName} (@${item.username})` : item.username || item.displayName || "사용자";
      const option = node("option", "", label); option.value = item.id; user.append(option);
    }
    if (sender.userId && !users.some(item => item.id === sender.userId)) {
      const missing = node("option", "", "사용자를 다시 선택해 주세요"); missing.value = sender.userId; missing.disabled = true; user.append(missing);
      user.setCustomValidity("현재 사용할 수 있는 사용자를 선택해 주세요.");
    }
    user.value = sender.userId || "";
    user.addEventListener("change", () => user.setCustomValidity(""));
    email.addEventListener("input", () => {
      agentRows.querySelectorAll('input[type="email"]').forEach(input => input.setCustomValidity(""));
    });
    const remove = action("삭제", () => {
      row.remove(); agentRows.querySelectorAll('input[type="email"]').forEach(input => input.setCustomValidity("")); markAgentDirty();
    }, "text-button mail-agent-remove");
    remove.setAttribute("aria-label", "이 발신자 등록 삭제");
    row.append(email, user, remove); agentRows.append(row);
    return email;
  }
  function renderAgentJobs() {
    if (!agentJobs) return;
    agentJobs.replaceChildren();
    const jobs = Array.isArray(agentData?.jobs) ? agentData.jobs.slice(0, 3) : [];
    const heading = node("div", "mail-agent-jobs-heading");
    heading.append(node("strong", "", "최근 메일 작업"), node("span", "mail-note", agentData?.lastCheckedAt ? `${dateLabel(agentData.lastCheckedAt)} 확인` : "아직 확인 전"));
    agentJobs.append(heading);
    if (!jobs.length) agentJobs.append(node("p", "mail-note", "아직 메일로 요청한 작업이 없습니다."));
    for (const job of jobs) {
      const row = node("div", "mail-agent-job");
      const copy = node("div", "mail-agent-job-copy");
      const title = node("p", "mail-agent-job-title");
      title.append(node("span", "mail-agent-job-state", jobStateLabel(job.status)), node("span", "", job.subject || "(제목 없음)"));
      copy.append(title, node("p", "mail-note", [job.from, dateLabel(job.receivedAt)].filter(Boolean).join(" · ")));
      const reasons = { invalid_received_date: "수신 시간 확인 안 됨", sender_not_allowed: "등록되지 않은 발신자", reply_not_confirmed: "답장 접수 확인 안 됨", reply_delivery_pending: "답장 재시도 대기", daily_limit: "일일 작업 한도에 도달함", mail_verification_unavailable: "서명 확인 대기", invalid_sender_or_recipient: "발신자·수신자 확인 안 됨", automatic_or_list_mail: "자동응답·메일링리스트 제외", sender_unverified: "서명 확인 안 됨", invalid_message_id: "메일 식별 정보 확인 안 됨", duplicate_message: "이미 처리한 메일", body_size_limit: "메일 본문이 너무 큼", execution_stopped: "작업 중단됨", task_failed: "작업 실행 실패", process_restarted: "서버 재시작으로 중단됨" };
      const reason = Object.hasOwn(reasons, job.reason) ? reasons[job.reason] : "";
      if (reason) copy.append(node("p", "mail-note mail-agent-reason", reason));
      row.append(copy);
      if (typeof openRoom === "function" && typeof job.roomId === "string" && job.roomId) {
        row.append(action("대화 열기", () => { const roomId = job.roomId; reset(); openRoom(roomId); }, "text-button"));
      }
      agentJobs.append(row);
    }
  }
  function renderAgentForm() {
    agentBody.replaceChildren();
    agentBody.append(node("p", "mail-note", "등록한 발신자의 새 메일로 작업하고 같은 메일에 결과를 답장합니다. 일반 메일은 보관만 하며 기존 전달은 유지됩니다."));
    agentForm = node("form", "mail-agent-form"); agentFields = node("fieldset");
    const toggle = node("label", "mail-agent-toggle");
    agentEnabled = node("input"); agentEnabled.type = "checkbox"; agentEnabled.setAttribute("role", "switch"); agentEnabled.checked = agentData.enabled === true;
    toggle.append(agentEnabled, node("span", "", "메일로 작업 사용")); agentFields.append(toggle);
    if (!agentData.configured) agentFields.append(node("p", "mail-note", "메일함 연결 후 사용할 수 있습니다. 발신자 등록은 미리 저장할 수 있습니다."));
    agentFields.append(node("p", "mail-agent-mapping-label", "등록 발신자 → 작업 사용자"));
    agentRows = node("div", "mail-agent-senders"); agentFields.append(agentRows);
    for (const sender of Array.isArray(agentData.senders) ? agentData.senders : []) addSender(sender);
    agentFields.append(action("+ 발신자 추가", () => { addSender().focus(); markAgentDirty(); }, "text-button mail-agent-add"));
    agentForm.addEventListener("input", markAgentDirty); agentForm.addEventListener("change", markAgentDirty);
    const footer = node("div", "mail-agent-footer");
    agentResult = node("p", "mail-note"); agentResult.setAttribute("role", "status"); agentResult.setAttribute("aria-live", "polite");
    agentSave = action("설정 저장", null, "outline-button"); agentSave.type = "submit";
    footer.append(agentResult, agentSave); agentForm.append(agentFields, footer);
    agentForm.addEventListener("submit", saveAgent);
    agentJobs = node("section", "mail-agent-jobs"); agentJobs.setAttribute("aria-label", "최근 메일 작업");
    agentBody.append(agentForm, agentJobs); updateAgentControls(); renderAgentJobs();
  }
  function scheduleAgentRefresh() {
    clearTimeout(agentTimer);
    if (!dialog?.open || !isAdmin()) return;
    const interval = Math.max(30, Math.min(300, Number(agentData?.pollIntervalSeconds) || 30));
    agentTimer = setTimeout(() => void loadAgent(true), interval * 1000);
  }
  async function loadAgent(poll = false) {
    if (!dialog?.open || !isAdmin()) return;
    if (agentLoading || agentSaving) { scheduleAgentRefresh(); return; }
    const requestEpoch = epoch, userId = getSession().user.id, sequence = ++agentRequest;
    agentLoading = true;
    try {
      const data = await api("/api/admin/mail/agent");
      if (!current(requestEpoch, userId) || sequence !== agentRequest) return;
      agentData = data; updateAgentSummary();
      if (!agentForm || (!poll && !agentDirty)) renderAgentForm();
      else { updateAgentControls(); renderAgentJobs(); }
    } catch (error) {
      if (!current(requestEpoch, userId) || sequence !== agentRequest) return;
      if (!agentData) {
        agentSummary.textContent = "메일로 작업 · 확인 필요";
        agentBody.replaceChildren(node("p", "mail-note", error.message || "메일 작업 설정을 불러오지 못했습니다. 새로고침해 주세요."));
      } else if (!poll && agentResult) agentResult.textContent = error.message || "메일 작업 상태를 확인하지 못했습니다.";
    } finally {
      if (current(requestEpoch, userId) && sequence === agentRequest) { agentLoading = false; scheduleAgentRefresh(); }
    }
  }
  async function saveAgent(event) {
    event.preventDefault();
    if (!agentForm || agentSaving || !agentDirty || !isAdmin() || !dialog?.open) return;
    const senders = [...agentRows.children].map(row => ({ email: row.querySelector("input").value.trim().toLowerCase(), userId: row.querySelector("select").value }));
    const seen = new Set();
    for (const [index, sender] of senders.entries()) {
      if (seen.has(sender.email)) {
        const input = agentRows.children[index].querySelector("input"); input.setCustomValidity("같은 발신자는 한 번만 등록해 주세요."); input.reportValidity(); return;
      }
      seen.add(sender.email);
    }
    if (!agentForm.reportValidity()) return;
    if (agentEnabled.checked && !senders.length) { agentResult.textContent = "작업을 요청할 발신자를 먼저 등록해 주세요."; return; }
    const requestEpoch = epoch, userId = getSession().user.id, sequence = ++agentRequest;
    agentLoading = false; agentSaving = true; clearTimeout(agentTimer);
    agentResult.textContent = "설정을 저장하고 있어요…"; updateAgentControls();
    try {
      const data = await api("/api/admin/mail/agent", { method: "POST", body: JSON.stringify({ enabled: agentEnabled.checked, senders }) });
      if (!current(requestEpoch, userId) || sequence !== agentRequest) return;
      agentData = data; agentDirty = false; updateAgentSummary();
      renderAgentForm(); agentResult.textContent = "저장했습니다.";
    } catch (error) {
      if (current(requestEpoch, userId) && sequence === agentRequest) agentResult.textContent = error.message || "설정을 저장하지 못했습니다. 다시 시도해 주세요.";
    } finally {
      if (current(requestEpoch, userId) && sequence === agentRequest) { agentSaving = false; updateAgentControls(); scheduleAgentRefresh(); }
    }
  }
  async function open() {
    if (!isAdmin()) { toast?.("관리자만 메일함을 볼 수 있습니다."); return; }
    ensureDialog();
    if (dialog.open) { dialog.focus(); return; }
    clearPrivateState(); count.textContent = "받은 메일"; updateControls(); dialog.showModal();
    await Promise.all([loadInbox(), loadAgent()]);
  }
  return { open, reset };
}
