import type Database from "better-sqlite3";

import { EXECUTION_FEEDBACK_EPOCH } from "./execution-feedback-contract.js";
import { isKnownTaskType } from "./taxonomy.js";

/** Stable, content-blind contract for the exact organic feedback report. */
export const EXECUTION_FEEDBACK_REPORT_CONTRACT = "execution-feedback-report-v1" as const;

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const MODEL_IDS = new Set([
  "mellum", "qwen3-30b-instruct", "gemma4", "qwen36-a3b", "vibethinker-3b",
  "qwen3-coder-next-80b", "gpt-oss-120b", "qwen35-122b-a10b",
  "muse-glimmer-30b", "nemotron-3.5-lightning-30b-a3b", "qwen38-27b",
  "ornith-1.5-35b", "image-fast", "image-balanced", "image-high",
]);
const SOURCE_NAMES = new Set([
  "gateway", "code-loop", "probe", "build-chunk", "cli", "mcp",
  "experiment-import", "harvest", "shadow-lane", "probe-import", "direct", "mcp-ask",
]);
const SURFACES = new Set(["ask", "delegate", "code_loop"]);
const USEFULNESS = new Set(["pass", "partial", "redo", "wrong"]);
const PURPOSES = new Set(["organic", "evaluation", "synthetic"]);

export interface ExecutionFeedbackReportWindow {
  since: string;
  until: string;
}

export interface ExecutionFeedbackReportRow {
  model: string;
  task: string;
  source: string;
  surface: string;
  completed: number;
  assessed: number;
  missing: number;
  pass: number;
  partial: number;
  redo: number;
  wrong: number;
  coverage: number | null;
}

export interface ExecutionFeedbackReportExcluded {
  evaluation: number;
  synthetic: number;
  unknown: number;
  epoch: number;
  ineligible: number;
}

export interface ExecutionFeedbackReport {
  contract: typeof EXECUTION_FEEDBACK_REPORT_CONTRACT;
  epoch: typeof EXECUTION_FEEDBACK_EPOCH;
  window: ExecutionFeedbackReportWindow;
  availability: "available" | "unavailable";
  unavailableReason?: "missing_table" | "missing_column";
  rows: ExecutionFeedbackReportRow[];
  completed: number | null;
  assessed: number | null;
  missing: number | null;
  coverage: number | null;
  excluded: ExecutionFeedbackReportExcluded | null;
}

interface JoinedRow {
  ts: unknown;
  node_id: unknown;
  shadow: unknown;
  superseded_at: unknown;
  outcome: unknown;
  model_id: unknown;
  task_type: unknown;
  source: unknown;
  surface: unknown;
  traffic_purpose: unknown;
  epoch: unknown;
  usefulness: unknown;
  available: unknown;
}

const REQUIRED_COLUMNS: Record<string, readonly string[]> = {
  delegations: ["id", "ts", "node_id", "shadow", "superseded_at", "outcome", "model_id", "task_type", "source"],
  execution_feedback: ["ledger_id", "surface", "traffic_purpose", "epoch", "usefulness", "available"],
};

function tableExists(db: Database.Database, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function hasColumns(db: Database.Database, table: string, columns: readonly string[]): boolean {
  const present = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name));
  return columns.every((column) => present.has(column));
}

function parseStrictIso(name: string, value: string): number {
  if (!ISO_UTC.test(value)) throw new RangeError(`${name} must be a canonical RFC3339 UTC timestamp`);
  const canonical = value.length === 20 ? value.replace("Z", ".000Z") : value;
  const time = Date.parse(canonical);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== canonical) throw new RangeError(`${name} is malformed`);
  return time;
}

function parseStoredIso(value: unknown): number | null {
  if (typeof value !== "string" || !ISO_UTC.test(value)) return null;
  const canonical = value.length === 20 ? value.replace("Z", ".000Z") : value;
  const time = Date.parse(canonical);
  return Number.isFinite(time) && new Date(time).toISOString() === canonical ? time : null;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Bucket an untrusted dimension to the same closed vocabulary as the adoption bundle. */
function bucketModel(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") return "unknown";
  if (value === "unknown") return "unknown";
  return MODEL_IDS.has(value) ? value : "other";
}

function bucketTask(value: unknown): string {
  return typeof value === "string" && isKnownTaskType(value) ? value : "other";
}

function bucketSource(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") return "unknown";
  if (SOURCE_NAMES.has(value)) return value;
  if (value.startsWith("probe")) return "probe";
  if (value.startsWith("code-loop")) return "code-loop";
  if (value.startsWith("gateway")) return "gateway";
  return "other";
}

function bucketSurface(value: unknown): string {
  return typeof value === "string" && SURFACES.has(value) ? value : "unknown";
}

function emptyExcluded(): ExecutionFeedbackReportExcluded {
  return { evaluation: 0, synthetic: 0, unknown: 0, epoch: 0, ineligible: 0 };
}

function unavailable(
  window: ExecutionFeedbackReportWindow,
  reason: "missing_table" | "missing_column",
): ExecutionFeedbackReport {
  return {
    contract: EXECUTION_FEEDBACK_REPORT_CONTRACT,
    epoch: EXECUTION_FEEDBACK_EPOCH,
    window,
    availability: "unavailable",
    unavailableReason: reason,
    rows: [],
    completed: null,
    assessed: null,
    missing: null,
    coverage: null,
    excluded: null,
  };
}

/**
 * Build a read-only, content-blind report over completed owner-visible feedback rows.
 *
 * `execution_feedback` is intentionally the denominator: one joined row is one completed
 * caller-visible execution. The old adoption evidence report is not consulted. No schema
 * creation, migration, or other write occurs here.
 */
export function buildExecutionFeedbackReport(
  db: Database.Database,
  bounds: ExecutionFeedbackReportWindow,
): ExecutionFeedbackReport {
  const sinceMs = parseStrictIso("since", bounds.since);
  const untilMs = parseStrictIso("until", bounds.until);
  if (sinceMs >= untilMs) throw new RangeError("since must be before until");
  const window = { since: bounds.since, until: bounds.until };

  if (!tableExists(db, "execution_feedback") || !tableExists(db, "delegations")) {
    return unavailable(window, "missing_table");
  }
  for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
    if (!hasColumns(db, table, columns)) return unavailable(window, "missing_column");
  }

  // Deliberately select only aggregate inputs. In particular, no handle, ledger id,
  // principal hash, alias, timestamp, prompt, note, or other identity-bearing value is emitted.
  const joined = db.prepare(`
    SELECT d.ts, d.node_id, d.shadow, d.superseded_at, d.outcome,
           d.model_id, d.task_type, d.source,
           f.surface, f.traffic_purpose, f.epoch, f.usefulness, f.available
      FROM execution_feedback AS f
      JOIN delegations AS d ON d.id = f.ledger_id
  `).all() as JoinedRow[];

  const excluded = emptyExcluded();
  const aggregate = new Map<string, ExecutionFeedbackReportRow>();

  for (const row of joined) {
    const ts = parseStoredIso(row.ts);
    if (ts === null || ts < sinceMs || ts >= untilMs) continue;

    const purpose = typeof row.traffic_purpose === "string" && PURPOSES.has(row.traffic_purpose)
      ? row.traffic_purpose
      : "unknown";
    if (row.epoch !== EXECUTION_FEEDBACK_EPOCH) {
      excluded.epoch += 1;
      continue;
    }
    if (purpose === "evaluation") { excluded.evaluation += 1; continue; }
    if (purpose === "synthetic") { excluded.synthetic += 1; continue; }
    if (purpose === "unknown") { excluded.unknown += 1; continue; }

    const eligible = row.available === 1 && row.node_id === "m5" && row.shadow === 0 && row.superseded_at === null
      && row.outcome !== null && row.outcome !== undefined && row.outcome !== "error";
    if (!eligible) { excluded.ineligible += 1; continue; }

    const dimensions = [bucketModel(row.model_id), bucketTask(row.task_type), bucketSource(row.source), bucketSurface(row.surface)];
    const key = dimensions.join("\u001f");
    const current = aggregate.get(key) ?? {
      model: dimensions[0], task: dimensions[1], source: dimensions[2], surface: dimensions[3],
      completed: 0, assessed: 0, missing: 0, pass: 0, partial: 0, redo: 0, wrong: 0, coverage: null,
    };
    current.completed += 1;
    if (typeof row.usefulness === "string" && USEFULNESS.has(row.usefulness)) {
      current.assessed += 1;
      current[row.usefulness as "pass" | "partial" | "redo" | "wrong"] += 1;
    } else {
      current.missing += 1;
    }
    aggregate.set(key, current);
  }

  const rows = [...aggregate.values()]
    .map((row) => ({ ...row, coverage: row.completed > 0 ? row.assessed / row.completed : null }))
    .sort((a, b) => compareStrings(a.model, b.model) || compareStrings(a.task, b.task) || compareStrings(a.source, b.source) || compareStrings(a.surface, b.surface));
  const completed = rows.reduce((sum, row) => sum + row.completed, 0);
  const assessed = rows.reduce((sum, row) => sum + row.assessed, 0);
  const missing = rows.reduce((sum, row) => sum + row.missing, 0);
  return {
    contract: EXECUTION_FEEDBACK_REPORT_CONTRACT,
    epoch: EXECUTION_FEEDBACK_EPOCH,
    window,
    availability: "available",
    rows,
    completed,
    assessed,
    missing,
    coverage: completed > 0 ? assessed / completed : null,
    excluded,
  };
}
