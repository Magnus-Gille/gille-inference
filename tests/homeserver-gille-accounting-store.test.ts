/**
 * Gille-owned LearningTaskContract v1 accounting — store tests (issue #3).
 *
 * Maps directly onto the issue's acceptance criteria: duplicate delivery / concurrent-writer
 * safety; original-occurrence-period preservation across correction/erasure; direct-exposure
 * tombstones cannot downgrade or omit their own counter; basis-proof field-by-field rejection;
 * Hugin-basis preservation (never fabricated by gille); authoritative partition/high-water
 * evidence anchoring full-period closes; partial-snapshot ineligibility; negative-exposure Hugin
 * attempt-reference validation; and erasure preserving an auditable, content-blind adjustment.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { describe, it, expect, afterEach } from "vitest";
import {
  createLearningTaskGatewayEcho,
  parseHuginRequestStamp,
  type HuginRequestStamp,
} from "../src/homeserver/learning-task-contract.js";
import { claimLearningTaskAdmission } from "../src/homeserver/learning-task-admission-store.js";
import {
  GilleNaturalKeyConflictError,
  PartialSnapshotNotCertifiableError,
  GilleAccountingError,
  recordDirectAttempt,
  recordDirectExposureObserved,
  recordNegativeExposureDecision,
  recordAdmissionDecision,
  recordOutcome,
  recordExclusion,
  writeCorrection,
  findEffectiveLeaf,
  writeErasureAdjustment,
  getGilleAccountingEvent,
  issueGilleBasisProof,
  verifyGilleBasisProofForErasure,
  verifyHuginAttemptReference,
  issueGillePartitionProof,
  verifyGillePartitionProof,
  closeFullPeriod,
  acceptPartitionProofForClose,
  denominatorBasisFor,
  type GilleBasisProof,
} from "../src/homeserver/gille-accounting-store.js";

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

/** Admit a Hugin-origin request into learning_task_admissions (issue #2's own store), the exact
 *  primitive gille-accounting-store.ts's `verifyHuginAttemptReference` checks against. */
function admitHuginAttempt(
  db: Database.Database,
  input: { taskInstanceId: string; attemptId: string },
): void {
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

const dirs: string[] = [];
function tempDbFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "gille-accounting-test-"));
  dirs.push(dir);
  return join(dir, "test.db");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  }
});

const JULY = "2026-07-15T10:00:00Z";
const AUGUST = "2026-08-03T10:00:00Z";

// ─── duplicate delivery / concurrency ──────────────────────────────────────────────────────

describe("duplicate delivery and concurrent-writer safety", () => {
  it("a duplicate delivery of the same natural key is an idempotent no-op, not a second row", () => {
    const db = new Database(":memory:");
    const first = recordDirectAttempt(db, {
      requestId: "req-1", lane: "chat", fingerprintSha256: "a".repeat(64), occurredAt: JULY,
    });
    expect(first.status).toBe("created");
    const second = recordDirectAttempt(db, {
      requestId: "req-1", lane: "chat", fingerprintSha256: "a".repeat(64), occurredAt: JULY,
    });
    expect(second.status).toBe("exact-existing");
    expect(second.event.eventId).toBe(first.event.eventId);
    const count = (db.prepare("SELECT COUNT(*) AS n FROM gille_accounting_events").get() as { n: number }).n;
    expect(count).toBe(1);
    db.close();
  });

  it("a genuinely different payload at the same natural key is refused, never silently overwritten", () => {
    const db = new Database(":memory:");
    recordDirectAttempt(db, { requestId: "req-1", lane: "chat", fingerprintSha256: "a".repeat(64), occurredAt: JULY });
    expect(() => recordDirectAttempt(db, {
      requestId: "req-1", lane: "code-loop", fingerprintSha256: "b".repeat(64), occurredAt: JULY,
    })).toThrow(GilleNaturalKeyConflictError);
    const count = (db.prepare("SELECT COUNT(*) AS n FROM gille_accounting_events").get() as { n: number }).n;
    expect(count).toBe(1);
    db.close();
  });

  it("two on-disk connections racing the identical natural key resolve to exactly one row with no lost update", () => {
    const path = tempDbFile();
    const connA = new Database(path);
    const connB = new Database(path);
    connA.pragma("journal_mode = WAL");
    connB.pragma("busy_timeout = 2000");

    // Force genuine interleaving at the raw-SQL level: connA acquires SQLite's write lock and
    // holds it open (uncommitted) while connB's full claim call is attempted — connB's own
    // `.immediate()` transaction must therefore either block (bounded by busy_timeout) or fail
    // fast with SQLITE_BUSY; either way it cannot observe a stale pre-commit state or silently
    // clobber connA's write. This is a real cross-connection lock, not a simulated one.
    connA.exec("BEGIN IMMEDIATE");
    let bBusy = false;
    try {
      recordDirectAttempt(connB, { requestId: "race-1", lane: "chat", fingerprintSha256: "c".repeat(64), occurredAt: JULY });
    } catch {
      bBusy = true; // SQLITE_BUSY (or timeout) while connA holds the writer lock — expected.
    }
    recordDirectAttempt(connA, { requestId: "race-1", lane: "chat", fingerprintSha256: "c".repeat(64), occurredAt: JULY });
    connA.exec("COMMIT");
    expect(bBusy).toBe(true);

    // Now that connA has committed, connB's retry must observe the already-persisted row and
    // resolve idempotently — never insert a second row for the same natural key.
    const retry = recordDirectAttempt(connB, { requestId: "race-1", lane: "chat", fingerprintSha256: "c".repeat(64), occurredAt: JULY });
    expect(retry.status).toBe("exact-existing");
    const count = (connB.prepare("SELECT COUNT(*) AS n FROM gille_accounting_events WHERE record_kind = 'direct-attempt'").get() as { n: number }).n;
    expect(count).toBe(1);
    connA.close();
    connB.close();
  });
});

// ─── occurrence-period immutability ────────────────────────────────────────────────────────

describe("original occurrence period is immutable across correction and erasure", () => {
  it("a July record cannot be erased or corrected into August denominator membership", () => {
    const db = new Database(":memory:");
    const created = recordDirectExposureObserved(db, {
      eventKey: "ev-july-1", fingerprintSha256: "a".repeat(64), lane: "chat", occurredAt: JULY,
    });
    expect(created.event.membership.occurrencePeriodUtc).toBe("2026-07");

    // Erase in August — the erasure-adjustment event's OWN occurrence period is August, but the
    // target's own row/membership must be completely untouched.
    writeErasureAdjustment(db, {
      targetEventId: created.event.eventId, adjustmentReason: "erasure",
      erasureRequestedAt: AUGUST, occurredAt: AUGUST,
    });
    const stillJuly = getGilleAccountingEvent(db, created.event.eventId);
    expect(stillJuly?.membership.occurrencePeriodUtc).toBe("2026-07");
    expect(stillJuly?.membership.issuedAt).toBe(JULY);

    // The July partition still contains exactly the original event; August's direct-exposure
    // partition is untouched by it (the adjustment is its own counter/partition).
    const julyProof = issueGillePartitionProof(db, "direct-exposure", "2026-07", AUGUST);
    expect(julyProof.status).toBe("complete");
    expect(julyProof.eventIds).toEqual([created.event.eventId]);
    const augustDirectExposure = issueGillePartitionProof(db, "direct-exposure", "2026-08", AUGUST);
    expect(augustDirectExposure.status).toBe("empty-confirmed");

    // The erasure-adjustment itself lives in its OWN August partition, under its OWN counter.
    const augustAdjustments = issueGillePartitionProof(db, "erasure-adjustment", "2026-08", AUGUST);
    expect(augustAdjustments.status).toBe("complete");
    expect(augustAdjustments.eventIds).toHaveLength(1);
    db.close();
  });

  it("a correction cannot move its predecessor's own occurrence period", () => {
    const db = new Database(":memory:");
    const created = recordDirectAttempt(db, { requestId: "req-corr", lane: "chat", fingerprintSha256: "a".repeat(64), occurredAt: JULY });
    writeCorrection(db, { predecessorEventId: created.event.eventId, reason: "wrong lane recorded", occurredAt: AUGUST });
    const predecessor = getGilleAccountingEvent(db, created.event.eventId);
    expect(predecessor?.membership.occurrencePeriodUtc).toBe("2026-07");
    db.close();
  });
});

// ─── direct-exposure tombstone cannot downgrade ────────────────────────────────────────────

describe("direct-exposure basis cannot be downgraded or omit its own counter", () => {
  it("basis derivation always includes the direct-exposure counter for an unjoined observed event", () => {
    const db = new Database(":memory:");
    const created = recordDirectExposureObserved(db, {
      eventKey: "ev-1", fingerprintSha256: "a".repeat(64), lane: "chat", occurredAt: JULY,
    });
    const proof = issueGilleBasisProof(db, created.event.eventId);
    expect(proof.basis).toBe("direct-exposure");
    expect(proof.counterSet).toEqual([{ owner: "gille-inference", counter: "direct-exposure" }]);
    db.close();
  });

  it("denominatorBasisFor is a pure function of the event — it accepts no caller override", () => {
    const db = new Database(":memory:");
    const created = recordDirectExposureObserved(db, {
      eventKey: "ev-2", fingerprintSha256: "a".repeat(64), lane: "chat", occurredAt: JULY,
    });
    const event = getGilleAccountingEvent(db, created.event.eventId)!;
    // There is no parameter on this function through which a caller could ask for
    // "not-denominator-bearing" — the only input is the stored event itself.
    expect(denominatorBasisFor.length).toBe(1);
    const { basis, counterSet } = denominatorBasisFor(event);
    expect(basis).not.toBe("not-denominator-bearing");
    expect(counterSet.length).toBeGreaterThan(0);
    db.close();
  });

  it("a forged basis proof claiming a direct-exposure event is not-denominator-bearing is rejected before erasure", () => {
    const db = new Database(":memory:");
    const created = recordDirectExposureObserved(db, {
      eventKey: "ev-3", fingerprintSha256: "a".repeat(64), lane: "chat", occurredAt: JULY,
    });
    const forged: GilleBasisProof = {
      producer: "gille-inference", recordKind: "direct-exposure", recordId: created.event.eventId,
      basis: "not-denominator-bearing", counterSet: [], issuer: "gille-inference", issuedAt: JULY,
    };
    const verification = verifyGilleBasisProofForErasure(db, forged, AUGUST);
    expect(verification.valid).toBe(false);
    db.close();
  });
});

// ─── basis proof field-by-field rejection ──────────────────────────────────────────────────

describe("every gille basis proof binds producer/kind/id/basis/counters/issuer/clock", () => {
  function baseCase(db: Database.Database) {
    const created = recordDirectAttempt(db, { requestId: "req-basis", lane: "chat", fingerprintSha256: "a".repeat(64), occurredAt: JULY });
    return issueGilleBasisProof(db, created.event.eventId);
  }

  it("accepts the authoritative, unmodified proof", () => {
    const db = new Database(":memory:");
    const proof = baseCase(db);
    expect(verifyGilleBasisProofForErasure(db, proof, AUGUST)).toEqual({ valid: true });
    db.close();
  });

  it("rejects a wrong producer", () => {
    const db = new Database(":memory:");
    const proof = baseCase(db);
    const tampered = { ...proof, producer: "hugin" } as unknown as GilleBasisProof;
    expect(verifyGilleBasisProofForErasure(db, tampered, AUGUST).valid).toBe(false);
    db.close();
  });

  it("rejects a wrong record kind", () => {
    const db = new Database(":memory:");
    const proof = baseCase(db);
    const tampered = { ...proof, recordKind: "outcome" } as GilleBasisProof;
    expect(verifyGilleBasisProofForErasure(db, tampered, AUGUST).valid).toBe(false);
    db.close();
  });

  it("rejects a wrong record id (points at a different, unrelated event whose own authoritative proof disagrees)", () => {
    const db = new Database(":memory:");
    const proof = baseCase(db);
    // Captured at a different instant, so its own authoritative proof carries a different
    // `issuedAt` — this is what makes the substitution detectable rather than coincidentally valid.
    const other = recordDirectAttempt(db, {
      requestId: "req-other", lane: "chat", fingerprintSha256: "b".repeat(64), occurredAt: "2026-07-16T09:00:00Z",
    });
    const tampered = { ...proof, recordId: other.event.eventId };
    expect(verifyGilleBasisProofForErasure(db, tampered, AUGUST).valid).toBe(false);
    db.close();
  });

  it("rejects a wrong/downgraded basis", () => {
    const db = new Database(":memory:");
    const proof = baseCase(db);
    const tampered: GilleBasisProof = { ...proof, basis: "not-denominator-bearing", counterSet: [] };
    expect(verifyGilleBasisProofForErasure(db, tampered, AUGUST).valid).toBe(false);
    db.close();
  });

  it("rejects a missing/empty counter set", () => {
    const db = new Database(":memory:");
    const proof = baseCase(db);
    const tampered = { ...proof, counterSet: [] };
    const parsed = verifyGilleBasisProofForErasure(db, tampered as GilleBasisProof, AUGUST);
    expect(parsed.valid).toBe(false);
    db.close();
  });

  it("rejects an extra/fabricated counter", () => {
    const db = new Database(":memory:");
    const proof = baseCase(db);
    const tampered: GilleBasisProof = {
      ...proof,
      counterSet: [...proof.counterSet, { owner: "hugin", counter: "join" }],
    };
    expect(verifyGilleBasisProofForErasure(db, tampered, AUGUST).valid).toBe(false);
    db.close();
  });

  it("rejects a wrong issuer", () => {
    const db = new Database(":memory:");
    const proof = baseCase(db);
    const tampered = { ...proof, issuer: "hugin" } as unknown as GilleBasisProof;
    expect(verifyGilleBasisProofForErasure(db, tampered, AUGUST).valid).toBe(false);
    db.close();
  });

  it("rejects a late issue clock (after the erasure request)", () => {
    const db = new Database(":memory:");
    const proof = baseCase(db);
    const tampered: GilleBasisProof = { ...proof, issuedAt: "2026-09-01T00:00:00Z" };
    expect(verifyGilleBasisProofForErasure(db, tampered, AUGUST).valid).toBe(false);
    db.close();
  });

  it("rejects an impossible/malformed issue clock", () => {
    const db = new Database(":memory:");
    const proof = baseCase(db);
    const tampered = { ...proof, issuedAt: "not-a-timestamp" } as unknown as GilleBasisProof;
    expect(verifyGilleBasisProofForErasure(db, tampered, AUGUST).valid).toBe(false);
    db.close();
  });

  it("rejects a missing/impossible erasure-request clock", () => {
    const db = new Database(":memory:");
    const proof = baseCase(db);
    expect(verifyGilleBasisProofForErasure(db, proof, "not-a-timestamp").valid).toBe(false);
    db.close();
  });

  it("rejects a proof for an event that does not exist", () => {
    const db = new Database(":memory:");
    const proof: GilleBasisProof = {
      producer: "gille-inference", recordKind: "direct-attempt", recordId: "gacc-" + "0".repeat(32),
      basis: "direct-request-capture", counterSet: [{ owner: "gille-inference", counter: "direct-attempt" }],
      issuer: "gille-inference", issuedAt: JULY,
    };
    expect(verifyGilleBasisProofForErasure(db, proof, AUGUST).valid).toBe(false);
    db.close();
  });
});

// ─── Hugin-basis preservation ───────────────────────────────────────────────────────────────

describe("Hugin-basis preservation for joined exposure records", () => {
  it("a joined exposure record backed by a verifiable Hugin admission gets an admissible basis proof carrying the Hugin join counter", () => {
    const db = new Database(":memory:");
    admitHuginAttempt(db, { taskInstanceId: "task-joined-1", attemptId: "attempt-joined-1" });
    const created = recordDirectExposureObserved(db, {
      eventKey: "ev-joined-1", fingerprintSha256: "a".repeat(64), lane: "delegate",
      joined: true, huginAttemptRef: { taskInstanceId: "task-joined-1", attemptId: "attempt-joined-1" },
      occurredAt: JULY,
    });
    const proof = issueGilleBasisProof(db, created.event.eventId);
    expect(proof.basis).toBe("joined-exposure");
    expect(proof.counterSet).toContainEqual({ owner: "hugin", counter: "join" });
    expect(proof.issuer).toBe("gille-inference"); // gille issues its OWN statement — it never claims to speak for Hugin
    db.close();
  });

  it("gille cannot fabricate or replace a Hugin-owned receipt: an unverifiable huginAttemptRef makes the basis unissuable", () => {
    const db = new Database(":memory:");
    // Deliberately never admitted through learning-task-admission-store.ts.
    const created = recordDirectExposureObserved(db, {
      eventKey: "ev-forged-1", fingerprintSha256: "a".repeat(64), lane: "delegate",
      joined: true, huginAttemptRef: { taskInstanceId: "never-admitted", attemptId: "never-admitted" },
      occurredAt: JULY,
    });
    expect(() => issueGilleBasisProof(db, created.event.eventId)).toThrow(GilleAccountingError);
    // And therefore erasure of this record must also fail closed — it can never reach a state
    // where gille asserts "owner_component: hugin" itself.
    expect(() => writeErasureAdjustment(db, {
      targetEventId: created.event.eventId, adjustmentReason: "erasure",
      erasureRequestedAt: AUGUST, occurredAt: AUGUST,
    })).toThrow(GilleAccountingError);
    db.close();
  });

  it("verifyHuginAttemptReference only succeeds against a genuinely admitted Hugin request", () => {
    const db = new Database(":memory:");
    expect(verifyHuginAttemptReference(db, { taskInstanceId: "x", attemptId: "y" }).verified).toBe(false);
    admitHuginAttempt(db, { taskInstanceId: "task-real", attemptId: "attempt-real" });
    expect(verifyHuginAttemptReference(db, { taskInstanceId: "task-real", attemptId: "attempt-real" }).verified).toBe(true);
    // A near-miss (right task, wrong attempt) must not verify.
    expect(verifyHuginAttemptReference(db, { taskInstanceId: "task-real", attemptId: "attempt-other" }).verified).toBe(false);
    db.close();
  });
});

// ─── negative-exposure decisions bound to an authoritative Hugin attempt ───────────────────

describe("negative-exposure decisions identify and validate the exact authoritative Hugin attempt", () => {
  it("a negative-exposure decision citing a genuinely admitted Hugin attempt succeeds", () => {
    const db = new Database(":memory:");
    admitHuginAttempt(db, { taskInstanceId: "task-neg-1", attemptId: "attempt-neg-1" });
    const result = recordNegativeExposureDecision(db, {
      lookupId: "lookup-1", queriedFingerprintSha256: "a".repeat(64), lane: "delegate",
      huginAttemptRef: { taskInstanceId: "task-neg-1", attemptId: "attempt-neg-1" },
      occurredAt: JULY,
    });
    expect(result.status).toBe("created");
    db.close();
  });

  it("a negative-exposure decision citing a non-existent Hugin attempt reference fails", () => {
    const db = new Database(":memory:");
    expect(() => recordNegativeExposureDecision(db, {
      lookupId: "lookup-2", queriedFingerprintSha256: "a".repeat(64), lane: "delegate",
      huginAttemptRef: { taskInstanceId: "does-not-exist", attemptId: "does-not-exist" },
      occurredAt: JULY,
    })).toThrow(GilleAccountingError);
    db.close();
  });

  it("a negative-exposure decision with no Hugin requester (direct traffic) does not require a Hugin reference", () => {
    const db = new Database(":memory:");
    const result = recordNegativeExposureDecision(db, {
      lookupId: "lookup-3", queriedFingerprintSha256: "a".repeat(64), lane: "chat", occurredAt: JULY,
    });
    expect(result.status).toBe("created");
    db.close();
  });
});

// ─── partition / high-water proofs and full-period closes ─────────────────────────────────

describe("full-period closure is anchored to authoritative partition/high-water evidence", () => {
  it("an empty period is certified via an authenticated empty-confirmed proof, not silently treated as missing", () => {
    const db = new Database(":memory:");
    const close = closeFullPeriod(db, "direct-attempt", "2026-07", JULY);
    expect(close.status).toBe("certified");
    expect(close.proof.status).toBe("empty-confirmed");
    db.close();
  });

  it("a period with real events certifies only once every event is present and the chain digest matches", () => {
    const db = new Database(":memory:");
    recordDirectAttempt(db, { requestId: "req-a", lane: "chat", fingerprintSha256: "a".repeat(64), occurredAt: JULY });
    recordDirectAttempt(db, { requestId: "req-b", lane: "chat", fingerprintSha256: "b".repeat(64), occurredAt: JULY });
    const close = closeFullPeriod(db, "direct-attempt", "2026-07", AUGUST);
    expect(close.status).toBe("certified");
    expect(close.proof.status).toBe("complete");
    expect(close.proof.highWaterSeq).toBe(2);
    db.close();
  });

  it("a caller-supplied event list cannot certify a close: a hand-built proof with a fabricated event list is rejected", () => {
    const db = new Database(":memory:");
    recordDirectAttempt(db, { requestId: "req-a", lane: "chat", fingerprintSha256: "a".repeat(64), occurredAt: JULY });
    const forged = issueGillePartitionProof(db, "direct-attempt", "2026-07", AUGUST);
    // Now mutate it to claim an extra event id that was never actually recorded.
    const fabricated = {
      ...forged,
      status: "complete" as const,
      highWaterSeq: forged.highWaterSeq + 1,
      eventIds: [...forged.eventIds, "gacc-" + "f".repeat(32)],
    };
    expect(() => acceptPartitionProofForClose(db, fabricated)).toThrow();
    db.close();
  });

  it("a bare 'full-period' label with no authoritative proof cannot certify — only a freshly issued proof can", () => {
    const db = new Database(":memory:");
    recordDirectAttempt(db, { requestId: "req-a", lane: "chat", fingerprintSha256: "a".repeat(64), occurredAt: JULY });
    // Simulate a caller who tries to assert completeness purely via a label/status flag rather
    // than through issueGillePartitionProof: hand-construct a "complete" proof with a plausible
    // but wrong chain digest.
    const fabricated = {
      schemaVersion: 1 as const, counter: "direct-attempt" as const, counterOwner: "gille-inference" as const,
      occurrencePeriodUtc: "2026-07", status: "complete" as const, highWaterSeq: 1,
      eventIds: ["gacc-" + "0".repeat(32)], chainDigest: "0".repeat(64), issuedAt: AUGUST,
    };
    expect(() => acceptPartitionProofForClose(db, fabricated)).toThrow();
    db.close();
  });

  it("verifyGillePartitionProof detects a stale proof once the partition has advanced", () => {
    const db = new Database(":memory:");
    recordDirectAttempt(db, { requestId: "req-a", lane: "chat", fingerprintSha256: "a".repeat(64), occurredAt: JULY });
    const stale = issueGillePartitionProof(db, "direct-attempt", "2026-07", JULY);
    recordDirectAttempt(db, { requestId: "req-b", lane: "chat", fingerprintSha256: "b".repeat(64), occurredAt: JULY });
    expect(verifyGillePartitionProof(db, stale).valid).toBe(false);
    expect(verifyGillePartitionProof(db, stale, { requireCurrent: false }).valid).toBe(true);
    db.close();
  });
});

describe("partial or unverifiable partitions cannot certify an aggregate", () => {
  it("a proof cannot be issued dated BEFORE the events it would certify (M5 dogfood review, issue #3)", () => {
    const db = new Database(":memory:");
    recordDirectAttempt(db, { requestId: "req-clock", lane: "chat", fingerprintSha256: "a".repeat(64), occurredAt: JULY });
    // Ask for a proof "issued" long before the event was ever recorded — internally
    // self-consistent (digest/count still matches live state) but a dishonest attestation.
    const proof = issueGillePartitionProof(db, "direct-attempt", "2026-07", "2020-01-01T00:00:00Z");
    expect(proof.status).toBe("partial");
    expect(proof.partialReason).toMatch(/predates|clock/i);
    db.close();
  });

  it("rejects a malformed issuedAt outright rather than issuing a proof against it", () => {
    const db = new Database(":memory:");
    expect(() => issueGillePartitionProof(db, "direct-attempt", "2026-07", "not-a-timestamp")).toThrow(GilleAccountingError);
    db.close();
  });

  it("a hand-edited partition row that disagrees with the real events reports partial, not complete", () => {
    const db = new Database(":memory:");
    recordDirectAttempt(db, { requestId: "req-a", lane: "chat", fingerprintSha256: "a".repeat(64), occurredAt: JULY });
    // Directly corrupt the high-water row to simulate tampering / a bug that desynced it.
    db.prepare(
      `UPDATE gille_accounting_partitions SET chain_digest = ? WHERE counter = 'direct-attempt' AND occurrence_period_utc = '2026-07'`
    ).run("f".repeat(64));
    const proof = issueGillePartitionProof(db, "direct-attempt", "2026-07", AUGUST);
    expect(proof.status).toBe("partial");
    expect(proof.partialReason).toBeTruthy();
    db.close();
  });

  it("closeFullPeriod on a partial partition reports partial-dataset-deferred, never silently certified", () => {
    const db = new Database(":memory:");
    recordDirectAttempt(db, { requestId: "req-a", lane: "chat", fingerprintSha256: "a".repeat(64), occurredAt: JULY });
    db.prepare(
      `UPDATE gille_accounting_partitions SET high_water_seq = 99 WHERE counter = 'direct-attempt' AND occurrence_period_utc = '2026-07'`
    ).run();
    const close = closeFullPeriod(db, "direct-attempt", "2026-07", AUGUST);
    expect(close.status).toBe("partial-dataset-deferred");
    expect(() => acceptPartitionProofForClose(db, close.proof)).toThrow(PartialSnapshotNotCertifiableError);
    db.close();
  });

  it("assertCertifiable / acceptPartitionProofForClose fail closed on any partial proof", () => {
    const db = new Database(":memory:");
    const partial = {
      schemaVersion: 1 as const, counter: "admission" as const, counterOwner: "gille-inference" as const,
      occurrencePeriodUtc: "2026-07", status: "partial" as const, highWaterSeq: 0, eventIds: [],
      chainDigest: "0".repeat(64), issuedAt: JULY, partialReason: "manufactured for the test",
    };
    expect(() => acceptPartitionProofForClose(db, partial)).toThrow(PartialSnapshotNotCertifiableError);
    db.close();
  });
});

// ─── correction chains ──────────────────────────────────────────────────────────────────────

describe("immutable correction chains", () => {
  it("a correction creates a new immutable event and never mutates the predecessor's row", () => {
    const db = new Database(":memory:");
    const created = recordAdmissionDecision(db, {
      evidenceId: "ev-admit-1", admitted: true, admissionBasis: "full-pass", occurredAt: JULY,
    });
    const correction = writeCorrection(db, {
      predecessorEventId: created.event.eventId, reason: "wrong admission basis recorded", occurredAt: AUGUST,
    });
    expect(correction.status).toBe("created");
    expect(correction.event.eventId).not.toBe(created.event.eventId);
    const predecessor = getGilleAccountingEvent(db, created.event.eventId);
    expect(predecessor).toEqual(created.event);
    expect(findEffectiveLeaf(db, created.event.eventId)).toBe(correction.event.eventId);
    db.close();
  });

  it("at most one correction may target a given predecessor — a second different correction is a conflict", () => {
    const db = new Database(":memory:");
    const created = recordOutcome(db, { requestId: "req-outcome-1", outcome: "completed", occurredAt: JULY });
    writeCorrection(db, { predecessorEventId: created.event.eventId, reason: "first correction", occurredAt: AUGUST });
    expect(() => writeCorrection(db, {
      predecessorEventId: created.event.eventId, reason: "a DIFFERENT second correction", occurredAt: "2026-09-01T00:00:00Z",
    })).toThrow(GilleNaturalKeyConflictError);
    db.close();
  });

  it("a correction must strictly time-advance past its predecessor", () => {
    const db = new Database(":memory:");
    const created = recordOutcome(db, { requestId: "req-outcome-2", outcome: "completed", occurredAt: JULY });
    expect(() => writeCorrection(db, {
      predecessorEventId: created.event.eventId, reason: "backdated", occurredAt: "2026-06-01T00:00:00Z",
    })).toThrow(GilleAccountingError);
    db.close();
  });

  it("correcting an unknown predecessor fails closed", () => {
    const db = new Database(":memory:");
    expect(() => writeCorrection(db, {
      predecessorEventId: "gacc-" + "0".repeat(32), reason: "orphan correction", occurredAt: AUGUST,
    })).toThrow(GilleAccountingError);
    db.close();
  });
});

// ─── erasure preserves an auditable, content-blind adjustment ─────────────────────────────

describe("erasure preserves an auditable counter adjustment without resurrecting content", () => {
  it("after erasure, the audit trail shows the adjustment happened but carries no content bytes", () => {
    const db = new Database(":memory:");
    const created = recordDirectExposureObserved(db, {
      eventKey: "ev-erase-1", fingerprintSha256: "a".repeat(64), lane: "chat", occurredAt: JULY,
    });
    const adjustment = writeErasureAdjustment(db, {
      targetEventId: created.event.eventId, adjustmentReason: "erasure",
      erasureRequestedAt: AUGUST, occurredAt: AUGUST, note: "owner-requested erasure",
    });
    expect(adjustment.status).toBe("created");
    expect(adjustment.event.payload.targetEventId).toBe(created.event.eventId);
    expect(adjustment.event.payload.basisProof.recordId).toBe(created.event.eventId);

    // The target row itself is never deleted (nothing to "resurrect" — no content was ever
    // stored), and the whole event table never carries the sentinel "raw content" string.
    expect(getGilleAccountingEvent(db, created.event.eventId)).not.toBeNull();
    const allRows = db.prepare("SELECT * FROM gille_accounting_events").all();
    const serialized = JSON.stringify(allRows);
    expect(serialized).not.toContain("SECRET-PROMPT-CONTENT");
    expect(serialized).toContain(created.event.eventId); // the adjustment DOES reference the target id
    db.close();
  });

  it("erasure of an unknown target fails closed", () => {
    const db = new Database(":memory:");
    expect(() => writeErasureAdjustment(db, {
      targetEventId: "gacc-" + "0".repeat(32), adjustmentReason: "erasure",
      erasureRequestedAt: AUGUST, occurredAt: AUGUST,
    })).toThrow(GilleAccountingError);
    db.close();
  });

  it("erasure is refused when the basis proof's own issue clock would be later than the erasure request", () => {
    const db = new Database(":memory:");
    const created = recordDirectExposureObserved(db, {
      eventKey: "ev-erase-2", fingerprintSha256: "a".repeat(64), lane: "chat", occurredAt: AUGUST,
    });
    // occurredAt (== basis issuedAt) is August; requesting erasure "as of" July is impossible.
    expect(() => writeErasureAdjustment(db, {
      targetEventId: created.event.eventId, adjustmentReason: "erasure",
      erasureRequestedAt: JULY, occurredAt: AUGUST,
    })).toThrow(GilleAccountingError);
    db.close();
  });
});

// ─── remaining record kinds sanity ──────────────────────────────────────────────────────────

describe("admission, outcome, and exclusion recorders", () => {
  it("records an admission decision with a non-denominator-bearing outcome/exclusion counterpart", () => {
    const db = new Database(":memory:");
    const admission = recordAdmissionDecision(db, {
      evidenceId: "ev-x", admitted: true, admissionBasis: "full-pass", occurredAt: JULY,
    });
    expect(issueGilleBasisProof(db, admission.event.eventId).basis).toBe("admission-decision");

    const outcome = recordOutcome(db, { requestId: "req-y", outcome: "failed", failureMode: "operational", occurredAt: JULY });
    expect(issueGilleBasisProof(db, outcome.event.eventId).basis).toBe("not-denominator-bearing");

    const exclusion = recordExclusion(db, {
      subjectId: "req-y", exclusionReason: "candidate-exposure-incomplete", occurredAt: JULY,
    });
    expect(issueGilleBasisProof(db, exclusion.event.eventId).basis).toBe("not-denominator-bearing");
    db.close();
  });

  it("duplicate exclusion delivery for the same subject/reason is idempotent", () => {
    const db = new Database(":memory:");
    const first = recordExclusion(db, { subjectId: "req-z", exclusionReason: "synthetic-test", occurredAt: JULY });
    const second = recordExclusion(db, { subjectId: "req-z", exclusionReason: "synthetic-test", occurredAt: JULY });
    expect(second.status).toBe("exact-existing");
    expect(second.event.eventId).toBe(first.event.eventId);
    db.close();
  });
});
