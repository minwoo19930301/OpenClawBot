import importlib.util
from pathlib import Path
import unittest

spec=importlib.util.spec_from_file_location('workflow_config',Path(__file__).with_name('workflow_config.py'))
workflow=importlib.util.module_from_spec(spec);spec.loader.exec_module(workflow)

def values():
    return {'GITHUB_REPOSITORY':'example/project','OCI_DEPLOY_REPOSITORY':'example/project',
            'OCI_DEPLOY_HOST':'host.example','OCI_DEPLOY_USER':'operator','OCI_PUBLIC_ORIGIN':'https://site.example',
            'OCI_KNOWN_HOSTS':'host.example ssh-ed25519 AAAA-fixture'}

class WorkflowTargetTests(unittest.TestCase):
    def test_no_default_target_for_a_fork(self):
        with self.assertRaises(ValueError):workflow.validate({'GITHUB_REPOSITORY':'fork/project'})
        for key in values():
            item=values();item.pop(key)
            with self.subTest(missing=key),self.assertRaises(ValueError):workflow.validate(item)

    def test_foreign_repository_and_shell_host_are_rejected(self):
        self.assertEqual(workflow.validate(values()),values())
        for key,value in [('GITHUB_REPOSITORY','foreign/project'),('OCI_DEPLOY_REPOSITORY','foreign/project'),
                          ('OCI_DEPLOY_HOST','-oProxyCommand=bad'),('OCI_DEPLOY_HOST','user@other.example'),
                          ('OCI_DEPLOY_HOST','host.example; id'),('OCI_DEPLOY_HOST','host.example/path'),
                          ('OCI_DEPLOY_USER','root -o'),('OCI_PUBLIC_ORIGIN','https://user:pass@site.example'),
                          ('OCI_PUBLIC_ORIGIN','http://site.example'),('OCI_KNOWN_HOSTS','')]:
            with self.subTest(key=key,value=value),self.assertRaises(ValueError):workflow.validate(dict(values(),**{key:value}))

    def test_both_workflows_gate_repository_and_validate_before_ssh(self):
        root=Path(__file__).resolve().parents[2]
        for name in ['ci.yml','oci-bootstrap.yml']:
            content=(root/'.github/workflows'/name).read_text()
            self.assertIn('vars.OCI_DEPLOY_REPOSITORY == github.repository',content)
            self.assertLess(content.index('python3 scripts/deploy/workflow_config.py'),content.index('if ssh' if name=='ci.yml' else 'ssh "${args[@]}"'))
            self.assertIn('StrictHostKeyChecking=yes',content)
            self.assertIn('target="$OCI_DEPLOY_USER@$OCI_DEPLOY_HOST"',content)
            self.assertNotRegex(content,r'ssh[^\n]*[a-z_][a-z0-9_-]*@(?:[0-9]+\.){3}[0-9]+')
