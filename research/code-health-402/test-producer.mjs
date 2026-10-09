import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import {
  analyzerStatus,
  assertToolVersion,
  buildCohortRuns,
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
import { checkVendorContract, collect, inferTriage, reportMarkdown, runProcess } from './collect.mjs';

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
  assert.deepEqual(normalizeKnipRows({ files: [], exports: [] }), []);
  assert.throws(() => normalizeKnipRows({ unrecognized: [] }), /unknown issue group/);
  assert.throws(() => normalizeKnipRows({ files: [{ note: 'not a source candidate' }] }), /no source path or symbol/);
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
