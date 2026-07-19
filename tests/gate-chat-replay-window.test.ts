/**
 * TDD for the --recent/--since time-window parsing in gate-chat-replay.ts.
 * Red first: written BEFORE the parsing logic exists.
 *
 * The window narrows the offline gate replay to recent owner_request_log traffic so the
 * nightly offloadability trend reflects (e.g.) the last 24h rather than all-time.
 */
import { describe, it, expect, beforeAll } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDurationMs, parseWindow, loadChatRequests, readFlag } from "../scripts/gate-chat-replay.js";

const NOW = Date.parse("2026-06-26T12:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 86_400_000;

describe("parseDurationMs", () => {
  it("parses hours", () => expect(parseDurationMs("24h")).toBe(24 * HOUR));
  it("parses days", () => expect(parseDurationMs("7d")).toBe(7 * DAY));
  it("parses minutes", () => expect(parseDurationMs("90m")).toBe(90 * 60_000));
  it("parses weeks", () => expect(parseDurationMs("2w")).toBe(2 * 7 * DAY));
  it("tolerates surrounding whitespace", () => expect(parseDurationMs("  12h ")).toBe(12 * HOUR));
  it("rejects a zero quantity", () => expect(() => parseDurationMs("0h")).toThrow());
  it("rejects a missing unit", () => expect(() => parseDurationMs("24")).toThrow());
  it("rejects an unknown unit", () => expect(() => parseDurationMs("3y")).toThrow());
  it("rejects gibberish", () => expect(() => parseDurationMs("xyz")).toThrow());
});

describe("parseWindow", () => {
  it("--recent computes an ISO cutoff relative to now", () => {
    const { sinceIso } = parseWindow({ recent: "24h", now: NOW });
    expect(sinceIso).toBe(new Date(NOW - DAY).toISOString());
  });

  it("--since accepts a bare date (midnight UTC)", () => {
    const { sinceIso } = parseWindow({ since: "2026-06-25", now: NOW });
    expect(sinceIso).toBe("2026-06-25T00:00:00.000Z");
  });

  it("--since accepts a full ISO timestamp and normalizes it", () => {
    const { sinceIso } = parseWindow({ since: "2026-06-25T06:30:00Z", now: NOW });
    expect(sinceIso).toBe("2026-06-25T06:30:00.000Z");
  });

  it("no window → all-time (null cutoff)", () => {
    const { sinceIso, label } = parseWindow({ now: NOW });
    expect(sinceIso).toBeNull();
    expect(label).toMatch(/all-time/i);
  });

  it("--since wins when both are given", () => {
    const { sinceIso } = parseWindow({ recent: "24h", since: "2026-06-20", now: NOW });
    expect(sinceIso).toBe("2026-06-20T00:00:00.000Z");
  });

  it("rejects an unparseable --since", () => {
    expect(() => parseWindow({ since: "not-a-date", now: NOW })).toThrow();
  });

  // Codex finding (low): a timezone-less datetime is ambiguous — owner_request_log.ts is UTC,
  // but Date.parse would read this as LOCAL time and silently shift the cutoff. Reject it.
  it("rejects a timezone-less --since datetime", () => {
    expect(() => parseWindow({ since: "2026-06-25T06:30:00", now: NOW })).toThrow();
  });

  it("accepts a --since with an explicit numeric offset and normalizes to UTC", () => {
    const { sinceIso } = parseWindow({ since: "2026-06-25T06:30:00+02:00", now: NOW });
    expect(sinceIso).toBe("2026-06-25T04:30:00.000Z");
  });
});

describe("readFlag — flag-arity validation", () => {
  // Codex finding (medium): a trailing/empty flag value silently fell through to all-time.
  it("returns undefined when the flag is absent", () => {
    expect(readFlag(["--n", "5"], "--recent")).toBeUndefined();
  });
  it("returns the value when present", () => {
    expect(readFlag(["--recent", "24h"], "--recent")).toBe("24h");
  });
  it("throws when the flag is the last arg (missing value)", () => {
    expect(() => readFlag(["--n", "5", "--recent"], "--recent")).toThrow();
  });
  it("throws when the next token is another flag", () => {
    expect(() => readFlag(["--recent", "--since", "2026-06-25"], "--recent")).toThrow();
  });

  it("label mentions the window for a --recent run", () => {
    const { label } = parseWindow({ recent: "24h", now: NOW });
    expect(label).toMatch(/24h/);
  });
});

describe("loadChatRequests — window filter over owner_request_log", () => {
  const SECONDARY = "qwen-secondary";
  let dbPath: string;

  beforeAll(() => {
    dbPath = join(mkdtempSync(join(tmpdir(), "gate-replay-db-")), "eval.db");
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE owner_request_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, alias TEXT NOT NULL,
      model TEXT, route TEXT NOT NULL, messages_json TEXT NOT NULL, completion TEXT NOT NULL,
      prompt_tokens INTEGER, completion_tokens INTEGER, latency_ms INTEGER, tok_per_sec REAL,
      outcome TEXT NOT NULL);`);
    const ins = db.prepare(
      `INSERT INTO owner_request_log (ts, alias, model, route, messages_json, completion, completion_tokens, outcome)
       VALUES (@ts,'owner',@model,@route,@mj,@completion,@ct,@outcome)`
    );
    const msg = (u: string) => JSON.stringify([{ role: "user", content: u }]);
    // 1: recent, eligible
    ins.run({ ts: "2026-06-26T10:00:00.000Z", model: "primary-a", route: "chat", mj: msg("What is the capital of France here?"), completion: "Paris.", ct: 2, outcome: "ok" });
    // 2: 1 day older, eligible only without a 24h window
    ins.run({ ts: "2026-06-25T10:00:00.000Z", model: "primary-a", route: "chat", mj: msg("Explain the TCP handshake in detail please"), completion: "SYN, SYN-ACK, ACK.", ct: 6, outcome: "ok" });
    // 3: much older, eligible only all-time
    ins.run({ ts: "2026-06-20T10:00:00.000Z", model: "primary-b", route: "mcp", mj: msg("An old question about something here"), completion: "An old answer.", ct: 4, outcome: "ok" });
    // 4: recent BUT served by the secondary → always skipped
    ins.run({ ts: "2026-06-26T11:00:00.000Z", model: SECONDARY, route: "chat", mj: msg("A recent question served by secondary"), completion: "echo", ct: 1, outcome: "ok" });
    // 5: recent BUT wrong route → excluded
    ins.run({ ts: "2026-06-26T09:00:00.000Z", model: "primary-a", route: "completion", mj: msg("A recent question on a non-chat route"), completion: "n/a", ct: 1, outcome: "ok" });
    // 6: recent BUT errored → excluded
    ins.run({ ts: "2026-06-26T08:00:00.000Z", model: "primary-a", route: "chat", mj: msg("A recent question that errored out here"), completion: "partial", ct: 1, outcome: "error" });
    db.close();
  });

  it("all-time (null cutoff) returns every eligible chat/mcp ok row", () => {
    const rows = loadChatRequests(SECONDARY, 100, null, dbPath);
    expect(rows.map((r) => r.id).sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });

  it("a 24h window excludes the day-older and ancient rows", () => {
    const { sinceIso } = parseWindow({ recent: "24h", now: Date.parse("2026-06-26T12:00:00.000Z") });
    const rows = loadChatRequests(SECONDARY, 100, sinceIso, dbPath);
    expect(rows.map((r) => r.id)).toEqual([1]);
  });

  it("--since a bare date includes that day onward", () => {
    const { sinceIso } = parseWindow({ since: "2026-06-25" });
    const rows = loadChatRequests(SECONDARY, 100, sinceIso, dbPath);
    expect(rows.map((r) => r.id).sort((a, b) => a - b)).toEqual([1, 2]);
  });

  it("never returns rows served by the secondary, wrong route, or errored", () => {
    const rows = loadChatRequests(SECONDARY, 100, null, dbPath);
    expect(rows.every((r) => r.model !== SECONDARY)).toBe(true);
    expect(rows.map((r) => r.id)).not.toContain(4);
    expect(rows.map((r) => r.id)).not.toContain(5);
    expect(rows.map((r) => r.id)).not.toContain(6);
  });
});
