let terminalModule,terminalStyle;
async function loadTerminal() {
  terminalStyle ||= new Promise((resolve,reject)=>{
    const link=document.createElement('link');link.rel='stylesheet';link.href='/vendor/xterm.css';link.dataset.workspaceTerminal='';
    const timer=setTimeout(()=>{link.remove();reject(new Error('터미널 스타일을 불러오지 못했습니다.'));},15000);
    link.onload=()=>{clearTimeout(timer);resolve();};
    link.onerror=()=>{clearTimeout(timer);link.remove();reject(new Error('터미널 스타일을 불러오지 못했습니다.'));};document.head.append(link);
  }).catch(error=>{terminalStyle=null;throw error;});
  terminalModule ||= import('/vendor/xterm.js').catch(error=>{terminalModule=null;throw error;});
  const [module]=await Promise.all([terminalModule,terminalStyle]);return module;
}

/** A single authenticated remote PTY; closing the view disposes every local resource. */
export async function createWorkspaceTerminal({mount,api,roomId,signal,onStatus=()=>{}}) {
  const {Terminal,FitAddon}=await loadTerminal();
  signal.throwIfAborted();
  const term=new Terminal({cursorBlink:true,convertEol:false,scrollback:2000,fontSize:13,fontFamily:'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',disableStdin:true,theme:{background:'#111317',foreground:'#d7dde5',cursor:'#b9d4e8',selectionBackground:'#627b9655'}});
  const fit=new FitAddon();term.loadAddon(fit);term.open(mount);
  let socket,disposed=false,ready=false,closing=false,resizeTimer,queuedOutputBytes=0,closeReason=null;
  const MAX_QUEUED_OUTPUT_BYTES=1024*1024;
  const stop=(text,status='error')=>{
    if(disposed||closing)return;
    closing=true;ready=false;term.options.disableStdin=true;closeReason={text,status};onStatus(text,status);
    try{socket?.close();}catch{}
  };
  const writeOutput=data=>{
    // Account for the UTF-16 string retained until xterm's parser callback runs.
    const bytes=data.length*2;
    if(bytes>MAX_QUEUED_OUTPUT_BYTES-queuedOutputBytes){stop('출력이 너무 빠릅니다. 터미널을 다시 연결해주세요.');return;}
    queuedOutputBytes+=bytes;let released=false;
    const release=()=>{if(!released){released=true;queuedOutputBytes=Math.max(0,queuedOutputBytes-bytes);}};
    try{term.write(data,release);}catch{release();stop('터미널 출력을 표시하지 못했습니다. 다시 연결해주세요.');}
  };
  const send=value=>{if(!disposed&&!closing&&ready&&socket?.readyState===WebSocket.OPEN){if(socket.bufferedAmount>524288){stop('연결이 느립니다. 다시 연결해주세요.');return;}socket.send(JSON.stringify(value));}};
  const resize=()=>{
    if(disposed||!mount.isConnected||!mount.clientWidth||!mount.clientHeight)return;
    fit.fit();
    const cols=Math.max(2,Math.min(400,term.cols)),rows=Math.max(2,Math.min(200,term.rows));
    if(cols!==term.cols||rows!==term.rows)term.resize(cols,rows);
    send({type:'resize',cols,rows});
  };
  const observer=new ResizeObserver(()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(resize,80);});observer.observe(mount);
  const input=term.onData(data=>{
    const points=Array.from(data);
    for(let offset=0;offset<points.length;offset+=1024)send({type:'input',data:points.slice(offset,offset+1024).join('')});
  });
  const dispose=()=>{
    if(disposed)return;disposed=true;ready=false;queuedOutputBytes=0;clearTimeout(resizeTimer);observer.disconnect();input.dispose();
    signal.removeEventListener('abort',dispose);
    if(socket){socket.onmessage=null;socket.onopen=null;socket.onclose=null;socket.onerror=null;try{socket.close();}catch{}}
    term.dispose();
  };
  signal.addEventListener('abort',dispose,{once:true});
  try {
    onStatus('터미널 연결 중…');resize();
    const ticket=await api(`/api/rooms/${encodeURIComponent(roomId)}/workspace/terminal/ticket`,{method:'POST',body:'{}',signal});
    signal.throwIfAborted();
    const url=new URL(ticket.websocketPath,location.href);
    if(url.origin!==location.origin||url.pathname!==`/api/rooms/${encodeURIComponent(roomId)}/workspace/terminal/ws`||!url.searchParams.has('ticket'))throw new Error('터미널 연결 경로가 올바르지 않습니다.');
    url.protocol=location.protocol==='https:'?'wss:':'ws:';socket=new WebSocket(url.href);
    socket.onmessage=event=>{
      if(disposed||closing)return;
      let message;try{if(typeof event.data!=='string'||event.data.length>2*1024*1024)throw new Error();message=JSON.parse(event.data);}catch{stop('터미널 응답을 읽지 못했습니다.');return;}
      if(message.type==='ready'){ready=true;term.options.disableStdin=false;resize();if(!closing)onStatus('연결됨','ready');}
      else if(message.type==='output'&&typeof message.data==='string')writeOutput(message.data);
      else if(message.type==='exit')stop(`터미널 종료${Number.isInteger(message.code)?' · '+message.code:''}. 다시 연결할 수 있습니다.`,'closed');
      else if(message.type==='error')stop('터미널 연결을 완료하지 못했습니다. 다시 연결해주세요.');
    };
    socket.onerror=()=>stop('터미널에 연결하지 못했습니다. 다시 연결해주세요.');
    socket.onclose=()=>{if(!disposed){ready=false;closing=true;term.options.disableStdin=true;if(!closeReason)onStatus('터미널 연결이 종료되었습니다. 다시 연결할 수 있습니다.');}};
    return {dispose,focus:()=>term.focus(),resize};
  }catch(error){dispose();throw error;}
}
