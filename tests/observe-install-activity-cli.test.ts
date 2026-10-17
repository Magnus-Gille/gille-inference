import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
const exec = promisify(execFile);
async function run(args: string[]) {
  try {
    const result = await exec(process.execPath, ["--import", "tsx", "scripts/observe-install-activity.ts", ...args]);
    return { ...result, code: 0 };
  } catch (error) { return error as { stdout: string; stderr: string; code: number }; }
}
describe("read-only activity diagnostic CLI", () => {
  it("has help and rejects invalid input without echoing it", async () => {
    expect((await run(["--help"])).stdout).toContain("Read-only");
    const result = await run(["--lease-dir", "PRIVATE", "--backend", "a=http://secret@127.0.0.1:8081/metrics"]);
    expect(result.code).toBe(2);
    expect(result.stderr).not.toMatch(/PRIVATE|secret/);
    // Node may append runtime/loader deprecation warnings after the diagnostic line.
    expect(JSON.parse(result.stderr.split("\n")[0]!).reason).toBe("invalid-input-or-observation-failed");
  });
  it("reports known mutex absence with unknown backend coverage and no mutations", async () => {
    const dir = await mkdtemp(join(tmpdir(), "activity-cli-"));
    try {
      const result = await run(["--lease-dir", dir]);
      expect(result.code).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({ source: "install-activity-diagnostic-v1",
        lease: { state: "absent", held: false }, backend: { coverage: "unknown", targets: [] } });
      expect(await readdir(dir)).toEqual([]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

const base = ["--lease-dir", "/unread-test-placeholder", "--backend", "a=http://127.0.0.1:8081/metrics"];
describe("activity CLI mapping validation", () => {
  it.each([
    ["--expect-host", "a".repeat(64)],
    ["--runtime", "a=42", "--runtime", "a=43"],
    ["--runtime", "other=42"],
    ["--runtime", "a=42", "--expect-runtime", `other=${"a".repeat(64)}`],
    ["--runtime", "a=0"],
    ["--runtime", "a=42", "--backend", "b=http://127.0.0.1:8082/metrics"],
  ])("rejects incomplete or ambiguous mappings: %j", async (...args) => {
    const result = await run([...base, ...args]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr.split("\n")[0]!)).toEqual({ source: "install-activity-diagnostic-v1", reason: "invalid-input-or-observation-failed" });
    expect(result.stderr).not.toContain("/unread-test-placeholder");
  });
});
