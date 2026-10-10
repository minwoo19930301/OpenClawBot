const ID = /^[a-f0-9]{64}$/;
const MAX_PAGES = 4;
const MAX_TASKS = 10;
const DAILY_TASKS = 100;
const REPLY_WINDOW = 23 * 60 * 60 * 1000;
const fail = (message, status = 400) => Object.assign(new Error(message), {status});
const clip = (value, max) => typeof value === 'string' ? value.slice(0, max) : '';

function email(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (normalized.length > 254 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/.test(normalized)) return null;
  return normalized;
}

function messageIds(value) {
  const text = Array.isArray(value) ? value.join(' ') : typeof value === 'string' ? value : '';
  return [...new Set((text.slice(0, 16000).match(/<[^<>\s\x00-\x1f\x7f]{1,998}>/g) || []).slice(-100))];
}

/** Durable task/reply state. No MIME, credentials, or raw exception text is persisted. */
export function createMailAgent({db, mailbox, env = {}, verifyMail, runTask, canRunTask = () => true, now = Date.now}) {
  if (!db || typeof verifyMail !== 'function' || typeof runTask !== 'function') throw new TypeError('Mail agent dependencies are required');
  const interval = Number(env.COMMUNITY_MAIL_AGENT_POLL_SECONDS ?? 60);
  if (!Number.isSafeInteger(interval) || interval < 15 || interval > 3600) throw fail('메일 확인 간격은 15~3600초여야 합니다.');
  const timestamp = () => { const value = Number(now()); if (!Number.isFinite(value)) throw new Error('Invalid clock'); return Math.floor(value); };
  const configured = Boolean(mailbox?.configured);
  db.exec(`
    CREATE TABLE IF NOT EXISTS mail_agent_config (
      id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL, senders TEXT NOT NULL,
      first_enabled_at INTEGER, cursor TEXT, last_checked_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS mail_agent_jobs (
      id TEXT PRIMARY KEY, user_id TEXT, sender TEXT NOT NULL, subject TEXT NOT NULL,
      received_at TEXT NOT NULL, received_ms INTEGER NOT NULL, message_id TEXT,
      status TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', room_id TEXT,
      reply_text TEXT, reply_request_id TEXT, reply_attempts INTEGER NOT NULL DEFAULT 0,
      reply_created_at INTEGER, reply_last_attempt_at INTEGER, started_at INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS mail_agent_message_identity
      ON mail_agent_jobs(sender,message_id) WHERE message_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS mail_agent_pending ON mail_agent_jobs(status,received_ms);
    CREATE INDEX IF NOT EXISTS mail_agent_user_runs ON mail_agent_jobs(user_id,started_at);
  `);
  const users = () => db.prepare('SELECT id,username,display_name FROM users ORDER BY created_at,id').all();
  function validateSenders(senders) {
    if (!Array.isArray(senders) || senders.length > 50) throw fail('허용할 메일 주소는 최대 50개입니다.');
    const known = new Set(users().map(user => user.id)), seen = new Set();
    return senders.map(sender => {
      const address = email(sender?.email);
      if (!address || seen.has(address) || typeof sender?.userId !== 'string' || !known.has(sender.userId)) throw fail('메일 주소와 등록된 사용자를 확인해 주세요.');
      seen.add(address);
      return {email:address, userId:sender.userId};
    });
  }
  if (!db.prepare('SELECT 1 FROM mail_agent_config WHERE id=1').get()) {
    let senders = [];
    if (env.COMMUNITY_MAIL_AGENT_USERS) {
      try { senders = JSON.parse(env.COMMUNITY_MAIL_AGENT_USERS); }
      catch { throw fail('메일 에이전트 사용자 설정이 올바르지 않습니다.'); }
    }
    senders = validateSenders(senders);
    const enabled = env.COMMUNITY_MAIL_AGENT_ENABLED === '1';
    if (enabled && (!configured || !senders.length)) throw fail('메일 연결과 허용할 사용자를 먼저 설정해 주세요.', 409);
    db.prepare('INSERT INTO mail_agent_config VALUES(1,?,?,?,NULL,NULL)').run(Number(enabled), JSON.stringify(senders), enabled ? timestamp() : null);
  }
  // A crash can occur after a tool has changed external state. Never replay that task.
  db.prepare("UPDATE mail_agent_jobs SET status='interrupted',reason='process_restarted',updated_at=? WHERE status='running'").run(timestamp());

  let polling = null, timer = null, closed = false, active = null;
  const config = () => db.prepare('SELECT * FROM mail_agent_config WHERE id=1').get();
  const mappings = () => JSON.parse(config().senders);
  const job = id => db.prepare('SELECT * FROM mail_agent_jobs WHERE id=?').get(id);
  function permitted(row) {
    return !closed && Boolean(config().enabled) && mappings().some(sender => sender.email === row.sender && sender.userId === row.user_id) &&
      Boolean(db.prepare('SELECT 1 FROM users WHERE id=?').get(row.user_id));
  }
  function status(id, state, reason = '') {
    db.prepare('UPDATE mail_agent_jobs SET status=?,reason=?,updated_at=? WHERE id=?').run(state, reason, timestamp(), id);
  }
  function view() {
    const state = config(), available = users();
    return {
      configured, enabled:Boolean(state.enabled),
      senders:JSON.parse(state.senders).map(sender => {
        const user = available.find(user => user.id === sender.userId);
        return {...sender, username:user?.username || '', displayName:user?.display_name || ''};
      }),
      users:available.map(user => ({id:user.id, username:user.username, displayName:user.display_name})),
      jobs:db.prepare('SELECT id,status,room_id,subject,sender,received_at,reason FROM mail_agent_jobs ORDER BY created_at DESC,rowid DESC LIMIT 25').all()
        .map(row => ({id:row.id, status:row.status, roomId:row.room_id, subject:row.subject, from:row.sender, receivedAt:row.received_at, reason:row.reason})),
      lastCheckedAt:state.last_checked_at === null ? null : new Date(state.last_checked_at).toISOString(),
      pollIntervalSeconds:interval,
    };
  }
  function configure(input) {
    if (!input || typeof input.enabled !== 'boolean') throw fail('메일 자동 작업 설정을 확인해 주세요.');
    const senders = validateSenders(input.senders);
    if (input.enabled && (!configured || !senders.length)) throw fail('메일 연결과 허용할 사용자를 먼저 설정해 주세요.', 409);
    const state = config();
    db.prepare('UPDATE mail_agent_config SET enabled=?,senders=?,first_enabled_at=? WHERE id=1')
      .run(Number(input.enabled), JSON.stringify(senders), state.first_enabled_at ?? (input.enabled ? timestamp() : null));
    if (active && !permitted(active.row)) active.controller.abort();
    return view();
  }

  async function discover() {
    const seenCursors = new Set();
    for (let page = 0; page < MAX_PAGES && !closed && config().enabled; page++) {
      const state = config(), cursor = state.cursor || undefined;
      if (seenCursors.has(cursor)) { db.prepare('UPDATE mail_agent_config SET cursor=NULL WHERE id=1').run(); break; }
      seenCursors.add(cursor);
      const listing = await mailbox.list(cursor);
      if (!Array.isArray(listing?.messages)) throw new Error('Invalid mail listing');
      const allowed = mappings();
      for (const item of listing.messages.slice(0, 50)) {
        if (!ID.test(item?.id || '')) continue;
        const received = Date.parse(item.receivedAt);
        if (Number.isFinite(received) && received < state.first_enabled_at) continue;
        const sender = email(item.from), mapping = allowed.find(row => row.email === sender);
        const validDate = Number.isFinite(received) && received <= timestamp() + 300000;
        db.prepare(`INSERT OR IGNORE INTO mail_agent_jobs
          (id,user_id,sender,subject,received_at,received_ms,status,reason,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?)`).run(item.id, mapping?.userId ?? null, sender || '', clip(item.subject, 1000), clip(item.receivedAt, 64),
          validDate ? received : 0, mapping && validDate ? 'queued' : 'ignored', !validDate ? 'invalid_received_date' : mapping ? '' : 'sender_not_allowed', timestamp(), timestamp());
      }
      const next = typeof listing.cursor === 'string' && listing.cursor.length <= 2048 && !/[\x00-\x1f]/.test(listing.cursor) ? listing.cursor : null;
      db.prepare('UPDATE mail_agent_config SET cursor=? WHERE id=1').run(next);
      if (!next) break;
    }
  }

  function saveReply(id, text, roomId, reason = '') {
    db.prepare(`UPDATE mail_agent_jobs SET status='reply_pending',reason=?,reply_text=?,room_id=?,reply_request_id=?,reply_created_at=?,updated_at=? WHERE id=?`)
      .run(reason, text, roomId, 'mail-agent-' + id, timestamp(), timestamp(), id);
  }
  async function sendReply(row) {
    if (!permitted(row)) { if (config().enabled && !closed) status(row.id, 'ignored', 'sender_not_allowed'); return; }
    if (row.reply_attempts >= 5 || timestamp() - row.reply_created_at >= REPLY_WINDOW) { status(row.id, 'uncertain', 'reply_not_confirmed'); return; }
    const delay = Math.min(900000, 60000 * 2 ** Math.max(0, row.reply_attempts - 1));
    if (row.reply_last_attempt_at !== null && timestamp() - row.reply_last_attempt_at < delay) return;
    db.prepare('UPDATE mail_agent_jobs SET reply_attempts=reply_attempts+1,reply_last_attempt_at=?,updated_at=? WHERE id=?').run(timestamp(), timestamp(), row.id);
    try {
      const result = await mailbox.send({action:'reply', id:row.id, text:row.reply_text, requestId:row.reply_request_id, automatic:true});
      if (result?.accepted !== true) throw new Error('Reply not confirmed');
      status(row.id, 'sent', row.reason === 'reply_delivery_pending' ? '' : row.reason);
    } catch {
      const latest = job(row.id);
      status(row.id, latest.reply_attempts >= 5 ? 'uncertain' : 'reply_pending', latest.reply_attempts >= 5 ? 'reply_not_confirmed' : 'reply_delivery_pending');
    }
  }

  async function execute(row) {
    if (!permitted(row)) { if (config().enabled && !closed) status(row.id, 'ignored', 'sender_not_allowed'); return false; }
    const current = timestamp(), dayStart = Math.floor(current / 86400000) * 86400000;
    if (db.prepare('SELECT count(*) AS n FROM mail_agent_jobs WHERE user_id=? AND started_at>=? AND started_at<?').get(row.user_id, dayStart, dayStart + 86400000).n >= DAILY_TASKS) {
      status(row.id, 'queued', 'daily_limit'); return false;
    }
    if (!await canRunTask()) return false;
    let message, verification;
    try {
      message = await mailbox.read(row.id);
      if (!email(message?.to) || email(message.from) !== row.sender || email(message.to) === row.sender) {
        status(row.id, 'ignored', 'invalid_sender_or_recipient'); return false;
      }
      verification = await verifyMail(await mailbox.raw(row.id), {expectedFrom:row.sender, expectedTo:message.to, now:timestamp()});
    } catch { status(row.id, 'queued', 'mail_verification_unavailable'); return false; }
    if (!permitted(row)) return false;
    if (verification?.verified !== true || email(verification.from) !== row.sender) {
      const automatic = ['skipped_automated','skipped_mailing_list','skipped_delivery_report','skipped_thread_limit'].includes(verification?.reason);
      status(row.id, 'ignored', automatic ? 'automatic_or_list_mail' : 'sender_unverified'); return false;
    }
    const verifiedIds = messageIds(verification.messageId);
    if (verifiedIds.length !== 1 || verifiedIds[0] !== verification.messageId) { status(row.id, 'ignored', 'invalid_message_id'); return false; }
    const messageId = verifiedIds[0];
    const duplicate = db.prepare('SELECT id FROM mail_agent_jobs WHERE sender=? AND message_id=? AND id!=?').get(row.sender, messageId, row.id);
    if (duplicate) { status(row.id, 'ignored', 'duplicate_message'); return false; }
    db.prepare('UPDATE mail_agent_jobs SET message_id=?,subject=?,reason=?,updated_at=? WHERE id=?')
      .run(messageId, clip(verification.subject, 1000), '', timestamp(), row.id);
    let roomId = null;
    const references = messageIds(verification.references), inReplyTo = messageIds(verification.inReplyTo);
    for (const reference of [...inReplyTo, ...references.reverse()]) {
      const previous = db.prepare('SELECT room_id FROM mail_agent_jobs WHERE user_id=? AND message_id=? AND id!=? AND room_id IS NOT NULL ORDER BY created_at DESC LIMIT 1')
        .get(row.user_id, reference, row.id);
      if (previous) { roomId = previous.room_id; break; }
    }
    if (typeof message.text !== 'string' || message.text.length > 8000 || !message.text.trim()) {
      saveReply(row.id, '자동 작업을 실행하지 않았습니다. 메일 본문에 요청을 8,000자 이내로 적어 다시 보내 주세요.', roomId, 'body_size_limit');
      await sendReply(job(row.id));
      return true;
    }
    if (!await canRunTask() || !permitted(row)) return false;
    const controller = new AbortController();
    active = {row, controller};
    db.prepare("UPDATE mail_agent_jobs SET status='running',reason='',room_id=?,started_at=?,updated_at=? WHERE id=?").run(roomId, timestamp(), timestamp(), row.id);
    const deadline = setTimeout(() => controller.abort(), 180000);
    deadline.unref?.();
    try {
      const result = await runTask({userId:row.user_id, id:row.id, roomId, signal:controller.signal, message:{
        id:row.id, from:row.sender, to:email(message.to), subject:clip(verification.subject, 1000), text:message.text,
        messageId, inReplyTo:inReplyTo[0] || '', references:messageIds(verification.references).join(' '), date:clip(verification.date, 100),
      }});
      if (controller.signal.aborted || !permitted(row)) { status(row.id, 'interrupted', 'execution_stopped'); return true; }
      if (typeof result?.text !== 'string' || !result.text.trim() || typeof result.roomId !== 'string' || !result.roomId) throw new Error('Invalid task result');
      saveReply(row.id, result.text.slice(0, 16000), result.roomId);
    } catch (error) {
      // Only the trusted runner may certify a pre-execution capacity race as safe to retry.
      if (error?.safeToRetry === true && !controller.signal.aborted && permitted(row)) {
        db.prepare("UPDATE mail_agent_jobs SET status='queued',reason='agent_busy',started_at=NULL,updated_at=? WHERE id=?").run(timestamp(), row.id);
        return false;
      }
      status(row.id, controller.signal.aborted ? 'interrupted' : 'failed', controller.signal.aborted ? 'execution_stopped' : 'task_failed');
      return true;
    }
    finally { clearTimeout(deadline); active = null; }
    await sendReply(job(row.id));
    return true;
  }

  async function check() {
    if (closed || !configured || !config().enabled) return view();
    db.prepare('UPDATE mail_agent_config SET last_checked_at=? WHERE id=1').run(timestamp());
    try { await discover(); } catch { /* Existing queued work can still finish during a listing outage. */ }
    let handled = 0;
    for (const row of db.prepare("SELECT * FROM mail_agent_jobs WHERE status='reply_pending' ORDER BY created_at LIMIT 10").all()) {
      if (closed || !config().enabled) break;
      await sendReply(row);
    }
    for (const row of db.prepare("SELECT * FROM mail_agent_jobs WHERE status='queued' ORDER BY received_ms,created_at LIMIT 100").all()) {
      if (closed || !config().enabled || handled >= MAX_TASKS) break;
      try { if (await execute(row)) handled++; }
      catch { if (job(row.id)?.status === 'running') status(row.id, 'interrupted', 'execution_stopped'); }
    }
    return view();
  }
  function poll() {
    if (polling) return polling;
    polling = check().finally(() => { polling = null; });
    return polling;
  }
  function start() {
    if (closed || timer) return;
    void poll().catch(() => {});
    timer = setInterval(() => { void poll().catch(() => {}); }, interval * 1000);
    timer.unref?.();
  }
  async function close() {
    closed = true;
    if (timer) clearInterval(timer);
    timer = null;
    active?.controller.abort();
    await polling?.catch(() => {});
  }
  return {view, configure, poll, start, close};
}
