import { z } from "zod";
import { extractCodeBlock, stripThink, type Verifier, type VerifyResult } from "./verifier.js";
import { ingressTaskType, isPromotedAdvisoryTaskType } from "./task-type-identity.js";

/**
 * Bounded local-review lane (issue #74).
 *
 * `code-review` (taxonomy.ts) stays a frontier-escalation gap type for open-ended, whole-patch PR
 * review — UNCHANGED by this module. This is a NARROW, distinct task type for three specific
 * bounded review subtasks that a local model can plausibly do well and that are cheap to grade
 * mechanically, without a frontier model in the loop:
 *
 *   1. classify-findings    — given already-identified findings, classify each (confirmed/refuted/
 *                              needs-info). The frontier already did the hard work of FINDING the
 *                              issue; the local model only judges each one against the diff.
 *   2. detect-anti-pattern  — does a fixed, named anti-pattern appear, and where.
 *   3. verify-output-shape  — does a candidate output structurally match a required schema.
 *
 * The evidence behind allowing this (grimnir session 2026-07-24, recorded on gille-inference#25):
 * 4/4 BOUNDED single-question M5 review calls on real merged PRs were useful and correct (two
 * action-pin SHA/semantics checks, one docs-consistency review with correct substring-edge
 * reasoning about `"HS_API_KEY"` vs `"$HS_API_KEY"`, one threshold-helper review that correctly
 * declined a terminology finding) — versus a whole-patch adversarial review of a ~160-line
 * safety-relevant diff (gille-inference#78) that returned 4 findings, ALL refuted on validation,
 * one of which would have removed safety-relevant claim-token fencing. The boundary this module
 * encodes is BOUNDED-vs-OPEN-ENDED, not "this model is generally capable of code review" — see
 * docs/review-bounded-lane.md.
 *
 * Local output from this lane is ADVISORY EVIDENCE ONLY — see delegate-policy.ts's
 * `isAdvisoryOnlyTaskType` — never an authoritative merge/decision gate, until an operator
 * explicitly promotes it after a measured pass rate (`delegatePolicy.promotedAdvisoryTaskTypes`).
 *
 * Anti-drift note: taxonomy.ts normally inlines its own keyword literals per task type (see its own
 * top-of-file comment). This module deliberately breaks that pattern and is the SINGLE SOURCE of
 * the exact marker strings that both the prompt builders below and taxonomy.ts's keyword list key
 * off — issue #74's explicit requirement is that prompt wording must not silently change the
 * intended route, so the marker literals the classifier watches for and the marker literals the
 * prompt contract emits must be structurally the same constant, not two copies that can drift.
 */

export const REVIEW_BOUNDED_TASK_TYPE = "review-bounded" as const;
export const REVIEW_BOUNDED_CONTRACT_VERSION = "gille-inference.review-bounded/v1" as const;

/**
 * The fixed instruction-frame marker every review-bounded prompt MUST contain verbatim. Chosen to
 * be a multi-word phrase (classifyTask scores multi-word keyword hits higher, see taxonomy.ts) that
 * is vanishingly unlikely to appear in an ordinary open-ended review ask.
 */
export const REVIEW_BOUNDED_CONTRACT_MARKER = "gille review-bounded contract v1";

/** Marker confirming the response contract; distinct from the request-side marker above. */
export const REVIEW_BOUNDED_SCHEMA_MARKER = "respond with only json matching the review-bounded schema";

export const REVIEW_BOUNDED_SUBTASK_KINDS = [
  "classify-findings",
  "detect-anti-pattern",
  "verify-output-shape",
] as const;
export type ReviewBoundedSubtaskKind = (typeof REVIEW_BOUNDED_SUBTASK_KINDS)[number];

/** Per-subtask-kind instruction-frame marker (`subtask kind: <kind>`), also multi-word. */
export function subtaskKindMarker(kind: ReviewBoundedSubtaskKind): string {
  return `subtask kind: ${kind}`;
}

/** Every literal keyword taxonomy.ts votes review-bounded on. Single source of truth (see header). */
export const REVIEW_BOUNDED_TAXONOMY_KEYWORDS: readonly string[] = [
  REVIEW_BOUNDED_CONTRACT_MARKER,
  REVIEW_BOUNDED_SCHEMA_MARKER,
  ...REVIEW_BOUNDED_SUBTASK_KINDS.map(subtaskKindMarker),
];

// ─── Input payloads (what the caller supplies to build a prompt) ─────────────────────

export interface FindingToClassify {
  id: string;
  claim: string;
  evidence?: string;
}

export interface ClassifyFindingsInput {
  diffExcerpt: string;
  findings: FindingToClassify[];
}

export interface DetectAntiPatternInput {
  patternId: string;
  patternDescription: string;
  codeExcerpt: string;
}

export interface VerifyOutputShapeInput {
  schemaDescription: string;
  candidateOutput: string;
}

// ─── Output schemas (exact, machine-checkable structured contracts) ──────────────────

const findingVerdictSchema = z.enum(["confirmed", "refuted", "needs-info"]);

const classifyFindingsOutputSchema = z.object({
  contract: z.literal(REVIEW_BOUNDED_CONTRACT_VERSION),
  subtask: z.literal("classify-findings"),
  classifications: z.array(
    z.object({
      id: z.string().min(1),
      verdict: findingVerdictSchema,
    })
  ),
});
export type ClassifyFindingsOutput = z.infer<typeof classifyFindingsOutputSchema>;

const detectAntiPatternOutputSchema = z.object({
  contract: z.literal(REVIEW_BOUNDED_CONTRACT_VERSION),
  subtask: z.literal("detect-anti-pattern"),
  pattern_id: z.string().min(1),
  detected: z.boolean(),
  locations: z.array(z.string()),
});
export type DetectAntiPatternOutput = z.infer<typeof detectAntiPatternOutputSchema>;

const verifyOutputShapeOutputSchema = z.object({
  contract: z.literal(REVIEW_BOUNDED_CONTRACT_VERSION),
  subtask: z.literal("verify-output-shape"),
  matches_schema: z.boolean(),
  violations: z.array(z.string()),
});
export type VerifyOutputShapeOutput = z.infer<typeof verifyOutputShapeOutputSchema>;

const reviewBoundedOutputSchema = z.discriminatedUnion("subtask", [
  classifyFindingsOutputSchema,
  detectAntiPatternOutputSchema,
  verifyOutputShapeOutputSchema,
]);
export type ReviewBoundedOutput = z.infer<typeof reviewBoundedOutputSchema>;

const SCHEMA_BY_KIND: Record<ReviewBoundedSubtaskKind, z.ZodTypeAny> = {
  "classify-findings": classifyFindingsOutputSchema,
  "detect-anti-pattern": detectAntiPatternOutputSchema,
  "verify-output-shape": verifyOutputShapeOutputSchema,
};

export type ReviewBoundedParseResult =
  | { ok: true; value: ReviewBoundedOutput }
  | { ok: false; error: string };

/**
 * Parse a local model's raw output against the review-bounded structured contract for `kind`.
 * Salvages a fenced/embedded JSON object exactly like verifier.ts's `jsonValid` (models routinely
 * wrap JSON in prose or a code fence despite instructions), then validates the EXACT schema —
 * wrong contract version, wrong subtask discriminator, or a missing/extra field all fail here,
 * before any grading judgment is applied.
 */
export function parseReviewBoundedOutput(
  kind: ReviewBoundedSubtaskKind,
  raw: string
): ReviewBoundedParseResult {
  const cleaned = extractCodeBlock(raw, ["json"]);
  let value: unknown;
  try {
    value = JSON.parse(cleaned);
  } catch {
    const m = cleaned.match(/[[{][\s\S]*[\]}]/);
    if (!m) return { ok: false, error: "output is not JSON" };
    try {
      value = JSON.parse(m[0]);
    } catch {
      return { ok: false, error: "output is not valid JSON" };
    }
  }
  const schema = SCHEMA_BY_KIND[kind];
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues.map((i) => `${i.path.join(".") || "$"}: ${i.message}`).join("; "),
    };
  }
  return { ok: true, value: parsed.data as ReviewBoundedOutput };
}

// ─── Prompt contract builders ─────────────────────────────────────────────────────────

function contractPreamble(kind: ReviewBoundedSubtaskKind): string {
  return [
    `${REVIEW_BOUNDED_CONTRACT_MARKER} — ${subtaskKindMarker(kind)}`,
    "",
    "This is a BOUNDED review subtask, not an open-ended code review. Answer ONLY the specific",
    "question below. Do not propose unrelated changes, do not restate the whole diff, and do not",
    "add prose outside the required JSON.",
    "",
  ].join("\n");
}

function schemaFooter(schemaLine: string): string {
  return [
    "",
    REVIEW_BOUNDED_SCHEMA_MARKER + ":",
    schemaLine,
    "Output ONLY the JSON object. No markdown fence, no commentary.",
  ].join("\n");
}

export function buildClassifyFindingsPrompt(input: ClassifyFindingsInput): string {
  const findingsBlock = input.findings
    .map((f) => `- id="${f.id}" claim="${f.claim}"${f.evidence ? ` evidence="${f.evidence}"` : ""}`)
    .join("\n");
  return [
    contractPreamble("classify-findings"),
    "The findings below were already identified by another reviewer. For EACH finding, classify it",
    'against the diff excerpt as "confirmed" (the diff genuinely has this issue), "refuted" (the',
    'finding is wrong/does not apply), or "needs-info" (cannot be determined from the excerpt).',
    "",
    "Diff excerpt:",
    input.diffExcerpt,
    "",
    "Findings to classify:",
    findingsBlock,
    schemaFooter(
      `{"contract":"${REVIEW_BOUNDED_CONTRACT_VERSION}","subtask":"classify-findings","classifications":[{"id":"<finding id>","verdict":"confirmed|refuted|needs-info"}]}`
    ),
  ].join("\n");
}

export function buildDetectAntiPatternPrompt(input: DetectAntiPatternInput): string {
  return [
    contractPreamble("detect-anti-pattern"),
    `Fixed anti-pattern (id="${input.patternId}"): ${input.patternDescription}`,
    "",
    "Code excerpt:",
    input.codeExcerpt,
    "",
    "Does this SPECIFIC anti-pattern appear in the excerpt? If yes, list the locations (line",
    "numbers, function names, or short quoted snippets) where it appears.",
    schemaFooter(
      `{"contract":"${REVIEW_BOUNDED_CONTRACT_VERSION}","subtask":"detect-anti-pattern","pattern_id":"${input.patternId}","detected":true|false,"locations":["..."]}`
    ),
  ].join("\n");
}

export function buildVerifyOutputShapePrompt(input: VerifyOutputShapeInput): string {
  return [
    contractPreamble("verify-output-shape"),
    "Required schema:",
    input.schemaDescription,
    "",
    "Candidate output to check:",
    input.candidateOutput,
    "",
    "Does the candidate output structurally match the required schema? List any violations",
    "(missing fields, wrong types, extra fields) — empty list if it matches.",
    schemaFooter(
      `{"contract":"${REVIEW_BOUNDED_CONTRACT_VERSION}","subtask":"verify-output-shape","matches_schema":true|false,"violations":["..."]}`
    ),
  ].join("\n");
}

export function buildReviewBoundedPrompt(
  kind: "classify-findings",
  input: ClassifyFindingsInput
): string;
export function buildReviewBoundedPrompt(
  kind: "detect-anti-pattern",
  input: DetectAntiPatternInput
): string;
export function buildReviewBoundedPrompt(
  kind: "verify-output-shape",
  input: VerifyOutputShapeInput
): string;
export function buildReviewBoundedPrompt(
  kind: ReviewBoundedSubtaskKind,
  input: ClassifyFindingsInput | DetectAntiPatternInput | VerifyOutputShapeInput
): string {
  switch (kind) {
    case "classify-findings":
      return buildClassifyFindingsPrompt(input as ClassifyFindingsInput);
    case "detect-anti-pattern":
      return buildDetectAntiPatternPrompt(input as DetectAntiPatternInput);
    case "verify-output-shape":
      return buildVerifyOutputShapePrompt(input as VerifyOutputShapeInput);
  }
}

// ─── Verifier: exact structured-output grading (machine-checkable, no frontier judge) ────

function jaccard(a: readonly string[], b: readonly string[]): number {
  const A = new Set(a.map((s) => s.trim().toLowerCase()).filter(Boolean));
  const B = new Set(b.map((s) => s.trim().toLowerCase()).filter(Boolean));
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  const union = A.size + B.size - inter;
  return union === 0 ? 1 : inter / union;
}

const PASS = (notes?: string): VerifyResult => ({ outcome: "pass", score: 1, notes });
const FAIL = (score: number, notes?: string): VerifyResult => ({ outcome: "fail", score, notes });
const PARTIAL = (score: number, notes?: string): VerifyResult => ({ outcome: "partial", score, notes });
const ERROR = (notes: string): VerifyResult => ({ outcome: "error", score: 0, errorClass: "parse", notes });

/**
 * Grade a review-bounded local output against the EXACT expected structured output for `kind`.
 * Deterministic and content-agnostic (compares typed fields, never prose) — this is what makes
 * "usefulness" scoreable automatically instead of needing a frontier judge in the loop (#74).
 */
export function reviewBoundedVerifier(
  kind: ReviewBoundedSubtaskKind,
  expected: ReviewBoundedOutput
): Verifier {
  return (raw: string): VerifyResult => {
    const parsed = parseReviewBoundedOutput(kind, stripThink(raw));
    if (!parsed.ok) return ERROR(parsed.error);
    const got = parsed.value;
    if (got.subtask !== expected.subtask) {
      return ERROR(`expected subtask ${expected.subtask}, got ${got.subtask}`);
    }

    if (got.subtask === "classify-findings" && expected.subtask === "classify-findings") {
      const wantById = new Map(expected.classifications.map((c) => [c.id, c.verdict]));
      const gotById = new Map(got.classifications.map((c) => [c.id, c.verdict]));
      const ids = [...wantById.keys()];
      if (ids.length === 0) return gotById.size === 0 ? PASS() : FAIL(0, "expected zero findings");
      const correct = ids.filter((id) => gotById.get(id) === wantById.get(id)).length;
      const score = correct / ids.length;
      const notes = `${correct}/${ids.length} findings classified correctly`;
      return score === 1 ? PASS(notes) : score > 0 ? PARTIAL(score, notes) : FAIL(0, notes);
    }

    if (got.subtask === "detect-anti-pattern" && expected.subtask === "detect-anti-pattern") {
      if (got.pattern_id !== expected.pattern_id) {
        return ERROR(`expected pattern_id ${expected.pattern_id}, got ${got.pattern_id}`);
      }
      const detectedMatch = got.detected === expected.detected;
      if (!detectedMatch) return FAIL(0, `expected detected=${expected.detected}, got ${got.detected}`);
      const locScore = jaccard(got.locations, expected.locations);
      const notes = `detected matches; locations overlap=${locScore.toFixed(2)}`;
      return locScore === 1 ? PASS(notes) : locScore > 0 ? PARTIAL(locScore, notes) : FAIL(0, notes);
    }

    if (got.subtask === "verify-output-shape" && expected.subtask === "verify-output-shape") {
      if (got.matches_schema !== expected.matches_schema) {
        return FAIL(0, `expected matches_schema=${expected.matches_schema}, got ${got.matches_schema}`);
      }
      const violScore = jaccard(got.violations, expected.violations);
      const notes = `matches_schema matches; violations overlap=${violScore.toFixed(2)}`;
      return violScore === 1 ? PASS(notes) : violScore > 0 ? PARTIAL(violScore, notes) : FAIL(0, notes);
    }

    // Unreachable: subtask equality is checked above for every known kind.
    return ERROR("unhandled review-bounded subtask combination");
  };
}

// ─── Preflight/capability advertisement (#74 acceptance criterion 4) ─────────────────

export type ReviewLaneEligibility = "local-advisory" | "frontier-only";

export interface ReviewLaneCapability {
  taskType: string;
  eligible: ReviewLaneEligibility;
  /** True while local output for this task type is advisory evidence only (never a merge gate). */
  advisoryOnly: boolean;
  /** True once an operator has explicitly promoted this task type past advisory-only. */
  promoted: boolean;
  subtaskKinds?: readonly ReviewBoundedSubtaskKind[];
  contractVersion?: string;
  reason: string;
}

/**
 * Pure capability lookup — no I/O, no model call — so an orchestrator (or a test) can ask "which
 * lane will taskType X get" before spending a `/delegate` round trip, and never waits on a local
 * review result for a task type that will always escalate (#74 acceptance criterion 4/5).
 */
export function reviewLaneCapability(
  rawTaskType: string,
  promotedAdvisoryTaskTypes: readonly string[]
): ReviewLaneCapability {
  // #80: resolve the caller's spelling exactly the way INGRESS will (trim, otherwise verbatim —
  // orchestrator.resolveTaskType, #155), so `?taskType=review-bounded%20` reports its real lane.
  // Deliberately NOT case-folded: this advertisement must describe the lane a caller actually gets.
  // `review-bounded` is not a taxonomy id, so #91's `policyTaskTypeIdentity` never canonicalizes it
  // and a case variant genuinely does fall through to the generic frontier-only answer below.
  // (For `code-review` both branches answer frontier-only anyway.) The conservative answer, and the
  // true one.
  const taskType = ingressTaskType(rawTaskType);
  if (taskType === REVIEW_BOUNDED_TASK_TYPE) {
    const promoted = isPromotedAdvisoryTaskType(taskType, promotedAdvisoryTaskTypes);
    return {
      taskType,
      eligible: "local-advisory",
      advisoryOnly: !promoted,
      promoted,
      subtaskKinds: REVIEW_BOUNDED_SUBTASK_KINDS,
      contractVersion: REVIEW_BOUNDED_CONTRACT_VERSION,
      reason: promoted
        ? "review-bounded has been explicitly promoted past advisory-only by an operator (measured pass rate, #74)"
        : "bounded review subtasks (classify-findings / detect-anti-pattern / verify-output-shape) may route " +
          "locally; output is advisory evidence only until promoted (#74)",
    };
  }
  if (taskType === "code-review") {
    return {
      taskType,
      eligible: "frontier-only",
      advisoryOnly: false,
      promoted: false,
      reason: "open-ended / whole-patch PR review remains frontier-only, unchanged by #74",
    };
  }
  return {
    taskType,
    eligible: "frontier-only",
    advisoryOnly: false,
    promoted: false,
    reason: "no local-eligible review lane is defined for this task type",
  };
}

/** The fixed set of lanes always surfaced by the `/v1/capabilities/review-lane` endpoint. */
export const REVIEW_LANE_KNOWN_TASK_TYPES = ["code-review", REVIEW_BOUNDED_TASK_TYPE] as const;

/** GET endpoint path for the review-lane capability preflight (#74 acceptance criterion 4). */
export const REVIEW_LANE_CAPABILITY_ENDPOINT = "/v1/capabilities/review-lane" as const;
