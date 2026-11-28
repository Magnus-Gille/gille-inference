import { describe, expect, it } from "vitest";
import {
  attributeGpuMemory,
  DEFAULT_GPU_UNATTRIBUTED_BASELINE_BYTES,
  parseGpuUnattributedBaselineBytes,
} from "../src/homeserver/gpu-attribution.js";

const GIB = 1024 ** 3;
const reclaim = new Map([["mellum", 9 * GIB], ["gemma4", 20 * GIB]]);

describe("attributeGpuMemory (INFER-355)", () => {
  it("flags GPU memory in use while nothing is resident", () => {
    // 2026-10-01 shape: ~19 GiB in use with no resident model.
    const result = attributeGpuMemory({ gttUsedBytes: 19 * GIB, residentModels: [], reclaimBytesByModel: reclaim });
    expect(result).toMatchObject({
      status: "nothing_resident",
      unattributedGpuBytes: 19 * GIB,
      inUseWhileNothingResident: true,
      exceedsBaseline: true,
      baselineBytes: DEFAULT_GPU_UNATTRIBUTED_BASELINE_BYTES,
    });
  });

  it("does not flag the idle driver baseline", () => {
    const result = attributeGpuMemory({ gttUsedBytes: Math.round(1.6 * GIB), residentModels: [], reclaimBytesByModel: reclaim });
    expect(result.inUseWhileNothingResident).toBe(false);
    expect(result.exceedsBaseline).toBe(false);
  });

  it("subtracts declared reclaim lower bounds for resident models", () => {
    const result = attributeGpuMemory({
      gttUsedBytes: 48 * GIB,
      residentModels: ["mellum", "gemma4", "mellum"],
      reclaimBytesByModel: reclaim,
    });
    expect(result).toMatchObject({
      status: "attributed",
      residentEstimateBytes: 29 * GIB,
      unattributedGpuBytes: 19 * GIB,
      inUseWhileNothingResident: false,
      exceedsBaseline: true,
      bound: "upper",
    });
  });

  it("clamps at zero when estimates exceed the counter", () => {
    const result = attributeGpuMemory({ gttUsedBytes: 8 * GIB, residentModels: ["mellum"], reclaimBytesByModel: reclaim });
    expect(result.unattributedGpuBytes).toBe(0);
    expect(result.exceedsBaseline).toBe(false);
  });

  it("is unknown, never guessed, when a resident model has no declared estimate", () => {
    const result = attributeGpuMemory({
      gttUsedBytes: 40 * GIB,
      residentModels: ["mellum", "secret-model-name"],
      reclaimBytesByModel: reclaim,
    });
    expect(result).toMatchObject({
      status: "unknown",
      reason: "estimate_missing",
      unattributedGpuBytes: null,
      residentWithoutEstimate: 1,
      exceedsBaseline: null,
    });
    expect(JSON.stringify(result)).not.toContain("secret-model-name");
  });

  it("is unknown without GTT counters or a residency snapshot", () => {
    expect(attributeGpuMemory({ gttUsedBytes: null, residentModels: [], reclaimBytesByModel: reclaim }))
      .toMatchObject({ status: "unknown", reason: "gtt_unavailable", unattributedGpuBytes: null });
    expect(attributeGpuMemory({ gttUsedBytes: 4 * GIB, residentModels: null, reclaimBytesByModel: reclaim }))
      .toMatchObject({ status: "unknown", reason: "residency_unknown", unattributedGpuBytes: null });
  });

  it("honours an operator baseline and rejects invalid values", () => {
    expect(parseGpuUnattributedBaselineBytes("2")).toBe(2 * GIB);
    expect(parseGpuUnattributedBaselineBytes("0")).toBe(0);
    expect(parseGpuUnattributedBaselineBytes(undefined)).toBe(DEFAULT_GPU_UNATTRIBUTED_BASELINE_BYTES);
    expect(parseGpuUnattributedBaselineBytes("-1")).toBe(DEFAULT_GPU_UNATTRIBUTED_BASELINE_BYTES);
    expect(parseGpuUnattributedBaselineBytes("lots")).toBe(DEFAULT_GPU_UNATTRIBUTED_BASELINE_BYTES);
    const result = attributeGpuMemory({ gttUsedBytes: 3 * GIB, residentModels: [], reclaimBytesByModel: reclaim, baselineBytes: 2 * GIB });
    expect(result.exceedsBaseline).toBe(true);
  });
});
