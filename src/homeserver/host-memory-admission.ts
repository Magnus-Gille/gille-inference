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
  /** Operator-declared peak host-memory cost per model id (bytes). Not calibrated. */
  modelBudgetBytes: ReadonlyMap<string, number>;
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

/**
 * Parse `modelId=GiB,...`. Invalid entries are dropped (never guessed) and their names returned so
 * startup can report them once. Only the model name is returned for an invalid entry, not the value.
 */
export function parseHostMemoryBudgets(
  raw: string | undefined,
): { budgets: Map<string, number>; invalid: string[] } {
  const budgets = new Map<string, number>();
  const invalid: string[] = [];
  if (raw === undefined || raw.trim() === "") return { budgets, invalid };
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (trimmed === "") continue;
    const eq = trimmed.lastIndexOf("=");
    const name = eq > 0 ? trimmed.slice(0, eq).trim() : eq === 0 ? "" : trimmed;
    const valueText = eq > 0 ? trimmed.slice(eq + 1).trim() : "";
    const gib = valueText === "" ? Number.NaN : Number(valueText);
    if (eq <= 0 || name === "" || !Number.isFinite(gib) || gib <= 0) {
      invalid.push(name === "" ? "(empty)" : name);
      continue;
    }
    budgets.set(name, Math.round(gib * GIB));
  }
  return { budgets, invalid };
}

function usableAvailable(memory: HostMemorySnapshot): number {
  return Math.max(0, memory.memAvailableBytes - (memory.cmaFreeBytes ?? 0));
}

export function decideHostMemoryAdmission(input: {
  requestedModel: string;
  running: Array<{ model: string; state: string }> | null;
  memory: HostMemorySnapshot | null;
  config: Pick<HostMemoryAdmissionConfig, "modelBudgetBytes" | "reserveBytes">;
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

  const self = running?.find((r) => r.model === requestedModel);
  if (self !== undefined) {
    return {
      ...base,
      outcome: "not_needed",
      reason: self.state === "ready" ? "already_resident" : "start_in_progress",
    };
  }
  if (budget === null) return { ...base, outcome: "refuse", reason: "budget_unknown" };
  if (memory === null) return { ...base, outcome: "refuse", reason: "host_memory_unknown" };

  let credit = 0;
  for (const r of running ?? []) {
    if (r.state === "ready") credit += config.modelBudgetBytes.get(r.model) ?? 0;
  }
  const usable = usableAvailable(memory);
  credit = Math.min(credit, Math.max(0, memory.memTotalBytes - usable));
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
    return { ok: false, error: `cannot read /proc/meminfo: ${(err as Error).message}` };
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
}

export type HostMemoryRejection =
  | { code: "insufficient_memory"; message: string; retryAfterSeconds: number; reason: HostMemoryReason }
  | { code: "memory_admission_unavailable"; message: string; retryAfterSeconds: null; reason: HostMemoryReason };

function safeModelLabel(model: string): string {
  // eslint-disable-next-line no-control-regex
  return model.replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, 128);
}

function defaultLog(record: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

/**
 * Check whole-host memory before forwarding a request that may make llama-swap start `model`.
 * Returns a rejection only in `enforce` mode with a `refuse` decision; otherwise null. In `off`
 * mode this returns immediately and performs no I/O.
 */
export async function admitHostMemory(
  config: HostMemoryAdmissionConfig,
  model: string,
  deps: HostMemoryAdmissionDeps,
): Promise<HostMemoryRejection | null> {
  if (config.mode === "off") return null;

  let running: RunningSnapshotEntry[] | null = null;
  let residencyError: string | undefined;
  try {
    running = await deps.getRunning();
  } catch (err) {
    // Unknown residency means no eviction credit (fail-conservative), never silently "empty".
    residencyError = (err as Error).message;
  }

  // A resident (or already starting) model needs no start. Count it, but skip the host reads and
  // the log line so steady-state traffic adds no per-request log volume.
  if (running?.some((r) => r.model === model)) {
    const notNeeded = decideHostMemoryAdmission({ requestedModel: model, running, memory: null, config });
    recordHostMemoryAdmission(config.mode, notNeeded.outcome, notNeeded.reason);
    return null;
  }

  let memory: HostMemorySnapshot | null = null;
  let memoryError: string | undefined;
  try {
    const read = await (deps.readMemory ?? readHostMemory)();
    if (read.ok) memory = read.memory;
    else memoryError = read.error;
  } catch (err) {
    memoryError = (err as Error).message;
  }

  const decision = decideHostMemoryAdmission({ requestedModel: model, running, memory, config });
  const enforced = config.mode === "enforce";
  (deps.log ?? defaultLog)({
    event: "host_memory_admission",
    ts: new Date().toISOString(),
    mode: config.mode,
    model: safeModelLabel(model),
    ...decision,
    ...(residencyError !== undefined ? { residencyError } : {}),
    ...(memoryError !== undefined ? { memoryError } : {}),
    enforced,
  });
  recordHostMemoryAdmission(config.mode, decision.outcome, decision.reason);

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
