export const EFFORTS = ["low", "medium", "high", "xhigh"];

const KNOWN = [
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
  const seen = new Set();
  const add = (name, baseUrl, apiKey) => {
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
    if (seen.has(fingerprint)) return;
    seen.add(fingerprint);
    providers.push({
      name: hostnameName(url.hostname, String(name || "provider").slice(0, 40)),
      baseUrl: url.href.replace(/\/$/, ""),
      apiKey,
      slot: providers.length,
    });
  };

  if (env.COMMUNITY_LLM_BASE_URL && env.COMMUNITY_LLM_API_KEY) {
    add("community", env.COMMUNITY_LLM_BASE_URL, env.COMMUNITY_LLM_API_KEY);
  }
  for (const [name, baseUrl, key] of KNOWN) {
    const prefix = key.slice(0, -"_API_KEY".length);
    if (env[key]) add(name, env[prefix + "_BASE_URL"] || baseUrl, env[key]);
    for (const envKey of Object.keys(env)) {
      const match = envKey.match(new RegExp("^" + prefix + "_API_KEY_(\\d+)$"));
      if (!match || !env[envKey]) continue;
      add(name, env[prefix + "_BASE_URL_" + match[1]] || baseUrl, env[envKey]);
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
        add(item.name, item.baseUrl, item.apiKey);
      }
    }
  }
  return providers;
}

export function createProviderPool(env = {}, fetchImpl = fetch) {
  const providers = readProviders(env);
  const catalogs = new Map();
  let cursor = 0;

  async function listModels(signal) {
    const models = [];
    const failures = [];
    await Promise.all(providers.map(async (provider) => {
      try {
        const response = await fetchImpl(provider.baseUrl + "/models", {
          redirect: "error",
          signal: AbortSignal.any([AbortSignal.timeout(8000), ...(signal ? [signal] : [])]),
          headers: { accept: "application/json", authorization: "Bearer " + provider.apiKey },
        });
        if (!response.ok) {
          await response.body?.cancel?.();
          failures.push({ provider: provider.name, slot: provider.slot, error: "목록을 가져오지 못했습니다." });
          return;
        }
        const data = await response.json();
        const rows = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
        const ids = new Set();
        for (const row of rows) {
          const id = typeof row === "string" ? row : row?.id;
          if (typeof id !== "string" || !/^[\w.:/@+-]{1,200}$/.test(id)) continue;
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
    return { models, failures };
  }

  function choose(modelId, effort) {
    const effortValue = EFFORTS.includes(effort) ? effort : "";
    const selected = typeof modelId === "string" && /^[\w.:/@+-]{1,200}$/.test(modelId) ? modelId : "";
    if (!providers.length) return null;
    if (selected) {
      const owning = providers.filter((provider) => catalogs.get(provider.slot)?.has(selected));
      if (!owning.length) return null;
      const provider = owning[cursor % owning.length];
      cursor += 1;
      return { model: selected, apiKey: provider.apiKey, baseUrl: provider.baseUrl, effort: effortValue, provider: provider.name };
    }
    if (!effortValue && !env.COMMUNITY_LLM_MODEL && catalogs.size === 0) return null;
    if (!env.COMMUNITY_LLM_MODEL && catalogs.size === 0) return null;
    const provider = providers[cursor % providers.length];
    cursor += 1;
    const listed = catalogs.get(provider.slot);
    const model = env.COMMUNITY_LLM_MODEL || (listed?.size ? [...listed][0] : "");
    if (!model) return null;
    return { model, apiKey: provider.apiKey, baseUrl: provider.baseUrl, effort: effortValue, provider: provider.name };
  }

  return { providers, listModels, choose, get configured() { return providers.length > 0; } };
}

export function publicModels(listed) {
  const grouped = new Map();
  for (const model of listed.models) {
    const row = grouped.get(model.id) || { value: model.id, id: model.id, name: model.name, providers: [] };
    if (!row.providers.includes(model.provider)) row.providers.push(model.provider);
    grouped.set(model.id, row);
  }
  return [...grouped.values()];
}

export function formatModelList(listed) {
  if (!listed.models.length && !listed.failures.length) {
    return "연결된 API가 없습니다. 서버에 API 키를 넣으면 model을 다시 입력할 때 목록을 가져옵니다.";
  }
  const lines = ["지금 API에서 가져온 모델입니다."];
  const groups = new Map();
  for (const model of listed.models) {
    const key = model.provider + "#" + model.slot;
    if (!groups.has(key)) groups.set(key, { provider: model.provider, ids: [] });
    groups.get(key).ids.push(model.id);
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
