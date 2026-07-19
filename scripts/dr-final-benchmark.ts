/**
 * Final validation: does the grounding-repair (reground) win survive END-TO-END + the blind judge?
 *
 *   A_baseline  — full local pipeline, synthStrategy=oneshot (current production)
 *   A_reground  — full local pipeline, synthStrategy=reground (the improvement) — ONLY variable vs A_baseline
 *   B_claude    — same harness, Claude Sonnet 4.6 does plan/distill/synth (the established 3.86 ceiling)
 *
 * Same ddgs + Trafilatura + box models (via :18091) for A; OpenRouter for B + judges. Blind-judged by
 * Claude Opus 4.8 + OpenAI o4-mini on 5 dims + rank. Compare to the 3-way benchmark (Local 3.00 /
 * Claude 3.86 / Perplexity 4.58, docs/deep-research-benchmark-2026-06-20.md).
 *
 *   OPENROUTER_API_KEY=... tsx scripts/dr-final-benchmark.ts [--queries N]
 */
import OpenAI from "openai";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadEnv } from "../src/env.js";
import { loadDeepResearchConfig, type DeepResearchConfig } from "../src/homeserver/deep-research-config.js";
import { buildResearchDeps } from "../src/homeserver/deep-research-cli.js";
import { runResearch, looseJson } from "../src/homeserver/deep-research.js";

loadEnv();
const KEY = process.env["OPENROUTER_API_KEY"] ?? "";
const VENV = `${homedir()}/.venvs/research/bin`;
const A_GATEWAY = process.env["BENCH_A_GATEWAY"] ?? "http://127.0.0.1:18091/v1";
const A_MODEL = process.env["BENCH_A_MODEL"] ?? "qwen3-coder-next-80b";
const A_DISTILL = process.env["BENCH_A_DISTILL"] ?? "mellum";
const A_SYNTH_TEMP = Number(process.env["BENCH_A_SYNTH_TEMP"] ?? 0);
const CLAUDE = process.env["BENCH_CLAUDE_MODEL"] ?? "anthropic/claude-sonnet-4.6";
const JUDGES = ["anthropic/claude-opus-4.8", "openai/o4-mini"];
const MAX_SOURCES = Number(process.env["BENCH_MAX_SOURCES"] ?? 8);
const DIMENSIONS = ["factual_accuracy", "depth_coverage", "citation_quality", "coherence", "usefulness"] as const;
const SYSTEMS = ["A_baseline", "A_reground", "B_claude"] as const;
type SystemId = (typeof SYSTEMS)[number];

const QUERIES = [
  "What are the main health benefits and risks of intermittent fasting, according to recent clinical evidence?",
  "How does the EU AI Act classify and regulate general-purpose AI (GPAI) models, and what obligations apply?",
  "What is the current scientific consensus on the cardiovascular effects of moderate coffee consumption?",
  "What are the leading proposed resolutions to the Fermi paradox, and how well-supported is each?",
  "How effective and safe are GLP-1 receptor agonists (e.g. semaglutide) for weight loss in adults without diabetes?",
];

const or = new OpenAI({ baseURL: "https://openrouter.ai/api/v1", apiKey: KEY, timeout: 900_000, maxRetries: 2 });

function baseCfg(over: Partial<DeepResearchConfig>): DeepResearchConfig {
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
    ...over,
  };
}

function fmt(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(0)}s` : `${ms}ms`;
}

interface RunOut {
  markdown: string;
  ms: number;
  meta: string;
  error?: string;
}

// A_improved may use a DIFFERENT synth model than the planner (the night's finding: a general writer
// beats the coder at synthesis). Defaults keep A_improved on the same model as baseline (= isolates
// the reground strategy); set BENCH_A_SYNTH_MODEL=qwen3-30b-instruct to also test the model swap.
const A_IMPROVED_SYNTH = process.env["BENCH_A_SYNTH_MODEL"] ?? A_MODEL;
const A_IMPROVED_MINTOK = Number(process.env["BENCH_A_SYNTH_MINTOK"] ?? 0);
// atomic is a citation-vs-readability trade-off (judges penalize the choppy short bodies), so the
// improved arm defaults to reground-ALONE. Set BENCH_A_ATOMIC=true to benchmark reground+atomic.
const A_IMPROVED_ATOMIC = process.env["BENCH_A_ATOMIC"] === "true";
// Quality-max: spend the (research-spike-acceptable) latency on depth. Improved arm + Claude use this;
// baseline stays quick (= today's default). Set BENCH_IMPROVED_DEPTH=thorough for the gap loop.
const IMPROVED_DEPTH: Depth = process.env["BENCH_IMPROVED_DEPTH"] === "thorough" ? "thorough" : "quick";

type Depth = "quick" | "thorough";
async function runLocal(query: string, opts: { synthModel: string; strategy: "oneshot" | "reground"; synthTemp: number; synthMinTokens: number; atomic: boolean; depth: Depth }): Promise<RunOut> {
  const cfg = baseCfg({
    gatewayUrl: A_GATEWAY,
    gatewayApiKey: "",
    plannerModel: A_MODEL,
    distillModel: A_DISTILL,
    synthModel: opts.synthModel,
    synthStrategy: opts.strategy,
    synthRepairRounds: 1,
    synthTemp: opts.synthTemp,
    synthMinTokens: opts.synthMinTokens,
    synthAtomic: opts.atomic,
  });
  const deps = buildResearchDeps(cfg, {}, { log: (m) => process.stderr.write(`    · ${m}\n`) });
  const t0 = Date.now();
  try {
    const res = await runResearch({ query, depth: opts.depth, nowIso: new Date().toISOString() }, deps);
    return {
      markdown: res.report.markdown,
      ms: Date.now() - t0,
      meta: `sources=${res.stats.sourcesFetched} cite=${(res.stats.citationPrecision * 100).toFixed(0)}% rsupport=${(res.stats.reportSentencePrecision * 100).toFixed(0)}% tok=${res.stats.totalCompletionTokens}`,
    };
  } catch (e) {
    return { markdown: "", ms: Date.now() - t0, meta: "", error: (e as Error).message };
  }
}

async function runClaude(query: string, depth: Depth): Promise<RunOut> {
  const cfg = baseCfg({
    gatewayUrl: "https://openrouter.ai/api/v1",
    gatewayApiKey: KEY,
    plannerModel: CLAUDE,
    distillModel: CLAUDE,
    synthModel: CLAUDE,
    synthStrategy: "oneshot",
  });
  const deps = buildResearchDeps(cfg, {}, { log: (m) => process.stderr.write(`    · ${m}\n`) });
  const t0 = Date.now();
  try {
    const res = await runResearch({ query, depth, nowIso: new Date().toISOString() }, deps);
    return { markdown: res.report.markdown, ms: Date.now() - t0, meta: `sources=${res.stats.sourcesFetched} cite=${(res.stats.citationPrecision * 100).toFixed(0)}%` };
  } catch (e) {
    return { markdown: "", ms: Date.now() - t0, meta: "", error: (e as Error).message };
  }
}

function shuffle<T>(a: T[]): T[] {
  const b = [...a];
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [b[i], b[j]] = [b[j]!, b[i]!];
  }
  return b;
}

type JScore = Record<string, number> & { rank: number; note: string };
async function judge(model: string, query: string, presented: { label: string; markdown: string }[]): Promise<Record<string, JScore> | null> {
  const body = presented.map((p) => `### ${p.label}\n\n${p.markdown.slice(0, 6000)}${p.markdown.length > 6000 ? "\n…[truncated]" : ""}`).join("\n\n---\n\n");
  const prompt =
    `You are a rigorous, impartial judge of research reports answering the same question. Judge ONLY content; ` +
    `you don't know which system produced which.\n\nQUESTION: ${query}\n\n${body}\n\n` +
    `Score EACH 1 (poor)–5 (excellent) on: ${DIMENSIONS.join(", ")}. Then an overall rank (1=best). ` +
    `Penalise unsupported claims and missing/incorrect citations. Respond ONLY with JSON keyed by label, e.g. ` +
    `{"${presented[0]!.label}":{${DIMENSIONS.map((d) => `"${d}":4`).join(",")},"rank":1,"note":"one line"}}`;
  try {
    const resp = await or.chat.completions.create({ model, messages: [{ role: "user", content: prompt }], max_tokens: 2500 });
    const p = looseJson(resp.choices[0]?.message?.content ?? "");
    return p && typeof p === "object" ? (p as never) : null;
  } catch (e) {
    process.stderr.write(`  judge ${model} failed: ${(e as Error).message}\n`);
    return null;
  }
}

async function main(): Promise<void> {
  if (!KEY) throw new Error("OPENROUTER_API_KEY not set");
  const n = Number(process.env["BENCH_QUERIES"] ?? QUERIES.length);
  const queries = QUERIES.slice(0, n);
  const outDir = process.env["BENCH_OUT"] ?? join("data", "research", `final-benchmark-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  mkdirSync(outDir, { recursive: true });

  const agg: Record<SystemId, { dim: Record<string, number>; dimN: number; rankSum: number; rankN: number; wins: number; ms: number; errors: number; runs: number }> =
    Object.fromEntries(SYSTEMS.map((s) => [s, { dim: Object.fromEntries(DIMENSIONS.map((d) => [d, 0])), dimN: 0, rankSum: 0, rankN: 0, wins: 0, ms: 0, errors: 0, runs: 0 }])) as never;

  const perQuery: { query: string; ranks: Record<SystemId, string> }[] = [];

  for (let qi = 0; qi < queries.length; qi++) {
    const query = queries[qi]!;
    process.stderr.write(`\n[Q${qi + 1}/${queries.length}] ${query}\n`);
    process.stderr.write(`  A_baseline (80b oneshot)…\n`);
    const aBase = await runLocal(query, { synthModel: A_MODEL, strategy: "oneshot", synthTemp: 0, synthMinTokens: 0, atomic: false, depth: "quick" });
    process.stderr.write(`  A_baseline done (${fmt(aBase.ms)} ${aBase.meta || aBase.error})\n  A_improved (${A_IMPROVED_SYNTH} reground${A_IMPROVED_ATOMIC ? "+atomic" : ""})…\n`);
    const aReg = await runLocal(query, { synthModel: A_IMPROVED_SYNTH, strategy: "reground", synthTemp: A_SYNTH_TEMP, synthMinTokens: A_IMPROVED_MINTOK, atomic: A_IMPROVED_ATOMIC, depth: IMPROVED_DEPTH });
    process.stderr.write(`  A_reground done (${fmt(aReg.ms)} ${aReg.meta || aReg.error})\n  B_claude…\n`);
    const b = await runClaude(query, IMPROVED_DEPTH);
    process.stderr.write(`  B_claude done (${fmt(b.ms)} ${b.meta || b.error})\n`);

    const outputs: Record<SystemId, RunOut> = { A_baseline: aBase, A_reground: aReg, B_claude: b };
    for (const s of SYSTEMS) {
      writeFileSync(join(outDir, `q${qi + 1}-${s}.md`), outputs[s].markdown || `(no output: ${outputs[s].error})`, "utf-8");
      agg[s].ms += outputs[s].ms;
      if (outputs[s].error) agg[s].errors++;
      else agg[s].runs++;
    }

    const avail = SYSTEMS.filter((s) => outputs[s].markdown.trim().length > 50);
    const labels = ["Report 1", "Report 2", "Report 3"];
    const order = shuffle(avail);
    const presented = order.map((s, i) => ({ label: labels[i]!, markdown: outputs[s].markdown }));
    const labelToSys = new Map(order.map((s, i) => [labels[i]!, s]));
    const ranksThisQ: Record<string, string> = {};
    for (const jm of JUDGES) {
      process.stderr.write(`  judge ${jm}…\n`);
      const scores = await judge(jm, query, presented);
      if (!scores) continue;
      for (const [label, sys] of labelToSys) {
        const sc = scores[label];
        if (!sc) continue;
        for (const d of DIMENSIONS) agg[sys].dim[d]! += Number((sc as Record<string, unknown>)[d]) || 0;
        agg[sys].dimN++;
        const rank = Number(sc.rank) || 0;
        if (rank > 0) {
          agg[sys].rankSum += rank;
          agg[sys].rankN++;
          if (rank === 1) agg[sys].wins++;
        }
        ranksThisQ[`${sys}/${jm.split("/")[1]}`] = String(rank); // full sys id (A_baseline/A_reground don't collide)
      }
    }
    perQuery.push({ query, ranks: ranksThisQ as Record<SystemId, string> });
  }

  const name: Record<SystemId, string> = { A_baseline: "A · Local baseline (oneshot)", A_reground: "A · Local + reground", B_claude: "B · Claude Sonnet 4.6" };
  const lines: string[] = [];
  lines.push(`# Deep-research FINAL benchmark — reground vs baseline vs Claude (${queries.length} queries)`, "");
  lines.push(`> ${new Date().toISOString()} · judges: ${JUDGES.join(" + ")} · max-sources ${MAX_SOURCES} · A synth temp ${A_SYNTH_TEMP}`, "");
  lines.push(`## Mean scores (1–5, queries × judges)`, "");
  lines.push(`| System | ${DIMENSIONS.join(" | ")} | **avg** | mean rank | #rank-1 | avg time |`);
  lines.push(`|---|${DIMENSIONS.map(() => "---").join("|")}|---|---|---|---|`);
  for (const s of SYSTEMS) {
    const a = agg[s];
    const dims = DIMENSIONS.map((d) => (a.dimN ? (a.dim[d]! / a.dimN).toFixed(2) : "—"));
    const overall = a.dimN ? (DIMENSIONS.reduce((x, d) => x + a.dim[d]!, 0) / (a.dimN * DIMENSIONS.length)).toFixed(2) : "—";
    const mr = a.rankN ? (a.rankSum / a.rankN).toFixed(2) : "—";
    const t = a.runs + a.errors ? fmt(a.ms / (a.runs + a.errors)) : "—";
    lines.push(`| ${name[s]} | ${dims.join(" | ")} | **${overall}** | ${mr} | ${a.wins} | ${t} |`);
  }
  lines.push("", "## Per-query ranks (system/judge → rank)", "");
  for (let i = 0; i < perQuery.length; i++) lines.push(`- Q${i + 1}: ${Object.entries(perQuery[i]!.ranks).map(([k, v]) => `${k}=${v}`).join("  ")}`);
  const md = lines.join("\n");
  writeFileSync(join(outDir, "FINAL-BENCHMARK.md"), md, "utf-8");
  process.stderr.write(`\n=== done → ${join(outDir, "FINAL-BENCHMARK.md")} ===\n`);
  console.log(md);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
