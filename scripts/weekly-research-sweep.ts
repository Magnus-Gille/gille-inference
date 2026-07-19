#!/usr/bin/env tsx
/**
 * weekly-research-sweep.ts — Job B: weekly EN+ZH research sweep (runs ON the M5 box).
 *
 * Goal: surface newly-published techniques for running the SMARTEST models as FAST as possible on
 * THIS box (AMD Strix Halo / Radeon 8060S, llama.cpp-Vulkan, quantization, speculative decoding,
 * MoE serving, long context). Uses the box's OWN local inference for everything — the deep-research
 * harness with the LOCAL brain (RESEARCH_BRAIN unset / --brain local), endpoint = llama-swap :8091.
 * No frontier tokens are spent.
 *
 * Pipeline: for each curated bilingual query → `deep-research-cli.ts run --brain local` → collect
 * the popular summaries → one LOCAL synthesis pass → a structured "stuff we should try" proposal
 * list (proposals.json + proposals.md + a consolidated report.md). The wrapper then publishes the
 * proposals to Heimdall (post-research-sweep-panel.ts) and rsyncs the report to the /read inbox.
 *
 * USAGE   tsx scripts/weekly-research-sweep.ts [--dry-run] [--max N]
 *   --dry-run  print the query set + planned commands; run no research and no synthesis.
 *
 * ENV
 *   RESEARCH_GATEWAY_URL   http://127.0.0.1:8091/v1   (local llama-swap; no auth)
 *   RESEARCH_SYNTH_MODEL   qwen3-coder-next-80b       (synthesis model)
 *   RESEARCH_PLANNER_MODEL / RESEARCH_DISTILL_MODEL    (passed through to the deep-research CLI)
 *   SEARCH_PROVIDER        ddgs    READER_PROVIDER  jina   (see runbook prerequisite)
 *   RESEARCH_SWEEP_MAX_QUERIES  6   (cap queries per run; rotates weekly by ISO-week)
 *   RESEARCH_SWEEP_OUT     ./data/research-sweep
 *   RESEARCH_OUTPUT_DIR    ./data/research   (where the CLI writes per-query reports)
 *   SYNTH_MAX_TOKENS       4000
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { parseProposals, type ResearchProposal } from "../src/homeserver/research-proposals.js";

const GATEWAY_URL = (process.env["RESEARCH_GATEWAY_URL"] ?? "http://127.0.0.1:8091/v1").replace(/\/$/, "");
const SYNTH_MODEL = process.env["RESEARCH_SYNTH_MODEL"] ?? "qwen3-coder-next-80b";
const OUT_DIR = process.env["RESEARCH_SWEEP_OUT"] ?? "./data/research-sweep";
const RESEARCH_DIR = process.env["RESEARCH_OUTPUT_DIR"] ?? "./data/research";
const SYNTH_MAX_TOKENS = Number(process.env["SYNTH_MAX_TOKENS"] ?? 4000);

const log = (m: string): void => console.log(`[sweep ${new Date().toISOString()}] ${m}`);

/**
 * Curated bilingual query set. Each theme has an English and a Chinese query — the deep-research
 * harness has no region/lang flag, so Chinese coverage comes from writing the query in Chinese.
 * Phrased to favor 2026/recent work while still surfacing durable techniques.
 */
export const QUERY_SET: { theme: string; en: string; zh: string }[] = [
  {
    theme: "strix-halo-llamacpp",
    en: "Latest 2026 benchmarks and tuning tips for running LLM inference on AMD Strix Halo / Ryzen AI Max (Radeon 8060S) with llama.cpp Vulkan and ROCm — tokens/sec, flash-attention, batch size",
    zh: "2026年 AMD Strix Halo 锐龙 AI Max 核显 Radeon 8060S 使用 llama.cpp Vulkan/ROCm 运行大模型推理的最新性能优化与跑分技巧",
  },
  {
    theme: "quantization",
    en: "Newest GGUF quantization methods 2026 that preserve quality at small size (imatrix, IQ-quants, AWQ, dynamic/2-bit) and how they affect llama.cpp inference speed and accuracy",
    zh: "2026年最新的 GGUF 量化方法（imatrix、IQ 量化、AWQ、动态低比特）在保持精度的同时如何影响 llama.cpp 推理速度",
  },
  {
    theme: "speculative-decoding",
    en: "Speculative / draft-model / EAGLE / Medusa decoding for llama.cpp in 2026 — practical speedups, which draft models, how to configure on consumer GPUs",
    zh: "2026年 llama.cpp 的投机解码 / 草稿模型 / EAGLE / Medusa 推理加速实践，如何选择草稿模型与配置",
  },
  {
    theme: "moe-serving",
    en: "Serving Mixture-of-Experts (MoE) open-weight models efficiently on a single consumer GPU in 2026 — offloading, expert routing, memory tricks for models like Qwen3 / gpt-oss",
    zh: "2026年在单张消费级显卡上高效部署 MoE 专家混合开源模型的方法（专家卸载、内存优化、Qwen3/gpt-oss 等）",
  },
  {
    theme: "small-strong-models",
    en: "Best new small open-weight LLMs of 2026 (under ~30B) that punch above their weight on coding and reasoning, available as GGUF",
    zh: "2026年最值得关注的小参数（30B 以下）开源大模型，在代码与推理上表现出色且有 GGUF 版本",
  },
  {
    theme: "long-context-kv",
    en: "Techniques in 2026 to extend context length and shrink KV-cache memory for local llama.cpp inference (KV quantization, sliding window, context shifting)",
    zh: "2026年本地 llama.cpp 推理中扩展上下文长度并压缩 KV 缓存显存的技术（KV 量化、滑动窗口、上下文偏移）",
  },
  {
    theme: "llama-swap-routing",
    en: "Latest llama.cpp server, llama-swap and local-LLM orchestration/routing features in 2026 for serving multiple models on one box with fast model switching",
    zh: "2026年 llama.cpp server、llama-swap 及本地大模型编排路由的新特性，在一台机器上服务多模型并快速切换",
  },
];

/** ISO week number (1-53) — used to rotate which queries run each week. */
export function isoWeek(d: Date): number {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
}

/** Flatten the themed set to individual queries, rotated by week so the box covers all themes over time. */
export function selectQueries(maxQueries: number, week: number): { theme: string; lang: "en" | "zh"; query: string }[] {
  const flat = QUERY_SET.flatMap((t) => [
    { theme: t.theme, lang: "en" as const, query: t.en },
    { theme: t.theme, lang: "zh" as const, query: t.zh },
  ]);
  if (maxQueries >= flat.length) return flat;
  const start = (week * maxQueries) % flat.length;
  const out: typeof flat = [];
  for (let i = 0; i < maxQueries; i++) out.push(flat[(start + i) % flat.length]!);
  return out;
}

/** The synthesis instruction fed to the local model (pure → testable). */
export function buildSynthPrompt(summaries: { theme: string; query: string; text: string }[]): string {
  const corpus = summaries
    .map((s, i) => `--- SOURCE ${i + 1} [${s.theme}] (query: ${s.query}) ---\n${s.text.slice(0, 4000)}`)
    .join("\n\n");
  return [
    "You are an inference-optimization analyst for a home AI server: an AMD Strix Halo box",
    "(Radeon 8060S, 64 GB GPU VRAM) running open-weight LLMs as GGUF via llama.cpp (Vulkan) behind",
    "llama-swap. Below are distilled research summaries about running smarter models faster on this",
    "class of hardware.",
    "",
    "From them, produce a concrete, deduplicated list of THINGS WE SHOULD TRY on this box. Each item",
    "must be actionable on llama.cpp/llama-swap with our hardware. Prefer recent, high-impact ideas.",
    "",
    'Output ONLY a JSON array, each element: {"title": short name, "idea": what to do concretely,',
    '"rationale": why it helps speed and/or intelligence on THIS box, "expectedGain": one of',
    '"speed"|"intelligence"|"both", "effort": one of "S"|"M"|"L", "sources": [urls from the summaries]}.',
    "No prose outside the JSON array. 5-12 items.",
    "",
    corpus,
  ].join("\n");
}

interface ResearchRunOutput {
  slug: string;
  reportPath?: string;
  popularPath?: string;
}

/**
 * Turn a spawnSync result into a human-readable failure reason, or "" on success (pure — testable).
 * Previously only `res.status` was checked, so a spawn-level failure (`res.error` — e.g. `npx`
 * missing from PATH, a real prerequisite gap) logged as a bare "exit null:" with the actual cause
 * silently dropped (#200), and a non-zero exit with no captured stderr logged as an empty message.
 */
export function describeSpawnFailure(res: { error?: Error; status: number | null; stderr?: string }): string {
  if (res.error) return `could not launch deep-research: ${res.error.message}`;
  if (res.status !== 0) {
    const stderr = (res.stderr ?? "").trim().slice(-300);
    return `deep-research exited ${res.status}${stderr ? `: ${stderr}` : " (no stderr captured)"}`;
  }
  return "";
}

/** Run the deep-research CLI for one query (local brain). Returns parsed stdout JSON or null. */
function runDeepResearch(query: string): ResearchRunOutput | null {
  const env = {
    ...process.env,
    RESEARCH_GATEWAY_URL: GATEWAY_URL,
    RESEARCH_GATEWAY_API_KEY: "",
  };
  const res = spawnSync(
    "npx",
    ["tsx", "src/homeserver/deep-research-cli.ts", "run", "--query", query, "--depth", "thorough", "--brain", "local"],
    { env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  );
  const failure = describeSpawnFailure(res);
  if (failure) {
    log(`  ${failure}`);
    return null;
  }
  // The CLI prints a JSON line with slug/reportPath/popularPath — find the last JSON object in stdout.
  for (const line of (res.stdout ?? "").trim().split("\n").reverse()) {
    const s = line.trim();
    if (!s.startsWith("{")) continue;
    try {
      const o = JSON.parse(s) as ResearchRunOutput;
      if (o.slug) return o;
    } catch {
      /* not the JSON line */
    }
  }
  return null;
}

async function synthChat(prompt: string): Promise<string> {
  const resp = await fetch(`${GATEWAY_URL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: SYNTH_MODEL, messages: [{ role: "user", content: prompt }], max_tokens: SYNTH_MAX_TOKENS, temperature: 0.2 }),
    signal: AbortSignal.timeout(600_000),
  });
  if (!resp.ok) throw new Error(`synth HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content ?? "";
}

/**
 * Delete a previous run's proposals.json from outDir, if present (#230 review). Without this, a
 * run that fails AFTER a prior run succeeded leaves last week's file in place — the poster then
 * republishes stale-but-valid data as if this run succeeded too, exactly the invisible-failure
 * this pipeline exists to prevent. No-op if there is nothing to clear.
 */
export function clearStaleOutput(outDir: string): void {
  const path = join(outDir, "proposals.json");
  if (existsSync(path)) rmSync(path);
}

/** Render the human-readable proposals + report markdown (pure). */
export function renderProposalsMarkdown(proposals: ResearchProposal[], dateIso: string): string {
  const lines = [`# Stuff we should try — M5 research sweep (${dateIso.slice(0, 10)})`, ""];
  if (proposals.length === 0) lines.push("_No proposals synthesized this week._");
  for (const p of proposals) {
    lines.push(`## ${p.title}  \`${p.expectedGain}\` · effort ${p.effort}`);
    lines.push("");
    lines.push(p.idea);
    if (p.rationale) lines.push("", `_Why:_ ${p.rationale}`);
    if (p.sources.length) lines.push("", `Sources: ${p.sources.map((u) => `<${u}>`).join(" ")}`);
    lines.push("");
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const maxIdx = args.indexOf("--max");
  const maxQueries = Number((maxIdx >= 0 ? args[maxIdx + 1] : undefined) ?? process.env["RESEARCH_SWEEP_MAX_QUERIES"] ?? 6);
  const week = isoWeek(new Date());
  const queries = selectQueries(maxQueries, week);

  mkdirSync(OUT_DIR, { recursive: true });
  log(`research sweep — week ${week}, ${queries.length} queries, synth=${SYNTH_MODEL}, endpoint=${GATEWAY_URL}`);

  if (dryRun) {
    for (const q of queries) console.log(`DRY-RUN [${q.lang}] ${q.theme}: ${q.query}`);
    return;
  }

  // Invalidate any previous run's output BEFORE attempting this one (#230 review) — a fail panel
  // must reflect THIS run's failure, not stale prior success.
  clearStaleOutput(OUT_DIR);

  // 1) Run deep-research per query, collect popular summaries.
  const summaries: { theme: string; query: string; text: string }[] = [];
  for (const q of queries) {
    log(`── researching [${q.lang}] ${q.theme} ──`);
    const out = runDeepResearch(q.query);
    if (!out) continue;
    const popularPath = out.popularPath ?? join(RESEARCH_DIR, out.slug, "popular.md");
    if (existsSync(popularPath)) {
      summaries.push({ theme: q.theme, query: q.query, text: readFileSync(popularPath, "utf8") });
      log(`  collected ${popularPath}`);
    } else {
      log(`  no popular.md at ${popularPath}`);
    }
  }

  if (summaries.length === 0) {
    log("no research summaries collected — aborting synthesis (check the search/reader prerequisite).");
    process.exit(1);
  }

  // 2) One LOCAL synthesis pass → proposals.
  log(`synthesizing proposals from ${summaries.length} summaries via ${SYNTH_MODEL} …`);
  const raw = await synthChat(buildSynthPrompt(summaries));
  const proposals = parseProposals(raw);
  log(`parsed ${proposals.length} proposal(s).`);

  // 3) Write artifacts (proposals.json for the panel; markdown for /read).
  const nowIso = new Date().toISOString();
  writeFileSync(join(OUT_DIR, "proposals.json"), JSON.stringify({ generatedAt: nowIso, week, queries, proposals }, null, 2));
  const md = renderProposalsMarkdown(proposals, nowIso);
  writeFileSync(join(OUT_DIR, "proposals.md"), md);
  // /read-friendly copy: lowercase-kebab filename, no frontmatter (handled by the wrapper rsync).
  writeFileSync(join(OUT_DIR, `m5-research-sweep-${nowIso.slice(0, 10)}.md`), md);
  log(`wrote proposals.json + proposals.md to ${OUT_DIR}. Run post-research-sweep-panel.ts to publish.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
  });
}
