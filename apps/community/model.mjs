import { BROWSER_TOOL_DEFINITIONS } from './browser-tools.mjs';
import { normalizeBotOutput } from './model-output.mjs';
import { usageEvent } from './usage.mjs';
export class ApiLlm {
  constructor(env) {
    this.name=env.COMMUNITY_LLM_MODEL;
    this.endpoint=new URL(env.COMMUNITY_LLM_BASE_URL.replace(/\/+$/,'')+'/chat/completions');
    if(this.endpoint.protocol!=='https:' && !['localhost','127.0.0.1','[::1]'].includes(this.endpoint.hostname)) throw new Error('Model endpoint must use HTTPS');
    this.key=env.COMMUNITY_LLM_API_KEY;
  }
  async complete(request, signal) {
    const key=request?.apiKey||this.key;
    const model=request?.model||this.name;
    let endpoint=this.endpoint;
    if(request?.baseUrl){
      endpoint=new URL(String(request.baseUrl).replace(/\/+$/,'')+'/chat/completions');
      if(endpoint.protocol!=='https:' && !['localhost','127.0.0.1','[::1]'].includes(endpoint.hostname)) throw new Error('Model endpoint must use HTTPS');
    }
    const effort=['low','medium','high','xhigh'].includes(request?.effort)?request.effort:'';
    const messages=[{role:'system',content:request.system},{role:'user',content:request.images?.length ? [{type:'text',text:request.user},...request.images.map(image=>({type:'image_url',image_url:{url:image}}))] : request.user}];
    const definitions=request.toolDefinitions || BROWSER_TOOL_DEFINITIONS;
    let actions=0, candidateIndex=0;
    for(let step=0;step<5;step++) {
      if(step) await request.beforeAdditionalModelCall();
      const useTools=Boolean(request.browser) && actions<4 && step<4;
      let response, activeCandidate;
      const candidates = request.attempts?.length ? request.attempts : [{apiKey:key, model, baseUrl:endpoint.href.replace(/\/chat\/completions$/, '')}];
      const start=candidateIndex;
      for (let attempt=start; attempt<Math.min(candidates.length, 8); attempt++) {
        signal?.throwIfAborted();
        if (attempt>start) await request.beforeAdditionalModelCall?.();
        const candidate=candidates[attempt];
        request.onProgress?.("model",attempt>start?"다른 모델 연결 중":"답변 작성 중");
        const target=new URL(candidate.baseUrl.replace(/\/+$/, '')+'/chat/completions');
        if(target.protocol!=='https:' && !['localhost','127.0.0.1','[::1]'].includes(target.hostname)) throw new Error('Model endpoint must use HTTPS');
        try {
          response=await fetch(target,{
            method:'POST',redirect:'error',
            signal:AbortSignal.any([AbortSignal.timeout(request.images?.length ? 30000 : 12000),...(signal?[signal]:[])]),
            headers:{'content-type':'application/json',authorization:'Bearer '+candidate.apiKey},
            body:JSON.stringify({model:candidate.model,messages,max_tokens:request.images?.length ? 2048 : 512,
              ...(effort && (!candidate.provider || /openai|groq/.test(candidate.provider)) ? {reasoning_effort:effort}:{}),
              ...(useTools?{tools:definitions,tool_choice:'auto'}:{})}),
          });
        } catch(error) {
          if(signal?.aborted) throw error;
          if(error.name!=='TimeoutError' && !(error instanceof TypeError)) throw error;
          request.onProviderFailure?.(candidate, 503);
          if(attempt===Math.min(candidates.length,8)-1) throw new Error('모든 모델 연결에 실패했습니다. 잠시 후 다시 시도해 주세요.');
          continue;
        }
        if(response.ok) {candidateIndex=attempt;activeCandidate=candidate;break;}
        const status=response.status;
        request.onUsage?.(usageEvent({provider:candidate.provider||candidate.name||'community',keySlot:candidate.slot,model:candidate.model,status,headers:response.headers}));
        const raw=response.headers.get('retry-after');
        const delay=raw ? (Number.isFinite(Number(raw)) ? Number(raw)*1000 : Date.parse(raw)-Date.now()) : 0;
        await response.body?.cancel();
        if(![401,402,403,404,408,429,500,502,503,504].includes(status)) throw new Error('Model provider rejected request ('+status+')');
        request.onProviderFailure?.(candidate,status,delay);
        if(attempt===Math.min(candidates.length,8)-1) throw new Error('사용 가능한 모델 한도 또는 인증을 확인해 주세요.');
      }
      request.onProgress?.("receiving","응답 수신 중");
      let payload;
      try {
        const reader=response.body.getReader(),chunks=[];let bytes=0;
        try {for(;;){const result=await reader.read();if(result.done)break;bytes+=result.value.byteLength;if(bytes>131072)throw new Error('Model response too large');chunks.push(Buffer.from(result.value));}}
        finally {await reader.cancel().catch(()=>{});}
        payload=JSON.parse(Buffer.concat(chunks).toString());
      } finally {
        request.onUsage?.(usageEvent({provider:activeCandidate.provider||activeCandidate.name||'community',keySlot:activeCandidate.slot,model:typeof payload?.model==='string'?payload.model:activeCandidate.model,status:response.status,headers:response.headers,usage:payload?.usage}));
      }
      const message=payload.choices?.[0]?.message;
      if(useTools && message?.tool_calls?.length) {
        const calls=message.tool_calls;
        if(!Array.isArray(calls)||calls.length>4-actions)throw new Error('Browser action budget exceeded');
        const allowed=new Set(definitions.map(t=>t.function.name));
        for(const call of calls) if(typeof call.id!=='string'||call.id.length>200||!allowed.has(call.function?.name)||typeof call.function.arguments!=='string'||call.function.arguments.length>10000)throw new Error('Invalid browser tool call');
        messages.push({role:'assistant',content:typeof message.content==='string'?message.content.slice(0,4000):null,tool_calls:calls});
        for(const call of calls) {
          actions++;
          let result;
          try {result=await request.browser(call.function.name,JSON.parse(call.function.arguments),{signal});}
          catch(error){result='Browser action failed: '+(error.status?error.message:'The page could not complete this action.');}
          messages.push({role:'tool',tool_call_id:call.id,content:String(result).slice(0,8000)});
        }
        continue;
      }
      const content=message?.content;
      if(typeof content!=='string'||!content.trim())throw new Error('Empty model response');
      return normalizeBotOutput(content);
    }
    throw new Error('Browser turn budget exhausted');
  }
}
