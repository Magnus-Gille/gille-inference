/**
 * Deep-research synthesis experiment harness (overnight, 2026-06-20).
 *
 * Goal: recover the "+0.86 brain gap" (benchmark: Local 3.00 < Claude-harness 3.86) WITHOUT a
 * frontier brain, by improving the SYNTHESIS stage — the locus of local's weakest judged dimension
 * (citation_quality 2.2/5). We isolate synthesis cleanly with a FROZEN CORPUS: retrieve once per
 * query (default roster: 80b plan + mellum distill via the box), cache {plan, sources, notes,
 * disputed}, then vary ONLY the synthesizer (model × temperature × strategy) on that fixed input.
 *
 * Zero core-pipeline changes: this script orchestrates the library's EXPORTED primitives. Winners
 * get productised into deep-research.ts afterward with TDD.
 *
 * Phases (each idempotent/resumable — skips work whose output already exists):
 *   tsx scripts/dr-experiment.ts retrieve   # build & cache frozen corpora for the query set
 *   tsx scripts/dr-experiment.ts synth       # run all synth variants → reports + metrics.jsonl
 *   tsx scripts/dr-experiment.ts judge       # blind multi-way judge of variant reports
 *   tsx scripts/dr-experiment.ts report      # print the metrics + judge summary tables
 *
 * Models served by the box llama-swap via an SSH forward (default :18091). Search+read run
 * laptop-side (the ~/.venvs/research venv); the OpenRouter key (judges) never leaves the laptop.
 */

import OpenAI from "openai";
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadEnv } from "../src/env.js";
import { loadDeepResearchConfig, type DeepResearchConfig } from "../src/homeserver/deep-research-config.js";
import { makeSearchProvider, urlTier } from "../src/homeserver/search-provider.js";
import { makeReader } from "../src/homeserver/reader.js";
import { makeChatFn } from "../src/homeserver/deep-research-cli.js";
import {
  looseJson,
  buildPlanPrompt,
  parsePlan,
  buildDistillPrompt,
  parseDistill,
  buildSynthPrompt,
  triangulate,
  assignSources,
  renderReport,
} from "../src/homeserver/deep-research.js";
import { checkCitations, extractCitedSourceIds, verifyReportSentences, type CitationClaim } from "../src/homeserver/citation-verifier.js";
import type { ChatFn, Source, DistilledNote, ClaimCluster, ResearchPlan, SearchHit } from "../src/homeserver/deep-research-types.js";

loadEnv();

// ─── config ──────────────────────────────────────────────────────────────────────
const KEY = process.env["OPENROUTER_API_KEY"] ?? "";
const VENV = `${homedir()}/.venvs/research/bin`;
const GATEWAY = process.env["DRX_GATEWAY"] ?? "http://127.0.0.1:18091/v1"; // box llama-swap via forward
const OUT = process.env["DRX_OUT"] ?? join("data", "dr-exp");
const CORPUS_DIR = join(OUT, "corpus");
const REPORT_DIR = join(OUT, "reports");
const METRICS = join(OUT, "metrics.jsonl");
const JUDGE_OUT = join(OUT, "judge.jsonl");
const CORPUS_SOURCES = Number(process.env["DRX_SOURCES"] ?? 8); // frozen corpus size
const PLAN_MODEL = process.env["DRX_PLAN_MODEL"] ?? "qwen3-coder-next-80b";
const DISTILL_MODEL = process.env["DRX_DISTILL_MODEL"] ?? "mellum";
const JUDGES = ["anthropic/claude-opus-4.8", "openai/o4-mini"];
const DIMENSIONS = ["factual_accuracy", "depth_coverage", "citation_quality", "coherence", "usefulness"] as const;

// 3 inner-loop queries (medical / regulatory / scientific mix) — a subset of the 5 canonical
// benchmark queries, so results compare directly to the 3-way benchmark (docs/deep-research-benchmark).
const QUERIES: { id: string; q: string }[] = [
  { id: "fasting", q: "What are the main health benefits and risks of intermittent fasting, according to recent clinical evidence?" },
  { id: "aiact", q: "How does the EU AI Act classify and regulate general-purpose AI (GPAI) models, and what obligations apply?" },
  { id: "fermi", q: "What are the leading proposed resolutions to the Fermi paradox, and how well-supported is each?" },
];

type Strategy = "oneshot" | "reground" | "outline" | "critique" | "atomic" | "reground-atomic";
interface Variant {
  name: string;
  model: string;
  temp: number;
  minTokens: number;
  strategy: Strategy;
}

// Variant matrix — grouped by model to minimise llama-swap reloads. baseline == current production.
const VARIANTS: Variant[] = [
  { name: "baseline-80b-t0", model: "qwen3-coder-next-80b", temp: 0, minTokens: 0, strategy: "oneshot" },
  { name: "80b-t03", model: "qwen3-coder-next-80b", temp: 0.3, minTokens: 0, strategy: "oneshot" },
  { name: "80b-t06", model: "qwen3-coder-next-80b", temp: 0.6, minTokens: 0, strategy: "oneshot" },
  { name: "80b-reground", model: "qwen3-coder-next-80b", temp: 0.3, minTokens: 0, strategy: "reground" },
  { name: "80b-outline", model: "qwen3-coder-next-80b", temp: 0.3, minTokens: 0, strategy: "outline" },
  { name: "80b-critique", model: "qwen3-coder-next-80b", temp: 0.3, minTokens: 0, strategy: "critique" },
  { name: "qwen35-t06", model: "qwen35-a3b", temp: 0.6, minTokens: 8000, strategy: "oneshot" },
  { name: "qwen35-reground", model: "qwen35-a3b", temp: 0.6, minTokens: 8000, strategy: "reground" },
  { name: "gemma4-t04", model: "gemma4", temp: 0.4, minTokens: 0, strategy: "oneshot" },
  { name: "gemma4-reground", model: "gemma4", temp: 0.4, minTokens: 0, strategy: "reground" },
  // Supplemental pass (added after batch 1 + diagnosis): atomic-sentence discipline targets the
  // long-recombined-sentence weakness that kept fasting at 0% even under reground.
  { name: "80b-atomic", model: "qwen3-coder-next-80b", temp: 0.3, minTokens: 0, strategy: "atomic" },
  { name: "80b-reground-atomic", model: "qwen3-coder-next-80b", temp: 0.3, minTokens: 0, strategy: "reground-atomic" },
  // New model (downloaded tonight): Qwen3-30B-A3B-Instruct-2507 — a NON-thinking general instruct
  // writer (vs the coder). Should be reliable (no reasoning-blank like qwen35-a3b) AND better prose.
  { name: "qwen3instruct-oneshot", model: "qwen3-30b-instruct", temp: 0.3, minTokens: 0, strategy: "oneshot" },
  { name: "qwen3instruct-reground", model: "qwen3-30b-instruct", temp: 0.3, minTokens: 0, strategy: "reground" },
  // Does a general WRITER + atomic beat the coder + atomic? (the model-swap question, isolated)
  { name: "qwen3instruct-atomic", model: "qwen3-30b-instruct", temp: 0.3, minTokens: 0, strategy: "atomic" },
  { name: "qwen3instruct-reground-atomic", model: "qwen3-30b-instruct", temp: 0.3, minTokens: 0, strategy: "reground-atomic" },
];

const SYNTH_TOK = 6000;

function baseCfg(): DeepResearchConfig {
  return {
    ...loadDeepResearchConfig(),
    gatewayUrl: GATEWAY,
    gatewayApiKey: "",
    searchProvider: "ddgs",
    searchFallbackProvider: "ddgs",
    ddgsPython: `${VENV}/python`,
    ddgsScript: "scripts/ddgs_search.py",
    readerProvider: "trafilatura",
    readerFallbackProvider: "jina",
    trafilaturaCmd: `${VENV}/trafilatura`,
  };
}

function local(model: string, temp: number, minTokens: number): ChatFn {
  const fn = makeChatFn(GATEWAY, "", model, temp);
  if (minTokens <= 0) return fn;
  return (req) => fn({ ...req, maxTokens: Math.max(req.maxTokens ?? 0, minTokens) });
}

/** Strip reasoning-model <think> blocks from a free-form body. The 80b-coder is non-thinking
 *  (no-op), but qwen35-a3b/gemma4 emit <think>…</think> inline in `content` — left in, it pollutes
 *  the report and tanks those variants for the wrong reason. (JSON stages already strip via looseJson.) */
function clean(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<\/?think>/gi, "")
    .trim();
}

function log(m: string): void {
  process.stderr.write(`${m}\n`);
}

// ─── frozen corpus ─────────────────────────────────────────────────────────────────
interface Corpus {
  id: string;
  query: string;
  plan: ResearchPlan;
  sources: Source[];
  notes: DistilledNote[];
  disputed: ClaimCluster[];
  retrieve: { sourcesFetched: number; claimsExtracted: number; disputedCount: number };
}

async function retrieveOne(id: string, query: string): Promise<Corpus> {
  const cfg = baseCfg();
  const search = makeSearchProvider(cfg);
  const reader = makeReader(cfg);
  const planner = local(PLAN_MODEL, 0, 0);
  const distiller = local(DISTILL_MODEL, 0, 0);

  // PLAN
  const planReq = buildPlanPrompt(query, cfg.maxQueriesPerIter);
  const planResp = await planner({ system: planReq.system, prompt: planReq.prompt, maxTokens: 1500 });
  const plan = parsePlan(planResp.text, cfg.maxQueriesPerIter) ?? { subQuestions: [query], queries: [query] };
  log(`  [${id}] plan: ${plan.subQuestions.length} subQs, ${plan.queries.length} queries`);

  // SEARCH (all plan queries) → dedup by url → tier-rank → top N
  const hits: SearchHit[] = [];
  for (const q of plan.queries.slice(0, cfg.maxQueriesPerIter)) {
    try {
      hits.push(...(await search.search(q)));
    } catch (e) {
      log(`  [${id}] search failed "${q}": ${(e as Error).message}`);
    }
  }
  const seen = new Set<string>();
  const tierRank = { primary: 0, secondary: 1, tertiary: 2 } as const;
  const deduped = hits.filter((h) => (seen.has(h.url) ? false : (seen.add(h.url), true)));
  deduped.sort((a, b) => tierRank[urlTier(a.url)] - tierRank[urlTier(b.url)]);
  const picked = deduped.slice(0, CORPUS_SOURCES);
  log(`  [${id}] ${hits.length} hits → ${picked.length} sources`);

  // READ
  const reads = [];
  for (const h of picked) {
    try {
      reads.push(await reader.read(h.url));
    } catch (e) {
      log(`  [${id}] read failed ${h.url}: ${(e as Error).message}`);
    }
  }
  const sources = assignSources(reads, 0);

  // DISTILL (mellum, with one retry on empty)
  const notes: DistilledNote[] = [];
  for (const src of sources) {
    const dReq = buildDistillPrompt(src, cfg.distillMaxChars);
    let resp = await distiller({ system: dReq.system, prompt: dReq.prompt, maxTokens: 1400 });
    let note = parseDistill(resp.text, src.id);
    if (!note || note.claims.length === 0) {
      resp = await distiller({ system: dReq.system, prompt: dReq.prompt, maxTokens: 1400 });
      note = parseDistill(resp.text, src.id);
    }
    if (note && note.claims.length > 0) notes.push(note);
  }
  const clusters = triangulate(notes);
  const disputed = clusters.filter((c) => c.status === "disputed");
  log(`  [${id}] distilled ${notes.length}/${sources.length} sources, ${notes.reduce((n, x) => n + x.claims.length, 0)} claims, ${disputed.length} disputed`);

  return {
    id,
    query,
    plan,
    sources,
    notes,
    disputed,
    retrieve: { sourcesFetched: sources.length, claimsExtracted: notes.reduce((n, x) => n + x.claims.length, 0), disputedCount: disputed.length },
  };
}

async function phaseRetrieve(): Promise<void> {
  mkdirSync(CORPUS_DIR, { recursive: true });
  for (const { id, q } of QUERIES) {
    const path = join(CORPUS_DIR, `${id}.json`);
    if (existsSync(path)) {
      log(`corpus [${id}] exists — skip`);
      continue;
    }
    log(`retrieve [${id}] ${q}`);
    const corpus = await retrieveOne(id, q);
    writeFileSync(path, JSON.stringify(corpus, null, 2), "utf-8");
    log(`  → cached ${path}`);
  }
}

function loadCorpus(id: string): Corpus {
  return JSON.parse(readFileSync(join(CORPUS_DIR, `${id}.json`), "utf-8")) as Corpus;
}

// ─── synthesis strategies ────────────────────────────────────────────────────────
function notesBlock(notes: DistilledNote[]): string {
  return notes
    .map((n) => {
      const lines = n.claims.map((c) => `  - ${c.text}${c.quote ? ` (“${c.quote.slice(0, 200)}”)` : ""}`).join("\n");
      return `[${n.sourceId}] (${n.tier}):\n${lines}`;
    })
    .join("\n\n");
}

function disputedBlock(disputed: ClaimCluster[]): string {
  return disputed.length ? disputed.map((d) => `- ${d.text} — sources disagree: ${d.sourceIds.join(", ")}`).join("\n") : "(none)";
}

interface SynthResult {
  body: string;
  calls: number;
  completionTokens: number;
  repairRounds?: number;
}

/** Strategy: one bounded call (current production). */
async function synthOneshot(fn: ChatFn, corpus: Corpus): Promise<SynthResult> {
  const req = buildSynthPrompt(corpus.query, corpus.plan.subQuestions, corpus.notes, corpus.disputed);
  const r = await fn({ system: req.system, prompt: req.prompt, maxTokens: SYNTH_TOK });
  return { body: clean(r.text), calls: 1, completionTokens: r.completionTokens };
}

/** Strategy: atomic-sentence discipline — short, ONE-claim-per-sentence prose, cite all contributing
 *  sources per sentence. Targets the long-recombined-sentence weakness (the diagnosed cause of low
 *  report-sentence support): each atomic sentence aligns to one source span → higher overlap + more
 *  verifiable. Reuses buildSynthPrompt's user block; swaps the system instruction. */
const ATOMIC_SYSTEM =
  "You are a research writer. Write the report as SHORT, ATOMIC sentences: exactly ONE factual claim " +
  "per sentence. NEVER combine multiple statistics, percentages, or facts into a single sentence — " +
  "split them. Immediately after each sentence cite EVERY source id it draws from, e.g. [S2] or [S2][S6]. " +
  "Use the DISTILLED NOTES only; never invent facts beyond them. Keep sentences close to the source " +
  "wording. Use ## section headings. Surface disagreements honestly.";

async function synthAtomic(fn: ChatFn, corpus: Corpus): Promise<SynthResult> {
  const req = buildSynthPrompt(corpus.query, corpus.plan.subQuestions, corpus.notes, corpus.disputed);
  const r = await fn({ system: ATOMIC_SYSTEM, prompt: req.prompt, maxTokens: SYNTH_TOK });
  return { body: clean(r.text), calls: 1, completionTokens: r.completionTokens };
}

/** Strategy: grounding-repair loop — synth → deterministic report-sentence verify → feed the
 *  UNSUPPORTED sentences back to the model to re-ground or remove. Pure harness intelligence:
 *  the harness uses its own verifier to drive a model repair. Targets citation_quality (2.2). */
async function synthReground(
  fn: ChatFn,
  corpus: Corpus,
  cfg: DeepResearchConfig,
  rounds = 1,
  firstPass: (fn: ChatFn, corpus: Corpus) => Promise<SynthResult> = synthOneshot,
  atomic = false
): Promise<SynthResult> {
  const first = await firstPass(fn, corpus);
  let body = first.body;
  let calls = first.calls;
  let toks = first.completionTokens;
  let repairRounds = 0;
  for (let r = 0; r < rounds; r++) {
    const check = verifyReportSentences({ reportBody: body, sources: corpus.sources, notes: corpus.notes, threshold: cfg.reportSentenceMatchThreshold });
    if (check.unsupported.length === 0) break;
    repairRounds++;
    const bad = check.unsupported.slice(0, 20).map((s, i) => `${i + 1}. "${s.sentence}" — cited ${s.citedSourceIds.join(", ")}`).join("\n");
    const system =
      "You revise a research report so every cited sentence is grounded. You are given the report, the " +
      "DISTILLED NOTES (the only allowed evidence), and a list of sentences whose content was NOT found in " +
      "the source they cite. Return the FULL corrected report in Markdown, same structure and [S#] citation " +
      "style. For each flagged sentence: rewrite it so it is directly supported by a note and cite that note's " +
      "[S#], OR delete it. Do not introduce new unsupported claims. Keep all well-grounded content." +
      (atomic
        ? " Write SHORT, ATOMIC sentences (one claim each); split any sentence that combines multiple " +
          "stats/facts; cite EVERY source each sentence draws from; keep wording close to the source."
        : "");
    const prompt =
      `Research question: ${corpus.query}\n\n` +
      `DISTILLED NOTES (cite by source id; the only allowed evidence):\n${notesBlock(corpus.notes)}\n\n` +
      `UNSUPPORTED SENTENCES TO FIX OR REMOVE:\n${bad}\n\n` +
      `CURRENT REPORT:\n${body}\n\n` +
      `Return ONLY the corrected full Markdown report (no preamble).`;
    const resp = await fn({ system, prompt, maxTokens: SYNTH_TOK });
    if (clean(resp.text).length > 200) body = clean(resp.text);
    calls++;
    toks += resp.completionTokens;
  }
  return { body, calls, completionTokens: toks, repairRounds };
}

/** Strategy: outline-first (STORM-style) — plan section bullets from the notes, then write. */
async function synthOutline(fn: ChatFn, corpus: Corpus): Promise<SynthResult> {
  const outlineSystem = "You are a research editor. From the distilled notes, produce a tight section outline. Respond ONLY with JSON.";
  const outlinePrompt =
    `Research question: ${corpus.query}\n\nSub-questions:\n${corpus.plan.subQuestions.map((s) => `- ${s}`).join("\n")}\n\n` +
    `DISTILLED NOTES:\n${notesBlock(corpus.notes)}\n\n` +
    `Return JSON: {"sections":[{"heading":string,"points":[string]}]}. Each point references the source ids ([S#]) that support it. 4-7 sections.`;
  const o = await fn({ system: outlineSystem, prompt: outlinePrompt, maxTokens: 2000 });
  const parsed = looseJson(o.text) as { sections?: { heading: string; points: string[] }[] } | null;
  const outline = parsed?.sections?.length
    ? parsed.sections.map((s) => `## ${s.heading}\n${(s.points ?? []).map((p) => `- ${p}`).join("\n")}`).join("\n\n")
    : corpus.plan.subQuestions.map((s) => `## ${s}`).join("\n\n");
  const writeSystem =
    "You are a research writer. Expand the OUTLINE into a long, well-structured, heavily-cited report using the " +
    "DISTILLED NOTES only. Cite every factual sentence inline with [S#]. Never invent facts beyond the notes.";
  const writePrompt =
    `Research question: ${corpus.query}\n\nOUTLINE:\n${outline}\n\n` +
    `DISTILLED NOTES (cite by source id):\n${notesBlock(corpus.notes)}\n\n` +
    `DISPUTED (call out in a "## Disputed / Uncertain" section):\n${disputedBlock(corpus.disputed)}\n\n` +
    `Write Markdown with ## headings and inline [S#] citations. Do NOT add a sources list.`;
  const w = await fn({ system: writeSystem, prompt: writePrompt, maxTokens: SYNTH_TOK });
  return { body: clean(w.text), calls: 2, completionTokens: o.completionTokens + w.completionTokens };
}

/** Strategy: draft → self-critique → revise. */
async function synthCritique(fn: ChatFn, corpus: Corpus): Promise<SynthResult> {
  const draft = await synthOneshot(fn, corpus);
  const critSystem = "You are a strict research editor. Critique the report for unsupported claims, missing citations, vague statements, and coverage gaps vs the notes. Be specific and terse.";
  const critPrompt = `DISTILLED NOTES:\n${notesBlock(corpus.notes)}\n\nREPORT:\n${draft.body}\n\nList the top 8 concrete problems as a numbered list.`;
  const crit = await fn({ system: critSystem, prompt: critPrompt, maxTokens: 1500 });
  const revSystem =
    "You are a research writer. Revise the report to fix every critique point using the DISTILLED NOTES only. " +
    "Cite every factual sentence with [S#]. Never invent facts beyond the notes. Return the FULL revised report.";
  const revPrompt = `Research question: ${corpus.query}\n\nDISTILLED NOTES:\n${notesBlock(corpus.notes)}\n\nCRITIQUE:\n${crit.text}\n\nCURRENT REPORT:\n${draft.body}\n\nReturn ONLY the revised full Markdown report.`;
  const rev = await fn({ system: revSystem, prompt: revPrompt, maxTokens: SYNTH_TOK });
  const body = clean(rev.text).length > 200 ? clean(rev.text) : draft.body;
  return { body, calls: 3, completionTokens: draft.completionTokens + crit.completionTokens + rev.completionTokens };
}

// ─── metrics ─────────────────────────────────────────────────────────────────────
interface MetricRow {
  qid: string;
  variant: string;
  model: string;
  temp: number;
  strategy: Strategy;
  ok: boolean;
  bodyChars: number;
  citedSourcesInBody: number;
  totalSources: number;
  citationPrecision: number; // distilled-claim → source (MVP gate)
  reportSentencePrecision: number; // report-sentence → cited-source (Phase-2)
  supportedSentences: number;
  unsupportedSentences: number;
  uncitedSentences: number;
  completionTokens: number;
  modelCalls: number;
  repairRounds: number;
  ms: number;
}

function computeMetrics(corpus: Corpus, body: string, cfg: DeepResearchConfig): Omit<MetricRow, "qid" | "variant" | "model" | "temp" | "strategy" | "completionTokens" | "modelCalls" | "repairRounds" | "ms"> {
  const citedInBody = new Set(extractCitedSourceIds(body));
  const claims: CitationClaim[] = corpus.notes.flatMap((n) => n.claims.map((c) => ({ claimText: c.text, sourceId: n.sourceId, quote: c.quote })));
  const cited = claims.filter((c) => citedInBody.has(c.sourceId));
  let citationPrecision = 1;
  if (claims.length > 0) citationPrecision = cited.length === 0 ? 0 : checkCitations(cited, corpus.sources, cfg.citationMatchThreshold).precision;
  const rc = verifyReportSentences({ reportBody: body, sources: corpus.sources, notes: corpus.notes, threshold: cfg.reportSentenceMatchThreshold });
  return {
    ok: body.length > 200,
    bodyChars: body.length,
    citedSourcesInBody: citedInBody.size,
    totalSources: corpus.sources.length,
    citationPrecision,
    reportSentencePrecision: rc.precision,
    supportedSentences: rc.supported.length,
    unsupportedSentences: rc.unsupported.length,
    uncitedSentences: rc.uncitedSentenceCount,
  };
}

function doneVariants(): Set<string> {
  const done = new Set<string>();
  if (!existsSync(METRICS)) return done;
  for (const line of readFileSync(METRICS, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as MetricRow;
      done.add(`${r.qid}__${r.variant}`);
    } catch {
      /* skip */
    }
  }
  return done;
}

async function phaseSynth(): Promise<void> {
  mkdirSync(REPORT_DIR, { recursive: true });
  const cfg = baseCfg();
  const corpora = QUERIES.map(({ id }) => loadCorpus(id));
  const done = doneVariants();
  // model-outer loop minimises llama-swap reloads
  for (const variant of VARIANTS) {
    for (const corpus of corpora) {
      const key = `${corpus.id}__${variant.name}`;
      if (done.has(key)) {
        log(`synth ${key} — done, skip`);
        continue;
      }
      const fn = local(variant.model, variant.temp, variant.minTokens);
      const t0 = Date.now();
      let sr: SynthResult;
      try {
        if (variant.strategy === "oneshot") sr = await synthOneshot(fn, corpus);
        else if (variant.strategy === "reground") sr = await synthReground(fn, corpus, cfg, 1);
        else if (variant.strategy === "outline") sr = await synthOutline(fn, corpus);
        else if (variant.strategy === "critique") sr = await synthCritique(fn, corpus);
        else if (variant.strategy === "atomic") sr = await synthAtomic(fn, corpus);
        else sr = await synthReground(fn, corpus, cfg, 1, synthAtomic, true); // reground-atomic
      } catch (e) {
        log(`synth ${key} ERROR: ${(e as Error).message}`);
        sr = { body: "", calls: 0, completionTokens: 0 };
      }
      const ms = Date.now() - t0;
      const m = computeMetrics(corpus, sr.body, cfg);
      const row: MetricRow = {
        qid: corpus.id,
        variant: variant.name,
        model: variant.model,
        temp: variant.temp,
        strategy: variant.strategy,
        ...m,
        completionTokens: sr.completionTokens,
        modelCalls: sr.calls,
        repairRounds: sr.repairRounds ?? 0,
        ms,
      };
      // full report markdown (for judging)
      const reportMd = renderReport({
        query: corpus.query,
        generatedAtIso: new Date().toISOString(),
        brain: "local",
        iterations: 1,
        body: sr.body || "_Synthesis failed._",
        sources: corpus.sources,
        disputed: corpus.disputed,
        citationPrecision: m.citationPrecision,
        reportCitations: verifyReportSentences({ reportBody: sr.body, sources: corpus.sources, notes: corpus.notes, threshold: cfg.reportSentenceMatchThreshold }),
      });
      writeFileSync(join(REPORT_DIR, `${key}.md`), reportMd, "utf-8");
      appendFileSync(METRICS, JSON.stringify(row) + "\n", "utf-8");
      log(`synth ${key}: rsupport=${(m.reportSentencePrecision * 100).toFixed(0)}% (${m.supportedSentences}/${m.supportedSentences + m.unsupportedSentences}) cite=${(m.citationPrecision * 100).toFixed(0)}% body=${m.bodyChars}c calls=${sr.calls} ${(ms / 1000).toFixed(0)}s`);
    }
  }
}

// ─── judging (blind, multi-way per query) ───────────────────────────────────────
const or = () => new OpenAI({ baseURL: "https://openrouter.ai/api/v1", apiKey: KEY, timeout: 900_000, maxRetries: 2 });

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

// Which variants go to the (paid) judge — keep small. Override with DRX_JUDGE_VARIANTS=a,b,c
const JUDGE_VARIANTS = (process.env["DRX_JUDGE_VARIANTS"] ?? "baseline-80b-t0,80b-t03,80b-reground,qwen35-reground").split(",").map((s) => s.trim()).filter(Boolean);

async function judgeOne(judgeModel: string, query: string, presented: { label: string; markdown: string }[]): Promise<Record<string, Record<string, number> & { rank: number; note: string }> | null> {
  const body = presented.map((p) => `### ${p.label}\n\n${p.markdown.slice(0, 6000)}${p.markdown.length > 6000 ? "\n…[truncated]" : ""}`).join("\n\n---\n\n");
  const prompt =
    `You are a rigorous, impartial judge of research reports. They all answer the same question. Judge ONLY content; ` +
    `you do not know which system produced which.\n\nQUESTION: ${query}\n\n${body}\n\n` +
    `Score EACH report 1 (poor) to 5 (excellent) on: ${DIMENSIONS.join(", ")}. Then an overall rank (1 = best). ` +
    `Penalise unsupported claims and missing/incorrect citations. Respond ONLY with JSON keyed by report label, e.g. ` +
    `{"${presented[0]!.label}":{${DIMENSIONS.map((d) => `"${d}":4`).join(",")},"rank":1,"note":"one line"}}`;
  try {
    const resp = await or().chat.completions.create({ model: judgeModel, messages: [{ role: "user", content: prompt }], max_tokens: 2500 });
    const parsed = looseJson(resp.choices[0]?.message?.content ?? "");
    return parsed && typeof parsed === "object" ? (parsed as never) : null;
  } catch (e) {
    log(`judge ${judgeModel} failed: ${(e as Error).message}`);
    return null;
  }
}

async function phaseJudge(): Promise<void> {
  if (!KEY) throw new Error("OPENROUTER_API_KEY not set");
  const labels = ["Report 1", "Report 2", "Report 3", "Report 4", "Report 5", "Report 6"];
  for (const { id, q } of QUERIES) {
    const variants = JUDGE_VARIANTS.filter((v) => existsSync(join(REPORT_DIR, `${id}__${v}.md`)));
    if (variants.length < 2) {
      log(`judge [${id}]: <2 variant reports present, skip`);
      continue;
    }
    const order = shuffle(variants);
    const presented = order.map((v, i) => ({ label: labels[i]!, markdown: readFileSync(join(REPORT_DIR, `${id}__${v}.md`), "utf-8") }));
    const labelToVariant = new Map(order.map((v, i) => [labels[i]!, v]));
    for (const jm of JUDGES) {
      log(`judge [${id}] ${jm} (${variants.length} variants)…`);
      const scores = await judgeOne(jm, q, presented);
      if (!scores) continue;
      for (const [label, variant] of labelToVariant) {
        const sc = scores[label];
        if (!sc) continue;
        const dims: Record<string, number> = {};
        for (const d of DIMENSIONS) dims[d] = Number((sc as Record<string, unknown>)[d]) || 0;
        appendFileSync(JUDGE_OUT, JSON.stringify({ qid: id, variant, judge: jm, dims, rank: Number(sc.rank) || 0, note: String(sc.note ?? "").slice(0, 200) }) + "\n", "utf-8");
      }
    }
  }
  log(`judge → ${JUDGE_OUT}`);
}

// ─── reporting ───────────────────────────────────────────────────────────────────
function phaseReport(): void {
  // metrics table (deterministic), averaged across queries
  const rows: MetricRow[] = existsSync(METRICS) ? readFileSync(METRICS, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const byVariant = new Map<string, MetricRow[]>();
  for (const r of rows) (byVariant.get(r.variant) ?? byVariant.set(r.variant, []).get(r.variant)!).push(r);
  const out: string[] = [];
  out.push("## Deterministic metrics (mean across queries)\n");
  out.push("| variant | model | temp | strat | rsupport% | cite% | body(c) | unsup | calls | tok | s |");
  out.push("|---|---|---|---|---|---|---|---|---|---|---|");
  const order = VARIANTS.map((v) => v.name);
  for (const name of order) {
    const rs = byVariant.get(name);
    if (!rs?.length) continue;
    const mean = (f: (r: MetricRow) => number) => rs.reduce((a, r) => a + f(r), 0) / rs.length;
    out.push(
      `| ${name} | ${rs[0]!.model} | ${rs[0]!.temp} | ${rs[0]!.strategy} | ${(mean((r) => r.reportSentencePrecision) * 100).toFixed(0)} | ${(mean((r) => r.citationPrecision) * 100).toFixed(0)} | ${mean((r) => r.bodyChars).toFixed(0)} | ${mean((r) => r.unsupportedSentences).toFixed(1)} | ${mean((r) => r.modelCalls).toFixed(1)} | ${mean((r) => r.completionTokens).toFixed(0)} | ${(mean((r) => r.ms) / 1000).toFixed(0)} |`
    );
  }
  // judge table
  const jrows: { qid: string; variant: string; judge: string; dims: Record<string, number>; rank: number }[] = existsSync(JUDGE_OUT)
    ? readFileSync(JUDGE_OUT, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];
  if (jrows.length) {
    out.push("\n## Blind judge scores (mean across queries × judges)\n");
    out.push(`| variant | ${DIMENSIONS.join(" | ")} | **avg** | mean rank | #rank-1 |`);
    out.push(`|---|${DIMENSIONS.map(() => "---").join("|")}|---|---|---|`);
    const jByV = new Map<string, typeof jrows>();
    for (const r of jrows) (jByV.get(r.variant) ?? jByV.set(r.variant, []).get(r.variant)!).push(r);
    for (const [variant, rs] of [...jByV.entries()].sort()) {
      const dimAvg = (d: string) => rs.reduce((a, r) => a + (r.dims[d] ?? 0), 0) / rs.length;
      const avg = DIMENSIONS.reduce((a, d) => a + dimAvg(d), 0) / DIMENSIONS.length;
      const meanRank = rs.reduce((a, r) => a + r.rank, 0) / rs.length;
      const wins = rs.filter((r) => r.rank === 1).length;
      out.push(`| ${variant} | ${DIMENSIONS.map((d) => dimAvg(d).toFixed(2)).join(" | ")} | **${avg.toFixed(2)}** | ${meanRank.toFixed(2)} | ${wins} |`);
    }
  }
  const text = out.join("\n");
  writeFileSync(join(OUT, "SUMMARY.md"), text + "\n", "utf-8");
  console.log(text);
  log(`\n→ ${join(OUT, "SUMMARY.md")}`);
}

// ─── main ────────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const cmd = process.argv[2];
  if (cmd === "retrieve") await phaseRetrieve();
  else if (cmd === "synth") await phaseSynth();
  else if (cmd === "judge") await phaseJudge();
  else if (cmd === "report") phaseReport();
  else if (cmd === "corpus-stats") {
    for (const { id } of QUERIES) {
      if (!existsSync(join(CORPUS_DIR, `${id}.json`))) continue;
      const c = loadCorpus(id);
      log(`${id}: ${c.sources.length} sources, ${c.notes.length} distilled, ${c.retrieve.claimsExtracted} claims, ${c.disputed.length} disputed`);
    }
  } else {
    log("usage: tsx scripts/dr-experiment.ts <retrieve|synth|judge|report|corpus-stats>");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
