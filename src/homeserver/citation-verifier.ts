/**
 * Deterministic citation-enforcement pass for the deep-research harness.
 *
 * This is the single highest-value piece of glue: it maps every claim to a literal source
 * span by string-matching, with NO LLM in the loop (docs/deep-research-harness-design.md §1
 * — "deterministic glue … citation enforcement"). A claim only counts as supported if its
 * quote (or, lacking one, its claim text) actually appears — closely enough — in the cited
 * source's full markdown. Fabricated or mis-attributed claims fall out as `unresolved`, and
 * citation markers pointing at a source id we never collected fall out as `dangling`.
 *
 * Correctness is paramount and there is no model judgment anywhere here — the matching is
 * normalize-then-substring, with a token-overlap fallback for minor wording drift.
 */

import type {
  Source,
  CitationCheck,
  ClaimCitation,
  SentenceCitation,
  ReportCitationCheck,
} from "./deep-research-types.js";
import type { Verifier, VerifyResult } from "./verifier.js";

// ─── Normalization ───────────────────────────────────────────────────────────────

/**
 * Normalize for fuzzy literal matching: lowercase, strip markdown emphasis (`*_`#>`),
 * convert smart quotes to plain, replace any non-alphanumeric run with a single space, trim.
 *
 * The non-alphanumeric collapse subsumes whitespace collapsing and most punctuation, so the
 * markdown/quote handling below is really only about characters that would otherwise survive
 * as alphanumerics-adjacent noise (they don't) — we keep the explicit smart-quote mapping so a
 * curly apostrophe in "it's" degrades to a word boundary identically to a straight one.
 */
export function normalizeForMatch(s: string): string {
  return (
    s
      .toLowerCase()
      // Smart quotes / dashes → plain so they normalize identically to their ASCII forms.
      .replace(/[‘’‚‛]/g, "'")
      .replace(/[“”„‟]/g, '"')
      .replace(/[–—‒―]/g, "-")
      // Markdown emphasis / structure markers are pure noise for literal matching.
      .replace(/[*_`#>~]/g, " ")
      // KEEP NUMBERS ATOMIC: collapse digit-group separators that sit BETWEEN two digits
      // ("2,500,000" / "1.234" → "2500000" / "1234") BEFORE the general non-alnum collapse,
      // so a number stays a single token. Otherwise "$2,500,000" fragments into 3 tokens and a
      // fabricated "9,500,000" matches "2,500,000" by token-overlap. Run twice to catch the
      // overlapping separator in triple groups (the first pass consumes alternate separators).
      .replace(/(\d)[,.](\d)/g, "$1$2")
      .replace(/(\d)[,.](\d)/g, "$1$2")
      // Any run of non-alphanumeric characters becomes a single space.
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
  );
}

// ─── Content-token & negation helpers ──────────────────────────────────────────────

/** Minimal English stopword set — words that carry no claim content for matching purposes. */
const STOPWORDS = new Set<string>([
  "a", "an", "the", "and", "or", "but", "of", "to", "in", "on", "at", "by", "for", "with",
  "as", "is", "are", "was", "were", "be", "been", "being", "it", "its", "this", "that",
  "these", "those", "from", "into", "than", "then", "so", "such", "they", "them", "their",
  "he", "she", "his", "her", "we", "our", "you", "your", "i", "me", "my", "had", "has",
  "have", "do", "does", "did", "will", "would", "can", "could", "should", "may", "might",
  "must", "shall", "if", "about", "over", "under", "between", "while", "during", "out", "up",
]);

/** Negation tokens whose presence on only one side flips the meaning of an otherwise-similar span. */
const NEGATION_TOKENS = new Set<string>([
  "no", "not", "never", "cannot", "none", "without", "fails", "fail", "false", "neither", "nor",
]);

/**
 * Directional / magnitude antonyms. A single edge-word swap ("increase" → "reduce") breaks too
 * few bigrams to drop the overlap below threshold, yet inverts a quantitative claim — the same
 * failure mode the negation guard handles, one level out. We only reject a CLEAN opposite (one
 * side purely "up", the other purely "down"); a sentence mentioning both directions is "mixed"
 * and never triggers the guard (conservative — avoid false rejects).
 *
 * DELIBERATELY restricted to unambiguous directional VERBS. Comparative adjectives / prepositions
 * (more/less/fewer/higher/lower/greater/up/down) and noun-or-polysemous forms (gain/loss/growth/
 * contract/slow) were intentionally EXCLUDED: they appear constantly in non-directional prose, and
 * including them produced false-REJECTs (a legitimately grounded sentence whose best-overlap window
 * happened to contain an opposite comparative). NOTE: this covers the common directional class only;
 * open-ended quality antonyms (clean/dangerous, effective/harmful) and unlisted verbs are a
 * documented residual of string-overlap matching — the unsupported-sentence list is the backstop.
 */
const DIR_UP = new Set<string>([
  "increase", "increases", "increased", "increasing", "rise", "rises", "rose", "risen", "rising",
  "grow", "grows", "grew", "grown", "growing", "surge", "surged", "surges", "soar", "soared", "soars",
  "expand", "expands", "expanded", "expanding", "climb", "climbed", "climbing", "accelerate", "accelerated",
]);
const DIR_DOWN = new Set<string>([
  "decrease", "decreases", "decreased", "decreasing", "reduce", "reduces", "reduced", "reducing",
  "fall", "falls", "fell", "fallen", "falling", "drop", "drops", "dropped", "dropping",
  "decline", "declines", "declined", "declining", "shrink", "shrinks", "shrank", "shrunk",
  "plummet", "plummeted", "plummets", "plunge", "plunged", "plunges", "collapse", "collapsed",
]);

/** Net direction of a token list: "up"/"down" if only one polarity present, else "mixed"/"none". */
function direction(tokens: string[]): "up" | "down" | "mixed" | "none" {
  let up = false;
  let down = false;
  for (const t of tokens) {
    if (DIR_UP.has(t)) up = true;
    if (DIR_DOWN.has(t)) down = true;
  }
  if (up && down) return "mixed";
  if (up) return "up";
  if (down) return "down";
  return "none";
}

/** A token is "numeric" if it is composed purely of digits (numbers are kept atomic upstream). */
function isNumericToken(t: string): boolean {
  return /^[0-9]+$/.test(t);
}

/** Distinct non-stopword tokens in a needle — the actual claim content. */
function distinctContentTokens(tokens: string[]): Set<string> {
  const out = new Set<string>();
  for (const t of tokens) if (!STOPWORDS.has(t)) out.add(t);
  return out;
}

/**
 * Does the token list contain a negation? Handles the "n't" contraction too: normalization
 * strips the apostrophe so "isn't" → "isn t", leaving a bare "t" — we treat a standalone "t"
 * immediately following a verb-ish token as too noisy, so instead we detect "n't" on the RAW
 * text separately (see `hasNegation`).
 */
function hasNegationTokens(tokens: string[]): boolean {
  for (const t of tokens) if (NEGATION_TOKENS.has(t)) return true;
  return false;
}

/** Negation detection over the ORIGINAL string: explicit tokens OR an "n't" contraction. */
function hasNegation(original: string, tokens: string[]): boolean {
  if (hasNegationTokens(tokens)) return true;
  return /n['’]t\b/i.test(original);
}

// ─── Bigram scoring ────────────────────────────────────────────────────────────────

/** Consecutive token pairs ("a b c" → ["a b", "b c"]). A single token yields the token itself. */
function bigrams(tokens: string[]): string[] {
  if (tokens.length <= 1) return [...tokens];
  const out: string[] = [];
  for (let i = 0; i < tokens.length - 1; i++) out.push(tokens[i] + " " + tokens[i + 1]);
  return out;
}

/**
 * Adjacency-preserving overlap: fraction of the needle's bigrams (multiset) present in the
 * window's bigrams. Unlike bag-of-words this is order-sensitive — an inversion or a single
 * swapped content word breaks the bigrams that touch it, dropping the score.
 */
function bigramOverlap(needleTokens: string[], windowTokens: string[]): number {
  const nb = bigrams(needleTokens);
  if (nb.length === 0) return 0;
  const avail = new Map<string, number>();
  for (const b of bigrams(windowTokens)) avail.set(b, (avail.get(b) ?? 0) + 1);
  let hits = 0;
  for (const b of nb) {
    const left = avail.get(b) ?? 0;
    if (left > 0) {
      hits++;
      avail.set(b, left - 1);
    }
  }
  return hits / nb.length;
}

function tokenize(s: string): string[] {
  const n = normalizeForMatch(s);
  return n.length === 0 ? [] : n.split(" ");
}

// ─── Span matching ───────────────────────────────────────────────────────────────

export interface SpanMatch {
  matched: boolean;
  span?: string;
  ratio: number;
}

/**
 * Find whether `needle` appears (closely enough) in `haystack`.
 *
 *  1. Normalize both. Empty needle → {matched:false, ratio:0}.
 *  2. Exact normalized substring → {matched:true, ratio:1, span:<original haystack slice>}.
 *  3. Trivial-needle guard (#4): if the needle has fewer than 2 distinct CONTENT tokens
 *     (non-stopwords), do NOT fall through to fuzzy matching — an exact substring is required,
 *     so a stopword-only / single-content-word quote cannot be inflated to a match by overlap.
 *  4. Else slide a token window of size = needle token count over the haystack and score each by
 *     BIGRAM (consecutive token-pair) multiset overlap, which preserves adjacency — an inversion
 *     or a swapped content word breaks the bigrams it touches. Take the best window.
 *  5. GUARDS applied to the best window, independent of the ratio:
 *       - Numeric exact-match (#1): every purely-numeric needle token must appear verbatim in
 *         the best window; a fabricated quantity therefore can never resolve.
 *       - Negation polarity (#2): if exactly one of {needle, best window} is negated, reject.
 *     matched = bestRatio >= threshold AND both guards pass.
 */
export function findSpan(needle: string, haystack: string, threshold: number): SpanMatch {
  const needleTokens = tokenize(needle);
  if (needleTokens.length === 0) return { matched: false, ratio: 0 };

  // ── (2) Exact normalized-substring fast path, recovering the original haystack slice. ──
  const exact = locateNormalizedSubstring(needle, haystack);
  if (exact !== null) return { matched: true, span: exact, ratio: 1 };

  // ── (3) Trivial-needle guard: too little content to fuzzy-match safely. ──
  // With <2 distinct content tokens, the only honest evidence is a literal substring (handled
  // above). Anything else (stopword padding, a lone repeated word) must NOT fuzzy-resolve.
  if (distinctContentTokens(needleTokens).size < 2) {
    return { matched: false, span: "", ratio: 0 };
  }

  // ── (4) Sliding token-window BIGRAM overlap over the haystack. ──
  const hayTokens = tokenize(haystack);
  if (hayTokens.length === 0) return { matched: false, ratio: 0 };

  const winSize = needleTokens.length;
  let bestRatio = 0;
  let bestStart = 0;
  let bestEnd = Math.min(winSize, hayTokens.length);

  // Window count: at least one window even when the haystack is shorter than the needle.
  const lastStart = Math.max(0, hayTokens.length - winSize);
  for (let start = 0; start <= lastStart; start++) {
    const end = Math.min(start + winSize, hayTokens.length);
    const ratio = bigramOverlap(needleTokens, hayTokens.slice(start, end));
    if (ratio > bestRatio) {
      bestRatio = ratio;
      bestStart = start;
      bestEnd = end;
    }
  }

  const bestWindowTokens = hayTokens.slice(bestStart, bestEnd);
  const span = bestWindowTokens.join(" ");

  // ── (5a) Numeric exact-match guard: a fabricated number must never pass on prose overlap. ──
  const windowNumeric = new Set(bestWindowTokens.filter(isNumericToken));
  for (const t of needleTokens) {
    if (isNumericToken(t) && !windowNumeric.has(t)) {
      return { matched: false, span, ratio: bestRatio };
    }
  }

  // ── (5b) Negation polarity guard: reject a one-sided negation mismatch. ──
  const needleNeg = hasNegation(needle, needleTokens);
  const windowNeg = hasNegation(span, bestWindowTokens);
  if (needleNeg !== windowNeg) {
    return { matched: false, span, ratio: bestRatio };
  }

  // ── (5c) Directional-antonym guard: reject a clean up-vs-down inversion (increase/reduce …). ──
  const needleDir = direction(needleTokens);
  const windowDir = direction(bestWindowTokens);
  if ((needleDir === "up" && windowDir === "down") || (needleDir === "down" && windowDir === "up")) {
    return { matched: false, span, ratio: bestRatio };
  }

  return { matched: bestRatio >= threshold, span, ratio: bestRatio };
}

/**
 * Return the original-`haystack` slice corresponding to a normalized-substring match of
 * `needle`, or null if `needle`'s normalized form is not a substring of `haystack`'s. We walk
 * the haystack building its normalized form while remembering each normalized char's origin
 * index, so we can map the normalized match window back to a real slice (trimmed of edge
 * whitespace introduced by normalization).
 */
function locateNormalizedSubstring(needle: string, haystack: string): string | null {
  const nNeedle = normalizeForMatch(needle);
  if (nNeedle.length === 0) return null;

  const { normalized, origin } = normalizeWithOrigin(haystack);
  const idx = normalized.indexOf(nNeedle);
  if (idx === -1) return null;

  // Map [idx, idx+len) in normalized space back to original-string indices.
  const startNorm = idx;
  const endNorm = idx + nNeedle.length - 1;
  const startOrig = origin[startNorm];
  const endOrig = origin[endNorm];
  if (startOrig === undefined || endOrig === undefined) return null;
  return haystack.slice(startOrig, endOrig + 1);
}

/**
 * Produce the normalized string AND, for every normalized character, the index into the
 * ORIGINAL string it came from. Space characters that normalization *inserts* between runs
 * map to the original index just past the consumed run (best-effort; only interior matches
 * use these, and we trim edges). Mirrors `normalizeForMatch`'s collapse rules exactly —
 * INCLUDING the digit-separator merge: a `,`/`.` flanked by digits is dropped with NO space so
 * numbers stay atomic ("3.2" → "32"), matching `normalizeForMatch`.
 */
function normalizeWithOrigin(s: string): { normalized: string; origin: number[] } {
  const lower = s.toLowerCase();
  let out = "";
  const origin: number[] = [];
  let pendingSpace = false; // a run of non-alnum chars collapses to at most one space

  const isDigit = (c: string | undefined): boolean => c !== undefined && c >= "0" && c <= "9";

  for (let i = 0; i < lower.length; i++) {
    const ch = lower[i]!;
    const isAlnum = (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9");
    if (isAlnum) {
      if (pendingSpace && out.length > 0) {
        out += " ";
        origin.push(i); // the inserted space "belongs" to where the next run begins
      }
      pendingSpace = false;
      out += ch;
      origin.push(i);
    } else if ((ch === "," || ch === ".") && isDigit(lower[i - 1]) && isDigit(lower[i + 1])) {
      // Digit-group separator between two digits → dropped entirely (no space, keep number atomic).
      // pendingSpace is left untouched (it is already false after emitting the preceding digit).
    } else {
      // Non-alphanumeric (incl. smart quotes, markdown markers, whitespace) → collapse to space.
      pendingSpace = true;
    }
  }
  return { normalized: out, origin };
}

// ─── Citation-marker extraction ──────────────────────────────────────────────────

// Require MATCHED delimiters: `[ … ]` OR `( … )` only — `[S1)` / `(S2]` must NOT extract (#7).
// Two alternatives, each closing with the partner of its opener.
const MARKER_RE = /\[\s*((?:s\d+\s*,\s*)*s\d+)\s*\]|\(\s*((?:s\d+\s*,\s*)*s\d+)\s*\)/gi;

/**
 * Extract citation markers like `[S1]`, `[S2, S3]`, `[S4][S5]`, `(S6)` from a report →
 * unique source ids in first-seen order, e.g. `["S1","S2","S3"]`. Case-insensitive on the S;
 * ids are normalized to an uppercase `S`.
 */
export function extractCitedSourceIds(reportMarkdown: string): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  let m: RegExpExecArray | null;
  MARKER_RE.lastIndex = 0;
  while ((m = MARKER_RE.exec(reportMarkdown)) !== null) {
    const group = m[1] ?? m[2]!; // bracket group OR paren group: one-or-more "s<digits>", comma-sep
    for (const raw of group.split(",")) {
      const id = canonicalId(raw.trim());
      if (id && !seen.has(id)) {
        seen.add(id);
        order.push(id);
      }
    }
  }
  return order;
}

/** "s7" / "S7" → "S7"; anything not matching the sN shape → "". */
function canonicalId(raw: string): string {
  const m = /^s(\d+)$/i.exec(raw.trim());
  return m ? `S${m[1]}` : "";
}

/** Strip every `[S#]`/`(S#)` citation marker from a sentence (so they don't pollute matching). */
const MARKER_STRIP_RE = /\[\s*(?:s\d+\s*,\s*)*s\d+\s*\]|\(\s*(?:s\d+\s*,\s*)*s\d+\s*\)/gi;

/** Common abbreviations whose trailing period is NOT a sentence boundary (avoids over-splitting). */
const ABBREVIATIONS = new Set<string>([
  "dr", "mr", "mrs", "ms", "prof", "st", "jr", "sr", "vs", "etc", "al", "fig", "figs", "eq", "eqs",
  "no", "nos", "vol", "vols", "pp", "cf", "approx", "inc", "ltd", "co", "e.g", "i.e", "u.s", "u.k",
  "ca", "est", "ref", "refs", "sec", "ch", "ed", "eds", "repr",
]);

/**
 * True when `s` ends in a known abbreviation — i.e. its trailing period is a FALSE sentence
 * boundary. Citation markers are stripped first so a real sentence ending in "[S1]." is never
 * mistaken for an abbreviation. We do NOT treat a bare single-letter token as an initial: that
 * over-merged real sentences ending in a one-letter word ("…earned grade A. It exceeded…"); an
 * un-merged initial ("J. Smith found X [S1]") degrades gracefully — the "J." fragment is dropped
 * as too-short and the marker stays with its content.
 */
function endsWithAbbreviation(s: string): boolean {
  const cleaned = s.replace(MARKER_STRIP_RE, " ").trimEnd();
  const m = cleaned.match(/([A-Za-z][A-Za-z.]*)\.$/);
  if (!m) return false;
  return ABBREVIATIONS.has(m[1]!.toLowerCase());
}

// ─── Sentence segmentation (for report-sentence verification) ─────────────────────

/**
 * Split a synthesized report BODY (markdown prose, NOT the rendered report — which carries a
 * deterministic `## Sources` list whose `[S#]` lines would be mis-read as cited sentences) into
 * gradeable sentences.
 *
 *  - A heading line (`#`…`######`) is dropped ONLY when it carries no citation — a heading that
 *    cites a source is a CLAIM (the model can emit one as `### Foo [S1]`) and must be graded, so
 *    its `#` prefix is stripped and it flows through (else a hallucination hides in a heading).
 *  - A leading list marker / blockquote (`- `, `* `, `1. `, `> `) is stripped.
 *  - Within a line, split on `.?!` followed by whitespace and the start of a new sentence
 *    (uppercase, digit, or an opening citation bracket). A `.` BETWEEN two digits (a decimal)
 *    is never a boundary because it is not followed by whitespace, so "3.2" stays intact.
 *  - Fragments split at a known abbreviation / initial ("et al. Found", "Fig. 3", "vs. X") are
 *    re-merged (a false boundary), so the [S#] marker is not detached from its content.
 */
export function splitSentences(body: string): string[] {
  const out: string[] = [];
  for (const rawLine of body.split(/\n+/)) {
    let line = rawLine.trim();
    if (line.length === 0) continue;
    if (/^#{1,6}\s/.test(line)) {
      if (extractCitedSourceIds(line).length === 0) continue; // structural heading, no citation
      line = line.replace(/^#{1,6}\s+/, ""); // a CITED heading is a claim → strip marker, grade it
    }
    line = line.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+|>\s+)/, ""); // strip a leading list/quote marker
    // Greedy split, then re-merge any fragment whose predecessor ended at a false (abbreviation) boundary.
    const merged: string[] = [];
    for (const part of line.split(/(?<=[.!?])\s+(?=["'(\[]?[A-Z0-9])/)) {
      const prev = merged[merged.length - 1];
      if (prev !== undefined && endsWithAbbreviation(prev)) merged[merged.length - 1] = `${prev} ${part}`;
      else merged.push(part);
    }
    for (const part of merged) {
      const s = part.trim();
      if (s.length > 0) out.push(s);
    }
  }
  return out;
}

// ─── Report-sentence citation check (Phase-2: closes the synthesis-hallucination gap) ──
// `SentenceCitation` / `ReportCitationCheck` are declared in deep-research-types.ts (the shared
// contract), mirroring how `CitationCheck` / `ClaimCitation` live there.

/**
 * Verify the SYNTHESIZED report against its own citations: every sentence carrying an `[S#]`
 * marker must have its content actually appear — via the same hardened `findSpan` (numeric &
 * negation guards intact) — in the cited source's evidence. Evidence = the source's full page
 * markdown PLUS that source's distilled claim texts+quotes (the synthesizer writes FROM the
 * notes, so a faithful paraphrase of a given claim is legitimately grounded). A sentence whose
 * content is in NONE of its cited sources is `unsupported` — the deterministic signal for
 * "synthesis invented a sentence and cited a source that doesn't say it".
 *
 * This complements `checkCitations` (which verifies distilled-claim → source): a report can have
 * perfect distilled-claim precision yet still over-claim in prose; only this pass catches that.
 */
export function verifyReportSentences(opts: {
  reportBody: string;
  sources: Source[];
  notes?: { sourceId: string; claims: { text: string; quote: string }[] }[];
  /** Span match threshold. Lower than the quote threshold — report prose paraphrases. Default 0.45,
   *  calibrated against the 2026-06-20 live M5 dogfood: genuine over-claims clustered <=0.30, faithful
   *  paraphrases >=0.43, so 0.45 credits paraphrase yet flags over-claims. The numeric/negation/antonym
   *  guards reject fabrications independent of the ratio, so the floor stays safe. */
  threshold?: number;
  /** Min distinct content tokens for a sentence to be graded (avoids splitter-fragment noise).
   *  Default 2 — `findSpan` itself requires ≥2 distinct content tokens, so a 2-content-token cited
   *  sentence is verifiable and a terse fabrication ("Cancer cured [S1]") must not skip the gate. */
  minContentTokens?: number;
}): ReportCitationCheck {
  const threshold = opts.threshold ?? 0.45;
  const minContentTokens = opts.minContentTokens ?? 2;

  // Per canonical source id, the evidence search space: page markdown + that source's claims.
  const evidence = new Map<string, string>();
  for (const s of opts.sources) evidence.set(canonicalId(s.id) || s.id, s.markdown);
  for (const n of opts.notes ?? []) {
    const id = canonicalId(n.sourceId) || n.sourceId;
    const extra = n.claims.map((c) => `${c.text} ${c.quote}`).join("\n");
    evidence.set(id, `${evidence.get(id) ?? ""}\n${extra}`);
  }

  const supported: SentenceCitation[] = [];
  const unsupported: SentenceCitation[] = [];
  let uncitedSentenceCount = 0;

  for (const sentence of splitSentences(opts.reportBody)) {
    const citedSourceIds = extractCitedSourceIds(sentence);
    const text = sentence.replace(MARKER_STRIP_RE, " ").replace(/\s+/g, " ").trim();
    const contentTokenCount = distinctContentTokens(tokenize(text)).size;

    if (citedSourceIds.length === 0) {
      // Uncited: only count substantive sentences (a transition / heading-ish line is noise).
      if (contentTokenCount >= minContentTokens) uncitedSentenceCount++;
      continue;
    }

    // Cited but too little content to verify deterministically → don't grade it either way.
    if (contentTokenCount < minContentTokens) continue;

    let best: { id: string; span: SpanMatch } | null = null;
    for (const id of citedSourceIds) {
      const cid = canonicalId(id) || id;
      const hay = evidence.get(cid);
      if (hay === undefined) continue; // dangling citation: nothing collected for this id
      const span = findSpan(text, hay, threshold);
      if (span.matched) {
        best = { id: cid, span };
        break;
      }
      if (!best || span.ratio > best.span.ratio) best = { id: cid, span };
    }

    const rec: SentenceCitation = { sentence: text, citedSourceIds, matchRatio: best?.span.ratio ?? 0 };
    if (best && best.span.matched) {
      rec.supportedBy = best.id;
      rec.matchedSpan = best.span.span;
      supported.push(rec);
    } else {
      unsupported.push(rec);
    }
  }

  const total = supported.length + unsupported.length;
  const precision = total === 0 ? 1 : supported.length / total;
  return { supported, unsupported, uncitedSentenceCount, precision };
}

// ─── Auto-attribution (reverse citation) — for non-citing synths (e.g. Tongyi-DR) ──

export interface AutoAttributeOptions {
  /** Span match threshold for attributing a source to a sentence. Mirrors the report-sentence
   *  verifier default (0.45) so a sentence that auto-cites is one the verifier will then accept. */
  threshold?: number;
  /** Min distinct content tokens before a sentence is eligible for attribution. Default 2 —
   *  matches `verifyReportSentences` (and `findSpan` itself requires ≥2 distinct content tokens). */
  minContentTokens?: number;
}

/**
 * Deterministically attach `[S#]` markers to a NON-citing report body, by reverse-matching each
 * substantive uncited sentence against the read sources with the SAME hardened matcher the trust
 * anchor uses (`findSpan` + the numeric/negation/antonym guards). This makes a grounded-but-uncited
 * report (the Tongyi-DR failure mode: it answers from the read pages but omits inline citations)
 * verifiable by `verifyReportSentences` — WITHOUT a model call and WITHOUT ever fabricating a link:
 * a sentence whose content is in NO source stays uncited (and is correctly flagged unsupported).
 *
 * Faithfulness contract:
 *  - A sentence that ALREADY carries an `[S#]` marker is left exactly as-is (no double-cite, no
 *    override — the model's own attribution wins). This also makes the pass idempotent.
 *  - The guards in `findSpan` block the common fabrication classes: a wrong number, a flipped
 *    negation, or a clean directional inversion can never resolve regardless of surface overlap.
 *    NOTE: auto-attribution is exactly as strong as the existing trust anchor and no stronger — it
 *    inherits `findSpan`'s documented residual (a single proper-noun/entity swap, e.g. "Lyon" for
 *    "Paris", can still clear the bigram threshold). Because it attributes at the SAME threshold the
 *    verifier grades with, it never marks anything the verifier would then reject; the unsupported-
 *    sentence list and human review remain the backstop for the residual entity-swap class. We do
 *    NOT broaden `findSpan` here (it is shared by `checkCitations` and the ledger verifier).
 *  - Structural lines that a trailing marker would corrupt or that the verifier never grades —
 *    fenced code blocks, markdown table rows, horizontal rules, and uncited headings — are skipped.
 *  - Original line structure (headings, list/quote markers, blank lines, intra-line spacing between
 *    sentences) is preserved; only the marker is appended to the matching sentence.
 *
 * Returns the body with markers appended. No side effects; never throws on empty input.
 */
export function autoAttributeCitations(
  reportBody: string,
  sources: Source[],
  opts: AutoAttributeOptions = {}
): string {
  const threshold = opts.threshold ?? 0.45;
  const minContentTokens = opts.minContentTokens ?? 2;

  // Evidence search space per canonical source id (page markdown only — the agent reads full pages,
  // there is no distilled-notes stage here). Preserve source order for deterministic best-match ties.
  const evidence: { id: string; markdown: string }[] = sources.map((s) => ({
    id: canonicalId(s.id) || s.id,
    markdown: s.markdown,
  }));

  // Process line-by-line so headings / list markers / blank lines survive unchanged. Split each
  // prose line into sentence segments + their trailing whitespace separators, attribute, rejoin.
  // Track fenced code blocks so we never rewrite code (or anything inside a ``` fence).
  const outLines: string[] = [];
  let inFence = false;
  for (const rawLine of reportBody.split("\n")) {
    const trimmed = rawLine.trim();
    // Toggle on a ``` / ~~~ code fence; the fence line and its contents are emitted verbatim.
    if (/^(```|~~~)/.test(trimmed)) {
      inFence = !inFence;
      outLines.push(rawLine);
      continue;
    }
    if (inFence) {
      outLines.push(rawLine);
      continue;
    }
    if (trimmed.length === 0) {
      outLines.push(rawLine);
      continue;
    }
    // Skip structural lines the verifier does not grade and that a trailing marker would corrupt:
    //  - markdown table rows (`| … |`) and separator rows — a marker breaks the cell grid;
    //  - horizontal rules (`---` / `***` / `___`).
    if (/^\|/.test(trimmed) || /^([-*_])\1{2,}$/.test(trimmed.replace(/\s+/g, ""))) {
      outLines.push(rawLine);
      continue;
    }
    // A structural heading with NO citation is not graded by the verifier → leave it untouched.
    // (A cited heading, like other cited sentences, is preserved as-is by the per-sentence guard.)
    if (/^#{1,6}\s/.test(trimmed) && extractCitedSourceIds(trimmed).length === 0) {
      outLines.push(rawLine);
      continue;
    }

    // Preserve the leading indentation + any list/quote/heading prefix; only rewrite the prose body.
    const prefixMatch = rawLine.match(/^(\s*(?:#{1,6}\s+)?(?:[-*+]\s+|\d+[.)]\s+|>\s+)?)/);
    const prefix = prefixMatch ? prefixMatch[0]! : "";
    const rest = rawLine.slice(prefix.length);

    outLines.push(prefix + attributeWithinLine(rest, evidence, threshold, minContentTokens));
  }
  return outLines.join("\n");
}

/**
 * Attribute markers to the sentences within one prose line, preserving the inter-sentence
 * whitespace. We split capturing the boundary whitespace so it can be re-emitted verbatim, mirroring
 * `splitSentences`' boundary regex; abbreviation false-boundaries are re-merged the same way.
 */
function attributeWithinLine(
  line: string,
  evidence: { id: string; markdown: string }[],
  threshold: number,
  minContentTokens: number
): string {
  // Split into [segment, sep, segment, sep, …] by capturing the boundary whitespace.
  const parts = line.split(/((?<=[.!?])\s+(?=["'(\[]?[A-Z0-9]))/);
  // Re-merge a fragment whose predecessor ended at an abbreviation (false boundary), carrying its sep.
  const merged: { text: string; sep: string }[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const text = parts[i] ?? "";
    const sep = parts[i + 1] ?? "";
    const prev = merged[merged.length - 1];
    if (prev !== undefined && endsWithAbbreviation(prev.text)) {
      prev.text = `${prev.text}${prev.sep}${text}`;
      prev.sep = sep;
    } else {
      merged.push({ text, sep });
    }
  }

  let out = "";
  for (const { text, sep } of merged) {
    out += attributeSentence(text, evidence, threshold, minContentTokens) + sep;
  }
  return out;
}

/** Append a best-matching `[S#]` to ONE sentence segment if it is uncited, substantive, and grounded. */
function attributeSentence(
  segment: string,
  evidence: { id: string; markdown: string }[],
  threshold: number,
  minContentTokens: number
): string {
  if (segment.trim().length === 0) return segment;
  // Already cited (model's own attribution wins) → leave untouched. Keeps the pass idempotent.
  if (extractCitedSourceIds(segment).length > 0) return segment;

  const text = segment.replace(MARKER_STRIP_RE, " ").replace(/\s+/g, " ").trim();
  if (distinctContentTokens(tokenize(text)).size < minContentTokens) return segment;

  // Best matching source across ALL sources (first-match-wins on ties for determinism).
  let best: { id: string; ratio: number } | null = null;
  for (const e of evidence) {
    const span = findSpan(text, e.markdown, threshold);
    if (span.matched && (best === null || span.ratio > best.ratio)) {
      best = { id: e.id, ratio: span.ratio };
    }
  }
  if (!best) return segment; // no grounded source → stays uncited (verifier will flag it)

  // Append the marker, preserving the segment's trailing sentence punctuation/whitespace shape:
  // insert the marker BEFORE a trailing period/!/? if present (so "Foo. [S1]" not "Foo [S1].").
  return appendMarker(segment, best.id);
}

/**
 * Append `[Sx]` to a sentence segment BEFORE its terminal punctuation, matching the codebase
 * citation convention ("Foo bar [S1]."), e.g. "Paris is the capital of France." →
 * "Paris is the capital of France [S1].". Placing the marker before the period keeps `[S1]`
 * attached to its sentence under `splitSentences`' boundary regex (which would otherwise split a
 * post-period "[S1]" into its own segment), and makes the pass idempotent. A segment with no
 * terminal punctuation gets the marker at the end with a leading space.
 */
function appendMarker(segment: string, id: string): string {
  const m = segment.match(/^([\s\S]*?)([.!?]+)(\s*)$/);
  if (m) return `${m[1].trimEnd()} [${id}]${m[2]}${m[3]}`;
  return `${segment} [${id}]`;
}

// ─── Per-claim citation check ────────────────────────────────────────────────────

export interface CitationClaim {
  claimText: string;
  sourceId: string;
  quote?: string;
}

/**
 * For each claim: locate its `Source` by id. If missing → unresolved (dangling citation).
 * Else `findSpan(quote ?? claimText, source.markdown, threshold)`. Build a `CitationCheck`
 * with resolved/unresolved arrays + precision = resolved / (resolved + unresolved), or 1
 * when there are no claims.
 */
export function checkCitations(claims: CitationClaim[], sources: Source[], threshold: number): CitationCheck {
  // Canonicalize source ids on BOTH sides (#5): a claim citing "s1" must resolve against a
  // source whose id is "S1" / "s1". Fall back to the raw id for any non-`sN`-shaped id so a
  // bespoke id scheme still matches itself exactly.
  const byId = new Map<string, Source>();
  for (const s of sources) byId.set(canonicalId(s.id) || s.id, s);

  const resolved: ClaimCitation[] = [];
  const unresolved: ClaimCitation[] = [];

  for (const claim of claims) {
    const source = byId.get(canonicalId(claim.sourceId) || claim.sourceId);
    if (!source) {
      // Dangling citation: the cited source was never collected.
      unresolved.push({ claimText: claim.claimText, sourceId: claim.sourceId, matchRatio: 0 });
      continue;
    }
    const needle = claim.quote ?? claim.claimText;
    const span = findSpan(needle, source.markdown, threshold);
    const cite: ClaimCitation = {
      claimText: claim.claimText,
      sourceId: claim.sourceId,
      matchRatio: span.ratio,
    };
    if (span.matched) {
      cite.matchedSpan = span.span;
      resolved.push(cite);
    } else {
      unresolved.push(cite);
    }
  }

  const total = resolved.length + unresolved.length;
  const precision = total === 0 ? 1 : resolved.length / total;
  return { resolved, unresolved, precision };
}

// ─── Ledger verifier ─────────────────────────────────────────────────────────────

/**
 * A `Verifier` for the ledger. The graded `output` is the synthesized report markdown.
 * Grades on `checkCitations(claims, sources, threshold).precision` AND flags dangling `[Sx]`
 * markers in the report that reference a source id not in `sources`.
 *
 *  - pass    if precision >= minPrecision AND no dangling markers,
 *  - partial if precision in [0.5, minPrecision) (and no dangling markers),
 *  - fail    otherwise (precision < 0.5, OR any dangling marker present).
 *
 * `score` = precision (the report-level citation precision), regardless of dangling markers,
 * so the ledger keeps a continuous signal even when a dangling marker forces a non-pass.
 */
export function citationsResolved(opts: {
  sources: Source[];
  claims: CitationClaim[];
  threshold?: number; // default 0.8 (span match)
  minPrecision?: number; // default 0.9 (report-level)
}): Verifier {
  const threshold = opts.threshold ?? 0.8;
  const minPrecision = opts.minPrecision ?? 0.9;

  return (output: string): VerifyResult => {
    const check = checkCitations(opts.claims, opts.sources, threshold);
    const precision = check.precision;

    // Flag any citation marker in the report that points at an uncollected source id.
    // Canonicalize the known ids the SAME way `extractCitedSourceIds` canonicalizes markers (#5),
    // so a source whose id is "s1" is not mis-flagged as dangling for an "[S1]" marker.
    const knownIds = new Set(opts.sources.map((s) => canonicalId(s.id) || s.id));
    const cited = extractCitedSourceIds(output);
    const dangling = cited.filter((id) => !knownIds.has(id));

    const summary = `precision ${precision.toFixed(2)} (${check.resolved.length}/${
      check.resolved.length + check.unresolved.length
    } claims resolved)`;

    if (dangling.length > 0) {
      const note = `${summary}; dangling markers: ${dangling.join(", ")}`;
      // Dangling markers force a non-pass; severity tracks precision.
      const outcome = precision < 0.5 ? "fail" : "partial";
      return { outcome, score: precision, notes: note };
    }

    // No-inline-marker guard (#6): a report that makes claims but carries ZERO inline [S#]
    // markers has cited nothing — it must not score as a clean pass however well the claims
    // string-match. (A report with no claims at all is vacuously fine — nothing to cite.)
    if (opts.claims.length > 0 && cited.length === 0) {
      const note = `${summary}; no inline citation markers in report`;
      const outcome = precision < 0.5 ? "fail" : "partial";
      return { outcome, score: precision, notes: note };
    }

    if (precision >= minPrecision) return { outcome: "pass", score: precision, notes: summary };
    if (precision >= 0.5) return { outcome: "partial", score: precision, notes: summary };
    return { outcome: "fail", score: precision, notes: summary };
  };
}
