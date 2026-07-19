/**
 * frames-numeric-rederive.ts — Reasoning-model ablation on FRAMES numerical questions.
 *
 * Tests whether a LOCAL reasoning model can fix the deep-research pipeline's
 * numerical-reasoning failure. On FRAMES, the non-thinking coder synth
 * (qwen3-coder-next-80b) scores ~0.10 on numerical questions. Hypothesis: a
 * reasoning model given the same gold facts CAN compute the answer.
 *
 * For each NUMERICAL question (reasoning_types contains "Numerical"), and for
 * each model, we:
 *   1. Build a derivation prompt: question + gold sources (prefixed [S#], truncated
 *      to ~12000 chars total), with instruction to show all arithmetic and output
 *      "ANSWER: <answer>" on the final line.
 *   2. Call the gateway via OpenAI SDK.
 *   3. Strip <think>...</think> from content (for qwen35-a3b inline thinking).
 *   4. Parse the last ANSWER: line; fall back to last non-empty line.
 *   5. Grade with looseAnswerMatch (deterministic, numeric-aware).
 *   6. Record to data/frames/numeric-rederive.jsonl (resumable — skip done idx+model pairs).
 *
 * The first model listed (qwen3-coder-next-80b) is the control — same model that
 * scored 0.10 in the pipeline. The others are reasoning-model candidates.
 *
 * Usage:
 *   tsx scripts/frames-numeric-rederive.ts [--smoke] [--model <id>]
 *
 *   --smoke      Run only the control model on idx=2 (first numerical Q) and exit.
 *   --model <id> Run only that model (useful for resuming a specific arm).
 *
 * Prerequisites:
 *   ssh -fN -L 18091:127.0.0.1:8091 m5
 *   RESEARCH_GATEWAY_URL defaults to http://127.0.0.1:18091/v1
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";
import { looseAnswerMatch } from "./frames-grade.js";
import { stripThink } from "../src/homeserver/deep-research.js";

// ─── Paths ────────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const FRAMES_DIR = join(REPO_ROOT, "data", "frames");
const CORPUS_DIR = join(FRAMES_DIR, "corpus");
const RESULTS_PATH = join(FRAMES_DIR, "results.jsonl");
const OUT_PATH = join(FRAMES_DIR, "numeric-rederive.jsonl");

// ─── Config ───────────────────────────────────────────────────────────────────

const GATEWAY_URL = (
  process.env["RESEARCH_GATEWAY_URL"] ?? "http://127.0.0.1:18091/v1"
).replace(/\/$/, "");
const GATEWAY_KEY = process.env["RESEARCH_GATEWAY_API_KEY"] ?? "x";

/** Models to sweep: control first, then reasoning candidates. */
const ALL_MODELS = [
  "qwen3-coder-next-80b", // control — the failing pipeline synth
  "qwen35-a3b",           // small reasoning model with inline <think>
  "gpt-oss-120b",         // larger reasoning candidate
];

/** Context ceiling for gold facts concatenated. */
const MAX_CONTEXT_CHARS = 12_000;

/** Token budget for each call. Reasoning models blank when starved — keep generous. */
const MAX_TOKENS = 16_000;

/** Temperature — low for deterministic arithmetic. */
const TEMPERATURE = 0.3;

// ─── Types ────────────────────────────────────────────────────────────────────

interface FramesResult {
  idx: number;
  question: string;
  gold: string;
  predicted: string;
  correct: boolean;
  matchType: string;
  reasoning_types: string;
  stats: unknown;
}

interface CorpusSource {
  id: string;
  url: string;
  title: string;
  tier: string;
  markdown: string;
}

interface Corpus {
  query: string;
  sources: CorpusSource[];
}

interface RederiveRecord {
  idx: number;
  question: string;
  gold: string;
  model: string;
  predicted: string;
  correct: boolean;
  matchType: "normalized" | "judge-no" | "blank";
  hadAnswerLine: boolean;
  completionChars: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Load numerical questions from results.jsonl (reasoning_types contains "Numerical"). */
function loadNumericalResults(): FramesResult[] {
  if (!existsSync(RESULTS_PATH)) {
    throw new Error(`results.jsonl not found at ${RESULTS_PATH}`);
  }
  return readFileSync(RESULTS_PATH, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as FramesResult)
    .filter((r) => r.reasoning_types.includes("Numerical"));
}

/** Load done {idx,model} pairs from the output file (for resumability). */
function loadDone(): Set<string> {
  if (!existsSync(OUT_PATH)) return new Set();
  const done = new Set<string>();
  readFileSync(OUT_PATH, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .forEach((l) => {
      try {
        const r = JSON.parse(l) as RederiveRecord;
        done.add(`${r.idx}::${r.model}`);
      } catch {
        /* skip malformed lines */
      }
    });
  return done;
}

/** Build the gold-facts context string (concatenated sources, truncated). */
function buildContext(corpus: Corpus): string {
  const parts: string[] = [];
  let total = 0;
  for (const src of corpus.sources) {
    const header = `[${src.id}] ${src.title}:\n`;
    const body = src.markdown;
    const available = MAX_CONTEXT_CHARS - total - header.length - 2;
    if (available <= 0) break;
    const chunk =
      body.length > available ? body.slice(0, available) + "…" : body;
    parts.push(header + chunk);
    total += header.length + chunk.length + 2;
    if (total >= MAX_CONTEXT_CHARS) break;
  }
  return parts.join("\n\n");
}

/** Build the derivation prompt for a single question + corpus. */
function buildPrompt(question: string, contextStr: string): string {
  return (
    `You are answering a question that requires combining facts and doing exact arithmetic. ` +
    `Work step by step, show every calculation explicitly, then on the FINAL line output ` +
    `exactly: ANSWER: <the final answer only>\n\n` +
    `QUESTION: ${question}\n\n` +
    `GOLD FACTS:\n${contextStr}\n\n` +
    `Now work through the arithmetic step by step, then output on the FINAL line: ANSWER: <answer>`
  );
}

/**
 * Extract the predicted answer from the completion text.
 * Strips <think>...</think> first (handles qwen35-a3b inline reasoning).
 * Looks for the last "ANSWER: ..." line; falls back to last non-empty line.
 */
function extractAnswer(raw: string): { predicted: string; hadAnswerLine: boolean } {
  const stripped = stripThink(raw);
  const lines = stripped.split("\n");

  // Walk from bottom to find the last ANSWER: line
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i]!.match(/ANSWER:\s*(.+)/i);
    if (m && m[1]) {
      return { predicted: m[1].trim(), hadAnswerLine: true };
    }
  }

  // Fallback: last non-empty line
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i]!.trim();
    if (t.length > 0) {
      return { predicted: t, hadAnswerLine: false };
    }
  }

  return { predicted: "", hadAnswerLine: false };
}

/**
 * Grade the predicted answer:
 *   - looseAnswerMatch → "normalized"
 *   - blank → "blank"
 *   - else → "judge-no" (no LLM judge for numeric — deterministic is sufficient here)
 */
function grade(
  gold: string,
  predicted: string
): { correct: boolean; matchType: "normalized" | "judge-no" | "blank" } {
  if (!predicted) return { correct: false, matchType: "blank" };
  if (looseAnswerMatch(gold, predicted)) return { correct: true, matchType: "normalized" };
  return { correct: false, matchType: "judge-no" };
}

// ─── Core runner ─────────────────────────────────────────────────────────────

async function runOne(
  item: FramesResult,
  model: string,
  client: OpenAI
): Promise<RederiveRecord> {
  const corpusPath = join(CORPUS_DIR, `${item.idx}.json`);
  const corpus: Corpus = JSON.parse(readFileSync(corpusPath, "utf-8"));

  const contextStr = buildContext(corpus);
  const userPrompt = buildPrompt(item.question, contextStr);

  const resp = await client.chat.completions.create({
    model,
    messages: [{ role: "user", content: userPrompt }],
    temperature: TEMPERATURE,
    max_tokens: MAX_TOKENS,
  });

  // Some reasoning models expose thinking in reasoning_content; content may be empty if
  // the model only returns reasoning. Fall back to reasoning_content in that case.
  const rawMsg = resp.choices[0]?.message as unknown as Record<string, unknown>;
  const rawContent =
    (rawMsg?.["content"] as string | null) ??
    (rawMsg?.["reasoning_content"] as string | null) ??
    "";

  const { predicted, hadAnswerLine } = extractAnswer(rawContent);
  const { correct, matchType } = grade(item.gold, predicted);

  return {
    idx: item.idx,
    question: item.question,
    gold: item.gold,
    model,
    predicted,
    correct,
    matchType,
    hadAnswerLine,
    completionChars: rawContent.length,
  };
}

// ─── Aggregate table ──────────────────────────────────────────────────────────

function printAggregate(records: RederiveRecord[], models: string[], total: number): void {
  console.log("\n── Aggregate results ──────────────────────────────────────");
  console.log(`Numerical questions: ${total} | Pipeline baseline: 0.10 (1/${total})\n`);

  const header = ["Model".padEnd(30), "Correct", "Acc", "Blanks", "ParseFail"].join("  ");
  console.log(header);
  console.log("─".repeat(header.length));

  for (const model of models) {
    const rows = records.filter((r) => r.model === model);
    if (rows.length === 0) continue;
    const correct = rows.filter((r) => r.correct).length;
    const blanks = rows.filter((r) => r.matchType === "blank").length;
    // Parse-fail: model produced output but no ANSWER: line was found (fell back to last line)
    const parseFails = rows.filter((r) => !r.hadAnswerLine && r.matchType !== "blank").length;
    const acc = (correct / rows.length).toFixed(2);
    console.log(
      [
        model.padEnd(30),
        `${correct}/${rows.length}`.padEnd(7),
        acc.padEnd(5),
        blanks > 0 ? `${blanks} blank`.padEnd(9) : "".padEnd(9),
        parseFails > 0 ? `${parseFails} parse-fail` : "",
      ].join("  ")
    );
  }
  console.log("");
}

// ─── CLI entry ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const smokeMode = args.includes("--smoke");
  const modelFlag = args.indexOf("--model");
  const modelFilter = modelFlag >= 0 ? args[modelFlag + 1] : null;

  const models = modelFilter ? [modelFilter] : ALL_MODELS;

  // Verify gateway reachability before doing any work
  {
    const testClient = new OpenAI({ baseURL: GATEWAY_URL, apiKey: GATEWAY_KEY });
    try {
      await testClient.models.list();
    } catch (e) {
      process.stderr.write(
        `[rederive] ERROR: cannot reach gateway at ${GATEWAY_URL}\n` +
          `  Make sure the port-forward is up: ssh -fN -L 18091:127.0.0.1:8091 m5\n` +
          `  Or set RESEARCH_GATEWAY_URL.\n` +
          `  Error: ${e instanceof Error ? e.message : String(e)}\n`
      );
      process.exit(1);
    }
  }

  const numerical = loadNumericalResults();
  console.log(
    `[rederive] Numerical questions: ${numerical.length} (filter: reasoning_types contains "Numerical")`
  );
  console.log(`[rederive] Models: ${models.join(", ")}`);
  console.log(`[rederive] Output: ${OUT_PATH}`);
  console.log(`[rederive] Gateway: ${GATEWAY_URL}\n`);

  if (smokeMode) {
    // Smoke: control model on the first numerical question only
    const item = numerical[0];
    if (!item) { console.error("No numerical questions found."); process.exit(1); }
    const smokeModel = "qwen3-coder-next-80b";
    console.log(`[smoke] idx=${item.idx} question="${item.question.slice(0, 60)}..."`);
    console.log(`[smoke] gold="${item.gold}"`);
    console.log(`[smoke] model=${smokeModel}\n`);

    const client = new OpenAI({ baseURL: GATEWAY_URL, apiKey: GATEWAY_KEY });
    const rec = await runOne(item, smokeModel, client);

    console.log(`[smoke] predicted="${rec.predicted}"`);
    console.log(`[smoke] correct=${rec.correct}  matchType=${rec.matchType}`);
    console.log(`[smoke] hadAnswerLine=${rec.hadAnswerLine}  completionChars=${rec.completionChars}`);
    return;
  }

  // Full sweep
  const done = loadDone();
  const client = new OpenAI({ baseURL: GATEWAY_URL, apiKey: GATEWAY_KEY });

  const allRecords: RederiveRecord[] = [];

  // Load already-done records so the aggregate table is complete even on a resume
  if (existsSync(OUT_PATH)) {
    readFileSync(OUT_PATH, "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .forEach((l) => {
        try { allRecords.push(JSON.parse(l) as RederiveRecord); } catch { /* skip */ }
      });
  }

  let skipped = 0;
  let ran = 0;

  for (const model of models) {
    for (const item of numerical) {
      const key = `${item.idx}::${model}`;
      if (done.has(key)) {
        skipped++;
        continue;
      }

      process.stderr.write(
        `[rederive] [${model}] idx=${item.idx} gold="${item.gold}" — calling...\n`
      );

      try {
        const rec = await runOne(item, model, client);
        appendFileSync(OUT_PATH, JSON.stringify(rec) + "\n", "utf-8");
        allRecords.push(rec);
        done.add(key);
        ran++;
        process.stderr.write(
          `  → predicted="${rec.predicted}" correct=${rec.correct} ` +
            `hadAnswerLine=${rec.hadAnswerLine} chars=${rec.completionChars}\n`
        );
      } catch (e) {
        process.stderr.write(
          `  → ERROR: ${e instanceof Error ? e.message : String(e)}\n`
        );
      }
    }
  }

  console.log(`\n[rederive] Done. ran=${ran} skipped=${skipped}`);
  printAggregate(allRecords, models, numerical.length);
}

main().catch((e) => {
  process.stderr.write(`Fatal: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
