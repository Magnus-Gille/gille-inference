/**
 * Erasure/exclusion propagation tests (issue #9, scope items 3 and 4).
 *
 * Central claims under test:
 *   - erasure of a plain (non-joined) subject propagates through issue #3's writeErasureAdjustment,
 *     preserving the target's original natural key / occurrence period / counter, never resurrecting
 *     content, and records a content-blind tombstone that a later import/admission path can consult
 *   - erasure of a JOINED exposure (Hugin-owned counter in its basis) REQUIRES a cross-owner
 *     acknowledgement that is independently re-verified — a fabricated ack is rejected
 *   - a tombstoned subject reports `isErased === true`, preventing re-import
 *   - excludeSubjectFromHarvesting is a pure forward to #3's own exclusion counter and never
 *     rewrites the subject's own prior events
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import {
  createLearningTaskGatewayEcho,
  parseHuginRequestStamp,
  type HuginRequestStamp,
} from "../src/homeserver/learning-task-contract.js";
import { claimLearningTaskAdmission } from "../src/homeserver/learning-task-admission-store.js";
import {
  recordDirectAttempt,
  recordDirectExposureObserved,
  getGilleAccountingEvent,
  denominatorBasisFor,
} from "../src/homeserver/gille-accounting-store.js";
import {
  propagateErasure,
  isErased,
  recordErasureTombstone,
  retentionSubjectKey,
  verifyCrossOwnerAcknowledgement,
  redactStoreSubjectContent,
  excludeSubjectFromHarvesting,
  RetentionErasureError,
} from "../src/homeserver/retention-erasure.js";
import { recordOwnerRequest } from "../src/homeserver/owner-log.js";
import { initDb, getDb } from "../src/db.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const requestFixture = JSON.parse(readFileSync(
  new URL("./fixtures/hugin-learning-task-request-v1.json", import.meta.url),
  "utf8",
)) as { prompt: string; learningTaskStamp: unknown };

let seq = 0;
function nextOpaque(): string {
  seq += 1;
  const hex = seq.toString(16).padStart(12, "0");
  return `opaque:aaaaaaaa-aaaa-4aaa-8aaa-${hex}`;
}

function admitHuginAttempt(db: Database.Database, input: { taskInstanceId: string; attemptId: string }): void {
  const base = parseHuginRequestStamp(requestFixture.learningTaskStamp);
  const stamp: HuginRequestStamp = structuredClone(base);
  stamp.task_instance_id = input.taskInstanceId;
  stamp.attempt_id = input.attemptId;
  stamp.idempotency_key = nextOpaque();
  stamp.request_id = nextOpaque();
  const echo = createLearningTaskGatewayEcho(stamp, {
    authenticatedPrincipalId: "service:hugin",
    authentication: "gateway-owner-auth",
    gatewayRequestId: nextOpaque(),
    admissionId: nextOpaque(),
    admittedAt: new Date("2026-07-19T10:00:03Z"),
  });
  const result = claimLearningTaskAdmission({
    principalId: "service:hugin",
    clientId: stamp.client_id,
    taskInstanceId: stamp.task_instance_id,
    attemptId: stamp.attempt_id,
    requestId: stamp.request_id,
    idempotencyKey: stamp.idempotency_key,
    requestFingerprint: "sha256:" + "a".repeat(64),
    surface: "delegate",
    gatewayEcho: echo,
  }, db);
  expect(result.kind).toBe("claimed");
}

const JULY = "2026-07-15T10:00:00Z";
const AUGUST = "2026-08-03T10:00:00Z";

describe("propagateErasure — plain (non-joined) subject", () => {
  it("adjusts the correct counter+period, never resurrects content, and tombstones the subject", () => {
    const db = new Database(":memory:");
    const created = recordDirectAttempt(db, { requestId: "req-erase-1", lane: "chat", fingerprintSha256: "a".repeat(64), occurredAt: JULY });

    const result = propagateErasure(db, {
      targetEventId: created.event.eventId,
      storeId: "request-log",
      subjectRef: "req-erase-1",
      erasureRequestedAt: AUGUST,
      occurredAt: AUGUST,
      note: "owner-requested erasure",
    });

    expect(result.status).toBe("erased");
    if (result.status !== "erased") return;
    expect(result.adjustment.payload.targetEventId).toBe(created.event.eventId);
    // Original occurrence period/natural key preserved exactly — the adjustment references it,
    // never rewrites it.
    expect(result.adjustment.payload.targetNaturalKey).toEqual(created.event.membership.naturalKey);
    expect(result.tombstone).toBe("created");

    // The target's own original row is untouched (issue #3 already guarantees this — asserted here
    // as a regression check specific to the issue #9 propagation path).
    const stillThere = getGilleAccountingEvent(db, created.event.eventId);
    expect(stillThere).not.toBeNull();
    expect(stillThere?.membership.occurrencePeriodUtc).toBe("2026-07");

    expect(isErased(db, "request-log", "req-erase-1")).toBe(true);
  });

  it("a second erasure of the same subject is idempotent (already-erased), not a duplicate tombstone", () => {
    const db = new Database(":memory:");
    const created = recordDirectAttempt(db, { requestId: "req-erase-2", lane: "chat", fingerprintSha256: "a".repeat(64), occurredAt: JULY });
    const first = propagateErasure(db, {
      targetEventId: created.event.eventId, storeId: "request-log", subjectRef: "req-erase-2",
      erasureRequestedAt: AUGUST, occurredAt: AUGUST,
    });
    expect(first.status).toBe("erased");
    const tombstoneCount = (db.prepare("SELECT COUNT(*) AS n FROM retention_erasures").get() as { n: number }).n;

    const second = recordErasureTombstone(db, { storeId: "request-log", subjectRef: "req-erase-2", reason: "erasure", requestedAt: AUGUST });
    expect(second.status).toBe("already-erased");
    const tombstoneCountAfter = (db.prepare("SELECT COUNT(*) AS n FROM retention_erasures").get() as { n: number }).n;
    expect(tombstoneCountAfter).toBe(tombstoneCount);
  });

  it("refuses cleanly (no partial writes) for an unknown (but validly-shaped) target event id", () => {
    const db = new Database(":memory:");
    const result = propagateErasure(db, {
      targetEventId: `gacc-${"0".repeat(32)}`, storeId: "request-log", subjectRef: "whatever",
      erasureRequestedAt: AUGUST, occurredAt: AUGUST,
    });
    expect(result.status).toBe("refused");
    const tombstoneCount = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='retention_erasures'").all()).length;
    expect(tombstoneCount).toBe(1); // schema created eagerly by propagateErasure's ensureSchema, but no row
    const rows = (db.prepare("SELECT COUNT(*) AS n FROM retention_erasures").get() as { n: number }).n;
    expect(rows).toBe(0);
  });

  it("refuses cleanly (never throws) for a MALFORMED target event id", () => {
    const db = new Database(":memory:");
    const result = propagateErasure(db, {
      targetEventId: "not-a-gacc-id-at-all", storeId: "request-log", subjectRef: "whatever",
      erasureRequestedAt: AUGUST, occurredAt: AUGUST,
    });
    expect(result.status).toBe("refused");
    const rows = (db.prepare("SELECT COUNT(*) AS n FROM retention_erasures").get() as { n: number }).n;
    expect(rows).toBe(0);
  });
});

describe("propagateErasure — cross-owner acknowledgement for a joined exposure", () => {
  it("refuses a joined-exposure erasure with no acknowledgement at all", () => {
    const db = new Database(":memory:");
    admitHuginAttempt(db, { taskInstanceId: "task-x1", attemptId: "attempt-x1" });
    const created = recordDirectExposureObserved(db, {
      eventKey: "ev-x1", fingerprintSha256: "a".repeat(64), lane: "delegate",
      joined: true, huginAttemptRef: { taskInstanceId: "task-x1", attemptId: "attempt-x1" }, occurredAt: JULY,
    });
    expect(denominatorBasisFor(created.event).counterSet.some((c) => c.owner === "hugin")).toBe(true);

    const result = propagateErasure(db, {
      targetEventId: created.event.eventId, storeId: "owner-request-log", subjectRef: "ev-x1",
      erasureRequestedAt: AUGUST, occurredAt: AUGUST,
    });
    expect(result.status).toBe("refused");
    if (result.status === "refused") expect(result.reason).toMatch(/Hugin/);
  });

  it("rejects a FABRICATED acknowledgement (never-admitted task/attempt pair)", () => {
    const db = new Database(":memory:");
    admitHuginAttempt(db, { taskInstanceId: "task-x2", attemptId: "attempt-x2" });
    const created = recordDirectExposureObserved(db, {
      eventKey: "ev-x2", fingerprintSha256: "a".repeat(64), lane: "delegate",
      joined: true, huginAttemptRef: { taskInstanceId: "task-x2", attemptId: "attempt-x2" }, occurredAt: JULY,
    });

    const fabricated = { owner: "hugin" as const, taskInstanceId: "never-admitted", attemptId: "never-admitted", acknowledgedAt: AUGUST };
    expect(verifyCrossOwnerAcknowledgement(db, fabricated).verified).toBe(false);

    const result = propagateErasure(db, {
      targetEventId: created.event.eventId, storeId: "owner-request-log", subjectRef: "ev-x2",
      erasureRequestedAt: AUGUST, occurredAt: AUGUST, crossOwnerAck: fabricated,
    });
    expect(result.status).toBe("refused");
    if (result.status === "refused") expect(result.reason).toMatch(/not authentic/);
    expect(isErased(db, "owner-request-log", "ev-x2")).toBe(false);
  });

  it("accepts a genuine acknowledgement verified against a durably admitted Hugin attempt", () => {
    const db = new Database(":memory:");
    admitHuginAttempt(db, { taskInstanceId: "task-x3", attemptId: "attempt-x3" });
    const created = recordDirectExposureObserved(db, {
      eventKey: "ev-x3", fingerprintSha256: "a".repeat(64), lane: "delegate",
      joined: true, huginAttemptRef: { taskInstanceId: "task-x3", attemptId: "attempt-x3" }, occurredAt: JULY,
    });
    const genuine = { owner: "hugin" as const, taskInstanceId: "task-x3", attemptId: "attempt-x3", acknowledgedAt: AUGUST };
    expect(verifyCrossOwnerAcknowledgement(db, genuine).verified).toBe(true);

    const result = propagateErasure(db, {
      targetEventId: created.event.eventId, storeId: "owner-request-log", subjectRef: "ev-x3",
      erasureRequestedAt: AUGUST, occurredAt: AUGUST, crossOwnerAck: genuine,
    });
    expect(result.status).toBe("erased");
    expect(isErased(db, "owner-request-log", "ev-x3")).toBe(true);
  });
});

describe("propagateErasure — content redaction never turns an already-completed erasure into a throw", () => {
  it("reports contentRedactionError rather than throwing when the requested redaction target is invalid", () => {
    const db = new Database(":memory:");
    const created = recordDirectAttempt(db, { requestId: "req-erase-cr-1", lane: "chat", fingerprintSha256: "a".repeat(64), occurredAt: JULY });

    // "request-log" is a real registered store but this in-memory db never had its table created —
    // redactStoreSubjectContent's UPDATE will throw (no such table), which must be caught here
    // rather than propagating out of propagateErasure, because the adjustment+tombstone above it
    // have already durably committed by the time this runs.
    const result = propagateErasure(db, {
      targetEventId: created.event.eventId, storeId: "request-log", subjectRef: "req-erase-cr-1",
      erasureRequestedAt: AUGUST, occurredAt: AUGUST,
      contentRedaction: { storeId: "owner-request-log", primaryKeyValue: "does-not-exist" },
    });

    expect(result.status).toBe("erased");
    if (result.status !== "erased") return;
    expect(result.contentRedacted).toBe(false);
    expect(result.contentRedactionError).toBeTruthy();
    // The erasure itself is unaffected: the adjustment and tombstone are real and durable.
    expect(getGilleAccountingEvent(db, result.adjustment.eventId)).not.toBeNull();
    expect(isErased(db, "request-log", "req-erase-cr-1")).toBe(true);
  });
});

describe("content redaction for a specific subject row", () => {
  it("redacts registered content columns and reports which columns were touched", () => {
    const dir = mkdtempSync(join(tmpdir(), "hs-retention-erasure-content-"));
    initDb(join(dir, "test.db"));
    recordOwnerRequest({
      alias: "owner1", model: "m", route: "chat", messagesJson: "[]", completion: "SECRET",
      promptTokens: 1, completionTokens: 1, latencyMs: 5, tokPerSec: 1, outcome: "ok",
    });
    const row = getDb().prepare("SELECT id FROM owner_request_log ORDER BY id DESC LIMIT 1").get() as { id: number };

    const redaction = redactStoreSubjectContent(getDb(), "owner-request-log", String(row.id));
    expect(redaction.redacted).toBe(true);
    expect(redaction.columns).toEqual(["messages_json", "completion"]);

    const after = getDb().prepare("SELECT completion, messages_json FROM owner_request_log WHERE id = ?").get(row.id) as
      { completion: string | null; messages_json: string | null };
    // owner_request_log's columns are NOT NULL — redacted to "" (the descriptor's
    // redactedContentValue), never SQL NULL. Still exactly as content-blind for reporting.
    expect(after.completion).toBe("");
    expect(after.messages_json).toBe("");
  });

  it("a content-blind store (no contentColumns) is a documented no-op", () => {
    const db = new Database(":memory:");
    const result = redactStoreSubjectContent(db, "request-log", "req-1");
    expect(result.redacted).toBe(false);
    expect(result.columns).toEqual([]);
  });

  it("an unknown storeId is a documented no-op, not a throw", () => {
    const db = new Database(":memory:");
    const result = redactStoreSubjectContent(db, "not-a-real-store", "x");
    expect(result.redacted).toBe(false);
  });
});

describe("excludeSubjectFromHarvesting — additive, never rewrites prior events", () => {
  it("records an exclusion event without touching the subject's own prior direct-attempt row", () => {
    const db = new Database(":memory:");
    const created = recordDirectAttempt(db, { requestId: "req-excl-1", lane: "chat", fingerprintSha256: "a".repeat(64), occurredAt: JULY });
    const before = getGilleAccountingEvent(db, created.event.eventId);

    const exclusion = excludeSubjectFromHarvesting(db, {
      subjectId: "req-excl-1", reason: "retention-owner-opt-out", occurredAt: AUGUST, note: "owner opted out",
    });
    expect(exclusion.status).toBe("created");
    expect(exclusion.event.payload.exclusionReason).toBe("retention-owner-opt-out");

    const after = getGilleAccountingEvent(db, created.event.eventId);
    expect(after).toEqual(before); // the original direct-attempt row is byte-identical — never rewritten
  });
});

describe("retentionSubjectKey", () => {
  it("is deterministic and distinguishes different (store, subject) pairs", () => {
    expect(retentionSubjectKey("request-log", "a")).toBe(retentionSubjectKey("request-log", "a"));
    expect(retentionSubjectKey("request-log", "a")).not.toBe(retentionSubjectKey("owner-request-log", "a"));
    expect(retentionSubjectKey("request-log", "a")).not.toBe(retentionSubjectKey("request-log", "b"));
  });
});

describe("recordErasureTombstone — validation", () => {
  it("rejects a non-RFC-3339 requestedAt", () => {
    const db = new Database(":memory:");
    expect(() => recordErasureTombstone(db, { storeId: "request-log", subjectRef: "x", reason: "erasure", requestedAt: "not-a-date" }))
      .toThrow(RetentionErasureError);
  });
});
