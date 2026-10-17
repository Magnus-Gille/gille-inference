#!/usr/bin/env python3
"""Disposable hosted-VM proof of the tracked OOMPolicy=continue contract.

This is a 64MiB CPU-memory cgroup test, not a host/GPU OOM or victim-order proof.
No production service, model, account, controller or template is installed.
"""
import json
import os
from pathlib import Path
import platform
import shutil
import signal
import subprocess
import sys
import time
import uuid


def cancel_fixture(_signum, _frame):
    raise RuntimeError('hosted fixture cancelled; unwind owned-unit cleanup')


def workload(output):
    sibling = os.fork()
    if sibling == 0:
        while True:
            (output / 'sibling').write_text(str(time.monotonic()))
            time.sleep(0.1)
    allocator = os.fork()
    if allocator == 0:
        while not (output / 'go').exists():
            time.sleep(0.02)
        blocks = []
        for _ in range(128):
            blocks.append(bytearray(1024 * 1024))
        os._exit(3)
    deadline = time.monotonic() + 12
    while time.monotonic() < deadline:
        waited, status = os.waitpid(allocator, os.WNOHANG)
        if waited:
            result = {'allocator_sigkill': os.WIFSIGNALED(status) and
                      os.WTERMSIG(status) == signal.SIGKILL,
                      'parent_pid': os.getpid(), 'sibling_pid': sibling}
            temporary = output / 'result.new'
            temporary.write_text(json.dumps(result))
            temporary.replace(output / 'result.json')
            break
        time.sleep(0.05)
    while True:
        time.sleep(0.2)


def command(args, check=True):
    return subprocess.run(args, check=check, capture_output=True, text=True,
                          env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C'},
                          timeout=10)


def events(cgroup):
    return dict((key, int(value)) for key, value in
                (line.split() for line in (cgroup / 'memory.events').read_text().splitlines()))


def fixture():
    assert platform.system() == 'Linux' and os.geteuid() == 0
    assert os.environ.get('GITHUB_ACTIONS') == 'true'
    assert os.environ.get('RUNNER_ENVIRONMENT') == 'github-hosted'
    assert Path('/sys/fs/cgroup/cgroup.controllers').is_file()
    available = next(int(line.split()[1]) for line in
                     Path('/proc/meminfo').read_text().splitlines()
                     if line.startswith('MemAvailable:'))
    assert available > 1024 * 1024, 'fixture needs >=1GiB spare host memory'
    template = Path(__file__).resolve().parents[2] / 'deploy/systemd/llama-swap-memory.conf'
    settings = {}
    for line in template.read_text().splitlines():
        if line.startswith(('OOMPolicy=', 'OOMScoreAdjust=')):
            key, value = line.split('=', 1)
            assert key not in settings
            settings[key] = value
    assert settings['OOMPolicy'] == 'continue'
    assert 800 <= int(settings['OOMScoreAdjust']) <= 1000
    name = 'gi-build-oom-' + uuid.uuid4().hex
    unit = name + '.service'
    root = Path('/run') / name
    root.mkdir(mode=0o755)
    output = root / 'output'
    output.mkdir(mode=0o700)
    os.chown(output, 65534, 65534)
    launcher = root / 'fixture.py'
    shutil.copyfile(__file__, launcher)
    launcher.chmod(0o644)
    cgroup = None
    try:
        command(['systemd-run', '--quiet', '--unit=' + unit, '--service-type=exec',
                 '--property=MemoryMax=67108864', '--property=MemorySwapMax=0',
                 '--property=OOMPolicy=' + settings['OOMPolicy'],
                 '--property=OOMScoreAdjust=' + settings['OOMScoreAdjust'],
                 '--property=RuntimeMaxSec=20', '--property=KillMode=control-group',
                 '--property=Restart=no', '--property=User=65534', '--property=Group=65534',
                 '--property=NoNewPrivileges=yes', '--property=ProtectSystem=strict',
                 '--property=ProtectHome=yes', '--property=PrivateTmp=yes',
                 '--property=RestrictAddressFamilies=AF_UNIX',
                 '--property=ReadWritePaths=' + str(output),
                 '/usr/bin/python3', str(launcher), '--workload', str(output)])
        cgpath = command(['systemctl', 'show', unit, '-p', 'ControlGroup', '--value']).stdout.strip()
        assert cgpath.startswith('/system.slice/' + name) and '..' not in cgpath
        cgroup = Path('/sys/fs/cgroup') / cgpath.lstrip('/')
        assert (cgroup / 'memory.max').read_text().strip() == '67108864'
        assert (cgroup / 'memory.swap.max').read_text().strip() == '0'
        assert (cgroup / 'memory.oom.group').read_text().strip() == '0'
        (output / 'go').touch(mode=0o644)
        deadline = time.monotonic() + 13
        while not (output / 'result.json').exists() and time.monotonic() < deadline:
            time.sleep(0.05)
        result = json.loads((output / 'result.json').read_text())
        assert result['allocator_sigkill'] is True
        assert events(cgroup)['oom_kill'] >= 1
        assert command(['systemctl', 'show', unit, '-p', 'ActiveState', '--value']).stdout.strip() == 'active'
        for key in ['parent_pid', 'sibling_pid']:
            os.kill(result[key], 0)
            assert str(result[key]) in (cgroup / 'cgroup.procs').read_text().splitlines()
        before = (output / 'sibling').stat().st_mtime_ns
        time.sleep(0.3)
        assert (output / 'sibling').stat().st_mtime_ns > before
        print(json.dumps({'proof': 'memcg_child_oom_parent_and_sibling_survive',
                          'memory_max': 67108864, 'memory_swap_max': 0,
                          'memory_oom_group': 0, 'oom_kill': events(cgroup)['oom_kill'],
                          'template_policy': settings['OOMPolicy'],
                          'scope': 'disposable_cpu_memory_only'}), flush=True)
    finally:
        # Only this unique fixture unit is addressed, including a failed start.
        command(['systemctl', 'stop', unit], check=False)
        state = command(['systemctl', 'show', unit, '-p', 'ActiveState', '--value'], check=False).stdout.strip()
        assert state in {'inactive', 'failed', ''}, 'owned unit did not stop'
        if cgroup is not None and cgroup.exists():
            assert dict(line.split() for line in (cgroup / 'cgroup.events').read_text().splitlines())['populated'] == '0'
        command(['systemctl', 'reset-failed', unit], check=False)
        shutil.rmtree(root)
        print(json.dumps({'cleanup_complete': True, 'owned_unit': unit}), flush=True)


def main():
    if len(sys.argv) == 3 and sys.argv[1] == '--workload':
        workload(Path(sys.argv[2]))
    else:
        signal.signal(signal.SIGTERM, cancel_fixture)
        fixture()


if __name__ == '__main__':
    main()
