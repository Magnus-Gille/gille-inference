#!/usr/bin/env tsx
/**
 * Post the weekly, content-blind M5 agent-adoption evidence panels to Heimdall (#136).
 *
 * The primary panel queries only `traffic_purpose = organic`; formal evaluations and synthetic
 * probes are published in a separate LAB panel. This script is read-only over the gateway DB and
 * never contacts the M5 gateway. It posts to Heimdall only when invoked by an operator/timer.
 *
 * Usage: tsx scripts/post-m5-adoption-panel.ts [--dry-run] [--db <path>] [--days 7]
 */
import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  ADOPTION_CHECK_OUTCOMES,
  ADOPTION_EXECUTION_MODES,
  ADOPTION_FALLBACK_REASONS,
  ADOPTION_HARNESSES,
  ADOPTION_RESULTS,
  ADOPTION_TRAFFIC_PURPOSES,
  ADOPTION_USEFULNESS,
  type AdoptionExecutionMode,
  type AdoptionTrafficPurpose,
  type AdoptionFallbackReason,
  type AdoptionHarness,
} from "../src/homeserver/adoption-evidence.js";
import {
  pushPanel,
  verifyPanelLanded,
  verifyProblem,
  type StatusPanel,
  type TablePanel,
} from "../src/homeserver/heimdall-push.js";

const SERVICE = "m5-inference";
const ORGANIC_PANEL = "m5-adoption-organic";
const FALLBACKS_PANEL = "m5-adoption-fallbacks";
const LAB_PANEL = "m5-adoption-lab";
const DAY_MS = 24 * 60 * 60 * 1000;
const READBACK_MAX_AGE_MS = 5 * 60 * 1000;

export const DEFAULT_DAYS = 7;
export const INITIAL_ADOPTION_TARGET = {
  minKnownOrganicEligibleOpportunities: 20,
  minUsefulCompletionRate: 0.6,
  reviewDate: "2026-08-28",
} as const;

export interface OrganicAdoptionByHarness {
  harness: AdoptionHarness;
  reports: number;
  eligibleOpportunities: number;
  attemptedDelegations: number;
  completed: number;
  usefulCompletions: number;
  deterministicChecks: number;
  deterministicCheckPasses: number;
  fallbackCounts: Record<AdoptionFallbackReason, number>;
}

export interface LabAdoptionByPurpose {
  purpose: "evaluation" | "synthetic";
  reports: number;
  eligibleOpportunities: number;
  attemptedDelegations: number;
  completed: number;
}

export interface AdoptionPanelOverflow {
  retainedIndividualCount: number;
  legacyAggregatedCount: number;
  legacyRowCount: number;
  attributedAggregatedCount: number;
  aggregatedCount: number;
  droppedCount: number;
  malformedDay: number;
  missingDimensions: number;
  cappedDays: string[];
  affectedDays: string[];
  perHarnessAttribution: "complete" | "unavailable";
  byPurpose: Record<AdoptionTrafficPurpose, OverflowPanelAggregate>;
  byHarness: Record<AdoptionHarness, OverflowPanelAggregate>;
  byMode: Record<AdoptionExecutionMode, OverflowPanelAggregate>;
}

interface OverflowPanelAggregate {
    legacyReports: number;
    reports: number;
    eligibleOpportunities: number;
    unknownOpportunityDenominators: number;
    attemptedDelegations: number;
    completed: number;
    usefulCompletions: number;
    deterministicChecks: number;
    deterministicCheckPasses: number;
    fallbackCounts: Record<AdoptionFallbackReason, number>;
}

interface OrganicSummaryDbRow {
  harness: AdoptionHarness;
  reports: number;
  eligible_opportunities: number;
  attempted_delegations: number;
  completed: number;
  useful_completions: number;
  deterministic_checks: number;
  deterministic_check_passes: number;
}

interface OrganicFallbackDbRow {
  harness: AdoptionHarness;
  fallback_reason: AdoptionFallbackReason;
  fallback_reports: number;
}

interface LabDbRow {
  purpose: "evaluation" | "synthetic";
  reports: number;
  eligible_opportunities: number;
  attempted_delegations: number;
  completed: number;
}

interface OverflowDbRow {
  recorded_day: unknown;
  harness?: unknown;
  execution_mode?: unknown;
  traffic_purpose: unknown;
  result: string;
  deterministic_check: string;
  reviewer_usefulness: unknown;
  fallback_reason: unknown;
  report_count: unknown;
  eligible_opportunities: unknown;
  unknown_opportunity_reports: unknown;
}

function isValidCounter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function utcDayStart(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function windowStartDay(now: number, days: number): string {
  return new Date(utcDayStart(now) - (days - 1) * DAY_MS).toISOString().slice(0, 10);
}

function windowThroughDay(now: number): string {
  return new Date(utcDayStart(now) + DAY_MS).toISOString().slice(0, 10);
}

export function hasAdoptionEvidenceTable(db: Database.Database): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'adoption_evidence'")
    .get() as { name: string } | undefined;
  return row?.name === "adoption_evidence";
}

export function openReadOnlyAdoptionDb(dbPath: string): Database.Database {
  if (!existsSync(dbPath)) {
    throw new Error(`adoption evidence database does not exist: ${dbPath}`);
  }
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}

function emptyFallbackCounts(): Record<AdoptionFallbackReason, number> {
  return Object.fromEntries(ADOPTION_FALLBACK_REASONS.map((reason) => [reason, 0])) as Record<AdoptionFallbackReason, number>;
}

function emptyOrganic(harness: AdoptionHarness): OrganicAdoptionByHarness {
  return {
    harness,
    reports: 0,
    eligibleOpportunities: 0,
    attemptedDelegations: 0,
    completed: 0,
    usefulCompletions: 0,
    deterministicChecks: 0,
    deterministicCheckPasses: 0,
    fallbackCounts: emptyFallbackCounts(),
  };
}

function emptyOverflow(): AdoptionPanelOverflow {
  const byPurpose = (): OverflowPanelAggregate => ({ legacyReports: 0, reports: 0, eligibleOpportunities: 0, unknownOpportunityDenominators: 0, attemptedDelegations: 0, completed: 0, usefulCompletions: 0, deterministicChecks: 0, deterministicCheckPasses: 0, fallbackCounts: Object.fromEntries(ADOPTION_FALLBACK_REASONS.map((reason) => [reason, 0])) as Record<AdoptionFallbackReason, number> });
  return {
    retainedIndividualCount: 0,
    legacyAggregatedCount: 0,
    legacyRowCount: 0,
    attributedAggregatedCount: 0,
    aggregatedCount: 0,
    droppedCount: 0,
    malformedDay: 0,
    missingDimensions: 0,
    cappedDays: [],
    affectedDays: [],
    perHarnessAttribution: "complete",
    byPurpose: {
      organic: byPurpose(),
      evaluation: byPurpose(),
      synthetic: byPurpose(),
    },
    byHarness: Object.fromEntries(ADOPTION_HARNESSES.map((harness) => [harness, byPurpose()])) as Record<AdoptionHarness, OverflowPanelAggregate>,
    byMode: Object.fromEntries(ADOPTION_EXECUTION_MODES.map((mode) => [mode, byPurpose()])) as Record<AdoptionExecutionMode, OverflowPanelAggregate>,
  };
}

function hasAdoptionEvidenceOverflowTable(db: Database.Database): boolean {
  const row = db
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'adoption_evidence_overflow'")
    .get() as { present: 1 } | undefined;
  return row?.present === 1;
}

function hasAdoptionEvidenceOverflowV2Table(db: Database.Database): boolean {
  const row = db
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'adoption_evidence_overflow_v2'")
    .get() as { present: 1 } | undefined;
  return row?.present === 1;
}

function tableColumns(db: Database.Database, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name));
}

function integerCount(value: unknown): number {
  return isValidCounter(value) ? value : 0;
}

function closedOverflowValue(value: unknown, values: readonly string[]): string {
  return typeof value === "string" && values.includes(value) ? value : "unknown";
}

function validOverflowDay(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

/** Read post-cap content-free aggregates without widening the per-harness attribution surface. */
export function queryAdoptionEvidenceOverflow(
  db: Database.Database,
  days: number = DEFAULT_DAYS,
  now: number = Date.now(),
): AdoptionPanelOverflow {
  const result = emptyOverflow();
  const sinceDay = windowStartDay(now, days);
  const throughDay = windowThroughDay(now);
  result.retainedIndividualCount = hasAdoptionEvidenceTable(db)
    ? Number((db.prepare("SELECT COUNT(*) AS count FROM adoption_evidence WHERE recorded_day >= @sinceDay AND recorded_day < @throughDay").get({ sinceDay, throughDay }) as { count: number }).count)
    : 0;
  const cappedDays = new Set<string>();
  const affectedDays = new Set<string>();
  let legacyRowCount = 0;
  const readRows = (table: "adoption_evidence_overflow" | "adoption_evidence_overflow_v2", attributed: boolean): OverflowDbRow[] => {
    const columns = tableColumns(db, table);
    const required = table === "adoption_evidence_overflow_v2"
      ? ["recorded_day", "harness", "execution_mode", "traffic_purpose", "result", "deterministic_check", "reviewer_usefulness", "fallback_reason", "report_count", "eligible_opportunities", "unknown_opportunity_reports"]
      : ["recorded_day", "traffic_purpose", "result", "deterministic_check", "reviewer_usefulness", "fallback_reason", "report_count", "eligible_opportunities"];
    if (required.some((column) => !columns.has(column))) {
      result.missingDimensions += 1;
      return [];
    }
    const unknownReports = columns.has("unknown_opportunity_reports")
      ? "unknown_opportunity_reports"
      : "CASE WHEN eligible_opportunities = 0 THEN report_count ELSE 0 END AS unknown_opportunity_reports";
    const fields = table === "adoption_evidence_overflow_v2"
      ? `recorded_day, harness, execution_mode, traffic_purpose, result, deterministic_check, reviewer_usefulness, fallback_reason, report_count, eligible_opportunities, ${unknownReports}`
      : `recorded_day, traffic_purpose, result, deterministic_check, reviewer_usefulness, fallback_reason, report_count, eligible_opportunities, ${unknownReports}`;
    const rows = db.prepare(`SELECT ${fields} FROM ${table} ORDER BY rowid ASC`).all() as OverflowDbRow[];
    for (const row of rows) {
      if (!validOverflowDay(row.recorded_day)) {
        result.malformedDay += 1;
        continue;
      }
      if (row.recorded_day < sinceDay || row.recorded_day >= throughDay) continue;
      if (!attributed) legacyRowCount += 1;
      cappedDays.add(row.recorded_day);
      affectedDays.add(row.recorded_day);
      const reports = integerCount(row.report_count);
      const opportunities = integerCount(row.eligible_opportunities);
      const unknownOpportunityDenominators = integerCount(row.unknown_opportunity_reports);
      const reportsValid = isValidCounter(row.report_count);
      const opportunitiesValid = isValidCounter(row.eligible_opportunities);
      const unknownValid = !columns.has("unknown_opportunity_reports") || isValidCounter(row.unknown_opportunity_reports);
      const countersValid = reportsValid && opportunitiesValid && unknownValid &&
        (!columns.has("unknown_opportunity_reports") || unknownOpportunityDenominators <= reports);
      const v2CounterConsistencyValid = !attributed || (
        countersValid &&
        reports > 0 &&
        unknownOpportunityDenominators <= reports &&
        opportunities >= reports - unknownOpportunityDenominators &&
        (opportunities === 0
          ? reports - unknownOpportunityDenominators === 0
          : opportunities / 10000 <= reports - unknownOpportunityDenominators)
      );
      if (!countersValid || !v2CounterConsistencyValid) result.missingDimensions += 1;
      if (attributed) result.attributedAggregatedCount += reports;
      else result.legacyAggregatedCount += reports;
      result.aggregatedCount += reports;
      const purposeValue = closedOverflowValue(row.traffic_purpose, ADOPTION_TRAFFIC_PURPOSES);
      const harnessValue = closedOverflowValue(row.harness, ADOPTION_HARNESSES);
      const modeValue = closedOverflowValue(row.execution_mode, ADOPTION_EXECUTION_MODES);
      const resultValue = closedOverflowValue(row.result, ADOPTION_RESULTS);
      const checkValue = closedOverflowValue(row.deterministic_check, ADOPTION_CHECK_OUTCOMES);
      const usefulnessValue = closedOverflowValue(row.reviewer_usefulness, ADOPTION_USEFULNESS);
      const fallbackValue = closedOverflowValue(row.fallback_reason, ADOPTION_FALLBACK_REASONS);
      const invalidDimensions = table === "adoption_evidence_overflow_v2" && [purposeValue, harnessValue, modeValue, resultValue, checkValue, usefulnessValue, fallbackValue].includes("unknown");
      if (invalidDimensions) result.missingDimensions += 1;
      const attempted = ["completed", "refused", "failed"].includes(resultValue) ? reports : 0;
      const useful = resultValue === "completed" && (checkValue === "pass" || checkValue === "not_run") && ["pass", "partial"].includes(usefulnessValue) ? reports : 0;
      const item = result.byPurpose[purposeValue as AdoptionTrafficPurpose];
      if (item) {
        if (!attributed) item.legacyReports += reports;
        item.reports += reports;
        item.eligibleOpportunities += opportunities;
        item.unknownOpportunityDenominators += unknownOpportunityDenominators;
        item.attemptedDelegations += attempted;
        item.completed += resultValue === "completed" ? reports : 0;
        item.usefulCompletions += useful;
        item.deterministicChecks += checkValue !== "not_run" ? reports : 0;
        item.deterministicCheckPasses += checkValue === "pass" ? reports : 0;
        if (ADOPTION_FALLBACK_REASONS.includes(fallbackValue as AdoptionFallbackReason)) item.fallbackCounts[fallbackValue as AdoptionFallbackReason] += reports;
      }
      if (table === "adoption_evidence_overflow_v2" && purposeValue === "organic" && !invalidDimensions) {
        const harness = result.byHarness[harnessValue as AdoptionHarness];
        if (harness) {
          harness.reports += reports;
          harness.eligibleOpportunities += opportunities;
          harness.unknownOpportunityDenominators += unknownOpportunityDenominators;
          harness.attemptedDelegations += attempted;
          harness.completed += resultValue === "completed" ? reports : 0;
          harness.usefulCompletions += useful;
          harness.deterministicChecks += checkValue !== "not_run" ? reports : 0;
          harness.deterministicCheckPasses += checkValue === "pass" ? reports : 0;
          if (ADOPTION_FALLBACK_REASONS.includes(fallbackValue as AdoptionFallbackReason)) harness.fallbackCounts[fallbackValue as AdoptionFallbackReason] += reports;
        }
      }
      if (table === "adoption_evidence_overflow_v2" && !invalidDimensions) {
        const mode = result.byMode[modeValue as AdoptionExecutionMode];
        if (mode) {
          mode.reports += reports;
          mode.eligibleOpportunities += opportunities;
          mode.unknownOpportunityDenominators += unknownOpportunityDenominators;
          mode.attemptedDelegations += attempted;
          mode.completed += resultValue === "completed" ? reports : 0;
          mode.usefulCompletions += useful;
          mode.deterministicChecks += checkValue !== "not_run" ? reports : 0;
          mode.deterministicCheckPasses += checkValue === "pass" ? reports : 0;
          if (ADOPTION_FALLBACK_REASONS.includes(fallbackValue as AdoptionFallbackReason)) mode.fallbackCounts[fallbackValue as AdoptionFallbackReason] += reports;
        }
      }
    }
    return rows;
  };
  if (hasAdoptionEvidenceOverflowV2Table(db)) readRows("adoption_evidence_overflow_v2", true);
  if (hasAdoptionEvidenceOverflowTable(db)) readRows("adoption_evidence_overflow", false);
  result.cappedDays = [...cappedDays].sort();
  result.affectedDays = [...affectedDays].sort();
  result.legacyRowCount = legacyRowCount;
  result.perHarnessAttribution = result.legacyRowCount > 0 || result.malformedDay > 0 || result.missingDimensions > 0 ? "unavailable" : "complete";
  return result;
}

/**
 * Query the primary panel. The WHERE clause is the enforced organic/evaluation separation: no
 * report labelled evaluation or synthetic can contribute to these adoption counts.
 */
export function queryOrganicAdoptionByHarness(
  db: Database.Database,
  days: number = DEFAULT_DAYS,
  now: number = Date.now()
): OrganicAdoptionByHarness[] {
  if (!hasAdoptionEvidenceTable(db)) return [];
  const summaries = db.prepare(
    `SELECT
       harness,
       COUNT(*) AS reports,
       COALESCE(SUM(eligible_opportunities), 0) AS eligible_opportunities,
       SUM(CASE WHEN result <> 'not_attempted' THEN 1 ELSE 0 END) AS attempted_delegations,
       SUM(CASE WHEN result = 'completed' THEN 1 ELSE 0 END) AS completed,
       SUM(CASE WHEN result = 'completed'
                  AND deterministic_check <> 'fail'
                  AND reviewer_usefulness IN ('pass', 'partial') THEN 1 ELSE 0 END) AS useful_completions,
       SUM(CASE WHEN deterministic_check <> 'not_run' THEN 1 ELSE 0 END) AS deterministic_checks,
       SUM(CASE WHEN deterministic_check = 'pass' THEN 1 ELSE 0 END) AS deterministic_check_passes
     FROM adoption_evidence
     WHERE recorded_day >= @sinceDay AND recorded_day < @throughDay AND traffic_purpose = 'organic'
     GROUP BY harness
     ORDER BY harness ASC`
  ).all({ sinceDay: windowStartDay(now, days), throughDay: windowThroughDay(now) }) as OrganicSummaryDbRow[];
  const fallbackRows = db.prepare(
    `SELECT harness, fallback_reason, COUNT(*) AS fallback_reports
       FROM adoption_evidence
      WHERE recorded_day >= @sinceDay AND recorded_day < @throughDay AND traffic_purpose = 'organic'
      GROUP BY harness, fallback_reason
      ORDER BY harness ASC, fallback_reason ASC`
  ).all({ sinceDay: windowStartDay(now, days), throughDay: windowThroughDay(now) }) as OrganicFallbackDbRow[];

  const byHarness = new Map<AdoptionHarness, OrganicAdoptionByHarness>();
  for (const row of summaries) {
    const value = emptyOrganic(row.harness);
    value.reports = row.reports;
    value.eligibleOpportunities = row.eligible_opportunities;
    value.attemptedDelegations = row.attempted_delegations;
    value.completed = row.completed;
    value.usefulCompletions = row.useful_completions;
    value.deterministicChecks = row.deterministic_checks;
    value.deterministicCheckPasses = row.deterministic_check_passes;
    byHarness.set(row.harness, value);
  }
  for (const row of fallbackRows) {
    const value = byHarness.get(row.harness);
    // Every fallback row comes from an aggregate row with the same organic WHERE clause.
    if (!value) continue;
    value.fallbackCounts[row.fallback_reason] = row.fallback_reports;
  }
  return [...byHarness.values()].sort((a, b) => a.harness.localeCompare(b.harness));
}

/** Lab-only panel: evaluation and synthetic reports are present, but never combined with organic use. */
export function queryLabAdoptionByPurpose(
  db: Database.Database,
  days: number = DEFAULT_DAYS,
  now: number = Date.now()
): LabAdoptionByPurpose[] {
  if (!hasAdoptionEvidenceTable(db)) return [];
  const rows = db.prepare(
    `SELECT
       traffic_purpose AS purpose,
       COUNT(*) AS reports,
       COALESCE(SUM(eligible_opportunities), 0) AS eligible_opportunities,
       SUM(CASE WHEN result <> 'not_attempted' THEN 1 ELSE 0 END) AS attempted_delegations,
       SUM(CASE WHEN result = 'completed' THEN 1 ELSE 0 END) AS completed
     FROM adoption_evidence
     WHERE recorded_day >= @sinceDay AND recorded_day < @throughDay AND traffic_purpose IN ('evaluation', 'synthetic')
     GROUP BY traffic_purpose
     ORDER BY traffic_purpose ASC`
  ).all({ sinceDay: windowStartDay(now, days), throughDay: windowThroughDay(now) }) as LabDbRow[];
  return rows.map((row) => ({
    purpose: row.purpose,
    reports: row.reports,
    eligibleOpportunities: row.eligible_opportunities,
    attemptedDelegations: row.attempted_delegations,
    completed: row.completed,
  }));
}

function pct(numerator: number, denominator: number): string {
  return denominator === 0 ? "not yet measured" : `${((numerator / denominator) * 100).toFixed(1)}%`;
}

function aggregateOrganic(rows: OrganicAdoptionByHarness[]): Omit<OrganicAdoptionByHarness, "harness"> {
  return rows.reduce(
    (total, row) => {
      total.reports += row.reports;
      total.eligibleOpportunities += row.eligibleOpportunities;
      total.attemptedDelegations += row.attemptedDelegations;
      total.completed += row.completed;
      total.usefulCompletions += row.usefulCompletions;
      total.deterministicChecks += row.deterministicChecks;
      total.deterministicCheckPasses += row.deterministicCheckPasses;
      for (const reason of ADOPTION_FALLBACK_REASONS) total.fallbackCounts[reason] += row.fallbackCounts[reason];
      return total;
    },
    {
      reports: 0,
      eligibleOpportunities: 0,
      attemptedDelegations: 0,
      completed: 0,
      usefulCompletions: 0,
      deterministicChecks: 0,
      deterministicCheckPasses: 0,
      fallbackCounts: emptyFallbackCounts(),
    }
  );
}

function mergeOrganicOverflow(
  totals: Omit<OrganicAdoptionByHarness, "harness">,
  overflow: AdoptionPanelOverflow,
): void {
  const item = overflow.byPurpose.organic;
  totals.reports += item.reports;
  totals.eligibleOpportunities += item.eligibleOpportunities;
  totals.attemptedDelegations += item.attemptedDelegations;
  totals.completed += item.completed;
  totals.usefulCompletions += item.usefulCompletions;
  totals.deterministicChecks += item.deterministicChecks;
  totals.deterministicCheckPasses += item.deterministicCheckPasses;
}

function mergeOverflowIntoOrganicRow(row: OrganicAdoptionByHarness, item: OverflowPanelAggregate): void {
  row.reports += item.reports;
  row.eligibleOpportunities += item.eligibleOpportunities;
  row.attemptedDelegations += item.attemptedDelegations;
  row.completed += item.completed;
  row.usefulCompletions += item.usefulCompletions;
  row.deterministicChecks += item.deterministicChecks;
  row.deterministicCheckPasses += item.deterministicCheckPasses;
  for (const reason of ADOPTION_FALLBACK_REASONS) row.fallbackCounts[reason] += item.fallbackCounts[reason];
}

export function buildAdoptionPanels(
  organicRows: OrganicAdoptionByHarness[],
  labRows: LabAdoptionByPurpose[],
  days: number,
  overflow: AdoptionPanelOverflow = emptyOverflow(),
): { organic: StatusPanel; organicByHarness: TablePanel; fallbacks: TablePanel; lab: TablePanel } {
  const byHarness = new Map(organicRows.map((row) => [row.harness, { ...row, fallbackCounts: { ...row.fallbackCounts } }]));
  for (const harness of ADOPTION_HARNESSES) {
    const item = overflow.byHarness[harness];
    if (item.reports === 0) continue;
    const row = byHarness.get(harness) ?? emptyOrganic(harness);
    mergeOverflowIntoOrganicRow(row, item);
    byHarness.set(harness, row);
  }
  const mergedOrganicRows = [...byHarness.values()].sort((a, b) => a.harness.localeCompare(b.harness));
  const totals = aggregateOrganic(organicRows);
  mergeOrganicOverflow(totals, overflow);
  for (const reason of ADOPTION_FALLBACK_REASONS) totals.fallbackCounts[reason] += overflow.byPurpose.organic.fallbackCounts[reason];
  const labByPurpose = new Map(labRows.map((row) => [row.purpose, { ...row }]));
  for (const purpose of ["evaluation", "synthetic"] as const) {
    const item = overflow.byPurpose[purpose];
    if (item.reports === 0) continue;
    const row = labByPurpose.get(purpose) ?? { purpose, reports: 0, eligibleOpportunities: 0, attemptedDelegations: 0, completed: 0 };
    row.reports += item.reports;
    row.eligibleOpportunities += item.eligibleOpportunities;
    row.attemptedDelegations += item.attemptedDelegations;
    row.completed += item.completed;
    labByPurpose.set(purpose, row);
  }
  const mergedLabRows = [...labByPurpose.values()].sort((a, b) => a.purpose.localeCompare(b.purpose));
  const organicOverflowCount = overflow.byPurpose.organic.reports;
  const organicIncomplete = overflow.byPurpose.organic.legacyReports > 0 || overflow.legacyRowCount > 0 || overflow.droppedCount > 0 || overflow.malformedDay > 0 || overflow.missingDimensions > 0;
  const fallbackIncomplete = overflow.droppedCount > 0 || overflow.malformedDay > 0 || overflow.missingDimensions > 0;
  const labIncomplete = overflow.byPurpose.evaluation.legacyReports > 0 || overflow.byPurpose.synthetic.legacyReports > 0 || overflow.legacyRowCount > 0 || overflow.droppedCount > 0 || overflow.malformedDay > 0 || overflow.missingDimensions > 0;
  const organicOverflowStatus = overflow.legacyRowCount > 0
    ? "legacy overflow rows lack durable attribution"
    : overflow.missingDimensions > 0
      ? "overflow schema, dimensions, or counters are invalid"
      : overflow.malformedDay > 0
        ? "overflow day values are malformed"
        : overflow.droppedCount > 0
          ? "overflow includes dropped reports"
          : "overflow retention is incomplete";
  const organic: StatusPanel = {
    service: SERVICE,
    panel: ORGANIC_PANEL,
    kind: "status",
    label: organicIncomplete
      ? "INCOMPLETE — organic M5 agent adoption (overflow coverage is incomplete)"
      : "MEASURED — organic M5 agent adoption",
    state: totals.reports === 0 || organicIncomplete ? "warn" : "pass",
    message:
      `MEASURED: ${totals.attemptedDelegations} attempted local delegation(s) from ${totals.eligibleOpportunities} known organic eligible opportunity/opportunities in ${days}d; ` +
      `useful completion rate ${pct(totals.usefulCompletions, totals.attemptedDelegations)}; deterministic check pass rate ${pct(totals.deterministicCheckPasses, totals.deterministicChecks)}. ` +
      (organicIncomplete
        ? `INCOMPLETE: ${organicOverflowCount} organic overflow observation(s) were aggregated on ${overflow.affectedDays.length} affected day(s); ${organicOverflowStatus}; per-harness attribution is unavailable and inference availability is unaffected. `
        : "") +
      "ENFORCED: evaluation and synthetic evidence are excluded from this panel. SHADOW: this measurement does not change routing or authorize frontier displacement.",
    detail: {
      kind: "table",
      cols: ["metric", "value"],
      rows: [
        { metric: "window", value: `${days}d` },
        { metric: "organic reports", value: totals.reports },
        { metric: "retained individual reports (all purposes)", value: overflow.retainedIndividualCount },
        { metric: "aggregated overflow reports", value: organicOverflowCount },
        { metric: "legacy aggregated overflow reports", value: overflow.legacyAggregatedCount },
        { metric: "attributed aggregated overflow reports", value: overflow.attributedAggregatedCount },
        { metric: "dropped reports", value: overflow.droppedCount },
        { metric: "malformed overflow days", value: overflow.malformedDay },
        { metric: "missing overflow dimensions", value: overflow.missingDimensions },
        { metric: "capped days (all purposes)", value: overflow.cappedDays.join(", ") || "none" },
        { metric: "affected days (all purposes)", value: overflow.affectedDays.join(", ") || "none" },
        { metric: "known eligible opportunities", value: totals.eligibleOpportunities },
        { metric: "attempted delegations", value: totals.attemptedDelegations },
        { metric: "useful completions", value: totals.usefulCompletions },
        { metric: "deterministic check pass rate", value: pct(totals.deterministicCheckPasses, totals.deterministicChecks) },
        { metric: "initial target", value: `≥${INITIAL_ADOPTION_TARGET.minKnownOrganicEligibleOpportunities} known organic opportunities and ≥${INITIAL_ADOPTION_TARGET.minUsefulCompletionRate * 100}% useful completion rate` },
        { metric: "review date", value: INITIAL_ADOPTION_TARGET.reviewDate },
        { metric: "routing effect", value: "shadow measurement only; no automatic routing change" },
      ],
    },
  };

  const organicByHarness: TablePanel = {
    service: SERVICE,
    panel: "m5-adoption-organic-by-harness",
    kind: "table",
    label: organicIncomplete
      ? "INCOMPLETE — organic M5 agent adoption by harness (per-harness attribution unavailable)"
      : "MEASURED — organic M5 agent adoption by harness",
    cols: [
      "harness",
      "known eligible opportunities",
      "attempted delegations",
      "useful completions",
      "deterministic check pass rate",
      "fallback reports",
    ],
    rows: mergedOrganicRows.map((row) => ({
      harness: row.harness,
      "known eligible opportunities": row.eligibleOpportunities,
      "attempted delegations": row.attemptedDelegations,
      "useful completions": row.usefulCompletions,
      "deterministic check pass rate": pct(row.deterministicCheckPasses, row.deterministicChecks),
      "fallback reports": ADOPTION_FALLBACK_REASONS
        .filter((reason) => reason !== "none")
        .reduce((sum, reason) => sum + row.fallbackCounts[reason], 0),
    })),
  };

  const fallbacks: TablePanel = {
    service: SERVICE,
    panel: FALLBACKS_PANEL,
    kind: "table",
    label: fallbackIncomplete
      ? "INCOMPLETE — organic M5 fallback reasons (dropped reports)"
      : "MEASURED — organic M5 fallback reasons (exact global aggregate)",
    cols: ["reason", "reports"],
    rows: ADOPTION_FALLBACK_REASONS.filter((reason) => reason !== "none")
      .map((reason) => ({ reason, reports: totals.fallbackCounts[reason] }))
      .filter((row) => row.reports > 0),
  };

  const lab: TablePanel = {
    service: SERVICE,
    panel: LAB_PANEL,
    kind: "table",
    label: labIncomplete
      ? "INCOMPLETE LAB — evaluation and synthetic M5 evidence"
      : "LAB — evaluation and synthetic M5 evidence",
    cols: ["purpose", "reports", "known eligible opportunities", "attempted delegations", "completed"],
    rows: mergedLabRows.map((row) => ({
      purpose: row.purpose,
      reports: row.reports,
      "known eligible opportunities": row.eligibleOpportunities,
      "attempted delegations": row.attemptedDelegations,
      completed: row.completed,
    })),
  };
  return { organic, organicByHarness, fallbacks, lab };
}

export function parseArgs(argv: string[]): { dryRun: boolean; dbPath: string; days: number } {
  let dryRun = false;
  let dbPath = process.env["EVAL_DB_PATH"] ?? "./data/eval.db";
  let days = DEFAULT_DAYS;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dry-run") dryRun = true;
    else if (argv[i] === "--db" && argv[i + 1]) dbPath = argv[++i]!;
    else if (argv[i] === "--days" && argv[i + 1]) days = Number(argv[++i]);
  }
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error("--days must be an integer from 1 to 365");
  return { dryRun, dbPath, days };
}

export interface AdoptionPanelMainDependencies {
  openReadOnlyDb?: (dbPath: string) => Database.Database;
  pushPanel?: typeof pushPanel;
  verifyPanelLanded?: typeof verifyPanelLanded;
  writeStdout?: (text: string) => void;
  writeStderr?: (text: string) => void;
}

export async function main(
  argv = process.argv.slice(2),
  dependencies: AdoptionPanelMainDependencies = {},
): Promise<number> {
  const openReadOnlyDb = dependencies.openReadOnlyDb ?? openReadOnlyAdoptionDb;
  const postPanel = dependencies.pushPanel ?? pushPanel;
  const verifyPostedPanel = dependencies.verifyPanelLanded ?? verifyPanelLanded;
  const writeStdout = dependencies.writeStdout ?? ((text: string) => process.stdout.write(text));
  const writeStderr = dependencies.writeStderr ?? ((text: string) => process.stderr.write(text));
  const { dryRun, dbPath, days } = parseArgs(argv);
  let db: Database.Database;
  try {
    db = openReadOnlyDb(dbPath);
  } catch (error) {
    writeStderr(
      `[m5-adoption-panel] cannot open authoritative EVAL_DB_PATH at ${dbPath}: ${error instanceof Error ? error.message : String(error)}\n`
    );
    return 2;
  }
  try {
    const now = Date.now();
    const panels = buildAdoptionPanels(
      queryOrganicAdoptionByHarness(db, days, now),
      queryLabAdoptionByPurpose(db, days, now),
      days,
      queryAdoptionEvidenceOverflow(db, days, now),
    );
    if (dryRun) {
      writeStdout(`${JSON.stringify(panels, null, 2)}\n`);
      return 0;
    }
    let failed = false;
    for (const panel of Object.values(panels)) {
      const pushed = await postPanel(panel);
      if (!pushed.ok) {
        writeStderr(`[m5-adoption-panel] ${panel.panel}: push failed: ${pushed.error ?? `HTTP ${pushed.status}`}\n`);
        failed = true;
        continue;
      }
      const readback = await verifyPostedPanel(SERVICE, panel.panel, { maxAgeMs: READBACK_MAX_AGE_MS });
      if (readback.ok) writeStdout(`[m5-adoption-panel] ${panel.panel}: published and verified\n`);
      else {
        writeStderr(`[m5-adoption-panel] ${panel.panel}: ${verifyProblem(readback)}\n`);
        failed = true;
      }
    }
    return failed ? 1 : 0;
  } finally {
    db.close();
  }
}

const isMain = process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) process.exitCode = await main();
