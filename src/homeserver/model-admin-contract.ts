/** Shared model-administration types and input validation. No backend side effects. */
import type { ModelStartAdmission } from "./host-memory-admission.js";

const MODEL_KEY_RE = /^[A-Za-z0-9._/@:-]+$/;

export function assertModelKey(key: string, field = "modelKey"): void {
  // Reject flag-smuggling ("-…"), absolute paths ("/…"), path traversal (".."), and
  // anything outside the catalogue-key charset.
  if (
    !key ||
    key.length > 200 ||
    key.startsWith("-") ||
    key.startsWith("/") ||
    key.includes("..") ||
    !MODEL_KEY_RE.test(key)
  ) {
    throw new Error(
      `invalid ${field}: must match ${MODEL_KEY_RE}, not begin with '-' or '/', not contain '..', max 200 chars`
    );
  }
}

export function assertGpu(gpu: string): void {
  if (!/^(max|off|0(\.\d+)?|1(\.0+)?)$/.test(gpu)) {
    throw new Error(`invalid gpu offload "${gpu}": expected "max", "off", or 0..1`);
  }
}

export interface ModelInfo {
  key: string;
  type: "llm" | "embedding" | string;
  displayName: string;
  architecture?: string;
  quantization?: string;
  bitsPerWeight?: number;
  sizeBytes?: number;
  paramsString?: string | null;
  maxContextLength?: number;
  vision?: boolean;
  toolUse?: boolean;
  /** True if at least one instance is loaded in memory. */
  loaded: boolean;
  /** Context length of the (first) loaded instance, if any. */
  loadedContext?: number | null;
}

export interface LoadOptions {
  contextLength?: number;
  parallel?: number;
  /** "max" | "off" | 0..1 */
  gpu?: string;
  ttlSeconds?: number;
  /** API identifier to assign; defaults to the model key so the OpenAI id stays stable. */
  identifier?: string;
  /** Internal admission callback invoked immediately before a model-start side effect. */
  beforeModelStart?: ModelStartAdmission;
}

export interface LoadResult {
  ok: boolean;
  modelKey: string;
  identifier: string;
  contextLength?: number;
  durationMs: number;
  message: string;
}

/** Sanitized read-only observation of a backend's currently running entries. */
export interface RunningSnapshotEntry {
  model: string;
  state: string;
  ttlSeconds: number | null;
}

/** A running-model observation could not be obtained; an empty list is never equivalent. */
export class RunningSnapshotUnavailableError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "RunningSnapshotUnavailableError";
    this.status = status;
  }
}
