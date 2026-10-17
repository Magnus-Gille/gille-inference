import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import {
  analyzerStatus,
  assertToolVersion,
  buildCohortRuns,
  codeHealthSnapshotId,
  countFunctionNodes,
  eslintInventoryComplete,
  mapJobConclusion,
  normalizeCoverageSummary,
  normalizeKnipRows,
  parseEslintReport,
  reliabilityCounts,
  summarizeComplexity,
  summarizeCoverage,
  unclassifiableKnownFailures,
} from './lib/core.mjs';
import {
  buildFirstAttemptEvidence,
  enumerateWorkflowRuns,
  fetchJsonWithRetry,
  getFirstAttempt,
} from './lib/ci.mjs';
import {
  checkVendorContract,
  collect,
  collectCi,
  collectWithFallback,
  gitWorkflowDigests,
  inferTriage,
  newCollectionRef,
  parseKnipReport,
  reportMarkdown,
  runConcurrentStaticCollectors,
  runConcurrentStaticAndCiCollectors,
  runProcess,
} from './collect.mjs';
import { validateObjective } from '../../contracts/grimnir-code-health-v1/scripts/lib/code-health-objective.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CONTRACT_ROOT = path.join(ROOT, 'contracts/grimnir-code-health-v1');
const DIGEST = 'a'.repeat(64);
const makeRun = (id, overrides = {}) => ({
  id,
  event: 'push',
  head_branch: 'main',
  head_sha: 'b'.repeat(40),
  created_at: '2026-09-20T10:00:00Z',
  run_attempt: 1,
  status: 'completed',
  conclusion: 'success',
  path: '.github/workflows/ci.yml@refs/heads/main',
  repository: { full_name: 'Magnus-Gille/gille-inference' },
  ...overrides,
});
const response = value => ({ ok: true, status: 200, json: async () => value });

test('snapshot identity is stable for replay and distinct for runs, attempts, and full commit SHAs', () => {
  const identity = {
    repository: { owner: 'Magnus-Gille', name: 'gille-inference' },
    commit: 'a'.repeat(40),
    collectionRef: 'ref:collection-gha-7021-attempt-1',
    attempt: 1,
  };
  const first = codeHealthSnapshotId(identity);
  assert.equal(codeHealthSnapshotId(identity), first);
  assert.notEqual(codeHealthSnapshotId({ ...identity, collectionRef: 'ref:collection-gha-7022-attempt-1' }), first);
  assert.notEqual(codeHealthSnapshotId({ ...identity, collectionRef: 'ref:collection-gha-7021-attempt-2', attempt: 2 }), first);
  assert.notEqual(codeHealthSnapshotId({ ...identity, commit: 'a'.repeat(12) + 'b'.repeat(28) }), first);
});

test('collection references are stable for GitHub artifacts and unique for local invocations', () => {
  assert.equal(newCollectionRef({ runId: '7021', attempt: 2 }), newCollectionRef({ runId: '7021', attempt: 2 }));
  const first = newCollectionRef({ runId: null, attempt: 1 });
  const second = newCollectionRef({ runId: null, attempt: 1 });
  assert.match(first, /^ref:collection-local-[0-9a-f-]+-attempt-1$/);
  assert.notEqual(first, second);
});

async function listFiles(directory, prefix = '') {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...await listFiles(path.join(directory, entry.name), relative));
    else result.push(relative);
  }
  return result;
}

test('vendored contract provenance pins the frozen revision and every copied file', async () => {
  const provenance = await checkVendorContract();
  assert.equal(provenance.source_revision, '7df005ce952a52816597d9888da977d689a631fd');
  assert.equal(provenance.source_repository, 'Magnus-Gille/grimnir');
  assert.equal(provenance.files.length, 10);
  for (const item of provenance.files) assert.match(item.sha256, /^[a-f0-9]{64}$/);

  const temp = await mkdtemp(path.join(os.tmpdir(), 'code-health-vendor-'));
  try {
    await cp(CONTRACT_ROOT, temp, { recursive: true });
    const firstFile = path.join(temp, provenance.files[0].path);
    await writeFile(firstFile, `${await readFile(firstFile, 'utf8')}\n`);
    await assert.rejects(checkVendorContract(temp), /vendored contract file hash mismatch/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('empty, failing, malformed, and truncated analyzer outputs never imply a zero measurement', () => {
  assert.deepEqual(parseEslintReport('[]').complexityWarnings, []);
  assert.equal(eslintInventoryComplete([], ['src/a.ts'], ROOT), false, 'empty report cannot stand in for an eligible-file inventory');
  assert.equal(analyzerStatus({ exitCode: 0, parsed: true }), 'complete');
  assert.equal(analyzerStatus({ exitCode: 2, parsed: true }), 'failed');
  assert.equal(analyzerStatus({ exitCode: 0, parsed: false }), 'failed');
  assert.equal(analyzerStatus({ exitCode: 0, parsed: true, truncated: true }), 'failed');
  assert.throws(() => parseEslintReport('{malformed'), SyntaxError);
  assert.throws(() => parseEslintReport('[{"filePath":"src/a.ts"}]'), /invalid file report/);
  assert.deepEqual(normalizeKnipRows({ files: [], issues: [] }), []);
  assert.throws(() => normalizeKnipRows({ summary: {} }), /no recognized issue groups/);
  assert.throws(() => normalizeKnipRows({ meta: {} }), /no recognized issue groups/);
  assert.throws(() => normalizeKnipRows({ files: [] }), /requires both files and issues arrays/);
  assert.throws(() => normalizeKnipRows({ unrecognized: [] }), /unknown issue group/);
  assert.throws(() => normalizeKnipRows({ files: [], issues: [{ file: 'src/a.ts', mysteries: [] }] }), /unknown kind/);
});

test('Knip qualification requires a complete bounded report and accepts a valid empty report', () => {
  const empty = parseKnipReport(JSON.stringify({ files: [], issues: [] }));
  assert.deepEqual(empty.rows, []);
  assert.equal(empty.parseError, null);
  for (const malformed of [{ summary: {} }, { meta: {} }, { files: [] }, { exports: [] }]) {
    const result = parseKnipReport(JSON.stringify(malformed));
    assert.equal(result.rows, null);
    assert.match(result.parseError, /Knip report requires complete files and issues arrays/);
  }
  const oversized = parseKnipReport(JSON.stringify({
    files: Array.from({ length: 5001 }, (_, index) => `src/unused-${index}.ts`),
    issues: [],
  }));
  assert.equal(oversized.rows, null);
  assert.match(oversized.parseError, /exceeds the 5,000-row artifact bound/);
});

test('tool provenance accepts only an installed version matching its declared pin', () => {
  assert.equal(assertToolVersion('knip', '5.46.0', '5.46.0'), '5.46.0');
  assert.throws(() => assertToolVersion('knip', '5.46.0', '5.47.0'), /installed version mismatch/);
  assert.throws(() => assertToolVersion('vitest', '3.2.7', null), /version is unavailable/);
});

test('Knip file-inventory and grouped-issues output preserves source-linked candidate context', () => {
  const report = {
    files: ['src/unused.ts'],
    issues: [
      { file: 'src/a.ts', owners: ['team-alpha'], dependencies: [], devDependencies: [],
        exports: [{ name: 'unusedExport', line: 12 }], nsExports: [{ name: 'unusedNamespace', line: 13 }],
        nsTypes: [{ name: 'UnusedType', line: 14 }],
        enumMembers: { Direction: [{ name: 'North', line: 15 }] },
        classMembers: { Service: [{ name: 'unusedMethod', line: 16 }] },
        duplicates: [[{ name: 'copyOne' }, { name: 'copyTwo' }]],
      },
      { file: 'src/b.ts', dependencies: [], exports: [] },
    ],
  };
  const rows = normalizeKnipRows(report);
  assert.deepEqual(rows.map(({ kind, file, name, line, parent_symbol }) => ({ kind, file, name, line, parent_symbol })), [
    { kind: 'files', file: 'src/unused.ts', name: null, line: null, parent_symbol: null },
    { kind: 'exports', file: 'src/a.ts', name: 'unusedExport', line: 12, parent_symbol: null },
    { kind: 'nsExports', file: 'src/a.ts', name: 'unusedNamespace', line: 13, parent_symbol: null },
    { kind: 'nsTypes', file: 'src/a.ts', name: 'UnusedType', line: 14, parent_symbol: null },
    { kind: 'enumMembers', file: 'src/a.ts', name: 'North', line: 15, parent_symbol: 'Direction' },
    { kind: 'classMembers', file: 'src/a.ts', name: 'unusedMethod', line: 16, parent_symbol: 'Service' },
    { kind: 'duplicates', file: 'src/a.ts', name: 'copyOne', line: null, parent_symbol: null },
    { kind: 'duplicates', file: 'src/a.ts', name: 'copyTwo', line: null, parent_symbol: null },
  ]);
  assert.deepEqual(rows[1].owners, ['team-alpha']);
  assert.throws(() => normalizeKnipRows({ files: ['src/a.ts'], issues: [{ file: 'src/a.ts', mysteries: [] }] }), /unknown kind/);
});

test('TypeScript parser handles generic arrow functions as TypeScript rather than JSX', async t => {
  const parserPath = path.join(ROOT, 'research/code-health-401/tooling/node_modules/@typescript-eslint/parser/dist/index.js');
  let parserModule;
  try { parserModule = await import(pathToFileURL(parserPath)); }
  catch { t.skip('pinned parser dependency is not installed in this environment'); return; }
  const parser = parserModule.default ?? parserModule;
  const ast = parser.parse('const identity = <T>(value: T): T => value;', {
    ecmaVersion: 2022, sourceType: 'module', loc: true, range: true,
    jsx: false, filePath: 'src/generic-fixture.ts',
    errorOnTypeScriptSyntacticAndSemanticIssues: false,
  });
  assert.equal(countFunctionNodes(ast), 1);
});

test('a missing analyzer executable is recorded as a bounded failed process', async () => {
  const missing = await runProcess('/__code-health-402-missing__/analyzer', []);
  assert.equal(missing.exitCode, 127);
  assert.equal(missing.errorName, 'ENOENT');
  assert.equal(missing.stdout, '');
  assert.equal(missing.timedOut, false);
});

test('static collectors start together and preserve the complexity/unused result order', async () => {
  let complexityResolve;
  let unusedResolve;
  const started = [];
  const complexity = new Promise(resolve => { complexityResolve = resolve; });
  const unused = new Promise(resolve => { unusedResolve = resolve; });
  const pending = runConcurrentStaticCollectors(
    async () => { started.push('complexity'); return complexity; },
    async () => { started.push('unused'); return unused; },
  );
  await new Promise(resolve => queueMicrotask(resolve));
  assert.deepEqual(started, ['complexity', 'unused']);
  complexityResolve({ slot: { name: 'complex_functions' }, elapsedMs: 10, status: 'measured' });
  unusedResolve({ slot: { name: 'unused_candidates' }, elapsedMs: 11, status: 'unknown' });
  assert.deepEqual(await pending, [
    { slot: { name: 'complex_functions' }, elapsedMs: 10, status: 'measured' },
    { slot: { name: 'unused_candidates' }, elapsedMs: 11, status: 'unknown' },
  ]);
});

test('CI metadata starts before blocked static collectors complete and result order stays stable', async () => {
  let complexityResolve;
  let unusedResolve;
  const started = [];
  const complexity = new Promise(resolve => { complexityResolve = resolve; });
  const unused = new Promise(resolve => { unusedResolve = resolve; });
  const pending = runConcurrentStaticAndCiCollectors(
    async () => { started.push('complexity'); return complexity; },
    async () => { started.push('unused'); return unused; },
    async () => { started.push('ci'); return { status: 'measured', elapsedMs: 7 }; },
  );
  await new Promise(resolve => queueMicrotask(resolve));
  assert.deepEqual(started, ['complexity', 'unused', 'ci']);
  complexityResolve({ slot: { name: 'complex_functions' }, elapsedMs: 10, status: 'measured' });
  unusedResolve({ slot: { name: 'unused_candidates' }, elapsedMs: 11, status: 'unknown' });
  assert.deepEqual(await pending, [[
    { slot: { name: 'complex_functions' }, elapsedMs: 10, status: 'measured' },
    { slot: { name: 'unused_candidates' }, elapsedMs: 11, status: 'unknown' },
  ], { status: 'measured', elapsedMs: 7 }]);
});

test('concurrent static/CI orchestration observes both branches before propagating errors', async () => {
  let releaseCi;
  let ciSettled = false;
  const ciGate = new Promise(resolve => { releaseCi = resolve; });
  const pending = runConcurrentStaticAndCiCollectors(
    async () => { throw new Error('synthetic static failure'); },
    async () => ({ slot: { name: 'unused_candidates' }, elapsedMs: 1, status: 'measured' }),
    async () => { await ciGate; ciSettled = true; return { status: 'measured' }; },
  );
  await new Promise(resolve => queueMicrotask(resolve));
  assert.equal(ciSettled, false, 'CI branch remains observed while the static failure is pending');
  releaseCi();
  await assert.rejects(pending, /synthetic static failure/);
  assert.equal(ciSettled, true, 'CI branch is awaited even after a static rejection');
});

test('concurrent static/CI orchestration waits for blocked unused work after complexity rejects', async () => {
  let releaseUnused;
  let releaseCi;
  let unusedSettled = false;
  let ciSettled = false;
  const unusedGate = new Promise(resolve => { releaseUnused = resolve; });
  const ciGate = new Promise(resolve => { releaseCi = resolve; });
  const pending = runConcurrentStaticAndCiCollectors(
    async () => { throw new Error('synthetic complexity failure'); },
    async () => { await unusedGate; unusedSettled = true; return { slot: { name: 'unused_candidates' } }; },
    async () => { await ciGate; ciSettled = true; return { status: 'measured' }; },
  );
  await new Promise(resolve => queueMicrotask(resolve));
  assert.equal(unusedSettled, false);
  assert.equal(ciSettled, false);
  releaseCi();
  await new Promise(resolve => queueMicrotask(resolve));
  assert.equal(ciSettled, true, 'CI is awaited independently of the blocked static branch');
  assert.equal(unusedSettled, false, 'complexity rejection does not short-circuit unused work');
  releaseUnused();
  await assert.rejects(pending, /synthetic complexity failure/);
  assert.equal(unusedSettled, true);
});

test('concurrent static/CI orchestration propagates a CI rejection after static completion', async () => {
  let staticSettled = false;
  await assert.rejects(
    runConcurrentStaticAndCiCollectors(
      async () => { staticSettled = true; return { slot: { name: 'complex_functions' } }; },
      async () => ({ slot: { name: 'unused_candidates' } }),
      async () => { throw new Error('synthetic CI failure'); },
    ),
    /synthetic CI failure/,
  );
  assert.equal(staticSettled, true, 'static branches are awaited before a CI rejection is propagated');
});

test('collector fallback records a bounded failure and evidence reference', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'code-health-402-fallback-'));
  const outputRoot = path.join(temp, 'artifact');
  const evidenceRefs = {};
  try {
    const result = await collectWithFallback({
      name: 'unused_candidates',
      unit: 'candidates',
      observedAt: '2026-10-17T12:00:00Z',
      outputRoot,
      evidenceRefs,
      collectMetric: async () => { throw Object.assign(new Error('synthetic analyzer failure'), { name: 'SyntheticError' }); },
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.slot.status, 'failed');
    assert.equal(result.slot.reason, 'producer-error');
    assert.deepEqual(evidenceRefs['ref:unused-candidates-collector-error'], {
      kind: 'artifact-file',
      path: 'evidence/unused_candidates/collector-error.json',
    });
    assert.deepEqual(JSON.parse(await readFile(path.join(outputRoot, 'evidence/unused_candidates/collector-error.json'))), {
      status: 'failed',
      error_name: 'SyntheticError',
      error: 'synthetic analyzer failure',
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('workflow history batch hashes exact Git blobs with one inventory process and deduplicated reads', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'code-health-402-git-history-'));
  const git = async (args, options = {}) => {
    const result = await runProcess('git', args, { cwd: temp, sanitizeOutput: false, ...options });
    assert.equal(result.exitCode, 0, `git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };
  const commit = async () => {
    await git(['add', '-A']);
    await git(['-c', 'user.name=Code Health Test', '-c', 'user.email=code-health-test@example.invalid', 'commit', '--quiet', '-m', 'fixture']);
    return git(['rev-parse', 'HEAD']);
  };
  try {
    await git(['init', '--quiet']);
    await mkdir(path.join(temp, '.github/workflows'), { recursive: true });
    await writeFile(path.join(temp, '.github/workflows/ci.yml'), 'name: first\n');
    const commits = [await commit()];
    await writeFile(path.join(temp, 'notes.txt'), 'one\n');
    commits.push(await commit());
    await writeFile(path.join(temp, 'notes.txt'), 'two\n');
    commits.push(await commit());
    await writeFile(path.join(temp, '.github/workflows/ci.yml'), 'name: second\n');
    commits.push(await commit());
    await writeFile(path.join(temp, 'notes.txt'), 'three\n');
    commits.push(await commit());
    await writeFile(path.join(temp, '.github/workflows/ci.yml'), '');
    commits.push(await commit());

    const processCalls = [];
    const resolverRun = async (command, args, options) => {
      processCalls.push([...args]);
      return runProcess(command, args, { ...options, cwd: temp });
    };
    const digests = await gitWorkflowDigests([...commits, commits[2]], { cwd: temp, run: resolverRun });
    assert.equal(digests.size, commits.length, 'duplicate commit inputs collapse to one map entry');
    assert.equal(processCalls.filter(args => args[0] === 'cat-file' && args[1] === '--batch-check').length, 1);
    assert.equal(processCalls.length, 4, 'six distinct commits use one inventory and three unique blob reads');
    const uniqueDigests = new Set();
    let priorResolverProcessCalls = 0;
    for (const sha of commits) {
      priorResolverProcessCalls += 1;
      const expected = await runProcess('git', ['show', `${sha}:.github/workflows/ci.yml`], { cwd: temp, sanitizeOutput: false });
      assert.equal(expected.exitCode, 0);
      const expectedDigest = createHash('sha256').update(expected.stdout).digest('hex');
      assert.equal(digests.get(sha), expectedDigest, `digest for ${sha} matches direct git show bytes`);
      uniqueDigests.add(expectedDigest);
    }
    assert.equal(uniqueDigests.size, 3);
    assert.equal(digests.get(commits[5]), createHash('sha256').update('').digest('hex'), 'an empty workflow blob hashes as empty bytes');
    assert.equal(priorResolverProcessCalls, 6, 'the former per-commit resolver invokes git show once for each distinct SHA');
    assert.ok(processCalls.length < priorResolverProcessCalls, 'batch inventory plus unique blobs uses fewer Git processes for repeated file versions');

    const forcedMissingRun = async (command, args, options) => {
      if (args[0] === 'cat-file' && args[1] === '--batch-check') {
        const commitSha = commits[0];
        return { exitCode: 0, stdout: `${commitSha}:.github/workflows/ci.yml missing\n`, stderr: '', timedOut: false };
      }
      return runProcess(command, args, { ...options, cwd: temp });
    };
    const fallbackDigests = await gitWorkflowDigests([commits[0]], { cwd: temp, run: forcedMissingRun });
    assert.equal(fallbackDigests.get(commits[0]), digests.get(commits[0]), 'default fallback resolves against the injected checkout');

    await git(['rm', '--quiet', '.github/workflows/ci.yml']);
    const missingPathCommit = await commit();
    const fallbackCalls = [];
    const missingDigests = await gitWorkflowDigests([missingPathCommit], {
      cwd: temp,
      fallback: async (sha, deadline) => {
        fallbackCalls.push({ sha, deadline });
        return DIGEST;
      },
    });
    assert.deepEqual(fallbackCalls, [{ sha: missingPathCommit, deadline: Number.POSITIVE_INFINITY }]);
    assert.equal(missingDigests.get(missingPathCommit), DIGEST);
    await assert.rejects(gitWorkflowDigests([missingPathCommit], {
      cwd: temp,
      fallback: async () => { throw new Error('missing locally'); },
    }), /missing locally/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('workflow history batch rejects malformed, truncated, timed-out, and invalid blob responses', async () => {
  const sha = 'c'.repeat(40);
  const validOid = 'd'.repeat(40);
  const cases = [
    { name: 'nonzero exit', result: { exitCode: 1, stdout: '', stderr: '', timedOut: false }, pattern: /inventory failed/ },
    { name: 'truncated stdout', result: { exitCode: 0, stdout: '', stderr: '', stdoutTruncated: true }, pattern: /inventory failed/ },
    { name: 'timeout', result: { exitCode: 124, stdout: '', stderr: '', timedOut: true }, pattern: /inventory failed/ },
    { name: 'missing row', result: { exitCode: 0, stdout: '', stderr: '' }, pattern: /unexpected row count/ },
    { name: 'malformed row', result: { exitCode: 0, stdout: 'bad object row\n', stderr: '' }, pattern: /malformed or non-blob/ },
    { name: 'unexpected type', result: { exitCode: 0, stdout: `${validOid} tree 1\n`, stderr: '' }, pattern: /malformed or non-blob/ },
    { name: 'oversize', result: { exitCode: 0, stdout: `${validOid} blob 10000001\n`, stderr: '' }, pattern: /size is invalid/ },
  ];
  for (const fixture of cases) {
    await assert.rejects(gitWorkflowDigests([sha], {
      run: async () => ({ elapsedMs: 0, stdoutTruncated: false, stderrTruncated: false, errorName: null, ...fixture.result }),
    }), fixture.pattern, fixture.name);
  }
  await assert.rejects(gitWorkflowDigests(['not-a-sha']), /full immutable commit SHAs/);
  const emptyBlobDigest = await gitWorkflowDigests([sha], {
    run: async (_command, args) => args[1] === '--batch-check'
      ? { exitCode: 0, stdout: `${validOid} blob 0\n`, stderr: '' }
      : { exitCode: 0, stdout: '', stderr: '' },
  });
  assert.equal(emptyBlobDigest.get(sha), createHash('sha256').update('').digest('hex'));
  await assert.rejects(gitWorkflowDigests([sha], {
    deadline: Date.now() - 1,
    run: (command, args, options) => runProcess(command, args, options),
  }), /inventory failed/);
  await assert.rejects(gitWorkflowDigests([sha], {
    run: async () => ({ exitCode: 0, stdout: `${validOid} blob 3\n`, stderr: '' }),
  }), /blob read failed|size did not match/);
});

test('complexity is strictly greater than the threshold with the full function denominator', () => {
  const ast = {
    type: 'Program',
    body: [
      { type: 'FunctionDeclaration', body: { type: 'BlockStatement', body: [] } },
      { type: 'VariableDeclarator', init: { type: 'ArrowFunctionExpression', body: { type: 'BlockStatement', body: [] } } },
      { type: 'MethodDefinition', value: { type: 'FunctionExpression', body: { type: 'BlockStatement', body: [] } } },
      { type: 'TSDeclareFunction', body: null },
    ],
  };
  assert.equal(countFunctionNodes(ast), 3, 'function bodies count; declaration-only signatures do not');
  assert.deepEqual(summarizeComplexity({ eligibleFunctions: 10, complexityValues: [20, 21], threshold: 20 }), {
    eligible_functions: 10,
    above_threshold_functions: 1,
  });
  const parsed = parseEslintReport(JSON.stringify([{ filePath: 'src/a.ts', messages: [
    { ruleId: 'complexity', severity: 1, line: 3, message: 'Function has a complexity of 20. Maximum allowed is 20.' },
    { ruleId: 'complexity', severity: 1, line: 8, message: 'Function has a complexity of 21. Maximum allowed is 20.' },
  ] }]));
  assert.deepEqual(parsed.complexityWarnings.map(item => item.value), [20, 21]);
  assert.deepEqual(summarizeComplexity({ eligibleFunctions: 10, complexityValues: parsed.complexityWarnings.map(item => item.value), threshold: 20 }), {
    eligible_functions: 10,
    above_threshold_functions: 1,
  });
});

test('coverage requires the declared unimported file and reconciles file totals', () => {
  const files = ['src/errors.ts', 'src/identity.ts', 'src/image-sidecar.ts'];
  const summary = {
    total: { lines: { total: 30, covered: 15 } },
    files: {
      'src/errors.ts': { lines: { total: 10, covered: 8 } },
      'src/identity.ts': { lines: { total: 10, covered: 7 } },
      'src/image-sidecar.ts': { lines: { total: 10, covered: 0 } },
    },
  };
  const result = summarizeCoverage(summary, files);
  assert.equal(result.eligible, 30);
  assert.equal(result.covered, 15);
  assert.equal(result.eligible_source_files, 3);
  assert.deepEqual(result.profile_refs, ['ref:coverage-profile-clean']);
  assert.throws(() => summarizeCoverage({ ...summary, files: Object.fromEntries(Object.entries(summary.files).slice(0, 2)) }, files), /inventory mismatch/);
  assert.throws(() => summarizeCoverage({ ...summary, total: { lines: { total: 29, covered: 15 } } }, files), /does not equal/);
});

test('Vitest top-level coverage summaries normalize absolute file keys and retain unimported files', () => {
  const sourceRoot = path.join(ROOT, 'src/homeserver');
  const vitestSummary = {
    total: { lines: { total: 246, covered: 186 } },
    [path.join(sourceRoot, 'errors.ts')]: { lines: { total: 175, covered: 172 } },
    [path.join(sourceRoot, 'image-sidecar.ts')]: { lines: { total: 51, covered: 0 } },
    [path.join(sourceRoot, 'task-type-identity.ts')]: { lines: { total: 20, covered: 14 } },
  };
  const normalized = normalizeCoverageSummary(vitestSummary, ROOT);
  assert.deepEqual(Object.keys(normalized.files).sort(), [
    'src/homeserver/errors.ts',
    'src/homeserver/image-sidecar.ts',
    'src/homeserver/task-type-identity.ts',
  ]);
  const coverage = summarizeCoverage(normalized, [
    'src/homeserver/errors.ts',
    'src/homeserver/image-sidecar.ts',
    'src/homeserver/task-type-identity.ts',
  ]);
  assert.equal(coverage.covered, 186);
  assert.equal(coverage.eligible, 246);
  assert.equal(coverage.emitted_source_files, 3);
  assert.deepEqual(normalized.files['src/homeserver/image-sidecar.ts'].lines, { total: 51, covered: 0 });
  assert.throws(() => normalizeCoverageSummary({ ...vitestSummary, '/outside/other.ts': { lines: { total: 1, covered: 0 } } }, ROOT), /outside the repository/);
});

test('CI run enumeration paginates completely and rejects malformed or moving inventories', async () => {
  const start = '2026-09-01T00:00:00Z';
  const end = '2026-10-01T00:00:00Z';
  const rows = Array.from({ length: 101 }, (_, index) => makeRun(index + 1));
  const pageFetcher = async (url, options) => {
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal);
    assert.equal(options.headers.authorization, 'Bearer test-token');
    const page = Number(new URL(url).searchParams.get('page'));
    return response({ total_count: rows.length, workflow_runs: rows.slice((page - 1) * 100, page * 100) });
  };
  const complete = await enumerateWorkflowRuns({ fetcher: pageFetcher, token: 'test-token', owner: 'Magnus-Gille', repo: 'gille-inference', workflow: 'ci.yml', start, end });
  assert.equal(complete.pageCount, 2);
  assert.equal(complete.windowCount, 101);

  await assert.rejects(enumerateWorkflowRuns({
    fetcher: async () => response({ total_count: 1, workflow_runs: [makeRun(1, { created_at: 'bad-date' })] }),
    token: 'test-token', owner: 'Magnus-Gille', repo: 'gille-inference', workflow: 'ci.yml', start, end,
  }), /invalid creation timestamp/);
  await assert.rejects(enumerateWorkflowRuns({
    fetcher: async url => {
      const page = Number(new URL(url).searchParams.get('page'));
      return response({ total_count: 101, workflow_runs: page === 1 ? rows.slice(0, 100) : [rows[99]] });
    },
    token: 'test-token', owner: 'Magnus-Gille', repo: 'gille-inference', workflow: 'ci.yml', start, end,
  }), /duplicate id/);
  await assert.rejects(enumerateWorkflowRuns({
    fetcher: async () => response({ total_count: 1001, workflow_runs: [] }),
    token: 'test-token', owner: 'Magnus-Gille', repo: 'gille-inference', workflow: 'ci.yml', start, end,
  }), /exceeds the 1000-row evidence bound/);
});

test('CI API retries bounded failures and respects the request deadline', async () => {
  let calls = 0;
  const retried = await fetchJsonWithRetry(async () => {
    calls += 1;
    return calls === 1 ? { ok: false, status: 503, headers: { get: () => null } } : response({ ok: true });
  }, 'https://api.github.com/repos/example', {}, { retries: 1, sleep: async () => {}, deadline: Date.now() + 1000 });
  assert.deepEqual(retried, { ok: true });
  assert.equal(calls, 2);
  await assert.rejects(fetchJsonWithRetry(async () => response({}), 'https://api.github.com/repos/example', {}, { deadline: Date.now() - 1 }), /time budget exhausted/);
  await assert.rejects(fetchJsonWithRetry(async (_url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(Object.assign(new Error('deadline'), { name: 'TimeoutError' })), { once: true });
  }), 'https://api.github.com/repos/example', {}, { retries: 0, deadline: Date.now() + 15 }), /TimeoutError/);
});

test('CI requests attempt one and never substitutes a successful rerun', async () => {
  const requested = [];
  const fetcher = async url => {
    const parsed = new URL(url);
    requested.push(parsed.pathname);
    if (parsed.pathname.endsWith('/attempts/1')) return response({ run_attempt: 1, status: 'completed', conclusion: 'failure' });
    if (parsed.pathname.endsWith('/attempts/1/jobs')) return response({ total_count: 2, jobs: [
      { id: 101, name: 'Gitleaks', status: 'completed', conclusion: 'success' },
      { id: 102, name: 'test', status: 'completed', conclusion: 'failure' },
    ] });
    throw new Error(`unexpected endpoint ${parsed.pathname}`);
  };
  const firstAttempt = await getFirstAttempt({ fetcher, token: 'test-token', owner: 'Magnus-Gille', repo: 'gille-inference', runId: 44, deadline: Date.now() + 1000 });
  assert.ok(requested.every(route => route.includes('/attempts/1')));
  assert.equal(firstAttempt.runAttempt, 1);

  const run = makeRun(44, { run_attempt: 2, conclusion: 'success' });
  const evidence = await buildFirstAttemptEvidence({
    enumeration: { totalCount: 1, pageCount: 1, windowCount: 1, windowRuns: [run], query: { start: '2026-09-01T00:00:00Z', end: '2026-10-01T00:00:00Z' } },
    attempts: new Map([[44, firstAttempt]]),
    workflowConfigForCommit: async () => DIGEST,
    expectedWorkflowDigest: DIGEST,
    expectedJobRefs: ['ref:job-secret-scan', 'ref:job-test'],
    jobNameToRef: { Gitleaks: 'ref:job-secret-scan', test: 'ref:job-test' },
    start: '2026-09-01T00:00:00Z', end: '2026-10-01T00:00:00Z',
  });
  assert.equal(evidence.runs[0].attempt, 1);
  assert.equal(evidence.runs[0].latest_attempt, 2);
  assert.equal(evidence.runs[0].overall_conclusion, 'failure');
  assert.equal(evidence.evidence.runs[0].latest_conclusion, 'success', 'the rerun remains context only');
  assert.equal(evidence.evidence.runs[0].first_attempt_conclusion, 'failure');
  const counts = reliabilityCounts(evidence.runs);
  assert.equal(counts.numerator, 0);
  assert.equal(counts.denominator, 1);
  assert.deepEqual(buildCohortRuns({
    runs: [run], attempts: new Map([[44, firstAttempt]]),
    expectedJobRefs: ['ref:job-secret-scan', 'ref:job-test'],
    jobNameToRef: { Gitleaks: 'ref:job-secret-scan', test: 'ref:job-test' },
    windowStart: '2026-09-01T00:00:00Z', windowEnd: '2026-10-01T00:00:00Z',
  })[0].jobs.map(job => job.conclusion), ['success', 'failure']);
  const inaccessible = buildCohortRuns({
    runs: [run], attempts: new Map(),
    expectedJobRefs: ['ref:job-secret-scan', 'ref:job-test'],
    jobNameToRef: { Gitleaks: 'ref:job-secret-scan', test: 'ref:job-test' },
    windowStart: '2026-09-01T00:00:00Z', windowEnd: '2026-10-01T00:00:00Z',
  });
  assert.equal(inaccessible[0].overall_conclusion, 'unknown', 'a successful later rerun cannot fill a missing first attempt');
  assert.equal(reliabilityCounts(inaccessible).fraction, null);
});

test('provider conclusions keep terminal timeouts in the failure denominator without guessing infrastructure', () => {
  const runs = buildCohortRuns({
    runs: [makeRun(51, { conclusion: 'timed_out' }), makeRun(52, { conclusion: 'startup_failure' })],
    attempts: new Map([
      [51, { status: 'completed', jobs: [{ name: 'test', conclusion: 'timed_out' }] }],
      [52, { status: 'completed', jobs: [{ name: 'test', conclusion: 'startup_failure' }] }],
    ]),
    expectedJobRefs: ['ref:job-test'],
    jobNameToRef: { test: 'ref:job-test' },
    windowStart: '2026-09-01T00:00:00Z', windowEnd: '2026-10-01T00:00:00Z',
  });
  assert.deepEqual(runs.map(run => run.jobs[0].conclusion), ['failure', 'failure']);
  assert.equal(reliabilityCounts(runs).denominator, 2);
  assert.equal(mapJobConclusion({ conclusion: 'infra_failure' }), 'unknown');
  assert.equal(mapJobConclusion({ conclusion: 'neutral' }), 'unknown');

  const workflowLevelStartup = buildCohortRuns({
    runs: [makeRun(53, { conclusion: 'startup_failure' })],
    attempts: new Map([[53, { status: 'completed', conclusion: 'startup_failure', jobs: [] }]]),
    expectedJobRefs: ['ref:job-test'], jobNameToRef: { test: 'ref:job-test' },
    windowStart: '2026-09-01T00:00:00Z', windowEnd: '2026-10-01T00:00:00Z',
  });
  assert.equal(workflowLevelStartup[0].overall_conclusion, 'unknown');
  assert.equal(reliabilityCounts(workflowLevelStartup).denominator, 0);
  const unclassified = unclassifiableKnownFailures([{
    run_id: 53, first_attempt_conclusion: 'startup_failure',
  }], [{
    run_ref: 'ref:gha-run-53-attempt-1', overall_conclusion: 'unknown',
    jobs: [{ conclusion: 'unknown' }, { conclusion: 'unknown' }],
  }]);
  assert.equal(unclassified[0].provider_conclusion, 'startup_failure');
  assert.match(unclassified[0].reason, /no expected job conclusion represents/);

  const mixedUnclassified = unclassifiableKnownFailures([{
    run_id: 55, first_attempt_conclusion: 'failure',
  }], [{
    run_ref: 'ref:gha-run-55-attempt-1', overall_conclusion: 'unknown',
    jobs: [{ conclusion: 'success' }, { conclusion: 'unknown' }],
  }]);
  assert.equal(mixedUnclassified.length, 1, 'a known run failure stays visible when mixed job outcomes normalize overall to unknown');
  assert.equal(mixedUnclassified[0].provider_conclusion, 'failure');
});

test('workflow-level startup failure with no jobs stays unknown and retains provider evidence', async () => {
  const result = await buildFirstAttemptEvidence({
    enumeration: {
      totalCount: 1, pageCount: 1, windowCount: 1,
      windowRuns: [makeRun(54, { conclusion: 'startup_failure' })],
      query: { start: '2026-09-01T00:00:00Z', end: '2026-10-01T00:00:00Z' },
    },
    attempts: new Map([[54, { status: 'completed', conclusion: 'startup_failure', jobs: [] }]]),
    workflowConfigForCommit: async () => DIGEST,
    expectedWorkflowDigest: DIGEST,
    expectedJobRefs: ['ref:job-test'], jobNameToRef: { test: 'ref:job-test' },
    start: '2026-09-01T00:00:00Z', end: '2026-10-01T00:00:00Z',
  });
  assert.equal(result.runs[0].overall_conclusion, 'unknown');
  assert.equal(reliabilityCounts(result.runs).denominator, 0);
  assert.equal(result.evidence.runs[0].first_attempt_conclusion, 'startup_failure');
  assert.deepEqual(result.evidence.runs[0].jobs, []);
  assert.deepEqual(unclassifiableKnownFailures(result.evidence.runs, result.runs), [{
    run_id: 54,
    provider_conclusion: 'startup_failure',
    classification: 'unknown',
    reason: 'frozen v1 derives the run outcome from expected jobs; no expected job conclusion represents this provider run-level failure',
  }]);
});

test('CI collector withholds the measured slot for unclassifiable known failures', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'code-health-402-ci-slot-'));
  try {
    const workflowDigest = createHash('sha256')
      .update(await readFile(path.join(ROOT, '.github/workflows/ci.yml')))
      .digest('hex');
    const fixtures = [
      {
        id: 61,
        providerConclusion: 'startup_failure',
        jobs: [],
        expectedStatus: 'unknown',
      },
      {
        id: 62,
        providerConclusion: 'failure',
        jobs: [
          { id: 6201, name: 'Gitleaks', status: 'completed', conclusion: 'success' },
          { id: 6202, name: 'test', status: 'completed', conclusion: null },
        ],
        expectedStatus: 'unknown',
      },
      {
        id: 63,
        providerConclusion: 'failure',
        jobs: [
          { id: 6301, name: 'Gitleaks', status: 'completed', conclusion: 'success' },
          { id: 6302, name: 'test', status: 'completed', conclusion: 'failure' },
        ],
        expectedStatus: 'measured',
      },
    ];
    const collected = [];
    for (const fixture of fixtures) {
      const run = makeRun(fixture.id, { conclusion: fixture.providerConclusion });
      const enumeration = {
        totalCount: 1, pageCount: 1, windowCount: 1, windowRuns: [run],
        query: { start: '2026-09-11T12:00:00Z', end: '2026-10-09T12:00:00Z' },
      };
      const evidenceRefs = {};
      const result = await collectCi({
        outputRoot: path.join(temp, `case-${fixture.id}`),
        observedAt: '2026-10-09T12:00:00Z',
        collectionRef: `ref:collection-ci-slot-${fixture.id}`,
        attempt: 1,
        token: 'synthetic-test-token',
        evidenceRefs,
        deadline: Date.now() + 10_000,
        enumerateRuns: async () => enumeration,
        fetchFirstAttempt: async () => ({
          runAttempt: 1, status: 'completed', conclusion: fixture.providerConclusion, jobs: fixture.jobs,
        }),
        workflowDigestForCommit: async () => workflowDigest,
      });
      assert.equal(result.status, fixture.expectedStatus, `collector state for fixture ${fixture.id}`);
      assert.equal(result.slot.status, fixture.expectedStatus, `published slot state for fixture ${fixture.id}`);
      const inventory = JSON.parse(await readFile(path.join(temp, `case-${fixture.id}`, 'evidence/ci/inventory.json'), 'utf8'));
      assert.equal(inventory.complete, true);
      assert.equal(inventory.runs.length, 1, 'raw attempt inventory remains available');
      assert.ok(evidenceRefs[`ref:gha-run-${fixture.id}-attempt-1`], 'raw run evidence remains indexed');
      if (fixture.expectedStatus === 'unknown') {
        assert.equal(result.slot.reason, 'incomplete-input');
        assert.equal(result.slot.payload, null);
        assert.equal(result.slot.source, null);
        assert.equal(result.slot.population, null);
        assert.equal(inventory.unclassifiable_known_failures.length, 1);
      } else {
        assert.ok(result.slot.payload);
        assert.ok(result.slot.source);
        assert.ok(result.slot.population);
        assert.equal(inventory.unclassifiable_known_failures.length, 0);
      }
      collected.push(result.slot);
    }

    const baseline = await collect({
      outputDir: path.join(temp, 'baseline-objective'),
      collectStatic: false,
      token: null,
      now: new Date('2026-10-09T12:00:00Z'),
      runId: null,
      attempt: 1,
    });
    const schema = JSON.parse(await readFile(path.join(CONTRACT_ROOT, 'docs/code-health-objective-v1.schema.json'), 'utf8'));
    for (const ciSlot of collected) {
      const objective = structuredClone(baseline.objective);
      objective.metrics.ci_first_attempt = ciSlot;
      assert.equal(validateObjective(schema, objective).valid, true, `full objective schema for ${ciSlot.status} CI slot`);
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('CI collector preserves every run version and first-attempt failure with the injected resolver seam', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'code-health-402-ci-history-seam-'));
  try {
    const expectedDigest = createHash('sha256')
      .update(await readFile(path.join(ROOT, '.github/workflows/ci.yml')))
      .digest('hex');
    const runs = [
      makeRun(71, { head_sha: 'a'.repeat(40), created_at: '2026-09-20T10:00:00Z', conclusion: 'success' }),
      makeRun(72, { head_sha: 'b'.repeat(40), created_at: '2026-09-21T10:00:00Z', conclusion: 'success' }),
      makeRun(73, { head_sha: 'c'.repeat(40), created_at: '2026-09-22T10:00:00Z', conclusion: 'failure' }),
    ];
    const attemptsFetched = [];
    const result = await collectCi({
      outputRoot: path.join(temp, 'artifact'),
      observedAt: '2026-10-09T12:00:00Z',
      collectionRef: 'ref:collection-ci-history-seam',
      attempt: 1,
      token: 'synthetic-test-token',
      evidenceRefs: {},
      deadline: Date.now() + 10_000,
      enumerateRuns: async () => ({
        totalCount: runs.length, pageCount: 1, windowCount: runs.length, windowRuns: runs,
        query: { start: '2026-09-11T12:00:00Z', end: '2026-10-09T12:00:00Z' },
      }),
      workflowDigestForCommit: async sha => sha === 'b'.repeat(40) ? 'f'.repeat(64) : expectedDigest,
      fetchFirstAttempt: async ({ runId }) => {
        attemptsFetched.push(Number(runId));
        const failure = Number(runId) === 73;
        return {
          runAttempt: 1,
          status: 'completed',
          conclusion: failure ? 'failure' : 'success',
          jobs: [
            { id: Number(runId) * 10 + 1, name: 'Gitleaks', status: 'completed', conclusion: 'success' },
            { id: Number(runId) * 10 + 2, name: 'test', status: 'completed', conclusion: failure ? 'failure' : 'success' },
          ],
        };
      },
    });
    assert.deepEqual(attemptsFetched, [71, 73], 'only runs using the exact pinned workflow reach attempt retrieval');
    assert.equal(result.status, 'measured');
    const inventory = JSON.parse(await readFile(path.join(temp, 'artifact/evidence/ci/inventory.json'), 'utf8'));
    assert.equal(inventory.complete_run_enumeration, true);
    assert.deepEqual(inventory.runs.map(run => run.run_id), [71, 73]);
    assert.deepEqual(inventory.workflow_config_cohorts.map(run => run.run_id), [72]);
    assert.deepEqual(result.slot.payload.runs.map(run => run.overall_conclusion), ['success', 'failure']);
    assert.deepEqual(result.slot.payload.runs.map(run => run.attempt), [1, 1]);
    assert.equal(result.slot.payload.expected_run_count, 2);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('CI attempt pool is bounded, preserves enumeration order, and keeps failures and exclusions', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'code-health-402-ci-attempt-pool-'));
  const expectedDigest = createHash('sha256')
    .update(await readFile(path.join(ROOT, '.github/workflows/ci.yml')))
    .digest('hex');
  const runs = [
    makeRun(81, { head_sha: 'a'.repeat(40), created_at: '2026-09-20T10:00:00Z' }),
    makeRun(82, { head_sha: 'b'.repeat(40), created_at: '2026-09-21T10:00:00Z' }),
    makeRun(83, { head_sha: 'c'.repeat(40), created_at: '2026-09-22T10:00:00Z', run_attempt: 2, conclusion: 'success' }),
    makeRun(84, { head_sha: 'd'.repeat(40), created_at: '2026-09-23T10:00:00Z' }),
    makeRun(85, { head_sha: 'e'.repeat(40), created_at: '2026-09-24T10:00:00Z' }),
    makeRun(86, { head_sha: 'f'.repeat(40), created_at: '2026-09-25T10:00:00Z' }),
    makeRun(87, { head_sha: '7'.repeat(40), created_at: '2026-09-26T10:00:00Z' }),
  ];
  let active = 0;
  let maximumActive = 0;
  let startCount = 0;
  let signalFourStarted;
  const fourStarted = new Promise(resolve => { signalFourStarted = resolve; });
  let signal86Started;
  const eightySixStarted = new Promise(resolve => { signal86Started = resolve; });
  let signal86Finished;
  const eightySixFinished = new Promise(resolve => { signal86Finished = resolve; });
  let signal84Finished;
  const eightyFourFinished = new Promise(resolve => { signal84Finished = resolve; });
  const gates = new Map();
  const failureCompletionOrder = [];
  let releasePending = false;
  let collectorPromise;
  const awaitBoundedSignal = async (signal, description) => {
    let timer;
    const received = await Promise.race([
      signal.then(() => true),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), 500); }),
    ]);
    clearTimeout(timer);
    assert.equal(received, true, description);
  };
  try {
    collectorPromise = collectCi({
      outputRoot: path.join(temp, 'artifact'),
      observedAt: '2026-10-09T12:00:00Z',
      collectionRef: 'ref:collection-ci-attempt-pool',
      attempt: 1,
      token: 'synthetic-test-token',
      evidenceRefs: {},
      deadline: Date.now() + 10_000,
      enumerateRuns: async () => ({
        totalCount: runs.length, pageCount: 1, windowCount: runs.length, windowRuns: runs,
        query: { start: '2026-09-11T12:00:00Z', end: '2026-10-09T12:00:00Z' },
      }),
      workflowDigestForCommit: async sha => sha === 'b'.repeat(40) ? 'f'.repeat(64) : expectedDigest,
      fetchFirstAttempt: async ({ runId }) => {
        const id = Number(runId);
        startCount += 1;
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        if (startCount === 4) signalFourStarted();
        if (id === 86) signal86Started();
        try {
          if (id !== 87) await new Promise(resolve => {
            if (releasePending) resolve();
            else gates.set(id, resolve);
          });
          if (id === 84) {
            failureCompletionOrder.push(id);
            throw null;
          }
          if (id === 86) {
            failureCompletionOrder.push(id);
            throw Object.assign(new Error('synthetic bounded failure'), { name: 'ApiError', status: 503 });
          }
          const failure = id === 83;
          return {
            runAttempt: 1,
            status: 'completed',
            conclusion: failure ? 'failure' : 'success',
            jobs: [
              { id: id * 10 + 1, name: 'Gitleaks', status: 'completed', conclusion: 'success' },
              { id: id * 10 + 2, name: 'test', status: 'completed', conclusion: failure ? 'failure' : 'success' },
            ],
          };
        } finally {
          active -= 1;
          if (id === 84) signal84Finished();
          if (id === 86) signal86Finished();
        }
      },
    });
    await awaitBoundedSignal(fourStarted, 'four selected attempts enter the controlled gate without serial waiting');
    assert.equal(maximumActive, 4, 'the pool reaches but does not exceed its fixed width');
    assert.equal(startCount, 4, 'the fifth selected attempt has not begun before a controlled release');

    gates.get(85)();
    await awaitBoundedSignal(eightySixStarted, 'one released worker starts the fifth selected attempt');
    assert.equal(startCount, 5);
    assert.equal(maximumActive, 4);
    gates.get(86)();
    await awaitBoundedSignal(eightySixFinished, 'run 86 provider error completes before run 84 rejection');
    assert.deepEqual(failureCompletionOrder, [86]);
    gates.get(84)();
    await awaitBoundedSignal(eightyFourFinished, 'run 84 null rejection completes after run 86');
    assert.deepEqual(failureCompletionOrder, [86, 84]);

    releasePending = true;
    for (const release of gates.values()) release();

    const result = await collectorPromise;
    assert.equal(result.status, 'measured');
    assert.deepEqual(result.slot.payload.runs.map(run => Number(run.run_ref.match(/gha-run-(\d+)-attempt-1/)?.[1])), [81, 83, 84, 85, 86, 87]);
    assert.deepEqual(result.slot.payload.runs.map(run => run.attempt), [1, 1, 1, 1, 1, 1]);
    assert.equal(result.slot.payload.runs[1].latest_attempt, 2, 'latest retry is retained only as context');
    assert.equal(result.slot.payload.runs[1].overall_conclusion, 'failure', 'first-attempt failure remains authoritative');
    const inventory = JSON.parse(await readFile(path.join(temp, 'artifact/evidence/ci/inventory.json'), 'utf8'));
    assert.deepEqual(inventory.runs.map(run => run.run_id), [81, 83, 84, 85, 86, 87], 'evidence stays in enumeration order');
    assert.deepEqual(inventory.workflow_config_cohorts.map(run => run.run_id), [82], 'excluded workflow version never enters the pool');
    assert.deepEqual(inventory.first_attempt_fetch_errors, [
      { run_id: 84, attempt: 1, error: 'ApiError', status: null },
      { run_id: 86, attempt: 1, error: 'ApiError', status: 503 },
    ], 'rejected null and ordinary API errors remain visible in enumeration order');
    assert.equal(inventory.attempt_evidence_complete, false);
    assert.equal(inventory.denominator, 4);
  } finally {
    releasePending = true;
    for (const release of gates.values()) release();
    if (collectorPromise) await collectorPromise.catch(() => {});
    await rm(temp, { recursive: true, force: true });
  }
});

test('CI cached workflow digests preserve complete enumeration after attempt-time deadline expiry', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'code-health-402-ci-attempt-deadline-'));
  const originalNow = Date.now;
  const now = { value: 1_000 };
  const expectedDigest = createHash('sha256')
    .update(await readFile(path.join(ROOT, '.github/workflows/ci.yml')))
    .digest('hex');
  const runs = [
    makeRun(91, { head_sha: '1'.repeat(40), created_at: '2026-09-20T10:00:00Z' }),
    makeRun(92, { head_sha: '2'.repeat(40), created_at: '2026-09-21T10:00:00Z' }),
    makeRun(93, { head_sha: '3'.repeat(40), created_at: '2026-09-22T10:00:00Z' }),
  ];
  Date.now = () => now.value;
  try {
    const fetched = [];
    const result = await collectCi({
      outputRoot: path.join(temp, 'artifact'),
      observedAt: '2026-10-09T12:00:00Z',
      collectionRef: 'ref:collection-ci-attempt-deadline',
      attempt: 1,
      token: 'synthetic-test-token',
      evidenceRefs: {},
      deadline: 2_000,
      enumerateRuns: async () => ({
        totalCount: runs.length, pageCount: 1, windowCount: runs.length, windowRuns: runs,
        query: { start: '2026-09-11T12:00:00Z', end: '2026-10-09T12:00:00Z' },
      }),
      workflowDigestForCommit: async () => expectedDigest,
      fetchFirstAttempt: async ({ runId }) => {
        fetched.push(Number(runId));
        now.value = 2_000;
        throw Object.assign(new Error('synthetic deadline'), { name: 'TimeoutError' });
      },
    });
    assert.deepEqual(fetched, [91], 'no new provider attempt starts after the deadline expires');
    assert.equal(result.status, 'measured', 'cached workflow digests preserve the complete inventory');
    assert.equal(result.slot.payload.expected_run_count, runs.length);
    assert.deepEqual(result.slot.payload.runs.map(run => run.overall_conclusion), ['unknown', 'unknown', 'unknown']);
    const inventory = JSON.parse(await readFile(path.join(temp, 'artifact/evidence/ci/inventory.json'), 'utf8'));
    assert.equal(inventory.complete_run_enumeration, true);
    assert.deepEqual(inventory.runs.map(run => run.run_id), [91, 92, 93]);
    assert.deepEqual(inventory.runs.map(run => run.first_attempt_status), [null, null, null]);
    assert.deepEqual(inventory.first_attempt_fetch_errors, [
      { run_id: 91, attempt: 1, error: 'TimeoutError', status: null },
      { run_id: 92, attempt: 1, error: 'TimeoutError', status: null },
      { run_id: 93, attempt: 1, error: 'TimeoutError', status: null },
    ]);
    assert.equal(inventory.attempt_evidence_complete, false);
  } finally {
    Date.now = originalNow;
    await rm(temp, { recursive: true, force: true });
  }
});

test('CI deadline before the first uncached workflow digest still fails closed', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'code-health-402-ci-history-expired-'));
  const originalNow = Date.now;
  let resolverCalls = 0;
  Date.now = () => 2_000;
  try {
    const result = await collectCi({
      outputRoot: path.join(temp, 'artifact'),
      observedAt: '2026-10-09T12:00:00Z',
      collectionRef: 'ref:collection-ci-history-expired',
      attempt: 1,
      token: 'synthetic-test-token',
      evidenceRefs: {},
      deadline: 2_000,
      enumerateRuns: async () => ({
        totalCount: 1, pageCount: 1, windowCount: 1,
        windowRuns: [makeRun(101, { head_sha: '4'.repeat(40), created_at: '2026-09-20T10:00:00Z' })],
        query: { start: '2026-09-11T12:00:00Z', end: '2026-10-09T12:00:00Z' },
      }),
      workflowDigestForCommit: async () => { resolverCalls += 1; return 'a'.repeat(64); },
    });
    assert.equal(resolverCalls, 0, 'an uncached workflow lookup does not begin after the deadline');
    assert.equal(result.status, 'failed');
    const inventory = JSON.parse(await readFile(path.join(temp, 'artifact/evidence/ci/inventory.json'), 'utf8'));
    assert.equal(inventory.complete_run_enumeration, false);
    assert.equal(inventory.runs, null);
    assert.match(inventory.reason, /time budget exhausted while verifying workflow history/);
  } finally {
    Date.now = originalNow;
    await rm(temp, { recursive: true, force: true });
  }
});

test('manual Knip triage binds file, symbol, and line together', () => {
  const prior = { candidates: [
    { path: 'src/a.ts', candidate_type: 'unused-file', classification: 'false-positive' },
    { path: 'src/a.ts:keepMe@12', candidate_type: 'unused-export', classification: 'uncertain' },
  ] };
  assert.equal(inferTriage({ kind: 'files', file: 'src/a.ts' }, prior).classification, 'false-positive');
  assert.equal(inferTriage({ kind: 'exports', file: 'src/a.ts', name: 'keepMe', line: 12 }, prior).classification, 'uncertain');
  assert.equal(inferTriage({ kind: 'exports', file: 'src/a.ts', name: 'keepMe', line: 13 }, prior).classification, 'unreviewed-candidate');
  assert.equal(inferTriage({ kind: 'exports', file: 'src/b.ts', name: 'keepMe', line: 12 }, prior).classification, 'unreviewed-candidate');
});

test('CI-only Markdown names only evidence the collector emits', () => {
  const metrics = Object.fromEntries([
    'complex_functions', 'unused_candidates', 'coverage', 'ci_first_attempt', 'confirmed_regressions',
  ].map(name => [name, { status: 'unknown' }]));
  const report = reportMarkdown({
    objective: { repository: { owner: 'owner', name: 'repo' }, commit: 'a'.repeat(40), snapshot_id: 'ref:test', observed_at: '2026-10-09T12:00:00Z', metrics },
    aggregate: { metrics: { ci_first_attempt: { status: 'unknown' } } },
    sourceContextData: { languages: [], change_frequency: { status: 'unknown' } },
    timings: [], errors: [], staticRequested: false, reportStatus: 'partial',
    staticMetadataElapsedMs: 1, coverageElapsedMs: null,
  });
  assert.doesNotMatch(report, /evidence\/(?:complexity|unused|coverage)\//);
  const paths = [...report.matchAll(/(?:evidence\/[A-Za-z0-9_./-]+|evidence-index\.json)/g)]
    .map(match => match[0].replace(/[.,;:]+$/, ''));
  assert.deepEqual([...new Set(paths)], ['evidence/ci/inventory.json', 'evidence/release-regression-survey.json', 'evidence-index.json']);
});

test('CI-only collection keeps static slots uncollected and uses the shared pilot budget', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'code-health-402-ci-only-'));
  const outputDir = path.join(temp, 'artifact');
  try {
    const result = await collect({
      outputDir,
      collectStatic: false,
      token: null,
      now: new Date('2026-10-09T12:00:00Z'),
      runId: null,
      attempt: 1,
    });
    for (const name of ['complex_functions', 'unused_candidates', 'coverage']) {
      assert.equal(result.objective.metrics[name].status, 'unknown', `${name} remains uncollected`);
    }
    assert.equal(result.objective.metrics.ci_first_attempt.status, 'unknown');
    assert.equal(result.staticMetadataElapsedMs <= 30_000, true, 'CI-only path keeps the 30 second pilot budget');
    const files = await listFiles(outputDir);
    assert.ok(files.includes('evidence/ci/inventory.json'));
    assert.equal(files.some(file => /evidence\/(complexity|unused|coverage)\//.test(file)), false);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('local static collection smoke emits a truthful partial artifact', { skip: process.env.CODE_HEALTH_REAL_SMOKE !== 'true' }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'code-health-402-report-'));
  const outputDir = path.join(temp, 'artifact');
  try {
    const result = await collect({ outputDir, collectStatic: true, token: null, now: new Date('2026-10-09T12:00:00Z'), runId: null, attempt: 1 });
    assert.equal(result.reportStatus, 'partial');
    assert.equal(result.manifest.contract_version, '1.0');
    assert.deepEqual(Object.keys(result.manifest).sort(), ['commit_sha', 'contract_version', 'evidence_index', 'repo_name', 'repo_owner', 'snapshots']);
    assert.equal(result.manifest.repo_name, 'gille-inference');
    assert.equal(result.manifest.commit_sha, result.objective.commit);
    assert.deepEqual(result.objective.metrics && Object.keys(result.objective.metrics).sort(), [
      'ci_first_attempt', 'complex_functions', 'confirmed_regressions', 'coverage', 'unused_candidates',
    ]);
    assert.ok(Object.values(result.objective.metrics).every(metric => ['unknown', 'failed', 'unsupported', 'stale', 'measured'].includes(metric.status)));
    const complexityMetric = result.objective.metrics.complex_functions;
    assert.equal(complexityMetric.status, 'measured', 'opt-in real smoke requires a clean committed worktree and the pinned installed analyzers');
    if (complexityMetric.status === 'measured') {
      assert.equal(complexityMetric.payload.algorithm, 'cyclomatic-complexity-v1');
      assert.equal(complexityMetric.payload.threshold, 20);
      assert.ok(Number.isSafeInteger(complexityMetric.payload.eligible_functions) && complexityMetric.payload.eligible_functions >= 0);
      assert.ok(Number.isSafeInteger(complexityMetric.payload.above_threshold_functions)
        && complexityMetric.payload.above_threshold_functions >= 0
        && complexityMetric.payload.above_threshold_functions <= complexityMetric.payload.eligible_functions);
      assert.ok(complexityMetric.source && complexityMetric.population,
        'a measured complexity slot must retain source and complete-population provenance');
    } else {
      assert.equal(complexityMetric.payload, null, 'an unavailable complexity slot must not carry a measured payload');
    }
    assert.ok(['failed', 'unknown'].includes(result.objective.metrics.unused_candidates.status));
    const coverageMetric = result.objective.metrics.coverage;
    assert.equal(coverageMetric.status, 'measured', 'opt-in real smoke must exercise actual pinned coverage successfully');
    assert.equal(coverageMetric.payload.covered, 186);
    assert.equal(coverageMetric.payload.eligible, 246);
    assert.equal(coverageMetric.payload.emitted_source_files, 3);
    assert.equal(coverageMetric.payload.eligible_source_files, 3);
    assert.equal(coverageMetric.payload.source_inventory, 'complete-declared-inventory');
    assert.equal(result.objective.metrics.ci_first_attempt.status, 'unknown');
    assert.equal(result.objective.metrics.confirmed_regressions.status, 'unknown');

    const index = JSON.parse(await readFile(path.join(outputDir, 'evidence-index.json'), 'utf8'));
    const manifestOnDisk = JSON.parse(await readFile(path.join(outputDir, 'manifest.json'), 'utf8'));
    assert.deepEqual(Object.keys(index).sort(), ['refs', 'version']);
    assert.deepEqual(manifestOnDisk, result.manifest);
    const coverageSummary = JSON.parse(await readFile(path.join(outputDir, 'evidence/coverage/coverage-summary.json'), 'utf8'));
    if (coverageSummary.files) {
      assert.deepEqual(Object.keys(coverageSummary.files).sort(), [
        'src/homeserver/errors.ts',
        'src/homeserver/image-sidecar.ts',
        'src/homeserver/task-type-identity.ts',
      ]);
      assert.equal(coverageSummary.total.lines.total, 246);
      assert.equal(coverageSummary.total.lines.covered, 186);
      assert.deepEqual(coverageSummary.files['src/homeserver/image-sidecar.ts'].lines, {
        total: 51, covered: 0, skipped: 0, pct: 0,
      });
    } else {
      assert.equal(result.objective.metrics.coverage.status, 'failed');
    }
    for (const reference of new Set(JSON.stringify(result.objective).match(/ref:[a-z0-9][a-z0-9-]*/g) ?? [])) {
      assert.ok(index.refs[reference], `missing evidence-index reference ${reference}`);
    }
    for (const record of Object.values(index.refs)) {
      if (record.kind === 'artifact-file') await readFile(path.join(outputDir, record.path));
      else if (record.kind === 'source') assert.ok(Number.isSafeInteger(record.line) && record.line > 0);
      else assert.equal(record.kind, 'github-run');
    }
    const report = await readFile(path.join(outputDir, 'report.md'), 'utf8');
    assert.match(report, /Report status: partial/);
    assert.match(report, /Static and metadata wall time: .*within budget|Static and metadata wall time: .*over budget/);
    const files = await listFiles(outputDir);
    assert.ok(files.includes('evidence/complexity/scan.json'));
    assert.ok(files.includes('evidence/unused/knip.json'));
    assert.ok(files.includes('evidence/coverage/run.json'));
    assert.ok(!files.some(file => file.startsWith('coverage/')), 'Vitest scratch output must stay outside the published artifact');
    const complexityInventory = JSON.parse(await readFile(path.join(outputDir, 'evidence/complexity/inventory.json'), 'utf8'));
    const complexitySummary = JSON.parse(await readFile(path.join(outputDir, 'evidence/complexity/summary.json'), 'utf8'));
    assert.equal(complexitySummary.status, complexityMetric.status);
    if (complexityMetric.status === 'measured') {
      assert.equal(complexitySummary.eligible_function_count, complexityMetric.payload.eligible_functions);
      assert.equal(complexitySummary.above_threshold_count, complexityMetric.payload.above_threshold_functions);
    } else {
      assert.equal(complexitySummary.eligible_function_count, null);
      assert.equal(complexitySummary.above_threshold_count, null);
    }
    assert.equal(complexityInventory.failed_files.length, 0, 'every tracked TypeScript source file must parse');
    assert.equal(complexityInventory.parsed_files, complexityInventory.files.length);
    const complexityScan = JSON.parse(await readFile(path.join(outputDir, 'evidence/complexity/scan.json'), 'utf8'));
    assert.equal(complexityScan.exit_code, 0);
    assert.equal(complexityScan.parse_error, null);
    assert.deepEqual(complexityScan.parse_errors, []);
    assert.equal(complexityScan.result_files.length, complexityInventory.files.length);
    assert.ok(eslintInventoryComplete(
      complexityScan.result_files.map(result => ({ filePath: result.path })),
      complexityInventory.files.map(file => file.path),
      ROOT,
    ), 'ESLint must emit exactly the eligible tracked TypeScript inventory');
    const knipRun = JSON.parse(await readFile(path.join(outputDir, 'evidence/unused/knip.json'), 'utf8'));
    assert.equal(knipRun.parse_error, null, 'the pinned Knip grouped-issues format must parse');
    assert.ok(Array.isArray(knipRun.raw_report.issues));
    const knipFindings = JSON.parse(await readFile(path.join(outputDir, 'evidence/unused/findings.json'), 'utf8'));
    assert.equal(knipFindings.candidate_count, normalizeKnipRows(knipRun.raw_report).length);
    assert.equal(knipFindings.candidate_rows.filter(row => row.kind === 'files').length, knipRun.raw_report.files.length);
    const priorTriage = JSON.parse(await readFile(path.join(ROOT, 'research/code-health-401/artifacts/knip-triage.json'), 'utf8'));
    for (const candidate of priorTriage.candidates) {
      const fileCandidate = candidate.candidate_type === 'unused-file';
      const separator = fileCandidate ? -1 : candidate.path.lastIndexOf(':');
      const at = fileCandidate ? -1 : candidate.path.lastIndexOf('@');
      const file = fileCandidate ? candidate.path : candidate.path.slice(0, separator);
      const name = fileCandidate ? null : candidate.path.slice(separator + 1, at);
      const line = fileCandidate ? null : Number(candidate.path.slice(at + 1));
      assert.ok(knipFindings.candidate_rows.some(row => row.path === file
        && row.triage.classification === candidate.classification
        && (fileCandidate ? row.kind === 'files' : row.kind === 'exports' && row.name === name && row.line === line)),
      `manual triage was not retained for ${candidate.path}`);
    }
    for (const relative of files) {
      const filePath = path.join(outputDir, relative);
      const content = await readFile(filePath, 'utf8');
      assert.ok(!content.includes(ROOT), `raw evidence leaked the absolute repository root in ${relative}`);
      assert.doesNotMatch(content, /(?:\/Users|\/private\/|\/tmp\/|\/home\/|\/var\/folders\/|file:\/\/)/, `artifact retained a local path marker in ${relative}`);
    }

  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('informational workflow preserves the read-only, always-artifact contract and pinned actions', async () => {
  const workflow = await readFile(path.join(ROOT, '.github/workflows/code-health.yml'), 'utf8');
  assert.match(workflow, /permissions:\n      contents: read\n      actions: read/);
  assert.match(workflow, /cron: '17 4 \* \* \*'/);
  assert.match(workflow, /cron: '47 4 \* \* 1'/);
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /github\.event_name != 'workflow_dispatch' \|\| github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /github\.event_name != 'schedule' \|\| vars\.CODE_HEALTH_COLLECTION_ENABLED == 'true'/);
  assert.match(workflow, /node-version: '22'/);
  assert.match(workflow, /name: code-health-v1/);
  assert.match(workflow, /retention-days: 30/);
  assert.match(workflow, /if: always\(\)/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /Check synthetic producer and workflow conformance[\s\S]*?node --test research\/code-health-402\/test-producer\.mjs/);
  const producerTests = await readFile(path.join(ROOT, 'research/code-health-402/test-producer.mjs'), 'utf8');
  assert.match(producerTests, /CODE_HEALTH_REAL_SMOKE !== 'true'/);
  assert.doesNotMatch(workflow, /CODE_HEALTH_REAL_SMOKE/);
  assert.match(workflow, /npm ci --prefix research\/code-health-401\/tooling --ignore-scripts/);
  assert.match(workflow, /npm ci --prefix research\/code-health-401\/coverage-tooling --ignore-scripts/);
  assert.match(workflow, /node research\/code-health-402\/collect\.mjs --output/);
  assert.match(workflow, /Collect once on schedule or manual dispatch[\s\S]*?github\.event_name != 'pull_request'/);
  assert.doesNotMatch(workflow, /Collect report without a token on pull requests/);
  assert.match(workflow, /Install isolated pinned analyzer tools[\s\S]*?github\.event\.schedule == '47 4 \* \* 1'/);
  assert.match(workflow, /Finalize bounded workflow status and timing[\s\S]*?elapsed_before_upload_ms/);
  assert.match(workflow, /static_pre_upload_budget_ms\":900000/);
  assert.match(workflow, /metadata_pre_upload_budget_ms\":30000/);
  assert.match(workflow, /pre_upload_budget_status/);
  assert.match(workflow, /end_to_end_budget_status\":\"unknown-upload-duration\"/);
  assert.match(workflow, /artifact_upload[\s\S]*?timeout-minutes: 3/);
  assert.match(workflow, /report_status|report\.md/);
  assert.match(workflow, /actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7\.0\.1/);
  assert.match(workflow, /actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7\.0\.0/);
  assert.match(workflow, /actions\/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7\.0\.2/);
  assert.doesNotMatch(workflow, /secrets\.|prod(?:uction)?[-_ ]?(?:token|credential)|deploy/i);
});
