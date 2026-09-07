import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb, getDb } from "../src/db.js";
import { ensureLedgerSchema } from "../src/homeserver/ledger.js";
import {
  createLearningTaskCapabilityEpoch,
  type LearningTaskCapabilityEpoch,
} from "../src/homeserver/learning-task-contract.js";
import {
  handleCodeLoopTool,
  type CodeLoopGatewayContext,
} from "../src/homeserver/code-loop-runtime.js";
import {
  getJobResult,
  startCodeLoop,
  _resetCodeLoopStateForTests,
  type CodeLoopStartConfig,
} from "../src/homeserver/code-loop.js";
import * as codeLoopStore from "../src/homeserver/code-loop-store.js";
import type { HomeserverConfig } from "../src/homeserver/config.js";
import type {
  CodeLoopDeps,
  CodeLoopRequest,
  CodeLoopResult,
  EngineRunResult,
} from "../src/homeserver/code-loop-types.js";
import { execCageCommand } from "../src/homeserver/code-loop-cage.js";
import type { ExecutionFeedbackOwner } from "../src/homeserver/execution-feedback.js";
import * as executionFeedback from "../src/homeserver/execution-feedback.js";

// Keep evidence derivation deterministic and independent of a live llama-swap backend.
const servedCmdByModel = new Map<string, string | null>();
vi.mock("../src/homeserver/model-admin.js", () => ({
  getLoaded: async () => [{ key: "qwen3-coder-next-80b" }],
  getRunningCmd: async (modelId: string) => servedCmdByModel.get(modelId) ?? null,
}));

const CAPS = {
  wallSDefault: 480,
  wallSMax: 900,
  turnsDefault: 24,
  turnsMax: 40,
  tokensDefault: 60_000,
  tokensMax: 120_000,
};

let workroot = "";
let capabilityEpoch: LearningTaskCapabilityEpoch;

beforeAll(() => {
  initDb(join(mkdtempSync(join(tmpdir(), "cl-runtime-feedback-db-")), "test.db"));
  ensureLedgerSchema();
});

beforeEach(() => {
  _resetCodeLoopStateForTests();
  workroot = mkdtempSync(join(tmpdir(), "cl-runtime-feedback-work-"));
  capabilityEpoch = createLearningTaskCapabilityEpoch();
  servedCmdByModel.clear();
});

function startConfig(): CodeLoopStartConfig {
  return {
    enabled: true,
    workroot,
    model: "qwen3-coder-next-80b",
    caps: CAPS,
    confinement: "off",
    cage: null,
  };
}

function runtimeConfig(): HomeserverConfig {
  return {
    lmStudioBaseUrl: "http://127.0.0.1:1234/v1",
    gatewayHost: "127.0.0.1",
    gatewayPort: 8080,
    codeLoop: "on",
    codeLoopPiBin: "",
    codeLoopNodeModulesDir: "",
    codeLoopApiKey: "test-only-key",
    codeLoopWorkroot: workroot,
    codeLoopModel: "qwen3-coder-next-80b",
    codeLoopPiAgentDir: "",
    codeLoopConfinement: "off",
    codeLoopForwardPort: 18080,
    codeLoopCaps: CAPS,
  } as unknown as HomeserverConfig;
}

function gatewayContext(owner: ExecutionFeedbackOwner | null): CodeLoopGatewayContext {
  return {
    feedbackOwner: owner,
    authenticatedPrincipalId: owner?.alias ?? "owner-without-feedback",
    authentication: "gateway-owner-auth",
    gatewayRequestId: "opaque:runtime-feedback-test",
    capabilityEpoch,
  };
}

function fakeDeps(owner: ExecutionFeedbackOwner): CodeLoopDeps {
  const engineRun = async (): Promise<EngineRunResult> => ({
    outcome: "completed",
    usage: { turns: 1, wall_ms: 1, prompt_tokens: 1, completion_tokens: 1 },
    finalMessage: "durable runtime result",
    unparseableLines: 0,
    detail: "",
  });
  return {
    engine: { run: async () => engineRun() },
    spawnPi: () => { throw new Error("not used"); },
    now: () => Date.now(),
    keyAlias: owner.alias,
    feedbackOwner: owner,
    readinessProbe: async () => true,
    maintenanceMode: () => false,
    growthCapBytes: 50 * 1024 * 1024,
    pollMs: 10_000,
    retentionTtlMs: 24 * 60 * 60 * 1000,
    runCommand: (argv, opts) => execCageCommand(argv, opts.timeoutMs, { cwd: opts.cwd, env: opts.env }),
    acquireLease: async () => ({ release: async () => {} }),
    cageSelfTest: async () => ({ ok: true, failures: [] }),
    cleanupUnit: async () => {},
  };
}

async function withHermeticDurableAdmission<T>(run: () => Promise<T>): Promise<T> {
  const leaseSpy = vi.spyOn(codeLoopStore, "acquireDurableCodeLoopLease").mockReturnValue({
    kind: "acquired",
    lease: { work_id: "runtime-feedback-test", release: () => {} },
  });
  try {
    return await run();
  } finally {
    leaseSpy.mockRestore();
  }
}

const request = (): CodeLoopRequest => ({
  client_run_id: "runtime-feedback-filter",
  instruction: "return a durable result",
  files: [{ path: "seed.txt", content: "seed\n" }],
  traffic_purpose: "organic",
});

async function waitForResult(workId: string): Promise<CodeLoopResult> {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    const result = getJobResult(workId, workroot);
    if (result.kind === "result") return result.result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`code-loop result ${workId} did not become available`);
}

async function seedDurableRun(): Promise<{ req: CodeLoopRequest; result: CodeLoopResult }> {
  const req = request();
  const owner = { alias: "colliding-alias", keyHash: "owner-a" };
  const started = await withHermeticDurableAdmission(() => startCodeLoop(req, startConfig(), fakeDeps(owner)));
  expect(started.ok).toBe(true);
  if (!started.ok) throw new Error(started.message);
  return { req, result: await waitForResult(started.work_id) };
}

function withoutHandle(result: Record<string, unknown>): Record<string, unknown> {
  const { feedback_handle: _handle, ...rest } = result;
  return rest;
}

async function callResult(owner: ExecutionFeedbackOwner | null, workId: string): Promise<Record<string, unknown>> {
  const response = await handleCodeLoopTool(
    "code_loop_result",
    { work_id: workId },
    runtimeConfig(),
    () => false,
    gatewayContext(owner),
  );
  expect(response.isError).toBe(false);
  return JSON.parse(response.text) as Record<string, unknown>;
}

describe("exact execution feedback filtering on code-loop runtime reads", () => {
  it("keeps code_loop_result handles for the exact key and preserves every other field", async () => {
    const { result } = await seedDurableRun();
    expect(result.feedback_handle).toMatch(/^[0-9a-f-]{36}$/);

    const binding = getDb().prepare(`SELECT f.handle, f.principal_hash, d.key_alias, d.source
      FROM execution_feedback f JOIN delegations d ON d.id = f.ledger_id
      WHERE f.handle = ?`).get(result.feedback_handle) as {
        handle: string; principal_hash: string; key_alias: string; source: string;
      } | undefined;
    expect(binding).toEqual({
      handle: result.feedback_handle,
      principal_hash: "owner-a",
      key_alias: "colliding-alias",
      source: "code-loop",
    });

    const exact = await callResult({ alias: "colliding-alias", keyHash: "owner-a" }, result.work_id);
    expect(exact).toEqual(result);

    // The alias is intentionally identical: the minted key hash is the binding boundary.
    const collidingKey = await callResult({ alias: "colliding-alias", keyHash: "owner-b" }, result.work_id);
    expect(collidingKey).toEqual(withoutHandle(result));
    expect(collidingKey).not.toHaveProperty("feedback_handle");

    const unauthenticated = await callResult(null, result.work_id);
    expect(unauthenticated).toEqual(withoutHandle(result));
  });

  it("applies the same exact-key filter to recovered code_loop_start results", async () => {
    const { req, result } = await seedDurableRun();
    _resetCodeLoopStateForTests();

    const recoveredExact = await handleCodeLoopTool(
      "code_loop_start",
      req as unknown as Record<string, unknown>,
      runtimeConfig(),
      () => false,
      gatewayContext({ alias: "colliding-alias", keyHash: "owner-a" }),
    );
    expect(recoveredExact.isError).toBe(false);
    const exactBody = JSON.parse(recoveredExact.text) as { result?: Record<string, unknown> };
    expect(exactBody.result).toEqual(result);

    _resetCodeLoopStateForTests();
    const recoveredCollidingKey = await handleCodeLoopTool(
      "code_loop_start",
      req as unknown as Record<string, unknown>,
      runtimeConfig(),
      () => false,
      gatewayContext({ alias: "colliding-alias", keyHash: "owner-b" }),
    );
    expect(recoveredCollidingKey.isError).toBe(false);
    const collidingBody = JSON.parse(recoveredCollidingKey.text) as { result?: Record<string, unknown> };
    expect(collidingBody.result).toEqual(withoutHandle(result));
    expect(collidingBody.result).not.toHaveProperty("feedback_handle");

    _resetCodeLoopStateForTests();
    const recoveredNullOwner = await handleCodeLoopTool(
      "code_loop_start",
      req as unknown as Record<string, unknown>,
      runtimeConfig(),
      () => false,
      gatewayContext(null),
    );
    expect(recoveredNullOwner.isError).toBe(false);
    const nullBody = JSON.parse(recoveredNullOwner.text) as { result?: Record<string, unknown> };
    expect(nullBody.result).toEqual(withoutHandle(result));
    expect(nullBody.result).not.toHaveProperty("feedback_handle");
  });

  it("sanitizes code_loop_result when the ownership lookup throws", async () => {
    const { result } = await seedDurableRun();
    const ownershipSpy = vi.spyOn(executionFeedback, "ownsExecutionFeedback").mockImplementation(() => {
      throw new Error("simulated feedback store failure");
    });
    try {
      const response = await handleCodeLoopTool(
        "code_loop_result",
        { work_id: result.work_id },
        runtimeConfig(),
        () => false,
        gatewayContext({ alias: "colliding-alias", keyHash: "owner-a" }),
      );
      expect(response.isError).toBe(false);
      expect(JSON.parse(response.text)).toEqual(withoutHandle(result));
    } finally {
      ownershipSpy.mockRestore();
    }
  });

  it("sanitizes recovered code_loop_start when the ownership lookup throws", async () => {
    const { req, result } = await seedDurableRun();
    _resetCodeLoopStateForTests();
    const ownershipSpy = vi.spyOn(executionFeedback, "ownsExecutionFeedback").mockImplementation(() => {
      throw new Error("simulated feedback store failure");
    });
    try {
      const response = await handleCodeLoopTool(
        "code_loop_start",
        req as unknown as Record<string, unknown>,
        runtimeConfig(),
        () => false,
        gatewayContext({ alias: "colliding-alias", keyHash: "owner-a" }),
      );
      expect(response.isError).toBe(false);
      const body = JSON.parse(response.text) as { result?: Record<string, unknown> };
      expect(body.result).toEqual(withoutHandle(result));
      expect(body.result).not.toHaveProperty("feedback_handle");
    } finally {
      ownershipSpy.mockRestore();
    }
  });
});
