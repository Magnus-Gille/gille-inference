"""Pure candidate-only execution planner. It deliberately has no execution API."""
import argparse
import hashlib
import json
import re
from datetime import datetime, timezone

SHA = re.compile(r'[0-9a-f]{64}\Z')
IMAGE = re.compile(r'[a-z0-9][a-z0-9./:_-]*@sha256:[0-9a-f]{64}\Z')
KEYS = {'version', 'run_id', 'image', 'source_sha256', 'runner_sha256',
        'verifier_sha256', 'pi_version', 'harness_sha', 'model', 'effort',
        'provider', 'auth', 'expires_at', 'limits'}
LIMITS = {'memory_mib', 'workspace_mib', 'tmp_mib', 'pids', 'cpus', 'seconds'}


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False)


def validate(value, now=None):
    if not isinstance(value, dict) or set(value) != KEYS or type(value['version']) is not int or value['version'] != 1:
        raise ValueError('closed version-1 declaration required')
    if not isinstance(value['run_id'], str) or not re.fullmatch(r'[a-f0-9]{32}', value['run_id']):
        raise ValueError('run_id must be a fresh 128-bit hexadecimal identifier')
    for key in ('source_sha256', 'runner_sha256', 'verifier_sha256'):
        if not isinstance(value[key], str) or not SHA.fullmatch(value[key]):
            raise ValueError('immutable content hash required: ' + key)
    if (not isinstance(value['image'], str) or not IMAGE.fullmatch(value['image'])
            or '/' not in value['image'].split('@')[0]
            or not ('.' in value['image'].split('/')[0] or ':' in value['image'].split('/')[0])):
        raise ValueError('fully qualified immutable image required')
    if not isinstance(value['harness_sha'], str) or not re.fullmatch(r'[0-9a-f]{40}', value['harness_sha']):
        raise ValueError('exact harness source commit required')
    if not isinstance(value['pi_version'], str) or not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', value['pi_version']):
        raise ValueError('exact Pi version required')
    if value['provider'] != 'openai' or value['auth'] != 'subscription-oauth' or value['effort'] != 'high':
        raise ValueError('OpenAI subscription/high is mandatory')
    if not isinstance(value['model'], str) or not re.fullmatch(r'gpt-[0-9]+\.[0-9]+-sol', value['model']):
        raise ValueError('exact catalog-verified Sol model required; aliases forbidden')
    limits = value['limits']
    if not isinstance(limits, dict) or set(limits) != LIMITS:
        raise ValueError('closed resource limits required')
    bounds = {'memory_mib': (512, 8192), 'workspace_mib': (64, 4096),
              'tmp_mib': (32, 512), 'pids': (16, 512), 'cpus': (1, 2), 'seconds': (30, 10800)}
    for key, (low, high) in bounds.items():
        if type(limits[key]) is not int or not low <= limits[key] <= high:
            raise ValueError('invalid resource limit: ' + key)
    if limits['workspace_mib'] + limits['tmp_mib'] >= limits['memory_mib']:
        raise ValueError('tmpfs ceilings must leave memory for processes')
    try:
        expiry = datetime.fromisoformat(value['expires_at'].replace('Z', '+00:00'))
    except (ValueError, AttributeError, TypeError) as exc:
        raise ValueError('UTC expiry required') from exc
    if expiry.utcoffset() is None or expiry.utcoffset().total_seconds() != 0:
        raise ValueError('UTC expiry required')
    now = now or datetime.now(timezone.utc)
    remaining = (expiry - now).total_seconds()
    if not 0 < remaining <= 86400:
        raise ValueError('expiry must be within the next 24 hours')
    if remaining < limits['seconds'] + 30:
        raise ValueError('expiry must cover runtime plus 30 seconds cleanup')
    return value


def plan(value, now=None):
    value = validate(value, now)
    v = value['limits']
    name = 'harness2-eval-' + value['run_id']
    # No candidate command, env, mount or executable is supplied by model output.
    # The actual command broker and lifecycle verifier are separate trusted code.
    podman = ['/usr/bin/podman', 'run', '--rm', '--name=' + name, '--pull=never',
              '--network=none', '--http-proxy=false', '--image-volume=ignore',
              '--read-only', '--cap-drop=ALL',
              '--security-opt=no-new-privileges', '--user=65534:65534',
              '--pid=private', '--ipc=private', '--cgroups=enabled',
              '--cpus=' + str(v['cpus']), '--memory=' + str(v['memory_mib']) + 'm',
              '--memory-swap=' + str(v['memory_mib']) + 'm',
              '--pids-limit=' + str(v['pids']), '--stop-timeout=5',
              '--timeout=' + str(v['seconds']), '--log-driver=none',
              '--tmpfs=/work:rw,nosuid,nodev,mode=0700,uid=65534,gid=65534,size=' + str(v['workspace_mib']) + 'm',
              '--tmpfs=/tmp:rw,nosuid,nodev,mode=1777,size=' + str(v['tmp_mib']) + 'm',
              '--workdir=/work', '--env=HOME=/work/home', '--env=PATH=/usr/bin:/bin',
              '--env=LANG=C.UTF-8', '--env=GIT_CONFIG_NOSYSTEM=1',
              '--env=GIT_CONFIG_GLOBAL=/dev/null', '--env=GIT_TERMINAL_PROMPT=0',
              '--env=PYTHONNOUSERSITE=1', '--env=PYTHONDONTWRITEBYTECODE=1',
              '--entrypoint=/usr/bin/sleep', value['image'], 'infinity']
    # This foreground process is a bounded, owned container lifecycle. An operator
    # must still inspect effective OCI/cgroup state; argv is not proof of isolation.
    systemd = ['/usr/bin/systemd-run', '--user', '--wait', '--pipe',
               '--quiet', '--service-type=exec', '--expand-environment=no',
               '--unit=' + name, '-p', 'MemoryMax=' + str(v['memory_mib']) + 'M',
               '-p', 'MemorySwapMax=0', '-p', 'TasksMax=' + str(v['pids']),
               '-p', 'CPUQuota=' + str(v['cpus'] * 100) + '%', '-p', 'CPUWeight=25',
               '-p', 'RuntimeMaxSec=' + str(v['seconds']), '-p', 'TimeoutStopSec=10',
               '-p', 'KillMode=control-group', '-p', 'OOMPolicy=kill', '--']
    return {'schema': 'harness2-candidate-plan/1', 'status': 'planned-not-qualified',
            'declaration_sha256': hashlib.sha256(canonical(value).encode()).hexdigest(),
            'declaration': value, 'unit': name + '.service', 'container': name,
            'argv': systemd + podman,
            'requires': ['owner-approved host envelope', 'isolated rootless Podman account',
                         'preloaded approved image and verified image environment',
                         'trusted Pi tool bridge; no native candidate tools',
                         'bounded seed/harvest with symlink and special-file rejection',
                         'effective cgroup/OCI and negative boundary proofs',
                         'protected-service baseline and OOM/restoration checks',
                         'native OAuth qualification outside candidate namespace'],
            'cleanup': {'unit_stop': ['/usr/bin/systemctl', '--user', 'stop', name + '.service'],
                        'container_stop': ['/usr/bin/podman', 'stop', '--time=5', name],
                        'verify_absent': ['/usr/bin/podman', 'container', 'exists', name],
                        'require_empty_cgroup': True, 'automatic_retry': False},
            'contains_credentials': False, 'execution_authorized': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('declaration')
    args = parser.parse_args()
    try:
        with open(args.declaration, encoding='utf-8') as stream:
            value = json.load(stream)
        print(json.dumps(plan(value), indent=2))
    except (ValueError, OSError) as exc:
        parser.exit(2, 'Rejected: ' + str(exc) + '\n')


if __name__ == '__main__':
    main()
