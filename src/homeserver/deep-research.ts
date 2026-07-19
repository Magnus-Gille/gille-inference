/**
 * Deep-research harness — the 8-stage pipeline.
 *
 * `plan → search → read → distill → verify/triangulate → gap → synthesize → cite → popular`.
 * Per docs/deep-research-harness-design.md §3, the long-horizon intelligence lives in the
 * DETERMINISTIC loop controller (this file's code): dedup, source-tier ranking, citation
 * enforcement, and a hard iteration budget. Every model touch is a single BOUNDED call through
 * an injected `ChatFn` (gateway-local by default), so the pipeline is fully unit-testable
 * offline with fakes — no M5, no network, no keys.
 *
 * Stage I/O parsing is deliberately defensive (the §3/§8 "reject malformed JSON deterministically
 * and retry, don't trust the model" rule): every model JSON is loose-parsed + shape-validated and
 * a bad parse degrades gracefully rather than poisoning the run.
 */

import type {
  ResearchRequest,
  ResearchDeps,
  ResearchResult,
  ResearchReport,
  ResearchPlan,
  GapAssessment,
  DistilledNote,
  ExtractedClaim,
  ClaimCluster,
  Source,
  SearchHit,
  ReadResult,
  ResearchStats,
  PopularSummary,
  SourceTier,
  ChatFn,
  StageChatFns,
} from "./deep-research-types.js";
import type { DeepResearchConfig } from "./deep-research-config.js";
import type { DelegationRecord, Outcome } from "./ledger.js";
import { urlTier } from "./search-provider.js";
import { contentHash, dedupePages } from "./reader.js";
import {
  checkCitations,
  extractCitedSourceIds,
  verifyReportSentences,
  type CitationClaim,
} from "./citation-verifier.js";
import type { ReportCitationCheck } from "./deep-research-types.js";

// ─── Per-stage token budgets (bounded calls; §4c) ───────────────────────────────
const TOK = { plan: 1500, distill: 1400, gap: 900, verify: 700, synth: 6000, popular: 4000 };

/** Strip reasoning-model <think>…</think> blocks (and stray tags) from a free-form synthesized body.
 *  Non-thinking models (qwen3-coder-80b, mellum) never emit these → no-op; a reasoning synth
 *  (qwen35-a3b, gemma4) would otherwise leak its chain-of-thought into the report. JSON stages are
 *  already protected by looseJson(); this guards the free-text synth + repair bodies. */
export function stripThink(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "") // closed blocks
    .replace(/<think>[\s\S]*$/i, "") // UNCLOSED block (truncated reasoning) → strip to EOF, never leak it
    .replace(/<\/?think>/gi, "") // stray orphan tags
    .trim();
}

// ─── JSON helpers (the "don't trust the model" gate) ────────────────────────────

/** Loose-parse JSON from model output: strip <think>, try a ```json fence, then a {…}/[…] slice. */
export function looseJson(text: string): unknown {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const fence = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)```/i);
  const candidates: string[] = [];
  if (fence && fence[1]) candidates.push(fence[1].trim());
  candidates.push(cleaned);
  const slice = cleaned.match(/[[{][\s\S]*[\]}]/);
  if (slice) candidates.push(slice[0]);
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

function asStringArray(v: unknown, cap: number): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((s) => s.trim()).slice(0, cap);
}

function asTier(v: unknown): SourceTier {
  return v === "primary" || v === "secondary" || v === "tertiary" ? v : "tertiary";
}

// ─── Stage 0: PLAN ───────────────────────────────────────────────────────────────

export function buildPlanPrompt(query: string, maxQueries: number): { system: string; prompt: string } {
  return {
    system:
      "You are a research planner. Decompose a research question into focused sub-questions and " +
      "concise web-search queries. Respond ONLY with JSON, no prose.",
    prompt:
      `Research question: ${query}\n\n` +
      `Return JSON exactly: {"subQuestions": string[], "queries": string[]}.\n` +
      `Give 3-6 sub-questions and up to ${maxQueries} search queries. Queries are short keyword ` +
      `phrases (not full sentences). No commentary.`,
  };
}

export function parsePlan(text: string, maxQueries: number): ResearchPlan | null {
  const j = looseJson(text) as { subQuestions?: unknown; queries?: unknown } | null;
  if (!j || typeof j !== "object") return null;
  const subQuestions = asStringArray(j.subQuestions, 8);
  const queries = asStringArray(j.queries, maxQueries);
  if (queries.length === 0) return null;
  return { subQuestions, queries };
}

// ─── Stage 3: DISTILL (per source) ───────────────────────────────────────────────

export function buildDistillPrompt(source: Source, maxChars: number): { system: string; prompt: string } {
  const page = source.markdown.length > maxChars ? source.markdown.slice(0, maxChars) : source.markdown;
  return {
    system:
      "You extract checkable factual claims from a single web page. Respond ONLY with JSON. Every " +
      "claim MUST be supported by a quote copied VERBATIM from the page (no paraphrase).",
    prompt:
      `Source [${source.id}] — ${source.title}\nURL: ${source.url}\n\nPAGE:\n${page}\n\n` +
      `Return JSON exactly: {"tier":"primary|secondary|tertiary","claims":[{"text":"<claim>","quote":"<verbatim quote>"}]}.\n` +
      `Extract up to 8 of the most relevant, checkable claims. Each "quote" must appear verbatim in the page above. No prose.`,
  };
}

export function parseDistill(text: string, sourceId: string): DistilledNote | null {
  const j = looseJson(text) as { tier?: unknown; claims?: unknown } | null;
  if (!j || typeof j !== "object" || !Array.isArray(j.claims)) return null;
  const claims: ExtractedClaim[] = [];
  for (const c of j.claims) {
    if (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string") {
      const text2 = (c as { text: string }).text.trim();
      const quote = typeof (c as { quote?: unknown }).quote === "string" ? (c as { quote: string }).quote.trim() : "";
      if (text2) claims.push({ text: text2, quote });
    }
  }
  return { sourceId, tier: asTier(j.tier), claims };
}

// ─── Stage 4: VERIFY / TRIANGULATE (deterministic clustering) ────────────────────

function tokenize(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2);
}

/** Jaccard token-set similarity of two claim texts, 0..1. */
export function claimSimilarity(a: string, b: string): number {
  const sa = new Set(tokenize(a));
  const sb = new Set(tokenize(b));
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}

const NEG = /\b(no|not|never|cannot|can't|isn't|aren't|wasn't|don't|doesn't|didn't|none|fails?|false|incorrect)\b/i;
function numbersIn(s: string): string[] {
  return (s.match(/-?\d[\d,]*\.?\d*/g) ?? []).map((n) => n.replace(/,/g, ""));
}

/** Strip negation words for polarity-conflict detection. */
function stripNeg(s: string): string {
  return s
    .replace(/\b(no|not|never|cannot|can't|isn't|aren't|wasn't|don't|doesn't|didn't|none|fails?|false|incorrect)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Return true when two claim texts from distinct sources are genuinely contradictory. */
function isPairContradictory(a: string, b: string): boolean {
  const sim = claimSimilarity(a, b);
  if (sim < 0.7) return false;
  // numeric conflict: both have numbers, numbers differ, non-numeric content is similar
  const numsA = numbersIn(a);
  const numsB = numbersIn(b);
  if (numsA.length > 0 && numsB.length > 0) {
    const numsDiffer = numsA.sort().join(",") !== numsB.sort().join(",");
    if (numsDiffer) {
      const stripNums = (s: string) => s.replace(/-?\d[\d,]*\.?\d*/g, " ").replace(/\s+/g, " ").trim();
      const nonNumSim = claimSimilarity(stripNums(a), stripNums(b));
      if (nonNumSim >= 0.7) return true;
    }
  }
  // polarity conflict: exactly one has negation, removing negation makes them ≥ 0.85 similar
  const aNeg = NEG.test(a);
  const bNeg = NEG.test(b);
  if (aNeg !== bNeg) {
    const strippedSim = claimSimilarity(stripNeg(a), stripNeg(b));
    if (strippedSim >= 0.85) return true;
  }
  return false;
}

/**
 * Cluster claims across sources by similarity. A cluster supported by ≥2 distinct sources is
 * "agreed"; a single-source cluster is "single". A cluster is "disputed" when members carry a
 * conservative contradiction signal: a polarity (negation) split, OR conflicting numbers in
 * otherwise-similar claims. DISPUTED surfacing is the lever that beats single-pass systems (§3).
 */
export function triangulate(notes: DistilledNote[], opts: { threshold?: number } = {}): ClaimCluster[] {
  const threshold = opts.threshold ?? 0.5;
  type Item = { text: string; quote: string; sourceId: string };
  const items: Item[] = [];
  for (const n of notes) for (const c of n.claims) items.push({ text: c.text, quote: c.quote, sourceId: n.sourceId });

  const clusters: { members: Item[] }[] = [];
  for (const it of items) {
    let best: { members: Item[] } | null = null;
    let bestSim = threshold;
    for (const cl of clusters) {
      const sim = Math.max(...cl.members.map((m) => claimSimilarity(m.text, it.text)));
      if (sim >= bestSim) {
        bestSim = sim;
        best = cl;
      }
    }
    if (best) best.members.push(it);
    else clusters.push({ members: [it] });
  }

  return clusters.map((cl): ClaimCluster => {
    const sourceIds = [...new Set(cl.members.map((m) => m.sourceId))];
    const quotes = cl.members.filter((m) => m.quote).map((m) => ({ sourceId: m.sourceId, quote: m.quote }));
    // Fix 6: pairwise contradiction check — only flag DISPUTED when two members from distinct
    // sources are genuinely contradictory (numeric-conflict OR polarity-conflict).
    let disputed = false;
    if (sourceIds.length >= 2) {
      outer: for (let i = 0; i < cl.members.length; i++) {
        for (let j = i + 1; j < cl.members.length; j++) {
          const mi = cl.members[i]!;
          const mj = cl.members[j]!;
          if (mi.sourceId !== mj.sourceId && isPairContradictory(mi.text, mj.text)) {
            disputed = true;
            break outer;
          }
        }
      }
    }
    const status = disputed ? "disputed" : sourceIds.length >= 2 ? "agreed" : "single";
    const cluster: ClaimCluster = {
      text: cl.members[0]!.text,
      status,
      sourceIds,
      quotes,
    };
    if (disputed) cluster.disputedBy = sourceIds;
    return cluster;
  });
}

// ─── Stage 5: GAP ────────────────────────────────────────────────────────────────

export function buildGapPrompt(
  query: string,
  subQuestions: string[],
  clusters: ClaimCluster[],
  maxQueries: number
): { system: string; prompt: string } {
  const claimsList = clusters.slice(0, 40).map((c) => `- ${c.text} [${c.sourceIds.join(",")}]`).join("\n");
  return {
    system: "You assess whether research coverage is sufficient. Respond ONLY with JSON, no prose.",
    prompt:
      `Research question: ${query}\nSub-questions:\n${subQuestions.map((s) => `- ${s}`).join("\n")}\n\n` +
      `Claims gathered so far:\n${claimsList || "(none yet)"}\n\n` +
      `Return JSON exactly: {"sufficient": boolean, "gaps": string[], "newQueries": string[]}.\n` +
      `If the claims answer the sub-questions, set sufficient=true. Otherwise list the gaps and up to ` +
      `${maxQueries} fresh search queries. No prose.`,
  };
}

export function parseGap(text: string, maxQueries: number): GapAssessment | null {
  const j = looseJson(text) as { sufficient?: unknown; gaps?: unknown; newQueries?: unknown } | null;
  if (!j || typeof j !== "object" || typeof j.sufficient !== "boolean") return null;
  return {
    sufficient: j.sufficient,
    gaps: asStringArray(j.gaps, 12),
    newQueries: asStringArray(j.newQueries, maxQueries),
  };
}

// ─── Stage 6: SYNTHESIZE ─────────────────────────────────────────────────────────

/** Default synth system prompt + the atomic-sentence variant (the biggest measured grounding lever:
 *  one checkable claim per sentence, cite every contributing source — keeps prose traceable). */
const SYNTH_SYSTEM_DEFAULT =
  "You are a research writer. Write a long, well-structured, heavily-cited report from the " +
  "DISTILLED NOTES only. Cite every factual sentence inline with [S#] markers matching the source " +
  "ids. Never invent facts beyond the notes. Surface disagreements honestly.";
const SYNTH_SYSTEM_ATOMIC =
  "You are a research writer. Write the report as SHORT, ATOMIC sentences: exactly ONE factual claim " +
  "per sentence. NEVER combine multiple statistics, percentages, or facts into one sentence — split " +
  "them. Immediately after each sentence cite EVERY source id it draws from, e.g. [S2] or [S2][S6]. " +
  "Use the DISTILLED NOTES only; never invent facts beyond them. Keep wording close to the source. " +
  "Use ## section headings. Surface disagreements honestly.";

export function buildSynthPrompt(
  query: string,
  subQuestions: string[],
  notes: DistilledNote[],
  disputed: ClaimCluster[],
  atomic = false
): { system: string; prompt: string } {
  const notesBlock = notes
    .map((n) => {
      const lines = n.claims.map((c) => `  - ${c.text}${c.quote ? ` (“${c.quote.slice(0, 200)}”)` : ""}`).join("\n");
      return `[${n.sourceId}] (${n.tier}):\n${lines}`;
    })
    .join("\n\n");
  const disputedBlock = disputed.length
    ? disputed.map((d) => `- ${d.text} — sources disagree: ${d.sourceIds.join(", ")}`).join("\n")
    : "(none)";
  return {
    system: atomic ? SYNTH_SYSTEM_ATOMIC : SYNTH_SYSTEM_DEFAULT,
    prompt:
      `Research question: ${query}\n\n` +
      `Use these as ## section headings:\n${subQuestions.map((s) => `- ${s}`).join("\n")}\n\n` +
      `DISTILLED NOTES (cite by source id):\n${notesBlock}\n\n` +
      // Note disagreements inline; the deterministic "## Disputed / Uncertain" section is appended by
      // the renderer, so do NOT add your own (avoids a duplicate heading).
      `NOTED DISAGREEMENTS (weave caveats into the relevant sections; do NOT add a Disputed heading):\n${disputedBlock}\n\n` +
      `Write Markdown with ## headings and inline [S#] citations. Do NOT add a sources list — it is ` +
      `appended automatically.`,
  };
}

// ─── Stage 6b: GROUNDING-REPAIR (reground) ───────────────────────────────────────
// The harness uses its OWN deterministic report-sentence verifier to drive a bounded model repair:
// feed the synthesizer the sentences whose content was NOT found in their cited source and have it
// re-ground (rewrite supported by a note, citing it) or remove them. Pure harness intelligence —
// targets the judged citation_quality weakness without trusting the model to self-police.

export function buildRegroundPrompt(
  query: string,
  notes: DistilledNote[],
  unsupported: { sentence: string; citedSourceIds: string[] }[],
  currentBody: string
): { system: string; prompt: string } {
  const notesBlock = notes
    .map((n) => `[${n.sourceId}] (${n.tier}):\n${n.claims.map((c) => `  - ${c.text}${c.quote ? ` (“${c.quote.slice(0, 200)}”)` : ""}`).join("\n")}`)
    .join("\n\n");
  const bad = unsupported.slice(0, 20).map((s, i) => `${i + 1}. "${s.sentence}" — cited ${s.citedSourceIds.join(", ")}`).join("\n");
  return {
    system:
      "You revise a research report so every cited sentence is grounded. You are given the report, the " +
      "DISTILLED NOTES (the only allowed evidence), and a list of sentences whose content was NOT found in " +
      "the source they cite. Return the FULL corrected report in Markdown, same structure and [S#] style. " +
      "For each flagged sentence: rewrite it so it is directly supported by a note and cite that note's [S#] " +
      "(cite EVERY source it draws from), OR delete it. Prefer SHORT, atomic sentences (one claim each); " +
      "split any sentence that packs multiple stats. Keep wording close to the source. Do not introduce new " +
      "unsupported claims. Keep all well-grounded content.",
    prompt:
      `Research question: ${query}\n\n` +
      `DISTILLED NOTES (cite by source id; the only allowed evidence):\n${notesBlock}\n\n` +
      `UNSUPPORTED SENTENCES TO FIX OR REMOVE:\n${bad}\n\n` +
      `CURRENT REPORT:\n${currentBody}\n\n` +
      `Return ONLY the corrected full Markdown report (no preamble).`,
  };
}

/** Run up to `rounds` grounding-repair passes. Adopts a repaired body only when it does NOT regress
 *  report-sentence precision (so a worse rewrite can never hurt the report). Returns the best body. */
async function regroundBody(
  deps: ResearchDeps,
  query: string,
  notes: DistilledNote[],
  sources: Source[],
  body: string,
  cfg: DeepResearchConfig,
  stats: ResearchStats,
  rounds: number
): Promise<string> {
  let best = body;
  let rc = verifyReportSentences({ reportBody: best, sources, notes, threshold: cfg.reportSentenceMatchThreshold });
  for (let r = 0; r < rounds; r++) {
    if (rc.unsupported.length === 0) break;
    const repairReq = buildRegroundPrompt(query, notes, rc.unsupported, best);
    const repaired = stripThink(
      await callStage(deps, "synthesis", deps.chat.synthesizer, repairReq, TOK.synth, (t) => stripThink(t).length > 200, stats)
    );
    if (repaired.length < 200) break;
    const rcR = verifyReportSentences({ reportBody: repaired, sources, notes, threshold: cfg.reportSentenceMatchThreshold });
    // Adopt ONLY on a genuine precision gain that does NOT strip grounded content. `precision` ignores
    // uncited sentences, so a rewrite can "win" by (a) dropping every [S#] (vacuous 1.0) or (b) deleting
    // the real grounded sentences and repeating ONE easy supported sentence to keep the raw count. Guard
    // on UNIQUE supported sentences (not the raw count) + a non-vacuous floor to block both.
    const uniqSupported = (c: ReportCitationCheck) =>
      new Set(c.supported.map((s) => s.sentence.toLowerCase().replace(/\s+/g, " ").trim())).size;
    const genuinelyBetter =
      rcR.precision > rc.precision && rcR.supported.length > 0 && uniqSupported(rcR) >= uniqSupported(rc);
    if (!genuinelyBetter) break; // no real improvement (or a gaming attempt) → stop, keep `best`
    best = repaired;
    rc = rcR;
  }
  return best;
}

// ─── Stage 8: POPULAR SUMMARY ────────────────────────────────────────────────────

export function buildPopularPrompt(query: string, reportMarkdown: string): { system: string; prompt: string } {
  return {
    system:
      "You write accessible, Simon-Willison-style blog summaries: concrete, direct, lightly " +
      "opinionated, jargon unpacked, and clear about why it matters.",
    prompt:
      `Summarize the following research report for a general audience in 1500-2500 words. Start with a ` +
      `single-line title on its own line. Explain why it matters and what is still uncertain.\n\n` +
      `Original question: ${query}\n\nREPORT:\n${reportMarkdown}`,
  };
}

export function splitPopular(text: string): PopularSummary {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const lines = cleaned.split("\n");
  let title = lines[0]?.replace(/^#+\s*/, "").trim() ?? "Research summary";
  if (title.length > 140) title = title.slice(0, 140);
  return { title, markdown: cleaned };
}

// ─── Source assembly (deterministic: dedup + id + tier + hash) ───────────────────

/** Turn fetched pages into id'd, tier-ranked, near-dup-collapsed Sources. ids continue from
 *  `startIndex` so iterations don't renumber earlier sources. */
export function assignSources(reads: ReadResult[], startIndex: number): Source[] {
  const deduped = dedupePages(reads.filter((r) => r.markdown.trim().length > 0));
  return deduped.map((r, i) => ({
    id: `S${startIndex + i + 1}`,
    url: r.url,
    title: (r.title ?? r.url).trim() || r.url,
    tier: urlTier(r.url),
    markdown: r.markdown,
    contentHash: contentHash(r.markdown),
  }));
}

// ─── Final report rendering (deterministic) ──────────────────────────────────────

export function renderReport(opts: {
  query: string;
  generatedAtIso: string;
  brain: ResearchReport["brain"];
  iterations: number;
  body: string;
  sources: Source[];
  disputed: ClaimCluster[];
  citationPrecision: number;
  reportCitations: ReportCitationCheck;
}): string {
  const { query, generatedAtIso, brain, iterations, body, sources, disputed, citationPrecision, reportCitations } =
    opts;
  const sourceLines = sources
    .map((s) => `- [${s.id}] [${s.title}](${s.url}) — _${s.tier}_`)
    .join("\n");
  const disputedLines = disputed.length
    ? disputed.map((d) => `- ${d.text} — _sources disagree: ${d.sourceIds.join(", ")}_`).join("\n")
    : "_None flagged._";

  const rc = reportCitations;
  const citedSentences = rc.supported.length + rc.unsupported.length;
  // Honest dual metric: distilled-claim precision can be 100% while the synthesizer still
  // over-claims in prose — only the report-sentence support figure exposes that.
  const unsupportedLines = rc.unsupported.length
    ? rc.unsupported.map((s) => `- "${s.sentence}" — _cited ${s.citedSourceIds.join(", ")}; not found in source_`).join("\n")
    : "_None — every cited sentence traced to its cited source._";

  return [
    `# Research report: ${query}`,
    "",
    `> Generated ${generatedAtIso} · brain: **${brain}** · iterations: ${iterations} · ` +
      `sources: ${sources.length} · distilled-claim citation precision: ${(citationPrecision * 100).toFixed(0)}% · ` +
      `report-sentence support: ${(rc.precision * 100).toFixed(0)}% (${rc.supported.length}/${citedSentences} cited)`,
    "",
    body.trim(),
    "",
    "## Disputed / Uncertain",
    "",
    disputedLines,
    "",
    "## Unsupported sentences",
    "",
    "_Sentences carrying an [S#] citation whose content was not found in the cited source — treat as unverified._",
    "",
    unsupportedLines,
    "",
    "## Sources",
    "",
    sourceLines || "_No sources._",
    "",
  ].join("\n");
}

// ─── Ledger-recording stage call ─────────────────────────────────────────────────

function outcomeFor(ok: boolean, empty: boolean): { outcome: Outcome; errorClass?: "empty" | "parse" } {
  if (empty) return { outcome: "error", errorClass: "empty" };
  if (ok) return { outcome: "pass" };
  return { outcome: "fail", errorClass: "parse" };
}

/** One bounded model call + ledger record. `validate` decides pass/fail for the ledger signal.
 *  On network/infra throw, records an error ledger row and returns "" so callers degrade. */
async function callStage(
  deps: ResearchDeps,
  taskType: string,
  chat: ChatFn,
  req: { system: string; prompt: string },
  maxTokens: number,
  validate: (text: string) => boolean,
  stats: ResearchStats
): Promise<string> {
  const started = Date.now();
  let resp: Awaited<ReturnType<ChatFn>>;
  try {
    resp = await chat({ system: req.system, prompt: req.prompt, maxTokens });
  } catch (e) {
    const latencyMs = Date.now() - started;
    const errorClass = /timeout|abort|ETIMEDOUT|ECONNREFUSED/i.test((e as Error).message)
      ? "timeout"
      : "infra";
    const rec: DelegationRecord = {
      taskType,
      modelId: "unknown",
      prompt: req.prompt.slice(0, 400),
      outcome: "error",
      score: 0,
      latencyMs,
      promptTokens: 0,
      completionTokens: 0,
      tokPerSec: null,
      verifier: "deep-research",
      source: "deep-research",
      errorClass,
    };
    deps.recordLedger?.(rec);
    return "";
  }
  const latencyMs = Date.now() - started;
  stats.totalCompletionTokens += resp.completionTokens;
  stats.modelCalls[taskType] = (stats.modelCalls[taskType] ?? 0) + 1;
  const empty = resp.text.trim().length === 0;
  const ok = !empty && validate(resp.text);
  const { outcome, errorClass } = outcomeFor(ok, empty);
  const rec: DelegationRecord = {
    taskType,
    modelId: resp.model,
    prompt: req.prompt.slice(0, 400),
    outcome,
    score: ok ? 1 : 0,
    latencyMs,
    promptTokens: resp.promptTokens,
    completionTokens: resp.completionTokens,
    tokPerSec: latencyMs > 0 ? Math.round((resp.completionTokens / latencyMs) * 1000) : null,
    verifier: "deep-research",
    source: "deep-research",
  };
  if (errorClass) rec.errorClass = errorClass;
  deps.recordLedger?.(rec);
  return resp.text;
}

// ─── The orchestrator ────────────────────────────────────────────────────────────

function depthBudget(req: ResearchRequest, cfg: DeepResearchConfig): { iters: number; perIter: number } {
  if (req.depth === "quick") return { iters: 1, perIter: Math.min(cfg.maxSourcesPerIter, 6) };
  return { iters: cfg.maxIters, perIter: cfg.maxSourcesPerIter };
}

export async function runResearch(req: ResearchRequest, deps: ResearchDeps): Promise<ResearchResult> {
  const cfg = deps.config;
  const chat: StageChatFns = deps.chat;
  const log = deps.log ?? (() => {});
  const progress = (stage: Parameters<NonNullable<ResearchDeps["onProgress"]>>[0]["stage"], iteration: number, detail: string) =>
    deps.onProgress?.({ stage, iteration, detail });

  const { iters, perIter } = depthBudget(req, cfg);
  const stats: ResearchStats = {
    iterations: 0,
    searchQueries: 0,
    sourcesFetched: 0,
    sourcesDistilled: 0,
    claimsExtracted: 0,
    claimsDisputed: 0,
    citationPrecision: 1,
    reportSentencePrecision: 1,
    totalCompletionTokens: 0,
    modelCalls: {},
  };

  // Stage 0: PLAN
  progress("plan", 0, "decomposing the query");
  const planReq = buildPlanPrompt(req.query, cfg.maxQueriesPerIter);
  const planText = await callStage(
    deps,
    "research-plan",
    chat.planner,
    planReq,
    TOK.plan,
    (t) => parsePlan(t, cfg.maxQueriesPerIter) !== null,
    stats
  );
  const plan = parsePlan(planText, cfg.maxQueriesPerIter) ?? { subQuestions: [req.query], queries: [req.query] };
  log(`plan: ${plan.subQuestions.length} sub-questions, ${plan.queries.length} queries`);

  const seenUrls = new Set<string>();
  const allSources: Source[] = [];
  const allNotes: DistilledNote[] = [];
  let queries = plan.queries;
  let clusters: ClaimCluster[] = [];

  for (let iter = 1; iter <= iters; iter++) {
    stats.iterations = iter;

    // Stage 1: SEARCH (+ deterministic dedup/rank/budget)
    progress("search", iter, `${queries.length} queries`);
    const hits: SearchHit[] = [];
    for (const q of queries.slice(0, cfg.maxQueriesPerIter)) {
      stats.searchQueries++;
      try {
        hits.push(...(await deps.search.search(q)));
      } catch (e) {
        log(`search failed for "${q}": ${(e as Error).message}`);
      }
    }
    const ranked = rankAndBudget(hits, seenUrls, perIter);
    for (const h of ranked) seenUrls.add(h.url);
    log(`iter ${iter}: ${hits.length} hits → ${ranked.length} new sources to read`);

    // Stage 2: READ (full pages)
    progress("read", iter, `reading ${ranked.length} pages`);
    const reads: ReadResult[] = [];
    for (const h of ranked) {
      try {
        reads.push(await deps.read.read(h.url));
      } catch (e) {
        log(`read failed for ${h.url}: ${(e as Error).message}`);
      }
    }
    const sources = assignSources(reads, allSources.length);
    allSources.push(...sources);
    stats.sourcesFetched = allSources.length;

    // Stage 3: DISTILL (per source, bounded; serial — the box GPU is serial)
    progress("distill", iter, `distilling ${sources.length} sources`);
    for (const src of sources) {
      const dReq = buildDistillPrompt(src, cfg.distillMaxChars);
      const dText = await callStage(
        deps,
        "source-distill",
        chat.distiller,
        dReq,
        TOK.distill,
        (t) => parseDistill(t, src.id) !== null,
        stats
      );
      let note = parseDistill(dText, src.id);
      if (!note || note.claims.length === 0) {
        // retry once (the "reject + retry, don't trust" rule)
        const rText = await callStage(
          deps,
          "source-distill",
          chat.distiller,
          dReq,
          TOK.distill,
          (t) => parseDistill(t, src.id) !== null,
          stats
        );
        note = parseDistill(rText, src.id);
      }
      if (note) {
        allNotes.push(note);
        stats.sourcesDistilled++;
        stats.claimsExtracted += note.claims.length;
      }
    }

    // Stage 4: VERIFY / TRIANGULATE (deterministic)
    progress("verify", iter, "clustering claims");
    clusters = triangulate(allNotes);
    stats.claimsDisputed = clusters.filter((c) => c.status === "disputed").length;

    // Stage 5: GAP (model decides content; CODE enforces the budget)
    if (iter >= iters) break;
    progress("gap", iter, "assessing coverage");
    const gapReq = buildGapPrompt(req.query, plan.subQuestions, clusters, cfg.maxQueriesPerIter);
    const gapText = await callStage(
      deps,
      "gap-check",
      chat.planner,
      gapReq,
      TOK.gap,
      (t) => parseGap(t, cfg.maxQueriesPerIter) !== null,
      stats
    );
    const gap = parseGap(gapText, cfg.maxQueriesPerIter);
    if (!gap || gap.sufficient || gap.newQueries.length === 0) {
      log(`gap: ${gap?.sufficient ? "sufficient" : "no new queries"} → stopping at iter ${iter}`);
      break;
    }
    queries = gap.newQueries;
  }

  const disputed = clusters.filter((c) => c.status === "disputed");

  // Fix 3: degenerate path — skip synth + popular if no sources or no notes were gathered
  if (allSources.length === 0 || allNotes.length === 0) {
    const noSourcesBody = allSources.length === 0
      ? "No sources could be retrieved."
      : "No claims could be extracted from the retrieved sources.";
    const citations = checkCitations([], allSources, cfg.citationMatchThreshold);
    const reportCitations = verifyReportSentences({ reportBody: noSourcesBody, sources: allSources });
    stats.citationPrecision = 1;
    stats.reportSentencePrecision = reportCitations.precision;
    const report: ResearchReport = {
      query: req.query,
      generatedAtIso: req.nowIso,
      sections: [],
      disputed: [],
      sources: allSources,
      brain: req.brain ?? cfg.brain,
      iterations: stats.iterations,
      citations,
      reportCitations,
      markdown: renderReport({
        query: req.query,
        generatedAtIso: req.nowIso,
        brain: req.brain ?? cfg.brain,
        iterations: stats.iterations,
        body: noSourcesBody,
        sources: allSources,
        disputed: [],
        citationPrecision: 1,
        reportCitations,
      }),
    };
    progress("done", stats.iterations, "complete");
    return { report, popular: { title: "Research summary", markdown: noSourcesBody }, stats };
  }

  // Stage 6: SYNTHESIZE (from distilled notes, NOT raw pages)
  progress("synthesize", stats.iterations, "writing the report");
  const synthReq = buildSynthPrompt(req.query, plan.subQuestions, allNotes, disputed, cfg.synthAtomic ?? false);
  const rawBody = stripThink(
    await callStage(deps, "synthesis", chat.synthesizer, synthReq, TOK.synth, (t) => stripThink(t).length > 200, stats)
  );

  // Fix 4: empty/short synth body fallback
  let body = rawBody.trim().length < 200
    ? "_Synthesis failed; sources and extracted claims are listed below._"
    : rawBody;

  // Stage 6b: GROUNDING-REPAIR (reground) — bounded loop that re-grounds unsupported sentences.
  if ((cfg.synthStrategy ?? "oneshot") === "reground" && rawBody.trim().length >= 200) {
    progress("synthesize", stats.iterations, "grounding-repair pass");
    body = await regroundBody(deps, req.query, allNotes, allSources, body, cfg, stats, cfg.synthRepairRounds);
  }

  // Stage 7: CITE (deterministic enforcement)
  progress("cite", stats.iterations, "enforcing citations");
  const citationClaims: CitationClaim[] = allNotes.flatMap((n) =>
    n.claims.map((c) => ({ claimText: c.text, sourceId: n.sourceId, quote: c.quote }))
  );
  const citedInBody = new Set(extractCitedSourceIds(body));
  const cited = citationClaims.filter((c) => citedInBody.has(c.sourceId));

  // Fix 5: remove fallback-to-all-claims when cited is empty — that masked fabrication
  let citations: ReturnType<typeof checkCitations>;
  // MVP gate: distilled-claim → source. Proves the claims we EXTRACTED are real, but is blind to
  // the synthesizer inventing a prose sentence and citing a source whose claims don't cover it.
  if (citationClaims.length === 0) {
    // nothing to check → vacuously precise
    citations = checkCitations([], allSources, cfg.citationMatchThreshold);
    stats.citationPrecision = 1;
  } else if (cited.length === 0) {
    // body cites nothing from the extracted claims (or body is empty) → precision 0
    citations = { resolved: [], unresolved: citationClaims, precision: 0 };
    stats.citationPrecision = 0;
  } else {
    citations = checkCitations(cited, allSources, cfg.citationMatchThreshold);
    stats.citationPrecision = citations.precision;
  }

  // Phase-2 gate: report-sentence → cited-source. Closes the gap the MVP cannot see — every
  // cited SENTENCE of the synthesized body must trace to its cited source's evidence (page +
  // that source's distilled claims), else it is flagged unsupported in the rendered report.
  const reportCitations: ReportCitationCheck = verifyReportSentences({
    reportBody: body,
    sources: allSources,
    notes: allNotes,
    threshold: cfg.reportSentenceMatchThreshold,
  });
  stats.reportSentencePrecision = reportCitations.precision;

  const report: ResearchReport = {
    query: req.query,
    generatedAtIso: req.nowIso,
    sections: [],
    disputed,
    sources: allSources,
    brain: req.brain ?? cfg.brain,
    iterations: stats.iterations,
    citations,
    reportCitations,
    markdown: renderReport({
      query: req.query,
      generatedAtIso: req.nowIso,
      brain: req.brain ?? cfg.brain,
      iterations: stats.iterations,
      body,
      sources: allSources,
      disputed,
      citationPrecision: citations.precision,
      reportCitations,
    }),
  };

  // Stage 8: POPULAR SUMMARY
  progress("popular", stats.iterations, "writing the accessible summary");
  const popText = await callStage(
    deps,
    "synthesis",
    chat.synthesizer,
    buildPopularPrompt(req.query, report.markdown),
    TOK.popular,
    (t) => t.trim().length > 200,
    stats
  );
  const popular = splitPopular(popText);

  progress("done", stats.iterations, "complete");
  return { report, popular, stats };
}

/** Dedup by url, drop seen, rank by tier, cap to budget. (search-provider.dedupeAndRank is
 *  re-implemented inline here to also respect the per-iteration source budget.) */
function rankAndBudget(hits: SearchHit[], seen: Set<string>, budget: number): SearchHit[] {
  const out: SearchHit[] = [];
  const localSeen = new Set<string>();
  const tierRank: Record<SourceTier, number> = { primary: 0, secondary: 1, tertiary: 2 };
  const ranked = [...hits].sort((a, b) => tierRank[urlTier(a.url)] - tierRank[urlTier(b.url)]);
  for (const h of ranked) {
    if (seen.has(h.url) || localSeen.has(h.url)) continue;
    localSeen.add(h.url);
    out.push(h);
    if (out.length >= budget) break;
  }
  return out;
}
