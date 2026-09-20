import { BROWSER_TOOL_DEFINITIONS } from './browser-tools.mjs';
const envelope = content => 'SendMessage: ' + JSON.stringify({type:'text',content});
export class ApiLlm {
  constructor(env) {
    this.name=env.COMMUNITY_LLM_MODEL;
    this.endpoint=new URL(env.COMMUNITY_LLM_BASE_URL.replace(/\/+$/,'')+'/chat/completions');
    if(this.endpoint.protocol!=='https:' && !['localhost','127.0.0.1','[::1]'].includes(this.endpoint.hostname)) throw new Error('Model endpoint must use HTTPS');
    this.key=env.COMMUNITY_LLM_API_KEY;
  }
  async complete(request, signal) {
    const messages=[{role:'system',content:request.system},{role:'user',content:request.user}];
    let actions=0;
    for(let step=0;step<5;step++) {
      if(step) await request.beforeAdditionalModelCall();
      const useTools=Boolean(request.browser) && actions<4 && step<4;
      const response=await fetch(this.endpoint,{
        method:'POST',redirect:'error',
        signal:AbortSignal.any([AbortSignal.timeout(20000),...(signal?[signal]:[])]),
        headers:{'content-type':'application/json',authorization:'Bearer '+this.key},
        body:JSON.stringify({model:this.name,messages,max_completion_tokens:512,
          ...(useTools?{tools:BROWSER_TOOL_DEFINITIONS,tool_choice:'auto',parallel_tool_calls:false}:{})}),
      });
      if(!response.ok){await response.body?.cancel();throw new Error('Model provider rejected request');}
      const reader=response.body.getReader(),chunks=[];let bytes=0;
      try {for(;;){const result=await reader.read();if(result.done)break;bytes+=result.value.byteLength;if(bytes>131072)throw new Error('Model response too large');chunks.push(Buffer.from(result.value));}}
      finally {await reader.cancel().catch(()=>{});}
      const message=JSON.parse(Buffer.concat(chunks).toString()).choices?.[0]?.message;
      if(useTools && message?.tool_calls?.length) {
        const calls=message.tool_calls;
        if(!Array.isArray(calls)||calls.length>4-actions)throw new Error('Browser action budget exceeded');
        const allowed=new Set(BROWSER_TOOL_DEFINITIONS.map(t=>t.function.name));
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
      return content.startsWith('SendMessage:')?content.slice(0,8000):envelope(content.slice(0,4000));
    }
    throw new Error('Browser turn budget exhausted');
  }
}
