/**
 * Whole-host memory admission for llama-swap model starts (issue #350).
 *
 * On this unified-memory host, GPU memory is not charged to the model service cgroup, so a request
 * for a non-resident large model can make llama-swap start it and exhaust the whole host. This
 * module decides, BEFORE the gateway forwards such a request, whether the host can afford the
 * start, and (in enforce mode only) lets the caller refuse with a named cause.
 *
 * Ships OFF by default. `shadow` observes and logs but never rejects: per-model budgets are
 * operator-declared and not yet calibrated against measurements.
 *
 * Content-blind: the log record carries the requested model id, the decision, and numbers only —
 * never prompt/response content, keys, or principal identity.
 *
 * This file deliberately has no runtime imports from config/model-admin (config imports the
 * parsers from here); residency and memory readers are injected.
 */

import { readFile as fsReadFile } from "node:fs/promises";
import type { RunningSnapshotEntry } from "./lmstudio-admin.js";
import { meminfoBytes } from "./strix-host-profile.js";
import { recordHostMemoryAdmission } from "./metrics.js";

export type HostMemoryAdmissionMode = "off" | "shadow" | "enforce";

export interface HostMemoryAdmissionConfig {
  mode: HostMemoryAdmissionMode;
  /** Operator-declared peak host-memory cost of STARTING a model (bytes). Not calibrated. */
  modelBudgetBytes: ReadonlyMap<string, number>;
  /**
   * Operator-declared conservative LOWER bound on the host memory released when that model is
   * evicted (bytes). A peak start budget is not such a bound, so a model without an entry here
   * gives no eviction credit.
   */
  modelReclaimBytes: ReadonlyMap<string, number>;
  reserveBytes: number;
  retryAfterSeconds: number;
}

export type HostMemoryOutcome = "not_needed" | "allow" | "refuse";
export type HostMemoryReason =
  | "already_resident"
  | "start_in_progress"
  | "budget_unknown"
  | "host_memory_unknown"
  | "insufficient_memory"
  | "fits";

export interface HostMemorySnapshot {
  memTotalBytes: number;
  memAvailableBytes: number;
  /** `CmaFree:` from /proc/meminfo; null when the line is absent (treated as 0). */
  cmaFreeBytes: number | null;
  gttUsedBytes: number | null;
  gttTotalBytes: number | null;
}

export interface HostMemoryDecision {
  outcome: HostMemoryOutcome;
  reason: HostMemoryReason;
  budgetBytes: number | null;
  reserveBytes: number;
  requiredBytes: number | null;
  /** Raw MemAvailable (includes free CMA pages that ordinary allocations cannot use). */
  memAvailableBytes: number | null;
  cmaFreeBytes: number | null;
  /** max(0, MemAvailable - CmaFree): the figure the decision actually uses. */
  usableAvailableBytes: number | null;
  evictionCreditBytes: number | null;
  projectedAvailableBytes: number | null;
  gttUsedBytes: number | null;
  gttTotalBytes: number | null;
  residencyKnown: boolean;
}

const GIB = 1024 ** 3;

export function parseHostMemoryMode(raw: string | undefined): HostMemoryAdmissionMode {
  return raw === "shadow" || raw === "enforce" ? raw : "off";
}

function parsePositiveGib(text: string): number | null {
  if (text === "") return null;
  const gib = Number(text);
  return Number.isFinite(gib) && gib > 0 ? gib : null;
}

/**
 * Parse `modelId=peakGiB[:reclaimGiB],...`. `peakGiB` is the host memory a start may need;
 * the optional `reclaimGiB` is a conservative lower bound on what evicting the model releases and
 * must not exceed the peak. Invalid entries are dropped whole (never guessed) and their names
 * returned so startup can report them once; the value is never returned.
 */
export function parseHostMemoryBudgets(
  raw: string | undefined,
): { budgets: Map<string, number>; reclaim: Map<string, number>; invalid: string[] } {
  const budgets = new Map<string, number>();
  const reclaim = new Map<string, number>();
  const invalid: string[] = [];
  if (raw === undefined || raw.trim() === "") return { budgets, reclaim, invalid };
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (trimmed === "") continue;
    const eq = trimmed.lastIndexOf("=");
    const name = eq > 0 ? trimmed.slice(0, eq).trim() : eq === 0 ? "" : trimmed;
    const valueText = eq > 0 ? trimmed.slice(eq + 1).trim() : "";
    const colon = valueText.indexOf(":");
    const peakGib = parsePositiveGib(colon < 0 ? valueText : valueText.slice(0, colon).trim());
    const reclaimGib = colon < 0 ? null : parsePositiveGib(valueText.slice(colon + 1).trim());
    const reclaimValid = colon < 0 || (reclaimGib !== null && peakGib !== null && reclaimGib <= peakGib);
    if (eq <= 0 || name === "" || peakGib === null || !reclaimValid) {
      invalid.push(name === "" ? "(empty)" : name);
      continue;
    }
    budgets.set(name, Math.round(peakGib * GIB));
    if (reclaimGib !== null) reclaim.set(name, Math.round(reclaimGib * GIB));
  }
  return { budgets, reclaim, invalid };
}

/** "ready" or "starting" when the model needs no new start; null otherwise. */
function residentStartState(
  running: Array<{ model: string; state: string }> | null,
  model: string,
): "ready" | "starting" | null {
  let found: "ready" | "starting" | null = null;
  for (const r of running ?? []) {
    if (r.model !== model) continue;
    if (r.state === "ready") return "ready";
    if (r.state === "starting") found = "starting";
  }
  return found;
}

function usableAvailable(memory: HostMemorySnapshot): number {
  return Math.max(0, memory.memAvailableBytes - (memory.cmaFreeBytes ?? 0));
}

export function decideHostMemoryAdmission(input: {
  requestedModel: string;
  running: Array<{ model: string; state: string }> | null;
  memory: HostMemorySnapshot | null;
  config: Pick<HostMemoryAdmissionConfig, "modelBudgetBytes" | "modelReclaimBytes" | "reserveBytes">;
}): HostMemoryDecision {
  const { requestedModel, running, memory, config } = input;
  const budget = config.modelBudgetBytes.get(requestedModel) ?? null;
  const base = {
    budgetBytes: budget,
    reserveBytes: config.reserveBytes,
    requiredBytes: null,
    memAvailableBytes: memory?.memAvailableBytes ?? null,
    cmaFreeBytes: memory?.cmaFreeBytes ?? null,
    usableAvailableBytes: memory === null ? null : usableAvailable(memory),
    evictionCreditBytes: null,
    projectedAvailableBytes: null,
    gttUsedBytes: memory?.gttUsedBytes ?? null,
    gttTotalBytes: memory?.gttTotalBytes ?? null,
    residencyKnown: running !== null,
  };

  // Only a ready model, or one whose start is already under way, needs no new start. Any other
  // state (stopping, stopped, unknown) proves neither, so it is checked like an absent model.
  const selfState = residentStartState(running, requestedModel);
  if (selfState !== null) {
    return {
      ...base,
      outcome: "not_needed",
      reason: selfState === "ready" ? "already_resident" : "start_in_progress",
    };
  }
  if (budget === null) return { ...base, outcome: "refuse", reason: "budget_unknown" };
  if (memory === null) return { ...base, outcome: "refuse", reason: "host_memory_unknown" };

  let credit = 0;
  for (const r of running ?? []) {
    if (r.model !== requestedModel && r.state === "ready") credit += config.modelReclaimBytes.get(r.model) ?? 0;
  }
  const usable = usableAvailable(memory);
  // Eviction cannot release more than is in use. Free CMA pages are not in use, so the cap is taken
  // on raw MemAvailable; subtracting CMA here would hand that unusable memory back as credit.
  credit = Math.min(credit, Math.max(0, memory.memTotalBytes - memory.memAvailableBytes));
  const projected = usable + credit;
  const required = budget + config.reserveBytes;
  return {
    ...base,
    requiredBytes: required,
    evictionCreditBytes: credit,
    projectedAvailableBytes: projected,
    outcome: projected >= required ? "allow" : "refuse",
    reason: projected >= required ? "fits" : "insufficient_memory",
  };
}

// ─── Host reader ─────────────────────────────────────────────────────────────────────

export type ReadTextFile = (path: string) => Promise<string>;

export type HostMemoryReadResult =
  | { ok: true; memory: HostMemorySnapshot }
  | { ok: false; error: string };

const MAX_DRM_CARDS = 16;

function parseByteInteger(text: string): number | null {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * Read whole-host memory from /proc/meminfo plus (best effort) the first readable
 * /sys/class/drm/card<N>/device/mem_info_gtt_{used,total} pair. Missing GTT files yield null GTT
 * fields; unreadable or unparseable meminfo is an explicit failure carrying the cause.
 */
export async function readHostMemory(
  readFile: ReadTextFile = (p) => fsReadFile(p, "utf8"),
): Promise<HostMemoryReadResult> {
  let meminfo: string;
  try {
    meminfo = await readFile("/proc/meminfo");
  } catch (err) {
    return { ok: false, error: `cannot read /proc/meminfo: ${errorText(err)}` };
  }
  const memTotalBytes = meminfoBytes(meminfo, "MemTotal");
  const memAvailableBytes = meminfoBytes(meminfo, "MemAvailable");
  if (memTotalBytes === null || memAvailableBytes === null) {
    return { ok: false, error: "cannot parse MemTotal/MemAvailable from /proc/meminfo" };
  }
  const cmaFreeBytes = meminfoBytes(meminfo, "CmaFree");
  let gttUsedBytes: number | null = null;
  let gttTotalBytes: number | null = null;
  for (let card = 0; card < MAX_DRM_CARDS; card++) {
    const dir = `/sys/class/drm/card${card}/device`;
    try {
      const used = parseByteInteger(await readFile(`${dir}/mem_info_gtt_used`));
      const total = parseByteInteger(await readFile(`${dir}/mem_info_gtt_total`));
      if (used !== null && total !== null) {
        gttUsedBytes = used;
        gttTotalBytes = total;
        break;
      }
    } catch {
      // Absent card or GTT file: GTT is calibration evidence only, so keep scanning.
    }
  }
  return { ok: true, memory: { memTotalBytes, memAvailableBytes, cmaFreeBytes, gttUsedBytes, gttTotalBytes } };
}

// ─── Orchestration ───────────────────────────────────────────────────────────────────

export interface HostMemoryAdmissionDeps {
  /** Residency observation (llama-swap GET /running). Throws when unavailable. */
  getRunning: () => Promise<RunningSnapshotEntry[]>;
  /** Defaults to readHostMemory() against the real host files. */
  readMemory?: () => Promise<HostMemoryReadResult>;
  /** Structured-log sink. Defaults to one JSON line on stdout. */
  log?: (record: Record<string, unknown>) => void;
  /** Deadline for each observation (residency, host memory). Defaults to 2000 ms. */
  observationTimeoutMs?: number;
}

const DEFAULT_OBSERVATION_TIMEOUT_MS = 2000;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Bound an observation. The check runs while the request holds an admission slot, so a hung
 * residency fetch or host read must not hold that slot; on expiry the caller treats the
 * observation as unavailable. The abandoned promise is left to settle on its own.
 */
function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    timer.unref?.();
    work.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err: unknown) => { clearTimeout(timer); reject(err); },
    );
  });
}

export type HostMemoryRejection =
  | { code: "insufficient_memory"; message: string; retryAfterSeconds: number; reason: HostMemoryReason }
  | { code: "memory_admission_unavailable"; message: string; retryAfterSeconds: null; reason: HostMemoryReason };

function safeModelLabel(model: string): string {
  // eslint-disable-next-line no-control-regex
  return model.replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, 128);
}

/**
 * Telemetry is best effort: a failing log sink or metric must never fail or reject a request,
 * least of all in shadow mode.
 */
function bestEffort(action: () => void): void {
  try {
    action();
  } catch {
    // Deliberately dropped: there is no safer channel to report a failing log sink on.
  }
}

function defaultLog(record: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

/**
 * Check whole-host memory before forwarding a request that may make llama-swap start `model`.
 * Returns a rejection only in `enforce` mode with a `refuse` decision; otherwise null. In `off`
 * mode this returns immediately and performs no I/O. It never throws.
 *
 * `model` is the raw requested id: it is used for lookup and echoed only to the caller who sent it.
 * `logLabel` is the caller's already-canonicalised label (validated against trusted model
 * configuration, else "unknown"); only that label reaches the shared log, because a raw model
 * string is caller-controlled text.
 */
export async function admitHostMemory(
  config: HostMemoryAdmissionConfig,
  model: string,
  deps: HostMemoryAdmissionDeps,
  logLabel: string | null = null,
): Promise<HostMemoryRejection | null> {
  if (config.mode === "off") return null;
  const timeoutMs = deps.observationTimeoutMs ?? DEFAULT_OBSERVATION_TIMEOUT_MS;

  let running: RunningSnapshotEntry[] | null = null;
  let residencyError: string | undefined;
  try {
    running = await withDeadline(deps.getRunning(), timeoutMs, "residency observation");
  } catch (err) {
    // Unknown residency means no eviction credit (fail-conservative), never silently "empty".
    residencyError = errorText(err);
  }

  // A resident (or already starting) model needs no start. Count it, but skip the host reads and
  // the log line so steady-state traffic adds no per-request log volume.
  if (residentStartState(running, model) !== null) {
    const notNeeded = decideHostMemoryAdmission({ requestedModel: model, running, memory: null, config });
    bestEffort(() => recordHostMemoryAdmission(config.mode, notNeeded.outcome, notNeeded.reason));
    return null;
  }

  let memory: HostMemorySnapshot | null = null;
  let memoryError: string | undefined;
  try {
    const read = await withDeadline((deps.readMemory ?? readHostMemory)(), timeoutMs, "host memory read");
    if (read.ok) memory = read.memory;
    else memoryError = read.error;
  } catch (err) {
    memoryError = errorText(err);
  }

  const decision = decideHostMemoryAdmission({ requestedModel: model, running, memory, config });
  const enforced = config.mode === "enforce";
  bestEffort(() =>
    (deps.log ?? defaultLog)({
      event: "host_memory_admission",
      ts: new Date().toISOString(),
      mode: config.mode,
      model: logLabel === null ? "unknown" : safeModelLabel(logLabel),
      ...decision,
      ...(residencyError !== undefined ? { residencyError } : {}),
      ...(memoryError !== undefined ? { memoryError } : {}),
      enforced,
    }),
  );
  bestEffort(() => recordHostMemoryAdmission(config.mode, decision.outcome, decision.reason));

  if (!enforced || decision.outcome !== "refuse") return null;
  const label = safeModelLabel(model);
  if (decision.reason === "insufficient_memory") {
    return {
      code: "insufficient_memory",
      message: `There is not enough host memory to start the model '${label}' right now. Retry after ${config.retryAfterSeconds}s.`,
      retryAfterSeconds: config.retryAfterSeconds,
      reason: decision.reason,
    };
  }
  return {
    code: "memory_admission_unavailable",
    message: `Memory admission cannot approve starting the model '${label}' (${decision.reason}). Retrying will not help until the operator fixes it.`,
    retryAfterSeconds: null,
    reason: decision.reason,
  };
}
