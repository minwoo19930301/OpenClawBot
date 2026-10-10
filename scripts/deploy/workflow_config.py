"""Fail before SSH unless this repository's operator explicitly configured a target."""
import os
import re
from urllib.parse import urlsplit


def validate(values):
    required = ['GITHUB_REPOSITORY', 'OCI_DEPLOY_REPOSITORY', 'OCI_DEPLOY_HOST',
                'OCI_DEPLOY_USER', 'OCI_PUBLIC_ORIGIN', 'OCI_KNOWN_HOSTS']
    if any(not isinstance(values.get(key), str) or not values[key].strip() for key in required):
        raise ValueError('Configure this repository deployment target before connecting')
    repository = values['OCI_DEPLOY_REPOSITORY']
    if (not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*', repository)
            or repository != values['GITHUB_REPOSITORY']):
        raise ValueError('Deployment repository does not match this workflow repository')
    host = values['OCI_DEPLOY_HOST']
    if not re.fullmatch(r'[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?', host) or '..' in host:
        raise ValueError('Invalid explicit deployment hostname')
    if not re.fullmatch(r'[a-z_][a-z0-9_-]{0,31}', values['OCI_DEPLOY_USER']):
        raise ValueError('Invalid explicit deployment user')
    origin = urlsplit(values['OCI_PUBLIC_ORIGIN'])
    if (origin.scheme != 'https' or not origin.hostname or origin.username or origin.password
            or origin.query or origin.fragment or origin.path not in ['', '/']):
        raise ValueError('Configure an HTTPS public origin without credentials or a path')
    # Both clear and hashed known_hosts records are accepted; SSH performs the cryptographic match.
    if not any(len(line.split()) >= 3 and line.split()[1].startswith(('ssh-', 'ecdsa-'))
               for line in values['OCI_KNOWN_HOSTS'].splitlines() if line and not line.startswith('#')):
        raise ValueError('A pinned SSH known_hosts record is required')
    return values


if __name__ == '__main__':
    validate(os.environ)
