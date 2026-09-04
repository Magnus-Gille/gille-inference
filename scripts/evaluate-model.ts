#!/usr/bin/env tsx
/**
 * evaluate-model.ts — manually initiated, maintenance-protected model evaluation.
 *
 * This is the retained evaluation path after the weekly discovery and automatic roster-promotion
 * jobs were retired. The operator must name an already-staged GGUF and its durable model id. The
 * artifact is evaluated by an ephemeral llama-server, and the content-blind result is appended to
 * the historical model-evaluation registry. This script never downloads, moves, deletes, serves,
 * or promotes a model.
 *
 * USAGE
 *   npx tsx scripts/evaluate-model.ts --evaluation-id <opaque-id> --model-id <org/model> --gguf <path> [--quant <label>]
 *   npx tsx scripts/evaluate-model.ts --evaluation-id <opaque-id> --model-id <org/model> --gguf <path> --dry-run
 *   npx tsx scripts/evaluate-model.ts --registry-verify-only
 *
 * ENV (all optional)
 *   MODELS_DIR                 /home/magnus/models
 *   EVAL_MODEL_PORT             9099
 *   EVAL_MODEL_CTX              8192
 *   EVAL_MODEL_REPEATS         1
 *   EVAL_MODEL_REGISTRY        ./data/model-scout-registry.jsonl (historic path)
 *   EVAL_MODEL_IDENTITY        stable opaque identity reused only for an exact retry
 *   LLAMA_SERVER_BIN            /home/magnus/llama.cpp/build/bin/llama-server
 *   LLAMASWAP_URL               http://127.0.0.1:8091
 *   M5_MAINTENANCE_KEY           owner/admin gateway key (never inherited by llama-server)
 *   EVAL_MODEL_GATEWAY_URL      gateway admin URL
 *   EVAL_MODEL_MAINTENANCE_TTL_S 7200
 *   EVAL_MODEL_MAINTENANCE_DRAIN_TIMEOUT_S 60
 */
import { spawn } from "node:child_process";
import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative } from "node:path";
import { pathToFileURL } from "node:url";

import { makeChatFn, runProbes } from "../src/homeserver/probe-runner.js";
import {
  DEFAULT_REGISTRY_PATH,
  appendEntry,
  preflightRegistry,
  verifyRegistryAppendability,
} from "../src/homeserver/model-registry.js";
import { PROBES, PROBE_BATTERY_VERSION, CORPUS_FINGERPRINT } from "../src/homeserver/probes.js";
import type { ProbeRunSummary, RegistryEntry, ScoutVerdict } from "../src/homeserver/scout-types.js";
import {
  evaluateScoutGate,
  loadScoutGateConfig,
  misconfigFlags,
  reviewQualityFlags,
  servingConfigFlags,
} from "../src/homeserver/scout-gate.js";
import {
  childEnvironmentWithoutMaintenanceKey,
  runMaintenanceWindowCommand,
  type MaintenanceWindowClientDependencies,
  type MaintenanceWindowClientEvidence,
  type MaintenanceWindowOpeningEvidence,
  type MaintenanceWindowClientPlan,
} from "../src/homeserver/maintenance-window-client.js";

const DEFAULT_MODELS_DIR = "/home/magnus/models";
const DEFAULT_LLAMA_SERVER_BIN = "/home/magnus/llama.cpp/build/bin/llama-server";
const DEFAULT_GATEWAY_URL = "http://127.0.0.1:8080";
const DEFAULT_PORT = 9099;
const DEFAULT_CTX = 8192;
const DEFAULT_REPEATS = 1;
const DEFAULT_MAINTENANCE_TTL_S = 7200;
const DEFAULT_MAINTENANCE_DRAIN_TIMEOUT_S = 60;
const EVALUATION_CLEANUP_RESERVE_S = 320;
const RESIDENCY_RESTORE_TIMEOUT_MS = 300_000;

const PORT = Number(process.env["EVAL_MODEL_PORT"] ?? DEFAULT_PORT);
const CTX = Number(process.env["EVAL_MODEL_CTX"] ?? DEFAULT_CTX);
const REPEATS = Number(process.env["EVAL_MODEL_REPEATS"] ?? DEFAULT_REPEATS);
const BIN = process.env["LLAMA_SERVER_BIN"] ?? DEFAULT_LLAMA_SERVER_BIN;
const LLAMASWAP_URL = (process.env["LLAMASWAP_URL"] ?? "http://127.0.0.1:8091").replace(/\/$/, "");
const REGISTRY = process.env["EVAL_MODEL_REGISTRY"] ?? DEFAULT_REGISTRY_PATH;
const MAINTENANCE_KEY = process.env["M5_MAINTENANCE_KEY"] ?? "";
const GATEWAY_URL = (process.env["EVAL_MODEL_GATEWAY_URL"] ?? DEFAULT_GATEWAY_URL).replace(/\/$/, "");
const MAINTENANCE_TTL_S = Number(process.env["EVAL_MODEL_MAINTENANCE_TTL_S"] ?? DEFAULT_MAINTENANCE_TTL_S);
const MAINTENANCE_DRAIN_TIMEOUT_S = Number(
  process.env["EVAL_MODEL_MAINTENANCE_DRAIN_TIMEOUT_S"] ?? DEFAULT_MAINTENANCE_DRAIN_TIMEOUT_S,
);
const EVALUATION_ENDPOINT = `http://127.0.0.1:${PORT}/v1`;
const EVAL_GATE_CONFIG = loadScoutGateConfig();

const log = (message: string): void => console.log(`[model-evaluation ${new Date().toISOString()}] ${message}`);

function value(flag: string, args = process.argv.slice(2)): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const result = args[index + 1];
  return result && !result.startsWith("--") ? result : undefined;
}

function isGguf(path: string): boolean {
  const fd = openSync(path, "r");
  try {
    const header = Buffer.alloc(4);
    readSync(fd, header, 0, 4, 0);
    return header.toString("ascii") === "GGUF";
  } finally {
    closeSync(fd);
  }
}

export interface ManualEvaluationCandidate {
  evaluationId: string;
  id: string;
  quant: string;
  sizeGB: number;
  sharded: boolean;
  artifactPath: string;
  artifactDir: string;
}

/** Validate an explicitly selected artifact and keep it inside the configured model root. */
export function manualCandidateForArtifact(input: {
  evaluationId: string;
  modelId: string;
  quant: string;
  artifactPath: string;
  modelsDir: string;
  sizeBytes: number;
}): ManualEvaluationCandidate {
  const evaluationId = input.evaluationId.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(evaluationId)) {
    throw new Error("--evaluation-id must be 8-128 characters using only letters, digits, '.', '_', ':' or '-'");
  }
  const id = input.modelId.trim();
  if (!id) throw new Error("--model-id is required");
  const rel = relative(input.modelsDir, input.artifactPath);
  if (!rel || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
    throw new Error(`evaluation artifact is outside configured model root: ${input.artifactPath}`);
  }
  if (!Number.isFinite(input.sizeBytes) || input.sizeBytes <= 0) {
    throw new Error(`evaluation artifact has invalid size: ${input.sizeBytes}`);
  }
  return {
    evaluationId,
    id,
    quant: input.quant.trim() || "LOCAL",
    sizeGB: Math.round((input.sizeBytes / 1024 ** 3) * 100) / 100,
    sharded: false,
    artifactPath: input.artifactPath,
    artifactDir: dirname(input.artifactPath),
  };
}

export function decideVerdict(summary: ProbeRunSummary): ScoutVerdict {
  if (summary.passRate >= 0.7 && (summary.avgTokPerSec ?? 0) >= 15) return "winner";
  if (summary.passRate >= 0.5) return "interesting";
  return "skip";
}

function evalServingConfig(): { ctx: number; repeats: number; ngl: number; flashAttn: string } {
  return { ctx: CTX, repeats: REPEATS, ngl: 99, flashAttn: "on" };
}

/** Build the durable content-blind registry row. `served` is always false here. */
export function buildRegistryEntry(
  candidate: ManualEvaluationCandidate,
  verdict: ScoutVerdict,
  summary: ProbeRunSummary | null
): RegistryEntry {
  const scoresByTaskType: Record<string, number> = {};
  for (const task of summary?.byTaskType ?? []) {
    scoresByTaskType[task.taskType] = Math.round(task.passRate * 1000) / 1000;
  }
  const servingConfig = summary ? evalServingConfig() : undefined;
  const gate = evaluateScoutGate({ id: candidate.id, scoresByTaskType }, EVAL_GATE_CONFIG);
  const gateFlags = [
    "manual-evaluation-only",
    ...gate.flags,
    ...(summary ? misconfigFlags(summary, EVAL_GATE_CONFIG) : []),
    ...(summary?.reviewMetrics ? reviewQualityFlags(summary.reviewMetrics, EVAL_GATE_CONFIG) : []),
    ...(summary ? servingConfigFlags({ evalServingConfig: servingConfig }) : []),
  ];
  const totalRuns = summary?.totalRuns ?? 0;
  const errors = summary?.error ?? 0;
  const emptyOutputs = summary?.emptyOutputs ?? 0;
  const truncations = summary?.truncations ?? 0;
  return {
    evaluationId: candidate.evaluationId,
    id: candidate.id,
    quant: candidate.quant,
    sizeGB: candidate.sizeGB,
    evaluatedAt: new Date().toISOString(),
    verdict,
    passRate: summary ? Math.round(summary.passRate * 1000) / 1000 : 0,
    avgTokPerSec: summary?.avgTokPerSec ?? null,
    scoresByTaskType,
    probeBatteryVersion: PROBE_BATTERY_VERSION,
    corpusFingerprint: CORPUS_FINGERPRINT,
    ...(summary
      ? {
          evalServingConfig: servingConfig,
          probeErrors: errors,
          probeTotalRuns: totalRuns,
          probeErrorRate: totalRuns > 0 ? Math.round((errors / totalRuns) * 1000) / 1000 : 0,
          probeEmptyOutputs: emptyOutputs,
          probeEmptyOutputRate: totalRuns > 0 ? Math.round((emptyOutputs / totalRuns) * 1000) / 1000 : 0,
          probeTruncations: truncations,
          probeTruncationRate: totalRuns > 0 ? Math.round((truncations / totalRuns) * 1000) / 1000 : 0,
          probeFinishReasons: summary.finishReasons,
          ...(summary.reviewMetrics
            ? {
                codeReviewSeededBugs: summary.reviewMetrics.seededBugs,
                codeReviewTruePositives: summary.reviewMetrics.truePositives,
                codeReviewReportedFindings: summary.reviewMetrics.reportedFindings,
                codeReviewCleanControls: summary.reviewMetrics.cleanControls,
                codeReviewConfabulatedCleanControls: summary.reviewMetrics.confabulatedCleanControls,
                codeReviewRecall: Math.round(summary.reviewMetrics.recall * 1000) / 1000,
                codeReviewPrecision: Math.round(summary.reviewMetrics.precision * 1000) / 1000,
                codeReviewCleanConfabulationRate: Math.round(summary.reviewMetrics.cleanConfabulationRate * 1000) / 1000,
              }
            : {}),
        }
      : {}),
    served: false,
    ggufDir: candidate.artifactDir,
    ggufPath: candidate.artifactPath,
    sharded: candidate.sharded,
    notes: "manual evaluation; no automatic roster mutation",
    gateFlags,
  };
}

async function portInUse(signal?: AbortSignal): Promise<boolean> {
  try {
    const timeout = AbortSignal.timeout(2_000);
    await fetch(`http://127.0.0.1:${PORT}/health`, {
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    return true;
  } catch (error) {
    signal?.throwIfAborted();
    void error;
    return false;
  }
}

interface QuiesceDependencies {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  baseUrl?: string;
  timeoutMs?: number;
}

/** Unload llama-swap and prove the serial GPU has no resident model before direct llama-server. */
export async function quiesceLlamaSwapForEvaluation(
  signal: AbortSignal,
  deps: QuiesceDependencies = {},
): Promise<void> {
  const fetchImpl = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((resolvePromise) => setTimeout(resolvePromise, ms)));
  const now = deps.now ?? Date.now;
  const baseUrl = (deps.baseUrl ?? LLAMASWAP_URL).replace(/\/$/, "");
  const deadline = now() + (deps.timeoutMs ?? 60_000);
  const unloadSignal = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
  const response = await fetchImpl(`${baseUrl}/api/models/unload`, { method: "POST", signal: unloadSignal });
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 200);
    throw new Error(`llama-swap unload failed: HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
  }
  while (true) {
    signal.throwIfAborted();
    const runningResponse = await fetchImpl(`${baseUrl}/running`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
    });
    if (!runningResponse.ok) throw new Error(`cannot verify llama-swap residency after unload: HTTP ${runningResponse.status}`);
    const body = await runningResponse.json().catch(() => null) as { running?: unknown } | null;
    if (!Array.isArray(body?.running)) throw new Error("cannot verify llama-swap residency after unload: malformed /running response");
    if (body.running.length === 0) return;
    if (now() >= deadline) throw new Error(`llama-swap still reports ${body.running.length} resident model(s) after unload`);
    await sleep(250);
  }
}

async function restoreRunningModels(
  runningModels: MaintenanceWindowOpeningEvidence["runningModels"],
  signal: AbortSignal,
): Promise<void> {
  const readyModels = runningModels.filter((entry) => entry.state === "ready");
  if (readyModels.length === 0) return;
  if (readyModels.length > 1) {
    throw new Error(`cannot restore ambiguous serial-GPU residency (${readyModels.length} ready models)`);
  }
  const model = readyModels[0]!.model;
  const response = await fetch(`${LLAMASWAP_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "Reply with exactly OK." }],
      max_tokens: 2,
      temperature: 0,
    }),
    signal,
  });
  if (!response.ok) throw new Error(`failed to restore resident model ${model}: HTTP ${response.status}`);
  log(`restored pre-evaluation resident model ${model}`);
}

async function waitHealthy(timeoutMs: number, signal: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/health`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(4_000)]),
      })).ok) return true;
    } catch (error) {
      signal.throwIfAborted();
      void error;
      // The ephemeral server is still starting.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
  }
  return false;
}

/** Convert child-process spawn errors into ordinary promise failures before any probe work starts. */
export function waitForChildSpawn(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise<void>((resolvePromise, reject) => {
    const spawned = (): void => { child.removeListener("error", failed); resolvePromise(); };
    const failed = (error: Error): void => { child.removeListener("spawn", spawned); reject(error); };
    child.once("spawn", spawned);
    child.once("error", failed);
  });
}

async function evaluate(candidate: ManualEvaluationCandidate, windowSignal: AbortSignal): Promise<RegistryEntry> {
  const localAbort = new AbortController();
  const signal = AbortSignal.any([windowSignal, localAbort.signal]);
  let child: ReturnType<typeof spawn> | undefined;
  let childSpawned = false;
  try {
    if (await portInUse(signal)) throw new Error(`evaluation port ${PORT} is already in use`);
    await quiesceLlamaSwapForEvaluation(signal);
    signal.throwIfAborted();

    log(`launching ephemeral llama-server for ${candidate.id} on :${PORT}`);
    child = spawn(
      BIN,
      ["--host", "127.0.0.1", "--port", String(PORT), "-m", candidate.artifactPath, "-ngl", "99", "-ub", "512", "-c", String(CTX), "--jinja", "-fa", "on"],
      { stdio: "ignore", env: childEnvironmentWithoutMaintenanceKey(process.env) }
    );
    await waitForChildSpawn(child);
    childSpawned = true;
    child.once("error", (error) => localAbort.abort(error));
    if (!(await waitHealthy(300_000, signal))) {
      log("ephemeral server did not become healthy");
      return buildRegistryEntry(candidate, "load_failed", null);
    }
    log(`healthy — running ${PROBES.length} probes × ${REPEATS}`);
    const summary = await runProbes({
      model: candidate.id,
      endpoint: EVALUATION_ENDPOINT,
      probes: PROBES,
      repeats: REPEATS,
      chat: makeChatFn({ endpoint: EVALUATION_ENDPOINT, apiKey: "", signal }),
      signal,
    });
    const verdict = decideVerdict(summary);
    const entry = buildRegistryEntry(candidate, verdict, summary);
    log(`verdict: ${verdict} (pass ${(summary.passRate * 100).toFixed(0)}%, ${summary.avgTokPerSec ?? "—"} tok/s); registry only, no roster mutation`);
    return entry;
  } finally {
    if (child && childSpawned) {
      child.kill("SIGTERM");
      await new Promise<void>((resolvePromise) => {
        if (child!.exitCode !== null || child!.signalCode !== null) {
          resolvePromise();
          return;
        }
        const timer = setTimeout(() => {
          child!.kill("SIGKILL");
          resolvePromise();
        }, 3_000);
        child!.once("exit", () => {
          clearTimeout(timer);
          resolvePromise();
        });
      });
    }
  }
}

type RunWindow = (
  plan: MaintenanceWindowClientPlan,
  deps: MaintenanceWindowClientDependencies,
) => Promise<MaintenanceWindowClientEvidence>;

export interface ProtectedEvaluationDependencies {
  apiKey: string;
  baseUrl: string;
  ttlSeconds: number;
  drainTimeoutSeconds: number;
  evaluate?: (candidate: ManualEvaluationCandidate, signal: AbortSignal) => Promise<RegistryEntry>;
  append?: (entry: RegistryEntry) => void;
  preflight?: () => void;
  restore?: (
    runningModels: MaintenanceWindowOpeningEvidence["runningModels"],
    signal: AbortSignal,
  ) => Promise<void>;
  runWindow?: RunWindow;
  /** Injectable cancellation used by deterministic lifecycle tests; production also traps OS signals. */
  terminationSignal?: AbortSignal;
}

/** Hold the server-owned exclusive lease until both evaluation and durable evidence append finish. */
export async function runProtectedEvaluation(
  candidate: ManualEvaluationCandidate,
  deps: ProtectedEvaluationDependencies,
): Promise<RegistryEntry> {
  if (!deps.apiKey.trim()) throw new Error("M5_MAINTENANCE_KEY is required for manual model evaluation");
  const preflight = deps.preflight ?? (() => preflightRegistry(REGISTRY));
  preflight();
  const evaluateCandidate = deps.evaluate ?? evaluate;
  const append = deps.append ?? ((entry: RegistryEntry) => appendEntry(entry, REGISTRY));
  const restore = deps.restore ?? restoreRunningModels;
  const runWindow = deps.runWindow ?? runMaintenanceWindowCommand;
  let entry: RegistryEntry | undefined;
  const terminationAbort = new AbortController();
  const abortForSignal = (signal: NodeJS.Signals): void => {
    terminationAbort.abort(new Error(`model evaluation interrupted by ${signal}`));
  };
  const effectiveTerminationSignal = deps.terminationSignal
    ? AbortSignal.any([terminationAbort.signal, deps.terminationSignal])
    : terminationAbort.signal;
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, abortForSignal);

  try {
    const evidence = await runWindow(
      {
        baseUrl: deps.baseUrl,
        ttlSeconds: deps.ttlSeconds,
        drainTimeoutSeconds: deps.drainTimeoutSeconds,
        abortBeforeExpirySeconds: EVALUATION_CLEANUP_RESERVE_S,
        // The shared window client requires a non-empty command label. This callback runs in-process
        // so the opaque release token never enters argv, env, or the llama-server child.
        command: ["manual-model-evaluation"],
      },
      {
        fetch,
        apiKey: deps.apiKey,
        signal: effectiveTerminationSignal,
        runChild: async (_command, opened, windowSignal) => {
          const workSignal = AbortSignal.any([windowSignal, effectiveTerminationSignal]);
          let evaluationError: unknown;
          try {
            entry = await evaluateCandidate(candidate, workSignal);
            append(entry);
          } catch (error) {
            evaluationError = error;
          }
          let restoreError: unknown;
          try {
            // Do not let a second operator signal or the probe-work deadline cancel restoration.
            // The hard cleanup timeout fits inside EVALUATION_CLEANUP_RESERVE_S with room for
            // child SIGKILL fallback and the two loopback close/status requests.
            await restore(opened.runningModels, AbortSignal.timeout(RESIDENCY_RESTORE_TIMEOUT_MS));
          } catch (error) {
            restoreError = error;
          }
          if (evaluationError === undefined && effectiveTerminationSignal.aborted) {
            evaluationError = effectiveTerminationSignal.reason;
          }
          if (evaluationError !== undefined && restoreError !== undefined) {
            throw new AggregateError([evaluationError, restoreError], "model evaluation and required residency restoration both failed");
          }
          if (evaluationError !== undefined) throw evaluationError;
          if (restoreError !== undefined) throw restoreError;
          return 0;
        },
      },
    );
    effectiveTerminationSignal.throwIfAborted();
    if (evidence.childExitCode !== 0 || entry === undefined) {
      throw new Error(`manual model evaluation did not complete inside the exclusive window (exit ${evidence.childExitCode})`);
    }
    return entry;
  } finally {
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      process.removeListener(signal, abortForSignal);
    }
  }
}

function resolveCandidate(args: string[]): ManualEvaluationCandidate {
  const configuredPath = value("--gguf", args) ?? process.env["EVAL_MODEL_GGUF"];
  const modelId = value("--model-id", args) ?? process.env["EVAL_MODEL_ID"] ?? "";
  const evaluationId = value("--evaluation-id", args) ?? process.env["EVAL_MODEL_IDENTITY"] ?? "";
  if (!configuredPath) throw new Error("usage: evaluate-model --evaluation-id <opaque-id> --model-id <org/model> --gguf <path> [--quant <label>]");
  const artifactPath = realpathSync(configuredPath);
  const modelsDir = realpathSync(process.env["MODELS_DIR"] ?? DEFAULT_MODELS_DIR);
  const stat = statSync(artifactPath);
  if (!stat.isFile() || !isGguf(artifactPath)) throw new Error(`--gguf is not a regular GGUF file: ${artifactPath}`);
  return manualCandidateForArtifact({
    evaluationId,
    modelId,
    quant: value("--quant", args) ?? process.env["EVAL_MODEL_QUANT"] ?? "LOCAL",
    artifactPath,
    modelsDir,
    sizeBytes: stat.size,
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--registry-verify-only")) {
    verifyRegistryAppendability(REGISTRY);
    console.log(JSON.stringify({ registry: REGISTRY, appendable: true, runtimeUid: process.getuid?.() ?? null }));
    return;
  }
  const candidate = resolveCandidate(args);
  if (args.includes("--dry-run")) {
    console.log(JSON.stringify({ dryRun: true, candidate, maintenanceRequired: true, mutation: "registry append only" }, null, 2));
    return;
  }

  const entry = await runProtectedEvaluation(candidate, {
    apiKey: MAINTENANCE_KEY,
    baseUrl: GATEWAY_URL,
    ttlSeconds: Number.isFinite(MAINTENANCE_TTL_S) && MAINTENANCE_TTL_S > 0
      ? MAINTENANCE_TTL_S
      : DEFAULT_MAINTENANCE_TTL_S,
    drainTimeoutSeconds: Number.isFinite(MAINTENANCE_DRAIN_TIMEOUT_S) && MAINTENANCE_DRAIN_TIMEOUT_S > 0
      ? MAINTENANCE_DRAIN_TIMEOUT_S
      : DEFAULT_MAINTENANCE_DRAIN_TIMEOUT_S,
  });
  console.log(JSON.stringify({ model: entry.id, verdict: entry.verdict, registry: REGISTRY, served: false, gateFlags: entry.gateFlags }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    process.exit(1);
  });
}
