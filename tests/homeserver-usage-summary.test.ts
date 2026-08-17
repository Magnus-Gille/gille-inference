import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";

import {
  M5_INFERENCE_ROUTES,
  queryM5UsageSummary,
} from "../src/homeserver/usage-summary.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 7, 17, 12, 0, 0);

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(`
    CREATE TABLE request_log (
      id TEXT PRIMARY KEY,
      ts INTEGER NOT NULL,
      alias TEXT,
      tier TEXT,
      key_hash TEXT,
      model TEXT NOT NULL,
      node TEXT NOT NULL DEFAULT 'm5',
      route TEXT NOT NULL,
      status INTEGER NOT NULL,
      outcome TEXT NOT NULL,
      error_class TEXT,
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      total_tokens INTEGER,
      queue_wait_ms INTEGER,
      ttft_ms INTEGER,
      total_ms INTEGER NOT NULL,
      admission TEXT
    )
  `);
});

afterEach(() => db.close());

function insert(over: Partial<{
  id: string;
  ts: number;
  alias: string | null;
  tier: string | null;
  node: string;
  route: string;
  status: number;
  outcome: string;
  totalMs: number;
  admission: string | null;
}> = {}): void {
  const row = {
    id: `r-${Math.random().toString(36).slice(2)}`,
    ts: NOW,
    alias: "owner",
    tier: "owner",
    node: "m5",
    route: "/v1/chat/completions",
    status: 200,
    outcome: "ok",
    totalMs: 1_000,
    admission: "admitted",
    ...over,
  };
  db.prepare(`
    INSERT INTO request_log
      (id, ts, alias, tier, model, node, route, status, outcome, total_ms, admission)
    VALUES
      (@id, @ts, @alias, @tier, 'mellum', @node, @route, @status, @outcome, @totalMs, @admission)
  `).run(row);
}

describe("queryM5UsageSummary", () => {
  it("returns a zero-filled seven-day series with the newest day first", () => {
    insert({ ts: NOW - DAY_MS, totalMs: 2_500 });

    const summary = queryM5UsageSummary(db, { now: NOW, days: 7, activeRequests: 0 });

    expect(summary.generatedAt).toBe(new Date(NOW).toISOString());
    expect(summary.daily).toHaveLength(7);
    expect(summary.daily[0]).toEqual({ date: "2026-08-17", requests: 0, requestTimeMs: 0 });
    expect(summary.daily[1]).toEqual({ date: "2026-08-16", requests: 1, requestTimeMs: 2_500 });
    expect(summary.daily[6]?.date).toBe("2026-08-11");
  });

  it("counts only admitted M5 compute calls and never the outer MCP transport row", () => {
    for (const route of M5_INFERENCE_ROUTES) insert({ route });
    insert({ route: "/mcp" });
    insert({ route: "/models" });
    insert({ route: "/v1/chat/completions", node: "orin" });
    insert({ route: "/v1/chat/completions", admission: "busy", status: 503, outcome: "busy" });
    insert({ route: "/v1/chat/completions", admission: "n/a", status: 401, outcome: "auth_failed" });

    const summary = queryM5UsageSummary(db, { now: NOW, activeRequests: 2 });

    expect(summary.last24Hours.requests).toBe(M5_INFERENCE_ROUTES.length);
    expect(summary.last24Hours.requestTimeMs).toBe(M5_INFERENCE_ROUTES.length * 1_000);
    expect(summary.activeRequests).toBe(2);
  });

  it("reports trailing-24-hour and seven-calendar-day totals separately", () => {
    insert({ ts: NOW - 2 * 60 * 60 * 1000, totalMs: 500 });
    insert({ ts: NOW - 2 * DAY_MS, totalMs: 1_500 });
    insert({ ts: NOW - 8 * DAY_MS, totalMs: 9_000 });

    const summary = queryM5UsageSummary(db, { now: NOW, days: 7 });

    expect(summary.last24Hours).toEqual({ requests: 1, requestTimeMs: 500 });
    expect(summary.last7Days).toEqual({ requests: 2, requestTimeMs: 2_000 });
    expect(summary.lastUsedAt).toBe(new Date(NOW - 2 * 60 * 60 * 1000).toISOString());
  });

  it("splits the last 24 hours into owner, guest, and other without exposing identities", () => {
    insert({ tier: "owner", alias: "private-owner", totalMs: 600 });
    insert({ tier: "owner", alias: "private-owner-two", totalMs: 400 });
    insert({ tier: "guest", alias: "private-guest", totalMs: 2_000 });
    insert({ tier: null, alias: "legacy-caller", totalMs: 250 });
    insert({ tier: "guest", ts: NOW - 2 * DAY_MS, totalMs: 9_000 });

    const summary = queryM5UsageSummary(db, { now: NOW });

    expect(summary.last24HoursByTier).toEqual({
      owner: { requests: 2, requestTimeMs: 1_000 },
      guest: { requests: 1, requestTimeMs: 2_000 },
      other: { requests: 1, requestTimeMs: 250 },
    });
    expect(
      summary.last24HoursByTier.owner.requests
      + summary.last24HoursByTier.guest.requests
      + summary.last24HoursByTier.other.requests,
    ).toBe(summary.last24Hours.requests);
    expect(JSON.stringify(summary)).not.toMatch(/private-owner|private-guest|legacy-caller/);
  });

  it("has a deliberately small content-blind response shape", () => {
    insert({ alias: "private-operator-alias" });
    const summary = queryM5UsageSummary(db, { now: NOW });
    const json = JSON.stringify(summary);

    expect(Object.keys(summary).sort()).toEqual([
      "activeRequests",
      "daily",
      "generatedAt",
      "last24Hours",
      "last24HoursByTier",
      "last7Days",
      "lastUsedAt",
    ]);
    expect(json).not.toContain("private-operator-alias");
    expect(json).not.toMatch(/alias|key|hash|token|prompt|response|content|model/i);
  });
});
