// Recommendations use only models returned by the connected providers.
const PICKS = [
  ['gemini-3.8-flash', 'gemini-3.5-flash', 'gemini-2.5-flash'],
  ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'],
  ['qwen/qwen3.8-27b', 'Qwen/Qwen3-235B-A22B-Instruct-2507'],
  ['command-a-03-2025', 'command-a-plus-05-2026'],
  ['meta-llama/llama-3.3-70b-instruct:free', 'openrouter/free'],
];
export function recommendedModels(models, limit=5) {
  const picked=[];
  for(const ids of PICKS){const model=ids.map(id=>models.find(m=>m.value===id)).find(Boolean);if(model&&!picked.includes(model))picked.push(model);}
  for(const model of models){
    if(picked.length>=limit)break;
    if(!picked.includes(model) && !/preview|experimental|image|audio|embed|rerank/i.test(model.id) && !(model.providers?.length===1&&model.providers[0]==='openrouter'&&!model.id.endsWith(':free')))picked.push(model);
  }
  return picked.slice(0,limit);
}
export function modelLabel(model) {
  const id=model.id || model.value;
  const known={'openai/gpt-oss-120b':'GPT-OSS 120B','openai/gpt-oss-20b':'GPT-OSS 20B','qwen/qwen3.8-27b':'Qwen 3.8 · 27B','command-a-03-2025':'Command A','command-a-plus-05-2026':'Command A+','openrouter/free':'OpenRouter Free'};
  return known[id] || id.replace(/^gemini-([\d.]+)-flash$/, 'Gemini $1 Flash').replace(/^[^/]+\//,'');
}
export function filterModels(models, query) {
  const terms=query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return models.filter(model=>terms.every(term=>[model.id,model.name,...(model.providers||[])].join(' ').toLowerCase().includes(term)));
}
