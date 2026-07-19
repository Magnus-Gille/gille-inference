/**
 * frames-eval.ts — FRAMES oracle-arm evaluation harness.
 *
 * For each FRAMES sample with a cached corpus:
 *  1. Inject stub SearchProvider + stub Reader (frozen corpus, no live retrieval)
 *  2. Run the DETERMINISTIC pipeline via runCli (mode: "deterministic", brain: "local")
 *  3. Extract a short final answer from the report using mellum (local, free)
 *  4. Grade against the gold answer: tier-1 normalized match, then local LLM judge
 *  5. Record to data/frames/results.jsonl (resumable)
 *
 * Usage:
 *   RESEARCH_GATEWAY_URL=http://127.0.0.1:18091/v1 tsx scripts/frames-eval.ts
 *   RESEARCH_GATEWAY_URL=http://127.0.0.1:18091/v1 tsx scripts/frames-eval.ts --idx 0   # smoke one item
 *   RESEARCH_GATEWAY_URL=http://127.0.0.1:18091/v1 tsx scripts/frames-eval.ts --force    # re-run done items
 *
 * Prerequisites:
 *   ssh -fN -L 18091:127.0.0.1:8091 m5
 *   data/frames/sample.jsonl + data/frames/corpus/*.json must exist (run frames-fetch.ts first)
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";
import {
  runCli,
  makeChatFn,
  type RunCliOptions,
} from "../src/homeserver/deep-research-cli.js";
import {
  resetDeepResearchConfig,
  setDeepResearchConfig,
} from "../src/homeserver/deep-research-config.js";
import type {
  SearchProvider,
  Reader,
  ResearchDeps,
  SearchHit,
  ReadResult,
  ResearchStats,
} from "../src/homeserver/deep-research-types.js";
import { normalizeAnswer, looseAnswerMatch } from "./frames-grade.js";

// ─── Paths ────────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const FRAMES_DIR = join(REPO_ROOT, "data", "frames");
const CORPUS_DIR = join(FRAMES_DIR, "corpus");
const REPORTS_DIR = join(FRAMES_DIR, "reports");
const RESULTS_PATH = join(FRAMES_DIR, "results.jsonl");
const SAMPLE_PATH = join(FRAMES_DIR, "sample.jsonl");

// ─── Config ───────────────────────────────────────────────────────────────────

const GATEWAY_URL = (process.env["RESEARCH_GATEWAY_URL"] ?? "http://127.0.0.1:18091/v1").replace(/\/$/, "");
const GATEWAY_KEY = process.env["RESEARCH_GATEWAY_API_KEY"] ?? "x";
const PLANNER_MODEL = "qwen3-coder-next-80b";
const DISTILL_MODEL = "mellum";
const SYNTH_MODEL = "qwen3-coder-next-80b";
const ANSWER_EXTRACT_MODEL = "mellum";
const JUDGE_MODEL = "qwen3-coder-next-80b";
const REPORT_TRUNC_CHARS = 6_000;

// ─── Types ────────────────────────────────────────────────────────────────────

interface FramesSample {
  idx: number;
  question: string;
  gold_answer: string;
  wiki_links: string[];
  reasoning_types: string;
}

interface CorpusSource {
  id: string;
  url: string;
  title: string;
  tier: "primary" | "secondary" | "tertiary";
  markdown: string;
}

interface Corpus {
  query: string;
  sources: CorpusSource[];
}

export interface FramesResult {
  idx: number;
  question: string;
  gold: string;
  predicted: string;
  correct: boolean;
  matchType: "normalized" | "judge" | "judge-no";
  reasoning_types: string;
  stats: {
    sourcesFetched: number;
    claimsExtracted: number;
    claimsDisputed: number;
    reportSentencePrecision: number;
    citationPrecision: number;
    totalCompletionTokens: number;
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function loadSamples(): FramesSample[] {
  if (!existsSync(SAMPLE_PATH)) {
    throw new Error(`sample.jsonl not found at ${SAMPLE_PATH} — run frames-fetch.ts first`);
  }
  return readFileSync(SAMPLE_PATH, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as FramesSample);
}

function loadDoneIds(): Set<number> {
  if (!existsSync(RESULTS_PATH)) return new Set();
  const done = new Set<number>();
  readFileSync(RESULTS_PATH, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .forEach((l) => {
      try { done.add((JSON.parse(l) as FramesResult).idx); } catch { /* skip */ }
    });
  return done;
}

/** Build a stub SearchProvider over a frozen corpus: returns ALL sources as SearchHits. */
function buildStubSearch(sources: CorpusSource[]): SearchProvider {
  return {
    name: "frozen-frames-corpus",
    async search(_q: string): Promise<SearchHit[]> {
      return sources.map((s) => ({
        url: s.url,
        title: s.title,
        snippet: s.markdown.slice(0, 250),
      }));
    },
  };
}

/** Build a stub Reader over a frozen corpus: serves each source's markdown by URL. */
function buildStubReader(sources: CorpusSource[]): Reader {
  const byUrl = new Map(sources.map((s) => [s.url, s]));
  return {
    name: "frozen-frames-corpus",
    async read(url: string): Promise<ReadResult> {
      const src = byUrl.get(url);
      if (!src) {
        // Unknown URL — return thin result rather than throwing, so the pipeline can continue
        return { url, title: url, markdown: "", isThin: true, fetchedVia: "frozen-frames-corpus" };
      }
      return {
        url,
        title: src.title,
        markdown: src.markdown,
        isThin: false,
        fetchedVia: "frozen-frames-corpus",
      };
    },
  };
}

/** Call mellum to extract a short factual answer from the report. */
async function extractAnswer(question: string, reportMarkdown: string): Promise<string> {
  const client = new OpenAI({ baseURL: GATEWAY_URL, apiKey: GATEWAY_KEY });
  const body = reportMarkdown.slice(0, REPORT_TRUNC_CHARS);
  const resp = await client.chat.completions.create({
    model: ANSWER_EXTRACT_MODEL,
    messages: [
      {
        role: "user",
        content:
          `Question: ${question}\n\nResearch report:\n${body}\n\n` +
          `Return ONLY the final short factual answer (a name/date/number/phrase), no explanation.`,
      },
    ],
    max_tokens: 64,
    temperature: 0,
  });
  return (resp.choices[0]?.message?.content ?? "").trim();
}

/** Grade: tier-1 normalized match → tier-2 local LLM judge. */
async function gradeAnswer(
  gold: string,
  predicted: string
): Promise<{ correct: boolean; matchType: "normalized" | "judge" | "judge-no" }> {
  // Tier 1: deterministic normalized match
  if (looseAnswerMatch(gold, predicted)) {
    return { correct: true, matchType: "normalized" };
  }

  // Tier 2: local LLM judge
  const client = new OpenAI({ baseURL: GATEWAY_URL, apiKey: GATEWAY_KEY });
  const resp = await client.chat.completions.create({
    model: JUDGE_MODEL,
    messages: [
      {
        role: "user",
        content:
          `Gold answer: ${gold}\nModel answer: ${predicted}\n` +
          `Does the model answer match the gold answer (same fact, ignoring phrasing/format)? ` +
          `Reply exactly YES or NO.`,
      },
    ],
    max_tokens: 8,
    temperature: 0,
  });
  const verdict = (resp.choices[0]?.message?.content ?? "").trim().toUpperCase();
  const correct = verdict.startsWith("YES");
  return { correct, matchType: correct ? "judge" : "judge-no" };
}

// ─── Per-item runner ──────────────────────────────────────────────────────────

async function runItem(sample: FramesSample, force: boolean): Promise<FramesResult | null> {
  const corpusPath = join(CORPUS_DIR, `${sample.idx}.json`);
  if (!existsSync(corpusPath)) {
    process.stderr.write(`[eval] [${sample.idx}] SKIP — no corpus file\n`);
    return null;
  }
  const corpus: Corpus = JSON.parse(readFileSync(corpusPath, "utf-8"));
  if (corpus.sources.length === 0) {
    process.stderr.write(`[eval] [${sample.idx}] SKIP — empty corpus\n`);
    return null;
  }

  process.stderr.write(`\n[eval] [${sample.idx}] ${sample.question.slice(0, 70)}...\n`);
  process.stderr.write(`  sources: ${corpus.sources.length}, gold: "${sample.gold_answer}"\n`);

  // Configure pipeline: pin models, local brain, point at gateway
  resetDeepResearchConfig();
  const config = setDeepResearchConfig({
    plannerModel: PLANNER_MODEL,
    distillModel: DISTILL_MODEL,
    synthModel: SYNTH_MODEL,
    brain: "local",
    gatewayUrl: GATEWAY_URL,
    gatewayApiKey: GATEWAY_KEY,
    // Scope the loop to what we have: 1 iteration (corpus is frozen, no benefit to gap loop)
    maxIters: 1,
    maxSourcesPerIter: corpus.sources.length + 2,
    outputDir: REPORTS_DIR,
  });

  const stubSearch = buildStubSearch(corpus.sources);
  const stubReader = buildStubReader(corpus.sources);

  const deps: ResearchDeps = {
    search: stubSearch,
    read: stubReader,
    chat: {
      planner: makeChatFn(GATEWAY_URL, GATEWAY_KEY, PLANNER_MODEL, 0),
      distiller: makeChatFn(GATEWAY_URL, GATEWAY_KEY, DISTILL_MODEL, 0),
      synthesizer: makeChatFn(GATEWAY_URL, GATEWAY_KEY, SYNTH_MODEL, 0),
    },
    config,
    log: (m) => process.stderr.write(`    · ${m}\n`),
  };

  const opts: RunCliOptions = {
    query: sample.question,
    depth: "thorough",
    brain: "local",
    mode: "deterministic",
    noLedger: true,
    nowIso: new Date().toISOString(),
    outputDir: REPORTS_DIR,
  };

  let pipelineStats: ResearchStats;
  let reportMarkdown: string;
  try {
    const result = await runCli(opts, { deps });
    pipelineStats = result.stats;
    reportMarkdown = readFileSync(result.reportPath, "utf-8");
    process.stderr.write(`  → report: ${result.reportPath}\n`);
  } catch (err) {
    process.stderr.write(`  [eval] [${sample.idx}] PIPELINE ERROR: ${err}\n`);
    return null;
  }

  // Extract short answer
  let predicted = "";
  try {
    predicted = await extractAnswer(sample.question, reportMarkdown);
    process.stderr.write(`  → predicted: "${predicted}"\n`);
  } catch (err) {
    process.stderr.write(`  [eval] [${sample.idx}] EXTRACT ERROR: ${err}\n`);
  }

  // Grade
  const { correct, matchType } = await gradeAnswer(sample.gold_answer, predicted);
  process.stderr.write(`  → correct: ${correct} (${matchType})\n`);

  return {
    idx: sample.idx,
    question: sample.question,
    gold: sample.gold_answer,
    predicted,
    correct,
    matchType,
    reasoning_types: sample.reasoning_types,
    stats: {
      sourcesFetched: pipelineStats.sourcesFetched,
      claimsExtracted: pipelineStats.claimsExtracted,
      claimsDisputed: pipelineStats.claimsDisputed,
      reportSentencePrecision: pipelineStats.reportSentencePrecision,
      citationPrecision: pipelineStats.citationPrecision,
      totalCompletionTokens: pipelineStats.totalCompletionTokens,
    },
  };
}

// ─── Aggregate reporting ──────────────────────────────────────────────────────

function printAggregate(results: FramesResult[]): void {
  if (results.length === 0) { console.log("[eval] No results to aggregate."); return; }

  const n = results.length;
  const nCorrect = results.filter((r) => r.correct).length;
  const acc = nCorrect / n;

  // By reasoning_type — FRAMES uses " | " separators; tolerate commas too
  const byType = new Map<string, { correct: number; total: number }>();
  for (const r of results) {
    const types = r.reasoning_types.split(/\s*\|\s*|,/).map((t) => t.trim()).filter(Boolean);
    for (const t of types) {
      const cur = byType.get(t) ?? { correct: 0, total: 0 };
      cur.total++;
      if (r.correct) cur.correct++;
      byType.set(t, cur);
    }
  }

  const meanSentPrec =
    results.reduce((acc, r) => acc + r.stats.reportSentencePrecision, 0) / n;

  console.log(`\n${"═".repeat(60)}`);
  console.log(`FRAMES Oracle-Arm Results (n=${n})`);
  console.log(`${"═".repeat(60)}`);
  console.log(`Overall accuracy:  ${(acc * 100).toFixed(1)}%  (${nCorrect}/${n})`);
  console.log(`  Reference targets: frontier oracle ≈73%, multi-step ≈66%, no-retrieval ≈41%`);
  console.log(`Mean report-sentence precision: ${(meanSentPrec * 100).toFixed(1)}%`);
  console.log(`\nBy reasoning type:`);
  const sorted = Array.from(byType.entries()).sort((a, b) => b[1].total - a[1].total);
  for (const [t, { correct, total }] of sorted) {
    console.log(`  ${t.padEnd(30)} ${(correct / total * 100).toFixed(0)}%  (${correct}/${total})`);
  }
  console.log(`${"═".repeat(60)}\n`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const force = argv.includes("--force");
  const idxFlag = argv.find((_, i) => argv[i - 1] === "--idx");
  const smokeIdx = idxFlag !== undefined ? parseInt(idxFlag, 10) : null;

  const samples = loadSamples();
  const done = force ? new Set<number>() : loadDoneIds();
  mkdirSync(REPORTS_DIR, { recursive: true });

  const toRun = smokeIdx !== null
    ? samples.filter((s) => s.idx === smokeIdx)
    : samples.filter((s) => !done.has(s.idx));

  if (toRun.length === 0) {
    console.log("[eval] All items already done. Use --force to re-run.");
    if (existsSync(RESULTS_PATH)) {
      const allResults: FramesResult[] = readFileSync(RESULTS_PATH, "utf-8")
        .trim().split("\n").filter(Boolean)
        .map((l) => JSON.parse(l) as FramesResult);
      printAggregate(allResults);
    }
    return;
  }

  process.stderr.write(`[eval] Running ${toRun.length} item(s) (${done.size} already done)\n`);

  // In-memory map keyed by idx for last-write-wins dedup (prevents --force from appending dups)
  const resultsMap = new Map<number, FramesResult>();
  // Seed with existing results (only when not forcing — force means replace all re-run items)
  if (!force && existsSync(RESULTS_PATH)) {
    readFileSync(RESULTS_PATH, "utf-8").trim().split("\n").filter(Boolean).forEach((l) => {
      try { const r = JSON.parse(l) as FramesResult; resultsMap.set(r.idx, r); } catch { /* skip */ }
    });
  }

  for (const sample of toRun) {
    const result = await runItem(sample, force);
    if (result) {
      resultsMap.set(result.idx, result);
      // Write after each item so progress is durable (atomic overwrite)
      writeFileSync(
        RESULTS_PATH,
        Array.from(resultsMap.values()).map((r) => JSON.stringify(r)).join("\n") + "\n",
        "utf-8",
      );
    }
  }

  // Aggregate over ALL results in the map
  const allResults = Array.from(resultsMap.values());
  printAggregate(allResults);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
