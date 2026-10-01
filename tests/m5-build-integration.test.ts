import { describe, it, expect, afterEach } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, symlinkSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBuildArchive, loadBuildConfig, runBuild } from '../client/m5-build.mjs';

const dirs: string[] = [];
const project = fileURLToPath(new URL('../', import.meta.url));
function repo() {
  const root = mkdtempSync(join(tmpdir(), 'm5-contract-')); dirs.push(root);
  const git = (...args: string[]) => {
    const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
    if (result.status) throw new Error(result.stderr);
    return result.stdout;
  };
  git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  writeFileSync(join(root, 'tracked.txt'), 'tracked'); writeFileSync(join(root, 'deleted.txt'), 'deleted');
  git('add', '.'); git('commit', '-qm', 'seed'); rmSync(join(root, 'deleted.txt'));
  return { root, git };
}
function transport(state: string) {
  return (_file: string, _args: string[], options: any) => spawn('python3', ['-I',
    join(project, 'tests/fixtures/m5-build-ssh.py'), join(project, 'scripts/m5-build-worker.py'), state], options);
}
const command = ['npm', 'test', '--', '--profile', 'literal;$(no-shell)'];
const quiet = { write() { return true; } };
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));

describe('m5 build cross-language offline integration', () => {
  it('runs a Node job without a Rust pin, decodes full-size chunks, pulls reports and preserves exit 7', async () => {
    const { root } = repo(); const state = mkdtempSync(join(tmpdir(), 'm5-worker-')); dirs.push(state);
    const result = await runBuild({ cwd: root, command, pull: ['reports/test.txt'], config: { sshTarget: 'm5-build' },
      spawnImpl: transport(state), stdout: quiet, stderr: quiet, captureOutput: true, outputLimit: 1024 * 1024 });
    expect(result.exit_code).toBe(7);
    expect(result.stdout).toBe('S'.repeat(48 * 1024)); expect(result.stderr).toBe('E'.repeat(48 * 1024));
    expect(result.truncated).toEqual({ stdout: false, stderr: false });
    expect(readFileSync(join(root, 'reports/test.txt'), 'utf8')).toBe('report from remote');
  });

  it('bounds MCP captures while still draining full output', async () => {
    const { root } = repo(); const state = mkdtempSync(join(tmpdir(), 'm5-worker-')); dirs.push(state);
    const result = await runBuild({ cwd: root, command, config: { sshTarget: 'm5-build' },
      spawnImpl: transport(state), stdout: quiet, stderr: quiet, captureOutput: true, outputLimit: 10 });
    expect(result.stdout).toHaveLength(10); expect(result.stderr).toHaveLength(10);
    expect(result.truncated).toEqual({ stdout: true, stderr: true }); expect(result.exit_code).toBe(7);
  });

  it('ships the entire owning worktree even from a subdirectory, with deletions preserved', async () => {
    const { root } = repo(); mkdirSync(join(root, 'sub'));
    const a = await createBuildArchive(root); const b = await createBuildArchive(join(root, 'sub'));
    expect(a.archive.equals(b.archive)).toBe(true); expect(a.repoId).toBe(b.repoId); expect(a.worktreeId).toBe(b.worktreeId);
    expect(a.archive.includes(Buffer.from('deleted.txt'))).toBe(false);
  });

  it('refuses ignored tracked files, case-folded secret paths and hardlinks', async () => {
    for (const kind of ['ignored-tracked', 'secret', 'hardlink']) {
      const { root, git } = repo();
      if (kind === 'ignored-tracked') {
        writeFileSync(join(root, '.gitignore'), 'tracked.txt\n'); git('add', '.gitignore');
      } else if (kind === 'secret') writeFileSync(join(root, '.ENV.local'), 'not sent');
      else linkSync(join(root, 'tracked.txt'), join(root, 'hardlink.txt'));
      await expect(createBuildArchive(root)).rejects.toThrow(/refused|forbidden|links|ignored/i);
    }
  });

  it('never follows an ignored symlink or hardlink while pulling, and stages all artifacts before replacing any', async () => {
    for (const kind of ['symlink-parent', 'symlink-leaf', 'hardlink-leaf']) {
      const { root } = repo(); const outside = mkdtempSync(join(tmpdir(), 'm5-outside-')); dirs.push(outside);
      const state = mkdtempSync(join(tmpdir(), 'm5-worker-')); dirs.push(state);
      writeFileSync(join(root, '.gitignore'), 'reports/\n'); writeFileSync(join(outside, 'second.txt'), 'preserve');
      if (kind === 'symlink-parent') symlinkSync(outside, join(root, 'reports'));
      else {
        mkdirSync(join(root, 'reports')); writeFileSync(join(root, 'reports/test.txt'), 'original report');
        if (kind === 'symlink-leaf') symlinkSync(join(outside, 'second.txt'), join(root, 'reports/second.txt'));
        else linkSync(join(outside, 'second.txt'), join(root, 'reports/second.txt'));
      }
      await expect(runBuild({ cwd: root, command, pull: ['reports/test.txt', 'reports/second.txt'], config: { sshTarget: 'm5-build' },
        spawnImpl: transport(state), stdout: quiet, stderr: quiet })).rejects.toThrow(/unsafe|filesystem|NotADirectory|links/i);
      expect(readFileSync(join(outside, 'second.txt'), 'utf8')).toBe('preserve');
      if (kind !== 'symlink-parent') expect(readFileSync(join(root, 'reports/test.txt'), 'utf8')).toBe('original report');
    }
  });

  it('uses the default SSH alias only for a missing config, never for invalid config', async () => {
    const { root } = repo(); const config = join(root, 'build.json');
    expect(await loadBuildConfig(config, { allowDefault: true })).toEqual({ version: 1, sshTarget: 'm5-build' });
    writeFileSync(config, 'not JSON'); await expect(loadBuildConfig(config, { allowDefault: true })).rejects.toThrow(/JSON/);
  });

  it('keeps macOS checks local and rejects toolchain flags on Node jobs before SSH', async () => {
    const { root } = repo();
    await expect(runBuild({ cwd: root, command: ['swift', 'build'] })).rejects.toThrow(/macOS/);
    await expect(runBuild({ cwd: root, command: ['npm', 'test'], toolchain: '1.98.0', config: { sshTarget: 'm5-build' } })).rejects.toThrow(/only.*cargo/);
  });
});
