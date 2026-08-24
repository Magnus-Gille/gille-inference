import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

/**
 * Validation for gate-d/peek-scan.py.
 *
 * The first version of the scanner reported `solutionInTranscript` by matching distinctive lines of
 * the reference solution against the harness transcript. Measured over 60 known-good Gate-D runs it
 * fired on 30/30 legitimate passing runs, because on tasks this small a *correct* implementation is
 * textually the reference solution — it measured convergence, not access.
 *
 * These tests pin the replacement's discriminating power directly: every leak signal must fire on a
 * planted leak (positive control) and stay silent on honest work that merely converges on the same
 * code (negative control). The negative controls are the ones that matter — they are the exact
 * failure mode that made the previous signal worthless.
 */

const REPO = resolve(__dirname, "..");
const SCANNER = join(REPO, "gate-d", "peek-scan.py");
const TASK_HIDDEN = join(REPO, "gate-d", "tasks", "05-tdd-write-test-then-impl");
const TASK_PLAIN = join(REPO, "gate-d", "tasks", "01-make-failing-test-pass");

const tmp = mkdtempSync(join(tmpdir(), "peek-scan-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function scan(taskDir: string, transcript: string): Record<string, boolean> {
  const p = join(tmp, `t-${Math.random().toString(36).slice(2)}.txt`);
  writeFileSync(p, transcript);
  const out = execFileSync("python3", [SCANNER, taskDir, p], { encoding: "utf8" });
  return JSON.parse(out) as Record<string, boolean>;
}

function firstFileUnder(dir: string): string {
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const entry of readdirSync(cur)) {
      const full = join(cur, entry);
      if (statSync(full).isDirectory()) stack.push(full);
      else return full;
    }
  }
  throw new Error(`no files under ${dir}`);
}

describe("peek-scan: positive controls (a planted leak must be detected)", () => {
  it("detects a reference-solution path reference", () => {
    const r = scan(TASK_PLAIN, `reading file ${join(TASK_PLAIN, "solution", "src", "sum.ts")}\n`);
    expect(r.graderPathInTranscript).toBe(true);
  });

  it("detects a hidden-oracle path reference", () => {
    const r = scan(TASK_HIDDEN, `cat ${join(TASK_HIDDEN, "oracle", "clamp.oracle.ts")}\n`);
    expect(r.graderPathInTranscript).toBe(true);
  });

  it("detects verbatim hidden-oracle content via its arbitrary literals", () => {
    const oracle = readFileSync(join(TASK_HIDDEN, "oracle", "clamp.oracle.ts"), "utf8");
    const r = scan(TASK_HIDDEN, `here is what I found:\n${oracle}\n`);
    expect(r.hiddenOracleMarkerInTranscript).toBe(true);
  });

  it("detects the reference-solution banner", () => {
    const sol = readFileSync(firstFileUnder(join(TASK_PLAIN, "solution")), "utf8");
    const r = scan(TASK_PLAIN, sol);
    expect(r.solutionMarkerInTranscript).toBe(true);
  });
});

describe("peek-scan: negative controls (honest work must NOT trip a leak signal)", () => {
  it("does NOT fire on a correct implementation that converges on the reference solution", () => {
    // This is the regression that killed the previous signal: identical *code*, no access.
    const solPath = firstFileUnder(join(TASK_PLAIN, "solution"));
    const codeOnly = readFileSync(solPath, "utf8")
      .split("\n")
      .filter((l) => !l.includes("REFERENCE SOLUTION"))
      .join("\n");
    const r = scan(TASK_PLAIN, `I'll implement it:\n${codeOnly}\n`);
    expect(r.solutionMarkerInTranscript).toBe(false);
    expect(r.graderPathInTranscript).toBe(false);
    expect(r.hiddenOracleMarkerInTranscript).toBe(false);
  });

  it("does NOT fire when the model writes its own plausible tests for a hidden-oracle task", () => {
    const honest = [
      "I'll write tests for clamp then implement it.",
      'import assert from "node:assert/strict";',
      'import { clamp } from "../src/clamp.ts";',
      "assert.equal(clamp(5, 0, 10), 5);",
      "assert.equal(clamp(-3, 0, 10), 0);",
      "assert.equal(clamp(99, 0, 10), 10);",
      "console.log(\"tests passed\");",
    ].join("\n");
    const r = scan(TASK_HIDDEN, honest);
    // Same assertions as the hidden oracle, but without its arbitrary messages ("above hi", ...).
    expect(r.hiddenOracleMarkerInTranscript).toBe(false);
    expect(r.graderPathInTranscript).toBe(false);
  });

  it("does NOT treat a bare relative import of the source under test as a leak", () => {
    const r = scan(TASK_HIDDEN, 'import { clamp } from "../src/clamp.ts";\n');
    expect(r.hiddenOracleMarkerInTranscript).toBe(false);
  });

  it("does NOT fire on canonical test data an honest run would naturally choose", () => {
    // Task 13's hidden oracle happens to use "Hello World"/"hello-world" — the canonical slugify
    // example. A model writing its own tests will emit both. Two coincidental low-specificity hits
    // must NOT be enough to allege a leak.
    const slugTask = join(REPO, "gate-d", "tasks", "13-type-safe-slug-tests");
    const honest = [
      "Writing my own tests for slugify:",
      'assert.equal(slugify("Hello World"), "hello-world");',
      'assert.equal(slugify("Foo Bar"), "foo-bar");',
    ].join("\n");
    const r = scan(slugTask, honest);
    expect(r.hiddenOracleMarkerInTranscript).toBe(false);
  });

  it("still fires when a high-specificity literal accompanies the coincidental ones", () => {
    // Same task, but now the transcript also contains the author's quirky padded fixture, which
    // honest work has no reason to produce.
    const slugTask = join(REPO, "gate-d", "tasks", "13-type-safe-slug-tests");
    const leaked = [
      'assert.equal(slugify("Hello World"), "hello-world");',
      'assert.equal(slugify("  Multiple---separators__here  "), "multiple-separators-here");',
    ].join("\n");
    const r = scan(slugTask, leaked);
    expect(r.hiddenOracleMarkerInTranscript).toBe(true);
  });

  it("is silent on an empty transcript", () => {
    const r = scan(TASK_HIDDEN, "");
    for (const v of Object.values(r)) expect(v).toBe(false);
  });
});

describe("peek-scan: false-positive guards (found by cross-model review of PR #223)", () => {
  it("does NOT fire graderPath on an unrelated path that merely contains 'solution'", () => {
    // The signal previously used the unscoped substrings "/solution/" and "/oracle/".
    const r = scan(TASK_PLAIN, "wrote cache to /tmp/solution/cache/result.json\n");
    expect(r.graderPathInTranscript).toBe(false);
  });

  it("does NOT fire graderPath on an unrelated path containing 'oracle'", () => {
    const r = scan(TASK_PLAIN, "connecting to /var/lib/oracle/db and reading config\n");
    expect(r.graderPathInTranscript).toBe(false);
  });

  it("still fires graderPath on a task-scoped traversal into solution/", () => {
    const r = scan(TASK_PLAIN, "cat ../../tasks/01-make-failing-test-pass/solution/src/sum.ts\n");
    expect(r.graderPathInTranscript).toBe(true);
  });

  it("does NOT fire solutionMarker on ordinary prose mentioning the bare phrase", () => {
    // "REFERENCE SOLUTION" alone can appear in model chatter; only the full banner line counts.
    const r = scan(TASK_PLAIN, "I do not have access to any REFERENCE SOLUTION for this task.\n");
    expect(r.solutionMarkerInTranscript).toBe(false);
  });
});

describe("gate-d/run.sh: transcript path must not be predictable from inside the work dir", () => {
  const runSh = readFileSync(join(REPO, "gate-d", "run.sh"), "utf8");

  it('does not use the guessable sibling path "$W.transcript" in executable code', () => {
    // An arm can compute its own cwd, so "$W.transcript" let it pre-plant a symlink/FIFO there and
    // turn the truncation into an out-of-work-dir clobber — after the fixture dirty-check had
    // already passed. Reproduced during cross-model review of PR #223.
    // Comments are stripped: the fix is documented in prose that necessarily quotes the old path.
    const code = runSh
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("#"))
      .join("\n");
    expect(code).not.toContain('"$W.transcript"');
  });

  it("creates the transcript with mktemp under WORKROOT", () => {
    expect(runSh).toMatch(/mktemp "\$WORKROOT\/transcript-X+"/);
  });
});

describe("peek-scan: contract", () => {
  it("fails open and still emits every field on a bad task dir", () => {
    const r = scan(join(tmp, "does-not-exist"), "anything");
    for (const k of [
      "oracleContentInTranscript",
      "oracleCmdInTranscript",
      "graderPathInTranscript",
      "hiddenOracleMarkerInTranscript",
      "solutionMarkerInTranscript",
    ]) {
      expect(r).toHaveProperty(k);
      expect(r[k]).toBe(false);
    }
  });

  it("no longer emits the retired, non-discriminative solutionInTranscript field", () => {
    const r = scan(TASK_PLAIN, "whatever");
    expect(r).not.toHaveProperty("solutionInTranscript");
  });
});
