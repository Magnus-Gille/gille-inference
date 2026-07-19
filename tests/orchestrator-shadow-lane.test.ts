/**
 * Wiring of the shadow lane (#234) into orchestrator.delegate().
 *
 * The pure policy lives in tests/shadow-lane.test.ts. Here we drive the real delegate() loop with
 * mocked inference clients + ledger and assert the FOUR properties the issue makes non-negotiable:
 *
 *   1. the caller's escalated response is IDENTICAL with the shadow lane on and off (never delayed,
 *      never altered — the shadow fires after the response is built, fire-and-forget);
 *   2. a shadow row IS recorded, flagged shadow, on a leaf the router escalated with zero local attempt;
 *   3. a NON-EMPTY delegate queue skips the shadow entirely (real traffic always wins the GPU);
 *   4. the lane is OFF by default — no second model call, no extra ledger row.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

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
}));

let delegate: typeof import("../src/homeserver/orchestrator.js").delegate;
let setConfig: typeof import("../src/homeserver/config.js").setConfig;
let resetConfig: typeof import("../src/homeserver/config.js").resetConfig;
let shadowLaneIdle: typeof import("../src/homeserver/shadow-lane.js").shadowLaneIdle;
let resetShadowLane: typeof import("../src/homeserver/shadow-lane.js").resetShadowLane;
let loadRoutingTable: typeof import("../src/homeserver/routing-table.js").loadRoutingTable;

/** A task type the adopted routing table sends straight to frontier — the #234 absorbing state. */
let GAP_TYPE: string;

const SHADOW_MODEL = "qwen3-coder-next-80b";

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

/** Ledger rows the shadow lane wrote (shadow === true). */
function shadowRows(): Array<Record<string, unknown>> {
  return recordDelegationMock.mock.calls
    .map((c) => c[0] as unknown as Record<string, unknown>)
    .filter((r) => r["shadow"] === true);
}

beforeEach(async () => {
  vi.clearAllMocks();
  const orch = await import("../src/homeserver/orchestrator.js");
  const cfg = await import("../src/homeserver/config.js");
  const shadow = await import("../src/homeserver/shadow-lane.js");
  const rt = await import("../src/homeserver/routing-table.js");
  delegate = orch.delegate;
  setConfig = cfg.setConfig;
  resetConfig = cfg.resetConfig;
  shadowLaneIdle = shadow.shadowLaneIdle;
  resetShadowLane = shadow.resetShadowLane;
  loadRoutingTable = rt.loadRoutingTable;
  GAP_TYPE = loadRoutingTable().escalateToFrontier[0]!;
  resetConfig();
  resetShadowLane();
  frontierMock.mockResolvedValue({ ok: true, response: "FRONTIER ANSWER: the bug is an off-by-one" });
  lmInferenceMock.mockResolvedValue(lmOk("LOCAL ANSWER: the bug is an off-by-one"));
});

function shadowOn(extra: Record<string, unknown> = {}) {
  setConfig({
    useRoutingTable: "on",
    shadowLane: {
      mode: "on",
      model: SHADOW_MODEL,
      taskTypes: [],
      maxTokens: 2048,
      timeoutMs: 60_000,
      agreementThreshold: 0.7,
      ...extra,
    },
  });
}

const escalatedTask = () => ({
  taskType: GAP_TYPE,
  prompt: "review this diff",
  frontierModelId: "anthropic/claude-sonnet-5",
});

describe("shadow lane — the caller's response is untouched", () => {
  it("the escalated response is byte-identical with the shadow lane ON and OFF", async () => {
    setConfig({ useRoutingTable: "on", shadowLane: { mode: "off", model: SHADOW_MODEL, taskTypes: [], maxTokens: 2048, timeoutMs: 60_000, agreementThreshold: 0.7 } });
    const off = await delegate(escalatedTask());
    const frontierCallsOff = frontierMock.mock.calls.length;
    await shadowLaneIdle();

    vi.clearAllMocks();
    frontierMock.mockResolvedValue({ ok: true, response: "FRONTIER ANSWER: the bug is an off-by-one" });
    lmInferenceMock.mockResolvedValue(lmOk("LOCAL ANSWER: the bug is an off-by-one"));
    resetConfig();
    shadowOn();
    const on = await delegate(escalatedTask());
    // The frontier call the CALLER depends on is made exactly once either way, with the same args.
    expect(frontierMock.mock.calls.length).toBe(frontierCallsOff);
    await shadowLaneIdle();

    // costTrace carries fresh uuids/timestamps — everything the caller reads is compared.
    const strip = (o: Record<string, unknown>) => {
      const { costTrace: _c, ...rest } = o;
      return rest;
    };
    expect(strip(on as unknown as Record<string, unknown>)).toEqual(
      strip(off as unknown as Record<string, unknown>)
    );
    expect(on.output).toBeUndefined(); // the shadow output NEVER reaches the caller
    expect(on.frontierOutput).toBe("FRONTIER ANSWER: the bug is an off-by-one");
  });
});

describe("shadow lane — evidence on an escalated leaf", () => {
  it("records a ledger row FLAGGED shadow, graded against the frontier answer", async () => {
    shadowOn();
    const out = await delegate(escalatedTask());
    expect(out.delegated).toBe(false); // the router escalated with zero local attempt
    await shadowLaneIdle();

    // The shadow ran the configured candidate on the caller's prompt.
    expect(lmInferenceMock).toHaveBeenCalledTimes(1);
    expect(lmInferenceMock.mock.calls[0]![0]).toBe(SHADOW_MODEL);

    const rows = shadowRows();
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    expect(row["taskType"]).toBe(GAP_TYPE);
    expect(row["modelId"]).toBe(SHADOW_MODEL);
    expect(row["source"]).toBe("shadow");
    // Local and frontier said the same thing → graded a pass against the frontier reference.
    expect(row["outcome"]).toBe("pass");
    expect(row["escalated"]).toBe(true);
  });

  it("a shadow answer that DISAGREES with the frontier is recorded as a fail (not silently dropped)", async () => {
    shadowOn();
    lmInferenceMock.mockResolvedValue(lmOk("No issues found."));
    await delegate(escalatedTask());
    await shadowLaneIdle();
    const rows = shadowRows();
    expect(rows.length).toBe(1);
    expect(rows[0]!["outcome"]).toBe("fail");
  });

  it("a shadow model ERROR is recorded as an error row, never thrown at the caller", async () => {
    shadowOn();
    lmInferenceMock.mockResolvedValue({ ok: false, error: "fetch failed" });
    const out = await delegate(escalatedTask());
    expect(out.escalate).toBe(true);
    expect(out.frontierOutput).toBeDefined(); // caller unaffected
    await shadowLaneIdle();
    const rows = shadowRows();
    expect(rows.length).toBe(1);
    expect(rows[0]!["outcome"]).toBe("error");
  });
});

describe("shadow lane — GPU contention", () => {
  it("a NON-EMPTY delegate queue skips the shadow entirely", async () => {
    shadowOn();
    // Hold a real delegation open so the delegate queue is non-empty when the shadow would fire.
    let releaseInflight: (v: unknown) => void = () => {};
    const inflight = new Promise((r) => {
      releaseInflight = r;
    });
    lmInferenceMock.mockImplementation(async (_model: string, prompt: string) => {
      if (prompt === "a slow real request") {
        await inflight;
        return lmOk("done");
      }
      return lmOk("LOCAL ANSWER: the bug is an off-by-one");
    });

    const slow = delegate({ taskType: "summarize", prompt: "a slow real request", modelId: "mellum" });
    const escalated = await delegate(escalatedTask()); // completes while `slow` is still in flight
    expect(escalated.escalate).toBe(true);
    await shadowLaneIdle();

    // The shadow model was never called — only the slow real request touched inference.
    expect(shadowRows()).toEqual([]);
    expect(lmInferenceMock.mock.calls.every((c) => c[0] !== SHADOW_MODEL)).toBe(true);

    releaseInflight(undefined);
    await slow;
    await shadowLaneIdle();
  });
});

describe("shadow lane — default off", () => {
  it("with no shadow config at all, an escalated leaf calls no local model and writes no row", async () => {
    setConfig({ useRoutingTable: "on" });
    const out = await delegate(escalatedTask());
    await shadowLaneIdle();
    expect(out.escalate).toBe(true);
    expect(lmInferenceMock).not.toHaveBeenCalled();
    expect(recordDelegationMock).not.toHaveBeenCalled();
  });
});
