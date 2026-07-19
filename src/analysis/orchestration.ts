/**
 * Orchestration benchmark analysis CLI.
 *
 * Usage:
 *   tsx src/analysis/orchestration.ts --batch orch-v1 [--output ./data/reports/orch-v1]
 *
 * Reads orchestration_runs and judge_records, produces:
 *   - strategy-comparison.md — strategy quality delta table + cost extrapolation
 *   - orchestration-runs.json — raw data for further analysis
 */

import { loadEnv } from "../env.js";
loadEnv();

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { initDb } from "../db.js";
import { averageScores, scoreToNumeric } from "./stats.js";
import { COMPOUND_TASKS } from "../tasks/compound.js";
import { ALL_STRATEGIES } from "../orchestrator/strategies.js";
import type { JudgeScores, ScoreLevel } from "../types.js";

// ─── DB row types ─────────────────────────────────────────────────────────────

interface OrchRunRow {
  id: string;
  compound_task_id: string;
  strategy_id: string;
  execution_model: string;
  orchestrator_model: string;
  status: string;
  total_prompt_tokens: number;
  total_completion_tokens: number;
  total_duration_ms: number;
  total_cost_usd: number;
  shadow_run_id: string | null;
}

interface JudgeRow {
  run_id: string;
  judge_model: string;
  scores: string;
}

// ─── Aggregation helpers ──────────────────────────────────────────────────────

interface StrategyStats {
  strategyId: string;
  label: string;
  tasksCompleted: number;
  tasksJudged: number;
  avgScore: number;
  avgCostUsd: number;
  totalCostUsd: number;
  avgDurationMs: number;
  scoresByTask: Record<string, number>;
}

// ─── Arg parsing ──────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { batchId: string; outputDir: string } {
  const args = argv.slice(2);
  let batchId: string | undefined;
  let outputDir = "./data/reports";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--batch" && args[i + 1]) {
      batchId = args[++i];
    } else if (args[i] === "--output" && args[i + 1]) {
      outputDir = args[++i];
    }
  }

  if (!batchId) {
    console.error("Error: --batch <id> is required");
    process.exit(1);
  }

  return { batchId, outputDir };
}

// ─── Markdown generation ──────────────────────────────────────────────────────

function buildStrategyComparisonMarkdown(
  batchId: string,
  statsMap: Map<string, StrategyStats>,
  taskIds: string[]
): string {
  const lines: string[] = [];
  const stats = Array.from(statsMap.values()).sort((a, b) => b.avgScore - a.avgScore);

  lines.push(`# Orchestration Strategy Comparison — Batch \`${batchId}\``);
  lines.push("");
  lines.push(`_Generated: ${new Date().toISOString()}_`);
  lines.push("");
  lines.push("## Strategy Leaderboard");
  lines.push("");
  lines.push("| Rank | Strategy | Tasks Judged | Avg Score (0-2) | Avg Cost/Run | Total Cost |");
  lines.push("| ---- | -------- | ------------ | --------------- | ------------ | ---------- |");

  for (let i = 0; i < stats.length; i++) {
    const s = stats[i]!;
    lines.push(
      `| ${i + 1} | ${s.label} | ${s.tasksJudged}/${s.tasksCompleted} | ${s.avgScore.toFixed(2)} | $${s.avgCostUsd.toFixed(4)} | $${s.totalCostUsd.toFixed(4)} |`
    );
  }

  // Quality delta table (vs cloud-only baseline)
  const baseline = statsMap.get("cloud-only");
  if (baseline && stats.length > 1) {
    lines.push("");
    lines.push("## Quality Delta vs Cloud-Only Baseline");
    lines.push("");
    lines.push("| Strategy | Score Delta | Cost Delta | Cost Savings % |");
    lines.push("| -------- | ----------- | ---------- | -------------- |");

    for (const s of stats) {
      if (s.strategyId === "cloud-only") continue;
      const scoreDelta = s.avgScore - baseline.avgScore;
      const costDelta = s.avgCostUsd - baseline.avgCostUsd;
      const costSavingsPct = baseline.avgCostUsd > 0
        ? ((baseline.avgCostUsd - s.avgCostUsd) / baseline.avgCostUsd * 100).toFixed(0)
        : "N/A";
      const scoreSign = scoreDelta >= 0 ? "+" : "";
      const costSign = costDelta >= 0 ? "+" : "";
      lines.push(
        `| ${s.label} | ${scoreSign}${scoreDelta.toFixed(2)} | ${costSign}$${costDelta.toFixed(4)} | ${costSavingsPct}% |`
      );
    }
  }

  // Per-task breakdown
  lines.push("");
  lines.push("## Per-Task Score Breakdown");
  lines.push("");

  const taskLabels = new Map(COMPOUND_TASKS.map((t) => [t.id, t.title]));
  const header = ["| Task", ...stats.map((s) => s.strategyId), "|"].join(" | ");
  const separator = ["| ----", ...stats.map(() => "------"), "|"].join(" | ");
  lines.push(header);
  lines.push(separator);

  for (const taskId of taskIds) {
    const taskTitle = taskLabels.get(taskId) ?? taskId;
    const scores = stats.map((s) => {
      const score = s.scoresByTask[taskId];
      return score !== undefined ? score.toFixed(2) : "—";
    });
    lines.push(`| ${taskTitle} | ${scores.join(" | ")} |`);
  }

  // Cost extrapolation
  lines.push("");
  lines.push("## Cost Extrapolation");
  lines.push("");
  lines.push("_Assumes 78% of real usage is delegation-style tasks (from prompt classification)._");
  lines.push("_Usage profile: 2.6B tokens/month (moderate multi-user)._");
  lines.push("");
  lines.push("| Strategy | Avg cost/task | 1000 tasks/day | 30k tasks/month | Annual |");
  lines.push("| -------- | ------------- | -------------- | ---------------- | ------ |");

  for (const s of stats) {
    const daily = s.avgCostUsd * 1000;
    const monthly = s.avgCostUsd * 30_000;
    const annual = monthly * 12;
    lines.push(
      `| ${s.label} | $${s.avgCostUsd.toFixed(4)} | $${daily.toFixed(2)} | $${monthly.toFixed(2)} | $${annual.toFixed(2)} |`
    );
  }

  // Decision framework
  if (baseline) {
    lines.push("");
    lines.push("## Decision Framework");
    lines.push("");
    lines.push("The hardware investment is justified if:");
    lines.push("");
    lines.push("1. **Quality gate:** Hybrid strategy scores within **0.3 points** of cloud-only on the 0-2 scale");
    lines.push("2. **Cost gate:** Hybrid saves **>50%** vs cloud-only per task");
    lines.push("3. **Coverage gate:** At least **5/7 tasks** show consistent quality");
    lines.push("");

    for (const s of stats) {
      if (s.strategyId === "cloud-only") continue;
      const scoreDelta = Math.abs(s.avgScore - baseline.avgScore);
      const qualityPass = scoreDelta <= 0.3;
      const costSavingsPct = baseline.avgCostUsd > 0
        ? (baseline.avgCostUsd - s.avgCostUsd) / baseline.avgCostUsd * 100
        : 0;
      const costPass = costSavingsPct >= 50;
      const coverageCount = Object.values(s.scoresByTask).filter((score) => score > 0).length;
      const coveragePass = coverageCount >= 5;

      lines.push(`**${s.label}:**`);
      lines.push(`- Quality: ${qualityPass ? "✓" : "✗"} delta = ${scoreDelta.toFixed(2)} (threshold: 0.30)`);
      lines.push(`- Cost savings: ${costPass ? "✓" : "✗"} ${costSavingsPct.toFixed(0)}% (threshold: 50%)`);
      lines.push(`- Coverage: ${coveragePass ? "✓" : "✗"} ${coverageCount}/7 tasks with data`);
      lines.push(`- **Verdict: ${qualityPass && costPass && coveragePass ? "JUSTIFIED" : qualityPass || costPass ? "BORDERLINE" : "NOT JUSTIFIED"}**`);
      lines.push("");
    }
  }

  return lines.join("\n");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { batchId, outputDir } = parseArgs(process.argv);
  const resolvedOutput = resolve(join(outputDir, batchId));
  mkdirSync(resolvedOutput, { recursive: true });

  console.log(`Analysing orchestration batch: ${batchId}`);

  const db = initDb();

  // Fetch all orchestration runs for this batch
  const orchRows = db
    .prepare<[string]>(
      `SELECT id, compound_task_id, strategy_id, execution_model, orchestrator_model,
              status, total_prompt_tokens, total_completion_tokens, total_duration_ms,
              total_cost_usd, shadow_run_id
       FROM orchestration_runs
       WHERE batch_id = ?`
    )
    .all(batchId) as OrchRunRow[];

  if (orchRows.length === 0) {
    console.warn("No orchestration runs found for this batch.");
    process.exit(0);
  }

  console.log(`  Found ${orchRows.length} orchestration runs`);

  // Fetch judge records for shadow runs
  const shadowRunIds = orchRows
    .map((r) => r.shadow_run_id)
    .filter((id): id is string => id !== null);

  const judgeMap = new Map<string, JudgeScores[]>(); // shadow_run_id → scores[]

  if (shadowRunIds.length > 0) {
    const placeholders = shadowRunIds.map(() => "?").join(",");
    const judgeRows = db
      .prepare<string[]>(
        `SELECT run_id, judge_model, scores FROM judge_records WHERE run_id IN (${placeholders})`
      )
      .all(...shadowRunIds) as JudgeRow[];

    for (const row of judgeRows) {
      try {
        const scores = JSON.parse(row.scores) as JudgeScores;
        const existing = judgeMap.get(row.run_id) ?? [];
        existing.push(scores);
        judgeMap.set(row.run_id, existing);
      } catch {
        // skip malformed
      }
    }

    console.log(`  Found judge records for ${judgeMap.size}/${shadowRunIds.length} shadow runs`);
  }

  // Build per-strategy stats
  const statsMap = new Map<string, StrategyStats>();

  // Initialise all known strategies (even if no runs yet)
  for (const strategy of ALL_STRATEGIES) {
    statsMap.set(strategy.id, {
      strategyId: strategy.id,
      label: strategy.label,
      tasksCompleted: 0,
      tasksJudged: 0,
      avgScore: 0,
      avgCostUsd: 0,
      totalCostUsd: 0,
      avgDurationMs: 0,
      scoresByTask: {},
    });
  }

  // Track all seen task IDs
  const seenTaskIds = new Set<string>();

  // Accumulate raw data per strategy
  const rawByStrategy = new Map<string, {
    costs: number[];
    durations: number[];
    allScores: JudgeScores[];
    scoresByTask: Record<string, JudgeScores[]>;
  }>();

  for (const row of orchRows) {
    seenTaskIds.add(row.compound_task_id);

    if (row.status !== "completed") continue;

    if (!rawByStrategy.has(row.strategy_id)) {
      rawByStrategy.set(row.strategy_id, {
        costs: [],
        durations: [],
        allScores: [],
        scoresByTask: {},
      });
    }
    const raw = rawByStrategy.get(row.strategy_id)!;
    raw.costs.push(row.total_cost_usd);
    raw.durations.push(row.total_duration_ms);

    const stat = statsMap.get(row.strategy_id);
    if (stat) stat.tasksCompleted++;

    // Attach judge scores if available
    if (row.shadow_run_id) {
      const scores = judgeMap.get(row.shadow_run_id);
      if (scores && scores.length > 0) {
        raw.allScores.push(...scores);
        const taskScores = raw.scoresByTask[row.compound_task_id] ?? [];
        taskScores.push(...scores);
        raw.scoresByTask[row.compound_task_id] = taskScores;
        if (stat) stat.tasksJudged++;
      }
    }
  }

  // Convert raw data into final stats
  for (const [strategyId, raw] of rawByStrategy) {
    const stat = statsMap.get(strategyId);
    if (!stat) continue;

    stat.avgScore = averageScores(raw.allScores);
    stat.totalCostUsd = raw.costs.reduce((a, b) => a + b, 0);
    stat.avgCostUsd = raw.costs.length > 0 ? stat.totalCostUsd / raw.costs.length : 0;
    stat.avgDurationMs = raw.durations.length > 0
      ? raw.durations.reduce((a, b) => a + b, 0) / raw.durations.length
      : 0;

    for (const [taskId, scores] of Object.entries(raw.scoresByTask)) {
      stat.scoresByTask[taskId] = averageScores(scores);
    }
  }

  const taskIds = Array.from(seenTaskIds).sort();

  // Generate outputs
  const comparisonMd = buildStrategyComparisonMarkdown(batchId, statsMap, taskIds);
  const mdPath = join(resolvedOutput, "strategy-comparison.md");
  writeFileSync(mdPath, comparisonMd);
  console.log(`Wrote: ${mdPath}`);

  const rawJson = {
    batchId,
    generatedAt: new Date().toISOString(),
    strategies: Array.from(statsMap.values()),
    runs: orchRows,
  };
  const jsonPath = join(resolvedOutput, "orchestration-runs.json");
  writeFileSync(jsonPath, JSON.stringify(rawJson, null, 2));
  console.log(`Wrote: ${jsonPath}`);

  console.log("\nDone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
