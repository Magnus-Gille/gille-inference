import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildManifest, parseWorkflowJobs, runChecks, validateReceipt } from '../scripts/verify-local.mjs';

function workflowFixtureRoot(root = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-local-fixture-'))) {
  fs.mkdirSync(path.join(root, '.github/workflows'), { recursive: true });
  for (const file of ['ci.yml','cgroup-stop-proof.yml','code-health.yml','host-arbiter.yml','observer-test-host.yml','producer-activity.yml','producer-channel.yml','proxy-activity.yml','runtime-producer-channel.yml'])
    fs.copyFileSync(path.join(process.cwd(), `.github/workflows/${file}`), path.join(root, `.github/workflows/${file}`));
  return root;
}

describe('local verification manifest', () => {
  it('keeps a spaced job display name as one raw check name', () => {
    const jobs = parseWorkflowJobs(`name: Example Workflow\non:\n  pull_request:\njobs:\n  example:\n    name: Check with several words\n    runs-on: ubuntu-latest\n`);
    expect(jobs).toEqual([{ id: 'example', name: 'Check with several words' }]);
  });

  it('fails closed when a required job is missing', () => {
    const root = workflowFixtureRoot();
    try {
      const ciFile = path.join(root, '.github/workflows/ci.yml');
      fs.writeFileSync(ciFile, fs.readFileSync(ciFile, 'utf8').replace('  secret-scan:', '  removed-job:'));
      expect(() => buildManifest({ root, event: 'pull_request' })).toThrow(/job coverage changed/i);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('expands known workflow jobs for the event and marks CI-only proof unavailable', () => {
    const root = workflowFixtureRoot();
    try {
      const manifest = buildManifest({ root, event: 'pull_request' });
      expect(manifest.checks.map(({ workflowName, rawName }) => `${workflowName} / ${rawName}`)).toContain('CI / Gitleaks');
      expect(manifest.checks.find(({ rawName }) => rawName === 'cgroup-stop-proof')?.status).toBe('unavailable');
      expect(manifest.checks.find(({ workflowName }) => workflowName === 'Informational code health')?.status).toBe('conformance-only');
      expect(manifest.clientCompatibility).toEqual({ present: false, reason: 'workflow-absent-at-invoked-revision' });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('applies branch, schedule, dispatch and pull-request conditions explicitly', () => {
    const root = process.cwd();
    const main = buildManifest({ root, event: 'push', branch: 'main' });
    const aider = buildManifest({ root, event: 'push', branch: 'aider-eval/base' });
    const schedule = buildManifest({ root, event: 'schedule', schedule: '47 4 * * 1' });
    const dispatch = buildManifest({ root, event: 'workflow_dispatch', branch: 'main', collectStatic: true });
    expect(main.checks.find((check: any) => check.rawName === 'host-arbiter')?.appliesToInvocation).toBe(true);
    expect(aider.checks.find((check: any) => check.rawName === 'host-arbiter')?.appliesToInvocation).toBe(false);
    expect(aider.checks.find((check: any) => check.rawName === 'Gitleaks')?.appliesToInvocation).toBe(true);
    expect(schedule.checks.filter((check: any) => check.workflowName !== 'Informational code health').every((check: any) => !check.appliesToInvocation)).toBe(true);
    expect(schedule.checks.find((check: any) => check.workflowName === 'Informational code health')?.reason).toContain('CODE_HEALTH_COLLECTION_ENABLED');
    expect(dispatch.checks.find((check: any) => check.workflowName === 'Informational code health')?.appliesToInvocation).toBe(true);
    expect(dispatch.checks.find((check: any) => check.workflowName === 'Informational code health')?.reason).toContain('hosted-report');
    expect(dispatch.checks.filter((check: any) => check.appliesToInvocation).map((check: any) => check.workflowName)).toEqual(['Informational code health']);
    expect(() => buildManifest({ root, event: 'schedule', schedule: '0 0 * * *' })).toThrow(/unsupported schedule/i);
    expect(buildManifest({ root, event: 'schedule' }).checks.every((check: any) => !check.appliesToInvocation)).toBe(true);
  });

  it('adds both matrix check names when the future client workflow exists', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-local-client-'));
    try {
      fs.rmSync(root, { recursive: true, force: true });
      workflowFixtureRoot(root);
      fs.writeFileSync(path.join(root, '.github/workflows/client-compatibility.yml'), `name: Client compatibility\non:\n  push:\n    branches: [main]\n  pull_request:\njobs:\n  client:\n    name: Client Node \${{ matrix.node }}\n    strategy:\n      matrix:\n        node: [18, 22]\n`);
      const manifest = buildManifest({ root, event: 'pull_request' });
      expect(manifest.checks.map((check: any) => check.rawName)).toContain('Client Node 18');
      expect(manifest.checks.map((check: any) => check.rawName)).toContain('Client Node 22');
      expect(manifest.checks).toHaveLength(13);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('requires successful completed receipts from the matching workflow and supplied head', () => {
    const manifest = { checks: [{ workflowName: 'CI', rawName: 'test', status: 'required' }] };
    const base = { name: 'test', workflowName: 'CI', head_sha: 'a'.repeat(40), status: 'completed', conclusion: 'success' };
    expect(validateReceipt(manifest, { checkRuns: [base] }, 'a'.repeat(40)).valid).toBe(true);
    expect(validateReceipt(manifest, { checkRuns: [base, { ...base, status: 'in_progress', conclusion: null }] }, 'a'.repeat(40)).valid).toBe(false);
    expect(validateReceipt(manifest, { checkRuns: [] }, 'a'.repeat(40)).valid).toBe(false);
    expect(validateReceipt(manifest, { checkRuns: [{ ...base, workflowName: 'Other' }] }, 'a'.repeat(40)).valid).toBe(false);
    expect(validateReceipt(manifest, { checkRuns: [{ ...base, head_sha: 'b'.repeat(40) }] }, 'a'.repeat(40)).valid).toBe(false);
    for (const conclusion of ['failure', 'neutral', 'skipped', null]) {
      expect(validateReceipt(manifest, { checkRuns: [{ ...base, conclusion }] }, 'a'.repeat(40)).valid).toBe(false);
    }
    expect(validateReceipt(manifest, { checkRuns: [{ ...base, status: 'queued' }] }, 'a'.repeat(40)).valid).toBe(false);
  });

  it('records command failure and continues with subsequent exact checks', async ({ skip }) => {
    const { results } = await runChecks({
      commands: [
        { id: 'red', command: [process.execPath, '-e', "process.stdout.write('exit-seven-marker'); process.exit(7)"] },
        { id: 'green', command: [process.execPath, '-e', "process.stdout.write('exit-zero-marker'); process.exit(0)"] },
      ],
      cwd: process.cwd(),
      tempRoot: '/tmp',
      homeRoot: '/tmp',
      pathValue: '/usr/bin:/bin',
    });
    if (results.every((item: any) => item.error?.includes('EPERM'))) skip('sandbox denied child process creation');
    expect(results.map((item: any) => item.exitCode)).toEqual([7, 0]);
    expect(results.map((item: any) => item.status)).toEqual(['failed', 'passed']);
    expect(results.map((item: any) => item.stdout)).toEqual(['exit-seven-marker', 'exit-zero-marker']);
  });

  it('reports a missing executable as unavailable while keeping PATH explicit', async () => {
    const { results, environment } = await runChecks({
      commands: [{ id: 'missing-tool', command: ['missing-local-binary'] }],
      spawn: () => ({ status: null, signal: null, stdout: '', stderr: '', error: Object.assign(new Error('not found'), { code: 'ENOENT' }) }),
    });
    expect(results[0].status).toBe('unavailable');
    expect(results[0].exitCode).toBeNull();
    expect(environment.PATH).toBe(process.env.PATH);
  });
});
