import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, getDb, initDb } from "../src/db.js";
import { createDirectGatewayHarness, type DirectGatewayHarness } from "./helpers/direct-gateway.js";

type MockMode = "ok" | "length" | "failed" | "empty" | "no-model" | "unknown";
const mockState = vi.hoisted(() => ({ mode: "ok" as MockMode, inferenceRequests: 0 }));
vi.mock("../src/runner/lmstudio-client.js", () => ({
  runLmStudioInference: vi.fn(async () => {
    mockState.inferenceRequests += 1;
    if (mockState.mode === "failed") return { ok: false, error: "mock failed" };
    if (mockState.mode === "length") {
      return { ok: false, error: "mock truncated", truncated: true, finishReason: "length", promptTokens: 3, completionTokens: 2, durationMs: 1, ttftMs: 1 };
    }
    if (mockState.mode === "empty") return { ok: false, error: "Empty response from mock model" };
    if (mockState.mode === "unknown") {
      return { ok: true, response: "local output", promptTokens: 3, completionTokens: 2, durationMs: 1, ttftMs: 1, tokensPerSecond: 2, finishReason: null };
    }
    return { ok: true, response: "local output", promptTokens: 3, completionTokens: 2, durationMs: 1, ttftMs: 1, tokensPerSecond: 2, truncated: false };
  }),
}));
vi.mock("../src/homeserver/model-admin.js", () => ({
  getLoaded: vi.fn(async () => mockState.mode === "no-model" ? [] : [{ key: "m1", contextLength: null }]),
  listModels: vi.fn(async () => []),
  getRunningSnapshot: vi.fn(async () => ({ models: [] })),
  loadModel: vi.fn(),
  unloadModel: vi.fn(),
  downloadModel: vi.fn(),
  RunningSnapshotUnavailableError: class extends Error {},
}));
let mintKey: typeof import("../src/homeserver/keystore.js").mintKey;
let lookupKey: typeof import("../src/homeserver/keystore.js").lookupKey;
let resetQuotaWindows: typeof import("../src/homeserver/quota.js").resetQuotaWindows;
let harness: DirectGatewayHarness;

const DEFAULTS = { rpm: 1000, tpm: 1_000_000, dailyTokenBudget: 0, maxParallel: 1 };

async function delegate(token: string, body: Record<string, unknown>): Promise<{
  response: { status: number };
  body: Record<string, unknown>;
}> {
  const result = await harness.invoke({
    method: "POST",
    path: "/delegate",
    token,
    headers: { "content-type": "application/json" },
    body,
  });
  return { response: result, body: result.json as Record<string, unknown> };
}

function feedbackRows(): Array<Record<string, unknown>> {
  return getDb().prepare("SELECT * FROM execution_feedback ORDER BY rowid ASC").all() as Array<Record<string, unknown>>;
}

beforeAll(async () => {
  initDb(join(mkdtempSync(join(tmpdir(), "hs-execution-feedback-delegate-")), "test.db"));
  process.env["HOMESERVER_HOST"] = "127.0.0.1";
  process.env["HOMESERVER_ADMIN_API_KEYS"] = "static-test-admin";
  process.env["HOMESERVER_MONITOR_API_KEYS"] = "static-test-monitor";
  delete process.env["HOMESERVER_API_KEYS"];

  const keystore = await import("../src/homeserver/keystore.js");
  const quota = await import("../src/homeserver/quota.js");
  mintKey = keystore.mintKey;
  lookupKey = keystore.lookupKey;
  resetQuotaWindows = quota.resetQuotaWindows;
  harness = createDirectGatewayHarness();
});

afterAll(async () => {
  closeDb();
});

beforeEach(() => {
  mockState.mode = "ok";
  mockState.inferenceRequests = 0;
  resetQuotaWindows();
});

describe("owner /delegate execution feedback binding", () => {
  it("returns a handle joined to the exact completed ledger row and records omitted purpose as unknown", async () => {
    const owner = mintKey({ alias: "feedback-delegate-owner", tier: "owner", scope: "admin" }, DEFAULTS);
    const explicit = await delegate(owner.plaintextKey, {
      prompt: "owner-visible organic output",
      taskType: "summarize",
      modelId: "m1",
      trafficPurpose: "organic",
    });
    expect(explicit.response.status).toBe(200);
    expect(explicit.body).toMatchObject({ delegated: true, output: "local output", feedbackHandle: expect.any(String) });
    const explicitLedgerId = explicit.body.ledgerId;
    expect(typeof explicitLedgerId).toBe("string");
    const ledger = getDb().prepare("SELECT id, source, node_id, shadow, superseded_at, outcome FROM delegations WHERE id = ?")
      .get(explicitLedgerId) as Record<string, unknown>;
    expect(ledger).toMatchObject({ id: explicitLedgerId, source: "gateway", node_id: "m5", shadow: 0, superseded_at: null, outcome: "unverified" });
    const ownerRecord = lookupKey(owner.plaintextKey)!;
    const row = getDb().prepare("SELECT handle, ledger_id, principal_hash, surface, traffic_purpose, epoch FROM execution_feedback WHERE ledger_id = ?")
      .get(explicitLedgerId) as Record<string, unknown>;
    expect(row).toMatchObject({
      handle: explicit.body.feedbackHandle,
      ledger_id: explicitLedgerId,
      principal_hash: ownerRecord.keyHash,
      surface: "delegate",
      traffic_purpose: "organic",
      epoch: "organic-exact-feedback-v1",
    });

    const omitted = await delegate(owner.plaintextKey, {
      prompt: "owner-visible unspecified output",
      taskType: "summarize",
      modelId: "m1",
    });
    expect(omitted.response.status).toBe(200);
    expect(omitted.body.feedbackHandle).toEqual(expect.any(String));
    const omittedRow = getDb().prepare("SELECT traffic_purpose FROM execution_feedback WHERE ledger_id = ?")
      .get(omitted.body.ledgerId) as { traffic_purpose: string };
    expect(omittedRow.traffic_purpose).toBe("unknown");
  });

  it("rejects invalid purpose before execution and excludes guest, static, and monitor callers", async () => {
    const owner = mintKey({ alias: "feedback-delegate-invalid", tier: "owner", scope: "admin" }, DEFAULTS);
    const initialFeedbackRows = feedbackRows();
    const invalid = await delegate(owner.plaintextKey, {
      prompt: "must not execute",
      modelId: "m1",
      trafficPurpose: "owner-secret-purpose",
    });
    expect(invalid.response.status).toBe(400);
    expect((invalid.body.error as Record<string, unknown>).param).toBe("trafficPurpose");
    expect(mockState.inferenceRequests).toBe(0);

    const guest = mintKey({ alias: "feedback-delegate-guest", tier: "guest", scope: "inference" }, DEFAULTS);
    const deniedGuest = await delegate(guest.plaintextKey, { prompt: "guest", modelId: "m1", trafficPurpose: "organic" });
    expect(deniedGuest.response.status).toBe(403);
    const deniedStatic = await delegate("static-test-admin", { prompt: "static", modelId: "m1", trafficPurpose: "organic" });
    expect(deniedStatic.response.status).toBe(200);
    expect(deniedStatic.body).not.toHaveProperty("feedbackHandle");
    const deniedMonitor = await delegate("static-test-monitor", { prompt: "monitor", modelId: "m1", trafficPurpose: "organic" });
    expect(deniedMonitor.response.status).toBe(403);
    expect(mockState.inferenceRequests).toBe(1);
    expect(feedbackRows()).toEqual(initialFeedbackRows);
  });

  it.each([
    ["truncated", "length", "m1"],
    ["failed", "failed", "m1"],
    ["no local output", "empty", "m1"],
    ["escalation", "no-model", undefined],
  ] as const)("does not bind a handle for %s local result", async (_label, mode, modelId) => {
    mockState.mode = mode;
    const owner = mintKey({ alias: `feedback-delegate-${_label.replaceAll(" ", "-")}`, tier: "owner", scope: "admin" }, DEFAULTS);
    const body: Record<string, unknown> = { prompt: `private ${_label} output`, taskType: "summarize", trafficPurpose: "organic" };
    if (modelId !== undefined) body.modelId = modelId;
    const result = await delegate(owner.plaintextKey, body);
    expect(result.response.status).toBe(200);
    expect(result.body).not.toHaveProperty("feedbackHandle");
    if (mode === "no-model") expect(result.body).toMatchObject({ delegated: false, escalate: true });
    const ledgerId = result.body.ledgerId;
    if (typeof ledgerId === "string") {
      const feedback = getDb().prepare("SELECT 1 FROM execution_feedback WHERE ledger_id = ?").get(ledgerId);
      expect(feedback).toBeUndefined();
    }
  });

  it("preserves nonempty output but does not bind when truncation metadata is unknown", async () => {
    mockState.mode = "unknown";
    const owner = mintKey({ alias: "feedback-delegate-unknown-truncation", tier: "owner", scope: "admin" }, DEFAULTS);
    const result = await delegate(owner.plaintextKey, {
      prompt: "unknown completion metadata",
      taskType: "summarize",
      modelId: "m1",
      trafficPurpose: "organic",
    });
    expect(result.response.status).toBe(200);
    expect(result.body).toMatchObject({ delegated: true, output: "local output" });
    expect(result.body).not.toHaveProperty("feedbackHandle");
    const ledgerId = result.body.ledgerId;
    if (typeof ledgerId === "string") {
      expect(getDb().prepare("SELECT 1 FROM execution_feedback WHERE ledger_id = ?").get(ledgerId)).toBeUndefined();
    }
  });

  it("preserves a successful delegate response when feedback binding fails", async () => {
    const owner = mintKey({ alias: "feedback-delegate-binding-failure", tier: "owner", scope: "admin" }, DEFAULTS);
    const initial = await delegate(owner.plaintextKey, {
      prompt: "seed the feedback schema",
      taskType: "summarize",
      modelId: "m1",
      trafficPurpose: "organic",
    });
    expect(initial.response.status).toBe(200);

    getDb().exec(`
      CREATE TRIGGER feedback_binding_failure
      BEFORE INSERT ON execution_feedback
      BEGIN
        SELECT RAISE(ABORT, 'feedback-binding-failed');
      END;
    `);

    const result = await delegate(owner.plaintextKey, {
      prompt: "original output must survive binding failure",
      taskType: "summarize",
      modelId: "m1",
      trafficPurpose: "organic",
    });
    expect(result.response.status).toBe(200);
    expect(result.body).toMatchObject({ delegated: true, output: "local output" });
    expect(result.body).not.toHaveProperty("feedbackHandle");
  });
});
