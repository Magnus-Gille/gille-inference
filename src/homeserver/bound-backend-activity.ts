/**
 * Read-only backend activity observations bound to a process identity.
 *
 * The process observer is deliberately injected at this boundary for deterministic
 * tests; the default path uses the platform-specific runtime evidence collector.
 */
import {
  observeBackendActivity,
  validateBackendTargets,
  type BackendActivityObservation,
  type BackendActivityTarget,
  type BackendActivityReport,
} from "./backend-activity-observation.js";
import { observeRuntimeProcess, type RuntimeProcessEvidence } from "./runtime-process-evidence.js";
import { performance } from "node:perf_hooks";

export type RuntimeProcessEvidenceReason = RuntimeProcessEvidence["reason"];

export interface BoundBackendActivityTarget extends BackendActivityTarget {
  pid: number;
  expectedIdentitySha256?: string;
}

export interface ObserveProcessOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type ObserveProcess = (
  target: { pid: number; url: string },
  opts?: ObserveProcessOptions,
) => Promise<RuntimeProcessEvidence>;

export interface BoundBackendActivityOptions {
  expectedHostBootIdSha256?: string;
  timeoutMs?: number;
  observeProcess?: ObserveProcess;
  fetch?: typeof fetch;
}

export type BoundBackendObservationReason =
  | BackendActivityObservation["reason"]
  | RuntimeProcessEvidenceReason
  | "identity-mismatch"
  | "host-mismatch";

export interface BoundProcessEvidence {
  before: RuntimeProcessEvidence | null;
  after: RuntimeProcessEvidence | null;
  label: "observed" | "matched" | "unknown";
  hostPin: "matched" | "unprovided" | "unknown";
  reason?: BoundBackendObservationReason;
}

export interface BoundBackendActivityObservation extends Omit<BackendActivityObservation, "reason"> {
  process: BoundProcessEvidence;
  reason: BoundBackendObservationReason;
}

export interface BoundBackendActivityReport extends Omit<BackendActivityReport, "targets"> {
  targets: BoundBackendActivityObservation[];
}

const PID_MAX = 2_147_483_647;
const DIGEST = /^[a-f0-9]{64}$/;
const DEFAULT_TIMEOUT_MS = 2_000;
const MAX_TIMEOUT_MS = 30_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && DIGEST.test(value);
}

function validPid(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= PID_MAX;
}

function validateTimeout(timeoutMs: number): void {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error("invalid observation timeout");
  }
}

/** Validate the common URL/id shape with the existing backend-target validator. */
export function validateBoundBackendTargets(input: unknown): BoundBackendActivityTarget[] {
  if (!Array.isArray(input)) throw new Error("invalid bound backend targets");

  const common = input.map(value => {
    if (!isRecord(value)) throw new Error("invalid bound backend targets");
    return { id: value.id, url: value.url };
  });
  const validated = validateBackendTargets(common);

  return input.map((value, index) => {
    if (!isRecord(value)) throw new Error("invalid bound backend targets");
    const keys = Object.keys(value);
    const allowed = new Set(["expectedIdentitySha256", "id", "pid", "url"]);
    if (keys.some(key => !allowed.has(key))) throw new Error("invalid bound backend targets");
    if (!validPid(value.pid)) throw new Error("invalid bound backend targets");
    if (value.expectedIdentitySha256 !== undefined && !isDigest(value.expectedIdentitySha256)) {
      throw new Error("invalid bound backend targets");
    }
    return {
      ...validated[index]!,
      pid: value.pid,
      ...(value.expectedIdentitySha256 === undefined ? {} : { expectedIdentitySha256: value.expectedIdentitySha256 }),
    };
  });
}

function unknownEvidence(reason: RuntimeProcessEvidenceReason): RuntimeProcessEvidence {
  return { state: "unknown", reason, identitySha256: null, hostBootIdSha256: null };
}

function normalizeEvidence(value: unknown): RuntimeProcessEvidence {
  if (!isRecord(value)) return unknownEvidence("read-failed");
  const state = value.state;
  const reason = value.reason;
  const identitySha256 = value.identitySha256;
  const hostBootIdSha256 = value.hostBootIdSha256;
  const validIdentity = identitySha256 === null || isDigest(identitySha256);
  const validHost = hostBootIdSha256 === null || isDigest(hostBootIdSha256);
  if ((state !== "observed" && state !== "unknown") ||
      !["sampled", "unsupported-platform", "invalid-process", "namespace-mismatch", "listener-mismatch", "process-changed", "read-failed", "timeout"].includes(reason as string) ||
      !validIdentity || !validHost) return unknownEvidence("read-failed");
  if (state === "observed" && (reason !== "sampled" || !isDigest(identitySha256) || !isDigest(hostBootIdSha256))) return unknownEvidence("read-failed");
  if (state === "unknown" && (reason === "sampled" || identitySha256 !== null || hostBootIdSha256 !== null)) return unknownEvidence("read-failed");
  return { state, reason: reason as RuntimeProcessEvidenceReason, identitySha256, hostBootIdSha256 };
}

async function defaultObserveProcess(
  target: { pid: number; url: string },
  opts: ObserveProcessOptions,
): Promise<RuntimeProcessEvidence> {
  try {
    return normalizeEvidence(await observeRuntimeProcess(target, opts));
  } catch {
    return unknownEvidence("read-failed");
  }
}

function sameProcess(before: RuntimeProcessEvidence, after: RuntimeProcessEvidence): boolean {
  return before.identitySha256 === after.identitySha256 && before.hostBootIdSha256 === after.hostBootIdSha256;
}

const TIMEOUT = Symbol("observation-timeout");

/**
 * Observe configured scheduler metrics only while the named process remains stable.
 * This is evidence of a sampled process/metrics binding, never release verification
 * or complete runtime coverage.
 */
export async function observeBoundBackendActivity(
  input: unknown,
  opts: BoundBackendActivityOptions = {},
): Promise<BoundBackendActivityReport> {
  const targets = validateBoundBackendTargets(input);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  validateTimeout(timeoutMs);
  if (opts.expectedHostBootIdSha256 !== undefined && !isDigest(opts.expectedHostBootIdSha256)) {
    throw new Error("invalid expected host boot id digest");
  }

  const observeProcess = opts.observeProcess ?? defaultObserveProcess;
  const abort = new AbortController();
  const deadline = performance.now() + timeoutMs;
  const remainingMs = (): number => Math.max(1, Math.floor(deadline - performance.now()));
  const safeObserveProcess = async (
    target: { pid: number; url: string },
    observeTimeoutMs: number,
  ): Promise<RuntimeProcessEvidence> => {
    try {
      return normalizeEvidence(await observeProcess(target, { timeoutMs: observeTimeoutMs, signal: abort.signal }));
    } catch {
      return unknownEvidence("read-failed");
    }
  };
  const withDeadline = async <T>(work: () => Promise<T>): Promise<T | typeof TIMEOUT> => {
    const remaining = deadline - performance.now();
    if (abort.signal.aborted || remaining <= 0) { abort.abort(); return TIMEOUT; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<typeof TIMEOUT>(resolve => {
      timer = setTimeout(() => { abort.abort(); resolve(TIMEOUT); }, remaining);
    });
    try {
      const result = await Promise.race([work(), timeout]);
      if (performance.now() >= deadline) { abort.abort(); return TIMEOUT; }
      return result;
    } finally {
      clearTimeout(timer);
    }
  };

  const observations: BoundBackendActivityObservation[] = [];
  for (const target of targets) {
    const startedAt = new Date().toISOString();
    const beforeResult = await withDeadline(() => safeObserveProcess({ pid: target.pid, url: target.url }, remainingMs()));
    if (beforeResult === TIMEOUT) {
      observations.push({
        id: target.id, source: "llamacpp-metrics-v1", startedAt, completedAt: new Date().toISOString(),
        state: "unknown", active: null, queued: null, reason: "timeout",
        process: { before: null, after: null, label: "unknown", hostPin: "unknown", reason: "timeout" },
      });
      continue;
    }
    const before = normalizeEvidence(beforeResult);
    const binding = (reason: BoundBackendObservationReason, after: RuntimeProcessEvidence | null = null): BoundBackendActivityObservation => ({
      id: target.id, source: "llamacpp-metrics-v1", startedAt, completedAt: new Date().toISOString(),
      state: "unknown", active: null, queued: null, reason,
      process: { before, after, label: "unknown", hostPin: "unknown", reason },
    });
    if (before.state !== "observed") {
      observations.push(binding(before.reason));
      continue;
    }
    if (target.expectedIdentitySha256 !== undefined && before.identitySha256 !== target.expectedIdentitySha256) {
      observations.push(binding("identity-mismatch"));
      continue;
    }
    if (opts.expectedHostBootIdSha256 !== undefined && before.hostBootIdSha256 !== opts.expectedHostBootIdSha256) {
      observations.push(binding("host-mismatch"));
      continue;
    }

    const metricResult = await withDeadline(() => observeBackendActivity(
      [{ id: target.id, url: target.url }],
      { timeoutMs: remainingMs(), fetch: opts.fetch },
    ));
    if (metricResult === TIMEOUT) {
      observations.push(binding("timeout"));
      continue;
    }

    const afterResult = await withDeadline(() => safeObserveProcess({ pid: target.pid, url: target.url }, remainingMs()));
    if (afterResult === TIMEOUT) {
      observations.push(binding("timeout"));
      continue;
    }
    const after = normalizeEvidence(afterResult);
    if (after.state !== "observed") {
      observations.push(binding(after.reason, after));
      continue;
    }
    if (!sameProcess(before, after)) {
      observations.push(binding("process-changed", after));
      continue;
    }

    const metric = metricResult.targets[0]!;
    observations.push({
      ...metric,
      process: {
        before,
        after,
        label: target.expectedIdentitySha256 !== undefined ? "matched" : "observed",
        hostPin: opts.expectedHostBootIdSha256 !== undefined ? "matched" : "unprovided",
        ...(metric.reason === "ok" ? {} : { reason: metric.reason }),
      },
      reason: metric.reason,
      startedAt,
      completedAt: new Date().toISOString(),
    });
  }

  return { scope: "configured-runtime-schedulers", coverage: "unknown", targets: observations };
}
