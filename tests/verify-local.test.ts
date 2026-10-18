import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildManifest, parseWorkflowJobs, runChecks, validateReceipt } from '../scripts/verify-local.mjs';

function workflowFixtureRoot(root = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-local-fixture-'))) {
  fs.mkdirSync(path.join(root, '.github/workflows'), { recursive: true });
  for (const file of ['ci.yml','cgroup-stop-proof.yml','code-health.yml','code-loop-recovery.yml','dependency-compatibility.yml','host-arbiter.yml','observer-test-host.yml','producer-activity.yml','producer-channel.yml','proxy-activity.yml','portal-visual.yml','runtime-producer-channel.yml'])
    fs.copyFileSync(path.join(process.cwd(), `.github/workflows/${file}`), path.join(root, `.github/workflows/${file}`));
  return root;
}

const PUBLISHED_CLIENT_WORKFLOW = `name: Client compatibility

on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read

jobs:
  client:
    name: Client Node \${{ matrix.node }}
    runs-on: ubuntu-latest
    timeout-minutes: 10
    strategy:
      fail-fast: false
      matrix:
        node: [18, 22]
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: \${{ matrix.node }}
      - name: Verify packed client package
        run: node scripts/verify-client-package.mjs
      - name: Run dependency-free runtime fixtures
        run: node --test client/tests/runtime-compatibility.mjs
`;

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

  it.each(['code-loop-recovery.yml', 'portal-visual.yml'])('fails closed when the required %s workflow source is missing', file => {
    const root = workflowFixtureRoot();
    try {
      fs.rmSync(path.join(root, '.github/workflows', file));
      expect(() => buildManifest({ root, event: 'pull_request' })).toThrow(new RegExp(`required workflow is missing: ${file}`));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it.each([
    ['code-loop-recovery.yml', 'name: Native code-loop recovery', 'name: Renamed code-loop recovery', /workflow name changed/i],
    ['portal-visual.yml', 'name: Portal desktop and mobile states', 'name: Renamed portal visual check', /baseline workflow\/job\/raw-name mapping changed/i],
  ])('fails closed when %s has a mismatched required workflow source', (file, expected, changed, error) => {
    const root = workflowFixtureRoot();
    try {
      const workflowPath = path.join(root, '.github/workflows', file);
      fs.writeFileSync(workflowPath, fs.readFileSync(workflowPath, 'utf8').replace(expected, changed));
      expect(() => buildManifest({ root, event: 'pull_request' })).toThrow(error);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('expands known workflow jobs for the event and marks CI-only proof unavailable', () => {
    const root = workflowFixtureRoot();
    try {
      const manifest = buildManifest({ root, event: 'pull_request' });
      expect(manifest.checks.map(({ workflowName, rawName }) => `${workflowName} / ${rawName}`)).toContain('CI / Gitleaks');
      expect(manifest.checks.find(({ rawName }) => rawName === 'cgroup-stop-proof')?.status).toBe('unavailable');
      expect(manifest.checks.find(({ workflowName }) => workflowName === 'Informational code health')?.status).toBe('conformance-only');
      expect(manifest.checks.map(({ workflowName, rawName }) => `${workflowName} / ${rawName}`)).toContain('Native code-loop recovery / Real manager and cage recovery');
      expect(manifest.checks.map(({ workflowName, rawName }) => `${workflowName} / ${rawName}`)).toContain('Portal visual verification / Portal desktop and mobile states');
      expect(manifest.checks).toHaveLength(14);
      expect(manifest.clientCompatibility).toEqual({ present: false, reason: 'workflow-absent-at-invoked-revision' });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('covers the Vitest coverage compatibility workflow and its event conditions', () => {
    const root = workflowFixtureRoot();
    try {
      const manifest = buildManifest({ root, event: 'pull_request' });
      const coverage = manifest.checks.find((check: any) => check.workflowFile === 'dependency-compatibility.yml');
      expect(coverage).toMatchObject({
        workflowName: 'Dependency compatibility',
        jobId: 'vitest-coverage',
        rawName: 'Vitest coverage compatibility',
        eventConditions: { push: ['main'], pull_request: ['all branches'] },
        appliesToInvocation: true,
        status: 'unavailable',
      });
      expect(manifest.workflowSourcesValidated).toContainEqual({
        file: 'dependency-compatibility.yml',
        workflowName: 'Dependency compatibility',
      });

      const source = fs.readFileSync(path.join(root, '.github/workflows/dependency-compatibility.yml'), 'utf8');
      expect(source).toContain("node-version: '22'");
      expect(source).toContain('run: npm ci\n');
      expect(source).toContain('run: npm ci --prefix research/code-health-401/coverage-tooling --ignore-scripts');
      expect(source).toContain('name: Verify Vitest and coverage provider versions');
      expect(source).toContain('run: ./node_modules/.bin/vitest run --config research/code-health-401/vitest.coverage.config.mjs');

      const push = buildManifest({ root, event: 'push', branch: 'main' });
      const dispatch = buildManifest({ root, event: 'workflow_dispatch', branch: 'main' });
      expect(push.checks.find((check: any) => check.workflowFile === 'dependency-compatibility.yml')?.appliesToInvocation).toBe(true);
      expect(dispatch.checks.find((check: any) => check.workflowFile === 'dependency-compatibility.yml')?.appliesToInvocation).toBe(false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('fails closed for unknown dependency commands and workflow files', () => {
    const root = workflowFixtureRoot();
    try {
      const workflowPath = path.join(root, '.github/workflows/dependency-compatibility.yml');
      const source = fs.readFileSync(workflowPath, 'utf8');
      fs.writeFileSync(workflowPath, source.replace('run: npm ci --prefix research/code-health-401/coverage-tooling --ignore-scripts', 'run: npm install --prefix research/code-health-401/coverage-tooling'));
      expect(() => buildManifest({ root, event: 'pull_request' })).toThrow(/command coverage changed/i);

      fs.writeFileSync(workflowPath, source);
      fs.writeFileSync(path.join(root, '.github/workflows/unmapped.yml'), 'name: Unmapped\njobs:\n  check:\n    name: Unmapped\n');
      expect(() => buildManifest({ root, event: 'pull_request' })).toThrow(/workflow source has no manifest coverage/i);
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
      expect(manifest.checks.filter((check: any) => check.workflowFile === 'client-compatibility.yml').map((check: any) => check.rawName))
        .toEqual(['Client Node 18', 'Client Node 22']);
      expect(manifest.checks).toHaveLength(16);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('accepts the published client compatibility workflow shape', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-local-client-published-'));
    try {
      workflowFixtureRoot(root);
      fs.writeFileSync(path.join(root, '.github/workflows/client-compatibility.yml'), PUBLISHED_CLIENT_WORKFLOW);
      const manifest = buildManifest({ root, event: 'pull_request' });
      expect(manifest.checks.filter((check: any) => check.workflowFile === 'client-compatibility.yml').map((check: any) => check.rawName))
        .toEqual(['Client Node 18', 'Client Node 22']);
      expect(manifest.checks).toHaveLength(16);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('rejects client strategy flags outside the mapped fail-fast setting', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-local-client-strategy-'));
    try {
      workflowFixtureRoot(root);
      fs.writeFileSync(
        path.join(root, '.github/workflows/client-compatibility.yml'),
        PUBLISHED_CLIENT_WORKFLOW.replace('fail-fast: false', 'fail-fast: true'),
      );
      expect(() => buildManifest({ root, event: 'pull_request' })).toThrow(/matrix changed/i);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it.each([
    ['include case', 'node: [18, 22]\n        include:\n          - node: 20'],
    ['exclude rule', 'node: [18, 22]\n        exclude:\n          - node: 22'],
    ['additional dimension', 'node: [18, 22]\n        os: [ubuntu-latest]'],
    ['unsupported node', 'node: [18, 20, 22]'],
  ])('fails closed when the client matrix adds an unmapped %s', (_caseName, matrix) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-local-client-include-'));
    try {
      workflowFixtureRoot(root);
      fs.writeFileSync(path.join(root, '.github/workflows/client-compatibility.yml'), `name: Client compatibility\non:\n  push:\n    branches: [main]\n  pull_request:\njobs:\n  client:\n    name: Client Node \${{ matrix.node }}\n    strategy:\n      matrix:\n        ${matrix}\n`);
      expect(() => buildManifest({ root, event: 'pull_request' })).toThrow(/matrix changed/i);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it.each(['Client Node', 'Client Node ${{ matrix.runtime }}', 'Client Node ${{ matrix.node }} (compatibility)'])(
    'rejects unmapped client check display name %s', display => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-local-client-name-'));
      try {
        workflowFixtureRoot(root);
        fs.writeFileSync(path.join(root, '.github/workflows/client-compatibility.yml'), `name: Client compatibility\non:\n  push:\n    branches: [main]\n  pull_request:\njobs:\n  client:\n    name: ${display}\n    strategy:\n      matrix:\n        node: [18, 22]\n`);
        expect(() => buildManifest({ root, event: 'pull_request' })).toThrow(/display name changed/i);
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    }
  );

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

  it('requires successful receipts for both newly qualified PR checks', () => {
    const root = workflowFixtureRoot();
    try {
      const manifest = buildManifest({ root, event: 'pull_request' });
      const head = 'a'.repeat(40);
      const required = manifest.checks.filter((check: any) =>
        ['Real manager and cage recovery', 'Portal desktop and mobile states'].includes(check.rawName));
      expect(required).toHaveLength(2);
      expect(required.every((check: any) => check.appliesToInvocation === true)).toBe(true);
      const runs = required.map((check: any) => ({
        name: check.rawName, workflowName: check.workflowName, head_sha: head, status: 'completed', conclusion: 'success',
      }));
      expect(validateReceipt({ checks: required }, { checkRuns: runs }, head).valid).toBe(true);
      expect(validateReceipt({ checks: required }, { checkRuns: runs.slice(0, 1) }, head).valid).toBe(false);
      expect(validateReceipt({ checks: required }, { checkRuns: runs.map((run: any) =>
        run.name === 'Portal desktop and mobile states' ? { ...run, conclusion: 'failure' } : run) }, head).valid).toBe(false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('records command failure and continues with subsequent exact checks', async ({ skip }) => {
    const { results } = await runChecks({
      commands: [
        { id: 'red', command: [process.execPath, '-e', "process.stdout.write('exit-seven-marker'); process.exit(7)"] },
        { id: 'green', command: [process.execPath, '-e', "process.stdout.write('exit-zero-marker'); process.exit(0)"] },
      ],
      cwd: process.cwd(),
      tempRoot: os.tmpdir(),
      homeRoot: os.tmpdir(),
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
      tempRoot: os.tmpdir(),
      homeRoot: os.tmpdir(),
      spawn: () => ({ status: null, signal: null, stdout: '', stderr: '', error: Object.assign(new Error('not found'), { code: 'ENOENT' }) }),
    });
    expect(results[0].status).toBe('unavailable');
    expect(results[0].exitCode).toBeNull();
    expect(environment.PATH).toBe(process.env.PATH);
  });
});
