import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  DIRECT_LOOPBACK_TRAFFIC_DISCLOSURE,
  EXACT_MATCH_SEMANTICS_DISCLOSURE,
  TASK_EXPOSURE_LOOKUP_MAX,
  TASK_FINGERPRINT_VERSION,
  backfillTaskExposures,
  canonicalTaskText,
  ensureTaskExposureSchema,
  initializeTaskExposureRegistry,
  listTaskExposureCoverageEpochs,
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

interface RawFingerprintVector {
  name: string;
  input_text: string;
  trimmed_utf8: string;
  expected_sha256: string;
}

/** Grimnir's normative bc8cf09 vectors — see tests/fixtures/learning-task-contract/PROVENANCE.md. */
const RAW_FINGERPRINT_VECTORS: RawFingerprintVector[] = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./fixtures/learning-task-contract/raw-fingerprint-vectors.json", import.meta.url)),
    "utf8"
  )
);

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
      identity_kind: "rendered-prompt",
      seen: true,
      first_seen_at: "2026-07-14T20:01:00.000Z",
      last_seen_at: "2026-07-14T20:02:00.000Z",
      lanes: ["code-loop", "delegate"],
      model_ids: ["mellum", "qwen3-coder-next-80b"],
      harness_ids: ["code-loop-pi-v6", "delegate-local"],
      unseen_claim_supported: true,
      includes_legacy_inexact: false,
      external_surfaces: [],
    });
    expect(response.results[1]).toMatchObject({
      fingerprint_sha256: unknown,
      identity_kind: "rendered-prompt",
      seen: false,
      first_seen_at: null,
      last_seen_at: null,
      lanes: [],
      model_ids: [],
      harness_ids: [],
      unseen_claim_supported: true,
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

describe("canonical logical-task identity — dual recording (#4)", () => {
  it("records rendered-prompt AND canonical-raw as separate rows for stamped traffic", () => {
    const db = makeDb();
    const rendered = "SYSTEM: you are Hugin.\n\nTASK: Implement the exposure registry dual-identity feature.";
    const canonicalDigest = sha256("Implement the exposure registry dual-identity feature.");
    recordTaskExposure({
      taskText: rendered,
      lane: "delegate",
      modelId: "mellum",
      harnessId: "delegate-local",
      canonicalFingerprintSha256: canonicalDigest,
      eventKey: "stamped-1",
      ts: "2026-07-14T20:01:00.000Z",
    }, db);

    const renderedFp = taskTextFingerprint(rendered).sha256;
    const response = lookupTaskExposures({
      fingerprint_version: TASK_FINGERPRINT_VERSION,
      fingerprints: [renderedFp],
      canonical: [{ fingerprint_sha256: canonicalDigest }],
    }, db, "2026-07-14T20:02:00.000Z");

    expect(response.results).toHaveLength(2);
    expect(response.results[0]).toMatchObject({
      fingerprint_sha256: renderedFp,
      identity_kind: "rendered-prompt",
      seen: true,
    });
    expect(response.results[1]).toMatchObject({
      fingerprint_sha256: canonicalDigest,
      identity_kind: "canonical-raw",
      seen: true,
      lanes: ["delegate"],
      model_ids: ["mellum"],
      harness_ids: ["delegate-local"],
    });
    // Two physically separate rows, not one row wearing two hats.
    const rowCount = (db.prepare(`SELECT COUNT(*) AS n FROM task_exposure_events`).get() as { n: number }).n;
    expect(rowCount).toBe(2);
  });

  it("finds a context-wrapped Hugin task by its canonical identity even though the rendered prompt differs", () => {
    const db = makeDb();
    // The rendered prompt Hugin's context/system wrapping produced — NOT what raw_fingerprint hashes.
    const wrappedPrompt = "You are operating under Hugin's nightly harness.\n\n---\nSummarize the incident.\n---\nRespond in one paragraph.";
    const rawLogicalTask = "Summarize the incident.";
    const canonicalDigest = taskTextFingerprint(rawLogicalTask).sha256;
    expect(taskTextFingerprint(wrappedPrompt).sha256).not.toBe(canonicalDigest); // genuinely different bytes

    recordTaskExposure({
      taskText: wrappedPrompt,
      lane: "delegate",
      modelId: "mellum",
      harnessId: "delegate-local",
      canonicalFingerprintSha256: canonicalDigest,
    }, db);

    // A caller who only ever sees the raw logical task (never the rendered/wrapped form) can still
    // prove exposure — this is the whole point of AC1.
    const response = lookupTaskExposures({
      fingerprint_version: TASK_FINGERPRINT_VERSION,
      fingerprints: [],
      canonical: [{
        fingerprint_sha256: canonicalDigest,
        exact_bytes: { encoding: "utf-8", byte_length: Buffer.byteLength(rawLogicalTask, "utf8"), text: rawLogicalTask },
      }],
    }, db);
    expect(response.results[0]).toMatchObject({ seen: true, identity_kind: "canonical-raw", unseen_claim_supported: true });

    // The RENDERED fingerprint of the raw logical task (as if it had been sent unwrapped) was never
    // recorded — confirms the two identities are genuinely independent lookups, not aliases.
    const rawAsRenderedFp = taskTextFingerprint(rawLogicalTask).sha256;
    const rendered = lookupTaskExposures({
      fingerprint_version: TASK_FINGERPRINT_VERSION,
      fingerprints: [rawAsRenderedFp],
    }, db);
    expect(rendered.results[0]).toMatchObject({ seen: false });
  });

  it("never persists raw task content for either identity — only their digests", () => {
    const db = makeDb();
    const marker = "RAW_TASK_MUST_NOT_LAND_4";
    const canonicalMarker = "CANONICAL_RAW_MUST_NOT_LAND_4";
    recordTaskExposure({
      taskText: marker,
      lane: "delegate",
      canonicalFingerprintSha256: sha256(canonicalMarker),
    }, db);
    const rows = db.prepare(`SELECT * FROM task_exposure_events`).all() as Record<string, unknown>[];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(JSON.stringify(row)).not.toContain(marker);
      expect(JSON.stringify(row)).not.toContain(canonicalMarker);
      expect(Object.keys(row)).not.toContain("prompt");
      expect(Object.keys(row)).not.toContain("task_text");
      expect(Object.keys(row)).not.toContain("raw_text");
    }
  });
});

describe("canonical lookup: recomputation vs label, never a bare-label negative claim (#4 AC2/AC3)", () => {
  it("recomputes and accepts Grimnir's normative bc8cf09 raw-fingerprint vectors", () => {
    expect(RAW_FINGERPRINT_VECTORS.length).toBeGreaterThanOrEqual(2);
    for (const vector of RAW_FINGERPRINT_VECTORS) {
      expect(taskTextFingerprint(vector.input_text)).toEqual({
        version: TASK_FINGERPRINT_VERSION,
        sha256: vector.expected_sha256,
      });
      const parsed = parseTaskExposureLookupRequest({
        fingerprint_version: TASK_FINGERPRINT_VERSION,
        fingerprints: [],
        canonical: [{
          fingerprint_sha256: vector.expected_sha256,
          exact_bytes: {
            encoding: "utf-8",
            byte_length: Buffer.byteLength(vector.input_text, "utf8"),
            text: vector.input_text,
          },
        }],
      });
      expect(parsed).toMatchObject({ ok: true });
    }
  });

  it("rejects a byte_length that does not match the exact UTF-8 length of the supplied text", () => {
    const vector = RAW_FINGERPRINT_VECTORS[0]!;
    const parsed = parseTaskExposureLookupRequest({
      fingerprint_version: TASK_FINGERPRINT_VERSION,
      fingerprints: [],
      canonical: [{
        fingerprint_sha256: vector.expected_sha256,
        exact_bytes: {
          encoding: "utf-8",
          byte_length: Buffer.byteLength(vector.input_text, "utf8") + 1, // wrong on purpose
          text: vector.input_text,
        },
      }],
    });
    expect(parsed).toMatchObject({ ok: false, param: "canonical" });
    if (!parsed.ok) expect(parsed.message).toMatch(/byte_length/);
  });

  it("rejects a mismatched byte vector: a label that does not match the recomputed digest", () => {
    const vector = RAW_FINGERPRINT_VECTORS[0]!;
    const parsed = parseTaskExposureLookupRequest({
      fingerprint_version: TASK_FINGERPRINT_VERSION,
      fingerprints: [],
      canonical: [{
        fingerprint_sha256: sha256("this is not the digest of the supplied bytes"),
        exact_bytes: {
          encoding: "utf-8",
          byte_length: Buffer.byteLength(vector.input_text, "utf8"),
          text: vector.input_text,
        },
      }],
    });
    expect(parsed).toMatchObject({ ok: false, param: "canonical" });
    if (!parsed.ok) expect(parsed.message).toMatch(/recomputed/);
  });

  it("a bare canonical label may report positive seen evidence but never supports an unseen claim", () => {
    const db = makeDb();
    const vector = RAW_FINGERPRINT_VECTORS[0]!;
    recordTaskExposure({
      taskText: "some rendered prompt text",
      lane: "code-loop",
      canonicalFingerprintSha256: vector.expected_sha256,
    }, db);

    const seenByLabel = lookupTaskExposures({
      fingerprint_version: TASK_FINGERPRINT_VERSION,
      fingerprints: [],
      canonical: [{ fingerprint_sha256: vector.expected_sha256 }],
    }, db);
    expect(seenByLabel.results[0]).toMatchObject({ seen: true, unseen_claim_supported: false });

    const neverSeenByLabel = lookupTaskExposures({
      fingerprint_version: TASK_FINGERPRINT_VERSION,
      fingerprints: [],
      canonical: [{ fingerprint_sha256: sha256("genuinely never recorded anywhere") }],
    }, db);
    // Fails closed: a bare label reporting seen:false is NOT trustworthy freshness evidence.
    expect(neverSeenByLabel.results[0]).toMatchObject({ seen: false, unseen_claim_supported: false });
  });
});

describe("fail-closed negative claims + structural disclosures (#4 AC3/AC4/AC6)", () => {
  it("degrades unseen_claim_supported to false (never seen itself) when live capture is unhealthy", () => {
    const db = makeDb("2026-07-14T20:00:00.000Z");
    db.prepare(`INSERT INTO task_exposure_meta (key, value) VALUES (?, ?)`).run(
      "first_live_capture_gap_at",
      "2026-07-14T20:05:00.000Z"
    );
    const response = lookupTaskExposures({
      fingerprint_version: TASK_FINGERPRINT_VERSION,
      fingerprints: [sha256("anything")],
    }, db, "2026-07-14T20:06:00.000Z");
    expect(response.coverage.coverage_complete).toBe(false);
    expect(response.results[0]).toMatchObject({ seen: false, unseen_claim_supported: false });
  });

  it("discloses the direct-loopback exclusion and exact-match-only contracts on every response", () => {
    const db = makeDb();
    const response = lookupTaskExposures({
      fingerprint_version: TASK_FINGERPRINT_VERSION,
      fingerprints: [sha256("x")],
    }, db);
    expect(response.coverage.direct_loopback_traffic).toEqual(DIRECT_LOOPBACK_TRAFFIC_DISCLOSURE);
    expect(response.coverage.direct_loopback_traffic.captured).toBe(false);
    expect(response.coverage.exact_match_semantics).toEqual(EXACT_MATCH_SEMANTICS_DISCLOSURE);
    expect(response.coverage.exact_match_semantics.contamination_proof).toBe(false);
  });
});

describe("legacy row disclosure (#4 AC7)", () => {
  it("finds pre-discriminator backfilled rows via a rendered-prompt query and flags them inexact", () => {
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
      1, "2026-07-10T10:00:00.000Z", "mcp",
      JSON.stringify([{ role: "user", content: "legacy historical owner task" }])
    );
    backfillTaskExposures(db, "2026-07-14T20:04:00.000Z");

    const legacyRow = db.prepare(
      `SELECT identity_kind, coverage_epoch_id FROM task_exposure_events WHERE event_key LIKE 'backfill:%'`
    ).get() as { identity_kind: string; coverage_epoch_id: string };
    expect(legacyRow.identity_kind).toBe("legacy-inexact");
    expect(legacyRow.coverage_epoch_id).toBe("legacy-pre-epoch");

    const fp = taskTextFingerprint("legacy historical owner task").sha256;
    const response = lookupTaskExposures({
      fingerprint_version: TASK_FINGERPRINT_VERSION,
      fingerprints: [fp],
    }, db, "2026-07-14T20:06:00.000Z");
    expect(response.results[0]).toMatchObject({ seen: true, includes_legacy_inexact: true });

    // A canonical-raw query must NOT match a legacy rendered-prompt-shaped row — different domains.
    const canonicalMiss = lookupTaskExposures({
      fingerprint_version: TASK_FINGERPRINT_VERSION,
      fingerprints: [],
      canonical: [{ fingerprint_sha256: fp }],
    }, db, "2026-07-14T20:06:00.000Z");
    expect(canonicalMiss.results[0]).toMatchObject({ seen: false });
  });

  it("migrates a pre-#4 database in place and discloses its existing rows as legacy-inexact", () => {
    // Simulate a DB created by the ORIGINAL #257 schema (no identity_kind/coverage_epoch_id at all).
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE task_exposure_events (
        event_key          TEXT PRIMARY KEY,
        ts                 TEXT NOT NULL,
        fingerprint_version TEXT NOT NULL,
        fingerprint_sha256 TEXT NOT NULL,
        lane               TEXT NOT NULL,
        model_id           TEXT,
        harness_id         TEXT
      );
      CREATE TABLE task_exposure_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    const preMigrationFp = taskTextFingerprint("pre-existing #257-era row").sha256;
    db.prepare(
      `INSERT INTO task_exposure_events (event_key, ts, fingerprint_version, fingerprint_sha256, lane, model_id, harness_id)
       VALUES ('pre-migration-1', '2026-07-01T00:00:00.000Z', ?, ?, 'delegate', 'mellum', 'delegate-local')`
    ).run(TASK_FINGERPRINT_VERSION, preMigrationFp);

    ensureTaskExposureSchema(db, "2026-07-14T20:00:00.000Z");

    const migratedRow = db.prepare(
      `SELECT identity_kind, coverage_epoch_id FROM task_exposure_events WHERE event_key = 'pre-migration-1'`
    ).get() as { identity_kind: string; coverage_epoch_id: string };
    expect(migratedRow).toEqual({ identity_kind: "legacy-inexact", coverage_epoch_id: "legacy-pre-epoch" });

    const response = lookupTaskExposures({
      fingerprint_version: TASK_FINGERPRINT_VERSION,
      fingerprints: [preMigrationFp],
    }, db, "2026-07-14T20:01:00.000Z");
    expect(response.results[0]).toMatchObject({ seen: true, includes_legacy_inexact: true });
  });
});

describe("coverage-epoch behavior across a simulated restart (#4)", () => {
  it("boots a single epoch with no gap, then mints a fresh epoch with a measured gap on restart", () => {
    const db = makeDb("2026-07-14T20:00:00.000Z");
    const bootEpochs = listTaskExposureCoverageEpochs(db);
    expect(bootEpochs).toHaveLength(1);
    expect(bootEpochs[0]).toMatchObject({ previousEpochId: null, previousEpochLastSeenAt: null, gapMs: null });

    const beforeRestart = lookupTaskExposures({
      fingerprint_version: TASK_FINGERPRINT_VERSION,
      fingerprints: [sha256("x")],
    }, db, "2026-07-14T20:00:30.000Z");
    expect(beforeRestart.coverage.restart_count).toBe(0);
    expect(beforeRestart.coverage.total_restart_gap_ms).toBe(0);
    const firstEpochId = beforeRestart.coverage.coverage_epoch_id;

    recordTaskExposure({
      taskText: "last thing recorded before the restart",
      lane: "delegate",
      ts: "2026-07-14T20:01:00.000Z",
    }, db);

    // A genuine gateway restart: initializeTaskExposureRegistry, not another ensureSchema-only call.
    initializeTaskExposureRegistry(db, "2026-07-14T20:10:00.000Z");

    const epochsAfterRestart = listTaskExposureCoverageEpochs(db);
    expect(epochsAfterRestart).toHaveLength(2);
    expect(epochsAfterRestart[1]).toMatchObject({
      previousEpochId: firstEpochId,
      previousEpochLastSeenAt: "2026-07-14T20:01:00.000Z",
      // 20:10:00 - 20:01:00 = 9 minutes.
      gapMs: 9 * 60 * 1000,
    });

    const afterRestart = lookupTaskExposures({
      fingerprint_version: TASK_FINGERPRINT_VERSION,
      fingerprints: [sha256("x")],
    }, db, "2026-07-14T20:10:30.000Z");
    expect(afterRestart.coverage.coverage_epoch_id).not.toBe(firstEpochId);
    expect(afterRestart.coverage.coverage_epoch_id).toBe(epochsAfterRestart[1]!.epochId);
    expect(afterRestart.coverage.restart_count).toBe(1);
    expect(afterRestart.coverage.total_restart_gap_ms).toBe(9 * 60 * 1000);
  });

  it("does not rotate an epoch on an ordinary (non-restart) ensureTaskExposureSchema call", () => {
    const db = makeDb("2026-07-14T20:00:00.000Z");
    const before = listTaskExposureCoverageEpochs(db);
    recordTaskExposure({ taskText: "ordinary live write", lane: "chat" }, db);
    ensureTaskExposureSchema(db); // no-op past the first call within one process (initialized WeakSet)
    const after = listTaskExposureCoverageEpochs(db);
    expect(after).toEqual(before);
  });
});
