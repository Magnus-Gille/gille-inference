/**
 * frames-evidence.ts — per-sample evidence preflight.
 *
 * The whole point of the table-preserving corpus rebuild is to de-confound the
 * numerical-reasoning diagnosis: BEFORE we trust an oracle-arm numerical score, we
 * must know the answer's evidence is actually PRESENT in the (rebuilt) gold corpus.
 * If the gold answer can't be found in the corpus, a wrong model answer tells us
 * nothing about reasoning — the sample is retrieval/extraction-broken and must be
 * excluded from the numerical-reasoning split.
 *
 * `evidencePresent` is a deterministic, content-blind matcher (no model) — TDD'd.
 */

/** Lowercase, strip thousands-separators (so 8,804,190 ≡ 8804190), collapse whitespace. */
export function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/,/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export interface EvidenceResult {
  present: boolean;
  /** how: "exact" | "numeric-tokens" | "numeric+words" | "all-words" | "absent" | "empty-gold" */
  how: string;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Substring match ANCHORED at word boundaries — avoids "ny" matching inside "germany" (Codex
 * review: unbounded substring/word checks produced false positives). Lookaround on \w so it also
 * behaves when the needle starts/ends with a non-word char.
 */
function containsAnchored(haystack: string, needle: string): boolean {
  if (needle === "") return false;
  return new RegExp(`(?<!\\w)${escapeRegExp(needle)}(?!\\w)`).test(haystack);
}

/**
 * Is the gold answer's evidence present in the corpus markdown?
 *   1. exact — the normalized gold phrase appears (word-boundary anchored).
 *   2. numeric-dominant answer (number(s), no significant words) — every gold number appears (the
 *      case table-stripping broke: the figure lived only in a table).
 *   3. number+words answer — BOTH every number AND every significant word must appear; a
 *      coincidental number elsewhere is NOT evidence (Codex review — this kept extraction-broken
 *      samples out of the de-confounded split).
 *   4. all-words — every significant (>3-char) alpha token appears (word-boundary anchored).
 */
export function evidencePresent(gold: string, corpus: string): EvidenceResult {
  const g = normalizeForMatch(gold);
  const c = normalizeForMatch(corpus);
  if (g.length === 0) return { present: false, how: "empty-gold" };
  if (containsAnchored(c, g)) return { present: true, how: "exact" };

  const goldNums = g.match(/-?\d+(?:\.\d+)?/g) ?? [];
  const goldWords = g.split(/\s+/).filter((w) => w.length > 3 && /[a-z]/.test(w));
  const corpusNums = new Set(c.match(/-?\d+(?:\.\d+)?/g) ?? []);
  const numsOk = goldNums.length > 0 && goldNums.every((n) => corpusNums.has(n));
  const wordsOk = goldWords.length > 0 && goldWords.every((w) => containsAnchored(c, w));

  if (goldNums.length > 0 && goldWords.length === 0) {
    if (numsOk) return { present: true, how: "numeric-tokens" };
  } else if (goldNums.length > 0 && goldWords.length > 0) {
    if (numsOk && wordsOk) return { present: true, how: "numeric+words" };
  } else if (goldWords.length > 0) {
    if (wordsOk) return { present: true, how: "all-words" };
  }
  return { present: false, how: "absent" };
}

/** Heuristic: does this FRAMES sample's reasoning_types involve numeric/tabular reasoning? */
export function isNumericReasoning(reasoningTypes: string): boolean {
  return /numerical|tabular|calculation|aggregat/i.test(reasoningTypes);
}
