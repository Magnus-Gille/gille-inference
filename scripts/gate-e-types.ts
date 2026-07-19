/**
 * gate-e-types.ts — shared type contract for the Gate E local-as-orchestrator bake-off.
 *
 * Gate E (T5) asks: can a LOCAL model hold the *brain* seat — decompose a goal,
 * route/sequence sub-tasks, integrate results, and decide escalation — not merely
 * execute leaf sub-tasks? See docs/gate-de-evaluation-plan.md §"Gate E" and
 * docs/migration-go-no-go-plan.md §T5.
 *
 * The contract here is the seam between the three deliverables:
 *   gate-e-tasks.ts    — the 20 gold OrchTask specs (D1–D4, 5 each)
 *   gate-e-bench.ts    — the four arms (A0–A3); each emits an OrchTrace per task
 *   gate-e-score.ts    — Tier-1 deterministic metrics: OrchTrace + OrchTask → TaskScore
 *   gate-e-verdict.ts  — applies E1–E6 across an arm's TaskScore[] → GateEVerdict
 *
 * Everything is dependency-injected and JSON-serialisable so the scorer and verdict
 * are unit-testable OFFLINE (no model calls); inference enters only at the bench
 * composition root (the M5 / OpenRouter).
 */

import type { Source } from "../src/homeserver/deep-research-types.js";

/** The four orchestration-task families. Each isolates a different brain duty. */
export type OrchFamily = "D1" | "D2" | "D3" | "D4";

/** The bake-off arms. A0 = frontier reference; A1/A2/A3 = local-brain challengers. */
export type ArmId = "a0" | "a1" | "a2" | "a3";

export const ARM_LABELS: Record<ArmId, string> = {
  a0: "A0-frontier-reference",
  a1: "A1-local-deterministic",
  a2: "A2-local-agentic",
  a3: "A3-advisor",
};

// ─────────────────────────────────────────────────────────────────────────────
// Gold task specs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The machine-checkable scoring spec, tagged by family. Each variant carries
 * exactly what gate-e-score.ts needs to compute answer_pass deterministically
 * (no judge): see §3 Tier-1 of the plan.
 */
export type ScorerSpec =
  /** D1 — deep research: FRAMES gold answer, graded by frames-grade.looseAnswerMatch. */
  | { kind: "frames"; goldAnswer: string }
  /**
   * D2 — feature task: the brain plans a primitive→export→test decomposition (scored by
   * plan_coverage), but the deterministic answer anchor is tsGate on the single integrated
   * module it produces (tsc + the `harness` test code appended after the candidate).
   */
  | { kind: "tsGate"; harness: string }
  /**
   * D3 — pipeline-of-tools: exact top-3 set (order-insensitive) + a stage checklist.
   * `stageChecklist` are substrings that must each appear as a declared/run stage.
   */
  | { kind: "pipeline"; goldTop3: string[]; stageChecklist: string[] }
  /** D4 — ambiguous/recovery: gold final answer, matched like D1. */
  | { kind: "answer-match"; goldAnswer: string };

export interface OrchTask {
  /** Stable id, e.g. "D1-01". */
  id: string;
  family: OrchFamily;
  title: string;
  /** The goal handed to the brain. Correctness depends on between-leaf decisions. */
  prompt: string;
  /**
   * Gold decomposition: the required sub-tasks the brain must declare. Used for
   * plan_coverage = |declared ∩ required| / |required| (fuzzy keyword match).
   */
  requiredSubtasks: string[];
  /**
   * Sub-task labels that are GENUINE gaps (must escalate to frontier). D4 tasks
   * carry ≥1; other families carry []. Drives E4 (gap recall + over-escalation).
   * A label here should keyword-match the leaf's declared subtask/taskType.
   */
  gapLeaves: string[];
  scorer: ScorerSpec;
  /** D1: path to the frozen FRAMES corpus JSON (data/frames/corpus/<idx>.json). */
  corpusRef?: string;
  /** D3: the raw input the pipeline consumes (e.g. the access log), inline. */
  inputData?: string;
  /** Per-leaf token budget; defaults applied by the bench. */
  maxLeafTokens?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Execution trace (what each arm emits per task)
// ─────────────────────────────────────────────────────────────────────────────

/** One leaf delegation the brain made (or would have made). */
export interface LeafCall {
  /** The brain's own label for this leaf (free text; matched to gold sub-tasks). */
  subtask: string;
  /** Classified/declared leaf task type (e.g. "sql", "extract", "code-implement"). */
  taskType: string;
  /** Model that served the leaf, or "FRONTIER" when escalated. */
  modelId: string;
  /** Did this leaf go to frontier? (orchestrator.delegate → DelegationOutcome.escalate) */
  escalated: boolean;
  output: string;
  promptTokens: number;
  completionTokens: number;
}

/** A frontier advisor consultation (A3 only). Load-bearing for E6. */
export interface AdvisorCall {
  question: string;
  promptTokens: number;
  completionTokens: number;
  model: string;
}

/**
 * The structured trace an arm produces for one task. The scorer reads ONLY this
 * (+ the OrchTask gold), never the live models — so scoring is deterministic.
 */
export interface OrchTrace {
  taskId: string;
  arm: ArmId;
  brainModel: string;
  /** Declared sub-tasks parsed from the brain's plan output. */
  plan: string[];
  leafCalls: LeafCall[];
  /** Frontier advisor calls (A3); [] for A0/A1/A2. */
  advisorCalls: AdvisorCall[];
  /** The brain's final answer / deliverable text. */
  finalAnswer: string;
  /** D1 only: the synthesized report body (for citation + Tier-2 judge). */
  reportMarkdown?: string;
  /** D1 only: the sources the report cites (for verifyReportSentences). */
  reportSources?: Source[];
  /** D2 only: the produced candidate code block(s) to feed tsGate. */
  producedCode?: string;
  wallMs: number;
  /** Brain-seat token usage (excludes leaf + advisor tokens). */
  brainPromptTokens: number;
  brainCompletionTokens: number;
  /** Runtime signals the bench detected (feed the collapse classifier). */
  runtimeError?: string;
  timedOut?: boolean;
  /** D1: sources actually read by the brain (under-read collapse if < 60% corpus). */
  sourcesRead?: number;
  /** D1: total sources in the frozen corpus. */
  corpusSize?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scoring (Tier-1 deterministic metrics, per task per arm)
// ─────────────────────────────────────────────────────────────────────────────

/** Any non-null value fails the task outright (E2: zero-tolerance). */
export type CollapseFlag =
  | "degenerate-loop"
  | "blanking"
  | "under-read"
  | "timeout"
  | "error"
  | null;

export interface TaskScore {
  taskId: string;
  family: OrchFamily;
  arm: ArmId;
  /** Deterministic final-answer correctness (§3.1). */
  answerPass: 0 | 1;
  /** |declared ∩ required| / |required| (§3.2). */
  planCoverage: number;
  /**
   * Did the brain escalate every genuine gap leaf? null when the task has no gap
   * leaf (only D4 carries them). Drives E4 recall (§3.3).
   */
  gapEscalated: boolean | null;
  /**
   * Per-task non-gap escalation rate (escalatedNonGapLeafCount / nonGapLeafCount).
   * Kept as a per-task DIAGNOSTIC; the E4 gate aggregates at the LEAF level across the
   * arm (sum/sum) so a task with many leaves can't be diluted by many tiny clean tasks.
   */
  overEscalationRate: number;
  /** Non-gap leaves in this task (E4 denominator contribution). */
  nonGapLeafCount: number;
  /** Non-gap leaves this task sent to frontier (E4 numerator contribution). */
  escalatedNonGapLeafCount: number;
  /** D1: report-sentence citation precision (§3.4); null for D2/D3/D4. */
  integrationScore: number | null;
  /** Any collapse → task FAIL (§3.5). */
  collapse: CollapseFlag;
  /**
   * Frontier tokens this task consumed that are frontier REGARDLESS of brain tier:
   * advisor calls (A3) + any escalated leaf. The brain's own tokens are NOT counted
   * here (the brain may be local); the verdict adds brainTokens for the frontier-brain
   * reference (A0) when computing the E6 denominator.
   */
  frontierTokens: number;
  /** The brain-seat tokens (prompt+completion). Frontier iff the arm's brain is frontier. */
  brainTokens: number;
  /** All tokens this task consumed (brain + leaf + advisor), for E6 share. */
  totalTokens: number;
  /** Free-text scorer notes (why answer failed, which collapse, etc.). */
  notes?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Verdict (E1–E6 aggregation across an arm's 20 tasks)
// ─────────────────────────────────────────────────────────────────────────────

/** Blind-judge dimension means (from dr-judge-hybrid), 1–5 scale. Optional input. */
export interface JudgeScores {
  planQuality?: number;
  integrationCoherence?: number;
  citationQuality?: number;
  overall: number;
  /** Lowest single dimension mean, for the "no dimension < acceptable floor" check. */
  minDimension?: number;
}

export interface ArmAggregate {
  arm: ArmId;
  n: number;
  answerPassRate: number;
  collapseCount: number;
  collapseTaskIds: string[];
  meanPlanCoverage: number;
  minPlanCoverage: number;
  minPlanCoverageTaskId: string;
  /** Fraction of D4 gap leaves escalated (E4 recall numerator/denominator). */
  d4GapRecall: number;
  d4GapLeafCount: number;
  /** Mean over-escalation across non-gap leaves (E4 laziness). */
  overEscalationRate: number;
  /** Sum of brain-tier-independent frontier tokens (advisor + escalated leaf). */
  frontierTokens: number;
  /** Sum of brain-seat tokens (frontier iff this arm's brain is frontier — A0). */
  brainTokens: number;
  totalTokens: number;
  judge?: JudgeScores;
}

export interface CriterionResult {
  id: "E1" | "E2" | "E3" | "E4" | "E5" | "E6";
  label: string;
  pass: boolean | null; // null = not evaluable (e.g. E5 with no judge data, E6 on non-A3)
  detail: string;
}

export interface GateEVerdict {
  arm: ArmId;
  reference: ArmAggregate; // A0
  candidate: ArmAggregate;
  criteria: CriterionResult[];
  /** True only if every evaluable criterion passes (E6 required for A3). */
  pass: boolean;
  recommendation: string;
}
