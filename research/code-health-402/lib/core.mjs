import { createHash } from 'node:crypto';
import path from 'node:path';

export const METRIC_NAMES = [
  'complex_functions',
  'unused_candidates',
  'coverage',
  'ci_first_attempt',
  'confirmed_regressions',
];

export const CI_CONCLUSIONS = [
  'success', 'failure', 'infra_failure', 'cancelled', 'skipped', 'pending', 'unknown',
];

const CI_PRIORITY = [
  'failure', 'infra_failure', 'unknown', 'pending', 'cancelled', 'skipped', 'success',
];

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function digest(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : canonical(value));
  return createHash('sha256').update(bytes).digest('hex');
}

export function refId(value) {
  const slug = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 92);
  if (!slug || !/^[a-z0-9]/.test(slug)) throw new TypeError('reference id needs a stable alphanumeric slug');
  return `ref:${slug}`;
}

export function isoSecond(date = new Date()) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function countFunctionNodes(ast) {
  let count = 0;
  const stack = [ast];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type) && node.body) {
      count += 1;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'parent' || key === 'tokens' || key === 'comments') continue;
      if (Array.isArray(value)) {
        for (let index = value.length - 1; index >= 0; index -= 1) stack.push(value[index]);
      } else if (value && typeof value === 'object') stack.push(value);
    }
  }
  return count;
}

export function analyzerStatus({ exitCode, parsed, truncated = false, timedOut = false }) {
  return exitCode === 0 && parsed && !truncated && !timedOut ? 'complete' : 'failed';
}

export function assertToolVersion(name, declaredVersion, installedVersion) {
  if (typeof declaredVersion !== 'string' || !declaredVersion || typeof installedVersion !== 'string' || !installedVersion) {
    throw new TypeError(`${name} tool version is unavailable`);
  }
  if (declaredVersion !== installedVersion) {
    throw new Error(`${name} installed version mismatch: declared ${declaredVersion}, installed ${installedVersion}`);
  }
  return installedVersion;
}

export function eslintInventoryComplete(reports, expectedFiles, root) {
  if (!Array.isArray(reports) || !Array.isArray(expectedFiles) || !root) return false;
  const normalize = value => {
    if (typeof value !== 'string') return null;
    const relative = path.isAbsolute(value) ? path.relative(root, value) : value;
    const normalized = relative.replaceAll('\\', '/').replace(/^\.\//, '');
    if (!normalized || normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) return null;
    return normalized;
  };
  const actual = reports.map(report => normalize(report?.filePath));
  const expected = expectedFiles.map(normalize);
  if (actual.some(value => value === null) || expected.some(value => value === null)) return false;
  return new Set(actual).size === actual.length
    && new Set(expected).size === expected.length
    && canonical([...actual].sort()) === canonical([...expected].sort());
}

export function summarizeComplexity({ eligibleFunctions, complexityValues, threshold }) {
  if (!Number.isSafeInteger(eligibleFunctions) || eligibleFunctions < 0) throw new TypeError('eligible function population must be a nonnegative integer');
  if (!Number.isSafeInteger(threshold) || threshold < 1) throw new TypeError('complexity threshold must be a positive integer');
  if (!Array.isArray(complexityValues) || complexityValues.some(value => !Number.isSafeInteger(value) || value < 1)) {
    throw new TypeError('complexity values must be positive integers');
  }
  if (complexityValues.length > eligibleFunctions) throw new TypeError('complexity warnings exceed the complete function population');
  return {
    eligible_functions: eligibleFunctions,
    above_threshold_functions: complexityValues.filter(value => value > threshold).length,
  };
}

export function parseEslintReport(stdout) {
  const reports = JSON.parse(stdout);
  if (!Array.isArray(reports)) throw new TypeError('ESLint JSON must be an array');
  const parseErrors = [];
  const complexityWarnings = [];
  for (const report of reports) {
    if (!report || typeof report !== 'object' || typeof report.filePath !== 'string' || !Array.isArray(report.messages)) {
      throw new TypeError('ESLint result has an invalid file report');
    }
    for (const message of report.messages) {
      if (!message || typeof message !== 'object' || !Number.isSafeInteger(message.severity)) {
        throw new TypeError('ESLint result has a malformed diagnostic');
      }
      if (message.fatal || (message.ruleId === null && message.severity === 2)) {
        parseErrors.push({ file: report.filePath, line: message.line ?? null, message: message.message });
      }
      if (message.ruleId === 'complexity' && message.severity === 1) {
        const value = String(message.message ?? '').match(/complexity of (\d+)/i)?.[1];
        if (!value) {
          parseErrors.push({ file: report.filePath, line: message.line ?? null, message: 'complexity warning omitted its numeric value' });
          continue;
        }
        complexityWarnings.push({
          file: report.filePath,
          line: message.line ?? null,
          column: message.column ?? null,
          value: Number(value),
          message: message.message,
        });
      }
    }
  }
  return { reports, parseErrors, complexityWarnings };
}

export function normalizeKnipRows(report) {
  const rows = [];
  const recognizedKinds = new Set([
    'files', 'dependencies', 'devDependencies', 'optionalPeerDependencies',
    'unlisted', 'binaries', 'unresolved', 'exports', 'nsExports', 'types', 'nsTypes',
    'enumMembers', 'classMembers', 'duplicates', 'catalog', 'unresolvedImports',
  ]);
  const add = (kind, value, context = {}) => {
    const { file: fallbackFile = null, owners = null, parentSymbol = null } = context;
    if (Array.isArray(value)) {
      for (const item of value) add(kind, item, context);
      return;
    }
    if (typeof value === 'string') {
      rows.push({ kind, file: fallbackFile ?? value, name: fallbackFile ? value : null, line: null, triage: 'unreviewed-candidate', owners, parent_symbol: parentSymbol });
      return;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError(`Knip ${kind} rows must be strings or objects`);
    }
    const file = typeof value.file === 'string' ? value.file : (typeof value.path === 'string' ? value.path : fallbackFile);
    const name = typeof value.name === 'string' ? value.name : (typeof value.symbol === 'string' ? value.symbol : null);
    if (!file && !name) throw new TypeError(`Knip ${kind} row has no source path or symbol`);
    const line = Number.isSafeInteger(value.line) && value.line > 0 ? value.line : null;
    rows.push({ kind: value.kind ?? value.issue ?? kind, file, name, line, triage: 'unreviewed-candidate', owners, parent_symbol: parentSymbol });
  };

  if (Array.isArray(report)) {
    if (!report.length) return rows;
    for (const value of report) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Knip array output contains a non-object row');
      const kind = value.kind ?? value.issue ?? value.type;
      if (typeof kind !== 'string' || !recognizedKinds.has(kind)) throw new TypeError('Knip array output contains an unknown issue kind');
      add(kind, value);
    }
  } else if (report && typeof report === 'object' && !Array.isArray(report)
    && Array.isArray(report.files) && Array.isArray(report.issues)) {
    if (report.files.some(file => typeof file !== 'string')) throw new TypeError('Knip file inventory contains a non-string path');
    for (const file of report.files) add('files', file);
    for (const issue of report.issues) {
      if (!issue || typeof issue !== 'object' || Array.isArray(issue) || typeof issue.file !== 'string') {
        throw new TypeError('Knip issue group has no source file');
      }
      const owners = issue.owners ?? null;
      if (owners !== null && (!Array.isArray(owners) || owners.some(owner => typeof owner !== 'string'))) {
        throw new TypeError('Knip issue group has malformed ownership metadata');
      }
      for (const [kind, value] of Object.entries(issue)) {
        if (kind === 'file' || kind === 'owners') continue;
        if (!recognizedKinds.has(kind)) throw new TypeError('Knip issue group contains an unknown kind');
        if ((kind === 'enumMembers' || kind === 'classMembers') && value && !Array.isArray(value) && typeof value === 'object') {
          for (const [parentSymbol, members] of Object.entries(value)) {
            if (!Array.isArray(members)) throw new TypeError(`Knip ${kind} parent entries must be arrays`);
            add(kind, members, { file: issue.file, owners, parentSymbol });
          }
        } else add(kind, value, { file: issue.file, owners });
      }
    }
  } else if (report && typeof report === 'object' && !Array.isArray(report)) {
    const keys = Object.keys(report).filter(kind => kind !== 'meta' && kind !== 'summary');
    if (keys.some(kind => !recognizedKinds.has(kind))) throw new TypeError('Knip output contains an unknown issue group');
    if (keys.length === 0 && !(report.meta || report.summary)) throw new TypeError('Knip output has no recognized issue groups');
    for (const [kind, value] of Object.entries(report)) {
      if (kind === 'meta' || kind === 'summary') continue;
      add(kind, value);
    }
  } else throw new TypeError('Knip JSON has an unsupported top-level shape');
  return rows;
}

export function mapJobConclusion(job, attemptStatus = 'completed') {
  if (!job) return attemptStatus === 'completed' ? 'unknown' : 'pending';
  const conclusion = job.conclusion;
  if (conclusion === 'success' || conclusion === 'failure' || conclusion === 'cancelled' || conclusion === 'skipped') {
    return conclusion;
  }
  if (conclusion === 'infra_failure') return 'infra_failure';
  if (conclusion === null && attemptStatus !== 'completed') return 'pending';
  return 'unknown';
}

export function deriveOverallConclusion(jobs) {
  return CI_PRIORITY.find(conclusion => jobs.some(job => job.conclusion === conclusion)) ?? 'unknown';
}

export function buildCohortRuns({ runs, attempts, expectedJobRefs, jobNameToRef, windowStart, windowEnd }) {
  const unique = new Set();
  const selected = [...runs].sort((left, right) => Number(left.id) - Number(right.id));
  if (selected.length > 1000) throw new RangeError('CI cohort exceeds the v1 1,000-run bound');
  const output = selected.map(run => {
    const numericId = Number(run.id);
    if (!Number.isSafeInteger(numericId) || numericId < 1 || unique.has(numericId)) {
      throw new TypeError('CI inventory contains an invalid or duplicate workflow run id');
    }
    unique.add(numericId);
    if (!/^[a-f0-9]{40}$/.test(run.head_sha ?? '')) throw new TypeError(`workflow run ${numericId} has no immutable commit SHA`);
    const createdAt = typeof run.created_at === 'string' ? isoSecond(new Date(run.created_at)) : null;
    if (!createdAt || Date.parse(createdAt) < Date.parse(windowStart) || Date.parse(createdAt) >= Date.parse(windowEnd)) {
      throw new TypeError(`workflow run ${numericId} falls outside the declared half-open window`);
    }
    const latestAttempt = Number(run.run_attempt);
    if (!Number.isSafeInteger(latestAttempt) || latestAttempt < 1) throw new TypeError(`workflow run ${numericId} has invalid latest attempt`);

    const first = attempts.get(numericId) ?? null;
    const attemptStatus = first?.status ?? (latestAttempt === 1 ? run.status : 'completed');
    const actualJobs = new Map();
    for (const job of first?.jobs ?? []) {
      const ref = jobNameToRef[job.name];
      if (!ref || !expectedJobRefs.includes(ref)) throw new TypeError(`workflow run ${numericId} has unexpected job ${job.name ?? '[unnamed]'}`);
      if (actualJobs.has(ref)) throw new TypeError(`workflow run ${numericId} has duplicate job ${ref}`);
      actualJobs.set(ref, job);
    }
    const jobs = expectedJobRefs.map(jobRef => ({
      job_ref: jobRef,
      conclusion: mapJobConclusion(actualJobs.get(jobRef), attemptStatus),
    }));
    return {
      run_ref: refId(`gha-run-${numericId}-attempt-1`),
      commit: run.head_sha,
      created_at: createdAt,
      attempt: 1,
      latest_attempt: latestAttempt,
      jobs,
      overall_conclusion: deriveOverallConclusion(jobs),
    };
  });
  return output;
}

export function reliabilityCounts(runs) {
  const runCounts = Object.fromEntries(CI_CONCLUSIONS.map(conclusion => [conclusion, 0]));
  const jobCounts = Object.fromEntries(CI_CONCLUSIONS.map(conclusion => [conclusion, 0]));
  for (const run of runs) {
    runCounts[run.overall_conclusion] += 1;
    for (const job of run.jobs) jobCounts[job.conclusion] += 1;
  }
  const denominator = runCounts.success + runCounts.failure + runCounts.infra_failure;
  return {
    runCounts,
    jobCounts,
    numerator: runCounts.success,
    denominator,
    fraction: denominator === 0 ? null : runCounts.success / denominator,
  };
}

export function slot({ name, observedAt, status, unit, reason = null, payload = null, source = null, population = null, priorSnapshotRef }) {
  const result = {
    status,
    payload: status === 'measured' ? payload : null,
    reason: status === 'measured' ? null : reason,
    observed_at: observedAt,
    unit,
    source,
    population,
    slot_ref: refId(`slot-${name.replaceAll('_', '-')}`),
  };
  if (priorSnapshotRef) result.prior_snapshot_ref = priorSnapshotRef;
  return result;
}

export function source({ runRef, attempt, toolName, toolVersion, language, platform, metricVersion, scopeVersion, configDigest, scopeDigest }) {
  return {
    run_ref: runRef,
    attempt,
    tool: { name: toolName, version: toolVersion },
    language,
    platform,
    feature_refs: [],
    metric_version: metricVersion,
    scope_version: scopeVersion,
    config_digest: { algorithm: 'sha256', value: configDigest },
    scope_digest: { algorithm: 'sha256', value: scopeDigest },
  };
}

export function normalizeCoverageSummary(summary, root) {
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)
    || !summary.total || typeof summary.total !== 'object' || !root) {
    throw new TypeError('coverage summary lacks a total or repository root');
  }
  const entries = summary.files && typeof summary.files === 'object'
    ? Object.entries(summary.files)
    : Object.entries(summary).filter(([key]) => key !== 'total');
  const files = {};
  for (const [file, value] of entries) {
    if (typeof file !== 'string' || !file || !value || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError('coverage per-file evidence is malformed');
    }
    const candidate = path.isAbsolute(file) ? path.relative(root, file) : file;
    const normalized = candidate.replaceAll('\\', '/').replace(/^\.\//, '');
    if (!normalized || normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) {
      throw new TypeError('coverage evidence path is outside the repository');
    }
    if (Object.hasOwn(files, normalized)) throw new TypeError('coverage evidence paths collide after normalization');
    files[normalized] = value;
  }
  return {
    total: summary.total,
    files,
  };
}

export function summarizeCoverage(summary, expectedFiles) {
  if (!summary || !summary.total || !summary.files || typeof summary.files !== 'object') {
    throw new TypeError('coverage summary lacks total and per-file evidence');
  }
  const actualPaths = Object.keys(summary.files).sort();
  const expected = [...expectedFiles].sort();
  if (canonical(actualPaths) !== canonical(expected)) {
    throw new TypeError(`coverage source inventory mismatch: expected ${expected.join(', ')}, got ${actualPaths.join(', ')}`);
  }
  const lines = summary.total.lines;
  if (!lines || !Number.isSafeInteger(lines.total) || !Number.isSafeInteger(lines.covered) || lines.total < 1 || lines.covered < 0 || lines.covered > lines.total) {
    throw new TypeError('coverage line denominator or numerator is invalid');
  }
  for (const file of expected) {
    const fileLines = summary.files[file]?.lines;
    if (!fileLines || !Number.isSafeInteger(fileLines.total) || !Number.isSafeInteger(fileLines.covered)
      || fileLines.total < 0 || fileLines.covered < 0 || fileLines.covered > fileLines.total) {
      throw new TypeError(`coverage summary omitted eligible source file ${file}`);
    }
  }
  const fileTotal = expected.reduce((sum, file) => sum + summary.files[file].lines.total, 0);
  const fileCovered = expected.reduce((sum, file) => sum + summary.files[file].lines.covered, 0);
  if (fileTotal !== lines.total || fileCovered !== lines.covered) throw new TypeError('coverage total does not equal the complete per-file inventory');
  return {
    measure: 'lines',
    covered: lines.covered,
    eligible: lines.total,
    emitted_source_files: actualPaths.length,
    eligible_source_files: expected.length,
    includes_inline_tests: false,
    clean_profiles: true,
    source_inventory: 'complete-declared-inventory',
    profile_refs: [refId('coverage-profile-clean')],
  };
}
