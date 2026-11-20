import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = process.cwd();
const RUN = join(ROOT, "gate-d", "run.sh");

function run(env: Record<string, string>, args: string[]) {
  const tmp = mkdtempSync(join(tmpdir(), "gd-variant-"));
  const out = join(tmp, "rows.jsonl");
  const res = spawnSync("bash", [RUN, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, GW_KEY: "test-key", TMPDIR: tmp, GATE_D_OUT: out, ...env },
    timeout: 120_000,
  });
  return { res, tmp, out };
}

describe("Gate D pi system-prompt variant (INFER-519)", () => {
  it.each([
    ["../secret.md", "bare file name"],
    [".hidden.md", "bare file name"],
    ["missing-variant.md", "no such prompt variant"],
  ])("rejects %s before any task runs", (value, message) => {
    const { res, tmp, out } = run({ GATE_D_PI_APPEND_SYSTEM: value }, ["pi", "01-make-failing-test-pass"]);
    try {
      expect(res.status).toBe(3);
      expect(res.stderr).toContain(message);
      expect(existsSync(out)).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("refuses the variant on non-pi arms", () => {
    const { res, tmp } = run({ GATE_D_PI_APPEND_SYSTEM: "verify-before-done.md" }, ["aider", "01-make-failing-test-pass"]);
    try {
      expect(res.status).toBe(3);
      expect(res.stderr).toContain("pi arm only");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("passes the committed prompt to pi and records its name and digest on the row", () => {
    const bin = mkdtempSync(join(tmpdir(), "gd-fake-pi-"));
    const argsLog = join(bin, "args.json");
    const fakePi = join(bin, "pi");
    writeFileSync(
      fakePi,
      `#!/usr/bin/env node\nrequire("fs").writeFileSync(${JSON.stringify(argsLog)}, JSON.stringify(process.argv.slice(2)));\n`,
    );
    chmodSync(fakePi, 0o755);
    const { res, tmp, out } = run(
      { GATE_D_PI_APPEND_SYSTEM: "verify-before-done.md", PATH: `${bin}:${process.env.PATH}` },
      ["pi", "01-make-failing-test-pass"],
    );
    try {
      expect(res.status, res.stderr).toBe(0);
      const args = JSON.parse(readFileSync(argsLog, "utf8")) as string[];
      const i = args.indexOf("--append-system-prompt");
      expect(i).toBeGreaterThan(-1);
      expect(args[i + 1]).toBe(join(ROOT, "gate-d", "prompts", "verify-before-done.md"));
      const row = JSON.parse(readFileSync(out, "utf8").trim().split("\n").pop()!) as Record<string, unknown>;
      expect(row.promptVariant).toBe("verify-before-done");
      expect(row.promptSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(row.pass).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it("leaves baseline rows labelled promptVariant none without the flag", () => {
    const bin = mkdtempSync(join(tmpdir(), "gd-fake-pi-"));
    const argsLog = join(bin, "args.json");
    const fakePi = join(bin, "pi");
    writeFileSync(
      fakePi,
      `#!/usr/bin/env node\nrequire("fs").writeFileSync(${JSON.stringify(argsLog)}, JSON.stringify(process.argv.slice(2)));\n`,
    );
    chmodSync(fakePi, 0o755);
    const { res, tmp, out } = run({ GATE_D_PI_APPEND_SYSTEM: "", PATH: `${bin}:${process.env.PATH}` }, [
      "pi",
      "01-make-failing-test-pass",
    ]);
    try {
      expect(res.status, res.stderr).toBe(0);
      const args = JSON.parse(readFileSync(argsLog, "utf8")) as string[];
      expect(args).not.toContain("--append-system-prompt");
      const row = JSON.parse(readFileSync(out, "utf8").trim().split("\n").pop()!) as Record<string, unknown>;
      expect(row.promptVariant).toBe("none");
      expect(row.promptSha256).toBeNull();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
      rmSync(bin, { recursive: true, force: true });
    }
  });
});
