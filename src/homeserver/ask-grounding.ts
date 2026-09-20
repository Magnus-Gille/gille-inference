/**
 * Deterministic constraint-adherence checker for grounded operational
 * checklists (#237). Pure text analysis: no model calls, no network.
 *
 * It answers one question: does the output stay inside the fixture's closed
 * fact set? Anything introduced from outside — a path, command, flag, host,
 * or version absent from the input and the fixture allow-list — fails, as
 * does a missing uncertainty marker on a declared-unverifiable aspect.
 * Checklist quality (clarity, ordering, completeness) is deliberately NOT
 * scored here; it belongs to a separate quality lane.
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

function cleanToken(raw: string): string {
  return raw.replace(/[.,;:!?)"'\]}>]+$/u, "").replace(/^["'({[<]+/u, "");
}

function normList(list: string[]): Set<string> {
  return new Set(list.map((item) => cleanToken(item).toLowerCase()));
}

function extractPaths(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/(~\/[\w.~+\/-]*[\w.~+\/-]|(?:^|[\s"'`(\[{])\/[\w.~+\/-]*[\w.~+\/-])/gu)) {
    const cleaned = cleanToken(match[1] ?? match[0]);
    if (cleaned.length > 1) found.add(cleaned);
  }
  return [...found];
}

function extractFlags(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/(^|[\s"'`(\[{=])--[a-zA-Z][\w-]*/gu)) {
    found.add(match[0].trim().replace(/^["'({\[=]+/u, ""));
  }
  return [...found];
}

function extractCodeSpans(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/`([^`\n]+)`/gu)) found.add(match[1]!.trim());
  for (const match of text.matchAll(/```[\w]*\n([\s\S]*?)```/gu)) {
    for (const line of match[1]!.split("\n")) {
      const trimmed = line.trim().replace(/^[$#>]\s*/u, "");
      if (trimmed.length > 0) found.add(trimmed);
    }
  }
  return [...found];
}

function extractHosts(text: string): string[] {
  const found = new Set<string>();
  // A dotted name inside a path (e.g. the `.db` in `~/.munin-memory/munin.db`)
  // is a filename, not a host: skip matches glued to a path separator.
  for (const match of text.matchAll(/\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}\b/giu)) {
    const before = match.index === undefined ? "" : text.slice(Math.max(0, match.index - 2), match.index);
    if (/[/~.]$/.test(before)) continue;
    found.add(cleanToken(match[0]));
  }
  for (const match of text.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)) {
    found.add(match[0]);
  }
  return [...found];
}

function extractVersions(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/\bv?\d+\.\d+(?:\.\d+)*(?:[-+][\w.]+)?/g)) {
    found.add(match[0]);
  }
  return [...found];
}

function checkList(
  kind: "path" | "command" | "flag" | "host" | "version",
  extracted: string[],
  fixture: AskGroundingFixture,
  findings: AskGroundingFinding[],
): void {
  const key = `${kind}s` as keyof AskGroundingFixture["allowed"];
  const allowed = normList(fixture.allowed[key]);
  const forbidden = normList(fixture.forbidden[key]);
  const facts = fixture.factsText.toLowerCase();
  for (const raw of extracted) {
    const item = cleanToken(raw).toLowerCase();
    if (item.length === 0) continue;
    if (forbidden.has(item)) {
      findings.push({ findingClass: `forbidden-${kind}` as AskGroundingFinding["findingClass"], detail: raw });
      continue;
    }
    if (allowed.has(item)) continue;
    // Facts-text membership is checked on the cleaned item so that a value
    // stated in the input is never novel, whatever its surface form.
    if (facts.includes(item)) continue;
    findings.push({ findingClass: `novel-${kind}` as AskGroundingFinding["findingClass"], detail: raw });
  }
}

function checkCommands(
  spans: string[],
  fixture: AskGroundingFixture,
  findings: AskGroundingFinding[],
): void {
  // A command counts as known when the whole span matches, so multi-word
  // fixtures like "cp .env" are enforceable without parsing shell grammar.
  const allowed = normList(fixture.allowed.commands);
  const forbidden = normList(fixture.forbidden.commands);
  const facts = fixture.factsText.toLowerCase();
  for (const raw of spans) {
    const span = cleanToken(raw).toLowerCase();
    if (span.length === 0) continue;
    let matchedForbidden = false;
    for (const entry of forbidden) {
      if (entry.length > 0 && span.includes(entry)) {
        findings.push({ findingClass: "forbidden-command", detail: raw });
        matchedForbidden = true;
        break;
      }
    }
    if (matchedForbidden) continue;
    let known = false;
    for (const entry of allowed) {
      if (entry.length > 0 && (span === entry || span.includes(entry))) {
        known = true;
        break;
      }
    }
    if (known) continue;
    if (facts.includes(span) && span.length > 3) continue;
    // Single generic verbs outside backticks/blocks are not commands; the
    // span-level check above already covers quoted and fenced content.
    if (!raw.includes(" ") && !raw.includes("/") && !raw.includes("-")) continue;
    findings.push({ findingClass: "novel-command", detail: raw });
  }
}

function checkUncertainty(
  fixture: AskGroundingFixture,
  outputText: string,
  findings: AskGroundingFinding[],
): void {
  const sentences = outputText.split(/[.!?\n]+/u);
  for (const { aspect, keywords, marker } of fixture.unverifiableAspects) {
    const markerRe = new RegExp(marker, "iu");
    const keywordRes = keywords.map((k) => new RegExp(k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu"));
    for (const sentence of sentences) {
      if (!keywordRes.some((re) => re.test(sentence))) continue;
      if (!markerRe.test(sentence)) {
        findings.push({
          findingClass: "missing-uncertainty",
          detail: `${aspect}: ${sentence.trim().slice(0, 160)}`,
        });
      }
    }
  }
}

/** Check one model output against a parsed fixture. Never throws on text. */
export function checkAskGrounding(fixture: AskGroundingFixture, outputText: string): AskGroundingResult {
  const parsed = askGroundingFixtureSchema.parse(fixture);
  const findings: AskGroundingFinding[] = [];
  checkList("path", extractPaths(outputText), parsed, findings);
  checkList("flag", extractFlags(outputText), parsed, findings);
  checkList("host", extractHosts(outputText), parsed, findings);
  checkList("version", extractVersions(outputText), parsed, findings);
  checkCommands(extractCodeSpans(outputText), parsed, findings);
  checkUncertainty(parsed, outputText, findings);
  findings.sort((a, b) => a.findingClass.localeCompare(b.findingClass) || a.detail.localeCompare(b.detail));
  return { pass: findings.length === 0, findings };
}
