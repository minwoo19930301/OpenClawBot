#!/usr/bin/python3
"""Read-only host metrics; atomic snapshot, no credentials or Docker socket exposed."""
import json, os, pathlib, subprocess, time
OUT = pathlib.Path('/var/lib/community-monitor')
def prop(unit, name):
    return subprocess.check_output(['systemctl','show',unit,'--property='+name,'--value'],text=True,timeout=5).strip()
def gib(n): return int(n)/1024**3
def quota(unit):
    v=prop(unit,'CPUQuotaPerSecUSec')
    if v.endswith('ms'): return float(v[:-2])/1000
    if v.endswith('s'): return float(v[:-1])
    raise ValueError('unlimited quota')
def main():
    mem={k:int(v.strip().split()[0])*1024 for k,v in (line.split(':',1) for line in pathlib.Path('/proc/meminfo').read_text().splitlines())}
    st=os.statvfs('/'); total=st.f_blocks*st.f_frsize; avail=st.f_bavail*st.f_frsize
    cpu=quota('community.slice'); personal_cpu=quota('openclaw.service')
    maximum=gib(prop('community.slice','MemoryMax')); personal_max=gib(prop('openclaw.service','MemoryMax'))
    # Every community container must actually belong to the shared parent.
    ids=subprocess.check_output(['docker','ps','-q','--filter','label=com.docker.compose.project=community'],text=True,timeout=5).split()
    parents=[]
    for cid in ids:
        parents.append(subprocess.check_output(['docker','inspect','--format','{{.HostConfig.CgroupParent}}',cid],text=True,timeout=5).strip())
    s=dict(timestamp=int(time.time()*1000),memoryUsedGiB=gib(mem['MemTotal']-mem['MemAvailable']),memoryTotalGiB=gib(mem['MemTotal']),diskUsedPercent=100*(total-avail)/total,diskFreeGiB=gib(avail),communityMemoryGiB=gib(prop('community.slice','MemoryCurrent')),communityLimitGiB=maximum,communityCpuLimit=cpu,personalLimitGiB=personal_max,personalCpuLimit=personal_cpu,limitsVerified=bool(ids) and all(p=='community.slice' for p in parents) and cpu<=3 and maximum<=16 and personal_cpu<=.5 and personal_max<=2 and prop('community.slice','MemorySwapMax')=='0')
    OUT.mkdir(mode=0o755,exist_ok=True)
    tmp=OUT/'status.tmp'; tmp.write_text(json.dumps(s)); tmp.chmod(0o644); tmp.replace(OUT/'status.json')
if __name__=='__main__': main()
