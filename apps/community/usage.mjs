const MAX_COUNT = 1_000_000_000_000;
const QUOTA_NOTE = "사용량은 이 앱이 받은 API 응답 기준입니다. 잔여 한도는 제공자의 마지막 응답 헤더 기준이며 현재 잔액이나 크레딧이 아닙니다. Groq 요청 한도는 일일 요청, 토큰 한도는 분당 토큰이며 조직 단위입니다. Gemini 한도는 프로젝트 단위입니다. 키별 값을 합산하지 않습니다.";

function count(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_COUNT ? value : null;
}

function headerCount(value) {
  return typeof value === "string" && /^\d{1,13}$/.test(value.trim()) ? count(Number(value)) : null;
}

function resetValue(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text.length > 64) return null;
  // Providers return seconds, duration strings such as 2m59.56s, or ISO timestamps.
  return /^(?:\d+(?:\.\d+)?(?:ms|s|m|h|d))+$/.test(text) || /^\d{1,13}(?:\.\d{1,6})?$/.test(text) ||
    (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(text) && Number.isFinite(Date.parse(text)))
    ? text : null;
}

function safeName(value, max, pattern) {
  return typeof value === "string" && value.length <= max && pattern.test(value) ? value : null;
}

function sanitizeLimit(value) {
  if (!value || typeof value !== "object") return null;
  const result = { limit: count(value.limit), remaining: count(value.remaining), reset: resetValue(value.reset) };
  return Object.values(result).every(item => item === null) ? null : result;
}

function sanitizeEvent(event) {
  if (!event || typeof event !== "object" || !Number.isInteger(event.status) || event.status < 100 || event.status > 599) return null;
  const successful = event.status >= 200 && event.status < 300;
  return {
    provider: safeName(event.provider, 64, /^[a-zA-Z0-9_.-]+$/) || "unknown",
    keySlot: Number.isSafeInteger(event.keySlot) && event.keySlot >= 0 && event.keySlot < 10000 ? event.keySlot : null,
    model: safeName(event.model, 200, /^[\w.:/@+-]+$/),
    status: event.status,
    at: Number.isSafeInteger(event.at) && event.at >= 0 && event.at <= 8_640_000_000_000_000 ? event.at : Date.now(),
    inputTokens: successful ? count(event.inputTokens) : null,
    outputTokens: successful ? count(event.outputTokens) : null,
    limits: { requests: sanitizeLimit(event.limits?.requests), tokens: sanitizeLimit(event.limits?.tokens) },
  };
}

/** Extract only public accounting fields; never retain headers, URLs, keys, or response text. */
export function usageEvent({ provider, keySlot, model, status, headers, usage, at = Date.now() } = {}) {
  const read = name => {
    try { return typeof headers?.get === "function" ? headers.get(name) : null; }
    catch { return null; }
  };
  const dimension = kind => ({
    limit: headerCount(read(`x-ratelimit-limit-${kind}`)),
    remaining: headerCount(read(`x-ratelimit-remaining-${kind}`)),
    reset: resetValue(read(`x-ratelimit-reset-${kind}`)),
  });
  return sanitizeEvent({
    provider, keySlot, model, status, at,
    inputTokens: count(usage?.prompt_tokens) ?? count(usage?.input_tokens),
    outputTokens: count(usage?.completion_tokens) ?? count(usage?.output_tokens),
    limits: { requests: dimension("requests"), tokens: dimension("tokens") },
  });
}

/** Persistent observed usage; a missing measurement remains null, distinct from measured zero. */
export function createUsageStore(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS model_usage_totals (
      room_id TEXT PRIMARY KEY,
      requests INTEGER NOT NULL,
      input_tokens INTEGER,
      output_tokens INTEGER,
      last_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS model_usage_providers (
      provider TEXT NOT NULL,
      key_slot INTEGER NOT NULL,
      last_json TEXT NOT NULL,
      PRIMARY KEY(provider,key_slot)
    );
  `);
  const add = db.prepare(`INSERT INTO model_usage_totals VALUES(?,1,?,?,?)
    ON CONFLICT(room_id) DO UPDATE SET
      requests=MIN(model_usage_totals.requests+1,${MAX_COUNT}),
      input_tokens=CASE WHEN excluded.input_tokens IS NULL THEN model_usage_totals.input_tokens
        ELSE MIN(COALESCE(model_usage_totals.input_tokens,0)+excluded.input_tokens,${MAX_COUNT}) END,
      output_tokens=CASE WHEN excluded.output_tokens IS NULL THEN model_usage_totals.output_tokens
        ELSE MIN(COALESCE(model_usage_totals.output_tokens,0)+excluded.output_tokens,${MAX_COUNT}) END,
      last_json=excluded.last_json`);
  const latest = db.prepare(`INSERT INTO model_usage_providers VALUES(?,?,?)
    ON CONFLICT(provider,key_slot) DO UPDATE SET last_json=excluded.last_json`);
  const room = db.prepare("SELECT * FROM model_usage_totals WHERE room_id=?");
  const providers = db.prepare("SELECT last_json FROM model_usage_providers ORDER BY provider,key_slot");
  function decoded(value) {
    try { return sanitizeEvent(JSON.parse(value)); } catch { return null; }
  }
  return {
    record(roomId, value) {
      if (typeof roomId !== "string" || !roomId || roomId.length > 200) return;
      const event = sanitizeEvent(value);
      if (!event) return;
      const encoded = JSON.stringify(event);
      db.exec("SAVEPOINT record_model_usage");
      try {
        add.run(roomId, event.inputTokens, event.outputTokens, encoded);
        latest.run(event.provider, event.keySlot ?? -1, encoded);
        db.exec("RELEASE record_model_usage");
      } catch (error) {
        db.exec("ROLLBACK TO record_model_usage; RELEASE record_model_usage");
        throw error;
      }
    },
    snapshot(roomId, { includeProviders = false } = {}) {
      const row = typeof roomId === "string" ? room.get(roomId) : null;
      return {
        inputTokens: count(row?.input_tokens),
        outputTokens: count(row?.output_tokens),
        requests: count(row?.requests) ?? 0,
        last: row ? decoded(row.last_json) : null,
        providers: includeProviders ? providers.all().map(item => decoded(item.last_json)).filter(Boolean) : [],
        quotaNote: QUOTA_NOTE,
      };
    },
  };
}
