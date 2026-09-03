#!/usr/bin/env tsx
/**
 * post-utilization-panel.ts — daily M5 box-utilization panel, pushed to Heimdall.
 *
 * WHY: the project's own finding is "capability is ahead of adoption" — organic ask/MCP usage
 * runs 8–76 calls/day vs 800–1900 on benchmark days. That gap is invisible unless someone reads
 * a log file. This script makes it a standing dashboard trend so day-over-day adoption is
 * actually visible and improvement (or regression) can be measured over time, the same way
 * `post-offloadability-panel.ts` did for the disagreement-gate fire-rate.
 *
 * DATA SOURCE: the content-blind, pseudonymous `request_log` table (src/homeserver/request-log.ts)
 * — READ-ONLY, on the box's live `data/eval.db`. Nothing here reads alias, key_hash, or any
 * prompt/response content; only node/admission/tier/model/route/token-count/timestamp columns are
 * touched.
 *
 * SCHEMA SURPRISE — `/healthz` (and the other 3 read-only monitor routes `/metrics`, `/ledger`,
 * `/models`) get a `request_log` row on EVERY hit, unconditionally, whenever `HOMESERVER_REQUEST_LOG`
 * is "on" (default). This is INDEPENDENT of `accessLogHealthz` (default off), which only gates the
 * separate structured text log — NOT this DB write (see gateway.ts's single `finally` block: the
 * `/healthz` branch returns early but still falls through the same `finally` that calls
 * `recordRequestLog`). A Cloudflare Tunnel / uptime monitor polling `/healthz` every few seconds
 * would otherwise swamp a genuine "247 calls/day" adoption signal with thousands of infra pings.
 * These four are exactly the routes a "read-only MONITOR principal" is limited to (see gateway.ts),
 * i.e. they are infrastructure surfaces by construction, never a human/agent "ask". All aggregation
 * below counts only real usage via the USAGE_ROUTES include-list (they are excluded by omission,
 * along with portal/admin/other non-usage routes — see the shared compute-request filter for the
 * full rationale). Filter epoch: `m5-admitted-compute-v2`; older panels are a historical break.
 *
 * Pushes TWO panels to Heimdall on service `m5-inference` (self-registering by (service, panel),
 * like every other poster — no Heimdall code change):
 *   - `m5-utilization`         timeseries — requests/day for the last 14 UTC-calendar days.
 *                              The Heimdall timeseries contract carries one y-series per panel, so
 *                              the owner/guest split + tokens/day live in the nested `detail` table
 *                              (one row per day: date/requests/owner/guest/tokens) — same technique
 *                              `post-offloadability-panel.ts` uses for its by-model breakdown.
 *   - `m5-utilization-models`  table — 7-day per-model rollup (calls, output tokens, share %).
 *
 * "Today-so-far" is implemented as a rolling trailing-24h window (not a UTC-midnight-anchored
 * calendar day) so the number is meaningful regardless of what hour the nightly cron actually
 * runs at, and it drives the printed summary line, e.g. "247 calls / 1.2M tok last 24h".
 *
 * USAGE   tsx scripts/post-utilization-panel.ts [--dry-run] [--db <path>]
 * ENV     HEIMDALL_PANELS_URL, HEIMDALL_FLEET_TOKEN (see src/homeserver/heimdall-push.ts),
 *         EVAL_DB_PATH (default ./data/eval.db)
 */
import Database from "better-sqlite3";
import { pathToFileURL } from "node:url";

import { pushPanel, verifyPanelLanded, verifyProblem, type TablePanel, type TimeseriesPanel } from "../src/homeserver/heimdall-push.js";
import {
  COMPUTE_REQUEST_FILTER_EPOCH,
  COMPUTE_REQUEST_FILTER_SQL,
  M5_COMPUTE_ROUTES,
} from "../src/homeserver/compute-request-filter.js";

const SERVICE = "m5-inference";
// Read-back freshness window: the panel we just pushed must have updated within this window to
// count as landed. Generous enough to absorb clock skew + Heimdall write latency.
const READBACK_MAX_AGE_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Default lookback for the daily timeseries panel. */
export const DEFAULT_SERIES_DAYS = 14;
/** Default lookback for the per-model rollup table. */
export const DEFAULT_ROLLUP_DAYS = 7;
/** Cap on distinct model rows shown in the rollup table (defensive; usually far fewer). */
const DEFAULT_MODEL_ROW_LIMIT = 30;

/** @deprecated Use the shared M5_COMPUTE_ROUTES source of truth. */
export const USAGE_ROUTES = M5_COMPUTE_ROUTES;

// ─── UTC calendar-day helpers ────────────────────────────────────────────────────────────

/** Epoch ms of UTC midnight for the calendar day containing `ms`. */
export function utcDayStart(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** `YYYY-MM-DD` (UTC) for the calendar day containing `ms`. */
export function utcDateString(ms: number): string {
  return new Date(utcDayStart(ms)).toISOString().slice(0, 10);
}

/** Start of an N-UTC-calendar-day window ending on (and including) today. */
function windowStartMs(now: number, days: number): number {
  return utcDayStart(now) - (days - 1) * DAY_MS;
}

// ─── Row shapes ───────────────────────────────────────────────────────────────────────────

export interface DailyUtilization {
  /** YYYY-MM-DD, UTC. */
  date: string;
  requests: number;
  ownerRequests: number;
  guestRequests: number;
  /**
   * Usage-route requests belonging to neither the owner nor a guest tier — i.e.
   * `requests - owner - guest`. These are the null-tier remainder (a MONITOR principal,
   * or a failed-auth 401/403 on a real usage route). Surfaced explicitly so the detail
   * table reconciles: requests === owner + guest + other (it otherwise looked like the
   * columns didn't add up).
   */
  otherRequests: number;
  /** SUM(total_tokens) — prompt + completion combined ("in+out"). */
  tokens: number;
}

export interface ModelRollupRow {
  model: string;
  calls: number;
  /** SUM(completion_tokens) for this model. */
  outputTokens: number;
  /** Share of total in-window calls, 0-100, rounded to 1 decimal. */
  sharePct: number;
}

export interface RecentStat {
  calls: number;
  tokens: number;
}

interface DailyDbRow {
  date: string;
  requests: number;
  owner_requests: number;
  guest_requests: number;
  tokens: number;
}

interface ModelDbRow {
  model: string;
  calls: number;
  output_tokens: number;
}

// ─── Aggregation (pure given an opened DB handle) ─────────────────────────────────────────

/**
 * Daily series over the last `days` UTC-calendar days (oldest first, always exactly `days`
 * entries — zero-filled for days with no traffic). The most recent entry is "today so far".
 */
export function queryDailySeries(
  db: Database.Database,
  days: number = DEFAULT_SERIES_DAYS,
  now: number = Date.now()
): DailyUtilization[] {
  const since = windowStartMs(now, days);
  const rows = db
    .prepare(
      `SELECT
         strftime('%Y-%m-%d', ts / 1000, 'unixepoch') AS date,
         COUNT(*)                                      AS requests,
         SUM(CASE WHEN tier = 'owner' THEN 1 ELSE 0 END) AS owner_requests,
         SUM(CASE WHEN tier = 'guest' THEN 1 ELSE 0 END) AS guest_requests,
         COALESCE(SUM(total_tokens), 0)                 AS tokens
       FROM request_log
       WHERE ${COMPUTE_REQUEST_FILTER_SQL}
         AND ts >= @since
         AND ts <= @now
       GROUP BY date`
    )
    .all({ since, now }) as DailyDbRow[];

  const byDate = new Map(rows.map((r) => [r.date, r]));
  const out: DailyUtilization[] = [];
  for (let i = 0; i < days; i++) {
    const date = utcDateString(since + i * DAY_MS);
    const r = byDate.get(date);
    const requests = r?.requests ?? 0;
    const ownerRequests = r?.owner_requests ?? 0;
    const guestRequests = r?.guest_requests ?? 0;
    out.push({
      date,
      requests,
      ownerRequests,
      guestRequests,
      otherRequests: requests - ownerRequests - guestRequests,
      tokens: r?.tokens ?? 0,
    });
  }
  return out;
}

/** Per-model rollup over the last `days` UTC-calendar days, sorted by calls desc. */
export function queryModelRollup(
  db: Database.Database,
  days: number = DEFAULT_ROLLUP_DAYS,
  now: number = Date.now()
): ModelRollupRow[] {
  const since = windowStartMs(now, days);
  const rows = db
    .prepare(
      `SELECT model,
              COUNT(*)                        AS calls,
              COALESCE(SUM(completion_tokens), 0) AS output_tokens
       FROM request_log
       WHERE ${COMPUTE_REQUEST_FILTER_SQL}
         AND ts >= @since
         AND ts <= @now
       GROUP BY model
       ORDER BY calls DESC, model ASC`
    )
    .all({ since, now }) as ModelDbRow[];

  const totalCalls = rows.reduce((sum, r) => sum + r.calls, 0);
  return rows.map((r) => ({
    model: r.model,
    calls: r.calls,
    outputTokens: r.output_tokens,
    sharePct: totalCalls > 0 ? Math.round((r.calls / totalCalls) * 1000) / 10 : 0,
  }));
}

/** Rolling trailing-window (default 24h) calls + tokens — the "today so far" headline stat. */
export function queryRecentStat(
  db: Database.Database,
  hours = 24,
  now: number = Date.now()
): RecentStat {
  const since = now - hours * 60 * 60 * 1000;
  const row = db
    .prepare(
      `SELECT COUNT(*) AS calls, COALESCE(SUM(total_tokens), 0) AS tokens
       FROM request_log
       WHERE ${COMPUTE_REQUEST_FILTER_SQL}
         AND ts >= @since
         AND ts <= @now`
    )
    .get({ since, now }) as { calls: number; tokens: number };
  return { calls: row.calls, tokens: row.tokens };
}

// ─── Formatting ─────────────────────────────────────────────────────────────────────────

/** "1234" / "2.5k" / "1.2M" — compact human token counts for the summary line. */
export function formatTokenCount(n: number): string {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(1)}k`;
  return `${sign}${abs}`;
}

/** "last 24h" / "last 6h" — derives the summary-line window label from the lookback hours,
 *  instead of a string hardcoded to the (currently-default) 24h window. */
export function windowLabel(hours: number): string {
  return `last ${hours}h`;
}

/** e.g. "247 calls / 1.2M tok last 24h" (or "last 6h" etc. for a non-default `hours`). */
export function formatSummaryLine(stat: RecentStat, hours: number = 24): string {
  return `${stat.calls} calls / ${formatTokenCount(stat.tokens)} tok ${windowLabel(hours)}`;
}

// ─── Envelope builders (pure → testable) ──────────────────────────────────────────────────

/** requests/day timeseries + a by-day detail table (owner/guest split + tokens). */
export function buildUtilizationTimeseriesPanel(daily: DailyUtilization[]): TimeseriesPanel {
  const points = daily.map((d) => ({ t: d.date, y: d.requests }));
  const last = daily[daily.length - 1];
  const panel: TimeseriesPanel = {
    service: SERVICE,
    panel: "m5-utilization",
    kind: "timeseries",
    label: `M5 utilization — requests/day (detail: owner/guest/other split + tokens in+out per day) [filter ${COMPUTE_REQUEST_FILTER_EPOCH}]`,
    unit: "requests",
    points,
  };
  if (last) {
    panel.summary = { latest: last.requests, window: `${daily.length}d`, n: daily.length };
    panel.detail = {
      kind: "table",
      cols: ["date", "requests", "owner", "guest", "other", "tokens"],
      rows: daily.map((d) => ({
        date: d.date,
        requests: d.requests,
        owner: d.ownerRequests,
        guest: d.guestRequests,
        other: d.otherRequests,
        tokens: d.tokens,
      })),
    };
  }
  return panel;
}

/** Per-model 7-day rollup → a table panel. */
export function buildModelRollupTablePanel(
  rollup: ModelRollupRow[],
  days: number = DEFAULT_ROLLUP_DAYS,
  limit: number = DEFAULT_MODEL_ROW_LIMIT
): TablePanel {
  return {
    service: SERVICE,
    panel: "m5-utilization-models",
    kind: "table",
    label: `M5 utilization — per-model rollup (last ${days}d) [filter ${COMPUTE_REQUEST_FILTER_EPOCH}]`,
    cols: ["model", "calls", "outputTokens", "sharePct"],
    rows: rollup.slice(0, limit).map((r) => ({
      model: r.model,
      calls: r.calls,
      outputTokens: r.outputTokens,
      sharePct: r.sharePct,
    })),
  };
}

// ─── Missing-table grace (finding 2) ──────────────────────────────────────────────────────

/**
 * True iff `request_log` exists in this DB. A freshly-created / pre-deploy `eval.db` (or one
 * built with `HOMESERVER_REQUEST_LOG` off) won't have the table yet — querying it would throw
 * "no such table: request_log" instead of the clean, expected "nothing to push yet" outcome.
 */
export function hasRequestLogTable(db: Database.Database): boolean {
  const row = db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'request_log'`)
    .get();
  return row !== undefined;
}

// ─── Entrypoint ─────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const dbPath = flag("--db") ?? process.env["EVAL_DB_PATH"] ?? "./data/eval.db";

  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch (err) {
    console.error(`[utilization-panel] cannot open DB at ${dbPath}: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  try {
    // Grace path: a fresh / pre-deploy DB (or HOMESERVER_REQUEST_LOG=off) has no request_log
    // table yet. Exit cleanly (0) instead of letting the query throw "no such table".
    if (!hasRequestLogTable(db)) {
      console.log("[utilization-panel] request_log not present yet — nothing to push");
      return;
    }

    const daily = queryDailySeries(db);
    const rollup = queryModelRollup(db);
    const recent = queryRecentStat(db);

    const timeseries = buildUtilizationTimeseriesPanel(daily);
    const table = buildModelRollupTablePanel(rollup);
    const summaryLine = formatSummaryLine(recent);

    if (dryRun) {
      console.log(JSON.stringify({ filterEpoch: COMPUTE_REQUEST_FILTER_EPOCH, timeseries, table, summaryLine }, null, 2));
      return;
    }

    let failed = false;
    for (const panel of [timeseries, table] as const) {
      const r = await pushPanel(panel);
      if (r.ok) {
        console.log(`[utilization-panel] pushed '${panel.panel}' (HTTP ${r.status})`);
        // A 200 only means "accepted" — read it back to prove it's actually stored/visible
        // (heimdall#102: pushes landed in an invisible drawer while every push returned 200).
        const v = await verifyPanelLanded(SERVICE, panel.panel, { maxAgeMs: READBACK_MAX_AGE_MS });
        if (v.ok) {
          console.log(`[utilization-panel] verified '${panel.panel}' landed (read-back ok)`);
        } else {
          failed = true;
          console.error(`[utilization-panel] READ-BACK FAILED for '${panel.panel}': ${verifyProblem(v)} — panel may not be visible in Heimdall`);
        }
      } else {
        failed = true;
        console.error(`[utilization-panel] push failed for '${panel.panel}': ${r.error ?? `HTTP ${r.status}: ${r.body}`}`);
      }
    }
    console.log(`[utilization-panel] ${summaryLine}`);
    if (failed) process.exit(1);
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
  });
}
