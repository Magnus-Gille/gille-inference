import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { getDb } from '../db.js';
import { ALL_TASKS } from '../tasks/index.js';
import { MODELS, getModelById } from './models.js';
import { runInference } from './openrouter-client.js';
import { runLocalInference, warmModel, unloadModel } from './local-client.js';
import { runLmStudioInference } from './lmstudio-client.js';
import type { TaskDefinition } from '../types.js';
import type { ModelSpec } from '../types.js';

export type Provider = 'openrouter' | 'local' | 'lmstudio';

/** Providers that run on local hardware (zero API cost, single-stream benchmarking). */
function isLocalProvider(p: Provider): boolean {
  return p === 'local' || p === 'lmstudio';
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BatchOptions {
  batchId: string;
  modelIds?: string[];
  taskIds?: string[];
  concurrency?: number;
  resume?: boolean;
  provider?: Provider;
  /** For local provider: map OpenRouter model IDs to Ollama model names */
  localModelMap?: Record<string, string>;
  /** Skip preflight checks for local provider (useful in tests) */
  skipPreflight?: boolean;
}

export interface BatchResult {
  completed: number;
  failed: number;
  skipped: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface WorkItem {
  task: TaskDefinition;
  model: ModelSpec;
  existingRunId?: string;
}

function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

// ─── Batch runner ─────────────────────────────────────────────────────────────

export async function runBatch(options: BatchOptions): Promise<BatchResult> {
  const {
    batchId,
    modelIds,
    taskIds,
    concurrency: requestedConcurrency = 3,
    resume = false,
    provider = 'openrouter',
    localModelMap = {},
    skipPreflight = false,
  } = options;

  // Local inference must be sequential — one request at a time per model
  const concurrency = isLocalProvider(provider) ? 1 : requestedConcurrency;
  if (isLocalProvider(provider) && requestedConcurrency > 1) {
    console.log('Local provider: overriding concurrency to 1 (sequential per model).');
  }

  const db = getDb();

  // Resolve tasks
  const tasks = taskIds
    ? ALL_TASKS.filter((t) => taskIds.includes(t.id))
    : ALL_TASKS;

  // Resolve models
  const models = modelIds
    ? MODELS.filter((m) => modelIds.includes(m.id))
    : MODELS;

  if (tasks.length === 0) {
    console.warn('No tasks matched the provided taskIds');
  }
  if (models.length === 0) {
    console.warn('No models matched the provided modelIds');
  }

  // Build work items, checking existing runs for resume support
  const workItems: WorkItem[] = [];

  const selectRun = db.prepare<[string, string, string], { id: string; status: string }>(
    'SELECT id, status FROM runs WHERE batch_id = ? AND task_id = ? AND model_id = ?'
  );

  const insertRun = db.prepare(`
    INSERT INTO runs (id, batch_id, task_id, model_id, status, prompt, created_at)
    VALUES (@id, @batchId, @taskId, @modelId, 'pending', @prompt, @createdAt)
    ON CONFLICT(batch_id, task_id, model_id) DO NOTHING
  `);

  const resetFailedRun = db.prepare(`
    UPDATE runs SET status = 'pending', error_message = NULL
    WHERE batch_id = @batchId AND task_id = @taskId AND model_id = @modelId AND status = 'failed'
  `);

  let alreadyCompleted = 0;
  for (const model of models) {
    for (const task of tasks) {
      const existing = selectRun.get(batchId, task.id, model.id);

      if (existing?.status === 'completed') {
        // Already completed — don't re-run
        alreadyCompleted++;
        continue;
      }

      // Insert new or reset failed runs to pending
      const runId = existing?.id ?? randomUUID();
      insertRun.run({
        id: runId,
        batchId,
        taskId: task.id,
        modelId: model.id,
        prompt: task.prompt,
        createdAt: new Date().toISOString(),
      });
      if (existing?.status === 'failed') {
        resetFailedRun.run({ batchId, taskId: task.id, modelId: model.id });
      }
      workItems.push({ task, model, existingRunId: runId });
    }
  }

  if (alreadyCompleted > 0) {
    console.log(`Skipping ${alreadyCompleted} already-completed run(s) from previous batch.`);
  }

  const total = workItems.length;
  let completed = 0;
  let failed = 0;
  let skipped = 0;
  let dispatchCount = 0;
  let finishedCount = 0;
  const batchStartTime = performance.now();
  const taskDurations: number[] = [];

  function formatEta(): string {
    if (taskDurations.length === 0) return '';
    const avgMs = taskDurations.reduce((a, b) => a + b, 0) / taskDurations.length;
    const remaining = total - finishedCount;
    // With concurrency, tasks run in parallel
    const estRemainingMs = (remaining / Math.min(concurrency, remaining || 1)) * avgMs;
    const mins = Math.floor(estRemainingMs / 60000);
    const secs = Math.floor((estRemainingMs % 60000) / 1000);
    if (mins > 0) return `~${mins}m${secs}s remaining`;
    return `~${secs}s remaining`;
  }

  function formatElapsed(): string {
    const ms = performance.now() - batchStartTime;
    const mins = Math.floor(ms / 60000);
    const secs = Math.floor((ms % 60000) / 1000);
    if (mins > 0) return `${mins}m${secs}s elapsed`;
    return `${secs}s elapsed`;
  }

  const updateRun = db.prepare(`
    UPDATE runs SET
      status = @status,
      response = @response,
      prompt_tokens = @promptTokens,
      completion_tokens = @completionTokens,
      duration_ms = @durationMs,
      cost_usd = @costUsd,
      provider = @provider,
      error_message = @errorMessage,
      completed_at = @completedAt,
      ttft_ms = @ttftMs,
      tokens_per_second = @tokensPerSecond
    WHERE batch_id = @batchId AND task_id = @taskId AND model_id = @modelId
  `);

  // Semaphore-limited fan-out
  async function processItem(item: WorkItem): Promise<void> {
    const { task, model } = item;

    const itemNum = ++dispatchCount;
    const itemStartTime = performance.now();
    console.log(`[${itemNum}/${total}] ${model.shortName} x ${task.id}: running...`);

    // Generous token budget — thinking/reasoning models (Qwen3, DeepSeek R1)
    // consume thousands of tokens on internal reasoning before producing visible
    // output. This is intentional — we want to evaluate models WITH thinking enabled,
    // since that's how they'd run locally.
    // Cap to model's context length minus ~3K for the prompt to avoid 400 errors.
    const idealMaxTokens = Math.max(task.maxTokens, 65536);
    // Local hardware: bound the ceiling so a degenerate generation can't run for
    // ~15 min at ~35 tok/s. 8192 leaves ample room for thinking traces + answer.
    const ceiling = isLocalProvider(provider) ? 12288 : idealMaxTokens;
    const maxTokens = Math.min(ceiling, model.contextLength - 3000);

    const inferenceOpts = {
      systemPrompt: task.systemPrompt,
      maxTokens,
      temperature: 0.0,
    };

    const result =
      provider === 'local'
        ? await runLocalInference(localModelMap[model.id] ?? model.shortName.toLowerCase(), task.prompt, inferenceOpts)
        : provider === 'lmstudio'
          ? await runLmStudioInference(localModelMap[model.id] ?? model.id, task.prompt, inferenceOpts)
          : await runInference(model.id, task.prompt, inferenceOpts);

    const completedAt = new Date().toISOString();

    if (result.ok) {
      // Calculate cost (zero for local)
      const costUsd = isLocalProvider(provider) ? 0 : (
        (result.promptTokens / 1_000_000) * model.openRouterPricePerMInputToken +
        (result.completionTokens / 1_000_000) * model.openRouterPricePerMOutputToken
      );

      // Extract local-only metrics if present
      const localResult = result as Record<string, unknown>;
      const ttftMs = ('ttftMs' in result ? localResult.ttftMs as number : null) ?? null;
      const tokensPerSecond = ('tokensPerSecond' in result ? localResult.tokensPerSecond as number : null) ?? null;
      const localInfo = ttftMs !== null ? `, TTFT: ${ttftMs}ms, ${tokensPerSecond} tok/s` : '';

      updateRun.run({
        status: 'completed',
        response: result.response,
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        durationMs: result.durationMs,
        costUsd,
        provider: result.provider ?? null,
        errorMessage: null,
        completedAt,
        batchId,
        taskId: task.id,
        modelId: model.id,
        ttftMs,
        tokensPerSecond,
      });

      completed++;
      finishedCount++;
      taskDurations.push(result.durationMs);
      console.log(
        `[${itemNum}/${total}] ${model.shortName} x ${task.id}: completed (${formatDuration(result.durationMs)}, ${result.completionTokens} tokens${localInfo}) — ${formatElapsed()}, ${formatEta()}`
      );
    } else {
      updateRun.run({
        status: 'failed',
        response: null,
        promptTokens: null,
        completionTokens: null,
        durationMs: null,
        costUsd: null,
        provider: null,
        errorMessage: result.error,
        completedAt,
        batchId,
        taskId: task.id,
        modelId: model.id,
        ttftMs: null,
        tokensPerSecond: null,
      });

      failed++;
      finishedCount++;
      taskDurations.push(performance.now() - itemStartTime);
      console.log(`[${itemNum}/${total}] ${model.shortName} x ${task.id}: FAILED — ${result.error} — ${formatElapsed()}, ${formatEta()}`);
    }
  }

  if (provider === 'local') {
    // For local inference: process models sequentially, warm before each model's batch,
    // unload after. Within a model's tasks, run sequentially (concurrency=1 enforced above).
    const modelGroups = new Map<string, WorkItem[]>();
    for (const item of workItems) {
      const key = item.model.id;
      if (!modelGroups.has(key)) modelGroups.set(key, []);
      modelGroups.get(key)!.push(item);
    }

    for (const [modelId, items] of modelGroups) {
      const model = items[0]!.model;
      const ollamaName = localModelMap[modelId] ?? model.shortName.toLowerCase();

      // Pre-warm: load model into GPU memory
      console.log(`\n[warm] Loading ${model.shortName} (${ollamaName}) into memory...`);
      const loadMs = await warmModel(ollamaName);
      if (loadMs !== null) {
        console.log(`[warm] Loaded in ${formatDuration(loadMs)}`);
      } else {
        console.warn(`[warm] Could not pre-warm ${ollamaName} — model may not be pulled. Continuing...`);
      }

      // Run all tasks for this model sequentially
      let taskIndex = 0;
      async function localWorker(): Promise<void> {
        while (taskIndex < items.length) {
          const item = items[taskIndex++]!;
          await processItem(item);
        }
      }
      // concurrency is already forced to 1 for local, but be explicit
      await Promise.all([localWorker()]);

      // Unload: evict from GPU memory before next model
      console.log(`[unload] Evicting ${model.shortName} from memory...`);
      await unloadModel(ollamaName);
      console.log(`[unload] Done.`);
    }
  } else {
    // Cloud provider: fan-out with bounded concurrency
    let index = 0;

    async function worker(): Promise<void> {
      while (index < workItems.length) {
        const item = workItems[index++]!;
        await processItem(item);
      }
    }

    const workers = Array.from({ length: Math.min(concurrency, workItems.length) }, () => worker());
    await Promise.all(workers);
  }

  return { completed, failed, skipped: skipped + alreadyCompleted };
}
