#!/usr/bin/env tsx
/**
 * post-delegate-policy-panel.ts — surface delegate-policy shadow learning on Heimdall.
 *
 * DATA SOURCE: delegation_costs, a content-blind SQLite table written by /delegate and owner MCP
 * ask telemetry. It contains task/model ids, policy mode/action, token counts, and verification
 * status, but never prompts or responses.
 *
 * USAGE   tsx scripts/post-delegate-policy-panel.ts [--dry-run] [--db <path>] [--days 30]
 * ENV     HEIMDALL_PANELS_URL, HEIMDALL_FLEET_TOKEN
 */
import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

import {
  pushPanel,
  verifyPanelLanded,
  verifyProblem,
  type PanelPayload,
  type StatusPanel,
  type TablePanel,
  type TimeseriesPanel,
} from "../src/homeserver/heimdall-push.js";

const SERVICE = "m5-inference";
const STATUS_PANEL = "delegate-policy-status";
const GROWTH_PANEL = "delegate-policy-shadow";
const LANES_PANEL = "delegate-policy-lanes";
const READBACK_MAX_AGE_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_DAYS = 30;

export interface DailyPolicyCounts {
  date: string;
  calls: number;
  allow: number;
  shadow: number;
  deny: number;
  escalated: number;
}

export interface PolicyLaneCounts {
  taskType: string;
  model: string;
  mode: string;
  calls: number;
  allow: number;
  shadow: number;
  deny: number;
  verified: number;
  unverified: number;
  escalated: number;
  totalTokens: number;
  lastSeen: string;
}

interface DailyPolicyDbRow {
  date: string;
  calls: number;
  allow_calls: number;
  shadow_calls: number;
  deny_calls: number;
  escalated_calls: number;
}

interface PolicyLaneDbRow {
  task_type: string;
  local_model: string;
  delegate_policy_mode: string;
  calls: number;
  allow_calls: number;
  shadow_calls: number;
  deny_calls: number;
  verified_calls: number;
  unverified_calls: number;
  escalated_calls: number;
  total_tokens: number;
  last_seen: string;
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

function hasTable(db: Database.Database, table: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table) as { name: string } | undefined;
  return row?.name === table;
}

function tableColumns(db: Database.Database, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

export function hasDelegatePolicyColumns(db: Database.Database): boolean {
  if (!hasTable(db, "delegation_costs")) return false;
  const cols = tableColumns(db, "delegation_costs");
  return cols.has("delegate_policy_mode") && cols.has("delegate_policy_action");
}

export function openReadOnlyPolicyDb(dbPath: string): Database.Database {
  if (!existsSync(dbPath)) {
    return new Database(":memory:");
  }
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}

export function queryDailyPolicyCounts(
  db: Database.Database,
  days: number = DEFAULT_DAYS,
  now: number = Date.now()
): DailyPolicyCounts[] {
  const start = utcDayStart(now) - (days - 1) * DAY_MS;
  if (!hasDelegatePolicyColumns(db)) {
    return Array.from({ length: days }, (_, i) => ({
      date: utcDateString(start + i * DAY_MS),
      calls: 0,
      allow: 0,
      shadow: 0,
      deny: 0,
      escalated: 0,
    }));
  }

  const since = windowStartIso(now, days);
  const rows = db
    .prepare(
      `SELECT
         substr(ts, 1, 10) AS date,
         COUNT(*) AS calls,
         SUM(CASE WHEN delegate_policy_action = 'allow' THEN 1 ELSE 0 END) AS allow_calls,
         SUM(CASE WHEN delegate_policy_action = 'shadow' THEN 1 ELSE 0 END) AS shadow_calls,
         SUM(CASE WHEN delegate_policy_action = 'deny' THEN 1 ELSE 0 END) AS deny_calls,
         SUM(CASE WHEN cost_status = 'escalated' THEN 1 ELSE 0 END) AS escalated_calls
       FROM delegation_costs
       WHERE ts >= @since
         AND delegate_policy_mode IS NOT NULL
         AND delegate_policy_action IS NOT NULL
       GROUP BY date`
    )
    .all({ since }) as DailyPolicyDbRow[];

  const byDate = new Map(rows.map((r) => [r.date, r]));
  const out: DailyPolicyCounts[] = [];
  for (let i = 0; i < days; i++) {
    const date = utcDateString(start + i * DAY_MS);
    const r = byDate.get(date);
    out.push({
      date,
      calls: r?.calls ?? 0,
      allow: r?.allow_calls ?? 0,
      shadow: r?.shadow_calls ?? 0,
      deny: r?.deny_calls ?? 0,
      escalated: r?.escalated_calls ?? 0,
    });
  }
  return out;
}

export function queryPolicyLanes(
  db: Database.Database,
  days: number = DEFAULT_DAYS,
  now: number = Date.now(),
  limit = 12
): PolicyLaneCounts[] {
  if (!hasDelegatePolicyColumns(db)) return [];
  const since = windowStartIso(now, days);
  const rows = db
    .prepare(
      `SELECT
         task_type,
         local_model,
         delegate_policy_mode,
         COUNT(*) AS calls,
         SUM(CASE WHEN delegate_policy_action = 'allow' THEN 1 ELSE 0 END) AS allow_calls,
         SUM(CASE WHEN delegate_policy_action = 'shadow' THEN 1 ELSE 0 END) AS shadow_calls,
         SUM(CASE WHEN delegate_policy_action = 'deny' THEN 1 ELSE 0 END) AS deny_calls,
         SUM(CASE WHEN cost_status = 'verified' THEN 1 ELSE 0 END) AS verified_calls,
         SUM(CASE WHEN cost_status = 'unverified' THEN 1 ELSE 0 END) AS unverified_calls,
         SUM(CASE WHEN cost_status = 'escalated' THEN 1 ELSE 0 END) AS escalated_calls,
         COALESCE(SUM(total_tokens), 0) AS total_tokens,
         MAX(ts) AS last_seen
       FROM delegation_costs
       WHERE ts >= @since
         AND delegate_policy_mode IS NOT NULL
         AND delegate_policy_action IS NOT NULL
       GROUP BY task_type, local_model, delegate_policy_mode
       ORDER BY calls DESC, shadow_calls DESC, deny_calls DESC, task_type ASC, local_model ASC
       LIMIT @limit`
    )
    .all({ since, limit }) as PolicyLaneDbRow[];

  return rows.map((r) => ({
    taskType: r.task_type,
    model: r.local_model,
    mode: r.delegate_policy_mode,
    calls: r.calls,
    allow: r.allow_calls,
    shadow: r.shadow_calls,
    deny: r.deny_calls,
    verified: r.verified_calls,
    unverified: r.unverified_calls,
    escalated: r.escalated_calls,
    totalTokens: r.total_tokens,
    lastSeen: r.last_seen,
  }));
}

export function buildPolicyStatusPanel(
  daily: DailyPolicyCounts[],
  lanes: PolicyLaneCounts[],
  days: number
): StatusPanel {
  const totals = daily.reduce(
    (acc, r) => ({
      calls: acc.calls + r.calls,
      allow: acc.allow + r.allow,
      shadow: acc.shadow + r.shadow,
      deny: acc.deny + r.deny,
      escalated: acc.escalated + r.escalated,
    }),
    { calls: 0, allow: 0, shadow: 0, deny: 0, escalated: 0 }
  );
  const state = totals.calls === 0 ? "warn" : totals.deny > 0 || totals.shadow > 0 ? "warn" : "pass";
  const message =
    totals.calls === 0
      ? `No delegate-policy rows in the last ${days}d yet. Shadow mode is deployed, but needs real /delegate traffic.`
      : `SHADOW: observed ${totals.calls} policy-evaluated delegations in ${days}d (${totals.allow} allow / ${totals.shadow} shadow / ${totals.deny} deny). Shadow mode only observes; it does not change routing.`;

  return {
    service: SERVICE,
    panel: STATUS_PANEL,
    kind: "status",
    label: "Delegate policy — shadow readiness",
    state,
    message,
    detail: {
      kind: "table",
      cols: ["metric", "value"],
      rows: [
        { metric: "mode", value: "shadow observation" },
        { metric: "window", value: `${days}d` },
        { metric: "policy rows", value: totals.calls },
        { metric: "allow / shadow / deny", value: `${totals.allow} / ${totals.shadow} / ${totals.deny}` },
        { metric: "escalated cost traces", value: totals.escalated },
        { metric: "top lane", value: lanes[0] ? `${lanes[0].taskType} on ${lanes[0].model}` : "none yet" },
        { metric: "next action", value: "Keep shadow on; do not enable enforce until high-volume lanes are allow-worthy." },
      ],
    },
  };
}

export function buildPolicyGrowthPanel(rows: DailyPolicyCounts[], days: number): TimeseriesPanel {
  const latest = rows[rows.length - 1];
  return {
    service: SERVICE,
    panel: GROWTH_PANEL,
    kind: "timeseries",
    label: "Delegate-policy shadow dataset growth",
    unit: "calls",
    points: rows.map((r) => ({ t: r.date, y: r.calls })),
    summary: {
      latest: latest?.calls ?? 0,
      window: `${days}d`,
      n: rows.reduce((sum, r) => sum + r.calls, 0),
    },
    detail: {
      kind: "table",
      cols: ["date", "calls", "allow", "shadow", "deny", "escalated"],
      rows: rows.map((r) => ({
        date: r.date,
        calls: r.calls,
        allow: r.allow,
        shadow: r.shadow,
        deny: r.deny,
        escalated: r.escalated,
      })),
    },
  };
}

export function buildPolicyLanesPanel(rows: PolicyLaneCounts[], days: number): TablePanel {
  return {
    service: SERVICE,
    panel: LANES_PANEL,
    kind: "table",
    label: `Delegate-policy lanes (${days}d, shadow)`,
    cols: [
      "task type",
      "model",
      "mode",
      "calls",
      "allow",
      "shadow",
      "deny",
      "verified",
      "unverified",
      "escalated",
      "tokens",
      "last seen",
    ],
    rows: rows.map((r) => ({
      "task type": r.taskType,
      model: r.model,
      mode: r.mode,
      calls: r.calls,
      allow: r.allow,
      shadow: r.shadow,
      deny: r.deny,
      verified: r.verified,
      unverified: r.unverified,
      escalated: r.escalated,
      tokens: r.totalTokens,
      "last seen": r.lastSeen,
    })),
  };
}

async function pushAndVerify(payload: PanelPayload): Promise<void> {
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
  const daysFlag = Number(flag("--days") ?? DEFAULT_DAYS);
  const days = Number.isFinite(daysFlag) && daysFlag > 0 ? daysFlag : DEFAULT_DAYS;
  const db = openReadOnlyPolicyDb(dbPath);
  const daily = queryDailyPolicyCounts(db, days);
  const lanes = queryPolicyLanes(db, days);
  const panels = [
    buildPolicyStatusPanel(daily, lanes, days),
    buildPolicyGrowthPanel(daily, days),
    buildPolicyLanesPanel(lanes, days),
  ];

  if (dryRun) {
    console.log(JSON.stringify(panels, null, 2));
    return;
  }

  for (const panel of panels) {
    await pushAndVerify(panel);
    console.log(`[post-delegate-policy] verified '${panel.panel}' landed`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : err);
    process.exit(1);
  });
}
