import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../src/db.js";
import {
  getEvidenceIdentitySnapshot,
  upsertEvidenceIdentitySnapshot,
} from "../src/homeserver/evidence-identity-store.js";
import {
  buildEvidenceIdentityBundle,
  contentDigest,
  digestIdentity,
  evidenceIdentityHash,
} from "../src/homeserver/evidence-identity.js";

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "hs-evidence-identity-store-test-"));
  initDb(join(dir, "test.db"));
});

function bundle(seed: string) {
  return buildEvidenceIdentityBundle({
    modelArtifact: digestIdentity({ id: seed, version: "v1", digest: contentDigest(seed), origin: "server-observed" }),
    lane: "delegate",
  });
}

describe("evidence-identity-store: content-addressed reconstruction (AC2)", () => {
  it("round-trips a bundle: upsert then read back byte-identical", () => {
    const b = bundle("round-trip-a");
    const hash = upsertEvidenceIdentitySnapshot(b, "2026-07-20T00:00:00.000Z");
    expect(hash).toBe(evidenceIdentityHash(b));

    const snapshot = getEvidenceIdentitySnapshot(hash);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.bundle).toEqual(b);
    expect(snapshot!.firstSeenAt).toBe("2026-07-20T00:00:00.000Z");
    expect(snapshot!.lastSeenAt).toBe("2026-07-20T00:00:00.000Z");
    expect(snapshot!.observationCount).toBe(1);
  });

  it("returns null for a hash that was never observed", () => {
    expect(getEvidenceIdentitySnapshot("sha256:" + "0".repeat(64))).toBeNull();
  });

  it("is idempotent: re-upserting the SAME bundle bumps last_seen_at/observation_count, keeps first_seen_at", () => {
    const b = bundle("round-trip-idempotent");
    const hash1 = upsertEvidenceIdentitySnapshot(b, "2026-07-20T01:00:00.000Z");
    const hash2 = upsertEvidenceIdentitySnapshot(b, "2026-07-20T02:00:00.000Z");
    expect(hash1).toBe(hash2);

    const snapshot = getEvidenceIdentitySnapshot(hash1)!;
    expect(snapshot.firstSeenAt).toBe("2026-07-20T01:00:00.000Z");
    expect(snapshot.lastSeenAt).toBe("2026-07-20T02:00:00.000Z");
    expect(snapshot.observationCount).toBe(2);
  });

  // M5 dogfood review (issue #5): under WAL, two concurrent writers can commit their single-
  // statement upserts in an order that does not match their nowIso wall-clock order. A blind
  // overwrite of last_seen_at would let it regress; this pins the MAX()-based fix.
  it("last_seen_at is monotonic (MAX), never regresses when an out-of-order timestamp is upserted later", () => {
    const b = bundle("out-of-order-commit");
    const hash1 = upsertEvidenceIdentitySnapshot(b, "2026-07-20T10:00:00.000Z");
    // Simulate a second writer whose upsert COMMITS second but carries an EARLIER observation
    // timestamp than the first writer's.
    const hash2 = upsertEvidenceIdentitySnapshot(b, "2026-07-20T05:00:00.000Z");
    expect(hash1).toBe(hash2);

    const snapshot = getEvidenceIdentitySnapshot(hash1)!;
    expect(snapshot.lastSeenAt).toBe("2026-07-20T10:00:00.000Z"); // NOT overwritten to the earlier ts
    expect(snapshot.firstSeenAt).toBe("2026-07-20T10:00:00.000Z");
    expect(snapshot.observationCount).toBe(2);
  });

  it("a DIFFERENT bundle never collides with, or overwrites, another identity's snapshot", () => {
    const a = bundle("distinct-a");
    const b = bundle("distinct-b");
    const hashA = upsertEvidenceIdentitySnapshot(a, "2026-07-20T03:00:00.000Z");
    const hashB = upsertEvidenceIdentitySnapshot(b, "2026-07-20T03:00:00.000Z");
    expect(hashA).not.toBe(hashB);
    expect(getEvidenceIdentitySnapshot(hashA)!.bundle).toEqual(a);
    expect(getEvidenceIdentitySnapshot(hashB)!.bundle).toEqual(b);
  });
});
