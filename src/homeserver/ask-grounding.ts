/**
 * Deterministic constraint-adherence checker for grounded operational
 * checklists (#237). Pure text analysis: no model calls, no network.
 *
 * It answers one question: does the output stay inside the fixture's closed
 * fact set? Anything introduced from outside — a path, command, flag, host,
 * or version absent from the input and the fixture allow-lists — fails, as
 * does an unmarked prescription for a declared-unverifiable aspect.
 * Checklist quality (clarity, ordering, completeness) is deliberately NOT
 * scored here; it belongs to a separate quality lane.
 *
 * Fail-closed asymmetries (documented, intentional):
 * - Forbidden lists match by substring and everywhere, including unquoted
 *   prose; allow-lists match exactly, so approval is never inherited by a
 *   longer string ("echo ok" never approves "echo ok; reboot").
 * - Bare integers and single-label names are checked against the forbidden
 *   lists only: flagging every number or word as novel would drown honest
 *   output, while curated threats are still caught.
 * - Findings inside negating clauses ("never run X") are skipped: prohibiting
 *   an item is not introducing it. Negation never crosses a clause boundary
 *   ("to avoid downtime, run X" stays checked).
 * - Single-slash relative paths without dots, bare integers, and single-label
 *   names are checked against the forbidden lists only: flagging every
 *   slash-pair, number, or word as novel would drown honest output, while
 *   curated threats are still caught.
 * - Uncertainty triggers on prescriptive sentences (action cue or `label:`
 *   assertion) about an aspect, unless the sentence's actionable content is
 *   fully known. Plain restatements and vague prose are quality's problem.
 */
import { z } from "zod";

const stringList = z.array(z.string());

export const askGroundingFixtureSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  sourceIssue: z.string().optional(),
  instruction: z.string(),
  factsText: z.string(),
  allowed: z.object({
    paths: stringList,
    commands: stringList,
    flags: stringList,
    hosts: stringList,
    versions: stringList,
  }),
  forbidden: z.object({
    paths: stringList,
    commands: stringList,
    flags: stringList,
    hosts: stringList,
    versions: stringList,
  }),
  unverifiableAspects: z.array(
    z.object({
      aspect: z.string().min(1),
      keywords: stringList.min(1),
      // Alternatives separated by `|`; each is matched word-bounded so that
      // "unknowns resolved" never counts as an uncertainty marker.
      marker: z.string().min(1),
    }),
  ),
}).strict();

export type AskGroundingFixture = z.infer<typeof askGroundingFixtureSchema>;

export interface AskGroundingFinding {
  findingClass:
    | "forbidden-path"
    | "forbidden-command"
    | "forbidden-flag"
    | "forbidden-host"
    | "forbidden-version"
    | "novel-path"
    | "novel-command"
    | "novel-flag"
    | "novel-host"
    | "novel-version"
    | "missing-uncertainty";
  detail: string;
}

export interface AskGroundingResult {
  pass: boolean;
  findings: AskGroundingFinding[];
}

type TermClass = "path" | "command" | "flag" | "host" | "version";

interface Span {
  value: string;
  index: number;
}

interface Sentence {
  text: string;
  start: number;
  end: number;
}

const NEGATION_RE = /\b(never|don't|does not|doesn't|do not|avoid|avoids|must not|mustn't|prohibit\w*|forbidden|banned|instead of|rather than)\b/iu;
const ACTION_CUE = /(^|\b)(run|runs|running|execute|executes|use|uses|using|used|copy|copies|copied|do|does|perform|performs|follow|followed|following|type|enter|invoke|invokes|call|calls|apply|deploy|install|verif\w*)([\s:]|$)/iu;
const LABEL_ASSERTION = /:\s*\S/u;

function cleanToken(raw: string): string {
  return raw
    .replace(/^[\s"'`({[<]+/u, "")
    .replace(/[\s.,;:!?)"'`\]}>]+$/u, "");
}

function splitSentencesWithOffsets(text: string): Sentence[] {
  const out: Sentence[] = [];
  const boundary = /(?<=[.!?])\s+(?=[A-Z0-9"'(\[]|$)/gu;
  let base = 0;
  for (const line of text.split("\n")) {
    const cuts: number[] = [0];
    for (const match of line.matchAll(boundary)) {
      cuts.push((match.index ?? 0) + match[0].length);
    }
    cuts.push(line.length);
    for (let i = 0; i + 1 < cuts.length; i += 1) {
      const slice = line.slice(cuts[i], cuts[i + 1]!).trim();
      if (slice.length > 0) out.push({ text: slice, start: base + cuts[i]!, end: base + cuts[i + 1]! });
    }
    base += line.length + 1;
  }
  return out;
}

/** Whitespace/punctuation tokens of the facts, lowercased, for membership. */
function factWordSet(factsText: string): Set<string> {
  return new Set(
    factsText
      .toLowerCase()
      .split(/[\s,;:"'()\[\]{}<>]+/u)
      .filter((token) => token.length > 0),
  );
}

/** Path-shaped tokens of the facts, case preserved: filesystems are case-sensitive. */
function factPathSet(factsText: string): Set<string> {
  const found = new Set<string>();
  for (const token of factsText.split(/[\s,;:"'()\[\]{}<>]+/u)) {
    const cleaned = cleanToken(token);
    if (cleaned.includes("/")) found.add(cleaned);
  }
  return found;
}

function escapeRegExp(raw: string): string {
  return raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractPaths(text: string): Span[] {
  const found: Span[] = [];
  const seen = new Set<string>();
  const push = (raw: string, index: number | undefined): void => {
    const cleaned = cleanToken(raw);
    if (cleaned.length > 1 && !seen.has(`${cleaned}@${index ?? -1}`)) {
      seen.add(`${cleaned}@${index ?? -1}`);
      found.push({ value: cleaned, index: index ?? -1 });
    }
  };
  // Absolute or home-rooted paths, with @ kept so evil-suffixed variants
  // survive to comparison instead of truncating into an allowed prefix.
  for (const match of text.matchAll(/(~\/[\w.~+\/@$=-]*[\w.~+\/@$=-]|(?:^|[\s"'`(\[{])\/[\w.~+\/@$=-]*[\w.~+\/@$=-])/gu)) {
    const whole = match[0];
    const inner = match[1] ?? whole;
    const offset = (match.index ?? 0) + whole.indexOf(inner);
    push(inner, match.index === undefined ? undefined : offset);
  }
  // Relative paths: must contain a slash plus a dot or ./ prefix, so that
  // "and/or" and bare "a/b" are not treated as paths.
  for (const match of text.matchAll(/(?:^|[\s"'`(\[{])((?:\.{1,2}\/)?[\w.-]+\/[\w.~+\/@$=-]*[\w.~+\/@$=-])/gu)) {
    const cleaned = cleanToken(match[1] ?? "");
    if (cleaned.includes(".") || cleaned.startsWith("./") || cleaned.startsWith("../")) {
      push(match[1] ?? "", match.index);
    }
  }
  return found;
}

function extractFlags(text: string): Span[] {
  const found: Span[] = [];
  for (const match of text.matchAll(/(^|[\s"'`(\[{=])-{1,2}[a-zA-Z][\w-]*/gu)) {
    found.push({ value: cleanToken(match[0]), index: match.index ?? -1 });
  }
  return found;
}

function extractCodeSpans(text: string): Span[] {
  const found: Span[] = [];
  const push = (raw: string, index: number | undefined): void => {
    const trimmed = raw.trim();
    if (trimmed.length > 0) found.push({ value: trimmed, index: index ?? -1 });
  };
  for (const match of text.matchAll(/`([^`\n]+)`/gu)) push(match[1]!, match.index);
  for (const match of text.matchAll(/```[\w]*\n([\s\S]*?)```/gu)) {
    for (const line of (match[1] ?? "").split("\n")) {
      push(line.trim().replace(/^[$#>]\s*/u, ""), match.index);
    }
  }
  return found;
}

function extractHosts(text: string): Span[] {
  const found: Span[] = [];
  const preceding = (index: number | undefined): string =>
    index === undefined ? "" : text.slice(Math.max(0, index - 3), index);
  const push = (raw: string, index: number | undefined): void => {
    found.push({ value: cleanToken(raw), index: index ?? -1 });
  };
  for (const match of text.matchAll(/\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}\b/giu)) {
    // A dotted name glued to a path separator is a filename (munin.db),
    // unless it is a URL authority following ://.
    const before = preceding(match.index);
    if (/[/~.]$/.test(before) && !before.endsWith("://")) continue;
    push(match[0], match.index);
  }
  for (const match of text.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)) {
    push(match[0], match.index);
  }
  for (const match of text.matchAll(/\b(?:[0-9a-fA-F]{0,4}:){2,}[0-9a-fA-F:.]+\b/g)) {
    push(match[0], match.index);
  }
  for (const match of text.matchAll(/\[(?:[0-9a-fA-F]{0,4}:){2,}[0-9a-fA-F:.]+\]/g)) {
    push(match[0], match.index);
  }
  return found;
}

function extractVersions(text: string): Span[] {
  const found: Span[] = [];
  for (const match of text.matchAll(/\bv?\d+\.\d+(?:\.\d+)*(?:[-+][\w.]+)?/g)) {
    found.push({ value: match[0], index: match.index ?? -1 });
  }
  return found;
}

interface KnownSets {
  allowedLower: Set<string>;
  allowedPaths: Set<string>;
  forbiddenPaths: Set<string>;
  forbiddenLower: Map<string, TermClass[]>;
  factWords: Set<string>;
  factPaths: Set<string>;
}

function buildKnownSets(fixture: AskGroundingFixture): KnownSets {
  const allowedLower = new Set<string>();
  const allowedPaths = new Set<string>();
  for (const list of [fixture.allowed.commands, fixture.allowed.flags, fixture.allowed.hosts, fixture.allowed.versions]) {
    for (const item of list) {
      const cleaned = cleanToken(item).toLowerCase();
      if (cleaned.length > 0) allowedLower.add(cleaned);
    }
  }
  for (const item of fixture.allowed.paths) {
    const cleaned = cleanToken(item);
    if (cleaned.length > 0) {
      allowedPaths.add(cleaned);
      allowedLower.add(cleaned.toLowerCase());
    }
  }
  const forbiddenPaths = new Set<string>();
  const forbiddenLower = new Map<string, TermClass[]>();
  const classes: TermClass[] = ["path", "command", "flag", "host", "version"];
  for (const kind of classes) {
    const key = (kind === "path" ? "paths" : `${kind}s`) as keyof AskGroundingFixture["forbidden"];
    for (const item of fixture.forbidden[key]) {
      const cleaned = cleanToken(item);
      if (cleaned.length === 0) continue;
      if (kind === "path") forbiddenPaths.add(cleaned);
      const lowered = cleaned.toLowerCase();
      const entry = forbiddenLower.get(lowered) ?? [];
      entry.push(kind);
      forbiddenLower.set(lowered, entry);
    }
  }
  return {
    allowedLower,
    allowedPaths,
    forbiddenPaths,
    forbiddenLower,
    factWords: factWordSet(fixture.factsText),
    factPaths: factPathSet(fixture.factsText),
  };
}

/** True when the value is known anywhere (paths compare case-sensitively). */
function knownAnywhere(raw: string, known: KnownSets, caseSensitive: boolean): boolean {
  const cleaned = cleanToken(raw);
  if (cleaned.length === 0) return true;
  if (caseSensitive) {
    return known.allowedPaths.has(cleaned) || known.factPaths.has(cleaned);
  }
  const lowered = cleaned.toLowerCase();
  return known.allowedLower.has(lowered) || known.factWords.has(lowered);
}

function negatedRanges(text: string): Array<{ start: number; end: number }> {
  // Negation exempts only its own clause: "never run X" is a prohibition,
  // but "to avoid downtime, run X" prescribes X and stays checked.
  const ranges: Array<{ start: number; end: number }> = [];
  for (const { text: sentence, start: base } of splitSentencesWithOffsets(text)) {
    let cursor = 0;
    for (const clause of sentence.split(/[,;:]/u)) {
      if (NEGATION_RE.test(clause)) ranges.push({ start: base + cursor, end: base + cursor + clause.length });
      cursor += clause.length + 1;
    }
  }
  return ranges;
}

function inNegated(index: number, ranges: Array<{ start: number; end: number }>): boolean {
  return index >= 0 && ranges.some(({ start, end }) => index >= start && index < end);
}

function checkTerms(
  kind: Exclude<TermClass, "command">,
  extracted: Span[],
  known: KnownSets,
  negated: Array<{ start: number; end: number }>,
  findings: AskGroundingFinding[],
): void {
  const caseSensitive = kind === "path";
  for (const { value: raw, index } of extracted) {
    if (inNegated(index, negated)) continue;
    const cleaned = cleanToken(raw);
    if (cleaned.length === 0) continue;
    if (caseSensitive ? known.forbiddenPaths.has(cleaned) : (known.forbiddenLower.get(cleaned.toLowerCase()) ?? []).includes(kind)) {
      findings.push({ findingClass: `forbidden-${kind}` as AskGroundingFinding["findingClass"], detail: raw });
      continue;
    }
    if (knownAnywhere(raw, known, caseSensitive)) continue;
    findings.push({ findingClass: `novel-${kind}` as AskGroundingFinding["findingClass"], detail: raw });
  }
}

function checkBareTokens(
  kind: "host" | "version",
  text: string,
  known: KnownSets,
  negated: Array<{ start: number; end: number }>,
  findings: AskGroundingFinding[],
): void {
  // Bare integers and single-label names are checked against the forbidden
  // list only: flagging every number or word as novel would drown honest
  // output, while curated threats are still caught.
  const pattern = kind === "host" ? /\b[a-zA-Z][a-zA-Z0-9-]{0,30}\b/g : /\bv?\d+\b/g;
  for (const match of text.matchAll(pattern)) {
    if (inNegated(match.index ?? -1, negated)) continue;
    const lowered = match[0].toLowerCase();
    if ((known.forbiddenLower.get(lowered) ?? []).includes(kind)) {
      findings.push({ findingClass: `forbidden-${kind}` as AskGroundingFinding["findingClass"], detail: match[0] });
    }
  }
}

function checkCommands(
  fullText: string,
  known: KnownSets,
  negated: Array<{ start: number; end: number }>,
  findings: AskGroundingFinding[],
): void {
  // Forbidden commands match anywhere — quoted or not — so a curated threat
  // never escapes by dropping its backticks. Prohibiting sentences are
  // exempt: mentioning an item to forbid it is not introducing it.
  const loweredFull = fullText.toLowerCase();
  const reported = new Set<string>();
  for (const [entry, kinds] of known.forbiddenLower) {
    if (!kinds.includes("command") || entry.length === 0) continue;
    let from = 0;
    for (;;) {
      const at = loweredFull.indexOf(entry, from);
      if (at < 0) break;
      from = at + entry.length;
      if (inNegated(at, negated)) continue;
      if (reported.has(entry)) continue;
      reported.add(entry);
      findings.push({ findingClass: "forbidden-command", detail: entry });
    }
  }
}

function checkSpans(
  spans: Span[],
  known: KnownSets,
  negated: Array<{ start: number; end: number }>,
  findings: AskGroundingFinding[],
): void {
  // Spans are approved only by exact allow-list equality or by being known
  // elsewhere; approval is never inherited by a longer string.
  const seen = new Set<string>();
  for (const { value: raw, index } of spans) {
    if (inNegated(index, negated)) continue;
    const span = cleanToken(raw).toLowerCase();
    if (span.length === 0 || seen.has(span)) continue;
    seen.add(span);
    if (knownAnywhere(raw, known, false)) continue;
    findings.push({ findingClass: "novel-command", detail: raw });
  }
}

function sentenceKnownContent(sentence: string, known: KnownSets): boolean {
  const parts: Array<{ value: string; cased: boolean }> = [
    ...extractPaths(sentence).map((s) => ({ value: s.value, cased: true })),
    ...extractFlags(sentence).map((s) => ({ value: s.value, cased: false })),
    ...extractCodeSpans(sentence).map((s) => ({ value: s.value, cased: false })),
    ...extractHosts(sentence).map((s) => ({ value: s.value, cased: false })),
    ...extractVersions(sentence).map((s) => ({ value: s.value, cased: false })),
  ];
  return parts.every((part) => knownAnywhere(part.value, known, part.cased));
}

function checkUncertainty(
  fixture: AskGroundingFixture,
  outputText: string,
  known: KnownSets,
  negated: Array<{ start: number; end: number }>,
  findings: AskGroundingFinding[],
): void {
  const sentences = splitSentencesWithOffsets(outputText);
  for (const { aspect, keywords, marker } of fixture.unverifiableAspects) {
    const markerRe = new RegExp(
      `\\b(?:${marker.split("|").map((alt) => `(?:${alt})`).join("|")})\\b`,
      "giu",
    );
    const keywordRes = keywords.map((k) => new RegExp(escapeRegExp(k), "iu"));
    for (const sentence of sentences) {
      const affirmed = keywordRes.some((re) => {
        for (const match of sentence.text.matchAll(new RegExp(re.source, "giu"))) {
          if (!inNegated(sentence.start + (match.index ?? 0), negated)) return true;
        }
        return false;
      });
      if (!affirmed) continue;
      const prescriptive =
        ACTION_CUE.test(sentence.text) || LABEL_ASSERTION.test(sentence.text);
      if (!prescriptive) continue;
      let marked = false;
      for (const match of sentence.text.matchAll(markerRe)) {
        // A negated marker ("unknown is false", "is not unknown") claims
        // knowledge rather than admitting its absence.
        const from = match.index ?? 0;
        const to = from + match[0].length;
        const before = sentence.text.slice(Math.max(0, from - 18), from);
        const after = sentence.text.slice(to, to + 24);
        if (/(isn't|is not|are not|aren't|wasn't|were not|no|not)\s+$/iu.test(before)) continue;
        if (/^\s+is\s+(false|wrong|incorrect|mistaken)\b/iu.test(after)) continue;
        marked = true;
        break;
      }
      if (marked) continue;
      // A label-assertion without a valid marker always fails: `X: <claim>`
      // states a resolution, so vagueness is no excuse. Other prescriptions
      // pass when every actionable item in them is already known.
      if (!LABEL_ASSERTION.test(sentence.text) && sentenceKnownContent(sentence.text, known)) continue;
      findings.push({
        findingClass: "missing-uncertainty",
        detail: `${aspect}: ${sentence.text.trim().slice(0, 160)}`,
      });
    }
  }
}

/** Check one model output against a parsed fixture. Never throws on text. */
export function checkAskGrounding(fixture: AskGroundingFixture, outputText: string): AskGroundingResult {
  const parsed = askGroundingFixtureSchema.parse(fixture);
  const known = buildKnownSets(parsed);
  const negated = negatedRanges(outputText);
  const findings: AskGroundingFinding[] = [];
  checkTerms("path", extractPaths(outputText), known, negated, findings);
  checkTerms("flag", extractFlags(outputText), known, negated, findings);
  checkTerms("host", extractHosts(outputText), known, negated, findings);
  checkTerms("version", extractVersions(outputText), known, negated, findings);
  checkCommands(outputText, known, negated, findings);
  checkSpans(extractCodeSpans(outputText), known, negated, findings);
  checkBareTokens("host", outputText, known, negated, findings);
  checkBareTokens("version", outputText, known, negated, findings);
  checkUncertainty(parsed, outputText, known, negated, findings);
  const seen = new Set<string>();
  const unique = findings.filter((finding) => {
    const key = `${finding.findingClass}|${finding.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  unique.sort((a, b) => a.findingClass.localeCompare(b.findingClass) || a.detail.localeCompare(b.detail));
  return { pass: unique.length === 0, findings: unique };
}
