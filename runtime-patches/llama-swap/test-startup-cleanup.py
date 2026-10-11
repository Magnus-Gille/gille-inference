#!/usr/bin/env python3
"""Exercise the built candidate's fatal-listener cleanup in disposable Linux CI only."""
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile

if (os.environ.get('GITHUB_ACTIONS') != 'true' or
        os.environ.get('RUNNER_ENVIRONMENT') != 'github-hosted' or os.geteuid() != 0):
    raise SystemExit('refusing: disposable GitHub-hosted root fixture required')
if len(sys.argv) not in (2, 3) or (len(sys.argv) == 3 and sys.argv[2] != '--expect-stale'):
    raise SystemExit('invalid fixture arguments')
binary = Path(sys.argv[1])
if not binary.is_absolute() or not binary.is_file() or binary.is_symlink():
    raise SystemExit('invalid candidate binary')
expect_stale = len(sys.argv) == 3
runtime = Path('/run/llama-swap-observer')
# Never adopt or remove a pre-existing directory/socket.
runtime.mkdir(mode=0o755)
socket = runtime / 'activity.sock'
try:
    with tempfile.TemporaryDirectory(prefix='gi-proxy-startup-') as scratch:
        config = Path(scratch) / 'config.yaml'
        config.write_text('logToStdout: proxy\nmodels:\n  fixture:\n    cmd: /usr/bin/false\n')
        for _ in range(1 if expect_stale else 2):
            result = subprocess.run([str(binary), '-config', str(config),
                '-install-observer-uid', str(os.geteuid()), '-listen', 'invalid-listen-address'],
                cwd=scratch, capture_output=True, timeout=15, check=False)
            output = result.stdout + result.stderr
            if result.returncode != 1 or b'http server error' not in output:
                # Only this credential-free synthetic fixture's bounded output.
                print(output[-4096:].decode('utf-8', errors='replace'), file=sys.stderr)
                raise SystemExit('fixture did not reach the intended post-observer listener failure')
            exists = socket.exists() or socket.is_symlink()
            if expect_stale:
                if not exists or not stat.S_ISSOCK(socket.lstat().st_mode):
                    raise SystemExit('uninstrumented cleanup mutation did not expose stale socket')
                print('red: missing exit cleanup leaves owned socket')
            elif exists:
                raise SystemExit('fatal startup left stale observer socket')
        if not expect_stale:
            print('pass: two fatal startup attempts each clean the owned observer socket')
finally:
    # Only this fixture's newly created directory is owned. Never recursively remove.
    if socket.exists() or socket.is_symlink():
        if not stat.S_ISSOCK(socket.lstat().st_mode):
            raise SystemExit('unexpected fixture path replacement; cleanup refused')
        socket.unlink()
    runtime.rmdir()
