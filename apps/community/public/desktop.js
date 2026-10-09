import {createWorkspaceTerminal} from '/workspace-terminal.js';
const VIEWS=[['browser','브라우저'],['terminal','터미널'],['files','파일']];
const el=(tag,text,className)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;};
const actionButton=(label,text=label)=>{const button=el('button',text,'workspace-button');button.type='button';button.setAttribute('aria-label',label);button.title=label;return button;};

export function browserFramePoint(rect,width,height,clientX,clientY) {
  if(!(width>0&&height>0&&rect.width>0&&rect.height>0))return null;
  const scale=Math.min(rect.width/width,rect.height/height),left=rect.left+(rect.width-width*scale)/2,top=rect.top+(rect.height-height*scale)/2;
  const x=(clientX-left)/scale,y=(clientY-top)/scale;
  return x>=0&&y>=0&&x<width&&y<height?{x:Math.floor(x),y:Math.floor(y)}:null;
}
async function boundedFile(url,signal,max=8*1024*1024) {
  const response=await fetch(url,{credentials:'same-origin',signal,redirect:'error'});
  if(!response.ok)throw new Error('파일을 불러오지 못했습니다.');
  if(Number(response.headers.get('content-length'))>max){await response.body?.cancel();throw new Error('미리보기는 8 MiB 이하 파일만 지원합니다.');}
  const reader=response.body?.getReader();if(!reader)throw new Error('파일 응답이 없습니다.');
  const parts=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>max)throw new Error('미리보기는 8 MiB 이하 파일만 지원합니다.');parts.push(value);}}
  finally{await reader.cancel().catch(()=>{});}
  return new Blob(parts,{type:response.headers.get('content-type')||'application/octet-stream'});
}

/** Three direct views of the shared OCI workspace, scoped to the current room. */
export function createDesktopUI({api,getRoomId,toast=()=>{},mount=null,initialView='browser',onViewChange=()=>{}}) {
  const state={roomId:null,view:VIEWS.some(([id])=>id===initialView)?initialView:'browser',generation:0,abort:null,cleanup:null,destroyed:false,paths:new Map()};
  const topbar=mount?.querySelector('.pane-bar')||document.querySelector('.topbar-actions');
  const toggle=actionButton('작업 공간 열기','▣');toggle.className='icon-button desktop-button';toggle.setAttribute('aria-expanded','false');topbar?.append(toggle);
  const panel=el('aside',undefined,'desktop-panel'+(mount?' desktop-inline':''));panel.setAttribute('aria-label','OCI 작업 공간');panel.hidden=true;
  const head=el('div',undefined,'desktop-head'),title=el('strong','작업 공간'),close=actionButton('작업 공간 닫기','×');close.classList.add('workspace-close');head.append(title,close);
  const tabs=el('div',undefined,'workspace-tabs');tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','작업 공간 보기');
  const buttons=new Map();
  for(const [id,label] of VIEWS){const button=actionButton(label);button.setAttribute('role','tab');button.dataset.view=id;button.onclick=()=>{if(state.view!==id){state.view=id;onViewChange(id);void activate();}};buttons.set(id,button);tabs.append(button);}
  tabs.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const available=[...buttons.values()].filter(button=>!button.disabled),index=available.indexOf(document.activeElement);let next=event.key==='Home'?0:event.key==='End'?available.length-1:(index+(event.key==='ArrowRight'?1:-1)+available.length)%available.length;available[next]?.focus();available[next]?.click();});
  const bar=el('div',undefined,'workspace-statusbar'),status=el('span','','desktop-status'),retry=actionButton('작업 공간 다시 연결','다시 연결');status.setAttribute('role','status');bar.append(status,retry);
  const content=el('div',undefined,'workspace-content');content.setAttribute('role','tabpanel');
  panel.append(head,tabs,content,bar);(mount||document.querySelector('.main-panel'))?.append(panel);
  const setStatus=(message,kind='')=>{status.textContent=message;status.dataset.kind=kind;};
  const stop=()=>{state.generation++;state.abort?.abort();state.abort=null;state.cleanup?.();state.cleanup=null;};
  const current=generation=>!state.destroyed&&state.generation===generation&&!panel.hidden&&!document.hidden;
  const empty=message=>{content.replaceChildren(el('div',message,'workspace-empty'));};
  const fail=(error,generation)=>{if(current(generation)&&error?.name!=='AbortError'){setStatus(error.message||'연결하지 못했습니다. 다시 연결해주세요.','error');}};

  async function activate() {
    stop();if(state.destroyed||!state.roomId||panel.hidden||document.hidden)return;
    const generation=state.generation,roomId=state.roomId,abort=new AbortController();state.abort=abort;
    const base=`/api/rooms/${encodeURIComponent(roomId)}/workspace`;
    for(const [id,button] of buttons){button.setAttribute('aria-selected',String(id===state.view));button.tabIndex=id===state.view?0:-1;button.disabled=false;}
    content.setAttribute('aria-label',VIEWS.find(([id])=>id===state.view)?.[1]||'작업 공간');
    empty('작업 공간에 연결하는 중…');setStatus('연결 중…');
    try{
      const available=await api(base,{signal:abort.signal});if(!current(generation))return;
      for(const [id,button] of buttons)button.disabled=available[id]!==true;
      if(available[state.view]!==true){empty('이 보기는 아직 연결되지 않았습니다.');setStatus('다시 연결하여 상태를 확인할 수 있습니다.');return;}
      if(state.view==='browser')state.cleanup=mountBrowser(base,generation,abort.signal);
      else if(state.view==='files')state.cleanup=mountFiles(base,roomId,generation,abort.signal);
      else{
        const terminal=el('div',undefined,'workspace-terminal');terminal.setAttribute('aria-label','OCI 터미널');content.replaceChildren(terminal);
        const instance=await createWorkspaceTerminal({mount:terminal,api,roomId,signal:abort.signal,onStatus:(message,kind)=>{if(current(generation))setStatus(message,kind);}});
        if(!current(generation)){instance.dispose();return;}state.cleanup=()=>instance.dispose();
      }
    }catch(error){if(current(generation)){empty('작업 공간에 연결하지 못했습니다.');fail(error,generation);}}
  }
  function mountBrowser(base,generation,signal) {
    const toolbar=el('form',undefined,'workspace-browser-toolbar'),back=actionButton('뒤로','←'),forward=actionButton('앞으로','→'),reload=actionButton('페이지 새로고침','↻'),address=el('input');address.type='text';address.className='workspace-address';address.setAttribute('aria-label','원격 브라우저 주소');address.placeholder='주소 입력';address.autocomplete='off';address.spellcheck=false;
    toolbar.append(back,forward,reload,address);
    const viewport=el('div',undefined,'workspace-browser-viewport'),image=el('img');image.alt='원격 브라우저 화면';image.draggable=false;image.className='workspace-browser-frame';
    const keyboard=el('textarea');keyboard.className='workspace-browser-keyboard';keyboard.setAttribute('aria-label','원격 브라우저 키보드 입력');keyboard.autocomplete='off';keyboard.autocapitalize='off';keyboard.spellcheck=false;keyboard.rows=1;
    const help=el('span','화면을 클릭해 조작하세요','workspace-browser-help');viewport.append(image,keyboard,help);content.replaceChildren(toolbar,viewport);
    let frame=null,timer,scrollTimer,textTimer,pendingText='',frameRequest=null,queue=Promise.resolve(),queued=0,composing=false,scrollX=0,scrollY=0,disposed=false;
    const active=()=>!disposed&&current(generation);
    const schedule=()=>{clearTimeout(timer);if(active())timer=setTimeout(()=>{if(queued){schedule();return;}void capture();},1100);};
    const capture=async()=>{
      if(!active())return;if(frameRequest)return frameRequest;
      frameRequest=(async()=>{
        try{
          const data=await api(base+'/browser/frame',{signal});if(!active())return;
          if(typeof data.image!=='string'||data.image.length>12*1024*1024||!/^data:image\/(?:jpeg|png);base64,[a-zA-Z0-9+/=]+$/.test(data.image)||!Number.isFinite(data.width)||!Number.isFinite(data.height)||data.width<=0||data.height<=0)throw new Error('브라우저 화면을 읽지 못했습니다.');
          frame=data;image.src=data.image;image.hidden=false;
          if(document.activeElement!==address)address.value=typeof data.url==='string'?data.url:'';
          image.alt=typeof data.title==='string'&&data.title?data.title:'원격 브라우저 화면';
          setStatus('브라우저 연결됨','ready');
        }catch(error){fail(error,generation);}finally{frameRequest=null;schedule();}
      })();return frameRequest;
    };
    const action=value=>{
      if(!active()||queued>=64)return;
      queued++;clearTimeout(timer);
      queue=queue.then(async()=>{if(!active())return;if(frameRequest)await frameRequest;if(!active())return;clearTimeout(timer);await api(base+'/browser/action',{method:'POST',body:JSON.stringify(value),signal});if(active()&&queued===1)await capture();}).catch(error=>fail(error,generation)).finally(()=>{queued--;if(!queued)schedule();});
    };
    toolbar.onsubmit=event=>{event.preventDefault();flushText();const value=address.value.trim();if(!value)return;let url;try{url=new URL(/^[a-z][a-z0-9+.-]*:/i.test(value)?value:'https://'+value);if(!['https:','http:'].includes(url.protocol))throw new Error();}catch{setStatus('http 또는 https 주소를 입력해주세요.','error');return;}action({type:'navigate',url:url.href});};
    back.onclick=()=>{flushText();action({type:'back'});};forward.onclick=()=>{flushText();action({type:'forward'});};reload.onclick=()=>{flushText();action({type:'reload'});};
    image.onclick=event=>{if(!frame)return;const point=browserFramePoint(image.getBoundingClientRect(),frame.width,frame.height,event.clientX,event.clientY);if(point){flushText();action({type:'click',...point});keyboard.focus({preventScroll:true});help.hidden=true;}};
    function flushText(){clearTimeout(textTimer);const points=Array.from(pendingText);pendingText='';for(let offset=0;offset<points.length;offset+=2000)action({type:'type',text:points.slice(offset,offset+2000).join('')});}
    const type=text=>{pendingText+=text;clearTimeout(textTimer);textTimer=setTimeout(flushText,180);};
    const flush=()=>{if(!composing&&keyboard.value){type(keyboard.value);keyboard.value='';}};
    keyboard.addEventListener('compositionstart',()=>{composing=true;});keyboard.addEventListener('compositionend',()=>{composing=false;flush();});keyboard.addEventListener('input',flush);
    keyboard.addEventListener('keydown',event=>{
      if(event.isComposing||composing||event.keyCode===229)return;
      const modifier=event.ctrlKey||event.metaKey;if(modifier&&event.key.toLowerCase()==='v')return;
      const special=['Enter','Tab','Backspace','Delete','Escape','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End','PageUp','PageDown'];
      if(!special.includes(event.key)&&!modifier&&!event.altKey)return;
      if(['Shift','Control','Alt','Meta'].includes(event.key))return;
      event.preventDefault();flush();flushText();const modifiers=[modifier?'Control':'',event.altKey?'Alt':'',event.shiftKey?'Shift':''].filter(Boolean);action({type:'key',key:[...modifiers,event.key].join('+')});
    });
    viewport.addEventListener('wheel',event=>{event.preventDefault();const factor=event.deltaMode===1?16:event.deltaMode===2?frame?.height||800:1;scrollX+=event.deltaX*factor;scrollY+=event.deltaY*factor;clearTimeout(scrollTimer);scrollTimer=setTimeout(()=>{flushText();action({type:'scroll',deltaX:Math.round(Math.max(-2000,Math.min(2000,scrollX))),deltaY:Math.round(Math.max(-2000,Math.min(2000,scrollY)))});scrollX=0;scrollY=0;},80);},{passive:false});
    image.hidden=true;void capture();
    return ()=>{disposed=true;clearTimeout(timer);clearTimeout(scrollTimer);clearTimeout(textTimer);pendingText='';image.removeAttribute('src');};
  }
  function mountFiles(base,roomId,generation,signal) {
    const toolbar=el('div',undefined,'workspace-files-toolbar'),up=actionButton('상위 폴더','↑'),root=actionButton('작업 폴더','⌂'),refresh=actionButton('파일 목록 새로고침','↻'),path=el('span','','workspace-file-path');toolbar.append(up,root,refresh,path);
    const list=el('div',undefined,'workspace-file-list');list.setAttribute('aria-label','작업 공간 파일');content.replaceChildren(toolbar,list);
    let directory=state.paths.get(roomId)||'',request=0,objectUrl=null,fileAbort=null;
    const revoke=()=>{if(objectUrl){URL.revokeObjectURL(objectUrl);objectUrl=null;}};
    const active=()=>current(generation)&&!signal.aborted;
    const load=async next=>{
      fileAbort?.abort();revoke();const id=++request;list.replaceChildren(el('p','파일을 불러오는 중…','workspace-empty'));setStatus('파일 목록 확인 중…');
      try{
        const data=await api(base+'/files?path='+encodeURIComponent(next),{signal});if(!active()||id!==request)return;
        directory=typeof data.path==='string'?data.path:next;state.paths.set(roomId,directory);path.textContent=directory?'/'+directory.replace(/^\/+/, ''):'작업 폴더';path.title=path.textContent;up.disabled=!directory||directory==='/';
        list.replaceChildren();const entries=Array.isArray(data.entries)?data.entries:[];
        for(const entry of entries){if(!entry||typeof entry.name!=='string'||typeof entry.path!=='string'||!['directory','file'].includes(entry.type))continue;
          const row=actionButton(entry.name);row.className='workspace-file-row';row.replaceChildren();row.append(el('span',entry.type==='directory'?'▱':'▤','workspace-file-icon'),el('span',entry.name,'workspace-file-name'));
          const size=entry.type==='directory'?'폴더':Number.isFinite(entry.size)?(entry.size>=1048576?(entry.size/1048576).toFixed(1)+' MiB':entry.size>=1024?(entry.size/1024).toFixed(1)+' KiB':entry.size+' B'):'';row.append(el('span',size,'workspace-file-size'));row.onclick=()=>entry.type==='directory'?void load(entry.path):void preview(entry);list.append(row);
        }
        if(!list.childElementCount)list.append(el('p','폴더가 비어 있습니다.','workspace-empty'));
        setStatus(data.truncated?'파일이 많아 일부만 표시합니다.':'작업 폴더 · '+entries.length+'개','ready');
      }catch(error){if(active()&&id===request){list.replaceChildren(el('p','파일 목록을 불러오지 못했습니다.','workspace-empty'));fail(error,generation);}}
    };
    const preview=async entry=>{
      fileAbort?.abort();revoke();fileAbort=new AbortController();const localSignal=AbortSignal.any([signal,fileAbort.signal]),id=++request;
      const header=el('div',undefined,'workspace-file-preview-head'),back=actionButton('파일 목록으로','← 목록'),name=el('strong',entry.name),download=el('a','다운로드','workspace-download');download.setAttribute('download',entry.name);header.append(back,name,download);back.onclick=()=>void load(directory);
      const body=el('div','파일을 불러오는 중…','workspace-file-preview-body');list.replaceChildren(header,body);setStatus('파일 확인 중…');
      try{
        const blob=await boundedFile(base+'/file?path='+encodeURIComponent(entry.path),localSignal);if(!active()||id!==request)return;
        objectUrl=URL.createObjectURL(blob);download.href=objectUrl;body.replaceChildren();
        const image=/^image\/(?:png|jpeg|gif|webp)$/.test(blob.type)||/\.(?:png|jpe?g|gif|webp)$/i.test(entry.name);
        const text=/^(?:text\/|application\/(?:json|xml))/.test(blob.type)||/\.(?:md|txt|log|json|csv|tsv|yaml|yml|toml|ini|conf|py|js|mjs|ts|tsx|jsx|css|html|sh|xml|sql)$/i.test(entry.name);
        if(image){const image=el('img');image.src=objectUrl;image.alt=entry.name;body.append(image);}
        else if(text){const value=await blob.slice(0,256*1024).text();if(!active()||id!==request)return;body.append(el('pre',value));if(blob.size>256*1024)body.append(el('p','앞부분만 표시합니다. 전체 내용은 다운로드해주세요.','workspace-file-note'));}
        else body.append(el('p','이 파일은 다운로드하여 열 수 있습니다.','workspace-empty'));
        setStatus('파일 미리보기','ready');
      }catch(error){if(active()&&id===request){body.textContent='파일을 미리 볼 수 없습니다.';fail(error,generation);}}
    };
    up.onclick=()=>void load(directory.replace(/\/+$/,'').split('/').slice(0,-1).join('/'));root.onclick=()=>void load('');refresh.onclick=()=>void load(directory);void load(directory);
    return ()=>{request++;fileAbort?.abort();revoke();};
  }
  const open=()=>{panel.hidden=false;toggle.setAttribute('aria-expanded','true');void activate();};
  const hide=()=>{stop();panel.hidden=true;toggle.setAttribute('aria-expanded','false');content.replaceChildren();};
  toggle.onclick=()=>panel.hidden?open():hide();close.onclick=hide;retry.onclick=()=>void activate();
  const visibility=()=>{if(document.hidden)stop();else if(!panel.hidden)void activate();};document.addEventListener('visibilitychange',visibility);
  return {
    openRoom(roomId){this.setRoom(roomId||getRoomId?.());if(panel.hidden)open();},
    setRoom(roomId){if(state.destroyed||state.roomId===roomId)return;stop();state.roomId=roomId||null;content.replaceChildren();toggle.hidden=!state.roomId;if(!state.roomId){hide();return;}open();},
    reset(){stop();state.roomId=null;state.paths.clear();hide();toggle.hidden=true;},
    destroy(){if(state.destroyed)return;this.reset();state.destroyed=true;document.removeEventListener('visibilitychange',visibility);panel.remove();toggle.remove();},
  };
}
