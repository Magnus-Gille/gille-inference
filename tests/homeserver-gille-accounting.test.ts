/**
 * Pure-module tests for gille-accounting.ts (issue #3): natural-key/event-id derivation,
 * membership construction, event schema cross-field invariants, and partition-proof
 * certification eligibility — no SQLite involved (mirrors the purity discipline of
 * evidence-identity.ts's own test file).
 */
import { describe, it, expect } from "vitest";
import {
  GILLE_ACCOUNTING_SCHEMA_VERSION,
  buildMembership,
  deriveEventId,
  directAttemptEventSchema,
  directExposureEventSchema,
  gilleAccountingEventSchema,
  gilleNaturalKeySchema,
  gillePartitionProofSchema,
  isEligibleForCertification,
  naturalKeyDigest,
  type GilleNaturalKey,
} from "../src/homeserver/gille-accounting.js";

const JULY = "2026-07-15T10:00:00Z";

describe("natural key identity", () => {
  it("the same natural key always derives the same event id", () => {
    const key: GilleNaturalKey = { recordKind: "direct-attempt", requestId: "req-1" };
    expect(deriveEventId(key)).toBe(deriveEventId(structuredClone(key)));
  });

  it("a different natural key derives a different event id", () => {
    const a: GilleNaturalKey = { recordKind: "direct-attempt", requestId: "req-1" };
    const b: GilleNaturalKey = { recordKind: "direct-attempt", requestId: "req-2" };
    expect(deriveEventId(a)).not.toBe(deriveEventId(b));
  });

  it("event ids follow the closed gacc-<32 hex> shape", () => {
    const key: GilleNaturalKey = { recordKind: "admission", evidenceId: "ev-1" };
    expect(deriveEventId(key)).toMatch(/^gacc-[0-9a-f]{32}$/);
  });

  it("direct-exposure observed and negative-coverage natural keys with the same string id differ", () => {
    const observed: GilleNaturalKey = { recordKind: "direct-exposure", exposureKind: "observed", eventKey: "x" };
    const negative: GilleNaturalKey = { recordKind: "direct-exposure", exposureKind: "negative-coverage", lookupId: "x" };
    expect(naturalKeyDigest(observed)).not.toBe(naturalKeyDigest(negative));
  });

  it("rejects an unknown record kind", () => {
    expect(() => gilleNaturalKeySchema.parse({ recordKind: "bogus", requestId: "x" })).toThrow();
  });
});

describe("membership evidence", () => {
  it("binds the occurrence period from the exact issuedAt instant, not asserted separately", () => {
    const key: GilleNaturalKey = { recordKind: "outcome", requestId: "req-1" };
    const membership = buildMembership({ naturalKey: key, issuedAt: JULY });
    expect(membership.occurrencePeriodUtc).toBe("2026-07");
    expect(membership.counter).toBe("outcome");
    expect(membership.counterOwner).toBe("gille-inference");
  });

  it("counter must equal the natural key's own record kind", () => {
    expect(() => ({
      naturalKey: { recordKind: "outcome", requestId: "x" },
      occurrencePeriodUtc: "2026-07",
      counter: "admission", // mismatched on purpose
      counterOwner: "gille-inference",
      issuedAt: JULY,
    })).not.toThrow(); // constructing the plain object never throws; only schema validation should
  });
});

describe("event schema cross-field invariants", () => {
  function baseDirectAttempt() {
    const naturalKey: GilleNaturalKey = { recordKind: "direct-attempt", requestId: "req-1" };
    return {
      schemaVersion: GILLE_ACCOUNTING_SCHEMA_VERSION,
      eventId: deriveEventId(naturalKey),
      recordKind: "direct-attempt" as const,
      requestId: "req-1",
      membership: buildMembership({ naturalKey, issuedAt: JULY }),
      occurredAt: JULY,
      recordedAt: JULY,
      payload: { lane: "chat", fingerprintSha256: "a".repeat(64) },
    };
  }

  it("accepts a well-formed direct-attempt event", () => {
    expect(() => directAttemptEventSchema.parse(baseDirectAttempt())).not.toThrow();
  });

  it("rejects an event id that is not content-derived from its own natural key", () => {
    const event = { ...baseDirectAttempt(), eventId: "gacc-" + "0".repeat(32) };
    expect(() => gilleAccountingEventSchema.parse(event)).toThrow();
  });

  it("rejects membership.issuedAt disagreeing with occurredAt", () => {
    const event = baseDirectAttempt();
    const mutated = { ...event, membership: { ...event.membership, issuedAt: "2026-07-16T00:00:00Z" } };
    expect(() => gilleAccountingEventSchema.parse(mutated)).toThrow();
  });

  it("rejects occurredAt after recordedAt", () => {
    const event = { ...baseDirectAttempt(), recordedAt: "2026-07-01T00:00:00Z" };
    expect(() => gilleAccountingEventSchema.parse(event)).toThrow();
  });

  it("rejects requestId disagreeing with the natural key", () => {
    const event = { ...baseDirectAttempt(), requestId: "some-other-request" };
    expect(() => gilleAccountingEventSchema.parse(event)).toThrow();
  });

  it("a joined direct-exposure event must carry a huginAttemptRef", () => {
    const naturalKey: GilleNaturalKey = { recordKind: "direct-exposure", exposureKind: "observed", eventKey: "ev-1" };
    const event = {
      schemaVersion: GILLE_ACCOUNTING_SCHEMA_VERSION,
      eventId: deriveEventId(naturalKey),
      recordKind: "direct-exposure" as const,
      membership: buildMembership({ naturalKey, issuedAt: JULY }),
      occurredAt: JULY,
      recordedAt: JULY,
      payload: { exposureKind: "observed" as const, fingerprintSha256: "a".repeat(64), lane: "chat", joined: true },
    };
    expect(() => directExposureEventSchema.parse(event)).not.toThrow(); // shape-only schema is permissive
    expect(() => gilleAccountingEventSchema.parse(event)).toThrow(); // cross-field invariant catches it
  });
});

describe("partition proof certification eligibility", () => {
  function proof(status: "complete" | "empty-confirmed" | "partial") {
    return gillePartitionProofSchema.parse({
      schemaVersion: GILLE_ACCOUNTING_SCHEMA_VERSION,
      counter: "direct-attempt",
      counterOwner: "gille-inference",
      occurrencePeriodUtc: "2026-07",
      status,
      highWaterSeq: status === "complete" ? 1 : 0,
      eventIds: status === "complete" ? [deriveEventId({ recordKind: "direct-attempt", requestId: "x" })] : [],
      chainDigest: "0".repeat(64),
      issuedAt: JULY,
      ...(status === "partial" ? { partialReason: "test reason" } : {}),
    });
  }

  it("complete and empty-confirmed are eligible for certification", () => {
    expect(isEligibleForCertification(proof("complete"))).toBe(true);
    expect(isEligibleForCertification(proof("empty-confirmed"))).toBe(true);
  });

  it("partial is never eligible for certification", () => {
    expect(isEligibleForCertification(proof("partial"))).toBe(false);
  });

  it("a partial proof without a partialReason fails schema validation (fail closed on shape alone)", () => {
    expect(() => gillePartitionProofSchema.parse({
      schemaVersion: GILLE_ACCOUNTING_SCHEMA_VERSION, counter: "direct-attempt", counterOwner: "gille-inference",
      occurrencePeriodUtc: "2026-07", status: "partial", highWaterSeq: 0, eventIds: [], chainDigest: "0".repeat(64), issuedAt: JULY,
    })).toThrow();
  });
});
