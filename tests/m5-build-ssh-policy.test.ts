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

  // Found on the first real host run: the transport starts in the operator's login directory, the
  // build account cannot enter it, and rootless Podman then fails every check with a misleading
  // "preload the image" error. The installer must leave that directory before it runs anything as
  // the build identity, and must not read a failed container listing as "no containers".
  it('installer leaves the caller directory before running as the build identity, and fails closed', () => {
    const source = readFileSync(fileURLToPath(new URL('../scripts/install-m5-build.sh', import.meta.url)), 'utf8');
    const lines = source.split('\n');
    const cdRoot = lines.findIndex(line => line === 'cd /');
    const firstBuildIdentityUse = lines.findIndex(line => /^\s*(\[\[.*)?\$?\(?run_build |=\$\(run_build |^run_build /.test(line) && !line.startsWith('run_build()'));
    expect(cdRoot, 'installer must change to / at top level').toBeGreaterThan(-1);
    expect(firstBuildIdentityUse, 'installer must use run_build').toBeGreaterThan(-1);
    expect(cdRoot).toBeLessThan(firstBuildIdentityUse);
    // No sudo/cd dance inside run_build that could reintroduce a caller-relative directory.
    expect(source).not.toMatch(/runuser[^\n]*--login|runuser[^\n]* -l /);
    expect(source).toContain("containers=$(run_build /usr/bin/podman ps -q) || fail 'Cannot list build containers as the build identity.'");
    expect(source).not.toContain('[[ -z $(run_build /usr/bin/podman ps -q) ]]');
  });

  it('installer does not leave a rejected SSH drop-in installed and does not compare failed checksums', () => {
    const source = readFileSync(fileURLToPath(new URL('../scripts/install-m5-build.sh', import.meta.url)), 'utf8');
    // Both SSH validations restore the previous drop-in state before failing, and neither reloads.
    expect(source).toContain('/usr/sbin/sshd -t || { restore_ssh_dropin; fail ');
    expect(source).toMatch(/' \|\| \{ restore_ssh_dropin; fail 'Dedicated SSH restrictions not effective/);
    expect(source).toContain('else rm -f -- "$ssh_dropin"; fi');
    const reload = source.indexOf('systemctl reload ssh.service');
    expect(reload).toBeGreaterThan(source.indexOf("fail 'Dedicated SSH restrictions not effective"));
    // Checksums are captured separately with their own failure guards and a format check.
    expect(source).toContain("payload_sum=$(sha256sum \"$worker\" | cut -d' ' -f1) || fail 'Cannot hash the worker payload.'");
    expect(source).toContain('[[ $payload_sum =~ ^[0-9a-f]{64}$ && $payload_sum == "$installed_sum" ]]');
    expect(source).not.toMatch(/\[\[ \$\(sha256sum/);
  });
});
