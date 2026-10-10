import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch, Mock
from types import SimpleNamespace
import json
import os
import stat

spec=importlib.util.spec_from_file_location('release',Path(__file__).with_name('release.py'))
release=importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)

def config_fixture(root='/srv/example-app'):
    return {'repository':'example/project','checkout_root':root,'deployment_user':'operator',
            'shared_desktop_room':'11111111-2222-4333-8444-555555555555',
            'shared_storage_root':'/var/lib/example-desktop','public_origin':'https://bot.example',
            'compose_project':'example','desktop_service':'desktop'}


class DeploymentBoundaryTests(unittest.TestCase):
    def test_install_never_mounts_over_unmounted_desktop_data(self):
        with tempfile.TemporaryDirectory() as temporary:
            config=dict(config_fixture(),shared_storage_root=temporary)
            home=Path(temporary)/'home'
            with patch.object(os.path,'ismount',return_value=False):
                release.check_install_storage(config)
                home.mkdir()
                release.check_install_storage(config)
                (home/'saved-file').write_text('existing desktop data')
                with self.assertRaisesRegex(ValueError,'contains data'):
                    release.check_install_storage(config)
            with patch.object(os.path,'ismount',return_value=True):
                release.check_install_storage(config)
            (home/'saved-file').unlink();home.rmdir()
            home.symlink_to(temporary,target_is_directory=True)
            with self.assertRaisesRegex(ValueError,'symlink'):
                release.check_install_storage(config)

    def test_rejects_shell_commands_and_non_pinned_refs(self):
        for value in ['main','a'*39,'a'*40+'; id','--help','A'*40,'$(id)']:
            with self.subTest(value=value),self.assertRaises(ValueError):
                release.validate_sha(value)
        self.assertEqual(release.validate_sha('a'*40),'a'*40)

    def test_rejects_tar_traversal_links_and_devices(self):
        for name,kind in [('repo/../../escape',tarfile.REGTYPE),('/escape',tarfile.REGTYPE),
                          ('repo/link',tarfile.SYMTYPE),('repo/device',tarfile.CHRTYPE)]:
            with self.subTest(name=name),tempfile.TemporaryDirectory() as temporary:
                root=Path(temporary);archive=root/'source.tar.gz';target=root/'target';target.mkdir()
                with tarfile.open(archive,'w:gz') as tar:
                    member=tarfile.TarInfo(name);member.type=kind;tar.addfile(member)
                with self.assertRaises(ValueError):release.extract(archive,target)

    def test_env_update_preserves_credentials_and_file_mode(self):
        with tempfile.TemporaryDirectory() as temporary:
            path=Path(temporary)/'.env.production'
            path.write_text('PRIVATE_TOKEN=unchanged-test-fixture\nVIEW=0\n')
            release.update_env(path,{'VIEW':'1'})
            self.assertEqual(path.read_text(),'PRIVATE_TOKEN=unchanged-test-fixture\nVIEW=1\n')
            self.assertEqual(path.stat().st_mode & 0o777,0o600)

    def test_source_archive_extracts_into_single_directory(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);archive=root/'source.tar.gz';target=root/'target';target.mkdir()
            with tarfile.open(archive,'w:gz') as tar:
                member=tarfile.TarInfo('repo/file');member.size=2;tar.addfile(member,io.BytesIO(b'ok'))
            self.assertEqual((release.extract(archive,target)/'file').read_text(),'ok')

    def test_operator_config_is_explicit_and_rejects_untrusted_selectors(self):
        good=config_fixture()
        self.assertEqual(release.validate_config(good),good)
        for key in good:
            value=dict(good);value.pop(key)
            with self.subTest(missing=key),self.assertRaises(ValueError):release.validate_config(value)
        for key,value in [('repository','https://github.com/example/project'),('repository','../someone/project'),
                          ('checkout_root','/'),('checkout_root','/srv/../etc'),('checkout_root','relative'),
                          ('deployment_user','operator; id'),('desktop_service','--help'),
                          ('shared_desktop_room',''),('public_origin','http://bot.example'),
                          ('public_origin','https://name:secret@bot.example'),('public_origin','https://bot.example/path')]:
            with self.subTest(key=key,value=value),self.assertRaises(ValueError):release.validate_config(dict(good,**{key:value}))
        with self.assertRaises(ValueError):release.validate_config(dict(good,config_path='/tmp/evil.json'))

    def test_missing_private_config_stops_before_network_or_commands(self):
        with patch.object(release,'read_root_file',side_effect=FileNotFoundError),patch.object(release,'fetch') as fetch,patch.object(release,'run') as run:
            with self.assertRaises(FileNotFoundError):release.deploy('a'*40)
            fetch.assert_not_called();run.assert_not_called()

    def test_repo_is_pinned_to_private_config_not_environment(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);deployment=root/'apps/community/deploy';deployment.mkdir(parents=True)
            (deployment/'.env.production').write_text('COMMUNITY_ORIGIN=https://bot.example\n')
            response=io.BytesIO(json.dumps({'sha':'b'*40}).encode())
            with patch.object(release,'load_config',return_value=config_fixture(str(root))),patch.object(release,'fetch',return_value=response) as fetch,patch.dict(os.environ,{'REPO':'foreign/target','OCI_DEPLOY_REPOSITORY':'foreign/target','OPENCLAW_DEPLOY_CONFIG':'/tmp/evil'}):
                with self.assertRaisesRegex(ValueError,'no longer main'):release.deploy('a'*40)
                fetch.assert_called_once_with('https://api.github.com/repos/example/project/commits/main')

    def test_foreign_origin_stops_before_contacting_source(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);deployment=root/'apps/community/deploy';deployment.mkdir(parents=True)
            (deployment/'.env.production').write_text('COMMUNITY_ORIGIN=https://different.example\n')
            with patch.object(release,'load_config',return_value=config_fixture(str(root))),patch.object(release,'fetch') as fetch:
                with self.assertRaisesRegex(ValueError,'origin'):release.deploy('a'*40)
                fetch.assert_not_called()

    def test_private_config_must_be_root_owned_and_not_symlinked(self):
        with tempfile.TemporaryDirectory() as temporary:
            path=Path(temporary)/'deployment.json';path.write_text('{}');path.chmod(0o600)
            parent=SimpleNamespace(st_uid=0,st_mode=stat.S_IFDIR|0o755)
            with patch.object(Path,'stat',return_value=parent):
                for uid,mode in [(1000,0o600),(0,0o644),(0,0o620)]:
                    with patch.object(os,'fstat',return_value=SimpleNamespace(st_uid=uid,st_mode=stat.S_IFREG|mode)):
                        with self.subTest(uid=uid,mode=mode),self.assertRaises(ValueError):release.read_root_file(path)
                with patch.object(os,'fstat',return_value=SimpleNamespace(st_uid=0,st_mode=stat.S_IFREG|0o600)):
                    self.assertEqual(release.read_root_file(path),b'{}')
                link=Path(temporary)/'link';link.symlink_to(path)
                with self.assertRaises(OSError):release.read_root_file(link)
            with patch.object(Path,'stat',return_value=SimpleNamespace(st_uid=0,st_mode=stat.S_IFDIR|0o777)):
                with self.assertRaises(ValueError):release.read_root_file(path)

    def test_compose_uses_private_manifest_and_configured_project(self):
        config=config_fixture()
        with patch.object(release,'run') as run:
            release.compose(config,'up','-d','app')
            args=run.call_args.args
            self.assertEqual(args[:2],('docker','compose'))
            self.assertEqual(args[args.index('-f')+1],'/etc/openclaw/compose.yml')
            self.assertEqual(args[args.index('-p')+1],'example')
            self.assertEqual(args[args.index('--env-file')+1],'/srv/example-app/apps/community/deploy/.env.production')

    def test_copy_source_never_replaces_private_settings_or_context(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);source=root/'source';target=root/'target';source.mkdir();target.mkdir()
            private=['.env.production','private-integrations.json','BUSINESS_CONTEXT.md','agent-context.md','community.sqlite']
            for name in private:
                (source/name).write_text('foreign source content')
                (target/name).write_text('existing private content')
            (source/'.openclaw-private').mkdir();(source/'.openclaw-private'/'token').write_text('foreign')
            (source/'app.js').write_text('new code')
            release.copy_source(source,target)
            for name in private:self.assertEqual((target/name).read_text(),'existing private content')
            self.assertFalse((target/'.openclaw-private').exists())
            self.assertEqual((target/'app.js').read_text(),'new code')
