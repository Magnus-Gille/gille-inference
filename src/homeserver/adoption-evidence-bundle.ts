import type Database from "better-sqlite3";

import {
  COMPUTE_REQUEST_FILTER_EPOCH,
  COMPUTE_REQUEST_FILTER_SQL,
  M5_COMPUTE_ROUTES,
  isAdmittedM5ComputeRequest,
} from "./compute-request-filter.js";
import {
  ADOPTION_CHECK_OUTCOMES,
  ADOPTION_EXECUTION_MODES,
  ADOPTION_FALLBACK_REASONS,
  ADOPTION_HARNESSES,
  ADOPTION_RESULTS,
  ADOPTION_TRAFFIC_PURPOSES,
  ADOPTION_USEFULNESS,
  type AdoptionTrafficPurpose,
  type AdoptionUsefulness,
} from "./adoption-evidence.js";
import { DEFAULT_COST_CATALOG_VERSION, roundUsd } from "./cost-catalog.js";
import { DELEGATION_M5_COST_VALUE_COLUMNS } from "./delegation-cost.js";
import { HARVEST_JUDGE_POLICY, isCurrentPolicy } from "./harvest.js";
import { isKnownTaskType } from "./taxonomy.js";
import { classifyVerifierKind, type VerifierKind } from "./verifier-classification.js";

/** Local, content-blind adoption evidence export contract (#245). */
export const ADOPTION_EVIDENCE_BUNDLE_CONTRACT = "m5-adoption-evidence-bundle-v1" as const;
export const ADOPTION_EVIDENCE_BUNDLE_VERSION = 1 as const;

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const MATURITY_LABELS = ["deployed/enforced", "deployed/shadow", "measured", "aspirational"] as const;
const NEXT_ACTIONS = ["improve_agent_access", "repair_measurement", "keep_routing_shadow", "propose_separately_reviewed_lane_promotion"] as const;

export type MaturityLabel = (typeof MATURITY_LABELS)[number];
export type NextAction = (typeof NEXT_ACTIONS)[number];
export type EvidenceStatus = "pass" | "fail" | "unknowable";

export interface EvidenceBundleWindow { from: string; throughExclusive: string; }
export interface EvidenceBundleOptions extends EvidenceBundleWindow { generatedAt?: string; }
export interface EvidenceThreshold { status: EvidenceStatus; observed: number | null; required: number; reason: string; }
export interface EvidenceBucket { bucket: string; rows: number; attempted: number; useful: number; }
interface ComputeBucket { bucket: string; requests: number; requestTimeMs: number; }

interface SourceWindow { rows: number; inWindow: number; malformedTimestamp: number; validMin: string | null; validMax: string | null; }
interface BoundedFilter { from: string; throughExclusive: string; comparison: string; timestampShape: string; }
interface AdoptionBreakdownRow { bucket: string; reports: number; knownOpportunities: number; attempted: number; useful: number; }

export interface AdoptionEvidenceRetention {
  retainedIndividualCount: number;
  aggregatedCount: number;
  droppedCount: number;
  cappedDays: string[];
  affectedDays: string[];
  perHarnessAttribution: "complete" | "unavailable";
  complete: boolean;
}

interface AdoptionOverflowAggregate {
  reports: number;
  knownOpportunities: number;
  unknownOpportunityDenominators: number;
  attempted: number;
  useful: number;
  completed: number;
  unassessedAttempted: number;
  deterministicChecks: number;
  deterministicCheckPasses: number;
  usefulness: Record<AdoptionUsefulness, number>;
  fallbackCounts: Record<string, number>;
}

interface AdoptionOverflowQueryResult {
  sourceRows: number;
  rows: number;
  malformedDay: number;
  validMin: string | null;
  validMax: string | null;
  aggregatedCount: number;
  droppedCount: number;
  cappedDays: string[];
  affectedDays: string[];
  perHarnessAttribution: "complete" | "unavailable";
  byPurpose: Record<AdoptionTrafficPurpose, AdoptionOverflowAggregate>;
  breakdowns: { result: Map<string, AdoptionBreakdownRow>; usefulness: Map<string, AdoptionBreakdownRow>; fallback: Map<string, AdoptionBreakdownRow> };
}

export interface AdoptionAggregate {
  reports: number;
  knownOpportunities: number;
  attempted: number;
  useful: number;
  usefulAttemptedRatio: number | null;
  usefulness: Record<AdoptionUsefulness, number>;
  unknownOpportunityDenominators: number;
  unassessedAttempted: number;
}

interface AdoptionQueryResult {
  aggregate: Record<AdoptionTrafficPurpose, AdoptionAggregate>;
  breakdowns: { purpose: AdoptionBreakdownRow[]; harness: AdoptionBreakdownRow[]; mode: AdoptionBreakdownRow[]; result: AdoptionBreakdownRow[]; usefulness: AdoptionBreakdownRow[]; fallback: AdoptionBreakdownRow[] };
  sourceRows: number;
  rows: number;
  malformedDay: number;
  validMin: string | null;
  validMax: string | null;
  fallbackCoverage: { capacity: number; transport: number; access: number; unknown: number };
  overflow: AdoptionOverflowQueryResult;
}

interface DelegationMatrixRow {
  task: string;
  model: string;
  verifier: VerifierKind;
  source: string;
  outcome: "pass" | "partial" | "fail" | "error" | "unverified" | "other";
  rows: number;
  infraErrors: number;
  reviewerUsefulness: Record<string, number>;
}

interface DelegationQueryResult {
  sourceRows: number;
  rows: number;
  currentRows: number;
  malformedTimestamp: number;
  validMin: string | null;
  validMax: string | null;
  matrix: DelegationMatrixRow[];
  byTask: EvidenceBucket[];
  byModel: EvidenceBucket[];
  byVerifier: EvidenceBucket[];
  bySource: EvidenceBucket[];
  reviewerUsefulness: { present: number; missing: number };
  infraErrors: number;
  unverified: number;
  currentIds: Set<string>;
  coverage: {
    evidenceIdentity: { present: number; missing: number };
    judgePolicy: { present: number; missing: number };
    learningTaskBinding: { present: number; missing: number };
  };
  stateCounts: {
    scope: "valid-timestamped delegation rows in the exact bounded window";
    currentM5: number;
    shadowM5: number;
    supersededM5: number;
    shadowAndSupersededM5: number;
    nonM5: number;
    invalid: number;
    reconciliation: { inWindow: number; classified: number; allMatch: boolean };
  };
  currentEvidenceIdentity: { present: number; missing: number };
  judgePolicy: { epoch: typeof HARVEST_JUDGE_POLICY; current: number; stale: number; missing: number; applicability: "current" | "mixed" | "historical-or-missing" | "no-current-m5-evidence" };
  learningTaskBinding: { scope: "current-M5 delegation rows in the exact bounded window"; currentM5: number; required: number; present: number; missing: number; notRequired: number; nonCurrentExcluded: number };
}

interface CostTotals {
  rows: number;
  m5TotalUsd: number | null;
  verifiedSavingsActualUsd: number | null;
  verifiedSavingsPremiumUsd: number | null;
  potentialSavingsActualUsd: number | null;
  potentialSavingsPremiumUsd: number | null;
  missingValues: number;
  confidence: "complete" | "partial" | "unknowable";
}

interface CostQueryResult {
  sourceRows: number;
  rows: number;
  malformedTimestamp: number;
  validMin: string | null;
  validMax: string | null;
  reconciled: CostTotals;
  unlinked: CostTotals;
  unreconciled: CostTotals;
  reconciledDelegations: number;
  attribution: { delegatorModel: { present: number; missing: number }; source: { stamped: number; default: number; missing: number; unknown: number } };
  tokens: { prompt: { present: number; missing: number }; completion: { present: number; missing: number }; total: { present: number; missing: number } };
  calibration: { present: number; missing: number };
  priceCatalog: { present: number; missing: number; unrecognized: number };
  byStatus: EvidenceBucket[];
  reconciliation: {
    currentDelegations: number;
    linkedRows: number;
    linkedDelegations: number;
    missingDelegations: number;
    duplicateLinks: number;
    duplicateRows: number;
    unlinkedRows: number;
    unreconciledRows: number;
    exactlyOnePerCurrentDelegation: boolean;
  };
}

export interface AdoptionEvidenceBundle {
  contract: typeof ADOPTION_EVIDENCE_BUNDLE_CONTRACT;
  version: typeof ADOPTION_EVIDENCE_BUNDLE_VERSION;
  generatedAt: string;
  window: EvidenceBundleWindow;
  admittedCompute: {
    filter: { epoch: typeof COMPUTE_REQUEST_FILTER_EPOCH; sql: string; node: "m5"; admission: "admitted"; excludedModel: "none"; routes: readonly string[]; bounds: BoundedFilter; historicalApplicability: { status: "unknown"; ambiguousRows: number; reason: string } };
    requests: number;
    requestTimeMs: number;
    missingRequestTime: number;
    byDay: ComputeBucket[];
    byTier: ComputeBucket[];
    byRoute: ComputeBucket[];
    byNode: ComputeBucket[];
    byModel: ComputeBucket[];
    reconciliation: { count: { total: number; byDay: number; byTier: number; byRoute: number; byNode: number; byModel: number; allMatch: boolean }; requestTimeMs: { total: number; byDay: number; byTier: number; byRoute: number; byNode: number; byModel: number; allMatch: boolean } };
    exclusions: { malformedTimestamp: number; node: { m5: number; nonM5: number; missing: number }; admission: { admitted: number; notAdmitted: number; missing: number }; model: { none: number; present: number; missing: number }; route: { included: number; excluded: number; missing: number }; reconciliation: { inWindow: number; byNode: number; byAdmission: number; byModel: number; byRoute: number; allMatch: boolean } };
    sourceWindow: SourceWindow;
  };
  adoption: {
    filter: BoundedFilter;
    byPurpose: Record<AdoptionTrafficPurpose, AdoptionAggregate>;
    breakdowns: AdoptionQueryResult["breakdowns"];
    fallbackCoverage: AdoptionQueryResult["fallbackCoverage"];
    thresholds: { knownOpportunities: EvidenceThreshold; usefulAttemptedRatio: EvidenceThreshold };
    overflow: AdoptionEvidenceRetention & { byPurpose: Record<AdoptionTrafficPurpose, AdoptionOverflowAggregate> };
    sourceWindow: SourceWindow;
  };
  delegations: {
    filter: BoundedFilter;
    rows: number;
    currentRows: number;
    attempted: number;
    useful: number;
    unverified: number;
    infraErrors: number;
    reviewerUsefulness: { present: number; missing: number };
    byTask: EvidenceBucket[];
    byModel: EvidenceBucket[];
    byVerifier: EvidenceBucket[];
    bySource: EvidenceBucket[];
    matrix: DelegationMatrixRow[];
    coverage: DelegationQueryResult["coverage"];
    stateCounts: DelegationQueryResult["stateCounts"];
    judgePolicy: DelegationQueryResult["judgePolicy"];
    learningTaskBinding: DelegationQueryResult["learningTaskBinding"];
    promotionReadiness: { evidenceIdentityComplete: boolean; judgePolicyCurrent: boolean; learningTaskBindingComplete: boolean; stateUnambiguous: boolean; reviewerUsefulnessComplete: boolean; costCoverageComplete: boolean; computeReconciliationComplete: boolean; historicalMetricUnambiguous: boolean; eligible: boolean };
    sourceWindow: SourceWindow;
  };
  cost: { filter: BoundedFilter; rows: number; reconciled: CostTotals; unlinked: CostTotals; unreconciled: CostTotals; reconciledDelegations: number; attribution: CostQueryResult["attribution"]; tokens: CostQueryResult["tokens"]; calibration: CostQueryResult["calibration"]; priceCatalog: CostQueryResult["priceCatalog"]; byStatus: EvidenceBucket[]; reconciliation: CostQueryResult["reconciliation"]; sourceWindow: SourceWindow };
  coverage: { evidenceIdentity: { present: number; missing: number }; judgePolicy: { present: number; missing: number }; learningTaskBinding: { present: number; missing: number }; retentionSourceWindow: Record<"adoptionEvidence" | "requestLog" | "delegations" | "costs", SourceWindow> };
  completeness: {
    requiredTables: Record<RequiredTable, true>;
    sourceRows: Record<"adoptionEvidence" | "admittedCompute" | "delegations" | "costs", number>;
    adoptionEvidence: AdoptionEvidenceRetention;
    missingness: { unknownOpportunityDenominators: number; unassessedAttemptedReports: number; missingDelegationVerifier: number; missingDelegationSource: number; missingDelegationUsefulness: number; missingCostValues: number; missingRequestTime: number; malformedTimestamps: number };
  };
  maturity: Array<{ area: string; label: MaturityLabel }>;
  nextAction: { action: NextAction; reason: string };
}

type RequiredTable = "adoption_evidence" | "request_log" | "delegations" | "delegation_costs";
const REQUIRED_DELEGATION_COST_COLUMNS = [
  "id",
  "ts",
  "delegation_id",
  "task_type",
  "local_model",
  "delegator_model",
  "delegator_model_source",
  "cost_status",
  "prompt_tokens",
  "completion_tokens",
  "total_tokens",
  ...DELEGATION_M5_COST_VALUE_COLUMNS,
  "verified_savings_actual_usd",
  "verified_savings_premium_usd",
  "potential_savings_actual_usd",
  "potential_savings_premium_usd",
  "price_catalog_version",
] as const;

const REQUIRED_TABLE_COLUMNS: Record<RequiredTable, readonly string[]> = {
  adoption_evidence: ["recorded_day", "harness", "execution_mode", "traffic_purpose", "result", "deterministic_check", "reviewer_usefulness", "fallback_reason", "eligible_opportunities"],
  request_log: ["id", "ts", "tier", "model", "node", "route", "admission", "total_ms"],
  delegations: ["id", "ts", "task_type", "node_id", "model_id", "outcome", "error_class", "verifier", "source", "shadow", "superseded_at", "evidence_identity_hash", "judge_policy", "learning_task_admission_id", "learning_task_instance_id", "learning_task_attempt_id", "reviewer_usefulness"],
  delegation_costs: REQUIRED_DELEGATION_COST_COLUMNS,
};

const KNOWN_MODEL_IDS = new Set(["mellum", "qwen3-30b-instruct", "gemma4", "vibethinker-3b", "qwen3-coder-next-80b", "gpt-oss-120b", "qwen35-122b-a10b", "muse-glimmer-30b", "nemotron-3.5-lightning-30b-a3b", "qwen38-27b", "ornith-1.5-35b", "image-fast", "image-balanced", "image-high"]);
const KNOWN_SOURCES = new Set(["gateway", "code-loop", "probe", "build-chunk", "cli", "mcp", "experiment-import", "harvest", "shadow-lane", "probe-import", "direct"]);

function tableColumns(db: Database.Database, table: string): Set<string> { return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name)); }

/** Validate every column used by this report without creating or migrating any schema. */
export function assertAdoptionEvidenceBundleSchema(db: Database.Database): void {
  for (const [table, columns] of Object.entries(REQUIRED_TABLE_COLUMNS) as Array<[RequiredTable, readonly string[]]>) {
    const exists = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { present: 1 } | undefined;
    if (!exists) throw new Error(`adoption evidence bundle requires table '${table}'`);
    const missing = columns.filter((column) => !tableColumns(db, table).has(column));
    if (missing.length > 0) throw new Error(`adoption evidence bundle requires columns in '${table}': ${missing.join(", ")}`);
  }
}

function parseStrictIso(name: string, value: string): number {
  if (!ISO_UTC.test(value)) throw new RangeError(`${name} must be an RFC3339 UTC timestamp with a fixed shape`);
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

function parseStoredEpochMs(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || !Number.isFinite(value)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? value : null;
}

function canonicalIso(time: number): string { return new Date(time).toISOString(); }

function rangeValue(current: string | null, candidate: string): string { return current === null || candidate < current ? candidate : current; }
function rangeMax(current: string | null, candidate: string): string { return current === null || candidate > current ? candidate : current; }
function emptySourceWindow(): SourceWindow { return { rows: 0, inWindow: 0, malformedTimestamp: 0, validMin: null, validMax: null }; }

function parseStoredDay(value: unknown): string | null {
  if (typeof value !== "string" || !DAY.test(value)) return null;
  const time = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? value : null;
}

export function validateEvidenceBundleWindow(window: EvidenceBundleWindow): void {
  const from = parseStrictIso("from", window.from); const through = parseStrictIso("throughExclusive", window.throughExclusive);
  if (through <= from) throw new RangeError("throughExclusive must be after from");
  if (from % DAY_MS !== 0 || through % DAY_MS !== 0) throw new RangeError("adoption evidence export bounds must be UTC calendar-day boundaries");
}

function finiteNumber(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
function emptyAggregate(): AdoptionAggregate { return { reports: 0, knownOpportunities: 0, attempted: 0, useful: 0, usefulAttemptedRatio: null, usefulness: Object.fromEntries(ADOPTION_USEFULNESS.map((value) => [value, 0])) as Record<AdoptionUsefulness, number>, unknownOpportunityDenominators: 0, unassessedAttempted: 0 }; }
function emptyBreakdownRow(bucket: string): AdoptionBreakdownRow { return { bucket, reports: 0, knownOpportunities: 0, attempted: 0, useful: 0 }; }
function breakdownMap(values: readonly string[]): Map<string, AdoptionBreakdownRow> { return new Map(values.map((value) => [value, emptyBreakdownRow(value)])); }
function bump(row: AdoptionBreakdownRow, opportunities: number, attempted: number, useful: number, reports = 1): void { row.reports += reports; row.knownOpportunities += opportunities; row.attempted += attempted; row.useful += useful; }
function closedValue(value: string, values: readonly string[]): string { return values.includes(value) ? value : "unknown"; }
// Emit zero rows for every fixed enum member. This keeps an empty category distinguishable from a
// missing/unknown category without allowing raw caller-controlled labels to become report keys.
function compareStrings(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function sortBreakdown(map: Map<string, AdoptionBreakdownRow>): AdoptionBreakdownRow[] { return [...map.values()].sort((a, b) => compareStrings(a.bucket, b.bucket)); }

function emptyOverflowAggregate(): AdoptionOverflowAggregate {
  return {
    reports: 0,
    knownOpportunities: 0,
    unknownOpportunityDenominators: 0,
    attempted: 0,
    useful: 0,
    completed: 0,
    unassessedAttempted: 0,
    deterministicChecks: 0,
    deterministicCheckPasses: 0,
    usefulness: Object.fromEntries(ADOPTION_USEFULNESS.map((value) => [value, 0])) as Record<AdoptionUsefulness, number>,
    fallbackCounts: Object.fromEntries(ADOPTION_FALLBACK_REASONS.map((value) => [value, 0])),
  };
}

function emptyOverflowQuery(): AdoptionOverflowQueryResult {
  return {
    sourceRows: 0,
    rows: 0,
    malformedDay: 0,
    validMin: null,
    validMax: null,
    aggregatedCount: 0,
    droppedCount: 0,
    cappedDays: [],
    affectedDays: [],
    perHarnessAttribution: "complete",
    byPurpose: { organic: emptyOverflowAggregate(), evaluation: emptyOverflowAggregate(), synthetic: emptyOverflowAggregate() },
    breakdowns: { result: breakdownMap(ADOPTION_RESULTS), usefulness: breakdownMap(ADOPTION_USEFULNESS), fallback: breakdownMap(ADOPTION_FALLBACK_REASONS) },
  };
}

/** The overflow table is optional for backwards-compatible read-only exports. */
function hasAdoptionOverflowTable(db: Database.Database): boolean {
  const found = db
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'adoption_evidence_overflow'")
    .get() as { present: 1 } | undefined;
  return found?.present === 1;
}

function validCount(value: unknown): number {
  return finiteNumber(value) && Number.isInteger(value) && value >= 0 ? value : 0;
}

function adoptionOverflowQuery(db: Database.Database, fromDay: string, throughDay: string): AdoptionOverflowQueryResult {
  if (!hasAdoptionOverflowTable(db)) return emptyOverflowQuery();
  const overflowColumns = tableColumns(db, "adoption_evidence_overflow");
  const unknownReports = overflowColumns.has("unknown_opportunity_reports")
    ? "unknown_opportunity_reports"
    : "CASE WHEN eligible_opportunities = 0 THEN report_count ELSE 0 END AS unknown_opportunity_reports";
  const all = db.prepare(`SELECT recorded_day, traffic_purpose, result, deterministic_check, reviewer_usefulness, fallback_reason, report_count, eligible_opportunities, ${unknownReports} FROM adoption_evidence_overflow ORDER BY rowid ASC`).all() as Array<Record<string, unknown>>;
  const output = emptyOverflowQuery();
  output.sourceRows = all.length;
  const cappedDays = new Set<string>();
  const affectedDays = new Set<string>();
  for (const row of all) {
    const day = parseStoredDay(row.recorded_day);
    if (!day) { output.malformedDay += 1; continue; }
    output.validMin = rangeValue(output.validMin, day);
    output.validMax = rangeMax(output.validMax, day);
    if (day < fromDay || day >= throughDay) continue;
    cappedDays.add(day);
    affectedDays.add(day);
    output.rows += 1;
    const reports = validCount(row.report_count);
    const opportunities = validCount(row.eligible_opportunities);
    const unknownOpportunityDenominators = validCount(row.unknown_opportunity_reports);
    output.aggregatedCount += reports;
    const purpose = closedValue(String(row.traffic_purpose ?? ""), ADOPTION_TRAFFIC_PURPOSES) as AdoptionTrafficPurpose;
    const result = closedValue(String(row.result ?? ""), ADOPTION_RESULTS);
    const check = closedValue(String(row.deterministic_check ?? ""), ADOPTION_CHECK_OUTCOMES);
    const usefulness = closedValue(String(row.reviewer_usefulness ?? ""), ADOPTION_USEFULNESS) as AdoptionUsefulness;
    const fallback = closedValue(String(row.fallback_reason ?? ""), ADOPTION_FALLBACK_REASONS);
    const attempted = ["completed", "refused", "failed"].includes(result) ? reports : 0;
    const useful = result === "completed" && check === "pass" && (usefulness === "pass" || usefulness === "partial") ? reports : 0;
    const dims: Array<[Map<string, AdoptionBreakdownRow>, string]> = [[output.breakdowns.result, result], [output.breakdowns.usefulness, usefulness], [output.breakdowns.fallback, fallback]];
    for (const [map, key] of dims) {
      const breakdown = map.get(key) ?? emptyBreakdownRow(key);
      map.set(key, breakdown);
      bump(breakdown, opportunities, attempted, useful, reports);
    }
    const item = output.byPurpose[purpose];
    if (!item) continue;
    item.reports += reports;
    item.knownOpportunities += opportunities;
    item.unknownOpportunityDenominators += unknownOpportunityDenominators;
    item.attempted += attempted;
    item.completed += result === "completed" ? reports : 0;
    item.useful += useful;
    item.unassessedAttempted += result === "completed" && (check === "not_run" || usefulness === "not_reported") ? reports : 0;
    item.deterministicChecks += check !== "not_run" ? reports : 0;
    item.deterministicCheckPasses += check === "pass" ? reports : 0;
    if ((usefulness as string) !== "unknown") item.usefulness[usefulness] += reports;
    if (fallback in item.fallbackCounts) item.fallbackCounts[fallback] += reports;
  }
  output.cappedDays = [...cappedDays].sort(compareStrings);
  output.affectedDays = [...affectedDays].sort(compareStrings);
  output.perHarnessAttribution = output.aggregatedCount > 0 ? "unavailable" : "complete";
  return output;
}

function mergeBreakdowns(target: Map<string, AdoptionBreakdownRow>, source: Map<string, AdoptionBreakdownRow>): void {
  for (const [bucket, row] of source) {
    const item = target.get(bucket) ?? emptyBreakdownRow(bucket);
    item.reports += row.reports;
    item.knownOpportunities += row.knownOpportunities;
    item.attempted += row.attempted;
    item.useful += row.useful;
    target.set(bucket, item);
  }
}

function adoptionQuery(db: Database.Database, fromDay: string, throughDay: string): AdoptionQueryResult {
  const aggregate: Record<AdoptionTrafficPurpose, AdoptionAggregate> = { organic: emptyAggregate(), evaluation: emptyAggregate(), synthetic: emptyAggregate() };
  const purpose = breakdownMap(ADOPTION_TRAFFIC_PURPOSES); const harness = breakdownMap(ADOPTION_HARNESSES); const mode = breakdownMap(ADOPTION_EXECUTION_MODES); const result = breakdownMap(ADOPTION_RESULTS); const usefulness = breakdownMap(ADOPTION_USEFULNESS); const fallback = breakdownMap(ADOPTION_FALLBACK_REASONS);
  const rows = db.prepare(`SELECT recorded_day, harness, execution_mode, traffic_purpose, result, deterministic_check, reviewer_usefulness, fallback_reason, eligible_opportunities FROM adoption_evidence ORDER BY rowid ASC`).all() as Array<Record<string, unknown>>;
  let malformedDay = 0; let inWindow = 0; let validMin: string | null = null; let validMax: string | null = null; const fallbackCoverage = { capacity: 0, transport: 0, access: 0, unknown: 0 };
  for (const row of rows) {
    const day = parseStoredDay(row.recorded_day); if (!day) { malformedDay += 1; continue; } validMin = rangeValue(validMin, day); validMax = rangeMax(validMax, day); if (day < fromDay || day >= throughDay) continue; inWindow += 1;
    const purposeValue = closedValue(String(row.traffic_purpose ?? ""), ADOPTION_TRAFFIC_PURPOSES); const harnessValue = closedValue(String(row.harness ?? ""), ADOPTION_HARNESSES); const modeValue = closedValue(String(row.execution_mode ?? ""), ADOPTION_EXECUTION_MODES); const resultValue = closedValue(String(row.result ?? ""), ADOPTION_RESULTS); const usefulnessValue = closedValue(String(row.reviewer_usefulness ?? ""), ADOPTION_USEFULNESS); const fallbackValue = closedValue(String(row.fallback_reason ?? ""), ADOPTION_FALLBACK_REASONS);
    const opportunities = finiteNumber(row.eligible_opportunities) && Number.isInteger(row.eligible_opportunities) && row.eligible_opportunities > 0 ? row.eligible_opportunities : 0; const attempted = ["completed", "refused", "failed"].includes(resultValue) ? 1 : 0; const useful = resultValue === "completed" && row.deterministic_check === "pass" && (usefulnessValue === "pass" || usefulnessValue === "partial") ? 1 : 0;
    const aggregateRow = aggregate[purposeValue as AdoptionTrafficPurpose];
    if (aggregateRow) {
      aggregateRow.reports += 1; aggregateRow.knownOpportunities += opportunities; aggregateRow.attempted += attempted; aggregateRow.useful += useful;
      if (usefulnessValue !== "unknown") aggregateRow.usefulness[usefulnessValue as AdoptionUsefulness] += 1;
      if (opportunities === 0) aggregateRow.unknownOpportunityDenominators += 1;
      const assessmentKnown = attempted === 0 || resultValue !== "completed" || ((ADOPTION_CHECK_OUTCOMES as readonly string[]).includes(String(row.deterministic_check)) && String(row.deterministic_check) !== "not_run" && usefulnessValue !== "not_reported" && usefulnessValue !== "unknown");
      if (!assessmentKnown) aggregateRow.unassessedAttempted += 1;
    }
    const dims: Array<[Map<string, AdoptionBreakdownRow>, string]> = [[purpose, purposeValue], [harness, harnessValue], [mode, modeValue], [result, resultValue], [usefulness, usefulnessValue], [fallback, fallbackValue]];
    for (const [map, key] of dims) { const item = map.get(key) ?? emptyBreakdownRow(key); map.set(key, item); bump(item, opportunities, attempted, useful); }
    if (fallbackValue === "m5_busy" || fallbackValue === "m5_refused") fallbackCoverage.capacity += 1; else if (fallbackValue === "m5_unreachable") fallbackCoverage.transport += 1; else if (fallbackValue === "m5_auth_unavailable" || fallbackValue === "m5_tool_missing") fallbackCoverage.access += 1; else if (fallbackValue !== "none") fallbackCoverage.unknown += 1;
  }
  for (const value of ADOPTION_TRAFFIC_PURPOSES) { const item = aggregate[value]; item.usefulAttemptedRatio = item.attempted > 0 ? item.useful / item.attempted : null; }
  const overflow = adoptionOverflowQuery(db, fromDay, throughDay);
  for (const purposeValue of ADOPTION_TRAFFIC_PURPOSES) {
    const aggregateRow = aggregate[purposeValue];
    const overflowRow = overflow.byPurpose[purposeValue];
    aggregateRow.reports += overflowRow.reports;
    aggregateRow.knownOpportunities += overflowRow.knownOpportunities;
    aggregateRow.attempted += overflowRow.attempted;
    aggregateRow.useful += overflowRow.useful;
    for (const usefulnessValue of ADOPTION_USEFULNESS) aggregateRow.usefulness[usefulnessValue] += overflowRow.usefulness[usefulnessValue];
    aggregateRow.unknownOpportunityDenominators += overflowRow.unknownOpportunityDenominators;
    aggregateRow.unassessedAttempted += overflowRow.unassessedAttempted;
    const purposeRow = purpose.get(purposeValue);
    if (purposeRow) {
      purposeRow.reports += overflowRow.reports;
      purposeRow.knownOpportunities += overflowRow.knownOpportunities;
      purposeRow.attempted += overflowRow.attempted;
      purposeRow.useful += overflowRow.useful;
    }
    for (const fallbackValue of ADOPTION_FALLBACK_REASONS) {
      const count = overflowRow.fallbackCounts[fallbackValue] ?? 0;
      if (fallbackValue === "m5_busy" || fallbackValue === "m5_refused") fallbackCoverage.capacity += count;
      else if (fallbackValue === "m5_unreachable") fallbackCoverage.transport += count;
      else if (fallbackValue === "m5_auth_unavailable" || fallbackValue === "m5_tool_missing") fallbackCoverage.access += count;
      else if (fallbackValue !== "none") fallbackCoverage.unknown += count;
    }
  }
  mergeBreakdowns(result, overflow.breakdowns.result);
  mergeBreakdowns(usefulness, overflow.breakdowns.usefulness);
  mergeBreakdowns(fallback, overflow.breakdowns.fallback);
  for (const value of ADOPTION_TRAFFIC_PURPOSES) { const item = aggregate[value]; item.usefulAttemptedRatio = item.attempted > 0 ? item.useful / item.attempted : null; }
  return { aggregate, breakdowns: { purpose: sortBreakdown(purpose), harness: sortBreakdown(harness), mode: sortBreakdown(mode), result: sortBreakdown(result), usefulness: sortBreakdown(usefulness), fallback: sortBreakdown(fallback) }, sourceRows: rows.length, rows: inWindow, malformedDay, validMin, validMax, fallbackCoverage, overflow };
}

function bucketTask(value: unknown): string { return typeof value === "string" && isKnownTaskType(value) ? value : "other"; }
function bucketModel(value: unknown): string { if (typeof value !== "string" || value.trim() === "") return "unknown"; if (value === "unknown") return "unknown"; return KNOWN_MODEL_IDS.has(value) ? value : "other"; }
function bucketSource(value: unknown): string { if (typeof value !== "string" || value.trim() === "") return "unknown"; if (KNOWN_SOURCES.has(value)) return value; if (value.startsWith("probe")) return "probe"; if (value.startsWith("code-loop")) return "code-loop"; if (value.startsWith("gateway")) return "gateway"; return "other"; }
function bucketOutcome(value: unknown): DelegationMatrixRow["outcome"] { return ["pass", "partial", "fail", "error", "unverified"].includes(String(value)) ? value as DelegationMatrixRow["outcome"] : "other"; }
function bucketRows(rows: Array<{ bucket: string; attempted: number; useful: number }>): EvidenceBucket[] { const map = new Map<string, EvidenceBucket>(); for (const row of rows) { const item = map.get(row.bucket) ?? { bucket: row.bucket, rows: 0, attempted: 0, useful: 0 }; item.rows += 1; item.attempted += row.attempted; item.useful += row.useful; map.set(row.bucket, item); } return [...map.values()].sort((a, b) => compareStrings(a.bucket, b.bucket)); }
function presence(value: unknown): boolean { return typeof value === "string" ? value.trim().length > 0 : value !== null && value !== undefined; }
function validIdentityHash(value: unknown): boolean { return typeof value === "string" && SHA256.test(value); }
function validReviewerUsefulness(value: unknown): boolean { return value === "pass" || value === "partial" || value === "redo" || value === "wrong"; }
function completeLearningTaskBinding(row: Record<string, unknown>): boolean {
  return presence(row.learning_task_admission_id) && presence(row.learning_task_instance_id) && presence(row.learning_task_attempt_id);
}
type DelegationState = "currentM5" | "shadowM5" | "supersededM5" | "shadowAndSupersededM5" | "nonM5" | "invalid";
function delegationState(row: Record<string, unknown>): DelegationState {
  if (!presence(row.node_id) || (row.shadow !== 0 && row.shadow !== 1)) return "invalid";
  const superseded = row.superseded_at === null || parseStoredIso(row.superseded_at) !== null;
  if (!superseded) return "invalid";
  if (row.node_id !== "m5") return "nonM5";
  if (row.shadow === 1 && row.superseded_at !== null) return "shadowAndSupersededM5";
  if (row.shadow === 1) return "shadowM5";
  if (row.superseded_at !== null) return "supersededM5";
  return "currentM5";
}

function delegationQuery(db: Database.Database, fromMs: number, throughMs: number): DelegationQueryResult {
  const all = db.prepare(`SELECT id, ts, task_type, node_id, model_id, outcome, error_class, verifier, source, shadow, superseded_at, evidence_identity_hash, judge_policy, learning_task_admission_id, learning_task_instance_id, learning_task_attempt_id, reviewer_usefulness FROM delegations ORDER BY rowid ASC`).all() as Array<Record<string, unknown>>;
  const inWindow: Array<Record<string, unknown>> = []; let malformedTimestamp = 0; let validMin: string | null = null; let validMax: string | null = null;
  for (const row of all) { const ts = parseStoredIso(row.ts); if (ts === null) malformedTimestamp += 1; else { const canonical = canonicalIso(ts); validMin = rangeValue(validMin, canonical); validMax = rangeMax(validMax, canonical); if (ts >= fromMs && ts < throughMs) inWindow.push(row); } }
  const coverage = { evidenceIdentity: { present: 0, missing: 0 }, judgePolicy: { present: 0, missing: 0 }, learningTaskBinding: { present: 0, missing: 0 } };
  const current: Array<Record<string, unknown>> = [];
  const stateCounts = { currentM5: 0, shadowM5: 0, supersededM5: 0, shadowAndSupersededM5: 0, nonM5: 0, invalid: 0 };
  let policyCurrent = 0; let policyStale = 0; let policyMissing = 0; let currentIdentityPresent = 0; let currentIdentityMissing = 0;
  for (const row of inWindow) {
    const identityComplete = validIdentityHash(row.evidence_identity_hash);
    (identityComplete ? coverage.evidenceIdentity.present++ : coverage.evidenceIdentity.missing++);
    (presence(row.judge_policy) ? coverage.judgePolicy.present++ : coverage.judgePolicy.missing++);
    const bound = completeLearningTaskBinding(row);
    (bound ? coverage.learningTaskBinding.present++ : coverage.learningTaskBinding.missing++);
    const state = delegationState(row); stateCounts[state] += 1;
    if (state === "currentM5") current.push(row);
  }
  for (const row of current) {
    if (validIdentityHash(row.evidence_identity_hash)) currentIdentityPresent += 1; else currentIdentityMissing += 1;
    if (!presence(row.judge_policy)) policyMissing += 1;
    else if (isCurrentPolicy(String(row.judge_policy))) policyCurrent += 1;
    else policyStale += 1;
  }
  const matrixMap = new Map<string, DelegationMatrixRow>();
  for (const row of current) {
    const task = bucketTask(row.task_type); const model = bucketModel(row.model_id); const verifier = classifyVerifierKind(typeof row.verifier === "string" ? row.verifier : null); const source = bucketSource(row.source); const outcome = bucketOutcome(row.outcome); const key = [task, model, verifier, source, outcome].join("\u001f");
    const reviewer = validReviewerUsefulness(row.reviewer_usefulness) ? String(row.reviewer_usefulness) : "missing";
    const item = matrixMap.get(key) ?? { task, model, verifier, source, outcome, rows: 0, infraErrors: 0, reviewerUsefulness: Object.fromEntries([...ADOPTION_USEFULNESS, "missing"].map((v) => [v, 0])) };
    item.rows += 1; if (row.outcome === "error" && row.error_class === "infra") item.infraErrors += 1; item.reviewerUsefulness[reviewer] = (item.reviewerUsefulness[reviewer] ?? 0) + 1; matrixMap.set(key, item);
  }
  const matrix = [...matrixMap.values()].sort((a, b) => compareStrings([a.task, a.model, a.verifier, a.source, a.outcome].join("\u001f"), [b.task, b.model, b.verifier, b.source, b.outcome].join("\u001f")));
  const by = (key: "task_type" | "model_id" | "verifier" | "source"): EvidenceBucket[] => bucketRows(current.map((row) => ({ bucket: key === "task_type" ? bucketTask(row[key]) : key === "model_id" ? bucketModel(row[key]) : key === "verifier" ? classifyVerifierKind(typeof row[key] === "string" ? row[key] : null) : bucketSource(row[key]), attempted: 1, useful: row.reviewer_usefulness === "pass" || row.reviewer_usefulness === "partial" ? 1 : 0 })));
  const currentIds = new Set(current.filter((row) => typeof row.id === "string").map((row) => row.id as string));
  const currentReviewerUsefulness = { present: current.filter((row) => validReviewerUsefulness(row.reviewer_usefulness)).length, missing: current.filter((row) => !validReviewerUsefulness(row.reviewer_usefulness)).length };
  const policyApplicability = current.length === 0 ? "no-current-m5-evidence" : policyCurrent === current.length ? "current" : policyCurrent > 0 ? "mixed" : "historical-or-missing";
  const currentBindingPresent = current.filter(completeLearningTaskBinding).length;
  const currentBindingMissing = current.length - currentBindingPresent;
  return { sourceRows: all.length, rows: inWindow.length, currentRows: current.length, malformedTimestamp, validMin, validMax, matrix, byTask: by("task_type"), byModel: by("model_id"), byVerifier: by("verifier"), bySource: by("source"), reviewerUsefulness: currentReviewerUsefulness, infraErrors: current.filter((row) => row.outcome === "error" && row.error_class === "infra").length, unverified: current.filter((row) => row.outcome === "unverified").length, currentIds, coverage, stateCounts: { scope: "valid-timestamped delegation rows in the exact bounded window", ...stateCounts, reconciliation: { inWindow: inWindow.length, classified: Object.values(stateCounts).reduce((sum, value) => sum + value, 0), allMatch: Object.values(stateCounts).reduce((sum, value) => sum + value, 0) === inWindow.length } }, currentEvidenceIdentity: { present: currentIdentityPresent, missing: currentIdentityMissing }, judgePolicy: { epoch: HARVEST_JUDGE_POLICY, current: policyCurrent, stale: policyStale, missing: policyMissing, applicability: policyApplicability }, learningTaskBinding: { scope: "current-M5 delegation rows in the exact bounded window", currentM5: current.length, required: current.length, present: currentBindingPresent, missing: currentBindingMissing, notRequired: 0, nonCurrentExcluded: inWindow.length - current.length } };
}

function emptyCostTotals(): CostTotals { return { rows: 0, m5TotalUsd: null, verifiedSavingsActualUsd: null, verifiedSavingsPremiumUsd: null, potentialSavingsActualUsd: null, potentialSavingsPremiumUsd: null, missingValues: 0, confidence: "unknowable" }; }
function costTotals(rows: Array<Record<string, unknown>>, confidence: CostTotals["confidence"]): CostTotals { if (rows.length === 0) return emptyCostTotals(); const keys = ["m5_marginal_cost_usd", "m5_amortized_cost_usd", "m5_total_cost_usd", "verified_savings_actual_usd", "verified_savings_premium_usd", "potential_savings_actual_usd", "potential_savings_premium_usd"] as const; const missingValues = rows.filter((row) => keys.some((key) => !finiteNumber(row[key]))).length; const sum = (key: (typeof keys)[number]): number | null => confidence !== "complete" || missingValues > 0 ? null : roundUsd(rows.reduce((total, row) => total + (row[key] as number), 0)); return { rows: rows.length, m5TotalUsd: sum("m5_total_cost_usd"), verifiedSavingsActualUsd: sum("verified_savings_actual_usd"), verifiedSavingsPremiumUsd: sum("verified_savings_premium_usd"), potentialSavingsActualUsd: sum("potential_savings_actual_usd"), potentialSavingsPremiumUsd: sum("potential_savings_premium_usd"), missingValues, confidence }; }

function costQuery(db: Database.Database, fromMs: number, throughMs: number, currentIds: Set<string>, currentDelegationCount: number): CostQueryResult {
  const all = db.prepare(`SELECT id, ts, delegation_id, task_type, local_model, delegator_model, delegator_model_source, cost_status, prompt_tokens, completion_tokens, total_tokens, m5_marginal_cost_usd, m5_amortized_cost_usd, m5_total_cost_usd, verified_savings_actual_usd, verified_savings_premium_usd, potential_savings_actual_usd, potential_savings_premium_usd, price_catalog_version FROM delegation_costs ORDER BY rowid ASC`).all() as Array<Record<string, unknown>>;
  const inWindow: Array<Record<string, unknown>> = []; let malformedTimestamp = 0; let validMin: string | null = null; let validMax: string | null = null; for (const row of all) { const ts = parseStoredIso(row.ts); if (ts === null) malformedTimestamp += 1; else { const canonical = canonicalIso(ts); validMin = rangeValue(validMin, canonical); validMax = rangeMax(validMax, canonical); if (ts >= fromMs && ts < throughMs) inWindow.push(row); } }
  const reconciled = inWindow.filter((row) => typeof row.delegation_id === "string" && currentIds.has(row.delegation_id)); const unlinked = inWindow.filter((row) => !presence(row.delegation_id)); const unreconciled = inWindow.filter((row) => !unlinked.includes(row) && !reconciled.includes(row));
  const linkedCounts = new Map<string, number>();
  for (const row of reconciled) {
    if (typeof row.delegation_id === "string") linkedCounts.set(row.delegation_id, (linkedCounts.get(row.delegation_id) ?? 0) + 1);
  }
  const reconciledDelegations = linkedCounts.size;
  const duplicateLinks = [...linkedCounts.values()].filter((count) => count > 1).length;
  const duplicateRows = [...linkedCounts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0);
  const reconciliation = {
    currentDelegations: currentDelegationCount,
    linkedRows: reconciled.length,
    linkedDelegations: reconciledDelegations,
    missingDelegations: Math.max(0, currentDelegationCount - reconciledDelegations),
    duplicateLinks,
    duplicateRows,
    unlinkedRows: unlinked.length,
    unreconciledRows: unreconciled.length,
    exactlyOnePerCurrentDelegation: currentDelegationCount === currentIds.size && reconciledDelegations === currentDelegationCount && duplicateLinks === 0 && duplicateRows === 0,
  };
  const attribution = { delegatorModel: { present: reconciled.filter((r) => presence(r.delegator_model)).length, missing: reconciled.filter((r) => !presence(r.delegator_model)).length }, source: { stamped: reconciled.filter((r) => r.delegator_model_source === "stamped").length, default: reconciled.filter((r) => r.delegator_model_source === "default").length, missing: reconciled.filter((r) => r.delegator_model_source === null || r.delegator_model_source === undefined).length, unknown: reconciled.filter((r) => !["stamped", "default", null, undefined].includes(r.delegator_model_source as never)).length } };
  const coverage = (key: string) => ({ present: reconciled.filter((r) => finiteNumber(r[key])).length, missing: reconciled.filter((r) => !finiteNumber(r[key])).length }); const tokens = { prompt: coverage("prompt_tokens"), completion: coverage("completion_tokens"), total: coverage("total_tokens") };
  const calibration = { present: reconciled.filter((r) => ["m5_marginal_cost_usd", "m5_amortized_cost_usd", "m5_total_cost_usd"].every((k) => finiteNumber(r[k]) && (r[k] as number) > 0)).length, missing: 0 }; calibration.missing = reconciled.length - calibration.present;
  const priceCatalog = { present: reconciled.filter((r) => presence(r.price_catalog_version)).length, missing: reconciled.filter((r) => !presence(r.price_catalog_version)).length, unrecognized: reconciled.filter((r) => presence(r.price_catalog_version) && r.price_catalog_version !== DEFAULT_COST_CATALOG_VERSION).length };
  const byStatus = bucketRows(inWindow.map((r) => ({ bucket: ["verified", "unverified", "failed", "escalated", "not_applicable"].includes(String(r.cost_status)) ? String(r.cost_status) : "unknown", attempted: 1, useful: 0 })));
  const confidence: CostTotals["confidence"] = reconciled.length === 0 ? "unknowable" : reconciliation.exactlyOnePerCurrentDelegation && attribution.source.stamped === reconciled.length && attribution.delegatorModel.missing === 0 && calibration.missing === 0 && priceCatalog.missing === 0 && priceCatalog.unrecognized === 0 && tokens.prompt.missing === 0 && tokens.completion.missing === 0 && tokens.total.missing === 0 ? "complete" : "partial";
  return { sourceRows: all.length, rows: inWindow.length, malformedTimestamp, validMin, validMax, reconciled: costTotals(reconciled, confidence), unlinked: costTotals(unlinked, "unknowable"), unreconciled: costTotals(unreconciled, "unknowable"), reconciledDelegations, attribution, tokens, calibration, priceCatalog, byStatus, reconciliation };
}

function computeQuery(db: Database.Database, fromMs: number, throughMs: number): AdoptionEvidenceBundle["admittedCompute"] {
  const all = db.prepare(`SELECT ts, tier, model, node, route, admission, total_ms FROM request_log ORDER BY rowid ASC`).all() as Array<Record<string, unknown>>;
  const sourceWindow = emptySourceWindow(); sourceWindow.rows = all.length;
  const exclusions = { malformedTimestamp: 0, node: { m5: 0, nonM5: 0, missing: 0 }, admission: { admitted: 0, notAdmitted: 0, missing: 0 }, model: { none: 0, present: 0, missing: 0 }, route: { included: 0, excluded: 0, missing: 0 } };
  const rows: Array<Record<string, unknown>> = [];
  for (const row of all) {
    const timestamp = parseStoredEpochMs(row.ts);
    if (timestamp === null) {
      sourceWindow.malformedTimestamp += 1; exclusions.malformedTimestamp += 1;
      continue;
    }
    const canonical = canonicalIso(timestamp); sourceWindow.validMin = rangeValue(sourceWindow.validMin, canonical); sourceWindow.validMax = rangeMax(sourceWindow.validMax, canonical);
    if (timestamp >= fromMs && timestamp < throughMs) {
      sourceWindow.inWindow += 1;
      if (row.node === "m5") exclusions.node.m5 += 1; else if (presence(row.node)) exclusions.node.nonM5 += 1; else exclusions.node.missing += 1;
      if (row.admission === "admitted") exclusions.admission.admitted += 1; else if (presence(row.admission)) exclusions.admission.notAdmitted += 1; else exclusions.admission.missing += 1;
      if (row.model === "none") exclusions.model.none += 1; else if (presence(row.model)) exclusions.model.present += 1; else exclusions.model.missing += 1;
      if ((M5_COMPUTE_ROUTES as readonly string[]).includes(String(row.route))) exclusions.route.included += 1; else if (presence(row.route)) exclusions.route.excluded += 1; else exclusions.route.missing += 1;
      if (isAdmittedM5ComputeRequest(row as { node: string; route: string; model: string; admission: string })) rows.push(row);
    }
  }
  const bucketFor = (row: Record<string, unknown>, key: "tier" | "route" | "node" | "model" | "day"): string => {
    if (key === "day") return new Date(row.ts as number).toISOString().slice(0, 10);
    if (key === "model") return bucketModel(row.model);
    if (key === "tier") return ["owner", "guest"].includes(String(row.tier)) ? String(row.tier) : "other";
    if (key === "node") return row.node === "m5" || row.node === "orin" ? String(row.node) : "other";
    return (M5_COMPUTE_ROUTES as readonly string[]).includes(String(row.route)) ? String(row.route) : "other";
  };
  const dimension = (key: "tier" | "route" | "node" | "model" | "day"): ComputeBucket[] => {
    const map = new Map<string, ComputeBucket>();
    for (const row of rows) {
      const bucket = bucketFor(row, key);
      const item = map.get(bucket) ?? { bucket, requests: 0, requestTimeMs: 0 };
      item.requests += 1;
      if (finiteNumber(row.total_ms) && Number.isInteger(row.total_ms) && row.total_ms >= 0) item.requestTimeMs += row.total_ms;
      map.set(bucket, item);
    }
    return [...map.values()].sort((a, b) => compareStrings(a.bucket, b.bucket));
  };
  const day = dimension("day"); const tier = dimension("tier"); const route = dimension("route"); const node = dimension("node"); const model = dimension("model");
  const total = rows.length; const validDuration = (row: Record<string, unknown>): row is Record<string, number> => finiteNumber(row.total_ms) && Number.isInteger(row.total_ms) && row.total_ms >= 0; const missingRequestTime = rows.filter((row) => !validDuration(row)).length; const time = rows.reduce((sum, row) => sum + (validDuration(row) ? row.total_ms : 0), 0);
  const count = (items: ComputeBucket[]) => items.reduce((sum, item) => sum + item.requests, 0);
  const timeFor = (items: ComputeBucket[]) => items.reduce((sum, item) => sum + item.requestTimeMs, 0);
  const countReconciliation = { total, byDay: count(day), byTier: count(tier), byRoute: count(route), byNode: count(node), byModel: count(model), allMatch: false };
  const timeReconciliation = { total: time, byDay: timeFor(day), byTier: timeFor(tier), byRoute: timeFor(route), byNode: timeFor(node), byModel: timeFor(model), allMatch: false };
  countReconciliation.allMatch = [countReconciliation.byDay, countReconciliation.byTier, countReconciliation.byRoute, countReconciliation.byNode, countReconciliation.byModel].every((v) => v === total);
  timeReconciliation.allMatch = missingRequestTime === 0 && [timeReconciliation.byDay, timeReconciliation.byTier, timeReconciliation.byRoute, timeReconciliation.byNode, timeReconciliation.byModel].every((v) => v === time);
  const exclusionReconciliation = { inWindow: sourceWindow.inWindow, byNode: Object.values(exclusions.node).reduce((sum, value) => sum + value, 0), byAdmission: Object.values(exclusions.admission).reduce((sum, value) => sum + value, 0), byModel: Object.values(exclusions.model).reduce((sum, value) => sum + value, 0), byRoute: Object.values(exclusions.route).reduce((sum, value) => sum + value, 0), allMatch: false };
  exclusionReconciliation.allMatch = [exclusionReconciliation.byNode, exclusionReconciliation.byAdmission, exclusionReconciliation.byModel, exclusionReconciliation.byRoute].every((value) => value === sourceWindow.inWindow);
  return { filter: { epoch: COMPUTE_REQUEST_FILTER_EPOCH, sql: COMPUTE_REQUEST_FILTER_SQL, node: "m5", admission: "admitted", excludedModel: "none", routes: M5_COMPUTE_ROUTES, bounds: { from: canonicalIso(fromMs), throughExclusive: canonicalIso(throughMs), comparison: "ts >= from AND ts < throughExclusive after exact predicate", timestampShape: "integer epoch milliseconds; malformed values excluded and counted" }, historicalApplicability: { status: "unknown", ambiguousRows: total, reason: "request_log rows do not carry the m5-admitted-compute-v2 filter epoch; every current-filter-matched row is unversioned, so historical comparison and promotion applicability remain unknown" } }, requests: total, requestTimeMs: time, missingRequestTime, byDay: day, byTier: tier, byRoute: route, byNode: node, byModel: model, reconciliation: { count: countReconciliation, requestTimeMs: timeReconciliation }, exclusions: { ...exclusions, reconciliation: exclusionReconciliation }, sourceWindow };
}

function thresholdKnown(aggregate: AdoptionAggregate): EvidenceThreshold { if (aggregate.reports === 0 || aggregate.knownOpportunities === 0) return { status: "unknowable", observed: null, required: 20, reason: "no known opportunity denominator was reported" }; return { status: aggregate.knownOpportunities >= 20 ? "pass" : "fail", observed: aggregate.knownOpportunities, required: 20, reason: aggregate.knownOpportunities >= 20 ? "minimum known opportunity sample reached" : "known opportunity sample is below the minimum" }; }
function thresholdUseful(aggregate: AdoptionAggregate): EvidenceThreshold { if (aggregate.attempted === 0 || aggregate.unassessedAttempted > 0) return { status: "unknowable", observed: aggregate.usefulAttemptedRatio, required: 0.6, reason: aggregate.attempted === 0 ? "no attempted delegation was reported" : "one or more attempts lack a complete usefulness assessment" }; return { status: aggregate.usefulAttemptedRatio !== null && aggregate.usefulAttemptedRatio >= 0.6 ? "pass" : "fail", observed: aggregate.usefulAttemptedRatio, required: 0.6, reason: aggregate.usefulAttemptedRatio !== null && aggregate.usefulAttemptedRatio >= 0.6 ? "useful-attempted ratio reached the minimum" : "useful-attempted ratio is below the minimum" }; }
function chooseNextAction(bundle: { adoption: AdoptionEvidenceBundle["adoption"]; admittedCompute: AdoptionEvidenceBundle["admittedCompute"]; delegations: AdoptionEvidenceBundle["delegations"]; cost: AdoptionEvidenceBundle["cost"] }): { action: NextAction; reason: string } {
  const malformed = bundle.adoption.sourceWindow.malformedTimestamp + bundle.admittedCompute.sourceWindow.malformedTimestamp + bundle.delegations.sourceWindow.malformedTimestamp + bundle.cost.sourceWindow.malformedTimestamp;
  const currentRows = bundle.delegations.currentRows;
  const readiness = bundle.delegations.promotionReadiness;
  const currentEvidenceIncomplete = currentRows > 0 && (!readiness.evidenceIdentityComplete || !readiness.judgePolicyCurrent || !readiness.learningTaskBindingComplete || !readiness.stateUnambiguous || !readiness.reviewerUsefulnessComplete || !readiness.costCoverageComplete || !readiness.computeReconciliationComplete || !readiness.historicalMetricUnambiguous);
  if (malformed > 0 || bundle.admittedCompute.missingRequestTime > 0 || !readiness.stateUnambiguous || !readiness.computeReconciliationComplete || bundle.cost.unreconciled.rows > 0 || bundle.cost.unlinked.rows > 0 || bundle.adoption.fallbackCoverage.unknown > 0 || bundle.adoption.overflow.aggregatedCount > 0 || bundle.adoption.overflow.droppedCount > 0 || currentEvidenceIncomplete) return { action: "repair_measurement", reason: bundle.adoption.overflow.aggregatedCount > 0 || bundle.adoption.overflow.droppedCount > 0 ? "adoption evidence retention is capped; overflow cannot support complete promotion evidence" : "timestamp, duration, policy, identity, binding, state, cost, fallback, or reconciliation coverage is incomplete" };
  const organic = bundle.adoption.byPurpose.organic;
  if (organic.reports === 0 || organic.knownOpportunities === 0 || bundle.adoption.fallbackCoverage.capacity + bundle.adoption.fallbackCoverage.transport + bundle.adoption.fallbackCoverage.access > 0) return { action: "improve_agent_access", reason: "organic adoption access or opportunity-denominator evidence is insufficient" };
  if (readiness.eligible) return { action: "propose_separately_reviewed_lane_promotion", reason: "both preregistered organic thresholds pass with complete current-M5 evidence" };
  return { action: "keep_routing_shadow", reason: "adoption evidence has not earned a routing change" };
}

/** Build a bundle from an already-open query-only database; this function performs SELECTs only. */
export function buildAdoptionEvidenceBundle(db: Database.Database, options: EvidenceBundleOptions): AdoptionEvidenceBundle {
  validateEvidenceBundleWindow(options);
  const fromMs = parseStrictIso("from", options.from);
  const throughMs = parseStrictIso("throughExclusive", options.throughExclusive);
  const fromDay = new Date(fromMs).toISOString().slice(0, 10);
  const throughDay = new Date(throughMs).toISOString().slice(0, 10);
  assertAdoptionEvidenceBundleSchema(db);
  const admittedCompute = computeQuery(db, fromMs, throughMs);
  const adoptionQueryResult = adoptionQuery(db, fromDay, throughDay);
  const delegation = delegationQuery(db, fromMs, throughMs);
  const cost = costQuery(db, fromMs, throughMs, delegation.currentIds, delegation.currentRows);
  const generatedAt = options.generatedAt ?? options.throughExclusive;
  parseStrictIso("generatedAt", generatedAt);
  const adoptionFilter: BoundedFilter = { from: options.from, throughExclusive: options.throughExclusive, comparison: "recorded_day >= UTC day(from) AND recorded_day < UTC day(throughExclusive); exact day bounds are required", timestampShape: "YYYY-MM-DD UTC calendar day; malformed values excluded and counted" };
  const timestampFilter: BoundedFilter = { from: options.from, throughExclusive: options.throughExclusive, comparison: "ts >= from AND ts < throughExclusive", timestampShape: "RFC3339 UTC with fixed YYYY-MM-DDTHH:mm:ss[.sss]Z shape; malformed values excluded and counted" };
  const sourceWindows = {
    adoptionEvidence: { rows: adoptionQueryResult.sourceRows, inWindow: adoptionQueryResult.rows, malformedTimestamp: adoptionQueryResult.malformedDay, validMin: adoptionQueryResult.validMin, validMax: adoptionQueryResult.validMax },
    requestLog: admittedCompute.sourceWindow,
    delegations: { rows: delegation.sourceRows, inWindow: delegation.rows, malformedTimestamp: delegation.malformedTimestamp, validMin: delegation.validMin, validMax: delegation.validMax },
    costs: { rows: cost.sourceRows, inWindow: cost.rows, malformedTimestamp: cost.malformedTimestamp, validMin: cost.validMin, validMax: cost.validMax },
  };
  const adoptionRetention: AdoptionEvidenceRetention = {
    retainedIndividualCount: adoptionQueryResult.rows,
    aggregatedCount: adoptionQueryResult.overflow.aggregatedCount,
    // The overflow schema has no durable dropped counter. Keep this explicit and conservative:
    // absence of durable evidence is not converted into an invented loss count.
    droppedCount: adoptionQueryResult.overflow.droppedCount,
    cappedDays: adoptionQueryResult.overflow.cappedDays,
    affectedDays: adoptionQueryResult.overflow.affectedDays,
    perHarnessAttribution: adoptionQueryResult.overflow.perHarnessAttribution,
    complete: adoptionQueryResult.overflow.aggregatedCount === 0 && adoptionQueryResult.overflow.droppedCount === 0,
  };
  const organic = adoptionQueryResult.aggregate.organic;
  const stateUnambiguous = delegation.stateCounts.reconciliation.allMatch && delegation.stateCounts.invalid === 0 && delegation.stateCounts.shadowAndSupersededM5 === 0;
  const costCoverageComplete = delegation.currentRows > 0 && cost.reconciledDelegations === delegation.currentRows && cost.reconciliation.exactlyOnePerCurrentDelegation && cost.unlinked.rows === 0 && cost.unreconciled.rows === 0 && cost.reconciled.confidence === "complete";
  const promotionReadiness = {
    evidenceIdentityComplete: delegation.currentRows > 0 && delegation.currentEvidenceIdentity.present === delegation.currentRows,
    judgePolicyCurrent: delegation.currentRows > 0 && delegation.judgePolicy.current === delegation.currentRows,
    learningTaskBindingComplete: delegation.learningTaskBinding.currentM5 === delegation.currentRows && delegation.learningTaskBinding.required === delegation.currentRows && delegation.learningTaskBinding.present === delegation.currentRows && delegation.learningTaskBinding.missing === 0 && delegation.learningTaskBinding.notRequired === 0,
    stateUnambiguous,
    reviewerUsefulnessComplete: delegation.currentRows > 0 && delegation.reviewerUsefulness.missing === 0,
    costCoverageComplete,
    computeReconciliationComplete: admittedCompute.reconciliation.count.allMatch && admittedCompute.reconciliation.requestTimeMs.allMatch && admittedCompute.exclusions.reconciliation.allMatch,
    historicalMetricUnambiguous: admittedCompute.filter.historicalApplicability.status !== "unknown" && admittedCompute.filter.historicalApplicability.ambiguousRows === 0,
    eligible: false,
  };
  promotionReadiness.eligible = adoptionRetention.complete && promotionReadiness.evidenceIdentityComplete && promotionReadiness.judgePolicyCurrent && promotionReadiness.learningTaskBindingComplete && promotionReadiness.stateUnambiguous && promotionReadiness.reviewerUsefulnessComplete && promotionReadiness.costCoverageComplete && promotionReadiness.computeReconciliationComplete && promotionReadiness.historicalMetricUnambiguous && adoptionQueryResult.aggregate.organic.knownOpportunities >= 20 && adoptionQueryResult.aggregate.organic.unassessedAttempted === 0 && adoptionQueryResult.aggregate.organic.attempted > 0 && adoptionQueryResult.aggregate.organic.useful / adoptionQueryResult.aggregate.organic.attempted >= 0.6 && delegation.matrix.length > 0;
  const withoutLabels = {
    contract: ADOPTION_EVIDENCE_BUNDLE_CONTRACT,
    version: ADOPTION_EVIDENCE_BUNDLE_VERSION,
    generatedAt,
    window: { from: options.from, throughExclusive: options.throughExclusive },
    admittedCompute,
    adoption: { filter: adoptionFilter, byPurpose: adoptionQueryResult.aggregate, breakdowns: adoptionQueryResult.breakdowns, fallbackCoverage: adoptionQueryResult.fallbackCoverage, thresholds: { knownOpportunities: thresholdKnown(organic), usefulAttemptedRatio: thresholdUseful(organic) }, overflow: { ...adoptionRetention, byPurpose: adoptionQueryResult.overflow.byPurpose }, sourceWindow: sourceWindows.adoptionEvidence },
    delegations: { filter: timestampFilter, rows: delegation.currentRows, currentRows: delegation.currentRows, attempted: delegation.currentRows, useful: delegation.byTask.reduce((sum, item) => sum + item.useful, 0), unverified: delegation.unverified, infraErrors: delegation.infraErrors, reviewerUsefulness: delegation.reviewerUsefulness, byTask: delegation.byTask, byModel: delegation.byModel, byVerifier: delegation.byVerifier, bySource: delegation.bySource, matrix: delegation.matrix, coverage: delegation.coverage, stateCounts: delegation.stateCounts, judgePolicy: delegation.judgePolicy, learningTaskBinding: delegation.learningTaskBinding, promotionReadiness, sourceWindow: sourceWindows.delegations },
    cost: { filter: timestampFilter, ...cost, sourceWindow: sourceWindows.costs },
    coverage: { evidenceIdentity: delegation.coverage.evidenceIdentity, judgePolicy: delegation.coverage.judgePolicy, learningTaskBinding: delegation.coverage.learningTaskBinding, retentionSourceWindow: sourceWindows },
    completeness: { requiredTables: { adoption_evidence: true as const, request_log: true as const, delegations: true as const, delegation_costs: true as const }, sourceRows: { adoptionEvidence: sourceWindows.adoptionEvidence.rows, admittedCompute: sourceWindows.requestLog.rows, delegations: sourceWindows.delegations.rows, costs: sourceWindows.costs.rows }, adoptionEvidence: adoptionRetention, missingness: { unknownOpportunityDenominators: Object.values(adoptionQueryResult.aggregate).reduce((sum, item) => sum + item.unknownOpportunityDenominators, 0), unassessedAttemptedReports: Object.values(adoptionQueryResult.aggregate).reduce((sum, item) => sum + item.unassessedAttempted, 0), missingDelegationVerifier: delegation.currentRows - delegation.byVerifier.filter((item) => item.bucket !== "ungraded").reduce((sum, item) => sum + item.rows, 0), missingDelegationSource: delegation.currentRows - delegation.bySource.filter((item) => item.bucket !== "unknown").reduce((sum, item) => sum + item.rows, 0), missingDelegationUsefulness: delegation.reviewerUsefulness.missing, missingCostValues: cost.reconciled.missingValues, missingRequestTime: admittedCompute.missingRequestTime, malformedTimestamps: sourceWindows.adoptionEvidence.malformedTimestamp + sourceWindows.requestLog.malformedTimestamp + sourceWindows.delegations.malformedTimestamp + sourceWindows.costs.malformedTimestamp } },
  };
  const maturity: Array<{ area: string; label: MaturityLabel }> = [
    { area: "admitted M5 compute evidence", label: admittedCompute.sourceWindow.inWindow > 0 ? "measured" : "aspirational" },
    { area: "adoption evidence", label: adoptionQueryResult.rows > 0 ? "measured" : "aspirational" },
    { area: "delegation/cost evidence", label: delegation.rows > 0 || cost.rows > 0 ? "measured" : "aspirational" },
    { area: "lane promotion", label: "aspirational" },
  ];
  return { ...withoutLabels, maturity, nextAction: chooseNextAction(withoutLabels) };
}
