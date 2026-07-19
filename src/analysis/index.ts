/**
 * Analysis CLI entry point.
 *
 * Usage:
 *   tsx src/analysis/index.ts --batch <id> [--format json|markdown|both] [--output <dir>]
 */

import { loadEnv } from "../env.js";
loadEnv();

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { initDb } from "../db.js";
import { getModelAggregatesWithAgreement } from "./stats.js";
import { calculateCostComparison, generateCostReport } from "./cost.js";
import { generateHardwareReport, HARDWARE_SPECS } from "./hardware.js";
import { MODELS } from "../runner/models.js";
import type { ModelAggregateWithAgreement } from "./stats.js";

// ─── Argument parsing ─────────────────────────────────────────────────────────

function parseArgs(argv: string[]): {
  batchId: string;
  format: "json" | "markdown" | "both";
  outputDir: string;
} {
  const args = argv.slice(2);
  let batchId: string | undefined;
  let format: "json" | "markdown" | "both" = "both";
  let outputDir = "./data/reports";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--batch" && args[i + 1]) {
      batchId = args[++i];
    } else if (args[i] === "--format" && args[i + 1]) {
      const f = args[++i];
      if (f === "json" || f === "markdown" || f === "both") {
        format = f;
      } else {
        console.error(`Unknown format: ${f}. Use json, markdown, or both.`);
        process.exit(1);
      }
    } else if (args[i] === "--output" && args[i + 1]) {
      outputDir = args[++i];
    }
  }

  if (!batchId) {
    console.error("Error: --batch <id> is required");
    process.exit(1);
  }

  return { batchId, format, outputDir };
}

// ─── Leaderboard JSON ─────────────────────────────────────────────────────────

function buildLeaderboard(
  aggregates: ModelAggregateWithAgreement[]
): object[] {
  return aggregates.map((agg, index) => ({
    rank: index + 1,
    modelId: agg.modelId,
    shortName: agg.shortName,
    taskCount: agg.taskCount,
    overallAvgScore: agg.overallAvgScore,
    avgScoreByCategory: agg.avgScoreByCategory,
    avgScoreByDifficulty: agg.avgScoreByDifficulty,
    totalCostUsd: agg.totalCostUsd,
    avgTokensPerTask: agg.avgTokensPerTask,
    judgeAgreementRate: agg.judgeAgreementRate,
  }));
}

// ─── Summary markdown ─────────────────────────────────────────────────────────

function buildSummaryMarkdown(
  batchId: string,
  aggregates: ModelAggregateWithAgreement[]
): string {
  const lines: string[] = [];

  lines.push(`# Evaluation Summary — Batch \`${batchId}\``);
  lines.push("");
  lines.push(
    `_Generated: ${new Date().toISOString()}_`
  );
  lines.push("");
  lines.push(
    "> **Note:** All results are labelled **hosted proxy upper bound** — " +
      "these are OpenRouter API results, not local inference quality."
  );
  lines.push("");

  if (aggregates.length === 0) {
    lines.push("No judged results found for this batch.");
    return lines.join("\n");
  }

  lines.push("## Model Leaderboard");
  lines.push("");
  lines.push(
    "| Rank | Model | Tasks | Avg Score (0-2) | Judge Agreement | Total Cost |"
  );
  lines.push(
    "| ---- | ----- | ----- | --------------- | --------------- | ---------- |"
  );

  for (let i = 0; i < aggregates.length; i++) {
    const agg = aggregates[i]!;
    const agreement =
      agg.judgeAgreementRate !== null
        ? `${(agg.judgeAgreementRate * 100).toFixed(0)}%`
        : "N/A";
    lines.push(
      `| ${i + 1} | ${agg.shortName} | ${agg.taskCount} | ${agg.overallAvgScore.toFixed(2)} | ${agreement} | $${agg.totalCostUsd.toFixed(4)} |`
    );
  }

  lines.push("");
  lines.push("## Key Questions");
  lines.push("");
  lines.push(
    "1. **Quality plateau?** See per-category scores in `leaderboard.json`."
  );
  lines.push(
    "2. **Reasoning models vs general?** Compare DS-R1 vs Qwen3 on architecture tasks."
  );
  lines.push(
    "3. **70B Q4 vs 32B Q8?** Check Llama 3.3 70B vs Qwen3 32B scores."
  );
  lines.push(
    "4. **Non-coding assistant quality?** Filter `non-coding` category in leaderboard."
  );
  lines.push(
    "5. **Cost break-even?** See `cost-analysis.md` for full analysis."
  );
  lines.push(
    "6. **Hardware feasibility?** See `hardware-comparison.md` for fit and tok/s estimates."
  );
  lines.push("");

  return lines.join("\n");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { batchId, format, outputDir } = parseArgs(process.argv);
  const resolvedOutput = resolve(outputDir);

  mkdirSync(resolvedOutput, { recursive: true });

  console.log(`Analysing batch: ${batchId}`);
  console.log(`Output directory: ${resolvedOutput}`);
  console.log("");

  // Open database.
  const db = initDb();

  // 1. Model aggregates.
  console.log("Computing model aggregates...");
  const aggregates = getModelAggregatesWithAgreement(db, batchId);
  console.log(`  Found ${aggregates.length} models with judged results.`);

  if (aggregates.length === 0) {
    console.warn(
      "Warning: no judged results found for this batch. Run the judge first."
    );
  }

  // 2. Cost comparisons — use top-performing model, fall back to first MODELS entry.
  const topModel = aggregates[0];
  const topModelSpec = MODELS.find(
    (m) => m.id === topModel?.modelId
  ) ?? MODELS[0];

  let costReport = "";
  if (topModelSpec) {
    console.log(`Computing cost comparisons for: ${topModelSpec.id}`);
    const costComparisons = calculateCostComparison(
      topModelSpec.id,
      {
        inputPricePerMToken: topModelSpec.openRouterPricePerMInputToken,
        outputPricePerMToken: topModelSpec.openRouterPricePerMOutputToken,
      },
      10.5
    );
    costReport = generateCostReport(topModelSpec.id, costComparisons);
  }

  // 3. Hardware report.
  console.log("Generating hardware comparison...");
  const hardwareReport = generateHardwareReport(MODELS);

  // 4. Write outputs.
  const leaderboard = buildLeaderboard(aggregates);
  const summaryMd = buildSummaryMarkdown(batchId, aggregates);

  if (format === "json" || format === "both") {
    const leaderboardPath = join(resolvedOutput, "leaderboard.json");
    writeFileSync(
      leaderboardPath,
      JSON.stringify({ batchId, generatedAt: new Date().toISOString(), models: leaderboard }, null, 2)
    );
    console.log(`Wrote: ${leaderboardPath}`);
  }

  if (format === "markdown" || format === "both") {
    const costPath = join(resolvedOutput, "cost-analysis.md");
    writeFileSync(costPath, costReport);
    console.log(`Wrote: ${costPath}`);

    const hwPath = join(resolvedOutput, "hardware-comparison.md");
    writeFileSync(hwPath, hardwareReport);
    console.log(`Wrote: ${hwPath}`);

    const summaryPath = join(resolvedOutput, "summary.md");
    writeFileSync(summaryPath, summaryMd);
    console.log(`Wrote: ${summaryPath}`);
  }

  // Also write the leaderboard as JSON even in markdown-only mode (it's the
  // primary data artifact).
  if (format === "markdown") {
    const leaderboardPath = join(resolvedOutput, "leaderboard.json");
    writeFileSync(
      leaderboardPath,
      JSON.stringify({ batchId, generatedAt: new Date().toISOString(), models: leaderboard }, null, 2)
    );
    console.log(`Wrote: ${leaderboardPath}`);
  }

  console.log("\nDone.");
  void HARDWARE_SPECS; // prevent unused import warning
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
