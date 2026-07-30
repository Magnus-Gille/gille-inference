/**
 * Strict contracts for the owner-only GPT-OSS recall -> Qwen precision review cascade (#132).
 *
 * This module deliberately owns no routing, issue creation, tool use, or user-facing response.
 * Its callers can use it only to collect shadow evidence; a malformed model response is rejected
 * before it can be recorded as a finding.
 */
import { z } from "zod";

export const REVIEW_CASCADE_CONTRACT = "gille-inference.review-cascade/v1" as const;

export const findingSeveritySchema = z.enum(["critical", "high", "medium", "low"]);
export type FindingSeverity = z.infer<typeof findingSeveritySchema>;

const findingSchema = z
  .object({
    id: z.string().trim().min(1),
    severity: findingSeveritySchema,
    lineIds: z.array(z.string().trim().min(1)).min(1),
    evidence: z.string().trim().min(1),
    claim: z.string().trim().min(1),
  })
  .strict();

export type ReviewFinding = z.infer<typeof findingSchema>;
export type ReviewFindingParse = { ok: true; findings: ReviewFinding[] } | { ok: false; error: string };

const adjudicationSchema = z
  .object({
    findingId: z.string().trim().min(1),
    decision: z.enum(["confirm", "refute", "insufficient"]),
    rationale: z.string().trim().min(1),
  })
  .strict();

export type Adjudication = z.infer<typeof adjudicationSchema>;
export type AdjudicationParse =
  | { ok: true; adjudications: Adjudication[] }
  | { ok: false; error: string };

export type SourceLinesParse = { ok: true; lines: Map<string, string> } | { ok: false; error: string };

/**
 * Source is intentionally a compact, line-addressable format: `L12|actual source line`.
 * The validator refuses duplicates and unlabelled/non-empty lines so models cannot cite an
 * invented span or smuggle an uncited prose section into the review corpus.
 */
export function parseReviewSource(source: string): SourceLinesParse {
  const lines = new Map<string, string>();
  for (const rawLine of source.split("\n")) {
    if (rawLine === "") continue;
    const match = /^([A-Za-z][A-Za-z0-9_-]{0,63})\|(.*)$/s.exec(rawLine);
    if (!match) return { ok: false, error: "source must contain only line-id|source-line records" };
    const [, id, text] = match;
    if (text === "") return { ok: false, error: `source line ${id} is empty` };
    if (lines.has(id)) return { ok: false, error: `source line id ${id} is duplicated` };
    lines.set(id, text);
  }
  return lines.size > 0 ? { ok: true, lines } : { ok: false, error: "source contains no labelled lines" };
}

function parseJson(raw: string): unknown | null {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/** Parse and source-validate recall-model findings. */
export function parseReviewFindings(raw: string, source: string): ReviewFindingParse {
  const sourceResult = parseReviewSource(source);
  if (!sourceResult.ok) return sourceResult;
  const parsed = z.object({ findings: z.array(findingSchema) }).strict().safeParse(parseJson(raw));
  if (!parsed.success) return { ok: false, error: `invalid finding response: ${parsed.error.issues[0]?.message ?? "schema mismatch"}` };

  const seen = new Set<string>();
  for (const finding of parsed.data.findings) {
    if (seen.has(finding.id)) return { ok: false, error: "finding ids must be unique" };
    seen.add(finding.id);
    const lineIds = [...new Set(finding.lineIds)];
    if (lineIds.length !== finding.lineIds.length) return { ok: false, error: `finding ${finding.id} cites a line more than once` };
    if (!lineIds.every((id) => sourceResult.lines.has(id))) {
      return { ok: false, error: `finding ${finding.id} cites a source line that was not reviewed` };
    }
    if (!lineIds.some((id) => sourceResult.lines.get(id)!.includes(finding.evidence))) {
      return { ok: false, error: `finding ${finding.id} evidence is not an exact excerpt from a cited source line` };
    }
  }
  return { ok: true, findings: parsed.data.findings };
}

/** Parse a precision-model verdict, requiring exactly one decision per recall candidate. */
export function parseAdjudications(raw: string, expectedFindingIds: readonly string[]): AdjudicationParse {
  if (new Set(expectedFindingIds).size !== expectedFindingIds.length) {
    return { ok: false, error: "expected finding ids must be unique" };
  }
  const parsed = z.object({ adjudications: z.array(adjudicationSchema) }).strict().safeParse(parseJson(raw));
  if (!parsed.success) return { ok: false, error: `invalid adjudication response: ${parsed.error.issues[0]?.message ?? "schema mismatch"}` };
  const expected = new Set(expectedFindingIds);
  const seen = new Set<string>();
  for (const row of parsed.data.adjudications) {
    if (!expected.has(row.findingId) || seen.has(row.findingId)) {
      return { ok: false, error: "adjudications must refer to each candidate exactly once" };
    }
    seen.add(row.findingId);
  }
  return seen.size === expected.size
    ? { ok: true, adjudications: parsed.data.adjudications }
    : { ok: false, error: "adjudications omitted a candidate" };
}

export function buildRecallPrompt(source: string): string {
  return [
    `Contract: ${REVIEW_CASCADE_CONTRACT}.`,
    "Perform recall-oriented code review of ONLY the labelled source below.",
    "Return only JSON: {\"findings\":[{\"id\":string,\"severity\":\"critical|high|medium|low\",\"lineIds\":[string],\"evidence\":string,\"claim\":string}]}.",
    "Every evidence value must be an exact excerpt from a cited source line. Do not cite lines that are absent.",
    "Source:",
    source,
  ].join("\n");
}

export function buildAdjudicationPrompt(source: string, findings: readonly ReviewFinding[]): string {
  return [
    `Contract: ${REVIEW_CASCADE_CONTRACT}.`,
    "Act as a precision reviewer. For every candidate below, decide confirm, refute, or insufficient using ONLY the labelled source.",
    "Return only JSON: {\"adjudications\":[{\"findingId\":string,\"decision\":\"confirm|refute|insufficient\",\"rationale\":string}]}.",
    "Do not create, drop, or merge candidates.",
    "Source:",
    source,
    "Candidates:",
    JSON.stringify(findings),
  ].join("\n");
}
