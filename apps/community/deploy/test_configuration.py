"""Offline deployment checks: no Docker daemon, host firewall or credentials used."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent

def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

class DeploymentTests(unittest.TestCase):
    def firewall(self, script, address=None, desktop=None):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)
            capture = path / 'capture'
            # Fake both CLIs; a successful list merely reports the dedicated table exists.
            for command in ('nft', 'iptables'):
                fake = path / command
                fake.write_text('#!/bin/bash\nprintf "%s\\n" "$*" >> "$CAPTURE"\nif [[ "$1" == "-f" ]]; then cat >> "$CAPTURE"; fi\n')
                fake.chmod(0o700)
            env = {key: value for key, value in os.environ.items()
                   if key not in ('HOST_PUBLIC_IP', 'DESKTOP_IP')}
            env.update(PATH=f'{path}:/usr/bin:/bin', CAPTURE=str(capture))
            if address is not None:
                env['HOST_PUBLIC_IP'] = address
            if desktop is not None:
                env['DESKTOP_IP'] = desktop
            result = subprocess.run(['bash', str(ROOT / 'desktop' / script)],
                                    env=env, capture_output=True, text=True)
            return result, capture.read_text() if capture.exists() else ''

    def test_firewalls_reject_missing_invalid_and_injected_addresses_before_commands(self):
        for script in ('community-desktop-guard.sh', 'community-desktop-firewall.sh'):
            for address in (None, '', '256.1.2.3', '203.0.113.2; flush ruleset', 'example.com', '::1'):
                with self.subTest(script=script, address=address):
                    result, applied = self.firewall(script, address)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertEqual(applied, '')
            result, applied = self.firewall(script, '203.0.113.12', 'bad-address')
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(applied, '')

    def test_nft_guard_uses_explicit_host_and_preserves_app_reply_boundary(self):
        result, applied = self.firewall('community-desktop-guard.sh', '203.0.113.12')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(applied.count('203.0.113.12/32'), 3)
        self.assertEqual(applied.count('ip saddr != 172.30.50.2'), 3)
        self.assertIn('ct state established,related accept', applied)
        self.assertIn('destroy table inet community_desktop_guard', applied)
        self.assertNotIn('flush ruleset', applied)

    def test_legacy_iptables_uses_explicit_host(self):
        result, applied = self.firewall('community-desktop-firewall.sh', '203.0.113.13')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('-d 203.0.113.13/32 -j REJECT', applied)
        self.assertIn('-s 172.30.50.3/32', applied)

    def test_whole_host_cpu_policy_is_not_tied_to_four_cpu_machine(self):
        for component in ('monitor', 'provisioner'):
            module = load_module(component, ROOT / component / ('collect.py' if component == 'monitor' else 'service.py'))
            for cores in (1, 2, 4, 8):
                with self.subTest(component=component, cores=cores), patch.object(module.os, 'cpu_count', return_value=cores):
                    self.assertTrue(module.whole_host_cpu('max 100000'))
                    self.assertTrue(module.whole_host_cpu(f'{cores * 100000} 100000'))
                    self.assertFalse(module.whole_host_cpu(f'{cores * 100000 - 1} 100000'))
                    for malformed in ('max', 'max 0', '-1 100000', 'max -1', 'max x', '1 2 3'):
                        self.assertFalse(module.whole_host_cpu(malformed))

    def test_environment_templates_leave_operator_and_provider_values_blank(self):
        required_blank = {
            '.env.production.example': ['COMMUNITY_ORIGIN', 'COMMUNITY_PUBLIC_HOST',
                'COMMUNITY_SHARED_DESKTOP_ROOM', 'COMMUNITY_DESKTOP_HOME',
                'COMMUNITY_BOOTSTRAP_TOKEN', 'COMMUNITY_LLM_BASE_URL', 'COMMUNITY_LLM_MODEL',
                'COMMUNITY_OPENCLAW_BASE_URL', 'COMMUNITY_INTEGRATIONS_FILE', 'COMMUNITY_AGENT_CONTEXT_FILE'],
            'openclaw/.env.example': ['COMMUNITY_OPENCLAW_TOKEN', 'OPENCLAW_MODEL_BASE_URL',
                'OPENCLAW_MODEL_API', 'OPENCLAW_MODEL_ID', 'OPENCLAW_MODEL_NAME'],
            'desktop/desktop-network.env.example': ['HOST_PUBLIC_IP'],
        }
        for name, keys in required_blank.items():
            values = dict(line.split('=', 1) for line in (ROOT / name).read_text().splitlines()
                          if line and not line.startswith('#'))
            for key in keys:
                self.assertEqual(values[key], '', f'{name}: {key}')
            for key, value in values.items():
                if any(part in key for part in ('TOKEN', 'KEY', 'PASSWORD', 'SECRET')):
                    self.assertEqual(value, '', f'{name}: {key}')

    def test_gateway_configuration_uses_only_operator_selected_provider(self):
        config = json.loads((ROOT / 'openclaw/community.json').read_text())
        self.assertEqual(config['agents']['defaults']['model']['primary'], 'configured/${OPENCLAW_MODEL_ID}')
        self.assertEqual(set(config['models']['providers']), {'configured'})
        provider = config['models']['providers']['configured']
        self.assertEqual(provider['baseUrl'], '${OPENCLAW_MODEL_BASE_URL}')
        self.assertEqual(provider['apiKey'], '${OPENCLAW_MODEL_API_KEY}')
        self.assertEqual(provider['models'][0]['id'], '${OPENCLAW_MODEL_ID}')
        self.assertEqual(config['tools']['deny'], ['*'])
        self.assertFalse(config['browser']['enabled'])
        self.assertFalse(config['plugins']['enabled'])

if __name__ == '__main__':
    unittest.main()
