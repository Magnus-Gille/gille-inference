/**
 * frames-regrade.ts — Offline re-grade of saved FRAMES results using the fixed grader.
 *
 * Re-runs looseAnswerMatch(gold, predicted) over already-saved JSONL rows without making
 * any model or API calls. Pure deterministic match only — the original eval used an LLM
 * judge as tier-2, so this offline regrade is a LOWER BOUND (judge could only add correct
 * matches on top of the deterministic tier).
 *
 * Usage:
 *   tsx scripts/frames-regrade.ts
 *   tsx scripts/frames-regrade.ts --results-only    # skip numeric-rederive table
 *   tsx scripts/frames-regrade.ts --numeric-only    # skip results table
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { looseAnswerMatch } from "./frames-grade.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FRAMES_DIR = join(__dirname, "..", "data", "frames");
const RESULTS_PATH = join(FRAMES_DIR, "results.jsonl");
const NUMERIC_PATH = join(FRAMES_DIR, "numeric-rederive.jsonl");

interface FramesResult {
  idx: number;
  gold: string;
  predicted: string;
  correct: boolean;
  matchType: string;
  reasoning_types: string;
}

interface RederiveRecord {
  idx: number;
  gold: string;
  predicted: string;
  model: string;
  correct: boolean;
  matchType: string;
  hadAnswerLine: boolean;
}

function loadJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try { return JSON.parse(l) as T; } catch { return null as unknown as T; }
    })
    .filter(Boolean);
}

function regradeResults(): void {
  const rows = loadJsonl<FramesResult>(RESULTS_PATH);
  if (rows.length === 0) {
    console.log(`[regrade] results.jsonl not found or empty at ${RESULTS_PATH}`);
    return;
  }

  const total = rows.length;
  const numerical = rows.filter((r) => r.reasoning_types.split(/\s*\|\s*|,/).includes("Numerical reasoning"));
  const nonNumerical = rows.filter((r) => !r.reasoning_types.split(/\s*\|\s*|,/).includes("Numerical reasoning"));

  const oldOverall = rows.filter((r) => r.correct).length;
  const newOverall = rows.filter((r) => looseAnswerMatch(r.gold, r.predicted)).length;

  const oldNum = numerical.filter((r) => r.correct).length;
  const newNum = numerical.filter((r) => looseAnswerMatch(r.gold, r.predicted)).length;

  const oldNonNum = nonNumerical.filter((r) => r.correct).length;
  const newNonNum = nonNumerical.filter((r) => looseAnswerMatch(r.gold, r.predicted)).length;

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("FRAMES results.jsonl — Offline Re-grade (deterministic match only)");
  console.log("Note: original tier-2 was LLM judge → this is a LOWER BOUND.");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`${"Bucket".padEnd(20)} ${"Before".padEnd(18)} ${"After".padEnd(18)} Delta`);
  console.log("─".repeat(72));

  const fmt = (n: number, d: number) => `${n}/${d} (${(n / d * 100).toFixed(1)}%)`.padEnd(18);

  console.log(`${"Overall".padEnd(20)} ${fmt(oldOverall, total)}${fmt(newOverall, total)}${newOverall - oldOverall >= 0 ? "+" : ""}${newOverall - oldOverall}`);
  console.log(`${"Numerical".padEnd(20)} ${fmt(oldNum, numerical.length)}${fmt(newNum, numerical.length)}${newNum - oldNum >= 0 ? "+" : ""}${newNum - oldNum}`);
  console.log(`${"Non-numerical".padEnd(20)} ${fmt(oldNonNum, nonNumerical.length)}${fmt(newNonNum, nonNumerical.length)}${newNonNum - oldNonNum >= 0 ? "+" : ""}${newNonNum - oldNonNum}`);
  console.log("═══════════════════════════════════════════════════════════════");

  // Detail rows that changed
  const changes = rows.filter((r) => r.correct !== looseAnswerMatch(r.gold, r.predicted));
  if (changes.length > 0) {
    console.log(`\nChanged rows (${changes.length}):`);
    for (const r of changes) {
      const newMatch = looseAnswerMatch(r.gold, r.predicted);
      const dir = newMatch ? "FALSE→TRUE" : "TRUE→FALSE";
      console.log(`  idx=${r.idx} [${dir}] was_matchType=${r.matchType}`);
      console.log(`    gold:      ${JSON.stringify(r.gold)}`);
      console.log(`    predicted: ${JSON.stringify(r.predicted.slice(0, 80))}`);
    }
  } else {
    console.log("\nNo rows changed between old and new deterministic match.");
  }
}

function regradeNumeric(): void {
  const rows = loadJsonl<RederiveRecord>(NUMERIC_PATH);
  if (rows.length === 0) {
    console.log(`[regrade] numeric-rederive.jsonl not found or empty at ${NUMERIC_PATH}`);
    return;
  }

  const models = [...new Set(rows.map((r) => r.model))].sort();
  const numQuestions = new Set(rows.map((r) => r.idx)).size;

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("FRAMES numeric-rederive.jsonl — Offline Re-grade (deterministic only)");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`Numerical questions: ${numQuestions}`);
  console.log(`${"Model".padEnd(30)} ${"Before".padEnd(16)} ${"After".padEnd(16)} Delta`);
  console.log("─".repeat(72));

  for (const model of models) {
    const mr = rows.filter((r) => r.model === model);
    const oldCorrect = mr.filter((r) => r.correct).length;
    const newCorrect = mr.filter((r) => looseAnswerMatch(r.gold, r.predicted)).length;
    const fmt = (n: number) => `${n}/${mr.length} (${(n / mr.length * 100).toFixed(0)}%)`.padEnd(16);
    const delta = newCorrect - oldCorrect;
    console.log(`${model.padEnd(30)} ${fmt(oldCorrect)}${fmt(newCorrect)}${delta >= 0 ? "+" : ""}${delta}`);

    const changes = mr.filter((r) => r.correct !== looseAnswerMatch(r.gold, r.predicted));
    for (const r of changes) {
      const newMatch = looseAnswerMatch(r.gold, r.predicted);
      const dir = newMatch ? "FALSE→TRUE" : "TRUE→FALSE";
      console.log(`  idx=${r.idx} [${dir}] hadAnswerLine=${r.hadAnswerLine}`);
      console.log(`    gold:      ${JSON.stringify(r.gold)}`);
      console.log(`    predicted: ${JSON.stringify(r.predicted.slice(0, 80))}`);
    }
  }
  console.log("═══════════════════════════════════════════════════════════════\n");
}

// ─── CLI entry ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const doResults = !args.includes("--numeric-only");
const doNumeric = !args.includes("--results-only");

if (doResults) regradeResults();
if (doNumeric) regradeNumeric();
