/**
 * CLI entry point for the batch runner.
 *
 * Usage:
 *   tsx src/runner/index.ts --batch "v1" [options]
 *
 * Options:
 *   --batch <id>              Required. Batch identifier.
 *   --models <list>|all       Comma-separated model IDs, or "all". Default: all.
 *   --tasks <list>|all        Comma-separated task IDs, or "all". Default: all.
 *   --concurrency <n>         Max parallel inference calls. Default: 3.
 *   --resume                  Skip runs that are already completed.
 *   --dry-run                 Print what would run without calling the API.
 *   --provider <name>         "openrouter" (default) or "local".
 *   --model-map <pairs>       Comma-separated "openrouter-id=ollama-name" pairs for local provider.
 *   --skip-preflight          Skip preflight checks when using --provider local.
 */

import { loadEnv } from '../env.js';
loadEnv();

import { MODELS, getModelById } from './models.js';
import { ALL_TASKS } from '../tasks/index.js';
import { runBatch } from './run-batch.js';
import { runPreflight } from './preflight.js';

// ─── Arg parsing ──────────────────────────────────────────────────────────────

import type { Provider } from './run-batch.js';

function parseArgs(argv: string[]): {
  batchId: string | null;
  modelIds: string[] | null;
  taskIds: string[] | null;
  concurrency: number;
  resume: boolean;
  dryRun: boolean;
  provider: Provider;
  localModelMap: Record<string, string>;
  skipPreflight: boolean;
} {
  const args = argv.slice(2);
  let batchId: string | null = null;
  let modelIds: string[] | null = null;
  let taskIds: string[] | null = null;
  let concurrency = 3;
  let resume = false;
  let dryRun = false;
  let provider: Provider = 'openrouter';
  const localModelMap: Record<string, string> = {};
  let skipPreflight = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--batch':
        batchId = args[++i] ?? null;
        break;
      case '--models': {
        const val = args[++i] ?? '';
        modelIds = val === 'all' ? null : val.split(',').map((s) => s.trim()).filter(Boolean);
        break;
      }
      case '--tasks': {
        const val = args[++i] ?? '';
        taskIds = val === 'all' ? null : val.split(',').map((s) => s.trim()).filter(Boolean);
        break;
      }
      case '--concurrency':
        concurrency = parseInt(args[++i] ?? '3', 10);
        break;
      case '--resume':
        resume = true;
        break;
      case '--dry-run':
        dryRun = true;
        break;
      case '--provider':
        provider = (args[++i] ?? 'openrouter') as Provider;
        break;
      case '--model-map': {
        // Format: "openrouter-id=ollama-name,openrouter-id=ollama-name"
        const val = args[++i] ?? '';
        for (const pair of val.split(',')) {
          const [key, value] = pair.split('=');
          if (key && value) localModelMap[key.trim()] = value.trim();
        }
        break;
      }
      case '--skip-preflight':
        skipPreflight = true;
        break;
      default:
        console.warn(`Unknown argument: ${arg}`);
    }
  }

  return { batchId, modelIds, taskIds, concurrency, resume, dryRun, provider, localModelMap, skipPreflight };
}

// ─── Summary table ────────────────────────────────────────────────────────────

function printSummaryTable(stats: Record<string, { completed: number; failed: number; skipped: number }>): void {
  console.log('\n' + '─'.repeat(64));
  console.log('Per-model summary:');
  console.log('─'.repeat(64));
  const header = 'Model'.padEnd(24) + 'Completed'.padStart(12) + 'Failed'.padStart(10) + 'Skipped'.padStart(10);
  console.log(header);
  console.log('─'.repeat(64));
  for (const [modelId, s] of Object.entries(stats)) {
    const model = getModelById(modelId);
    const name = (model?.shortName ?? modelId).padEnd(24);
    const line = name + String(s.completed).padStart(12) + String(s.failed).padStart(10) + String(s.skipped).padStart(10);
    console.log(line);
  }
  console.log('─'.repeat(64));
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { batchId, modelIds, taskIds, concurrency, resume, dryRun, provider, localModelMap, skipPreflight } = parseArgs(process.argv);

  if (!batchId) {
    console.error('Error: --batch <id> is required');
    process.exit(1);
  }

  // Resolve the model and task lists for display / dry-run
  const resolvedModels = modelIds
    ? MODELS.filter((m) => modelIds.includes(m.id))
    : MODELS;

  const resolvedTasks = taskIds
    ? ALL_TASKS.filter((t) => taskIds.includes(t.id))
    : ALL_TASKS;

  const totalRuns = resolvedModels.length * resolvedTasks.length;

  console.log(`Batch: ${batchId}`);
  console.log(`Models (${resolvedModels.length}): ${resolvedModels.map((m) => m.shortName).join(', ')}`);
  console.log(`Tasks (${resolvedTasks.length}): ${resolvedTasks.map((t) => t.id).join(', ')}`);
  console.log(`Total runs: ${totalRuns}`);
  console.log(`Concurrency: ${concurrency}`);
  console.log(`Provider: ${provider}`);
  console.log(`Resume: ${resume}`);

  if (dryRun) {
    console.log('\nDry run — no API calls will be made. Exiting.');
    return;
  }

  // Run preflight for local provider
  if (provider === 'local' && !skipPreflight) {
    // Collect the Ollama model names that will be used
    const resolvedModelNames = resolvedModels.map(
      (m) => localModelMap[m.id] ?? m.shortName.toLowerCase()
    );
    const preflight = await runPreflight({ requiredModelNames: resolvedModelNames });
    if (!preflight.passed) {
      process.exit(1);
    }
  }

  // Track per-model stats by running each model's tasks as a subset
  const perModelStats: Record<string, { completed: number; failed: number; skipped: number }> = {};

  // Run all models together — post-process stats from the overall result
  const result = await runBatch({
    batchId,
    modelIds: modelIds ?? undefined,
    taskIds: taskIds ?? undefined,
    concurrency,
    resume,
    provider,
    localModelMap,
    skipPreflight: true, // preflight already ran above
  });

  // For per-model breakdown, query the DB after the run
  // Simple approach: show overall stats only, and label as "all models"
  console.log('\nRun complete.');
  console.log(`  Completed: ${result.completed}`);
  console.log(`  Failed:    ${result.failed}`);
  console.log(`  Skipped:   ${result.skipped}`);

  // Show per-model summary by reading the DB
  try {
    const { getDb } = await import('../db.js');
    const db = getDb();

    for (const model of resolvedModels) {
      const row = db.prepare<[string, string], { completed: number; failed: number }>(
        `SELECT
           SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
         FROM runs
         WHERE batch_id = ? AND model_id = ?`
      ).get(batchId, model.id);

      perModelStats[model.id] = {
        completed: row?.completed ?? 0,
        failed: row?.failed ?? 0,
        skipped: 0,
      };
    }

    printSummaryTable(perModelStats);
  } catch {
    // Non-fatal — DB summary is a best-effort display
  }
}

main().catch((err: unknown) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
