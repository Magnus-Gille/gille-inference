/**
 * Deep-research 3-way benchmark.
 *
 *   A = LOCAL    — the harness with M5 local models (qwen3-coder-next-80b + mellum) via :8091.
 *   B = CLAUDE   — the SAME harness, but Claude (Sonnet 4.6) does plan/distill/synth (isolates
 *                  the one variable: local vs frontier reasoning; same ddgs search + trafilatura).
 *   C = REAL DR  — Perplexity Sonar Deep Research (a productized frontier DR), one OpenRouter call.
 *
 * Each query's three reports are judged BLIND (shuffled labels) by two cross-family judges
 * (Claude Opus 4.8 + OpenAI o4-mini) on 5 dimensions + an overall rank. Runs on the LAPTOP so the
 * OpenRouter key never leaves it; the box is only a model backend for A (via the :18091 forward).
 *
 *   OPENROUTER_API_KEY=... tsx scripts/benchmark-deep-research.ts [--queries N] [--out DIR]
 */

import OpenAI from "openai";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadEnv } from "../src/env.js";
import { loadDeepResearchConfig, type DeepResearchConfig } from "../src/homeserver/deep-research-config.js";
import { buildResearchDeps } from "../src/homeserver/deep-research-cli.js";
import { runResearch, looseJson } from "../src/homeserver/deep-research.js";
import type { ChatFn, StageChatFns } from "../src/homeserver/deep-research-types.js";

loadEnv(); // populate process.env from .env BEFORE reading the key / building the client

// ─── config ──────────────────────────────────────────────────────────────────────
const KEY = process.env["OPENROUTER_API_KEY"] ?? "";
const VENV = `${homedir()}/.venvs/research/bin`;
const A_GATEWAY = process.env["BENCH_A_GATEWAY"] ?? "http://127.0.0.1:18091/v1"; // box llama-swap via forward
// System A model roles — override to benchmark a different local brain (e.g. tongyi-dr as a single brain).
const A_PLANNER = process.env["BENCH_A_PLANNER"] ?? "qwen3-coder-next-80b";
const A_DISTILL = process.env["BENCH_A_DISTILL"] ?? "mellum";
const A_SYNTH = process.env["BENCH_A_SYNTH"] ?? "qwen3-coder-next-80b";
// Floor on A's per-call max_tokens — REASONING models (e.g. tongyi-dr) need room for reasoning_content
// before they emit `content`; at the harness's default budgets they return empty (the thinking-model trap).
const A_MIN_TOKENS = Number(process.env["BENCH_A_MIN_TOKENS"] ?? 0);
// Temperature for A's calls. The harness defaults to 0 (right for non-thinking mellum/80b), but a
// reasoning MoE (tongyi-dr) DEGENERATE-LOOPS at temp=0 → set >0 (0.6 is the reasoning-model norm).
const A_TEMP = Number(process.env["BENCH_A_TEMP"] ?? 0);
const CLAUDE = process.env["BENCH_CLAUDE_MODEL"] ?? "anthropic/claude-sonnet-4.6";
const PERPLEXITY = process.env["BENCH_PERPLEXITY_MODEL"] ?? "perplexity/sonar-deep-research";
const JUDGES = ["anthropic/claude-opus-4.8", "openai/o4-mini"];
const MAX_SOURCES = Number(process.env["BENCH_MAX_SOURCES"] ?? 5);

const QUERIES = [
  "What are the main health benefits and risks of intermittent fasting, according to recent clinical evidence?",
  "How does the EU AI Act classify and regulate general-purpose AI (GPAI) models, and what obligations apply?",
  "What is the current scientific consensus on the cardiovascular effects of moderate coffee consumption?",
  "What are the leading proposed resolutions to the Fermi paradox, and how well-supported is each?",
  "How effective and safe are GLP-1 receptor agonists (e.g. semaglutide) for weight loss in adults without diabetes?",
];

const DIMENSIONS = ["factual_accuracy", "depth_coverage", "citation_quality", "coherence", "usefulness"] as const;
const SYSTEMS = ["A_local", "B_claude", "C_perplexity"] as const;
type SystemId = (typeof SYSTEMS)[number];

const or = new OpenAI({ baseURL: "https://openrouter.ai/api/v1", apiKey: KEY, timeout: 900_000, maxRetries: 2 });

function baseConfig(): DeepResearchConfig {
  return {
    ...loadDeepResearchConfig(),
    searchProvider: "ddgs",
    searchFallbackProvider: "ddgs",
    ddgsPython: `${VENV}/python`,
    ddgsScript: "scripts/ddgs_search.py",
    readerProvider: "trafilatura",
    readerFallbackProvider: "jina",
    trafilaturaCmd: `${VENV}/trafilatura`,
    maxSourcesPerIter: MAX_SOURCES,
    maxQueriesPerIter: 5,
    brain: "local",
  };
}

function fmt(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(0)}s` : `${ms}ms`;
}

// ─── system runners ───────────────────────────────────────────────────────────────

interface RunOut {
  markdown: string;
  ms: number;
  meta: string;
  error?: string;
}

/** Override a ChatFn's max_tokens floor + temperature (reasoning models need headroom + temp>0). */
function withAOverrides(fn: ChatFn, minTokens: number, temperature: number): ChatFn {
  if (minTokens <= 0 && temperature <= 0) return fn;
  return (req) =>
    fn({
      ...req,
      ...(minTokens > 0 ? { maxTokens: Math.max(req.maxTokens ?? 0, minTokens) } : {}),
      ...(temperature > 0 ? { temperature: req.temperature ?? temperature } : {}),
    });
}

async function runHarness(
  query: string,
  gatewayUrl: string,
  apiKey: string,
  models: { planner: string; distill: string; synth: string },
  minTokens = 0,
  temperature = 0
): Promise<RunOut> {
  const cfg: DeepResearchConfig = {
    ...baseConfig(),
    gatewayUrl,
    gatewayApiKey: apiKey,
    plannerModel: models.planner,
    distillModel: models.distill,
    synthModel: models.synth,
  };
  const deps = buildResearchDeps(cfg, {}, { log: (m) => process.stderr.write(`    · ${m}\n`) });
  if (minTokens > 0 || temperature > 0) {
    const c = deps.chat as StageChatFns;
    deps.chat = {
      planner: withAOverrides(c.planner, minTokens, temperature),
      distiller: withAOverrides(c.distiller, minTokens, temperature),
      synthesizer: withAOverrides(c.synthesizer, minTokens, temperature),
      ...(c.verifier ? { verifier: withAOverrides(c.verifier, minTokens, temperature) } : {}),
    };
  }
  const t0 = Date.now();
  try {
    const res = await runResearch({ query, depth: "quick", nowIso: new Date().toISOString() }, deps);
    return {
      markdown: res.report.markdown,
      ms: Date.now() - t0,
      meta: `sources=${res.stats.sourcesFetched} claims=${res.stats.claimsExtracted} cite=${(res.stats.citationPrecision * 100).toFixed(0)}% tok=${res.stats.totalCompletionTokens}`,
    };
  } catch (e) {
    return { markdown: "", ms: Date.now() - t0, meta: "", error: (e as Error).message };
  }
}

async function runPerplexity(query: string): Promise<RunOut> {
  const t0 = Date.now();
  try {
    const resp = await or.chat.completions.create({
      model: PERPLEXITY,
      messages: [
        { role: "user", content: `${query}\n\nWrite a thorough, well-structured research report with inline source citations.` },
      ],
    });
    return { markdown: resp.choices[0]?.message?.content ?? "", ms: Date.now() - t0, meta: `model=${PERPLEXITY}` };
  } catch (e) {
    return { markdown: "", ms: Date.now() - t0, meta: "", error: (e as Error).message };
  }
}

// ─── judging (blind: shuffled display labels) ──────────────────────────────────────

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

type JudgeScores = Record<string, { rank: number; note: string } & Record<(typeof DIMENSIONS)[number], number>>;

async function judge(
  judgeModel: string,
  query: string,
  presented: { label: string; markdown: string }[]
): Promise<JudgeScores | null> {
  const body = presented
    .map((p) => `### ${p.label}\n\n${p.markdown.slice(0, 6000)}${p.markdown.length > 6000 ? "\n…[truncated]" : ""}`)
    .join("\n\n---\n\n");
  const prompt =
    `You are a rigorous, impartial judge of research reports. The reports below all answer the same question. ` +
    `Judge ONLY their content; you do not know which system produced which.\n\n` +
    `QUESTION: ${query}\n\n${body}\n\n` +
    `Score EACH report from 1 (poor) to 5 (excellent) on: factual_accuracy, depth_coverage, citation_quality, ` +
    `coherence, usefulness. Then give an overall rank (1 = best). Penalise unsupported claims and missing citations. ` +
    `Respond ONLY with JSON keyed by the report label, e.g. ` +
    `{"${presented[0]!.label}":{"factual_accuracy":4,"depth_coverage":3,"citation_quality":5,"coherence":4,"usefulness":4,"rank":2,"note":"one-line rationale"}, ...}`;
  try {
    const resp = await or.chat.completions.create({
      model: judgeModel,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 2000,
    });
    const parsed = looseJson(resp.choices[0]?.message?.content ?? "") as JudgeScores | null;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (e) {
    process.stderr.write(`    judge ${judgeModel} failed: ${(e as Error).message}\n`);
    return null;
  }
}

// ─── main ───────────────────────────────────────────────────────────────────────

interface QueryResult {
  query: string;
  outputs: Record<SystemId, RunOut>;
  judgments: { judge: string; scores: Record<SystemId, { dims: Record<string, number>; rank: number; note: string }> }[];
}

async function main(): Promise<void> {
  if (!KEY) throw new Error("OPENROUTER_API_KEY not set");
  const nQueries = Number(process.env["BENCH_QUERIES"] ?? QUERIES.length);
  const queries = QUERIES.slice(0, nQueries);
  const outDir = process.env["BENCH_OUT"] ?? join("data", "research", `benchmark-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  mkdirSync(outDir, { recursive: true });
  process.stderr.write(`\n=== deep-research benchmark: ${queries.length} queries, A=${A_GATEWAY} B=${CLAUDE} C=${PERPLEXITY} ===\n`);

  const results: QueryResult[] = [];

  for (let qi = 0; qi < queries.length; qi++) {
    const query = queries[qi]!;
    process.stderr.write(`\n[Q${qi + 1}/${queries.length}] ${query}\n`);

    process.stderr.write(`  A (local)…\n`);
    const A = await runHarness(query, A_GATEWAY, "", { planner: A_PLANNER, distill: A_DISTILL, synth: A_SYNTH }, A_MIN_TOKENS, A_TEMP);
    process.stderr.write(`  A done (${fmt(A.ms)} ${A.meta || A.error})\n  B (claude)…\n`);
    const B = await runHarness(query, "https://openrouter.ai/api/v1", KEY, { planner: CLAUDE, distill: CLAUDE, synth: CLAUDE });
    process.stderr.write(`  B done (${fmt(B.ms)} ${B.meta || B.error})\n  C (perplexity)…\n`);
    const C = await runPerplexity(query);
    process.stderr.write(`  C done (${fmt(C.ms)} ${C.meta || C.error})\n`);

    const outputs: Record<SystemId, RunOut> = { A_local: A, B_claude: B, C_perplexity: C };
    for (const s of SYSTEMS) writeFileSync(join(outDir, `q${qi + 1}-${s}.md`), outputs[s].markdown || `(no output: ${outputs[s].error})`, "utf-8");

    // blind judging — shuffle which report gets which display label
    const available = SYSTEMS.filter((s) => outputs[s].markdown.trim().length > 50);
    const labels = ["Report 1", "Report 2", "Report 3"];
    const order = shuffle(available);
    const presented = order.map((s, i) => ({ label: labels[i]!, markdown: outputs[s].markdown }));
    const labelToSystem = new Map(order.map((s, i) => [labels[i]!, s]));

    const judgments: QueryResult["judgments"] = [];
    for (const jm of JUDGES) {
      process.stderr.write(`  judge ${jm}…\n`);
      const scores = await judge(jm, query, presented);
      if (!scores) continue;
      const mapped: Record<string, { dims: Record<string, number>; rank: number; note: string }> = {};
      for (const [label, sys] of labelToSystem) {
        const sc = scores[label];
        if (!sc) continue;
        const dims: Record<string, number> = {};
        for (const d of DIMENSIONS) dims[d] = Number((sc as Record<string, unknown>)[d]) || 0;
        mapped[sys] = { dims, rank: Number(sc.rank) || 0, note: String(sc.note ?? "").slice(0, 200) };
      }
      judgments.push({ judge: jm, scores: mapped as Record<SystemId, { dims: Record<string, number>; rank: number; note: string }> });
    }
    results.push({ query, outputs, judgments });
  }

  // ─── aggregate ───
  const agg: Record<SystemId, { dimSum: Record<string, number>; dimN: number; rankSum: number; rankN: number; wins: number; runs: number; errors: number; msSum: number }> =
    Object.fromEntries(SYSTEMS.map((s) => [s, { dimSum: {}, dimN: 0, rankSum: 0, rankN: 0, wins: 0, runs: 0, errors: 0, msSum: 0 }])) as never;
  for (const s of SYSTEMS) for (const d of DIMENSIONS) agg[s].dimSum[d] = 0;

  for (const r of results) {
    for (const s of SYSTEMS) {
      agg[s].msSum += r.outputs[s].ms;
      if (r.outputs[s].error) agg[s].errors++;
      else agg[s].runs++;
    }
    for (const j of r.judgments) {
      for (const s of SYSTEMS) {
        const sc = j.scores[s];
        if (!sc) continue;
        for (const d of DIMENSIONS) agg[s].dimSum[d]! += sc.dims[d] ?? 0;
        agg[s].dimN++;
        if (sc.rank > 0) {
          agg[s].rankSum += sc.rank;
          agg[s].rankN++;
          if (sc.rank === 1) agg[s].wins++;
        }
      }
    }
  }

  const sysName: Record<SystemId, string> = { A_local: "A · Local (M5)", B_claude: "B · Claude Sonnet 4.6", C_perplexity: "C · Perplexity DR" };
  const lines: string[] = [];
  lines.push(`# Deep-research benchmark — ${queries.length} queries`, "");
  lines.push(`> Generated ${new Date().toISOString()} · judges: ${JUDGES.join(" + ")} · max-sources/query: ${MAX_SOURCES}`, "");
  lines.push(`## Mean scores (1–5, averaged across queries × judges)`, "");
  lines.push(`| System | ${DIMENSIONS.join(" | ")} | **avg** | mean rank | #rank-1 | avg time |`);
  lines.push(`|---|${DIMENSIONS.map(() => "---").join("|")}|---|---|---|---|`);
  for (const s of SYSTEMS) {
    const a = agg[s];
    const dimAvgs = DIMENSIONS.map((d) => (a.dimN ? (a.dimSum[d]! / a.dimN).toFixed(2) : "—"));
    const overall = a.dimN ? (DIMENSIONS.reduce((x, d) => x + a.dimSum[d]!, 0) / (a.dimN * DIMENSIONS.length)).toFixed(2) : "—";
    const meanRank = a.rankN ? (a.rankSum / a.rankN).toFixed(2) : "—";
    const avgTime = a.runs + a.errors ? fmt(a.msSum / (a.runs + a.errors)) : "—";
    lines.push(`| ${sysName[s]} | ${dimAvgs.join(" | ")} | **${overall}** | ${meanRank} | ${a.wins} | ${avgTime} |`);
  }
  lines.push("", `## Per-query detail`, "");
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    lines.push(`### Q${i + 1}: ${r.query}`, "");
    for (const s of SYSTEMS) {
      const o = r.outputs[s];
      lines.push(`- **${sysName[s]}** — ${o.error ? `❌ ${o.error}` : `${fmt(o.ms)}, ${o.meta}`}`);
    }
    for (const j of r.judgments) {
      const ranks = SYSTEMS.map((s) => `${s.split("_")[0]}=${j.scores[s]?.rank ?? "?"}`).join(" ");
      lines.push(`  - judge \`${j.judge}\`: ranks ${ranks}`);
    }
    lines.push("");
  }

  const reportMd = lines.join("\n");
  writeFileSync(join(outDir, "BENCHMARK.md"), reportMd, "utf-8");
  writeFileSync(join(outDir, "results.json"), JSON.stringify({ queries, results, agg }, null, 2), "utf-8");
  process.stderr.write(`\n=== done → ${join(outDir, "BENCHMARK.md")} ===\n`);
  console.log(reportMd);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
