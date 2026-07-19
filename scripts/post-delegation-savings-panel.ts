#!/usr/bin/env tsx
/**
 * post-delegation-savings-panel.ts — push verified M5 delegation savings to Heimdall.
 *
 * DATA SOURCE: delegation_costs, a content-blind SQLite table written by /delegate and owner MCP
 * ask telemetry. It contains model ids, token counts, verification status, and USD estimates, but
 * never prompts or responses.
 *
 * USAGE   tsx scripts/post-delegation-savings-panel.ts [--dry-run] [--db <path>] [--days 30]
 * ENV     HEIMDALL_PANELS_URL, HEIMDALL_FLEET_TOKEN, HOMESERVER_USD_TO_SEK
 */
import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

import {
  pushPanel,
  verifyPanelLanded,
  verifyProblem,
  type TablePanel,
  type TimeseriesPanel,
} from "../src/homeserver/heimdall-push.js";

const SERVICE = "m5-inference";
const SAVINGS_PANEL = "delegation-savings";
const TASK_PANEL = "delegation-savings-by-task";
const READBACK_MAX_AGE_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_DAYS = 30;

export interface DailySavings {
  date: string;
  calls: number;
  verifiedCalls: number;
  unverifiedCalls: number;
  failedCalls: number;
  escalatedCalls: number;
  verifiedSavingsActualSek: number;
  verifiedSavingsPremiumSek: number;
  potentialSavingsActualSek: number;
  potentialSavingsPremiumSek: number;
}

export interface SavingsByTaskType {
  taskType: string;
  calls: number;
  verifiedCalls: number;
  unverifiedCalls: number;
  failedCalls: number;
  escalatedCalls: number;
  verifiedSavingsPremiumSek: number;
  potentialSavingsPremiumSek: number;
}

interface DailySavingsDbRow {
  date: string;
  calls: number;
  verified_calls: number;
  unverified_calls: number;
  failed_calls: number;
  escalated_calls: number;
  verified_actual_usd: number;
  verified_premium_usd: number;
  potential_actual_usd: number;
  potential_premium_usd: number;
}

interface TaskSavingsDbRow {
  task_type: string;
  calls: number;
  verified_calls: number;
  unverified_calls: number;
  failed_calls: number;
  escalated_calls: number;
  verified_premium_usd: number;
  potential_premium_usd: number;
}

function usdToSek(value: number, rate: number): number {
  return Math.round(value * rate * 100) / 100;
}

function utcDayStart(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function utcDateString(ms: number): string {
  return new Date(utcDayStart(ms)).toISOString().slice(0, 10);
}

function windowStartIso(now: number, days: number): string {
  return new Date(utcDayStart(now) - (days - 1) * DAY_MS).toISOString();
}

export function hasDelegationCostsTable(db: Database.Database): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'delegation_costs'`)
    .get() as { name: string } | undefined;
  return row?.name === "delegation_costs";
}

export function openReadOnlySavingsDb(dbPath: string): Database.Database {
  if (!existsSync(dbPath)) {
    return new Database(":memory:");
  }
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}

export function queryDailySavings(
  db: Database.Database,
  days: number = DEFAULT_DAYS,
  now: number = Date.now(),
  sekRate: number = 10.5
): DailySavings[] {
  if (!hasDelegationCostsTable(db)) {
    return Array.from({ length: days }, (_, i) => {
      const date = utcDateString(utcDayStart(now) - (days - 1 - i) * DAY_MS);
      return {
        date,
        calls: 0,
        verifiedCalls: 0,
        unverifiedCalls: 0,
        failedCalls: 0,
        escalatedCalls: 0,
        verifiedSavingsActualSek: 0,
        verifiedSavingsPremiumSek: 0,
        potentialSavingsActualSek: 0,
        potentialSavingsPremiumSek: 0,
      };
    });
  }

  const since = windowStartIso(now, days);
  const rows = db
    .prepare(
      `SELECT
         substr(ts, 1, 10) AS date,
         COUNT(*) AS calls,
         SUM(CASE WHEN cost_status = 'verified' THEN 1 ELSE 0 END) AS verified_calls,
         SUM(CASE WHEN cost_status = 'unverified' THEN 1 ELSE 0 END) AS unverified_calls,
         SUM(CASE WHEN cost_status = 'failed' THEN 1 ELSE 0 END) AS failed_calls,
         SUM(CASE WHEN cost_status = 'escalated' THEN 1 ELSE 0 END) AS escalated_calls,
         COALESCE(SUM(verified_savings_actual_usd), 0) AS verified_actual_usd,
         COALESCE(SUM(verified_savings_premium_usd), 0) AS verified_premium_usd,
         COALESCE(SUM(potential_savings_actual_usd), 0) AS potential_actual_usd,
         COALESCE(SUM(potential_savings_premium_usd), 0) AS potential_premium_usd
       FROM delegation_costs
       WHERE ts >= @since
       GROUP BY date`
    )
    .all({ since }) as DailySavingsDbRow[];

  const byDate = new Map(rows.map((r) => [r.date, r]));
  const out: DailySavings[] = [];
  const start = utcDayStart(now) - (days - 1) * DAY_MS;
  for (let i = 0; i < days; i++) {
    const date = utcDateString(start + i * DAY_MS);
    const r = byDate.get(date);
    out.push({
      date,
      calls: r?.calls ?? 0,
      verifiedCalls: r?.verified_calls ?? 0,
      unverifiedCalls: r?.unverified_calls ?? 0,
      failedCalls: r?.failed_calls ?? 0,
      escalatedCalls: r?.escalated_calls ?? 0,
      verifiedSavingsActualSek: usdToSek(r?.verified_actual_usd ?? 0, sekRate),
      verifiedSavingsPremiumSek: usdToSek(r?.verified_premium_usd ?? 0, sekRate),
      potentialSavingsActualSek: usdToSek(r?.potential_actual_usd ?? 0, sekRate),
      potentialSavingsPremiumSek: usdToSek(r?.potential_premium_usd ?? 0, sekRate),
    });
  }
  return out;
}

export function querySavingsByTaskType(
  db: Database.Database,
  days: number = DEFAULT_DAYS,
  now: number = Date.now(),
  sekRate: number = 10.5
): SavingsByTaskType[] {
  if (!hasDelegationCostsTable(db)) return [];
  const since = windowStartIso(now, days);
  const rows = db
    .prepare(
      `SELECT
         task_type AS task_type,
         COUNT(*) AS calls,
         SUM(CASE WHEN cost_status = 'verified' THEN 1 ELSE 0 END) AS verified_calls,
         SUM(CASE WHEN cost_status = 'unverified' THEN 1 ELSE 0 END) AS unverified_calls,
         SUM(CASE WHEN cost_status = 'failed' THEN 1 ELSE 0 END) AS failed_calls,
         SUM(CASE WHEN cost_status = 'escalated' THEN 1 ELSE 0 END) AS escalated_calls,
         COALESCE(SUM(verified_savings_premium_usd), 0) AS verified_premium_usd,
         COALESCE(SUM(potential_savings_premium_usd), 0) AS potential_premium_usd
       FROM delegation_costs
       WHERE ts >= @since
       GROUP BY task_type
       ORDER BY verified_premium_usd DESC, potential_premium_usd DESC, calls DESC, task_type ASC`
    )
    .all({ since }) as TaskSavingsDbRow[];

  return rows.map((r) => ({
    taskType: r.task_type,
    calls: r.calls,
    verifiedCalls: r.verified_calls,
    unverifiedCalls: r.unverified_calls,
    failedCalls: r.failed_calls,
    escalatedCalls: r.escalated_calls,
    verifiedSavingsPremiumSek: usdToSek(r.verified_premium_usd, sekRate),
    potentialSavingsPremiumSek: usdToSek(r.potential_premium_usd, sekRate),
  }));
}

export function buildSavingsTimeseriesPanel(rows: DailySavings[], days: number): TimeseriesPanel {
  const latest = rows[rows.length - 1];
  return {
    service: SERVICE,
    panel: SAVINGS_PANEL,
    kind: "timeseries",
    label: "Verified M5 delegation savings vs premium baseline",
    unit: "SEK",
    points: rows.map((r) => ({ t: r.date, y: r.verifiedSavingsPremiumSek })),
    summary: {
      latest: latest?.verifiedSavingsPremiumSek ?? 0,
      window: `${days}d`,
      n: rows.reduce((sum, r) => sum + r.calls, 0),
    },
    detail: {
      kind: "table",
      cols: [
        "date",
        "calls",
        "verified",
        "unverified",
        "failed",
        "escalated",
        "verified premium SEK",
        "potential premium SEK",
      ],
      rows: rows.map((r) => ({
        date: r.date,
        calls: r.calls,
        verified: r.verifiedCalls,
        unverified: r.unverifiedCalls,
        failed: r.failedCalls,
        escalated: r.escalatedCalls,
        "verified premium SEK": r.verifiedSavingsPremiumSek,
        "potential premium SEK": r.potentialSavingsPremiumSek,
      })),
    },
  };
}

export function buildSavingsByTaskPanel(rows: SavingsByTaskType[], days: number): TablePanel {
  return {
    service: SERVICE,
    panel: TASK_PANEL,
    kind: "table",
    label: `M5 delegation savings by task type (${days}d)`,
    cols: [
      "task type",
      "calls",
      "verified",
      "unverified",
      "failed",
      "escalated",
      "verified premium SEK",
      "potential premium SEK",
    ],
    rows: rows.map((r) => ({
      "task type": r.taskType,
      calls: r.calls,
      verified: r.verifiedCalls,
      unverified: r.unverifiedCalls,
      failed: r.failedCalls,
      escalated: r.escalatedCalls,
      "verified premium SEK": r.verifiedSavingsPremiumSek,
      "potential premium SEK": r.potentialSavingsPremiumSek,
    })),
  };
}

async function pushAndVerify(payload: TimeseriesPanel | TablePanel): Promise<void> {
  const pushed = await pushPanel(payload);
  if (!pushed.ok) {
    throw new Error(`POST ${payload.panel} failed: ${pushed.error ?? `HTTP ${pushed.status}: ${pushed.body ?? ""}`}`);
  }
  const verified = await verifyPanelLanded(payload.service, payload.panel, {
    maxAgeMs: READBACK_MAX_AGE_MS,
  });
  if (!verified.ok) {
    throw new Error(`read-back failed for ${payload.panel}: ${verifyProblem(verified)}`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const dryRun = args.includes("--dry-run");
  const dbPath = flag("--db") ?? process.env["EVAL_DB_PATH"] ?? "./data/eval.db";
  const days = Number(flag("--days") ?? DEFAULT_DAYS);
  const sekRate = Number(process.env["HOMESERVER_USD_TO_SEK"] ?? 10.5);
  const db = openReadOnlySavingsDb(dbPath);
  const daily = queryDailySavings(db, Number.isFinite(days) && days > 0 ? days : DEFAULT_DAYS, Date.now(), sekRate);
  const byTask = querySavingsByTaskType(db, Number.isFinite(days) && days > 0 ? days : DEFAULT_DAYS, Date.now(), sekRate);
  const panels = [
    buildSavingsTimeseriesPanel(daily, Number.isFinite(days) && days > 0 ? days : DEFAULT_DAYS),
    buildSavingsByTaskPanel(byTask, Number.isFinite(days) && days > 0 ? days : DEFAULT_DAYS),
  ];

  if (dryRun) {
    console.log(JSON.stringify(panels, null, 2));
    return;
  }

  for (const panel of panels) {
    await pushAndVerify(panel);
    console.log(`[post-savings] verified '${panel.panel}' landed`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : err);
    process.exit(1);
  });
}
