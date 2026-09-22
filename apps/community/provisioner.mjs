import { request } from 'node:http';
export function createProvisioner(socketPath, desktops) {
  const pending=new Map();
  function call(room,action) {
    return new Promise((resolve,reject)=>{
      const req=request({socketPath,path:`/rooms/${room}/${action}`,method:'POST',headers:{'content-length':'0'}},res=>{
        let body='';res.on('data',b=>{body+=b;if(body.length>8192)req.destroy(new Error('response too large'));});
        res.on('end',()=>{try{const data=JSON.parse(body);if(res.statusCode!==200)throw Object.assign(new Error(data.error),{status:res.statusCode});resolve(data);}catch(e){reject(e);}});
      });
      req.setTimeout(55000,()=>req.destroy(new Error('데스크톱 준비 시간이 초과되었습니다. 다시 열어주세요.')));
      req.on('error',()=>reject(Object.assign(new Error('데스크톱 관리 서비스에 연결할 수 없습니다. 잠시 후 다시 열어주세요.'),{status:503})));req.end();
    });
  }
  return {
    enabled:!!socketPath,
    ensure(room) {
      if(!socketPath)return Promise.resolve();
      if(pending.has(room))return pending.get(room);
      const job=call(room,'ensure').then(data=>{
        const host=`desktop-${room}`;
        if(data.wsUrl!==`ws://${host}:6080/`||data.cdpUrl!==`http://${host}:9222/`)throw new Error('Unexpected desktop endpoint');
        desktops.set(room,data);
      }).finally(()=>pending.delete(room));pending.set(room,job);return job;
    },
    touch(room){if(socketPath)void call(room,'touch').catch(()=>{});},
  };
}
