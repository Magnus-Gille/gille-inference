/**
 * TDD for the `--task-types` / `--count-only` filter on gate-chat-replay.ts (issue #201
 * fix-forward). Red first: written BEFORE parseTaskTypesFilter / buildCountReport /
 * loadChatRequests's task-type param / TrendRecord.taskTypesFilter exist.
 *
 * Context: the 7.5% launch fire-rate was measured on a benchmark-flood regime of short
 * `extract`/`classify` leaf tasks that ended 2026-06-27. Current organic traffic is dominated by
 * open-ended/agentic rows the output-similarity scorer was never validated against (fire-rate
 * ~95%). The fix-forward is a stratified re-run restricted to the task types the instrument is
 * still valid for — this suite covers: (1) the filter narrows the SAMPLING POOL before `--n`'s
 * stride-sampling cap, not after; (2) an unknown task type is a hard, listed error (a typo must
 * not silently produce an empty/no-op filter); (3) the filter is recorded on the trend record so
 * a filtered run is self-describing from the JSONL spine alone; (4) `--count-only` sizes `--n`
 * with ZERO model calls.
 */
import { describe, it, expect, beforeAll } from "vitest";
import Database from "better-sqlite3";
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  loadChatRequests,
  parseTaskTypesFilter,
  buildCountReport,
  buildTrendRecord,
  parseDurationMs,
} from "../scripts/gate-chat-replay.js";
import { isTrendRecord } from "../scripts/post-offloadability-panel.js";
import { TASK_TYPES } from "../src/homeserver/taxonomy.js";

const REPO_ROOT = resolve(__dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "gate-chat-replay.ts");
const TSX = join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");

// ─────────────────────────────────────────────────────────────────────────
// parseTaskTypesFilter — pure CSV → validated Set<taskTypeId>
// ─────────────────────────────────────────────────────────────────────────
describe("parseTaskTypesFilter", () => {
  it("returns null when the flag is absent (no filtering)", () => {
    expect(parseTaskTypesFilter(undefined)).toBeNull();
  });

  it("parses a comma-separated list of valid task types", () => {
    const s = parseTaskTypesFilter("extract,classify,qa-factual");
    expect(s).not.toBeNull();
    expect([...(s as Set<string>)].sort()).toEqual(["classify", "extract", "qa-factual"]);
  });

  it("trims surrounding whitespace around each id", () => {
    const s = parseTaskTypesFilter(" extract , classify ");
    expect([...(s as Set<string>)].sort()).toEqual(["classify", "extract"]);
  });

  it("dedupes repeated ids", () => {
    const s = parseTaskTypesFilter("extract,extract,classify");
    expect([...(s as Set<string>)].sort()).toEqual(["classify", "extract"]);
  });

  it("a single unknown type is a hard error listing the valid types", () => {
    expect(() => parseTaskTypesFilter("qa_factual")).toThrow(/qa_factual/);
    try {
      parseTaskTypesFilter("qa_factual");
      expect.unreachable();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // The valid list must actually contain the correctly-spelled id, proving this isn't a
      // silently-empty filter masquerading as an error about something else.
      expect(msg).toMatch(/qa-factual/);
      for (const t of TASK_TYPES) expect(msg).toMatch(new RegExp(t.id.replace(/[-]/g, "\\-")));
    }
  });

  it("a mix of valid + invalid reports ONLY the invalid one(s)", () => {
    try {
      parseTaskTypesFilter("extract,bogus-type");
      expect.unreachable();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toMatch(/bogus-type/);
      expect(msg).not.toMatch(/unknown task type\(s\): extract/);
    }
  });

  it("an empty value is a hard error (not a silent no-op null)", () => {
    expect(() => parseTaskTypesFilter("")).toThrow();
    expect(() => parseTaskTypesFilter("   ")).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// buildCountReport — pure aggregation, no I/O (structural proof of "no model calls")
// ─────────────────────────────────────────────────────────────────────────
describe("buildCountReport", () => {
  it("counts rows by task type, sorted descending", () => {
    const r = buildCountReport([
      { taskType: "extract" },
      { taskType: "extract" },
      { taskType: "classify" },
    ]);
    expect(r.total).toBe(3);
    expect(r.byTaskType).toEqual([
      { taskType: "extract", n: 2 },
      { taskType: "classify", n: 1 },
    ]);
  });

  it("handles an empty row set", () => {
    expect(buildCountReport([])).toEqual({ total: 0, byTaskType: [] });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// TrendRecord.taskTypesFilter — recorded only when the flag was used
// ─────────────────────────────────────────────────────────────────────────
describe("buildTrendRecord — taskTypesFilter", () => {
  const base = {
    nowIso: "2026-07-10T03:00:00.000Z",
    windowShort: "9d",
    okCount: 30,
    errCount: 0,
    wouldEscalateCount: 2,
    byModel: [{ model: "primary-a", n: 30, esc: 2 }],
    byTaskType: [{ taskType: "extract", n: 30, esc: 2 }],
    sampledTsSorted: ["2026-07-01T00:00:00.000Z", "2026-07-10T02:00:00.000Z"],
  };

  it("records the filter (sorted/stable) when the flag was used", () => {
    const r = buildTrendRecord({ ...base, taskTypesFilter: ["extract", "classify"] });
    expect(r.taskTypesFilter).toEqual(["extract", "classify"]);
  });

  it("omits the field entirely for an unfiltered run (backward compatible)", () => {
    const r = buildTrendRecord(base);
    expect(r.taskTypesFilter).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(r, "taskTypesFilter")).toBe(false);
  });

  it("a record WITH taskTypesFilter still satisfies isTrendRecord (extra optional field is compatible)", () => {
    const r = buildTrendRecord({ ...base, taskTypesFilter: ["extract"] });
    expect(isTrendRecord(r)).toBe(true);
  });

  it("round-trips through JSON (the actual append-only spine format)", () => {
    const r = buildTrendRecord({ ...base, taskTypesFilter: ["extract"] });
    const parsed = JSON.parse(JSON.stringify(r));
    expect(parsed.taskTypesFilter).toEqual(["extract"]);
    expect(isTrendRecord(parsed)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// loadChatRequests — task-type filter applied BEFORE the --n stride-sampling cap
// ─────────────────────────────────────────────────────────────────────────
describe("loadChatRequests — task-type filter at sampling time (pre-cap)", () => {
  const SECONDARY = "qwen-secondary";
  let dbPath: string;

  beforeAll(() => {
    dbPath = join(mkdtempSync(join(tmpdir(), "gate-replay-tasktype-db-")), "eval.db");
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE owner_request_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, alias TEXT NOT NULL,
      model TEXT, route TEXT NOT NULL, messages_json TEXT NOT NULL, completion TEXT NOT NULL,
      prompt_tokens INTEGER, completion_tokens INTEGER, latency_ms INTEGER, tok_per_sec REAL,
      outcome TEXT NOT NULL);`);
    const ins = db.prepare(
      `INSERT INTO owner_request_log (ts, alias, model, route, messages_json, completion, completion_tokens, outcome)
       VALUES (@ts,'owner',@model,@route,@mj,@completion,@ct,'ok')`
    );
    const msg = (u: string) => JSON.stringify([{ role: "user", content: u }]);
    // Insertion order matters: 3 "extract" rows FIRST (ids 1-3, oldest), THEN 9 "classify" rows
    // (ids 4-12, newest). The query orders `id DESC`, so the newest-first eligible pool is
    // [classify x9 (ids 12..4), extract x3 (ids 3..1)] — i.e. the extract rows sit at the TAIL of
    // the unfiltered pool. This is deliberate: a stride-sample of n=3 over the full 12-row MIXED
    // pool (indices 0,4,8 of a 12-item list) lands entirely inside the classify block, so any
    // implementation that filters AFTER the stride-sample would return ZERO extract rows even
    // though exactly 3 exist — only filtering BEFORE the cap (i.e. over the extract-only pool of
    // 3) returns all 3.
    for (let i = 1; i <= 3; i++) {
      ins.run({
        ts: `2026-07-0${i}T10:00:00.000Z`,
        model: "primary-a",
        route: "chat",
        mj: msg(`extract the value number ${i} from this record`),
        completion: `value ${i}`,
        ct: 2,
      });
    }
    for (let i = 1; i <= 9; i++) {
      ins.run({
        ts: `2026-07-0${i}T11:00:00.000Z`,
        model: "primary-a",
        route: "chat",
        mj: msg(`classify the sentiment of message number ${i} today`),
        completion: `neutral ${i}`,
        ct: 2,
      });
    }
    db.close();
  });

  it("filter-before-cap: --task-types extract with --n 3 returns all 3 extract rows even though they sit outside the unfiltered stride sample", () => {
    const rows = loadChatRequests(SECONDARY, 3, null, dbPath, new Set(["extract"]));
    expect(rows.length).toBe(3);
    expect(rows.every((r) => r.taskType === "extract")).toBe(true);
    expect(rows.map((r) => r.id).sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });

  it("contrast: the SAME n=3 with NO filter samples entirely from the classify block (proves the construction, not the fix)", () => {
    const rows = loadChatRequests(SECONDARY, 3, null, dbPath, null);
    expect(rows.length).toBe(3);
    expect(rows.some((r) => r.taskType === "extract")).toBe(false);
  });

  it("filter to a type with MORE eligible rows than --n returns exactly n, all matching", () => {
    const rows = loadChatRequests(SECONDARY, 3, null, dbPath, new Set(["classify"]));
    expect(rows.length).toBe(3);
    expect(rows.every((r) => r.taskType === "classify")).toBe(true);
  });

  it("filter to a type with FEWER eligible rows than --n returns only what's available (not padded with other types)", () => {
    const rows = loadChatRequests(SECONDARY, 10, null, dbPath, new Set(["extract"]));
    expect(rows.length).toBe(3);
    expect(rows.every((r) => r.taskType === "extract")).toBe(true);
  });

  it("a filter matching no rows returns an empty array, not an error", () => {
    const rows = loadChatRequests(SECONDARY, 10, null, dbPath, new Set(["sql"]));
    expect(rows).toEqual([]);
  });

  it("every row carries its classified taskType even when unfiltered", () => {
    const rows = loadChatRequests(SECONDARY, 100, null, dbPath, null);
    expect(rows.length).toBe(12);
    for (const r of rows) expect(["extract", "classify"]).toContain(r.taskType);
  });

  it("a multi-day --recent window (the stratified-rerun use case, e.g. 9d) still composes with the task-type filter", () => {
    // parseDurationMs already covers d/w units directly; this exercises the same window math
    // end-to-end against real rows spanning several days, combined with the new filter. Anchored
    // at 09:00 (an hour before the earliest fixture row's 10:00 timestamp) so the 9-day-back
    // cutoff comfortably includes all 3 extract rows rather than sitting on the day boundary.
    const nowIso = new Date(Date.parse("2026-07-10T09:00:00.000Z")).toISOString();
    const sinceIso = new Date(Date.parse(nowIso) - parseDurationMs("9d")).toISOString();
    const rows = loadChatRequests(SECONDARY, 100, sinceIso, dbPath, new Set(["extract"]));
    expect(rows.length).toBe(3); // all 3 extract rows are within the last 9 days of 2026-07-10
    expect(rows.every((r) => r.taskType === "extract")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// CLI end-to-end: --task-types validation, and --count-only makes ZERO model calls
// ─────────────────────────────────────────────────────────────────────────
describe("gate-chat-replay CLI — --task-types / --count-only", () => {
  let dir: string;
  let dbPath: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "gate-replay-cli-"));
    dbPath = join(dir, "eval.db");
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE owner_request_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, alias TEXT NOT NULL,
      model TEXT, route TEXT NOT NULL, messages_json TEXT NOT NULL, completion TEXT NOT NULL,
      prompt_tokens INTEGER, completion_tokens INTEGER, latency_ms INTEGER, tok_per_sec REAL,
      outcome TEXT NOT NULL);`);
    const ins = db.prepare(
      `INSERT INTO owner_request_log (ts, alias, model, route, messages_json, completion, completion_tokens, outcome)
       VALUES (@ts,'owner',@model,@route,@mj,@completion,@ct,'ok')`
    );
    const msg = (u: string) => JSON.stringify([{ role: "user", content: u }]);
    const now = new Date().toISOString();
    ins.run({ ts: now, model: "primary-a", route: "chat", mj: msg("extract the customer id from this ticket"), completion: "id-42", ct: 2 });
    ins.run({ ts: now, model: "primary-a", route: "chat", mj: msg("extract the invoice total from this document"), completion: "total-99", ct: 2 });
    ins.run({ ts: now, model: "primary-a", route: "chat", mj: msg("classify the sentiment of this support ticket please"), completion: "neutral", ct: 2 });
    db.close();
  });

  function runSync(args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
    const r = spawnSync(process.execPath, [TSX, SCRIPT, ...args], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 20_000,
      env: { ...process.env, EVAL_DB_PATH: dbPath, ...extraEnv },
    });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }

  it("an unknown --task-types value is a hard error (exit non-zero, lists valid types) before any DB/network work", () => {
    const r = runSync(["--task-types", "qa_factual", "--count-only"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/qa_factual/);
    expect(r.stderr).toMatch(/qa-factual/);
  });

  it("--count-only reports eligible rows by task type and exits 0", () => {
    const r = runSync(["--count-only", "--recent", "24h"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/ELIGIBLE ROW COUNT/);
    expect(r.stdout).toMatch(/extract\s+2/);
    expect(r.stdout).toMatch(/classify\s+1/);
  });

  it("--count-only combined with --task-types reports only the filtered type(s)", () => {
    const r = runSync(["--count-only", "--recent", "24h", "--task-types", "extract"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/extract\s+2/);
    expect(r.stdout).not.toMatch(/classify\s+1/);
  });

  it("--count-only makes ZERO model calls, even when the secondary endpoint would otherwise be hit", async () => {
    let hits = 0;
    const stub = http.createServer((req, res) => {
      hits++;
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "stub-reply (should never be requested)" } }] }));
      });
    });
    await new Promise<void>((resolvePromise) => stub.listen(0, "127.0.0.1", resolvePromise));
    const port = (stub.address() as { port: number }).port;

    try {
      const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolvePromise, reject) => {
        const child = spawn(process.execPath, [TSX, SCRIPT, "--count-only", "--recent", "24h"], {
          cwd: REPO_ROOT,
          timeout: 20_000,
          env: {
            ...process.env,
            EVAL_DB_PATH: dbPath,
            LMSTUDIO_BASE_URL: `http://127.0.0.1:${port}/v1`,
            GATE_CALL_TIMEOUT_MS: "1000",
          },
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => (stdout += d));
        child.stderr.on("data", (d) => (stderr += d));
        child.on("error", reject);
        child.on("close", (code) => resolvePromise({ status: code, stdout, stderr }));
      });

      expect(result.status).toBe(0);
      expect(hits).toBe(0); // the structural proof: the stub NEVER saw a request
      expect(result.stdout).toMatch(/ELIGIBLE ROW COUNT/);
    } finally {
      stub.close();
    }
  }, 25_000);
});
