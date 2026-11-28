/**
 * GPU memory held outside the model service (INFER-355).
 *
 * The DRM GTT counters are device-wide: they include every model llama-swap has resident, the
 * desktop/driver baseline, and any out-of-band GPU tenant (the 2026-10-01 OOM had one). This
 * module subtracts what the gateway can attribute to resident models and reports the rest.
 *
 * Attribution brackets what resident models hold with the two operator-declared figures from
 * INFER-352 (`HOMESERVER_HOST_MEMORY_MODEL_BUDGETS_GIB`, `modelId=peakGiB[:reclaimGiB]`):
 * - the RECLAIM estimate is a conservative LOWER bound on a resident model's footprint, so GTT
 *   used minus reclaim is an UPPER bound on memory held outside the model service
 *   (`unattributedGpuBytes`); a model with no reclaim entry contributes 0, which keeps it an
 *   upper bound;
 * - the PEAK start budget is an UPPER bound on a resident model's footprint, so GTT used minus
 *   peak is a LOWER bound (`unattributedGpuBytesMin`).
 * `exceedsBaseline` fires only when even the lower bound is above the allowance (memory is
 * certainly held outside the model service); `mayExceedBaseline` fires on the upper bound. The
 * admission margins between peak and reclaim are deliberately wide, so with large models
 * resident only the upper bound may trip, and it must not be read as an incident on its own.
 * A resident model without a declared peak makes attribution `unknown` rather than guessed.
 *
 * Content-blind: numbers, a fixed status/reason vocabulary and booleans only. No process names,
 * command lines, PIDs or paths, so an out-of-band tenant is visible without exposing what it is.
 */

const GIB = 1024 ** 3;

/**
 * Default unattributed allowance (bytes). The 2026-10-03 calibration measured the idle
 * desktop/driver GTT baseline at about 1.5 GiB (peak GTT minus peak drop for the two smallest
 * models); 4 GiB keeps margin above that, stays below the smallest roster model (~5.3 GiB) and
 * far below the 17.7 GiB out-of-band tenant removed on 2026-10-02.
 */
export const DEFAULT_GPU_UNATTRIBUTED_BASELINE_BYTES = 4 * GIB;

export type GpuAttributionStatus = "nothing_resident" | "attributed" | "unknown";
export type GpuAttributionReason = "gtt_unavailable" | "residency_unknown" | "estimate_missing";

export interface GpuAttribution {
  status: GpuAttributionStatus;
  reason: GpuAttributionReason | null;
  /** Upper bound on GTT bytes not attributable to resident models; null when unknown. */
  unattributedGpuBytes: number | null;
  /** Lower bound on the same quantity (GTT used minus declared peaks); null when unknown. */
  unattributedGpuBytesMin: number | null;
  /** Sum of declared reclaim lower bounds for resident models; null when unknown. */
  residentEstimateBytes: number | null;
  /** Sum of declared peak budgets for resident models; null when unknown. */
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
  estimateBasis: "declared_peak_and_reclaim";
}

export interface GpuAttributionInput {
  gttUsedBytes: number | null;
  /** Resident model ids, or null when the residency snapshot is unavailable. */
  residentModels: readonly string[] | null;
  peakBytesByModel: ReadonlyMap<string, number>;
  reclaimBytesByModel: ReadonlyMap<string, number>;
  baselineBytes?: number;
}

function unknown(reason: GpuAttributionReason, baselineBytes: number, residentWithoutEstimate: number | null = null): GpuAttribution {
  return {
    status: "unknown",
    reason,
    unattributedGpuBytes: null,
    unattributedGpuBytesMin: null,
    residentEstimateBytes: null,
    residentPeakBytes: null,
    residentWithoutEstimate,
    baselineBytes,
    inUseWhileNothingResident: null,
    exceedsBaseline: null,
    mayExceedBaseline: null,
    estimateBasis: "declared_peak_and_reclaim",
  };
}

function positiveBytes(value: number | undefined): number | null {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function attributeGpuMemory(input: GpuAttributionInput): GpuAttribution {
  const baselineBytes =
    input.baselineBytes !== undefined && Number.isSafeInteger(input.baselineBytes) && input.baselineBytes >= 0
      ? input.baselineBytes
      : DEFAULT_GPU_UNATTRIBUTED_BASELINE_BYTES;
  const used = input.gttUsedBytes;
  if (used === null || !Number.isSafeInteger(used) || used < 0) return unknown("gtt_unavailable", baselineBytes);
  if (input.residentModels === null) return unknown("residency_unknown", baselineBytes);
  const resident = [...new Set(input.residentModels)];
  if (resident.length === 0) {
    return {
      status: "nothing_resident",
      reason: null,
      unattributedGpuBytes: used,
      unattributedGpuBytesMin: used,
      residentEstimateBytes: 0,
      residentPeakBytes: 0,
      residentWithoutEstimate: 0,
      baselineBytes,
      inUseWhileNothingResident: used > baselineBytes,
      exceedsBaseline: used > baselineBytes,
      mayExceedBaseline: used > baselineBytes,
      estimateBasis: "declared_peak_and_reclaim",
    };
  }
  let reclaimSum = 0;
  let peakSum = 0;
  let missing = 0;
  for (const model of resident) {
    const peak = positiveBytes(input.peakBytesByModel.get(model));
    if (peak === null) {
      missing += 1;
      continue;
    }
    peakSum += peak;
    // A reclaim estimate above the peak is not a lower bound; cap it rather than trust it.
    reclaimSum += Math.min(peak, positiveBytes(input.reclaimBytesByModel.get(model)) ?? 0);
  }
  if (missing > 0) return unknown("estimate_missing", baselineBytes, missing);
  const upper = Math.max(0, used - reclaimSum);
  const lower = Math.max(0, used - peakSum);
  return {
    status: "attributed",
    reason: null,
    unattributedGpuBytes: upper,
    unattributedGpuBytesMin: lower,
    residentEstimateBytes: reclaimSum,
    residentPeakBytes: peakSum,
    residentWithoutEstimate: 0,
    baselineBytes,
    inUseWhileNothingResident: false,
    exceedsBaseline: lower > baselineBytes,
    mayExceedBaseline: upper > baselineBytes,
    estimateBasis: "declared_peak_and_reclaim",
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
