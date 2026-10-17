import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { COMPUTE_REQUEST_FILTER_EPOCH } from "../src/homeserver/compute-request-filter.js";
import { queryLatestSuccessfulM5InferenceAt } from "../src/homeserver/inference-freshness.js";

const NOW = Date.UTC(2026, 9, 9, 12);

let db: Database.Database;
let seq = 0;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(`
    CREATE TABLE request_log (
      id TEXT PRIMARY KEY,
      ts INTEGER NOT NULL,
      model TEXT NOT NULL,
      node TEXT NOT NULL,
      route TEXT NOT NULL,
      status INTEGER NOT NULL,
      outcome TEXT NOT NULL,
      admission TEXT,
      compute_filter_epoch TEXT
    );
  `);
  seq = 0;
});

afterEach(() => db.close());

function insertRow(overrides: Partial<{
  ts: number;
  model: string;
  node: string;
  route: string;
  status: number;
  outcome: string;
  admission: string;
  epoch: string;
}> = {}): void {
  seq += 1;
  const row = {
    ts: NOW - seq * 1_000,
    model: "m5-model",
    node: "m5",
    route: "/v1/chat/completions",
    status: 200,
    outcome: "ok",
    admission: "admitted",
    epoch: COMPUTE_REQUEST_FILTER_EPOCH,
    ...overrides,
  };
  db.prepare(`
    INSERT INTO request_log (id, ts, model, node, route, status, outcome, admission, compute_filter_epoch)
    VALUES (@id, @ts, @model, @node, @route, @status, @outcome, @admission, @epoch)
  `).run({ id: `row-${seq}`, ...row });
}

describe("queryLatestSuccessfulM5InferenceAt", () => {
  it("returns the newest observed successful admitted M5 inference as ISO UTC", () => {
    const olderSuccess = NOW - 20_000;
    const latestSuccess = NOW - 10_000;
    insertRow({ ts: olderSuccess });
    insertRow({ ts: latestSuccess });

    insertRow({ ts: NOW - 9_000, outcome: "error" });
    insertRow({ ts: NOW - 8_000, admission: "rejected" });
    insertRow({ ts: NOW - 7_000, node: "orin" });
    insertRow({ ts: NOW - 6_000, route: "/mcp" });
    insertRow({ ts: NOW - 5_000, epoch: "legacy-route-only" });
    insertRow({ ts: NOW + 1_000 });

    expect(queryLatestSuccessfulM5InferenceAt(db, NOW)).toBe(new Date(latestSuccess).toISOString());
  });

  it("excludes non-2xx outcomes even when the outcome label is ok", () => {
    insertRow({ ts: NOW - 1_000, status: 199 });
    insertRow({ ts: NOW - 500, status: 300 });

    expect(queryLatestSuccessfulM5InferenceAt(db, NOW)).toBeNull();
  });

  it("returns null when no successful admitted request exists", () => {
    expect(queryLatestSuccessfulM5InferenceAt(db, NOW)).toBeNull();
  });

  it("validates now and propagates database errors", () => {
    expect(() => queryLatestSuccessfulM5InferenceAt(db, Number.NaN)).toThrow(RangeError);
    expect(() => queryLatestSuccessfulM5InferenceAt(db, Number.MAX_VALUE)).toThrow(RangeError);

    const closed = new Database(":memory:");
    closed.close();
    expect(() => queryLatestSuccessfulM5InferenceAt(closed, NOW)).toThrow();
  });
});
