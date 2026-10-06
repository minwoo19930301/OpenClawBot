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
