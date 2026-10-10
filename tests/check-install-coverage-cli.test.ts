import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const exec = promisify(execFile);
const script = resolve("scripts/check-install-coverage.ts");
const run = (args: string[]) => exec(process.execPath, ["--import", "tsx", script, ...args], {
  cwd: resolve("."),
  env: { PATH: "/usr/bin:/bin", FORCE_COLOR: "0", NODE_NO_WARNINGS: "1" },
});

async function withFiles<T>(fn: (directory: string, paths: string[]) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "install-coverage-cli-"));
  const paths = ["INVENTORY.json", "BINDING.json", "EVIDENCE.json"].map(name => join(directory, name));
  try {
    return await fn(directory, paths);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

type FixtureMode = "idle" | "busy";

async function writeValid(paths: string[], mode: FixtureMode = "idle"): Promise<void> {
  const hostBootIdSha256 = "a".repeat(64);
  const boundaryIdentitySha256 = "b".repeat(64);
  const inventory = {
    schemaVersion: 1,
    hostBootIdSha256,
    backends: [{ id: "r", kind: "runtime", ingressIds: ["d", "l"] }],
    ingresses: [
      { id: "d", kind: "direct", backendIds: ["r"] },
      { id: "l", kind: "lifecycle", backendIds: ["r"] },
    ],
  };
  const inventorySha256 = createHash("sha256")
    .update(`install-backend-inventory-v1\n${JSON.stringify(inventory)}`, "utf8")
    .digest("hex");
  const observedAt = new Date(Date.now()).toISOString();
  const expiresAt = new Date(Date.now() + 30_000).toISOString();
  const binding = {
    schemaVersion: 1,
    inventorySha256,
    boundaryIdentitySha256,
    expiresAt,
    maxObservationAgeMs: 60_000,
  };
  const receipt = {
    source: "host-inventory-v1",
    state: "observed",
    observedAt,
    hostBootIdSha256,
    inventorySha256,
    boundaryIdentitySha256,
    scope: "all-host-inference",
    backendIds: ["r"],
    ingressIds: ["d", "l"],
    unclassifiedBackendCount: 0,
    unclassifiedIngressCount: 0,
  };
  const identity = "c".repeat(64);
  const activity = mode === "busy" ? 1 : 0;
  const evidence = {
    schemaVersion: 1,
    inventoryBefore: receipt,
    backends: [{ id: "r", source: "backend-work-v1", state: "observed", observedAt,
      hostBootIdSha256, inventorySha256, identityBeforeSha256: identity, identityAfterSha256: identity,
      active: activity, queued: 0, loading: 0 }],
    ingresses: [
      { id: "d", source: "ingress-work-v1", state: "observed", observedAt, hostBootIdSha256,
        inventorySha256, identityBeforeSha256: identity, identityAfterSha256: identity,
        active: 0, queued: 0, loading: 0 },
      { id: "l", source: "ingress-work-v1", state: "observed", observedAt, hostBootIdSha256,
        inventorySha256, identityBeforeSha256: identity, identityAfterSha256: identity,
        active: 0, queued: 0, loading: 0 },
    ],
    inventoryAfter: receipt,
  };
  await Promise.all([
    writeFile(paths[0]!, JSON.stringify(inventory), "utf8"),
    writeFile(paths[1]!, JSON.stringify(binding), "utf8"),
    writeFile(paths[2]!, JSON.stringify(evidence), "utf8"),
  ]);
}

describe("check-install-coverage CLI", () => {
  it("describes offline validation and never live installation admission", async () => {
    const result = await run(["--help"]);
    expect(result.stdout).toMatch(/offline evidence validation only/i);
    expect(result.stdout).toMatch(/never live installation admission/i);
    expect(result.stderr).toBe("");
  });

  it("rejects invalid argument counts without echoing arguments", async () => {
    const result = await run(["PRIVATE-PATH", "PRIVATE-CONTENT"])
      .then(() => { throw new Error("expected failure"); })
      .catch(error => error as { code: number; stdout: string; stderr: string });
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toMatch(/PRIVATE-PATH|PRIVATE-CONTENT/);
  });

  it("reports malformed JSON with exit 2 and sanitized JSON only", async () => {
    await withFiles(async (_directory, paths) => {
      await writeFile(paths[0]!, "{ private-content: not-json", "utf8");
      await Promise.all(paths.slice(1).map(path => writeFile(path, "{}", "utf8")));
      try {
        await run(paths);
        throw new Error("expected failure");
      } catch (error) {
        const result = error as { code: number; stdout: string; stderr: string };
        expect(result.code).toBe(2);
        expect(result.stdout).toBe("");
        expect(result.stderr).not.toMatch(/private-content|not-json|install-coverage-cli-/);
        expect(JSON.parse(result.stderr)).toEqual({
          source: "install-coverage-check-v1",
          coverage: "unknown",
          activity: "unknown",
          observedAt: null,
          inventorySha256: null,
          reasons: [{ code: "input-read-failed" }],
        });
      }
    });
  });

  it("rejects an input larger than 1 MiB without echoing its path or content", async () => {
    await withFiles(async (_directory, paths) => {
      await writeFile(paths[0]!, `{"padding":"${"x".repeat(1024 * 1024)}"}`, "utf8");
      await Promise.all(paths.slice(1).map(path => writeFile(path, "{}", "utf8")));
      try {
        await run(paths);
        throw new Error("expected failure");
      } catch (error) {
        const result = error as { code: number; stdout: string; stderr: string };
        expect(result.code).toBe(2);
        expect(result.stdout).toBe("");
        expect(result.stderr).not.toMatch(/padding|install-coverage-cli-/);
        expect(JSON.parse(result.stderr)).toMatchObject({ reasons: [{ code: "input-read-failed" }] });
      }
    });
  });

  it("rejects a non-regular input without echoing its path", async () => {
    await withFiles(async (directory, paths) => {
      await writeValid(paths);
      try {
        await run([directory, paths[1]!, paths[2]!]);
        throw new Error("expected failure");
      } catch (error) {
        const result = error as { code: number; stdout: string; stderr: string };
        expect(result.code).toBe(2);
        expect(result.stdout).toBe("");
        expect(result.stderr).not.toContain(directory);
        expect(JSON.parse(result.stderr)).toMatchObject({ reasons: [{ code: "input-read-failed" }] });
      }
    });
  });

  it("does not echo evaluator failures, input content, or paths", async () => {
    await withFiles(async (_directory, paths) => {
      await Promise.all(paths.map(path => writeFile(path, JSON.stringify({
        privatePath: "/private/should-not-escape",
        privateContent: "SECRET_CONTENT_SHOULD_NOT_ESCAPE",
      }), "utf8")));
      const result = await run(paths).catch(error => error as { code: number; stdout: string; stderr: string });
      const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
      expect(output).not.toMatch(/PRIVATE_CONTENT|\/private\/should-not-escape|install-coverage-cli-/i);
    });
  });

  it("returns exit 1 for invalid schemas", async () => {
    await withFiles(async (_directory, paths) => {
      await Promise.all(paths.map(path => writeFile(path, "null", "utf8")));
      const result = await run(paths).catch(error => error as { code: number; stdout: string; stderr: string });
      expect(result.code).toBe(1);
      expect(result.stderr).toBe("");
      const report = JSON.parse(result.stdout);
      expect(report).toMatchObject({ source: "install-coverage-check-v1", coverage: "unknown", activity: "unknown" });
      expect(report.reasons).toEqual(expect.any(Array));
    });
  });

  it("returns exit 0 for a complete idle report", async () => {
    await withFiles(async (_directory, paths) => {
      await writeValid(paths);
      const result = await run(paths);
      const report = JSON.parse(result.stdout);
      expect(report).toMatchObject({ source: "install-coverage-check-v1", coverage: "complete", activity: "idle" });
      expect(result.stderr).toBe("");
    });
  });

  it("returns exit 1 for a complete busy report", async () => {
    await withFiles(async (_directory, paths) => {
      await writeValid(paths, "busy");
      const result = await run(paths).catch(error => error as { code: number; stdout: string; stderr: string });
      expect(result.code).toBe(1);
      const report = JSON.parse(result.stdout);
      expect(report).toMatchObject({ source: "install-coverage-check-v1", coverage: "complete", activity: "busy" });
      expect(result.stderr).toBe("");
    });
  });
});
