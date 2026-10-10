import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SCRIPT = resolve(REPO_ROOT, "scripts/observe-host-inventory.ts");

function runCli(args: readonly string[]) {
  const result = spawnSync(process.execPath, ["--import", "tsx", SCRIPT, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 10_000,
    env: { PATH: "/usr/bin:/bin", NODE_NO_WARNINGS: "1", FORCE_COLOR: "0" },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function parseReport(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout) as Record<string, unknown>;
}

describe("observe-host-inventory CLI", () => {
  it("prints help without probing the host", () => {
    const result = runCli(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("visible Linux procfs only");
    expect(result.stdout).toContain("does not provide complete host coverage");
    expect(result.stdout).toContain("installation admission");
    expect(result.stderr).toBe("");
  });

  it.each([
    ["unknown flag", ["--nope"]],
    ["missing timeout", ["--timeout-ms"]],
    ["zero timeout", ["--timeout-ms", "0"]],
    ["timeout above maximum", ["--timeout-ms", "30001"]],
    ["fractional timeout", ["--timeout-ms", "1.5"]],
    ["positional argument", ["extra"]],
  ])("returns a sanitized closed report for %s", (_name, args) => {
    const result = runCli(args);
    expect(result.status).toBe(2);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain(args.join(" "));
    expect(parseReport(result.stdout)).toEqual({
      source: "linux-host-inventory-v1",
      observation: "unknown",
      coverage: "unknown",
      reason: "invalid-input-or-observation-failed",
    });
  });

  it.each([
    ["duplicate timeout", ["--timeout-ms", "1", "--timeout-ms", "1"]],
    ["duplicate help", ["--help", "--help"]],
  ])("rejects %s without leaking input", (_name, args) => {
    const result = runCli(args);
    expect(result.status).toBe(2);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain(args.join(" "));
    expect(parseReport(result.stdout).reason).toBe("invalid-input-or-observation-failed");
  });

  it("reports unsupported platform only when the valid invocation can run on a non-Linux host", () => {
    if (process.platform === "linux") return;
    const result = runCli(["--timeout-ms", "1"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("");
    const report = parseReport(result.stdout);
    expect(report.source).toBe("linux-host-inventory-v1");
    expect(report.observation).toBe("unknown");
    expect(report.coverage).toBe("unknown");
  });
});
