/**
 * Tests for the M5 utilization Heimdall panel poster.
 *
 * Builds a temp SQLite DB with the REAL request_log schema (copied verbatim from
 * src/homeserver/request-log.ts's CREATE TABLE — keep these in sync if that ever changes),
 * inserts rows across days/tiers/models/routes, and asserts:
 *   - day bucketing is UTC-calendar-day correct and zero-fills missing days
 *   - owner/guest split and NULL-token handling are correct
 *   - the 7-day model rollup respects the window edge and computes share % correctly
 *   - noise routes (/healthz etc.) are excluded from every aggregate
 *   - envelopes are structurally valid Heimdall panels and NEVER carry content/alias fields
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  queryDailySeries,
  queryModelRollup,
  queryRecentStat,
  buildUtilizationTimeseriesPanel,
  buildModelRollupTablePanel,
  formatTokenCount,
  formatSummaryLine,
  windowLabel,
  utcDateString,
  utcDayStart,
  DEFAULT_SERIES_DAYS,
  DEFAULT_ROLLUP_DAYS,
  USAGE_ROUTES,
  hasRequestLogTable,
} from "../scripts/post-utilization-panel.js";
import { PANEL_ID_RE } from "../src/homeserver/heimdall-push.js";

const DAY_MS = 24 * 60 * 60 * 1000;

// Copied verbatim from src/homeserver/request-log.ts's ensureSchema().
const CREATE_REQUEST_LOG = `
  CREATE TABLE request_log (
    id                TEXT PRIMARY KEY,
    ts                INTEGER NOT NULL,
    alias             TEXT,
    tier              TEXT,
    key_hash          TEXT,
    model             TEXT NOT NULL,
    route             TEXT NOT NULL,
    status            INTEGER NOT NULL,
    outcome           TEXT NOT NULL,
    error_class       TEXT,
    prompt_tokens     INTEGER,
    completion_tokens INTEGER,
    total_tokens      INTEGER,
    queue_wait_ms     INTEGER,
    ttft_ms           INTEGER,
    total_ms          INTEGER NOT NULL,
    admission         TEXT
  );
`;

interface RowInput {
  id: string;
  ts: number;
  alias: string | null;
  tier: string | null;
  keyHash: string | null;
  model: string;
  route: string;
  status: number;
  outcome: string;
  errorClass: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  queueWaitMs: number | null;
  ttftMs: number | null;
  totalMs: number;
  admission: string | null;
}

let dir: string;
let db: Database.Database;
let seq = 0;

function insertRow(over: Partial<RowInput> = {}): void {
  seq += 1;
  const row: RowInput = {
    id: `r-${seq}`,
    ts: Date.now(),
    alias: "alice",
    tier: "owner",
    keyHash: null,
    model: "qwen3-30b-instruct",
    route: "/v1/chat/completions",
    status: 200,
    outcome: "ok",
    errorClass: null,
    promptTokens: 100,
    completionTokens: 50,
    totalTokens: 150,
    queueWaitMs: null,
    ttftMs: 200,
    totalMs: 900,
    admission: "admitted",
    ...over,
  };
  db.prepare(
    `INSERT INTO request_log
       (id, ts, alias, tier, key_hash, model, route, status, outcome, error_class,
        prompt_tokens, completion_tokens, total_tokens, queue_wait_ms, ttft_ms, total_ms, admission)
     VALUES
       (@id, @ts, @alias, @tier, @keyHash, @model, @route, @status, @outcome, @errorClass,
        @promptTokens, @completionTokens, @totalTokens, @queueWaitMs, @ttftMs, @totalMs, @admission)`
  ).run(row);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hs-utilization-panel-test-"));
  db = new Database(join(dir, "test.db"));
  db.exec(CREATE_REQUEST_LOG);
  seq = 0;
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// ─── UTC day helpers ───────────────────────────────────────────────────────────────────

describe("utcDayStart / utcDateString", () => {
  it("floors to UTC midnight regardless of time-of-day", () => {
    const ms = Date.UTC(2026, 5, 15, 23, 59, 59); // 2026-06-15T23:59:59Z
    expect(utcDayStart(ms)).toBe(Date.UTC(2026, 5, 15, 0, 0, 0));
    expect(utcDateString(ms)).toBe("2026-06-15");
  });

  it("formats as YYYY-MM-DD", () => {
    expect(utcDateString(Date.UTC(2026, 0, 3, 5))).toBe("2026-01-03");
  });
});

// ─── queryDailySeries ──────────────────────────────────────────────────────────────────

describe("queryDailySeries", () => {
  it("returns exactly `days` entries, oldest first, zero-filled when empty", () => {
    const now = Date.UTC(2026, 5, 15, 12, 0, 0);
    const series = queryDailySeries(db, DEFAULT_SERIES_DAYS, now);
    expect(series.length).toBe(DEFAULT_SERIES_DAYS);
    expect(series[0]!.date).toBe("2026-06-02"); // 13 days before today
    expect(series[series.length - 1]!.date).toBe("2026-06-15"); // today
    for (const d of series) {
      expect(d.requests).toBe(0);
      expect(d.ownerRequests).toBe(0);
      expect(d.guestRequests).toBe(0);
      expect(d.tokens).toBe(0);
    }
  });

  it("buckets a row into its own UTC calendar day", () => {
    const now = Date.UTC(2026, 5, 15, 12, 0, 0);
    insertRow({ ts: Date.UTC(2026, 5, 14, 23, 59, 0), tier: "owner", totalTokens: 200 });
    const series = queryDailySeries(db, 3, now);
    const day14 = series.find((d) => d.date === "2026-06-14")!;
    const day15 = series.find((d) => d.date === "2026-06-15")!;
    expect(day14.requests).toBe(1);
    expect(day14.tokens).toBe(200);
    expect(day15.requests).toBe(0);
  });

  it("splits owner vs guest requests correctly, ignoring null-tier rows for both buckets", () => {
    const now = Date.UTC(2026, 5, 15, 12, 0, 0);
    insertRow({ ts: now, tier: "owner" });
    insertRow({ ts: now, tier: "guest" });
    insertRow({ ts: now, tier: "guest" });
    insertRow({ ts: now, tier: null }); // e.g. a legacy/implicit-admin call — a usage route, but no tier
    const series = queryDailySeries(db, 1, now);
    const today = series[0]!;
    expect(today.requests).toBe(4);
    expect(today.ownerRequests).toBe(1);
    expect(today.guestRequests).toBe(2);
  });

  it("reports the null-tier remainder as `other`, so requests = owner + guest + other", () => {
    const now = Date.UTC(2026, 5, 15, 12, 0, 0);
    insertRow({ ts: now, tier: "owner" });
    insertRow({ ts: now, tier: "guest" });
    insertRow({ ts: now, tier: "guest" });
    insertRow({ ts: now, tier: null }); // a usage route with no tier — MONITOR / failed-auth remainder
    const today = queryDailySeries(db, 1, now)[0]!;
    expect(today.requests).toBe(4);
    expect(today.ownerRequests).toBe(1);
    expect(today.guestRequests).toBe(2);
    expect(today.otherRequests).toBe(1);
    expect(today.ownerRequests + today.guestRequests + today.otherRequests).toBe(today.requests);
  });

  it("treats NULL total_tokens as 0, not NaN or a dropped row", () => {
    const now = Date.UTC(2026, 5, 15, 12, 0, 0);
    insertRow({ ts: now, totalTokens: null });
    insertRow({ ts: now, totalTokens: 300 });
    const today = queryDailySeries(db, 1, now)[0]!;
    expect(today.requests).toBe(2);
    expect(today.tokens).toBe(300);
  });

  it("excludes non-usage routes (monitor, portal, admin) from requests and tokens", () => {
    const now = Date.UTC(2026, 5, 15, 12, 0, 0);
    const nonUsageRoutes = [
      "/healthz",
      "/metrics",
      "/ledger",
      "/models",
      "/v1/models",
      "/portal",
      "/portal/model-evals.json",
      "/portal/redeem",
      "/portal/stats",
      "/portal/feedback",
      "/portal/me",
      "/hs",
      "/admin/models/load",
      "/v1/images/generations/jobs/abc123",
    ];
    for (const route of nonUsageRoutes) {
      insertRow({ ts: now, route, tier: null, model: "none", totalTokens: 0 });
    }
    insertRow({ ts: now, route: "/v1/chat/completions", tier: "owner", totalTokens: 50 });
    const today = queryDailySeries(db, 1, now)[0]!;
    expect(today.requests).toBe(1);
    expect(today.tokens).toBe(50);
  });

  it("excludes a route string unknown to USAGE_ROUTES (a future non-usage route added later)", () => {
    const now = Date.UTC(2026, 5, 15, 12, 0, 0);
    insertRow({ ts: now, route: "/v1/some-brand-new-endpoint-nobody-added-here", tier: "owner", totalTokens: 999 });
    const today = queryDailySeries(db, 1, now)[0]!;
    expect(today.requests).toBe(0);
    expect(today.tokens).toBe(0);
  });

  it("counts a row for every route in USAGE_ROUTES", () => {
    const now = Date.UTC(2026, 5, 15, 12, 0, 0);
    for (const route of USAGE_ROUTES) {
      insertRow({ ts: now, route, tier: "owner", totalTokens: 1 });
    }
    const today = queryDailySeries(db, 1, now)[0]!;
    expect(today.requests).toBe(USAGE_ROUTES.length);
    expect(today.tokens).toBe(USAGE_ROUTES.length);
  });

  it("excludes a row exactly one day before the window and includes one at the window start boundary", () => {
    const now = Date.UTC(2026, 5, 15, 12, 0, 0);
    const days = 3; // window: 2026-06-13 .. 2026-06-15
    const windowStart = Date.UTC(2026, 5, 13, 0, 0, 0);
    insertRow({ ts: windowStart - 1, tier: "owner" }); // just outside
    insertRow({ ts: windowStart, tier: "owner" }); // exactly at the boundary — included
    const series = queryDailySeries(db, days, now);
    const totalRequests = series.reduce((sum, d) => sum + d.requests, 0);
    expect(totalRequests).toBe(1);
  });
});

// ─── queryModelRollup ──────────────────────────────────────────────────────────────────

describe("queryModelRollup", () => {
  it("aggregates calls and output tokens per model, sorted by calls desc", () => {
    const now = Date.UTC(2026, 5, 15, 12, 0, 0);
    insertRow({ ts: now, model: "qwen3-30b-instruct", completionTokens: 40 });
    insertRow({ ts: now, model: "qwen3-30b-instruct", completionTokens: 60 });
    insertRow({ ts: now, model: "mellum", completionTokens: 10 });
    const rollup = queryModelRollup(db, DEFAULT_ROLLUP_DAYS, now);
    expect(rollup[0]!.model).toBe("qwen3-30b-instruct");
    expect(rollup[0]!.calls).toBe(2);
    expect(rollup[0]!.outputTokens).toBe(100);
    expect(rollup[1]!.model).toBe("mellum");
    expect(rollup[1]!.calls).toBe(1);
  });

  it("computes share % of total in-window calls, summing to ~100", () => {
    const now = Date.UTC(2026, 5, 15, 12, 0, 0);
    insertRow({ ts: now, model: "a" });
    insertRow({ ts: now, model: "a" });
    insertRow({ ts: now, model: "a" });
    insertRow({ ts: now, model: "b" });
    const rollup = queryModelRollup(db, DEFAULT_ROLLUP_DAYS, now);
    const total = rollup.reduce((s, r) => s + r.sharePct, 0);
    expect(total).toBeCloseTo(100, 0);
    expect(rollup.find((r) => r.model === "a")!.sharePct).toBe(75);
    expect(rollup.find((r) => r.model === "b")!.sharePct).toBe(25);
  });

  it("includes an 'unknown' model as its own row, same as any other label", () => {
    const now = Date.UTC(2026, 5, 15, 12, 0, 0);
    insertRow({ ts: now, model: "unknown" });
    const rollup = queryModelRollup(db, DEFAULT_ROLLUP_DAYS, now);
    expect(rollup.map((r) => r.model)).toContain("unknown");
  });

  it("treats NULL completion_tokens as 0", () => {
    const now = Date.UTC(2026, 5, 15, 12, 0, 0);
    insertRow({ ts: now, model: "a", completionTokens: null });
    const rollup = queryModelRollup(db, DEFAULT_ROLLUP_DAYS, now);
    expect(rollup[0]!.outputTokens).toBe(0);
  });

  it("excludes non-usage routes from the rollup", () => {
    const now = Date.UTC(2026, 5, 15, 12, 0, 0);
    insertRow({ ts: now, model: "none", route: "/healthz", tier: null });
    insertRow({ ts: now, model: "none", route: "/portal", tier: null });
    insertRow({ ts: now, model: "none", route: "/admin/keys", tier: null });
    const rollup = queryModelRollup(db, DEFAULT_ROLLUP_DAYS, now);
    expect(rollup.length).toBe(0);
  });

  it("respects the 7-day window edge (a row 8 days old is excluded)", () => {
    const now = Date.UTC(2026, 5, 15, 12, 0, 0);
    const eightDaysAgo = now - 8 * DAY_MS;
    insertRow({ ts: eightDaysAgo, model: "old-model" });
    insertRow({ ts: now, model: "new-model" });
    const rollup = queryModelRollup(db, DEFAULT_ROLLUP_DAYS, now);
    expect(rollup.map((r) => r.model)).toEqual(["new-model"]);
  });
});

// ─── queryRecentStat ───────────────────────────────────────────────────────────────────

describe("queryRecentStat", () => {
  it("counts calls and sums tokens within the trailing window only", () => {
    const now = Date.UTC(2026, 5, 15, 12, 0, 0);
    insertRow({ ts: now - 1 * 60 * 60 * 1000, totalTokens: 100 }); // 1h ago — in
    insertRow({ ts: now - 30 * 60 * 60 * 1000, totalTokens: 999 }); // 30h ago — out
    const stat = queryRecentStat(db, 24, now);
    expect(stat.calls).toBe(1);
    expect(stat.tokens).toBe(100);
  });

  it("excludes non-usage routes", () => {
    const now = Date.UTC(2026, 5, 15, 12, 0, 0);
    insertRow({ ts: now, route: "/healthz", tier: null, model: "none" });
    insertRow({ ts: now, route: "/portal/stats", tier: null, model: "none" });
    const stat = queryRecentStat(db, 24, now);
    expect(stat.calls).toBe(0);
  });

  it("treats NULL total_tokens as 0", () => {
    const now = Date.UTC(2026, 5, 15, 12, 0, 0);
    insertRow({ ts: now, totalTokens: null });
    const stat = queryRecentStat(db, 24, now);
    expect(stat.tokens).toBe(0);
  });
});

// ─── Formatting ─────────────────────────────────────────────────────────────────────────

describe("formatTokenCount", () => {
  it("formats millions with one decimal", () => expect(formatTokenCount(1_200_000)).toBe("1.2M"));
  it("formats thousands with one decimal", () => expect(formatTokenCount(2_500)).toBe("2.5k"));
  it("leaves small numbers as plain integers", () => expect(formatTokenCount(42)).toBe("42"));
  it("handles zero", () => expect(formatTokenCount(0)).toBe("0"));
});

describe("windowLabel", () => {
  it('labels the default 24h window as "last 24h"', () => expect(windowLabel(24)).toBe("last 24h"));
  it('labels an arbitrary N-hour window as "last Nh"', () => {
    expect(windowLabel(6)).toBe("last 6h");
    expect(windowLabel(1)).toBe("last 1h");
    expect(windowLabel(72)).toBe("last 72h");
  });
});

describe("formatSummaryLine", () => {
  it("matches the documented example format for the default 24h window", () => {
    expect(formatSummaryLine({ calls: 247, tokens: 1_200_000 })).toBe("247 calls / 1.2M tok last 24h");
  });

  it("derives the window label from the hours param instead of hardcoding 24h", () => {
    expect(formatSummaryLine({ calls: 9, tokens: 500 }, 6)).toBe("9 calls / 500 tok last 6h");
    expect(formatSummaryLine({ calls: 0, tokens: 0 }, 72)).toBe("0 calls / 0 tok last 72h");
  });
});

// ─── Envelope builders ──────────────────────────────────────────────────────────────────

describe("buildUtilizationTimeseriesPanel", () => {
  it("emits a valid timeseries panel with Heimdall-legal ids", () => {
    const now = Date.UTC(2026, 5, 15, 12, 0, 0);
    const daily = queryDailySeries(db, DEFAULT_SERIES_DAYS, now);
    const panel = buildUtilizationTimeseriesPanel(daily);
    expect(panel.kind).toBe("timeseries");
    expect(panel.service).toBe("m5-inference");
    expect(panel.panel).toBe("m5-utilization");
    expect(PANEL_ID_RE.test(panel.service)).toBe(true);
    expect(PANEL_ID_RE.test(panel.panel)).toBe(true);
    expect(panel.points.length).toBe(DEFAULT_SERIES_DAYS);
  });

  it("carries owner/guest split + tokens in the detail table, keyed to the same dates as points", () => {
    const now = Date.UTC(2026, 5, 15, 12, 0, 0);
    insertRow({ ts: now, tier: "owner", totalTokens: 100 });
    insertRow({ ts: now, tier: "guest", totalTokens: 50 });
    const panel = buildUtilizationTimeseriesPanel(queryDailySeries(db, DEFAULT_SERIES_DAYS, now));
    expect(panel.detail?.kind).toBe("table");
    const todayRow = panel.detail!.rows.find((r) => r["date"] === "2026-06-15")!;
    expect(todayRow["requests"]).toBe(2);
    expect(todayRow["owner"]).toBe(1);
    expect(todayRow["guest"]).toBe(1);
    expect(todayRow["other"]).toBe(0);
    expect(todayRow["tokens"]).toBe(150);
  });

  it("never includes alias, key_hash, or any content-shaped field", () => {
    const now = Date.UTC(2026, 5, 15, 12, 0, 0);
    insertRow({ ts: now, alias: "definitely-secret-alias", tier: "owner" });
    const panel = buildUtilizationTimeseriesPanel(queryDailySeries(db, DEFAULT_SERIES_DAYS, now));
    const json = JSON.stringify(panel);
    expect(json).not.toContain("definitely-secret-alias");
    for (const banned of ["alias", "key_hash", "keyHash", "prompt", "response", "messages", "content"]) {
      expect(json.toLowerCase()).not.toContain(banned.toLowerCase());
    }
  });
});

describe("buildModelRollupTablePanel", () => {
  it("emits a valid table panel with Heimdall-legal ids", () => {
    const now = Date.UTC(2026, 5, 15, 12, 0, 0);
    insertRow({ ts: now, model: "qwen3-30b-instruct" });
    const panel = buildModelRollupTablePanel(queryModelRollup(db, DEFAULT_ROLLUP_DAYS, now));
    expect(panel.kind).toBe("table");
    expect(panel.service).toBe("m5-inference");
    expect(panel.panel).toBe("m5-utilization-models");
    expect(PANEL_ID_RE.test(panel.panel)).toBe(true);
    expect(panel.cols).toEqual(["model", "calls", "outputTokens", "sharePct"]);
    expect(panel.rows[0]).toEqual({ model: "qwen3-30b-instruct", calls: 1, outputTokens: 50, sharePct: 100 });
  });

  it("never includes alias, key_hash, or any content-shaped field", () => {
    const now = Date.UTC(2026, 5, 15, 12, 0, 0);
    insertRow({ ts: now, alias: "another-secret-alias", model: "qwen3-30b-instruct" });
    const panel = buildModelRollupTablePanel(queryModelRollup(db, DEFAULT_ROLLUP_DAYS, now));
    const json = JSON.stringify(panel);
    expect(json).not.toContain("another-secret-alias");
    for (const banned of ["alias", "key_hash", "keyHash", "prompt", "response", "messages", "content"]) {
      expect(json.toLowerCase()).not.toContain(banned.toLowerCase());
    }
  });

  it("honors the row limit", () => {
    const now = Date.UTC(2026, 5, 15, 12, 0, 0);
    for (let i = 0; i < 5; i++) insertRow({ ts: now, model: `model-${i}` });
    const panel = buildModelRollupTablePanel(queryModelRollup(db, DEFAULT_ROLLUP_DAYS, now), DEFAULT_ROLLUP_DAYS, 3);
    expect(panel.rows.length).toBe(3);
  });
});

// ─── Cross-check: rollup totals agree with the daily series over the same window ──────────

// ─── Missing-table grace (finding 2) ──────────────────────────────────────────────────────

describe("hasRequestLogTable", () => {
  it("returns false against a DB that has no request_log table yet (pre-deploy / fresh DB)", () => {
    const bareDb = new Database(join(dir, "bare.db"));
    try {
      expect(hasRequestLogTable(bareDb)).toBe(false);
    } finally {
      bareDb.close();
    }
  });

  it("returns true against a DB with the real request_log schema", () => {
    expect(hasRequestLogTable(db)).toBe(true);
  });
});

describe("consistency: model rollup total calls matches summed daily requests over the same window", () => {
  it("agrees for a 7-day window", () => {
    const now = Date.UTC(2026, 5, 15, 12, 0, 0);
    insertRow({ ts: now, model: "a" });
    insertRow({ ts: now - 1 * DAY_MS, model: "b" });
    insertRow({ ts: now - 6 * DAY_MS, model: "a" }); // still inside a 7-UTC-day window
    insertRow({ ts: now - 9 * DAY_MS, model: "a" }); // outside
    const rollup = queryModelRollup(db, DEFAULT_ROLLUP_DAYS, now);
    const daily = queryDailySeries(db, DEFAULT_ROLLUP_DAYS, now);
    const rollupTotal = rollup.reduce((s, r) => s + r.calls, 0);
    const dailyTotal = daily.reduce((s, d) => s + d.requests, 0);
    expect(rollupTotal).toBe(dailyTotal);
    expect(rollupTotal).toBe(3);
  });
});
