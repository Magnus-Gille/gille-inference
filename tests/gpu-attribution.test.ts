import { describe, expect, it } from "vitest";
import {
  attributeGpuMemory,
  DEFAULT_GPU_UNATTRIBUTED_BASELINE_BYTES,
  parseGpuUnattributedBaselineBytes,
} from "../src/homeserver/gpu-attribution.js";

const GIB = 1024 ** 3;
const peak = new Map([["mellum", 12 * GIB], ["gemma4", 24 * GIB], ["qwen35-122b-a10b", 94 * GIB], ["peak-only", 10 * GIB]]);
const reclaim = new Map([["mellum", 8 * GIB], ["gemma4", 18 * GIB], ["qwen35-122b-a10b", 65 * GIB]]);
const est = { peakBytesByModel: peak, reclaimBytesByModel: reclaim };

describe("attributeGpuMemory (INFER-355)", () => {
  it("flags GPU memory in use while nothing is resident", () => {
    // 2026-10-01 shape: ~19 GiB in use with no resident model.
    const result = attributeGpuMemory({ gttUsedBytes: 19 * GIB, residentModels: [], ...est });
    expect(result).toMatchObject({
      status: "nothing_resident",
      unattributedGpuBytes: 19 * GIB,
      inUseWhileNothingResident: true,
      exceedsBaseline: true,
      baselineBytes: DEFAULT_GPU_UNATTRIBUTED_BASELINE_BYTES,
    });
  });

  it("does not flag the idle driver baseline", () => {
    const result = attributeGpuMemory({ gttUsedBytes: Math.round(1.6 * GIB), residentModels: [], ...est });
    expect(result.inUseWhileNothingResident).toBe(false);
    expect(result.exceedsBaseline).toBe(false);
  });

  it("brackets unattributed memory between declared peaks and reclaim bounds", () => {
    // mellum + gemma4 resident (~29 GiB) plus an 18 GiB out-of-band tenant.
    const result = attributeGpuMemory({
      gttUsedBytes: 47 * GIB,
      residentModels: ["mellum", "gemma4", "mellum"],
      ...est,
    });
    expect(result).toMatchObject({
      status: "attributed",
      residentEstimateBytes: 26 * GIB,
      residentPeakBytes: 36 * GIB,
      unattributedGpuBytes: 21 * GIB,
      unattributedGpuBytesMin: 11 * GIB,
      inUseWhileNothingResident: false,
      exceedsBaseline: true,
      mayExceedBaseline: true,
    });
  });

  it("does not call a large resident model's admission margin an incident", () => {
    // 2026-10-03: qwen35-122b-a10b held ~73 GiB GTT; reclaim bound 65, peak 94.
    const result = attributeGpuMemory({ gttUsedBytes: 73 * GIB, residentModels: ["qwen35-122b-a10b"], ...est });
    expect(result.unattributedGpuBytes).toBe(8 * GIB);
    expect(result.unattributedGpuBytesMin).toBe(0);
    expect(result.mayExceedBaseline).toBe(true);
    expect(result.exceedsBaseline).toBe(false);
  });

  it("treats a missing reclaim entry as zero credit, keeping the upper bound valid", () => {
    const result = attributeGpuMemory({ gttUsedBytes: 9 * GIB, residentModels: ["peak-only"], ...est });
    expect(result).toMatchObject({ status: "attributed", unattributedGpuBytes: 9 * GIB, unattributedGpuBytesMin: 0 });
  });

  it("clamps at zero when estimates exceed the counter", () => {
    const result = attributeGpuMemory({ gttUsedBytes: 7 * GIB, residentModels: ["mellum"], ...est });
    expect(result.unattributedGpuBytesMin).toBe(0);
    expect(result.unattributedGpuBytes).toBe(0);
    expect(result.exceedsBaseline).toBe(false);
  });

  it("is unknown, never guessed, when a resident model has no declared peak", () => {
    const result = attributeGpuMemory({
      gttUsedBytes: 40 * GIB,
      residentModels: ["mellum", "secret-model-name"],
      ...est,
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
    expect(attributeGpuMemory({ gttUsedBytes: null, residentModels: [], ...est }))
      .toMatchObject({ status: "unknown", reason: "gtt_unavailable", unattributedGpuBytes: null });
    expect(attributeGpuMemory({ gttUsedBytes: 4 * GIB, residentModels: null, ...est }))
      .toMatchObject({ status: "unknown", reason: "residency_unknown", unattributedGpuBytes: null });
  });

  it("honours an operator baseline and rejects invalid values", () => {
    expect(parseGpuUnattributedBaselineBytes("2")).toBe(2 * GIB);
    expect(parseGpuUnattributedBaselineBytes("0")).toBe(0);
    expect(parseGpuUnattributedBaselineBytes(undefined)).toBe(DEFAULT_GPU_UNATTRIBUTED_BASELINE_BYTES);
    expect(parseGpuUnattributedBaselineBytes("-1")).toBe(DEFAULT_GPU_UNATTRIBUTED_BASELINE_BYTES);
    expect(parseGpuUnattributedBaselineBytes("lots")).toBe(DEFAULT_GPU_UNATTRIBUTED_BASELINE_BYTES);
    const result = attributeGpuMemory({ gttUsedBytes: 3 * GIB, residentModels: [], ...est, baselineBytes: 2 * GIB });
    expect(result.exceedsBaseline).toBe(true);
  });
});
