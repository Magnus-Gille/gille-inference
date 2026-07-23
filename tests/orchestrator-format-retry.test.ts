/**
 * Issue #164 — retry-on-transient-parse-error in the local delegate path.
 *
 * gpt-oss-120b uses the OpenAI harmony format; llama.cpp parses assistant turns with a strict PEG
 * grammar and hard-throws HTTP 500 ("…does not match the expected peg-native format") when the model
 * emits bare JSON with no channel markup. The failure is PROVEN non-deterministic on identical
 * requests (5/5 with a strict prompt, 1/8 success with a milder one; plain prompts return 200), so a
 * single retry of the same call recovers the large majority.
 *
 * This is the IMMEDIATE resilience fix (retry once). The robust grammar-constrained prevention is
 * tracked separately (#166) and NOT implemented here.
 *
 * Split in two:
 *   - isTransientFormatError(): the pure signature predicate (no mocks) — the heart of the ticket.
 *   - delegate():              the retry actually recovers / caps at one / never fires on other errors.
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
let isTransientFormatError: typeof import("../src/homeserver/orchestrator.js").isTransientFormatError;
let setConfig: typeof import("../src/homeserver/config.js").setConfig;
let resetConfig: typeof import("../src/homeserver/config.js").resetConfig;

// The real llama.cpp harmony/PEG failure surfaced through runLmStudioInference's error wrapper.
const PEG_ERROR =
  "LM Studio error: 500 status code (no body) Value does not match the expected peg-native format";

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
  isTransientFormatError = orch.isTransientFormatError;
  setConfig = cfg.setConfig;
  resetConfig = cfg.resetConfig;
  resetConfig();
  // Pin routing/gate flags OFF so the plain delegate path is exercised, and silence logs.
  setConfig({ useRoutingTable: "off", disagreementGate: "off", accessLog: "off", delegationCostLog: "off" });
  frontierMock.mockResolvedValue({ ok: true, response: "FRONTIER ANSWER" });
});

// ── The pure predicate (the ticket's testable signature) ──────────────────────────
describe("isTransientFormatError — the format-error signature", () => {
  it("matches the 'does not match the expected … format' phrasing (case-insensitive)", () => {
    expect(isTransientFormatError(PEG_ERROR)).toBe(true);
    expect(isTransientFormatError("Value DOES NOT MATCH the EXPECTED json format")).toBe(true);
  });

  it("matches a bare peg-native / peg_native mention", () => {
    expect(isTransientFormatError("peg-native parse error")).toBe(true);
    expect(isTransientFormatError("PEG_NATIVE validation failed")).toBe(true);
  });

  it("returns false for null/undefined/empty", () => {
    expect(isTransientFormatError(null)).toBe(false);
    expect(isTransientFormatError(undefined)).toBe(false);
    expect(isTransientFormatError("")).toBe(false);
  });

  it("returns false for genuinely different errors (timeout / empty / network)", () => {
    expect(isTransientFormatError("__hs_timeout__")).toBe(false);
    expect(isTransientFormatError("Empty response from LM Studio model")).toBe(false);
    expect(isTransientFormatError("fetch failed")).toBe(false);
  });
});

// ── The retry actually recovers / caps at one / never over-fires ──────────────────
describe("delegate() — retry-on-transient-parse-error (#164)", () => {
  it("fails once with the PEG error then succeeds on retry → returns the successful delegation", async () => {
    lmInferenceMock
      .mockResolvedValueOnce({ ok: false as const, error: PEG_ERROR })
      .mockResolvedValueOnce(lmOk("LOCAL JSON ANSWER"));

    const out = await delegate({ prompt: "output ONLY JSON", frontierModelId: "anthropic/claude-sonnet-4-6" });

    expect(out.delegated).toBe(true);
    expect(out.escalate).toBe(false); // retry recovered → no escalation
    expect(out.output).toBe("LOCAL JSON ANSWER");
    expect(out.formatRetried).toBe(true); // the retry is observable on the outcome
    // exactly one retry: the local model was called twice, no more
    expect(lmInferenceMock).toHaveBeenCalledTimes(2);
    // Each attempt gets its OWN AbortController+timer — the retry must not reuse the first
    // attempt's (already-cleared) signal. Pin that contract so a future refactor can't share one.
    const sig0 = (lmInferenceMock.mock.calls[0]![2] as { signal?: AbortSignal }).signal;
    const sig1 = (lmInferenceMock.mock.calls[1]![2] as { signal?: AbortSignal }).signal;
    expect(sig0).toBeInstanceOf(AbortSignal);
    expect(sig1).toBeInstanceOf(AbortSignal);
    expect(sig0).not.toBe(sig1); // distinct controller per attempt
    expect(sig0!.aborted).toBe(false); // neither timed out
    expect(sig1!.aborted).toBe(false);
    expect(frontierMock).not.toHaveBeenCalled();
    // the recovered delegation is recorded with the retry noted (visible, not silent)
    const rec = recordDelegationMock.mock.calls[0]![0] as { outcome: string; notes: string | null };
    expect(rec.outcome).toBe("unverified");
    expect(rec.notes ?? "").toContain("format-retry");
  });

  it("fails twice with the PEG error → falls through to escalate/record (capped at one retry)", async () => {
    lmInferenceMock.mockResolvedValue({ ok: false as const, error: PEG_ERROR });

    const out = await delegate({ prompt: "output ONLY JSON", frontierModelId: "anthropic/claude-sonnet-4-6" });

    expect(out.delegated).toBe(true);
    expect(out.escalate).toBe(true); // both attempts failed → existing failure path
    expect(out.outcome).toBe("error");
    expect(out.formatRetried).toBe(true);
    // capped: exactly two calls (original + one retry), NOT an infinite loop
    expect(lmInferenceMock).toHaveBeenCalledTimes(2);
    // existing escalation path unchanged: frontier fallback ran
    expect(frontierMock).toHaveBeenCalledTimes(1);
    expect(out.frontierOutput).toBe("FRONTIER ANSWER");
    const rec = recordDelegationMock.mock.calls[0]![0] as {
      outcome: string;
      escalated: boolean;
      errorClass: string;
      notes: string | null;
    };
    expect(rec.outcome).toBe("error");
    expect(rec.escalated).toBe(true);
    expect(rec.errorClass).toBe("parse"); // classified as a parse failure, not generic infra
    expect(rec.notes ?? "").toContain("format-retry");
  });

  it("a genuinely different error (network) is NOT retried — single call, escalates as before", async () => {
    lmInferenceMock.mockResolvedValue({ ok: false as const, error: "fetch failed" });

    const out = await delegate({ prompt: "do the thing", frontierModelId: "anthropic/claude-sonnet-4-6" });

    expect(out.escalate).toBe(true);
    expect(out.formatRetried).toBeFalsy();
    expect(lmInferenceMock).toHaveBeenCalledTimes(1); // no format-retry for a non-format error
    const rec = recordDelegationMock.mock.calls[0]![0] as { errorClass: string; notes: string | null };
    expect(rec.errorClass).toBe("infra");
    expect(rec.notes ?? "").not.toContain("format-retry");
  });

  it("a token-limited local result is explicit, recorded as truncated, and never verified", async () => {
    lmInferenceMock.mockResolvedValue({
      ok: false as const,
      error:
        "LM Studio completion truncated (finish_reason=length, completion_tokens=64, visible_content_chars=3)",
      finishReason: "length",
      truncated: true,
      promptTokens: 20,
      completionTokens: 64,
      durationMs: 900,
      ttftMs: 250,
    });

    const verifier = vi.fn(async () => ({ outcome: "pass" as const, score: 1 }));
    const out = await delegate({
      prompt: "answer exactly F-20",
      verifier,
      verifierName: "exact",
      frontierModelId: "anthropic/claude-sonnet-4-6",
    });

    expect(lmInferenceMock).toHaveBeenCalledTimes(1);
    expect(verifier).not.toHaveBeenCalled();
    expect(out).toMatchObject({
      delegated: true,
      escalate: true,
      outcome: "error",
      finishReason: "length",
      truncated: true,
      frontierOutput: "FRONTIER ANSWER",
    });
    expect(out.output).toBeUndefined();
    const rec = recordDelegationMock.mock.calls[0]![0] as {
      outcome: string;
      escalated: boolean;
      errorClass: string;
      notes: string | null;
      latencyMs: number | null;
      ttftMs: number | null;
      promptTokens: number | null;
      completionTokens: number | null;
    };
    expect(rec).toMatchObject({
      outcome: "error",
      escalated: true,
      errorClass: "truncated",
      latencyMs: 900,
      ttftMs: 250,
      promptTokens: 20,
      completionTokens: 64,
    });
    expect(rec.notes ?? "").toContain("finish_reason=length");
  });

  it("a real per-attempt timeout aborts and never reaches the format-retry branch (single call)", async () => {
    // The per-attempt timer aborts the in-flight call; the late-resolving (over-budget) result is
    // normalized to the timeout sentinel, which is NOT a format error → no retry. This pins that the
    // timeout guard is re-armed per attempt AND that a timeout can't be mistaken for a format-500.
    setConfig({ callTimeoutMs: 20 });
    lmInferenceMock.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 80)); // exceed the 20ms guard
      return lmOk("LATE ANSWER"); // would-be success arrives after the abort — must be discarded
    });

    const out = await delegate({ prompt: "output ONLY JSON", frontierModelId: "anthropic/claude-sonnet-4-6" });

    expect(out.escalate).toBe(true);
    expect(out.outcome).toBe("error");
    expect(out.formatRetried).toBeFalsy(); // a timeout is not a format error → no retry
    expect(lmInferenceMock).toHaveBeenCalledTimes(1); // timed out on the first attempt only
    const rec = recordDelegationMock.mock.calls[0]![0] as { errorClass: string };
    expect(rec.errorClass).toBe("timeout");
  });

  it("a successful first call is never retried (no regression on the happy path)", async () => {
    lmInferenceMock.mockResolvedValue(lmOk("HAPPY ANSWER"));

    const out = await delegate({ prompt: "do the thing" });

    expect(out.output).toBe("HAPPY ANSWER");
    expect(out.escalate).toBe(false);
    expect(out.formatRetried).toBeFalsy();
    expect(lmInferenceMock).toHaveBeenCalledTimes(1);
  });

  it("returns a costTrace with verified savings only after a verifier pass", async () => {
    setConfig({ delegationCostLog: "on" });
    lmInferenceMock.mockResolvedValue(lmOk("VERIFIED ANSWER"));

    const out = await delegate({
      prompt: "bounded task",
      delegatorModelId: "claude-fable-5",
      premiumBaselineModelId: "claude-fable-5",
      verifierName: "test-pass",
      verifier: async () => ({ outcome: "pass", score: 1 }),
    });

    expect(out.outcome).toBe("pass");
    expect(out.costTrace?.costStatus).toBe("verified");
    expect(out.costTrace?.verifiedSavingsActualUsd).toBeGreaterThan(0);
    expect(out.costTrace?.verifiedSavingsPremiumUsd).toBeGreaterThan(0);
  });
});
