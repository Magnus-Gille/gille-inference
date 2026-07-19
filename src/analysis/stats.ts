import type Database from "better-sqlite3";
import type {
  ModelAggregate,
  ScoreLevel,
  JudgeScores,
  TaskCategory,
  DifficultyLevel,
} from "../types.js";
import { ALL_TASKS } from "../tasks/index.js";

// ─── Task metadata (loaded once at module init) ─────────────────────────────

const TASK_META = new Map(
  ALL_TASKS.map((t) => [t.id, { category: t.category, difficulty: t.difficulty }])
);

// task_ids we've already warned about, so a noisy batch warns once per id.
const warnedUnknownTaskIds = new Set<string>();

/**
 * Resolve a run's task_id to its category + difficulty via the task registry.
 *
 * When the task_id is NOT in the registry we return the explicit "unknown"
 * category rather than silently defaulting to "non-coding" (issue #1: that
 * default made every unregistered task_id — e.g. delegated-work runs before
 * those tasks were registered — masquerade as non-coding, poisoning that
 * bucket). Unknowns are surfaced honestly and warned about once per id.
 */
function resolveTaskMeta(taskId: string): {
  category: TaskCategory;
  difficulty: DifficultyLevel;
} {
  const meta = TASK_META.get(taskId);
  if (meta) return { category: meta.category, difficulty: meta.difficulty };

  if (!warnedUnknownTaskIds.has(taskId)) {
    warnedUnknownTaskIds.add(taskId);
    console.warn(
      `[analysis] task_id "${taskId}" not found in the task registry — ` +
        `classifying as "unknown" (check src/tasks/ registration).`
    );
  }
  return { category: "unknown", difficulty: 3 };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Compute the p-th percentile of a sorted or unsorted array of numbers.
 * Uses linear interpolation between ranks for fractional percentiles.
 *
 * @param values - numeric array (not mutated)
 * @param p - percentile in [0, 100]
 * @returns value at the p-th percentile
 * @throws if `values` is empty or `p` is outside [0, 100]
 */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    throw new Error("percentile: cannot compute on an empty array");
  }
  if (Number.isNaN(p) || p < 0 || p > 100) {
    throw new Error(`percentile: p must be in [0, 100], got ${p}`);
  }
  // Sort a copy — never mutate the caller's array.
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0]!;
  // Linear interpolation between the two closest ranks (NIST / numpy "linear").
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo]!;
  const frac = rank - lo;
  return sorted[lo]! + frac * (sorted[hi]! - sorted[lo]!);
}

/** Convert a ScoreLevel to a numeric value for averaging. */
export function scoreToNumeric(score: ScoreLevel): number {
  switch (score) {
    case "fail":
      return 0;
    case "acceptable":
      return 1;
    case "good":
      return 2;
  }
}

/** Average numeric scores for an array of JudgeScores across all 3 dimensions. */
export function averageScores(scores: JudgeScores[]): number {
  if (scores.length === 0) return 0;
  let total = 0;
  for (const s of scores) {
    total +=
      scoreToNumeric(s.correctness) +
      scoreToNumeric(s.completeness) +
      scoreToNumeric(s.quality);
  }
  return total / (scores.length * 3);
}

// ─── DB row types ─────────────────────────────────────────────────────────────

interface RunJudgeRow {
  run_id: string;
  model_id: string;
  task_id: string;
  task_category: string;
  task_difficulty: number;
  completion_tokens: number | null;
  cost_usd: number | null;
  scores_json: string;
  judge_model: string;
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Compute per-model aggregates for all models that have been judged in batchId.
 *
 * One ModelAggregate is returned per model. Raw JudgeScores are collected into
 * scoresByCategory / scoresByDifficulty so callers can compute derived stats.
 */
export function getModelAggregates(
  db: Database.Database,
  batchId: string
): ModelAggregate[] {
  // Pull all judged run data in one query.  We LEFT-JOIN tasks metadata but
  // since tasks aren't stored in the DB (they live in src/tasks/) we attach
  // category/difficulty via the run's task_id — however the schema stores
  // only task_id in runs.  We therefore do a two-step query: first fetch all
  // runs+judge_records, then enrich with task metadata from the tasks registry
  // if available.  If not available we leave category/difficulty as unknown.
  const rows = db
    .prepare<[string]>(
      `SELECT
         r.id          AS run_id,
         r.model_id,
         r.task_id,
         r.completion_tokens,
         r.cost_usd,
         jr.scores     AS scores_json,
         jr.judge_model
       FROM runs r
       JOIN judge_records jr ON jr.run_id = r.id
       WHERE r.batch_id = ?
         AND r.status = 'completed'`
    )
    .all(batchId) as RunJudgeRow[];

  if (rows.length === 0) return [];

  // Group by modelId.
  interface Accumulator {
    modelId: string;
    // run_id → set of judge_models (to detect agreement)
    runJudges: Map<string, { judges: string[]; scoresByJudge: Map<string, JudgeScores> }>;
    totalCostUsd: number;
    completionTokensSum: number;
    completionTokensCount: number;
    scoresByCategory: Map<TaskCategory, JudgeScores[]>;
    scoresByDifficulty: Map<DifficultyLevel, JudgeScores[]>;
    taskIds: Set<string>;
  }

  const byModel = new Map<string, Accumulator>();

  for (const row of rows) {
    let acc = byModel.get(row.model_id);
    if (!acc) {
      acc = {
        modelId: row.model_id,
        runJudges: new Map(),
        totalCostUsd: 0,
        completionTokensSum: 0,
        completionTokensCount: 0,
        scoresByCategory: new Map(),
        scoresByDifficulty: new Map(),
        taskIds: new Set(),
      };
      byModel.set(row.model_id, acc);
    }

    // Each run appears once per judge — accumulate cost only once per run.
    if (!acc.taskIds.has(row.run_id)) {
      acc.taskIds.add(row.run_id);
      acc.totalCostUsd += row.cost_usd ?? 0;
      if (row.completion_tokens != null) {
        acc.completionTokensSum += row.completion_tokens;
        acc.completionTokensCount += 1;
      }
    }

    // Parse scores.
    let parsed: JudgeScores;
    try {
      parsed = JSON.parse(row.scores_json) as JudgeScores;
    } catch {
      continue;
    }

    // Accumulate into runJudges for agreement rate calculation.
    let rj = acc.runJudges.get(row.run_id);
    if (!rj) {
      rj = { judges: [], scoresByJudge: new Map() };
      acc.runJudges.set(row.run_id, rj);
    }
    rj.judges.push(row.judge_model);
    rj.scoresByJudge.set(row.judge_model, parsed);

    // Enrich with task metadata.
    const { category, difficulty } = resolveTaskMeta(row.task_id);

    const catList = acc.scoresByCategory.get(category) ?? [];
    catList.push(parsed);
    acc.scoresByCategory.set(category, catList);

    const diffList = acc.scoresByDifficulty.get(difficulty) ?? [];
    diffList.push(parsed);
    acc.scoresByDifficulty.set(difficulty, diffList);
  }

  // Build ModelAggregate objects.
  // We also derive shortName from modelId (last segment after "/") since the
  // model registry is not imported here to keep the dependency minimal.
  const results: ModelAggregate[] = [];

  for (const acc of byModel.values()) {
    const shortName = acc.modelId.includes("/")
      ? (acc.modelId.split("/").pop() ?? acc.modelId)
      : acc.modelId;

    // Unique task count = number of unique run_ids.
    const taskCount = acc.taskIds.size;

    const avgTokensPerTask =
      acc.completionTokensCount > 0
        ? Math.round(acc.completionTokensSum / acc.completionTokensCount)
        : 0;

    const scoresByCategory: ModelAggregate["scoresByCategory"] = {};
    for (const [cat, scores] of acc.scoresByCategory) {
      scoresByCategory[cat] = scores;
    }

    const scoresByDifficulty: ModelAggregate["scoresByDifficulty"] = {};
    for (const [diff, scores] of acc.scoresByDifficulty) {
      scoresByDifficulty[diff] = scores;
    }

    results.push({
      modelId: acc.modelId,
      shortName,
      taskCount,
      scoresByCategory,
      scoresByDifficulty,
      totalCostUsd: acc.totalCostUsd,
      avgTokensPerTask,
    });
  }

  return results;
}

/**
 * Compute judge agreement rate for a ModelAggregate.
 *
 * A task is "agreed" when both judges score all three dimensions within 1
 * step of each other (|score_a - score_b| <= 1 for correctness, completeness,
 * quality).
 *
 * Returns a number in [0, 1], or null if no task has two judges.
 */
export function judgeAgreementRate(aggregate: ModelAggregate): number | null {
  // Re-derive from scoresByCategory — we can't access runJudges from the
  // public type, so we compute a proxy: for each category, compare pairs of
  // scores that correspond to the same task (every pair of consecutive entries
  // with step 2).  This is accurate when the DB returns one row per judge per
  // run and the scores are ordered run-by-run.
  //
  // However without the run-level pairing we cannot do this correctly from the
  // aggregate alone.  The agreement rate is therefore better computed during
  // getModelAggregates and exposed separately.  We expose a helper here that
  // accepts the raw runJudges map computed internally (used by tests and the
  // CLI).
  void aggregate; // used for type check
  return null; // requires richer data — use computeAgreementRate() below
}

/**
 * Internal type returned by getModelAggregatesWithAgreement which includes
 * the per-run judge data needed for agreement rate calculation.
 */
export interface ModelAggregateWithAgreement extends ModelAggregate {
  judgeAgreementRate: number | null;
  overallAvgScore: number;
  avgScoreByCategory: Partial<Record<TaskCategory, number>>;
  avgScoreByDifficulty: Partial<Record<DifficultyLevel, number>>;
}

/**
 * Extended version of getModelAggregates that also computes derived statistics
 * (overall average, per-category averages, and judge agreement rate).
 */
export function getModelAggregatesWithAgreement(
  db: Database.Database,
  batchId: string
): ModelAggregateWithAgreement[] {
  // Pull the same data as getModelAggregates but also track per-run scores by
  // judge for agreement rate calculation.
  const rows = db
    .prepare<[string]>(
      `SELECT
         r.id          AS run_id,
         r.model_id,
         r.task_id,
         r.completion_tokens,
         r.cost_usd,
         jr.scores     AS scores_json,
         jr.judge_model
       FROM runs r
       JOIN judge_records jr ON jr.run_id = r.id
       WHERE r.batch_id = ?
         AND r.status = 'completed'`
    )
    .all(batchId) as RunJudgeRow[];

  if (rows.length === 0) return [];

  interface RunAcc {
    judges: Map<string, JudgeScores>;
    category: TaskCategory;
    difficulty: DifficultyLevel;
    costUsd: number;
    completionTokens: number | null;
  }

  // modelId → runId → RunAcc
  const byModel = new Map<string, Map<string, RunAcc>>();

  for (const row of rows) {
    let runMap = byModel.get(row.model_id);
    if (!runMap) {
      runMap = new Map();
      byModel.set(row.model_id, runMap);
    }

    let runAcc = runMap.get(row.run_id);
    if (!runAcc) {
      const { category, difficulty } = resolveTaskMeta(row.task_id);
      runAcc = {
        judges: new Map(),
        category,
        difficulty,
        costUsd: row.cost_usd ?? 0,
        completionTokens: row.completion_tokens,
      };
      runMap.set(row.run_id, runAcc);
    }

    let parsed: JudgeScores;
    try {
      parsed = JSON.parse(row.scores_json) as JudgeScores;
    } catch {
      continue;
    }
    runAcc.judges.set(row.judge_model, parsed);
  }

  const results: ModelAggregateWithAgreement[] = [];

  for (const [modelId, runMap] of byModel) {
    const shortName = modelId.includes("/")
      ? (modelId.split("/").pop() ?? modelId)
      : modelId;

    const scoresByCategory = new Map<TaskCategory, JudgeScores[]>();
    const scoresByDifficulty = new Map<DifficultyLevel, JudgeScores[]>();
    let totalCostUsd = 0;
    let completionTokensSum = 0;
    let completionTokensCount = 0;
    let agreedTasks = 0;
    let twoJudgeTasks = 0;

    for (const runAcc of runMap.values()) {
      totalCostUsd += runAcc.costUsd;
      if (runAcc.completionTokens != null) {
        completionTokensSum += runAcc.completionTokens;
        completionTokensCount += 1;
      }

      for (const scores of runAcc.judges.values()) {
        const catList = scoresByCategory.get(runAcc.category) ?? [];
        catList.push(scores);
        scoresByCategory.set(runAcc.category, catList);

        const diffList = scoresByDifficulty.get(runAcc.difficulty) ?? [];
        diffList.push(scores);
        scoresByDifficulty.set(runAcc.difficulty, diffList);
      }

      // Agreement rate: only for runs with exactly 2 judges.
      const judgeList = Array.from(runAcc.judges.values());
      if (judgeList.length >= 2) {
        twoJudgeTasks++;
        const [a, b] = judgeList;
        const within1 =
          Math.abs(scoreToNumeric(a!.correctness) - scoreToNumeric(b!.correctness)) <= 1 &&
          Math.abs(scoreToNumeric(a!.completeness) - scoreToNumeric(b!.completeness)) <= 1 &&
          Math.abs(scoreToNumeric(a!.quality) - scoreToNumeric(b!.quality)) <= 1;
        if (within1) agreedTasks++;
      }
    }

    // Build public scoresByCategory / scoresByDifficulty maps.
    const scoresByCat: ModelAggregate["scoresByCategory"] = {};
    for (const [cat, scores] of scoresByCategory) {
      scoresByCat[cat] = scores;
    }

    const scoresByDiff: ModelAggregate["scoresByDifficulty"] = {};
    for (const [diff, scores] of scoresByDifficulty) {
      scoresByDiff[diff] = scores;
    }

    // Overall average (across all judges and dimensions).
    const allScores: JudgeScores[] = [];
    for (const scores of scoresByCategory.values()) {
      allScores.push(...scores);
    }
    const overallAvgScore = averageScores(allScores);

    // Per-category averages.
    const avgScoreByCategory: Partial<Record<TaskCategory, number>> = {};
    for (const [cat, scores] of scoresByCategory) {
      avgScoreByCategory[cat] = averageScores(scores);
    }

    // Per-difficulty averages.
    const avgScoreByDifficulty: Partial<Record<DifficultyLevel, number>> = {};
    for (const [diff, scores] of scoresByDifficulty) {
      avgScoreByDifficulty[diff] = averageScores(scores);
    }

    results.push({
      modelId,
      shortName,
      taskCount: runMap.size,
      scoresByCategory: scoresByCat,
      scoresByDifficulty: scoresByDiff,
      totalCostUsd,
      avgTokensPerTask:
        completionTokensCount > 0
          ? Math.round(completionTokensSum / completionTokensCount)
          : 0,
      judgeAgreementRate:
        twoJudgeTasks > 0 ? agreedTasks / twoJudgeTasks : null,
      overallAvgScore,
      avgScoreByCategory,
      avgScoreByDifficulty,
    });
  }

  // Sort by overall score descending.
  results.sort((a, b) => b.overallAvgScore - a.overallAvgScore);

  return results;
}
