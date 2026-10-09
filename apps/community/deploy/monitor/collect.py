#!/usr/bin/python3
"""Read-only A1 host metrics; physical disks and mounted filesystems counted once."""
import json, os, pathlib, subprocess, time
OUT = pathlib.Path('/var/lib/community-monitor')
def run(*args): return subprocess.check_output(args,text=True,timeout=10).strip()
def gib(n): return int(n)/1024**3
def cpu():
    values=list(map(int,pathlib.Path('/proc/stat').read_text().splitlines()[0].split()[1:9]))
    return sum(values),values[3]+values[4]
def main():
    first=cpu(); time.sleep(1); last=cpu()
    mem={k:int(v.strip().split()[0])*1024 for k,v in (line.split(':',1) for line in pathlib.Path('/proc/meminfo').read_text().splitlines())}
    blocks=json.loads(run('lsblk','--bytes','--json','--output','NAME,TYPE,SIZE'))['blockdevices']
    physical=sum(int(b['size']) for b in blocks if b['type']=='disk')
    allocated=sum(sum(int(p['size']) for p in b.get('children',[]) if p['type']=='part') or int(b['size']) for b in blocks if b['type']=='disk')
    mounts=json.loads(run('findmnt','--json','--list','--output','SOURCE,TARGET,FSTYPE'))['filesystems']
    filesystems=[]; seen=set()
    for m in mounts:
        source=m['source']
        if not source.startswith('/dev/') or source.startswith('/dev/loop') : continue
        device=os.stat(m['target']).st_dev
        if device in seen: continue
        seen.add(device)
        st=os.statvfs(m['target']); total=st.f_blocks*st.f_frsize; free=st.f_bavail*st.f_frsize
        filesystems.append(dict(mount=m['target'],totalGiB=gib(total),usedGiB=gib((st.f_blocks-st.f_bfree)*st.f_frsize),freeGiB=gib(free),usedPercent=100*(total-free)/total if total else 0))
    used=sum(f['usedGiB'] for f in filesystems); free=sum(f['freeGiB'] for f in filesystems)
    total=gib(physical); usable=gib(mem['MemTotal'])
    s=dict(timestamp=int(time.time()*1000),scope='a1-host',cpuCount=os.cpu_count(),cpuUsedPercent=100*(1-(last[1]-first[1])/max(1,last[0]-first[0])),memoryUsedGiB=gib(mem['MemTotal']-mem['MemAvailable']),memoryTotalGiB=usable,diskTotalGiB=total,diskUsedGiB=used,diskUsedPercent=100*used/total,diskFreeGiB=free,diskUnallocatedGiB=gib(max(0,physical-allocated)),filesystems=filesystems,communityMemoryGiB=gib(run('systemctl','show','community.slice','--property=MemoryCurrent','--value')),communityLimitGiB=usable,communityCpuLimit=os.cpu_count(),personalLimitGiB=usable,personalCpuLimit=os.cpu_count(),limitsVerified=pathlib.Path("/sys/fs/cgroup/community.slice/memory.max").read_text().strip()=="max" and pathlib.Path("/sys/fs/cgroup/community.slice/cpu.max").read_text().split()==["400000","100000"])
    OUT.mkdir(mode=0o755,exist_ok=True)
    tmp=OUT/'status.tmp'; tmp.write_text(json.dumps(s)); tmp.chmod(0o644); tmp.replace(OUT/'status.json')
if __name__=='__main__': main()
