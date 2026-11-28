import { describe, expect, it, afterEach } from "vitest";
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
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// INFER-521: gate-d/run.sh, sweep.sh and the corpus helper running an external task root (for
// example code-battle's gate-d-r3) with a corpus-manifest.json. Every case runs against a disposable
// git checkout of gate-d/ and a synthetic two-task external corpus built from in-repo tasks.
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
  cpSync(join(REAL_ROOT, "scripts", "pi-benchmark-telemetry.ts"), join(repo, "scripts", "pi-benchmark-telemetry.ts"));
  symlinkSync(join(REAL_ROOT, "node_modules"), join(repo, "node_modules"));
  cpSync(join(REAL_ROOT, "package.json"), join(repo, "package.json"));
  writeFileSync(join(repo, ".gitignore"), "node_modules\ndata/\n");
  git(repo, "init", "-q", "--template=");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "fixture");
  return repo;
}

const SOURCES = [
  { id: "r3-test-a", from: "01-make-failing-test-pass", family: "make-pass", trap: false },
  { id: "r3-test-b", from: "06-fix-off-by-one", family: "boundary-bugfix", trap: true },
];

function corpusTool(repo: string, env: Record<string, string>, ...args: string[]) {
  return spawnSync("python3", [join(repo, "gate-d", "gate_d_corpus.py"), ...args], {
    encoding: "utf8",
    env: cleanEnv(env),
  });
}

function digestOf(repo: string, taskDir: string): string {
  const res = spawnSync("python3", ["-c", "import sys;sys.path.insert(0,sys.argv[1]);import gate_d_corpus as g;from pathlib import Path;print(g.tree_digest(Path(sys.argv[2])))", join(repo, "gate-d"), taskDir], { encoding: "utf8" });
  if (res.status !== 0) throw new Error(res.stderr);
  return res.stdout.trim();
}

/** A synthetic external corpus: two in-repo tasks re-labelled as gate-d-r3, plus its manifest. */
function externalCorpus(repo: string, opts: { root?: string; sealed?: boolean; atStop?: string | null } = {}): string {
  const root = opts.root ?? tmp("gd-ext-corpus-");
  mkdirSync(root, { recursive: true });
  const split = opts.sealed ? "sealed" : "validation";
  const tasks = [];
  for (const s of SOURCES) {
    const dir = join(root, s.id);
    cpSync(join(repo, "gate-d", "tasks", s.from), dir, { recursive: true });
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
    Object.assign(meta, { id: s.id, corpusRevision: "gate-d-r3", holdout: !!opts.sealed, split, family: s.family, trap: s.trap });
    writeFileSync(join(dir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
    tasks.push({ id: s.id, family: s.family, digest: digestOf(repo, dir) });
  }
  writeFileSync(join(root, "corpus-manifest.json"), JSON.stringify({ corpusRevision: "gate-d-r3", split, count: tasks.length, tasks }, null, 2));
  const atStop = opts.atStop === undefined
    ? `#!/usr/bin/env bash\nprintf '{"atStopTypecheck":"passed","atStopVisibleTests":"none","detectableFailureAtStop":false}\\n'\n`
    : opts.atStop;
  if (atStop !== null) writeFileSync(join(root, "at-stop.sh"), atStop);
  return root;
}

/**
 * Fake pi: logs its call, optionally applies the task's reference solution (so the run passes) and
 * runs extra JS, then emits a small NDJSON transcript: one edit followed by a green typecheck.
 */
function fakePi(opts: { root?: string; solve?: boolean; script?: string } = {}): { bin: string; log: string } {
  const bin = tmp("gd-ext-bin-");
  const log = join(bin, "calls.jsonl");
  writeFileSync(
    join(bin, "pi"),
    `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const id = path.basename(process.cwd()).replace(/-pi-[^-]+$/, "");
// The runner scrubs its GATE_D_* configuration from the arm, so the test hands the root in directly.
const taskDir = path.join(${JSON.stringify(opts.root ?? "")}, id);
const gateEnv = Object.keys(process.env).filter((k) => k.startsWith("GATE_D_"));
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ id, gateEnv }) + "\\n");
${opts.solve ? `fs.cpSync(path.join(taskDir, "solution"), process.cwd(), { recursive: true });` : ""}
${opts.script ?? ""}
const ev = (o) => console.log(JSON.stringify(o));
ev({ type: "turn_start" });
ev({ type: "tool_execution_start", toolCallId: "e1", toolName: "edit", args: { path: "secret/path.ts" } });
ev({ type: "tool_execution_end", toolCallId: "e1", toolName: "edit", isError: false });
ev({ type: "turn_start" });
ev({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "npx tsc --noEmit" } });
ev({ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", isError: false });
ev({ type: "turn_end", message: { usage: { input: 10, output: 4 } } });
`,
  );
  chmodSync(join(bin, "pi"), 0o755);
  return { bin, log };
}

function calls(log: string): Array<{ id: string; gateEnv: string[] }> {
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function rows(out: string): Array<Record<string, unknown>> {
  if (!existsSync(out)) return [];
  return readFileSync(out, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function runGateD(repo: string, bin: string, env: Record<string, string>, args: string[], script = "run.sh") {
  const work = tmp("gd-ext-work-");
  const out = env.GATE_D_OUT ?? join(work, "rows.jsonl");
  const res = spawnSync("bash", [join(repo, "gate-d", script), ...args], {
    cwd: repo,
    encoding: "utf8",
    env: cleanEnv({
      GW_KEY: "test-key",
      GW: "http://127.0.0.1:9/v1",
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

const VERIFICATION_KEYS = [
  "verificationClass", "typecheckRuns", "testRuns", "typecheckAfterLastEdit", "testsAfterLastEdit",
  "lastTypecheckOutcome", "lastTestOutcome", "stoppedWithFailingCheck", "ambiguousCheckOutcomes",
  "firstEditTurn", "lastEditTurn", "edits",
];

describe("Gate D external task root (INFER-521)", { timeout: 240_000 }, () => {
  it("runs a synthetic external two-task corpus end to end with r3 identity and the new fields", () => {
    const repo = fixtureRepo();
    const root = externalCorpus(repo);
    const manifest = JSON.parse(readFileSync(join(root, "corpus-manifest.json"), "utf8"));
    const { bin, log } = fakePi({ root, solve: true });
    const { res, out } = runGateD(repo, bin, { GATE_D_TASKS_ROOT: root }, ["pi", "all"]);
    expect(res.status, res.stderr).toBe(0);
    expect(calls(log).map((c) => c.id)).toEqual(["r3-test-a", "r3-test-b"]);
    // The arm never learns where the corpus (with its solutions and oracles) lives.
    for (const c of calls(log)) expect(c.gateEnv).toEqual([]);
    const all = rows(out);
    expect(all).toHaveLength(2);
    for (const [n, row] of all.entries()) {
      const src = SOURCES[n]!;
      expect(row).toMatchObject({
        task: src.id,
        corpusRevision: "gate-d-r3",
        taskRevision: manifest.tasks[n].digest,
        holdout: false,
        family: src.family,
        split: "validation",
        trap: src.trap,
        pass: true,
        exitClass: "pass",
        atStopTypecheck: "passed",
        atStopVisibleTests: "none",
        detectableFailureAtStop: false,
        verificationClass: "checked-green-after-last-edit",
        typecheckRuns: 1,
        testRuns: 0,
        typecheckAfterLastEdit: true,
        testsAfterLastEdit: false,
        lastTypecheckOutcome: "passed",
        lastTestOutcome: null,
        stoppedWithFailingCheck: false,
        ambiguousCheckOutcomes: 0,
        firstEditTurn: 1,
        lastEditTurn: 1,
        edits: 1,
      });
      // Content-blind: no command, path or transcript text in the row.
      expect(JSON.stringify(row)).not.toContain("tsc --noEmit");
      expect(JSON.stringify(row)).not.toContain("secret/path");
    }

    // The sweep resumes and summarizes within gate-d-r3 only.
    const sweep = runGateD(repo, bin, { GATE_D_TASKS_ROOT: root, GATE_D_OUT: out, ARMS: "pi", SEEDS: "1" }, [], "sweep.sh");
    expect(sweep.res.status, sweep.res.stderr).toBe(0);
    expect(sweep.res.stdout).toContain("[skip] pi/qwen3-coder-next-80b/r3-test-a");
    expect(sweep.res.stdout).toContain("gate-d-r3 pi/qwen3-coder-next-80b [prompt=none]: 2/2 pass");
    expect(rows(out)).toHaveLength(2);

    // A re-pinned task (new digest) does not resume from rows of its earlier version.
    const editedMeta = join(root, "r3-test-a", "meta.json");
    writeFileSync(editedMeta, readFileSync(editedMeta, "utf8").replace('"split"', '"note": "re-pinned",\n  "split"'));
    manifest.tasks[0].digest = digestOf(repo, join(root, "r3-test-a"));
    writeFileSync(join(root, "corpus-manifest.json"), JSON.stringify(manifest));
    const resweep = runGateD(repo, bin, { GATE_D_TASKS_ROOT: root, GATE_D_OUT: out, ARMS: "pi", SEEDS: "1" }, [], "sweep.sh");
    expect(resweep.res.status, resweep.res.stderr).toBe(0);
    expect(resweep.res.stdout).toContain("[run ] pi/qwen3-coder-next-80b/r3-test-a");
    expect(resweep.res.stdout).toContain("[skip] pi/qwen3-coder-next-80b/r3-test-b");
    expect(rows(out)).toHaveLength(3);
  });

  it("leaves in-repo r1/r2 enumeration and pinning unchanged", () => {
    const repo = fixtureRepo();
    const corpus = JSON.parse(readFileSync(join(repo, "gate-d", "corpus.json"), "utf8"));
    const r1 = corpusTool(repo, {}, "tasks");
    expect(r1.stdout.trim().split("\n")).toEqual(corpus.revisions["gate-d-r1"].tasks);
    expect(corpusTool(repo, {}, "revision").stdout.trim()).toBe("gate-d-r1");
    const r2 = corpusTool(repo, { GATE_D_INCLUDE_HOLDOUT: "1" }, "tasks");
    expect(r2.stdout.trim().split("\n")).toEqual(corpus.revisions["gate-d-r2"].tasks);
    expect(corpus.revisions["gate-d-r1"].pinnedTaskTree).toBe("5ab301a9cfd63debf37d9edd1823514f692dc872");
    expect(corpusTool(repo, {}, "tasks-root").stdout.trim()).toBe(join(repo, "gate-d", "tasks"));

    // An in-repo row keeps its identity and gains no external-only fields.
    const { bin } = fakePi();
    const { res, out } = runGateD(repo, bin, {}, ["pi", "01-make-failing-test-pass"]);
    expect(res.status, res.stderr).toBe(0);
    const [row] = rows(out);
    expect(row).toMatchObject({ corpusRevision: "gate-d-r1", taskRevision: "gate-d-r1", holdout: false });
    for (const key of ["family", "split", "trap", "atStopTypecheck", "detectableFailureAtStop"]) expect(row).not.toHaveProperty(key);
    expect(row!.verificationClass).toBe("checked-green-after-last-edit");
  });

  it.each([
    ["a pre-existing edit", "pre"],
    ["an edit made mid-run", "edit"],
    ["an added file", "add"],
  ])("aborts without a row on %s to an external task", (_label, mode) => {
    const repo = fixtureRepo();
    const root = externalCorpus(repo);
    const target = join(root, "r3-test-a", "repo", "src", "sum.ts");
    if (mode === "pre") appendFileSync(target, "// drift\n");
    const script = mode === "edit"
      ? `fs.appendFileSync(${JSON.stringify(target)}, "// escaped edit\\n");`
      : mode === "add"
        ? `fs.writeFileSync(path.join(taskDir, "oracle-extra.ts"), "x");`
        : "";
    const { bin, log } = fakePi({ root, solve: true, script });
    const { res, out } = runGateD(repo, bin, { GATE_D_TASKS_ROOT: root }, ["pi", "r3-test-a"]);
    expect(res.status).toBe(9);
    expect(res.stderr).toMatch(/manifest digest before the run|changed on disk during this run/);
    expect(rows(out)).toEqual([]);
    expect(calls(log)).toHaveLength(mode === "pre" ? 0 : 1);
  });

  it("aborts without a row when the task changes during grading", () => {
    const repo = fixtureRepo();
    const root = externalCorpus(repo, {
      atStop: `#!/usr/bin/env bash\necho tampered >> "$1/INSTRUCTION.md"\n`,
    });
    const { bin } = fakePi({ root, solve: true });
    const { res, out } = runGateD(repo, bin, { GATE_D_TASKS_ROOT: root }, ["pi", "r3-test-a"]);
    expect(res.status).toBe(9);
    expect(res.stderr).toContain("changed on disk during grading");
    expect(rows(out)).toEqual([]);
  });

  it("refuses a task root inside the checkout, an overlapping work root, and sealed tasks without the opt-in", () => {
    const repo = fixtureRepo();
    const { bin, log } = fakePi();

    const inside = externalCorpus(repo, { root: join(repo, "external-r3") });
    let r = runGateD(repo, bin, { GATE_D_TASKS_ROOT: inside }, ["pi", "all"]);
    expect(r.res.status).toBe(3);
    expect(r.res.stderr).toContain("overlaps this checkout");

    const root = externalCorpus(repo);
    r = runGateD(repo, bin, { GATE_D_TASKS_ROOT: root, GATE_D_WORKROOT: join(root, "work") }, ["pi", "all"]);
    expect(r.res.status).toBe(3);
    expect(r.res.stderr).toContain("overlap");

    const sealed = externalCorpus(repo, { sealed: true });
    for (const sel of ["all", "r3-test-a"]) {
      r = runGateD(repo, bin, { GATE_D_TASKS_ROOT: sealed }, ["pi", sel]);
      expect(r.res.status).toBe(3);
      expect(r.res.stderr).toContain("holdouts require GATE_D_INCLUDE_HOLDOUT=1");
    }
    expect(runGateD(repo, bin, { GATE_D_TASKS_ROOT: sealed, ARMS: "pi" }, [], "sweep.sh").res.status).toBe(3);
    expect(calls(log)).toEqual([]);
    expect(rows(r.out)).toEqual([]);

    r = runGateD(repo, bin, { GATE_D_TASKS_ROOT: sealed, GATE_D_INCLUDE_HOLDOUT: "1" }, ["pi", "r3-test-a"]);
    expect(r.res.status, r.res.stderr).toBe(0);
    expect(rows(r.out)[0]).toMatchObject({ corpusRevision: "gate-d-r3", holdout: true, split: "sealed" });
  });

  it("rejects manifests that collide with in-repo revisions or list unknown tasks", () => {
    const repo = fixtureRepo();
    const root = externalCorpus(repo);
    const path = join(root, "corpus-manifest.json");
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...manifest, corpusRevision: "gate-d-r1" }));
    expect(corpusTool(repo, { GATE_D_TASKS_ROOT: root }, "tasks").stderr).toContain("collides with an in-repo revision");
    writeFileSync(path, JSON.stringify({ ...manifest, tasks: [...manifest.tasks, { id: "../escape", digest: "0".repeat(64) }], count: 3 }));
    expect(corpusTool(repo, { GATE_D_TASKS_ROOT: root }, "tasks").stderr).toContain("invalid task id");
    writeFileSync(path, JSON.stringify(manifest));
    symlinkSync(join(repo, "gate-d", "check.sh"), join(root, "r3-test-a", "link.sh"));
    expect(corpusTool(repo, { GATE_D_TASKS_ROOT: root }, "verify-digest", "r3-test-a").stderr).toContain("symlink");
  });

  it.each([
    ["missing", null],
    ["failing", "#!/usr/bin/env bash\necho nope\nexit 1\n"],
    ["malformed", `#!/usr/bin/env bash\necho '{"atStopTypecheck":"passed","atStopVisibleTests":"none","detectableFailureAtStop":false,"cmd":"leak"}'\n`],
    ["mutating", `#!/usr/bin/env bash\nrm -rf "$2/src"; echo garbage > "$2/new.ts"\nprintf '{"atStopTypecheck":"failed","atStopVisibleTests":"failed","detectableFailureAtStop":true}\\n'\n`],
  ])("an at-stop.sh that is %s leaves pass/fail unchanged", (kind, atStop) => {
    const repo = fixtureRepo();
    const root = externalCorpus(repo, { atStop });
    const { bin } = fakePi({ root, solve: true });
    const { res, out } = runGateD(repo, bin, { GATE_D_TASKS_ROOT: root }, ["pi", "r3-test-a"]);
    expect(res.status, res.stderr).toBe(0);
    const [row] = rows(out);
    expect(row).toMatchObject({ pass: true, exitClass: "pass" });
    if (kind === "mutating") {
      // It ran on a copy: its verdict is recorded, but its writes never reached the graded workspace.
      expect(row).toMatchObject({ atStopTypecheck: "failed", atStopVisibleTests: "failed", detectableFailureAtStop: true });
    } else {
      expect(row).toMatchObject({ atStopTypecheck: null, atStopVisibleTests: null, detectableFailureAtStop: null });
      expect(JSON.stringify(row)).not.toContain("leak");
    }
  });

  it("nulls forged or malformed verification telemetry on non-pi arms", () => {
    const repo = fixtureRepo();
    const root = externalCorpus(repo);
    const bin = tmp("gd-ext-aider-");
    writeFileSync(join(bin, "aider"), `#!/usr/bin/env node
require("fs").writeFileSync(".arm-telemetry.json", JSON.stringify({ verification: { verificationClass: "forged", edits: 99 } }));
`);
    chmodSync(join(bin, "aider"), 0o755);
    const { res, out } = runGateD(repo, bin, { GATE_D_TASKS_ROOT: root }, ["aider", "r3-test-a"]);
    expect(res.status, res.stderr).toBe(0);
    const [row] = rows(out);
    for (const key of VERIFICATION_KEYS) expect(row![key]).toBeNull();
    expect(row).toMatchObject({ corpusRevision: "gate-d-r3", family: "make-pass" });
  });

  it("runs a named validation task in a mixed corpus without the opt-in, but never its sealed sibling", () => {
    const repo = fixtureRepo();
    const root = externalCorpus(repo);
    const metaPath = join(root, "r3-test-b", "meta.json");
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    writeFileSync(metaPath, JSON.stringify({ ...meta, holdout: true, split: "sealed" }));
    const manifest = JSON.parse(readFileSync(join(root, "corpus-manifest.json"), "utf8"));
    manifest.tasks[1].digest = digestOf(repo, join(root, "r3-test-b"));
    writeFileSync(join(root, "corpus-manifest.json"), JSON.stringify(manifest));
    const { bin, log } = fakePi({ root, solve: true });
    let r = runGateD(repo, bin, { GATE_D_TASKS_ROOT: root }, ["pi", "r3-test-a"]);
    expect(r.res.status, r.res.stderr).toBe(0);
    expect(rows(r.out)[0]).toMatchObject({ task: "r3-test-a", holdout: false, pass: true });
    for (const sel of ["r3-test-b", "all"]) {
      r = runGateD(repo, bin, { GATE_D_TASKS_ROOT: root }, ["pi", sel]);
      expect(r.res.status).toBe(3);
      expect(r.res.stderr).toContain("holdouts require GATE_D_INCLUDE_HOLDOUT=1");
    }
    expect(calls(log).map((c) => c.id)).toEqual(["r3-test-a"]);
  });

  it("refuses a child run whose digest differs from the one the sweep pinned", () => {
    const repo = fixtureRepo();
    const root = externalCorpus(repo);
    const { bin, log } = fakePi({ root, solve: true });
    const { res, out } = runGateD(repo, bin, { GATE_D_TASKS_ROOT: root, GATE_D_EXPECT_TASK_REVISION: "0".repeat(64) }, ["pi", "r3-test-a"]);
    expect(res.status).toBe(3);
    expect(res.stderr).toContain("changed since the sweep started");
    expect(rows(out)).toEqual([]);
    expect(calls(log)).toEqual([]);
  });

  it("resolves a relative GATE_D_AT_STOP from the caller's directory", () => {
    const repo = fixtureRepo();
    const root = externalCorpus(repo, { atStop: null });
    const scripts = join(repo, "at-stop-local");
    mkdirSync(scripts);
    writeFileSync(join(scripts, "at-stop.sh"), `#!/usr/bin/env bash\nprintf '{"atStopTypecheck":"failed","atStopVisibleTests":"none","detectableFailureAtStop":true}\\n'\n`);
    const { bin } = fakePi({ root, solve: true });
    // runGateD runs from the fixture checkout, so this relative path names the file above.
    const { res, out } = runGateD(repo, bin, { GATE_D_TASKS_ROOT: root, GATE_D_AT_STOP: "at-stop-local/at-stop.sh" }, ["pi", "r3-test-a"]);
    expect(res.status, res.stderr).toBe(0);
    expect(rows(out)[0]).toMatchObject({ pass: true, atStopTypecheck: "failed", detectableFailureAtStop: true });
  });

  it("refuses a task root whose path would break quoting", () => {
    const repo = fixtureRepo();
    const root = externalCorpus(repo, { root: join(tmp("gd-ext-q-"), "it's") });
    const r = corpusTool(repo, { GATE_D_TASKS_ROOT: root }, "tasks");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("quote");
  });

  it("grades an external task through the code-loop runner with the runner-owned toolchain link", () => {
    const repo = fixtureRepo();
    const root = externalCorpus(repo);
    const home = tmp("gd-ext-home-");
    writeFileSync(join(home, ".scout-maintenance.env"), "KEY=hs_owner_test_key\n");
    const results = join(tmp("gd-ext-cl-"), "cl.jsonl");
    // A stand-in code_loop gateway that returns the reference solution as the diff.
    const harness = `
import http.server, json, os, shutil, subprocess, sys, tempfile, threading
task = sys.argv[1]
seed = tempfile.mkdtemp()
shutil.copytree(os.path.join(task, "repo"), seed, dirs_exist_ok=True)
g = lambda *a: subprocess.run(["git", "-c", "user.email=t@l", "-c", "user.name=t", *a], cwd=seed, check=True, capture_output=True, text=True).stdout
g("init", "-q"); g("add", "-A"); g("commit", "-qm", "seed")
shutil.copytree(os.path.join(task, "solution"), seed, dirs_exist_ok=True)
diff = g("diff")
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        tool = body["params"]["name"]
        out = {"code_loop_start": {"work_id": "w1"}, "code_loop_status": {"status": "done"},
               "code_loop_result": {"status": "done", "diff": diff}}[tool]
        data = json.dumps({"result": {"content": [{"text": json.dumps(out)}]}}).encode()
        self.send_response(200); self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)
srv = http.server.HTTPServer(("127.0.0.1", 0), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
env = dict(os.environ, GATE_D_CL_GATEWAY=f"http://127.0.0.1:{srv.server_port}/mcp")
r = subprocess.run([sys.executable, sys.argv[2], "r3-test-a"], env=env, capture_output=True, text=True)
sys.stdout.write(r.stdout); sys.stderr.write(r.stderr); sys.exit(r.returncode)
`;
    mkdirSync(join(repo, "scripts"), { recursive: true });
    cpSync(join(REAL_ROOT, "scripts", "gate-d-code-loop.py"), join(repo, "scripts", "gate-d-code-loop.py"));
    const res = spawnSync("python3", ["-c", harness, join(root, "r3-test-a"), join(repo, "scripts", "gate-d-code-loop.py")], {
      encoding: "utf8",
      env: cleanEnv({ HOME: home, GATE_D_CL_REPO: repo, GATE_D_CL_RESULTS: results, GATE_D_TASKS_ROOT: root, NO_PROXY: "127.0.0.1", no_proxy: "127.0.0.1" }),
      timeout: 120_000,
    });
    expect(res.status, res.stdout + res.stderr).toBe(0);
    const [row] = rows(results);
    expect(row, res.stdout).toMatchObject({ id: "r3-test-a", corpusRevision: "gate-d-r3", family: "make-pass", applied: true, passed: true });
    // Content-blind: an external row keeps the gate id, never check.sh output or gateway text.
    expect(row).toMatchObject({ check_gate: "pass" });
    for (const key of ["check_tail", "detail", "summary"]) expect(row).not.toHaveProperty(key);
    // Grading happened in a private temp dir, not under the public checkout.
    expect(existsSync(join(repo, "gate-d", ".work-cl", "r3-test-a"))).toBe(false);
  });

  it("rejects missing or contradictory holdout metadata", () => {
    const repo = fixtureRepo();
    const root = externalCorpus(repo);
    const metaPath = join(root, "r3-test-a", "meta.json");
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    const repin = () => {
      const manifest = JSON.parse(readFileSync(join(root, "corpus-manifest.json"), "utf8"));
      manifest.tasks[0].digest = digestOf(repo, join(root, "r3-test-a"));
      writeFileSync(join(root, "corpus-manifest.json"), JSON.stringify(manifest));
    };
    const { holdout: _drop, ...noHoldout } = meta;
    writeFileSync(metaPath, JSON.stringify(noHoldout)); repin();
    expect(corpusTool(repo, { GATE_D_TASKS_ROOT: root }, "tasks").stderr).toContain("must set holdout");
    writeFileSync(metaPath, JSON.stringify({ ...meta, split: "sealed", holdout: false })); repin();
    expect(corpusTool(repo, { GATE_D_TASKS_ROOT: root }, "tasks").stderr).toContain("sealed split but does not set holdout");
  });

  it("binds the digest check to the exact directory that is seeded and graded", () => {
    const repo = fixtureRepo();
    const root = externalCorpus(repo);
    const copy = join(tmp("gd-ext-copy-"), "r3-test-a");
    cpSync(join(root, "r3-test-a"), copy, { recursive: true });
    appendFileSync(join(copy, "INSTRUCTION.md"), "tampered\n");
    const manifest = JSON.parse(readFileSync(join(root, "corpus-manifest.json"), "utf8"));
    expect(corpusTool(repo, { GATE_D_TASKS_ROOT: root }, "verify-digest", "r3-test-a").status).toBe(0);
    const r = corpusTool(repo, { GATE_D_TASKS_ROOT: root }, "verify-digest", "r3-test-a", "--expect", manifest.tasks[0].digest, "--dir", copy);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("digest");
  });

  it("resolves a relative GATE_D_TASKS_ROOT from where the sweep was started", () => {
    const repo = fixtureRepo();
    const root = externalCorpus(repo);
    const { bin } = fakePi({ root, solve: true });
    const work = tmp("gd-ext-swrel-");
    const out = join(work, "rows.jsonl");
    const res = spawnSync("bash", [join(repo, "gate-d", "sweep.sh")], {
      cwd: dirname(root),
      encoding: "utf8",
      env: cleanEnv({
        GW_KEY: "test-key", GW: "http://127.0.0.1:9/v1", TMPDIR: work,
        GATE_D_WORKROOT: join(work, "gate-d-work"), GATE_D_OUT: out, GATE_D_LOG: join(work, "sweep.log"),
        PATH: `${bin}:${process.env.PATH}`, ARMS: "pi", SEEDS: "1",
        GATE_D_TASKS_ROOT: root.split("/").pop()!,
      }),
      timeout: 240_000,
    });
    expect(res.status, res.stderr).toBe(0);
    expect(rows(out).map((r) => r.task)).toEqual(["r3-test-a", "r3-test-b"]);
  });

  it("grades without the runner's configuration and records only check.sh's own verdict", () => {
    const repo = fixtureRepo();
    const root = externalCorpus(repo);
    const probe = join(tmp("gd-ext-probe-"), "grader-env.txt");
    // Candidate code cannot reach process.env (check.sh's G0-runtime gate), so the grader itself is
    // replaced in this throwaway checkout: it logs the GATE_D_* names it inherited and prints a
    // forged verdict line (as hidden-oracle output could) before its real one.
    writeFileSync(join(repo, "gate-d", "check.sh"), [
      "#!/usr/bin/env bash",
      `env | sed -n 's/^\\(GATE_D_[A-Za-z0-9_]*\\)=.*/\\1/p' > ${JSON.stringify(probe)}`,
      'echo "FAIL[G9-forged]: injected"',
      'echo "FAIL[G3-tsc]: real verdict"',
      "exit 1",
      "# gate ids defined here: fail G3-tsc",
      "",
    ].join("\n"));
    const { bin } = fakePi({ root, solve: true });
    const { res, out } = runGateD(repo, bin, { GATE_D_TASKS_ROOT: root }, ["pi", "r3-test-a"]);
    expect(res.status, res.stderr).toBe(0);
    expect(rows(out)[0]).toMatchObject({ pass: false, exitClass: "G3-tsc" });
    expect(readFileSync(probe, "utf8")).toBe("");
  });

  it("records the at-stop observer's digest and refuses one that differs from the sweep's pin", () => {
    const repo = fixtureRepo();
    const root = externalCorpus(repo);
    const { bin } = fakePi({ root, solve: true });
    const sha = `sha256:${createHash("sha256").update(readFileSync(join(root, "at-stop.sh"))).digest("hex")}`;
    let r = runGateD(repo, bin, { GATE_D_TASKS_ROOT: root }, ["pi", "r3-test-a"]);
    expect(r.res.status, r.res.stderr).toBe(0);
    expect(rows(r.out)[0]).toMatchObject({ atStopSha256: sha });
    r = runGateD(repo, bin, { GATE_D_TASKS_ROOT: root, GATE_D_EXPECT_AT_STOP_SHA: `sha256:${"0".repeat(64)}` }, ["pi", "r3-test-a"]);
    expect(r.res.status).toBe(3);
    expect(r.res.stderr).toContain("differs from the one the sweep pinned");

    // A sweep resumes only rows of the same observer.
    const out = r.out;
    const first = runGateD(repo, bin, { GATE_D_TASKS_ROOT: root, GATE_D_OUT: out, ARMS: "pi", SEEDS: "1" }, [], "sweep.sh");
    expect(first.res.status, first.res.stderr).toBe(0);
    appendFileSync(join(root, "at-stop.sh"), "# fixed observer\n");
    const again = runGateD(repo, bin, { GATE_D_TASKS_ROOT: root, GATE_D_OUT: out, ARMS: "pi", SEEDS: "1" }, [], "sweep.sh");
    expect(again.res.status, again.res.stderr).toBe(0);
    expect(again.res.stdout).toContain("[run ] pi/qwen3-coder-next-80b/r3-test-a");
    expect(rows(out)).toHaveLength(4);
  });
});
