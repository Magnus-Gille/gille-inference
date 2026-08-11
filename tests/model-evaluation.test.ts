import { describe, expect, it } from "vitest";
import type { ProbeRunSummary } from "../src/homeserver/scout-types.js";
import {
  assertMaintenanceEngaged,
  buildRegistryEntry,
  decideVerdict,
  manualCandidateForArtifact,
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

  it("fails closed when protected evaluation lacks confirmed maintenance", () => {
    expect(() => assertMaintenanceEngaged(true, true)).not.toThrow();
    expect(() => assertMaintenanceEngaged(false, false)).not.toThrow();
    expect(() => assertMaintenanceEngaged(false, true)).toThrow(/EVAL_MODEL_REQUIRE_MAINTENANCE=1/);
  });
});
