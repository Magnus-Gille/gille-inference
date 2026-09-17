import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { describe, expect, it, beforeAll, afterAll } from "vitest";

import { HALOGEN_PILOT_PROFILE, halogenProfileHash } from "../src/homeserver/halogen-profile.js";

type JsonObject = Record<string, any>;
type ChildResult = { status: number | null; stdout: string; stderr: string };

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(repoRoot, "scripts", "run-halogen-compatibility.ts");
const profileSha256 = halogenProfileHash(HALOGEN_PILOT_PROFILE);
const runnerCommit = "b".repeat(40);
const esbuild = join(repoRoot, "node_modules", ".bin", "esbuild");
let bundleDir: string;
let bundlePath: string;

async function tempDirectory(prefix: string): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

function plan(): JsonObject {
  return {
    schemaVersion: 1,
    runnerCommit,
    expiresAt: "2099-01-01T00:00:00.000Z",
    profileSha256,
    name: "gille-317-halogen-01",
    runId: "0123456789abcdef0123456789abcdef",
    gatewayBaseUrl: "http://127.0.0.1:8080",
    user: "halogen",
    group: "halogen",
    uid: 1001,
    expectedResidentModels: [],
    protectedUnits: ["home-gateway.service", "llama-swap.service"],
    qualificationSha256: "c".repeat(64),
    prior: {
      pid: 1234,
      startTicks: "5678",
      argv: ["/usr/bin/llama-server", "--model", "/home/halogen/model.gguf"],
      cwd: "/home/halogen",
      executableSha256: "d".repeat(64),
      modelPath: "/home/halogen/model.gguf",
      modelBytes: 123456,
      modelMtimeMs: 1_700_000_000_000,
      restoreName: "gille-317-prior-01",
    },
  };
}

async function writePlan(directory: string, value: unknown = plan(), mode = 0o600): Promise<string> {
  const path = join(directory, "plan.json");
  await writeFile(path, typeof value === "string" ? value : JSON.stringify(value), { mode });
  await chmod(path, mode);
  return path;
}

function run(args: string[], directory: string): ChildResult {
  const result = spawnSync(process.execPath, [bundlePath, ...args], {
    cwd: directory,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

async function unchanged(directory: string, before: string[]): Promise<void> {
  expect(await readdir(directory)).toEqual(before);
}

describe("run-halogen-compatibility CLI", () => {
  beforeAll(async () => {
    bundleDir = await tempDirectory("halogen-cli-bundle-");
    bundlePath = join(bundleDir, "run-halogen-compatibility.mjs");
    execFileSync(esbuild, [
      entry, "--bundle", "--platform=node", "--format=esm", "--outfile=" + bundlePath,
    ], { encoding: "utf8" });
  });

  afterAll(async () => {
    // The temporary bundle is intentionally left for the test runner's normal temp cleanup.
  });

  it("prints help without reading a plan or touching host operations", async () => {
    const directory = await tempDirectory("halogen-cli-help-");
    const before = await readdir(directory);
    const result = run(["--help"], directory);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("run-halogen-compatibility --plan PRIVATE_JSON");
    await unchanged(directory, before);
  });

  it("renders the default private plan with hashes and the complete launch argv", async () => {
    const directory = await tempDirectory("halogen-cli-plan-");
    const planPath = await writePlan(directory);
    const before = await readdir(directory);
    const result = run(["--plan", planPath], directory);

    expect(result.status, result.stderr).toBe(0);
    const rendered = JSON.parse(result.stdout) as JsonObject;
    const expectedPlanSha256 = createHash("sha256").update(await readFile(planPath)).digest("hex");
    expect(rendered).toMatchObject({
      mode: "plan-only",
      planSha256: expectedPlanSha256,
      runnerCommit,
      maintenanceSeconds: 3600,
      candidateSeconds: 1800,
      priorProcess: 1234,
      restoreUnit: "gille-317-prior-01.service",
    });
    expect(rendered.runnerSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(rendered.launch).toMatchObject({
      command: "/usr/bin/sudo",
      unit: "gille-317-halogen-01.service",
      container: "gille-317-halogen-01",
    });
    expect(rendered.launch.args).toEqual(expect.arrayContaining([
      "--unit=gille-317-halogen-01.service",
      "--network=none",
      "--pull=never",
      "--property=RuntimeMaxSec=1800",
      "--property=MemorySwapMax=0",
      "--cap-drop=ALL",
    ]));
    expect(JSON.stringify(rendered.launch)).not.toContain("M5_MAINTENANCE_KEY");
    await unchanged(directory, before);
  });

  it("rejects wrong accepted hashes before any execute work", async () => {
    const directory = await tempDirectory("halogen-cli-hash-");
    const planPath = await writePlan(directory);
    const before = await readdir(directory);
    const result = run([
      "--plan", planPath, "--execute",
      "--accepted-plan-sha256", "0".repeat(64),
      "--accepted-runner-sha256", "1".repeat(64),
    ], directory);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('"pass":false');
    await unchanged(directory, before);
  });

  it("requires the maintenance key only after accepted hashes and before host work", async () => {
    const directory = await tempDirectory("halogen-cli-key-");
    const planPath = await writePlan(directory);
    const rendered = JSON.parse(run(["--plan", planPath], directory).stdout) as JsonObject;
    const before = await readdir(directory);
    const result = run([
      "--plan", planPath, "--execute",
      "--accepted-plan-sha256", rendered.planSha256,
      "--accepted-runner-sha256", rendered.runnerSha256,
    ], directory);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('"pass":false');
    expect(result.stderr).not.toContain("M5_MAINTENANCE_KEY");
    await unchanged(directory, before);
  });

  it.each([
    ["world-readable", async (directory: string) => writePlan(directory, plan(), 0o644)],
    ["symlink", async (directory: string) => {
      const target = await writePlan(directory);
      const linked = join(directory, "linked-plan.json");
      await symlink(target, linked);
      return linked;
    }],
    ["unsafe schema", async (directory: string) => {
      const value = plan();
      value.prior.cwd = "/home/halogen/../unsafe";
      return writePlan(directory, value);
    }],
  ])("refuses %s plan input", async (_label, makePath) => {
    const directory = await tempDirectory("halogen-cli-plan-refusal-");
    const planPath = await makePath(directory);
    const before = await readdir(directory);
    const result = run(["--plan", planPath], directory);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('"pass":false');
    await unchanged(directory, before);
  });

  it("rejects duplicate flags before plan execution", async () => {
    const directory = await tempDirectory("halogen-cli-duplicate-");
    const planPath = await writePlan(directory);
    const before = await readdir(directory);
    const result = run(["--plan", planPath, "--plan", planPath], directory);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('"pass":false');
    await unchanged(directory, before);
  });
});
