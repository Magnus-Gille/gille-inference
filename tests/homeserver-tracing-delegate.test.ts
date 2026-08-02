import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  getLoaded: async () => [{ key: "gpt-oss-120b", contextLength: 32768 }],
  getRunningCmd: async () => "--model /srv/models/gpt-oss-120b.gguf --ctx-size 32768",
}));

const recordDelegationMock = vi.fn(() => "ledger-id-1");
vi.mock("../src/homeserver/ledger.js", () => ({
  shouldDelegate: () => ({ delegate: true, reason: "test delegate" }),
  recordDelegation: (rec: unknown) => recordDelegationMock(rec),
  getLaneEvidence: () => ({
    taskType: "extract",
    modelId: "gpt-oss-120b",
    verifier: null,
    attempts: 0,
    passes: 0,
    partials: 0,
    fails: 0,
    errors: 0,
    successRate: 0,
    errorRate: 0,
    p50LatencyMs: null,
    p90LatencyMs: null,
    latestTs: null,
    sources: {},
  }),
}));

let delegate: typeof import("../src/homeserver/orchestrator.js").delegate;
let runWithSyntheticTraceForTests: typeof import("../src/homeserver/tracing.js").runWithSyntheticTraceForTests;
let flushTracingForTests: typeof import("../src/homeserver/tracing.js").flushTracingForTests;
let setTracingTestHooks: typeof import("../src/homeserver/tracing.js").setTracingTestHooks;
let resetTracingTestHooks: typeof import("../src/homeserver/tracing.js").resetTracingTestHooks;
let setConfig: typeof import("../src/homeserver/config.js").setConfig;
let resetConfig: typeof import("../src/homeserver/config.js").resetConfig;
let setDefaultLogger: typeof import("../src/homeserver/access-log.js").setDefaultLogger;
let originalDefaultLogger: typeof import("../src/homeserver/access-log.js").defaultLogger;
let resetCatalogueCache: typeof import("../src/homeserver/catalogue.js").resetCatalogueCache;

const PEG_ERROR =
  "LM Studio error: 500 status code (no body) Value does not match the expected peg-native format";

function lmOk(response: string) {
  return {
    ok: true as const,
    response,
    promptTokens: 10,
    completionTokens: 20,
    durationMs: 120,
    ttftMs: 30,
    tokensPerSecond: 66,
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  const accessLog = await import("../src/homeserver/access-log.js");
  setDefaultLogger = accessLog.setDefaultLogger;
  originalDefaultLogger = accessLog.defaultLogger;
  setDefaultLogger(accessLog.createAccessLogger(() => {}));
  const orch = await import("../src/homeserver/orchestrator.js");
  const tracing = await import("../src/homeserver/tracing.js");
  const cfg = await import("../src/homeserver/config.js");
  const catalogue = await import("../src/homeserver/catalogue.js");
  delegate = orch.delegate;
  runWithSyntheticTraceForTests = tracing.runWithSyntheticTraceForTests;
  flushTracingForTests = tracing.flushTracingForTests;
  setTracingTestHooks = tracing.setTracingTestHooks;
  resetTracingTestHooks = tracing.resetTracingTestHooks;
  setConfig = cfg.setConfig;
  resetConfig = cfg.resetConfig;
  resetCatalogueCache = catalogue.resetCatalogueCache;
  resetConfig();
  setConfig({ useRoutingTable: "off", disagreementGate: "off", accessLog: "off", delegationCostLog: "off" });
  frontierMock.mockResolvedValue({ ok: true, response: "FRONTIER" });
});

afterEach(() => {
  setDefaultLogger(originalDefaultLogger);
  resetTracingTestHooks();
  vi.restoreAllMocks();
});

describe("delegate tracing", () => {
  it("records retry ordinals and verification without exporting the caller model id", async () => {
    setTracingTestHooks({
      captureExports: true,
      nextSpanId: vi
        .fn<() => string>()
        .mockReturnValueOnce("b9c7c989f97918e2")
        .mockReturnValueOnce("1111111111111111")
        .mockReturnValueOnce("2222222222222222")
        .mockReturnValueOnce("3333333333333333"),
    });
    lmInferenceMock
      .mockResolvedValueOnce({ ok: false as const, error: PEG_ERROR })
      .mockResolvedValueOnce(lmOk("LOCAL JSON ANSWER"));

    const verifier = vi.fn(async () => ({ outcome: "pass" as const, score: 1, notes: "verified" }));

    const out = await runWithSyntheticTraceForTests(
      {
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-b9c7c989f97918e1-01",
        taskType: "delegation",
        lane: "default",
        exportEnabled: true,
      },
      async () =>
        delegate({
          prompt: "output ONLY JSON",
          taskType: "extract",
          verifier,
          verifierName: "exact",
          frontierModelId: "anthropic/claude-sonnet-4-6",
        }),
      { outcome: "ok" },
    );

    expect(out).toMatchObject({
      delegated: true,
      escalate: false,
      output: "LOCAL JSON ANSWER",
      formatRetried: true,
    });
    expect(verifier).toHaveBeenCalledTimes(1);

    const records = await flushTracingForTests();
    const spans = records.filter((record) => (record as { kind?: string }).kind === "trace-span") as Array<{
      phase: string;
      retry_ordinal?: number;
      task_type?: string;
      lane?: string;
      model_artifact_identity?: string;
      outcome?: string;
      error_class?: string;
    }>;
    const inferenceSpans = spans.filter((span) => span.phase === "inference");
    expect(inferenceSpans).toHaveLength(2);
    expect(inferenceSpans.map((span) => span.retry_ordinal)).toEqual([0, 1]);
    expect(inferenceSpans[0]).toMatchObject({ retry_ordinal: 0, outcome: "error", error_class: "parse" });
    expect(inferenceSpans[1]).toMatchObject({ retry_ordinal: 1, outcome: "ok" });
    expect(spans.some((span) => span.phase === "verification")).toBe(true);
    expect(spans[0]?.task_type).toBe("delegation");
    expect(spans[0]?.lane).toBe("default");
    expect(spans.find((span) => span.phase === "inference" && span.retry_ordinal === 1)?.model_artifact_identity).toBeUndefined();
    expect(JSON.stringify(records)).not.toContain("output ONLY JSON");
    expect(JSON.stringify(records)).not.toContain(PEG_ERROR);
  });

  it("never exports a caller-supplied secret-shaped model override with a cold catalogue", async () => {
    setTracingTestHooks({ captureExports: true });
    resetCatalogueCache();
    lmInferenceMock.mockResolvedValue(lmOk("SAFE ANSWER"));
    const secretShapedModelId = "SECRET_TOKEN_ABC";

    await runWithSyntheticTraceForTests(
      {
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4740-b9c7c989f97918e1-01",
        taskType: "delegation",
        lane: "default",
        exportEnabled: true,
      },
      async () =>
        delegate({
          prompt: "keep routing this request",
          taskType: "extract",
          modelId: secretShapedModelId,
        }),
      { outcome: "ok" },
    );

    const records = await flushTracingForTests();
    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain(secretShapedModelId);
    const inference = records.find((record) =>
      (record as { kind?: string; phase?: string }).kind === "trace-span"
      && (record as { phase?: string }).phase === "inference"
    ) as { model_artifact_identity?: string } | undefined;
    expect(inference?.model_artifact_identity).toBeUndefined();
    expect(lmInferenceMock).toHaveBeenCalledWith(secretShapedModelId, expect.any(String), expect.anything());
  });

  it("does not create one exported identity per explicit model override", async () => {
    setTracingTestHooks({ captureExports: true });
    lmInferenceMock.mockResolvedValue(lmOk("SAFE ANSWER"));
    const modelIds = Array.from({ length: 1_000 }, (_, index) => `caller-model-${index}`);

    await runWithSyntheticTraceForTests(
      {
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4741-b9c7c989f97918e1-01",
        taskType: "delegation",
        lane: "default",
        exportEnabled: true,
      },
      async () => {
        for (const modelId of modelIds) {
          await delegate({ prompt: "keep routing this request", taskType: "extract", modelId });
        }
      },
      { outcome: "ok" },
    );

    const records = await flushTracingForTests();
    const identities = records
      .map((record) => (record as { model_artifact_identity?: unknown }).model_artifact_identity)
      .filter((identity): identity is string => typeof identity === "string");
    expect(new Set(identities).size).toBeLessThanOrEqual(1);
    expect(JSON.stringify(records)).not.toContain("caller-model-999");
    expect(lmInferenceMock).toHaveBeenCalledTimes(modelIds.length);
  });

  it("keeps delegate behaviour unchanged when export drops records", async () => {
    setTracingTestHooks({
      exporter: vi.fn(async () => {
        throw new Error("collector offline");
      }),
    });
    lmInferenceMock.mockResolvedValue(lmOk("SAFE ANSWER"));

    const out = await runWithSyntheticTraceForTests(
      {
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-b9c7c989f97918e1-01",
        taskType: "delegation",
        lane: "default",
        exportEnabled: true,
      },
      async () =>
        delegate({
          prompt: "summarize this",
          taskType: "summarize",
          frontierModelId: "anthropic/claude-sonnet-4-6",
        }),
      { outcome: "ok" },
    );

    expect(out).toMatchObject({
      delegated: true,
      escalate: false,
      output: "SAFE ANSWER",
    });
    expect(recordDelegationMock).toHaveBeenCalledTimes(1);
    await expect(flushTracingForTests()).resolves.toBeDefined();
  });
});
