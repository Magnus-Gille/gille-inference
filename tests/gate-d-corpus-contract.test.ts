import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeAssertions } from "../gate-d/check-test-assertions.mjs";
import { runtimeIntegrityViolations } from "../gate-d/check-runtime-integrity.mjs";
import {
  hasCallableExport,
  hasImportedCall,
  hasImportedReturnFlow,
  hasImportedValidatedReturn,
} from "../gate-d/check-ts-contract.mjs";

const ROOT = process.cwd();
const RUN = join(ROOT, "gate-d", "run.sh");
const SWEEP = join(ROOT, "gate-d", "sweep.sh");
const CODE_LOOP = join(ROOT, "scripts", "gate-d-code-loop.py");
const CI = join(ROOT, ".github", "workflows", "ci.yml");

describe("Gate D corpus revision contract (#250)", () => {
  it("pins r1 at 10 tasks and exposes four holdouts only in r2", () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, "gate-d", "corpus.json"), "utf8")) as {
      defaultRevision: string;
      holdoutRevision: string;
      revisions: Record<string, {
        tasks: string[];
        holdoutTasks?: string[];
        acceptance: { denominator: number };
        pinnedCommit?: string;
        pinnedTaskTree?: string;
      }>;
    };
    expect(manifest.defaultRevision).toBe("gate-d-r1");
    expect(manifest.holdoutRevision).toBe("gate-d-r2");
    expect(manifest.revisions["gate-d-r1"]?.tasks).toHaveLength(10);
    expect(manifest.revisions["gate-d-r1"]?.pinnedCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(manifest.revisions["gate-d-r1"]?.pinnedTaskTree).toMatch(/^[0-9a-f]{40}$/);
    expect(manifest.revisions["gate-d-r2"]?.tasks).toHaveLength(14);
    expect(manifest.revisions["gate-d-r2"]?.holdoutTasks).toEqual([
      "11-node-path-containment",
      "12-add-csv-cli-format",
      "13-type-safe-slug-tests",
      "14-shared-handle-validation",
    ]);
    for (const revision of Object.values(manifest.revisions)) {
      expect(revision.acceptance.denominator).toBe(revision.tasks.length);
    }
  });

  it("enforces the committed r1 tree pin while running the complete verifier in CI", () => {
    const workflow = readFileSync(CI, "utf8");
    expect(workflow).toContain("fetch-depth: 0");
    expect(workflow).toContain("GATE_D_STRICT_PIN=1 bash gate-d/verify-fixtures.sh");
    expect(workflow).not.toContain("GATE_D_CONTRACT_ONLY=1");
  });

  it("uses immutable Node 24-native GitHub Action pins in CI (#73)", () => {
    const workflow = readFileSync(CI, "utf8");
    expect(workflow).toContain("actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1");
    expect(workflow).toContain("actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0");
    expect(workflow).toContain("node-version: '22'");
    expect(workflow).not.toMatch(/actions\/(checkout|setup-node)@v\d/);
  });

  it("shell runners use the manifest helper instead of filesystem task globs", () => {
    for (const path of [RUN, SWEEP]) {
      const source = readFileSync(path, "utf8");
      expect(source).toContain('CORPUS_TOOL="$ROOT/gate_d_corpus.py"');
      expect(source).toContain('python3 "$CORPUS_TOOL" tasks');
      expect(source).not.toContain('ls -d */');
      expect(source).not.toContain('"$ROOT"/tasks/*/');
    }
  });

  it("code-loop runner selects revisions and filters scoreboards by corpusRevision", () => {
    const source = readFileSync(CODE_LOOP, "utf8");
    expect(source).toContain('parser.add_argument("--include-holdout"');
    expect(source).toContain("corpus_revision = active_revision(manifest, include_holdout)");
    expect(source).toContain('prior.get("corpusRevision", "gate-d-r1")');
    expect(source).toContain('row.get("corpusRevision", "gate-d-r1")');
    expect(source).toContain('denominator = acceptance["denominator"]');
  });

  it("distinguishes unknown tasks and permits non-Git deployment trees unless strict pinning is requested", () => {
    const runner = readFileSync(RUN, "utf8");
    const verifier = readFileSync(join(ROOT, "gate-d", "verify-fixtures.sh"), "utf8");
    expect(runner).toContain("unknown Gate D task");
    expect(runner).toContain("holdouts require GATE_D_INCLUDE_HOLDOUT=1");
    expect(verifier).toContain('GATE_D_STRICT_PIN:-0');
    expect(verifier).toContain("tree pin skipped outside a git checkout");
  });
});

describe("Gate D verifier runtime integrity", () => {
  it("allows ordinary Node assertions and test registration", () => {
    const source = `
      import { strict as assert } from "node:assert";
      import { test } from "node:test";
      test("works", () => assert.equal(1 + 1, 2));
    `;
    expect(runtimeIntegrityViolations(source)).toEqual([]);
  });

  it("rejects candidate process control and mutation or escape of trusted test bindings", () => {
    const cases = [
      `process.exit(0);`,
      `const quit = (process as any)["exit"]; quit(0);`,
      `globalThis["process"].reallyExit(0);`,
      `import processControl from "node:process"; processControl.exit(0);`,
      `import assert from "node:assert/strict"; assert.equal = () => {};`,
      `import assert from "node:assert/strict"; Object.defineProperty(assert, "equal", { value() {} });`,
      `import { test } from "node:test"; test.only = () => {};`,
      `import { strict as assert } from "node:assert"; const replacement = assert;`,
      `import { strict as assert } from "node:assert"; let replacement; replacement = assert;`,
      `import { strict as assert } from "node:assert"; rewrite(assert);`,
      `import { strict as assert } from "node:assert"; function returnAssert() { return assert; }`,
      `import { strict as assert } from "node:assert"; const returnAssert = () => true ? assert : null;`,
      `const assert = (await import("node:" + "assert")).strict; Object.defineProperty(assert, "equal", { value() {} });`,
      `import { createRequire } from "node:module"; const assert = createRequire(import.meta.url)("node:assert").strict;`,
      `globalThis["pro" + "cess"].exit(0);`,
      `eval("process.exit(0)");`,
      `(() => {}).constructor("process.exit(0)")();`,
      `import vm from "node:vm"; vm.runInThisContext("process.exit(0)");`,
      `import "../.git/runtime-helper.ts";`,
    ];
    for (const source of cases) expect(runtimeIntegrityViolations(source)).not.toEqual([]);
  });
});

describe("Gate D AST assertion gate", () => {
  const withSubjectImport = (source: string): string =>
    `import { slugify } from "./slugify.ts";\n${source}`;

  it("accepts node:test callbacks, as-const tables, forEach, and common assert methods", () => {
    const cases = [
      "import { strict as assert } from 'node:assert'; assert.equal(slugify('a'),'a'); assert.equal(slugify('b'),'b'); assert.strictEqual(slugify('c'),'c');",
      "import assert from 'node:assert/strict'; const cases = [['a','a'],['b','b'],['c','c']] as const; for (const [a,b] of cases) assert.deepEqual(slugify(a), b);",
      "import { test as spec } from 'node:test'; import * as check from 'node:assert'; spec('slug', () => { check.ok(slugify('a') === 'a'); check.deepEqual(slugify('b'),'b'); check.match(slugify('c'), /c/); });",
      "import { strict as assert } from 'node:assert'; const cases = [['a','a'],['b','b'],['c','c']] as const; cases.forEach(([a,b]) => assert.equal(slugify(a), b));",
      "import { equal as eq, notStrictEqual, throws } from 'node:assert/strict'; eq(slugify('a'),'a'); notStrictEqual(slugify('b'),'wrong'); throws(() => slugify(null as never));",
      "import { test } from 'node:test'; test('slug', (t) => { t.assert.equal(slugify('a'),'a'); t.assert.notEqual(slugify('b'),'wrong'); t.assert.throws(() => slugify(null as never)); });",
      "import assert from 'node:assert'; assert.strict.equal(slugify('a'),'a'); assert.strict.equal(slugify('b'),'b'); assert.strict.equal(slugify('c'),'c');",
      "import assert from 'node:assert/strict'; assert(slugify('a') === 'a'); assert(slugify('b') === 'b'); assert(slugify('c') === 'c');",
      "import { slugify as makeSlug } from './slugify.ts'; import assert from 'node:assert/strict'; assert.equal(makeSlug('a'),'a'); assert.equal(makeSlug('b'),'b'); assert.equal(makeSlug('c'),'c');",
      "import { test } from 'node:test'; import assert from 'node:assert/strict'; test('slug', { skip: false, todo: false }, () => { assert.equal(slugify('a'),'a'); assert.equal(slugify('b'),'b'); assert.equal(slugify('c'),'c'); });",
      "import { test } from 'node:test'; import assert from 'node:assert/strict'; const options = { skip: false, todo: '' }; test('slug', options, () => { assert.equal(slugify('a'),'a'); assert.equal(slugify('b'),'b'); assert.equal(slugify('c'),'c'); });",
      "import assert from 'node:assert/strict'; for (const row of [,,,]) assert.equal(slugify(row), row);",
      "import assert from 'node:assert/strict'; assert.rejects(async () => { await Promise.resolve(); slugify('a'); }); assert.rejects(async () => { await Promise.resolve(); slugify('b'); }); assert.rejects(async () => { await Promise.resolve(); slugify('c'); });",
    ];
    expect(cases.map((source) => analyzeAssertions(withSubjectImport(source), "slugify", 3).pass)).toEqual(cases.map(() => true));
  });

  it("rejects vacuous, uncalled, and unreachable assertions", () => {
    const cases = [
      "import { strict as assert } from 'node:assert'; slugify('unused'); assert.equal(1,1); assert.equal(2,2); assert.strictEqual(3,3);",
      "import { strict as assert } from 'node:assert'; function neverCalled() { assert.equal(slugify('a'),'a'); assert.equal(slugify('b'),'b'); assert.equal(slugify('c'),'c'); }",
      "import { strict as assert } from 'node:assert'; if (false) { assert.equal(slugify('a'),'a'); assert.equal(slugify('b'),'b'); assert.equal(slugify('c'),'c'); }",
      "import { strict as assert } from 'node:assert'; const fake = { test(_name: string, _callback: () => void) {} }; fake.test('slug', () => { assert.equal(slugify('a'),'a'); assert.equal(slugify('b'),'b'); assert.equal(slugify('c'),'c'); });",
      "import { test } from 'node:test'; const assert = { equal(..._args: unknown[]) {} }; test('slug', () => { assert.equal(slugify('a'),'a'); assert.equal(slugify('b'),'b'); assert.equal(slugify('c'),'c'); });",
      "import { strict as assert } from 'node:assert'; function test(_name: string, _callback: () => void) {} test('slug', () => { assert.equal(slugify('a'),'a'); assert.equal(slugify('b'),'b'); assert.equal(slugify('c'),'c'); });",
      "import { strict as assert } from 'node:assert'; false && assert.equal(slugify('a'),'a'); false && assert.equal(slugify('b'),'b'); false && assert.equal(slugify('c'),'c');",
      "import { strict as assert } from 'node:assert'; assert.equal(false && slugify('a'), false); assert.equal(true || slugify('b'), true); assert.equal(false ? slugify('c') : '', '');",
      "import { strict as assert } from 'node:assert'; [1, 2, 3].forEach(() => assert.equal(slugify('same'), 'same'));",
      "const t = { assert: { equal(..._args: unknown[]) {} } }; t.assert.equal(slugify('a'),'a'); t.assert.equal(slugify('b'),'b'); t.assert.equal(slugify('c'),'c');",
      "import { describe } from 'node:test'; describe('slug', (t) => { t.assert.equal(slugify('a'),'a'); t.assert.equal(slugify('b'),'b'); t.assert.equal(slugify('c'),'c'); });",
      "import { test } from 'node:test'; import assert from 'node:assert/strict'; test('slug', { skip: true }, () => { assert.equal(slugify('a'),'a'); assert.equal(slugify('b'),'b'); assert.equal(slugify('c'),'c'); });",
      "import { test } from 'node:test'; import assert from 'node:assert/strict'; test.todo('slug', () => { assert.equal(slugify('a'),'a'); assert.equal(slugify('b'),'b'); assert.equal(slugify('c'),'c'); });",
      "import { test } from 'node:test'; import assert from 'node:assert/strict'; test('slug', { skip: 'reason' }, () => { assert.equal(slugify('a'),'a'); assert.equal(slugify('b'),'b'); assert.equal(slugify('c'),'c'); });",
      "import { test } from 'node:test'; import assert from 'node:assert/strict'; const options = { todo: 'later' }; test('slug', options, () => { assert.equal(slugify('a'),'a'); assert.equal(slugify('b'),'b'); assert.equal(slugify('c'),'c'); });",
      "import { test } from 'node:test'; import assert from 'node:assert/strict'; const options = getOptions(); test('slug', options, () => { assert.equal(slugify('a'),'a'); assert.equal(slugify('b'),'b'); assert.equal(slugify('c'),'c'); }); function getOptions(): { skip: string } { return { skip: 'later' }; }",
      "import { test } from 'node:test'; import assert from 'node:assert/strict'; test('slug', (t) => { assert.equal(slugify('a'),'wrong'); t.skip('later'); assert.equal(slugify('b'),'wrong'); assert.equal(slugify('c'),'wrong'); });",
    ];
    expect(cases.map((source) => analyzeAssertions(withSubjectImport(source), "slugify", 3).pass)).toEqual(cases.map(() => false));
  });

  it("uses zero for unknown for-of cardinality without inflating invariant expected values", () => {
    const unknownCardinality = [
      "import assert from 'node:assert/strict'; const table = { a: 'a' }; for (const [input, expected] of Object.entries(table)) assert.equal(slugify(input), expected);",
      "import assert from 'node:assert/strict'; const rows = ['a'].map((input) => ({ input, expected: input })); for (const row of rows) assert.equal(slugify(row.input), row.expected);",
      "import assert from 'node:assert/strict'; const rows = [{ input: 'a', expected: 'a' }]; for (const row of [...rows]) assert.equal(slugify(row.input), row.expected);",
    ];
    expect(unknownCardinality.map((source) => analyzeAssertions(withSubjectImport(source), "slugify", 1).pass)).toEqual([false, false, false]);
    expect(analyzeAssertions(withSubjectImport(
      "import assert from 'node:assert/strict'; const rows = [{ input: 'a', expected: 'a' }] as const; for (const row of rows) assert.equal(slugify(row.input), row.expected);"
    ), "slugify", 1).pass).toBe(true);

    const invariantExpected = [
      "import assert from 'node:assert/strict'; for (const expected of ['same','same','same']) assert.equal(slugify('same'), expected);",
      "import assert from 'node:assert/strict'; for (const expected of ['same','same','same']) assert.ok(slugify('same') === expected);",
    ];
    expect(invariantExpected.map((source) => analyzeAssertions(withSubjectImport(source), "slugify", 3).pass)).toEqual([false, false]);
  });

  it("does not sum mutually exclusive unknown branches into multiple executions", () => {
    const cases = [
      `const branch = Date.now() % 3;
       if (branch === 0) assert.equal(slugify("a"), "a");
       else if (branch === 1) assert.equal(slugify("b"), "b");
       else assert.equal(slugify("c"), "c");`,
      `const branch = Date.now() % 3;
       branch === 0 ? assert.equal(slugify("a"), "a")
         : branch === 1 ? assert.equal(slugify("b"), "b")
         : assert.equal(slugify("c"), "c");`,
      `const branch = Date.now() % 3;
       switch (branch) {
         case 0: assert.equal(slugify("a"), "a"); break;
         case 1: assert.equal(slugify("b"), "b"); break;
         default: assert.equal(slugify("c"), "c");
       }`,
    ].map((body) => withSubjectImport(`import assert from "node:assert/strict"; ${body}`));
    const results = cases.map((source) => analyzeAssertions(source, "slugify", 3));
    expect(results.map((result) => result.subjectAssertionExecutions)).toEqual([1, 1, 1]);
    expect(results.map((result) => result.pass)).toEqual([false, false, false]);

    const tryCatch = analyzeAssertions(withSubjectImport(`
      import assert from "node:assert/strict";
      try { assert.equal(slugify("a"), "a"); }
      catch { assert.equal(slugify("b"), "b"); }
      finally { assert.equal(slugify("c"), "c"); }
    `), "slugify", 3);
    expect(tryCatch.subjectAssertionExecutions).toBe(2);
    expect(tryCatch.pass).toBe(false);
  });

  it("requires the imported subject call on every reachable assertion-argument path", () => {
    const hidden = [
      `const run = false; assert.equal(run && slugify("a"), false); assert.equal(run && slugify("b"), false); assert.equal(run && slugify("c"), false);`,
      `const skip = true; assert.equal(skip || slugify("a"), true); assert.equal(skip || slugify("b"), true); assert.equal(skip || slugify("c"), true);`,
      `const choose = false; assert.equal(choose ? slugify("a") : "", ""); assert.equal(choose ? slugify("b") : "", ""); assert.equal(choose ? slugify("c") : "", "");`,
    ].map((body) => withSubjectImport(`import assert from "node:assert/strict"; ${body}`));
    const hiddenResults = hidden.map((source) => analyzeAssertions(source, "slugify", 3));
    expect(hiddenResults.map((result) => result.subjectAssertionExecutions)).toEqual([0, 0, 0]);
    expect(hiddenResults.map((result) => result.pass)).toEqual([false, false, false]);

    const staticallyLive = withSubjectImport(`
      import assert from "node:assert/strict";
      assert.equal(true && slugify("a"), "a");
      assert.equal(false || slugify("b"), "b");
      assert.equal(true ? slugify("c") : "", "c");
      assert.equal(false ? "" : slugify("d"), "d");
    `);
    expect(analyzeAssertions(staticallyLive, "slugify", 4).pass).toBe(true);
  });

  it("uses a guaranteed lower bound across callbacks, loops, switch exits, and array cardinality", () => {
    const cases = [
      `import { test } from "node:test"; import assert from "node:assert/strict"; test("dead", () => { return; assert.equal(slugify("a"), "a"); assert.equal(slugify("b"), "b"); assert.equal(slugify("c"), "c"); });`,
      `import assert from "node:assert/strict"; while (false) { assert.equal(slugify("a"), "a"); assert.equal(slugify("b"), "b"); assert.equal(slugify("c"), "c"); }`,
      `import assert from "node:assert/strict"; for (; false;) { assert.equal(slugify("a"), "a"); assert.equal(slugify("b"), "b"); assert.equal(slugify("c"), "c"); }`,
      `import assert from "node:assert/strict"; const xs = new Set<string>(); for (const x of xs) { assert.equal(slugify(x), x); assert.equal(slugify(x), x); assert.equal(slugify(x), x); }`,
      `import assert from "node:assert/strict"; for (const x of []) { assert.equal(slugify("a"), x); assert.equal(slugify("b"), x); assert.equal(slugify("c"), x); }`,
      `import assert from "node:assert/strict"; const guard = true; switch (0) { case 0: if (guard) break; default: assert.equal(slugify("a"), "a"); assert.equal(slugify("b"), "b"); assert.equal(slugify("c"), "c"); }`,
      `import assert from "node:assert/strict"; const rows = ["a", "b", "c"]; rows.length = 0; for (const row of rows) assert.equal(slugify(row), row);`,
      `import assert from "node:assert/strict"; const rows = ["a", "b", "c"]; const alias = rows; alias.length = 0; for (const row of rows) assert.equal(slugify(row), row);`,
      `import assert from "node:assert/strict"; const rows = ["a", "b", "c"]; function wipe(values: string[]) { values.length = 0; } wipe(rows); for (const row of rows) assert.equal(slugify(row), row);`,
      `import assert from "node:assert/strict"; const rows = ["a", "b", "c"]; const box = { rows }; box.rows.length = 0; for (const row of rows) assert.equal(slugify(row), row);`,
      `import assert from "node:assert/strict"; const rows = ["a", "b", "c"]; const holders = [rows]; holders[0].length = 0; for (const row of rows) assert.equal(slugify(row), row);`,
      `import assert from "node:assert/strict"; const rows: string[] = []; { const rows = ["a", "b", "c"]; void rows; } for (const row of rows) assert.equal(slugify(row), row);`,
    ].map(withSubjectImport);
    const results = cases.map((source) => analyzeAssertions(source, "slugify", 3));
    expect(results.map((result) => result.subjectAssertionExecutions)).toEqual(cases.map(() => 0));
    expect(results.map((result) => result.pass)).toEqual(cases.map(() => false));
  });

  it("rejects optional, sparse, overridden, inert, abrupt, and class-only execution syntax", () => {
    const cases = [
      `import assert from "node:assert/strict"; const maybe: any = undefined; assert.equal(maybe?.fn(slugify("a")), undefined);`,
      `import assert from "node:assert/strict"; const maybe: any = undefined; assert.equal(maybe?.["fn"](slugify("a")), undefined);`,
      `import assert from "node:assert/strict"; const rows = [,,,]; rows.forEach((row) => assert.equal(slugify(row), row));`,
      `import assert from "node:assert/strict"; const rows = ["a", "b", "c"]; rows.forEach = () => {}; rows.forEach((row) => assert.equal(slugify(row), row));`,
      `import assert from "node:assert/strict"; Array.prototype.forEach = function () {}; const rows = ["a", "b", "c"]; rows.forEach((row) => assert.equal(slugify(row), row));`,
      `import assert from "node:assert/strict"; Array.prototype["forEach"] = function () {}; const rows = ["a", "b", "c"]; rows.forEach((row) => assert.equal(slugify(row), row));`,
      `import assert from "node:assert/strict"; Object.defineProperty(Array.prototype, "forEach", { value() {} }); const rows = ["a", "b", "c"]; rows.forEach((row) => assert.equal(slugify(row), row));`,
      `import assert from "node:assert/strict"; const rows = ["a", "b", "c"]; rows.forEach(function* (row) { assert.equal(slugify(row), row); });`,
      `import assert from "node:assert/strict"; const rows = ["a", "b", "c"]; rows.forEach(async (row) => { await new Promise(() => {}); assert.equal(slugify(row), row); });`,
      `import { test } from "node:test"; import assert from "node:assert/strict"; test("inert", function* () { assert.equal(slugify("a"), "a"); });`,
      `import assert from "node:assert/strict"; assert.doesNotThrow(function* () { slugify("a"); });`,
      `import assert from "node:assert/strict"; assert.doesNotThrow(async () => { await new Promise(() => {}); slugify("a"); });`,
      `import assert from "node:assert/strict"; process.exit(0); assert.equal(slugify("a"), "a"); assert.equal(slugify("b"), "b"); assert.equal(slugify("c"), "c");`,
      `import assert from "node:assert/strict"; const quit = (process as any)["exit"]; quit(0); assert.equal(slugify("a"), "a"); assert.equal(slugify("b"), "b"); assert.equal(slugify("c"), "c");`,
      `import assert from "node:assert/strict"; (globalThis.process as any).reallyExit(0); assert.equal(slugify("a"), "a"); assert.equal(slugify("b"), "b"); assert.equal(slugify("c"), "c");`,
      `import assert from "node:assert/strict"; assert.ok(class { value = slugify("a"); });`,
      `import assert from "node:assert/strict"; assert.equal = () => {}; assert.equal(slugify("a"), "wrong"); assert.equal(slugify("b"), "wrong"); assert.equal(slugify("c"), "wrong");`,
      `import assert from "node:assert/strict"; Object.defineProperty(assert, "equal", { value() {} }); assert.equal(slugify("a"), "wrong"); assert.equal(slugify("b"), "wrong"); assert.equal(slugify("c"), "wrong");`,
      `import { test } from "node:test"; import assert from "node:assert/strict"; test.only = (_name: string, _callback: () => void) => {}; test.only("fake", () => { assert.equal(slugify("a"), "a"); assert.equal(slugify("b"), "b"); assert.equal(slugify("c"), "c"); });`,
      `import { test } from "node:test"; import assert from "node:assert/strict"; test("inherited skip", { __proto__: { skip: true } }, () => { assert.equal(slugify("a"), "a"); assert.equal(slugify("b"), "b"); assert.equal(slugify("c"), "c"); });`,
      `import { test } from "node:test"; import assert from "node:assert/strict"; const options = { skip: false }; options.skip = true; test("mutated skip", options, () => { assert.equal(slugify("a"), "a"); assert.equal(slugify("b"), "b"); assert.equal(slugify("c"), "c"); });`,
    ].map(withSubjectImport);
    const results = cases.map((source) => analyzeAssertions(source, "slugify", 1));
    expect(results.map((result) => result.subjectAssertionExecutions)).toEqual(cases.map(() => 0));
    expect(results.map((result) => result.pass)).toEqual(cases.map(() => false));
  });

  it("requires authentic unshadowed node and subject bindings", () => {
    const cases = [
      withSubjectImport(`import assert from "node:assert/strict"; { const assert = { equal() {} }; assert.equal(slugify("a"), "a"); assert.equal(slugify("b"), "b"); assert.equal(slugify("c"), "c"); }`),
      `import assert from "node:assert/strict"; function slugify(value: string) { return value; } assert.equal(slugify("a"), "a"); assert.equal(slugify("b"), "b"); assert.equal(slugify("c"), "c");`,
      withSubjectImport(`import { test } from "node:test"; import assert from "node:assert/strict"; { const test = (_name: string, _callback: () => void) => {}; test("fake", () => { assert.equal(slugify("a"), "a"); assert.equal(slugify("b"), "b"); assert.equal(slugify("c"), "c"); }); }`),
      `import assert from "node:assert/strict"; const slugify = (value: string) => value; assert.equal(slugify("a"), "a"); assert.equal(slugify("b"), "b"); assert.equal(slugify("c"), "c");`,
    ];
    expect(cases.map((source) => analyzeAssertions(source, "slugify", 3).pass)).toEqual([false, false, false, false]);
  });

  it("executes the visible task-13 test so meaningful but wrong assertions are rejected", () => {
    const meta = JSON.parse(readFileSync(join(ROOT, "gate-d", "tasks", "13-type-safe-slug-tests", "meta.json"), "utf8")) as {
      structural: string;
    };
    expect(meta.structural).toBe("npx --no-install tsx test/slugify.test.ts");
  });
});

describe("Gate D AST structural contracts", () => {
  it("accepts equivalent TypeScript styles and rejects look-alike module paths", () => {
    const dir = mkdtempSync(join(tmpdir(), "gd-structure-"));
    try {
      const exported = join(dir, "format.ts");
      const consumer = join(dir, "cli.ts");
      writeFileSync(exported, "export const formatCsv = (rows: unknown[]) => String(rows.length);\n");
      writeFileSync(consumer, 'import {\n  formatCsv as csv\n} from "./format.ts";\nexport const run = () => csv([]);\n');
      expect(hasCallableExport(exported, "formatCsv")).toBe(true);
      expect(hasImportedCall(consumer, "formatCsv", "./format", "run")).toBe(true);

      writeFileSync(exported, "const validate = (value: string): void => { void value; };\nexport { validate as assertValidHandle };\n");
      writeFileSync(consumer, 'import * as validation from "./validate.ts";\nexport function normalize(v: string) { validation.assertValidHandle(v); return v; }\n');
      expect(hasCallableExport(exported, "assertValidHandle")).toBe(true);
      expect(hasImportedCall(consumer, "assertValidHandle", "./validate", "normalize")).toBe(true);

      writeFileSync(consumer, 'import { formatCsv } from "./format-backup.ts";\nvoid formatCsv([]);\n');
      expect(hasImportedCall(consumer, "formatCsv", "./format", "run")).toBe(false);

      writeFileSync(consumer, [
        'import { formatCsv } from "./format.ts";',
        'function deadHelper() { return formatCsv([]); }',
        'void deadHelper;',
        'export function run() { return "inlined"; }',
      ].join("\n"));
      expect(hasImportedCall(consumer, "formatCsv", "./format", "run")).toBe(false);

      writeFileSync(consumer, 'import { formatCsv } from "./format.ts";\nexport function run() { if (false) formatCsv([]); return "inlined"; }\n');
      expect(hasImportedCall(consumer, "formatCsv", "./format", "run")).toBe(false);

      writeFileSync(consumer, 'import { formatCsv } from "./format.ts";\nexport function run() { false && formatCsv([]); true || formatCsv([]); while (false) formatCsv([]); return "inlined"; }\n');
      expect(hasImportedCall(consumer, "formatCsv", "./format", "run")).toBe(false);

      writeFileSync(consumer, [
        'import { formatCsv } from "./format.ts";',
        'function csv(rows: unknown[]) { return formatCsv(rows); }',
        'export function run(argv: string[]) { return argv.includes("--csv") ? csv([]) : "text"; }',
      ].join("\n"));
      expect(hasImportedReturnFlow(consumer, "formatCsv", "./format", "run")).toBe(true);

      writeFileSync(consumer, 'import { formatCsv } from "./format.ts";\nexport function run() { void formatCsv([]); return "inline"; }\n');
      expect(hasImportedReturnFlow(consumer, "formatCsv", "./format", "run")).toBe(false);

      writeFileSync(consumer, 'import { formatCsv } from "./format.ts";\nexport function run() { return (formatCsv([]), "inline"); }\n');
      expect(hasImportedReturnFlow(consumer, "formatCsv", "./format", "run")).toBe(false);

      writeFileSync(consumer, 'import { formatCsv } from "./format.ts";\nexport function run() { return void formatCsv([]); }\n');
      expect(hasImportedReturnFlow(consumer, "formatCsv", "./format", "run")).toBe(false);

      writeFileSync(consumer, [
        'import { assertValidHandle } from "./validate.ts";',
        'function check(value: string) { assertValidHandle(value); }',
        'export function normalizeHandle(value: string) { const normalized = value.trim().toLowerCase(); check(normalized); return normalized; }',
      ].join("\n"));
      expect(hasImportedValidatedReturn(consumer, "assertValidHandle", "./validate", "normalizeHandle")).toBe(true);

      writeFileSync(consumer, 'import { assertValidHandle } from "./validate.ts";\nexport function normalizeHandle(value: string) { const normalized = value.trim().toLowerCase(); assertValidHandle("other"); return normalized; }\n');
      expect(hasImportedValidatedReturn(consumer, "assertValidHandle", "./validate", "normalizeHandle")).toBe(false);

      writeFileSync(consumer, 'import { assertValidHandle } from "./validate.ts";\nexport function normalizeHandle(value: string) { const normalized = value.trim().toLowerCase(); if (value === "never") assertValidHandle(normalized); return normalized; }\n');
      expect(hasImportedValidatedReturn(consumer, "assertValidHandle", "./validate", "normalizeHandle")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("models loops, switches, and try/catch without treating unreachable validators as live", () => {
    const dir = mkdtempSync(join(tmpdir(), "gd-control-flow-"));
    try {
      const consumer = join(dir, "consumer.ts");
      const returnFlowCases = [
        'import { formatCsv } from "./format.ts"; export function run(argv: string[]) { for (const arg of argv) { if (arg === "--csv") return formatCsv([]); } return "text"; }',
        'import { formatCsv } from "./format.ts"; export function run(argv: string[]) { for (let i = 0; i < argv.length; i++) { if (argv[i] === "--csv") return formatCsv([]); } return "text"; }',
        'import { formatCsv } from "./format.ts"; export function run(mode: string) { switch (mode) { case "csv": return formatCsv([]); default: return "text"; } }',
        'import { formatCsv } from "./format.ts"; export function run() { try { return formatCsv([]); } catch (error) { throw error; } }',
      ];
      const returnFlowResults = returnFlowCases.map((source) => {
        writeFileSync(consumer, source);
        return hasImportedReturnFlow(consumer, "formatCsv", "./format", "run");
      });
      expect(returnFlowResults).toEqual(returnFlowCases.map(() => true));

      const rejectedValidatorCases = [
        'import { assertValidHandle } from "./validate.ts"; export function normalizeHandle(value: string) { const normalized = value.trim(); try { assertValidHandle(normalized); } catch {} return normalized; }',
        'import { assertValidHandle } from "./validate.ts"; export function normalizeHandle(value: string) { const normalized = value.trim(); while (false) assertValidHandle(normalized); return normalized; }',
        'import { assertValidHandle } from "./validate.ts"; export function normalizeHandle(value: string) { const normalized = value.trim(); switch ("text") { case "csv": assertValidHandle(normalized); break; } return normalized; }',
      ];
      for (const source of rejectedValidatorCases) {
        writeFileSync(consumer, source);
        expect(hasImportedValidatedReturn(consumer, "assertValidHandle", "./validate", "normalizeHandle")).toBe(false);
      }

      writeFileSync(consumer, 'import { assertValidHandle } from "./validate.ts"; export function normalizeHandle(value: string) { const normalized = value.trim(); try { assertValidHandle(normalized); return normalized; } catch (error) { throw error; } }');
      expect(hasImportedValidatedReturn(consumer, "assertValidHandle", "./validate", "normalizeHandle")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects shadowed imports, unmodeled result laundering, and unreachable dependency flow", () => {
    const dir = mkdtempSync(join(tmpdir(), "gd-flow-hardening-"));
    try {
      const consumer = join(dir, "consumer.ts");
      const rejectedReturnFlows = [
        `import { formatCsv } from "./format.ts"; export function run() { const formatCsv = () => "fake"; return formatCsv(); }`,
        `import { formatCsv } from "./format.ts"; export function run() { function passthrough(_ignored: string, value: string) { return value; } return passthrough(formatCsv([]), "inline fake csv"); }`,
        `import { formatCsv } from "./format.ts"; export function run() { if (false && unknown) return formatCsv([]); return "text"; }`,
        `import { formatCsv } from "./format.ts"; export function run() { for (const row of []) return formatCsv([row]); return "text"; }`,
        `import { formatCsv } from "./format.ts"; export function run() { return formatCsv([]) && "inline fake csv"; }`,
        `import { formatCsv } from "./format.ts"; export function run(argv: string[]) { if (Date.now() < 0) return formatCsv([]); return argv.includes("--csv") ? "inline fake csv" : "text"; }`,
        `import { formatCsv } from "./format.ts"; function choose(x: string, y: string) { return Date.now() < 0 ? x : y; } export function run(argv: string[]) { return argv.includes("--csv") ? choose(formatCsv([]), "inline fake csv") : "text"; }`,
        `import { formatCsv } from "./format.ts"; export function run(argv: string[]) { return argv.includes("--csv") ? [formatCsv([]), "inline fake csv"][1] : "text"; }`,
        `import { formatCsv } from "./format.ts"; export function run(argv: string[]) { return argv.includes("--csv") ? ({ real: formatCsv([]), fake: "inline fake csv" }["fake"]) : "text"; }`,
        `import { formatCsv } from "./format.ts"; export function run(argv: string[]) { return argv.includes("--csv") ? formatCsv([]).slice(0, 0).concat("inline fake csv") : "text"; }`,
        `import { formatCsv } from "./format.ts"; export function run(argv: string[]) { return argv.includes("--csv") ? formatCsv([]).substring(0, 0).concat("inline fake csv") : "text"; }`,
        `import { formatCsv } from "./format.ts"; export function run(argv: string[]) { return argv[999] === "--csv" ? formatCsv([]) : "inline fake csv"; }`,
        `import { formatCsv } from "./format.ts"; export function run(argv: string[]) { if (Date.now() < argv.length) return formatCsv([]); return argv.includes("--csv") ? "inline fake csv" : "text"; }`,
        `import { formatCsv } from "./format.ts"; export function run(argv: string[]) { argv.includes = () => false; return argv.includes("--csv") ? formatCsv([]) : argv[1] === "--csv" ? "inline fake csv" : "text"; }`,
        `import { formatCsv } from "./format.ts"; function poison(args: string[]) { args.includes = () => false; } export function run(argv: string[]) { poison(argv); return argv.includes("--csv") ? formatCsv([]) : argv[1] === "--csv" ? "inline fake csv" : "text"; }`,
        `import { formatCsv } from "./format.ts"; export function run(argv: string[]) { Date.now() > 0 && (argv.includes = () => false); return argv.includes("--csv") ? formatCsv([]) : argv[1] === "--csv" ? "inline fake csv" : "text"; }`,
        `import { formatCsv } from "./format.ts"; export function run(argv: string[]) { const csv = argv.includes("--csv"); argv.length = 0; for (const _arg of argv) return formatCsv([]); return csv ? "inline fake csv" : "text"; }`,
        `import { formatCsv } from "./format.ts"; export function run(argv: string[]) { delete (argv as any).includes; return argv.includes?.("--csv") ? formatCsv([]) : argv[1] === "--csv" ? "inline fake csv" : "text"; }`,
        `import { formatCsv } from "./format.ts"; export function run(argv: string[]) { Object.defineProperty(argv, "includes", { value: () => false }); return argv.includes("--csv") ? formatCsv([]) : argv[1] === "--csv" ? "inline fake csv" : "text"; }`,
      ];
      const returnResults = rejectedReturnFlows.map((source) => {
        writeFileSync(consumer, source);
        return hasImportedReturnFlow(consumer, "formatCsv", "./format", "run");
      });
      expect(returnResults).toEqual(rejectedReturnFlows.map(() => false));

      const rejectedValidatedReturns = [
        `import { assertValidHandle } from "./validate.ts"; export function normalizeHandle(value: string) { const assertValidHandle = (_value: string) => {}; const normalized = value.trim(); assertValidHandle(normalized); return normalized; }`,
        `import { assertValidHandle } from "./validate.ts"; export function normalizeHandle(value: string) { const normalized = encodeURI(value); assertValidHandle(value); return normalized; }`,
        `import { assertValidHandle } from "./validate.ts"; export function normalizeHandle(value: string) { assertValidHandle(value); return \`\${value}!\`; }`,
        `import { assertValidHandle } from "./validate.ts"; export function normalizeHandle(value: string) { const normalized = value.trim(); const dead = () => assertValidHandle(normalized); void dead; return normalized; }`,
        `import { assertValidHandle } from "./validate.ts"; export function normalizeHandle(value: string) { const normalized = value.trim(); [].forEach(() => assertValidHandle(normalized)); return normalized; }`,
        `import { assertValidHandle } from "./validate.ts"; export function normalizeHandle(value: string) { const box = { v: "safe" }; assertValidHandle(box.v); box.v = value.trim().toLowerCase(); if (!/^[a-z0-9_-]{1,20}$/i.test(box.v)) throw new Error("invalid"); return box.v; }`,
        `import { assertValidHandle } from "./validate.ts"; export function normalizeHandle(value: string) { const normalized = value.trim().toLowerCase(); const fake = (candidate: string) => { if (!/^[a-z0-9_-]{1,20}$/i.test(candidate)) throw new Error("invalid"); }; [assertValidHandle, fake][1](normalized); return normalized; }`,
        `import { assertValidHandle } from "./validate.ts"; export function normalizeHandle(value: string, pick: number) { const normalized = value.trim().toLowerCase(); const fake = (_candidate: string) => {}; [assertValidHandle, fake][pick](normalized); return normalized; }`,
        `import { assertValidHandle } from "./validate.ts"; export function normalizeHandle(value: string) { const normalized = value.trim().toLowerCase(); const box = { checked: "safe", returned: normalized }; const { checked, returned } = box; assertValidHandle(checked); if (!/^[a-z0-9_-]{1,20}$/i.test(returned)) throw new Error("invalid"); return returned; }`,
        `import { assertValidHandle } from "./validate.ts"; export function normalizeHandle(value: string) { const normalized = value.trim().toLowerCase(); const fake = (_candidate: string) => {}; ({ real: assertValidHandle, fake })["fake"](normalized); return normalized; }`,
        `import { assertValidHandle } from "./validate.ts"; export function normalizeHandle(value: string) { let normalized = "safe"; assertValidHandle(normalized); normalized &&= value.trim().toLowerCase(); if (!/^[a-z0-9_-]{1,20}$/i.test(normalized)) throw new Error("invalid"); return normalized; }`,
      ];
      const validatedResults = rejectedValidatedReturns.map((source) => {
        writeFileSync(consumer, source);
        return hasImportedValidatedReturn(consumer, "assertValidHandle", "./validate", "normalizeHandle");
      });
      expect(validatedResults).toEqual(rejectedValidatedReturns.map(() => false));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves imported-result provenance through modeled transforms and containers", () => {
    const dir = mkdtempSync(join(tmpdir(), "gd-flow-positives-"));
    try {
      const consumer = join(dir, "consumer.ts");
      const accepted = [
        `import { formatCsv } from "./format.ts"; export function run() { const csv = formatCsv([]); return csv.trimEnd(); }`,
        `import { formatCsv } from "./format.ts"; export function run(fmt: "csv") { return ({ csv: formatCsv }[fmt])([]); }`,
        `import { formatCsv } from "./format.ts"; export function run() { return [formatCsv([])].join("\\n"); }`,
        `import { formatCsv } from "./format.ts"; export function run() { return [formatCsv([])][0]; }`,
        `import { formatCsv } from "./format.ts"; export function run() { return ({ csv: formatCsv([]) })["csv"]; }`,
        `import { formatCsv } from "./format.ts"; export function run() { return formatCsv([]).concat("\\n"); }`,
      ];
      const results = accepted.map((source) => {
        writeFileSync(consumer, source);
        return hasImportedReturnFlow(consumer, "formatCsv", "./format", "run");
      });
      expect(results).toEqual(accepted.map(() => true));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
