import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'vitest';
import {
  attachUnusedConsumerEvidence,
  buildUnusedReferenceAudit,
  qualifiedUnusedPayload,
  validateUnusedScope,
} from '../research/code-health-402/lib/unused.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

it('AST audit distinguishes type imports and fixture strings from unresolved computed imports', async () => {
  const scope = {
    scope_version: 'fixture-v1',
    audited_source_prefixes: ['src/', 'tests/'],
    candidate_source_prefixes: ['src/'],
    source_extensions: ['.ts'],
    consumer_classes: [
      { class: 'production-internal', prefixes: ['src/'] },
      { class: 'test', prefixes: ['tests/'] },
    ],
    reviewed_data_enumerations: [],
  };
  const files = ['src/module.ts', 'tests/module.test.ts'];
  const source = [
    'type Module = typeof import("../src/module.js").UsedType;',
    'const example = "await import(dynamicPath)";',
    'await import(dynamicPath);',
  ].join('\n');
  const audit = await buildUnusedReferenceAudit({
    scope,
    files,
    readSource: async file => file === 'tests/module.test.ts' ? source : 'export interface UsedType {}\n',
  });
  assert.equal(audit.references.length, 1);
  assert.equal(audit.references[0].reference_type, 'type-import');
  assert.deepEqual(audit.references[0].imported_symbols, ['UsedType']);
  assert.deepEqual(audit.dynamic_unknowns.map(item => [item.path, item.line, item.kind]), [
    ['tests/module.test.ts', 3, 'computed-dynamic-import'],
  ]);
  assert.equal(audit.graph_qualified, false);
});

it('source audit retains operator, test, benchmark, and gate references and keeps data enumeration distinct', async () => {
  const scope = JSON.parse(await readFile(path.join(ROOT, 'research/code-health-402/unused-scope-v2.json'), 'utf8'));
  const files = [
    'scripts/qualify-m3.ts',
    'scripts/export-m5-adoption-evidence.ts',
    'scripts/run-halogen-compatibility.ts',
    'scripts/retention-cli.ts',
    'scripts/gate-c-loadtest.mjs',
    'scripts/monitor-mcp.mjs',
    'src/homeserver/m3-qualification.ts',
    'src/homeserver/adoption-evidence-bundle.ts',
    'src/homeserver/halogen-host-operations.ts',
    'src/homeserver/retention-registry.ts',
    'src/homeserver/not-referenced.ts',
    'tests/qualify-m3-cli.test.ts',
    'tests/monitor-mcp.test.ts',
    'tests/homeserver-adoption-evidence-bundle.test.ts',
    'tests/halogen-host-operations.test.ts',
    'tests/halogen-runtime-cli.test.ts',
    'tests/homeserver-retention-registry.test.ts',
    'benchmarks/real-agent/oracles/pi-telemetry.hidden.test.ts',
    'scripts/pi-benchmark-telemetry.ts',
    'scripts/gate-e-score.ts',
    'scripts/gate-shadow-score.ts',
    'gate-d/check-runtime-integrity.mjs',
    'scripts/gate-e-bench.ts',
    'scripts/gate-shadow-measure.ts',
    'client/m5-client.mjs',
    'tests/computed-loader.test.ts',
  ];
  const sourceByPath = new Map([
    ['scripts/qualify-m3.ts', "import { evaluateM3Qualification } from '../src/homeserver/m3-qualification.js';\n"],
    ['scripts/export-m5-adoption-evidence.ts', "import { buildAdoptionEvidenceBundle } from '../src/homeserver/adoption-evidence-bundle.js';\n"],
    ['scripts/run-halogen-compatibility.ts', "import { createHalogenHostOperations } from '../src/homeserver/halogen-host-operations.js';\n"],
    ['scripts/retention-cli.ts', "import { retentionRegistry } from '../src/homeserver/retention-registry.js';\n"],
    ['tests/qualify-m3-cli.test.ts', "const evaluator = await import('../src/homeserver/m3-qualification.js');\n"],
    ['tests/monitor-mcp.test.ts', "import { monitorMcp, probeMcpTool } from '../scripts/monitor-mcp.mjs';\n"],
    ['tests/homeserver-adoption-evidence-bundle.test.ts', "import { buildAdoptionEvidenceBundle } from '../src/homeserver/adoption-evidence-bundle.js';\n"],
    ['tests/halogen-host-operations.test.ts', "const operations = await import('../src/homeserver/halogen-host-operations.js');\n"],
    ['tests/homeserver-retention-registry.test.ts', "import { retentionRegistry } from '../src/homeserver/retention-registry.js';\n"],
    ['benchmarks/real-agent/oracles/pi-telemetry.hidden.test.ts', "await import(pathToFileURL(resolve(process.cwd(), 'scripts/pi-benchmark-telemetry.ts')).href);\n"],
    ['gate-d/check-runtime-integrity.mjs', "import { check } from '../src/homeserver/retention-registry.js';\n"],
    ['scripts/gate-e-bench.ts', "await import('./gate-e-score.js');\n"],
    ['scripts/gate-shadow-measure.ts', "await import('./gate-shadow-score.js');\n"],
    ['client/m5-client.mjs', "const files = await readdir(spoolDir);\n"],
    ['tests/computed-loader.test.ts', 'await import(modulePath);\n'],
  ]);
  const audit = await buildUnusedReferenceAudit({
    scope,
    files,
    readSource: async relative => sourceByPath.get(relative) ?? '',
  });
  const m3Consumers = audit.references.filter(reference => reference.target_path === 'src/homeserver/m3-qualification.ts');
  assert.deepEqual(new Set(m3Consumers.map(reference => reference.consumer_class)), new Set(['operator', 'test']));
  assert.ok(audit.references.some(reference => reference.consumer_class === 'benchmark'
    && reference.target_path === 'scripts/pi-benchmark-telemetry.ts'));
  assert.ok(audit.references.some(reference => reference.consumer_class === 'gate'
    && reference.target_path === 'src/homeserver/retention-registry.ts'));
  assert.ok(audit.reviewed_data_enumerations.some(reference => reference.path === 'client/m5-client.mjs'
    && reference.kind === 'adoption-spool-data-pruning'));
  assert.ok(audit.dynamic_unknowns.some(reference => reference.path === 'tests/computed-loader.test.ts'
    && reference.kind === 'computed-dynamic-import'));
  assert.equal(audit.graph_qualified, false, 'unresolved dynamic consumers keep the graph unknown');
  const candidates = attachUnusedConsumerEvidence([
    { kind: 'files', file: 'src/homeserver/m3-qualification.ts', line: 1 },
    { kind: 'exports', file: 'src/homeserver/not-referenced.ts', name: 'missingExport', line: 1 },
  ], audit, scope);
  assert.equal(candidates[0].candidate_state, 'retained-by-source-reference');
  assert.deepEqual(new Set(candidates[0].consumer_references.map(reference => reference.consumer_class)), new Set(['operator', 'test']));
  assert.equal(candidates[1].candidate_state, 'unknown-incomplete-graph');
  assert.equal(qualifiedUnusedPayload(candidates, audit.graph_qualified, scope), null,
    'unresolved dynamic references must never become a measured zero');
});

it('namespace imports retain candidate exports and never increase the qualified count', async () => {
  const scope = JSON.parse(await readFile(path.join(ROOT, 'research/code-health-402/unused-scope-v2.json'), 'utf8'));
  const audit = await buildUnusedReferenceAudit({
    scope,
    files: ['src/shared.ts', 'tests/shared-namespace.test.ts'],
    readSource: async file => file === 'tests/shared-namespace.test.ts'
      ? "import * as shared from '../src/shared.js'; void shared;\n"
      : 'export const maybeUnused = true;\n',
  });
  const candidates = attachUnusedConsumerEvidence([
    { kind: 'exports', file: 'src/shared.ts', name: 'maybeUnused', line: 1 },
  ], audit, scope);
  assert.equal(candidates[0].candidate_state, 'retained-by-source-reference');
  assert.equal(qualifiedUnusedPayload(candidates, audit.graph_qualified, scope).candidate_count, 0);
});

it('keeps an aliased computed createRequire loader unresolved', async () => {
  const scope = {
    scope_version: 'fixture-create-require-v1',
    audited_source_prefixes: ['src/', 'tests/'],
    candidate_source_prefixes: ['src/'],
    source_extensions: ['.ts'],
    consumer_classes: [{ class: 'test', prefixes: ['tests/'] }],
    reviewed_data_enumerations: [],
  };
  const files = ['src/module.ts', 'tests/create-require.test.ts'];
  const source = [
    "import { createRequire as makeRequire } from 'node:module';",
    'const localRequire = makeRequire(import.meta.url);',
    'localRequire(modulePath);',
  ].join('\n');
  const audit = await buildUnusedReferenceAudit({
    scope,
    files,
    readSource: async file => file === 'tests/create-require.test.ts' ? source : 'export const present = true;\n',
  });
  assert.ok(audit.dynamic_unknowns.some(item => item.path === 'tests/create-require.test.ts'
    && item.line === 1 && item.kind === 'unsupported-create-require'));
  assert.ok(audit.dynamic_unknowns.some(item => item.path === 'tests/create-require.test.ts'
    && item.line === 1 && item.kind === 'unsupported-node-module-import'));
  assert.equal(audit.graph_qualified, false, 'computed require aliases stay outside the qualified graph');
});

it('keeps node:module loader aliases and builtin require forms unresolved', async () => {
  const scope = {
    scope_version: 'fixture-node-module-v1',
    audited_source_prefixes: ['src/', 'tests/'],
    candidate_source_prefixes: ['src/'],
    source_extensions: ['.ts'],
    consumer_classes: [{ class: 'test', prefixes: ['tests/'] }],
    reviewed_data_enumerations: [],
  };
  const sources = new Map([
    ['tests/namespace.test.ts', [
      "import * as module from 'node:module';",
      "const load = module['createRequire'](import.meta.url);",
      'load(modulePath);',
    ].join('\n')],
    ['tests/renamed.test.ts', [
      "import { createRequire as makeRequire } from 'module';",
      'const load = makeRequire(import.meta.url);',
      'load(modulePath);',
    ].join('\n')],
    ['tests/dynamic.test.ts', "await import('node:module');\n"],
    ['tests/require.test.ts', "const loader = require('module');\n"],
  ]);
  const files = ['src/module.ts', ...sources.keys()];
  const audit = await buildUnusedReferenceAudit({
    scope,
    files,
    readSource: async file => sources.get(file) ?? 'export const present = true;\n',
  });
  const unsupported = audit.dynamic_unknowns.filter(item => item.kind === 'unsupported-node-module-import');
  assert.deepEqual(unsupported.map(item => item.path).sort(), [...sources.keys()].sort());
  assert.equal(audit.graph_qualified, false, 'node:module aliases cannot silently qualify computed module loading');
});

it('keeps child_process launch consumers unknown, including promisified execFile aliases', async () => {
  const scope = {
    scope_version: 'fixture-child-process-v1',
    audited_source_prefixes: ['src/', 'scripts/', 'tests/'],
    candidate_source_prefixes: ['src/', 'scripts/'],
    source_extensions: ['.ts'],
    candidate_kinds: ['files', 'exports'],
    consumer_classes: [{ class: 'test', prefixes: ['tests/'] }],
    reviewed_data_enumerations: [],
  };
  const sources = new Map([
    ['tests/observe-install-activity-cli.test.ts', [
      "import { execFile as childExecFile } from 'child_process';",
      "import { promisify } from 'node:util';",
      'const execFile = promisify(childExecFile);',
      "await execFile(process.execPath, ['--import', 'tsx', 'scripts/observe-install-activity.ts']);",
    ].join('\n')],
    ['tests/node-child-process.test.ts', "import { spawn } from 'node:child_process';\nspawn('node', []);\n"],
    ['tests/require-child-process.test.ts', "const { execFile } = require('child_process');\nexecFile('node', []);\n"],
  ]);
  const files = ['src/module.ts', 'scripts/observe-install-activity.ts', ...sources.keys()];
  const audit = await buildUnusedReferenceAudit({
    scope,
    files,
    readSource: async file => sources.get(file) ?? 'export const present = true;\n',
  });
  const unsupported = audit.dynamic_unknowns
    .filter(item => item.kind === 'unsupported-child-process-import')
    .map(item => [item.path, item.target]);
  assert.deepEqual(unsupported, [
    ['tests/node-child-process.test.ts', 'node:child_process'],
    ['tests/observe-install-activity-cli.test.ts', 'child_process'],
    ['tests/require-child-process.test.ts', 'child_process'],
  ]);
  assert.equal(audit.graph_qualified, false, 'process-launch consumers keep the graph unknown');
  const candidates = attachUnusedConsumerEvidence([
    { kind: 'exports', file: 'src/module.ts', name: 'present', line: 1 },
    { kind: 'files', file: 'scripts/observe-install-activity.ts', line: 1 },
  ], audit, scope);
  assert.equal(candidates[0].candidate_state, 'unknown-incomplete-graph');
  assert.equal(candidates[1].candidate_state, 'unknown-incomplete-graph');
  assert.equal(qualifiedUnusedPayload(candidates, audit.graph_qualified, scope), null);
});

it('same-line imports preserve every imported symbol reference', async () => {
  const scope = JSON.parse(await readFile(path.join(ROOT, 'research/code-health-402/unused-scope-v2.json'), 'utf8'));
  const audit = await buildUnusedReferenceAudit({
    scope,
    files: ['src/shared.ts', 'tests/shared-imports.test.ts'],
    readSource: async file => file === 'tests/shared-imports.test.ts'
      ? "import { alpha } from '../src/shared.js'; import { beta } from '../src/shared.js';\n"
      : 'export const alpha = true; export const beta = true;\n',
  });
  const candidates = attachUnusedConsumerEvidence([
    { kind: 'exports', file: 'src/shared.ts', name: 'alpha', line: 1 },
    { kind: 'exports', file: 'src/shared.ts', name: 'beta', line: 1 },
  ], audit, scope);
  assert.equal(audit.references.filter(reference => reference.path === 'tests/shared-imports.test.ts').length, 2);
  assert.deepEqual(candidates.map(candidate => candidate.candidate_state), [
    'retained-by-source-reference',
    'retained-by-source-reference',
  ]);
});

it('tracked AST inventory is complete, deterministic, and source-links all operator roots', async () => {
  const scope = JSON.parse(await readFile(path.join(ROOT, 'research/code-health-402/unused-scope-v2.json'), 'utf8'));
  const config = JSON.parse(await readFile(path.join(ROOT, 'research/code-health-402/knip-valid-v2.json'), 'utf8'));
  const packageJson = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean);
  const validation = validateUnusedScope({ scope, config, packageJson, files });
  assert.equal(validation.complete, true, JSON.stringify(validation));
  const audit = await buildUnusedReferenceAudit({
    scope,
    files,
    readSource: relative => readFile(path.join(ROOT, relative), 'utf8'),
  });
  const sourcePaths = files.filter(file => scope.audited_source_prefixes.some(prefix => file.startsWith(prefix))
    && scope.source_extensions.includes(path.posix.extname(file))).sort();
  assert.equal(audit.complete_source_inventory, true);
  assert.equal(audit.inventory.total_source_files, sourcePaths.length);
  assert.deepEqual(audit.inventory.source_paths, sourcePaths);
  for (const operatorRoot of scope.required_operator_roots) assert.ok(files.includes(operatorRoot), operatorRoot);
  assert.deepEqual(scope.operator_root_evidence.map(evidence => evidence.root).sort(), [...scope.required_operator_roots].sort());
  for (const evidence of scope.operator_root_evidence) {
    assert.ok(files.includes(evidence.source), evidence.source);
    const source = await readFile(path.join(ROOT, evidence.source), 'utf8');
    assert.ok(source.split(/\r?\n/)[evidence.line - 1]?.includes(evidence.pattern),
      `${evidence.source}:${evidence.line} does not support ${evidence.root}`);
  }
  for (const consumer of [...scope.known_test_consumers, ...scope.known_benchmark_consumers]) {
    assert.ok(files.includes(consumer), consumer);
    assert.ok(audit.references.some(reference => reference.path === consumer), consumer);
  }
  assert.ok(audit.dynamic_unknown_count > 0, 'tracked child_process consumers remain explicitly unknown');
  assert.ok(audit.dynamic_unknowns.every(unknown => unknown.kind === 'unsupported-child-process-import'),
    JSON.stringify(audit.dynamic_unknowns));
  assert.equal(audit.graph_qualified, false,
    'candidate-module graph remains unknown until process-launch coverage is proven');
  assert.ok(audit.unresolved_local_references
    .filter(reference => reference.may_target_candidate)
    .every(reference => reference.kind === 'unsupported-child-process-import'),
  'only process-launch consumers may keep candidate modules unresolved');
  assert.equal(audit.reviewed_data_enumeration_count, 1);
});
