import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  TASK_EXPOSURE_LOOKUP_MAX,
  TASK_FINGERPRINT_VERSION,
  backfillTaskExposures,
  canonicalTaskText,
  ensureTaskExposureSchema,
  initializeTaskExposureRegistry,
  lookupTaskExposures,
  parseTaskExposureLookupRequest,
  recordTaskExposure,
  taskTextFingerprint,
  taskTextsFromMessages,
  type TaskExposureLookupRequest,
} from "../src/homeserver/task-exposure.js";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function makeDb(now = "2026-07-14T20:00:00.000Z"): Database.Database {
  const db = new Database(":memory:");
  ensureTaskExposureSchema(db, now);
  return db;
}

describe("task-text fingerprint contract (#257)", () => {
  it("matches Hugin's exact JS trim + UTF-8 SHA-256 contract", () => {
    expect(canonicalTaskText(" \tÅngström\r\n")).toBe("Ångström");
    expect(taskTextFingerprint(" \tÅngström\r\n")).toEqual({
      version: TASK_FINGERPRINT_VERSION,
      sha256: sha256("Ångström"),
    });
  });

  it("does not normalize internal whitespace or Unicode composition", () => {
    expect(taskTextFingerprint("a  b").sha256).not.toBe(taskTextFingerprint("a b").sha256);
    expect(taskTextFingerprint("é").sha256).not.toBe(taskTextFingerprint("e\u0301").sha256);
  });

  it("extracts string and OpenAI text-part user turns without including system/assistant text", () => {
    expect(taskTextsFromMessages([
      { role: "system", content: "secret system" },
      { role: "user", content: " task one " },
      { role: "assistant", content: "answer" },
      { role: "user", content: [{ type: "text", text: "task " }, { type: "image_url", image_url: {} }, { type: "text", text: "two" }] },
    ])).toEqual([" task one ", "task two"]);
  });
});
describe("task exposure storage and lookup", () => {
  it("returns first/last seen plus deduplicated lane/model/harness metadata", () => {
    const db = makeDb();
    const task = "Implement the bounded exposure registry";
    recordTaskExposure({
      taskText: task,
      lane: "delegate",
      modelId: "mellum",
      harnessId: "delegate-local",
      eventKey: "event-1",
      ts: "2026-07-14T20:01:00.000Z",
    }, db);
    recordTaskExposure({
      taskText: `\n${task}\t`,
      lane: "code-loop",
      modelId: "qwen3-coder-next-80b",
      harnessId: "code-loop-pi-v6",
      eventKey: "event-2",
      ts: "2026-07-14T20:02:00.000Z",
    }, db);
    // Stable event keys make retries/backfills idempotent.
    expect(recordTaskExposure({
      taskText: task,
      lane: "delegate",
      eventKey: "event-1",
      ts: "2026-07-14T20:03:00.000Z",
    }, db)).toBe(false);

    const known = taskTextFingerprint(task).sha256;
    const unknown = sha256("never seen");
    const response = lookupTaskExposures({
      fingerprint_version: TASK_FINGERPRINT_VERSION,
      fingerprints: [known, unknown],
    }, db, "2026-07-14T20:03:00.000Z");

    expect(response.coverage).toMatchObject({
      coverage_complete: true,
      from: "2026-07-14T20:00:00.000Z",
      through: "2026-07-14T20:03:00.000Z",
      historical_backfill_complete: false,
    });
    expect(response.results[0]).toEqual({
      fingerprint_sha256: known,
      seen: true,
      first_seen_at: "2026-07-14T20:01:00.000Z",
      last_seen_at: "2026-07-14T20:02:00.000Z",
      lanes: ["code-loop", "delegate"],
      model_ids: ["mellum", "qwen3-coder-next-80b"],
      harness_ids: ["code-loop-pi-v6", "delegate-local"],
    });
    expect(response.results[1]).toMatchObject({
      fingerprint_sha256: unknown,
      seen: false,
      first_seen_at: null,
      last_seen_at: null,
      lanes: [],
      model_ids: [],
      harness_ids: [],
    });
  });

  it("stores no raw task text", () => {
    const db = makeDb();
    const marker = "RAW_TASK_MUST_NOT_LAND_257";
    recordTaskExposure({ taskText: marker, lane: "chat", eventKey: "privacy" }, db);
    const row = db.prepare(`SELECT * FROM task_exposure_events`).get() as Record<string, unknown>;
    expect(JSON.stringify(row)).not.toContain(marker);
    expect(Object.keys(row)).not.toContain("prompt");
    expect(Object.keys(row)).not.toContain("task_text");
  });

  it("starts a new honest coverage epoch after a captured write gap", () => {
    const db = makeDb("2026-07-14T20:00:00.000Z");
    db.prepare(`INSERT INTO task_exposure_meta (key, value) VALUES (?, ?)`).run(
      "first_live_capture_gap_at",
      "2026-07-14T20:05:00.000Z"
    );
    const request: TaskExposureLookupRequest = {
      fingerprint_version: TASK_FINGERPRINT_VERSION,
      fingerprints: [sha256("unknown after gap")],
    };

    expect(lookupTaskExposures(request, db, "2026-07-14T20:06:00.000Z").coverage)
      .toMatchObject({ coverage_complete: false, from: "2026-07-14T20:00:00.000Z" });

    initializeTaskExposureRegistry(db, "2026-07-14T21:00:00.000Z");
    expect(lookupTaskExposures(request, db, "2026-07-14T21:01:00.000Z").coverage)
      .toMatchObject({ coverage_complete: true, from: "2026-07-14T21:00:00.000Z" });
  });
});

describe("historical exposure backfill", () => {
  it("imports full owner messages and provably-complete excerpts idempotently, skipping truncation", () => {
    const db = makeDb();
    db.exec(`
      CREATE TABLE owner_request_log (
        id INTEGER PRIMARY KEY, ts TEXT NOT NULL, route TEXT NOT NULL, messages_json TEXT NOT NULL
      );
      CREATE TABLE delegations (
        id TEXT PRIMARY KEY, ts TEXT NOT NULL, source TEXT, model_id TEXT NOT NULL, prompt_excerpt TEXT
      );
    `);
    db.prepare(`INSERT INTO owner_request_log VALUES (?, ?, ?, ?)`).run(
      1,
      "2026-07-10T10:00:00.000Z",
      "mcp",
      JSON.stringify([{ role: "user", content: "full historical owner task" }])
    );
    db.prepare(`INSERT INTO delegations VALUES (?, ?, ?, ?, ?)`).run(
      "d-short",
      "2026-07-11T10:00:00.000Z",
      "gateway",
      "mellum",
      "short direct delegate"
    );
    db.prepare(`INSERT INTO delegations VALUES (?, ?, ?, ?, ?)`).run(
      "d-long",
      "2026-07-12T10:00:00.000Z",
      "code-loop",
      "qwen3-coder-next-80b",
      "x".repeat(280)
    );

    const first = backfillTaskExposures(db, "2026-07-14T20:04:00.000Z");
    const second = backfillTaskExposures(db, "2026-07-14T20:05:00.000Z");
    expect(first).toMatchObject({
      ownerRowsScanned: 1,
      delegationRowsScanned: 2,
      eventsImported: 2,
      rowsSkippedInexact: 1,
    });
    expect(second.eventsImported).toBe(0);

    const fingerprints = [
      taskTextFingerprint("full historical owner task").sha256,
      taskTextFingerprint("short direct delegate").sha256,
      taskTextFingerprint("x".repeat(280)).sha256,
    ];
    const response = lookupTaskExposures({
      fingerprint_version: TASK_FINGERPRINT_VERSION,
      fingerprints,
    }, db, "2026-07-14T20:06:00.000Z");
    expect(response.results.map((row) => row.seen)).toEqual([true, true, false]);
    expect(response.results[0]?.lanes).toEqual(["mcp-ask"]);
    expect(response.results[1]).toMatchObject({ lanes: ["delegate"], model_ids: ["mellum"] });
    expect(response.coverage).toMatchObject({
      historical_backfill_complete: false,
      historical_events_imported: 2,
      historical_rows_skipped_inexact: 1,
      historical_backfill_from: "2026-07-10T10:00:00.000Z",
      historical_backfill_through: "2026-07-12T10:00:00.000Z",
    });
  });
});

describe("lookup request validation", () => {
  const good = sha256("good");

  it("accepts only the exact version and lowercase SHA-256 values", () => {
    expect(parseTaskExposureLookupRequest({
      fingerprint_version: TASK_FINGERPRINT_VERSION,
      fingerprints: [good],
    })).toEqual({
      ok: true,
      value: { fingerprint_version: TASK_FINGERPRINT_VERSION, fingerprints: [good] },
    });
    expect(parseTaskExposureLookupRequest({ fingerprint_version: "v0", fingerprints: [good] })).toMatchObject({ ok: false, param: "fingerprint_version" });
    expect(parseTaskExposureLookupRequest({ fingerprint_version: TASK_FINGERPRINT_VERSION, fingerprints: [good.toUpperCase()] })).toMatchObject({ ok: false, param: "fingerprints" });
  });

  it("enforces non-empty, bounded, duplicate-free batches", () => {
    expect(parseTaskExposureLookupRequest({ fingerprint_version: TASK_FINGERPRINT_VERSION, fingerprints: [] })).toMatchObject({ ok: false });
    expect(parseTaskExposureLookupRequest({ fingerprint_version: TASK_FINGERPRINT_VERSION, fingerprints: [good, good] })).toMatchObject({ ok: false });
    expect(parseTaskExposureLookupRequest({
      fingerprint_version: TASK_FINGERPRINT_VERSION,
      fingerprints: Array.from({ length: TASK_EXPOSURE_LOOKUP_MAX + 1 }, (_, i) => sha256(String(i))),
    })).toMatchObject({ ok: false });
  });
});
