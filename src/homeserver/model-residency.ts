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

/** Separately supplied, content-blind facts keyed by the sanitized model name. */
export interface ModelResidencyFacts {
  readonly lastUseAtMsByModel: Readonly<Record<string, NumericFact>>;
  /** The current lifecycle's load/ready timestamp; older request-log rows cannot retain a model. */
  readonly lifecycleStartAtMsByModel: Readonly<Record<string, NumericFact>>;
  readonly activeCountByModel: Readonly<Record<string, NumericFact>>;
  /** An explicit backend expiry observation; absence never means expired. */
  readonly expiresAtMsByModel?: Readonly<Record<string, NumericFact>>;
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

  let classification: ModelResidencyClassification = "unknown";
  if (activeCount !== null && activeCount > 0) {
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
  };
}

/** Diagnose every currently running sanitized entry without retaining any input state. */
export function diagnoseModelResidency(observation: ModelResidencyObservation): ModelResidencyDiagnostic[] {
  return observation.running.map((entry) => classifyModelResidency(entry, observation.facts, observation.nowMs));
}
