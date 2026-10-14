#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const REQUIRED_WORKFLOWS = [
  ['cgroup-stop-proof.yml', 'Bound cgroup stop proof', ['cgroup-stop-proof']],
  ['ci.yml', 'CI', ['secret-scan', 'test']],
  ['code-health.yml', 'Informational code health', ['collect']],
  ['host-arbiter.yml', 'Fixed host arbitration', ['host-arbiter']],
  ['observer-test-host.yml', 'Observer test-host prerequisites', ['native-boundary', 'preflight']],
  ['producer-activity.yml', 'Native producer activity', ['cpp-activity']],
  ['producer-channel.yml', 'Native producer channel', ['producer-channel']],
  ['proxy-activity.yml', 'Pinned proxy activity fixture', ['proxy-activity']],
  ['runtime-producer-channel.yml', 'C++ runtime producer channel', ['runtime-producer-channel']],
];
const CLIENT_WORKFLOW = ['client-compatibility.yml', 'Client compatibility', ['client']];
const CODE_HEALTH_SCHEDULES = ['17 4 * * *', '47 4 * * 1'];
const EXPECTED_CHECKS = [
  ['Bound cgroup stop proof', 'cgroup-stop-proof', 'cgroup-stop-proof'],
  ['CI', 'secret-scan', 'Gitleaks'], ['CI', 'test', 'test'],
  ['Informational code health', 'collect', 'Collect report-only code health'],
  ['Fixed host arbitration', 'host-arbiter', 'host-arbiter'],
  ['Observer test-host prerequisites', 'native-boundary', 'native-boundary'],
  ['Observer test-host prerequisites', 'preflight', 'preflight'],
  ['Native producer activity', 'cpp-activity', 'cpp-activity'],
  ['Native producer channel', 'producer-channel', 'producer-channel'],
  ['Pinned proxy activity fixture', 'proxy-activity', 'proxy-activity'],
  ['C++ runtime producer channel', 'runtime-producer-channel', 'runtime-producer-channel'],
];
const COMMANDS = [
  { id: 'typecheck', command: ['npm', 'run', 'typecheck'] },
  { id: 'gate-d-fixtures', command: ['bash', 'gate-d/verify-fixtures.sh'], env: { GATE_D_STRICT_PIN: '1' } },
  { id: 'tests', command: ['npm', 'test', '--', '--maxWorkers=2'] },
  { id: 'systemone-native-server', command: ['python3', 'tests/test_systemone_native_server.py', '-v'] },
  { id: 'diff-check', command: ['git', 'diff', '--check'] },
];

// Read the deliberately small subset used by this repository's workflow files. This is not a YAML parser.
export function parseWorkflowJobs(source) {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const jobsIndex = lines.findIndex(line => /^jobs:\s*$/.test(line));
  if (jobsIndex < 0) throw new Error('workflow has no jobs block');
  const jobs = [];
  for (let i = jobsIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\S/.test(line) && line.trim() !== '') break;
    const jobMatch = line.match(/^  ([A-Za-z0-9_-]+):\s*$/);
    if (!jobMatch) continue;
    const id = jobMatch[1];
    let end = i + 1;
    while (end < lines.length && (!/^  [A-Za-z0-9_-]+:\s*$/.test(lines[end]) || /^    /.test(lines[end]))) {
      if (/^\S/.test(lines[end]) && lines[end].trim() !== '') break;
      end++;
    }
    const block = lines.slice(i + 1, end).join('\n');
    const display = block.match(/^    name:\s*(.*?)\s*$/m)?.[1];
    let name = display || id;
    if (name.includes('${{ matrix.node }}')) {
      const matrix = block.match(/^\s{8}node:\s*\[([^\]]+)\]\s*$/m)?.[1];
      if (!matrix) throw new Error(`job ${id} has an unrecognized node matrix`);
      const versions = matrix.split(',').map(value => value.trim());
      if (versions.length !== 2 || versions.join(',') !== '18,22') throw new Error(`job ${id} node matrix changed: ${matrix}`);
      for (const version of versions) jobs.push({ id, name: name.replace('${{ matrix.node }}', version) });
    } else jobs.push({ id, name });
    i = end - 1;
  }
  if (jobs.length === 0) throw new Error('workflow has no readable jobs');
  return jobs;
}

function workflowInfo(root, definition) {
  const [file, expectedName, expectedJobs] = definition;
  const filename = path.join(root, '.github/workflows', file);
  if (!fs.existsSync(filename)) throw new Error(`required workflow is missing: ${file}`);
  const source = fs.readFileSync(filename, 'utf8');
  const declaredName = source.match(/^name:\s*(.*?)\s*$/m)?.[1];
  if (declaredName !== expectedName) throw new Error(`${file} workflow name changed: expected ${expectedName}, got ${declaredName ?? 'missing'}`);
  const jobs = parseWorkflowJobs(source);
  const expectedTriggers = file === 'code-health.yml' ? ['pull_request', 'schedule', 'workflow_dispatch'] : ['push', 'pull_request'];
  for (const trigger of expectedTriggers) {
    if (!new RegExp(`^  ${trigger}:\\s*$`, 'm').test(source)) throw new Error(`${file} is missing expected ${trigger} trigger`);
  }
  if (file === 'ci.yml' && !/branches:\s*\[main,\s*aider-eval\/base\]/.test(source)) throw new Error('ci.yml push branch coverage changed');
  if (file !== 'ci.yml' && file !== 'code-health.yml' && !/branches:\s*\[main\]/.test(source)) throw new Error(`${file} push branch coverage changed`);
  if (file === 'code-health.yml') {
    for (const fragment of ["'17 4 * * *'", "'47 4 * * 1'", "vars.CODE_HEALTH_COLLECTION_ENABLED == 'true'", "github.ref == 'refs/heads/main'", 'collect_static:']) {
      if (!source.includes(fragment)) throw new Error(`code-health.yml expected gate/input missing: ${fragment}`);
    }
  }
  const ids = [...new Set(jobs.map(job => job.id))].sort();
  if (ids.join('\0') !== [...expectedJobs].sort().join('\0')) {
    throw new Error(`${file} job coverage changed: expected ${expectedJobs.join(', ')}, found ${ids.join(', ')}`);
  }
  return { file, name: expectedName, jobs, source };
}

function conditionsFor(workflow, job) {
  if (workflow.file === 'code-health.yml') return {
    push: [], pull_request: ['conformance-only'], schedule: CODE_HEALTH_SCHEDULES,
    workflow_dispatch: ['main-only', 'collect_static input; default true'],
  };
  if (workflow.file === 'ci.yml') return { push: ['main', 'aider-eval/base'], pull_request: ['all branches'] };
  if (workflow.file === 'proxy-activity.yml') return { push: ['main'], pull_request: ['all branches'] };
  if (workflow.file === 'client-compatibility.yml') return { push: ['main'], pull_request: ['all branches'] };
  return { push: ['main'], pull_request: ['all branches'] };
}

function applies(workflow, event, branch, schedule) {
  if (workflow.file === 'code-health.yml') {
    if (event === 'pull_request') return true;
    if (event === 'schedule') return CODE_HEALTH_SCHEDULES.includes(schedule);
    return event === 'workflow_dispatch' && branch === 'main';
  }
  if (event === 'pull_request') return true;
  if (event === 'workflow_dispatch' || event === 'schedule') return false;
  if (event !== 'push') return false;
  if (workflow.file === 'ci.yml') return branch === 'main' || branch === 'aider-eval/base';
  if (workflow.file === 'proxy-activity.yml' || workflow.file === 'client-compatibility.yml') return branch === 'main';
  return branch === 'main';
}

export function buildManifest({ root = process.cwd(), event = 'pull_request', branch = null, schedule = null, collectStatic = true } = {}) {
  if (!['push', 'pull_request', 'schedule', 'workflow_dispatch'].includes(event)) throw new Error(`unsupported event: ${event}`);
  if (event === 'schedule' && schedule && !CODE_HEALTH_SCHEDULES.includes(schedule)) throw new Error(`unsupported schedule cron: ${schedule}`);
  const workflows = REQUIRED_WORKFLOWS.map(definition => workflowInfo(root, definition));
  const knownWorkflowFiles = new Set([...REQUIRED_WORKFLOWS, CLIENT_WORKFLOW].map(([file]) => file));
  for (const entry of fs.readdirSync(path.join(root, '.github/workflows'))) {
    if (/\.ya?ml$/.test(entry) && !knownWorkflowFiles.has(entry)) throw new Error(`workflow source has no manifest coverage: ${entry}`);
  }
  const clientPath = path.join(root, '.github/workflows', CLIENT_WORKFLOW[0]);
  let clientCompatibility = { present: false, reason: 'workflow-absent-at-invoked-revision' };
  if (fs.existsSync(clientPath)) {
    workflows.push(workflowInfo(root, CLIENT_WORKFLOW));
    clientCompatibility = { present: true, reason: null };
  }
  const checks = [];
  for (const workflow of workflows) {
    for (const job of workflow.jobs) {
      const active = applies(workflow, event, branch, schedule);
      let status = active ? 'unavailable' : 'not-applicable';
      let reason = active ? 'hosted-check-not-run-by-local-verifier' : 'event-or-branch-condition-not-matched';
      if (workflow.file === 'code-health.yml' && event === 'pull_request') {
        status = 'conformance-only';
        reason = 'pull-request-runs-conformance-only; report-only-metrics-unavailable';
      } else if (workflow.file === 'code-health.yml' && event === 'schedule') {
        status = schedule ? 'unavailable' : 'not-applicable';
        reason = schedule
          ? `schedule-collection-gated-by-CODE_HEALTH_COLLECTION_ENABLED-truth-unknown${schedule === '47 4 * * 1' ? '-and-hosted-tools-for-static-metrics' : '; static-metrics-not-collected'}`
          : 'schedule-cron-not-supplied; CODE_HEALTH_COLLECTION_ENABLED-truth-unknown';
      } else if (workflow.file === 'code-health.yml' && event === 'workflow_dispatch' && branch === 'main') {
        status = 'unavailable';
        reason = collectStatic ? 'hosted-report-collection-and-code-health-slots-not-run-locally' : 'hosted-report-collection-not-run-locally; static-collection-disabled';
      }
      checks.push({ workflowFile: workflow.file, workflowName: workflow.name, jobId: job.id, rawName: job.name, eventConditions: conditionsFor(workflow, job), appliesToInvocation: active, status, reason });
    }
  }
  const actual = checks.filter(check => !check.workflowFile.startsWith('client-')).map(check => `${check.workflowName}\0${check.jobId}\0${check.rawName}`).sort();
  const expected = EXPECTED_CHECKS.map(pair => pair.join('\0')).sort();
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    throw new Error('baseline workflow/job/raw-name mapping changed');
  }
  return {
    schemaVersion: 1,
    event: { name: event, branch, schedule, collectStatic: event === 'workflow_dispatch' ? collectStatic : null },
    workflowSourcesValidated: workflows.map(({ file, name }) => ({ file, workflowName: name })),
    clientCompatibility,
    checks,
    hostProof: { status: 'CI-only/unavailable', facts: ['host OS series', 'kernel and cgroup proof', 'Gitleaks full-history scan', 'upstream proxy fixture'] },
    codeHealth: { status: 'report-only/unavailable-unless-hosted-collector-runs', metricValues: null, conformanceIsNotACollectedMetric: true },
  };
}

export function validateReceipt(manifest, receipt, headSha) {
  const errors = [];
  if (!/^[0-9a-f]{40}$/i.test(headSha ?? '')) errors.push('a fresh 40-character head SHA is required');
  const runs = Array.isArray(receipt?.checkRuns) ? receipt.checkRuns : [];
  const required = manifest.checks.filter(check => check.appliesToInvocation !== false && check.status !== 'not-applicable');
  for (const expected of required) {
    const matches = runs.filter(run => run.name === expected.rawName && run.workflowName === expected.workflowName && run.head_sha === headSha);
    if (!matches.length) { errors.push(`missing receipt: ${expected.workflowName} / ${expected.rawName}`); continue; }
    if (matches.length !== 1) { errors.push(`ambiguous duplicate receipts: ${expected.workflowName} / ${expected.rawName}`); continue; }
    const success = matches[0].status === 'completed' && matches[0].conclusion === 'success';
    if (!success) errors.push(`unsuccessful or incomplete receipt: ${expected.workflowName} / ${expected.rawName}`);
  }
  return { valid: errors.length === 0, headSha: /^[0-9a-f]{40}$/i.test(headSha ?? '') ? headSha : null, errors };
}

export async function runChecks({ commands = COMMANDS, cwd = process.cwd(), tempRoot = '/tmp', homeRoot = '/tmp', pathValue = process.env.PATH ?? '/usr/bin:/bin', spawn = spawnSync } = {}) {
  const id = `${process.pid}-${Date.now().toString(36)}`;
  const tmpdir = fs.mkdtempSync(path.join(tempRoot, `i452-${id.slice(-10)}-`));
  const home = fs.mkdtempSync(path.join(homeRoot, `h452-${id.slice(-10)}-`));
  const results = [];
  for (let index = 0; index < commands.length; index++) {
    const item = commands[index];
    const command = Array.isArray(item.command) ? item.command : item;
    const commandId = item.id ?? `command-${index + 1}`;
    const overrides = item.env ?? {};
    const prefix = Object.entries(overrides).map(([key, value]) => `${key}=${value}`).join(' ');
    process.stdout.write(`\n>>> ${prefix ? `${prefix} ` : ''}${command.join(' ')}\n`);
    const result = spawn(command[0], command.slice(1), {
      cwd, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024,
      env: { PATH: pathValue, HOME: home, TMPDIR: tmpdir, ...(item.env || {}) },
    });
    const stdout = result.stdout ?? '';
    const stderr = result.stderr ?? '';
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
    const exitCode = result.error ? null : result.status;
    const commandResult = { id: commandId, command, environmentOverrides: overrides, status: exitCode === 0 ? 'passed' : result.error ? 'unavailable' : 'failed', exitCode, signal: result.signal ?? null, error: result.error?.message ?? null, stdout, stderr };
    results.push(commandResult);
    process.stdout.write(`<<< ${commandId}: ${commandResult.status} (exit ${exitCode ?? 'unavailable'})\n`);
  }
  return { environment: { PATH: pathValue, HOME: home, TMPDIR: tmpdir, node: process.version }, results };
}

function parseArgs(argv) {
  const options = { event: 'pull_request', branch: null, schedule: null, collectStatic: true, manifestOnly: false, receiptFile: null, head: null };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--manifest-only') options.manifestOnly = true;
    else if (key === '--no-collect-static') options.collectStatic = false;
    else if (['--event', '--branch', '--schedule', '--receipt', '--head'].includes(key)) {
      const value = argv[++i];
      if (!value) throw new Error(`missing value for ${key}`);
      if (key === '--event') options.event = value;
      else if (key === '--branch') options.branch = value;
      else if (key === '--schedule') options.schedule = value;
      else if (key === '--receipt') options.receiptFile = value;
      else if (key === '--head') options.head = value;
    } else throw new Error(`unknown argument: ${key}`);
  }
  if (options.receiptFile && !options.manifestOnly) throw new Error('--receipt requires --manifest-only');
  if (options.receiptFile && !options.head) throw new Error('--receipt requires --head');
  return options;
}

async function main(argv) {
  const options = parseArgs(argv);
  if (Number(process.versions.node.split('.')[0]) < 20) throw new Error(`Node.js 20+ required; found ${process.version}`);
  const manifest = buildManifest({ ...options, root: process.cwd() });
  if (options.manifestOnly) {
    const output = { manifest, historicalReceiptValidation: null, commandsRan: [] };
    if (options.receiptFile) output.historicalReceiptValidation = validateReceipt(manifest, JSON.parse(fs.readFileSync(options.receiptFile, 'utf8')), options.head);
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    if (output.historicalReceiptValidation && !output.historicalReceiptValidation.valid) process.exitCode = 1;
    return;
  }
  const local = await runChecks({ cwd: process.cwd() });
  const failed = local.results.some(result => result.status !== 'passed');
  const enrichedChecks = manifest.checks.map(check => {
    if (check.workflowFile === 'ci.yml' && check.rawName === 'test') return { ...check, status: failed ? 'local-subset-failed' : 'local-subset-passed', hostedStatus: 'pending' };
    return check;
  });
  process.stdout.write(`${JSON.stringify({ manifest: { ...manifest, checks: enrichedChecks }, environment: local.environment, commandsRan: local.results.map(({ id, command, environmentOverrides, status, exitCode, signal, error }) => ({ id, command, environmentOverrides, status, exitCode, signal, error })), localSubsetStatus: failed ? 'failed' : 'passed', hostedChecksPending: true, deliveryReady: false }, null, 2)}\n`);
  if (failed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => { process.stderr.write(`verify-local: ${error.message}\n`); process.exitCode = 1; });
}
