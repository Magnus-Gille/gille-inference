import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  ensureTaskExposureSchema,
  lookupTaskExposures,
  recordTaskExposure,
  taskTextFingerprint,
  TASK_FINGERPRINT_VERSION,
  TASK_EXPOSURE_EXTERNAL_LANE,
  recordExternalProducerHeartbeat,
  externalProducerSurfaceHeartbeats,
  EXTERNAL_EXPOSURE_HEARTBEAT_STALE_MS,
} from "../src/homeserver/task-exposure.js";
import {
  ingestExposureReceipt,
  type ExposureReceiptAdmission,
  type ExposureReceiptRejection,
} from "../src/homeserver/exposure-receipt-intake.js";
import {
  EXPOSURE_RECEIPT_SCHEMA_VERSION,
  EXPOSURE_RECEIPT_CONTRACT_VERSION,
  SUBSCRIPTION_NOT_INDEPENDENT_NOTE,
  type ExposureReceiptEnvelope,
} from "../src/homeserver/exposure-receipt-schema.js";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function makeDb(now = "2026-07-14T20:00:00.000Z"): Database.Database {
  const db = new Database(":memory:");
  ensureTaskExposureSchema(db, now);
  return db;
}

/** A structurally-valid, fully-populated receipt envelope; tests override only what they vary. */
function makeReceipt(overrides: Partial<ExposureReceiptEnvelope> = {}): ExposureReceiptEnvelope {
  const base: ExposureReceiptEnvelope = {
    schemaVersion: EXPOSURE_RECEIPT_SCHEMA_VERSION,
    contractVersion: EXPOSURE_RECEIPT_CONTRACT_VERSION,
    kind: "observation",
    receiptId: "receipt-001",
    surface: "codex_app",
    fingerprintVersion: TASK_FINGERPRINT_VERSION,
    canonicalFingerprintSha256: taskTextFingerprint("Implement the exposure-receipt intake").sha256,
    provider: "openai",
    requestedModel: "gpt-5-codex",
    effectiveModel: { status: "known", modelId: "gpt-5-codex" },
    modelConfigEpoch: { kind: "label", label: "default-config" },
    harness: { kind: "label", label: "codex-app@1.0.0" },
    reasoningEffort: "medium",
    instructionDigest: { kind: "unknown", reason: "not-observed" },
    promptDigest: { kind: "unknown", reason: "not-observed" },
    skillDigest: { kind: "unknown", reason: "not-observed" },
    toolPolicyDigest: { kind: "unknown", reason: "not-observed" },
    subscriptionEntitlementEpoch: "epoch-2026-07",
    occurredAt: "2026-07-20T10:00:00.000Z",
    producedAt: "2026-07-20T10:00:01.000Z",
    subscriptionNotIndependentNote: SUBSCRIPTION_NOT_INDEPENDENT_NOTE,
  };
  return { ...base, ...overrides } as ExposureReceiptEnvelope;
}

describe("exposure-receipt intake — admission (gille#10)", () => {
  it("admits a valid Codex App observation and feeds the shared #4 exposure registry", () => {
    const db = makeDb();
    const receipt = makeReceipt();
    const result = ingestExposureReceipt(receipt, "codex-app-work", { db, now: () => "2026-07-20T10:00:05.000Z" });
    expect(result.status).toBe("admitted");
    const admission = result as ExposureReceiptAdmission;
    expect(admission).toMatchObject({
      admission: "created",
      surface: "codex_app",
      subscriptionAlias: "codex-app-work",
      coverage: "imported",
    });

    const lookup = lookupTaskExposures({
      fingerprint_version: TASK_FINGERPRINT_VERSION,
      fingerprints: [],
      canonical: [{ fingerprint_sha256: receipt.canonicalFingerprintSha256 }],
    }, db, "2026-07-20T10:00:05.000Z");
    expect(lookup.results[0]).toMatchObject({
      seen: true,
      lanes: [TASK_EXPOSURE_EXTERNAL_LANE],
      model_ids: ["gpt-5-codex"],
      external_surfaces: ["codex_app"],
    });
  });

  it("AC1: a task observed first on Codex App and later proposed through Hugin/M5 is returned seen, with both surfaces linked", () => {
    const db = makeDb();
    const taskText = "Refactor the retry policy for delegate() calls";
    const receipt = makeReceipt({
      receiptId: "receipt-ac1",
      canonicalFingerprintSha256: taskTextFingerprint(taskText).sha256,
    });
    ingestExposureReceipt(receipt, "codex-app-work", { db, now: () => "2026-07-20T09:00:00.000Z" });

    // Later, the SAME logical task is proposed through Hugin/M5 — modelled here exactly as
    // gille's own gateway does for a stamped /delegate call: a rendered-prompt row plus a
    // canonical-raw row sharing the SAME canonical fingerprint (#4).
    recordTaskExposure({
      taskText: "<hugin-wrapped rendering of the same task>",
      lane: "delegate",
      modelId: "m1",
      harnessId: "delegate-local",
      canonicalFingerprintSha256: taskTextFingerprint(taskText).sha256,
      eventKey: "hugin-delegate-1",
      ts: "2026-07-20T11:00:00.000Z",
    }, db);

    const lookup = lookupTaskExposures({
      fingerprint_version: TASK_FINGERPRINT_VERSION,
      fingerprints: [],
      canonical: [{ fingerprint_sha256: taskTextFingerprint(taskText).sha256 }],
    }, db, "2026-07-20T11:00:01.000Z");
    expect(lookup.results[0]!.seen).toBe(true);
    expect(lookup.results[0]!.lanes.sort()).toEqual(["delegate", TASK_EXPOSURE_EXTERNAL_LANE].sort());
    expect(lookup.results[0]!.external_surfaces).toEqual(["codex_app"]);
  });

  it("duplicate: an exact redelivery of the same receipt is an idempotent no-op", () => {
    const db = makeDb();
    const receipt = makeReceipt({ receiptId: "receipt-dup" });
    const first = ingestExposureReceipt(receipt, "codex-app-work", { db, now: () => "2026-07-20T10:00:00.000Z" });
    expect(first.status).toBe("admitted");
    expect((first as ExposureReceiptAdmission).admission).toBe("created");

    const second = ingestExposureReceipt(receipt, "codex-app-work", { db, now: () => "2026-07-20T10:05:00.000Z" });
    expect(second.status).toBe("admitted");
    expect((second as ExposureReceiptAdmission).admission).toBe("exact-existing");

    const rows = db.prepare(
      `SELECT COUNT(*) AS n FROM task_exposure_events WHERE fingerprint_sha256 = ?`
    ).get(receipt.canonicalFingerprintSha256) as { n: number };
    expect(rows.n).toBe(1);
  });

  it("receipt-id-reused-with-different-content: a mutated redelivery under the same receiptId is rejected", () => {
    const db = makeDb();
    const receipt = makeReceipt({ receiptId: "receipt-mutate" });
    ingestExposureReceipt(receipt, "codex-app-work", { db, now: () => "2026-07-20T10:00:00.000Z" });

    const mutated = makeReceipt({ receiptId: "receipt-mutate", requestedModel: "gpt-5-codex-mini" });
    const result = ingestExposureReceipt(mutated, "codex-app-work", { db, now: () => "2026-07-20T10:05:00.000Z" });
    expect(result.status).toBe("rejected");
    expect((result as ExposureReceiptRejection).reason).toBe("receipt-id-reused-with-different-content");
  });

  it("late: a terminal receipt reported long after occurredAt is marked imported-late, still admitted and seen", () => {
    const db = makeDb();
    const receipt = makeReceipt({
      receiptId: "receipt-late",
      occurredAt: "2026-06-01T00:00:00.000Z",
    });
    const result = ingestExposureReceipt(receipt, "codex-app-work", { db, now: () => "2026-07-20T10:00:00.000Z" });
    expect(result.status).toBe("admitted");
    expect((result as ExposureReceiptAdmission).coverage).toBe("imported-late");

    const lookup = lookupTaskExposures({
      fingerprint_version: TASK_FINGERPRINT_VERSION,
      fingerprints: [],
      canonical: [{ fingerprint_sha256: receipt.canonicalFingerprintSha256 }],
    }, db, "2026-07-20T10:00:01.000Z");
    expect(lookup.results[0]!.seen).toBe(true);
  });

  it("unknown-model: an honestly-unknown effective model is admitted and never inflates model_ids", () => {
    const db = makeDb();
    const receipt = makeReceipt({
      receiptId: "receipt-unknown-model",
      effectiveModel: { status: "unknown", reason: "not-observed" },
    });
    const result = ingestExposureReceipt(receipt, "codex-app-work", { db, now: () => "2026-07-20T10:00:00.000Z" });
    expect(result.status).toBe("admitted");

    const lookup = lookupTaskExposures({
      fingerprint_version: TASK_FINGERPRINT_VERSION,
      fingerprints: [],
      canonical: [{ fingerprint_sha256: receipt.canonicalFingerprintSha256 }],
    }, db, "2026-07-20T10:00:01.000Z");
    expect(lookup.results[0]).toMatchObject({ seen: true, model_ids: [] });
  });

  it("unsupported-schema-version / unsupported-contract-version / unsupported-fingerprint-version are rejected with specific reasons", () => {
    const db = makeDb();
    const schemaVersionBad = ingestExposureReceipt(
      { ...makeReceipt(), schemaVersion: 999 as unknown as 1 },
      "codex-app-work",
      { db },
    );
    expect((schemaVersionBad as ExposureReceiptRejection).reason).toBe("unsupported-schema-version");

    const contractVersionBad = ingestExposureReceipt(
      { ...makeReceipt(), contractVersion: "some-other-contract/v9" as unknown as typeof EXPOSURE_RECEIPT_CONTRACT_VERSION },
      "codex-app-work",
      { db },
    );
    expect((contractVersionBad as ExposureReceiptRejection).reason).toBe("unsupported-contract-version");

    const fingerprintVersionBad = ingestExposureReceipt(
      { ...makeReceipt(), fingerprintVersion: "sha256-v0" as unknown as typeof TASK_FINGERPRINT_VERSION },
      "codex-app-work",
      { db },
    );
    expect((fingerprintVersionBad as ExposureReceiptRejection).reason).toBe("unsupported-fingerprint-version");
  });

  it("non-content-blind: an unrecognised field (e.g. a smuggled transcript) is rejected outright, not stripped", () => {
    const db = makeDb();
    const withExtra = { ...makeReceipt(), transcript: "the whole conversation" };
    const result = ingestExposureReceipt(withExtra, "codex-app-work", { db });
    expect(result.status).toBe("rejected");
    expect((result as ExposureReceiptRejection).reason).toBe("non-content-blind");
  });

  it("non-content-blind: a free-text-shaped value in an identity field is rejected, not accepted as a token", () => {
    const db = makeDb();
    const withFreeText = makeReceipt({ requestedModel: "this looks like a whole sentence, not a token" });
    const result = ingestExposureReceipt(withFreeText, "codex-app-work", { db });
    expect(result.status).toBe("rejected");
    expect((result as ExposureReceiptRejection).reason).toBe("non-content-blind");
  });

  it("placeholder-identity: a fixture/placeholder harness label is rejected as inadmissible evidence", () => {
    const db = makeDb();
    const receipt = makeReceipt({ harness: { kind: "label", label: "fixture-model-v1" } });
    const result = ingestExposureReceipt(receipt, "codex-app-work", { db });
    expect(result.status).toBe("rejected");
    expect((result as ExposureReceiptRejection).reason).toBe("placeholder-identity");
  });

  it("incomplete-envelope: a missing required field is rejected", () => {
    const db = makeDb();
    const receipt = makeReceipt() as unknown as Record<string, unknown>;
    delete receipt["occurredAt"];
    const result = ingestExposureReceipt(receipt, "codex-app-work", { db });
    expect(result.status).toBe("rejected");
    expect((result as ExposureReceiptRejection).reason).toBe("incomplete-envelope");
  });

  it("never persists raw task content anywhere — only the digest and identity metadata", () => {
    const db = makeDb();
    const marker = "EXPOSURE_RECEIPT_RAW_MARKER_10";
    const receipt = makeReceipt({
      receiptId: "receipt-content-blind",
      canonicalFingerprintSha256: taskTextFingerprint(marker).sha256,
    });
    ingestExposureReceipt(receipt, "codex-app-work", { db });
    const dump = JSON.stringify(db.prepare(`SELECT * FROM task_exposure_events`).all())
      + JSON.stringify(db.prepare(`SELECT * FROM external_exposure_receipts`).all());
    expect(dump).not.toContain(marker);
  });
});

describe("exposure-receipt intake — subscription aliasing (gille#10)", () => {
  it("two subscription aliases reporting the same fingerprint are retained as distinct evidence, never merged as independent", () => {
    const db = makeDb();
    const taskText = "shared task across two Codex CLI subscriptions";
    const fp = taskTextFingerprint(taskText).sha256;
    ingestExposureReceipt(
      makeReceipt({ receiptId: "r1", surface: "codex_cli", canonicalFingerprintSha256: fp }),
      "codex-cli-work",
      { db, now: () => "2026-07-20T10:00:00.000Z" },
    );
    ingestExposureReceipt(
      makeReceipt({ receiptId: "r2", surface: "codex_cli", canonicalFingerprintSha256: fp }),
      "codex-cli-personal",
      { db, now: () => "2026-07-20T10:05:00.000Z" },
    );
    // Both receipts are real, retained evidence — the registry does not collapse them because
    // they share a provider/model/harness; it just sees "codex_cli saw this" twice (dedup is
    // keyed by receiptId, not by subscription). What matters for the "not independent" guarantee
    // is that admission never inspects `subscriptionEntitlementEpoch`/alias plurality as evidence
    // of anything beyond quota/liveness — verified by the schema's fixed literal note being
    // required at parse time (see the SUBSCRIPTION_NOT_INDEPENDENT_NOTE rejection test above).
    const heartbeats = externalProducerSurfaceHeartbeats(db, "2026-07-20T10:05:01.000Z");
    const codexCli = heartbeats.find((h) => h.surface === "codex_cli")!;
    expect(codexCli.principals.map((p) => p.principal_alias).sort()).toEqual(["codex-cli-personal", "codex-cli-work"]);
    expect(codexCli.healthy).toBe(true);
  });

  it("rejects a receipt missing the fixed subscription-not-independent literal", () => {
    const db = makeDb();
    const bad = { ...makeReceipt(), subscriptionNotIndependentNote: "trust me" };
    const result = ingestExposureReceipt(bad, "codex-app-work", { db });
    expect(result.status).toBe("rejected");
  });
});

describe("producer heartbeats and fail-closed coverage (gille#10 AC2)", () => {
  it("a fresh heartbeat keeps unseen_claim_supported true for an unrelated canonical query", () => {
    const db = makeDb();
    recordExternalProducerHeartbeat({ surface: "pi", principalAlias: "pi-home" }, db, );
    const neverSeen = sha256("never-seen-task");
    const lookup = lookupTaskExposures({
      fingerprint_version: TASK_FINGERPRINT_VERSION,
      fingerprints: [],
      canonical: [{
        fingerprint_sha256: neverSeen,
        exact_bytes: { encoding: "utf-8", byte_length: Buffer.byteLength("never-seen-task", "utf8"), text: "never-seen-task" },
      }],
    }, db);
    expect(lookup.coverage.external_producer_heartbeats_healthy).toBe(true);
    expect(lookup.results[0]!.seen).toBe(false);
    expect(lookup.results[0]!.unseen_claim_supported).toBe(true);
  });

  it("a stale registered producer heartbeat prevents an unseen-covered claim registry-wide", () => {
    const db = makeDb("2026-07-01T00:00:00.000Z");
    recordExternalProducerHeartbeat({ surface: "pi", principalAlias: "pi-home", ts: "2026-07-01T00:00:00.000Z" }, db);
    const staleNow = new Date(Date.parse("2026-07-01T00:00:00.000Z") + EXTERNAL_EXPOSURE_HEARTBEAT_STALE_MS + 60_000).toISOString();

    const surfaces = externalProducerSurfaceHeartbeats(db, staleNow);
    expect(surfaces.find((s) => s.surface === "pi")!.healthy).toBe(false);

    const neverSeen = sha256("another-never-seen-task");
    const lookup = lookupTaskExposures({
      fingerprint_version: TASK_FINGERPRINT_VERSION,
      fingerprints: [],
      canonical: [{
        fingerprint_sha256: neverSeen,
        exact_bytes: { encoding: "utf-8", byte_length: Buffer.byteLength("another-never-seen-task", "utf8"), text: "another-never-seen-task" },
      }],
    }, db, staleNow);
    expect(lookup.coverage.external_producer_heartbeats_healthy).toBe(false);
    expect(lookup.results[0]!.seen).toBe(false);
    expect(lookup.results[0]!.unseen_claim_supported).toBe(false);
    expect(lookup.coverage.incomplete_reasons).toContain(
      "one or more registered external exposure producers have a missing or stale heartbeat",
    );
  });

  it("one healthy principal keeps a surface healthy even when a sibling principal on the same surface has gone stale", () => {
    const db = makeDb("2026-07-01T00:00:00.000Z");
    recordExternalProducerHeartbeat({ surface: "codex_cli", principalAlias: "codex-cli-retired", ts: "2026-07-01T00:00:00.000Z" }, db);
    const laterNow = new Date(Date.parse("2026-07-01T00:00:00.000Z") + 60_000).toISOString();
    recordExternalProducerHeartbeat({ surface: "codex_cli", principalAlias: "codex-cli-active", ts: laterNow }, db);

    const checkNow = new Date(Date.parse(laterNow) + EXTERNAL_EXPOSURE_HEARTBEAT_STALE_MS - 1_000).toISOString();
    const surfaces = externalProducerSurfaceHeartbeats(db, checkNow);
    const codexCli = surfaces.find((s) => s.surface === "codex_cli")!;
    expect(codexCli.healthy).toBe(true);
    expect(codexCli.principals.find((p) => p.principal_alias === "codex-cli-retired")!.healthy).toBe(false);
    expect(codexCli.principals.find((p) => p.principal_alias === "codex-cli-active")!.healthy).toBe(true);
  });

  it("an unregistered surface never blocks unseen claims — only registered surfaces gate coverage", () => {
    const db = makeDb();
    const lookup = lookupTaskExposures({
      fingerprint_version: TASK_FINGERPRINT_VERSION,
      fingerprints: [],
      canonical: [{
        fingerprint_sha256: sha256("no-producers-registered-at-all"),
        exact_bytes: { encoding: "utf-8", byte_length: Buffer.byteLength("no-producers-registered-at-all", "utf8"), text: "no-producers-registered-at-all" },
      }],
    }, db);
    expect(lookup.coverage.external_producer_heartbeats).toEqual([]);
    expect(lookup.coverage.external_producer_heartbeats_healthy).toBe(true);
    expect(lookup.results[0]!.unseen_claim_supported).toBe(true);
  });

  it("an admitted receipt itself counts as a heartbeat for its surface/subscription", () => {
    const db = makeDb();
    const receipt = makeReceipt({ receiptId: "receipt-heartbeat-side-effect" });
    ingestExposureReceipt(receipt, "codex-app-work", { db, now: () => "2026-07-20T10:00:00.000Z" });
    const surfaces = externalProducerSurfaceHeartbeats(db, "2026-07-20T10:00:01.000Z");
    const codexApp = surfaces.find((s) => s.surface === "codex_app")!;
    expect(codexApp.healthy).toBe(true);
    expect(codexApp.principals.map((p) => p.principal_alias)).toEqual(["codex-app-work"]);
  });
});
