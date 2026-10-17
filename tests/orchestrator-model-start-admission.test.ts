import { describe, expect, it, beforeEach, vi } from "vitest";

const lmInferenceMock = vi.fn();
vi.mock("../src/runner/lmstudio-client.js", () => ({
  runLmStudioInference: (modelId: string, prompt: string, opts: unknown) =>
    lmInferenceMock(modelId, prompt, opts),
}));

const orinInferenceMock = vi.fn();
vi.mock("../src/homeserver/nodes.js", () => ({
  configuredDelegateModelIds: () => ["orin-model"],
  orinAllowsTask: () => true,
  runOrinInference: (modelId: string, prompt: string, opts: unknown, cfg: unknown) =>
    orinInferenceMock(modelId, prompt, opts, cfg),
}));

vi.mock("../src/homeserver/model-admin.js", () => ({
  getLoaded: async () => [{ key: "m5-model" }],
}));

const frontierMock = vi.fn();
vi.mock("../src/runner/openrouter-client.js", () => ({
  runInference: (modelId: string, prompt: string, opts: unknown) => frontierMock(modelId, prompt, opts),
}));

const recordDelegationMock = vi.fn(() => "ledger-id-1");
vi.mock("../src/homeserver/ledger.js", () => ({
  shouldDelegate: () => ({ delegate: true, reason: "test: delegate" }),
  recordDelegation: (rec: unknown) => recordDelegationMock(rec),
  getLaneEvidence: () => ({
    taskType: "test", modelId: "test-model", verifier: null, attempts: 0, passes: 0, partials: 0,
    fails: 0, errors: 0, successRate: 0, errorRate: 0, p50LatencyMs: null, p90LatencyMs: null,
    latestTs: null, sources: {},
  }),
}));

let delegate: typeof import("../src/homeserver/orchestrator.js").delegate;
let setConfig: typeof import("../src/homeserver/config.js").setConfig;
let resetConfig: typeof import("../src/homeserver/config.js").resetConfig;

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
    accessLog: "off",
    delegationCostLog: "off",
    disagreementGate: "off",
    orin: { url: "http://orin.test", model: "orin-model", eligibleTaskTypes: ["extract"], healthTimeoutMs: 500 },
  });
  orinInferenceMock.mockResolvedValue(lmOk("ORIN ANSWER"));
  frontierMock.mockResolvedValue({ ok: true, response: "FRONTIER ANSWER" });
});

describe("delegate() — model-start admission node boundary", () => {
  it("skips the M5 admission hook for an explicitly eligible Orin run", async () => {
    const beforeModelStart = vi.fn(async () => {});

    const out = await delegate({
      nodeId: "orin",
      modelId: "orin-model",
      taskType: "extract",
      prompt: "extract the value",
      beforeModelStart,
    });

    expect(out.delegated).toBe(true);
    expect(out.output).toBe("ORIN ANSWER");
    expect(orinInferenceMock).toHaveBeenCalledTimes(1);
    expect(lmInferenceMock).not.toHaveBeenCalled();
    expect(beforeModelStart).not.toHaveBeenCalled();
  });
});
