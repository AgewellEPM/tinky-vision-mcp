#!/usr/bin/env python3
"""Deploy committed source only when the installed baseline is unchanged."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile


def digest(path):
    if path.is_symlink() or not path.is_file():
        return None
    return hashlib.sha256(path.read_bytes()).hexdigest()


def atomic_write(path, data, mode):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='.tinky-sync-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main():
    source = Path(__file__).resolve().parent.parent
    target = Path(os.environ.get('TINKY_SYNC_TARGET', str(Path.home() / '.kist/mcp/tinky-vision-mcp'))).resolve()
    mode = sys.argv[1] if len(sys.argv) > 1 else 'deploy'
    if mode not in ('check', 'deploy'):
        raise RuntimeError('Usage: tinky-vision-sync [check|deploy]')

    def git(*args):
        return subprocess.check_output(['git', '-C', str(source), *args])

    manifest_path = target / '.tinky-sync-state.json'
    if not manifest_path.is_file():
        raise RuntimeError('Missing reviewed deployment baseline; reconcile both checkouts before deploying')
    manifest = json.loads(manifest_path.read_text())
    branch = git('symbolic-ref', '--short', 'HEAD').decode().strip()
    if Path(manifest['source']).resolve() != source or manifest['branch'] != branch:
        raise RuntimeError('Source checkout/branch differs from the reviewed deployment baseline')
    if git('status', '--porcelain', '--untracked-files=no').strip():
        raise RuntimeError('Commit the reviewed source changes before deployment')
    paths = [p for p in git('ls-files', '-z').decode().split('\0') if p]
    planned, hashes = [], {}
    # Preflight ALL paths before writing anything. Untracked installed work and
    # differences since the last deployment must never be overwritten by a hook.
    for relative in paths:
        src, dst = source / relative, target / relative
        if src.is_symlink() or not src.is_file():
            raise RuntimeError('Unsupported source path: ' + relative)
        expected = manifest['files'].get(relative)
        current = digest(dst)
        wanted = digest(src)
        committed = hashlib.sha256(git('show', 'HEAD:' + relative)).hexdigest()
        if wanted != committed:
            raise RuntimeError('Source changed after review: ' + relative)
        hashes[relative] = wanted
        if dst.is_symlink() or (dst.exists() and current not in (expected, wanted)):
            raise RuntimeError('Installed work changed; refusing overwrite: ' + relative)
        if current != wanted:
            planned.append((relative, src, dst, current))
    if mode == 'check':
        print(json.dumps({'status': 'drift' if planned else 'matched',
                          'changed': [p[0] for p in planned]}))
        return 1 if planned else 0
    for relative, src, dst, previous in planned:
        if digest(dst) != previous or dst.is_symlink():
            raise RuntimeError('Installed file changed during deployment: ' + relative)
        atomic_write(dst, src.read_bytes(), src.stat().st_mode & 0o777)
    manifest.update(files=hashes, commit=git('rev-parse', 'HEAD').decode().strip())
    atomic_write(manifest_path, (json.dumps(manifest, indent=2)+'\n').encode(), 0o600)
    print(json.dumps({'status': 'deployed', 'files': len(planned), 'commit': manifest['commit']}))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (RuntimeError, subprocess.CalledProcessError, OSError, ValueError, KeyError) as error:
        print('tinky-vision-sync: ' + str(error), file=sys.stderr)
        sys.exit(1)
