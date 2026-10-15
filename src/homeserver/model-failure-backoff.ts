/** Backend failures eligible for the in-memory per-model suppression window. */
export type BackendFailureKind =
  | "upstream_http_error"
  | "upstream_unavailable"
  | "upstream_timeout"
  | "model_load_failed";

export interface ModelTemporarilyUnavailable {
  code: "model_temporarily_unavailable";
  retry_after_seconds: number;
  unavailable_until: string;
}

const FAILURE_THRESHOLD = 3;
const FAILURE_WINDOW_MS = 60_000;
const COOLDOWN_MS = 30_000;
const CANONICAL_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/;

interface ModelFailureState {
  failures: number[];
  unavailableUntil: number | null;
}

function isCanonicalModelId(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_MODEL_ID.test(value);
}

function isBackendFailureKind(value: unknown): value is BackendFailureKind {
  return value === "upstream_http_error" ||
    value === "upstream_unavailable" ||
    value === "upstream_timeout" ||
    value === "model_load_failed";
}

/**
 * Suppresses repeated backend failures for a finite, approved model roster.
 * This is process-local state; it does not establish that a model is healthy when observe returns null.
 */
export class ModelFailureBackoff {
  private readonly approvedModels: Set<string>;
  private readonly states = new Map<string, ModelFailureState>();

  constructor(approvedModelIds: readonly string[], private readonly now: () => number = Date.now) {
    this.approvedModels = new Set(approvedModelIds.filter(isCanonicalModelId));
  }

  recordFailure(modelId: unknown, kind: BackendFailureKind): void {
    if (!isCanonicalModelId(modelId) || !this.approvedModels.has(modelId) || !isBackendFailureKind(kind)) return;
    const now = this.readNow();
    if (now === null) return;

    const state = this.states.get(modelId) ?? { failures: [], unavailableUntil: null };
    if (state.unavailableUntil !== null) {
      if (now < state.unavailableUntil) return;
      state.failures = [];
      state.unavailableUntil = null;
    }
    const latestFailure = state.failures.at(-1);
    if (latestFailure !== undefined && now < latestFailure) state.failures = [];
    state.failures = state.failures.filter((failedAt) => now - failedAt <= FAILURE_WINDOW_MS);
    state.failures.push(now);

    if (state.failures.length >= FAILURE_THRESHOLD) {
      state.failures = [];
      state.unavailableUntil = now + COOLDOWN_MS;
    }
    this.states.set(modelId, state);
  }

  recordSuccess(modelId: unknown): void {
    if (!isCanonicalModelId(modelId) || !this.approvedModels.has(modelId)) return;
    this.states.delete(modelId);
  }

  observe(modelId: unknown): ModelTemporarilyUnavailable | null {
    if (!isCanonicalModelId(modelId) || !this.approvedModels.has(modelId)) return null;
    const state = this.states.get(modelId);
    if (state?.unavailableUntil === null || state === undefined) return null;

    const now = this.readNow();
    if (now === null) return null;
    if (now >= state.unavailableUntil) {
      this.states.delete(modelId);
      return null;
    }

    return {
      code: "model_temporarily_unavailable",
      retry_after_seconds: Math.ceil((state.unavailableUntil - now) / 1_000),
      unavailable_until: new Date(state.unavailableUntil).toISOString(),
    };
  }

  private readNow(): number | null {
    const value = this.now();
    return Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000 - COOLDOWN_MS
      ? value
      : null;
  }
}
