import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


class SyncTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.source, self.target = root/'source', root/'target'
        (self.source/'scripts').mkdir(parents=True)
        self.target.mkdir()
        shutil.copy2(Path(__file__).resolve().parents[1]/'scripts/sync-installed.py', self.source/'scripts/sync-installed.py')
        self.git('init', '-b', 'main')
        self.git('config', 'user.name', 'Fixture')
        self.git('config', 'user.email', 'fixture@example.invalid')
        (self.source/'data.txt').write_text('old')
        self.git('add', '.')
        self.git('commit', '-m', 'baseline')
        for relative in ('data.txt', 'scripts/sync-installed.py'):
            dst=self.target/relative;dst.parent.mkdir(exist_ok=True)
            shutil.copy2(self.source/relative, dst)
        baseline = {p: hashlib.sha256((self.target/p).read_bytes()).hexdigest()
                    for p in ('data.txt', 'scripts/sync-installed.py')}
        (self.target/'.tinky-sync-state.json').write_text(json.dumps(
            dict(source=str(self.source), branch='main', files=baseline)))

    def tearDown(self): self.temp.cleanup()

    def git(self, *args):
        return subprocess.run(['git', '-C', str(self.source), *args], check=True, capture_output=True)

    def deploy(self):
        return subprocess.run(['python3', str(self.source/'scripts/sync-installed.py')],
            env={**os.environ, 'TINKY_SYNC_TARGET': str(self.target)}, capture_output=True, text=True)

    def change(self):
        (self.source/'data.txt').write_text('new')
        self.git('commit', '-am', 'reviewed change')

    def test_committed_update_preserves_unrelated_installed_files(self):
        self.change()
        (self.target/'unrelated.txt').write_text('keep')
        self.assertEqual(self.deploy().returncode, 0)
        self.assertEqual((self.target/'data.txt').read_text(), 'new')
        self.assertEqual((self.target/'unrelated.txt').read_text(), 'keep')

    def test_installed_edits_block_without_overwrite(self):
        self.change()
        (self.target/'data.txt').write_text('other session')
        result=self.deploy()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('refusing overwrite', result.stderr)
        self.assertEqual((self.target/'data.txt').read_text(), 'other session')

    def test_branch_switch_and_uncommitted_changes_cannot_deploy(self):
        self.change()
        self.git('checkout', '-b', 'experiment')
        self.assertNotEqual(self.deploy().returncode, 0)
        self.git('checkout', 'main')
        (self.source/'data.txt').write_text('uncommitted')
        self.assertNotEqual(self.deploy().returncode, 0)
        self.assertEqual((self.target/'data.txt').read_text(), 'old')


if __name__ == '__main__': unittest.main()
