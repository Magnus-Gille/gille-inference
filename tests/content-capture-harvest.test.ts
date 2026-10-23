/**
 * #487: metadata-only owner_request_log rows are excluded from every content reader explicitly,
 * not merely because their content columns happen to be empty. Each fixture marks a row
 * `content_capture = 'suppressed'` while (defensively) leaving content in it, simulating a row a
 * future writer bug could produce; the readers must still never return it.
 */
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadChatRequests } from "../scripts/gate-chat-replay.js";
import { ownerLogContentRowsPredicate } from "../src/homeserver/owner-log.js";
import { parseContentCaptureArgument, parseContentCaptureHeader } from "../src/homeserver/content-capture.js";

const OWNER_LOG_DDL = `CREATE TABLE owner_request_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, alias TEXT NOT NULL,
  model TEXT, route TEXT NOT NULL, messages_json TEXT NOT NULL, completion TEXT NOT NULL,
  prompt_tokens INTEGER, completion_tokens INTEGER, latency_ms INTEGER, tok_per_sec REAL,
  outcome TEXT NOT NULL`;

function fixture(withColumn: boolean): string {
  const dbPath = join(mkdtempSync(join(tmpdir(), "content-capture-harvest-")), "eval.db");
  const db = new Database(dbPath);
  db.exec(`${OWNER_LOG_DDL}${withColumn ? ", content_capture TEXT" : ""});`);
  const msg = (u: string) => JSON.stringify([{ role: "user", content: u }]);
  const ins = db.prepare(
    withColumn
      ? `INSERT INTO owner_request_log (ts, alias, model, route, messages_json, completion, completion_tokens, outcome, content_capture)
         VALUES (@ts,'owner','primary',@route,@mj,@completion,2,'ok',@cc)`
      : `INSERT INTO owner_request_log (ts, alias, model, route, messages_json, completion, completion_tokens, outcome)
         VALUES (@ts,'owner','primary',@route,@mj,@completion,2,'ok')`
  );
  ins.run({ ts: "2026-10-20T10:00:00.000Z", route: "chat", mj: msg("An ordinary harvestable owner question"), completion: "An answer.", ...(withColumn ? { cc: null } : {}) });
  if (withColumn) {
    ins.run({ ts: "2026-10-20T11:00:00.000Z", route: "mcp", mj: msg("CANARY_HARVEST restricted owner question"), completion: "CANARY_HARVEST answer", cc: "suppressed" });
  }
  db.close();
  return dbPath;
}

describe("harvest source excludes suppressed owner-log rows", () => {
  it("loadChatRequests never returns a suppressed row", () => {
    const rows = loadChatRequests("secondary", 100, null, fixture(true));
    expect(rows.map((r) => r.id)).toEqual([1]);
    expect(JSON.stringify(rows)).not.toContain("CANARY_HARVEST");
  });

  it("a pre-migration database without the column still loads", () => {
    expect(loadChatRequests("secondary", 100, null, fixture(false)).map((r) => r.id)).toEqual([1]);
  });

  it("the shared predicate is empty only when the column is absent", () => {
    const withCol = new Database(fixture(true), { readonly: true });
    const without = new Database(fixture(false), { readonly: true });
    try {
      expect(ownerLogContentRowsPredicate(withCol)).toContain("content_capture");
      expect(ownerLogContentRowsPredicate(without)).toBe("");
    } finally {
      withCol.close();
      without.close();
    }
  });
});

describe("content-capture parsing fails closed", () => {
  it("accepts only 'none' for the argument", () => {
    expect(parseContentCaptureArgument(undefined)).toEqual({ ok: true, capture: "default" });
    expect(parseContentCaptureArgument("none")).toEqual({ ok: true, capture: "suppressed" });
    for (const bad of ["None", "", "off", "metadata", true, null, 0, ["none"]]) {
      expect(parseContentCaptureArgument(bad).ok).toBe(false);
    }
  });

  it("accepts 'none' case-insensitively for the header and rejects duplicates or other values", () => {
    expect(parseContentCaptureHeader(undefined)).toEqual({ ok: true, capture: "default" });
    expect(parseContentCaptureHeader(" NONE ")).toEqual({ ok: true, capture: "suppressed" });
    for (const bad of ["", "none, none", "full", "suppressed"]) {
      expect(parseContentCaptureHeader(bad).ok).toBe(false);
    }
    expect(parseContentCaptureHeader(["none", "none"]).ok).toBe(false);
  });
});
