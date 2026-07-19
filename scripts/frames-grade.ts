/**
 * frames-grade.ts — Pure answer-normalization + loose match for FRAMES eval.
 *
 * Two tiers of matching:
 *   1. normalizeAnswer + looseAnswerMatch  (deterministic, numeric-aware, word-level substring)
 *   2. Falls through to LLM judge in frames-eval.ts if tier-1 returns false
 *
 * Deliberately avoids any imports beyond Node builtins so it is unit-testable offline.
 */

/** Article tokens stripped from the START of a normalized string. */
const LEADING_ARTICLES = new Set(["the", "a", "an"]);

/**
 * Leading "framing" prefixes that add no semantic content to an answer.
 * E.g. "This was Mesut Ozil." → "Mesut Ozil."
 */
const FRAMING_PREFIX_RE = /^(this was|it was|the answer is|the answer was|that was|it is|his name is|her name is|their name is)\s+/i;

/** Regex matching a purely-numeric string (digits, optional decimal point). */
const PURE_NUMERIC_RE = /^\d+(\.\d+)?$/;

function isPureNumeric(s: string): boolean {
  return PURE_NUMERIC_RE.test(s.replace(/\s/g, ""));
}

/**
 * Normalize an answer string for loose comparison:
 *   - Normalize unicode spaces / narrow-no-break-space to regular space
 *   - Normalize curly/fancy quotes → ASCII equivalents before NFKD fold
 *   - NFKD-fold diacritics (Ö→O, é→e, etc.) then drop non-ASCII
 *   - Lowercase
 *   - Strip leading framing phrases ("This was", "Her name is", …)
 *   - Strip ONLY thousands-grouped commas (\d{1,3}(,\d{3})+); decimal points kept
 *   - Strip all remaining non-alphanumeric chars except space and decimal point
 *   - Remove isolated periods (not between two digits) to clean sentence-final dots
 *   - Collapse whitespace
 *   - Strip leading articles (the / a / an)
 */
export function normalizeAnswer(s: string): string {
  // Normalize unicode spaces (narrow no-break space U+202F, thin space, etc.)
  let t = s.replace(/[      ​]/g, " ");
  // Normalize fancy apostrophes/quotes → ASCII before NFKD so d'Or and d'Or map the same
  t = t.replace(/['‘’‚‛′‵`´]/g, "'");
  t = t.replace(/["“”„‟″‶]/g, '"');
  // NFKD diacritic fold: decompose into base chars + combining marks, then keep only ASCII
  t = [...t.normalize("NFKD")].filter((c) => c.charCodeAt(0) < 128).join("");
  t = t.toLowerCase().trim();
  // Strip leading framing phrases
  t = t.replace(FRAMING_PREFIX_RE, "");
  // Thousands-grouped comma strip: "1,234" → "1234", "506,000" → "506000"
  // Pattern: 1–3 digits followed by one or more groups of exactly 3 digits after a comma
  t = t.replace(/\d{1,3}(?:,\d{3})+/g, (m) => m.replace(/,/g, ""));
  // Strip all non-alphanumeric except space and period
  t = t.replace(/[^a-z0-9 .]/g, " ");
  // Remove isolated periods (sentence-final dots, etc.) — keep only decimal points (digit.digit)
  t = t.replace(/(?<!\d)\.(?!\d)/g, " ");
  // Collapse whitespace
  t = t.replace(/\s+/g, " ").trim();
  // Strip leading article
  const parts = t.split(" ");
  if (parts.length > 1 && LEADING_ARTICLES.has(parts[0]!)) {
    t = parts.slice(1).join(" ");
  }
  return t;
}

/**
 * Word-level substring check: is every word in `needle` contained in `haystack`'s word list
 * in order (contiguous window)?
 *
 * "jane ballou" is a word-substr of "her name is jane ballou" → true
 * "cat" is NOT a word-substr of "concatenate" → false  (word boundary enforced)
 */
function wordSubstr(needle: string, haystack: string): boolean {
  if (needle === "") return true;
  const nWords = needle.split(" ");
  const hWords = haystack.split(" ");
  const nLen = nWords.length;
  for (let i = 0; i <= hWords.length - nLen; i++) {
    let match = true;
    for (let j = 0; j < nLen; j++) {
      if (hWords[i + j] !== nWords[j]) { match = false; break; }
    }
    if (match) return true;
  }
  return false;
}

/**
 * Returns true if `subjectWords` appears in `haystackWords` immediately after a negator
 * (not / never / no).
 */
function isNegated(subjectWords: string[], haystackWords: string[]): boolean {
  const NEGATORS = new Set(["not", "never", "no"]);
  const nLen = subjectWords.length;
  for (let i = 0; i < haystackWords.length - nLen; i++) {
    if (NEGATORS.has(haystackWords[i]!)) {
      let match = true;
      for (let j = 0; j < nLen; j++) {
        if (haystackWords[i + 1 + j] !== subjectWords[j]) { match = false; break; }
      }
      if (match) return true;
    }
  }
  return false;
}

/**
 * Tier-1 loose match:
 *   - Empty predicted → false (never a match)
 *   - After normalization, exact match → true
 *   - Numeric equality: parse both as floats; if both parse, compare numerically
 *     (decimal points preserved, so 3.14 ≠ 314)
 *   - Word-level substring gold-in-predicted → true, unless gold is negated in predicted
 *   - Word-level substring predicted-in-gold → true, with guards:
 *       · purely-numeric predicted in non-numeric gold phrase → false (guard vs "10" in "10 years")
 *       · predicted appears after a negator in gold → false
 *       · single-word predicted in a long gold (>4 words) → false (guard vs "Years" in long gold)
 *
 * Returns false when none of the above triggers; caller falls through to an LLM judge.
 */
export function looseAnswerMatch(gold: string, predicted: string): boolean {
  const g = normalizeAnswer(gold);
  const p = normalizeAnswer(predicted);

  // Empty predicted never matches
  if (!p) return false;

  // Exact after normalization
  if (g === p) return true;

  // Numeric equality: both must parse as finite numbers; decimal preserved so 3.14 ≠ 314
  const gRaw = g.replace(/\s/g, "");
  const pRaw = p.replace(/\s/g, "");
  const gNum = Number(gRaw);
  const pNum = Number(pRaw);
  if (!Number.isNaN(gNum) && !Number.isNaN(pNum) && gRaw !== "" && pRaw !== "") {
    return gNum === pNum;
  }

  const gWords = g.split(" ");
  const pWords = p.split(" ");

  // Gold inside predicted (e.g. "France" inside "The answer is France") — generally OK
  // but reject if gold appears in a negation context within predicted
  if (wordSubstr(g, p)) {
    if (isNegated(gWords, pWords)) return false;
    return true;
  }

  // Predicted inside gold — needs additional guards against false positives
  if (wordSubstr(p, g)) {
    // Guard 1: purely-numeric predicted in a non-numeric gold phrase
    // ("10" substring of "10 years" should not score — route to LLM judge)
    if (isPureNumeric(pRaw) && !isPureNumeric(gRaw)) return false;
    // Guard 2: predicted appears after a negator inside gold
    if (isNegated(pWords, gWords)) return false;
    // Guard 3: single-word predicted matching into a long gold (unit-only false positive)
    if (pWords.length === 1 && gWords.length > 4) return false;
    return true;
  }

  return false;
}
