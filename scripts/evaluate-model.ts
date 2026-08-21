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
 *   npx tsx scripts/evaluate-model.ts --model-id <org/model> --gguf <path> [--quant <label>]
 *   npx tsx scripts/evaluate-model.ts --model-id <org/model> --gguf <path> --dry-run
 *
 * ENV (all optional)
 *   MODELS_DIR                 /home/magnus/models
 *   EVAL_MODEL_PORT             9099
 *   EVAL_MODEL_CTX              8192
 *   EVAL_MODEL_REPEATS         1
 *   EVAL_MODEL_REGISTRY        ./data/model-scout-registry.jsonl (historic path)
 *   LLAMA_SERVER_BIN            /home/magnus/llama.cpp/build/bin/llama-server
 *   LLAMASWAP_URL               http://127.0.0.1:8091
 *   EVAL_MODEL_UNLOAD_FIRST     1
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
import { DEFAULT_REGISTRY_PATH, appendEntry } from "../src/homeserver/model-registry.js";
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

const PORT = Number(process.env["EVAL_MODEL_PORT"] ?? DEFAULT_PORT);
const CTX = Number(process.env["EVAL_MODEL_CTX"] ?? DEFAULT_CTX);
const REPEATS = Number(process.env["EVAL_MODEL_REPEATS"] ?? DEFAULT_REPEATS);
const BIN = process.env["LLAMA_SERVER_BIN"] ?? DEFAULT_LLAMA_SERVER_BIN;
const LLAMASWAP_URL = (process.env["LLAMASWAP_URL"] ?? "http://127.0.0.1:8091").replace(/\/$/, "");
const REGISTRY = process.env["EVAL_MODEL_REGISTRY"] ?? DEFAULT_REGISTRY_PATH;
const UNLOAD_FIRST = process.env["EVAL_MODEL_UNLOAD_FIRST"] !== "0";
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
  id: string;
  quant: string;
  sizeGB: number;
  sharded: boolean;
  artifactPath: string;
  artifactDir: string;
}

/** Validate an explicitly selected artifact and keep it inside the configured model root. */
export function manualCandidateForArtifact(input: {
  modelId: string;
  quant: string;
  artifactPath: string;
  modelsDir: string;
  sizeBytes: number;
}): ManualEvaluationCandidate {
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

async function portInUse(): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(2_000) });
    return true;
  } catch {
    return false;
  }
}

async function unloadLlamaSwap(): Promise<void> {
  try {
    await fetch(`${LLAMASWAP_URL}/api/models/unload`, { method: "POST", signal: AbortSignal.timeout(15_000) });
  } catch {
    log("llama-swap unload did not respond; continuing with the explicit evaluation guard");
  }
}

async function restoreRunningModels(
  runningModels: MaintenanceWindowOpeningEvidence["runningModels"],
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
    signal: AbortSignal.timeout(300_000),
  });
  if (!response.ok) throw new Error(`failed to restore resident model ${model}: HTTP ${response.status}`);
  log(`restored pre-evaluation resident model ${model}`);
}

async function waitHealthy(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(4_000) })).ok) return true;
    } catch {
      // The ephemeral server is still starting.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
  }
  return false;
}

async function evaluate(candidate: ManualEvaluationCandidate): Promise<RegistryEntry> {
  if (await portInUse()) throw new Error(`evaluation port ${PORT} is already in use`);
  if (UNLOAD_FIRST) await unloadLlamaSwap();

  log(`launching ephemeral llama-server for ${candidate.id} on :${PORT}`);
  const child = spawn(
    BIN,
    ["--host", "127.0.0.1", "--port", String(PORT), "-m", candidate.artifactPath, "-ngl", "99", "-ub", "512", "-c", String(CTX), "--jinja", "-fa", "on"],
    { stdio: "ignore", env: childEnvironmentWithoutMaintenanceKey(process.env) }
  );
  const forwardSignal = (signal: NodeJS.Signals): void => {
    if (!child.killed) child.kill(signal);
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, forwardSignal);
  try {
    if (!(await waitHealthy(300_000))) {
      log("ephemeral server did not become healthy");
      return buildRegistryEntry(candidate, "load_failed", null);
    }
    log(`healthy — running ${PROBES.length} probes × ${REPEATS}`);
    const summary = await runProbes({
      model: candidate.id,
      endpoint: EVALUATION_ENDPOINT,
      probes: PROBES,
      repeats: REPEATS,
      chat: makeChatFn({ endpoint: EVALUATION_ENDPOINT, apiKey: "" }),
    });
    const verdict = decideVerdict(summary);
    const entry = buildRegistryEntry(candidate, verdict, summary);
    log(`verdict: ${verdict} (pass ${(summary.passRate * 100).toFixed(0)}%, ${summary.avgTokPerSec ?? "—"} tok/s); registry only, no roster mutation`);
    return entry;
  } finally {
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      process.removeListener(signal, forwardSignal);
    }
    child.kill("SIGTERM");
    await new Promise<void>((resolvePromise) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolvePromise();
        return;
      }
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolvePromise();
      }, 3_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolvePromise();
      });
    });
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
  evaluate?: (candidate: ManualEvaluationCandidate) => Promise<RegistryEntry>;
  append?: (entry: RegistryEntry) => void;
  restore?: (runningModels: MaintenanceWindowOpeningEvidence["runningModels"]) => Promise<void>;
  runWindow?: RunWindow;
}

/** Hold the server-owned exclusive lease until both evaluation and durable evidence append finish. */
export async function runProtectedEvaluation(
  candidate: ManualEvaluationCandidate,
  deps: ProtectedEvaluationDependencies,
): Promise<RegistryEntry> {
  const evaluateCandidate = deps.evaluate ?? evaluate;
  const append = deps.append ?? ((entry: RegistryEntry) => appendEntry(entry, REGISTRY));
  const restore = deps.restore ?? restoreRunningModels;
  const runWindow = deps.runWindow ?? runMaintenanceWindowCommand;
  let entry: RegistryEntry | undefined;

  const evidence = await runWindow(
    {
      baseUrl: deps.baseUrl,
      ttlSeconds: deps.ttlSeconds,
      drainTimeoutSeconds: deps.drainTimeoutSeconds,
      // The shared window client requires a non-empty command label. This callback runs in-process
      // so the opaque release token never enters argv, env, or the llama-server child.
      command: ["manual-model-evaluation"],
    },
    {
      fetch,
      apiKey: deps.apiKey,
      runChild: async (_command, opened) => {
        let evaluationError: unknown;
        try {
          entry = await evaluateCandidate(candidate);
          append(entry);
        } catch (error) {
          evaluationError = error;
        }
        let restoreError: unknown;
        try {
          await restore(opened.runningModels);
        } catch (error) {
          restoreError = error;
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
  if (evidence.childExitCode !== 0 || entry === undefined) {
    throw new Error(`manual model evaluation did not complete inside the exclusive window (exit ${evidence.childExitCode})`);
  }
  return entry;
}

function resolveCandidate(args: string[]): ManualEvaluationCandidate {
  const configuredPath = value("--gguf", args) ?? process.env["EVAL_MODEL_GGUF"];
  const modelId = value("--model-id", args) ?? process.env["EVAL_MODEL_ID"] ?? "";
  if (!configuredPath) throw new Error("usage: evaluate-model --model-id <org/model> --gguf <path> [--quant <label>]");
  const artifactPath = realpathSync(configuredPath);
  const modelsDir = realpathSync(process.env["MODELS_DIR"] ?? DEFAULT_MODELS_DIR);
  const stat = statSync(artifactPath);
  if (!stat.isFile() || !isGguf(artifactPath)) throw new Error(`--gguf is not a regular GGUF file: ${artifactPath}`);
  return manualCandidateForArtifact({
    modelId,
    quant: value("--quant", args) ?? process.env["EVAL_MODEL_QUANT"] ?? "LOCAL",
    artifactPath,
    modelsDir,
    sizeBytes: stat.size,
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
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
