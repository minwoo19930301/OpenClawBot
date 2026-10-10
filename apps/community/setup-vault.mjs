import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync, chmodSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { readProviders } from './providers.mjs';

export const DEFAULT_BOT_NAME = 'CustomCloudBot';
export const AI_CATALOG = [
  ['groq', 'Groq', 'https://api.groq.com/openai/v1'],
  ['gemini', 'Gemini', 'https://generativelanguage.googleapis.com/v1beta/openai'],
  ['huggingface', 'Hugging Face', 'https://router.huggingface.co/v1'],
  ['openrouter', 'OpenRouter', 'https://openrouter.ai/api/v1'],
  ['openai', 'OpenAI API', 'https://api.openai.com/v1'],
  ['nvidia', 'NVIDIA NIM', 'https://integrate.api.nvidia.com/v1'],
  ['cohere', 'Cohere', 'https://api.cohere.ai/compatibility/v1'],
  ['xai', 'xAI', 'https://api.x.ai/v1'],
  ['custom', 'OpenAI 호환 API', ''],
].map(([id, name, baseUrl]) => ({ id, name, baseUrl }));

const invalid = message => Object.assign(new Error(message), { status: 400 });
const str = (value, max = 200) => {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw invalid('설정 값의 형식과 길이를 확인해 주세요.');
  return value.trim();
};
function endpoint(value, gateway = false) {
  const raw = str(value, 500);
  let url;
  try { url = new URL(raw); } catch { throw invalid('올바른 서버 주소를 입력해 주세요.'); }
  const local = ['localhost', '127.0.0.1', '[::1]', ...(gateway ? ['openclaw'] : [])].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))) throw invalid('HTTPS 주소를 사용해 주세요. 로컬 연결은 HTTP를 사용할 수 있습니다.');
  return url.href.replace(/\/+$/, '');
}
function secret(value) {
  const result = str(value, 8192);
  if (!result) throw invalid('새 연결의 인증 정보를 입력해 주세요.');
  return result;
}
const safeFile = path => {
  const info = lstatSync(path);
  if (!info.isFile() || info.size > 1024 * 1024) throw new Error('Invalid vault file');
  chmodSync(path, 0o600);
};

/** Only encrypted credentials are persisted. The local key must be backed up with the vault. */
export function createSetupVault(dataDir, env = {}) {
  const path = join(dataDir, 'setup-vault.json');
  const keyPath = join(dataDir, 'setup-vault.key');
  let key;
  let state = { version: 1, profile: { displayName: DEFAULT_BOT_NAME, cloud: '', domain: '', mail: '' }, providers: [], gateway: null, backend: '', completed: false };
  try {
    if (existsSync(keyPath)) { safeFile(keyPath); key = readFileSync(keyPath); if (key.length !== 32) throw new Error('Invalid key'); }
    if (existsSync(path)) {
      safeFile(path);
      if (!key) throw new Error('Missing key');
      const saved = JSON.parse(readFileSync(path, 'utf8'));
      if (saved.version !== 1) throw new Error('Invalid version');
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(saved.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(saved.tag, 'base64'));
      state = JSON.parse(Buffer.concat([decipher.update(Buffer.from(saved.data, 'base64')), decipher.final()]).toString('utf8'));
      if (state.version !== 1 || !state.profile || !Array.isArray(state.providers)) throw new Error('Invalid state');
    }
  } catch { throw new Error('설정 Vault를 읽지 못했습니다. Vault와 암호화 키를 함께 복구해 주세요. 기존 파일은 변경하지 않았습니다.'); }

  function save(next) {
    if (!key) {
      key = randomBytes(32);
      writeFileSync(keyPath, key, { mode: 0o600, flag: 'wx' });
    }
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(next), 'utf8'), cipher.final()]);
    const envelope = JSON.stringify({ version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') });
    if (Buffer.byteLength(envelope) > 1024 * 1024) throw invalid('Vault 저장 한도를 초과했습니다.');
    const tmp = path + '.' + randomUUID() + '.tmp';
    writeFileSync(tmp, envelope, { mode: 0o600, flag: 'wx' });
    renameSync(tmp, path);
    state = next;
  }
  function runtimeEnv() {
    const next = { ...env };
    // Existing environment credentials stay intact; additions are separate slots.
    let prior = [];
    try { const parsed = JSON.parse(env.COMMUNITY_LLM_PROVIDERS || '[]'); if (Array.isArray(parsed)) prior = parsed; } catch {}
    next.COMMUNITY_LLM_PROVIDERS = JSON.stringify([...prior, ...state.providers.map(p => ({ name: p.provider, baseUrl: p.baseUrl, apiKey: p.apiKey, model: p.model }))]);
    if (state.gateway?.enabled) {
      next.COMMUNITY_OPENCLAW_BASE_URL = state.gateway.baseUrl;
      next.COMMUNITY_OPENCLAW_TOKEN = state.gateway.token;
      next.COMMUNITY_OPENCLAW_AGENT_ID = state.gateway.agentId;
      if (new URL(state.gateway.baseUrl).hostname === 'openclaw') next.COMMUNITY_OPENCLAW_ALLOW_PRIVATE_HTTP = '1';
    }
    return next;
  }
  function view({ configured = false, activeBackend = 'none', subscriptions = [] } = {}) {
    const effective = runtimeEnv();
    const gatewayConfigured = Boolean(effective.COMMUNITY_OPENCLAW_BASE_URL && effective.COMMUNITY_OPENCLAW_TOKEN);
    const environment = readProviders(env).map((p, i) => ({ id: 'environment-' + i, provider: p.name, name: p.name, baseUrl: p.baseUrl, model: env[p.name.toUpperCase() + '_MODEL'] || '', hasKey: true, source: 'environment' }));
    return {
      profile: { ...state.profile }, setupRequired: !state.completed && !configured,
      providers: [...environment, ...state.providers.map(({ apiKey, ...p }) => ({ ...p, name: AI_CATALOG.find(c => c.id === p.provider)?.name || p.provider, hasKey: Boolean(apiKey), source: 'vault' }))],
      catalog: AI_CATALOG,
      gateway: { configured: gatewayConfigured, hasToken: gatewayConfigured, baseUrl: effective.COMMUNITY_OPENCLAW_BASE_URL || '', agentId: effective.COMMUNITY_OPENCLAW_AGENT_ID || 'default', source: state.gateway?.enabled ? 'vault' : gatewayConfigured ? 'environment' : null },
      subscriptions, activeBackend,
    };
  }
  return {
    view, runtimeEnv,
    get name() { return state.profile.displayName; },
    get backend() { return state.backend; },
    profile(input) {
      const displayName = str(input.displayName ?? state.profile.displayName, 48);
      if (!displayName) throw invalid('봇 이름을 입력해 주세요.');
      const cloud = str(input.cloud ?? state.profile.cloud, 40);
      if (!['', 'local', 'oci', 'aws', 'gcp', 'azure', 'other'].includes(cloud)) throw invalid('서버 종류를 다시 선택해 주세요.');
      const domain = str(input.domain ?? state.profile.domain, 200);
      const mail = str(input.mail ?? state.profile.mail, 200);
      if (domain && !/^(?:[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?)(?::\d{1,5})?$/.test(domain)) throw invalid('도메인은 경로 없이 입력해 주세요.');
      if (mail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) throw invalid('메일 주소를 확인해 주세요.');
      save({ ...state, profile: { displayName, cloud, domain, mail }, completed: true });
    },
    provider(input) {
      const provider = str(input.provider, 40), catalog = AI_CATALOG.find(p => p.id === provider);
      if (!catalog) throw invalid('지원하는 AI 공급자를 선택해 주세요.');
      const id = input.id ? str(input.id, 80) : randomUUID();
      const previous = state.providers.find(p => p.id === id);
      if (input.id && !previous) throw invalid('수정할 Vault 연결을 찾지 못했습니다.');
      if (!previous && state.providers.length >= 32) throw invalid('Vault AI 연결은 최대 32개입니다.');
      const baseUrl = endpoint(input.baseUrl || catalog.baseUrl);
      if (previous && !input.apiKey && (previous.provider !== provider || previous.baseUrl !== baseUrl)) throw invalid('공급자나 주소를 변경하면 새 인증 정보를 입력해 주세요.');
      const apiKey = input.apiKey ? secret(input.apiKey) : previous?.apiKey;
      if (!apiKey) throw invalid('API 키를 입력해 주세요.');
      const model = str(input.model ?? previous?.model ?? '', 200);
      if (model && !/^[\w.:/@+-]{1,200}$/.test(model)) throw invalid('모델 ID를 확인해 주세요.');
      const providers = [...state.providers.filter(p => p.id !== id), { id, provider, baseUrl, apiKey, model }];
      save({ ...state, providers });
    },
    gateway(input) {
      const prior = state.gateway || { baseUrl: env.COMMUNITY_OPENCLAW_BASE_URL, token: env.COMMUNITY_OPENCLAW_TOKEN, agentId: env.COMMUNITY_OPENCLAW_AGENT_ID };
      const baseUrl = endpoint(input.baseUrl, true);
      if (!input.token && prior.baseUrl && endpoint(prior.baseUrl, true) !== baseUrl) throw invalid('서버 주소를 변경하면 새 Gateway 토큰을 입력해 주세요.');
      const token = input.token ? secret(input.token) : prior.token;
      if (!token || token.length < 16) throw invalid('Gateway 토큰은 16자 이상이어야 합니다.');
      const agentId = str(input.agentId || prior.agentId || 'default', 80);
      if (!/^[\w.-]{1,80}$/.test(agentId)) throw invalid('에이전트 ID를 확인해 주세요.');
      save({ ...state, gateway: { baseUrl, token, agentId, enabled: true } });
    },
    selectBackend(backend) {
      if (!['api', 'gateway'].includes(backend)) throw invalid('AI 실행 방식을 선택해 주세요.');
      const effective = runtimeEnv();
      if (backend === 'gateway' && !(effective.COMMUNITY_OPENCLAW_BASE_URL && effective.COMMUNITY_OPENCLAW_TOKEN)) throw invalid('먼저 Gateway를 연결해 주세요.');
      if (backend === 'api' && !readProviders(effective).length) throw invalid('먼저 API 키를 연결해 주세요.');
      save({ ...state, backend });
    },
  };
}
