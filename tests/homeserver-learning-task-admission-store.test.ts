import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  createLearningTaskGatewayEcho,
  parseHuginRequestStamp,
  type HuginRequestStamp,
} from "../src/homeserver/learning-task-contract.js";
import {
  claimLearningTaskAdmission,
  getLearningTaskAdmissionById,
  getLearningTaskAdmissionByAttempt,
  lookupLearningTaskAdmission,
  releaseLearningTaskAdmission,
} from "../src/homeserver/learning-task-admission-store.js";

const fixture = JSON.parse(readFileSync(
  new URL("./fixtures/hugin-learning-task-serializer-v1.json", import.meta.url),
  "utf8",
)) as { raw_logical_task: string };
const requestFixture = JSON.parse(readFileSync(
  new URL("./fixtures/hugin-learning-task-request-v1.json", import.meta.url),
  "utf8",
)) as { prompt: string; learningTaskStamp: unknown };

function candidate(stamp: HuginRequestStamp, principalId = "service:hugin") {
  const echo = createLearningTaskGatewayEcho(stamp, {
    authenticatedPrincipalId: principalId,
    authentication: "gateway-owner-auth",
    gatewayRequestId: "opaque:e3e3e3e3-e3e3-4e3e-8e3e-e3e3e3e3e3e3",
    admissionId: "opaque:e4e4e4e4-e4e4-4e4e-8e4e-e4e4e4e4e4e4",
    admittedAt: new Date("2026-07-19T10:00:03Z"),
  });
  return {
    principalId,
    clientId: stamp.client_id,
    taskInstanceId: stamp.task_instance_id,
    attemptId: stamp.attempt_id,
    requestId: stamp.request_id,
    idempotencyKey: stamp.idempotency_key,
    requestFingerprint: "sha256:" + "a".repeat(64),
    surface: "delegate" as const,
    gatewayEcho: echo,
  };
}

describe("durable LearningTaskContract admission identity", () => {
  it("linearizes idempotency, task-attempt, and request identities per authenticated principal", () => {
    const db = new Database(":memory:");
    const stamp = parseHuginRequestStamp(requestFixture.learningTaskStamp);
    const first = candidate(stamp);
    expect(claimLearningTaskAdmission(first, db).kind).toBe("claimed");
    expect(claimLearningTaskAdmission(first, db).kind).toBe("existing");

    const sameAttemptStamp = structuredClone(stamp);
    sameAttemptStamp.idempotency_key = "opaque:11111111-1111-4111-8111-111111111111";
    sameAttemptStamp.request_id = "opaque:22222222-2222-4222-8222-222222222222";
    const sameAttemptFreshTransport = candidate(sameAttemptStamp);
    expect(claimLearningTaskAdmission(sameAttemptFreshTransport, db).kind).toBe("conflict");

    const sameRequestStamp = structuredClone(stamp);
    sameRequestStamp.idempotency_key = "opaque:33333333-3333-4333-8333-333333333333";
    sameRequestStamp.attempt_id = "attempt-2";
    const sameRequestFreshAttempt = candidate(sameRequestStamp);
    expect(claimLearningTaskAdmission(sameRequestFreshAttempt, db).kind).toBe("conflict");

    const substitutedClientStamp = structuredClone(stamp);
    substitutedClientStamp.client_id = "substituted-client";
    substitutedClientStamp.idempotency_key = "opaque:55555555-5555-4555-8555-555555555555";
    substitutedClientStamp.request_id = "opaque:66666666-6666-4666-8666-666666666666";
    const substitutedClient = candidate(substitutedClientStamp);
    expect(claimLearningTaskAdmission(substitutedClient, db).kind).toBe("conflict");

    const otherStamp = structuredClone(stamp);
    otherStamp.expected_transport_principal_id = "service:other-hugin";
    const anotherPrincipal = candidate(otherStamp, "service:other-hugin");
    // The store's namespace is the verified transport principal, not a caller-controlled client id.
    expect(claimLearningTaskAdmission(anotherPrincipal, db).kind).toBe("claimed");
    db.close();
  });

  it("persists only the closed stamp/echo and digests, never raw or rendered task content", () => {
    const db = new Database(":memory:");
    const stamp = parseHuginRequestStamp(requestFixture.learningTaskStamp);
    claimLearningTaskAdmission(candidate(stamp), db);
    const row = db.prepare("SELECT * FROM learning_task_admissions").get() as Record<string, unknown>;
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain(fixture.raw_logical_task.trim());
    expect(serialized).not.toContain(requestFixture.prompt);
    expect(serialized).toContain(stamp.raw_fingerprint.digest);
    db.close();
  });

  it("looks up only an exact principal-bound fingerprint and surface without creating a claim", () => {
    const db = new Database(":memory:");
    const stamp = parseHuginRequestStamp(requestFixture.learningTaskStamp);
    const first = candidate(stamp);
    const { gatewayEcho: _gatewayEcho, ...identity } = first;

    expect(lookupLearningTaskAdmission(identity, db)).toEqual({ kind: "none" });
    expect((db.prepare("SELECT COUNT(*) AS count FROM learning_task_admissions").get() as { count: number }).count).toBe(0);

    const claimed = claimLearningTaskAdmission(first, db);
    expect(claimed.kind).toBe("claimed");
    expect(lookupLearningTaskAdmission(identity, db)).toMatchObject({
      kind: "existing",
      record: { gatewayEcho: first.gatewayEcho },
    });
    expect(lookupLearningTaskAdmission({
      ...identity,
      requestFingerprint: "sha256:" + "b".repeat(64),
    }, db).kind).toBe("conflict");
    expect(lookupLearningTaskAdmission({
      ...identity,
      surface: "code-loop",
    }, db).kind).toBe("conflict");
    expect(lookupLearningTaskAdmission({
      ...identity,
      principalId: "service:other-hugin",
    }, db)).toEqual({ kind: "none" });
    db.close();
  });

  it("looks up an admitted request by (task_instance_id, attempt_id) alone — issue #3's authoritative-attempt-reference primitive", () => {
    const db = new Database(":memory:");
    const stamp = parseHuginRequestStamp(requestFixture.learningTaskStamp);
    expect(getLearningTaskAdmissionByAttempt(stamp.task_instance_id, stamp.attempt_id, db)).toBeNull();

    const claimed = claimLearningTaskAdmission(candidate(stamp), db);
    expect(claimed.kind).toBe("claimed");

    const found = getLearningTaskAdmissionByAttempt(stamp.task_instance_id, stamp.attempt_id, db);
    expect(found?.gatewayEcho.echoed_request.task_instance_id).toBe(stamp.task_instance_id);
    expect(found?.gatewayEcho.echoed_request.attempt_id).toBe(stamp.attempt_id);
    expect(found?.gatewayEcho.echoed_request.source.component).toBe("hugin");

    // A near-miss (right task, wrong attempt id) must not resolve to any row.
    expect(getLearningTaskAdmissionByAttempt(stamp.task_instance_id, "some-other-attempt", db)).toBeNull();
    db.close();
  });

  it("resolves only the exact server-generated admission id for ledger binding (#61)", () => {
    const db = new Database(":memory:");
    const stamp = parseHuginRequestStamp(requestFixture.learningTaskStamp);
    const claimed = claimLearningTaskAdmission(candidate(stamp), db);
    expect(claimed.kind).toBe("claimed");
    if (claimed.kind !== "claimed") return;

    expect(getLearningTaskAdmissionById(claimed.record.admissionRecordId, db)).toMatchObject({
      admissionRecordId: claimed.record.admissionRecordId,
      taskInstanceId: stamp.task_instance_id,
      attemptId: stamp.attempt_id,
      surface: "delegate",
    });
    expect(getLearningTaskAdmissionById("no-such-admission", db)).toBeNull();
    db.close();
  });

  it("releases only through the explicit pre-execution rollback operation", () => {
    const db = new Database(":memory:");
    const stamp = parseHuginRequestStamp(requestFixture.learningTaskStamp);
    const first = claimLearningTaskAdmission(candidate(stamp), db);
    expect(first.kind).toBe("claimed");
    if (first.kind !== "claimed") return;

    expect(releaseLearningTaskAdmission(first.record.admissionRecordId, db)).toBe(true);
    expect(claimLearningTaskAdmission(candidate(stamp), db).kind).toBe("claimed");
    db.close();
  });
});
