/**
 * model-registry.ts — durable JSONL registry for explicitly requested model evaluations.
 *
 * Append-only log at the historical data/model-scout-registry.jsonl path (one RegistryEntry JSON
 * per line). The filename is retained so existing evidence, including Muse Glimmer, remains
 * readable after the weekly discovery job is retired.
 * All filesystem functions take an optional path parameter (default = DEFAULT_REGISTRY_PATH)
 * so tests can use a temp file. Pure helpers have no filesystem side-effects.
 */
import { randomUUID } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import type { RegistryEntry } from "./scout-types.js";

// ── Constants ─────────────────────────────────────────────────────────────────

export const DEFAULT_REGISTRY_PATH: string = resolve("./data/model-scout-registry.jsonl");

function isNonNegativeCountRecord(value: unknown): value is Record<string, number> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every(
    (count) => typeof count === "number" && Number.isInteger(count) && count >= 0
  );
}

/** #12: shape-check for the persisted exact eval serving configuration. */
function isEvalServingConfig(value: unknown): value is { ctx: number; repeats: number; ngl?: number; flashAttn?: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["ctx"] === "number" &&
    Number.isFinite(v["ctx"]) &&
    typeof v["repeats"] === "number" &&
    Number.isFinite(v["repeats"]) &&
    (v["ngl"] === undefined || typeof v["ngl"] === "number") &&
    (v["flashAttn"] === undefined || typeof v["flashAttn"] === "string")
  );
}

function hasConsistentReviewCounts(e: Record<string, unknown>): boolean {
  const seeded = e["codeReviewSeededBugs"];
  const truePositives = e["codeReviewTruePositives"];
  const reported = e["codeReviewReportedFindings"];
  const cleanControls = e["codeReviewCleanControls"];
  const confabulated = e["codeReviewConfabulatedCleanControls"];
  if (
    typeof seeded !== "number" ||
    typeof truePositives !== "number" ||
    typeof reported !== "number" ||
    typeof cleanControls !== "number" ||
    typeof confabulated !== "number"
  ) {
    return true; // Each optional field is shape-checked below; only compare complete evidence.
  }
  return truePositives <= seeded && truePositives <= reported && confabulated <= cleanControls;
}

// ── Type guard ────────────────────────────────────────────────────────────────

/** Minimal shape validation — rejects nulls, wrong primitive types, array scoresByTaskType. */
export function isRegistryEntry(x: unknown): x is RegistryEntry {
  if (x === null || typeof x !== "object" || Array.isArray(x)) return false;
  const e = x as Record<string, unknown>;
  return (
    typeof e["id"] === "string" &&
    typeof e["quant"] === "string" &&
    typeof e["sizeGB"] === "number" &&
    typeof e["evaluatedAt"] === "string" &&
    (e["evaluationId"] === undefined ||
      (typeof e["evaluationId"] === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(e["evaluationId"]))) &&
    typeof e["verdict"] === "string" &&
    typeof e["passRate"] === "number" &&
    typeof e["served"] === "boolean" &&
    e["scoresByTaskType"] !== null &&
    !Array.isArray(e["scoresByTaskType"]) &&
    typeof e["scoresByTaskType"] === "object" &&
    (e["probeErrors"] === undefined || (typeof e["probeErrors"] === "number" && Number.isFinite(e["probeErrors"]) && e["probeErrors"] >= 0)) &&
    (e["probeTotalRuns"] === undefined ||
      (typeof e["probeTotalRuns"] === "number" && Number.isFinite(e["probeTotalRuns"]) && e["probeTotalRuns"] >= 0)) &&
    (e["probeErrorRate"] === undefined ||
      (typeof e["probeErrorRate"] === "number" && Number.isFinite(e["probeErrorRate"]) && e["probeErrorRate"] >= 0 && e["probeErrorRate"] <= 1)) &&
    (e["probeEmptyOutputs"] === undefined ||
      (typeof e["probeEmptyOutputs"] === "number" && Number.isFinite(e["probeEmptyOutputs"]) && e["probeEmptyOutputs"] >= 0)) &&
    (e["probeEmptyOutputRate"] === undefined ||
      (typeof e["probeEmptyOutputRate"] === "number" && Number.isFinite(e["probeEmptyOutputRate"]) && e["probeEmptyOutputRate"] >= 0 && e["probeEmptyOutputRate"] <= 1)) &&
    (e["probeTruncations"] === undefined ||
      (typeof e["probeTruncations"] === "number" && Number.isFinite(e["probeTruncations"]) && e["probeTruncations"] >= 0)) &&
    (e["probeTruncationRate"] === undefined ||
      (typeof e["probeTruncationRate"] === "number" && Number.isFinite(e["probeTruncationRate"]) && e["probeTruncationRate"] >= 0 && e["probeTruncationRate"] <= 1)) &&
    (e["probeFinishReasons"] === undefined || isNonNegativeCountRecord(e["probeFinishReasons"])) &&
    (e["codeReviewSeededBugs"] === undefined ||
      (typeof e["codeReviewSeededBugs"] === "number" && Number.isInteger(e["codeReviewSeededBugs"]) && e["codeReviewSeededBugs"] >= 0)) &&
    (e["codeReviewTruePositives"] === undefined ||
      (typeof e["codeReviewTruePositives"] === "number" && Number.isInteger(e["codeReviewTruePositives"]) && e["codeReviewTruePositives"] >= 0)) &&
    (e["codeReviewReportedFindings"] === undefined ||
      (typeof e["codeReviewReportedFindings"] === "number" && Number.isInteger(e["codeReviewReportedFindings"]) && e["codeReviewReportedFindings"] >= 0)) &&
    (e["codeReviewCleanControls"] === undefined ||
      (typeof e["codeReviewCleanControls"] === "number" && Number.isInteger(e["codeReviewCleanControls"]) && e["codeReviewCleanControls"] >= 0)) &&
    (e["codeReviewConfabulatedCleanControls"] === undefined ||
      (typeof e["codeReviewConfabulatedCleanControls"] === "number" && Number.isInteger(e["codeReviewConfabulatedCleanControls"]) && e["codeReviewConfabulatedCleanControls"] >= 0)) &&
    (e["codeReviewRecall"] === undefined ||
      (typeof e["codeReviewRecall"] === "number" && Number.isFinite(e["codeReviewRecall"]) && e["codeReviewRecall"] >= 0 && e["codeReviewRecall"] <= 1)) &&
    (e["codeReviewPrecision"] === undefined ||
      (typeof e["codeReviewPrecision"] === "number" && Number.isFinite(e["codeReviewPrecision"]) && e["codeReviewPrecision"] >= 0 && e["codeReviewPrecision"] <= 1)) &&
    (e["codeReviewCleanConfabulationRate"] === undefined ||
      (typeof e["codeReviewCleanConfabulationRate"] === "number" && Number.isFinite(e["codeReviewCleanConfabulationRate"]) && e["codeReviewCleanConfabulationRate"] >= 0 && e["codeReviewCleanConfabulationRate"] <= 1)) &&
    hasConsistentReviewCounts(e) &&
    (e["probeBatteryVersion"] === undefined || typeof e["probeBatteryVersion"] === "string") &&
    (e["corpusFingerprint"] === undefined || typeof e["corpusFingerprint"] === "string") &&
    (e["evalServingConfig"] === undefined || isEvalServingConfig(e["evalServingConfig"])) &&
    // #176 gateFlags is optional, but when present it must be a string[] — a malformed value would
    // otherwise reach a roster consumer and throw on `.join`. Reject the row (fail closed) instead.
    (e["gateFlags"] === undefined ||
      (Array.isArray(e["gateFlags"]) && e["gateFlags"].every((f) => typeof f === "string")))
  );
}

// ── Filesystem helpers ────────────────────────────────────────────────────────

function errnoCode(error: unknown): string {
  if (error !== null && typeof error === "object" && "code" in error) {
    const code = String((error as { code?: unknown }).code ?? "");
    if (/^[A-Z0-9_]+$/.test(code)) return code;
  }
  return "IO_ERROR";
}

function persistenceError(operation: string, path: string, error: unknown): Error {
  return new Error(`registry persistence failed during ${operation} for ${path} (${errnoCode(error)})`);
}

function readCompleteRegistryBytes(path: string): Buffer {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!fstatSync(fd).isFile()) {
      throw Object.assign(new Error("not a regular registry target"), { code: "EINVAL" });
    }
    const bytes = readFileSync(fd);
    if (bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a) {
      throw Object.assign(new Error("incomplete JSONL record"), { code: "INVALID_JSONL" });
    }
    return bytes;
  } catch (error) {
    throw persistenceError("read and validate target", path, error);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function assertRegistryLockAvailable(path: string): void {
  const lockPath = `${path}.lock`;
  if (existsSync(lockPath)) {
    throw new Error(`registry lock unavailable at ${lockPath} for registry ${path} (EEXIST)`);
  }
}

function parseRegistryBytes(raw: Buffer): RegistryEntry[] {
  const entries: RegistryEntry[] = [];
  for (const line of raw.toString("utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (isRegistryEntry(parsed)) entries.push(parsed);
  }
  return entries;
}

/** Read-only proof used by deployment verification under the evaluator's effective identity. */
export function verifyRegistryAppendability(path: string = DEFAULT_REGISTRY_PATH): void {
  const dir = dirname(path);
  let targetFd: number | undefined;
  try {
    if (!lstatSync(dir).isDirectory() || !lstatSync(path).isFile()) {
      throw Object.assign(new Error("not a regular registry target"), { code: "EINVAL" });
    }
    accessSync(dir, constants.W_OK | constants.X_OK);
  } catch (error) {
    throw persistenceError("verify parent appendability", path, error);
  }
  try {
    targetFd = openSync(
      path,
      constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    if (!fstatSync(targetFd).isFile()) {
      throw Object.assign(new Error("not a regular registry target"), { code: "EINVAL" });
    }
  } catch (error) {
    throw persistenceError("open target for append", path, error);
  } finally {
    if (targetFd !== undefined) closeSync(targetFd);
  }
  readCompleteRegistryBytes(path);
  assertRegistryLockAvailable(path);
}

/**
 * Prove the evaluator identity can both open the registry and atomically replace it in its parent.
 * Fresh targets are created private; existing ownership/modes are deliberately not repaired here
 * because that privileged preparation belongs to the deployment path.
 */
export function preflightRegistry(path: string = DEFAULT_REGISTRY_PATH): void {
  const dir = dirname(path);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!lstatSync(dir).isDirectory()) throw Object.assign(new Error("not a directory"), { code: "ENOTDIR" });
  } catch (error) {
    throw persistenceError("prepare parent", path, error);
  }

  let targetFd: number | undefined;
  try {
    if (existsSync(path) && !lstatSync(path).isFile()) {
      throw Object.assign(new Error("not a regular file"), { code: "EINVAL" });
    }
    targetFd = openSync(
      path,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      0o600,
    );
    if (!fstatSync(targetFd).isFile()) {
      throw Object.assign(new Error("not a regular registry target"), { code: "EINVAL" });
    }
  } catch (error) {
    throw persistenceError("open target for append", path, error);
  } finally {
    if (targetFd !== undefined) closeSync(targetFd);
  }

  const probe = `${path}.${process.pid}.${randomUUID()}.preflight`;
  let probeFd: number | undefined;
  try {
    probeFd = openSync(
      probe,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    fsyncSync(probeFd);
  } catch (error) {
    throw persistenceError("check parent for atomic replace", path, error);
  } finally {
    if (probeFd !== undefined) closeSync(probeFd);
    try { unlinkSync(probe); } catch { /* absent or preflight failed before creation */ }
  }
  readCompleteRegistryBytes(path);
  assertRegistryLockAvailable(path);
}

export type RegistryAppendOutcome = "appended" | "duplicate";

/**
 * Durably add one complete JSONL row under an exclusive sibling lock. The whole next file is
 * fsynced and atomically renamed, so a crash exposes either the old complete registry or the new
 * complete registry. Exact evaluation retries are no-ops; identity reuse with different evidence
 * fails closed.
 */
export function appendEntry(
  entry: RegistryEntry,
  path: string = DEFAULT_REGISTRY_PATH,
): RegistryAppendOutcome {
  preflightRegistry(path);
  const dir = dirname(path);
  const lockPath = `${path}.lock`;
  let lockFd: number | undefined;
  let tempPath: string | undefined;
  try {
    try {
      lockFd = openSync(
        lockPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      writeFileSync(lockFd, `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`);
      fsyncSync(lockFd);
    } catch (error) {
      throw new Error(`registry lock unavailable at ${lockPath} for registry ${path} (${errnoCode(error)})`);
    }

    const existing = readCompleteRegistryBytes(path);

    const line = `${JSON.stringify(entry)}\n`;
    if (entry.evaluationId) {
      const prior = parseRegistryBytes(existing).find(
        (candidate) => candidate.evaluationId === entry.evaluationId,
      );
      if (prior) {
        if (`${JSON.stringify(prior)}\n` === line) return "duplicate";
        throw new Error(`evaluation identity collision for ${entry.evaluationId} in registry ${path}`);
      }
    }

    tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    const tempFd = openSync(
      tempPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(tempFd, Buffer.concat([existing, Buffer.from(line, "utf8")]));
      fsyncSync(tempFd);
    } finally {
      closeSync(tempFd);
    }
    renameSync(tempPath, path);
    tempPath = undefined;
    const dirFd = openSync(dir, constants.O_RDONLY);
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
    return "appended";
  } finally {
    if (tempPath) {
      try { unlinkSync(tempPath); } catch { /* never mask the persistence failure */ }
    }
    if (lockFd !== undefined) {
      try { closeSync(lockFd); }
      finally {
        try { unlinkSync(lockPath); } catch { /* a stale lock fails future writes closed */ }
      }
    }
  }
}

/**
 * Read all valid entries from the JSONL file. Returns [] if the file doesn't exist.
 * Skips blank lines, malformed JSON, and lines failing isRegistryEntry — silently.
 */
export function readRegistry(path: string = DEFAULT_REGISTRY_PATH): RegistryEntry[] {
  if (!existsSync(path)) return [];
  return parseRegistryBytes(readCompleteRegistryBytes(path));
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

/**
 * Reduce to the most-recent entry per model id (ISO evaluatedAt compared lexically).
 * Order-independent.
 */
export function latestByModel(entries: RegistryEntry[]): Map<string, RegistryEntry> {
  const m = new Map<string, RegistryEntry>();
  for (const e of entries) {
    const existing = m.get(e.id);
    if (!existing || e.evaluatedAt > existing.evaluatedAt) {
      m.set(e.id, e);
    }
  }
  return m;
}

/** True if any entry has the given id. */
export function isEvaluated(id: string, entries: RegistryEntry[]): boolean {
  return entries.some((e) => e.id === id);
}

/**
 * Return the ids whose LATEST entry has served === true.
 * A model demoted in a later evaluation does not appear.
 */
export function servedIds(entries: RegistryEntry[]): string[] {
  const latest = latestByModel(entries);
  const ids: string[] = [];
  for (const [id, e] of latest) {
    if (e.served) ids.push(id);
  }
  return ids;
}

/** Set of all distinct ids ever seen in entries. */
export function evaluatedIds(entries: RegistryEntry[]): Set<string> {
  return new Set(entries.map((e) => e.id));
}
