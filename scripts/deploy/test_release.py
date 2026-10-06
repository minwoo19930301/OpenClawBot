import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest

spec=importlib.util.spec_from_file_location('release',Path(__file__).with_name('release.py'))
release=importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)

class DeploymentBoundaryTests(unittest.TestCase):
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
