import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, mkdir, mkdtemp, realpath, rm, writeFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  canonical,
  assertToolVersion,
  analyzerStatus,
  countFunctionNodes,
  digest,
  eslintInventoryComplete,
  isoSecond,
  normalizeKnipRows,
  normalizeCoverageSummary,
  parseEslintReport,
  refId,
  slot,
  source,
  summarizeComplexity,
  summarizeCoverage,
  unclassifiableKnownFailures,
} from './lib/core.mjs';
import {
  buildFirstAttemptEvidence,
  ciPayload,
  enumerateWorkflowRuns,
  getFirstAttempt,
} from './lib/ci.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const CONTRACT_ROOT = path.resolve(ROOT, 'contracts/grimnir-code-health-v1');
const EXPECTED_CI_WORKFLOW_DIGEST = '407d5fa03b87292bb20e3cfc06188f6f7a0f32ec2fdbbb5ef18fdee1ddc5132a';
const EXPECTED_VENDOR_PROVENANCE_SHA256 = '92e9f60f34a8d279c6ad4d017a1adfa017bc79a814babee77b2ad82580cbe65f';
const COMPLEXITY_THRESHOLD = 20;
const PROCESS_TIMEOUT_MS = 60_000;
const PROCESS_STDOUT_LIMIT = 10_000_000;
const PROCESS_STDERR_LIMIT = 1_000_000;
const STATIC_AND_METADATA_BUDGET_MS = 30_000;
const COVERAGE_FILES = [
  'src/homeserver/errors.ts',
  'src/homeserver/task-type-identity.ts',
  'src/homeserver/image-sidecar.ts',
];
const EXPECTED_JOB_REFS = [refId('job-secret-scan'), refId('job-test')];
const JOB_NAME_TO_REF = {
  Gitleaks: refId('job-secret-scan'),
  'secret-scan': refId('job-secret-scan'),
  test: refId('job-test'),
};
const REASON_TEXT = {
  notCollected: 'not-collected',
  producerError: 'producer-error',
  incompleteInput: 'incomplete-input',
  scopeUnavailable: 'scope-unavailable',
};

function safeRelative(root, candidate) {
  const value = path.isAbsolute(candidate) ? path.relative(root, candidate) : candidate;
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '');
  if (!normalized || normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) {
    throw new TypeError('evidence path is outside the repository');
  }
  return normalized;
}

function sanitizeString(value, root = ROOT) {
  let output = String(value).replaceAll(root, '.').replaceAll(root.replaceAll('/', '\\'), '.');
  output = output.replace(/(?:\/Users|\/private\/tmp|\/tmp|\/home|\/var\/folders)\/[^\s:]+/g, '[absolute-path]');
  return output;
}

function sanitizeJson(value, root = ROOT) {
  if (typeof value === 'string') return sanitizeString(value, root);
  if (Array.isArray(value)) return value.map(item => sanitizeJson(item, root));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeJson(item, root)]));
  }
  return value;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function writeJson(outputRoot, relative, value) {
  const file = path.resolve(outputRoot, relative);
  if (!file.startsWith(`${path.resolve(outputRoot)}${path.sep}`)) throw new TypeError('artifact path escaped output directory');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(sanitizeJson(value), null, 2)}\n`, { mode: 0o600 });
}

async function writeText(outputRoot, relative, value) {
  const file = path.resolve(outputRoot, relative);
  if (!file.startsWith(`${path.resolve(outputRoot)}${path.sep}`)) throw new TypeError('artifact path escaped output directory');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, sanitizeString(value), { mode: 0o600 });
}

function collectReferences(value, result = new Set()) {
  if (typeof value === 'string' && /^ref:[a-z0-9][a-z0-9-]{0,95}$/.test(value)) result.add(value);
  else if (Array.isArray(value)) for (const item of value) collectReferences(item, result);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) collectReferences(item, result);
  return result;
}

function exactKeys(value, expected, description) {
  const actual = Object.keys(value ?? {}).sort();
  if (canonical(actual) !== canonical([...expected].sort())) throw new TypeError(`${description} keys do not match the v1 transport contract`);
}

async function validateEvidenceIndex(outputRoot, objective, evidenceRefs) {
  const unresolved = [...collectReferences(objective)].filter(reference => !evidenceRefs[reference]);
  if (unresolved.length) throw new TypeError(`objective references lack evidence-index entries: ${unresolved.join(', ')}`);
  for (const [reference, record] of Object.entries(evidenceRefs)) {
    if (!/^ref:[a-z0-9][a-z0-9-]{0,95}$/.test(reference)) throw new TypeError(`invalid evidence-index reference ${reference}`);
    if (record.kind === 'artifact-file') {
      exactKeys(record, ['kind', 'path'], 'artifact-file evidence');
      const relative = safeRelative('.', record.path);
      if (!relative.startsWith('evidence/') && !relative.startsWith('snapshots/')) throw new TypeError('artifact-file evidence path escapes its artifact namespace');
      await stat(path.resolve(outputRoot, relative));
    } else if (record.kind === 'source') {
      exactKeys(record, ['kind', 'path', 'line'], 'source evidence');
      const relative = safeRelative(ROOT, record.path);
      if (!Number.isSafeInteger(record.line) || record.line < 1) throw new TypeError('source evidence requires a positive line number');
      const sourceText = await readFile(path.resolve(ROOT, relative), 'utf8');
      if (record.line > sourceText.split('\n').length) throw new TypeError(`source evidence line is outside ${relative}`);
    } else if (record.kind === 'github-run') {
      exactKeys(record, ['kind', 'run_id', 'attempt'], 'GitHub run evidence');
      if (!Number.isSafeInteger(record.run_id) || record.run_id < 1 || !Number.isSafeInteger(record.attempt) || record.attempt !== 1) {
        throw new TypeError('GitHub run evidence requires positive run ID and first-attempt number');
      }
    } else throw new TypeError(`unsupported evidence-index kind for ${reference}`);
  }
}

export async function runProcess(command, args, {
  cwd = ROOT,
  extraEnv = {},
  timeoutMs = PROCESS_TIMEOUT_MS,
  deadline = Number.POSITIVE_INFINITY,
  sanitizeOutput = true,
} = {}) {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) return {
    exitCode: 124,
    stdout: '',
    stderr: 'collection budget exhausted before process start',
    elapsedMs: 0,
    errorName: 'TimeoutError',
    timedOut: true,
    stdoutTruncated: false,
    stderrTruncated: false,
  };
  timeoutMs = Math.max(1, Math.min(timeoutMs, remainingMs));
  const started = performance.now();
  const allowedEnv = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    CI: 'true',
    NODE_ENV: 'test',
    ...extraEnv,
  };
  return new Promise(resolve => {
    let stdout = '';
    let stderr = '';
    let spawnError = null;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    const child = spawn(command, args, { cwd, env: allowedEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes <= PROCESS_STDOUT_LIMIT) stdout += chunk;
      else if (!stdoutTruncated) {
        stdoutTruncated = true;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
      }
    });
    child.stderr.on('data', chunk => {
      stderrBytes += Buffer.byteLength(chunk);
      if (stderrBytes <= PROCESS_STDERR_LIMIT) stderr += chunk;
      else if (!stderrTruncated) {
        stderrTruncated = true;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
      }
    });
    child.on('error', error => { spawnError = error; });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
    }, timeoutMs);
    child.on('close', code => {
      clearTimeout(timeout);
      const terminate = stdoutTruncated || stderrTruncated;
      resolve({
        exitCode: timedOut || terminate ? 124 : (Number.isInteger(code) && code >= 0 ? code : 127),
        stdout: sanitizeOutput ? sanitizeString(stdout) : stdout,
        stderr: sanitizeOutput ? sanitizeString(stderr) : stderr,
        elapsedMs: Math.round(performance.now() - started),
        errorName: spawnError?.code ?? spawnError?.name ?? null,
        timedOut,
        stdoutTruncated,
        stderrTruncated,
      });
    });
  });
}

async function gitOutput(args, deadline = Number.POSITIVE_INFINITY) {
  const result = await runProcess('git', args, { deadline });
  if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed (${result.exitCode})`);
  return result.stdout;
}

async function repoHead(deadline) {
  const head = (await gitOutput(['rev-parse', 'HEAD'], deadline)).trim();
  if (!/^[a-f0-9]{40}$/.test(head)) throw new TypeError('checkout HEAD is not a full immutable SHA');
  return head;
}

async function sourceFiles(deadline) {
  const output = await gitOutput(['ls-files', '-z'], deadline);
  return output.split('\0').filter(Boolean).map(item => safeRelative(ROOT, item)).sort();
}

async function cleanTrackedWorktree(deadline) {
  return (await gitOutput(['status', '--porcelain', '--untracked-files=all'], deadline)).trim().length === 0;
}

async function fileDigest(relative) {
  return digest(await readFile(path.resolve(ROOT, relative)));
}

async function configDigest(relativeFiles, extra = {}) {
  const values = {};
  for (const relative of relativeFiles) values[relative] = digest(await readFile(path.resolve(ROOT, relative)));
  return digest({ files: values, extra });
}

async function verifiedToolVersion(manifestPath, packagePath, packageName, section = 'devDependencies') {
  const manifest = await readJson(path.resolve(ROOT, manifestPath));
  const installed = await readJson(path.resolve(ROOT, packagePath));
  const declaredVersion = manifest[section]?.[packageName];
  return assertToolVersion(packageName, declaredVersion, installed.version);
}

function currentPlatform() {
  const arch = os.arch() === 'x64' ? 'x64' : os.arch();
  const platform = process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win32' : 'linux';
  return `${platform}-${arch}`;
}

function makeMetricSource({ collectionRef, attempt, toolName, toolVersion, language, configDigestValue, scopeDigestValue, metricVersion, scopeVersion }) {
  return source({
    runRef: collectionRef,
    attempt,
    toolName,
    toolVersion,
    language,
    platform: currentPlatform(),
    metricVersion,
    scopeVersion,
    configDigest: configDigestValue,
    scopeDigest: scopeDigestValue,
  });
}

function aggregateResult(result, metricName) {
  const metric = result.aggregate?.metrics?.[metricName];
  return metric ? { status: metric.status, ...Object.fromEntries(Object.entries(metric).filter(([key]) => key !== 'status' && key !== 'source' && key !== 'population')) } : null;
}

function addRef(index, reference, record) {
  if (!/^ref:[a-z0-9][a-z0-9-]{0,95}$/.test(reference)) throw new TypeError(`invalid evidence reference ${reference}`);
  const existing = index[reference];
  if (existing && canonical(existing) !== canonical(record)) throw new TypeError(`evidence reference collision ${reference}`);
  index[reference] = record;
}

function addArtifactRef(index, reference, relativePath) {
  const file = safeRelative('.', relativePath);
  if (!file.startsWith('evidence/') && !file.startsWith('snapshots/')) {
    throw new TypeError('artifact-file evidence paths must stay inside the emitted artifact');
  }
  addRef(index, reference, { kind: 'artifact-file', path: file });
}

function addSourceRef(index, reference, relativePath, line) {
  addRef(index, reference, { kind: 'source', path: safeRelative(ROOT, relativePath), line });
}

function uncollectedMetric(name, observedAt, unit, reason = REASON_TEXT.notCollected) {
  return slot({ name, observedAt, status: 'unknown', unit, reason });
}

function failedMetric(name, observedAt, unit, reason = REASON_TEXT.producerError) {
  return slot({ name, observedAt, status: 'failed', unit, reason });
}

async function collectFunctionInventory(files, parserPath) {
  const parserModule = await import(pathToFileURL(parserPath));
  const parser = parserModule.default ?? parserModule;
  if (typeof parser.parse !== 'function') throw new TypeError('TypeScript parser has no parse export');
  const eligible = [];
  const errors = [];
  for (const relative of files) {
    try {
      const text = await readFile(path.resolve(ROOT, relative), 'utf8');
      const ast = parser.parse(text, {
        ecmaVersion: 2022,
        sourceType: 'module',
        loc: true,
        range: true,
        jsx: false,
        filePath: relative,
        tokens: false,
        comment: false,
        errorOnTypeScriptSyntacticAndSemanticIssues: false,
      });
      eligible.push({ path: relative, functions: countFunctionNodes(ast) });
    } catch (error) {
      errors.push({ path: relative, error: error?.name ?? 'ParseError', line: error?.loc?.line ?? null });
    }
  }
  return {
    files: eligible,
    eligibleFunctions: eligible.reduce((sum, file) => sum + file.functions, 0),
    parsedFiles: eligible.length,
    failedFiles: errors.length,
    errors,
  };
}

function safeLintEvidence(report, root) {
  return report.reports.map(file => ({
    path: safeRelative(root, file.filePath),
    error_count: file.errorCount,
    warning_count: file.warningCount,
    messages: (file.messages ?? []).map(message => ({
      rule_id: message.ruleId ?? null,
      severity: message.severity,
      line: message.line ?? null,
      column: message.column ?? null,
      message: sanitizeString(message.message, root),
    })),
  }));
}

export function inferTriage(row, priorTriage) {
  const candidates = priorTriage.candidates ?? [];
  const match = candidates.find(candidate => {
    if (candidate.candidate_type === 'unused-file') {
      return candidate.path === row.file && (row.kind === 'files' || row.kind === 'file');
    }
    if (candidate.candidate_type !== 'unused-export') return false;
    const at = candidate.path.lastIndexOf('@');
    const separator = candidate.path.lastIndexOf(':', at);
    if (separator < 1 || at <= separator + 1) return false;
    const file = candidate.path.slice(0, separator);
    const name = candidate.path.slice(separator + 1, at);
    const line = Number(candidate.path.slice(at + 1));
    return file === row.file && name === row.name && line === row.line && row.kind === 'exports';
  });
  return match ? {
    classification: match.classification,
    source_path: 'research/code-health-401/artifacts/knip-triage.json',
  } : { classification: 'unreviewed-candidate', source_path: null };
}

async function collectKnip({ outputRoot, observedAt, collectionRef, attempt, modified, evidenceRefs, deadline }) {
  const resultPath = 'evidence/unused/knip.json';
  const findingsPath = 'evidence/unused/findings.json';
  const scopePath = 'evidence/unused/scope.json';
  const command = path.resolve(ROOT, 'research/code-health-401/tooling/node_modules/.bin/knip');
  const knipVersion = await verifiedToolVersion(
    'research/code-health-401/tooling/package.json',
    'research/code-health-401/tooling/node_modules/knip/package.json',
    'knip',
  );
  const args = [
    '--config', 'research/code-health-401/knip-valid.json',
    '--tsConfig', 'tsconfig.json',
    '--include', 'files', '--include', 'dependencies', '--include', 'exports',
    '--reporter', 'json', '--no-progress', '--no-exit-code',
  ];
  const startedAt = isoSecond();
  const run = await runProcess(command, args, { deadline });
  let rows = null;
  let parseError = null;
  try {
    rows = normalizeKnipRows(JSON.parse(run.stdout));
    if (rows.length > 5000) throw new RangeError('Knip result exceeds the 5,000-row artifact bound');
  } catch (error) {
    parseError = error?.message ?? 'Knip output could not be parsed';
  }
  await writeJson(outputRoot, resultPath, {
    command: ['knip', ...args],
    exit_code: run.exitCode,
    elapsed_ms: run.elapsedMs,
    started_at: startedAt,
    parse_error: parseError,
    raw_report: rows === null ? null : sanitizeJson(JSON.parse(run.stdout)),
    stderr: run.stderr,
    spawn_error: run.errorName,
    stdout_truncated: run.stdoutTruncated,
    stderr_truncated: run.stderrTruncated,
    timed_out: run.timedOut,
  });

  const config = await readJson(path.resolve(ROOT, 'research/code-health-401/knip-valid.json'));
  const priorTriage = await readJson(path.resolve(ROOT, 'research/code-health-401/artifacts/knip-triage.json'));
  const findings = (rows ?? []).map((row, index) => {
    const candidateRef = refId(`knip-candidate-${index + 1}`);
    const sourcePathValue = row.file ? safeRelative(ROOT, row.file) : null;
    const line = row.line;
    if (sourcePathValue && Number.isSafeInteger(line) && line > 0) addSourceRef(evidenceRefs, candidateRef, sourcePathValue, line);
    else addArtifactRef(evidenceRefs, candidateRef, findingsPath);
    return {
      ref: candidateRef,
      kind: row.kind,
      path: sourcePathValue,
      name: row.name,
      line,
      owners: row.owners,
      parent_symbol: row.parent_symbol,
      triage: inferTriage({ ...row, file: sourcePathValue }, priorTriage),
      suppression_context: {
        knip_config: 'research/code-health-401/knip-valid.json',
        ignored_path_patterns: config.ignore ?? [],
        output_row_was_filtered: false,
      },
    };
  });
  const findingsEvidence = {
    status: run.exitCode === 0 && rows !== null ? 'complete-unqualified-graph' : 'failed',
    candidate_rows: rows === null ? null : findings,
    candidate_count: rows === null ? null : findings.length,
    graph_qualification: 'unqualified',
    graph_qualification_reason: 'The accepted #401 review found omitted operational entrypoints, tests, and dynamic consumers; raw candidates are investigation leads only.',
    prior_manual_triage: 'research/code-health-401/artifacts/knip-triage.json',
    ignored_path_patterns: config.ignore ?? [],
    configured_entrypoints: config.entry ?? [],
  };
  await writeJson(outputRoot, findingsPath, findingsEvidence);
  await writeJson(outputRoot, scopePath, {
    configured_entrypoints: config.entry ?? [],
    include: ['src/**/*.ts', 'scripts/**/*.ts', 'client/**/*.mjs'],
    ignored_path_patterns: config.ignore ?? [],
    graph_qualification: 'unqualified',
    excluded_consumer_classes: ['tests', 'operator entrypoints not validated by #401', 'dynamic consumers'],
  });
  const configHash = await configDigest([
    'research/code-health-401/knip-valid.json',
    'research/code-health-401/tooling/package-lock.json',
    'research/code-health-401/tooling/package.json',
  ], { parserConfig: 'normal-mode files,exports,dependencies; no production-only dead-code headline' });
  const scopeHash = digest({
    include: ['src/**/*.ts', 'scripts/**/*.ts', 'client/**/*.mjs'],
    explicitEntrypoints: 'research/code-health-401/knip-valid.json',
    excluded: config.ignore ?? [],
    graph: 'unqualified-until-owner-validates-all-runtime-operator-test-dynamic-consumers',
  });
  const analyzerComplete = analyzerStatus({
    exitCode: run.exitCode,
    parsed: rows !== null,
    truncated: run.stdoutTruncated || run.stderrTruncated,
    timedOut: run.timedOut,
  }) === 'complete';
  const isValid = analyzerComplete && !modified;
  const slotValue = slot({
    name: 'unused_candidates', observedAt, unit: 'candidates',
    status: isValid ? 'unknown' : 'failed',
    reason: isValid ? REASON_TEXT.incompleteInput : (modified ? REASON_TEXT.incompleteInput : REASON_TEXT.producerError),
    source: isValid ? makeMetricSource({
      collectionRef: refId(`${collectionRef.slice(4)}-knip`), attempt,
      toolName: 'knip', toolVersion: knipVersion, language: 'typescript',
      configDigestValue: configHash, scopeDigestValue: scopeHash,
      metricVersion: 'unused-candidates-v1', scopeVersion: 'knip-explicit-entrypoints-v1',
    }) : null,
    population: isValid ? {
      included_refs: [refId('inventory-unused-candidates')],
      excluded_refs: [refId('scope-tests-dynamic-and-operator-entrypoints')],
    } : null,
  });
  addArtifactRef(evidenceRefs, refId('inventory-unused-candidates'), findingsPath);
  addArtifactRef(evidenceRefs, refId(`${collectionRef.slice(4)}-knip`), resultPath);
  addArtifactRef(evidenceRefs, refId('scope-tests-dynamic-and-operator-entrypoints'), scopePath);
  addSourceRef(evidenceRefs, refId('unused-triage-source'), 'research/code-health-401/artifacts/knip-triage.json', 1);
  return { slot: slotValue, elapsedMs: run.elapsedMs, status: slotValue.status };
}

async function collectComplexity({ files, outputRoot, observedAt, collectionRef, attempt, modified, evidenceRefs, deadline }) {
  const scanPath = 'evidence/complexity/scan.json';
  const inventoryPath = 'evidence/complexity/inventory.json';
  const scopePath = 'evidence/complexity/scope.json';
  const parserPath = path.resolve(ROOT, 'research/code-health-401/tooling/node_modules/@typescript-eslint/parser/dist/index.js');
  const eslintVersion = await verifiedToolVersion(
    'research/code-health-401/tooling/package.json',
    'research/code-health-401/tooling/node_modules/eslint/package.json',
    'eslint',
  );
  const parserVersion = await verifiedToolVersion(
    'research/code-health-401/tooling/package.json',
    'research/code-health-401/tooling/node_modules/@typescript-eslint/parser/package.json',
    '@typescript-eslint/parser',
  );
  const parserStarted = performance.now();
  let inventory;
  let inventoryError = null;
  try {
    inventory = await collectFunctionInventory(files, parserPath);
  } catch (error) {
    inventoryError = error?.message ?? 'function inventory parser unavailable';
    inventory = { files: [], eligibleFunctions: null, parsedFiles: 0, failedFiles: files.length, errors: [] };
  }
  const parserElapsed = Math.round(performance.now() - parserStarted);
  await writeJson(outputRoot, inventoryPath, {
    include: ['src/**/*.ts', 'scripts/**/*.ts'],
    exclude: ['tests/**', 'research/**', 'benchmarks/**', 'gate-d/**', 'generated/**', 'declaration-only functions without executable bodies'],
    function_definition: 'FunctionDeclaration, FunctionExpression, and ArrowFunctionExpression nodes with executable bodies',
    parsed_files: inventory.parsedFiles,
    eligible_functions: inventory.eligibleFunctions,
    failed_files: inventory.errors,
    files: inventory.files,
    parser_error: inventoryError,
    elapsed_ms: parserElapsed,
  });
  await writeJson(outputRoot, scopePath, {
    include: ['src/**/*.ts', 'scripts/**/*.ts'],
    exclude: ['tests/**', 'research/**', 'benchmarks/**', 'gate-d/**', 'generated/**'],
    function_inventory: 'all tracked eligible files; executable function declarations, expressions, and arrows are counted once',
    construction_policy: 'tracked TypeScript inventory from git ls-files, parser failures invalidate the slot',
  });

  const command = path.resolve(ROOT, 'research/code-health-401/tooling/node_modules/.bin/eslint');
  const args = [
    '--config', 'research/code-health-401/eslint-correction.config.mjs',
    '--no-warn-ignored', '--format', 'json', ...files,
  ];
  const startedAt = isoSecond();
  const run = await runProcess(command, args, { deadline });
  let report = null;
  let reportError = null;
  try { report = parseEslintReport(run.stdout); }
  catch (error) { reportError = error?.message ?? 'ESLint output could not be parsed'; }
  const rawResults = report ? safeLintEvidence(report, ROOT) : null;
  await writeJson(outputRoot, scanPath, {
    command: ['eslint', ...args],
    exit_code: run.exitCode,
    elapsed_ms: run.elapsedMs,
    started_at: startedAt,
    result_files: rawResults,
    complexity_above_threshold: report?.complexityWarnings ?? null,
    parse_errors: report?.parseErrors ?? null,
    parse_error: reportError,
    parser_diagnostic: run.stderr,
    algorithm_detail: 'ESLint complexity rule with modified cyclomatic variant, threshold 20',
    stdout_truncated: run.stdoutTruncated,
    stderr_truncated: run.stderrTruncated,
    timed_out: run.timedOut,
    spawn_error: run.errorName,
  });
  const configHash = await configDigest([
    'research/code-health-401/eslint-correction.config.mjs',
    'research/code-health-401/tooling/package-lock.json',
    'research/code-health-401/tooling/package.json',
    'tsconfig.json',
  ], { threshold: COMPLEXITY_THRESHOLD, algorithm: 'eslint-modified-cyclomatic-v1' });
  const scopeHash = digest({
    include: ['src/**/*.ts', 'scripts/**/*.ts'],
    exclude: ['tests/**', 'research/**', 'benchmarks/**', 'gate-d/**', 'generated/**'],
    inventory: 'TypeScript parser counts executable function declarations, expressions, and arrows once',
  });
  const complete = analyzerStatus({
    exitCode: run.exitCode,
    parsed: report !== null && report.parseErrors.length === 0,
    truncated: run.stdoutTruncated || run.stderrTruncated,
    timedOut: run.timedOut,
  }) === 'complete'
    && report !== null && eslintInventoryComplete(report.reports, files, ROOT)
    && inventoryError === null && inventory.errors.length === 0 && inventory.parsedFiles === files.length && !modified;
  const complexitySummary = report && inventory.eligibleFunctions !== null
    ? summarizeComplexity({
      eligibleFunctions: inventory.eligibleFunctions,
      complexityValues: report.complexityWarnings.map(item => item.value),
      threshold: COMPLEXITY_THRESHOLD,
    })
    : null;
  const runRef = refId(`${collectionRef.slice(4)}-complexity`);
  const slotValue = complete
    ? slot({
      name: 'complex_functions', observedAt, status: 'measured', unit: 'functions',
      payload: {
      algorithm: 'cyclomatic-complexity-v1',
        threshold: COMPLEXITY_THRESHOLD,
        ...complexitySummary,
      },
      source: makeMetricSource({
        collectionRef: runRef, attempt, toolName: 'eslint-ts-parser',
        toolVersion: `eslint-${eslintVersion}_parser-${parserVersion}`,
        language: 'typescript', configDigestValue: configHash, scopeDigestValue: scopeHash,
        metricVersion: 'complex-functions-v1', scopeVersion: 'ts-executable-functions-v1',
      }),
      population: { included_refs: [refId('inventory-typescript-functions')], excluded_refs: [refId('scope-tests-and-non-typescript')] },
    })
    : slot({
      name: 'complex_functions', observedAt, status: 'failed', unit: 'functions',
      reason: modified || inventory.errors.length > 0 || inventoryError ? REASON_TEXT.incompleteInput : REASON_TEXT.producerError,
    });
  await writeJson(outputRoot, 'evidence/complexity/summary.json', {
    threshold: COMPLEXITY_THRESHOLD,
    strict_comparison: 'complexity > 20',
    eligible_function_count: complete ? inventory.eligibleFunctions : null,
    above_threshold_count: complete ? report.complexityWarnings.length : null,
    parser_file_count: inventory.parsedFiles,
    parse_failures: inventory.failedFiles,
    status: slotValue.status,
  });
  addArtifactRef(evidenceRefs, refId('inventory-typescript-functions'), inventoryPath);
  addArtifactRef(evidenceRefs, runRef, scanPath);
  addArtifactRef(evidenceRefs, refId('scope-tests-and-non-typescript'), scopePath);
  return { slot: slotValue, elapsedMs: run.elapsedMs + parserElapsed, status: slotValue.status };
}

async function collectCoverage({ outputRoot, observedAt, collectionRef, attempt, modified, evidenceRefs }) {
  const summaryPath = 'evidence/coverage/coverage-summary.json';
  const testOutputPath = 'evidence/coverage/test-output.txt';
  const scopePath = 'evidence/coverage/scope.json';
  const vitestVersion = await verifiedToolVersion(
    'research/code-health-401/coverage-tooling/package.json',
    'node_modules/vitest/package.json',
    'vitest', 'dependencies',
  );
  const providerVersion = await verifiedToolVersion(
    'research/code-health-401/coverage-tooling/package.json',
    'research/code-health-401/coverage-tooling/node_modules/@vitest/coverage-v8/package.json',
    '@vitest/coverage-v8', 'dependencies',
  );
  const scratchRoot = await mkdtemp(path.join(os.tmpdir(), 'code-health-402-vitest-'));
  const outputCoverageDir = path.resolve(scratchRoot, 'coverage');
  await rm(outputCoverageDir, { recursive: true, force: true });
  const command = path.resolve(ROOT, 'node_modules/.bin/vitest');
  const args = ['run', '--config', 'research/code-health-402/vitest.coverage.config.mjs'];
  const startedAt = isoSecond();
  const run = await runProcess(command, args, {
    extraEnv: { CODE_HEALTH_OUTPUT_DIR: scratchRoot },
    timeoutMs: 180_000,
  });
  await writeText(outputRoot, testOutputPath, `${run.stdout}\n${run.stderr}`);
  const configHash = await configDigest([
    'research/code-health-402/vitest.coverage.config.mjs',
    'research/code-health-402/coverage-scope.json',
    'research/code-health-401/coverage-tooling/package-lock.json',
    'research/code-health-401/coverage-tooling/package.json',
    'package-lock.json',
  ], { provider: `@vitest/coverage-v8@${providerVersion}`, vitest: vitestVersion, measure: 'lines' });
  const scopeHash = digest({
    policy: 'explicit source and test inventories declared in research/code-health-402/coverage-scope.json',
    inventoryConstruction: 'include every declared file, including unimported source; clean profile per invocation',
    inlineTests: false,
    unit: 'lines',
  });
  let summary = null;
  let error = null;
  try {
    summary = normalizeCoverageSummary(await readJson(path.join(outputCoverageDir, 'coverage-summary.json')), ROOT);
  } catch (caught) {
    error = caught?.message ?? 'coverage summary is unavailable';
  } finally {
    await rm(scratchRoot, { recursive: true, force: true });
  }
  if (summary) await writeJson(outputRoot, summaryPath, summary);
  else await writeJson(outputRoot, summaryPath, { status: 'unavailable', reason: error ?? 'coverage summary is missing', total: null, files: null });
  const isComplete = run.exitCode === 0 && summary !== null && !modified;
  let payload = null;
  if (isComplete) {
    try { payload = summarizeCoverage(summary, COVERAGE_FILES); }
    catch (caught) { error = caught?.message ?? 'coverage inventory did not match declaration'; }
  }
  const measured = isComplete && payload !== null;
  const runRef = refId(`${collectionRef.slice(4)}-coverage`);
  const slotValue = measured
    ? slot({
      name: 'coverage', observedAt, status: 'measured', unit: 'lines', payload,
        source: makeMetricSource({
        collectionRef: runRef, attempt, toolName: 'vitest-v8',
        toolVersion: `vitest-${vitestVersion}_coverage-v8-${providerVersion}`,
        language: 'typescript', configDigestValue: configHash, scopeDigestValue: scopeHash,
        metricVersion: 'coverage-lines-v1', scopeVersion: 'code-health-401-selected-typescript-scope-v1',
      }),
      population: { included_refs: [refId('inventory-coverage-typescript')], excluded_refs: [refId('scope-tests-and-unselected-source')] },
    })
    : slot({
      name: 'coverage', observedAt, status: 'failed', unit: 'lines',
      reason: modified ? REASON_TEXT.incompleteInput : (run.exitCode !== 0 || summary === null ? REASON_TEXT.producerError : REASON_TEXT.incompleteInput),
    });
  await writeJson(outputRoot, 'evidence/coverage/run.json', {
    command: ['vitest', ...args],
    exit_code: run.exitCode,
    elapsed_ms: run.elapsedMs,
    started_at: startedAt,
    summary_present: summary !== null,
    stdout_truncated: run.stdoutTruncated,
    stderr_truncated: run.stderrTruncated,
    timed_out: run.timedOut,
    spawn_error: run.errorName,
    coverage_error: error,
    tests: 'two declared tests in a clean, isolated V8 profile',
    status: slotValue.status,
  });
  await writeJson(outputRoot, 'evidence/coverage/inventory.json', {
    scope: 'research/code-health-402/coverage-scope.json',
    eligible_source_files: COVERAGE_FILES,
    rows: summary ? Object.entries(summary.files).map(([file, data]) => ({ path: file, lines: data.lines })) : null,
    complete_declared_inventory: measured,
  });
  await writeJson(outputRoot, scopePath, await readJson(path.resolve(ROOT, 'research/code-health-402/coverage-scope.json')));
  addArtifactRef(evidenceRefs, refId('inventory-coverage-typescript'), 'evidence/coverage/inventory.json');
  if (measured) addArtifactRef(evidenceRefs, refId('coverage-profile-clean'), summaryPath);
  addArtifactRef(evidenceRefs, runRef, testOutputPath);
  addArtifactRef(evidenceRefs, refId('scope-tests-and-unselected-source'), scopePath);
  return { slot: slotValue, elapsedMs: run.elapsedMs, status: slotValue.status };
}

async function sourceContext({ files, outputRoot, observedAt, deadline }) {
  const sourceSpecs = [
    { language: 'typescript', predicate: file => /^(src|scripts)\/.+\.ts$/.test(file) },
    { language: 'mjs', predicate: file => /^(client|scripts)\/.+\.mjs$/.test(file) },
    { language: 'shell', predicate: file => /^scripts\/.+\.sh$/.test(file) },
    { language: 'python', predicate: file => /^scripts\/.+\.py$/.test(file) },
  ];
  const languageCounts = [];
  const missing = [];
  for (const spec of sourceSpecs) {
    const selected = files.filter(spec.predicate);
    let bytes = 0;
    const missingBefore = missing.length;
    for (const file of selected) {
      try { bytes += (await stat(path.resolve(ROOT, file))).size; }
      catch { missing.push(file); }
    }
    languageCounts.push({
      language: spec.language,
      tracked_files: selected.length,
      source_bytes: missing.length === missingBefore ? bytes : null,
      inventory_complete: missing.length === missingBefore,
    });
  }
  const churnStart = new Date(Date.parse(observedAt) - 30 * 86400000);
  const changelog = await runProcess('git', [
    'log', '--since', isoSecond(churnStart), '--no-renames', '--format=commit:%H', '--numstat',
    '--', 'src', 'scripts', 'client',
  ], { deadline });
  let commits = 0;
  let touchedFiles = 0;
  let additions = 0;
  let deletions = 0;
  let binaryEntries = 0;
  for (const line of changelog.stdout.split('\n')) {
    if (line.startsWith('commit:')) { commits += 1; continue; }
    const match = line.match(/^(\d+|-)\s+(\d+|-)\s+(.+)$/);
    if (!match) continue;
    touchedFiles += 1;
    if (match[1] === '-' || match[2] === '-') binaryEntries += 1;
    else { additions += Number(match[1]); deletions += Number(match[2]); }
  }
  const changeFrequency = changelog.exitCode === 0 ? {
    status: 'measured',
    window_start: isoSecond(churnStart),
    window_end: observedAt,
    policy: 'git log --numstat with --no-renames; each path row is counted; binary deltas remain unquantified',
    commits,
    changed_path_rows: touchedFiles,
    additions,
    deletions,
    binary_entries_unquantified: binaryEntries,
  } : {
    status: 'failed',
    reason: 'git-log-failed',
    window_start: isoSecond(churnStart),
    window_end: observedAt,
    commits: null,
    changed_path_rows: null,
    additions: null,
    deletions: null,
    binary_entries_unquantified: null,
  };
  const result = {
    as_of: observedAt,
    source_roots: ['src/**/*.ts', 'scripts/**/*.ts', 'client/**/*.mjs', 'scripts/**/*.mjs', 'scripts/**/*.sh', 'scripts/**/*.py'],
    languages: languageCounts,
    missing_tracked_files: missing,
    change_frequency: changeFrequency,
    source_size_and_change_frequency_are_context_only: true,
  };
  await writeJson(outputRoot, 'evidence/source-context.json', result);
  return { result };
}

async function gitWorkflowDigest(commit, deadline) {
  const run = await runProcess('git', ['show', `${commit}:.github/workflows/ci.yml`], { sanitizeOutput: false, deadline });
  if (run.exitCode !== 0) throw new Error(`pinned CI workflow is absent at ${commit}`);
  return createHash('sha256').update(run.stdout).digest('hex');
}

async function collectCi({ outputRoot, observedAt, collectionRef, attempt, token, evidenceRefs, deadline }) {
  const inventoryPath = 'evidence/ci/inventory.json';
  const detailsPath = 'evidence/ci/first-attempt-details.json';
  await writeJson(outputRoot, detailsPath, { status: 'not-collected', first_attempts: null });
  const startDate = new Date(Date.parse(observedAt) - 28 * 86400000);
  const start = isoSecond(startDate);
  const end = observedAt;
  const configHash = digest({
    workflow: EXPECTED_CI_WORKFLOW_DIGEST,
    expectedJobs: EXPECTED_JOB_REFS,
    displayedJobNameMap: JOB_NAME_TO_REF,
    query: { branch: 'main', event: 'push', windowDays: 28, firstAttemptOnly: true },
  });
  const scopeHash = digest({
    workflow: '.github/workflows/ci.yml',
    branch: 'main', event: 'push', window: '[start,end)',
    jobs: EXPECTED_JOB_REFS,
    inventory: 'complete Actions workflow run enumeration; no retry substitution; workflow config pinned by SHA-256',
  });
  if (!token) {
    await writeJson(outputRoot, inventoryPath, { status: 'not-collected', reason: 'read-only GitHub Actions token is unavailable', window_start: start, window_end: end, runs: null });
    await writeJson(outputRoot, detailsPath, { status: 'not-collected', reason: 'read-only GitHub Actions token is unavailable', first_attempts: null });
    return { slot: uncollectedMetric('ci_first_attempt', observedAt, 'runs'), elapsedMs: 0, status: 'unknown' };
  }
  if (await fileDigest('.github/workflows/ci.yml') !== EXPECTED_CI_WORKFLOW_DIGEST) {
    await writeJson(outputRoot, inventoryPath, {
      status: 'scope-unavailable', reason: 'the CI workflow changed; update the pinned workflow digest and begin a reviewed series',
      expected_digest: EXPECTED_CI_WORKFLOW_DIGEST, current_digest: await fileDigest('.github/workflows/ci.yml'),
      window_start: start, window_end: end, runs: null,
    });
    await writeJson(outputRoot, detailsPath, { status: 'scope-unavailable', reason: 'the current CI workflow differs from the pinned cohort', first_attempts: null });
    return { slot: slot({ name: 'ci_first_attempt', observedAt, status: 'unknown', unit: 'runs', reason: REASON_TEXT.scopeUnavailable }), elapsedMs: 0, status: 'unknown' };
  }
  const began = performance.now();
  const collectionDeadline = deadline ?? (Date.now() + STATIC_AND_METADATA_BUDGET_MS);
  try {
    const enumeration = await enumerateWorkflowRuns({
      token, owner: 'Magnus-Gille', repo: 'gille-inference', workflow: 'ci.yml', start, end,
      deadline: collectionDeadline,
    });
    const configCache = new Map();
    const configForCommit = async sha => {
      if (Date.now() >= collectionDeadline) throw new Error('CI collection time budget exhausted while verifying workflow history');
      if (!configCache.has(sha)) configCache.set(sha, await gitWorkflowDigest(sha, collectionDeadline));
      return configCache.get(sha);
    };
    const selectedForAttempts = [];
    const configurationExcluded = [];
    for (const run of enumeration.windowRuns) {
      const pinned = await configForCommit(run.head_sha);
      if (pinned === EXPECTED_CI_WORKFLOW_DIGEST) selectedForAttempts.push(run);
      else configurationExcluded.push({ run_id: Number(run.id), commit_sha: run.head_sha, created_at: isoSecond(new Date(run.created_at)), reason: 'workflow-definition-changed' });
    }
    const attempts = new Map();
    const attemptErrors = [];
    for (const run of selectedForAttempts) {
      try {
        attempts.set(Number(run.id), await getFirstAttempt({
          token, owner: 'Magnus-Gille', repo: 'gille-inference', runId: run.id, deadline: collectionDeadline,
        }));
      } catch (error) {
        attempts.set(Number(run.id), null);
        attemptErrors.push({ run_id: Number(run.id), attempt: 1, error: error?.name ?? 'ApiError', status: Number.isInteger(error?.status) ? error.status : null });
      }
    }
    const complete = await buildFirstAttemptEvidence({
      enumeration, attempts, workflowConfigForCommit: configForCommit,
      expectedWorkflowDigest: EXPECTED_CI_WORKFLOW_DIGEST,
      expectedJobRefs: EXPECTED_JOB_REFS, jobNameToRef: JOB_NAME_TO_REF,
      start, end,
    });
    complete.evidence.workflow_config_cohorts = configurationExcluded;
    complete.evidence.first_attempt_fetch_errors = attemptErrors;
    complete.evidence.attempt_evidence_complete = attemptErrors.length === 0;
    const unclassifiableFailures = unclassifiableKnownFailures(complete.evidence.runs, complete.runs);
    const runInventoryRef = refId(`${collectionRef.slice(4)}-ci-inventory`);
    const payload = ciPayload({
      runs: complete.runs,
      workflowRef: refId('workflow-ci-yml-main-v1'),
      workflowDigest: EXPECTED_CI_WORKFLOW_DIGEST,
      expectedJobRefs: EXPECTED_JOB_REFS,
      start, end,
      inventoryRef: runInventoryRef,
    });
    await writeJson(outputRoot, inventoryPath, {
      ...complete.evidence,
      window_start: start,
      window_end: end,
      complete_run_enumeration: true,
      unclassifiable_known_failures: unclassifiableFailures,
      denominator: complete.runs.reduce((count, run) => count + ['success', 'failure', 'infra_failure'].includes(run.overall_conclusion), 0),
      denominator_policy: 'success + failure + source-attributed infra_failure; workflow-level failures without expected job results remain unknown',
    });
    await writeJson(outputRoot, detailsPath, {
      first_attempts: complete.evidence.runs,
      retry_policy: 'always request attempt 1; latest attempt is retained as context only',
      provider_conclusion_mapping: {
        success: 'success',
        failure: 'failure',
        timed_out: 'failure',
        startup_failure: 'failure when returned for an expected job; workflow-level result without jobs remains unknown',
        cancelled: 'cancelled',
        skipped: 'skipped',
        action_required: 'unknown',
        neutral: 'unknown',
        stale: 'unknown',
        other: 'unknown; provider raw value is retained',
        infra_failure: 'unknown unless separately supported by source evidence',
      },
      unknown_capability_reason: 'The frozen cohort can classify expected job results but cannot assign a workflow-level failure when no expected jobs were created.',
      unclassifiable_known_failures: unclassifiableFailures,
    });
    const runRef = refId(`${collectionRef.slice(4)}-ci`);
    const slotValue = slot({
      name: 'ci_first_attempt', observedAt, status: 'measured', unit: 'runs', payload,
      source: makeMetricSource({
        collectionRef: runRef, attempt, toolName: 'github-actions-api', toolVersion: '2022-11-28',
        language: 'typescript', configDigestValue: configHash, scopeDigestValue: scopeHash,
        metricVersion: 'ci-first-attempt-v1', scopeVersion: 'main-push-ci-v1',
      }),
      population: {
        included_refs: [runInventoryRef],
        excluded_refs: configurationExcluded.length ? [refId(`${collectionRef.slice(4)}-other-workflow-versions`)] : [],
      },
    });
    addArtifactRef(evidenceRefs, runInventoryRef, inventoryPath);
    addArtifactRef(evidenceRefs, refId(`${collectionRef.slice(4)}-other-workflow-versions`), inventoryPath);
    addArtifactRef(evidenceRefs, runRef, detailsPath);
    addSourceRef(evidenceRefs, refId('workflow-ci-yml-main-v1'), '.github/workflows/ci.yml', 1);
    for (const jobRef of EXPECTED_JOB_REFS) addArtifactRef(evidenceRefs, jobRef, detailsPath);
    for (const run of complete.runs) {
      const runId = Number(run.run_ref.match(/gha-run-(\d+)-attempt-1/)?.[1]);
      if (Number.isSafeInteger(runId) && runId > 0) addRef(evidenceRefs, run.run_ref, { kind: 'github-run', run_id: runId, attempt: 1 });
    }
    return { slot: slotValue, elapsedMs: Math.round(performance.now() - began), status: 'measured' };
  } catch (error) {
    await writeJson(outputRoot, inventoryPath, {
      status: 'failed',
      reason: sanitizeString(error?.message ?? 'CI collection failed'),
      window_start: start,
      window_end: end,
      complete_run_enumeration: false,
      runs: null,
    });
    await writeJson(outputRoot, detailsPath, {
      status: 'failed',
      reason: sanitizeString(error?.message ?? 'CI first-attempt evidence unavailable'),
      first_attempts: null,
    });
    return {
      slot: failedMetric('ci_first_attempt', observedAt, 'runs', error?.message?.includes('workflow') ? REASON_TEXT.scopeUnavailable : REASON_TEXT.producerError),
      elapsedMs: Math.round(performance.now() - began),
      status: 'failed',
    };
  }
}

export async function checkVendorContract(contractRoot = CONTRACT_ROOT) {
  const provenanceBytes = await readFile(path.resolve(contractRoot, 'contract-provenance.json'));
  if (digest(provenanceBytes) !== EXPECTED_VENDOR_PROVENANCE_SHA256) throw new Error('vendored contract provenance digest mismatch');
  const manifest = JSON.parse(provenanceBytes.toString('utf8'));
  if (manifest.contract_version !== '1.0' || manifest.source_repository !== 'Magnus-Gille/grimnir'
    || manifest.source_revision !== '7df005ce952a52816597d9888da977d689a631fd' || manifest.files.length !== 10) {
    throw new Error('vendored contract provenance does not identify the frozen shared contract');
  }
  for (const item of manifest.files) {
    const actual = digest(await readFile(path.resolve(contractRoot, item.path)));
    if (actual !== item.sha256) throw new Error(`vendored contract file hash mismatch: ${item.path}`);
  }
  return manifest;
}

export function reportMarkdown({ objective, aggregate, sourceContextData, timings, errors, staticRequested, reportStatus, staticMetadataElapsedMs, coverageElapsedMs }) {
  const metrics = objective.metrics;
  const lines = [
    '# Code health v1 report',
    '',
    `Repository: ${objective.repository.owner}/${objective.repository.name}`,
    `Commit: ${objective.commit}`,
    `Snapshot: ${objective.snapshot_id}`,
    `Collected: ${objective.observed_at}`,
    `Report status: ${reportStatus}`,
    `Static collection requested: ${staticRequested ? 'yes' : 'no'}`,
    `Static and metadata wall time: ${staticMetadataElapsedMs} ms / ${STATIC_AND_METADATA_BUDGET_MS} ms (${staticMetadataElapsedMs <= STATIC_AND_METADATA_BUDGET_MS ? 'within budget' : 'over budget'}).`,
    `Scoped coverage wall time: ${coverageElapsedMs ?? 'not collected'} ms (pilot cap 180,000 ms).`,
    '',
    '| Metric | State | Evidence |',
    '| --- | --- | --- |',
    `| Complex functions | ${metrics.complex_functions.status} | ${staticRequested ? 'evidence/complexity/summary.json' : 'not collected (static cadence)'} |`,
    `| Unused candidates | ${metrics.unused_candidates.status} | ${staticRequested ? 'evidence/unused/findings.json — graph remains unqualified' : 'not collected (static cadence)'} |`,
    `| Scoped coverage | ${metrics.coverage.status} | ${staticRequested ? 'evidence/coverage/coverage-summary.json' : 'not collected (static cadence)'} |`,
    `| First-attempt main CI | ${metrics.ci_first_attempt.status} | evidence/ci/inventory.json |`,
    `| Confirmed regressions | ${metrics.confirmed_regressions.status} | evidence/release-regression-survey.json |`,
    '',
    'No cross-language score, automatic cleanup, or gate is derived from this report.',
    'A missing reading is not zero. The only objective counts are exposed when their source inventory is complete.',
    '',
    '## CI denominator',
    '',
  ];
  const ci = aggregate.metrics.ci_first_attempt;
  if (ci.status === 'measured') {
    lines.push(`First-attempt success: ${ci.numerator}/${ci.denominator}; fraction: ${ci.fraction === null ? 'not defined' : ci.fraction.toFixed(4)}.`);
    lines.push(`Expected run inventory: ${ci.expected_runs}; sparse: ${ci.sparse ? 'yes' : 'no'}.`);
    lines.push(`Run outcomes: ${JSON.stringify(ci.counts_by_conclusion)}.`);
    lines.push(`Job outcomes: ${JSON.stringify(ci.job_counts_by_conclusion)}.`);
  } else {
    lines.push(`CI denominator is unavailable because the slot is ${ci.status}. See evidence/ci/inventory.json.`);
  }
  lines.push('', '## Source-size and change-frequency context', '', 'These counts are context only and are not folded into a quality score.', '');
  for (const entry of sourceContextData.languages) {
    const bytes = entry.inventory_complete ? `${entry.source_bytes} bytes` : 'bytes unavailable because the inventory is incomplete';
    lines.push(`- ${entry.language}: ${entry.tracked_files} tracked files, ${bytes}.`);
  }
  const changes = sourceContextData.change_frequency;
  if (changes.status === 'measured') {
    lines.push(`- Last 30 days: ${changes.commits} commits, ${changes.changed_path_rows} changed-path rows, +${changes.additions}/-${changes.deletions} text lines; ${changes.binary_entries_unquantified} binary rows unquantified.`);
  } else lines.push('- Last 30 days: change-frequency evidence unavailable.');
  lines.push('', '## Incremental wall time', '');
  for (const item of timings) lines.push(`- ${item.name}: ${item.elapsed_ms} ms, state ${item.status}.`);
  if (errors.length) {
    lines.push('', '## Collection diagnostics', '');
    for (const error of errors) lines.push(`- ${error}`);
  }
  lines.push('', 'Raw evidence paths are relative to this artifact and indexed by `evidence-index.json`.', '');
  return `${lines.join('\n')}\n`;
}

async function ensureArtifactOutput(outputRoot) {
  const absolute = path.resolve(outputRoot);
  if (absolute === ROOT || absolute.startsWith(`${ROOT}${path.sep}`)) {
    throw new TypeError('artifact output directory must be outside the source repository');
  }
  await mkdir(absolute, { recursive: true, mode: 0o700 });
  const resolved = await realpath(absolute);
  if (resolved === ROOT || resolved.startsWith(`${ROOT}${path.sep}`)) {
    throw new TypeError('artifact output directory must be outside the source repository');
  }
  await mkdir(path.join(resolved, 'snapshots'), { recursive: true, mode: 0o700 });
  await mkdir(path.join(resolved, 'evidence'), { recursive: true, mode: 0o700 });
  return resolved;
}

async function collectWithFallback({ name, unit, observedAt, outputRoot, evidenceRefs, collectMetric }) {
  const started = performance.now();
  try {
    return await collectMetric();
  } catch (error) {
    const relative = `evidence/${name}/collector-error.json`;
    const reference = refId(`${name}-collector-error`);
    await writeJson(outputRoot, relative, {
      status: 'failed',
      error_name: error?.name ?? 'Error',
      error: sanitizeString(error?.message ?? 'metric collection failed'),
    });
    addArtifactRef(evidenceRefs, reference, relative);
    return {
      slot: failedMetric(name, observedAt, unit),
      elapsedMs: Math.round(performance.now() - started),
      status: 'failed',
    };
  }
}

export async function collect({
  outputDir,
  collectStatic = false,
  token = process.env.CODE_HEALTH_GITHUB_TOKEN ?? null,
  now = new Date(),
  runId = process.env.GITHUB_RUN_ID ?? null,
  attempt = Number(process.env.GITHUB_RUN_ATTEMPT ?? 1),
}) {
  if (!outputDir) throw new TypeError('pass --output <directory> to keep generated evidence outside tracked sources');
  await checkVendorContract();
  const outputRoot = await ensureArtifactOutput(outputDir);
  const errors = [];
  const timings = [];
  const evidenceRefs = {};
  const pilotStarted = performance.now();
  const pilotDeadline = Date.now() + STATIC_AND_METADATA_BUDGET_MS;
  const commit = await repoHead(pilotDeadline);
  const observedAt = isoSecond(now);
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new TypeError('collector attempt must be a positive integer');
  const providerRunId = runId === null ? null : Number(runId);
  if (providerRunId !== null && (!Number.isSafeInteger(providerRunId) || providerRunId < 1)) throw new TypeError('GitHub run ID must be a positive integer');
  const runSlug = providerRunId !== null ? `gha-${providerRunId}` : `local-${Date.parse(observedAt)}`;
  const collectionRef = refId(`collection-${runSlug}-${attempt}`);
  const sourceList = await sourceFiles(pilotDeadline);
  const tsFiles = sourceList.filter(file => /^(src|scripts)\/.+\.ts$/.test(file));
  const trackedClean = await cleanTrackedWorktree(pilotDeadline);
  if (!trackedClean) errors.push('Tracked worktree changes were present; source-based slots are withheld.');
  const contextStarted = performance.now();
  const context = await sourceContext({ files: sourceList, outputRoot, observedAt, deadline: pilotDeadline });
  const contextElapsedMs = Math.round(performance.now() - contextStarted);
  timings.push({ name: 'Source size and 30-day churn context', elapsed_ms: contextElapsedMs, status: context.result.change_frequency.status });
  addArtifactRef(evidenceRefs, refId('source-size-and-change-context'), 'evidence/source-context.json');
  await writeJson(outputRoot, 'evidence/collector-run.json', {
    collection_ref: collectionRef,
    collector_attempt: attempt,
    observed_at: observedAt,
    commit_sha: commit,
    tracked_worktree_clean: trackedClean,
    node_version: process.version,
    platform: currentPlatform(),
    static_collection_requested: collectStatic,
    static_and_metadata_budget_ms: STATIC_AND_METADATA_BUDGET_MS,
    source_roots: ['src/**/*.ts', 'scripts/**/*.ts', 'client/**/*.mjs', 'scripts/**/*.mjs', 'scripts/**/*.sh', 'scripts/**/*.py'],
    generated_by: 'gille-inference code-health-402 informational producer',
  });
  addArtifactRef(evidenceRefs, collectionRef, 'evidence/collector-run.json');

  let complexMetric;
  let unusedMetric;
  let coverageMetric;
  if (!collectStatic) {
    complexMetric = uncollectedMetric('complex_functions', observedAt, 'functions');
    unusedMetric = uncollectedMetric('unused_candidates', observedAt, 'candidates');
    coverageMetric = uncollectedMetric('coverage', observedAt, 'lines');
  } else {
    const complexity = await collectWithFallback({
      name: 'complex_functions', unit: 'functions', observedAt, outputRoot, evidenceRefs,
      collectMetric: () => collectComplexity({
        files: tsFiles, outputRoot, observedAt, collectionRef, attempt, modified: !trackedClean, evidenceRefs, deadline: pilotDeadline,
      }),
    });
    complexMetric = complexity.slot;
    timings.push({ name: 'ESLint and TypeScript function inventory', elapsed_ms: complexity.elapsedMs, status: complexity.status });
    if (complexity.status !== 'measured') errors.push(`Complexity collection state: ${complexity.status}.`);

    const unused = await collectWithFallback({
      name: 'unused_candidates', unit: 'candidates', observedAt, outputRoot, evidenceRefs,
      collectMetric: () => collectKnip({
        outputRoot, observedAt, collectionRef, attempt, modified: !trackedClean, evidenceRefs, deadline: pilotDeadline,
      }),
    });
    unusedMetric = unused.slot;
    timings.push({ name: 'Knip candidate exploration', elapsed_ms: unused.elapsedMs, status: unused.status });
    if (unused.status === 'failed') errors.push('Knip candidate extraction failed; raw graph output is retained where available.');
  }

  const ci = await collectCi({ outputRoot, observedAt, collectionRef, attempt, token, evidenceRefs, deadline: pilotDeadline });
  timings.push({ name: 'GitHub Actions 28-day first-attempt cohort', elapsed_ms: ci.elapsedMs, status: ci.status });
  if (ci.status !== 'measured') errors.push(`CI collection state: ${ci.status}.`);
  const staticMetadataElapsedMs = Math.round(performance.now() - pilotStarted);
  if (staticMetadataElapsedMs > STATIC_AND_METADATA_BUDGET_MS) errors.push(`Static and metadata collection exceeded the ${STATIC_AND_METADATA_BUDGET_MS} ms pilot budget.`);

  if (collectStatic) {
    const coverage = await collectWithFallback({
      name: 'coverage', unit: 'lines', observedAt, outputRoot, evidenceRefs,
      collectMetric: () => collectCoverage({ outputRoot, observedAt, collectionRef, attempt, modified: !trackedClean, evidenceRefs }),
    });
    coverageMetric = coverage.slot;
    timings.push({ name: 'Scoped Vitest/V8 coverage', elapsed_ms: coverage.elapsedMs, status: coverage.status });
    if (coverage.status !== 'measured') errors.push(`Coverage collection state: ${coverage.status}.`);
  } else coverageMetric = uncollectedMetric('coverage', observedAt, 'lines');

  const releaseEvidencePath = 'evidence/release-regression-survey.json';
  await writeJson(outputRoot, releaseEvidencePath, {
    status: 'unknown',
    reason: 'No complete, reviewed release cohort survey is registered for this producer.',
    release_inventory_complete: false,
    issue_survey_complete: false,
    record_contract: 'research/code-health-402/release-regression-record.md',
    observed_at: observedAt,
  });
  const regressionsMetric = uncollectedMetric('confirmed_regressions', observedAt, 'regressions');

  const objective = {
    contract_version: '1.0',
    snapshot_id: refId(`objective-${commit.slice(0, 12)}-${Date.parse(observedAt)}`),
    supersedes_ref: null,
    correction_ref: null,
    repository: { owner: 'Magnus-Gille', name: 'gille-inference' },
    commit,
    observed_at: observedAt,
    metrics: {
      complex_functions: complexMetric,
      unused_candidates: unusedMetric,
      coverage: coverageMetric,
      ci_first_attempt: ci.slot,
      confirmed_regressions: regressionsMetric,
    },
  };
  const schema = await readJson(path.resolve(CONTRACT_ROOT, 'docs/code-health-objective-v1.schema.json'));
  const { validateObjective } = await import(pathToFileURL(path.resolve(CONTRACT_ROOT, 'scripts/lib/code-health-objective.mjs')));
  const validation = validateObjective(schema, objective);
  if (!validation.valid) {
    await writeJson(outputRoot, 'evidence/objective-validation-error.json', validation);
    throw new Error(`objective contract conformance failed: ${[...validation.schemaErrors, ...validation.semanticErrors].join('; ')}`);
  }
  const snapshotPath = 'snapshots/objective-v1.json';
  await writeJson(outputRoot, snapshotPath, objective);
  addArtifactRef(evidenceRefs, objective.snapshot_id, snapshotPath);
  addArtifactRef(evidenceRefs, refId('release-regression-survey'), releaseEvidencePath);
  addSourceRef(evidenceRefs, refId('release-regression-record-contract'), 'research/code-health-402/release-regression-record.md', 1);

  const slots = await readJson(path.resolve(ROOT, 'research/code-health-402/slots.json'));
  const sourceText = await readFile(path.resolve(ROOT, 'research/code-health-402/slots.json'), 'utf8');
  for (const metric of Object.keys(objective.metrics)) {
    const id = objective.metrics[metric].slot_ref;
    const marker = `"slot_ref": "${id}"`;
    const markerOffset = sourceText.indexOf(marker);
    if (markerOffset < 0) throw new Error(`registered objective slot marker missing: ${id}`);
    const line = sourceText.slice(0, markerOffset).split('\n').length;
    if (!slots.slots.some(entry => entry.slot_ref === id)) throw new Error(`registered objective slot missing: ${id}`);
    addSourceRef(evidenceRefs, id, 'research/code-health-402/slots.json', line);
  }
  // Also index every stable expected job identity to its run/job evidence file.
  for (const jobRef of EXPECTED_JOB_REFS) addArtifactRef(evidenceRefs, jobRef, 'evidence/ci/first-attempt-details.json');
  await validateEvidenceIndex(outputRoot, objective, evidenceRefs);
  await writeJson(outputRoot, 'evidence-index.json', { version: '1.0', refs: evidenceRefs });
  const manifest = {
    contract_version: '1.0',
    repo_owner: 'Magnus-Gille',
    repo_name: 'gille-inference',
    commit_sha: commit,
    snapshots: [snapshotPath],
    evidence_index: 'evidence-index.json',
  };
  exactKeys(manifest, ['contract_version', 'repo_owner', 'repo_name', 'commit_sha', 'snapshots', 'evidence_index'], 'code-health manifest');
  await writeJson(outputRoot, 'manifest.json', manifest);
  const reportStatus = Object.values(validation.aggregate.metrics).every(metric => metric.status === 'measured') ? 'complete' : 'partial';
  const coverageElapsedMs = timings.find(item => item.name === 'Scoped Vitest/V8 coverage')?.elapsed_ms ?? null;
  await writeText(outputRoot, 'report.md', reportMarkdown({
    objective,
    aggregate: validation.aggregate,
    sourceContextData: context.result,
    timings,
    errors,
    staticRequested: collectStatic,
    reportStatus,
    staticMetadataElapsedMs,
    coverageElapsedMs,
  }));
  await writeJson(outputRoot, 'evidence/overhead.json', {
    observed_at: observedAt,
    measurements: timings,
    budget: {
      static_and_metadata_ms: STATIC_AND_METADATA_BUDGET_MS,
      coverage_ms: 180_000,
      static_and_metadata_elapsed_ms: staticMetadataElapsedMs,
      static_and_metadata_within_budget: staticMetadataElapsedMs <= STATIC_AND_METADATA_BUDGET_MS,
      coverage_elapsed_ms: coverageElapsedMs,
      source: 'provisional gille-inference #402 pilot budget',
    },
    report_status: reportStatus,
  });
  await checkVendorContract();
  return { objective, manifest, aggregate: validation.aggregate, errors, outputRoot, reportStatus, staticMetadataElapsedMs, coverageElapsedMs };
}

function parseArgs(args) {
  const result = { outputDir: null, collectStatic: process.env.CODE_HEALTH_COLLECT_STATIC === 'true' };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--output') result.outputDir = args[++index] ?? null;
    else if (args[index] === '--static') result.collectStatic = true;
    else if (args[index] === '--ci-only') result.collectStatic = false;
    else throw new TypeError(`unknown argument ${args[index]}`);
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = await collect(parseArgs(process.argv.slice(2)));
    process.stdout.write(`code-health v1 artifact written to ${path.relative(ROOT, result.outputRoot)}\n`);
    process.stdout.write(`report_status=${result.reportStatus}; objective=${result.objective.snapshot_id}; states=${JSON.stringify(result.aggregate.state_counts)}\n`);
  } catch (error) {
    process.stderr.write(`${error?.message ?? 'code-health producer failed'}\n`);
    process.exitCode = 1;
  }
}
