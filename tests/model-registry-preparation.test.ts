import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = join(__dirname, "..", "scripts", "prepare-model-evaluation-registry.sh");
const EVALUATOR = join(__dirname, "..", "scripts", "evaluate-model.ts");
const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "model-registry-prepare-"));
  roots.push(value);
  return value;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function prepare(liveRoot: string): void {
  const user = userInfo();
  execFileSync("bash", [SCRIPT, "--root", liveRoot, "--uid", String(user.uid), "--gid", String(user.gid)]);
}

describe("model-evaluation registry preparation (#263)", () => {
  it("creates the exact fresh target with private owner modes", () => {
    const liveRoot = root();
    prepare(liveRoot);
    const data = join(liveRoot, "data");
    const registry = join(data, "model-scout-registry.jsonl");
    expect(readFileSync(registry, "utf8")).toBe("");
    expect(statSync(data).mode & 0o777).toBe(0o700);
    expect(statSync(registry).mode & 0o777).toBe(0o600);
    expect(statSync(registry).uid).toBe(userInfo().uid);
    expect(statSync(registry).gid).toBe(userInfo().gid);
  });

  it("repairs the target without truncating history or recursively changing siblings", () => {
    const liveRoot = root();
    const data = join(liveRoot, "data");
    const registry = join(data, "model-scout-registry.jsonl");
    const unrelated = join(data, "unrelated.db");
    mkdirSync(data, { mode: 0o755 });
    writeFileSync(registry, "historical-row\n", { mode: 0o644 });
    writeFileSync(unrelated, "untouched\n", { mode: 0o640 });
    chmodSync(registry, 0o644);
    chmodSync(unrelated, 0o640);

    prepare(liveRoot);

    expect(readFileSync(registry, "utf8")).toBe("historical-row\n");
    expect(statSync(data).mode & 0o777).toBe(0o700);
    expect(statSync(registry).mode & 0o777).toBe(0o600);
    expect(statSync(unrelated).mode & 0o777).toBe(0o640);
  });

  it("verifies appendability under the effective runtime uid without changing registry bytes", () => {
    const liveRoot = root();
    prepare(liveRoot);
    const registry = join(liveRoot, "data", "model-scout-registry.jsonl");
    writeFileSync(registry, "historical-row\n");
    const before = readFileSync(registry);
    const output = execFileSync(process.execPath, ["--import", "tsx", EVALUATOR, "--registry-verify-only"], {
      env: { ...process.env, EVAL_MODEL_REGISTRY: registry },
      encoding: "utf8",
    });
    expect(JSON.parse(output)).toEqual({
      registry,
      appendable: true,
      runtimeUid: userInfo().uid,
    });
    expect(readFileSync(registry)).toEqual(before);
  });

  it("refuses a symlink at the durable registry target", () => {
    const liveRoot = root();
    const data = join(liveRoot, "data");
    mkdirSync(data);
    const outside = join(liveRoot, "outside");
    writeFileSync(outside, "do not touch\n");
    execFileSync("ln", ["-s", outside, join(data, "model-scout-registry.jsonl")]);
    expect(() => prepare(liveRoot)).toThrow();
    expect(readFileSync(outside, "utf8")).toBe("do not touch\n");
  });

  it("keeps privileged operations no-follow and limits mode changes to the unprivileged identity", () => {
    const source = readFileSync(SCRIPT, "utf8");
    expect(source).toContain('sudo chown -h "$uid:$gid"');
    expect(source).not.toMatch(/sudo\s+(chmod|install)/);
    const deploy = readFileSync(join(__dirname, "..", "scripts", "deploy-gateway.sh"), "utf8");
    expect(deploy).not.toMatch(/sudo[^\n]*prepare-model-evaluation-registry\.sh/);
  });
});
