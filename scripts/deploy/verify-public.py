import json, os, urllib.request

origin='https://168.107.91.96'
with urllib.request.urlopen(origin+'/api/health',timeout=30) as response:
    health=json.load(response)
assert health.get('ok') is True and health.get('release')==os.environ['EXPECTED_SHA'], health
for path in ['/', '/app.js', '/desktop.js', '/manifest.webmanifest', '/sw.js']:
    with urllib.request.urlopen(origin+path,timeout=30) as response:
        assert response.status==200 and response.read(1), path
print('Public HTTPS and expected release verified:',health['release'])
