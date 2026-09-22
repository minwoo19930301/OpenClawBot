#!/usr/bin/python3
"""Narrow Unix-socket desktop broker. No caller-controlled images, paths or commands."""
import http.server, json, os, pathlib, re, shutil, socketserver, subprocess, threading, time
ROOT=pathlib.Path('/var/lib/community-desktops')
SOCKET='/run/community-provisioner/control.sock'
ROOM=re.compile(r'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$')
MAX_STORED=4
MAX_RUNNING=2 # dynamic desktops; the existing legacy desktop is additional
IDLE=900
LOCK=threading.Lock()
LEASES={}
class Capacity(Exception): pass
def run(*args): return subprocess.check_output(args,text=True,stderr=subprocess.DEVNULL,timeout=45).strip()
def docker(*args): return run('docker',*args)
def name(room): return 'desktop-'+room
def state(room):
    try: return json.loads(docker('inspect',name(room)))[0]
    except subprocess.CalledProcessError: return None
def ensure(room):
    with LOCK:
        ROOT.mkdir(parents=True,exist_ok=True)
        # Fail closed if the aggregate limit or network guard is missing.
        if pathlib.Path('/sys/fs/cgroup/community.slice/memory.max').read_text().strip()!='17179869184': raise Capacity('서버 자원 제한을 확인할 수 없습니다.')
        guard=run('nft','list','table','inet','community_desktop_guard')
        if '172.30.50.0/28' not in guard or '172.30.50.2' not in guard: raise Capacity('독립 데스크톱 네트워크 보호 설정 확인이 필요합니다.')
        if pathlib.Path('/sys/fs/cgroup/community.slice/cpu.max').read_text().split()!=['300000','100000']: raise Capacity('CPU 합산 제한 확인이 필요합니다.')
        entries=sorted(p for p in ROOT.iterdir() if p.is_dir() and ROOM.fullmatch(p.name))
        folder=ROOT/room
        info=state(room)
        if info and info.get("Config",{}).get("Labels",{}).get("openclawbot.managed") != "desktop": raise Capacity("관리 대상이 아닌 컨테이너와 이름이 충돌합니다.")
        if not info or not info['State']['Running']:
            active=docker('ps','-q','--filter','label=openclawbot.managed=desktop').split()
            if len(active)>=MAX_RUNNING: raise Capacity('독립 데스크톱 2개가 사용 중입니다. 미사용 화면이 15분 후 정지되면 다시 열어주세요.')
        if not folder.exists():
            if len(entries)>=MAX_STORED: raise Capacity('저장 가능한 데스크톱 4개 한도입니다. 운영자의 공간 정리가 필요합니다.')
            if shutil.disk_usage(ROOT).free < 3*1024**3: raise Capacity('디스크 여유 공간이 부족해 새 데스크톱 생성을 보류했습니다.')
            slots={int((p/'slot').read_text()) for p in entries}
            slot=next(i for i in range(4,8) if i not in slots)
            folder.mkdir(mode=0o700)
            (folder/'slot').write_text(str(slot))
        slot=int((folder/'slot').read_text())
        disk=folder/'home.ext4'; home=folder/'home'; home.mkdir(exist_ok=True)
        if not disk.exists():
            # Fixed-size filesystem limits each profile and all downloads to 512 MiB.
            temp=folder/'home.pending'
            try:
                run('fallocate','-l','512M',str(temp)); run('mkfs.ext4','-q','-F',str(temp)); temp.replace(disk)
            finally: temp.unlink(missing_ok=True)
        if subprocess.call(['mountpoint','-q',str(home)])!=0:
            run('mount','-o','loop,nodev,nosuid',str(disk),str(home))
            os.chown(home,10001,10001); os.chmod(home,0o700)
        if not info:
            docker('create','--name',name(room),'--label','openclawbot.managed=desktop','--label','com.docker.compose.project=community',
              '--network','community-desktop','--ip','172.30.50.'+str(slot),'--network-alias',name(room),
              '--cgroup-parent','community.slice','--memory','2g','--memory-swap','2g','--cpus','1','--pids-limit','256',
              '--shm-size','128m','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true',
              '--security-opt','seccomp=/home/opc/community/apps/community/deploy/desktop/seccomp-chromium.json',
              '--volume',str(home)+':/home/desktop:Z',
              '--tmpfs','/tmp:rw,size=128m,mode=1777','--tmpfs','/run/desktop:rw,size=32m,uid=10001,gid=10001,mode=700',
              '--log-opt','max-size=5m','--log-opt','max-file=2','community-desktop:managed')
        if not info or not info['State']['Running']: docker('start',name(room))
        LEASES[room]=time.monotonic()
        return {'wsUrl':'ws://'+name(room)+':6080/','cdpUrl':'http://'+name(room)+':9222/'}
def reap_once():
    with LOCK:
        for room in list(LEASES):
            if time.monotonic()-LEASES[room]>IDLE:
                docker('stop','--time','15',name(room)); del LEASES[room]
def reap():
    while True:
        time.sleep(30)
        try: reap_once()
        except Exception: pass
class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def do_POST(self):
        match=re.fullmatch(r'/rooms/([a-f0-9-]{36})/(ensure|touch)',self.path)
        status=200
        try:
            if not match or not ROOM.fullmatch(match[1]) or match[1]=='00000000-0000-4000-8000-000000000001': raise ValueError('route')
            room,action=match.groups()
            if action=='ensure': result=ensure(room)
            else:
                with LOCK:
                    if room in LEASES: LEASES[room]=time.monotonic()
                result={'ok':True}
        except Capacity as e: status=409; result={'error':str(e)}
        except ValueError: status=400; result={'error':'잘못된 데스크톱 요청입니다.'}
        except Exception: status=503; result={'error':'데스크톱 생성 또는 재시작을 완료하지 못했습니다. 운영자 확인이 필요합니다.'}
        payload=json.dumps(result).encode(); self.send_response(status); self.send_header('Content-Type','application/json'); self.send_header('Content-Length',str(len(payload))); self.end_headers(); self.wfile.write(payload)
class Server(socketserver.ThreadingMixIn,socketserver.UnixStreamServer): daemon_threads=True
if __name__=='__main__':
    ROOT.mkdir(parents=True,exist_ok=True)
    # Existing containers must be remounted through ensure after broker/host restart.
    for cid in docker('ps','-q','--filter','label=openclawbot.managed=desktop').split(): docker('stop','--time','15',cid)
    pathlib.Path(SOCKET).unlink(missing_ok=True)
    server=Server(SOCKET,Handler); os.chown(SOCKET,0,1000); os.chmod(SOCKET,0o660)
    threading.Thread(target=reap,daemon=True).start(); server.serve_forever()
