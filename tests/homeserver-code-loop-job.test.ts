import { describe, it, expect, beforeEach, beforeAll, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync, unlinkSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import Database from "better-sqlite3";
import { initDb, getDb } from "../src/db.js";
import { ensureLedgerSchema, reconstructEvidenceIdentity } from "../src/homeserver/ledger.js";
import {
  evidenceIdentityFromAdmittedStamp,
  evidenceIdentityFromServedModelCmd,
  buildEvidenceIdentityBundle,
  evidenceIdentityHash,
} from "../src/homeserver/evidence-identity.js";

// #33: code-loop.ts now derives evidence identity via orchestrator.ts's deriveEvidenceIdentity,
// which joins a LIVE served-model observation (model-admin.js's getRunningCmd). Mocked here —
// same discipline as orchestrator-evidence-identity.test.ts — so the served-model half of a
// stamped run's identity is deterministic instead of depending on a real llama-swap backend.
const servedCmdByModel = new Map<string, string | null>();
vi.mock("../src/homeserver/model-admin.js", () => ({
  getLoaded: async () => [{ key: "qwen3-coder-next-80b" }],
  getRunningCmd: async (modelId: string) => servedCmdByModel.get(modelId) ?? null,
}));
import {
  startCodeLoop,
  getJobStatus,
  getJobResult,
  ledgerOutcome,
  globToRegExp,
  matchesAnyGlob,
  sweepCodeLoopSandboxes,
  isCodeLoopUnitName,
  _resetCodeLoopStateForTests,
  type CodeLoopStartConfig,
  CODE_LOOP_HARNESS_VERSION,
} from "../src/homeserver/code-loop.js";
import { execCageCommand } from "../src/homeserver/code-loop-cage.js";
import type { CodeLoopDeps, EngineRunResult } from "../src/homeserver/code-loop-types.js";
import {
  acquireDurableCodeLoopLease,
  claimDurableCodeLoopRun,
  codeLoopRequestFingerprint,
  isDurableCodeLoopWorkLive,
} from "../src/homeserver/code-loop-store.js";
import {
  TASK_FINGERPRINT_VERSION,
  lookupTaskExposures,
  taskTextFingerprint,
} from "../src/homeserver/task-exposure.js";
import {
  createLearningTaskCapabilityEpoch,
  createLearningTaskGatewayEcho,
  parseHuginRequestStamp,
  type HuginRequestStamp,
} from "../src/homeserver/learning-task-contract.js";
import { claimLearningTaskAdmission } from "../src/homeserver/learning-task-admission-store.js";

/**
 * Job lifecycle over a REAL tmp sandbox (design §11 tests 3–6): real git diff harvest, the
 * single-flight mutex, ledger outcome mapping, protected-glob detection, orphan sweep + TTL.
 * The engine + GPU lease are faked; git + check_cmd run for real (uncaged, cageArgv=[]).
 */

const CAPS = {
  wallSDefault: 480, wallSMax: 900, turnsDefault: 24, turnsMax: 40, tokensDefault: 60_000, tokensMax: 120_000,
};
const ROOT = process.cwd();

let workroot = "";

beforeAll(() => {
  initDb(join(mkdtempSync(join(tmpdir(), "cl-job-db-")), "test.db"));
  ensureLedgerSchema();
});

beforeEach(() => {
  _resetCodeLoopStateForTests();
  workroot = mkdtempSync(join(tmpdir(), "cl-job-work-"));
  try { getDb().prepare("DELETE FROM learning_task_admissions").run(); } catch { /* schema is lazy */ }
  servedCmdByModel.clear();
});

function startCfg(over: Partial<CodeLoopStartConfig> = {}): CodeLoopStartConfig {
  return {
    enabled: true,
    workroot,
    model: "qwen3-coder-next-80b",
    caps: CAPS,
    confinement: "off",
    cage: null,
    ...over,
  };
}

/** Deps whose engine writes `changes` into the sandbox and returns `outcome`; git runs for real. */
function fakeDeps(over: {
  engineRun?: (sandboxDir: string, instruction: string) => Promise<EngineRunResult>;
  maintenance?: boolean;
  lease?: "ok" | "unavailable";
  cageOk?: boolean;
  now?: () => number;
  learningTaskAdmission?: CodeLoopDeps["learningTaskAdmission"];
  keyAlias?: string;
} = {}): CodeLoopDeps {
  const okRun = async (): Promise<EngineRunResult> => ({
    outcome: "completed",
    usage: { turns: 3, wall_ms: 1000, prompt_tokens: 100, completion_tokens: 50 },
    finalMessage: "done",
    unparseableLines: 0,
    detail: "",
  });
  return {
    engine: { run: async (o) => (over.engineRun ? over.engineRun(o.sandboxDir, o.instruction) : okRun()) },
    spawnPi: () => { throw new Error("not used"); },
    now: over.now ?? (() => Date.now()),
    ...(over.learningTaskAdmission === undefined
      ? {}
      : { learningTaskAdmission: over.learningTaskAdmission }),
    keyAlias: over.keyAlias ?? null,
    readinessProbe: async () => true,
    maintenanceMode: () => over.maintenance === true,
    growthCapBytes: 50 * 1024 * 1024,
    pollMs: 10_000,
    retentionTtlMs: 24 * 60 * 60 * 1000,
    runCommand: (argv, opts) => execCageCommand(argv, opts.timeoutMs, { cwd: opts.cwd, env: opts.env }),
    acquireLease: async () => (over.lease === "unavailable" ? null : { release: async () => {} }),
    cageSelfTest: async () => ({ ok: over.cageOk !== false, failures: over.cageOk === false ? ["forced fail"] : [] }),
  };
}

async function waitForTerminal(workId: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = getJobStatus(workId);
    if (s && s.status !== "running") return;
    if (Date.now() > deadline) throw new Error(`job ${workId} did not terminate`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

// ─── glob matcher ───────────────────────────────────────────────────────────────────────

describe("globToRegExp / matchesAnyGlob", () => {
  it("** matches across directories", () => {
    expect(globToRegExp("test/**").test("test/a/b.ts")).toBe(true);
    expect(globToRegExp("test/**").test("test/x.ts")).toBe(true);
    expect(globToRegExp("test/**").test("src/x.ts")).toBe(false);
  });
  it("* stays within a path segment", () => {
    expect(globToRegExp("*.ts").test("a.ts")).toBe(true);
    expect(globToRegExp("*.ts").test("a/b.ts")).toBe(false);
  });
  it("exact file", () => {
    expect(matchesAnyGlob("tsconfig.json", ["tsconfig.json", "test/**"])).toBe(true);
    expect(matchesAnyGlob("src/x.ts", ["tsconfig.json", "test/**"])).toBe(false);
  });
});

// ─── ledger outcome mapping (design §9) ─────────────────────────────────────────────────

describe("ledgerOutcome mapping", () => {
  it("completed + check pass → pass", () => {
    expect(ledgerOutcome("completed", { ran: true, exit_code: 0 })).toEqual({ outcome: "pass", errorClass: null });
  });
  it("completed + check fail → fail", () => {
    expect(ledgerOutcome("completed", { ran: true, exit_code: 1 })).toEqual({ outcome: "fail", errorClass: null });
  });
  it("completed + no check → unverified", () => {
    expect(ledgerOutcome("completed", { ran: false, exit_code: null })).toEqual({ outcome: "unverified", errorClass: null });
  });
  it("degeneracy → error/infra (kept out of verdict math)", () => {
    expect(ledgerOutcome("degenerate", { ran: false, exit_code: null })).toEqual({ outcome: "error", errorClass: "infra" });
  });
  it("cap-exceeded → error/timeout", () => {
    expect(ledgerOutcome("cap-exceeded", { ran: false, exit_code: null })).toEqual({ outcome: "error", errorClass: "timeout" });
  });
  it("arm-error / orphaned → error/infra", () => {
    expect(ledgerOutcome("arm-error", { ran: false, exit_code: null })).toEqual({ outcome: "error", errorClass: "infra" });
    expect(ledgerOutcome("orphaned", { ran: false, exit_code: null })).toEqual({ outcome: "error", errorClass: "infra" });
  });
});

// ─── refusals ───────────────────────────────────────────────────────────────────────────

describe("startCodeLoop — refusals", () => {
  const req = { instruction: "fix it", files: [{ path: "a.ts", content: "export {};\n" }] };

  it("disabled when the flag is off", async () => {
    const r = await startCodeLoop(req, startCfg({ enabled: false }), fakeDeps());
    expect(r).toEqual({ ok: false, refusal: "disabled", message: expect.any(String) });
  });
  it("maintenance window refuses", async () => {
    const r = await startCodeLoop(req, startCfg(), fakeDeps({ maintenance: true }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal).toBe("maintenance");
  });
  it("cage self-test failure refuses with cage-unavailable (confinement required)", async () => {
    const r = await startCodeLoop(req, startCfg({ confinement: "required", cage: { buildArgv: () => [] } }), fakeDeps({ cageOk: false }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal).toBe("cage-unavailable");
  });
  it("lease unavailable refuses with lease-unavailable", async () => {
    const r = await startCodeLoop(req, startCfg(), fakeDeps({ lease: "unavailable" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal).toBe("lease-unavailable");
  });
  it("invalid request (no files) refuses", async () => {
    const r = await startCodeLoop({ instruction: "x", files: [] }, startCfg(), fakeDeps());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal).toBe("invalid-request");
  });
  it("invalid client_run_id refuses before execution", async () => {
    const r = await startCodeLoop({ ...req, client_run_id: "bad/id" }, startCfg(), fakeDeps());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal).toBe("invalid-request");
  });
});

// ─── full lifecycle + real diff harvest ─────────────────────────────────────────────────

describe("startCodeLoop — lifecycle + git diff harvest", () => {
  it("completed run harvests the diff, changed files, and pi summary; result re-fetchable", async () => {
    const engineRun = async (sandboxDir: string): Promise<EngineRunResult> => {
      writeFileSync(join(sandboxDir, "a.ts"), "export const x = 2;\n"); // modify the seed
      writeFileSync(join(sandboxDir, "new.ts"), "export const y = 1;\n"); // add a file
      return { outcome: "completed", usage: { turns: 3, wall_ms: 900, prompt_tokens: 100, completion_tokens: 50 }, finalMessage: "changed x", unparseableLines: 0, detail: "" };
    };
    const start = await startCodeLoop(
      { instruction: "bump x", files: [{ path: "a.ts", content: "export const x = 1;\n" }] },
      startCfg(),
      fakeDeps({ engineRun })
    );
    expect(start.ok).toBe(true);
    if (!start.ok) return;
    await waitForTerminal(start.work_id);

    const res = getJobResult(start.work_id);
    expect(res.kind).toBe("result");
    if (res.kind !== "result") return;
    expect(res.result.status).toBe("completed");
    expect(res.result.changed_files.sort()).toEqual(["a.ts", "new.ts"]);
    expect(res.result.diff).toContain("export const x = 2;");
    expect(res.result.summary).toBe("changed x");
    expect(res.result.execution).toEqual({
      schema_version: 1,
      model: "qwen3-coder-next-80b",
      engine: "pi",
      harness_version: "code-loop-pi-2026-07-14-v6",
      effective_caps: { wall_s: 480, turns: 24, completion_tokens: 60_000 },
      capabilities: {
        start_idempotency: "client-run-id-v1",
        agent_checks: "pi-bash-events-v3",
      },
    });
    expect(res.result.telemetry).toEqual({
      schema_version: 1,
      phase_ms: {},
      mutation_evidence: "diff-only",
      observability_coverage: 0.5,
    });
    expect(res.result.agent_checks).toEqual({
      schema_version: 3,
      source: "pi-bash-events",
      state: "unobservable",
      unparseable_lines: 0,
      coverage_loss_events: 1,
      work_id: start.work_id,
      attempts: [],
    });
    // Re-fetchable.
    expect(getJobResult(start.work_id).kind).toBe("result");
    // Ledger row written with source=code-loop.
    const row = getDb().prepare("SELECT source, outcome FROM delegations WHERE source='code-loop' ORDER BY ts DESC LIMIT 1").get() as { source: string; outcome: string };
    expect(row.source).toBe("code-loop");
    expect(row.outcome).toBe("unverified"); // no check_cmd
  });

  it("check_cmd pass → ledger pass; protected violation disqualifies the check", async () => {
    // engine writes solution.txt; check_cmd asserts it exists.
    const engineRun = async (sandboxDir: string): Promise<EngineRunResult> => {
      writeFileSync(join(sandboxDir, "solution.txt"), "ok\n");
      return { outcome: "completed", usage: { turns: 2, wall_ms: 500, prompt_tokens: 10, completion_tokens: 5 }, finalMessage: "wrote solution", unparseableLines: 0, detail: "" };
    };
    let clock = 0;
    const start = await startCodeLoop(
      { instruction: "write solution", files: [{ path: "seed.txt", content: "todo\n" }], check_cmd: "test -f solution.txt" },
      startCfg(),
      fakeDeps({ engineRun, now: () => (clock += 100) })
    );
    expect(start.ok).toBe(true);
    if (!start.ok) return;
    await waitForTerminal(start.work_id);
    const res = getJobResult(start.work_id);
    if (res.kind !== "result") throw new Error("no result");
    expect(res.result.check.ran).toBe(true);
    expect(res.result.check.exit_code).toBe(0);
    expect(res.result.telemetry.phase_ms.check).toBe(100);
    const row = getDb().prepare("SELECT outcome, verifier FROM delegations WHERE source='code-loop' ORDER BY ts DESC LIMIT 1").get() as { outcome: string; verifier: string };
    expect(row.outcome).toBe("pass");
    expect(row.verifier).toBe("check-cmd");
  });

  it("reports trusted first-edit timing and passes the stable deadline wrapper to the engine", async () => {
    let seenInstruction = "";
    const engineRun = async (sandboxDir: string, instruction: string): Promise<EngineRunResult> => {
      seenInstruction = instruction;
      writeFileSync(join(sandboxDir, "a.ts"), "export const x = 2;\n");
      return {
        outcome: "completed",
        usage: { turns: 4, wall_ms: 1000, prompt_tokens: 100, completion_tokens: 50 },
        finalMessage: "done",
        unparseableLines: 0,
        detail: "",
        telemetry: {
          first_edit_turn: 2,
          edit_start_ms: 300,
          phase_ms: { inspect: 300, edit: 700 },
          mutation_evidence: "tool-call",
          observability_coverage: 1,
          agent_checks: [{
            order: 1,
            kind: "typescript",
            command_fingerprint: `sha256:${"a".repeat(64)}`,
            started_ms: 700,
            ended_ms: 850,
            status: "passed",
            exit_code: 0,
          }],
        },
      };
    };
    const start = await startCodeLoop(
      {
        instruction: "fix x",
        files: [{ path: "a.ts", content: "export const x = 1;\n" }],
        caps: { turns: 13, edit_deadline_turn: 6 },
      },
      startCfg(),
      fakeDeps({ engineRun })
    );
    if (!start.ok) throw new Error("start failed");
    await waitForTerminal(start.work_id);
    const res = getJobResult(start.work_id);
    if (res.kind !== "result") throw new Error("no result");
    expect(seenInstruction).toContain("edit-deadline policy v1");
    expect(seenInstruction.endsWith("fix x")).toBe(true);
    expect(res.result.execution.effective_caps).toEqual({
      wall_s: 480,
      turns: 13,
      completion_tokens: 60_000,
      edit_deadline_turn: 6,
    });
    expect(res.result.telemetry).toMatchObject({
      first_edit_turn: 2,
      edit_start_ms: 300,
      phase_ms: { inspect: 300, edit: 700 },
      mutation_evidence: "tool-call",
      observability_coverage: 1,
    });
    expect(res.result.agent_checks).toEqual({
      schema_version: 3,
      source: "pi-bash-events",
      state: "attempted",
      unparseable_lines: 0,
      coverage_loss_events: 0,
      work_id: start.work_id,
      attempts: [{
        order: 1,
        kind: "typescript",
        command_fingerprint: `sha256:${"a".repeat(64)}`,
        started_ms: 700,
        ended_ms: 850,
        status: "passed",
        exit_code: 0,
      }],
    });
    expect(res.result.check.ran).toBe(false); // downstream/gateway check remains distinct
  });

  it("distinguishes unobservable and partial agent-check NDJSON coverage", async () => {
    const run = (attempted: boolean, signal: "unparseable" | "coverage-loss"): ReturnType<typeof startCodeLoop> => startCodeLoop(
      {
        instruction: `${attempted ? "partial" : "unobservable"}-${signal}`,
        files: [{ path: "a.ts", content: "export const x = 1;\n" }],
      },
      startCfg(),
      fakeDeps({
        engineRun: async () => ({
          outcome: "completed",
          usage: { turns: 1, wall_ms: 1, prompt_tokens: 1, completion_tokens: 1 },
          finalMessage: "done",
          unparseableLines: signal === "unparseable" ? 2 : 0,
          detail: "",
          telemetry: {
            phase_ms: {},
            mutation_evidence: "none",
            observability_coverage: 1,
            agent_check_unparseable_lines: signal === "unparseable" ? 2 : 0,
            agent_check_coverage_loss_events: signal === "coverage-loss" ? 1 : 0,
            agent_checks: attempted ? [{
              order: 1,
              kind: "test",
              command_fingerprint: `sha256:${"b".repeat(64)}`,
              started_ms: 1,
              ended_ms: 2,
              status: "passed",
              exit_code: null,
            }] : [],
          },
        }),
      })
    );

    const first = await run(false, "unparseable");
    if (!first.ok) throw new Error("first start failed");
    await waitForTerminal(first.work_id);
    const firstResult = getJobResult(first.work_id);
    if (firstResult.kind !== "result") throw new Error("missing first result");
    expect(firstResult.result.agent_checks).toMatchObject({ state: "unobservable", unparseable_lines: 2, coverage_loss_events: 0, attempts: [] });

    const second = await run(true, "unparseable");
    if (!second.ok) throw new Error("second start failed");
    await waitForTerminal(second.work_id);
    const secondResult = getJobResult(second.work_id);
    if (secondResult.kind !== "result") throw new Error("missing second result");
    expect(secondResult.result.agent_checks).toMatchObject({ state: "partial", unparseable_lines: 2, coverage_loss_events: 0 });
    expect(secondResult.result.agent_checks.attempts).toHaveLength(1);

    const third = await run(false, "coverage-loss");
    if (!third.ok) throw new Error("third start failed");
    await waitForTerminal(third.work_id);
    const thirdResult = getJobResult(third.work_id);
    if (thirdResult.kind !== "result") throw new Error("missing third result");
    expect(thirdResult.result.agent_checks).toMatchObject({
      state: "unobservable", unparseable_lines: 0, coverage_loss_events: 1, attempts: [],
    });

    const fourth = await run(true, "coverage-loss");
    if (!fourth.ok) throw new Error("fourth start failed");
    await waitForTerminal(fourth.work_id);
    const fourthResult = getJobResult(fourth.work_id);
    if (fourthResult.kind !== "result") throw new Error("missing fourth result");
    expect(fourthResult.result.agent_checks).toMatchObject({
      state: "partial", unparseable_lines: 0, coverage_loss_events: 1,
    });
    expect(fourthResult.result.agent_checks.attempts).toHaveLength(1);
  });

  it("defensively caps injected agent-check attempts and reports dropped evidence", async () => {
    const attempts = Array.from({ length: 1_002 }, (_, index) => ({
      order: index + 1,
      kind: "test" as const,
      command_fingerprint: `sha256:${index.toString(16).padStart(64, "0")}`,
      started_ms: index * 2,
      ended_ms: index * 2 + 1,
      status: "passed" as const,
      exit_code: null,
    }));
    const started = await startCodeLoop(
      { instruction: "bounded checks", files: [{ path: "a.ts", content: "x\n" }] },
      startCfg(),
      fakeDeps({
        engineRun: async () => ({
          outcome: "completed",
          usage: { turns: 1, wall_ms: 1, prompt_tokens: 1, completion_tokens: 1 },
          finalMessage: "done",
          unparseableLines: 0,
          detail: "",
          telemetry: {
            phase_ms: {},
            mutation_evidence: "none",
            observability_coverage: 1,
            agent_check_unparseable_lines: 0,
            agent_check_coverage_loss_events: 0,
            agent_checks: attempts,
          },
        }),
      })
    );
    if (!started.ok) throw new Error("start failed");
    await waitForTerminal(started.work_id);
    const result = getJobResult(started.work_id);
    if (result.kind !== "result") throw new Error("missing result");
    expect(result.result.agent_checks.attempts).toHaveLength(1_000);
    expect(result.result.agent_checks.attempts[0]?.order).toBe(1);
    expect(result.result.agent_checks.attempts[999]?.order).toBe(1_000);
    expect(result.result.agent_checks.coverage_loss_events).toBe(2);
    expect(result.result.agent_checks.state).toBe("partial");
  });

  it("protected glob violation is detected at exit and skips the check", async () => {
    const engineRun = async (sandboxDir: string): Promise<EngineRunResult> => {
      writeFileSync(join(sandboxDir, "tsconfig.json"), "{}\n"); // touches a protected path
      return { outcome: "completed", usage: { turns: 1, wall_ms: 100, prompt_tokens: 1, completion_tokens: 1 }, finalMessage: "", unparseableLines: 0, detail: "" };
    };
    const start = await startCodeLoop(
      { instruction: "x", files: [{ path: "a.ts", content: "y\n" }], protected: ["tsconfig.json"], check_cmd: "true" },
      startCfg(),
      fakeDeps({ engineRun })
    );
    if (!start.ok) throw new Error("start failed");
    await waitForTerminal(start.work_id);
    const res = getJobResult(start.work_id);
    if (res.kind !== "result") throw new Error("no result");
    expect(res.result.protected_violations).toContain("tsconfig.json");
    expect(res.result.check.ran).toBe(false); // protected violation disqualifies the check
  });

  it("single-flight: a second start while one runs → busy", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const engineRun = async (): Promise<EngineRunResult> => {
      await gate;
      return { outcome: "completed", usage: { turns: 1, wall_ms: 1, prompt_tokens: 1, completion_tokens: 1 }, finalMessage: "", unparseableLines: 0, detail: "" };
    };
    const req = { instruction: "x", files: [{ path: "a.ts", content: "y\n" }] };
    const first = await startCodeLoop(req, startCfg(), fakeDeps({ engineRun }));
    expect(first.ok).toBe(true);
    const second = await startCodeLoop(req, startCfg(), fakeDeps());
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.refusal).toBe("busy");
    release();
    if (first.ok) await waitForTerminal(first.work_id);
    // After it finishes, a new start succeeds (mutex released).
    const third = await startCodeLoop(req, startCfg(), fakeDeps());
    expect(third.ok).toBe(true);
    if (third.ok) await waitForTerminal(third.work_id);
  });

  it("status/result for an unknown work_id", async () => {
    expect(getJobStatus("cl-nope")).toBeNull();
    expect(getJobResult("cl-nope").kind).toBe("unknown");
  });

  it("arm-error surfaces the engine's detail in the terminal result (the 94ms silent-death fix)", async () => {
    // The live smoke that motivated this: pi died instantly in the cage and the result JSON was
    // empty everything — the stderr evidence never left the engine. It must reach the caller.
    const engineRun = async (): Promise<EngineRunResult> => ({
      outcome: "arm-error",
      usage: { turns: 0, wall_ms: 94, prompt_tokens: 0, completion_tokens: 0 },
      finalMessage: "",
      unparseableLines: 0,
      detail: "pi exited 1: bwrap: execvp /home/inference/.local/bin/pi: No such file or directory",
    });
    const start = await startCodeLoop(
      { instruction: "x", files: [{ path: "a.ts", content: "y\n" }] },
      startCfg(),
      fakeDeps({ engineRun })
    );
    if (!start.ok) throw new Error("start failed");
    await waitForTerminal(start.work_id);
    const res = getJobResult(start.work_id);
    if (res.kind !== "result") throw new Error("no result");
    expect(res.result.status).toBe("arm-error");
    expect(res.result.detail).toContain("No such file or directory");
    // The MCP caller sees exactly this object JSON-stringified — the field must survive that.
    expect(JSON.parse(JSON.stringify(res.result)).detail).toContain("execvp");
  });

  it("result detail is bounded to ~400 chars", async () => {
    const engineRun = async (): Promise<EngineRunResult> => ({
      outcome: "arm-error",
      usage: { turns: 0, wall_ms: 1, prompt_tokens: 0, completion_tokens: 0 },
      finalMessage: "",
      unparseableLines: 0,
      detail: "e".repeat(5000),
    });
    const start = await startCodeLoop(
      { instruction: "x", files: [{ path: "a.ts", content: "y\n" }] },
      startCfg(),
      fakeDeps({ engineRun })
    );
    if (!start.ok) throw new Error("start failed");
    await waitForTerminal(start.work_id);
    const res = getJobResult(start.work_id);
    if (res.kind !== "result") throw new Error("no result");
    expect(res.result.detail.length).toBeLessThanOrEqual(400);
  });

  it("an engine THROW also surfaces as arm-error detail", async () => {
    const engineRun = async (): Promise<EngineRunResult> => {
      throw new Error("spawn EACCES");
    };
    const start = await startCodeLoop(
      { instruction: "x", files: [{ path: "a.ts", content: "y\n" }] },
      startCfg(),
      fakeDeps({ engineRun })
    );
    if (!start.ok) throw new Error("start failed");
    await waitForTerminal(start.work_id);
    const res = getJobResult(start.work_id);
    if (res.kind !== "result") throw new Error("no result");
    expect(res.result.status).toBe("arm-error");
    expect(res.result.detail).toContain("spawn EACCES");
    expect(res.result.agent_checks).toMatchObject({
      schema_version: 3,
      state: "unobservable",
      unparseable_lines: 0,
      coverage_loss_events: 1,
      attempts: [],
    });
  });

  it("single-flight is race-free across the cage self-test await (TOCTOU)", async () => {
    // Two concurrent starts with confinement=required. The cage self-test is a real async gate,
    // so both calls reach the await before either has (naively) set the mutex. Exactly ONE must
    // win; the other must be refused `busy`. (Regression: the check-then-set straddled the await.)
    let releaseCage!: () => void;
    const cageGate = new Promise<void>((r) => (releaseCage = r));
    let releaseEngine!: () => void;
    const engineGate = new Promise<void>((r) => (releaseEngine = r));

    const gatedDeps = (): CodeLoopDeps => ({
      ...fakeDeps({
        engineRun: async () => {
          await engineGate; // keep the winner running so it can't release the mutex before we assert
          return { outcome: "completed", usage: { turns: 1, wall_ms: 1, prompt_tokens: 1, completion_tokens: 1 }, finalMessage: "", unparseableLines: 0, detail: "" };
        },
      }),
      cageSelfTest: async () => { await cageGate; return { ok: true, failures: [] }; },
    });
    const cfg = startCfg({ confinement: "required", cage: { buildArgv: () => [] } });
    const req = { instruction: "x", files: [{ path: "a.ts", content: "y\n" }] };

    const p1 = startCodeLoop(req, cfg, gatedDeps());
    const p2 = startCodeLoop(req, cfg, gatedDeps());
    releaseCage();
    const [r1, r2] = await Promise.all([p1, p2]);

    const oks = [r1, r2].filter((r) => r.ok);
    const busies = [r1, r2].filter((r) => !r.ok && (r as { refusal?: string }).refusal === "busy");
    expect(oks.length).toBe(1);
    expect(busies.length).toBe(1);

    releaseEngine();
    const winner = (r1.ok ? r1 : r2) as Extract<typeof r1, { ok: true }>;
    await waitForTerminal(winner.work_id);
  });
});

describe("code_loop_start caller idempotency (#251)", () => {
  const baseRequest = {
    client_run_id: "gate-d-pair-001",
    instruction: "fix x",
    files: [{ path: "a.ts", content: "export const x = 1;\n" }],
    caps: { turns: 13 },
  };

  it("preserves the pre-LearningTaskContract fingerprint and recovers its durable record", async () => {
    const predeployFingerprint = "sha256:44a843e13885c849523d2b423e67062caf9b46c76642b4eeb28547faeeaa6c1f";
    expect(codeLoopRequestFingerprint(baseRequest)).toBe(predeployFingerprint);
    claimDurableCodeLoopRun(workroot, {
      schema_version: 1,
      client_run_id: baseRequest.client_run_id,
      request_fingerprint: predeployFingerprint,
      work_id: "cl-20260719-legacy01",
      status: "completed",
      usage: { turns: 1, wall_ms: 1, prompt_tokens: 1, completion_tokens: 1 },
      result: null,
      started_at_ms: Date.parse("2026-07-18T10:00:00Z"),
    });

    expect(await startCodeLoop(baseRequest, startCfg(), fakeDeps())).toMatchObject({
      ok: true,
      recovered: true,
      work_id: "cl-20260719-legacy01",
      request_fingerprint: predeployFingerprint,
    });
  });

  it("records one content-blind code-loop exposure across recovered retries", async () => {
    const marker = "CODE_LOOP_EXPOSURE_RAW_MARKER_257";
    const request = {
      ...baseRequest,
      client_run_id: "task-exposure-idempotency-257",
      instruction: marker,
    };
    const started = await startCodeLoop(request, startCfg(), fakeDeps());
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await waitForTerminal(started.work_id);

    const recovered = await startCodeLoop(request, startCfg(), fakeDeps());
    expect(recovered).toMatchObject({ ok: true, recovered: true, work_id: started.work_id });

    const fingerprint = taskTextFingerprint(marker).sha256;
    const lookup = lookupTaskExposures({
      fingerprint_version: TASK_FINGERPRINT_VERSION,
      fingerprints: [fingerprint],
    });
    expect(lookup.results[0]).toMatchObject({
      seen: true,
      lanes: ["code-loop"],
      model_ids: ["qwen3-coder-next-80b"],
      harness_ids: [CODE_LOOP_HARNESS_VERSION],
    });
    const row = getDb().prepare(
      `SELECT COUNT(*) AS n, GROUP_CONCAT(event_key) AS keys
       FROM task_exposure_events
       WHERE fingerprint_version = ? AND fingerprint_sha256 = ?`
    ).get(TASK_FINGERPRINT_VERSION, fingerprint) as { n: number; keys: string };
    expect(row.n).toBe(1);
    expect(row.keys).toContain(started.work_id);
    expect(row.keys).not.toContain(marker);
  });

  it("concurrent duplicate submissions recover one work id and execute once", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let executions = 0;
    const deps = fakeDeps({
      engineRun: async () => {
        executions++;
        await gate;
        return { outcome: "completed", usage: { turns: 1, wall_ms: 1, prompt_tokens: 1, completion_tokens: 1 }, finalMessage: "done", unparseableLines: 0, detail: "" };
      },
    });

    const first = await startCodeLoop(baseRequest, startCfg(), deps);
    const duplicate = await startCodeLoop(baseRequest, startCfg(), deps);
    expect(first.ok).toBe(true);
    expect(duplicate.ok).toBe(true);
    if (!first.ok || !duplicate.ok) return;
    expect(duplicate.work_id).toBe(first.work_id);
    expect(duplicate.recovered).toBe(true);
    expect(duplicate.status).toBe("running");
    expect(duplicate.request_fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    for (let i = 0; i < 50 && executions === 0; i++) await new Promise((r) => setTimeout(r, 5));
    expect(executions).toBe(1);

    release();
    await waitForTerminal(first.work_id);
  });

  it("same client_run_id with a different canonical request is an explicit conflict", async () => {
    const first = await startCodeLoop(baseRequest, startCfg(), fakeDeps());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const conflict = await startCodeLoop(
      { ...baseRequest, instruction: "different request" },
      startCfg(),
      fakeDeps()
    );
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.refusal).toBe("conflict");
    await waitForTerminal(first.work_id);
  });

  it("response-lost-after-commit retry recovers the terminal result after process reset", async () => {
    let executions = 0;
    const deps = fakeDeps({
      engineRun: async (sandboxDir) => {
        executions++;
        writeFileSync(join(sandboxDir, "a.ts"), "export const x = 2;\n");
        return { outcome: "completed", usage: { turns: 2, wall_ms: 50, prompt_tokens: 4, completion_tokens: 3 }, finalMessage: "fixed", unparseableLines: 0, detail: "" };
      },
    });
    const lostResponse = await startCodeLoop(baseRequest, startCfg(), deps);
    if (!lostResponse.ok) throw new Error("start failed");
    await waitForTerminal(lostResponse.work_id);

    _resetCodeLoopStateForTests(); // gateway/process restart: memory gone, durable files remain
    const retry = await startCodeLoop(baseRequest, startCfg(), deps);
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(retry.recovered).toBe(true);
    expect(retry.work_id).toBe(lostResponse.work_id);
    expect(retry.status).toBe("completed");
    expect(retry.result?.summary).toBe("fixed");
    expect(retry.result?.work_id).toBe(lostResponse.work_id);
    expect(executions).toBe(1);

    expect(getJobStatus(retry.work_id, workroot)?.status).toBe("completed");
    expect(getJobResult(retry.work_id, workroot).kind).toBe("result");
  });

  it("fails closed when a cached terminal result predates the current harness evidence contract", async () => {
    const request = { ...baseRequest, client_run_id: "legacy-terminal-result" };
    const started = await startCodeLoop(request, startCfg(), fakeDeps());
    if (!started.ok) throw new Error("start failed");
    await waitForTerminal(started.work_id);

    const clientPath = join(
      workroot,
      ".code-loop-state-v1",
      `client-${createHash("sha256").update(request.client_run_id).digest("hex")}.json`
    );
    const cached = JSON.parse(readFileSync(clientPath, "utf8")) as {
      result: { execution: { harness_version: string; capabilities: { agent_checks: string } }; agent_checks: { schema_version: number } };
    };
    cached.result.execution.harness_version = "code-loop-pi-2026-07-14-v4";
    cached.result.execution.capabilities.agent_checks = "pi-bash-events-v1";
    cached.result.agent_checks.schema_version = 1;
    writeFileSync(clientPath, JSON.stringify(cached));

    _resetCodeLoopStateForTests();
    const recovered = await startCodeLoop(request, startCfg(), fakeDeps());
    expect(recovered).toMatchObject({ ok: true, recovered: true, status: "completed" });
    if (!recovered.ok) return;
    expect(recovered.result).toBeUndefined();
    expect(getJobResult(recovered.work_id, workroot)).toEqual({
      kind: "terminal-unavailable",
      status: "completed",
    });
  });

  it("durably recovers and TTL-compacts a terminal degenerate result", async () => {
    const request = { ...baseRequest, client_run_id: "durable-degenerate" };
    const deps = fakeDeps({
      engineRun: async () => ({
        outcome: "degenerate",
        usage: { turns: 2, wall_ms: 20, prompt_tokens: 4, completion_tokens: 2 },
        finalMessage: "?????",
        unparseableLines: 0,
        detail: "second attempt degenerated",
      }),
    });
    const started = await startCodeLoop(request, startCfg(), deps);
    if (!started.ok) throw new Error("start failed");
    await waitForTerminal(started.work_id);
    _resetCodeLoopStateForTests();

    const recovered = await startCodeLoop(request, startCfg(), deps);
    if (!recovered.ok) throw new Error("recovery failed");
    expect(recovered).toMatchObject({ recovered: true, work_id: started.work_id, status: "degenerate" });
    expect(recovered.result?.status).toBe("degenerate");

    await sweepCodeLoopSandboxes(
      { workroot, retentionTtlMs: 1 },
      { now: () => Date.now() + 60_000, stopUnit: async () => {} }
    );
    expect(getJobResult(started.work_id, workroot)).toEqual({ kind: "terminal-unavailable", status: "degenerate" });
  });

  it("metadata write failure after durable acceptance still schedules work and recovers terminally", async () => {
    let executions = 0;
    const request = { ...baseRequest, client_run_id: "meta-write-failure" };
    const deps: CodeLoopDeps = {
      ...fakeDeps({
        engineRun: async () => {
          executions++;
          return {
            outcome: "completed",
            usage: { turns: 1, wall_ms: 1, prompt_tokens: 1, completion_tokens: 1 },
            finalMessage: "done",
            unparseableLines: 0,
            detail: "",
          };
        },
      }),
      writeMeta: () => { throw Object.assign(new Error("forced metadata I/O failure"), { code: "EIO" }); },
    };
    const started = await startCodeLoop(request, startCfg(), deps);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await waitForTerminal(started.work_id);
    expect(executions).toBe(1);
    _resetCodeLoopStateForTests();
    const recovered = await startCodeLoop(request, startCfg(), deps);
    expect(recovered).toMatchObject({ ok: true, recovered: true, status: "completed", work_id: started.work_id });
  });

  it.each(["cage", "lease"] as const)(
    "a retry racing %s admission failure never receives an evaporating work_id",
    async (failure) => {
      const request = { ...baseRequest, client_run_id: `admission-${failure}` };
      let entered!: () => void;
      const admissionEntered = new Promise<void>((resolve) => { entered = resolve; });
      let release!: () => void;
      const admissionGate = new Promise<void>((resolve) => { release = resolve; });
      const deps: CodeLoopDeps = {
        ...fakeDeps(),
        ...(failure === "cage" ? {
          cageSelfTest: async () => {
            entered();
            await admissionGate;
            return { ok: false, failures: ["forced"] };
          },
        } : {
          acquireLease: async () => {
            entered();
            await admissionGate;
            return null;
          },
        }),
      };
      const cfg = failure === "cage"
        ? startCfg({ confinement: "required", cage: { buildArgv: () => [] } })
        : startCfg();
      const firstPromise = startCodeLoop(request, cfg, deps);
      await admissionEntered;
      const racingRetry = await startCodeLoop(request, cfg, deps);
      expect(racingRetry.ok).toBe(false);
      if (!racingRetry.ok) expect(racingRetry.refusal).toBe("busy");
      expect("work_id" in racingRetry).toBe(false);
      release();
      const first = await firstPromise;
      expect(first.ok).toBe(false);
      if (!first.ok) expect(first.refusal).toBe(failure === "cage" ? "cage-unavailable" : "lease-unavailable");

      const retried = await startCodeLoop(request, startCfg(), fakeDeps());
      expect(retried.ok).toBe(true);
      if (retried.ok) await waitForTerminal(retried.work_id);
    }
  );

  it("same-id recovery is evaluated before an unrelated single-flight busy refusal", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const deps = fakeDeps({
      engineRun: async () => {
        await gate;
        return { outcome: "completed", usage: { turns: 1, wall_ms: 1, prompt_tokens: 1, completion_tokens: 1 }, finalMessage: "", unparseableLines: 0, detail: "" };
      },
    });
    const first = await startCodeLoop(baseRequest, startCfg(), deps);
    if (!first.ok) throw new Error("start failed");

    const same = await startCodeLoop(baseRequest, startCfg(), deps);
    expect(same.ok).toBe(true);
    if (same.ok) expect(same.work_id).toBe(first.work_id);

    const unrelated = await startCodeLoop(
      { ...baseRequest, client_run_id: "gate-d-pair-002" },
      startCfg(),
      deps
    );
    expect(unrelated.ok).toBe(false);
    if (!unrelated.ok) expect(unrelated.refusal).toBe("busy");

    release();
    await waitForTerminal(first.work_id);
  });

  it("legacy callers remain explicitly non-idempotent", async () => {
    const legacy = await startCodeLoop(
      { instruction: "legacy", files: [{ path: "a.ts", content: "x\n" }] },
      startCfg(),
      fakeDeps()
    );
    expect(legacy.ok).toBe(true);
    if (!legacy.ok) return;
    expect(legacy.client_run_id).toBeNull();
    expect(legacy.request_fingerprint).toBeNull();
    expect(legacy.capabilities.start_idempotency).toBe("client-run-id-v1");
    await waitForTerminal(legacy.work_id);
    expect(getJobResult(legacy.work_id, workroot).kind).toBe("result");
    _resetCodeLoopStateForTests();
    // Submission remains non-idempotent, but the server-generated internal identity keeps result
    // retention/recovery trusted even when the caller omitted client_run_id.
    expect(getJobResult(legacy.work_id, workroot).kind).toBe("result");
  });
});

describe("LearningTaskContract stamped code_loop admission", () => {
  const requestFixture = JSON.parse(readFileSync(
    new URL("./fixtures/hugin-learning-task-request-v1.json", import.meta.url),
    "utf8",
  )) as { prompt: string; learningTaskStamp: unknown };
  const nowMs = Date.parse("2026-07-19T10:00:03.000Z");

  function stampedRequest(epoch: ReturnType<typeof createLearningTaskCapabilityEpoch>): {
    client_run_id: string;
    learning_task_stamp: HuginRequestStamp;
    instruction: string;
    files: Array<{ path: string; content: string }>;
    task_type: string;
  } {
    const stamp = parseHuginRequestStamp(structuredClone(requestFixture.learningTaskStamp));
    stamp.preflight.response = epoch.advertise(new Date("2026-07-19T10:00:02.000Z"));
    return {
      client_run_id: stamp.idempotency_key,
      learning_task_stamp: stamp,
      instruction: requestFixture.prompt,
      files: [{ path: "incident.txt", content: "fixture\n" }],
      task_type: stamp.task_type.id,
    };
  }

  function stampedDeps(
    epoch: ReturnType<typeof createLearningTaskCapabilityEpoch>,
    gatewayRequestId = "opaque:33333333-3333-4333-8333-333333333333",
    authenticatedPrincipalId = "service:hugin",
    clockMs = nowMs,
  ): CodeLoopDeps {
    return fakeDeps({
      now: () => clockMs,
      keyAlias: authenticatedPrincipalId,
      learningTaskAdmission: {
        capabilityEpoch: epoch,
        authenticatedPrincipalId,
        authentication: "gateway-owner-auth",
        gatewayRequestId,
      },
    });
  }

  it("echoes and durably recovers one exact admitted stamp while binding the ledger principal", async () => {
    const epoch = createLearningTaskCapabilityEpoch();
    const request = stampedRequest(epoch);
    const first = await startCodeLoop(request, startCfg(), stampedDeps(epoch));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(createHash("sha256").update(request.instruction.trim(), "utf8").digest("hex"))
      .not.toBe(request.learning_task_stamp.raw_fingerprint.digest);
    expect(first.learning_task_gateway_echo).toMatchObject({
      echoed_request: request.learning_task_stamp,
      authenticated_principal_id: "service:hugin",
      authentication: "gateway-owner-auth",
      gateway_request_id: "opaque:33333333-3333-4333-8333-333333333333",
    });
    await waitForTerminal(first.work_id);

    const promptHash = createHash("sha256").update(request.instruction).digest("hex").slice(0, 16);
    const ledger = getDb().prepare(
      "SELECT key_alias AS keyAlias FROM delegations WHERE source = 'code-loop' AND prompt_hash = ? ORDER BY id DESC LIMIT 1",
    ).get(promptHash) as { keyAlias: string | null };
    expect(ledger.keyAlias).toBe("service:hugin");

    _resetCodeLoopStateForTests();
    const restartedEpoch = createLearningTaskCapabilityEpoch();
    const recovered = await startCodeLoop(
      request,
      startCfg(),
      stampedDeps(restartedEpoch, "opaque:55555555-5555-4555-8555-555555555555"),
    );
    expect(recovered).toMatchObject({
      ok: true,
      recovered: true,
      work_id: first.work_id,
      learning_task_gateway_echo: first.learning_task_gateway_echo,
      result: {
        work_id: first.work_id,
        execution: {
          model: "qwen3-coder-next-80b",
          harness_version: CODE_LOOP_HARNESS_VERSION,
        },
      },
    });

    const substitutedCaller = await startCodeLoop(
      request,
      startCfg(),
      stampedDeps(
        restartedEpoch,
        "opaque:66666666-6666-4666-8666-666666666666",
        "service:not-hugin",
      ),
    );
    expect(substitutedCaller).toMatchObject({ ok: false, refusal: "invalid-request" });
    if (!substitutedCaller.ok) expect(substitutedCaller.message).toMatch(/principal/i);
  });

  it("records BOTH the rendered instruction and the stamp's canonical raw identity (#4)", async () => {
    const epoch = createLearningTaskCapabilityEpoch();
    const request = stampedRequest(epoch);
    // Fresh identity: the fixture's ids are fixed, and an earlier test in this describe block
    // already durably admitted that exact task/attempt/idempotency/request tuple — reusing it here
    // would hit the recovery path (same work_id, no new row) rather than exercise a live accept.
    const freshOpaque = () => `opaque:${randomUUID()}`;
    request.client_run_id = freshOpaque();
    request.learning_task_stamp.idempotency_key = request.client_run_id;
    request.learning_task_stamp.request_id = freshOpaque();
    request.learning_task_stamp.task_instance_id = `task-${randomUUID()}`;
    request.learning_task_stamp.attempt_id = `attempt-${randomUUID()}`;
    // Also give this run its own canonical identity so its exposure row count is independent of
    // the earlier "echoes and durably recovers" test, which admitted the fixture's default digest.
    request.learning_task_stamp.raw_fingerprint.digest = createHash("sha256").update(randomUUID(), "utf8").digest("hex");
    const started = await startCodeLoop(request, startCfg(), stampedDeps(epoch));
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await waitForTerminal(started.work_id);

    const renderedFingerprint = taskTextFingerprint(request.instruction).sha256;
    const canonicalDigest = request.learning_task_stamp.raw_fingerprint.digest;
    expect(renderedFingerprint).not.toBe(canonicalDigest); // genuinely distinct byte domains

    const lookup = lookupTaskExposures({
      fingerprint_version: TASK_FINGERPRINT_VERSION,
      fingerprints: [renderedFingerprint],
      canonical: [{ fingerprint_sha256: canonicalDigest }],
    });
    expect(lookup.results[0]).toMatchObject({
      identity_kind: "rendered-prompt",
      seen: true,
      lanes: ["code-loop"],
    });
    expect(lookup.results[1]).toMatchObject({
      identity_kind: "canonical-raw",
      seen: true,
      lanes: ["code-loop"],
      model_ids: ["qwen3-coder-next-80b"],
      harness_ids: [CODE_LOOP_HARNESS_VERSION],
    });

    const canonicalRowCount = (getDb().prepare(
      `SELECT COUNT(*) AS n FROM task_exposure_events WHERE identity_kind = 'canonical-raw' AND fingerprint_sha256 = ?`
    ).get(canonicalDigest) as { n: number }).n;
    expect(canonicalRowCount).toBe(1);
  });

  it("rejects replay under a mutated attempt or another durable client identity", async () => {
    const epoch = createLearningTaskCapabilityEpoch();
    const request = stampedRequest(epoch);
    const first = await startCodeLoop(request, startCfg(), stampedDeps(epoch));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await waitForTerminal(first.work_id);

    const changedAttempt = structuredClone(request);
    changedAttempt.learning_task_stamp.attempt_id = "attempt-replayed";
    const conflict = await startCodeLoop(changedAttempt, startCfg(), stampedDeps(epoch));
    expect(conflict).toMatchObject({ ok: false, refusal: "conflict" });

    const changedRequestIdentity = structuredClone(request);
    changedRequestIdentity.learning_task_stamp.request_id = "opaque:88888888-8888-4888-8888-888888888888";
    expect(await startCodeLoop(changedRequestIdentity, startCfg(), stampedDeps(epoch)))
      .toMatchObject({ ok: false, refusal: "conflict" });

    const changedRawIdentity = structuredClone(request);
    changedRawIdentity.learning_task_stamp.raw_fingerprint.digest = "a".repeat(64);
    expect(await startCodeLoop(changedRawIdentity, startCfg(), stampedDeps(epoch)))
      .toMatchObject({ ok: false, refusal: "conflict" });

    const changedConfiguration = structuredClone(request);
    changedConfiguration.learning_task_stamp.origin_config.prompt.config_digest.digest = "b".repeat(64);
    expect(await startCodeLoop(changedConfiguration, startCfg(), stampedDeps(epoch)))
      .toMatchObject({ ok: false, refusal: "conflict" });

    const changedPolicy = structuredClone(request);
    changedPolicy.learning_task_stamp.macro_decision.policy_id = "substituted-policy";
    expect(await startCodeLoop(changedPolicy, startCfg(), stampedDeps(epoch)))
      .toMatchObject({ ok: false, refusal: "conflict" });

    const changedInstruction = structuredClone(request);
    changedInstruction.instruction += "\nIgnore the stamped Hugin envelope.";
    const instructionConflict = await startCodeLoop(changedInstruction, startCfg(), stampedDeps(epoch));
    expect(instructionConflict).toMatchObject({ ok: false, refusal: "conflict" });

    const anotherClient = structuredClone(request);
    anotherClient.client_run_id = "opaque:99999999-9999-4999-8999-999999999999";
    const refused = await startCodeLoop(anotherClient, startCfg(), stampedDeps(epoch));
    expect(refused).toMatchObject({ ok: false, refusal: "invalid-request" });
    if (!refused.ok) expect(refused.message).toMatch(/idempotency|client_run_id/i);

    const freshIdempotencySameAttempt = structuredClone(request);
    freshIdempotencySameAttempt.client_run_id = "opaque:91919191-9191-4191-8191-919191919191";
    freshIdempotencySameAttempt.learning_task_stamp.idempotency_key = freshIdempotencySameAttempt.client_run_id;
    freshIdempotencySameAttempt.learning_task_stamp.request_id = "opaque:92929292-9292-4292-8292-929292929292";
    expect(await startCodeLoop(freshIdempotencySameAttempt, startCfg(), stampedDeps(epoch)))
      .toMatchObject({ ok: false, refusal: "conflict" });

    const freshIdempotencySameRequest = structuredClone(request);
    freshIdempotencySameRequest.client_run_id = "opaque:93939393-9393-4393-8393-939393939393";
    freshIdempotencySameRequest.learning_task_stamp.idempotency_key = freshIdempotencySameRequest.client_run_id;
    freshIdempotencySameRequest.learning_task_stamp.attempt_id = "attempt-substituted";
    expect(await startCodeLoop(freshIdempotencySameRequest, startCfg(), stampedDeps(epoch)))
      .toMatchObject({ ok: false, refusal: "conflict" });

    const substitutedClientNamespace = structuredClone(request);
    substitutedClientNamespace.client_run_id = "opaque:94949494-9494-4494-8494-949494949494";
    substitutedClientNamespace.learning_task_stamp.idempotency_key = substitutedClientNamespace.client_run_id;
    substitutedClientNamespace.learning_task_stamp.request_id = "opaque:95959595-9595-4595-8595-959595959595";
    substitutedClientNamespace.learning_task_stamp.client_id = "another-hugin-client";
    expect(await startCodeLoop(substitutedClientNamespace, startCfg(), stampedDeps(epoch)))
      .toMatchObject({ ok: false, refusal: "conflict" });
  });

  it("returns the stored echo and a distinct fail-closed refusal after admission-before-publish", async () => {
    const epoch = createLearningTaskCapabilityEpoch();
    const request = {
      ...stampedRequest(epoch),
      caps: { turns: 20, edit_deadline_turn: 15 },
    };
    const echo = createLearningTaskGatewayEcho(request.learning_task_stamp, {
      authenticatedPrincipalId: "service:hugin",
      authentication: "gateway-owner-auth",
      gatewayRequestId: "opaque:31313131-3131-4131-8131-313131313131",
      admissionId: "opaque:41414141-4141-4141-8141-414141414141",
      admittedAt: new Date(nowMs),
    });
    expect(claimLearningTaskAdmission({
      principalId: "service:hugin",
      clientId: request.learning_task_stamp.client_id,
      taskInstanceId: request.learning_task_stamp.task_instance_id,
      attemptId: request.learning_task_stamp.attempt_id,
      requestId: request.learning_task_stamp.request_id,
      idempotencyKey: request.learning_task_stamp.idempotency_key,
      requestFingerprint: codeLoopRequestFingerprint(request),
      surface: "code-loop",
      gatewayEcho: echo,
    }).kind).toBe("claimed");

    const restartedEpoch = createLearningTaskCapabilityEpoch();
    const tightenedConfig = startCfg({
      caps: { ...CAPS, turnsMax: 10 },
    });
    expect(await startCodeLoop(
      request,
      tightenedConfig,
      stampedDeps(
        restartedEpoch,
        "opaque:51515151-5151-4151-8151-515151515151",
        "service:hugin",
        Date.parse("2026-07-19T10:20:03.000Z"),
      ),
    )).toMatchObject({
      ok: false,
      refusal: "admission-recovery",
      recovered_admission: true,
      learning_task_gateway_echo: echo,
    });
  });

  it("rejects a durable run whose stored echo is not the exact incoming stamped identity", async () => {
    const epoch = createLearningTaskCapabilityEpoch();
    const request = stampedRequest(epoch);
    const substitutedStamp = structuredClone(request.learning_task_stamp);
    substitutedStamp.macro_decision.policy_id = "substituted-persisted-policy";
    const mismatchedEcho = createLearningTaskGatewayEcho(substitutedStamp, {
      authenticatedPrincipalId: "service:hugin",
      authentication: "gateway-owner-auth",
      gatewayRequestId: "opaque:61616161-6161-4161-8161-616161616161",
      admissionId: "opaque:71717171-7171-4171-8171-717171717171",
      admittedAt: new Date(nowMs),
    });
    expect(claimDurableCodeLoopRun(workroot, {
      schema_version: 1,
      client_run_id: request.client_run_id,
      // Simulate a historical/inconsistent record whose fingerprint did not cover its echo.
      request_fingerprint: codeLoopRequestFingerprint(request),
      work_id: "cl-20260719-deadbeef",
      status: "completed",
      usage: { turns: 1, wall_ms: 1, prompt_tokens: 1, completion_tokens: 1 },
      result: null,
      started_at_ms: nowMs,
      learning_task_gateway_echo: mismatchedEcho,
    }).kind).toBe("claimed");

    expect(await startCodeLoop(request, startCfg(), stampedDeps(epoch)))
      .toMatchObject({ ok: false, refusal: "conflict" });
  });
});

describe("#33: code_loop lane binds evidence identity via orchestrator.ts's deriveEvidenceIdentity", () => {
  const requestFixture = JSON.parse(readFileSync(
    new URL("./fixtures/hugin-learning-task-request-v1.json", import.meta.url),
    "utf8",
  )) as { prompt: string; learningTaskStamp: unknown };
  const nowMs = Date.parse("2026-07-19T10:00:03.000Z");

  let uniqueCounter = 0;

  function stampedRequest(epoch: ReturnType<typeof createLearningTaskCapabilityEpoch>): {
    client_run_id: string;
    learning_task_stamp: HuginRequestStamp;
    instruction: string;
    files: Array<{ path: string; content: string }>;
    task_type: string;
  } {
    const stamp = parseHuginRequestStamp(structuredClone(requestFixture.learningTaskStamp));
    stamp.preflight.response = epoch.advertise(new Date("2026-07-19T10:00:02.000Z"));
    // recordDelegation() ids are random UUIDs (not insertion-ordered), and the older
    // "LearningTaskContract stamped code_loop admission" describe block above ALSO writes
    // code-loop ledger rows for this identical fixture prompt. A unique per-call suffix on the
    // rendered instruction (never on the stamp — evidenceIdentityFromAdmittedStamp reads only
    // stamp fields, never req.instruction) keeps this describe block's `ledgerRowFor` lookups
    // unambiguous without depending on ledger row ordering.
    const instruction = `${requestFixture.prompt}\n\n[#33 test marker ${uniqueCounter++}]`;
    return {
      client_run_id: stamp.idempotency_key,
      learning_task_stamp: stamp,
      instruction,
      files: [{ path: "incident.txt", content: "fixture\n" }],
      task_type: stamp.task_type.id,
    };
  }

  function stampedDeps(epoch: ReturnType<typeof createLearningTaskCapabilityEpoch>): CodeLoopDeps {
    return fakeDeps({
      now: () => nowMs,
      keyAlias: "service:hugin",
      learningTaskAdmission: {
        capabilityEpoch: epoch,
        authenticatedPrincipalId: "service:hugin",
        authentication: "gateway-owner-auth",
        gatewayRequestId: "opaque:33333333-3333-4333-8333-333333333333",
      },
    });
  }

  function ledgerRowFor(prompt: string): { hash: string | null; lane: string | null } {
    const promptHash = createHash("sha256").update(prompt).digest("hex").slice(0, 16);
    // `id` is a random UUID (recordDelegation), not insertion-ordered — order by `ts` (defense in
    // depth on top of stampedRequest's unique-per-call instruction marker above).
    return getDb()
      .prepare(
        "SELECT evidence_identity_hash AS hash, evidence_lane AS lane FROM delegations WHERE source = 'code-loop' AND prompt_hash = ? ORDER BY ts DESC LIMIT 1"
      )
      .get(promptHash) as { hash: string | null; lane: string | null };
  }

  it("a stamped code_loop run lands a reconstructable evidence identity tagged 'code-loop'", async () => {
    const epoch = createLearningTaskCapabilityEpoch();
    const request = stampedRequest(epoch);
    const servedCmd = "llama-server -m /models/qwen3-coder-next-80b-Q4_K_M.gguf -c 65536";
    servedCmdByModel.set("qwen3-coder-next-80b", servedCmd);

    const started = await startCodeLoop(request, startCfg(), stampedDeps(epoch));
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await waitForTerminal(started.work_id);

    const row = ledgerRowFor(request.instruction);
    expect(row.hash).not.toBeNull();
    // Per-lane correctness (#33 AC2): tagged code-loop, never a delegate/delegate-shadow/mcp-ask tag.
    expect(row.lane).toBe("code-loop");

    const expectedBundle = buildEvidenceIdentityBundle({
      ...evidenceIdentityFromAdmittedStamp(request.learning_task_stamp),
      ...evidenceIdentityFromServedModelCmd(servedCmd),
      lane: "code-loop",
    });
    expect(row.hash).toBe(evidenceIdentityHash(expectedBundle));

    const snapshot = reconstructEvidenceIdentity(row.hash!);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.bundle).toEqual(expectedBundle);
    expect(snapshot!.bundle.lane).toBe("code-loop");
    expect(snapshot!.bundle.harness.kind).toBe("digest");
    expect(snapshot!.bundle.modelArtifact.kind).toBe("digest");
  });

  it("a served-model lookup failure fails OPEN to unknown('not-observed'), never fabricated", async () => {
    const epoch = createLearningTaskCapabilityEpoch();
    const request = stampedRequest(epoch);
    // No entry in servedCmdByModel for this model -> getRunningCmd resolves null (not-observed).
    const started = await startCodeLoop(request, startCfg(), stampedDeps(epoch));
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await waitForTerminal(started.work_id);

    const row = ledgerRowFor(request.instruction);
    expect(row.hash).not.toBeNull();
    expect(row.lane).toBe("code-loop");
    const snapshot = reconstructEvidenceIdentity(row.hash!);
    expect(snapshot!.bundle.modelArtifact).toMatchObject({ kind: "unknown", reason: "not-observed" });
    expect(snapshot!.bundle.configEpoch).toMatchObject({ kind: "unknown", reason: "not-observed" });
  });

  it("an unstamped code_loop run keeps a null (legacy) evidence identity, no crash", async () => {
    const prompt = "plain legacy run, no stamp (#33)";
    const started = await startCodeLoop(
      { instruction: prompt, files: [{ path: "a.txt", content: "x\n" }] },
      startCfg(),
      fakeDeps()
    );
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await waitForTerminal(started.work_id);

    const row = ledgerRowFor(prompt);
    expect(row.hash).toBeNull();
    expect(row.lane).toBeNull();
  });
});

describe("durable code-loop process lease", () => {
  function seedLegacyPidOnlyLease(ownerPid: number, workId = "legacy-work"): string {
    const stateDir = join(workroot, ".code-loop-state-v1");
    mkdirSync(stateDir, { recursive: true });
    const dbPath = join(stateDir, "active-run.sqlite");
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE active_run_lease (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        owner_instance_id TEXT NOT NULL,
        owner_pid INTEGER NOT NULL,
        work_id TEXT NOT NULL
      );
      INSERT INTO active_run_lease (singleton, owner_instance_id, owner_pid, work_id)
      VALUES (1, 'legacy-owner', ${ownerPid}, '${workId}');
    `);
    db.close();
    return dbPath;
  }

  it("upgrades a live migrated PID-only row and preserves it as busy during rolling overlap", () => {
    const dbPath = seedLegacyPidOnlyLease(process.pid);
    const migrated = acquireDurableCodeLoopLease(workroot, "new-work", () => true, {
      processIdentityOf: () => ({ boot_id: "legacy-boot", start_token: "legacy-start" }),
    });
    expect(migrated).toEqual({ kind: "busy", work_id: "legacy-work" });
    const db = new Database(dbPath, { readonly: true });
    expect(db.prepare("SELECT owner_instance_id, owner_boot_id, owner_start_token, owner_identity_instance_id FROM active_run_lease").get()).toEqual({
      owner_instance_id: "legacy-owner",
      owner_boot_id: "legacy-boot",
      owner_start_token: "legacy-start",
      owner_identity_instance_id: "legacy-owner",
    });
    db.close();
  });

  it("preserves a live migrated PID-only row as unknown/busy when identity sampling is unavailable", () => {
    const dbPath = seedLegacyPidOnlyLease(process.pid);
    let identityCalls = 0;
    const migrated = acquireDurableCodeLoopLease(workroot, "new-work", () => true, {
      processIdentityOf: () => ++identityCalls === 1
        ? null
        : { boot_id: "new-boot", start_token: "new-start" },
    });
    expect(migrated).toEqual({ kind: "busy", work_id: "legacy-work" });
    const db = new Database(dbPath, { readonly: true });
    expect(db.prepare("SELECT owner_boot_id, owner_start_token FROM active_run_lease").get()).toEqual({
      owner_boot_id: null,
      owner_start_token: null,
    });
    db.close();
  });

  it("reclaims a dead migrated PID-only row", () => {
    seedLegacyPidOnlyLease(2_147_483_647);
    const migrated = acquireDurableCodeLoopLease(workroot, "new-work", () => false, {
      processIdentityOf: () => ({ boot_id: "boot-new", start_token: "start-new" }),
    });
    expect(migrated.kind).toBe("acquired");
    if (migrated.kind === "acquired") migrated.lease.release();
  });

  it("keeps a live legacy-reclaimed owner busy when its inherited identity columns are stale", () => {
    const firstIdentity = { boot_id: "boot-old", start_token: "start-old" };
    const first = acquireDurableCodeLoopLease(workroot, "identity-aware-owner", () => true, {
      processIdentityOf: () => firstIdentity,
    });
    if (first.kind !== "acquired") throw new Error("first lease not acquired");

    // Simulate the deployed legacy binary's reclaim UPDATE: it replaces owner/pid/work but does
    // not know about any of the three identity columns added by the rolling successor.
    const dbPath = join(workroot, ".code-loop-state-v1", "active-run.sqlite");
    const db = new Database(dbPath);
    db.prepare(`
      UPDATE active_run_lease
      SET owner_instance_id = 'legacy-reclaimer', owner_pid = ?, work_id = 'legacy-live-work'
      WHERE singleton = 1
    `).run(process.pid);
    db.close();

    const actualLegacyIdentity = { boot_id: "boot-new", start_token: "start-new" };
    expect(acquireDurableCodeLoopLease(workroot, "must-not-double-run", () => true, {
      processIdentityOf: () => actualLegacyIdentity,
    })).toEqual({ kind: "busy", work_id: "legacy-live-work" });
    expect(isDurableCodeLoopWorkLive(
      workroot,
      "legacy-live-work",
      () => true,
      () => actualLegacyIdentity
    )).toBe(true);
    first.lease.release(); // stale owner-conditioned release cannot delete the legacy row
  });

  it.each([
    ["boot change", { boot_id: "boot-b", start_token: "start-a" }],
    ["PID reuse", { boot_id: "boot-a", start_token: "start-b" }],
  ] as const)("rejects PID-only liveness after %s", (_label, successorIdentity) => {
    const dir = join(workroot, successorIdentity.start_token);
    mkdirSync(dir, { recursive: true });
    const originalIdentity = { boot_id: "boot-a", start_token: "start-a" };
    const first = acquireDurableCodeLoopLease(dir, "original", () => true, {
      processIdentityOf: () => originalIdentity,
    });
    if (first.kind !== "acquired") throw new Error("first lease not acquired");
    expect(isDurableCodeLoopWorkLive(dir, "original", () => true, () => originalIdentity)).toBe(true);
    expect(isDurableCodeLoopWorkLive(dir, "original", () => true, () => successorIdentity)).toBe(false);

    const successor = acquireDurableCodeLoopLease(dir, "successor", () => true, {
      processIdentityOf: () => successorIdentity,
    });
    expect(successor.kind).toBe("acquired");
    first.lease.release(); // stale release is owner-conditioned
    if (successor.kind === "acquired") successor.lease.release();
  });

  it("treats a temporarily unavailable identity lookup as busy, not dead", () => {
    const originalIdentity = { boot_id: "boot-a", start_token: "start-a" };
    const first = acquireDurableCodeLoopLease(workroot, "original", () => true, {
      processIdentityOf: () => originalIdentity,
    });
    if (first.kind !== "acquired") throw new Error("first lease not acquired");
    expect(isDurableCodeLoopWorkLive(workroot, "original", () => true, () => null)).toBe(true);
    let probes = 0;
    expect(acquireDurableCodeLoopLease(workroot, "successor", () => true, {
      processIdentityOf: () => ++probes === 1 ? originalIdentity : null,
    })).toEqual({ kind: "busy", work_id: "original" });
    first.lease.release();
  });

  it("retries a transient release failure and does not wedge later admission", () => {
    let attempts = 0;
    const first = acquireDurableCodeLoopLease(workroot, "release-retry", () => true, {
      beforeReleaseAttempt: (attempt) => {
        attempts = attempt;
        if (attempt === 1) throw Object.assign(new Error("busy once"), { code: "SQLITE_BUSY" });
      },
    });
    if (first.kind !== "acquired") throw new Error("first lease not acquired");
    first.lease.release();
    expect(attempts).toBe(2);
    const next = acquireDurableCodeLoopLease(workroot, "after-retry", () => true);
    expect(next.kind).toBe("acquired");
    if (next.kind === "acquired") next.lease.release();
  });

  it("can reclaim its own conditioned row after release retries are exhausted", () => {
    const stuck = acquireDurableCodeLoopLease(workroot, "stuck-release", () => true, {
      beforeReleaseAttempt: () => { throw new Error("forced I/O fault"); },
    });
    if (stuck.kind !== "acquired") throw new Error("stuck lease not acquired");
    expect(() => stuck.lease.release()).toThrow("forced I/O fault");
    const recovered = acquireDurableCodeLoopLease(workroot, "recovered", () => true, {
      reclaimOwnInstance: true,
    });
    expect(recovered.kind).toBe("acquired");
    if (recovered.kind === "acquired") recovered.lease.release();
  });

  it("release is owner-conditioned and cannot delete a successor", () => {
    const first = acquireDurableCodeLoopLease(workroot, "first", () => true);
    expect(first.kind).toBe("acquired");
    if (first.kind !== "acquired") return;
    expect(acquireDurableCodeLoopLease(workroot, "blocked", () => true)).toEqual({
      kind: "busy",
      work_id: "first",
    });
    first.lease.release();

    const successor = acquireDurableCodeLoopLease(workroot, "successor", () => true);
    expect(successor.kind).toBe("acquired");
    if (successor.kind !== "acquired") return;
    first.lease.release(); // idempotent stale release must not remove successor's row
    expect(acquireDurableCodeLoopLease(workroot, "third", () => true)).toEqual({
      kind: "busy",
      work_id: "successor",
    });
    successor.lease.release();
  });

  it("serializes two cross-process stale takeovers so exactly one paid-run lease wins", { timeout: 20_000 }, async () => {
    const startChild = async (workId: string): Promise<{
      child: ChildProcessWithoutNullStreams;
      result: { kind: "acquired" | "busy"; work_id: string | null };
    }> => {
      const child = spawn(process.execPath, [
        "--import", "tsx",
        join(ROOT, "tests", "fixtures", "code-loop-lease-child.ts"),
        workroot,
        workId,
      ], { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
      const result = await new Promise<{ kind: "acquired" | "busy"; work_id: string | null }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`lease child timed out: ${stderr}`)), 10_000);
        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
          const newline = stdout.indexOf("\n");
          if (newline === -1) return;
          clearTimeout(timer);
          try { resolve(JSON.parse(stdout.slice(0, newline)) as { kind: "acquired" | "busy"; work_id: string | null }); }
          catch (err) { reject(new Error(`invalid lease child output: ${stdout}; ${String(err)}; ${stderr}`)); }
        });
        child.once("error", (err) => { clearTimeout(timer); reject(err); });
        child.once("exit", (code) => {
          if (stdout.includes("\n")) return;
          clearTimeout(timer);
          reject(new Error(`lease child exited ${String(code)} before result: ${stderr}`));
        });
      });
      return { child, result };
    };

    const dead = await startChild("dead-owner");
    expect(dead.result.kind).toBe("acquired");
    dead.child.kill("SIGKILL");
    await once(dead.child, "exit");

    const [b, c] = await Promise.all([startChild("contender-b"), startChild("contender-c")]);
    const winner = [b, c].find((entry) => entry.result.kind === "acquired");
    const loser = [b, c].find((entry) => entry.result.kind === "busy");
    expect(winner).toBeDefined();
    expect(loser?.result.work_id).toBe(winner?.result.work_id);

    const d = await startChild("contender-d");
    expect(d.result).toEqual({ kind: "busy", work_id: winner?.result.work_id ?? null });
    await once(d.child, "exit");

    if (winner !== undefined) {
      winner.child.stdin.write("release\n");
      await once(winner.child, "exit");
    }
    const loserChild = loser?.child;
    if (loserChild !== undefined && loserChild.exitCode === null) await once(loserChild, "exit");
  });
});

// ─── orphan sweep + TTL ─────────────────────────────────────────────────────────────────

describe("isCodeLoopUnitName", () => {
  it("accepts only the harness's own transient scope unit shape", () => {
    expect(isCodeLoopUnitName("code-loop-cl-20260702-abcdef12")).toBe(true);
    // Attacker-chosen / other user units MUST be rejected.
    expect(isCodeLoopUnitName("important-user.service")).toBe(false);
    expect(isCodeLoopUnitName("home-gateway.service")).toBe(false);
    expect(isCodeLoopUnitName("code-loop-x")).toBe(false); // wrong id shape
    expect(isCodeLoopUnitName("../../etc")).toBe(false);
    expect(isCodeLoopUnitName("")).toBe(false);
  });
});

describe("sweepCodeLoopSandboxes", () => {
  it("does not orphan a running sandbox owned by an overlapping live gateway process", async () => {
    const workId = "cl-20260714-cafebabe";
    const lease = acquireDurableCodeLoopLease(workroot, workId, () => true);
    expect(lease.kind).toBe("acquired");
    if (lease.kind !== "acquired") return;
    const dir = join(workroot, `${workId}-Ab3Xy9`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".meta.json"), JSON.stringify({
      work_id: workId,
      status: "running",
      scope_unit: `code-loop-${workId}`,
      model: "m",
      started_at_ms: Date.now(),
    }));
    const stopped: string[] = [];
    const result = await sweepCodeLoopSandboxes(
      { workroot, retentionTtlMs: 24 * 60 * 60 * 1000 },
      { now: () => Date.now(), stopUnit: async (unit) => { stopped.push(unit); } }
    );
    expect(result.orphaned).toBe(0);
    expect(stopped).toEqual([]);
    expect(JSON.parse(readFileSync(join(dir, ".meta.json"), "utf8"))).toMatchObject({ status: "running" });
    lease.lease.release();
  });

  it("marks a durable running binding orphaned even if the crash preceded sandbox metadata", async () => {
    const workId = "cl-20260714-deadbeef";
    claimDurableCodeLoopRun(workroot, {
      schema_version: 1,
      client_run_id: "crash-before-sandbox",
      request_fingerprint: `sha256:${"a".repeat(64)}`,
      work_id: workId,
      status: "running",
      usage: { turns: 0, wall_ms: 0, prompt_tokens: 0, completion_tokens: 0 },
      result: null,
      started_at_ms: Date.now(),
    });
    const clientPath = join(
      workroot,
      ".code-loop-state-v1",
      `client-${createHash("sha256").update("crash-before-sandbox").digest("hex")}.json`
    );
    const prior = JSON.parse(readFileSync(clientPath, "utf8")) as Record<string, unknown>;
    writeFileSync(clientPath, JSON.stringify({ ...prior, owner_instance_id: "prior-process", owner_pid: 2_147_483_647 }));

    const r = await sweepCodeLoopSandboxes(
      { workroot, retentionTtlMs: 24 * 60 * 60 * 1000 },
      { now: () => Date.now(), stopUnit: async () => {} }
    );
    expect(r.orphaned).toBe(1);
    expect(getJobStatus(workId, workroot)?.status).toBe("orphaned");
  });

  it("does not treat a live but non-owning PID as proof that a durable run is active", async () => {
    const workId = "cl-20260714-bad0cafe";
    claimDurableCodeLoopRun(workroot, {
      schema_version: 1,
      client_run_id: "pid-without-lease",
      request_fingerprint: `sha256:${"c".repeat(64)}`,
      work_id: workId,
      status: "running",
      usage: { turns: 0, wall_ms: 0, prompt_tokens: 0, completion_tokens: 0 },
      result: null,
      started_at_ms: Date.now(),
    });

    const r = await sweepCodeLoopSandboxes(
      { workroot, retentionTtlMs: 24 * 60 * 60 * 1000 },
      { now: () => Date.now(), stopUnit: async () => {} }
    );
    expect(r.orphaned).toBe(1);
    expect(getJobStatus(workId, workroot)?.status).toBe("orphaned");
  });

  it("does not orphan a new durable binding racing the asynchronous startup sweep", async () => {
    const workId = "cl-20260714-feedface";
    const lease = acquireDurableCodeLoopLease(workroot, workId, () => true);
    expect(lease.kind).toBe("acquired");
    if (lease.kind !== "acquired") return;
    claimDurableCodeLoopRun(workroot, {
      schema_version: 1,
      client_run_id: "new-process-start",
      request_fingerprint: `sha256:${"b".repeat(64)}`,
      work_id: workId,
      status: "running",
      usage: { turns: 0, wall_ms: 0, prompt_tokens: 0, completion_tokens: 0 },
      result: null,
      started_at_ms: Date.now(),
    });

    const r = await sweepCodeLoopSandboxes(
      { workroot, retentionTtlMs: 24 * 60 * 60 * 1000 },
      { now: () => Date.now(), stopUnit: async () => {} }
    );
    expect(r.orphaned).toBe(0);
    expect(getJobStatus(workId, workroot)?.status).toBe("running");
    lease.lease.release();
  });

  it("marks a stale 'running' .meta.json as orphaned and stops its unit", async () => {
    const dir = join(workroot, "cl-20260702-abcdef12-Ab3Xy9");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".meta.json"), JSON.stringify({ work_id: "cl-20260702-abcdef12", status: "running", scope_unit: "code-loop-cl-20260702-abcdef12", model: "m", started_at_ms: Date.now() }));
    const stopped: string[] = [];
    const r = await sweepCodeLoopSandboxes({ workroot, retentionTtlMs: 24 * 60 * 60 * 1000 }, { now: () => Date.now(), stopUnit: async (u) => { stopped.push(u); } });
    expect(r.orphaned).toBe(1);
    expect(stopped).toEqual(["code-loop-cl-20260702-abcdef12"]);
    const meta = JSON.parse(readFileSync(join(dir, ".meta.json"), "utf8")) as { status: string };
    expect(meta.status).toBe("orphaned");
  });

  it("does NOT hand systemctl an attacker-chosen scope_unit from a tampered .meta.json", async () => {
    // A hostile pi can overwrite .meta.json in its own sandbox; the sweep must never `systemctl
    // --user stop` an arbitrary unit name from it. The run is still marked orphaned, but no stop.
    const dir = join(workroot, "cl-20260702-evilaaaa-Zz9Qw1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".meta.json"), JSON.stringify({ work_id: "cl-20260702-evilaaaa", status: "running", scope_unit: "home-gateway.service", model: "m", started_at_ms: Date.now() }));
    const stopped: string[] = [];
    const r = await sweepCodeLoopSandboxes({ workroot, retentionTtlMs: 24 * 60 * 60 * 1000 }, { now: () => Date.now(), stopUnit: async (u) => { stopped.push(u); } });
    expect(r.orphaned).toBe(1);
    expect(stopped).toEqual([]); // the untrusted unit name was refused
    const meta = JSON.parse(readFileSync(join(dir, ".meta.json"), "utf8")) as { status: string };
    expect(meta.status).toBe("orphaned");
  });

  it("does not synchronously parse oversized agent-writable metadata during the sweep", async () => {
    const dir = join(workroot, "cl-20260702-a11cebad-Zz9Qw1");
    mkdirSync(dir, { recursive: true });
    const metadata = JSON.stringify({
      work_id: "cl-20260702-a11cebad",
      status: "running",
      model: "m",
      started_at_ms: Date.now(),
    }).padEnd(70 * 1024, " ");
    writeFileSync(join(dir, ".meta.json"), metadata);
    const stopped: string[] = [];
    const result = await sweepCodeLoopSandboxes(
      { workroot, retentionTtlMs: 24 * 60 * 60 * 1000 },
      { now: () => Date.now(), stopUnit: async (unit) => { stopped.push(unit); } }
    );
    expect(result).toEqual({ orphaned: 0, reclaimed: 0 });
    expect(stopped).toEqual([]);
  });

  it("reclaims a sandbox older than the TTL", async () => {
    const dir = join(workroot, "cl-old");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".meta.json"), JSON.stringify({ work_id: "cl-old", status: "completed", scope_unit: "u", model: "m", started_at_ms: Date.now() - 48 * 60 * 60 * 1000 }));
    const r = await sweepCodeLoopSandboxes({ workroot, retentionTtlMs: 24 * 60 * 60 * 1000 }, { now: () => Date.now(), stopUnit: async () => {} });
    expect(r.reclaimed).toBe(1);
    expect(existsSync(dir)).toBe(false);
  });

  it("TTL-reclaims an old recordless and metadata-less sandbox from its filesystem timestamp", async () => {
    const now = Date.now();
    const oldDir = join(workroot, "cl-20260714-deadc0de-Ab3Xy9");
    const freshDir = join(workroot, "cl-20260714-feedc0de-Ab3Xy9");
    mkdirSync(oldDir, { recursive: true });
    mkdirSync(freshDir, { recursive: true });
    const old = new Date(now - 48 * 60 * 60 * 1000);
    utimesSync(oldDir, old, old);

    const r = await sweepCodeLoopSandboxes(
      { workroot, retentionTtlMs: 24 * 60 * 60 * 1000 },
      { now: () => now, stopUnit: async () => {} }
    );
    expect(r.reclaimed).toBe(1);
    expect(existsSync(oldDir)).toBe(false);
    expect(existsSync(freshDir)).toBe(true);
  });

  it("periodically compacts a durable source-bearing result without a restart", async () => {
    const started = await startCodeLoop(
      {
        client_run_id: "ttl-result-compaction",
        instruction: "finish",
        files: [{ path: "a.ts", content: "export const x = 1;\n" }],
      },
      startCfg(),
      fakeDeps()
    );
    if (!started.ok) throw new Error("start failed");
    await waitForTerminal(started.work_id);
    expect(getJobResult(started.work_id, workroot).kind).toBe("result");

    const result = await sweepCodeLoopSandboxes(
      { workroot, retentionTtlMs: 1 },
      { now: () => Date.now() + 60_000, stopUnit: async () => {} }
    );
    expect(result.reclaimed).toBe(1);
    expect(getJobResult(started.work_id, workroot)).toEqual({
      kind: "terminal-unavailable",
      status: "completed",
    });
  });

  it.each(["deleted", "garbled", "forged"] as const)(
    "omitted client_run_id still has trusted expiry with %s agent-writable metadata",
    async (metadata) => {
      const started = await startCodeLoop(
        {
          instruction: "finish",
          files: [{ path: "a.ts", content: "export const x = 1;\n" }],
        },
        startCfg(),
        fakeDeps()
      );
      if (!started.ok) throw new Error("start failed");
      await waitForTerminal(started.work_id);
      const sandbox = readdirSync(workroot).find((name) => name.startsWith(`${started.work_id}-`));
      if (sandbox === undefined) throw new Error("sandbox missing");
      const metaPath = join(workroot, sandbox, ".meta.json");
      if (metadata === "deleted") unlinkSync(metaPath);
      else if (metadata === "garbled") writeFileSync(metaPath, "{not-json");
      else writeFileSync(metaPath, JSON.stringify({
        work_id: started.work_id,
        status: "completed",
        scope_unit: `code-loop-${started.work_id}`,
        model: "forged",
        started_at_ms: Date.now() + 365 * 24 * 60 * 60 * 1000,
      }));

      const result = await sweepCodeLoopSandboxes(
        { workroot, retentionTtlMs: 1 },
        { now: () => Date.now() + 60_000, stopUnit: async () => {} }
      );
      expect(result.reclaimed).toBe(1);
      expect(existsSync(join(workroot, sandbox))).toBe(false);
      expect(getJobResult(started.work_id, workroot)).toEqual({ kind: "terminal-unavailable", status: "completed" });
    }
  );

  it("compacts durable and in-memory results even when the entire sandbox was deleted", async () => {
    const started = await startCodeLoop(
      {
        client_run_id: "ttl-deleted-sandbox",
        instruction: "finish",
        files: [{ path: "a.ts", content: "export const x = 1;\n" }],
      },
      startCfg(),
      fakeDeps()
    );
    if (!started.ok) throw new Error("start failed");
    await waitForTerminal(started.work_id);
    const sandbox = readdirSync(workroot).find((name) => name.startsWith(`${started.work_id}-`));
    if (sandbox === undefined) throw new Error("sandbox missing");
    rmSync(join(workroot, sandbox), { recursive: true, force: true });

    const result = await sweepCodeLoopSandboxes(
      { workroot, retentionTtlMs: 1 },
      { now: () => Date.now() + 60_000, stopUnit: async () => {} }
    );
    expect(result.reclaimed).toBe(0);
    expect(getJobResult(started.work_id, workroot)).toEqual({ kind: "terminal-unavailable", status: "completed" });
  });
});
