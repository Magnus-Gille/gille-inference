/**
 * model-registry.ts — durable JSONL registry for the weekly Model Scout.
 *
 * Append-only log at data/model-scout-registry.jsonl (one RegistryEntry JSON per line).
 * All filesystem functions take an optional path parameter (default = DEFAULT_REGISTRY_PATH)
 * so tests can use a temp file. Pure helpers have no filesystem side-effects.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
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
    // #176 gateFlags is optional, but when present it must be a string[] — a malformed value would
    // otherwise reach promote-model and throw on `.join`. Reject the row (fail closed) instead.
    (e["gateFlags"] === undefined ||
      (Array.isArray(e["gateFlags"]) && e["gateFlags"].every((f) => typeof f === "string")))
  );
}

// ── Filesystem helpers ────────────────────────────────────────────────────────

/**
 * Append one entry as a JSON line. Creates the parent directory if it doesn't exist.
 * Throws on write errors (caller should surface them).
 */
export function appendEntry(entry: RegistryEntry, path: string = DEFAULT_REGISTRY_PATH): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  appendFileSync(path, JSON.stringify(entry) + "\n", "utf8");
}

/**
 * Read all valid entries from the JSONL file. Returns [] if the file doesn't exist.
 * Skips blank lines, malformed JSON, and lines failing isRegistryEntry — silently.
 */
export function readRegistry(path: string = DEFAULT_REGISTRY_PATH): RegistryEntry[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8");
  const entries: RegistryEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // skip malformed JSON
      continue;
    }
    if (!isRegistryEntry(parsed)) continue;
    entries.push(parsed);
  }
  return entries;
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
