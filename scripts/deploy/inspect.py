"""Read operator-selected service metadata without printing environment values."""
import importlib.util
import json
import pathlib
import subprocess

# The installed file has no .py suffix, so use an explicit source loader.
from importlib.machinery import SourceFileLoader
spec=importlib.util.spec_from_loader('release',SourceFileLoader('release','/usr/local/sbin/openclaw-release'))
release=importlib.util.module_from_spec(spec);spec.loader.exec_module(release)
config=release.load_config()
def run(*args):
    return subprocess.check_output(args,text=True)
for name in [config['compose_project']+'-app-1',config['compose_project']+'-'+config['desktop_service']+'-1']:
    obj=json.loads(run('docker','inspect',name))[0]
    print(json.dumps({'name':name,'image':obj['Config']['Image'],'state':obj['State']['Status'],
                      'mount_destinations':[item['Destination'] for item in obj['Mounts']]}))
print(run('df','-h',config['checkout_root'],config['shared_storage_root']))
print(run('docker','compose','version'))
print('shared storage mounted:',pathlib.Path(config['shared_storage_root'],'home').is_mount())
