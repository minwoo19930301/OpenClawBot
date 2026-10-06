#!/usr/bin/python3
"""Root-owned release command: only current main of the fixed repository."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request

REPO = 'minwoo19930301/OpenClawBot'
ROOT = Path('/home/opc/community')
DEPLOY = ROOT / 'apps/community/deploy'
ROOM = '4bc4b8f0-1789-4afb-a927-e7adbcc7b9b9'
DESKTOP = 'desktop-' + ROOM
DESKTOP_CONTAINER = 'community-' + DESKTOP + '-1'

def run(*args, cwd=None, capture=False):
    return subprocess.run(args, cwd=cwd, check=True, text=True,
                          stdout=subprocess.PIPE if capture else None).stdout

def fetch(url):
    request = urllib.request.Request(url, headers={'User-Agent': 'OpenClawBot-deploy'})
    return urllib.request.urlopen(request, timeout=60)

def validate_sha(value):
    if not re.fullmatch(r'[0-9a-f]{40}', value):
        raise ValueError('Expected a full lowercase Git commit SHA')
    return value

def extract(archive, destination):
    with tarfile.open(archive) as tar:
        members = tar.getmembers()
        for member in members:
            parts = Path(member.name).parts
            if (not parts or member.name.startswith('/') or '..' in parts
                    or not (member.isfile() or member.isdir())):
                raise ValueError('Unsafe source archive member')
        tar.extractall(destination, members=members)
    roots = list(destination.iterdir())
    if len(roots) != 1 or not roots[0].is_dir():
        raise ValueError('Expected one source tree')
    return roots[0]

def desktop_digest(folder):
    digest = hashlib.sha256()
    for path in sorted(folder.rglob('*')):
        if path.is_file():
            digest.update(str(path.relative_to(folder)).encode())
            digest.update(path.read_bytes())
    return digest.hexdigest()

def update_env(path, values):
    lines = path.read_text().splitlines()
    lines = [line for line in lines if line.split('=', 1)[0] not in values]
    lines += [key + '=' + value for key, value in values.items()]
    temporary = path.with_name(path.name + '.pending')
    temporary.write_text('\n'.join(lines) + '\n')
    temporary.chmod(0o600)
    os.replace(temporary, path)

def verify(release, desktop=True):
    last_error = None
    for _ in range(30):
        try:
            with fetch('http://127.0.0.1:8787/api/health') as response:
                health = json.load(response)
            if health.get('ok') and health.get('release') == release:
                break
        except Exception as error:
            last_error = error
        time.sleep(2)
    else:
        raise RuntimeError('Release health did not match expected SHA') from last_error
    if desktop:
        # Actual RFB handshake through the app network, for each independent view.
        script = """
        import WebSocket from 'ws';
        for (const port of [6080,6081,6082]) {
          await new Promise((resolve,reject)=>{
            const ws=new WebSocket('ws://desktop-ROOM:'+port+'/websockify');
            const timer=setTimeout(()=>{ws.terminate();reject(Error('RFB timeout '+port));},10000);
            ws.on('error',e=>{clearTimeout(timer);reject(e);});
            ws.once('message',data=>{clearTimeout(timer);ws.close();
              if(!data.toString().startsWith('RFB '))reject(Error('Bad RFB '+port));else resolve();});
          });
          console.log('RFB view ready:',port);
        }
        """.replace('ROOM', ROOM)
        run('docker','exec','community-app-1','node','--input-type=module','-e',script)
        run('docker','exec',DESKTOP_CONTAINER,'google-chrome','--version')

def deploy(sha):
    sha = validate_sha(sha)
    with fetch('https://api.github.com/repos/' + REPO + '/commits/main') as response:
        main_sha = json.load(response)['sha']
    if sha != main_sha:
        raise ValueError('Refusing to deploy a commit that is no longer main')
    if not os.path.ismount('/var/lib/community-shared/home'):
        raise RuntimeError('Shared desktop storage is not mounted')
    if shutil.disk_usage(ROOT).free < 1536 * 1024**2:
        raise RuntimeError('At least 1.5 GiB free disk is required before building')
    with tempfile.TemporaryDirectory(prefix='openclaw-release-', dir='/home/opc') as folder:
        folder = Path(folder)
        archive = folder / 'source.tar.gz'
        with fetch('https://codeload.github.com/' + REPO + '/tar.gz/' + sha) as response:
            with archive.open('wb') as output:
                shutil.copyfileobj(response, output)
        source_dir = folder / 'source'
        source_dir.mkdir()
        source = extract(archive, source_dir)
        new_desktop_hash = desktop_digest(source / 'apps/community/deploy/desktop')
        state = Path('/var/lib/community-shared/deployed-desktop-hash')
        desktop_changed = not state.exists() or state.read_text().strip() != new_desktop_hash
        app_tag = 'community-app:' + sha
        desktop_tag = 'community-desktop:' + sha
        run('docker','build','--build-arg','RELEASE='+sha,'-t',app_tag,
            '-f',str(source/'apps/community/deploy/Dockerfile'),str(source))
        if desktop_changed:
            run('docker','build','-t',desktop_tag,'-f',
                str(source/'apps/community/deploy/desktop/Dockerfile.managed'),
                str(source/'apps/community/deploy/desktop'))
        old_app = run('docker','inspect','community-app-1','--format','{{.Image}}',capture=True).strip()
        old_desktop = run('docker','inspect',DESKTOP_CONTAINER,'--format','{{.Image}}',capture=True).strip()
        run('docker','tag',old_app,'community-app:previous')
        run('docker','tag',old_desktop,'community-desktop:previous')
        previous_release = json.loads(run('docker','exec','community-app-1','node','-e',
            "console.log(JSON.stringify(process.env.COMMUNITY_RELEASE))",capture=True))
        # SQLite backup API includes WAL state; never copy a live database file.
        backup_js = """
        const { DatabaseSync, backup }=await import('node:sqlite');
        const fs=await import('node:fs');fs.mkdirSync('/data/deploy-backups',{recursive:true,mode:0o700});
        const db=new DatabaseSync('/data/community.sqlite');
        await backup(db,'/data/deploy-backups/before-SHA.sqlite');db.close();
        """.replace('SHA', sha)
        run('docker','exec','community-app-1','node','--input-type=module','-e',backup_js)
        old_compose = (DEPLOY/'compose.yml').read_bytes()
        old_env = (DEPLOY/'.env.production').read_bytes()
        try:
            shutil.copytree(source, ROOT, dirs_exist_ok=True)
            update_env(DEPLOY/'.env.production', {
                'COMMUNITY_SHARED_DESKTOP_ROOM':ROOM,
                'COMMUNITY_DESKTOP_VIEWS':'1',
            })
            run('docker','tag',app_tag,'community-app:local')
            if desktop_changed:
                run('docker','tag',desktop_tag,'community-desktop:local')
                run('docker','tag',desktop_tag,'community-desktop:managed')
                mounts = json.loads(run('docker','inspect',DESKTOP_CONTAINER,capture=True))[0]['Mounts']
                if not any(m['Destination']=='/home/desktop' for m in mounts):
                    run('docker','pause',DESKTOP_CONTAINER)
                    try:
                        # docker cp can expose the underlying image instead of a
                        # tmpfs. Read the paused process's actual mount namespace.
                        pid=run('docker','inspect',DESKTOP_CONTAINER,'--format','{{.State.Pid}}',capture=True).strip()
                        if not pid.isdigit() or int(pid)<1:
                            raise RuntimeError('Cannot locate paused desktop namespace')
                        run('cp','-a','/proc/'+pid+'/root/home/desktop/.','/var/lib/community-shared/home/')
                    finally:
                        run('docker','unpause',DESKTOP_CONTAINER)
                run('chown','-hR','-P','10001:10001','/var/lib/community-shared/home')
                run('docker','stop','--time','20',DESKTOP_CONTAINER)
                # Chrome's hostname lock cannot survive replacement of its container.
                for name in ['SingletonLock','SingletonSocket','SingletonCookie']:
                    path=Path('/var/lib/community-shared/home/chromium')/name
                    if path.is_symlink() or path.is_file():
                        path.unlink()
                run('docker','compose','up','-d','--no-deps','--no-build',DESKTOP,cwd=DEPLOY)
            run('docker','compose','up','-d','--no-deps','--no-build','--wait','--wait-timeout','120','app',cwd=DEPLOY)
            verify(sha)
        except BaseException:
            print('Deployment failed; restoring previous app and desktop images.',flush=True)
            subprocess.run(['docker','logs','--tail','25',DESKTOP_CONTAINER])
            subprocess.run(['docker','inspect',DESKTOP_CONTAINER,'--format','{{json .State}}'])
            (DEPLOY/'compose.yml').write_bytes(old_compose)
            (DEPLOY/'.env.production').write_bytes(old_env)
            (DEPLOY/'.env.production').chmod(0o600)
            run('docker','tag',old_app,'community-app:local')
            run('docker','tag',old_desktop,'community-desktop:local')
            services = [DESKTOP,'app'] if desktop_changed else ['app']
            run('docker','compose','up','-d','--no-deps','--no-build','--wait',*services,cwd=DEPLOY)
            verify(previous_release,desktop=False)
            raise
        state.write_text(new_desktop_hash+'\n')
        Path('/var/lib/community-shared/deployed-release').write_text(sha+'\n')
        # Only retire this deployer's immutable tags; preserve current/previous
        # images, operator backup tags, other projects and every running image.
        for line in run('docker','image','ls','--format','{{.Repository}} {{.Tag}}',capture=True).splitlines():
            repository, tag = line.split()
            if (repository in ['community-app','community-desktop']
                    and re.fullmatch(r'[0-9a-f]{40}',tag)
                    and tag not in [sha,previous_release]):
                subprocess.run(['docker','image','rm',repository+':'+tag],
                               stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        print('DEPLOYED '+sha,flush=True)

if __name__ == '__main__':
    os.umask(0o077)
    if len(sys.argv)!=2:
        sys.exit('Usage: openclaw-release <full-main-commit-sha>')
    validate_sha(sys.argv[1])
    if os.geteuid()!=0:
        sys.exit('Deployment command must be installed and run via sudo')
    with open('/run/lock/openclaw-deploy.lock','w') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        deploy(sys.argv[1])
