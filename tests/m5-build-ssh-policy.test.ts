import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Real OpenSSH parser, but -G/-F /dev/null: no network, auth or personal config.
function inspectOptions(options: string[]) {
  const result = spawnSync('ssh', ['-G', '-F', '/dev/null', ...options, 'example.invalid'], { encoding: 'utf8' });
  expect(result.status, 'OpenSSH policy options must actually parse').toBe(0);
  return result.stdout.split('\n').filter(line => /^(forwardagent|clearallforwardings|sendenv) /.test(line));
}

describe('remote build SSH policy', () => {
  it('uses valid explicit no-forwarding/environment options in the build client', () => {
    const source = readFileSync(fileURLToPath(new URL('../client/m5-build.mjs', import.meta.url)), 'utf8');
    expect(source).toContain('"SendEnv=-*"');
    expect(source).not.toContain('"SendEnv="');
    const policy = inspectOptions(['-o', 'BatchMode=yes', '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes', '-o', 'SendEnv=-*']);
    expect(policy).toContain('forwardagent no'); expect(policy).toContain('clearallforwardings yes');
    expect(policy.some(line => line.startsWith('sendenv '))).toBe(false);
  });

  it('shares hardened SSH policy and a credential-free environment for both deploy paths', () => {
    const source = readFileSync(fileURLToPath(new URL('../scripts/deploy-m5-build.sh', import.meta.url)), 'utf8');
    expect(source).toContain('ForwardAgent=no'); expect(source).toContain('ClearAllForwardings=yes');
    expect(source).toContain("'SendEnv=-*'"); expect(source).toContain('for name in $(compgen -e)');
    expect(source).toContain('HOME|PATH|SSH_AUTH_SOCK|USER|LOGNAME');
    expect(source).toContain('run_ssh "sudo -n bash');
    expect(source).toContain('| run_ssh \\\n');
    expect((source.match(/ssh "\$\{ssh_args\[@\]\}"/g) ?? [])).toHaveLength(1);
  });
});
