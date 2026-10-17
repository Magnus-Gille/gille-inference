import { describe, expect, it, vi } from "vitest";

import {
  runStrixSpeculationPolicySynthesis,
  writeArtifactPair,
} from "../scripts/synthesize-strix-speculation-policy.js";

const provenance = {
  schemaVersion: 1,
  modelArtifactSha256: "a".repeat(64), runtimeCommit: "b".repeat(40),
  runtimeBinarySha256: "c".repeat(64), serverArgsSha256: "d".repeat(64),
  serverArgsInvariantSha256: "9".repeat(64),
  backend: "vulkan", quant: "Q4_K_M", kernel: "6.14", mesaVersion: "25.2", rocmVersion: null,
  contextSize: 65536, kvTypeK: "q8_0", kvTypeV: "q8_0", flashAttention: "on",
  batch: 2048, ubatch: 512, parallelism: 1, speculation: "none", draftDepth: null,
  cacheRamMiB: 8192, contextCheckpoints: 32, checkpointMinStep: 8192, cacheIdleSlots: "on",
};
const summary = {
  fixtureId: "code", taskType: "code", concurrency: 1, batches: 3, requests: 3,
  successfulRequests: 3, oraclePasses: 3, successRate: 1, oraclePassRate: 1,
  p50TtftMs: 100, p95TtftMs: 100, p50TotalMs: 1_000, p95TotalMs: 1_000,
  aggregateTokensPerSecond: 80, usefulCompletionsPerMinute: 60,
  promptTokensPerSecond: 1_000, predictedTokensPerSecond: 80, cacheHitRate: 0, acceptanceRate: null,
};

describe("runStrixSpeculationPolicySynthesis", () => {
  it("writes content-blind machine and human policy artifacts", () => {
    const direct = JSON.stringify({
      schemaVersion: 1, model: "qwen", fixtureSha256: "e".repeat(64), provenance,
      batches: Array.from({ length: 3 }, (_, repetition) => ({
        fixtureId: "code", taskType: "code", concurrency: 1, repetition, wallMs: 1_000,
        speculation: null, requests: [{ ok: true, oraclePass: true, outputSha256: "a".repeat(64) }],
      })),
      summaries: [summary],
    });
    const candidate = JSON.stringify({
      schemaVersion: 1,
      model: "qwen",
      fixtureSha256: "e".repeat(64),
      provenance: { ...provenance, speculation: "draft-mtp", draftDepth: 2, serverArgsSha256: "f".repeat(64) },
      batches: Array.from({ length: 3 }, (_, repetition) => ({
        fixtureId: "code", taskType: "code", concurrency: 1, repetition, wallMs: 800,
        speculation: { draftTokens: 100, acceptedTokens: 70, verificationSteps: 10, acceptanceRate: 0.7 },
        requests: [{ ok: true, oraclePass: true, outputSha256: "a".repeat(64) }],
      })),
      summaries: [{ ...summary, aggregateTokensPerSecond: 100, predictedTokensPerSecond: 100, usefulCompletionsPerMinute: 75, acceptanceRate: 0.7 }],
    });
    const writePair = vi.fn();
    const stdout = vi.fn();
    const exit = runStrixSpeculationPolicySynthesis([
      "--direct", "direct.json", "--candidate", "mtp2.json", "--min-batches", "3", "--out", "/tmp/policy",
    ], {
      readFile: (path) => path === "direct.json" ? direct : candidate,
      writePair,
      canonicalPath: (path) => path,
      stdout,
      stderr: vi.fn(),
    });

    expect(exit).toBe(0);
    expect(writePair).toHaveBeenCalledTimes(1);
    expect(writePair.mock.calls[0]![1]).toContain('"selection": "speculative"');
    expect(writePair.mock.calls[0]![3]).toContain("offline policy");
    expect(writePair.mock.calls[0]!.join("\n")).not.toContain("a".repeat(64));
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('"speculativeCells":1'));
  });

  it("refuses to overwrite input evidence through an output alias", () => {
    const stderr = vi.fn();
    const exit = runStrixSpeculationPolicySynthesis([
      "--direct", "/evidence/direct.json", "--candidate", "/evidence/mtp.json", "--out", "/alias/direct",
    ], {
      readFile: vi.fn(),
      writePair: vi.fn(),
      canonicalPath: (path) => path.replace("/alias/", "/evidence/"),
      stdout: vi.fn(),
      stderr,
    });

    expect(exit).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringMatching(/overwrite.*input evidence/i));
  });

  it("restores the prior JSON/Markdown pair when the second publication fails", () => {
    const files = new Map<string, string>([["/out/policy.json", "old-json"], ["/out/policy.md", "old-md"]]);
    let failJsonPublish = true;
    const ops = {
      exists: (path: string) => files.has(path),
      read: (path: string) => {
        const value = files.get(path);
        if (value === undefined) throw new Error(`missing file: ${path}`);
        return value;
      },
      mkdir: vi.fn(),
      writeExclusive: (path: string, content: string) => {
        if (files.has(path)) throw new Error("exists");
        files.set(path, content);
      },
      rename: (from: string, to: string) => {
        if (failJsonPublish && from.includes("policy.json") && from.endsWith(".tmp") && to === "/out/policy.json") {
          failJsonPublish = false;
          throw new Error("simulated second publication failure");
        }
        const value = files.get(from);
        if (value === undefined) throw new Error(`missing source: ${from}`);
        files.delete(from);
        files.set(to, value);
      },
      unlink: (path: string) => {
        if (!files.delete(path)) throw new Error(`missing file: ${path}`);
      },
    };

    expect(() => writeArtifactPair(
      "/out/policy.json", "new-json", "/out/policy.md", "new-md", ops
    )).toThrow(/simulated second publication failure/i);
    expect(files.get("/out/policy.json")).toBe("old-json");
    expect(files.get("/out/policy.md")).toBe("old-md");
    expect([...files.keys()].filter((path) => path.endsWith(".tmp") || path.endsWith(".bak"))).toEqual([]);

    files.clear();
    files.set("/out/policy.json", "old-json");
    files.set("/out/policy.md", "old-md");
    failJsonPublish = true;
    const successfulRename = ops.rename;
    ops.rename = (from: string, to: string) => {
      if (from.endsWith(".bak") && from.includes("policy.json") && to === "/out/policy.json") {
        throw new Error("simulated rollback failure");
      }
      successfulRename(from, to);
    };
    expect(() => writeArtifactPair(
      "/out/policy.json", "new-json", "/out/policy.md", "new-md", ops
    )).toThrow(/rollback was incomplete/i);
  });
});
