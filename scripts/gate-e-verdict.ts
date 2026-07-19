/**
 * gate-e-verdict.ts — apply the E1–E6 pass criteria to an arm's TaskScore[] and emit a
 * PASS/FAIL verdict + S1/S2 recommendation. Pure, offline, deterministic.
 *
 * Gate E PASSES (unlock S2) iff a single LOCAL-brain arm clears all of E1–E5 (and E6 for
 * the Advisor arm A3), with the frontier arm A0 as the reference ceiling. See
 * docs/gate-de-evaluation-plan.md §4 and §"Verdict logic".
 */

import type {
  ArmAggregate,
  ArmId,
  CriterionResult,
  GateEVerdict,
  JudgeScores,
  TaskScore,
} from "./gate-e-types.js";
import { ARM_LABELS } from "./gate-e-types.js";

// Thresholds (single source of truth — mirror the §4 table).
export const E1_ANSWER_DELTA = 0.1; // candidate ≥ A0 − 0.10
export const E3_MEAN_COVERAGE = 0.85;
export const E3_MIN_COVERAGE = 0.6;
export const E4_OVER_ESCALATION = 0.1;
export const E5_JUDGE_DELTA = 0.5; // candidate ≥ A0 − 0.5
export const E5_ACCEPTABLE_FLOOR = 3.0; // "acceptable" on the 5-pt rubric
export const E6_FRONTIER_SHARE = 0.25; // A3 frontier ≤ 25% of A0's frontier

function round(n: number, dp = 3): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/** Aggregate one arm's per-task scores into the arm-level rollup. */
export function aggregateArm(
  arm: ArmId,
  scores: TaskScore[],
  judge?: JudgeScores,
): ArmAggregate {
  const n = scores.length;
  const answerPassRate = n === 0 ? 0 : scores.filter((s) => s.answerPass === 1).length / n;

  const collapses = scores.filter((s) => s.collapse !== null);
  const collapseTaskIds = collapses.map((s) => s.taskId);

  const coverages = scores.map((s) => s.planCoverage);
  const meanPlanCoverage = n === 0 ? 0 : coverages.reduce((a, b) => a + b, 0) / n;
  let minPlanCoverage = 1;
  let minPlanCoverageTaskId = "";
  for (const s of scores) {
    if (s.planCoverage < minPlanCoverage) {
      minPlanCoverage = s.planCoverage;
      minPlanCoverageTaskId = s.taskId;
    }
  }
  if (n === 0) minPlanCoverage = 0;

  // E4: gap recall is over tasks that carry a gap leaf (gapEscalated !== null).
  const gapTasks = scores.filter((s) => s.gapEscalated !== null);
  const d4GapLeafCount = gapTasks.length;
  const d4GapRecall =
    d4GapLeafCount === 0 ? 1 : gapTasks.filter((s) => s.gapEscalated === true).length / d4GapLeafCount;

  // Over-escalation: aggregated at the LEAF level (sum escalated non-gap / sum non-gap)
  // — NOT a mean of per-task rates, so a many-leaf over-escalating task can't be diluted
  // by many tiny clean ones (E4 integrity).
  const totalNonGapLeaves = scores.reduce((a, s) => a + s.nonGapLeafCount, 0);
  const totalEscalatedNonGap = scores.reduce((a, s) => a + s.escalatedNonGapLeafCount, 0);
  const overEscalationRate = totalNonGapLeaves === 0 ? 0 : totalEscalatedNonGap / totalNonGapLeaves;

  const frontierTokens = scores.reduce((a, s) => a + s.frontierTokens, 0);
  const brainTokens = scores.reduce((a, s) => a + s.brainTokens, 0);
  const totalTokens = scores.reduce((a, s) => a + s.totalTokens, 0);

  return {
    arm,
    n,
    answerPassRate: round(answerPassRate),
    collapseCount: collapses.length,
    collapseTaskIds,
    meanPlanCoverage: round(meanPlanCoverage),
    minPlanCoverage: round(minPlanCoverage),
    minPlanCoverageTaskId,
    d4GapRecall: round(d4GapRecall),
    d4GapLeafCount,
    overEscalationRate: round(overEscalationRate),
    frontierTokens,
    brainTokens,
    totalTokens,
    judge,
  };
}

/** The frontier-token spend used as the E6 denominator: brain (if frontier) + advisor + escalated. */
export function referenceFrontierTokens(reference: ArmAggregate): number {
  // A0's brain is frontier, so its brain tokens count as frontier spend.
  return reference.brainTokens + reference.frontierTokens;
}

/**
 * Apply E1–E6 to a candidate arm against the A0 reference. E5 requires judge data
 * (null/unevaluable without it). E6 applies only to A3.
 */
export function evaluateGateE(
  candidate: ArmAggregate,
  reference: ArmAggregate,
): GateEVerdict {
  const criteria: CriterionResult[] = [];

  // E1 — answer correctness vs frontier
  const e1Pass = candidate.answerPassRate >= reference.answerPassRate - E1_ANSWER_DELTA;
  criteria.push({
    id: "E1",
    label: "Answer correctness ≥ A0 − 0.10",
    pass: e1Pass,
    detail: `candidate ${candidate.answerPassRate} vs A0 ${reference.answerPassRate} (floor ${round(
      reference.answerPassRate - E1_ANSWER_DELTA,
    )})`,
  });

  // E2 — no collapse
  const e2Pass = candidate.collapseCount === 0;
  criteria.push({
    id: "E2",
    label: "Zero collapse tasks",
    pass: e2Pass,
    detail:
      candidate.collapseCount === 0
        ? "no collapses"
        : `${candidate.collapseCount} collapse(s): ${candidate.collapseTaskIds.join(", ")}`,
  });

  // E3 — plan coverage
  const e3Pass =
    candidate.meanPlanCoverage >= E3_MEAN_COVERAGE && candidate.minPlanCoverage >= E3_MIN_COVERAGE;
  criteria.push({
    id: "E3",
    label: "Plan coverage mean ≥ 0.85, no task < 0.6",
    pass: e3Pass,
    detail: `mean ${candidate.meanPlanCoverage}, min ${candidate.minPlanCoverage} (${candidate.minPlanCoverageTaskId})`,
  });

  // E4 — escalation judgment (lazy not eager)
  const e4Pass = candidate.d4GapRecall >= 1 && candidate.overEscalationRate <= E4_OVER_ESCALATION;
  criteria.push({
    id: "E4",
    label: "Gap recall 100%, over-escalation ≤ 0.10",
    pass: e4Pass,
    detail: `gap recall ${candidate.d4GapRecall} (${candidate.d4GapLeafCount} gap tasks), over-escalation ${candidate.overEscalationRate}`,
  });

  // E5 — judge quality delta (needs judge data on BOTH arms)
  let e5Pass: boolean | null = null;
  let e5Detail = "no judge data (run dr-judge-hybrid on the saved reports)";
  if (candidate.judge && reference.judge) {
    const deltaOk = candidate.judge.overall >= reference.judge.overall - E5_JUDGE_DELTA;
    const floorOk = (candidate.judge.minDimension ?? candidate.judge.overall) >= E5_ACCEPTABLE_FLOOR;
    e5Pass = deltaOk && floorOk;
    e5Detail = `overall ${candidate.judge.overall} vs A0 ${reference.judge.overall} (floor ${round(
      reference.judge.overall - E5_JUDGE_DELTA,
    )}); min-dim ${candidate.judge.minDimension ?? "n/a"} (floor ${E5_ACCEPTABLE_FLOOR})`;
  }
  criteria.push({ id: "E5", label: "Judge mean ≥ A0 − 0.5, no dim < acceptable", pass: e5Pass, detail: e5Detail });

  // E6 — economic gate (A3 only)
  let e6Pass: boolean | null = null;
  let e6Detail = "n/a (E6 applies to the Advisor arm A3 only)";
  if (candidate.arm === "a3") {
    const refFrontier = referenceFrontierTokens(reference);
    const share = refFrontier === 0 ? 0 : candidate.frontierTokens / refFrontier;
    e6Pass = share <= E6_FRONTIER_SHARE;
    e6Detail = `A3 frontier ${candidate.frontierTokens} tok / A0 frontier ${refFrontier} tok = ${round(
      share,
    )} (ceiling ${E6_FRONTIER_SHARE})`;
  }
  criteria.push({ id: "E6", label: "A3 frontier share ≤ 25% of A0", pass: e6Pass, detail: e6Detail });

  // Pass = all REQUIRED criteria true. A3 requires E6; others require E1–E5.
  const required: CriterionResult["id"][] =
    candidate.arm === "a3" ? ["E1", "E2", "E3", "E4", "E5", "E6"] : ["E1", "E2", "E3", "E4", "E5"];
  const pass = required.every((id) => criteria.find((c) => c.id === id)?.pass === true);

  return {
    arm: candidate.arm,
    reference,
    candidate,
    criteria,
    pass,
    recommendation: recommend(candidate, criteria, pass),
  };
}

function recommend(candidate: ArmAggregate, criteria: CriterionResult[], pass: boolean): string {
  const by = (id: string) => criteria.find((c) => c.id === id);
  const label = ARM_LABELS[candidate.arm];

  if (pass && candidate.arm === "a1") {
    return `${label} cleared E1–E5 — S2 is viable with a FRONTIER-FREE brain. The standing "local can't orchestrate" finding is overturned for the harness-scaffolded case. Recommend S2.`;
  }
  if (pass && candidate.arm === "a3") {
    return `${label} cleared E1–E6 — S2 viable via the Advisor pattern (local holds the loop, frontier is a bounded on-demand advisor). Recommend S2-Advisor.`;
  }
  if (pass) {
    return `${label} cleared the required criteria — S2 viable on this arm. Recommend S2.`;
  }

  // Failures → name the way-forward per §4.
  if (by("E2")?.pass === false) {
    return `${label} COLLAPSED on ${candidate.collapseCount} task(s) (${candidate.collapseTaskIds.join(
      ", ",
    )}) — E2 zero-tolerance failed. S2 blocked; way-forward = the T5 context pre-digest mini-project. Stay S1-Hybrid.`;
  }
  if (candidate.arm === "a3" && by("E6")?.pass === false && ["E1", "E2", "E3", "E4", "E5"].every((id) => by(id)?.pass !== false)) {
    return `${label} cleared E1–E5 but FAILED E6 (advisor frontier share too high) — the quality came from the frontier it leaned on; it is S1 wearing a costume. Stay S1-Hybrid.`;
  }
  const failed = criteria.filter((c) => c.pass === false).map((c) => c.id);
  const pending = criteria.filter((c) => c.pass === null).map((c) => c.id);
  const parts = [`failed ${failed.join(", ") || "none"}`];
  if (pending.length) parts.push(`pending ${pending.join(", ")}`);
  return `${label} did NOT clear Gate E (${parts.join("; ")}). Frontier stays the brain; S1-Hybrid is the steady state.`;
}
