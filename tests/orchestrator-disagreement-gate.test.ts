/**
 * End-to-end wiring of the cross-model disagreement gate into orchestrator.delegate().
 *
 * The gate's PURE core (decision + eligibility) is covered in tests/disagreement-gate.test.ts.
 * Here we mock the inference clients + the DB-touching ledger so we can drive delegate() through
 * the full path and assert the ROUTING/RECORDING behaviour:
 *   - gate "on"     + disagreeing secondary → escalate + frontier called + gate recorded.
 *   - gate "shadow" + disagreeing secondary → recorded (wouldEscalate) but NOT escalated.
 *   - gate "on"     + agreeing secondary    → kept local, no frontier call.
 *   - a present verifier verdict            → gate never runs (no second model call).
 *   - gate "off" (default)                  → no second model call at all.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// ── mocks: inference clients, the loaded-model resolver, and the ledger (DB) ──
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
  // Default config used by the box; tests override disagreementGate per-case.
  setConfig({
    disagreementGateModel: "qwen3-coder-next-80b",
    disagreementGateThreshold: 0.3,
    accessLog: "off",
    delegationCostLog: "off",
  });
  frontierMock.mockResolvedValue({ ok: true, response: "FRONTIER ANSWER: 9" });
});

/** Make the primary (mellum) and secondary (qwen) return specific outputs. */
function wireLocalModels(primaryOut: string, secondaryOut: string) {
  lmInferenceMock.mockImplementation(async (modelId: string) =>
    modelId === "mellum" ? lmOk(primaryOut) : lmOk(secondaryOut)
  );
}

describe("delegate() — disagreement gate (unverified path)", () => {
  it("gate=on + disagreeing secondary → escalates, calls frontier, records the gate", async () => {
    setConfig({ disagreementGate: "on" });
    wireLocalModels("ANSWER: 7", "ANSWER: 42"); // numeric → disagreementScore 1.0

    const out = await delegate({ prompt: "what is the value?", frontierModelId: "anthropic/claude-sonnet-4-6" });

    expect(out.delegated).toBe(true);
    expect(out.escalate).toBe(true);
    expect(out.gate).toMatchObject({ mode: "on", model: "qwen3-coder-next-80b", wouldEscalate: true });
    expect(out.gate?.score).toBe(1);
    // second local model was actually called
    expect(lmInferenceMock).toHaveBeenCalledTimes(2);
    expect(lmInferenceMock.mock.calls.map((c) => c[0]).sort()).toEqual(["mellum", "qwen3-coder-next-80b"]);
    // frontier fallback ran and its output is attached
    expect(frontierMock).toHaveBeenCalledTimes(1);
    expect(out.frontierOutput).toBe("FRONTIER ANSWER: 9");
    // ledger row marked escalated, with a gate note AND the structured #91 columns
    const rec = recordDelegationMock.mock.calls[0]![0] as {
      escalated: boolean;
      notes: string;
      gateMode: string | null;
      gateScore: number | null;
      gateWouldEscalate: boolean | null;
    };
    expect(rec.escalated).toBe(true);
    expect(rec.notes).toContain("gate(on):qwen3-coder-next-80b");
    expect(rec.notes).toContain("disagree=1");
    expect(rec.gateMode).toBe("on");
    expect(rec.gateScore).toBe(1);
    expect(rec.gateWouldEscalate).toBe(true);
  });

  it("gate=shadow + disagreeing secondary → recorded but NOT escalated (no frontier call)", async () => {
    setConfig({ disagreementGate: "shadow" });
    wireLocalModels("ANSWER: 7", "ANSWER: 42");

    const out = await delegate({ prompt: "what is the value?", frontierModelId: "anthropic/claude-sonnet-4-6" });

    expect(out.escalate).toBe(false); // shadow does not change routing
    expect(out.gate).toMatchObject({ mode: "shadow", wouldEscalate: true });
    expect(lmInferenceMock).toHaveBeenCalledTimes(2); // second model DID run (to record the signal)
    expect(frontierMock).not.toHaveBeenCalled(); // but no escalation happened
    const rec = recordDelegationMock.mock.calls[0]![0] as {
      escalated: boolean;
      notes: string;
      gateMode: string | null;
      gateWouldEscalate: boolean | null;
    };
    expect(rec.escalated).toBe(false);
    expect(rec.notes).toContain("gate(shadow):");
    expect(rec.notes).toContain("disagree=1");
    // shadow is inert on routing (escalated stays false) but the structured columns still record
    // the would-escalate signal — that's the whole point of #91 (queryable without notes-regex).
    expect(rec.gateMode).toBe("shadow");
    expect(rec.gateWouldEscalate).toBe(true);
  });

  it("gate=on + agreeing secondary → kept local, no frontier call", async () => {
    setConfig({ disagreementGate: "on" });
    wireLocalModels("ANSWER: 42", "the answer is ANSWER: 42.0"); // numeric-equal → score 0

    const out = await delegate({ prompt: "what is the value?", frontierModelId: "anthropic/claude-sonnet-4-6" });

    expect(out.escalate).toBe(false);
    expect(out.gate).toMatchObject({ wouldEscalate: false });
    expect(out.gate?.score).toBe(0);
    expect(frontierMock).not.toHaveBeenCalled();
  });

  it("gate=on but a verifier produced a verdict → gate NEVER runs (only one local call)", async () => {
    setConfig({ disagreementGate: "on" });
    wireLocalModels("ANSWER: 7", "ANSWER: 42");

    const out = await delegate({
      prompt: "what is the value?",
      verifier: async () => ({ outcome: "pass", score: 1 }),
      verifierName: "test-pass",
    });

    expect(out.outcome).toBe("pass");
    expect(out.gate).toBeUndefined();
    expect(lmInferenceMock).toHaveBeenCalledTimes(1); // primary only; no second model
    const rec = recordDelegationMock.mock.calls[0]![0] as { gateMode: string | null };
    expect(rec.gateMode).toBeNull(); // no gate activity → structured columns stay NULL
  });

  it("gate=off (default) → no second local call, behaviour-preserving", async () => {
    setConfig({ disagreementGate: "off" });
    wireLocalModels("ANSWER: 7", "ANSWER: 42");

    const out = await delegate({ prompt: "what is the value?" });

    expect(out.gate).toBeUndefined();
    expect(out.escalate).toBe(false);
    expect(lmInferenceMock).toHaveBeenCalledTimes(1);
  });

  it("gate=on + secondary OVER-RUNS the timeout → normalized to a timeout error, no escalation (Codex #1)", async () => {
    // callTimeoutMs is small; the secondary mock ignores the abort signal and resolves LATE with a
    // valid-looking (but over-budget / possibly-truncated) answer. The gate must discard it.
    setConfig({ disagreementGate: "on", callTimeoutMs: 20 });
    lmInferenceMock.mockImplementation(async (modelId: string) => {
      if (modelId === "mellum") return lmOk("ANSWER: 7");
      await new Promise((r) => setTimeout(r, 80)); // exceed the 20ms timeout
      return lmOk("ANSWER: 42"); // would have disagreed — must NOT drive the gate
    });

    const out = await delegate({ prompt: "what is the value?", frontierModelId: "anthropic/claude-sonnet-4-6" });

    expect(out.escalate).toBe(false);
    expect(out.gate).toMatchObject({ wouldEscalate: false, secondaryError: "__hs_timeout__" });
    expect(frontierMock).not.toHaveBeenCalled();
  });

  it("gate=on + secondary inference fails → keep local, record the gate error (never escalate on a flaky secondary)", async () => {
    setConfig({ disagreementGate: "on" });
    lmInferenceMock.mockImplementation(async (modelId: string) =>
      modelId === "mellum" ? lmOk("ANSWER: 7") : { ok: false as const, error: "fetch failed" }
    );

    const out = await delegate({ prompt: "what is the value?", frontierModelId: "anthropic/claude-sonnet-4-6" });

    expect(out.escalate).toBe(false);
    expect(out.gate).toMatchObject({ wouldEscalate: false, secondaryError: "fetch failed" });
    expect(frontierMock).not.toHaveBeenCalled();
    const rec = recordDelegationMock.mock.calls[0]![0] as {
      notes: string;
      gateMode: string | null;
      gateError: string | null;
      gateWouldEscalate: boolean | null;
    };
    expect(rec.notes).toContain("error=fetch failed");
    expect(rec.gateMode).toBe("on");
    expect(rec.gateError).toBe("fetch failed");
    expect(rec.gateWouldEscalate).toBe(false);
  });
});
