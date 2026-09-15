#!/usr/bin/env node
/** Operator-only entry point. Default prints a plan; --execute requires exact reviewed hashes. */
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { halogenHostPlanSchema, createHalogenHostOperations, fileSha256 } from '../src/homeserver/halogen-host-operations.js';
import { buildHalogenLaunch } from '../src/homeserver/halogen-runtime-plan.js';
import { HALOGEN_PILOT_PROFILE } from '../src/homeserver/halogen-profile.js';
import { runHalogenCompatibilityEvaluation } from '../src/homeserver/halogen-evaluation.js';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 1 && argv[0] === '--help') {
    console.log('run-halogen-compatibility --plan PRIVATE_JSON [--execute --accepted-plan-sha256 HASH --accepted-runner-sha256 HASH]');
    return;
  }
  const flags = new Map<string, string>();
  let execute = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (flag === '--execute' && !execute) { execute = true; continue; }
    if (!['--plan', '--accepted-plan-sha256', '--accepted-runner-sha256'].includes(flag)
      || flags.has(flag) || !argv[i + 1] || argv[i + 1]!.startsWith('--')) throw new Error('invalid or duplicate argument');
    flags.set(flag, argv[++i]!);
  }
  const path = flags.get('--plan');
  if (!path) throw new Error('--plan is required');
  const resolvedPlan = resolve(path);
  for (let current = resolvedPlan; current !== '/'; current = dirname(current)) {
    if ((await lstat(current)).isSymbolicLink()) throw new Error('plan path contains symlink');
  }
  const info = await lstat(resolvedPlan);
  if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new Error('plan must be private and owned by caller');
  const bytes = await readFile(resolvedPlan);
  const planSha256 = createHash('sha256').update(bytes).digest('hex');
  const p = halogenHostPlanSchema.parse(JSON.parse(bytes.toString()));
  const home = `/home/${p.user}`;
  const root = `${home}/halogen-eval-317`;
  const launch = buildHalogenLaunch(HALOGEN_PILOT_PROFILE, { name: p.name, runId: p.runId, user: p.user,
    group: p.group, uid: p.uid, homeDirectory: home,
    artifactDirectory: `${root}/staging/${HALOGEN_PILOT_PROFILE.modelRevision}` });
  const self = fileURLToPath(import.meta.url);
  const runnerSha256 = await fileSha256(self);
  if (!execute) {
    console.log(JSON.stringify({ mode: 'plan-only', planSha256, runnerSha256, runnerCommit: p.runnerCommit,
      expiresAt: p.expiresAt, maintenanceSeconds: 3600, candidateSeconds: 1800,
      launch, priorProcess: p.prior.pid, restoreUnit: `${p.prior.restoreName}.service`,
      expectedResidentModels: p.expectedResidentModels, protectedUnits: p.protectedUnits }, null, 2));
    return;
  }
  if (flags.get('--accepted-plan-sha256') !== planSha256 || flags.get('--accepted-runner-sha256') !== runnerSha256) {
    throw new Error('exact accepted plan and executable hashes required');
  }
  if (!self.endsWith('.mjs')) throw new Error('execution requires the reviewed self-contained .mjs bundle');
  const apiKey = process.env['M5_MAINTENANCE_KEY'];
  if (!apiKey?.trim()) throw new Error('approved operator maintenance credential must be supplied in environment');
  const runDirectory = `${root}/runs`;
  for (let current = root; current !== '/'; current = dirname(current)) {
    if ((await lstat(current)).isSymbolicLink()) throw new Error('run path contains symlink');
  }
  try { await mkdir(runDirectory, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const directory = await lstat(runDirectory);
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== p.uid || (directory.mode & 0o777) !== 0o700) {
    throw new Error('run directory must be caller-owned mode0700');
  }
  const receipt = `${runDirectory}/${p.name}.json`;
  const claim = `${runDirectory}/${p.name}.claim`;
  for (const target of [receipt, claim]) {
    try { await lstat(target); throw new Error('run identity already used'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const operations = createHalogenHostOperations(p);
  const start = operations.startCandidate.bind(operations);
  operations.startCandidate = async () => {
    await writeFile(claim, JSON.stringify({ planSha256, runnerSha256, runnerCommit: p.runnerCommit }), { flag: 'wx', mode: 0o600 });
    await start();
  };
  const abort = new AbortController();
  const interrupt = (): void => abort.abort(new Error('operator interrupted evaluation'));
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, interrupt);
  const common = { schemaVersion: 1, gate: 'synthetic-compatibility-only', planSha256, runnerSha256,
    runnerCommit: p.runnerCommit, profileSha256: p.profileSha256 };
  try {
    const result = await runHalogenCompatibilityEvaluation({ operations, apiKey, expectedResidentModels: p.expectedResidentModels, approvedExpiresAt: p.expiresAt, signal: abort.signal });
    await writeFile(receipt, JSON.stringify({ ...common, pass: true, result }), { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ ...common, pass: true, receipt }));
  } catch (error) {
    const diagnostics: Array<{ name: string; message: string }> = [];
    const collect = (value: unknown, depth = 0): void => {
      if (!(value instanceof Error) || depth > 3 || diagnostics.length >= 12) return;
      diagnostics.push({ name: value.name, message: value.message.replaceAll(apiKey, '[redacted]').slice(0, 1000) });
      if (value instanceof AggregateError) for (const item of value.errors) collect(item, depth + 1);
      if (value.cause) collect(value.cause, depth + 1);
    };
    collect(error);
    const diagnostic = JSON.stringify(diagnostics);
    await writeFile(receipt, JSON.stringify({ ...common, pass: false,
      errorClass: error instanceof Error ? error.name : 'UnknownError', diagnostics }), { flag: 'wx', mode: 0o600 });
    console.error(JSON.stringify({ ...common, pass: false, receipt, errorSha256: createHash('sha256').update(diagnostic).digest('hex') }));
    process.exitCode = 1;
  } finally {
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.removeListener(signal, interrupt);
  }
}
main().catch(error => {
  console.error(JSON.stringify({ pass: false, errorClass: error instanceof Error ? error.name : 'UnknownError',
    errorSha256: createHash('sha256').update(error instanceof Error ? error.message : 'unknown').digest('hex') }));
  process.exitCode = 1;
});
