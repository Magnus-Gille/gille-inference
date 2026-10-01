#!/usr/bin/env python3
"""Local, credential-free dirfd filesystem helper for m5 build (Python 3.9+).

Node does not expose openat/renameat; path-based checks cannot close symlink
ancestor races. Every selected file/destination is opened relative to held dirfds.
Only the snapshot operation emits binary bytes; failures emit static diagnostics.
"""
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tarfile
import tempfile

MAX_ARCHIVE = 128 * 1024 * 1024
MAX_FILE = 16 * 1024 * 1024
MAX_PULL = 32 * 1024 * 1024
MAX_PATHS = 100000


class Refused(Exception):
    pass


def safe_path(path):
    if not isinstance(path, str) or not path or len(path.encode('utf8')) > 4096 or '\\' in path or '\0' in path:
        raise Refused('Unsafe build file path.')
    if any(p in ('', '.', '..') or p.lower().startswith('.env') or p.lower() in ('secrets', '.git') for p in path.split('/')):
        raise Refused('Build refused: forbidden or unsafe path.')
    return path


def git(cwd, argv, data=None, allowed=(0,)):
    # No credential environment, hooks, fsmonitor, alternate index, external diff,
    # or provider/SSH auth is inherited. These are local read-only Git operations.
    env = {'PATH': '/usr/bin:/bin:/opt/homebrew/bin', 'HOME': '/nonexistent',
           'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null',
           'GIT_TERMINAL_PROMPT': '0', 'LC_ALL': 'C'}
    result = subprocess.run(['git', '-c', 'core.fsmonitor=false', '-C', cwd, *argv],
                            input=data, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                            env=env, timeout=30)
    if result.returncode not in allowed or len(result.stdout) > 16 * 1024 * 1024:
        raise Refused('Could not inspect the local Git worktree safely.')
    return result.stdout


def relative_parent(root_fd, relative, create=False):
    parts = safe_path(relative).split('/')
    fd = os.dup(root_fd)
    try:
        for part in parts[:-1]:
            if create:
                try:
                    os.mkdir(part, mode=0o700, dir_fd=fd)
                except FileExistsError:
                    pass
            following = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = following
        return fd, parts[-1]
    except BaseException:
        os.close(fd)
        raise


def same_file(a, b):
    return (a.st_dev, a.st_ino, a.st_size, a.st_mtime_ns, a.st_ctime_ns) == (b.st_dev, b.st_ino, b.st_size, b.st_mtime_ns, b.st_ctime_ns)


def read_selected(root_fd, path):
    parent, leaf = relative_parent(root_fd, path)
    try:
        before = os.stat(leaf, dir_fd=parent, follow_symlinks=False)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > MAX_ARCHIVE:
            raise Refused('Build refused: links, hardlinks and special files are not allowed.')
        fd = os.open(leaf, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        with os.fdopen(fd, 'rb') as source:
            opened = os.fstat(source.fileno())
            if not same_file(before, opened):
                raise Refused('Build file changed during snapshot creation.')
            data = source.read(MAX_ARCHIVE + 1)
            after = os.fstat(source.fileno())
            if len(data) != opened.st_size or not same_file(opened, after):
                raise Refused('Build file changed during snapshot creation.')
            return data, opened.st_mode
    finally:
        os.close(parent)


def snapshot(request):
    cwd = os.path.realpath(request['cwd'])
    # Sending the entire owning worktree, also when invoked from a subdirectory.
    root = git(cwd, ['rev-parse', '--show-toplevel']).decode('utf8').strip()
    root = os.path.realpath(root)
    common = git(root, ['rev-parse', '--git-common-dir']).decode('utf8').strip()
    common = os.path.realpath(os.path.join(root, common))
    root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        paths = git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).decode('utf8').split('\0')
        paths = sorted(set(p for p in paths if p))
        if len(paths) > MAX_PATHS:
            raise Refused('Too many selected build files.')
        for path in paths:
            safe_path(path)
        for path in request.get('pull', []):
            safe_path(path)
        ignored = git(root, ['check-ignore', '--no-index', '-z', '--stdin'],
                      ('\0'.join(paths) + ('\0' if paths else '')).encode('utf8'), allowed=(0, 1))
        if ignored:
            raise Refused('Build refused: ignored tracked files are selected.')
        channel_file = None
        plain_toolchain = None
        with tempfile.TemporaryFile() as payload:
            with tarfile.open(fileobj=payload, mode='w', format=tarfile.USTAR_FORMAT) as archive:
                selected = 0
                for path in paths:
                    try:
                        data, mode = read_selected(root_fd, path)
                    except FileNotFoundError:
                        # A deleted tracked file must NOT reappear remotely.
                        continue
                    selected += ((len(data) + 511)//512)*512 + 512
                    if selected + 10240 > MAX_ARCHIVE:
                        raise Refused('Build snapshot exceeds the 128 MiB limit.')
                    member = tarfile.TarInfo(path)
                    member.mode = 0o700 if mode & 0o111 else 0o600
                    member.size = len(data)
                    archive.addfile(member, io.BytesIO(data))
                    if path in ('rust-toolchain.toml', 'rust-toolchain'):
                        if len(data) > 8192:
                            raise Refused('Oversized Rust toolchain file.')
                        if path.endswith('.toml'):
                            channel_file = data.decode('utf8')
                        else:
                            plain_toolchain = data.decode('utf8')
            size = payload.tell()
            if size > MAX_ARCHIVE:
                raise Refused('Build snapshot exceeds the 128 MiB limit.')
            meta = dict(root=root, repoId=hashlib.sha256(common.encode()).hexdigest(),
                        worktreeId=hashlib.sha256(root.encode()).hexdigest(),
                        toolchainFile=channel_file, plainToolchain=plain_toolchain)
            sys.stdout.buffer.write(json.dumps(meta).encode('utf8') + b'\n')
            payload.seek(0)
            while True:
                chunk = payload.read(65536)
                if not chunk:
                    break
                sys.stdout.buffer.write(chunk)
    finally:
        os.close(root_fd)


def pull(request):
    root_fd = os.open(request['root'], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    pending = []
    total = 0
    seen = set()
    try:
        # Validate all selections and stage every output before changing any leaf.
        for artifact in request['artifacts']:
            path = safe_path(artifact['path'])
            if path in seen:
                raise Refused('Duplicate build artifact.')
            seen.add(path)
            data = base64.b64decode(artifact['data'], validate=True)
            total += len(data)
            if len(data) > MAX_FILE or total > MAX_PULL:
                raise Refused('Build artifacts exceed their size limits.')
            parent, leaf = relative_parent(root_fd, path, create=True)
            try:
                try:
                    info = os.stat(leaf, dir_fd=parent, follow_symlinks=False)
                    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                        raise Refused('Refusing to replace an unsafe artifact destination.')
                except FileNotFoundError:
                    pass
                temp = '.m5-pull-' + os.urandom(16).hex()
                fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
                with os.fdopen(fd, 'wb') as output:
                    output.write(data)
                pending.append((parent, temp, leaf))
            except BaseException:
                os.close(parent)
                raise
        for parent, temp, leaf in pending:
            # renameat replaces a directory entry, never follows the destination
            # symlink or truncates a hardlinked file outside the owning worktree.
            os.replace(temp, leaf, src_dir_fd=parent, dst_dir_fd=parent)
    finally:
        for parent, temp, _ in pending:
            try:
                os.unlink(temp, dir_fd=parent)
            except FileNotFoundError:
                pass
            os.close(parent)
        os.close(root_fd)


def main():
    try:
        os.umask(0o077)
        limit = 48 * 1024 * 1024 if sys.argv[1:] == ['pull'] else 256 * 1024
        data = sys.stdin.buffer.read(limit + 1)
        if len(data) > limit:
            raise Refused('Local build helper input exceeds its bound.')
        request = json.loads(data)
        if sys.argv[1:] == ['snapshot']:
            snapshot(request)
        elif sys.argv[1:] == ['pull']:
            pull(request)
        else:
            raise Refused('Invalid local build helper operation.')
        return 0
    except Refused as exc:
        print(str(exc), file=sys.stderr)
        return 125
    except (OSError, ValueError, KeyError, subprocess.SubprocessError, tarfile.TarError) as exc:
        print('Local build filesystem operation failed (' + type(exc).__name__ + ').', file=sys.stderr)
        return 125


if __name__ == '__main__':
    sys.exit(main())
