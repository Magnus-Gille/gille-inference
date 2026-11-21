import { describe, expect, it, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Every case runs against a disposable git checkout of gate-d/, never the developer's checkout:
// run.sh restores fixtures with `git checkout`/`git clean` when it detects drift, and that must only
// ever touch a throwaway tree.
const REAL_ROOT = process.cwd();
const VARIANT = "verify-before-done.md";
const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  cleanup.push(dir);
  return dir;
}

/** The caller's environment minus every Git override, so fixture Git can only touch the fixture. */
function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("GIT_")) env[k] = v;
  return { ...env, ...extra };
}

function git(cwd: string, ...args: string[]): string {
  const res = spawnSync("git", ["-c", "user.email=t@local", "-c", "user.name=t", ...args], {
    cwd,
    encoding: "utf8",
    env: cleanEnv(),
  });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr}`);
  return res.stdout;
}

function fixtureRepo(): string {
  const repo = tmp("gd-fixture-");
  cpSync(join(REAL_ROOT, "gate-d"), join(repo, "gate-d"), { recursive: true });
  mkdirSync(join(repo, "scripts"));
  cpSync(join(REAL_ROOT, "scripts", "pi-benchmark-telemetry.ts"), join(repo, "scripts", "pi-benchmark-telemetry.ts"));
  symlinkSync(join(REAL_ROOT, "node_modules"), join(repo, "node_modules"));
  // The real package.json declares ESM; without it tsx would load the telemetry collector as CJS.
  cpSync(join(REAL_ROOT, "package.json"), join(repo, "package.json"));
  writeFileSync(join(repo, ".gitignore"), "node_modules\ndata/\n");
  git(repo, "init", "-q");
  const top = realpathSync(git(repo, "rev-parse", "--show-toplevel").trim());
  if (top !== repo) throw new Error(`fixture git top level escaped to ${top}`);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "fixture");
  return repo;
}

/** Fake arm executables that record their argv (and, for pi, the exact prompt bytes received). */
function fakeBin(script = ""): { bin: string; log: string } {
  const bin = tmp("gd-bin-");
  const log = join(bin, "calls.jsonl");
  for (const name of ["pi", "aider", "opencode", "qwen"]) {
    writeFileSync(
      join(bin, name),
      `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
const i = args.indexOf("--append-system-prompt");
let prompt = null;
if (i >= 0) { try { prompt = fs.readFileSync(args[i + 1], "utf8"); } catch (e) { prompt = null; } }
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ name: ${JSON.stringify(name)}, args, prompt }) + "\\n");
${script}
`,
    );
    chmodSync(join(bin, name), 0o755);
  }
  return { bin, log };
}

function calls(log: string): Array<{ name: string; args: string[]; prompt: string | null }> {
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function runGateD(repo: string, bin: string, env: Record<string, string>, args: string[], script = "run.sh") {
  const work = tmp("gd-work-");
  const out = join(work, "rows.jsonl");
  const res = spawnSync("bash", [join(repo, "gate-d", script), ...args], {
    cwd: repo,
    encoding: "utf8",
    env: cleanEnv({
      GW_KEY: "test-key",
      GW: "http://127.0.0.1:9/v1",
      TMPDIR: work,
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

const sha256 = (text: string) => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
const TASK = "01-make-failing-test-pass";

describe("gate-d/run.sh pi prompt variants (INFER-519)", { timeout: 120_000 }, () => {
  it.each([
    ["../secret.md", "bare file name"],
    [".hidden.md", "bare file name"],
    ["missing-variant.md", "no such prompt variant committed"],
  ])("rejects %s before any arm runs", (value, message) => {
    const repo = fixtureRepo();
    const { bin, log } = fakeBin();
    const { res, out } = runGateD(repo, bin, { GATE_D_PI_APPEND_SYSTEM: value }, ["pi", TASK]);
    expect(res.status).toBe(3);
    expect(res.stderr).toContain(message);
    expect(calls(log)).toEqual([]);
    expect(rows(out)).toEqual([]);
  });

  it("rejects untracked, edited and symlinked prompt files", () => {
    const repo = fixtureRepo();
    const { bin, log } = fakeBin();
    const prompts = join(repo, "gate-d", "prompts");

    writeFileSync(join(prompts, "untracked.md"), "not committed\n");
    let r = runGateD(repo, bin, { GATE_D_PI_APPEND_SYSTEM: "untracked.md" }, ["pi", TASK]);
    expect(r.res.status).toBe(3);
    expect(r.res.stderr).toContain("no such prompt variant committed");

    writeFileSync(join(prompts, VARIANT), "edited in the working tree\n");
    r = runGateD(repo, bin, { GATE_D_PI_APPEND_SYSTEM: VARIANT }, ["pi", TASK]);
    expect(r.res.status).toBe(3);
    expect(r.res.stderr).toContain("differs from HEAD");
    git(repo, "checkout", "-q", "--", "gate-d/prompts");

    const outside = join(tmp("gd-outside-"), "outside.md");
    writeFileSync(outside, "content from outside the prompts directory\n");
    symlinkSync(outside, join(prompts, "linked.md"));
    git(repo, "add", "gate-d/prompts/linked.md");
    git(repo, "commit", "-q", "-m", "symlinked variant");
    r = runGateD(repo, bin, { GATE_D_PI_APPEND_SYSTEM: "linked.md" }, ["pi", TASK]);
    expect(r.res.status).toBe(3);
    expect(r.res.stderr).toContain("regular file");

    unlinkSync(join(prompts, VARIANT));
    symlinkSync(outside, join(prompts, VARIANT));
    r = runGateD(repo, bin, { GATE_D_PI_APPEND_SYSTEM: VARIANT }, ["pi", TASK]);
    expect(r.res.status).toBe(3);
    expect(r.res.stderr).toContain("differs from HEAD");

    expect(calls(log)).toEqual([]);
  });

  it("refuses the variant on non-pi arms", () => {
    const repo = fixtureRepo();
    const { bin, log } = fakeBin();
    const { res } = runGateD(repo, bin, { GATE_D_PI_APPEND_SYSTEM: VARIANT }, ["aider", TASK]);
    expect(res.status).toBe(3);
    expect(res.stderr).toContain("pi arm only");
    expect(calls(log)).toEqual([]);
  });

  it("hands pi a private snapshot by path and records the digest of exactly its bytes, across tasks and mid-run edits", () => {
    const repo = fixtureRepo();
    const promptPath = join(repo, "gate-d", "prompts", VARIANT);
    const committed = readFileSync(promptPath, "utf8");
    // Every fake pi edits the repository copy of the prompt; later tasks must still get the snapshot.
    const { bin, log } = fakeBin(`fs.writeFileSync(${JSON.stringify(promptPath)}, "tampered mid-run\\n");`);
    const { res, out } = runGateD(repo, bin, { GATE_D_PI_APPEND_SYSTEM: VARIANT }, ["pi", "all"]);
    expect(res.status, res.stderr).toBe(0);
    const pis = calls(log).filter((c) => c.name === "pi");
    expect(pis.length).toBe(10);
    const all = rows(out);
    expect(all).toHaveLength(10);
    for (const [n, pi] of pis.entries()) {
      const value = pi.args[pi.args.indexOf("--append-system-prompt") + 1]!;
      expect(value.startsWith("/")).toBe(true);
      expect(value.startsWith(repo)).toBe(false);
      expect(pi.prompt).toBe(committed);
      expect(all[n]!.promptVariant).toBe("verify-before-done");
      expect(all[n]!.promptSha256).toBe(sha256(committed));
    }
    // The real collector ran (ESM fixture) and the run was graded, not an arm error.
    expect(all[0]!.exitClass).toBe("G2-no-edit");
    expect(typeof all[0]!.turns).toBe("number");

    // A later invocation sees the edited working tree and fails closed instead of using it.
    const again = runGateD(repo, bin, { GATE_D_PI_APPEND_SYSTEM: VARIANT }, ["pi", TASK]);
    expect(again.res.status).toBe(3);
    expect(again.res.stderr).toContain("differs from HEAD");
  });

  it("never lets a filename-shaped prompt select another file", () => {
    const repo = fixtureRepo();
    writeFileSync(join(repo, "gate-d", "prompts", "filename.md"), "tsconfig.json");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "filename-shaped prompt");
    const { bin, log } = fakeBin();
    const { res, out } = runGateD(repo, bin, { GATE_D_PI_APPEND_SYSTEM: "filename.md" }, ["pi", TASK]);
    expect(res.status, res.stderr).toBe(0);
    const pi = calls(log).find((c) => c.name === "pi")!;
    const value = pi.args[pi.args.indexOf("--append-system-prompt") + 1]!;
    expect(value).not.toBe("tsconfig.json");
    expect(value.startsWith("/")).toBe(true);
    expect(pi.prompt).toBe("tsconfig.json");
    expect(rows(out).pop()!.promptSha256).toBe(sha256("tsconfig.json"));
  });

  it("fails closed without a row when the snapshot is modified during the run", () => {
    const repo = fixtureRepo();
    const { bin } = fakeBin(
      `if (i >= 0) { fs.chmodSync(args[i + 1], 0o600); fs.writeFileSync(args[i + 1], "swapped\\n"); }`,
    );
    const { res, out } = runGateD(repo, bin, { GATE_D_PI_APPEND_SYSTEM: VARIANT }, ["pi", TASK]);
    expect(res.status).toBe(3);
    expect(res.stderr).toContain("prompt snapshot");
    expect(rows(out)).toEqual([]);
  });

  it("refuses a prompt whose digest differs from the one a sweep pinned", () => {
    const repo = fixtureRepo();
    const { bin, log } = fakeBin();
    const { res } = runGateD(
      repo,
      bin,
      { GATE_D_PI_APPEND_SYSTEM: VARIANT, GATE_D_EXPECT_PROMPT_SHA: `sha256:${"0".repeat(64)}` },
      ["pi", TASK],
    );
    expect(res.status).toBe(3);
    expect(res.stderr).toContain("this sweep started with");
    expect(calls(log)).toEqual([]);
  });

  it("ignores inherited Git overrides that point at another checkout", () => {
    const victim = tmp("gd-victim-");
    git(victim, "init", "-q");
    writeFileSync(join(victim, "keep.txt"), "victim\n");
    git(victim, "add", "-A");
    git(victim, "commit", "-q", "-m", "victim");
    writeFileSync(join(victim, "uncommitted.txt"), "work in progress\n");
    const before = git(victim, "rev-parse", "HEAD");
    const repo = fixtureRepo();
    // Dirty a fixture file so run.sh's restore path (git checkout/clean) would run if it could.
    const { bin } = fakeBin(`fs.writeFileSync(${JSON.stringify(join(repo, "gate-d", "tasks", TASK, "INSTRUCTION.md"))}, "dirty\\n");`);
    const { res } = runGateD(
      repo,
      bin,
      { GATE_D_PI_APPEND_SYSTEM: VARIANT, GIT_DIR: join(victim, ".git"), GIT_WORK_TREE: victim },
      ["pi", TASK],
    );
    expect(res.status).toBe(9);
    expect(git(victim, "rev-parse", "HEAD")).toBe(before);
    expect(readFileSync(join(victim, "uncommitted.txt"), "utf8")).toBe("work in progress\n");
    expect(git(victim, "status", "--porcelain")).toBe("?? uncommitted.txt\n");
    // The fixture, not the victim, was restored.
    expect(readFileSync(join(repo, "gate-d", "tasks", TASK, "INSTRUCTION.md"), "utf8")).not.toBe("dirty\n");
  });

  it.runIf(existsSync("/dev/full"))("exits non-zero when the result row cannot be written", () => {
    const repo = fixtureRepo();
    const { bin } = fakeBin();
    const { res } = runGateD(repo, bin, { GATE_D_OUT: "/dev/full" }, ["pi", TASK]);
    expect(res.status).toBe(4);
    expect(res.stderr).toContain("could not append the result row");
  });

  it("labels baseline rows promptVariant none and passes no prompt flag", () => {
    const repo = fixtureRepo();
    const { bin, log } = fakeBin();
    const { res, out } = runGateD(repo, bin, { GATE_D_PI_APPEND_SYSTEM: "" }, ["pi", TASK]);
    expect(res.status, res.stderr).toBe(0);
    expect(calls(log).find((c) => c.name === "pi")!.args).not.toContain("--append-system-prompt");
    const row = rows(out).pop()!;
    expect(row.promptVariant).toBe("none");
    expect(row.promptSha256).toBeNull();
    expect(row.exitClass).toBe("G2-no-edit");
  });

  it("ignores work-dir telemetry on arms without a collector and keeps runner fields authoritative", () => {
    const repo = fixtureRepo();
    const { bin } = fakeBin(
      `fs.writeFileSync(".arm-telemetry.json", JSON.stringify({ promptVariant: "forged", promptSha256: "sha256:${"0".repeat(64)}", pass: true, exitClass: "pass", turns: 99 }));`,
    );
    const { res, out } = runGateD(repo, bin, {}, ["aider", TASK]);
    expect(res.status, res.stderr).toBe(0);
    const row = rows(out).pop()!;
    expect(row.promptVariant).toBe("none");
    expect(row.promptSha256).toBeNull();
    expect(row.pass).toBe(false);
    expect(row.exitClass).not.toBe("pass");
    expect(row.turns).toBeNull();
  });
});

describe("gate-d/sweep.sh prompt variants (INFER-519)", { timeout: 120_000 }, () => {
  /** Replace run.sh in the fixture with a stub that appends one labelled row per invocation. */
  function stubRunner(repo: string, body?: string): void {
    writeFileSync(
      join(repo, "gate-d", "run.sh"),
      body ??
        `#!/usr/bin/env bash
set -u
ROOT="$(cd "$(dirname "$0")" && pwd)"; REPO_ROOT="$(cd "$ROOT/.." && pwd)"
. "$ROOT/prompt-identity.sh"
resolve_prompt_variant "$REPO_ROOT" || exit 3
GD_A="$1" GD_T="$2" GD_V="$PROMPT_VARIANT" GD_S="$PROMPT_SHA" python3 -c "import json,os
print(json.dumps({'arm':os.environ['GD_A'],'model':os.environ['MODEL'],'task':os.environ['GD_T'],'corpusRevision':'gate-d-r1','pass':True,'exitClass':'pass','promptVariant':os.environ['GD_V'],'promptSha256':os.environ['GD_S'] or None}))" >>"$GATE_D_OUT"
`,
    );
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "stub runner");
  }

  it("resumes and summarizes baseline (including legacy rows) and variant runs separately", () => {
    const repo = fixtureRepo();
    stubRunner(repo);
    const { bin } = fakeBin();
    const work = tmp("gd-sweep-");
    const out = join(work, "rows.jsonl");
    writeFileSync(
      out,
      [
        { arm: "pi", model: "m", task: TASK, corpusRevision: "gate-d-r1", pass: false, exitClass: "G4-oracle" },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n") + "\n",
    );
    const env = { ARMS: "pi", SEEDS: "1", MODEL: "m", GATE_D_OUT: out };

    const variant = runGateD(repo, bin, { ...env, GATE_D_PI_APPEND_SYSTEM: VARIANT }, [], "sweep.sh");
    expect(variant.res.status, variant.res.stderr).toBe(0);
    const afterVariant = rows(out);
    // The legacy baseline row must not satisfy the variant's seed for the same task.
    expect(afterVariant.filter((r) => r.task === TASK && r.promptVariant === "verify-before-done")).toHaveLength(1);
    expect(variant.res.stdout).toContain(`[run ] pi/m/${TASK}`);

    const baseline = runGateD(repo, bin, { ...env, GATE_D_PI_APPEND_SYSTEM: "" }, [], "sweep.sh");
    expect(baseline.res.status, baseline.res.stderr).toBe(0);
    // The legacy row counts as the baseline seed, so this task is skipped; the others run once.
    expect(baseline.res.stdout).toContain(`[skip] pi/m/${TASK}`);
    const all = rows(out);
    expect(all.filter((r) => r.task === TASK)).toHaveLength(2);
    const summary = baseline.res.stdout.split("\n").filter((l) => l.startsWith("gate-d-r1 pi/m"));
    expect(summary.some((l) => l.includes("[prompt=none]") && l.endsWith("9/10 pass"))).toBe(true);
    expect(summary.some((l) => /\[prompt=verify-before-done@[0-9a-f]{12}\]: 10\/10 pass$/.test(l))).toBe(true);
  });

  it("refuses a variant with non-pi arms before running anything", () => {
    const repo = fixtureRepo();
    stubRunner(repo);
    const { bin } = fakeBin();
    const r = runGateD(repo, bin, { ARMS: "aider pi", MODEL: "m", GATE_D_PI_APPEND_SYSTEM: VARIANT }, [], "sweep.sh");
    expect(r.res.status).toBe(3);
    expect(r.res.stderr).toContain("pi arm only");
    expect(rows(r.out)).toEqual([]);
  });

  it("aborts on a runner failure instead of acting on a stale previous row", () => {
    const repo = fixtureRepo();
    stubRunner(repo, "#!/usr/bin/env bash\necho 'error: refused' >&2\nexit 3\n");
    const { bin } = fakeBin();
    const work = tmp("gd-sweep-");
    const out = join(work, "rows.jsonl");
    writeFileSync(out, JSON.stringify({ arm: "pi", model: "m", task: "x", exitClass: "arm-error" }) + "\n");
    const r = runGateD(repo, bin, { ARMS: "pi", MODEL: "m", GATE_D_OUT: out }, [], "sweep.sh");
    expect(r.res.status).toBe(3);
    expect(r.res.stdout).toContain("SWEEP aborted: run.sh exited 3");
    expect(r.res.stdout).not.toContain("[reset]");
  });
});
