export const EFFORTS = ["low", "medium", "high", "xhigh"];
const validModel = (value) => typeof value === "string" && /^[\w.:/@+-]{1,200}$/.test(value) ? value : "";

const KNOWN = [
  ["huggingface", "https://router.huggingface.co/v1", "HUGGINGFACE_TOKEN"],
  ["nvidia", "https://integrate.api.nvidia.com/v1", "NVIDIA_NIM_API_KEY"],
  ["cohere", "https://api.cohere.ai/compatibility/v1", "COHERE_API_KEY"],
  ["groq", "https://api.groq.com/openai/v1", "GROQ_API_KEY"],
  ["openrouter", "https://openrouter.ai/api/v1", "OPENROUTER_API_KEY"],
  ["openai", "https://api.openai.com/v1", "OPENAI_API_KEY"],
  ["xai", "https://api.x.ai/v1", "XAI_API_KEY"],
  ["gemini", "https://generativelanguage.googleapis.com/v1beta/openai", "GEMINI_API_KEY"],
];

function hostnameName(hostname, fallback) {
  const host = hostname.toLowerCase();
  if (host.includes("groq")) return "groq";
  if (host.includes("openrouter")) return "openrouter";
  if (host.includes("x.ai")) return "xai";
  if (host.includes("googleapis")) return "gemini";
  if (host.includes("openai")) return "openai";
  return fallback;
}

export function readProviders(env) {
  const providers = [];
  const seen = new Map();
  const add = (name, baseUrl, apiKey, model) => {
    if (typeof baseUrl !== "string" || typeof apiKey !== "string" || !baseUrl || !apiKey) return;
    let url;
    try {
      url = new URL(baseUrl.replace(/\/+$/, "") + "/");
    } catch {
      return;
    }
    if (url.username || url.password || url.search || url.hash) return;
    if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return;
    const fingerprint = url.href + "\n" + apiKey;
    if (seen.has(fingerprint)) {
      if (validModel(model)) seen.get(fingerprint).model = model;
      return;
    }
    providers.push({
      name: hostnameName(url.hostname, String(name || "provider").slice(0, 40)),
      baseUrl: url.href.replace(/\/$/, ""),
      apiKey,
      slot: providers.length,
      ...(validModel(model) ? {model} : {}),
    });
    seen.set(fingerprint, providers.at(-1));
  };

  if (env.COMMUNITY_LLM_BASE_URL && env.COMMUNITY_LLM_API_KEY) {
    add("community", env.COMMUNITY_LLM_BASE_URL, env.COMMUNITY_LLM_API_KEY, env.COMMUNITY_LLM_MODEL);
  }
  for (const [name, baseUrl, key] of KNOWN) {
    const prefix = key.replace(/_(?:API_KEY|TOKEN)$/, "");
    if (env[key]) add(name, env[prefix + "_BASE_URL"] || baseUrl, env[key], env[prefix + "_MODEL"]);
    for (const envKey of Object.keys(env)) {
      const match = envKey.match(new RegExp("^" + key + "_(\\d+)$"));
      if (!match || !env[envKey]) continue;
      add(name, env[prefix + "_BASE_URL_" + match[1]] || baseUrl, env[envKey], env[prefix + "_MODEL_" + match[1]] || env[prefix + "_MODEL"]);
    }
  }
  if (env.COMMUNITY_LLM_PROVIDERS) {
    let parsed = [];
    try {
      parsed = JSON.parse(env.COMMUNITY_LLM_PROVIDERS);
    } catch {
      parsed = [];
    }
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (!item || typeof item !== "object") continue;
        add(item.name, item.baseUrl, item.apiKey, item.model);
      }
    }
  }
  return providers;
}

export function createProviderPool(env = {}, fetchImpl = fetch) {
  const providers = readProviders(env);
  const catalogs = new Map();
  let cursor = 0;
  const cooldowns = new Map();
  let lastListed = 0;
  let pending;
  const configuredModel = (provider) => validModel(provider.model || env[provider.name.toUpperCase() + "_MODEL"] || env.COMMUNITY_LLM_MODEL);

  async function listModels(signal) {
    const models = [];
    catalogs.clear();
    const failures = [];
    const useConfiguredModel = (provider) => {
      const id = configuredModel(provider);
      if (!id) return false;
      catalogs.set(provider.slot, new Set([id]));
      models.push({provider:provider.name,slot:provider.slot,id,name:id,configured:true});
      return true;
    };
    await Promise.all(providers.map(async (provider) => {
      try {
        const response = await fetchImpl((provider.name === "cohere" ? "https://api.cohere.com/v1/models?endpoint=chat&page_size=1000" : provider.baseUrl + "/models"), {
          redirect: "error",
          signal: AbortSignal.any([AbortSignal.timeout(8000), ...(signal ? [signal] : [])]),
          headers: { accept: "application/json", authorization: "Bearer " + provider.apiKey },
        });
        if (!response.ok) {
          await response.body?.cancel?.();
          failures.push({ provider: provider.name, slot: provider.slot, error: "목록을 가져오지 못했습니다." });
          // A missing discovery endpoint is not proof of model/auth support. Keep
          // the failure and mark this administrator-supplied entry explicitly.
          if ([404,405,501].includes(response.status)) useConfiguredModel(provider);
          return;
        }
        const data = await response.json();
        const rows = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
        if ((Array.isArray(data?.data) || Array.isArray(data?.models)) && rows.length === 0 && useConfiguredModel(provider)) {
          failures.push({provider:provider.name,slot:provider.slot,error:"모델 목록이 비어 있어 직접 설정한 모델만 표시합니다. 연결은 아직 확인되지 않았습니다."});
          return;
        }
        const ids = new Set();
        for (const row of rows) {
          let id = typeof row === "string" ? row : row?.id || row?.name;
          if(provider.name === "gemini" && typeof id === "string") id=id.replace(/^models\//, "");
          if (typeof id !== "string" || !/^[\w.:/@+-]{1,200}$/.test(id)) continue;
          if (/whisper|orpheus|prompt-guard|safeguard|embedding|embed-|rerank|native-audio|live-preview|image|vision|(?:^|[\/.-])tts(?:[\/.-]|$)/i.test(id)) continue;
          ids.add(id);
          models.push({
            provider: provider.name,
            slot: provider.slot,
            id,
            name: typeof row?.name === "string" ? row.name.slice(0, 120) : id,
          });
        }
        catalogs.set(provider.slot, ids);
      } catch {
        failures.push({ provider: provider.name, slot: provider.slot, error: "목록을 가져오지 못했습니다." });
      }
    }));
    lastListed = Date.now();
    return { models, failures };
  }

  async function ensureModels() {
    if (Date.now() - lastListed < 300000) return;
    pending ??= listModels().finally(() => { pending = null; });
    await pending;
  }
  function choose(modelId, effort) {
    const selected = typeof modelId === "string" && /^[\w.:/@+-]{1,200}$/.test(modelId) ? modelId : "";
    let candidates = providers.flatMap(provider => {
      if ((cooldowns.get(provider.slot) || 0) > Date.now()) return [];
      const listed = catalogs.get(provider.slot);
      const configured = configuredModel(provider);
      let ids = [...(listed || [])];
      // OpenRouter auto mode never silently selects a paid model.
      if (!selected && provider.name === "openrouter") ids = ids.filter(id => id.endsWith(":free") || id === "openrouter/free");
      const model = selected ? (listed?.has(selected) ? selected : "") :
        (ids.includes(configured) ? configured : ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "gemini-3.8-flash", "gemini-3.5-flash", "gemini-2.5-flash", "command-a-03-2025"].find(id => ids.includes(id)) || ids.sort()[0]);
      return model ? [{...provider, model, effort: EFFORTS.includes(effort) ? effort : "", provider: provider.name}] : [];
    });
    if(selected && !selected.endsWith(":free") && candidates.some(p=>p.provider!=="openrouter"))candidates=candidates.filter(p=>p.provider!=="openrouter");
    if (!candidates.length) return null;
    const start = cursor++ % candidates.length;
    const ordered = [...candidates.slice(start), ...candidates.slice(0, start)];
    // Try one key per provider first; repeated keys must not consume the entire turn.
    const first = [], rest = [], seen = new Set();
    for (const candidate of ordered) { (seen.has(candidate.provider) ? rest : first).push(candidate); seen.add(candidate.provider); }
    const attempts = [...first, ...rest];
    const choice = attempts[0];
    return {...choice, attempts, onProviderFailure: (candidate, status, retryAfter) => {
      const duration = status === 401 || status === 403 ? 3600000 : Math.max(30000, Math.min(3600000, retryAfter || 60000));
      cooldowns.set(candidate.slot, Date.now() + duration);
    }};
  }
  return { providers, listModels, ensureModels, choose, get configured() { return providers.length > 0; } };
}

export function publicModels(listed) {
  const grouped = new Map();
  for (const model of listed.models) {
    const row = grouped.get(model.id) || { value: model.id, id: model.id, name: model.name, providers: [], ...(model.configured ? {configured:true} : {}) };
    if (!model.configured) delete row.configured;
    if (!row.providers.includes(model.provider)) row.providers.push(model.provider);
    grouped.set(model.id, row);
  }
  return [...grouped.values()];
}

export function formatModelList(listed) {
  if (!listed.models.length && !listed.failures.length) {
    return "연결된 API가 없습니다. 서버에 API 키를 넣으면 model을 다시 입력할 때 목록을 가져옵니다.";
  }
  const lines = [listed.models.some(model=>model.configured) ? "API 모델 목록과 직접 설정한 모델입니다. 수동 설정은 연결 확인 결과가 아닙니다." : "지금 API에서 가져온 모델입니다."];
  const groups = new Map();
  for (const model of listed.models) {
    const key = model.provider + "#" + model.slot;
    if (!groups.has(key)) groups.set(key, { provider: model.provider, ids: [] });
    groups.get(key).ids.push(model.id + (model.configured ? " (수동 설정)" : ""));
  }
  const counts = new Map();
  for (const group of groups.values()) counts.set(group.provider, (counts.get(group.provider) || 0) + 1);
  const seen = new Map();
  for (const group of groups.values()) {
    const index = (seen.get(group.provider) || 0) + 1;
    seen.set(group.provider, index);
    const label = counts.get(group.provider) > 1 ? group.provider + " " + index : group.provider;
    const shown = group.ids.slice(0, 30);
    lines.push(label + ": " + shown.join(", "));
    if (group.ids.length > shown.length) lines.push(label + " 외 " + (group.ids.length - shown.length) + "개");
  }
  for (const failure of listed.failures) lines.push(failure.provider + ": " + failure.error);
  return lines.join("\n").slice(0, 4000);
}
