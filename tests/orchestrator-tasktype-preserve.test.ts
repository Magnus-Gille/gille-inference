/**
 * Issue #155 — an explicit caller-supplied taskType must be preserved verbatim in the ledger
 * row, instead of being flattened to the classifier's guess (often "other").
 *
 * Background: ratatoskr#31 sends production triage traffic through POST /delegate with
 * taskType:"triage". Because "triage" was absent from the vocabulary, delegateImpl() flattened it
 * to classifyTask(prompt).taskType — i.e. "other" — so the first production workload could never
 * earn its own routing verdict. The fix is two-fold: (1) add triage to the vocabulary; (2) honor
 * ANY non-blank explicit taskType verbatim (domain knowledge the classifier lacks), falling back
 * to the classifier ONLY when the field is absent/blank.
 *
 * Split in two:
 *   - resolveTaskType(): the pure boundary function (no mocks) — the heart of the ticket.
 *   - delegate():        the value actually survives into the recorded ledger row (mocked leaf).
 *
 * Written BEFORE the implementation (red→green).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// ── mocks: inference clients, the loaded-model resolver, and the DB-touching ledger ──
// (taxonomy is intentionally NOT mocked — the "absent taskType" case must exercise the real
//  keyword classifier, which is the no-regression guarantee.)
const lmInferenceMock = vi.fn();
vi.mock("../src/runner/lmstudio-client.js", () => ({
  runLmStudioInference: (modelId: string, prompt: string, opts: unknown) =>
    lmInferenceMock(modelId, prompt, opts),
}));

vi.mock("../src/runner/openrouter-client.js", () => ({
  runInference: vi.fn(),
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

let resolveTaskType: typeof import("../src/homeserver/orchestrator.js").resolveTaskType;
let delegate: typeof import("../src/homeserver/orchestrator.js").delegate;
let setConfig: typeof import("../src/homeserver/config.js").setConfig;
let resetConfig: typeof import("../src/homeserver/config.js").resetConfig;
let classifyTask: typeof import("../src/homeserver/taxonomy.js").classifyTask;

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
  const tax = await import("../src/homeserver/taxonomy.js");
  resolveTaskType = orch.resolveTaskType;
  delegate = orch.delegate;
  setConfig = cfg.setConfig;
  resetConfig = cfg.resetConfig;
  classifyTask = tax.classifyTask;
  resetConfig();
  // Pin the routing/gate flags OFF so env can't perturb the plain delegate path, and silence logs.
  setConfig({ useRoutingTable: "off", disagreementGate: "off", accessLog: "off", delegationCostLog: "off" });
  lmInferenceMock.mockResolvedValue(lmOk("LOCAL ANSWER"));
});

// ── The pure boundary (issue #155's heart) ────────────────────────────────────────

describe("resolveTaskType — explicit vs classifier boundary", () => {
  it("preserves a known explicit taskType verbatim (triage)", () => {
    expect(resolveTaskType({ taskType: "triage", prompt: "irrelevant" })).toBe("triage");
  });

  it("preserves an UNKNOWN explicit taskType verbatim (does NOT flatten to 'other')", () => {
    // A caller asserting a bucket the classifier cannot derive is domain knowledge — honor it.
    expect(resolveTaskType({ taskType: "ratatoskr-custom", prompt: "Summarize this report." })).toBe(
      "ratatoskr-custom"
    );
  });

  it("trims surrounding whitespace on an explicit taskType (same bucket as untrimmed)", () => {
    expect(resolveTaskType({ taskType: "  triage  ", prompt: "irrelevant" })).toBe("triage");
  });

  it("falls back to the keyword classifier when taskType is absent", () => {
    const prompt = "Summarize this report.";
    expect(resolveTaskType({ prompt })).toBe(classifyTask(prompt).taskType);
  });

  it("falls back to the keyword classifier when taskType is blank/whitespace", () => {
    const prompt = "Summarize this report.";
    expect(resolveTaskType({ taskType: "", prompt })).toBe(classifyTask(prompt).taskType);
    expect(resolveTaskType({ taskType: "   ", prompt })).toBe(classifyTask(prompt).taskType);
  });
});

// ── The value survives into the recorded ledger row ───────────────────────────────

describe("delegate() — explicit taskType survives into the ledger row", () => {
  it("threads caller sampler controls to the local inference client", async () => {
    await delegate({
      prompt: "Solve it",
      modelId: "mellum",
      temperature: 1,
      topP: 0.95,
      topK: 0,
      minP: 0,
    });
    expect(lmInferenceMock).toHaveBeenCalledTimes(1);
    expect(lmInferenceMock.mock.calls[0]![2]).toMatchObject({
      temperature: 1,
      topP: 0.95,
      topK: 0,
      minP: 0,
    });
  });

  it("applies the VibeThinker sampler profile when the caller omits controls", async () => {
    await delegate({ prompt: "Solve it", modelId: "vibethinker-3b" });
    expect(lmInferenceMock.mock.calls[0]![2]).toMatchObject({
      temperature: 1,
      topP: 0.95,
      topK: 0,
      minP: 0,
    });
  });

  it("records an explicit triage taskType verbatim (not flattened to 'other')", async () => {
    const out = await delegate({ taskType: "triage", prompt: "Should ratatoskr answer or clarify?" });

    expect(out.taskType).toBe("triage");
    expect(recordDelegationMock).toHaveBeenCalledTimes(1);
    const rec = recordDelegationMock.mock.calls[0]![0] as { taskType: string };
    expect(rec.taskType).toBe("triage");
  });

  it("records an UNKNOWN explicit taskType verbatim (the general policy)", async () => {
    const out = await delegate({ taskType: "novel-brain", prompt: "Summarize this report." });

    expect(out.taskType).toBe("novel-brain");
    const rec = recordDelegationMock.mock.calls[0]![0] as { taskType: string };
    expect(rec.taskType).toBe("novel-brain");
  });

  it("NO REGRESSION: an absent taskType still resolves via the classifier", async () => {
    const prompt = "Summarize this report.";
    const out = await delegate({ prompt });

    const expected = classifyTask(prompt).taskType;
    expect(out.taskType).toBe(expected);
    expect(expected).not.toBe("other"); // sanity: this prompt is classifiable
    const rec = recordDelegationMock.mock.calls[0]![0] as { taskType: string };
    expect(rec.taskType).toBe(expected);
  });

  it("forwards the authenticated key alias into the ledger record", async () => {
    await delegate({ taskType: "triage", prompt: "Should ratatoskr answer?", keyAlias: "codex-cli" });

    const rec = recordDelegationMock.mock.calls[0]![0] as { keyAlias: string };
    expect(rec.keyAlias).toBe("codex-cli");
  });
});
