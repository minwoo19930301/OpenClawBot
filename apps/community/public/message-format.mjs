export function safeLink(value) {
  try {const u=new URL(value);return ['https:','http:'].includes(u.protocol)&&!u.username&&!u.password?u.href:null;}catch{return null;}
}
function inline(node,text){
 const pattern=/\*\*([^*\n]+)\*\*|`([^`\n]+)`|\[([^\]\n]+)\]\(([^\s)]+)\)/g;
 let end=0;
 for(const match of text.matchAll(pattern)){
  node.append(document.createTextNode(text.slice(end,match.index)));
  const link=match[3]&&safeLink(match[4]);
  if(match[3]&&!link)node.append(document.createTextNode(match[0]));
  else {const element=document.createElement(match[1]?'strong':match[2]?'code':'a');element.textContent=match[1]||match[2]||match[3];if(link){element.href=link;element.target='_blank';element.rel='noopener noreferrer';}node.append(element);}
  end=match.index+match[0].length;
 }
 node.append(document.createTextNode(text.slice(end)));
}
export function renderMessageText(value){
 const root=document.createElement('div');root.className='message-copy';
 const parts=String(value).split(/```/);
 parts.forEach((part,index)=>{
  if(index%2){
   const newline=part.indexOf('\n');const language=newline>=0?part.slice(0,newline).trim():'';
   const content=newline>=0?part.slice(newline+1).replace(/\n$/,''):part;
   const block=document.createElement('div');block.className='code-block';
   const header=document.createElement('div');header.className='code-header';const label=document.createElement('span');label.textContent=language||'코드';const button=document.createElement('button');button.type='button';button.textContent='복사';button.setAttribute('aria-label','코드 복사');button.onclick=async()=>{try{await navigator.clipboard.writeText(content);button.textContent='복사됨';}catch{button.textContent='복사 실패';}};
   header.append(label,button);const pre=document.createElement('pre'),code=document.createElement('code');code.textContent=content;pre.append(code);block.append(header,pre);root.append(block);
  }else{
   for(const paragraph of part.split(/\n\s*\n/)){if(!paragraph.trim())continue;const node=document.createElement('div');node.className='rich-paragraph';const heading=paragraph.match(/^#{1,3}\s+(.+)$/);if(heading){node.classList.add('rich-heading');inline(node,heading[1]);}else inline(node,paragraph.trim());root.append(node);}
  }
 });return root;
}
