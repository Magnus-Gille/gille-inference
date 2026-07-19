/**
 * Issue #166 — grammar-constrained structured output through the local delegate path.
 *
 * The robust prevention behind #164's retry band-aid: JSON-shaped task types are delegated with a
 * `response_format`, which engages llama.cpp's constrained decoder so gpt-oss-120b's harmony parser
 * can't hard-throw a PEG 500 on strict-JSON prompts. Two layers:
 *
 *   - resolveResponseFormat(): the pure precedence rule (explicit > json-type default > none) — the
 *     trust anchor, tested without mocks.
 *   - delegate():             the resolved format actually reaches runLmStudioInference (primary AND
 *     the disagreement-gate secondary), respects the config kill-switch, and never touches prose tasks.
 *
 * Written BEFORE the implementation (red→green).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// ── mocks: inference clients, the loaded-model resolver, and the DB-touching ledger ──
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
  getLoaded: async () => [{ key: "gpt-oss-120b" }],
}));

const recordDelegationMock = vi.fn(() => "ledger-id-1");
vi.mock("../src/homeserver/ledger.js", () => ({
  shouldDelegate: () => ({ delegate: true, reason: "test: delegate" }),
  recordDelegation: (rec: unknown) => recordDelegationMock(rec),
  getLaneEvidence: () => ({
    taskType: "test",
    modelId: "test-model",
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
let resolveResponseFormat: typeof import("../src/homeserver/orchestrator.js").resolveResponseFormat;
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

/** The response_format that reached runLmStudioInference for a given served model id. */
function formatFor(modelId: string): unknown {
  const call = lmInferenceMock.mock.calls.find((c) => c[0] === modelId);
  return call ? (call[2] as { responseFormat?: unknown }).responseFormat : "NO_CALL";
}

beforeEach(async () => {
  vi.clearAllMocks();
  const orch = await import("../src/homeserver/orchestrator.js");
  const cfg = await import("../src/homeserver/config.js");
  delegate = orch.delegate;
  resolveResponseFormat = orch.resolveResponseFormat;
  setConfig = cfg.setConfig;
  resetConfig = cfg.resetConfig;
  resetConfig();
  // Plain delegate path: routing/gate off, logs silent. autoJsonResponseFormat defaults ON.
  setConfig({ useRoutingTable: "off", disagreementGate: "off", accessLog: "off", delegationCostLog: "off" });
  lmInferenceMock.mockResolvedValue(lmOk('{"verdict":"ready"}'));
  frontierMock.mockResolvedValue({ ok: true, response: "FRONTIER ANSWER" });
});

// ── The pure precedence rule (the ticket's testable core) ─────────────────────────
describe("resolveResponseFormat — precedence (explicit > json-type default > none)", () => {
  const schema = { type: "json_schema", json_schema: { name: "v", schema: {} } } as const;

  it("defaults a JSON-shaped task type to json_object when autoJson is on", () => {
    expect(resolveResponseFormat("triage", undefined, true)).toEqual({ type: "json_object" });
    expect(resolveResponseFormat("source-distill", undefined, true)).toEqual({ type: "json_object" });
  });

  it("returns none for a prose task type even when autoJson is on", () => {
    expect(resolveResponseFormat("qa-factual", undefined, true)).toBeUndefined();
    expect(resolveResponseFormat("code-implement", undefined, true)).toBeUndefined();
  });

  it("returns none for a JSON-shaped type when autoJson is off (the kill-switch)", () => {
    expect(resolveResponseFormat("triage", undefined, false)).toBeUndefined();
  });

  it("an explicit format always wins — over the default AND the kill-switch", () => {
    expect(resolveResponseFormat("triage", schema, true)).toBe(schema); // wins over json_object default
    expect(resolveResponseFormat("qa-factual", schema, true)).toBe(schema); // supplied on a prose type
    expect(resolveResponseFormat("triage", schema, false)).toBe(schema); // wins even with autoJson off
  });
});

// ── The resolved format reaches the local call(s) ────────────────────────────────
describe("delegate() — forwards response_format to the local model (#166)", () => {
  it("a triage (JSON-shaped) task gets a json_object response_format on the local call", async () => {
    await delegate({ prompt: "triage this request", taskType: "triage" });
    expect(lmInferenceMock).toHaveBeenCalledTimes(1);
    expect(formatFor("gpt-oss-120b")).toEqual({ type: "json_object" });
  });

  it("a prose (qa-factual) task sends NO response_format (unconstrained decoding preserved)", async () => {
    await delegate({ prompt: "what is the capital of France?", taskType: "qa-factual" });
    expect(formatFor("gpt-oss-120b")).toBeUndefined();
  });

  it("autoJsonResponseFormat=off disables the default even for a JSON-shaped task", async () => {
    setConfig({ autoJsonResponseFormat: false });
    await delegate({ prompt: "triage this request", taskType: "triage" });
    expect(formatFor("gpt-oss-120b")).toBeUndefined();
  });

  it("an explicit task.responseFormat (json_schema) is forwarded verbatim, overriding the default", async () => {
    const schema = {
      type: "json_schema" as const,
      json_schema: { name: "triage_verdict", schema: { type: "object" }, strict: true },
    };
    await delegate({ prompt: "triage this request", taskType: "triage", responseFormat: schema });
    expect(formatFor("gpt-oss-120b")).toEqual(schema);
  });

  it("the format-500 retry (#164) reuses the SAME response_format on the second attempt", async () => {
    const PEG = "LM Studio error: 500 (no body) Value does not match the expected peg-native format";
    lmInferenceMock
      .mockResolvedValueOnce({ ok: false as const, error: PEG })
      .mockResolvedValueOnce(lmOk('{"verdict":"ready"}'));
    const out = await delegate({ prompt: "triage this request", taskType: "triage" });
    expect(out.formatRetried).toBe(true);
    expect(lmInferenceMock).toHaveBeenCalledTimes(2);
    // both attempts carried the json_object constraint
    for (const c of lmInferenceMock.mock.calls) {
      expect((c[2] as { responseFormat?: unknown }).responseFormat).toEqual({ type: "json_object" });
    }
  });

  it("the disagreement-gate secondary model receives the same response_format", async () => {
    // shadow mode: the gate runs on the unverified path (no verifier) but does NOT change routing,
    // so we isolate the forwarding contract. Primary=gpt-oss-120b, secondary=qwen3-coder-next-80b.
    setConfig({ disagreementGate: "shadow", disagreementGateModel: "qwen3-coder-next-80b" });
    lmInferenceMock.mockImplementation(async (modelId: string) =>
      lmOk(modelId === "gpt-oss-120b" ? '{"verdict":"ready"}' : '{"verdict":"clarify"}')
    );
    await delegate({ prompt: "triage this request", taskType: "triage" });
    expect(lmInferenceMock).toHaveBeenCalledTimes(2);
    expect(formatFor("gpt-oss-120b")).toEqual({ type: "json_object" }); // primary
    expect(formatFor("qwen3-coder-next-80b")).toEqual({ type: "json_object" }); // secondary
  });
});
