/**
 * Orchestration benchmark CLI entry point.
 *
 * Usage:
 *   tsx src/orchestrator/index.ts --batch orch-v1 [options]
 *
 * Options:
 *   --batch <id>              Required. Batch identifier.
 *   --strategy <id>           One of: cloud-only, hybrid-gemma4, hybrid-qwen35, fully-local, all. Default: all.
 *   --tasks <list>|all        Comma-separated compound task IDs, or "all". Default: all.
 *   --resume                  Skip orchestration_runs that are already completed.
 *   --dry-run                 Print what would run without calling any API.
 *   --verbose                 Print sub-task progress.
 *
 * After running, judge the results with:
 *   tsx src/judge/index.ts --batch orch-v1 --judge both
 *
 * Then analyse with:
 *   tsx src/analysis/orchestration.ts --batch orch-v1
 */

import { loadEnv } from "../env.js";
loadEnv();

import { initDb } from "../db.js";
import { COMPOUND_TASKS } from "../tasks/compound.js";
import { ALL_STRATEGIES, getStrategyById } from "./strategies.js";
import { executeCompoundTask } from "./executor.js";
import type { StrategyConfig } from "./types.js";

// ─── Arg parsing ──────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): {
  batchId: string | null;
  strategyIds: string[] | null;
  taskIds: string[] | null;
  resume: boolean;
  dryRun: boolean;
  verbose: boolean;
} {
  const args = argv.slice(2);
  let batchId: string | null = null;
  let strategyIds: string[] | null = null;
  let taskIds: string[] | null = null;
  let resume = false;
  let dryRun = false;
  let verbose = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--batch":
        batchId = args[++i] ?? null;
        break;
      case "--strategy": {
        const val = args[++i] ?? "";
        if (val === "all") {
          strategyIds = null;
        } else {
          strategyIds = val.split(",").map((s) => s.trim()).filter(Boolean);
        }
        break;
      }
      case "--tasks": {
        const val = args[++i] ?? "";
        taskIds = val === "all" ? null : val.split(",").map((s) => s.trim()).filter(Boolean);
        break;
      }
      case "--resume":
        resume = true;
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--verbose":
        verbose = true;
        break;
      default:
        if (arg && !arg.startsWith("#")) {
          console.warn(`Unknown argument: ${arg}`);
        }
    }
  }

  return { batchId, strategyIds, taskIds, resume, dryRun, verbose };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { batchId, strategyIds, taskIds, resume, dryRun, verbose } = parseArgs(process.argv);

  if (!batchId) {
    console.error("Error: --batch <id> is required");
    process.exit(1);
  }

  // Resolve strategies
  let strategies: StrategyConfig[];
  if (strategyIds === null) {
    strategies = ALL_STRATEGIES;
  } else {
    strategies = [];
    for (const id of strategyIds) {
      const s = getStrategyById(id);
      if (!s) {
        console.error(`Unknown strategy: "${id}". Available: ${ALL_STRATEGIES.map((s) => s.id).join(", ")}`);
        process.exit(1);
      }
      strategies.push(s);
    }
  }

  // Resolve tasks
  let tasks = taskIds === null
    ? COMPOUND_TASKS
    : COMPOUND_TASKS.filter((t) => taskIds.includes(t.id));

  if (tasks.length === 0) {
    console.error("No matching compound tasks found.");
    process.exit(1);
  }

  // Initialise DB
  initDb();

  const totalRuns = tasks.length * strategies.length;
  console.log(`Orchestration benchmark: ${batchId}`);
  console.log(`  Tasks:      ${tasks.length} (${tasks.map((t) => t.id).join(", ")})`);
  console.log(`  Strategies: ${strategies.length} (${strategies.map((s) => s.id).join(", ")})`);
  console.log(`  Total runs: ${totalRuns}`);
  if (resume) console.log("  Resume:     enabled (skipping completed runs)");
  if (dryRun) console.log("  Mode:       DRY RUN");
  console.log("");

  let completed = 0;
  let failed = 0;
  let skipped = 0;

  // Run sequentially — local inference can't be parallelised, and API rate limits
  // make parallelisation risky for cloud too.
  for (const strategy of strategies) {
    console.log(`\nStrategy: ${strategy.label}`);

    for (const task of tasks) {
      process.stdout.write(`  ${task.id} (${task.title})... `);

      const result = await executeCompoundTask(task, {
        batchId,
        strategy,
        dryRun,
        resume,
        verbose,
      });

      if (dryRun) {
        skipped++;
        continue;
      }

      if (!result.ok && result.totalCostUsd === 0 && result.totalDurationMs === 0) {
        // Resume skip
        skipped++;
        console.log("skipped (already done)");
        continue;
      }

      if (result.ok) {
        completed++;
        console.log(
          `done ($${result.totalCostUsd.toFixed(4)}, ${(result.totalDurationMs / 1000).toFixed(1)}s)`
        );
      } else {
        failed++;
        console.log(`FAILED: ${result.errorMessage ?? "unknown error"}`);
      }
    }
  }

  console.log(`\n${"─".repeat(60)}`);
  console.log(`Results: ${completed} completed, ${failed} failed, ${skipped} skipped`);

  if (!dryRun && completed > 0) {
    console.log(`\nNext steps:`);
    console.log(`  Judge:    tsx src/judge/index.ts --batch ${batchId} --judge both`);
    console.log(`  Analyse:  tsx src/analysis/orchestration.ts --batch ${batchId}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
