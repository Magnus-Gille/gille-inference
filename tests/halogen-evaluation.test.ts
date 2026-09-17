import { describe, expect, it, vi } from "vitest";

import {
  runHalogenCompatibilityEvaluation,
  type HalogenEvaluationOperations,
} from "../src/homeserver/halogen-evaluation.js";
import type {
  MaintenanceWindowClientEvidence,
  MaintenanceWindowOpeningEvidence,
} from "../src/homeserver/maintenance-window-client.js";

const VALID_RESULT = {
  schemaVersion: 1,
  gate: "synthetic-compatibility-only",
  pass: true,
  rows: Array.from({ length: 5 }, () => ({ pass: true })),
};

const READY_RESIDENT: MaintenanceWindowOpeningEvidence["runningModels"] = [
  { model: "prior-model", state: "ready", ttlSeconds: 900 },
];

const WINDOW_EVIDENCE: MaintenanceWindowOpeningEvidence = {
  mode: "exclusive",
  startedAt: "2026-09-15T10:00:00.000Z",
  expiresAt: "2026-09-15T11:00:00.000Z",
  runningModels: READY_RESIDENT,
};

function makeOperations(options: {
  events?: string[];
  failAt?: string;
  failure?: Error;
  result?: unknown;
  abortController?: AbortController;
} = {}): HalogenEvaluationOperations {
  const events = options.events ?? [];
  const failure = options.failure ?? new Error(`failure at ${options.failAt ?? "operation"}`);
  const step = (name: string) => vi.fn(async () => {
    events.push(name);
    if (options.failAt === name) throw failure;
  });

  return {
    preflight: step("preflight"),
    stopPriorExperiment: step("stopPriorExperiment"),
    quiesceSwap: step("quiesceSwap"),
    assertHeadroom: step("assertHeadroom"),
    startCandidate: step("startCandidate"),
    verifyContainment: step("verifyContainment"),
    waitForReady: vi.fn(async (_signal: AbortSignal) => {
      events.push("waitForReady");
      if (options.abortController !== undefined) options.abortController.abort(new Error("test abort"));
      if (options.failAt === "waitForReady") throw failure;
    }),
    compatibility: vi.fn(async (_signal: AbortSignal) => {
      events.push("compatibility");
      if (options.failAt === "compatibility") throw failure;
      return options.result !== undefined ? options.result : VALID_RESULT;
    }),
    ensureCandidateStopped: step("ensureCandidateStopped"),
    assertSafeToRestore: step("assertSafeToRestore"),
    restorePriorExperiment: step("restorePriorExperiment"),
    restoreSwap: vi.fn(async (_residents: MaintenanceWindowOpeningEvidence["runningModels"]) => {
      events.push("restoreSwap");
      if (options.failAt === "restoreSwap") throw failure;
    }),
    verifyRestoration: step("verifyRestoration"),
  };
}

const TAILNET_URL = "http://198.51.100.23:8080";
const LOCAL_ADDRESSES = ["127.0.0.1", "::1", "198.51.100.23"];

function mockFetchGateway(status: { ok: boolean; status: number; body: unknown } | Error) {
  return vi.fn(async () => {
    if (status instanceof Error) throw status;
    return { ok: status.ok, status: status.status, json: async () => status.body };
  });
}

async function invokeEvaluation(options: {
  operations: HalogenEvaluationOperations;
  residents?: MaintenanceWindowOpeningEvidence["runningModels"];
  expectedResidentModels?: string[];
  approvedExpiresAt?: string;
  signal?: AbortSignal;
  gatewayBaseUrl?: unknown;
  fetch?: typeof fetch;
  gatewayStatus?: { ok: boolean; status: number; body: unknown } | Error;
  localAddresses?: string[];
}): Promise<{
  result?: unknown;
  error?: unknown;
  runWindowCalls: number;
  planBaseUrl?: unknown;
  canReleaseAtEnd: boolean | undefined;
}> {
  let canReleaseAtEnd: boolean | undefined;
  let runWindowCalls = 0;
  let planBaseUrl: unknown;
  const runWindow = vi.fn(async (
    plan: { command: string[]; baseUrl: string },
    deps: {
      runChild: (
        command: string[],
        opened: MaintenanceWindowOpeningEvidence,
        signal: AbortSignal,
      ) => Promise<number>;
      canReleaseWindow?: () => boolean;
    },
  ): Promise<MaintenanceWindowClientEvidence> => {
    runWindowCalls += 1;
    planBaseUrl = plan.baseUrl;
    expect(plan.command).toEqual(["halogen-synthetic-compatibility"]);
    try {
      const childSignal = new AbortController().signal;
      const childExitCode = await deps.runChild(
        plan.command,
        { ...WINDOW_EVIDENCE, runningModels: options.residents ?? READY_RESIDENT },
        childSignal,
      );
      return {
        mode: "exclusive",
        startedAt: WINDOW_EVIDENCE.startedAt,
        endedAt: WINDOW_EVIDENCE.startedAt,
        childExitCode,
        restored: true,
        runningModels: options.residents ?? READY_RESIDENT,
      };
    } finally {
      canReleaseAtEnd = deps.canReleaseWindow?.();
    }
  });

  try {
    const result = await runHalogenCompatibilityEvaluation({
      operations: options.operations,
      apiKey: "test-maintenance-key",
      expectedResidentModels: options.expectedResidentModels ?? ["prior-model"],
      approvedExpiresAt: options.approvedExpiresAt ?? "2026-09-15T12:00:00.000Z",
      signal: options.signal,
      gatewayBaseUrl: (options.gatewayBaseUrl ?? TAILNET_URL) as string,
      localAddresses: options.localAddresses ?? LOCAL_ADDRESSES,
      fetch: (options.fetch ??
        mockFetchGateway(
          options.gatewayStatus ?? { ok: true, status: 200, body: { active: false, evidence: null } },
        )) as unknown as typeof fetch,
      runWindow,
    });
    return { result, runWindowCalls, planBaseUrl, canReleaseAtEnd };
  } catch (error) {
    return { error, runWindowCalls, planBaseUrl, canReleaseAtEnd };
  }
}

describe("Halogen compatibility evaluation", () => {
  it("runs the successful path in mutation order and restores after verified shutdown", async () => {
    const events: string[] = [];
    const outcome = await invokeEvaluation({ operations: makeOperations({ events }) });

    expect(outcome.error).toBeUndefined();
    expect(outcome.result).toEqual(VALID_RESULT);
    expect(events).toEqual([
      "preflight",
      "stopPriorExperiment",
      "quiesceSwap",
      "assertHeadroom",
      "startCandidate",
      "verifyContainment",
      "waitForReady",
      "compatibility",
      "ensureCandidateStopped",
      "assertSafeToRestore",
      "restorePriorExperiment",
      "restoreSwap",
      "verifyRestoration",
    ]);
    expect(outcome.canReleaseAtEnd).toBe(true);
  });

  it.each([
    { failAt: "stopPriorExperiment", cleanup: ["assertSafeToRestore", "restorePriorExperiment", "verifyRestoration"] },
    { failAt: "quiesceSwap", cleanup: ["assertSafeToRestore", "restorePriorExperiment", "restoreSwap", "verifyRestoration"] },
    { failAt: "assertHeadroom", cleanup: ["assertSafeToRestore", "restorePriorExperiment", "restoreSwap", "verifyRestoration"] },
    { failAt: "startCandidate", cleanup: ["ensureCandidateStopped", "assertSafeToRestore", "restorePriorExperiment", "restoreSwap", "verifyRestoration"] },
    { failAt: "verifyContainment", cleanup: ["ensureCandidateStopped", "assertSafeToRestore", "restorePriorExperiment", "restoreSwap", "verifyRestoration"] },
    { failAt: "waitForReady", cleanup: ["ensureCandidateStopped", "assertSafeToRestore", "restorePriorExperiment", "restoreSwap", "verifyRestoration"] },
    { failAt: "compatibility", cleanup: ["ensureCandidateStopped", "assertSafeToRestore", "restorePriorExperiment", "restoreSwap", "verifyRestoration"] },
  ])("cleans up after a failure at $failAt", async ({ failAt, cleanup }) => {
    const events: string[] = [];
    const failure = new Error(`work failed at ${failAt}`);
    const outcome = await invokeEvaluation({
      operations: makeOperations({ events, failAt, failure }),
    });

    expect(outcome.error).toBe(failure);
    expect(events.slice(-cleanup.length)).toEqual(cleanup);
    expect(outcome.canReleaseAtEnd).toBe(true);
  });

  it("does not restore GPU residents or release the window after candidate shutdown fails", async () => {
    const events: string[] = [];
    const shutdownFailure = new Error("candidate shutdown was not verified");
    const outcome = await invokeEvaluation({
      operations: makeOperations({
        events,
        failAt: "ensureCandidateStopped",
        failure: shutdownFailure,
      }),
    });

    expect(outcome.error).toBeInstanceOf(AggregateError);
    expect(events).toEqual([
      "preflight",
      "stopPriorExperiment",
      "quiesceSwap",
      "assertHeadroom",
      "startCandidate",
      "verifyContainment",
      "waitForReady",
      "compatibility",
      "ensureCandidateStopped",
    ]);
    expect(outcome.canReleaseAtEnd).toBe(false);
    expect(events).not.toContain("restorePriorExperiment");
    expect(events).not.toContain("restoreSwap");
    expect(events).not.toContain("verifyRestoration");
  });

  it("skips both GPU restores and retains the window when post-shutdown safety fails", async () => {
    const events: string[] = [];
    const safetyFailure = new Error("protected service or OOM invariant failed");
    const outcome = await invokeEvaluation({
      operations: makeOperations({ events, failAt: "assertSafeToRestore", failure: safetyFailure }),
    });

    expect(outcome.error).toBeInstanceOf(AggregateError);
    expect(events.slice(-2)).toEqual(["ensureCandidateStopped", "assertSafeToRestore"]);
    expect(events).not.toContain("restorePriorExperiment");
    expect(events).not.toContain("restoreSwap");
    expect(events).not.toContain("verifyRestoration");
    expect(outcome.canReleaseAtEnd).toBe(false);
  });

  it.each(["restorePriorExperiment", "restoreSwap", "verifyRestoration"])(
    "marks the window non-releasable when %s fails",
    async (failAt) => {
      const events: string[] = [];
      const restoreFailure = new Error(`restore failed at ${failAt}`);
      const outcome = await invokeEvaluation({
        operations: makeOperations({ events, failAt, failure: restoreFailure }),
      });

      expect(outcome.error).toBeInstanceOf(AggregateError);
      expect(outcome.canReleaseAtEnd).toBe(false);
      expect(events).toContain("ensureCandidateStopped");
      expect(events).toContain("assertSafeToRestore");
      expect(events).toContain("restorePriorExperiment");
      if (failAt === "restorePriorExperiment") expect(events).not.toContain("restoreSwap");
      else expect(events).toContain("restoreSwap");
      expect(events).toContain("verifyRestoration");
    },
  );

  it("fails before opening a window when preflight fails", async () => {
    const events: string[] = [];
    const preflightFailure = new Error("preflight rejected candidate");
    const operations = makeOperations({ events, failAt: "preflight", failure: preflightFailure });
    const outcome = await invokeEvaluation({ operations });

    expect(outcome.error).toBe(preflightFailure);
    expect(outcome.runWindowCalls).toBe(0);
    expect(events).toEqual(["preflight"]);
  });

  it("rejects ambiguous residents before any runtime mutation", async () => {
    const events: string[] = [];
    const outcome = await invokeEvaluation({
      operations: makeOperations({ events }),
      residents: [
        { model: "one", state: "ready", ttlSeconds: 100 },
        { model: "two", state: "ready", ttlSeconds: 100 },
      ],
    });

    expect(outcome.error).toMatchObject({ message: expect.stringContaining("ambiguous prior swap residency") });
    expect(events).toEqual(["preflight"]);
    expect(outcome.canReleaseAtEnd).toBe(true);
  });

  it("rejects non-ready residents before any runtime mutation", async () => {
    const events: string[] = [];
    const outcome = await invokeEvaluation({
      operations: makeOperations({ events }),
      residents: [{ model: "candidate", state: "loading", ttlSeconds: 100 }],
    });

    expect(outcome.error).toMatchObject({ message: expect.stringContaining("ambiguous prior swap residency") });
    expect(events).toEqual(["preflight"]);
  });

  it("aborts during readiness and still performs verified cleanup", async () => {
    const events: string[] = [];
    const controller = new AbortController();
    const outcome = await invokeEvaluation({
      operations: makeOperations({ events, abortController: controller }),
      signal: controller.signal,
    });

    expect(outcome.error).toBeDefined();
    expect(events).toContain("waitForReady");
    expect(events.slice(-5)).toEqual([
      "ensureCandidateStopped",
      "assertSafeToRestore",
      "restorePriorExperiment",
      "restoreSwap",
      "verifyRestoration",
    ]);
    expect(outcome.canReleaseAtEnd).toBe(true);
  });

  it("preserves the compatibility work error after successful cleanup", async () => {
    const events: string[] = [];
    const workFailure = new Error("compatibility command failed");
    const outcome = await invokeEvaluation({
      operations: makeOperations({ events, failAt: "compatibility", failure: workFailure }),
    });

    expect(outcome.error).toBe(workFailure);
    expect(events.slice(-5)).toEqual([
      "ensureCandidateStopped",
      "assertSafeToRestore",
      "restorePriorExperiment",
      "restoreSwap",
      "verifyRestoration",
    ]);
  });

  it.each([
    { name: "false pass", result: { ...VALID_RESULT, pass: false } },
    { name: "malformed result", result: { schemaVersion: 1, gate: "synthetic-compatibility-only", pass: true, rows: [] } },
    { name: "null result", result: null },
  ])("rejects a %s result and still cleans up", async ({ result }) => {
    const events: string[] = [];
    const outcome = await invokeEvaluation({
      operations: makeOperations({ events, result }),
    });

    expect(outcome.error).toBeDefined();
    expect(outcome.error).toBeInstanceOf(Error);
    expect(events.slice(-5)).toEqual([
      "ensureCandidateStopped",
      "assertSafeToRestore",
      "restorePriorExperiment",
      "restoreSwap",
      "verifyRestoration",
    ]);
    expect(outcome.canReleaseAtEnd).toBe(true);
  });
});

it('stops further GPU reloads after prior-experiment restoration fails', async () => {
  const operations = makeOperations({ failAt: 'restorePriorExperiment' });
  const outcome = await invokeEvaluation({ operations });
  expect(outcome.canReleaseAtEnd).toBe(false);
  expect(operations.restoreSwap).not.toHaveBeenCalled();
});

it('rejects a resident that differs from the approved plan without mutation', async () => {
  const operations = makeOperations();
  const outcome = await invokeEvaluation({ operations, residents: [{ model: 'other-model', state: 'ready', ttlSeconds: 900 }] });
  expect(outcome.error).toBeInstanceOf(Error);
  expect(outcome.canReleaseAtEnd).toBe(true);
  expect(operations.stopPriorExperiment).not.toHaveBeenCalled();
});
it('accepts an explicitly approved empty resident set', async () => {
  const outcome = await invokeEvaluation({ operations: makeOperations(), residents: [], expectedResidentModels: [] });
  expect(outcome.error).toBeUndefined();
  expect(outcome.canReleaseAtEnd).toBe(true);
});

it('releases an overlong server window before any runtime mutation', async () => {
  const operations = makeOperations();
  const outcome = await invokeEvaluation({ operations, approvedExpiresAt: '2026-09-15T10:30:00.000Z' });
  expect(outcome.error).toBeInstanceOf(Error);
  expect(outcome.canReleaseAtEnd).toBe(true);
  expect(operations.stopPriorExperiment).not.toHaveBeenCalled();
});

describe('Halogen gateway address (#323)', () => {
  it('passes the approved gateway address to the window instead of loopback', async () => {
    const events: string[] = [];
    const outcome = await invokeEvaluation({ operations: makeOperations({ events }) });
    expect(outcome.error).toBeUndefined();
    expect(outcome.runWindowCalls).toBe(1);
    expect(outcome.planBaseUrl).toBe(TAILNET_URL);
  });

  it.each([
    { name: 'path', url: 'http://127.0.0.1:8080/admin' },
    { name: 'credentials', url: 'http://user:pass@127.0.0.1:8080' },
    { name: 'missing scheme', url: '127.0.0.1:8080' },
    { name: 'missing port', url: 'http://127.0.0.1' },
    { name: 'https', url: 'https://127.0.0.1:8080' },
    { name: 'empty', url: '' },
  ])('rejects a gateway URL with $name before any window or operation', async ({ url }) => {
    const events: string[] = [];
    const outcome = await invokeEvaluation({ operations: makeOperations({ events }), gatewayBaseUrl: url });
    expect(outcome.error).toBeInstanceOf(Error);
    expect(outcome.runWindowCalls).toBe(0);
    expect(events).toEqual([]);
  });

  it('rejects a non-local gateway host without sending the credential anywhere', async () => {
    const events: string[] = [];
    const fetch = mockFetchGateway({ ok: true, status: 200, body: { active: false } });
    const outcome = await invokeEvaluation({
      operations: makeOperations({ events }),
      gatewayBaseUrl: 'http://203.0.113.7:8080',
      fetch: fetch as unknown as typeof window.fetch,
    });
    expect(outcome.error).toBeInstanceOf(Error);
    expect(String((outcome.error as Error).message)).toMatch(/local|203\.0\.113\.7/);
    expect(fetch).not.toHaveBeenCalled();
    expect(outcome.runWindowCalls).toBe(0);
    expect(events).toEqual([]);
  });

  it('fails closed naming the URL when the gateway is unreachable', async () => {
    const events: string[] = [];
    const outcome = await invokeEvaluation({
      operations: makeOperations({ events }),
      gatewayStatus: new Error('connect ECONNREFUSED 198.51.100.23:8080'),
    });
    expect(outcome.error).toBeInstanceOf(Error);
    expect(String((outcome.error as Error).message)).toMatch(/198\.51\.100\.23:8080/);
    expect(outcome.runWindowCalls).toBe(0);
    expect(events).toEqual([]);
  });

  it('refuses to open when a window is already active', async () => {
    const events: string[] = [];
    const outcome = await invokeEvaluation({
      operations: makeOperations({ events }),
      gatewayStatus: { ok: true, status: 200, body: { active: true, evidence: null } },
    });
    expect(outcome.error).toBeInstanceOf(Error);
    expect(String((outcome.error as Error).message)).toMatch(/active|already/i);
    expect(outcome.runWindowCalls).toBe(0);
    expect(events).toEqual([]);
  });

  it('rejects a bad credential before any mutation', async () => {
    const events: string[] = [];
    const outcome = await invokeEvaluation({
      operations: makeOperations({ events }),
      gatewayStatus: { ok: false, status: 401, body: { error: { message: 'invalid_api_key' } } },
    });
    expect(outcome.error).toBeInstanceOf(Error);
    expect(String((outcome.error as Error).message)).toMatch(/401/);
    expect(outcome.runWindowCalls).toBe(0);
    expect(events).toEqual([]);
  });

  it('rejects a malformed window status before any mutation', async () => {
    const events: string[] = [];
    const outcome = await invokeEvaluation({
      operations: makeOperations({ events }),
      gatewayStatus: { ok: true, status: 200, body: { active: 'sometime' } },
    });
    expect(outcome.error).toBeInstanceOf(Error);
    expect(String((outcome.error as Error).message)).toMatch(/malformed/);
    expect(outcome.runWindowCalls).toBe(0);
    expect(events).toEqual([]);
  });
});
