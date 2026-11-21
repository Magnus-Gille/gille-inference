/**
 * Content-blind model-residency diagnostics.
 *
 * This module deliberately has no backend, HTTP, clock, or database dependency. The
 * adapter supplies the already-sanitized running snapshot and the separate fact maps;
 * a later integration can persist those plain values without widening this contract.
 */

export type ModelResidencyClassification = "serving" | "ttl_retained" | "unexpected" | "unknown";

/** The only running-entry fields this diagnostic layer is allowed to inspect or return. */
export interface SanitizedRunningEntry {
  readonly model: string;
  readonly state: string;
  readonly ttlSeconds: number | null;
}

type NumericFact = number | null | undefined;

/**
 * Activity is a separate question from residency (INFER-376). A model can be resident and
 * `ready` while nothing is generating. Each sample states which traffic it covers:
 *  - `all_backend_traffic`: a backend-side observation (for example inference slots) that
 *    includes direct loopback consumers that bypass the gateway.
 *  - `gateway_admitted_only`: gateway admission counters. These see only requests that
 *    entered through the gateway, so a zero here can never prove the backend is idle.
 */
export type ModelActivityCoverage = "all_backend_traffic" | "gateway_admitted_only";
export type ModelActivityState = "active" | "idle" | "unknown";
export type ModelActivityUnknownReason = "not_probed" | "stale" | "future" | "invalid" | "partial_coverage";

export interface ModelActivitySample {
  readonly coverage: ModelActivityCoverage;
  /** Requests or processing slots observed active for this model at observedAtMs. */
  readonly activeCount: number;
  readonly observedAtMs: number;
}

export interface ModelActivity {
  readonly state: ModelActivityState;
  /** Why the state is unknown; null when it is active or idle. */
  readonly reason: ModelActivityUnknownReason | null;
  /** Provenance of the sample the state rests on; null when no sample supports it. */
  readonly coverage: ModelActivityCoverage | null;
  readonly activeCount: number | null;
  readonly observedAtMs: number | null;
}

/** Default freshness bound for an activity sample. Older evidence says nothing about now. */
export const MODEL_ACTIVITY_MAX_AGE_MS = 5_000;

const COVERAGES: ReadonlySet<string> = new Set(["all_backend_traffic", "gateway_admitted_only"]);

function validSample(sample: unknown): sample is ModelActivitySample {
  if (!isRecord(sample)) return false;
  const { coverage, activeCount, observedAtMs } = sample as Record<string, unknown>;
  return typeof coverage === "string" && COVERAGES.has(coverage)
    && typeof activeCount === "number" && Number.isSafeInteger(activeCount) && activeCount >= 0
    && typeof observedAtMs === "number" && Number.isFinite(observedAtMs);
}

const unknownActivity = (reason: ModelActivityUnknownReason): ModelActivity =>
  ({ state: "unknown", reason, coverage: null, activeCount: null, observedAtMs: null });

/**
 * Decide active / idle / unknown from explicit samples. Never infers idleness:
 *  - any fresh sample with positive activity is `active` (positive evidence is sufficient
 *    whatever its coverage);
 *  - `idle` needs a fresh zero from a sample that covers all backend traffic;
 *  - everything else is `unknown` with a reason. A fresh gateway-only zero is
 *    `partial_coverage`, because direct backend consumers are invisible to it.
 */
export function classifyModelActivity(
  samples: readonly ModelActivitySample[] | undefined,
  nowMs: number,
  maxAgeMs: number = MODEL_ACTIVITY_MAX_AGE_MS,
): ModelActivity {
  if (!Number.isFinite(nowMs) || !Number.isFinite(maxAgeMs) || maxAgeMs < 0) return unknownActivity("invalid");
  if (samples === undefined || !Array.isArray(samples) || samples.length === 0) return unknownActivity("not_probed");
  const valid = samples.filter(validSample);
  if (valid.length === 0) return unknownActivity("invalid");
  const fresh = valid.filter((s) => s.observedAtMs <= nowMs && nowMs - s.observedAtMs <= maxAgeMs);
  const newest = (list: ModelActivitySample[]): ModelActivitySample =>
    list.reduce((a, b) => (b.observedAtMs > a.observedAtMs ? b : a));
  const supported = (state: "active" | "idle", s: ModelActivitySample): ModelActivity =>
    ({ state, reason: null, coverage: s.coverage, activeCount: s.activeCount, observedAtMs: s.observedAtMs });
  const positive = fresh.filter((s) => s.activeCount > 0);
  if (positive.length > 0) return supported("active", newest(positive));
  const completeZero = fresh.filter((s) => s.coverage === "all_backend_traffic");
  if (completeZero.length > 0) return supported("idle", newest(completeZero));
  if (fresh.length > 0) return unknownActivity("partial_coverage");
  if (valid.some((s) => s.observedAtMs > nowMs)) return unknownActivity("future");
  return unknownActivity("stale");
}

/** Separately supplied, content-blind facts keyed by the sanitized model name. */
export interface ModelResidencyFacts {
  readonly lastUseAtMsByModel: Readonly<Record<string, NumericFact>>;
  /** The current lifecycle's load/ready timestamp; older request-log rows cannot retain a model. */
  readonly lifecycleStartAtMsByModel: Readonly<Record<string, NumericFact>>;
  readonly activeCountByModel: Readonly<Record<string, NumericFact>>;
  /** An explicit backend expiry observation; absence never means expired. */
  readonly expiresAtMsByModel?: Readonly<Record<string, NumericFact>>;
  /** Activity samples per model; absence means activity was not probed (unknown). */
  readonly activitySamplesByModel?: Readonly<Record<string, readonly ModelActivitySample[] | undefined>>;
}

/** Persistable-friendly input seam for a future store or gateway integration. */
export interface ModelResidencyObservation {
  readonly running: readonly SanitizedRunningEntry[];
  readonly facts: ModelResidencyFacts;
  /** Injected epoch milliseconds; this module never reads the wall clock. */
  readonly nowMs: number;
}

/** Content-blind diagnostic output; no backend command, address, request, or payload data. */
export interface ModelResidencyDiagnostic {
  readonly model: string;
  readonly state: string;
  readonly ttlSeconds: number | null;
  readonly classification: ModelResidencyClassification;
  readonly activeCount: number | null;
  readonly lastUseAtMs: number | null;
  readonly expiresAtMs: number | null;
  /** Active / idle / unknown, separate from residency. `ready` never implies active. */
  readonly activity: ModelActivity;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/**
 * Validate the narrow snapshot boundary and copy only its three safe fields. This
 * rejects widened objects instead of silently retaining an unsafe backend response.
 */
function copySanitizedRunningEntry(entry: SanitizedRunningEntry): SanitizedRunningEntry {
  if (!isRecord(entry)) {
    throw new TypeError("expected a sanitized running entry with only model, state, and ttlSeconds");
  }

  const keys = Object.keys(entry);
  if (
    keys.length !== 3 ||
    !hasOwn(entry, "model") ||
    !hasOwn(entry, "state") ||
    !hasOwn(entry, "ttlSeconds")
  ) {
    throw new TypeError("expected a sanitized running entry with only model, state, and ttlSeconds");
  }

  const model = entry.model;
  const state = entry.state;
  const ttlSeconds = entry.ttlSeconds;
  if (typeof model !== "string" || model.length === 0 || typeof state !== "string" || state.length === 0) {
    throw new TypeError("expected a sanitized running entry with only model, state, and ttlSeconds");
  }
  if (ttlSeconds !== null && typeof ttlSeconds !== "number") {
    throw new TypeError("expected a sanitized running entry with only model, state, and ttlSeconds");
  }

  return {
    model,
    state,
    ttlSeconds: ttlSeconds !== null && Number.isFinite(ttlSeconds) && ttlSeconds >= 0 ? ttlSeconds : null,
  };
}

function mapValue(map: unknown, model: string): number | null {
  if (!isRecord(map) || !hasOwn(map, model)) return null;
  const value = map[model];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonNegativeMapValue(map: unknown, model: string): number | null {
  const value = mapValue(map, model);
  return value !== null && value >= 0 ? value : null;
}

/**
 * Classify one sanitized running entry from explicit, separately supplied facts.
 * Precedence is current positive activity, explicit expiry, then a reliable TTL/last-use
 * observation. Conflicting stale expiry cannot override a positive active-count fact.
 */
export function classifyModelResidency(
  entry: SanitizedRunningEntry,
  facts: ModelResidencyFacts,
  nowMs: number
): ModelResidencyDiagnostic {
  const safeEntry = copySanitizedRunningEntry(entry);
  const activeCount = nonNegativeMapValue(facts?.activeCountByModel, safeEntry.model);
  const lastUseAtMs = mapValue(facts?.lastUseAtMsByModel, safeEntry.model);
  const lifecycleStartAtMs = mapValue(facts?.lifecycleStartAtMsByModel, safeEntry.model);
  const expiresAtMs = mapValue(facts?.expiresAtMsByModel, safeEntry.model);
  const reliableNow = Number.isFinite(nowMs);

  const samples = isRecord(facts?.activitySamplesByModel) && hasOwn(facts.activitySamplesByModel, safeEntry.model)
    ? facts.activitySamplesByModel[safeEntry.model]
    : undefined;
  const activity = classifyModelActivity(samples, nowMs);

  let classification: ModelResidencyClassification = "unknown";
  if ((activeCount !== null && activeCount > 0) || activity.state === "active") {
    classification = "serving";
  } else if (reliableNow && expiresAtMs !== null && nowMs >= expiresAtMs) {
    // Expiry is unexpected only because an explicit expiry fact says it elapsed.
    classification = "unexpected";
  } else if (
    reliableNow &&
    safeEntry.ttlSeconds !== null &&
    lastUseAtMs !== null &&
    lifecycleStartAtMs !== null &&
    lastUseAtMs >= lifecycleStartAtMs &&
    lastUseAtMs <= nowMs &&
    (nowMs - lastUseAtMs) / 1000 <= safeEntry.ttlSeconds
  ) {
    // Inclusive boundary: the model is retained exactly through the supplied TTL.
    classification = "ttl_retained";
  }

  return {
    ...safeEntry,
    classification,
    activeCount,
    lastUseAtMs,
    expiresAtMs,
    activity,
  };
}

/** Diagnose every currently running sanitized entry without retaining any input state. */
export function diagnoseModelResidency(observation: ModelResidencyObservation): ModelResidencyDiagnostic[] {
  return observation.running.map((entry) => classifyModelResidency(entry, observation.facts, observation.nowMs));
}
