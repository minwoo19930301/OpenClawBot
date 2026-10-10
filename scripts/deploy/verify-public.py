import json
import os
import re
import urllib.request
from urllib.parse import urlsplit


def verify(origin, expected):
    parsed = urlsplit(origin)
    if (parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password
            or parsed.query or parsed.fragment or parsed.path not in ['', '/']):
        raise ValueError('Set OCI_PUBLIC_ORIGIN to the operator HTTPS origin')
    if not re.fullmatch(r'[a-f0-9]{40}', expected):
        raise ValueError('Expected an immutable release SHA')
    origin = origin.rstrip('/')
    with urllib.request.urlopen(origin + '/api/health', timeout=30) as response:
        health = json.load(response)
    if health.get('ok') is not True or health.get('release') != expected:
        raise RuntimeError('Public release does not match the tested SHA')
    for path in ['/', '/app.js', '/desktop.js', '/manifest.webmanifest', '/sw.js']:
        with urllib.request.urlopen(origin + path, timeout=30) as response:
            if response.status != 200 or not response.read(1):
                raise RuntimeError('Public asset unavailable: ' + path)
    print('Public HTTPS and expected release verified:', expected)


if __name__ == '__main__':
    verify(os.environ['OCI_PUBLIC_ORIGIN'], os.environ['EXPECTED_SHA'])
