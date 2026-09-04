import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import type { ProbeRunSummary } from "../src/homeserver/scout-types.js";
import {
  buildRegistryEntry,
  decideVerdict,
  manualCandidateForArtifact,
  quiesceLlamaSwapForEvaluation,
  runProtectedEvaluation,
  waitForChildSpawn,
} from "../scripts/evaluate-model.js";

const summary = (passRate: number, tokPerSec: number | null): ProbeRunSummary => ({
  model: "manual/model",
  endpoint: "http://127.0.0.1:9099/v1",
  totalRuns: 10,
  pass: Math.round(passRate * 10),
  partial: 0,
  fail: 10 - Math.round(passRate * 10),
  error: 0,
  passRate,
  avgTokPerSec: tokPerSec,
  emptyOutputs: 0,
  truncations: 0,
  finishReasons: { stop: 10 },
  byTaskType: [],
  results: [],
});
describe("manual model evaluation", () => {
  it("keeps the explicit evaluation path bounded to an existing local artifact", () => {
    const candidate = manualCandidateForArtifact({
      evaluationId: "manual-eval-muse-1",
      modelId: "meta/Muse-Glimmer-30B",
      quant: "KQ_DYNAMIC",
      artifactPath: "/home/magnus/models/muse/muse.gguf",
      modelsDir: "/home/magnus/models",
      sizeBytes: 19_653_957_984,
    });
    expect(candidate).toMatchObject({
      evaluationId: "manual-eval-muse-1",
      id: "meta/Muse-Glimmer-30B",
      quant: "KQ_DYNAMIC",
      sizeGB: 18.3,
      sharded: false,
    });
  });

  it("rejects an artifact outside the configured model root", () => {
    expect(() => manualCandidateForArtifact({
      evaluationId: "manual-eval-muse-1",
      modelId: "meta/Muse-Glimmer-30B",
      quant: "KQ_DYNAMIC",
      artifactPath: "/tmp/muse.gguf",
      modelsDir: "/home/magnus/models",
      sizeBytes: 1,
    })).toThrow(/outside configured model root/i);
  });

  it("uses measured thresholds only for a registry verdict", () => {
    expect(decideVerdict(summary(0.8, 30))).toBe("winner");
    expect(decideVerdict(summary(0.6, 30))).toBe("interesting");
    expect(decideVerdict(summary(0.8, 10))).toBe("interesting");
  });

  it("writes evidence as manual-only and never as served", () => {
    const candidate = manualCandidateForArtifact({
      evaluationId: "manual-eval-muse-1",
      modelId: "meta/Muse-Glimmer-30B",
      quant: "KQ_DYNAMIC",
      artifactPath: "/home/magnus/models/muse/muse.gguf",
      modelsDir: "/home/magnus/models",
      sizeBytes: 19_653_957_984,
    });
    const entry = buildRegistryEntry(candidate, "winner", summary(0.8, 30));
    expect(entry.evaluationId).toBe("manual-eval-muse-1");
    expect(entry.served).toBe(false);
    expect(entry.notes).toMatch(/no automatic roster mutation/i);
    expect(entry.gateFlags).toContain("manual-evaluation-only");
  });

  it("holds an exclusive token-scoped window through evaluation and registry append", async () => {
    const candidate = manualCandidateForArtifact({
      evaluationId: "manual-eval-protected-1",
      modelId: "manual/model",
      quant: "Q4_K_M",
      artifactPath: "/home/magnus/models/manual/model.gguf",
      modelsDir: "/home/magnus/models",
      sizeBytes: 1024,
    });
    const events: string[] = [];
    const expectedEntry = buildRegistryEntry(candidate, "winner", summary(0.8, 30));

    const entry = await runProtectedEvaluation(candidate, {
      apiKey: "maintenance-key",
      baseUrl: "http://127.0.0.1:8080",
      ttlSeconds: 600,
      drainTimeoutSeconds: 5,
      preflight: () => events.push("preflight"),
      evaluate: async () => {
        events.push("evaluate");
        return expectedEntry;
      },
      append: (record) => {
        expect(record).toBe(expectedEntry);
        events.push("append");
      },
      restore: async (runningModels, signal) => {
        expect(runningModels).toEqual([{ model: "qwen36-a3b", state: "ready", ttlSeconds: 120 }]);
        expect(signal.aborted).toBe(false);
        events.push("restore");
      },
      runWindow: async (_plan, deps) => {
        expect(_plan.ttlSeconds).toBeGreaterThan(320);
        expect(_plan.abortBeforeExpirySeconds).toBe(320);
        expect(deps.apiKey).toBe("maintenance-key");
        expect(deps.signal?.aborted).toBe(false);
        events.push("open");
        const childExitCode = await deps.runChild(
          ["manual-model-evaluation"],
          {
            mode: "exclusive",
            startedAt: "2026-08-22T00:00:00.000Z",
            expiresAt: "2026-08-22T02:00:00.000Z",
            runningModels: [{ model: "qwen36-a3b", state: "ready", ttlSeconds: 120 }],
          },
          new AbortController().signal,
        );
        events.push("close");
        return {
          mode: "exclusive",
          startedAt: "2026-08-22T00:00:00.000Z",
          endedAt: "2026-08-22T00:00:01.000Z",
          childExitCode,
          restored: true,
          runningModels: [],
        };
      },
    });

    expect(entry).toBe(expectedEntry);
    expect(events).toEqual(["preflight", "open", "evaluate", "append", "restore", "close"]);
  });

  it("fails before opening the maintenance window when registry preflight fails", async () => {
    const candidate = manualCandidateForArtifact({
      evaluationId: "manual-eval-preflight-failure",
      modelId: "manual/model",
      quant: "Q4_K_M",
      artifactPath: "/home/magnus/models/manual/model.gguf",
      modelsDir: "/home/magnus/models",
      sizeBytes: 1024,
    });
    const events: string[] = [];
    await expect(runProtectedEvaluation(candidate, {
      apiKey: "maintenance-key",
      baseUrl: "http://127.0.0.1:8080",
      ttlSeconds: 600,
      drainTimeoutSeconds: 5,
      preflight: () => {
        events.push("preflight");
        throw new Error("registry preflight failed: cannot open target");
      },
      evaluate: async () => {
        events.push("evaluate");
        throw new Error("must not run");
      },
      runWindow: async () => {
        events.push("open");
        throw new Error("must not open");
      },
    })).rejects.toThrow(/registry preflight failed/i);
    expect(events).toEqual(["preflight"]);
  });

  it("fails closed before evaluation when no maintenance credential is available", async () => {
    const candidate = manualCandidateForArtifact({
      evaluationId: "manual-eval-no-key",
      modelId: "manual/model",
      quant: "Q4_K_M",
      artifactPath: "/home/magnus/models/manual/model.gguf",
      modelsDir: "/home/magnus/models",
      sizeBytes: 1024,
    });
    await expect(runProtectedEvaluation(candidate, {
      apiKey: "",
      baseUrl: "http://127.0.0.1:8080",
      ttlSeconds: 600,
      drainTimeoutSeconds: 5,
      evaluate: async () => { throw new Error("must not run"); },
      append: () => { throw new Error("must not append"); },
    })).rejects.toThrow(/M5_MAINTENANCE_KEY is required/);
  });

  it("restores prior residency before closing the window when evaluation fails", async () => {
    const candidate = manualCandidateForArtifact({
      evaluationId: "manual-eval-restore",
      modelId: "manual/model",
      quant: "Q4_K_M",
      artifactPath: "/home/magnus/models/manual/model.gguf",
      modelsDir: "/home/magnus/models",
      sizeBytes: 1024,
    });
    const events: string[] = [];
    await expect(runProtectedEvaluation(candidate, {
      apiKey: "maintenance-key",
      baseUrl: "http://127.0.0.1:8080",
      ttlSeconds: 600,
      drainTimeoutSeconds: 5,
      evaluate: async () => {
        events.push("evaluate-failed");
        throw new Error("probe failure");
      },
      append: () => { events.push("unexpected-append"); },
      restore: async () => { events.push("restore"); },
      runWindow: async (_plan, deps) => {
        events.push("open");
        try {
          await deps.runChild(
            ["manual-model-evaluation"],
            { mode: "exclusive", startedAt: "now", expiresAt: "later", runningModels: [] },
            new AbortController().signal,
          );
        } finally {
          events.push("close");
        }
        throw new Error("unreachable");
      },
    })).rejects.toThrow("probe failure");
    expect(events).toEqual(["open", "evaluate-failed", "restore", "close"]);
  });

  it("keeps signal ownership through restoration and closes before surfacing interruption", async () => {
    const candidate = manualCandidateForArtifact({
      evaluationId: "manual-eval-signal",
      modelId: "manual/model",
      quant: "Q4_K_M",
      artifactPath: "/home/magnus/models/manual/model.gguf",
      modelsDir: "/home/magnus/models",
      sizeBytes: 1024,
    });
    const events: string[] = [];
    const expectedEntry = buildRegistryEntry(candidate, "winner", summary(0.8, 30));
    const termination = new AbortController();
    let finishRestore!: () => void;
    const restoreGate = new Promise<void>((resolve) => { finishRestore = resolve; });
    const running = runProtectedEvaluation(candidate, {
      apiKey: "maintenance-key",
      baseUrl: "http://127.0.0.1:8080",
      ttlSeconds: 600,
      drainTimeoutSeconds: 5,
      evaluate: async () => expectedEntry,
      append: () => events.push("append"),
      terminationSignal: termination.signal,
      restore: async () => {
        events.push("restore-start");
        termination.abort(new Error("model evaluation interrupted by SIGTERM"));
        await restoreGate;
        events.push("restore-finish");
      },
      runWindow: async (_plan, deps) => {
        events.push("open");
        try {
          await deps.runChild(
            ["manual-model-evaluation"],
            {
              mode: "exclusive",
              startedAt: "now",
              expiresAt: "later",
              runningModels: [{ model: "qwen36-a3b", state: "ready", ttlSeconds: 120 }],
            },
            new AbortController().signal,
          );
        } finally {
          events.push("close");
        }
        throw new Error("unreachable");
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    finishRestore();
    await expect(running).rejects.toThrow(/interrupted by SIGTERM/);
    expect(events).toEqual(["open", "append", "restore-start", "restore-finish", "close"]);
  });

  it("refuses a failed llama-swap unload instead of starting a competing evaluator", async () => {
    const controller = new AbortController();
    await expect(quiesceLlamaSwapForEvaluation(controller.signal, {
      baseUrl: "http://llama-swap",
      fetch: async () => new Response("busy", { status: 503 }),
    })).rejects.toThrow(/unload failed: HTTP 503/);
  });

  it("waits until llama-swap proves residency is empty", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    const running = [
      { running: [{ model: "qwen36-a3b", state: "ready" }] },
      { running: [] },
    ];
    await quiesceLlamaSwapForEvaluation(controller.signal, {
      baseUrl: "http://llama-swap",
      sleep: async () => undefined,
      fetch: async (input, init) => {
        calls.push(`${init?.method ?? "GET"} ${String(input)}`);
        if (init?.method === "POST") return new Response("OK");
        return new Response(JSON.stringify(running.shift()), {
          headers: { "content-type": "application/json" },
        });
      },
    });
    expect(calls).toEqual([
      "POST http://llama-swap/api/models/unload",
      "GET http://llama-swap/running",
      "GET http://llama-swap/running",
    ]);
  });

  it("turns a missing llama-server binary spawn error into a caught failure", async () => {
    const child = new EventEmitter() as ChildProcess;
    const waiting = waitForChildSpawn(child);
    child.emit("error", new Error("spawn ENOENT"));
    await expect(waiting).rejects.toThrow("spawn ENOENT");
  });
});
