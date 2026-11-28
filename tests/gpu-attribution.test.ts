import { describe, expect, it } from "vitest";
import {
  attributeGpuMemory,
  DEFAULT_GPU_UNATTRIBUTED_BASELINE_BYTES,
  parseGpuModelGttMinBytes,
  parseGpuUnattributedBaselineBytes,
  type ResidencyEntry,
} from "../src/homeserver/gpu-attribution.js";

const GIB = 1024 ** 3;
const peak = new Map([["mellum", 12 * GIB], ["gemma4", 24 * GIB], ["big", 94 * GIB], ["peak-only", 10 * GIB]]);
const gttMin = new Map([["mellum", 8 * GIB], ["gemma4", 18 * GIB], ["big", 68 * GIB]]);
const est = { peakBytesByModel: peak, gttMinBytesByModel: gttMin };

function ready(...models: string[]): ResidencyEntry[] {
  return models.map((model) => ({ model, state: "ready" }));
}

function attribute(gttUsedBytes: number | null, before: ResidencyEntry[] | null, after: ResidencyEntry[] | null = before) {
  return attributeGpuMemory({ gttUsedBytes, residentBefore: before, residentAfter: after, ...est });
}

describe("attributeGpuMemory (INFER-355)", () => {
  it("flags GPU memory in use while nothing is resident", () => {
    expect(attribute(19 * GIB, [])).toMatchObject({
      status: "nothing_resident",
      unattributedGpuBytes: 19 * GIB,
      unattributedGpuBytesMin: 19 * GIB,
      inUseWhileNothingResident: true,
      exceedsBaseline: true,
      baselineBytes: DEFAULT_GPU_UNATTRIBUTED_BASELINE_BYTES,
    });
  });

  it("does not flag the idle driver baseline", () => {
    const result = attribute(Math.round(1.6 * GIB), []);
    expect(result.inUseWhileNothingResident).toBe(false);
    expect(result.exceedsBaseline).toBe(false);
  });

  it("brackets unattributed memory between declared peaks and GTT lower bounds", () => {
    // mellum + gemma4 resident (~29 GiB GTT) plus an 18 GiB out-of-band tenant.
    expect(attribute(47 * GIB, ready("mellum", "gemma4", "mellum"))).toMatchObject({
      status: "attributed",
      residentGttMinBytes: 26 * GIB,
      residentPeakBytes: 36 * GIB,
      unattributedGpuBytes: 21 * GIB,
      unattributedGpuBytesMin: 11 * GIB,
      inUseWhileNothingResident: false,
      exceedsBaseline: true,
      mayExceedBaseline: true,
    });
  });

  it("does not call a large resident model's admission margin an incident", () => {
    const result = attribute(71 * GIB, ready("big"));
    expect(result.unattributedGpuBytesMin).toBe(0);
    expect(result.unattributedGpuBytes).toBe(3 * GIB);
    expect(result.exceedsBaseline).toBe(false);
    expect(result.mayExceedBaseline).toBe(false);
  });

  it("gives no credit for a model without a GTT lower bound, keeping the upper bound valid", () => {
    expect(attribute(9 * GIB, ready("peak-only"))).toMatchObject({
      status: "attributed",
      residentGttMinBytes: 0,
      unattributedGpuBytes: 9 * GIB,
      unattributedGpuBytesMin: 0,
    });
  });

  it("clamps at zero when estimates exceed the counter", () => {
    const result = attribute(7 * GIB, ready("mellum"));
    expect(result.unattributedGpuBytesMin).toBe(0);
    expect(result.unattributedGpuBytes).toBe(0);
    expect(result.exceedsBaseline).toBe(false);
  });

  it("is unknown, never guessed, when a resident model has no declared peak", () => {
    const result = attribute(40 * GIB, ready("mellum", "secret-model-name"));
    expect(result).toMatchObject({
      status: "unknown",
      reason: "estimate_missing",
      unattributedGpuBytes: null,
      residentWithoutEstimate: 1,
      exceedsBaseline: null,
    });
    expect(JSON.stringify(result)).not.toContain("secret-model-name");
  });

  it("is unknown while a model is starting or stopping", () => {
    expect(attribute(30 * GIB, [{ model: "mellum", state: "starting" }])).toMatchObject({
      status: "unknown", reason: "residency_transition", unattributedGpuBytes: null,
    });
    expect(attribute(30 * GIB, [...ready("gemma4"), { model: "mellum", state: "stopping" }])).toMatchObject({
      status: "unknown", reason: "residency_transition",
    });
  });

  it("is unknown when residency changed around the counter read", () => {
    expect(attribute(30 * GIB, ready("gemma4"), [])).toMatchObject({ status: "unknown", reason: "residency_transition" });
    expect(attribute(30 * GIB, [], ready("gemma4"))).toMatchObject({ status: "unknown", reason: "residency_transition" });
    // Order and duplicates do not count as a change.
    expect(attribute(30 * GIB, ready("gemma4", "mellum"), ready("mellum", "gemma4", "mellum")).status).toBe("attributed");
  });

  it("is unknown without GTT counters or a residency snapshot", () => {
    expect(attribute(null, [])).toMatchObject({ status: "unknown", reason: "gtt_unavailable", unattributedGpuBytes: null });
    expect(attribute(4 * GIB, null)).toMatchObject({ status: "unknown", reason: "residency_unknown" });
    expect(attribute(4 * GIB, [], null)).toMatchObject({ status: "unknown", reason: "residency_unknown" });
  });

  it("honours an operator baseline and rejects invalid values", () => {
    expect(parseGpuUnattributedBaselineBytes("2")).toBe(2 * GIB);
    expect(parseGpuUnattributedBaselineBytes("0")).toBe(0);
    expect(parseGpuUnattributedBaselineBytes(undefined)).toBe(DEFAULT_GPU_UNATTRIBUTED_BASELINE_BYTES);
    expect(parseGpuUnattributedBaselineBytes("-1")).toBe(DEFAULT_GPU_UNATTRIBUTED_BASELINE_BYTES);
    expect(parseGpuUnattributedBaselineBytes("lots")).toBe(DEFAULT_GPU_UNATTRIBUTED_BASELINE_BYTES);
    const result = attributeGpuMemory({ gttUsedBytes: 3 * GIB, residentBefore: [], residentAfter: [], ...est, baselineBytes: 2 * GIB });
    expect(result.exceedsBaseline).toBe(true);
  });

  it("parses GTT lower bounds and drops invalid or duplicated entries", () => {
    const { gttMin: parsed, invalid } = parseGpuModelGttMinBytes("mellum=8, gemma4=18.5 ,bad=x,neg=-1,dup=1,dup=2,=3");
    expect([...parsed.entries()]).toEqual([["mellum", 8 * GIB], ["gemma4", Math.round(18.5 * GIB)]]);
    expect(invalid).toEqual(expect.arrayContaining(["bad", "neg", "dup", "(unnamed)"]));
    expect(parseGpuModelGttMinBytes(undefined).gttMin.size).toBe(0);
  });
});
