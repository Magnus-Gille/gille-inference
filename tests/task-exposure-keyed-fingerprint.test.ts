import { createHash, createHmac } from "node:crypto";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../src/db.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  KEYED_FINGERPRINT_SCHEME,
  TASK_FINGERPRINT_VERSION,
  configureTaskExposureFingerprintKey,
  ensureTaskExposureSchema,
  isKeyedExposureFingerprintAvailable,
  lookupTaskExposures,
  recordTaskExposure,
  recordTaskExposureBestEffort,
} from "../src/homeserver/task-exposure.js";

/**
 * #487 (conductor decision): a content-suppressed call must never leave an unkeyed digest of its
 * task text. A short Restricted prompt (e.g. a 10-digit identity number, ~10^10 candidates) is
 * brute-forceable from a plain SHA-256, so suppressed exposure rows store
 * HMAC-SHA256(gateway key, "task-exposure-v1\0" + sha256hex) under a versioned, key-identified
 * fingerprint_version. Lookups compute the same HMAC in memory, so exam-contamination checks still
 * match. Without a key the keyed write fails closed (the gateway refuses the opt-out up front).
 */

const KEY_A = "a".repeat(24) + "-test-only-exposure-key-A";
const KEY_B = "b".repeat(24) + "-test-only-exposure-key-B";
const LOW_ENTROPY_PROMPT = "8501019876";
const NOW = "2026-10-20T12:00:00.000Z";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  ensureTaskExposureSchema(db, NOW);
  return db;
}

function rows(db: Database.Database): Array<{ fingerprint_version: string; fingerprint_sha256: string; identity_kind: string }> {
  return db.prepare(`SELECT fingerprint_version, fingerprint_sha256, identity_kind FROM task_exposure_events ORDER BY event_key`).all() as never;
}

afterEach(() => {
  configureTaskExposureFingerprintKey("");
});

describe("keyed exposure fingerprint for content-suppressed calls", () => {
  it("never stores the plain SHA-256 of a suppressed prompt", () => {
    expect(configureTaskExposureFingerprintKey(KEY_A)).toBe("configured");
    const db = makeDb();
    recordTaskExposure({ taskText: LOW_ENTROPY_PROMPT, lane: "mcp-ask", harnessId: "mcp-ask", contentCapture: "suppressed", ts: NOW }, db);
    const stored = rows(db);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.fingerprint_version.startsWith(`${KEYED_FINGERPRINT_SCHEME}:`)).toBe(true);
    expect(stored[0]!.fingerprint_sha256).not.toBe(sha256(LOW_ENTROPY_PROMPT));
    expect(JSON.stringify(db.prepare(`SELECT * FROM task_exposure_events`).all())).not.toContain(sha256(LOW_ENTROPY_PROMPT));
    // It is the documented, domain-separated construction (the key itself is never stored).
    const expected = createHmac("sha256", KEY_A).update(`task-exposure-v1\0${sha256(LOW_ENTROPY_PROMPT)}`, "utf8").digest("hex");
    expect(stored[0]!.fingerprint_sha256).toBe(expected);
    expect(JSON.stringify(stored)).not.toContain(KEY_A);
  });

  it("is deterministic under one key and differs across keys", () => {
    configureTaskExposureFingerprintKey(KEY_A);
    const db = makeDb();
    recordTaskExposure({ taskText: LOW_ENTROPY_PROMPT, lane: "chat", contentCapture: "suppressed", ts: NOW }, db);
    recordTaskExposure({ taskText: `  ${LOW_ENTROPY_PROMPT}  `, lane: "chat", contentCapture: "suppressed", ts: NOW }, db);
    const underA = rows(db);
    expect(underA).toHaveLength(2);
    expect(underA[1]).toEqual(underA[0]);
    configureTaskExposureFingerprintKey(KEY_B);
    recordTaskExposure({ taskText: LOW_ENTROPY_PROMPT, lane: "chat", contentCapture: "suppressed", ts: NOW }, db);
    const underB = rows(db).filter((r) => r.fingerprint_version !== underA[0]!.fingerprint_version);
    expect(underB).toHaveLength(1);
    expect(underB[0]!.fingerprint_sha256).not.toBe(underA[0]!.fingerprint_sha256);
  });

  it("an unsuppressed record keeps the existing plain fingerprint", () => {
    configureTaskExposureFingerprintKey(KEY_A);
    const db = makeDb();
    recordTaskExposure({ taskText: "ordinary task", lane: "chat", ts: NOW }, db);
    expect(rows(db)[0]).toMatchObject({ fingerprint_version: TASK_FINGERPRINT_VERSION, fingerprint_sha256: sha256("ordinary task") });
  });

  it("a caller-supplied canonical digest is keyed too under suppression", () => {
    configureTaskExposureFingerprintKey(KEY_A);
    const db = makeDb();
    const digest = sha256(LOW_ENTROPY_PROMPT);
    recordTaskExposure({ taskText: `rendered ${LOW_ENTROPY_PROMPT}`, lane: "code-loop", canonicalFingerprintSha256: digest, contentCapture: "suppressed", ts: NOW }, db);
    const stored = rows(db);
    expect(stored.map((r) => r.identity_kind).sort()).toEqual(["canonical-raw", "rendered-prompt"]);
    expect(JSON.stringify(stored)).not.toContain(digest);
    expect(JSON.stringify(stored)).not.toContain(sha256(`rendered ${LOW_ENTROPY_PROMPT}`));
  });

  it("lookups by plain fingerprint and by canonical digest still match suppressed exposures", () => {
    configureTaskExposureFingerprintKey(KEY_A);
    const db = makeDb();
    db.prepare(`INSERT OR REPLACE INTO task_exposure_meta (key, value) VALUES ('live_capture_started_at', ?), ('canonical_identity_capture_started_at', ?)`).run(NOW, NOW);
    const digest = sha256(LOW_ENTROPY_PROMPT);
    recordTaskExposure({ taskText: LOW_ENTROPY_PROMPT, lane: "mcp-ask", contentCapture: "suppressed", ts: NOW }, db);
    recordTaskExposure({ taskText: "other rendered", lane: "code-loop", canonicalFingerprintSha256: sha256("raw exam item"), contentCapture: "suppressed", ts: NOW }, db);
    const response = lookupTaskExposures({
      fingerprint_version: TASK_FINGERPRINT_VERSION,
      fingerprints: [digest, sha256("never seen")],
      canonical: [{ fingerprint_sha256: sha256("raw exam item") }],
    }, db, NOW);
    expect(response.results.map((r) => [r.fingerprint_sha256, r.seen])).toEqual([
      [digest, true],
      [sha256("never seen"), false],
      [sha256("raw exam item"), true],
    ]);
    expect(response.results[1]!.unseen_claim_supported).toBe(true);
  });

  it("rows recorded under another key make negative claims unsupported instead of silently fresh", () => {
    configureTaskExposureFingerprintKey(KEY_A);
    const db = makeDb();
    db.prepare(`INSERT OR REPLACE INTO task_exposure_meta (key, value) VALUES ('live_capture_started_at', ?)`).run(NOW);
    recordTaskExposure({ taskText: LOW_ENTROPY_PROMPT, lane: "chat", contentCapture: "suppressed", ts: NOW }, db);
    configureTaskExposureFingerprintKey(KEY_B);
    const rotated = lookupTaskExposures({ fingerprint_version: TASK_FINGERPRINT_VERSION, fingerprints: [sha256("anything")] }, db, NOW);
    expect(rotated.results[0]!.unseen_claim_supported).toBe(false);
    expect(rotated.coverage.coverage_complete).toBe(false);
    expect(rotated.coverage.incomplete_reasons.join(" ")).toMatch(/keyed fingerprint/i);
    configureTaskExposureFingerprintKey("");
    const missing = lookupTaskExposures({ fingerprint_version: TASK_FINGERPRINT_VERSION, fingerprints: [sha256("anything")] }, db, NOW);
    expect(missing.results[0]!.unseen_claim_supported).toBe(false);
  });
});

describe("missing or invalid key fails closed", () => {
  it("reports unavailable and refuses a keyed write without falling back to a plain digest", () => {
    expect(configureTaskExposureFingerprintKey("")).toBe("missing");
    expect(isKeyedExposureFingerprintAvailable()).toBe(false);
    const db = makeDb();
    expect(() => recordTaskExposure({ taskText: LOW_ENTROPY_PROMPT, lane: "chat", contentCapture: "suppressed", ts: NOW }, db)).toThrow(/key/i);
    expect(rows(db)).toEqual([]);
  });

  it("the best-effort recorder records nothing and marks coverage incomplete", () => {
    initDb(join(mkdtempSync(join(tmpdir(), "keyed-exposure-")), "test.db"));
    configureTaskExposureFingerprintKey("");
    expect(recordTaskExposureBestEffort({ taskText: LOW_ENTROPY_PROMPT, lane: "chat", contentCapture: "suppressed" })).toBe(false);
  });

  it("rejects a key shorter than 32 bytes", () => {
    expect(configureTaskExposureFingerprintKey("too-short")).toBe("invalid");
    expect(isKeyedExposureFingerprintAvailable()).toBe(false);
  });
});
