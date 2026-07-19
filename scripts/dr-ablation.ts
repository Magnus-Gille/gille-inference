/**
 * Deep-research DISTILLATION-ABLATION runner (laptop-side primitives).
 *
 * We hold a frozen web corpus FIXED (data/dr-ablation/corpus/qN.json, produced separately) and
 * vary (a) the DISTILL step and (b) the SYNTH brain, to find what closes the quality gap to
 * Claude. This script provides the local primitives — it calls models over a configurable
 * `--baseurl` (an SSH port-forward to the M5's llama-swap, e.g. http://127.0.0.1:18091/v1).
 * Claude-family synth + judging are done ELSEWHERE (by subagents); this builds distill / synth /
 * verify only.
 *
 * It REUSES the production pipeline wherever possible (the distill prompt + parser, the synth
 * prompt builder + reground loop, renderReport, verifyReportSentences, makeChatFn) so the
 * ablation measures the SAME code the box runs — only the distill style and synth model vary.
 *
 *   tsx scripts/dr-ablation.ts distill  --corpus data/dr-ablation/corpus/q1.json \
 *        --model mellum --style terse|rich|extractive|none --baseurl http://127.0.0.1:18091/v1 \
 *        [--max-chars 6000] --out data/dr-ablation/notes/q1.terse.mellum.json
 *   tsx scripts/dr-ablation.ts synth-local --notes <notes.json> --corpus <corpus.json> \
 *        --model qwen3-coder-next-80b --reground on|off --baseurl <url> --out <dir>
 *   tsx scripts/dr-ablation.ts verify --report <report.md> --corpus <corpus.json> --out <verify.json>
 *
 * Every model touch is a single bounded call through a `ChatFn`, so the deterministic glue (prompt
 * assembly, note IO, synth-from-notes, verify) is unit-testable offline with fakes — no network.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildDistillPrompt,
  parseDistill,
  buildSynthPrompt,
  buildRegroundPrompt,
  renderReport,
  triangulate,
  looseJson,
  stripThink,
} from "../src/homeserver/deep-research.js";
import { verifyReportSentences } from "../src/homeserver/citation-verifier.js";
import { makeChatFn } from "../src/homeserver/deep-research-cli.js";
import type {
  ChatFn,
  Source,
  SourceTier,
  DistilledNote,
  ReportCitationCheck,
} from "../src/homeserver/deep-research-types.js";

// ─── Domain types (the frozen-corpus + ablation-note shapes) ──────────────────────

/** Which distillation variant produced a note. */
export type DistillStyle = "terse" | "rich" | "extractive" | "none";

/** A single source in a frozen corpus file (`data/dr-ablation/corpus/qN.json`). */
export interface CorpusSource {
  id: string;
  url: string;
  title: string;
  tier: SourceTier;
  markdown: string;
}

/** A frozen web corpus held fixed across the ablation. */
export interface Corpus {
  query: string;
  sources: CorpusSource[];
}

/** A distilled note for one source — the ablation's per-source DISTILL output. */
export interface AblationNote {
  id: string;
  tier: SourceTier;
  /** The distilled text fed to synth: terse=compact claims, rich=summary+claims,
   *  extractive=verbatim quotes, none=truncated full-page markdown. */
  distilled: string;
}

/** The `notes/*.json` artifact `distill` writes and `synth-local` reads. */
export interface NotesFile {
  query: string;
  style: DistillStyle;
  model: string;
  notes: AblationNote[];
}

const DEFAULT_MAX_CHARS = 6000;
/** Single-synth char ceiling; above it we map-reduce (synth per chunk, then combine). */
const SYNTH_PROMPT_CEILING = 100_000;
/** Per-stage token budget for ablation calls (generous — thinking models blank when starved). */
const TOK = { distill: 4000, synth: 8000, popular: 4000 };

// ─── Distill prompt builders ──────────────────────────────────────────────────────
// terse reuses the pipeline's buildDistillPrompt (current mellum atomic-claims style). The two
// variants below are denser/verbatim probes of "what feeds synth better".

function truncate(markdown: string, maxChars: number): string {
  return markdown.length > maxChars ? markdown.slice(0, maxChars) : markdown;
}

/** RICH: more claims + a 2-3 sentence summary per source → a longer, denser note. */
export function buildRichDistillPrompt(source: Source, maxChars: number): { system: string; prompt: string } {
  const page = truncate(source.markdown, maxChars);
  return {
    system:
      "You distill a single web page into a dense research note. Respond ONLY with JSON. Every claim " +
      "MUST be supported by a quote copied VERBATIM from the page (no paraphrase in the quote).",
    prompt:
      `Source [${source.id}] — ${source.title}\nURL: ${source.url}\n\nPAGE:\n${page}\n\n` +
      `Return JSON exactly: {"tier":"primary|secondary|tertiary","summary":"<2-3 sentence summary>",` +
      `"claims":[{"text":"<claim>","quote":"<verbatim quote>"}]}.\n` +
      `Write a 2-3 sentence "summary" of the page, then extract up to 15 of the most relevant, ` +
      `checkable claims (MORE than a terse pass — be dense). Each "quote" must appear verbatim in the ` +
      `page above. No prose outside the JSON.`,
  };
}

/** EXTRACTIVE: copy 5-10 VERBATIM key sentences/quotes (no paraphrase), numbers preserved. */
export function buildExtractiveDistillPrompt(source: Source, maxChars: number): { system: string; prompt: string } {
  const page = truncate(source.markdown, maxChars);
  return {
    system:
      "You extract a web page's key sentences by COPYING them verbatim. Respond ONLY with JSON. " +
      "Do NOT paraphrase, summarize, or rewrite — copy the original wording exactly, preserving every number.",
    prompt:
      `Source [${source.id}] — ${source.title}\nURL: ${source.url}\n\nPAGE:\n${page}\n\n` +
      `Return JSON exactly: {"tier":"primary|secondary|tertiary","quotes":["<verbatim sentence>", ...]}.\n` +
      `Copy 5-10 of the most important key sentences or quotes from the page above, VERBATIM (no ` +
      `paraphrase, preserve all numbers and units exactly). Each string must appear word-for-word in ` +
      `the page. No prose outside the JSON.`,
  };
}

// ─── Note rendering (parsed model output → the `distilled` string) ─────────────────

/** Render a parsed DistilledNote (terse/rich) into a compact string: optional summary + one
 *  claim per line. This is the `distilled` text that feeds synth. */
export function renderNote(note: DistilledNote, summary: string | undefined): string {
  const lines = note.claims.map((c) => `- ${c.text}${c.quote ? ` ("${c.quote.slice(0, 200)}")` : ""}`);
  const body = lines.join("\n");
  return summary && summary.trim() ? `${summary.trim()}\n${body}` : body;
}

/** Parse + render an extractive response (a JSON `{quotes:[...]}`) into the `distilled` string,
 *  preserving the verbatim text. */
function renderExtractive(text: string): string {
  const j = looseJson(text) as { quotes?: unknown } | null;
  if (!j || typeof j !== "object" || !Array.isArray(j.quotes)) return "";
  const quotes = j.quotes.filter((q): q is string => typeof q === "string" && q.trim().length > 0).map((q) => q.trim());
  return quotes.map((q) => `- ${q}`).join("\n");
}

/** Pull the `summary` field out of a rich response (best-effort). */
function parseSummary(text: string): string | undefined {
  const j = looseJson(text) as { summary?: unknown } | null;
  if (j && typeof j === "object" && typeof j.summary === "string" && j.summary.trim()) return j.summary.trim();
  return undefined;
}

// ─── distillSource: one source → one AblationNote (per style) ──────────────────────

/**
 * Distil one source under a given style. `none` makes NO model call (the `distilled` = the source
 * markdown truncated to `maxChars`, feeding full pages to synth). On a blank/failed model response,
 * returns an EMPTY note rather than crashing the whole run.
 */
export async function distillSource(
  source: CorpusSource,
  style: DistillStyle,
  chat: ChatFn,
  maxChars: number
): Promise<AblationNote> {
  if (style === "none") {
    return { id: source.id, tier: source.tier, distilled: truncate(source.markdown, maxChars) };
  }

  // The pipeline's Source carries a contentHash; the corpus shape doesn't, so add a stub.
  const src: Source = { ...source, contentHash: "" };
  const req =
    style === "terse"
      ? buildDistillPrompt(src, maxChars)
      : style === "rich"
        ? buildRichDistillPrompt(src, maxChars)
        : buildExtractiveDistillPrompt(src, maxChars);

  let text = "";
  try {
    const resp = await chat({ system: req.system, prompt: req.prompt, maxTokens: TOK.distill });
    text = resp.text ?? "";
  } catch {
    text = ""; // network/infra error → graceful empty note, don't crash the run
  }
  text = stripThink(text);
  if (text.trim().length === 0) return { id: source.id, tier: source.tier, distilled: "" };

  if (style === "extractive") {
    return { id: source.id, tier: source.tier, distilled: renderExtractive(text) };
  }
  // terse / rich both parse as the standard distill JSON; rich additionally carries a summary.
  const note = parseDistill(text, source.id);
  if (!note || note.claims.length === 0) return { id: source.id, tier: source.tier, distilled: "" };
  const summary = style === "rich" ? parseSummary(text) : undefined;
  return { id: source.id, tier: note.tier, distilled: renderNote(note, summary) };
}

/** Distil an entire corpus into a NotesFile. */
export async function distillCorpus(
  corpus: Corpus,
  style: DistillStyle,
  model: string,
  chat: ChatFn,
  maxChars: number
): Promise<NotesFile> {
  const notes: AblationNote[] = [];
  for (const source of corpus.sources) {
    notes.push(await distillSource(source, style, chat, maxChars));
  }
  return { query: corpus.query, style, model, notes };
}

// ─── Corpus / notes IO ──────────────────────────────────────────────────────────

export function readCorpus(path: string): Corpus {
  const raw = JSON.parse(readFileSync(path, "utf-8")) as Corpus;
  if (!raw || typeof raw.query !== "string" || !Array.isArray(raw.sources)) {
    throw new Error(`corpus ${path} is malformed: expected {query, sources[]}`);
  }
  return raw;
}

export function writeNotesFile(path: string, notes: NotesFile): void {
  writeFileSync(path, JSON.stringify(notes, null, 2), "utf-8");
}

export function readNotesFile(path: string): NotesFile {
  const raw = JSON.parse(readFileSync(path, "utf-8")) as NotesFile;
  if (!raw || !Array.isArray(raw.notes)) throw new Error(`notes ${path} is malformed: expected {notes[]}`);
  return raw;
}

// ─── synth-local: synthesize a report from the notes, reusing the pipeline ──────────

/**
 * Convert ablation notes into the pipeline's `DistilledNote` shape so `buildSynthPrompt` /
 * `verifyReportSentences` consume them unchanged. Each note's whole `distilled` string becomes a
 * single claim (text); the corpus markdown is the verification evidence. (For `none`, the claim
 * text IS the full truncated page, so synth sees the raw page — exactly the intent.)
 */
function asPipelineNotes(notes: AblationNote[]): DistilledNote[] {
  return notes
    .filter((n) => n.distilled.trim().length > 0)
    .map((n) => ({ sourceId: n.id, tier: n.tier, claims: [{ text: n.distilled, quote: "" }] }));
}

/** Corpus sources → the pipeline's Source[] (the verification evidence search space). */
function asPipelineSources(corpus: Corpus): Source[] {
  return corpus.sources.map((s) => ({ ...s, contentHash: "" }));
}

export interface SynthLocalOptions {
  notes: NotesFile;
  corpus: Corpus;
  model: string;
  reground: boolean;
  chat: ChatFn;
  outDir: string;
  /** Injected ISO (deterministic-testable). Defaults to now. */
  nowIso?: string;
}

export interface SynthLocalResult {
  reportPath: string;
  metaPath: string;
  stats: { reportSentencePrecision: number; supported: number; unsupported: number; uncitedSentenceCount: number };
  mapReduce: boolean;
}

/** One bounded synth call (strip <think>). On error returns "" so callers degrade. */
async function synthCall(chat: ChatFn, req: { system: string; prompt: string }, maxTokens: number): Promise<string> {
  try {
    const resp = await chat({ system: req.system, prompt: req.prompt, maxTokens });
    return stripThink(resp.text ?? "");
  } catch {
    return "";
  }
}

/** Bounded grounding-repair loop (mirrors the pipeline's private regroundBody, built from the
 *  exported buildRegroundPrompt + verifyReportSentences). Adopts a repaired body only on a
 *  genuine, non-gaming precision gain. */
async function regroundBody(
  chat: ChatFn,
  query: string,
  pnotes: DistilledNote[],
  sources: Source[],
  body: string,
  rounds: number
): Promise<string> {
  let best = body;
  let rc = verifyReportSentences({ reportBody: best, sources, notes: pnotes });
  for (let r = 0; r < rounds; r++) {
    if (rc.unsupported.length === 0) break;
    const repaired = await synthCall(chat, buildRegroundPrompt(query, pnotes, rc.unsupported, best), TOK.synth);
    if (repaired.length < 200) break;
    const rcR = verifyReportSentences({ reportBody: repaired, sources, notes: pnotes });
    const uniqSupported = (c: ReportCitationCheck) =>
      new Set(c.supported.map((s) => s.sentence.toLowerCase().replace(/\s+/g, " ").trim())).size;
    const genuinelyBetter =
      rcR.precision > rc.precision && rcR.supported.length > 0 && uniqSupported(rcR) >= uniqSupported(rc);
    if (!genuinelyBetter) break;
    best = repaired;
    rc = rcR;
  }
  return best;
}

/** Chunk pipeline-notes into groups whose combined distilled-text stays under the ceiling. */
function chunkNotes(pnotes: DistilledNote[], ceiling: number): DistilledNote[][] {
  const chunks: DistilledNote[][] = [];
  let cur: DistilledNote[] = [];
  let curChars = 0;
  for (const n of pnotes) {
    const size = n.claims.reduce((a, c) => a + c.text.length, 0);
    if (cur.length > 0 && curChars + size > ceiling) {
      chunks.push(cur);
      cur = [];
      curChars = 0;
    }
    cur.push(n);
    curChars += size;
  }
  if (cur.length > 0) chunks.push(cur);
  return chunks.length > 0 ? chunks : [[]];
}

/**
 * Synthesize a report from the distilled notes using the LOCAL synth model, reusing the pipeline's
 * synth prompt builder + reground loop + renderer. If the assembled synth prompt would exceed
 * SYNTH_PROMPT_CEILING chars, MAP-REDUCE: synth over source-chunks then combine. Writes
 * report.md + meta.json to outDir.
 */
export async function synthLocalFromNotes(opts: SynthLocalOptions): Promise<SynthLocalResult> {
  const { notes, corpus, model, reground, chat, outDir } = opts;
  const nowIso = opts.nowIso ?? new Date().toISOString();
  const query = corpus.query || notes.query;
  const pnotes = asPipelineNotes(notes.notes);
  const sources = asPipelineSources(corpus);
  const subQuestions = [query];

  // The disputed list is deterministic from the notes (DISPUTED triangulation is part of the pipeline).
  const clusters = triangulate(pnotes);
  const disputed = clusters.filter((c) => c.status === "disputed");

  // Estimate the single-synth prompt size; map-reduce when it would blow the ceiling.
  const fullPrompt = buildSynthPrompt(query, subQuestions, pnotes, disputed);
  const promptChars = fullPrompt.system.length + fullPrompt.prompt.length;
  const mapReduce = promptChars > SYNTH_PROMPT_CEILING && pnotes.length > 1;

  let body: string;
  if (mapReduce) {
    // MAP: synth each chunk of sources independently → partial bodies.
    const chunks = chunkNotes(pnotes, SYNTH_PROMPT_CEILING);
    const partials: string[] = [];
    for (const chunk of chunks) {
      const req = buildSynthPrompt(query, subQuestions, chunk, disputed);
      const partial = await synthCall(chat, req, TOK.synth);
      if (partial.trim().length > 0) partials.push(partial);
    }
    // REDUCE: feed the partial bodies (as one note set) back through synth to combine. The
    // partials already carry [S#] markers, so we hand them to the combiner as the evidence.
    const combineNotes: DistilledNote[] = partials.map((p, i) => ({
      sourceId: pnotes[i]?.sourceId ?? `S${i + 1}`,
      tier: "secondary",
      claims: [{ text: p, quote: "" }],
    }));
    const combineReq = buildSynthPrompt(query, subQuestions, combineNotes, disputed);
    const combined = await synthCall(chat, combineReq, TOK.synth);
    body = combined.trim().length >= 200 ? combined : partials.join("\n\n");
  } else {
    body = await synthCall(chat, fullPrompt, TOK.synth);
  }

  if (body.trim().length < 200) body = "_Synthesis failed; sources and notes are listed below._";

  if (reground && body !== "_Synthesis failed; sources and notes are listed below._") {
    body = await regroundBody(chat, query, pnotes, sources, body, 1);
  }

  // Final report-sentence verification + render (the same renderer the box uses).
  const reportCitations = verifyReportSentences({ reportBody: body, sources, notes: pnotes });
  const markdown = renderReport({
    query,
    generatedAtIso: nowIso,
    brain: "local",
    iterations: 1,
    body,
    sources,
    disputed,
    citationPrecision: 1, // distilled-claim precision is not the ablation's metric; report-sentence is
    reportCitations,
  });

  // Popular summary call (kept for parity with the pipeline; its body is not graded here).
  await synthCall(
    chat,
    {
      system:
        "You write accessible, Simon-Willison-style blog summaries: concrete, direct, jargon unpacked.",
      prompt: `Summarize the following research report for a general audience in 1500-2500 words.\n\n${markdown}`,
    },
    TOK.popular
  );

  mkdirSync(outDir, { recursive: true });
  const reportPath = join(outDir, "report.md");
  const metaPath = join(outDir, "meta.json");
  writeFileSync(reportPath, markdown, "utf-8");
  const stats = {
    reportSentencePrecision: reportCitations.precision,
    supported: reportCitations.supported.length,
    unsupported: reportCitations.unsupported.length,
    uncitedSentenceCount: reportCitations.uncitedSentenceCount,
  };
  writeFileSync(
    metaPath,
    JSON.stringify(
      { query, model, style: notes.style, reground, mapReduce, sources: sources.length, stats },
      null,
      2
    ),
    "utf-8"
  );
  return { reportPath, metaPath, stats, mapReduce };
}

// ─── verify: the shared scorer over ANY report.md ──────────────────────────────────

export interface VerifyResult {
  reportSentencePrecision: number;
  supported: number;
  unsupported: number;
  uncitedSentenceCount: number;
}

/**
 * Load a report markdown + corpus sources, run `verifyReportSentences` (the trust anchor) over the
 * report body against the corpus, write the scored result to `outPath`, and return it. Works on
 * ANY report.md (including ones written by other tools) — it is the shared scorer for the ablation.
 */
export function verifyReportFile(reportPath: string, corpusPath: string, outPath: string): VerifyResult {
  const reportBody = readFileSync(reportPath, "utf-8");
  const corpus = readCorpus(corpusPath);
  const sources = asPipelineSources(corpus);
  const rc = verifyReportSentences({ reportBody, sources });
  const result: VerifyResult = {
    reportSentencePrecision: rc.precision,
    supported: rc.supported.length,
    unsupported: rc.unsupported.length,
    uncitedSentenceCount: rc.uncitedSentenceCount,
  };
  writeFileSync(outPath, JSON.stringify(result, null, 2), "utf-8");
  return result;
}

// ─── argv ──────────────────────────────────────────────────────────────────────

function parseFlags(argv: string[]): Record<string, string | boolean> {
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
  return flags;
}

function reqStr(flags: Record<string, string | boolean>, key: string): string {
  const v = flags[key];
  if (typeof v !== "string" || v.length === 0) throw new Error(`--${key} is required`);
  return v;
}

function asStyle(v: string): DistillStyle {
  if (v === "terse" || v === "rich" || v === "extractive" || v === "none") return v;
  throw new Error(`--style must be terse|rich|extractive|none (got "${v}")`);
}

const USAGE =
  "Usage:\n" +
  '  tsx scripts/dr-ablation.ts distill --corpus <path> --model <id> --style terse|rich|extractive|none \\\n' +
  "       --baseurl <url> [--max-chars N] --out <path>\n" +
  "  tsx scripts/dr-ablation.ts synth-local --notes <path> --corpus <path> --model <id> \\\n" +
  "       --reground on|off --baseurl <url> --out <dir>\n" +
  "  tsx scripts/dr-ablation.ts verify --report <path> --corpus <path> --out <path>\n";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const flags = parseFlags(argv.slice(1));

  if (cmd === "distill") {
    const corpus = readCorpus(reqStr(flags, "corpus"));
    const model = reqStr(flags, "model");
    const style = asStyle(reqStr(flags, "style"));
    const out = reqStr(flags, "out");
    const maxChars = typeof flags["max-chars"] === "string" ? Number(flags["max-chars"]) : DEFAULT_MAX_CHARS;
    // `none` needs no model; the others call over --baseurl.
    const chat: ChatFn =
      style === "none"
        ? async () => ({ text: "", promptTokens: 0, completionTokens: 0, model })
        : makeChatFn(reqStr(flags, "baseurl"), "x", model, 0);
    const notes = await distillCorpus(corpus, style, model, chat, maxChars);
    writeNotesFile(out, notes);
    const filled = notes.notes.filter((n) => n.distilled.trim().length > 0).length;
    console.log(JSON.stringify({ command: "distill", style, model, sources: notes.notes.length, filled, out }, null, 2));
    return;
  }

  if (cmd === "synth-local") {
    const notes = readNotesFile(reqStr(flags, "notes"));
    const corpus = readCorpus(reqStr(flags, "corpus"));
    const model = reqStr(flags, "model");
    const reground = reqStr(flags, "reground") === "on";
    const outDir = reqStr(flags, "out");
    const chat = makeChatFn(reqStr(flags, "baseurl"), "x", model, 0);
    const res = await synthLocalFromNotes({ notes, corpus, model, reground, chat, outDir });
    console.log(
      JSON.stringify(
        { command: "synth-local", model, style: notes.style, reground, mapReduce: res.mapReduce, ...res.stats, reportPath: res.reportPath },
        null,
        2
      )
    );
    return;
  }

  if (cmd === "verify") {
    const res = verifyReportFile(reqStr(flags, "report"), reqStr(flags, "corpus"), reqStr(flags, "out"));
    console.log(JSON.stringify({ command: "verify", ...res }, null, 2));
    return;
  }

  console.log(USAGE);
}

// Run only when invoked directly (not when imported by a test).
const invokedDirectly = process.argv[1]?.endsWith("dr-ablation.ts") ?? false;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
