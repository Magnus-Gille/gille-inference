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
 * ships a package.json whose `npm test` runs its oracle, declared as a visible test, so at-stop.sh
 * reports it red on the untouched seed.
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
        JSON.stringify({ private: true, scripts: { test: "tsx test/paginate.oracle.ts" } }, null, 2) + "\n");
      meta.oracleFiles = [...meta.oracleFiles, "package.json"];
      meta.visibleTests = ["test/paginate.oracle.ts"];
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
    for (const k of VERIFICATION_KEYS) expect(row![k], k).toBeNull();
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

  it("aborts when the manifest changes after the sweep pinned it", () => {
    const repo = fixtureRepo();
    const root = corpus();
    // The first arm rewrites the manifest; the next run.sh invocation must refuse.
    const { bin, log } = fakeBin(root,
      `const m = path.join(root, "corpus-manifest.json"); fs.writeFileSync(m, fs.readFileSync(m, "utf8") + " ");`);
    const work = tmp("gd-ext-sweep-");
    const { res } = runGateD(repo, bin, {
      GATE_D_TASKS_ROOT: root, ARMS: "pi", SEEDS: "1",
      GATE_D_OUT: join(work, "rows.jsonl"), GATE_D_LOG: join(work, "sweep.log"),
    }, [], "sweep.sh");
    expect(res.status).toBe(3);
    expect(res.stdout + res.stderr).toContain("changed since the sweep started");
    expect(calls(log)).toHaveLength(1);
  });
});
