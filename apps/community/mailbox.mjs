const failure = (status, message) => Object.assign(new Error(message), { status });
const idPattern = /^[a-f0-9]{64}$/;
const string = (value, max) => typeof value === 'string' ? value.slice(0, max) : '';
const summary = item => ({
  id: string(item?.id, 64), from: string(item?.from, 320),
  subject: string(item?.subject, 1000), receivedAt: string(item?.receivedAt, 64),
});

/** The mailbox credential remains on the server; never return upstream objects verbatim. */
export function createMailbox({ env = {}, fetchImpl = fetch } = {}) {
  let endpoint;
  try {
    const url = new URL(env.COMMUNITY_MAIL_URL);
    if (url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash) endpoint = url;
  } catch {}
  const token = env.COMMUNITY_MAIL_TOKEN;
  const configured = Boolean(endpoint && typeof token === 'string' && token);
  async function request(query, payload, raw = false) {
    if (!configured) throw failure(409, '서버에 메일함 연결 정보가 없습니다.');
    const url = new URL(endpoint);
    for (const [name, value] of Object.entries(query || {})) if (value) url.searchParams.set(name, value);
    let response;
    try {
      response = await fetchImpl(url.href, {
        method: payload ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(20000),
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', 'user-agent': 'OpenClaw-Mail/1.0' },
        ...(payload ? { body: JSON.stringify(payload) } : {}),
      });
    } catch { throw failure(502, payload ? '발송 결과를 확인하지 못했습니다. 내용을 유지한 채 다시 시도하면 같은 요청 번호를 사용합니다.' : '메일 서버에 연결하지 못했습니다. 다시 시도해 주세요.'); }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 404) throw failure(404, '메일을 찾을 수 없습니다.');
      if ([401, 403].includes(response.status)) throw failure(409, '메일 연결 인증 또는 접근 권한을 확인해 주세요.');
      throw failure(502, payload ? '메일 서버가 발송을 완료하지 못했습니다. 연결과 발신 설정을 확인해 주세요.' : '메일 서버가 요청을 처리하지 못했습니다.');
    }
    try {
      let size = 0; const chunks = [];
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > (raw ? 10 : 2) * 1024 * 1024) throw new Error('Mailbox response too large');
        chunks.push(Buffer.from(chunk));
      }
      const bytes = Buffer.concat(chunks);
      return raw ? bytes : JSON.parse(bytes.toString('utf8'));
    } catch { throw failure(502, '메일 서버 응답을 읽지 못했습니다.'); }
  }
  return {
    configured,
    async list(cursor) {
      if (!configured) return { configured: false, address: '', messages: [], cursor: null };
      if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 2048 || /[\x00-\x1f]/.test(cursor))) throw failure(400, '메일 목록 위치가 올바르지 않습니다.');
      const data = await request({ cursor });
      if (!Array.isArray(data?.messages)) throw failure(502, '메일 목록 응답이 올바르지 않습니다.');
      return { configured: true, address: string(data.address, 320),
        messages: data.messages.slice(0, 50).map(summary).filter(m => idPattern.test(m.id)),
        cursor: typeof data.cursor === 'string' && data.cursor.length <= 2048 ? data.cursor : null };
    },
    async read(id) {
      if (typeof id !== 'string' || !idPattern.test(id)) throw failure(400, '메일 번호가 올바르지 않습니다.');
      const data = await request({ id });
      if (data?.id !== id) throw failure(502, '메일 응답이 올바르지 않습니다.');
      return { ...summary(data), to: string(data.to, 320), text: string(data.text, 200000),
        attachments: Array.isArray(data.attachments) ? data.attachments.slice(0, 100).map(a => ({ filename: string(a?.filename, 255), mimeType: string(a?.mimeType, 120) })) : [],
        contentTrust: 'untrusted-email-content' };
    },
    // Original MIME is only used internally for cryptographic sender verification.
    async raw(id) {
      if (typeof id !== 'string' || !idPattern.test(id)) throw failure(400, '메일 번호가 올바르지 않습니다.');
      return request({ id, raw: '1' }, undefined, true);
    },
    async send(input = {}) {
      const { action, id, to, subject, text, requestId } = input;
      if (!['send', 'reply'].includes(action)) throw failure(400, '메일 작성 또는 답장을 선택해 주세요.');
      if (typeof text !== 'string' || !text.trim() || text.length > 40000) throw failure(400, '메일 내용은 1~40,000자여야 합니다.');
      if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(requestId)) throw failure(400, '메일 요청 번호가 올바르지 않습니다.');
      const payload = { action, text, requestId };
      if (input.automatic === true) payload.automatic = true;
      if (action === 'reply') {
        if (typeof id !== 'string' || !idPattern.test(id)) throw failure(400, '답장할 메일을 선택해 주세요.');
        payload.id = id;
      } else {
        if (typeof to !== 'string' || to.length > 254 || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(to)) throw failure(400, '받는 사람의 메일 주소 한 개를 입력해 주세요.');
        if (typeof subject !== 'string' || subject.length > 1000 || /[\r\n]/.test(subject)) throw failure(400, '메일 제목을 확인해 주세요.');
        Object.assign(payload, { to, subject });
      }
      if (Buffer.byteLength(JSON.stringify(payload)) > 65536) throw failure(413, '메일 내용을 조금 줄여 주세요.');
      const data = await request({}, payload);
      if (data?.accepted !== true) throw failure(502, '메일 발송 접수를 확인하지 못했습니다.');
      return { accepted: true, id: string(data.id, 200), from: string(data.from, 320) };
    },
  };
}
