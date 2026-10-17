#!/usr/bin/python3
"""Fixed SSH forced command for the dedicated, offline M5 build account.

No caller-controlled host command, host path, environment, network or image. The
container is untrusted: only its snapshot and per-repo caches are writable.
All stdout is version-1 NDJSON; infrastructure failures are distinct from tests.
"""
import base64
import contextlib
import fcntl
import io
import json
import os
from pathlib import Path, PurePosixPath
import pwd
import re
import selectors
import select
import shutil
import signal
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import uuid

MAX_ARCHIVE = 128 * 1024 * 1024
MAX_FILE = 16 * 1024 * 1024
MAX_PULL = 32 * 1024 * 1024
MAX_OUTPUT = 256 * 1024 * 1024
WALL_SECONDS = 1800
ROOT = Path('/var/lib/gille-build')
CONFIG = Path('/etc/gille-build.json')
USER = 'gille-build'
MINIMUM_FREE_BYTES = 1024 ** 3
WARNING_FREE_BYTES = 8 * 1024 ** 3
MAX_CAPACITY_VALUE = (1 << 53) - 1
MAX_FILESYSTEM_BYTES = 64 * 1024 ** 3


class BuildError(Exception):
    """Only static, content-free diagnostics may be emitted to the caller."""


def safe_path(value):
    if (not isinstance(value, str) or not value or len(value.encode('utf8')) > 4096
            or '\\' in value or '\0' in value or value.startswith('/')):
        raise BuildError('Unsafe build path; use a relative regular file.')
    parts = value.split('/')
    if any(p in ('', '.', '..') or p.lower().startswith('.env')
           or p.lower() in ('secrets', '.git') for p in parts):
        raise BuildError('Protected or unsafe build path refused.')
    return str(PurePosixPath(value))


def validate_request(value):
    if not isinstance(value, dict) or set(value) - {
        'version', 'repo_id', 'worktree_id', 'command', 'toolchain', 'pull', 'archive_bytes'
    }:
        raise BuildError('Invalid build protocol header.')
    if value.get('version') != 1 or isinstance(value.get('version'), bool):
        raise BuildError('Unsupported build protocol version.')
    for key in ('repo_id', 'worktree_id'):
        if not isinstance(value.get(key), str) or not re.fullmatch('[a-f0-9]{64}', value[key]):
            raise BuildError('Invalid build identity.')
    command = value.get('command')
    if (not isinstance(command, list) or not 1 <= len(command) <= 128
            or any(not isinstance(a, str) or '\0' in a or len(a.encode('utf8')) > 4096 for a in command)
            or not command[0]):
        raise BuildError('Build command must be a bounded argv array.')
    executable = command[0].split('/')[-1]
    if (executable in ('swift', 'xcrun', 'xcodebuild', 'codesign', 'productbuild', 'notarytool')
            or any('apple-darwin' in a for a in command)
            or (executable == 'cargo' and 'tauri' in command and 'build' in command)):
        raise BuildError('macOS-only job: run locally or on a GitHub macOS runner.')
    channel = value.get('toolchain')
    if channel is not None and (not isinstance(channel, str) or not re.fullmatch(r'(?:stable|[0-9]+\.[0-9]+(?:\.[0-9]+)?)', channel)):
        raise BuildError('Use a pinned numeric Rust toolchain or stable.')
    if channel is not None and executable != 'cargo':
        raise BuildError('Rust toolchain selection is only supported for cargo commands.')
    pulls = value.get('pull')
    if not isinstance(pulls, list) or len(pulls) > 32 or len(set(p for p in pulls if isinstance(p, str))) != len(pulls):
        raise BuildError('Invalid artifact selection.')
    for path in pulls:
        safe_path(path)
    length = value.get('archive_bytes')
    if type(length) is not int or not 0 < length <= MAX_ARCHIVE:
        raise BuildError('Snapshot exceeds the 128 MiB transfer limit.')
    return value


def read_request(stream, first_line=None):
    if first_line is None:
        first_line, value = read_header_line(stream)
    else:
        try:
            value = json.loads(first_line)
        except (ValueError, UnicodeError) as exc:
            raise BuildError('Invalid build header JSON.') from exc
    request = validate_request(value)
    payload = tempfile.TemporaryFile()
    try:
        remaining = request['archive_bytes']
        while remaining:
            block = stream.read(min(65536, remaining))
            if not block:
                raise BuildError('Truncated build snapshot.')
            payload.write(block)
            remaining -= len(block)
        if stream.read(1):
            raise BuildError('Unexpected bytes after build snapshot.')
        payload.seek(0)
        return request, payload
    except BaseException:
        payload.close()
        raise


def extract_snapshot(payload, destination):
    total = 0
    seen = set()
    try:
        with tarfile.open(fileobj=payload, mode='r:') as archive:
            for member in archive:
                path = safe_path(member.name)
                if path in seen or len(seen) >= 100000 or member.issparse():
                    raise BuildError('Duplicate, sparse or excessive snapshot members.')
                seen.add(path)
                if not member.isfile() or member.size < 0:
                    raise BuildError('Only regular files may enter a build snapshot.')
                total += member.size
                if total > MAX_ARCHIVE:
                    raise BuildError('Expanded snapshot exceeds its size limit.')
                target = destination / path
                target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                source = archive.extractfile(member)
                # destination is a NEW private directory, never an old/container-written tree.
                with source, open(target, 'xb') as output:
                    shutil.copyfileobj(source, output, length=65536)
                target.chmod(0o700 if member.mode & 0o111 else 0o600)
    except (tarfile.TarError, OSError, ValueError) as exc:
        raise BuildError('Invalid or conflicting snapshot archive.') from exc


def read_artifact(root, relative):
    parts = safe_path(relative).split('/')
    current = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in parts[:-1]:
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=current)
            os.close(current)
            current = next_fd
        fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=current)
        with os.fdopen(fd, 'rb') as source:
            before = os.fstat(source.fileno())
            if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > MAX_FILE:
                raise BuildError('Artifact must be a single-link regular file under 16 MiB.')
            data = source.read(MAX_FILE + 1)
            after = os.fstat(source.fileno())
            if len(data) > MAX_FILE or (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
                raise BuildError('Artifact changed during collection.')
            return data
    except OSError as exc:
        raise BuildError('Selected artifact missing or unsafe.') from exc
    finally:
        os.close(current)


@contextlib.contextmanager
def job_locks(state, identity):
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    handles = []
    try:
        handle = os.open(state / ('worktree-' + identity + '.lock'), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        handles.append(handle)
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise BuildError('This worktree already has a build; retry after it finishes.') from exc
        for index in range(3):
            slot = os.open(state / ('slot-' + str(index) + '.lock'), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
            try:
                fcntl.flock(slot, fcntl.LOCK_EX | fcntl.LOCK_NB)
                handles.append(slot)
                break
            except BlockingIOError:
                os.close(slot)
        else:
            raise BuildError('All three build slots are busy; retry later.')
        yield
    finally:
        for handle in reversed(handles):
            os.close(handle)


def private_directory(path):
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise BuildError('Build state ownership or permissions are unsafe.')
    return path


def validate_runtime_info(info):
    host = info.get('host', {}) if isinstance(info, dict) else {}
    if (host.get('security', {}).get('rootless') is not True
            or host.get('cgroupVersion') != 'v2' or host.get('cgroupManager') != 'systemd'):
        raise BuildError('Rootless Podman with systemd cgroup v2 is required; no unsafe fallback.')


def observe_capacity():
    usage = shutil.disk_usage(ROOT)
    values = (usage.total, usage.used, usage.free)
    if any(type(value) is not int or value < 0 or value > MAX_CAPACITY_VALUE for value in values):
        raise BuildError('Build filesystem capacity observation is invalid.')
    if usage.used > usage.total or usage.free > usage.total:
        raise BuildError('Build filesystem capacity observation is inconsistent.')
    return {
        'total_bytes': usage.total,
        'used_bytes': usage.used,
        'free_bytes': usage.free,
        'minimum_free_bytes': MINIMUM_FREE_BYTES,
        'warning_free_bytes': WARNING_FREE_BYTES,
        'observed_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
    }


def load_config(*, check_capacity=True, create_root=True):
    info = CONFIG.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
        raise BuildError('Build config must be root-owned and not group/world-writable.')
    value = json.loads(CONFIG.read_text())
    if (not isinstance(value, dict) or set(value) != {'version', 'image', 'podman'}
            or value['version'] != 1 or value['podman'] != '/usr/bin/podman'
            or not isinstance(value['image'], str)
            or not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9./:_-]*@sha256:[a-f0-9]{64}', value['image'])):
        raise BuildError('Use the closed version-1 config and an immutable builder image digest.')
    runtime = Path(value['podman']).stat()
    if runtime.st_uid != 0 or runtime.st_mode & 0o022:
        raise BuildError('Podman executable must be root-owned and not writable by the build account.')
    account = pwd.getpwnam(USER)
    if os.getuid() == 0 or os.getuid() != account.pw_uid or Path(account.pw_dir) != ROOT:
        raise BuildError('Worker must run only as the dedicated unprivileged build account.')
    if create_root:
        private_directory(ROOT)
    else:
        root_info = ROOT.lstat()
        if not stat.S_ISDIR(root_info.st_mode) or root_info.st_uid != account.pw_uid or root_info.st_mode & 0o077:
            raise BuildError('Build state ownership or permissions are unsafe.')
    if not os.path.ismount(ROOT):
        raise BuildError('Build home must be a separate capacity-bounded filesystem.')
    if check_capacity:
        capacity = observe_capacity()
        if capacity['total_bytes'] > MAX_FILESYSTEM_BYTES:
            raise BuildError('Build filesystem must be at most 64 GiB.')
        if capacity['free_bytes'] < MINIMUM_FREE_BYTES:
            raise BuildError('Build filesystem must be at most 64 GiB with at least 1 GiB free.')
    return value


def runtime_environment():
    # Deliberately do not inherit SSH/environment credentials, proxy vars, agent
    # sockets, providers, registry auth, or the operator/gateway home.
    uid = os.getuid()
    return {'PATH': '/usr/bin:/bin', 'HOME': str(ROOT), 'USER': USER,
            'LOGNAME': USER, 'LANG': 'C.UTF-8', 'XDG_RUNTIME_DIR': '/run/user/' + str(uid),
            'DBUS_SESSION_BUS_ADDRESS': 'unix:path=/run/user/' + str(uid) + '/bus'}


def container_command(config, repo, name, request):
    workspace = repo / 'worktrees' / request['worktree_id'] / 'source'
    target = repo / 'worktrees' / request['worktree_id'] / 'target'
    cache = repo / 'cache'
    command = list(request['command'])
    if request.get('toolchain'):
        if len(command) > 1 and command[1].startswith('+'):
            raise BuildError('Do not combine --toolchain with a cargo +toolchain argument.')
        command.insert(1, '+' + request['toolchain'])
    return [config['podman'], 'run', '--name', name, '--rm', '--pull=never', '--network=none',
            '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
            '--userns=keep-id', '--cpus=2', '--cpu-shares=128', '--memory=8g',
            '--memory-swap=8g', '--pids-limit=512', '--stop-timeout=5', '--timeout=1800',
            '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m', '--workdir=/workspace',
            '--mount', 'type=bind,src=' + str(workspace) + ',dst=/workspace,rw',
            '--mount', 'type=bind,src=' + str(target) + ',dst=/target,rw',
            '--mount', 'type=bind,src=' + str(cache) + ',dst=/cache,rw',
            '--env', 'HOME=/tmp/home', '--env', 'CARGO_HOME=/cache/cargo',
            '--env', 'CARGO_TARGET_DIR=/target', '--env', 'CARGO_NET_OFFLINE=true',
            '--env', 'RUSTUP_AUTO_INSTALL=0', '--env', 'RUSTC_WRAPPER=sccache',
            '--env', 'SCCACHE_DIR=/cache/sccache',
            '--env', 'SCCACHE_CACHE_SIZE=4G', '--env', 'npm_config_cache=/cache/npm',
            '--env', 'npm_config_offline=true', '--env', 'npm_config_audit=false',
            '--entrypoint', command[0], config['image'], *command[1:]]


def emit(kind, **fields):
    sys.stdout.write(json.dumps(dict(type=kind, **fields), separators=(',', ':')) + '\n')
    sys.stdout.flush()


def read_header_line(stream):
    line = stream.readline(8193)
    if len(line) > 8192 or not line.endswith(b'\n'):
        raise BuildError('Missing or oversized build header.')
    try:
        return line, json.loads(line)
    except (ValueError, UnicodeError) as exc:
        raise BuildError('Invalid build header JSON.') from exc


def read_status_request(stream, value):
    if (not isinstance(value, dict) or set(value) != {'version', 'operation'}
            or value.get('version') != 1 or isinstance(value.get('version'), bool)
            or value.get('operation') != 'status'):
        raise BuildError('Invalid status protocol request.')
    if stream.read(1):
        raise BuildError('Unexpected bytes after status request.')


def is_status_request(value):
    return isinstance(value, dict) and 'operation' in value


def stop_container(config, name, env):
    # Container name is server-generated, never a caller-supplied identifier.
    stopped = subprocess.run([config['podman'], 'rm', '--force', '--time=5', name],
                             env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20)
    if stopped.returncode:
        # Distinguish already-removed from unknown failure; never declare cleanup
        # success based on a failed mutation or quietly leave an unbounded job.
        exists = subprocess.run([config['podman'], 'container', 'exists', name],
                                env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
        if exists.returncode != 1:
            raise BuildError('Build container cleanup failed; operator intervention required.')


def client_gone():
    # A silent container must not wait until its next write to notice a dead
    # SSH channel. poll() reports a pipe writer's missing reader without writing.
    fd = sys.stdout.fileno()
    info = os.fstat(fd)
    if not (stat.S_ISFIFO(info.st_mode) or stat.S_ISSOCK(info.st_mode)):
        return False  # local/operator redirection; runtime timeout still applies
    channel = select.poll()
    channel.register(fd, select.POLLERR | select.POLLHUP)
    return bool(channel.poll(0))


def run_container(config, repo, request):
    env = runtime_environment()
    result = subprocess.run([config['podman'], 'info', '--format=json'], env=env,
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=15)
    if result.returncode or len(result.stdout) > 1024 * 1024:
        raise BuildError('Podman runtime unavailable; no local or privileged fallback.')
    try:
        validate_runtime_info(json.loads(result.stdout))
    except ValueError as exc:
        raise BuildError('Invalid Podman runtime evidence.') from exc
    name = 'm5-build-' + uuid.uuid4().hex
    started = time.monotonic()
    count = 0
    process = None
    try:
        process = subprocess.Popen(container_command(config, repo, name, request), env=env,
                                   stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   start_new_session=True)
        with selectors.DefaultSelector() as streams:
            streams.register(process.stdout, selectors.EVENT_READ, 'stdout')
            streams.register(process.stderr, selectors.EVENT_READ, 'stderr')
            while streams.get_map():
                if client_gone():
                    raise BuildError('Build SSH channel disconnected; cancelling its container.')
                if time.monotonic() - started >= WALL_SECONDS:
                    raise BuildError('Build exceeded the 30-minute wall limit.')
                for key, _ in streams.select(timeout=0.5):
                    block = os.read(key.fileobj.fileno(), 48 * 1024)
                    if not block:
                        streams.unregister(key.fileobj)
                        key.fileobj.close()
                        continue
                    count += len(block)
                    if count > MAX_OUTPUT:
                        raise BuildError('Build exceeded the 256 MiB output limit.')
                    emit(key.data, data=base64.b64encode(block).decode('ascii'))
        # Closing stdout/stderr does not prove the container/client has exited.
        # Continue polling the SSH channel even after both output pipes reach EOF.
        while process.poll() is None:
            if client_gone():
                raise BuildError('Build SSH channel disconnected; cancelling its container.')
            remaining = WALL_SECONDS - (time.monotonic() - started)
            if remaining <= 0:
                raise BuildError('Build exceeded the 30-minute wall limit.')
            try:
                process.wait(timeout=min(0.5, remaining))
            except subprocess.TimeoutExpired:
                continue
        code = process.wait(timeout=1)
        if code < 0 or code > 255:
            raise BuildError('Build runtime ended without a command exit status.')
        return code
    finally:
        # A forced SSH disconnect, stream write failure, timeout, or signal must
        # terminate the cgroup/container, not just its local podman client.
        if process is not None:
            try:
                # podman/conmon/container have independent lifetimes: a dead
                # client never proves that its container was removed.
                stop_container(config, name, env)
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait(timeout=10)
                for stream in (process.stdout, process.stderr):
                    if stream is not None:
                        stream.close()


def remove_tree(path):
    if path.is_symlink():
        path.unlink()
    elif path.exists():
        shutil.rmtree(path)


def cleanup_stale(state, age=14 * 86400, target_age=7 * 86400):
    """Reclaim idle targets after 7 days, whole trees after 14; keep caches/locks."""
    repos = state / 'repos'
    if not repos.exists():
        return
    now = time.time()
    for repo in repos.iterdir():
        if not re.fullmatch('[a-f0-9]{64}', repo.name) or repo.is_symlink():
            raise BuildError('Unexpected build repository state; cleanup refused.')
        trees = repo / 'worktrees'
        if not trees.exists():
            continue
        if trees.is_symlink():
            raise BuildError('Unsafe build worktree root; cleanup refused.')
        for tree in trees.iterdir():
            if not re.fullmatch('[a-f0-9]{64}', tree.name) or tree.is_symlink():
                raise BuildError('Unexpected build worktree state; cleanup refused.')
            stamp = tree / '.last-used'
            if not stamp.exists() or stamp.is_symlink() or now - stamp.stat().st_mtime < min(age, target_age):
                continue
            try:
                with job_locks(state / 'locks', tree.name):
                    idle = now - stamp.stat().st_mtime
                    if idle >= age:
                        remove_tree(tree)
                    elif idle >= target_age:
                        remove_tree(tree / 'target')
            except BuildError as exc:
                if str(exc) not in ('This worktree already has a build; retry after it finishes.',
                                    'All three build slots are busy; retry later.'):
                    raise


def execute(request, payload, config):
    state = private_directory(ROOT / 'state')
    cleanup_stale(state)
    with job_locks(state / 'locks', request['worktree_id']):
        repo = private_directory(private_directory(state / 'repos') / request['repo_id'])
        trees = private_directory(repo / 'worktrees')
        tree = private_directory(trees / request['worktree_id'])
        private_directory(tree / 'target')
        cache = private_directory(repo / 'cache')
        for name in ('cargo', 'npm', 'sccache'):
            private_directory(cache / name)
        staging = Path(tempfile.mkdtemp(prefix='.snapshot-', dir=tree))
        try:
            extract_snapshot(payload, staging)
            remove_tree(tree / 'source')
            staging.rename(tree / 'source')
            code = run_container(config, repo, request)
            # Container is stopped before inspecting outputs; fd-relative opens
            # still refuse links left by an untrusted build script.
            total = 0
            for path in request['pull']:
                data = read_artifact(tree / 'source', path)
                total += len(data)
                if total > MAX_PULL:
                    raise BuildError('Selected artifacts exceed the 32 MiB total limit.')
                if not data:
                    emit('artifact', path=path, data='')
                for offset in range(0, len(data), 48 * 1024):
                    emit('artifact', path=path, data=base64.b64encode(data[offset:offset+48*1024]).decode('ascii'))
            return code
        finally:
            remove_tree(staging)
            # stamp never resides inside container-writable source/target.
            stamp = tree / '.last-used'
            fd = os.open(stamp, os.O_CREAT | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
            os.close(fd)
            os.utime(stamp, None, follow_symlinks=False)


def main():
    os.umask(0o077)
    install_lock = None
    def interrupted(_signal, _frame):
        raise BuildError('Build session interrupted or expired.')
    for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT, signal.SIGALRM):
        signal.signal(sig, interrupted)
    signal.alarm(WALL_SECONDS + 60)
    try:
        install_lock = os.open('/run/gille-build/install.lock', os.O_RDONLY | os.O_NOFOLLOW)
        info = os.fstat(install_lock)
        if info.st_uid != 0 or info.st_mode & 0o022 or not stat.S_ISREG(info.st_mode):
            raise BuildError('Unsafe installation lock; provisioning refused.')
        try:
            fcntl.flock(install_lock, fcntl.LOCK_SH | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise BuildError('Build worker upgrade in progress; retry later.') from exc
        # SSH_ORIGINAL_COMMAND is NEVER evaluated. Only the root-owned timer may
        # select cleanup via the actual launcher's argv; ssh forced command has
        # no arguments irrespective of what the caller asked SSH to execute.
        if sys.argv[1:] == ['--cleanup']:
            config = load_config(check_capacity=False)
            capacity = observe_capacity()
            if capacity['total_bytes'] > MAX_FILESYSTEM_BYTES:
                raise BuildError('Build filesystem must be at most 64 GiB.')
            cleanup_stale(private_directory(ROOT / 'state'))
            return 0
        if sys.argv[1:]:
            raise BuildError('This worker accepts only its framed stdin protocol.')
        header_line, header = read_header_line(sys.stdin.buffer)
        if is_status_request(header):
            read_status_request(sys.stdin.buffer, header)
            load_config(check_capacity=False, create_root=False)
            capacity = observe_capacity()
            if capacity['total_bytes'] > MAX_FILESYSTEM_BYTES:
                raise BuildError('Build filesystem must be at most 64 GiB.')
            emit('capacity', **capacity)
            emit('exit', code=0)
            return 0
        config = load_config(check_capacity=False)
        capacity = observe_capacity()
        if capacity['total_bytes'] > MAX_FILESYSTEM_BYTES:
            raise BuildError('Build filesystem must be at most 64 GiB.')
        if capacity['free_bytes'] < MINIMUM_FREE_BYTES:
            emit('capacity', **capacity)
            emit('error', code=125, diagnostic_code='build_capacity_low', capacity=capacity)
            return 125
        request, payload = read_request(sys.stdin.buffer, first_line=header_line)
        with payload:
            code = execute(request, payload, config)
        emit('exit', code=code)
        return code
    except BuildError as exc:
        emit('error', message=str(exc), code=125)
        return 125
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as exc:
        # Preserve a content-free failure class, not stdout/stderr/path/env data.
        emit('error', message='Build infrastructure failure (' + type(exc).__name__ + '); check dedicated build provisioning.', code=125)
        return 125
    finally:
        if install_lock is not None:
            os.close(install_lock)


if __name__ == '__main__':
    sys.exit(main())
