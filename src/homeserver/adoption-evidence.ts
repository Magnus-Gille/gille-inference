import type Database from "better-sqlite3";
import { getDb } from "../db.js";

/**
 * Content-blind M5 adoption evidence (#136).
 *
 * This is deliberately separate from the capability ledger, request log, and cost ledger:
 * those systems answer what ran, while this one records an L1's coarse, declared opportunity
 * and outcome observation. Its closed schema makes the organic-adoption denominator observable
 * without accepting prompts, completions, paths, repositories, or agent/session identities.
 */

export const ADOPTION_HARNESSES = [
  "claude",
  "codex_cli",
  "codex_app",
  "pi",
  "direct_cli",
  "evaluation_runner",
] as const;
export type AdoptionHarness = (typeof ADOPTION_HARNESSES)[number];

export const ADOPTION_EXECUTION_MODES = ["ask", "code_loop", "delegate"] as const;
export type AdoptionExecutionMode = (typeof ADOPTION_EXECUTION_MODES)[number];

export const ADOPTION_TRAFFIC_PURPOSES = ["organic", "evaluation", "synthetic"] as const;
export type AdoptionTrafficPurpose = (typeof ADOPTION_TRAFFIC_PURPOSES)[number];

/** `not_attempted` makes a missing tool/auth fallback visible instead of counting invisible frontier work. */
export const ADOPTION_RESULTS = ["completed", "refused", "failed", "not_attempted"] as const;
export type AdoptionResult = (typeof ADOPTION_RESULTS)[number];

export const ADOPTION_CHECK_OUTCOMES = ["pass", "fail", "not_run"] as const;
export type AdoptionCheckOutcome = (typeof ADOPTION_CHECK_OUTCOMES)[number];

export const ADOPTION_USEFULNESS = ["pass", "partial", "redo", "wrong", "not_reported"] as const;
export type AdoptionUsefulness = (typeof ADOPTION_USEFULNESS)[number];

export const ADOPTION_FALLBACK_REASONS = [
  "none",
  "m5_tool_missing",
  "m5_auth_unavailable",
  "m5_unreachable",
  "m5_busy",
  "m5_refused",
  "local_result_unusable",
  "other_known",
] as const;
export type AdoptionFallbackReason = (typeof ADOPTION_FALLBACK_REASONS)[number];

/** Wire shape accepted by the MCP tool and `m5 adoption report`; every field is low-cardinality. */
export interface AdoptionEvidenceReport {
  harness: AdoptionHarness;
  executionMode: AdoptionExecutionMode;
  trafficPurpose: AdoptionTrafficPurpose;
  result: AdoptionResult;
  deterministicCheck: AdoptionCheckOutcome;
  reviewerUsefulness: AdoptionUsefulness;
  fallbackReason: AdoptionFallbackReason;
  /** A declared count, not an inferred call count. Zero means the L1 did not know the denominator. */
  eligibleOpportunities: number;
}

export type ParseAdoptionEvidenceResult =
  | { ok: true; value: AdoptionEvidenceReport }
  | { ok: false };

export const ADOPTION_EVIDENCE_COLUMNS = [
  "recorded_day",
  "harness",
  "execution_mode",
  "traffic_purpose",
  "result",
  "deterministic_check",
  "reviewer_usefulness",
  "fallback_reason",
  "eligible_opportunities",
] as const;

/** Hard aggregate bound: enough for a small weekly trial, never an unbounded telemetry sink. */
export const MAX_ADOPTION_EVIDENCE_ROWS_PER_DAY = 25;
/** Transient, per-minted-key flood bound. The key hash is never written to adoption_evidence. */
export const MAX_ADOPTION_REPORTS_PER_PRINCIPAL_WINDOW = 8;
const ADOPTION_REPORT_WINDOW_MS = 60_000;

const reporterWindows = new Map<string, number[]>();

let initializedDb: Database.Database | null = null;

function ensureSchema(db: Database.Database): void {
  if (initializedDb === db) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS adoption_evidence (
      recorded_day           TEXT NOT NULL,
      harness                TEXT NOT NULL,
      execution_mode         TEXT NOT NULL,
      traffic_purpose        TEXT NOT NULL,
      result                 TEXT NOT NULL,
      deterministic_check    TEXT NOT NULL,
      reviewer_usefulness    TEXT NOT NULL,
      fallback_reason        TEXT NOT NULL,
      eligible_opportunities INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_adoption_evidence_recorded_day ON adoption_evidence(recorded_day);
    CREATE INDEX IF NOT EXISTS idx_adoption_evidence_purpose ON adoption_evidence(traffic_purpose, recorded_day);
    CREATE INDEX IF NOT EXISTS idx_adoption_evidence_harness ON adoption_evidence(harness, recorded_day);
  `);
  initializedDb = db;
}

function evidenceDb(): Database.Database {
  const db = getDb();
  ensureSchema(db);
  return db;
}

export function ensureAdoptionEvidenceSchema(): void {
  ensureSchema(getDb());
}

function ownEnum<T extends readonly string[]>(raw: Record<string, unknown>, key: string, values: T): T[number] | null {
  const value = raw[key];
  return typeof value === "string" && (values as readonly string[]).includes(value)
    ? value as T[number]
    : null;
}

/**
 * Keep the storage boundary fail-closed too. TypeScript types do not protect a runtime caller
 * (or a future internal import), so this repeats the closed-schema and outcome invariants after
 * MCP parsing rather than relying on a caller's `as` assertion.
 */
function isValidAdoptionEvidenceReport(report: AdoptionEvidenceReport): boolean {
  if (
    !(ADOPTION_HARNESSES as readonly string[]).includes(report.harness) ||
    !(ADOPTION_EXECUTION_MODES as readonly string[]).includes(report.executionMode) ||
    !(ADOPTION_TRAFFIC_PURPOSES as readonly string[]).includes(report.trafficPurpose) ||
    !(ADOPTION_RESULTS as readonly string[]).includes(report.result) ||
    !(ADOPTION_CHECK_OUTCOMES as readonly string[]).includes(report.deterministicCheck) ||
    !(ADOPTION_USEFULNESS as readonly string[]).includes(report.reviewerUsefulness) ||
    !(ADOPTION_FALLBACK_REASONS as readonly string[]).includes(report.fallbackReason) ||
    !Number.isInteger(report.eligibleOpportunities) ||
    report.eligibleOpportunities < 0 ||
    report.eligibleOpportunities > 10_000
  ) {
    return false;
  }

  return report.result === "completed"
    ? report.fallbackReason === "none"
    : report.deterministicCheck === "not_run" &&
      report.reviewerUsefulness === "not_reported" &&
      report.fallbackReason !== "none";
}

/**
 * Parse a public report fail-closed. The error deliberately contains no echoed caller input: even
 * malformed callers must not turn their instruction or path into an access log or MCP response.
 */
export function parseAdoptionEvidence(raw: unknown): ParseAdoptionEvidenceResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false };
  const value = raw as Record<string, unknown>;
  const allowed = new Set([
    "harness",
    "execution_mode",
    "traffic_purpose",
    "result",
    "deterministic_check",
    "reviewer_usefulness",
    "fallback_reason",
    "eligible_opportunities",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return { ok: false };

  const harness = ownEnum(value, "harness", ADOPTION_HARNESSES);
  const executionMode = ownEnum(value, "execution_mode", ADOPTION_EXECUTION_MODES);
  const trafficPurpose = ownEnum(value, "traffic_purpose", ADOPTION_TRAFFIC_PURPOSES);
  const result = ownEnum(value, "result", ADOPTION_RESULTS);
  const deterministicCheck = ownEnum(value, "deterministic_check", ADOPTION_CHECK_OUTCOMES);
  const reviewerUsefulness = ownEnum(value, "reviewer_usefulness", ADOPTION_USEFULNESS);
  const fallbackReason = ownEnum(value, "fallback_reason", ADOPTION_FALLBACK_REASONS);
  const eligibleOpportunities = value["eligible_opportunities"];
  if (
    !harness ||
    !executionMode ||
    !trafficPurpose ||
    !result ||
    !deterministicCheck ||
    !reviewerUsefulness ||
    !fallbackReason ||
    typeof eligibleOpportunities !== "number" ||
    !Number.isInteger(eligibleOpportunities) ||
    eligibleOpportunities < 0 ||
    eligibleOpportunities > 10_000
  ) {
    return { ok: false };
  }

  const report: AdoptionEvidenceReport = {
    harness,
    executionMode,
    trafficPurpose,
    result,
    deterministicCheck,
    reviewerUsefulness,
    fallbackReason,
    eligibleOpportunities,
  };
  if (!isValidAdoptionEvidenceReport(report)) return { ok: false };

  return {
    ok: true,
    value: report,
  };
}

/**
 * Reserve one short, in-memory reporting slot for an authenticated principal. The key hash exists
 * only in this process memory and expires from its bucket after one minute; it never reaches the
 * evidence table, panel, request log, or access log.
 */
export function allowAdoptionEvidenceReportForPrincipal(keyHash: string, nowMs = Date.now()): boolean {
  if (!keyHash) return false;
  const windowStart = nowMs - ADOPTION_REPORT_WINDOW_MS;
  const active = (reporterWindows.get(keyHash) ?? []).filter((at) => at > windowStart);
  if (active.length >= MAX_ADOPTION_REPORTS_PER_PRINCIPAL_WINDOW) {
    reporterWindows.set(keyHash, active);
    return false;
  }
  active.push(nowMs);
  reporterWindows.set(keyHash, active);
  return true;
}

/**
 * Write one already-validated, content-free evidence report with only its server-derived UTC day.
 * Returns false when the bounded daily aggregate is full; it never generates a report/event id.
 */
export function recordAdoptionEvidence(report: AdoptionEvidenceReport): boolean {
  if (!isValidAdoptionEvidenceReport(report)) {
    throw new Error("Invalid content-blind adoption report.");
  }
  const db = evidenceDb();
  const recordedDay = new Date().toISOString().slice(0, 10);
  const count = db
    .prepare("SELECT COUNT(*) AS count FROM adoption_evidence WHERE recorded_day = ?")
    .get(recordedDay) as { count: number };
  if (count.count >= MAX_ADOPTION_EVIDENCE_ROWS_PER_DAY) return false;
  db
    .prepare(
      `INSERT INTO adoption_evidence
         (recorded_day, harness, execution_mode, traffic_purpose, result, deterministic_check,
          reviewer_usefulness, fallback_reason, eligible_opportunities)
       VALUES
         (@recordedDay, @harness, @executionMode, @trafficPurpose, @result, @deterministicCheck,
          @reviewerUsefulness, @fallbackReason, @eligibleOpportunities)`
    )
    .run({ recordedDay, ...report });
  return true;
}
