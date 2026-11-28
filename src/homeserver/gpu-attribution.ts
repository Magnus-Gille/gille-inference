/**
 * GPU memory held outside the model service (INFER-355).
 *
 * The DRM GTT counters are device-wide: they include every model llama-swap has resident, the
 * desktop/driver baseline, and any out-of-band GPU tenant (the 2026-10-01 OOM had one). This
 * module subtracts what the gateway can attribute to resident models and reports the rest.
 *
 * Attribution uses the operator-declared RECLAIM estimate (INFER-352), which is a conservative
 * LOWER bound on what a resident model holds. Subtracting a lower bound makes
 * `unattributedGpuBytes` an UPPER bound on memory held outside the model service: it can raise a
 * false alarm, never hide a tenant behind an over-generous estimate. A resident model with no
 * declared reclaim estimate makes attribution `unknown` rather than guessed.
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
  /** Sum of declared reclaim lower bounds for resident models; null when unknown. */
  residentEstimateBytes: number | null;
  /** Resident models with no declared reclaim estimate (count only, never names). */
  residentWithoutEstimate: number | null;
  baselineBytes: number;
  /** GTT above the baseline while llama-swap reports no resident model. */
  inUseWhileNothingResident: boolean | null;
  /** Unattributed bytes above the baseline: an out-of-band tenant is likely. */
  exceedsBaseline: boolean | null;
  estimateBasis: "declared_reclaim_lower_bound";
  bound: "upper";
}

export interface GpuAttributionInput {
  gttUsedBytes: number | null;
  /** Resident model ids, or null when the residency snapshot is unavailable. */
  residentModels: readonly string[] | null;
  reclaimBytesByModel: ReadonlyMap<string, number>;
  baselineBytes?: number;
}

function unknown(reason: GpuAttributionReason, baselineBytes: number, residentWithoutEstimate: number | null = null): GpuAttribution {
  return {
    status: "unknown",
    reason,
    unattributedGpuBytes: null,
    residentEstimateBytes: null,
    residentWithoutEstimate,
    baselineBytes,
    inUseWhileNothingResident: null,
    exceedsBaseline: null,
    estimateBasis: "declared_reclaim_lower_bound",
    bound: "upper",
  };
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
      residentEstimateBytes: 0,
      residentWithoutEstimate: 0,
      baselineBytes,
      inUseWhileNothingResident: used > baselineBytes,
      exceedsBaseline: used > baselineBytes,
      estimateBasis: "declared_reclaim_lower_bound",
      bound: "upper",
    };
  }
  let estimate = 0;
  let missing = 0;
  for (const model of resident) {
    const bytes = input.reclaimBytesByModel.get(model);
    if (bytes === undefined || !Number.isSafeInteger(bytes) || bytes <= 0) missing += 1;
    else estimate += bytes;
  }
  if (missing > 0) return unknown("estimate_missing", baselineBytes, missing);
  const unattributed = Math.max(0, used - estimate);
  return {
    status: "attributed",
    reason: null,
    unattributedGpuBytes: unattributed,
    residentEstimateBytes: estimate,
    residentWithoutEstimate: 0,
    baselineBytes,
    inUseWhileNothingResident: false,
    exceedsBaseline: unattributed > baselineBytes,
    estimateBasis: "declared_reclaim_lower_bound",
    bound: "upper",
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
