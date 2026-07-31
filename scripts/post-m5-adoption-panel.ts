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

function utcDayStart(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function windowStartDay(now: number, days: number): string {
  return new Date(utcDayStart(now) - (days - 1) * DAY_MS).toISOString().slice(0, 10);
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
     WHERE recorded_day >= @sinceDay AND traffic_purpose = 'organic'
     GROUP BY harness
     ORDER BY harness ASC`
  ).all({ sinceDay: windowStartDay(now, days) }) as OrganicSummaryDbRow[];
  const fallbackRows = db.prepare(
    `SELECT harness, fallback_reason, COUNT(*) AS fallback_reports
       FROM adoption_evidence
      WHERE recorded_day >= @sinceDay AND traffic_purpose = 'organic'
      GROUP BY harness, fallback_reason
      ORDER BY harness ASC, fallback_reason ASC`
  ).all({ sinceDay: windowStartDay(now, days) }) as OrganicFallbackDbRow[];

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
     WHERE recorded_day >= @sinceDay AND traffic_purpose IN ('evaluation', 'synthetic')
     GROUP BY traffic_purpose
     ORDER BY traffic_purpose ASC`
  ).all({ sinceDay: windowStartDay(now, days) }) as LabDbRow[];
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

export function buildAdoptionPanels(
  organicRows: OrganicAdoptionByHarness[],
  labRows: LabAdoptionByPurpose[],
  days: number
): { organic: StatusPanel; organicByHarness: TablePanel; fallbacks: TablePanel; lab: TablePanel } {
  const totals = aggregateOrganic(organicRows);
  const organic: StatusPanel = {
    service: SERVICE,
    panel: ORGANIC_PANEL,
    kind: "status",
    label: "MEASURED — organic M5 agent adoption",
    state: totals.reports === 0 ? "warn" : "pass",
    message:
      `MEASURED: ${totals.attemptedDelegations} attempted local delegation(s) from ${totals.eligibleOpportunities} known organic eligible opportunity/opportunities in ${days}d; ` +
      `useful completion rate ${pct(totals.usefulCompletions, totals.attemptedDelegations)}; deterministic check pass rate ${pct(totals.deterministicCheckPasses, totals.deterministicChecks)}. ` +
      "ENFORCED: evaluation and synthetic evidence are excluded from this panel. SHADOW: this measurement does not change routing or authorize frontier displacement.",
    detail: {
      kind: "table",
      cols: ["metric", "value"],
      rows: [
        { metric: "window", value: `${days}d` },
        { metric: "organic reports", value: totals.reports },
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
    label: "MEASURED — organic M5 agent adoption by harness",
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
    label: "MEASURED — organic M5 fallback reasons",
    cols: ["reason", "reports"],
    rows: ADOPTION_FALLBACK_REASONS.filter((reason) => reason !== "none")
      .map((reason) => ({ reason, reports: totals.fallbackCounts[reason] }))
      .filter((row) => row.reports > 0),
  };

  const lab: TablePanel = {
    service: SERVICE,
    panel: LAB_PANEL,
    kind: "table",
    label: "LAB — evaluation and synthetic M5 evidence",
    cols: ["purpose", "reports", "known eligible opportunities", "attempted delegations", "completed"],
    rows: labRows.map((row) => ({
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

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const { dryRun, dbPath, days } = parseArgs(argv);
  let db: Database.Database;
  try {
    db = openReadOnlyAdoptionDb(dbPath);
  } catch (error) {
    process.stderr.write(
      `[m5-adoption-panel] cannot open authoritative EVAL_DB_PATH at ${dbPath}: ${error instanceof Error ? error.message : String(error)}\n`
    );
    return 2;
  }
  try {
    const panels = buildAdoptionPanels(
      queryOrganicAdoptionByHarness(db, days),
      queryLabAdoptionByPurpose(db, days),
      days
    );
    if (dryRun) {
      process.stdout.write(`${JSON.stringify(panels, null, 2)}\n`);
      return 0;
    }
    for (const panel of Object.values(panels)) {
      const pushed = await pushPanel(panel);
      if (!pushed.ok) {
        process.stderr.write(`[m5-adoption-panel] ${panel.panel}: push failed: ${pushed.error ?? `HTTP ${pushed.status}`}\n`);
        continue;
      }
      const readback = await verifyPanelLanded(SERVICE, panel.panel, { maxAgeMs: READBACK_MAX_AGE_MS });
      if (readback.ok) process.stdout.write(`[m5-adoption-panel] ${panel.panel}: published and verified\n`);
      else process.stderr.write(`[m5-adoption-panel] ${panel.panel}: ${verifyProblem(readback)}\n`);
    }
    return 0;
  } finally {
    db.close();
  }
}

const isMain = process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) process.exitCode = await main();
