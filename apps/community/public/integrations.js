import { applyBrand } from "/setup.js";
const status=document.querySelector('#status'), services=document.querySelector('#services');
let csrf;
async function api(path,body){const r=await fetch(path,{cache:'no-store',...(body?{method:'POST',headers:{'content-type':'application/json','x-csrf-token':csrf},body:JSON.stringify(body)}:{})});const d=await r.json();if(!r.ok)throw Error(d.error||'연결 실패');return d;}
const labels={auth:"서버 인증 확인",credits:'잔여 크레딧 확인',domains:'등록 도메인 조회',assets:'이미지 목록 조회',models:'모델 목록 조회',inbox:'받은메일 20개 조회',calendars:'캘린더 조회',profile:'인증·프로필 확인',search:'검색',voices:'음성 목록',account:'계정 확인'};
try {
 const session=await api('/api/session');applyBrand(session.brand);if(session.user?.role!=='admin')throw Error('사이트 관리자 로그인이 필요합니다.');csrf=session.csrfToken;
 const rooms=await api('/api/rooms');
 const personal=rooms.rooms.find(r=>r.personal);if(personal)document.querySelector('#personal-chat').href='/?room='+encodeURIComponent(personal.id);
 const data=await api('/api/admin/integrations');
 for(const service of data.services){
  const article=document.createElement('article'), title=document.createElement('h2'), badge=document.createElement('span'), note=document.createElement('p'), output=document.createElement('pre');
  title.textContent=service.name;badge.className='badge';badge.textContent=service.configured?'인증 정보 등록됨':'인증 정보 없음';note.textContent=service.note;
  article.append(title,badge,note);let query;
  if(service.actions.includes('search')){query=document.createElement('input');query.placeholder='검색어';query.setAttribute('aria-label','검색어');article.append(query);}
  for(const action of service.actions){const button=document.createElement('button');button.textContent=labels[action]||action;button.disabled=!service.configured;
   button.onclick=async()=>{button.disabled=true;output.textContent='조회 중…';try{const result=await api(`/api/admin/integrations/${service.id}/${action}`,query?{query:query.value}:{});output.textContent=JSON.stringify(result.result,null,2);}catch(e){output.textContent=e.message;}finally{button.disabled=false;}};article.append(button);
  }article.append(output);services.append(article);
 }status.textContent=`${data.services.filter(s=>s.configured).length}개 서비스의 인증 정보가 등록되어 있습니다. 연결 확인 버튼으로 실제 권한을 검사하세요.`;
}catch(e){status.textContent=e.message;}
document.querySelector('#models').onclick=async()=>{const output=document.querySelector('#model-result');output.textContent='확인 중…';try{const data=await api('/api/models');const providers={};for(const m of data.models)for(const p of m.providers)(providers[p]??=[]).push(m.name);output.textContent=JSON.stringify({providers,failures:data.failures},null,2);}catch(e){output.textContent=e.message;}};

document.querySelector('#ask-form').onsubmit=async event=>{event.preventDefault();const button=document.querySelector('#ask-button'),output=document.querySelector('#answer');button.disabled=true;output.textContent='연결 서비스를 확인하고 있어요…';try{const data=await api('/api/admin/integrations/ask',{prompt:document.querySelector('#ask-prompt').value});output.textContent=data.answer+(data.usedServices?.length?"\n\n조회 완료: "+data.usedServices.map(s=>s.id+" / "+s.action).join(", "):"");}catch(e){output.textContent=e.message;}finally{button.disabled=false;}};
