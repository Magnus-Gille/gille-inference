import { describe, expect, it } from "vitest";
import type { ProbeRunSummary } from "../src/homeserver/scout-types.js";
import {
  buildRegistryEntry,
  decideVerdict,
  manualCandidateForArtifact,
  runProtectedEvaluation,
} from "../scripts/evaluate-model.js";

const summary = (passRate: number, tokPerSec: number | null): ProbeRunSummary => ({
  model: "manual/model",
  endpoint: "http://127.0.0.1:9099/v1",
  totalRuns: 10,
  pass: Math.round(passRate * 10),
  partial: 0,
  fail: 10 - Math.round(passRate * 10),
  error: 0,
  passRate,
  avgTokPerSec: tokPerSec,
  emptyOutputs: 0,
  truncations: 0,
  finishReasons: { stop: 10 },
  byTaskType: [],
  results: [],
});
describe("manual model evaluation", () => {
  it("keeps the explicit evaluation path bounded to an existing local artifact", () => {
    const candidate = manualCandidateForArtifact({
      modelId: "meta/Muse-Glimmer-30B",
      quant: "KQ_DYNAMIC",
      artifactPath: "/home/magnus/models/muse/muse.gguf",
      modelsDir: "/home/magnus/models",
      sizeBytes: 19_653_957_984,
    });
    expect(candidate).toMatchObject({
      id: "meta/Muse-Glimmer-30B",
      quant: "KQ_DYNAMIC",
      sizeGB: 18.3,
      sharded: false,
    });
  });

  it("rejects an artifact outside the configured model root", () => {
    expect(() => manualCandidateForArtifact({
      modelId: "meta/Muse-Glimmer-30B",
      quant: "KQ_DYNAMIC",
      artifactPath: "/tmp/muse.gguf",
      modelsDir: "/home/magnus/models",
      sizeBytes: 1,
    })).toThrow(/outside configured model root/i);
  });

  it("uses measured thresholds only for a registry verdict", () => {
    expect(decideVerdict(summary(0.8, 30))).toBe("winner");
    expect(decideVerdict(summary(0.6, 30))).toBe("interesting");
    expect(decideVerdict(summary(0.8, 10))).toBe("interesting");
  });

  it("writes evidence as manual-only and never as served", () => {
    const candidate = manualCandidateForArtifact({
      modelId: "meta/Muse-Glimmer-30B",
      quant: "KQ_DYNAMIC",
      artifactPath: "/home/magnus/models/muse/muse.gguf",
      modelsDir: "/home/magnus/models",
      sizeBytes: 19_653_957_984,
    });
    const entry = buildRegistryEntry(candidate, "winner", summary(0.8, 30));
    expect(entry.served).toBe(false);
    expect(entry.notes).toMatch(/no automatic roster mutation/i);
    expect(entry.gateFlags).toContain("manual-evaluation-only");
  });

  it("holds an exclusive token-scoped window through evaluation and registry append", async () => {
    const candidate = manualCandidateForArtifact({
      modelId: "manual/model",
      quant: "Q4_K_M",
      artifactPath: "/home/magnus/models/manual/model.gguf",
      modelsDir: "/home/magnus/models",
      sizeBytes: 1024,
    });
    const events: string[] = [];
    const expectedEntry = buildRegistryEntry(candidate, "winner", summary(0.8, 30));

    const entry = await runProtectedEvaluation(candidate, {
      apiKey: "maintenance-key",
      baseUrl: "http://127.0.0.1:8080",
      ttlSeconds: 120,
      drainTimeoutSeconds: 5,
      evaluate: async () => {
        events.push("evaluate");
        return expectedEntry;
      },
      append: (record) => {
        expect(record).toBe(expectedEntry);
        events.push("append");
      },
      restore: async (runningModels) => {
        expect(runningModels).toEqual([{ model: "qwen36-a3b", state: "ready", ttlSeconds: 120 }]);
        events.push("restore");
      },
      runWindow: async (_plan, deps) => {
        expect(deps.apiKey).toBe("maintenance-key");
        events.push("open");
        const childExitCode = await deps.runChild(
          ["manual-model-evaluation"],
          {
            mode: "exclusive",
            startedAt: "2026-08-22T00:00:00.000Z",
            runningModels: [{ model: "qwen36-a3b", state: "ready", ttlSeconds: 120 }],
          },
        );
        events.push("close");
        return {
          mode: "exclusive",
          startedAt: "2026-08-22T00:00:00.000Z",
          endedAt: "2026-08-22T00:00:01.000Z",
          childExitCode,
          restored: true,
          runningModels: [],
        };
      },
    });

    expect(entry).toBe(expectedEntry);
    expect(events).toEqual(["open", "evaluate", "append", "restore", "close"]);
  });

  it("fails closed before evaluation when no maintenance credential is available", async () => {
    const candidate = manualCandidateForArtifact({
      modelId: "manual/model",
      quant: "Q4_K_M",
      artifactPath: "/home/magnus/models/manual/model.gguf",
      modelsDir: "/home/magnus/models",
      sizeBytes: 1024,
    });
    await expect(runProtectedEvaluation(candidate, {
      apiKey: "",
      baseUrl: "http://127.0.0.1:8080",
      ttlSeconds: 120,
      drainTimeoutSeconds: 5,
      evaluate: async () => { throw new Error("must not run"); },
      append: () => { throw new Error("must not append"); },
    })).rejects.toThrow(/M5_MAINTENANCE_KEY is required/);
  });

  it("restores prior residency before closing the window when evaluation fails", async () => {
    const candidate = manualCandidateForArtifact({
      modelId: "manual/model",
      quant: "Q4_K_M",
      artifactPath: "/home/magnus/models/manual/model.gguf",
      modelsDir: "/home/magnus/models",
      sizeBytes: 1024,
    });
    const events: string[] = [];
    await expect(runProtectedEvaluation(candidate, {
      apiKey: "maintenance-key",
      baseUrl: "http://127.0.0.1:8080",
      ttlSeconds: 120,
      drainTimeoutSeconds: 5,
      evaluate: async () => {
        events.push("evaluate-failed");
        throw new Error("probe failure");
      },
      append: () => { events.push("unexpected-append"); },
      restore: async () => { events.push("restore"); },
      runWindow: async (_plan, deps) => {
        events.push("open");
        try {
          await deps.runChild(
            ["manual-model-evaluation"],
            { mode: "exclusive", startedAt: "now", runningModels: [] },
          );
        } finally {
          events.push("close");
        }
        throw new Error("unreachable");
      },
    })).rejects.toThrow("probe failure");
    expect(events).toEqual(["open", "evaluate-failed", "restore", "close"]);
  });
});
