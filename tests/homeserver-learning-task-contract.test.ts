import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  LEARNING_TASK_CAPABILITIES,
  LEARNING_TASK_CONTRACT_VERSION,
  LEARNING_TASK_SCHEMA_REVISION,
  LearningTaskContractError,
  createLearningTaskCapabilityEpoch,
  createLearningTaskGatewayEcho,
  jcsCanonicalize,
  parseHuginRequestStamp,
  validateHuginRequestStamp,
  type HuginRequestStamp,
} from "../src/homeserver/learning-task-contract.js";

interface SerializerFixture {
  fixture_status: string;
  contract_source: string;
  producer_source: string;
  raw_logical_task: string;
  observed_hugin_instruction: string;
  task_id: string;
  task_type: string;
  expected_raw_fingerprint: string;
  expected_contract: unknown;
  origin_config: {
    prompt: [string, string];
    harness: [string, string];
    tool_policy: [string, string];
  };
  stamp: unknown;
}

interface HuginRequestFixture {
  prompt: string;
  taskType: string;
  huginTaskIdentity: {
    taskId: string;
    rawTaskFingerprint: { digest: string };
  };
  learningTaskStamp: unknown;
}

const serializerFixtureUrl = new URL("./fixtures/hugin-learning-task-serializer-v1.json", import.meta.url);
const serializerFixtureBytes = readFileSync(serializerFixtureUrl);
const fixture = JSON.parse(serializerFixtureBytes.toString("utf8")) as SerializerFixture;
const requestFixtureBytes = readFileSync(
  new URL("./fixtures/hugin-learning-task-request-v1.json", import.meta.url),
);
const requestFixture = JSON.parse(requestFixtureBytes.toString("utf8")) as HuginRequestFixture;

const NOW = new Date("2026-07-19T10:00:03.000Z");
const ADVERTISED = new Date("2026-07-19T10:00:02.000Z");

function clone<T>(value: T): T {
  return structuredClone(value);
}

function liveStamp(): { stamp: HuginRequestStamp; epoch: ReturnType<typeof createLearningTaskCapabilityEpoch> } {
  const epoch = createLearningTaskCapabilityEpoch();
  const stamp = parseHuginRequestStamp(clone(fixture.stamp));
  stamp.preflight.response = epoch.advertise(ADVERTISED);
  return { stamp, epoch };
}

function validate(stamp: unknown, epoch: ReturnType<typeof createLearningTaskCapabilityEpoch>, overrides: {
  authenticatedPrincipalId?: string;
  transportIdempotencyKey?: string;
  taskType?: string;
  now?: Date;
} = {}): HuginRequestStamp {
  return validateHuginRequestStamp(stamp, {
    capabilityEpoch: epoch,
    authenticatedPrincipalId: overrides.authenticatedPrincipalId ?? "service:hugin",
    authentication: "gateway-owner-auth",
    transportIdempotencyKey: overrides.transportIdempotencyKey ?? "opaque:e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1",
    effectiveTaskType: overrides.taskType ?? "summarize",
    now: overrides.now ?? NOW,
  });
}

describe("LearningTaskContract v1 gateway contract", () => {
  it("pins and consumes the exact real Hugin serializer fixture without contract drift", () => {
    expect(createHash("sha256").update(serializerFixtureBytes).digest("hex")).toBe(
      "c905050c9e8242353984a4ce2958ff955e29f003124ac6b6673cf05674c9e4b7",
    );
    expect(createHash("sha256").update(requestFixtureBytes).digest("hex")).toBe(
      "a4fbd8930f5798c8e8671af80d79389fa1a2d9c7934d0e243bafae0445a765f6",
    );
    expect(fixture.fixture_status).toBe("real-hugin-serializer");
    expect(fixture.contract_source).toContain("grimnir@032acc9");
    expect(fixture.producer_source).toBe("Magnus-Gille/hugin#240:buildHomeserverRequestBody");
    expect(requestFixture.prompt).toBe(fixture.observed_hugin_instruction);
    expect(requestFixture.learningTaskStamp).toEqual(fixture.stamp);
    const stamp = parseHuginRequestStamp(fixture.stamp);
    expect(stamp.contract_request).toEqual(fixture.expected_contract);
    expect(stamp.contract_request).toEqual({
      contract_version: LEARNING_TASK_CONTRACT_VERSION,
      schema_revision: LEARNING_TASK_SCHEMA_REVISION,
      features: LEARNING_TASK_CAPABILITIES.features,
    });
    expect(stamp.raw_fingerprint.digest).toBe(fixture.expected_raw_fingerprint);
    expect(stamp.task_instance_id).toBe(fixture.task_id);
    expect(stamp.task_type.id).toBe(fixture.task_type);
    expect(requestFixture.taskType).toBe(fixture.task_type);
    expect(requestFixture.huginTaskIdentity).toMatchObject({
      taskId: fixture.task_id,
      rawTaskFingerprint: { digest: fixture.expected_raw_fingerprint },
    });
    expect([stamp.origin_config.prompt.id, stamp.origin_config.prompt.version])
      .toEqual(fixture.origin_config.prompt);
    expect([stamp.origin_config.harness.id, stamp.origin_config.harness.version])
      .toEqual(fixture.origin_config.harness);
    expect([stamp.origin_config.tool_policy.id, stamp.origin_config.tool_policy.version])
      .toEqual(fixture.origin_config.tool_policy);
  });

  it("advertises the closed schema, service identity, observation clock, and fifteen-minute epoch", () => {
    const epoch = createLearningTaskCapabilityEpoch();
    const response = epoch.advertise(ADVERTISED);
    expect(response).toEqual({
      advertisement_id: expect.stringMatching(/^opaque:[0-9a-f-]{36}$/),
      endpoint: "/v1/capabilities/learning-task",
      protocol_version: "learning-task-preflight/v1",
      advertised_at: "2026-07-19T10:00:02.000Z",
      expires_at: "2026-07-19T10:15:02.000Z",
      authenticated_principal_id: "service:gille-inference",
      authentication: "service-auth",
      capabilities: LEARNING_TASK_CAPABILITIES,
    });
    expect(epoch.accepts(response, NOW)).toBe(true);
    expect(createLearningTaskCapabilityEpoch().accepts(response, NOW)).toBe(false);
  });

  it("validates the authenticated request and returns an exact, content-blind gateway echo", () => {
    const { stamp, epoch } = liveStamp();
    const accepted = validate(stamp, epoch);
    const echo = createLearningTaskGatewayEcho(accepted, {
      authenticatedPrincipalId: "service:hugin",
      authentication: "gateway-owner-auth",
      gatewayRequestId: "opaque:33333333-3333-4333-8333-333333333333",
      admissionId: "opaque:44444444-4444-4444-8444-444444444444",
      admittedAt: NOW,
    });

    expect(echo.echoed_request).toEqual(accepted);
    expect(echo.capabilities).toEqual(LEARNING_TASK_CAPABILITIES);
    expect(echo.authenticated_principal_id).toBe("service:hugin");
    expect(echo.principal_binding_digest).toEqual({
      algorithm: "sha256",
      version: "gateway-principal-request-binding-jcs-v1",
      digest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(jcsCanonicalize(echo)).not.toContain("Summarize the fixture incident report");
  });

  it("reproduces the accepted Grimnir principal/request JCS binding digest", () => {
    const echo = createLearningTaskGatewayEcho(parseHuginRequestStamp(fixture.stamp), {
      authenticatedPrincipalId: "service:hugin",
      authentication: "gateway-owner-auth",
      gatewayRequestId: "opaque:e3e3e3e3-e3e3-4e3e-8e3e-e3e3e3e3e3e3",
      admissionId: "opaque:e4e4e4e4-e4e4-4e4e-8e4e-e4e4e4e4e4e4",
      admittedAt: new Date("2026-07-19T10:00:03Z"),
    });
    expect(echo.principal_binding_digest.digest).toBe(
      "9263d19b4a3d9f6d9eefacf354f5cae144894df4dc5cb839dd63ebce6d904a0c",
    );
  });

  it("keeps Hugin's transmitted envelope distinct from its authoritative raw prompt fingerprint", () => {
    const { stamp, epoch } = liveStamp();
    expect(fixture.observed_hugin_instruction).not.toBe(fixture.raw_logical_task);
    expect(createHash("sha256").update(fixture.observed_hugin_instruction.trim(), "utf8").digest("hex"))
      .not.toBe(stamp.raw_fingerprint.digest);
    expect(validate(stamp, epoch)).toEqual(stamp);
  });

  it.each([
    ["stale preflight", (s: HuginRequestStamp) => s, { now: new Date("2026-07-19T10:15:02.000Z") }, /expired|fresh/i],
    ["feature downgrade", (s: HuginRequestStamp) => { s.contract_request.features.pop(); return s; }, {}, /feature|schema/i],
    ["caller mismatch", (s: HuginRequestStamp) => s, { authenticatedPrincipalId: "service:not-hugin" }, /principal/i],
    ["idempotency replay under another transport id", (s: HuginRequestStamp) => s, { transportIdempotencyKey: "opaque:99999999-9999-4999-8999-999999999999" }, /idempotency|transport/i],
    ["task taxonomy mutation", (s: HuginRequestStamp) => s, { taskType: "code-edit" }, /task type/i],
  ])("fails closed on %s", (_name, mutate, overrides, expected) => {
    const { stamp, epoch } = liveStamp();
    expect(() => validate(mutate(stamp), epoch, overrides)).toThrow(expected);
  });

  it("rejects an otherwise fresh advertisement from another gateway process/configuration epoch", () => {
    const { stamp } = liveStamp();
    const restarted = createLearningTaskCapabilityEpoch();
    expect(() => validate(stamp, restarted)).toThrow(/epoch|advertisement/i);
  });

  it("rejects extra fields and impossible UTC dates at the public parser boundary", () => {
    const extra = clone(fixture.stamp) as Record<string, unknown>;
    extra["transport_attempt"] = 2;
    expect(() => parseHuginRequestStamp(extra)).toThrow(LearningTaskContractError);

    const impossible = clone(fixture.stamp) as { stamped_at: string };
    impossible.stamped_at = "2026-02-30T10:00:00Z";
    expect(() => parseHuginRequestStamp(impossible)).toThrow(/date|timestamp/i);
  });
});
