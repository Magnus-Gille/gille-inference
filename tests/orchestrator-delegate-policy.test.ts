import { describe, it, expect, beforeEach, vi } from "vitest";
import { DEFAULT_DELEGATE_POLICY } from "../src/homeserver/config.js";
import type { LaneEvidence } from "../src/homeserver/ledger.js";

const lmInferenceMock = vi.fn();
vi.mock("../src/runner/lmstudio-client.js", () => ({
  runLmStudioInference: (modelId: string, prompt: string, opts: unknown) =>
    lmInferenceMock(modelId, prompt, opts),
}));

const frontierMock = vi.fn();
vi.mock("../src/runner/openrouter-client.js", () => ({
  runInference: (modelId: string, prompt: string, opts: unknown) => frontierMock(modelId, prompt, opts),
}));

vi.mock("../src/homeserver/model-admin.js", () => ({
  getLoaded: async () => [{ key: "mellum" }],
}));

const recordDelegationMock = vi.fn(() => "ledger-id-1");
const getLaneEvidenceMock = vi.fn();
vi.mock("../src/homeserver/ledger.js", () => ({
  shouldDelegate: () => ({ delegate: true, reason: "test: delegate" }),
  recordDelegation: (rec: unknown) => recordDelegationMock(rec),
  getLaneEvidence: (...args: unknown[]) => getLaneEvidenceMock(...args),
}));

let delegate: typeof import("../src/homeserver/orchestrator.js").delegate;
let setConfig: typeof import("../src/homeserver/config.js").setConfig;
let resetConfig: typeof import("../src/homeserver/config.js").resetConfig;

function lane(partial: Partial<LaneEvidence> = {}): LaneEvidence {
  return {
    taskType: "classify",
    modelId: "mellum",
    verifier: "jsonValid",
    attempts: 10,
    passes: 10,
    partials: 0,
    fails: 0,
    errors: 0,
    successRate: 1,
    errorRate: 0,
    p50LatencyMs: 800,
    p90LatencyMs: 900,
    latestTs: "2026-07-08T00:00:00.000Z",
    sources: { gateway: 10 },
    ...partial,
  };
}

function lmOk(response: string) {
  return {
    ok: true as const,
    response,
    promptTokens: 10,
    completionTokens: 20,
    durationMs: 100,
    ttftMs: 30,
    tokensPerSecond: 50,
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  const orch = await import("../src/homeserver/orchestrator.js");
  const cfg = await import("../src/homeserver/config.js");
  delegate = orch.delegate;
  setConfig = cfg.setConfig;
  resetConfig = cfg.resetConfig;
  resetConfig();
  setConfig({
    useRoutingTable: "off",
    disagreementGate: "off",
    accessLog: "off",
    delegationCostLog: "off",
  });
  lmInferenceMock.mockResolvedValue(lmOk("OK"));
  frontierMock.mockResolvedValue({ ok: true, response: "FRONTIER" });
  getLaneEvidenceMock.mockReturnValue(lane());
});

describe("delegate() — production delegate policy", () => {
  it("enforce mode blocks a no-verifier lane before local inference", async () => {
    setConfig({ delegatePolicy: { ...DEFAULT_DELEGATE_POLICY, mode: "enforce" } });

    const out = await delegate({ taskType: "classify", prompt: "classify this", source: "gateway" });

    expect(out.delegated).toBe(false);
    expect(out.escalate).toBe(true);
    expect(out.delegatePolicy?.action).toBe("shadow");
    expect(out.decisionReason).toContain("delegate-policy shadow");
    expect(lmInferenceMock).not.toHaveBeenCalled();
    expect(recordDelegationMock).not.toHaveBeenCalled();
  });

  it("enforce mode blocks anonymous custom verifier lanes before local inference", async () => {
    setConfig({ delegatePolicy: { ...DEFAULT_DELEGATE_POLICY, mode: "enforce" } });
    getLaneEvidenceMock.mockReturnValue(lane({ verifier: "custom", attempts: 20, passes: 20 }));

    const out = await delegate({
      taskType: "classify",
      prompt: "classify this",
      source: "gateway",
      verifier: async () => ({ outcome: "pass", score: 1 }),
    });

    expect(out.delegated).toBe(false);
    expect(out.escalate).toBe(true);
    expect(out.delegatePolicy?.action).toBe("shadow");
    expect(out.decisionReason).toContain("delegate-policy shadow");
    expect(lmInferenceMock).not.toHaveBeenCalled();
    expect(recordDelegationMock).not.toHaveBeenCalled();
  });

  it("shadow mode records the policy decision but preserves current local behavior", async () => {
    setConfig({ delegatePolicy: { ...DEFAULT_DELEGATE_POLICY, mode: "shadow" } });

    const out = await delegate({ taskType: "classify", prompt: "classify this", source: "gateway" });

    expect(out.delegated).toBe(true);
    expect(out.escalate).toBe(false);
    expect(out.delegatePolicy?.action).toBe("shadow");
    expect(lmInferenceMock).toHaveBeenCalledTimes(1);
    expect(recordDelegationMock).toHaveBeenCalledTimes(1);
  });

  it("enforce mode allows a certified verifier-backed lane", async () => {
    setConfig({ delegatePolicy: { ...DEFAULT_DELEGATE_POLICY, mode: "enforce" } });

    const out = await delegate({
      taskType: "classify",
      prompt: "return OK",
      source: "gateway",
      verifierName: "jsonValid",
      verifier: async () => ({ outcome: "pass", score: 1 }),
    });

    expect(out.delegated).toBe(true);
    expect(out.escalate).toBe(false);
    expect(out.delegatePolicy?.action).toBe("allow");
    expect(lmInferenceMock).toHaveBeenCalledTimes(1);
    expect(recordDelegationMock).toHaveBeenCalledTimes(1);
  });
});
