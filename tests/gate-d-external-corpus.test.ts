import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";

// INFER-521: gate-d/run.sh and sweep.sh run an external task corpus (code-battle's gate-d-r3) from
// GATE_D_TASKS_ROOT, guarded by the manifest's content digest instead of git status. Every case
// runs a disposable git checkout of gate-d/ against a synthetic two-task corpus built from r1 seeds,
// with stub arms, so no model, network or GPU is involved.

const REAL_ROOT = process.cwd();
const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function isInside(path: string, root: string): boolean {
  const target = statSync(root);
  for (let p = path; ; p = dirname(p)) {
    const st = statSync(p);
    if (st.dev === target.dev && st.ino === target.ino) return true;
    if (dirname(p) === p) return false;
  }
}
const TMP_PARENT = realpathSync(tmpdir());
if (isInside(TMP_PARENT, REAL_ROOT)) {
  throw new Error(`the test temp dir ${TMP_PARENT} is inside this checkout; set TMPDIR elsewhere`);
}

function tmp(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(TMP_PARENT, prefix)));
  cleanup.push(dir);
  return dir;
}

function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("GIT_") || k.startsWith("GATE_D_") || k === "KEEP_WORK") continue;
    env[k] = v;
  }
  return { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_ATTR_NOSYSTEM: "1", ...extra };
}

function git(cwd: string, ...args: string[]): string {
  const isolation = ["-c", "core.attributesFile=/dev/null", "-c", "core.excludesFile=/dev/null", "-c", "core.hooksPath=/dev/null"];
  const res = spawnSync("git", [...isolation, "-c", "user.email=t@local", "-c", "user.name=t", ...args], {
    cwd,
    encoding: "utf8",
    env: cleanEnv(),
  });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr}`);
  return res.stdout;
}

function fixtureRepo(): string {
  const repo = tmp("gd-ext-fixture-");
  cpSync(join(REAL_ROOT, "gate-d"), join(repo, "gate-d"), { recursive: true });
  cpSync(join(REAL_ROOT, "vendor"), join(repo, "vendor"), { recursive: true });
  mkdirSync(join(repo, "scripts"));
  for (const f of ["pi-benchmark-telemetry.ts", "pi-verification-telemetry.ts"]) {
    cpSync(join(REAL_ROOT, "scripts", f), join(repo, "scripts", f));
  }
  symlinkSync(join(REAL_ROOT, "node_modules"), join(repo, "node_modules"));
  cpSync(join(REAL_ROOT, "package.json"), join(repo, "package.json"));
  writeFileSync(join(repo, ".gitignore"), "node_modules\ndata/\n");
  git(repo, "init", "-q", "--template=");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "fixture");
  return repo;
}

/** The same algorithm as code-battle's core.tree_digest, written independently of gate_d_corpus.py. */
function treeDigest(dir: string): string {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else files.push(relative(dir, full).split(sep).join("/"));
    }
  };
  walk(dir);
  // pathlib order: component-wise, not plain string order.
  files.sort((a, b) => {
    const pa = a.split("/"), pb = b.split("/");
    for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
      if (pa[i] !== pb[i]) return pa[i]! < pb[i]! ? -1 : 1;
    }
    return pa.length - pb.length;
  });
  const h = createHash("sha256");
  for (const rel of files) {
    const fileHash = createHash("sha256").update(readFileSync(join(dir, rel))).digest("hex");
    h.update(Buffer.concat([Buffer.from(rel), Buffer.from([0]), Buffer.from(fileHash), Buffer.from("\n")]));
  }
  return h.digest("hex");
}

const TASK_A = "r3-test-sum-000";
const TASK_B = "r3-test-paginate-001";

interface CorpusOptions { split?: string; holdout?: boolean; revision?: string }

/**
 * Two r1 seeds re-labelled as an r3 corpus. Task A (sum) has no visible tests. Task B (paginate)
 * ships its oracle again as the visible test test/paginate.test.ts (which at-stop.sh runs with the
 * toolchain's `tsx --test`, as the r3 seeds' `npm test` does), so at-stop.sh reports it red on the
 * untouched seed.
 */
function corpus(opts: CorpusOptions = {}): string {
  const root = tmp("gd-ext-corpus-");
  const revision = opts.revision ?? "gate-d-r3";
  const split = opts.split ?? "validation";
  const holdout = opts.holdout ?? split === "sealed";
  const specs = [
    { id: TASK_A, from: "01-make-failing-test-pass", family: "sum-family", trap: false },
    { id: TASK_B, from: "06-fix-off-by-one", family: "paginate-family", trap: true },
  ];
  for (const s of specs) {
    const dir = join(root, s.id);
    cpSync(join(REAL_ROOT, "gate-d", "tasks", s.from), dir, { recursive: true });
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
    Object.assign(meta, { id: s.id, corpusRevision: revision, holdout, split, family: s.family, trap: s.trap });
    if (s.id === TASK_B) {
      writeFileSync(join(dir, "repo", "package.json"),
        JSON.stringify({ private: true, scripts: { test: "tsx --test test/*.test.ts" } }, null, 2) + "\n");
      cpSync(join(dir, "repo", "test", "paginate.oracle.ts"), join(dir, "repo", "test", "paginate.test.ts"));
      meta.oracleFiles = [...meta.oracleFiles, "package.json", "test/paginate.test.ts"];
      meta.visibleTests = ["test/paginate.test.ts"];
    }
    writeFileSync(join(dir, "meta.json"), JSON.stringify(meta, null, 2) + "\n");
  }
  writeManifest(root, revision, split);
  return root;
}

function writeManifest(root: string, revision = "gate-d-r3", split = "validation"): void {
  const tasks = [TASK_A, TASK_B].map((id) => ({ id, family: "x", digest: treeDigest(join(root, id)) }));
  writeFileSync(join(root, "corpus-manifest.json"),
    JSON.stringify({ corpusRevision: revision, generatorVersion: "1", split, count: tasks.length, tasks }, null, 2) + "\n");
}

/**
 * Stub arms. pi solves task A by copying its reference solution and emits a pi NDJSON stream with
 * one edit and one green typecheck after it; it leaves task B untouched. `script` runs afterwards.
 * Each call records whether the runner leaked GATE_D_* configuration into the arm's environment.
 */
function fakeBin(root: string, script = ""): { bin: string; log: string } {
  const bin = tmp("gd-ext-bin-");
  const log = join(bin, "calls.jsonl");
  for (const name of ["pi", "aider", "opencode", "qwen"]) {
    writeFileSync(join(bin, name), `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const root = ${JSON.stringify(root)};
const cwd = process.cwd();
const task = fs.existsSync(path.join(cwd, "src", "sum.ts")) ? ${JSON.stringify(TASK_A)} : ${JSON.stringify(TASK_B)};
const leaked = Object.keys(process.env).filter((k) => k.startsWith("GATE_D_"));
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ name: ${JSON.stringify(name)}, task, leaked }) + "\\n");
if (${JSON.stringify(name)} === "pi") {
  const ev = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
  ev({ type: "turn_start" });
  if (task === ${JSON.stringify(TASK_A)}) {
    fs.copyFileSync(path.join(root, task, "solution", "src", "sum.ts"), path.join(cwd, "src", "sum.ts"));
    ev({ type: "tool_execution_start", toolCallId: "e1", toolName: "edit", args: { path: "secret/path.ts" } });
    ev({ type: "tool_execution_end", toolCallId: "e1", toolName: "edit", isError: false, result: { content: [] } });
    ev({ type: "turn_start" });
    ev({ type: "tool_execution_start", toolCallId: "b1", toolName: "bash", args: { command: "npx tsc --noEmit -p tsconfig.json" } });
    ev({ type: "tool_execution_end", toolCallId: "b1", toolName: "bash", isError: false, result: { content: [] } });
  }
  ev({ type: "turn_end", message: { role: "assistant", usage: { input: 10, output: 5 } } });
}
${script}
`);
    chmodSync(join(bin, name), 0o755);
  }
  return { bin, log };
}

function calls(log: string): Array<{ name: string; task: string; leaked: string[] }> {
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function runGateD(repo: string, bin: string, env: Record<string, string>, args: string[], script = "run.sh") {
  const work = tmp("gd-ext-work-");
  const out = join(work, "rows.jsonl");
  const res = spawnSync("bash", [join(repo, "gate-d", script), ...args], {
    cwd: repo,
    encoding: "utf8",
    env: cleanEnv({
      GW_KEY: "test-key",
      GW: "http://127.0.0.1:9/v1",
      MODEL: "m",
      TMPDIR: work,
      GATE_D_WORKROOT: join(work, "gate-d-work"),
      GATE_D_OUT: out,
      GATE_D_LOG: join(work, "sweep.log"),
      PATH: `${bin}:${process.env.PATH}`,
      ...env,
    }),
    timeout: 240_000,
  });
  return { res, out };
}

function rows(out: string): Array<Record<string, unknown>> {
  if (!existsSync(out)) return [];
  return readFileSync(out, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

const VERIFICATION_KEYS = [
  "verificationClass", "typecheckRuns", "testRuns", "typecheckAfterLastEdit", "testsAfterLastEdit",
  "lastTypecheckOutcome", "lastTestOutcome", "stoppedWithFailingCheck", "ambiguousCheckOutcomes",
  "firstEditTurn", "lastEditTurn", "edits",
];
const AT_STOP_KEYS = ["atStopTypecheck", "atStopVisibleTests", "detectableFailureAtStop"];
const R3_KEYS = ["family", "split", "trap", ...AT_STOP_KEYS, ...VERIFICATION_KEYS];

describe("Gate D external task digest (INFER-521)", () => {
  it("matches code-battle's tree_digest, including component-wise path order", () => {
    const dir = tmp("gd-ext-vec-");
    mkdirSync(join(dir, "a"));
    mkdirSync(join(dir, "a-b"));
    writeFileSync(join(dir, "a", "x"), "one\n");
    writeFileSync(join(dir, "a-b", "x"), "two\n");
    writeFileSync(join(dir, "b.txt"), "three");
    // Pinned from code-battle gate-d-r3 generator/core.py tree_digest on this exact tree.
    const expected = "ece6e3bdbd0ce8538e590d95e191c6c6fecfcd2bab812b14c72534455acb0acd";
    expect(treeDigest(dir)).toBe(expected);
    const res = spawnSync("python3", ["-c",
      "import sys; sys.path.insert(0, sys.argv[1]); import gate_d_corpus as g; from pathlib import Path; print(g.tree_digest(Path(sys.argv[2])))",
      join(REAL_ROOT, "gate-d"), dir], { encoding: "utf8" });
    expect(res.stdout.trim()).toBe(expected);
  });
});

describe("gate-d/run.sh external task root (INFER-521)", { timeout: 240_000 }, () => {
  it("runs a two-task external corpus end to end with r3 identity and the new fields", () => {
    const repo = fixtureRepo();
    const root = corpus();
    const { bin, log } = fakeBin(root);
    const { res, out } = runGateD(repo, bin, { GATE_D_TASKS_ROOT: root }, ["pi", "all"]);
    expect(res.status, res.stderr).toBe(0);
    const all = rows(out);
    expect(all.map((r) => r.task)).toEqual([TASK_A, TASK_B]);
    const manifest = JSON.parse(readFileSync(join(root, "corpus-manifest.json"), "utf8"));
    for (const [i, row] of all.entries()) {
      expect(row.corpusRevision).toBe("gate-d-r3");
      expect(row.taskRevision).toBe(manifest.tasks[i].digest);
      expect(row.holdout).toBe(false);
      expect(row.split).toBe("validation");
      for (const k of R3_KEYS) expect(row, k).toHaveProperty(k);
    }
    const [a, b] = all as [Record<string, unknown>, Record<string, unknown>];
    expect(a).toMatchObject({
      pass: true, exitClass: "pass", family: "sum-family", trap: false,
      atStopTypecheck: "passed", atStopVisibleTests: "none", detectableFailureAtStop: false,
      verificationClass: "checked-green-after-last-edit", typecheckRuns: 1, testRuns: 0,
      typecheckAfterLastEdit: true, testsAfterLastEdit: false, lastTypecheckOutcome: "passed",
      lastTestOutcome: null, stoppedWithFailingCheck: false, ambiguousCheckOutcomes: 0,
      firstEditTurn: 1, lastEditTurn: 1, edits: 1, turns: 2,
      verificationSchema: "gate-d-r3/verification-telemetry@1",
    });
    expect(b).toMatchObject({
      pass: false, exitClass: "G2-no-edit", family: "paginate-family", trap: true,
      atStopTypecheck: "passed", atStopVisibleTests: "failed", detectableFailureAtStop: true,
      verificationClass: "no-edit", edits: 0, firstEditTurn: null,
    });
    // Content-blind: no command, path or text from the transcript reaches the row.
    expect(readFileSync(out, "utf8")).not.toMatch(/secret\/path|tsconfig|npx/);
    // Runner configuration never reaches an arm.
    expect(calls(log).map((c) => c.leaked)).toEqual([[], []]);
    // Nothing was written into the task root, and the digests still hold.
    expect(treeDigest(join(root, TASK_A))).toBe(manifest.tasks[0].digest);
  });

  it("gives non-pi arms the same row schema with null telemetry", () => {
    const repo = fixtureRepo();
    const root = corpus();
    const { bin } = fakeBin(root);
    const { res, out } = runGateD(repo, bin, { GATE_D_TASKS_ROOT: root }, ["aider", TASK_B]);
    expect(res.status, res.stderr).toBe(0);
    const [row] = rows(out);
    for (const k of [...VERIFICATION_KEYS, "verificationSchema"]) expect(row![k], k).toBeNull();
    expect(row).toMatchObject({ atStopVisibleTests: "failed", detectableFailureAtStop: true, pass: false });
  });

  it("leaves r1 and r2 enumeration, pinning and row schema unchanged", () => {
    const repo = fixtureRepo();
    const root = corpus();
    const { bin } = fakeBin(root);
    const corpusJson = JSON.parse(readFileSync(join(REAL_ROOT, "gate-d", "corpus.json"), "utf8"));
    const r1 = runGateD(repo, bin, {}, ["--list-tasks"]);
    expect(r1.res.stdout.trim().split("\n")).toEqual(corpusJson.revisions["gate-d-r1"].tasks);
    const r2 = runGateD(repo, bin, { GATE_D_INCLUDE_HOLDOUT: "1" }, ["--list-tasks"]);
    expect(r2.res.stdout.trim().split("\n")).toEqual(corpusJson.revisions["gate-d-r2"].tasks);
    const ext = runGateD(repo, bin, { GATE_D_TASKS_ROOT: root }, ["--list-tasks"]);
    expect(ext.res.stdout.trim().split("\n")).toEqual([TASK_A, TASK_B]);
    // The committed corpus helper ignores the variable, so verify-fixtures.sh cannot be redirected.
    const helper = spawnSync("python3", [join(repo, "gate-d", "gate_d_corpus.py"), "tasks"], {
      encoding: "utf8", env: cleanEnv({ GATE_D_TASKS_ROOT: root }),
    });
    expect(helper.stdout.trim().split("\n")).toEqual(corpusJson.revisions["gate-d-r1"].tasks);

    const { res, out } = runGateD(repo, bin, {}, ["pi", "01-make-failing-test-pass"]);
    expect(res.status, res.stderr).toBe(0);
    const [row] = rows(out);
    expect(row).toMatchObject({ corpusRevision: "gate-d-r1", taskRevision: "gate-d-r1", holdout: false });
    for (const k of R3_KEYS) expect(row, k).not.toHaveProperty(k);
  });

  it("aborts without a row when a task file was edited before the run", () => {
    const repo = fixtureRepo();
    const root = corpus();
    appendFileSync(join(root, TASK_A, "solution", "src", "sum.ts"), "// edited\n");
    const { bin, log } = fakeBin(root);
    const { res, out } = runGateD(repo, bin, { GATE_D_TASKS_ROOT: root }, ["pi", TASK_A]);
    expect(res.status).toBe(9);
    expect(res.stderr).toContain("does not match the manifest");
    expect(calls(log)).toEqual([]);
    expect(rows(out)).toEqual([]);
  });

  it("aborts without a row when the arm edits a task file mid-run", () => {
    const repo = fixtureRepo();
    const root = corpus();
    const { bin, log } = fakeBin(root,
      `fs.appendFileSync(path.join(root, task, "INSTRUCTION.md"), "\\nmid-run edit\\n");`);
    const { res, out } = runGateD(repo, bin, { GATE_D_TASKS_ROOT: root }, ["pi", "all"]);
    expect(res.status).toBe(9);
    expect(res.stderr).toContain("changed on disk during this run");
    expect(calls(log)).toHaveLength(1);
    expect(rows(out)).toEqual([]);
  });

  it("aborts without a row when a file is added to a task, before or during the run", () => {
    const repo = fixtureRepo();
    const root = corpus();
    const { bin, log } = fakeBin(root, `fs.writeFileSync(path.join(root, task, "repo", "src", "extra.ts"), "export {};\\n");`);
    let r = runGateD(repo, bin, { GATE_D_TASKS_ROOT: root }, ["pi", TASK_A]);
    expect(r.res.status).toBe(9);
    expect(rows(r.out)).toEqual([]);
    expect(calls(log)).toHaveLength(1);
    // The added file is still there: the next run refuses before the arm.
    r = runGateD(repo, bin, { GATE_D_TASKS_ROOT: root }, ["pi", TASK_A]);
    expect(r.res.status).toBe(9);
    expect(r.res.stderr).toContain("does not match the manifest");
    expect(calls(log)).toHaveLength(1);
  });

  it("aborts without a row when the arm rewrites a task and its manifest digest together", () => {
    const repo = fixtureRepo();
    const root = corpus();
    const { bin, log } = fakeBin(root, `
const manifestPath = path.join(root, "corpus-manifest.json");
fs.appendFileSync(path.join(root, task, "INSTRUCTION.md"), "\\nrewritten\\n");
const h = (d) => { const c = require("crypto"); const files = [];
  const walk = (x) => { for (const n of fs.readdirSync(x)) { const f = path.join(x, n); fs.statSync(f).isDirectory() ? walk(f) : files.push(path.relative(d, f)); } };
  walk(d); files.sort((a, b) => { const pa = a.split("/"), pb = b.split("/");
    for (let i = 0; i < Math.min(pa.length, pb.length); i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1; return pa.length - pb.length; });
  const out = c.createHash("sha256");
  for (const r of files) out.update(Buffer.concat([Buffer.from(r), Buffer.from([0]), Buffer.from(c.createHash("sha256").update(fs.readFileSync(path.join(d, r))).digest("hex")), Buffer.from("\\n")]));
  return out.digest("hex"); };
const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
for (const t of m.tasks) if (t.id === task) t.digest = h(path.join(root, task));
fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2) + "\\n");`);
    const { res, out } = runGateD(repo, bin, { GATE_D_TASKS_ROOT: root }, ["pi", TASK_A]);
    expect(calls(log)).toHaveLength(1);
    expect(res.status).toBe(9);
    expect(res.stderr).toContain("changed since it was pinned");
    expect(rows(out)).toEqual([]);
  });

  it("refuses a task root whose path a shell-interpolating helper would misread", () => {
    const repo = fixtureRepo();
    const parent = tmp("gd-ext-quote-");
    const quoted = join(parent, "it's a root");
    cpSync(corpus(), quoted, { recursive: true });
    const { bin, log } = fakeBin(quoted);
    const { res, out } = runGateD(repo, bin, { GATE_D_TASKS_ROOT: quoted }, ["pi", "all"]);
    expect(res.status).toBe(3);
    expect(res.stderr).toContain("plain path");
    expect(calls(log)).toEqual([]);
    expect(rows(out)).toEqual([]);
  });

  it("runs at-stop.sh on a copy, so files it leaves behind never reach check.sh", () => {
    const repo = fixtureRepo();
    writeFileSync(join(repo, "gate-d", "at-stop.sh"),
      `#!/usr/bin/env bash\necho junk > "$2/src/leftover.ts"\necho '{"atStopTypecheck":"passed","atStopVisibleTests":"none","detectableFailureAtStop":false}'\n`);
    const root = corpus();
    const { bin } = fakeBin(root);
    const { res, out } = runGateD(repo, bin, { GATE_D_TASKS_ROOT: root }, ["pi", TASK_A]);
    expect(res.status, res.stderr).toBe(0);
    expect(rows(out)[0]).toMatchObject({ pass: true, exitClass: "pass", atStopTypecheck: "passed" });
  });

  it("never executes a workspace whose changes grading will reject (scope check first)", () => {
    const repo = fixtureRepo();
    const root = corpus();
    const marker = join(tmp("gd-ext-marker-"), "ran");
    // The arm rewrites task B's package.json test script, which is outside its edit targets.
    const { bin } = fakeBin(root, `if (task === ${JSON.stringify(TASK_B)}) fs.writeFileSync("package.json",
      JSON.stringify({ private: true, scripts: { test: "touch ${marker}" } }));`);
    const { res, out } = runGateD(repo, bin, { GATE_D_TASKS_ROOT: root }, ["pi", TASK_B]);
    expect(res.status, res.stderr).toBe(0);
    expect(existsSync(marker)).toBe(false);
    const [row] = rows(out);
    expect(row).toMatchObject({ pass: false, exitClass: "G0-files", atStopTypecheck: null, atStopVisibleTests: null });
    expect(res.stderr).toContain("out-of-scope");
  });

  it("records a check that hits the at-stop cap as unmeasured, not red", () => {
    const repo = fixtureRepo();
    const root = corpus();
    writeFileSync(join(root, TASK_B, "repo", "test", "paginate.test.ts"),
      'import { test } from "node:test";\ntest("slow", async () => { await new Promise((resolve) => setTimeout(resolve, 20_000)); });\n');
    writeManifest(root);
    const { bin } = fakeBin(root);
    const { res, out } = runGateD(repo, bin, { GATE_D_TASKS_ROOT: root, AT_STOP_CAP_S: "1" }, ["pi", TASK_B]);
    expect(res.status, res.stderr).toBe(0);
    expect(rows(out)[0]).toMatchObject({ atStopTypecheck: null, detectableFailureAtStop: null, exitClass: "G2-no-edit" });
  });

  it("runs at-stop.sh without the runner's credentials", () => {
    const repo = fixtureRepo();
    const dump = join(tmp("gd-ext-env-"), "env.txt");
    writeFileSync(join(repo, "gate-d", "at-stop.sh"), `#!/usr/bin/env bash\nenv > ${dump}\necho '{}'\n`);
    const root = corpus();
    const { bin } = fakeBin(root);
    const { res } = runGateD(repo, bin, { GATE_D_TASKS_ROOT: root, SECRET_TOKEN: "s3cret" }, ["pi", TASK_A]);
    expect(res.status, res.stderr).toBe(0);
    const env = readFileSync(dump, "utf8");
    expect(env).not.toContain("test-key");
    expect(env).not.toContain("s3cret");
    expect(env).not.toContain("GATE_D_");
    // The toolchain is named explicitly, never taken from the candidate-controlled node_modules link.
    expect(env).toContain(`AT_STOP_TOOLCHAIN=${realpathSync(repo)}/node_modules\n`);
  });

  it("fails a row on gate R3-io when a candidate module reaches the file system", () => {
    const repo = fixtureRepo();
    const root = corpus();
    // A correct sum that also reads files: check.sh alone would pass it.
    const { bin } = fakeBin(root, `if (task === ${JSON.stringify(TASK_A)}) fs.writeFileSync(path.join(cwd, "src", "sum.ts"),
  'import { readdirSync } from "node:fs";\\nexport const seen = readdirSync(".").length;\\nexport function sum(xs: number[]): number { return xs.reduce((a, x) => a + x, 0); }\\n');`);
    const { res, out } = runGateD(repo, bin, { GATE_D_TASKS_ROOT: root }, ["pi", TASK_A]);
    expect(res.status, res.stderr).toBe(0);
    expect(rows(out)[0]).toMatchObject({ task: TASK_A, pass: false, exitClass: "R3-io" });
    // The static gate runs before any candidate code, so at-stop never executed this workspace.
    expect(rows(out)[0]).toMatchObject({ atStopTypecheck: null, atStopVisibleTests: null, detectableFailureAtStop: null });
    expect(res.stderr).toContain("gate R3-io failed");
  });

  it("records an io gate that cannot run as a runner failure, not a model failure", () => {
    const repo = fixtureRepo();
    writeFileSync(join(repo, "vendor", "code-battle-gate-d-r3", "io-gate.mjs"), "throw new Error('broken gate');\n");
    const root = corpus();
    const { bin } = fakeBin(root);
    const { res, out } = runGateD(repo, bin, { GATE_D_TASKS_ROOT: root }, ["pi", TASK_A]);
    expect(res.status, res.stderr).toBe(0);
    expect(rows(out)[0]).toMatchObject({ task: TASK_A, pass: false, exitClass: "R3-io-error" });
  });

  it("grades external tasks with code generation from strings disabled", () => {
    const repo = fixtureRepo();
    const root = corpus();
    // The static gate cannot see a Function constructor reached through a property chain; node's
    // --disallow-code-generation-from-strings must make the oracle fail instead.
    const { bin } = fakeBin(root, `if (task === ${JSON.stringify(TASK_A)}) fs.writeFileSync(path.join(cwd, "src", "sum.ts"),
  'const make = (() => 0).constructor as (body: string) => () => number;\\nexport function sum(xs: number[]): number { return xs.reduce((a, x) => a + x, make("return 0")()); }\\n');`);
    const { res, out } = runGateD(repo, bin, { GATE_D_TASKS_ROOT: root }, ["pi", TASK_A]);
    expect(res.status, res.stderr).toBe(0);
    expect(rows(out)[0]).toMatchObject({ task: TASK_A, pass: false });
    // tsc accepts it (G3) and the oracle throws at the Function call (G4), not the static gate.
    expect(rows(out)[0]!.exitClass).toBe("G4-oracle");
  });

  it("refuses a task whose directory scan is incomplete", () => {
    const root = corpus();
    // Simulate an unreadable subtree (chmod cannot stop root): os.walk reports it through onerror.
    const script = `import os, sys
sys.path.insert(0, sys.argv[1])
import gate_d_corpus as g
from pathlib import Path
real = os.scandir
def scandir(path="."):
    if str(path).endswith("/src"):
        raise PermissionError(13, "Permission denied", str(path))
    return real(path)
os.scandir = scandir
try:
    g.tree_digest(Path(sys.argv[2]))
except g.ExternalCorpusError as error:
    print("refused:", error)
    sys.exit(0)
sys.exit(1)
`;
    const res = spawnSync("python3", ["-c", script, join(REAL_ROOT, "gate-d"), join(root, TASK_A)], { encoding: "utf8" });
    expect(res.status, res.stderr + res.stdout).toBe(0);
    expect(res.stdout).toContain("cannot scan");
  });

  it("refuses a meta.json that is a FIFO without blocking", () => {
    const repo = fixtureRepo();
    const root = corpus();
    rmSync(join(root, TASK_B, "meta.json"));
    expect(spawnSync("mkfifo", [join(root, TASK_B, "meta.json")]).status).toBe(0);
    const { bin, log } = fakeBin(root);
    let { res } = runGateD(repo, bin, { GATE_D_TASKS_ROOT: root }, ["--list-tasks"]);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("not a regular file");
    ({ res } = runGateD(repo, bin, { GATE_D_TASKS_ROOT: root }, ["pi", "all"]));
    expect(res.status).toBe(3);
    expect(res.stderr).toContain("not a regular file");
    expect(calls(log)).toEqual([]);
  });

  it("aborts without a row when the task changes during grading", () => {
    const repo = fixtureRepo();
    const root = corpus();
    // at-stop.sh runs candidate code between the post-arm check and check.sh; make it tamper.
    writeFileSync(join(repo, "gate-d", "at-stop.sh"),
      `#!/usr/bin/env bash\necho tampered >> "$1/meta.json"\necho '{}'\n`);
    const { bin } = fakeBin(root);
    const { res, out } = runGateD(repo, bin, { GATE_D_TASKS_ROOT: root }, ["pi", TASK_A]);
    expect(res.status).toBe(9);
    expect(res.stderr).toContain("during grading");
    expect(rows(out)).toEqual([]);
  });

  it("refuses symlinks inside an external task", () => {
    const repo = fixtureRepo();
    const root = corpus();
    symlinkSync("/etc/hostname", join(root, TASK_A, "repo", "link"));
    const { bin, log } = fakeBin(root);
    const { res } = runGateD(repo, bin, { GATE_D_TASKS_ROOT: root }, ["pi", TASK_A]);
    expect(res.status).toBe(9);
    expect(res.stderr).toContain("symlink");
    expect(calls(log)).toEqual([]);
  });

  it("refuses a task root inside the checkout, or one that contains it", () => {
    const repo = fixtureRepo();
    const inside = join(repo, "external");
    cpSync(corpus(), inside, { recursive: true });
    const { bin, log } = fakeBin(inside);
    let r = runGateD(repo, bin, { GATE_D_TASKS_ROOT: inside }, ["pi", "all"]);
    expect(r.res.status).toBe(3);
    expect(r.res.stderr).toContain("overlaps this checkout");
    r = runGateD(repo, bin, { GATE_D_TASKS_ROOT: dirname(repo) }, ["pi", "all"]);
    expect(r.res.status).toBe(3);
    expect(r.res.stderr).toContain("overlaps this checkout");
    // A symlink pointing into the checkout is resolved first.
    const link = join(tmp("gd-ext-link-"), "root");
    symlinkSync(inside, link);
    r = runGateD(repo, bin, { GATE_D_TASKS_ROOT: link }, ["pi", "all"]);
    expect(r.res.status).toBe(3);
    expect(calls(log)).toEqual([]);
  });

  it("refuses a work root inside the task root", () => {
    const repo = fixtureRepo();
    const root = corpus();
    const { bin, log } = fakeBin(root);
    const { res } = runGateD(repo, bin, { GATE_D_TASKS_ROOT: root, GATE_D_WORKROOT: join(root, "work") }, ["pi", "all"]);
    expect(res.status).toBe(3);
    expect(res.stderr).toContain("overlap");
    expect(calls(log)).toEqual([]);
  });

  it("refuses an external revision that collides with a committed one", () => {
    const repo = fixtureRepo();
    const root = corpus({ revision: "gate-d-r1" });
    const { bin } = fakeBin(root);
    const { res } = runGateD(repo, bin, { GATE_D_TASKS_ROOT: root }, ["pi", "all"]);
    expect(res.status).toBe(3);
    expect(res.stderr).toContain("collides");
  });

  it("refuses sealed tasks without the holdout opt-in and runs them with it", () => {
    const repo = fixtureRepo();
    const root = corpus({ split: "sealed" });
    const { bin, log } = fakeBin(root);
    let r = runGateD(repo, bin, { GATE_D_TASKS_ROOT: root }, ["pi", "all"]);
    expect(r.res.status).toBe(3);
    expect(r.res.stderr).toContain("GATE_D_INCLUDE_HOLDOUT=1");
    r = runGateD(repo, bin, { GATE_D_TASKS_ROOT: root }, ["pi", TASK_A]);
    expect(r.res.status).toBe(3);
    expect(r.res.stderr).toContain("sealed");
    expect(calls(log)).toEqual([]);
    r = runGateD(repo, bin, { GATE_D_TASKS_ROOT: root, GATE_D_INCLUDE_HOLDOUT: "1" }, ["pi", TASK_A]);
    expect(r.res.status, r.res.stderr).toBe(0);
    expect(rows(r.out)[0]).toMatchObject({ holdout: true, split: "sealed", pass: true });
  });

  it("seals a task flagged holdout even in a non-sealed manifest", () => {
    const repo = fixtureRepo();
    const root = corpus({ split: "validation", holdout: true });
    const { bin, log } = fakeBin(root);
    const { res } = runGateD(repo, bin, { GATE_D_TASKS_ROOT: root }, ["pi", "all"]);
    expect(res.status).toBe(3);
    expect(calls(log)).toEqual([]);
  });

  it.each([
    ["missing", null],
    ["failing", "#!/usr/bin/env bash\necho '{\"atStopTypecheck\":\"passed\"}'\nexit 1\n"],
    ["garbage", "#!/usr/bin/env bash\necho 'not json'\n"],
    ["off-schema", "#!/usr/bin/env bash\necho '{\"atStopTypecheck\":\"/etc/passwd\",\"detectableFailureAtStop\":\"yes\",\"extra\":1}'\n"],
  ])("a %s at-stop.sh yields null fields and leaves pass/fail unchanged", (_label, body) => {
    const repo = fixtureRepo();
    const script = join(repo, "gate-d", "at-stop.sh");
    if (body === null) unlinkSync(script);
    else writeFileSync(script, body);
    const root = corpus();
    const { bin } = fakeBin(root);
    const { res, out } = runGateD(repo, bin, { GATE_D_TASKS_ROOT: root }, ["pi", "all"]);
    expect(res.status, res.stderr).toBe(0);
    const [a, b] = rows(out) as [Record<string, unknown>, Record<string, unknown>];
    for (const row of [a, b]) for (const k of AT_STOP_KEYS) expect(row[k], k).toBeNull();
    expect(a).not.toHaveProperty("extra");
    expect([a.pass, a.exitClass, b.pass, b.exitClass]).toEqual([true, "pass", false, "G2-no-edit"]);
  });
});

describe("vendored at-stop.sh provenance (INFER-521)", () => {
  it("is the corpus original plus only lines marked INFER-521-local", () => {
    const text = readFileSync(join(REAL_ROOT, "gate-d", "at-stop.sh"), "utf8");
    const lines = text.split("\n");
    const recorded = /sha256 of the source\n# file ([0-9a-f]{64})/.exec(text)?.[1];
    expect(recorded).toMatch(/^[0-9a-f]{64}$/);
    const bodyStart = lines.findIndex((l) => l.startsWith("# Grader-derived"));
    expect(bodyStart).toBeGreaterThan(0);
    const original = [lines[0], ...lines.slice(bodyStart).filter((l) => !l.endsWith("# INFER-521-local"))].join("\n");
    expect(createHash("sha256").update(original).digest("hex")).toBe(recorded);
  });
});

describe("vendored io-gate.mjs provenance (INFER-521)", () => {
  it("is byte-identical to the corpus original recorded in CORPUS.md", () => {
    const doc = readFileSync(join(REAL_ROOT, "gate-d", "CORPUS.md"), "utf8");
    const recorded = /`gate-d-r3\/io-gate\.mjs`, sha256 `([0-9a-f]{64})`/.exec(doc)?.[1];
    expect(recorded).toBeDefined();
    const actual = createHash("sha256").update(readFileSync(join(REAL_ROOT, "vendor", "code-battle-gate-d-r3", "io-gate.mjs"))).digest("hex");
    expect(actual).toBe(recorded);
  });
});

describe("scripts/gate-d-code-loop.py external task root (INFER-521)", { timeout: 60_000 }, () => {
  function codeLoop(repo: string, args: string[], env: Record<string, string> = {}) {
    cpSync(join(REAL_ROOT, "scripts", "gate-d-code-loop.py"), join(repo, "scripts", "gate-d-code-loop.py"));
    const work = tmp("gd-ext-cl-");
    return spawnSync("python3", [join(repo, "scripts", "gate-d-code-loop.py"), ...args], {
      encoding: "utf8",
      env: cleanEnv({ GATE_D_CL_REPO: repo, GATE_D_CL_RESULTS: join(work, "cl.jsonl"), ...env }),
    });
  }

  it("lists and scores the external corpus without credentials", () => {
    const repo = fixtureRepo();
    const root = corpus();
    let r = codeLoop(repo, ["--tasks-root", root, "--list-tasks"]);
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ corpusRevision: "gate-d-r3", tasks: [TASK_A, TASK_B] });
    r = codeLoop(repo, ["--scoreboard-only"], { GATE_D_TASKS_ROOT: root });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("no acceptance gate");
    expect(r.stdout).toContain('"verdict": "REPORT"');
  });

  it("defaults to the checkout that holds the script", () => {
    const repo = fixtureRepo();
    const root = corpus();
    cpSync(join(REAL_ROOT, "scripts", "gate-d-code-loop.py"), join(repo, "scripts", "gate-d-code-loop.py"));
    const r = spawnSync("python3", [join(repo, "scripts", "gate-d-code-loop.py"), "--tasks-root", root, "--list-tasks"], {
      encoding: "utf8", env: cleanEnv({ GATE_D_CL_RESULTS: join(tmp("gd-ext-cl-"), "cl.jsonl") }),
    });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ tasks: [TASK_A, TASK_B] });
  });

  it("refuses sealed tasks without the opt-in and a root inside the checkout", () => {
    const repo = fixtureRepo();
    const sealed = corpus({ split: "sealed" });
    let r = codeLoop(repo, ["--tasks-root", sealed, "--list-tasks"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--include-holdout");
    r = codeLoop(repo, ["--tasks-root", sealed, "--include-holdout", "--list-tasks"]);
    expect(r.status, r.stderr).toBe(0);
    const inside = join(repo, "external");
    cpSync(corpus(), inside, { recursive: true });
    r = codeLoop(repo, ["--tasks-root", inside, "--list-tasks"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("overlaps this checkout");
  });
});

describe("gate-d/sweep.sh external task root (INFER-521)", { timeout: 240_000 }, () => {
  it("resumes and summarizes by corpus revision and task digest", () => {
    const repo = fixtureRepo();
    const root = corpus();
    const { bin, log } = fakeBin(root);
    const work = tmp("gd-ext-sweep-");
    const env = {
      GATE_D_TASKS_ROOT: root, ARMS: "pi", SEEDS: "1",
      GATE_D_OUT: join(work, "rows.jsonl"), GATE_D_LOG: join(work, "sweep.log"),
    };
    let r = runGateD(repo, bin, env, [], "sweep.sh");
    expect(r.res.status, r.res.stderr).toBe(0);
    expect(calls(log)).toHaveLength(2);
    expect(r.res.stdout).toContain("gate-d-r3 pi/m [prompt=none]: 1/2 pass");

    r = runGateD(repo, bin, env, [], "sweep.sh");
    expect(r.res.status, r.res.stderr).toBe(0);
    expect(calls(log)).toHaveLength(2);

    // Re-generating task B (new content, new manifest digest) re-runs only task B, and its old row
    // no longer counts in the summary.
    appendFileSync(join(root, TASK_B, "INSTRUCTION.md"), "\nRegenerated.\n");
    writeManifest(root);
    r = runGateD(repo, bin, env, [], "sweep.sh");
    expect(r.res.status, r.res.stderr).toBe(0);
    expect(calls(log).map((c) => c.task)).toEqual([TASK_A, TASK_B, TASK_B]);
    expect(r.res.stdout).toContain("gate-d-r3 pi/m [prompt=none]: 1/2 pass");
    expect(rows(env.GATE_D_OUT)).toHaveLength(3);
  });

  it("does not count rows whose R3-io gate could not run, so a repaired sweep finishes", () => {
    const repo = fixtureRepo();
    const root = corpus();
    const { bin, log } = fakeBin(root);
    const work = tmp("gd-ext-sweep-");
    const env = {
      GATE_D_TASKS_ROOT: root, ARMS: "pi", SEEDS: "1",
      GATE_D_OUT: join(work, "rows.jsonl"), GATE_D_LOG: join(work, "sweep.log"),
    };
    const gate = join(repo, "vendor", "code-battle-gate-d-r3", "io-gate.mjs");
    const original = readFileSync(gate);
    writeFileSync(gate, "throw new Error('broken gate');\n");
    let r = runGateD(repo, bin, env, [], "sweep.sh");
    expect(r.res.status, r.res.stderr).toBe(0);
    expect(rows(env.GATE_D_OUT).map((x) => x.exitClass)).toEqual(["R3-io-error", "R3-io-error"]);
    expect(r.res.stdout).not.toContain("pass");
    writeFileSync(gate, original);
    r = runGateD(repo, bin, env, [], "sweep.sh");
    expect(r.res.status, r.res.stderr).toBe(0);
    expect(calls(log)).toHaveLength(4);
    expect(r.res.stdout).toContain("gate-d-r3 pi/m [prompt=none]: 1/2 pass");
  });

  it("never counts validation rows toward a sealed run of the same task bytes", () => {
    const repo = fixtureRepo();
    const root = corpus();
    const { bin, log } = fakeBin(root);
    const work = tmp("gd-ext-sweep-");
    const env = {
      GATE_D_TASKS_ROOT: root, ARMS: "pi", SEEDS: "1",
      GATE_D_OUT: join(work, "rows.jsonl"), GATE_D_LOG: join(work, "sweep.log"),
    };
    let r = runGateD(repo, bin, env, [], "sweep.sh");
    expect(r.res.status, r.res.stderr).toBe(0);
    expect(calls(log)).toHaveLength(2);
    // Same task bytes and digests, now under a sealed manifest.
    writeManifest(root, "gate-d-r3", "sealed");
    r = runGateD(repo, bin, { ...env, GATE_D_INCLUDE_HOLDOUT: "1" }, [], "sweep.sh");
    expect(r.res.status, r.res.stderr).toBe(0);
    expect(calls(log)).toHaveLength(4);
    expect(rows(env.GATE_D_OUT).map((x) => x.holdout)).toEqual([false, false, true, true]);
  });

  it("aborts without a row when the manifest changes after the sweep pinned it", () => {
    const repo = fixtureRepo();
    const root = corpus();
    // The first arm rewrites the manifest: its own post-arm check refuses, before any row.
    const { bin, log } = fakeBin(root,
      `const m = path.join(root, "corpus-manifest.json"); fs.writeFileSync(m, fs.readFileSync(m, "utf8") + " ");`);
    const work = tmp("gd-ext-sweep-");
    const { res } = runGateD(repo, bin, {
      GATE_D_TASKS_ROOT: root, ARMS: "pi", SEEDS: "1",
      GATE_D_OUT: join(work, "rows.jsonl"), GATE_D_LOG: join(work, "sweep.log"),
    }, [], "sweep.sh");
    expect(res.status).toBe(9);
    expect(res.stdout + res.stderr).toContain("changed since it was pinned");
    expect(calls(log)).toHaveLength(1);
    expect(rows(join(work, "rows.jsonl"))).toEqual([]);
  });
});
