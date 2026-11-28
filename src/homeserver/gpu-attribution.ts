/**
 * GPU memory held outside the model service (INFER-355).
 *
 * The DRM GTT counters are device-wide: they include every model llama-swap has resident, the
 * desktop/driver baseline, and any out-of-band GPU tenant. This module brackets what the gateway
 * can attribute to resident models and reports the rest.
 *
 * - Lower bound (`unattributedGpuBytesMin`): GTT used minus the declared PEAK start budget of each
 *   resident model (`HOMESERVER_HOST_MEMORY_MODEL_BUDGETS_GIB`). A peak is a whole-host upper
 *   bound on a model's footprint, so it is also an upper bound on its GTT share.
 * - Upper bound (`unattributedGpuBytes`): GTT used minus a GTT-specific LOWER bound per resident
 *   model (`HOMESERVER_GPU_MODEL_GTT_MIN_GIB`). A model without one contributes 0, which keeps the
 *   bound valid. The admission reclaim estimate is deliberately NOT used here: it bounds whole-host
 *   memory released on eviction, not GTT held, so subtracting it could hide a tenant.
 *
 * `exceedsBaseline` uses the lower bound (memory is certainly held outside the model service);
 * `mayExceedBaseline` uses the upper bound (possible, not proven). Attribution is `unknown`, never
 * guessed, when GTT or residency is unavailable, a resident model has no declared peak, a model is
 * in a transitional state, or residency changed while the counter was read.
 *
 * Content-blind: numbers, a fixed status/reason vocabulary and booleans only. No model names,
 * process names, command lines, PIDs or paths.
 */

const GIB = 1024 ** 3;

/**
 * Default unattributed allowance (bytes): above the idle desktop/driver GTT baseline seen in
 * calibration (well under 2 GiB) and below the smallest roster model's footprint.
 */
export const DEFAULT_GPU_UNATTRIBUTED_BASELINE_BYTES = 4 * GIB;

export type GpuAttributionStatus = "nothing_resident" | "attributed" | "unknown";
export type GpuAttributionReason =
  | "gtt_unavailable"
  | "residency_unknown"
  | "residency_transition"
  | "estimate_missing";

export interface GpuAttribution {
  status: GpuAttributionStatus;
  reason: GpuAttributionReason | null;
  /** Upper bound on GTT bytes not attributable to resident models; null when unknown. */
  unattributedGpuBytes: number | null;
  /** Lower bound on the same quantity; null when unknown. */
  unattributedGpuBytesMin: number | null;
  /** Sum of declared GTT lower bounds for resident models (0 for a model without one). */
  residentGttMinBytes: number | null;
  /** Sum of declared peak budgets for resident models. */
  residentPeakBytes: number | null;
  /** Resident models with no declared peak budget (count only, never names). */
  residentWithoutEstimate: number | null;
  baselineBytes: number;
  /** GTT above the baseline while llama-swap reports no resident model. */
  inUseWhileNothingResident: boolean | null;
  /** Even the lower bound is above the baseline: memory is certainly held outside the model service. */
  exceedsBaseline: boolean | null;
  /** The upper bound is above the baseline: an out-of-band tenant is possible, not proven. */
  mayExceedBaseline: boolean | null;
  estimateBasis: "declared_peak_and_gtt_min";
}

export interface ResidencyEntry {
  model: string;
  state: string;
}

export interface GpuAttributionInput {
  gttUsedBytes: number | null;
  /** Residency observed before the counter read, or null when unavailable. */
  residentBefore: readonly ResidencyEntry[] | null;
  /** Residency observed after the counter read, or null when unavailable. */
  residentAfter: readonly ResidencyEntry[] | null;
  peakBytesByModel: ReadonlyMap<string, number>;
  gttMinBytesByModel: ReadonlyMap<string, number>;
  baselineBytes?: number;
}

function unknown(reason: GpuAttributionReason, baselineBytes: number, residentWithoutEstimate: number | null = null): GpuAttribution {
  return {
    status: "unknown",
    reason,
    unattributedGpuBytes: null,
    unattributedGpuBytesMin: null,
    residentGttMinBytes: null,
    residentPeakBytes: null,
    residentWithoutEstimate,
    baselineBytes,
    inUseWhileNothingResident: null,
    exceedsBaseline: null,
    mayExceedBaseline: null,
    estimateBasis: "declared_peak_and_gtt_min",
  };
}

function positiveBytes(value: number | undefined): number | null {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** Sorted unique model ids, or null when any entry is not a settled `ready` resident. */
function settledReady(entries: readonly ResidencyEntry[]): string[] | null {
  const models = new Set<string>();
  for (const entry of entries) {
    if (entry.state !== "ready") return null;
    models.add(entry.model);
  }
  return [...models].sort();
}

export function attributeGpuMemory(input: GpuAttributionInput): GpuAttribution {
  const baselineBytes =
    input.baselineBytes !== undefined && Number.isSafeInteger(input.baselineBytes) && input.baselineBytes >= 0
      ? input.baselineBytes
      : DEFAULT_GPU_UNATTRIBUTED_BASELINE_BYTES;
  const used = input.gttUsedBytes;
  if (used === null || !Number.isSafeInteger(used) || used < 0) return unknown("gtt_unavailable", baselineBytes);
  if (input.residentBefore === null || input.residentAfter === null) return unknown("residency_unknown", baselineBytes);
  const before = settledReady(input.residentBefore);
  const after = settledReady(input.residentAfter);
  // A starting model has not reached its footprint and a stopping one may already have released
  // it; either makes a subtraction meaningless. So does residency changing around the read.
  if (before === null || after === null || before.join("\n") !== after.join("\n")) {
    return unknown("residency_transition", baselineBytes);
  }
  if (before.length === 0) {
    return {
      status: "nothing_resident",
      reason: null,
      unattributedGpuBytes: used,
      unattributedGpuBytesMin: used,
      residentGttMinBytes: 0,
      residentPeakBytes: 0,
      residentWithoutEstimate: 0,
      baselineBytes,
      inUseWhileNothingResident: used > baselineBytes,
      exceedsBaseline: used > baselineBytes,
      mayExceedBaseline: used > baselineBytes,
      estimateBasis: "declared_peak_and_gtt_min",
    };
  }
  let gttMinSum = 0;
  let peakSum = 0;
  let missing = 0;
  for (const model of before) {
    const peak = positiveBytes(input.peakBytesByModel.get(model));
    if (peak === null) {
      missing += 1;
      continue;
    }
    peakSum += peak;
    // A GTT lower bound above the peak cannot be a lower bound; cap it rather than trust it.
    gttMinSum += Math.min(peak, positiveBytes(input.gttMinBytesByModel.get(model)) ?? 0);
  }
  if (missing > 0) return unknown("estimate_missing", baselineBytes, missing);
  const upper = Math.max(0, used - gttMinSum);
  const lower = Math.max(0, used - peakSum);
  return {
    status: "attributed",
    reason: null,
    unattributedGpuBytes: upper,
    unattributedGpuBytesMin: lower,
    residentGttMinBytes: gttMinSum,
    residentPeakBytes: peakSum,
    residentWithoutEstimate: 0,
    baselineBytes,
    inUseWhileNothingResident: false,
    exceedsBaseline: lower > baselineBytes,
    mayExceedBaseline: upper > baselineBytes,
    estimateBasis: "declared_peak_and_gtt_min",
  };
}

/** Parse the operator allowance in GiB; invalid or negative values fall back to the default. */
export function parseGpuUnattributedBaselineBytes(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_GPU_UNATTRIBUTED_BASELINE_BYTES;
  const gib = Number(raw);
  if (!Number.isFinite(gib) || gib < 0) return DEFAULT_GPU_UNATTRIBUTED_BASELINE_BYTES;
  const bytes = Math.round(gib * GIB);
  return Number.isSafeInteger(bytes) ? bytes : DEFAULT_GPU_UNATTRIBUTED_BASELINE_BYTES;
}

/**
 * Parse `modelId=gttMinGiB,...`: a conservative lower bound on the GTT a settled resident model
 * holds. Invalid entries and every entry of a duplicated id are dropped (never guessed); their
 * names are returned so startup can report them once.
 */
export function parseGpuModelGttMinBytes(raw: string | undefined): { gttMin: Map<string, number>; invalid: string[] } {
  const gttMin = new Map<string, number>();
  const invalid: string[] = [];
  const seen = new Set<string>();
  if (raw === undefined || raw.trim() === "") return { gttMin, invalid };
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (trimmed === "") continue;
    const eq = trimmed.lastIndexOf("=");
    const name = eq > 0 ? trimmed.slice(0, eq).trim() : "";
    if (name === "") {
      invalid.push("(unnamed)");
      continue;
    }
    if (seen.has(name)) {
      gttMin.delete(name);
      invalid.push(name);
      continue;
    }
    seen.add(name);
    const text = trimmed.slice(eq + 1).trim();
    const bytes = text === "" ? NaN : Math.round(Number(text) * GIB);
    if (!Number.isSafeInteger(bytes) || bytes <= 0) {
      invalid.push(name);
      continue;
    }
    gttMin.set(name, bytes);
  }
  return { gttMin, invalid };
}
