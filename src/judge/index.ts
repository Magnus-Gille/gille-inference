import { loadEnv } from "../env.js";
loadEnv();

import { randomUUID } from "node:crypto";
import { initDb } from "../db.js";
import { getTaskById } from "../tasks/index.js";
import { judgeWithOpus } from "./opus-judge.js";
import { judgeWithO4Mini } from "./o4mini-judge.js";
import { shouldFlagForReview } from "./aggregate.js";
import type { JudgeModel, JudgeScores, TaskCategory } from "../types.js";

// ─── CLI arg parsing ──────────────────────────────────────────────────────────

interface CliArgs {
  batchId: string;
  judge: "opus" | "o4mini" | "both";
  taskFilter?: TaskCategory;
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  let batchId: string | undefined;
  let judge: "opus" | "o4mini" | "both" = "both";
  let taskFilter: TaskCategory | undefined;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--batch":
        batchId = args[++i];
        break;
      case "--judge": {
        const val = args[++i];
        if (val !== "opus" && val !== "o4mini" && val !== "both") {
          throw new Error(`--judge must be one of: opus, o4mini, both`);
        }
        judge = val;
        break;
      }
      case "--task-filter":
        taskFilter = args[++i] as TaskCategory;
        break;
      case "--dry-run":
        dryRun = true;
        break;
    }
  }

  if (!batchId) {
    throw new Error("--batch <id> is required");
  }

  return { batchId, judge, taskFilter, dryRun };
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

interface RunRow {
  id: string;
  task_id: string;
  model_id: string;
  response: string | null;
}

interface JudgeExistsRow {
  cnt: number;
}

function getCompletedRuns(
  db: ReturnType<typeof initDb>,
  batchId: string,
  taskFilter?: TaskCategory
): RunRow[] {
  if (taskFilter) {
    return db
      .prepare(
        `SELECT r.id, r.task_id, r.model_id, r.response
         FROM runs r
         WHERE r.batch_id = ? AND r.status = 'completed'`
      )
      .all(batchId) as RunRow[];
    // Filter post-query since task category is not in the DB
  }
  return db
    .prepare(
      `SELECT id, task_id, model_id, response
       FROM runs
       WHERE batch_id = ? AND status = 'completed'`
    )
    .all(batchId) as RunRow[];
}

function existingJudgeModels(
  db: ReturnType<typeof initDb>,
  runId: string
): Set<string> {
  const rows = db
    .prepare(`SELECT judge_model FROM judge_records WHERE run_id = ?`)
    .all(runId) as Array<{ judge_model: string }>;
  return new Set(rows.map((r) => r.judge_model));
}

function insertJudgeRecord(
  db: ReturnType<typeof initDb>,
  runId: string,
  judgeModel: JudgeModel,
  scores: JudgeScores,
  rationale: string,
  flaggedForReview: boolean
): void {
  db.prepare(
    `INSERT INTO judge_records (id, run_id, judge_model, scores, rationale, flagged_for_review, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    randomUUID(),
    runId,
    judgeModel,
    JSON.stringify(scores),
    rationale,
    flaggedForReview ? 1 : 0,
    new Date().toISOString()
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const db = initDb();

  // Fetch completed runs
  let runs = getCompletedRuns(db, args.batchId, args.taskFilter);

  // Apply task-filter if specified (post-query category filter)
  if (args.taskFilter) {
    runs = runs.filter((r) => {
      const task = getTaskById(r.task_id);
      return task?.category === args.taskFilter;
    });
  }

  if (runs.length === 0) {
    console.log(`No completed runs found for batch "${args.batchId}".`);
    return;
  }

  // Determine which judge models to run
  const judgeModels: JudgeModel[] = [];
  if (args.judge === "opus" || args.judge === "both") {
    judgeModels.push("anthropic/claude-opus-4-5");
  }
  if (args.judge === "o4mini" || args.judge === "both") {
    judgeModels.push("openai/o4-mini");
  }

  // Determine what needs judging
  type PendingEntry = { run: RunRow; judgeModel: JudgeModel };
  const pending: PendingEntry[] = [];

  for (const run of runs) {
    const existing = existingJudgeModels(db, run.id);
    for (const judgeModel of judgeModels) {
      if (!existing.has(judgeModel)) {
        pending.push({ run, judgeModel });
      }
    }
  }

  if (args.dryRun) {
    console.log(
      `Dry run — would judge ${pending.length} run/judge combinations:`
    );
    for (const { run, judgeModel } of pending) {
      console.log(`  run=${run.id} task=${run.task_id} judge=${judgeModel}`);
    }
    return;
  }

  if (pending.length === 0) {
    console.log(`All runs in batch "${args.batchId}" are already judged.`);
    return;
  }

  console.log(
    `Judging ${pending.length} run/judge combinations for batch "${args.batchId}"...`
  );

  let judged = 0;
  let flaggedCount = 0;
  let errors = 0;

  // Track pairs for agreement rate
  const agreementPairs: Array<{ agrees: boolean }> = [];

  // Group pending by run ID to detect when both judges are done for a run
  const scoresByRun = new Map<
    string,
    { opus?: JudgeScores; o4mini?: JudgeScores }
  >();

  for (const { run, judgeModel } of pending) {
    const task = getTaskById(run.task_id);
    if (!task) {
      console.error(`  WARN: task "${run.task_id}" not found in registry — skipping`);
      errors++;
      continue;
    }

    const response = run.response ?? "";
    process.stdout.write(
      `  ${judgeModel} / run=${run.id} task=${run.task_id} ... `
    );

    let result;
    if (judgeModel === "anthropic/claude-opus-4-5") {
      result = await judgeWithOpus(task, response);
    } else {
      result = await judgeWithO4Mini(task, response);
    }

    if (!result.ok) {
      console.log(`ERROR: ${result.error}`);
      errors++;
      continue;
    }

    // Determine flagging — need both judges' scores
    const runEntry = scoresByRun.get(run.id) ?? {};
    if (judgeModel === "anthropic/claude-opus-4-5") {
      runEntry.opus = result.scores;
    } else {
      runEntry.o4mini = result.scores;
    }
    scoresByRun.set(run.id, runEntry);

    let flagged = false;
    if (runEntry.opus && runEntry.o4mini) {
      flagged = shouldFlagForReview(runEntry.opus, runEntry.o4mini);
      const agrees = !flagged;
      agreementPairs.push({ agrees });
      if (flagged) flaggedCount++;
    }

    insertJudgeRecord(db, run.id, judgeModel, result.scores, result.rationale, flagged);
    judged++;
    console.log(
      `done (correctness=${result.scores.correctness} completeness=${result.scores.completeness} quality=${result.scores.quality})`
    );
  }

  // Re-check existing judge records to compute agreement rate for already-stored pairs
  // For newly inserted records we tracked agreement above
  const agreementRate =
    agreementPairs.length > 0
      ? Math.round(
          (agreementPairs.filter((p) => p.agrees).length /
            agreementPairs.length) *
            100
        )
      : null;

  console.log("\nSummary:");
  console.log(`  Judged:           ${judged}`);
  console.log(`  Flagged for review: ${flaggedCount}`);
  if (agreementRate !== null) {
    console.log(`  Agreement rate:   ${agreementRate}%`);
  }
  if (errors > 0) {
    console.log(`  Errors:           ${errors}`);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
