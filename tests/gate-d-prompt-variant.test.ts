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

function git(cwd: string, ...args: string[]): string {
  const res = spawnSync("git", ["-c", "user.email=t@local", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr}`);
  return res.stdout;
}

function fixtureRepo(): string {
  const repo = tmp("gd-fixture-");
  cpSync(join(REAL_ROOT, "gate-d"), join(repo, "gate-d"), { recursive: true });
  mkdirSync(join(repo, "scripts"));
  cpSync(join(REAL_ROOT, "scripts", "pi-benchmark-telemetry.ts"), join(repo, "scripts", "pi-benchmark-telemetry.ts"));
  symlinkSync(join(REAL_ROOT, "node_modules"), join(repo, "node_modules"));
  writeFileSync(join(repo, ".gitignore"), "node_modules\ndata/\n");
  git(repo, "init", "-q");
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
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ name: ${JSON.stringify(name)}, args }) + "\\n");
${script}
`,
    );
    chmodSync(join(bin, name), 0o755);
  }
  return { bin, log };
}

function calls(log: string): Array<{ name: string; args: string[] }> {
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function runGateD(repo: string, bin: string, env: Record<string, string>, args: string[], script = "run.sh") {
  const work = tmp("gd-work-");
  const out = join(work, "rows.jsonl");
  const res = spawnSync("bash", [join(repo, "gate-d", script), ...args], {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      GW_KEY: "test-key",
      GW: "http://127.0.0.1:9/v1",
      TMPDIR: work,
      GATE_D_OUT: out,
      GATE_D_LOG: join(work, "sweep.log"),
      PATH: `${bin}:${process.env.PATH}`,
      ...env,
    },
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

describe("gate-d/run.sh pi prompt variants (INFER-519)", () => {
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

  it("records the digest of exactly the bytes pi received, even if the file is edited mid-run", () => {
    const repo = fixtureRepo();
    const promptPath = join(repo, "gate-d", "prompts", VARIANT);
    const committed = readFileSync(promptPath, "utf8");
    // The fake pi edits the prompt file while it runs; the row must still describe what pi got.
    const { bin, log } = fakeBin(
      `fs.writeFileSync(${JSON.stringify(promptPath)}, "tampered mid-run\\n");`,
    );
    const { res, out } = runGateD(repo, bin, { GATE_D_PI_APPEND_SYSTEM: VARIANT }, ["pi", TASK]);
    expect(res.status, res.stderr).toBe(0);
    const pi = calls(log).find((c) => c.name === "pi")!;
    const i = pi.args.indexOf("--append-system-prompt");
    expect(i).toBeGreaterThan(-1);
    const received = pi.args[i + 1]!;
    expect(received).toBe(committed.replace(/\n+$/, ""));
    const row = rows(out).pop()!;
    expect(row.promptVariant).toBe("verify-before-done");
    expect(row.promptSha256).toBe(sha256(received));

    // A later invocation sees the edited working tree and fails closed instead of using it.
    const again = runGateD(repo, bin, { GATE_D_PI_APPEND_SYSTEM: VARIANT }, ["pi", TASK]);
    expect(again.res.status).toBe(3);
    expect(again.res.stderr).toContain("differs from HEAD");
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

describe("gate-d/sweep.sh prompt variants (INFER-519)", () => {
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
