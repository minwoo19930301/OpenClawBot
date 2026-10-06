import json, subprocess, pathlib

def run(*args):
    return subprocess.check_output(args, text=True)

print(run('docker','ps','--format','{{.Names}} {{.Status}}'))
names=run('docker','ps','-a','--format','{{.Names}}').splitlines()
for name in names:
    if name.startswith('community-') and ('desktop' in name or name=='community-app-1'):
        obj=json.loads(run('docker','inspect',name))[0]
        print(json.dumps({'name':name,'image':obj['Config']['Image'],'mounts':obj['Mounts'],'tmpfs':obj['HostConfig'].get('Tmpfs'), 'labels':obj['Config'].get('Labels')}))
        if name=='community-app-1':
            print('desktop settings:',[v for v in obj['Config']['Env'] if v.split('=')[0] in ['COMMUNITY_DESKTOP_MAP','COMMUNITY_INITIAL_ROOM_ID','COMMUNITY_SHARED_DESKTOP_ROOM','COMMUNITY_DESKTOP_VIEWS']])
print(run('df','-h','/home/opc','/var/lib'))
print(run('docker','compose','version'))
print('shared storage exists:',pathlib.Path('/var/lib/community-shared').exists())
candidate='community-desktop:cd1cb32fed18a79cf7567e4fa9394a6f37c6e3a6'
if subprocess.run(['docker','image','inspect',candidate],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0:
    import time
    name='openclaw-desktop-preflight'
    try:
        run('docker','run','-d','--name',name,'--network','none','--memory','2g','--pids-limit','256',
            '--cap-drop','ALL','--security-opt','no-new-privileges:true',
            '--security-opt','seccomp=/home/opc/community/apps/community/deploy/desktop/seccomp-chromium.json',
            '--shm-size','128m','--tmpfs','/home/desktop:size=512m,uid=10001,gid=10001,mode=700',
            '--tmpfs','/tmp:size=128m,mode=1777','--tmpfs','/run/desktop:size=32m,uid=10001,gid=10001,mode=700',candidate)
        time.sleep(8)
        print('candidate state:',run('docker','inspect',name,'--format','{{json .State}}'))
        subprocess.run(['docker','logs','--tail','25',name])
        subprocess.run(['docker','exec',name,'sh','-c','cat /run/desktop/xvfb.log /run/desktop/chromium.log; ps -eo comm | sort | uniq -c'])
    finally:
        subprocess.run(['docker','rm','-f',name],stdout=subprocess.DEVNULL)
