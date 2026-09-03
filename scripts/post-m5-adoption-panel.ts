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
  ADOPTION_FALLBACK_REASONS,
  ADOPTION_TRAFFIC_PURPOSES,
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
  aggregatedCount: number;
  droppedCount: number;
  cappedDays: string[];
  affectedDays: string[];
  perHarnessAttribution: "complete" | "unavailable";
  byPurpose: Record<AdoptionTrafficPurpose, {
    reports: number;
    eligibleOpportunities: number;
    attemptedDelegations: number;
    completed: number;
    usefulCompletions: number;
    deterministicChecks: number;
    deterministicCheckPasses: number;
    fallbackCounts: Record<AdoptionFallbackReason, number>;
  }>;
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
  recorded_day: string;
  traffic_purpose: AdoptionTrafficPurpose;
  result: string;
  deterministic_check: string;
  reviewer_usefulness: string;
  fallback_reason: AdoptionFallbackReason;
  report_count: number;
  eligible_opportunities: number;
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
  const byPurpose = () => ({ reports: 0, eligibleOpportunities: 0, attemptedDelegations: 0, completed: 0, usefulCompletions: 0, deterministicChecks: 0, deterministicCheckPasses: 0, fallbackCounts: Object.fromEntries(ADOPTION_FALLBACK_REASONS.map((reason) => [reason, 0])) as Record<AdoptionFallbackReason, number> });
  return {
    retainedIndividualCount: 0,
    aggregatedCount: 0,
    droppedCount: 0,
    cappedDays: [],
    affectedDays: [],
    perHarnessAttribution: "complete",
    byPurpose: {
      organic: byPurpose(),
      evaluation: byPurpose(),
      synthetic: byPurpose(),
    },
  };
}

function hasAdoptionEvidenceOverflowTable(db: Database.Database): boolean {
  const row = db
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'adoption_evidence_overflow'")
    .get() as { present: 1 } | undefined;
  return row?.present === 1;
}

function integerCount(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

/** Read post-cap content-free aggregates without widening the per-harness attribution surface. */
export function queryAdoptionEvidenceOverflow(
  db: Database.Database,
  days: number = DEFAULT_DAYS,
  now: number = Date.now(),
): AdoptionPanelOverflow {
  const result = emptyOverflow();
  result.retainedIndividualCount = hasAdoptionEvidenceTable(db)
    ? Number((db.prepare("SELECT COUNT(*) AS count FROM adoption_evidence WHERE recorded_day >= @sinceDay AND recorded_day < @throughDay").get({ sinceDay: windowStartDay(now, days), throughDay: windowThroughDay(now) }) as { count: number }).count)
    : 0;
  if (!hasAdoptionEvidenceOverflowTable(db)) return result;
  const all = db.prepare("SELECT recorded_day, traffic_purpose, result, deterministic_check, reviewer_usefulness, fallback_reason, report_count, eligible_opportunities FROM adoption_evidence_overflow ORDER BY rowid ASC").all() as OverflowDbRow[];
  const cappedDays = new Set<string>();
  const affectedDays = new Set<string>();
  const sinceDay = windowStartDay(now, days);
  const throughDay = windowThroughDay(now);
  for (const row of all) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.recorded_day)) continue;
    if (row.recorded_day < sinceDay || row.recorded_day >= throughDay) continue;
    cappedDays.add(row.recorded_day);
    affectedDays.add(row.recorded_day);
    const reports = integerCount(row.report_count);
    const opportunities = integerCount(row.eligible_opportunities);
    result.aggregatedCount += reports;
    const purpose = ADOPTION_TRAFFIC_PURPOSES.includes(row.traffic_purpose) ? row.traffic_purpose : null;
    if (!purpose) continue;
    const item = result.byPurpose[purpose];
    item.reports += reports;
    item.eligibleOpportunities += opportunities;
    item.attemptedDelegations += ["completed", "refused", "failed"].includes(row.result) ? reports : 0;
    item.completed += row.result === "completed" ? reports : 0;
    item.usefulCompletions += row.result === "completed" && row.deterministic_check !== "fail" && ["pass", "partial"].includes(row.reviewer_usefulness) ? reports : 0;
    item.deterministicChecks += row.deterministic_check !== "not_run" ? reports : 0;
    item.deterministicCheckPasses += row.deterministic_check === "pass" ? reports : 0;
    if (ADOPTION_FALLBACK_REASONS.includes(row.fallback_reason)) item.fallbackCounts[row.fallback_reason] += reports;
  }
  result.cappedDays = [...cappedDays].sort();
  result.affectedDays = [...affectedDays].sort();
  result.perHarnessAttribution = result.aggregatedCount > 0 ? "unavailable" : "complete";
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

export function buildAdoptionPanels(
  organicRows: OrganicAdoptionByHarness[],
  labRows: LabAdoptionByPurpose[],
  days: number,
  overflow: AdoptionPanelOverflow = emptyOverflow(),
): { organic: StatusPanel; organicByHarness: TablePanel; fallbacks: TablePanel; lab: TablePanel } {
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
  const organicIncomplete = organicOverflowCount > 0 || overflow.droppedCount > 0;
  const fallbackIncomplete = overflow.droppedCount > 0;
  const labIncomplete = overflow.byPurpose.evaluation.reports + overflow.byPurpose.synthetic.reports > 0 || overflow.droppedCount > 0;
  const organic: StatusPanel = {
    service: SERVICE,
    panel: ORGANIC_PANEL,
    kind: "status",
    label: organicIncomplete
      ? "INCOMPLETE — organic M5 agent adoption (overflow is unattributed)"
      : "MEASURED — organic M5 agent adoption",
    state: totals.reports === 0 || organicIncomplete ? "warn" : "pass",
    message:
      `MEASURED: ${totals.attemptedDelegations} attempted local delegation(s) from ${totals.eligibleOpportunities} known organic eligible opportunity/opportunities in ${days}d; ` +
      `useful completion rate ${pct(totals.usefulCompletions, totals.attemptedDelegations)}; deterministic check pass rate ${pct(totals.deterministicCheckPasses, totals.deterministicChecks)}. ` +
      (organicIncomplete
        ? `INCOMPLETE: ${organicOverflowCount} organic overflow observation(s) were aggregated on ${overflow.affectedDays.length} affected day(s); per-harness attribution is unavailable and inference availability is unaffected. `
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
        { metric: "dropped reports", value: overflow.droppedCount },
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
    rows: organicRows.map((row) => ({
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
