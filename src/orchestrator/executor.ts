import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { getDb } from "../db.js";
import { runInference } from "../runner/openrouter-client.js";
import { runLocalInference } from "../runner/local-client.js";
import type { CompoundTaskDefinition, SubTaskDefinition, SubTaskResult, StrategyConfig } from "./types.js";

// ─── Pricing lookup (USD per million tokens) ──────────────────────────────────
// Used to compute cost_usd for cloud sub-tasks.

const CLOUD_PRICING: Record<string, { input: number; output: number }> = {
  "anthropic/claude-opus-4-5": { input: 15.0, output: 75.0 },
  "anthropic/claude-sonnet-4-5": { input: 3.0, output: 15.0 },
  "anthropic/claude-haiku-4-5": { input: 0.8, output: 4.0 },
};

function estimateCost(modelId: string, promptTokens: number, completionTokens: number): number {
  const pricing = CLOUD_PRICING[modelId];
  if (!pricing) return 0;
  return (
    (promptTokens / 1_000_000) * pricing.input +
    (completionTokens / 1_000_000) * pricing.output
  );
}

// ─── Template injection ───────────────────────────────────────────────────────

/**
 * Replace {{<SUB_TASK_ID>_OUTPUT}} placeholders in a template string with actual
 * sub-task outputs. Sub-task IDs are normalised: dashes → underscores, uppercase.
 *
 * Example: "ct-001-a" → "CT_001_A_OUTPUT"
 */
function injectOutputs(template: string, outputs: Map<string, string>): string {
  let result = template;
  for (const [subTaskId, output] of outputs) {
    const placeholder = `{{${subTaskId.replace(/-/g, "_").toUpperCase()}_OUTPUT}}`;
    result = result.replaceAll(placeholder, output);
  }
  return result;
}

// ─── Single inference call ────────────────────────────────────────────────────

interface CallResult {
  ok: boolean;
  output: string;
  promptTokens: number;
  completionTokens: number;
  durationMs: number;
  errorMessage?: string;
}

async function callModel(
  modelId: string,
  provider: "openrouter" | "local",
  prompt: string,
  systemPrompt: string | undefined,
  maxTokens: number
): Promise<CallResult> {
  if (provider === "openrouter") {
    const result = await runInference(modelId, prompt, {
      systemPrompt,
      maxTokens,
      temperature: 0.0,
    });
    if (!result.ok) {
      return { ok: false, output: "", promptTokens: 0, completionTokens: 0, durationMs: 0, errorMessage: result.error };
    }
    return {
      ok: true,
      output: result.response,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      durationMs: result.durationMs,
    };
  } else {
    const result = await runLocalInference(modelId, prompt, {
      systemPrompt,
      maxTokens,
      temperature: 0.0,
    });
    if (!result.ok) {
      return { ok: false, output: "", promptTokens: 0, completionTokens: 0, durationMs: 0, errorMessage: result.error };
    }
    return {
      ok: true,
      output: result.response,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      durationMs: result.durationMs,
    };
  }
}

// ─── Main orchestration loop ──────────────────────────────────────────────────

export interface OrchestratorOptions {
  batchId: string;
  strategy: StrategyConfig;
  dryRun?: boolean;
  resume?: boolean;
  verbose?: boolean;
}

export interface OrchestratorResult {
  ok: boolean;
  orchestrationRunId: string;
  shadowRunId?: string;
  finalOutput?: string;
  totalCostUsd: number;
  totalDurationMs: number;
  errorMessage?: string;
}

/**
 * Execute a single compound task using the given strategy.
 * Returns after inserting the orchestration_run record and shadow run.
 */
export async function executeCompoundTask(
  task: CompoundTaskDefinition,
  options: OrchestratorOptions
): Promise<OrchestratorResult> {
  const { batchId, strategy, dryRun = false, resume = false, verbose = false } = options;
  const db = getDb();

  const executionModelId = strategy.executionModel.modelId;
  const orchestratorModelId = strategy.orchestratorModel.modelId;

  // ── Resume check ────────────────────────────────────────────────────────────
  if (resume) {
    const existing = db
      .prepare<[string, string, string, string]>(
        `SELECT id, shadow_run_id, status FROM orchestration_runs
         WHERE batch_id = ? AND compound_task_id = ? AND strategy_id = ? AND execution_model = ?`
      )
      .get(batchId, task.id, strategy.id, executionModelId) as
      | { id: string; shadow_run_id: string | null; status: string }
      | undefined;

    if (existing && existing.status === "completed") {
      if (verbose) console.log(`  [skip] ${task.id} / ${strategy.id} already completed`);
      return {
        ok: true,
        orchestrationRunId: existing.id,
        shadowRunId: existing.shadow_run_id ?? undefined,
        totalCostUsd: 0,
        totalDurationMs: 0,
      };
    }
  }

  if (dryRun) {
    console.log(`  [dry-run] Would execute: ${task.id} with strategy ${strategy.id}`);
    console.log(`    Sub-tasks: ${task.subTasks.map((s) => s.id).join(", ")}`);
    console.log(`    Execution model: ${executionModelId} (${strategy.executionModel.provider})`);
    console.log(`    Orchestrator: ${orchestratorModelId} (${strategy.orchestratorModel.provider})`);
    return { ok: true, orchestrationRunId: "dry-run", totalCostUsd: 0, totalDurationMs: 0 };
  }

  // ── Create orchestration run record ──────────────────────────────────────────
  const orchRunId = randomUUID();
  const createdAt = new Date().toISOString();

  // Upsert: if record exists (from a failed previous run), update it
  db.prepare<[string, string, string, string, string, string, string]>(
    `INSERT INTO orchestration_runs
       (id, batch_id, compound_task_id, strategy_id, orchestrator_model, execution_model, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'running', ?)
     ON CONFLICT(batch_id, compound_task_id, strategy_id, execution_model)
     DO UPDATE SET id = excluded.id, status = 'running', created_at = excluded.created_at`
  ).run(orchRunId, batchId, task.id, strategy.id, orchestratorModelId, executionModelId, createdAt);

  // Re-read the actual ID in case of conflict (the INSERT may have been skipped)
  const orchRow = db
    .prepare<[string, string, string, string]>(
      `SELECT id FROM orchestration_runs
       WHERE batch_id = ? AND compound_task_id = ? AND strategy_id = ? AND execution_model = ?`
    )
    .get(batchId, task.id, strategy.id, executionModelId) as { id: string };
  const actualOrchRunId = orchRow.id;

  // ── Execute sub-tasks sequentially ────────────────────────────────────────────
  const subTaskOutputs = new Map<string, string>(); // subTaskId → output text
  const subTaskResults: SubTaskResult[] = [];
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalDurationMs = 0;
  let totalCostUsd = 0;
  let allSubTasksOk = true;

  for (const subTask of task.subTasks) {
    if (verbose) console.log(`    Sub-task ${subTask.id}...`);

    const prompt = injectOutputs(subTask.promptTemplate, subTaskOutputs);
    const callStart = performance.now();

    const callResult = await callModel(
      executionModelId,
      strategy.executionModel.provider,
      prompt,
      subTask.systemPrompt,
      subTask.maxTokens
    );

    const callDurationMs = Math.round(performance.now() - callStart);
    const subCostUsd =
      strategy.executionModel.provider === "openrouter"
        ? estimateCost(executionModelId, callResult.promptTokens, callResult.completionTokens)
        : 0; // local is free

    const subResult: SubTaskResult = {
      subTaskId: subTask.id,
      ok: callResult.ok,
      output: callResult.output,
      promptTokens: callResult.promptTokens,
      completionTokens: callResult.completionTokens,
      durationMs: callDurationMs,
      costUsd: subCostUsd,
      errorMessage: callResult.errorMessage,
    };

    subTaskResults.push(subResult);
    totalPromptTokens += callResult.promptTokens;
    totalCompletionTokens += callResult.completionTokens;
    totalDurationMs += callDurationMs;
    totalCostUsd += subCostUsd;

    if (!callResult.ok) {
      allSubTasksOk = false;
      if (verbose) console.log(`    [fail] ${subTask.id}: ${callResult.errorMessage}`);
      // Continue — synthesis will still run with whatever we have, but mark it
      subTaskOutputs.set(subTask.id, `[Sub-task failed: ${callResult.errorMessage ?? "unknown error"}]`);
    } else {
      subTaskOutputs.set(subTask.id, callResult.output);
      if (verbose) console.log(`    [done] ${subTask.id} (${callResult.completionTokens} tokens, ${callDurationMs}ms)`);
    }
  }

  // ── Synthesis call ────────────────────────────────────────────────────────────
  if (verbose) console.log(`    Synthesis call...`);

  const synthesisPrompt = injectOutputs(task.synthesisPromptTemplate, subTaskOutputs);
  const synthStart = performance.now();

  const synthResult = await callModel(
    orchestratorModelId,
    strategy.orchestratorModel.provider,
    synthesisPrompt,
    task.synthesisSystemPrompt,
    task.synthesisMaxTokens
  );

  const synthDurationMs = Math.round(performance.now() - synthStart);
  const synthCostUsd =
    strategy.orchestratorModel.provider === "openrouter"
      ? estimateCost(orchestratorModelId, synthResult.promptTokens, synthResult.completionTokens)
      : 0;

  totalPromptTokens += synthResult.promptTokens;
  totalCompletionTokens += synthResult.completionTokens;
  totalDurationMs += synthDurationMs;
  totalCostUsd += synthCostUsd;

  const finalOutput = synthResult.ok ? synthResult.output : null;
  const overallStatus = synthResult.ok && allSubTasksOk ? "completed" : "failed";
  const errorMessage = !synthResult.ok
    ? `Synthesis failed: ${synthResult.errorMessage}`
    : !allSubTasksOk
    ? "One or more sub-tasks failed"
    : undefined;

  const completedAt = new Date().toISOString();

  // ── Insert shadow run (for judge compatibility) ────────────────────────────────
  let shadowRunId: string | undefined;
  if (finalOutput) {
    shadowRunId = randomUUID();
    // model_id encodes strategy/execution so leaderboard can differentiate rows
    const shadowModelId = `${strategy.id}/${executionModelId}`;
    try {
      db.prepare<[string, string, string, string, string, string, number, number, number, number, string]>(
        `INSERT INTO runs
           (id, batch_id, task_id, model_id, status, prompt, response,
            prompt_tokens, completion_tokens, duration_ms, cost_usd, provider, created_at)
         VALUES (?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, 'orchestrator', ?)
         ON CONFLICT(batch_id, task_id, model_id) DO NOTHING`
      ).run(
        shadowRunId,
        batchId,
        task.id,
        shadowModelId,
        task.description,
        finalOutput,
        totalPromptTokens,
        totalCompletionTokens,
        totalDurationMs,
        totalCostUsd,
        completedAt
      );
    } catch (err) {
      // If shadow run insert fails, it's not critical — log and continue
      console.warn(`Warning: shadow run insert failed for ${task.id}: ${err}`);
      shadowRunId = undefined;
    }
  }

  // ── Update orchestration_runs record ─────────────────────────────────────────
  db.prepare<[string, string | null, number, number, number, number, string, string | null, string | null, string, string]>(
    `UPDATE orchestration_runs SET
       status = ?,
       final_output = ?,
       total_prompt_tokens = ?,
       total_completion_tokens = ?,
       total_duration_ms = ?,
       total_cost_usd = ?,
       sub_task_results_json = ?,
       error_message = ?,
       shadow_run_id = ?,
       completed_at = ?
     WHERE id = ?`
  ).run(
    overallStatus,
    finalOutput,
    totalPromptTokens,
    totalCompletionTokens,
    totalDurationMs,
    totalCostUsd,
    JSON.stringify(subTaskResults),
    errorMessage ?? null,
    shadowRunId ?? null,
    completedAt,
    actualOrchRunId
  );

  if (verbose) {
    console.log(
      `    [${overallStatus}] ${task.id} — ${totalCompletionTokens} tokens, ` +
      `$${totalCostUsd.toFixed(4)}, ${(totalDurationMs / 1000).toFixed(1)}s`
    );
  }

  return {
    ok: overallStatus === "completed",
    orchestrationRunId: actualOrchRunId,
    shadowRunId,
    finalOutput: finalOutput ?? undefined,
    totalCostUsd,
    totalDurationMs,
    errorMessage,
  };
}
