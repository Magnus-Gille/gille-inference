import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, chmodSync, copyFileSync, readFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureServedProcess,
  type ServedArtifactStat,
  type ServedProvenanceCollectorDeps,
} from "../src/homeserver/served-provenance-collector.js";

const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function procStat(startTime: string): string {
  const fields: string[] = Array.from({ length: 20 }, (_, index) => index === 0 ? "S" : "0");
  fields[19] = startTime;
  return `42 (llama-server) ${fields.join(" ")}`;
}

function digest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function fixture(overrides: Partial<ServedProvenanceCollectorDeps> = {}) {
  const root = mkdtempSync(join(tmpdir(), "served-provenance-"));
  fixtureRoots.push(root);
  const viewIdentity: ServedArtifactStat = {
    dev: "1", ino: "2", mode: "040755", size: 0, mtimeNs: "1", ctimeNs: "1",
  };
  mkdirSync(join(root, "models"));
  writeFileSync(join(root, "models", "model.gguf"), "model bytes");
  writeFileSync(join(root, "llama-server"), "runtime bytes");
  const deps: ServedProvenanceCollectorDeps = {
    now: () => "2026-09-07T10:00:00.000Z",
    readProcStat: () => procStat("123"),
    readProcCmdline: () => [
      "llama-server", "--model", "/models/model.gguf", "--ctx-size", "4096", "--parallel=4",
      "--temp=0.2", "--top-p", "0.9", "--top-k=40", "--min-p", "0.05", "--n-predict", "512",
      "--api-key", "secret-value",
    ],
    readProcExe: () => join(root, "llama-server"),
    readProcRoot: () => root,
    readProcCwd: () => root,
    readProcMountNamespace: () => "mnt:[1]",
    readSelfMountNamespace: () => "mnt:[1]",
    readProcRootIdentity: () => viewIdentity,
    readSelfRootIdentity: () => viewIdentity,
    readKernelRelease: () => "6.12-test",
    getArch: () => "arm64",
    getCpuCount: () => 12,
    getMemoryBytes: () => 64 * 1024 ** 3,
    ...overrides,
  };
  return { root, deps };
}

describe("captureServedProcess", () => {
  it("captures allowlisted process flags and hashes without retaining argv, paths, or pid", () => {
    const { root, deps } = fixture();
    const result = captureServedProcess(42, deps);

    expect(result.freshness).toBe("fresh");
    expect(result.reasons).toEqual([]);
    expect(result.weights).toEqual([{ sha256: digest(join(root, "models", "model.gguf")), binding: "unproven" }]);
    expect(result.projector).toEqual({ kind: "unknown" });
    expect(result.runtimeSha256).toBe(digest(join(root, "llama-server")));
    expect(result.launchFlags).toEqual({
      contextSize: 4096,
      parallelism: 4,
      temperature: 0.2,
      topP: 0.9,
      topK: 40,
      minP: 0.05,
      predictLimit: 512,
    });
    expect(result.environment).toEqual({ osRelease: "6.12-test", arch: "arm64", cpuCount: 12, memoryBytes: 64 * 1024 ** 3 });
    expect(JSON.stringify(result)).not.toContain("secret-value");
    expect(JSON.stringify(result)).not.toContain(root);
    expect(result).not.toHaveProperty("pid");
    expect(result).not.toHaveProperty("argv");
  });

  it("does not treat model values or unrelated value text as unsupported flags", () => {
    const { root, deps } = fixture({
      readProcCmdline: () => [
        "llama-server", "--model", "/models/my-lora-model.gguf", "--alias", "coder-draft",
      ],
    });
    writeFileSync(join(root, "models", "my-lora-model.gguf"), "model bytes");
    const result = captureServedProcess(42, deps);

    expect(result.freshness).toBe("fresh");
    expect(result.reasons).not.toContain("unsupported-model-loader-feature");
    expect(result.weights).toEqual([{ sha256: digest(join(root, "models", "my-lora-model.gguf")), binding: "unproven" }]);
  });

  it("keeps explicit draft, LoRA, and adapter flags unsupported", () => {
    const { deps } = fixture({
      readProcCmdline: () => [
        "llama-server", "--model", "/models/model.gguf", "--draft-model", "/models/draft.gguf",
        "--lora", "/models/adapter.gguf", "--adapter", "/models/adapter-2.gguf",
      ],
    });
    const result = captureServedProcess(42, deps);

    expect(result.freshness).toBe("unavailable");
    expect(result.reasons).toContain("unsupported-model-loader-feature");
  });

  it("shows a same-path byte change across stable captures", () => {
    const { root, deps } = fixture();
    const before = captureServedProcess(42, deps);
    writeFileSync(join(root, "models", "model.gguf"), "changed model bytes");
    const after = captureServedProcess(42, deps);

    expect(before.freshness).toBe("fresh");
    expect(after.freshness).toBe("fresh");
    expect(after.weights[0]?.sha256).not.toBe(before.weights[0]?.sha256);
  });

  it("marks a same-path replacement during hashing stale and never claims stable bytes", () => {
    const { root, deps } = fixture();
    let replaced = false;
    const modelPath = join(root, "models", "model.gguf");
    const originalHash = deps.hashArtifact;
    const result = captureServedProcess(42, {
      ...deps,
      hashArtifact: (path) => {
        if (!replaced && path === modelPath) {
          replaced = true;
          writeFileSync(path, "replacement with a different size");
        }
        return originalHash ? originalHash(path) : "";
      },
    });

    expect(result.freshness).toBe("stale");
    expect(result.reasons).toContain("artifact-changed");
    expect(result.weights[0]).toEqual({ sha256: null, binding: "stale" });
  });

  it("marks an inode replacement during hashing stale", () => {
    const { root, deps } = fixture();
    const modelPath = join(root, "models", "model.gguf");
    const replacementPath = join(root, "models", "replacement.gguf");
    writeFileSync(replacementPath, "other bytes");
    let swapped = false;
    const result = captureServedProcess(42, {
      ...deps,
      hashArtifact: (path) => {
        if (!swapped && path === modelPath) {
          swapped = true;
          renameSync(replacementPath, path);
        }
        return digest(path);
      },
    });

    expect(result.freshness).toBe("stale");
    expect(result.reasons).toContain("artifact-changed");
    expect(result.weights[0]).toEqual({ sha256: null, binding: "stale" });
  });

  it("marks a process restart race stale even when all hashes succeed", () => {
    const { deps } = fixture();
    let reads = 0;
    const result = captureServedProcess(42, {
      ...deps,
      readProcStat: () => procStat(reads++ === 0 ? "123" : "124"),
    });

    expect(result.freshness).toBe("stale");
    expect(result.reasons).toContain("process-identity-changed");
    expect(result.weights[0]?.binding).toBe("unproven");
  });

  it("fails closed for remote, repeated, split, and auxiliary model inputs", () => {
    const { deps } = fixture({
      readProcCmdline: () => [
        "llama-server", "--model=https://example.invalid/model.gguf", "--model", "/models/other.gguf",
        "--lora", "/models/adapter.gguf", "--mmproj", "/models/projector.gguf", "--mmproj", "/models/other.gguf",
      ],
    });
    const result = captureServedProcess(42, deps);

    expect(result.freshness).toBe("unavailable");
    expect(result.reasons).toEqual(expect.arrayContaining([
      "artifact-remote", "model-flag-ambiguous", "projector-flag-ambiguous", "unsupported-model-loader-feature",
    ]));
    expect(result.projector).toEqual({ kind: "unknown" });
  });

  it("returns fixed reasons for an unavailable pid without exposing filesystem errors", () => {
    const { deps } = fixture({
      readProcStat: () => { throw new Error("ENOENT /proc/42/stat secret path"); },
    });
    const result = captureServedProcess(42, deps);

    expect(result.freshness).toBe("unavailable");
    expect(result.reasons).toEqual(["process-unavailable"]);
    expect(JSON.stringify(result)).not.toContain("ENOENT");
    expect(JSON.stringify(result)).not.toContain("secret path");
  });

  it("rejects a non-llama-server executable before parsing command-line content", () => {
    const { deps } = fixture({ readProcExe: () => "/usr/bin/other-server" });
    const result = captureServedProcess(42, deps);

    expect(result.freshness).toBe("unavailable");
    expect(result.reasons).toEqual(["process-not-llama-server"]);
    expect(result.weights).toEqual([]);
  });

  it("hashes all enumerated GGUF shards and treats an incomplete set as unavailable", () => {
    const complete = fixture({
      readProcCmdline: () => ["llama-server", "--model", "/models/model-00001-of-00002.gguf"],
    });
    writeFileSync(join(complete.root, "models", "model-00001-of-00002.gguf"), "shard one");
    writeFileSync(join(complete.root, "models", "model-00002-of-00002.gguf"), "shard two");
    const result = captureServedProcess(42, complete.deps);
    expect(result.freshness).toBe("fresh");
    expect(result.weights).toHaveLength(2);

    const incomplete = fixture({
      readProcCmdline: () => ["llama-server", "--model", "/models/model-00001-of-00002.gguf"],
    });
    writeFileSync(join(incomplete.root, "models", "model-00001-of-00002.gguf"), "shard one");
    const unavailable = captureServedProcess(42, incomplete.deps);
    expect(unavailable.freshness).toBe("unavailable");
    expect(unavailable.reasons).toContain("artifact-shards-unavailable");
  });

  it("keeps negative predict limits and duplicate launch values unknown", () => {
    const { deps } = fixture({
      readProcCmdline: () => [
        "llama-server", "--model", "/models/model.gguf", "--n-predict", "-1", "--ctx-size", "4096",
        "--ctx-size", "8192", "--draft-n", "5",
      ],
    });
    const result = captureServedProcess(42, deps);

    expect(result.launchFlags.predictLimit).toBe(-1);
    expect(result.launchFlags.contextSize).toBeNull();
    expect(result.reasons).toEqual(expect.arrayContaining([
      "launch-flag-ambiguous", "unsupported-model-loader-feature",
    ]));
    expect(result.freshness).toBe("unavailable");
  });

  it("fails closed when an artifact flag has no usable value", () => {
    const { deps } = fixture({
      readProcCmdline: () => ["llama-server", "--model", "--ctx-size", "4096"],
    });
    const result = captureServedProcess(42, deps);

    expect(result.freshness).toBe("unavailable");
    expect(result.reasons).toContain("artifact-path-unavailable");
    expect(result.weights).toEqual([{ sha256: null, binding: "unproven" }]);
  });

  it("rejects relative traversal and mount-view mismatches", () => {
    const traversal = fixture({
      readProcCmdline: () => ["llama-server", "--model", "../outside.gguf"],
    });
    const traversalResult = captureServedProcess(42, traversal.deps);
    expect(traversalResult.freshness).toBe("unavailable");
    expect(traversalResult.reasons).toContain("artifact-path-unavailable");

    const mismatch = fixture({ readProcMountNamespace: () => "mnt:[different]" });
    const mismatchResult = captureServedProcess(42, mismatch.deps);
    expect(mismatchResult.freshness).toBe("unavailable");
    expect(mismatchResult.reasons).toContain("process-view-unavailable");
    expect(mismatchResult.weights[0]).toEqual({ sha256: null, binding: "unproven" });
  });

  it("marks a mount-view change during hashing stale", () => {
    const { deps } = fixture();
    let namespaceReads = 0;
    const result = captureServedProcess(42, {
      ...deps,
      readProcMountNamespace: () => namespaceReads++ === 0 ? "mnt:[1]" : "mnt:[changed]",
    });

    expect(result.freshness).toBe("stale");
    expect(result.reasons).toContain("process-view-changed");
  });

  it.skipIf(process.platform !== "linux")("captures a real Linux /proc process without proving served-byte binding", async () => {
    const root = mkdtempSync(join(tmpdir(), "served-provenance-linux-"));
    fixtureRoots.push(root);
    const runtimePath = join(root, "llama-server");
    const modelPath = join(root, "model.gguf");
    copyFileSync("/bin/sh", runtimePath);
    chmodSync(runtimePath, 0o755);
    writeFileSync(modelPath, "real proc integration model bytes");

    const child = spawn(runtimePath, ["-s", "--", "--model", modelPath], {
      cwd: root,
      stdio: ["pipe", "ignore", "ignore"],
    });
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      const pid = child.pid;
      expect(pid).toBeTypeOf("number");
      if (pid === undefined) throw new Error("child did not expose a pid");

      const result = captureServedProcess(pid);

      expect(result.freshness).toBe("fresh");
      expect(result.reasons).toEqual([]);
      expect(result.weights).toEqual([{ sha256: digest(modelPath), binding: "unproven" }]);
      expect(result.runtimeSha256).toBe(digest(runtimePath));
      expect(result.projector).toEqual({ kind: "unknown" });
      expect(result).not.toHaveProperty("pid");
      expect(JSON.stringify(result)).not.toContain(root);
      expect(JSON.stringify(result)).not.toContain(modelPath);
      expect(JSON.stringify(result)).not.toContain(runtimePath);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            child.kill("SIGKILL");
          }, 1_000);
          child.once("close", () => {
            clearTimeout(timer);
            resolve();
          });
          child.kill("SIGTERM");
        });
      }
      child.stdin?.destroy();
    }
  });
});
