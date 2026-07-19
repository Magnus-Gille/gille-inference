/**
 * gate-e-score.ts — Tier-1 deterministic orchestration metrics (the trust anchor).
 *
 * Pure, offline, no model calls (tsGate runs tsc/tsx locally for D2). Reads ONLY the
 * gold OrchTask + the arm's OrchTrace → a TaskScore. See docs/gate-de-evaluation-plan.md
 * §3 "Scoring — Tier 1". The project's hard-won atomic-sentence evaluation finding
 * is that the deterministic metric and the judge DIVERGE — so Tier 1 anchors the verdict in
 * machine-checkable truth; the blind judge (dr-judge-hybrid) only adjudicates the residual.
 */

import { looseAnswerMatch } from "./frames-grade.js";
import { normalizeForMatch } from "./frames-evidence.js";
import { verifyReportSentences } from "../src/homeserver/citation-verifier.js";
import { tsGate } from "../src/homeserver/verifier.js";
import type { OrchTask, OrchTrace, TaskScore, CollapseFlag, LeafCall } from "./gate-e-types.js";

const STOPWORDS = new Set([
  "the", "and", "for", "with", "into", "from", "that", "this", "each", "per", "its",
  "a", "an", "of", "to", "in", "on", "as", "or", "by", "is", "are", "be", "it", "at",
  "run", "add", "find", "name", "naming", "draft", "write", "report", "summary",
]);

/** Lowercase content tokens (len≥3, non-stopword), commas/punct stripped. */
export function contentTokens(s: string): string[] {
  return normalizeForMatch(s)
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

/**
 * Does a declared plan step "cover" a required sub-task? Covered when they share enough
 * distinctive content tokens. Threshold scales with the required step's token count so
 * short steps need fewer matches, long ones need ≥2.
 */
export function stepCovers(required: string, declared: string): boolean {
  const rTok = new Set(contentTokens(required));
  const dTok = new Set(contentTokens(declared));
  if (rTok.size === 0) return false;
  let shared = 0;
  for (const t of rTok) if (dTok.has(t)) shared++;
  const need = rTok.size <= 2 ? 1 : 2;
  return shared >= need;
}

/** plan_coverage = |required covered by ≥1 declared step| / |required|. */
export function planCoverage(required: string[], declared: string[]): number {
  if (required.length === 0) return 1;
  let covered = 0;
  for (const r of required) {
    if (declared.some((d) => stepCovers(r, d))) covered++;
  }
  return covered / required.length;
}

/** Does a leaf call correspond to a gap-leaf label? (keyword match on subtask/taskType) */
export function leafMatchesLabel(leaf: LeafCall, label: string): boolean {
  const lTok = new Set([...contentTokens(leaf.subtask), ...contentTokens(leaf.taskType)]);
  // The taskType itself is the strongest signal (e.g. "sql").
  if (normalizeForMatch(leaf.taskType) === normalizeForMatch(label)) return true;
  const labelTok = contentTokens(label);
  if (labelTok.length === 0) return normalizeForMatch(leaf.taskType) === normalizeForMatch(label);
  return labelTok.some((t) => lTok.has(t));
}

export interface EscalationMetrics {
  gapEscalated: boolean | null;
  /** Per-task non-gap escalation rate (diagnostic; the gate aggregates leaf-level). */
  overEscalationRate: number;
  nonGapLeafCount: number;
  escalatedNonGapLeafCount: number;
}

/**
 * E4 inputs. gapEscalated = every gap leaf was escalated (null if the task has none).
 * over_escalation is reported both as a per-task rate (diagnostic) AND as the raw
 * leaf counts, so the verdict can aggregate at the LEAF level (sum/sum) — preventing a
 * many-leaf over-escalating task from being diluted by many tiny clean tasks.
 */
export function escalationMetrics(task: OrchTask, leafCalls: LeafCall[]): EscalationMetrics {
  const gapLabels = task.gapLeaves;
  const isGapLeaf = (leaf: LeafCall) => gapLabels.some((g) => leafMatchesLabel(leaf, g));

  let gapEscalated: boolean | null = null;
  if (gapLabels.length > 0) {
    // Each gap label must be matched by ≥1 escalated leaf.
    gapEscalated = gapLabels.every((g) =>
      leafCalls.some((leaf) => leafMatchesLabel(leaf, g) && leaf.escalated),
    );
  }

  const nonGap = leafCalls.filter((leaf) => !isGapLeaf(leaf));
  const escalatedNonGap = nonGap.filter((leaf) => leaf.escalated).length;
  const overEscalationRate = nonGap.length === 0 ? 0 : escalatedNonGap / nonGap.length;

  return {
    gapEscalated,
    overEscalationRate,
    nonGapLeafCount: nonGap.length,
    escalatedNonGapLeafCount: escalatedNonGap,
  };
}

const DEGENERATE_CHAR_RUN = 400; // matches HOMESERVER_DEGENERACY_RUN_THRESHOLD default

/** Longest run of identical non-whitespace characters in `s`. */
export function longestCharRun(s: string): number {
  let max = 0;
  let cur = 0;
  let prev = "";
  for (const ch of s) {
    if (/\s/.test(ch)) {
      cur = 0;
      prev = "";
      continue;
    }
    if (ch === prev) cur++;
    else cur = 1;
    prev = ch;
    if (cur > max) max = cur;
  }
  return max;
}

/** ≥3 consecutive identical (subtask+output) leaf actions = a stuck loop. */
export function hasRepeatedActionLoop(leafCalls: LeafCall[], run = 3): boolean {
  let streak = 1;
  for (let i = 1; i < leafCalls.length; i++) {
    const a = leafCalls[i - 1];
    const b = leafCalls[i];
    if (a.subtask === b.subtask && a.output === b.output) {
      streak++;
      if (streak >= run) return true;
    } else {
      streak = 1;
    }
  }
  return false;
}

/**
 * Collapse classifier (§3.5) — any non-null → task FAIL (E2, zero tolerance).
 * Precedence: timeout → error → blanking → under-read → degenerate-loop.
 */
export function classifyCollapse(task: OrchTask, trace: OrchTrace): CollapseFlag {
  if (trace.timedOut) return "timeout";
  if (trace.runtimeError) return "error";

  const answerEmpty = trace.finalAnswer.trim().length === 0;
  const reportEmpty =
    task.family === "D1" && (trace.reportMarkdown ?? "").trim().length === 0;
  if (answerEmpty || reportEmpty) return "blanking";

  if (task.family === "D1" && trace.corpusSize && trace.corpusSize > 0) {
    const read = trace.sourcesRead ?? 0;
    if (read / trace.corpusSize < 0.6) return "under-read";
  }

  if (
    hasRepeatedActionLoop(trace.leafCalls) ||
    longestCharRun(trace.finalAnswer) >= DEGENERATE_CHAR_RUN
  ) {
    return "degenerate-loop";
  }

  return null;
}

/**
 * D3: every gold top-3 token present in the final answer (order-insensitive).
 * NOTE (known limitation): this is presence-based, so a brain that *dumps every*
 * candidate (e.g. all IPs) would pass trivially. That gaming is caught by the other
 * signals — it tanks plan_coverage and the Tier-2 judge — and is symmetric across arms.
 * The deterministic anchor stays simple on purpose (the prior "metric vs judge" lesson).
 */
export function pipelineAnswerPass(goldTop3: string[], finalAnswer: string): boolean {
  const hay = normalizeForMatch(finalAnswer);
  return goldTop3.every((g) => hay.includes(normalizeForMatch(g)));
}

/**
 * Each canonical pipeline stage → the leaf taskTypes that REALIZE it. A brain rarely
 * names its plan steps "extract"/"aggregate" — it says "Count …" / "Identify top-3 …" —
 * but the executed leaf carries a taskType that pins down what the step actually did.
 * Crediting a stage from its realizing leaf type makes the gate robust to plan vocabulary
 * while keeping it honest: a SKIPPED stage runs no leaf of that type, so it stays uncovered.
 */
const STAGE_TASK_TYPES: Record<string, string[]> = {
  extract: ["data-transform", "extract", "qa-factual"],
  aggregate: ["data-transform", "reason-math", "sql"],
  classify: ["classify"],
  summarize: ["summarize", "rewrite"],
};

/**
 * D3 stage coverage: every declared pipeline stage actually ran. A stage counts as
 * covered if (a) a declared plan step / leaf subtask keyword-matches it (plan-level
 * decomposition), OR (b) a distinct, as-yet-unconsumed leaf of a realizing taskType
 * executed it (vocabulary-robust — see STAGE_TASK_TYPES).
 *
 * The (b) leaf is CONSUMED so a single fused leaf can't satisfy two distinct stages:
 * `data-transform` realizes both extract and aggregate, but one counting leaf must not
 * credit both — distinct stages need distinct realizing leaves. This still stops a
 * "right top-3 but skipped classify/summarize" trace from passing on the answer alone:
 * a skipped stage has neither a matching plan step nor an unconsumed realizing leaf.
 * (Greedy first-fit assignment is sound for these short fixed checklists, where the only
 * type shared across stages is `data-transform`; a stage falls back to its non-shared
 * realizing types when the shared leaf is already taken.)
 */
export function stageChecklistCovered(
  stageChecklist: string[],
  plan: string[],
  leafCalls: LeafCall[],
): boolean {
  if (stageChecklist.length === 0) return true;
  const declared = [...plan, ...leafCalls.map((l) => `${l.subtask} ${l.taskType}`)];
  const consumed = new Array<boolean>(leafCalls.length).fill(false);
  return stageChecklist.every((stage) => {
    if (declared.some((d) => stepCovers(stage, d))) return true;
    const realizing = STAGE_TASK_TYPES[normalizeForMatch(stage)] ?? [];
    const idx = leafCalls.findIndex(
      (l, i) => !consumed[i] && realizing.includes(normalizeForMatch(l.taskType)),
    );
    if (idx === -1) return false;
    consumed[idx] = true;
    return true;
  });
}

/** Frontier tokens this task consumed: advisor calls + any leaf that escalated. */
export function frontierTokens(trace: OrchTrace): number {
  const advisor = trace.advisorCalls.reduce(
    (n, c) => n + c.promptTokens + c.completionTokens,
    0,
  );
  const escalatedLeaf = trace.leafCalls
    .filter((l) => l.escalated)
    .reduce((n, l) => n + l.promptTokens + l.completionTokens, 0);
  return advisor + escalatedLeaf;
}

export function totalTokens(trace: OrchTrace): number {
  const leaf = trace.leafCalls.reduce((n, l) => n + l.promptTokens + l.completionTokens, 0);
  const advisor = trace.advisorCalls.reduce(
    (n, c) => n + c.promptTokens + c.completionTokens,
    0,
  );
  return trace.brainPromptTokens + trace.brainCompletionTokens + leaf + advisor;
}

/** D2 answer correctness: run tsGate (tsc+tsx) on the produced code. Async. */
async function tsGateAnswerPass(
  harness: string,
  producedCode: string,
): Promise<{ pass: 0 | 1; note: string }> {
  const verifier = tsGate({ harness, typecheck: true });
  const res = await verifier(producedCode);
  return {
    pass: res.outcome === "pass" ? 1 : 0,
    note: `tsGate=${res.outcome} (score ${res.score})${res.notes ? `: ${res.notes}` : ""}`,
  };
}

/** Score one task's trace into the Tier-1 metrics. Async (D2 runs tsGate). */
export async function scoreTask(task: OrchTask, trace: OrchTrace): Promise<TaskScore> {
  const collapse = classifyCollapse(task, trace);
  const { gapEscalated, overEscalationRate, nonGapLeafCount, escalatedNonGapLeafCount } =
    escalationMetrics(task, trace.leafCalls);
  const coverage = planCoverage(task.requiredSubtasks, trace.plan);

  let answerPass: 0 | 1 = 0;
  let integrationScore: number | null = null;
  const notes: string[] = [];

  switch (task.scorer.kind) {
    case "frames":
    case "answer-match": {
      answerPass = looseAnswerMatch(task.scorer.goldAnswer, trace.finalAnswer) ? 1 : 0;
      if (task.family === "D1") {
        const check = verifyReportSentences({
          reportBody: trace.reportMarkdown ?? "",
          sources: trace.reportSources ?? [],
        });
        integrationScore = check.precision;
      }
      break;
    }
    case "pipeline": {
      // Answer must carry the correct top-3 AND every declared stage must have run —
      // a "right answer, skipped classify/summarize" trace does not pass (E1 integrity).
      const answerOk = pipelineAnswerPass(task.scorer.goldTop3, trace.finalAnswer);
      const stagesOk = stageChecklistCovered(task.scorer.stageChecklist, trace.plan, trace.leafCalls);
      answerPass = answerOk && stagesOk ? 1 : 0;
      if (answerOk && !stagesOk) notes.push("top-3 correct but a declared pipeline stage was skipped");
      break;
    }
    case "tsGate": {
      const r = await tsGateAnswerPass(task.scorer.harness, trace.producedCode ?? "");
      answerPass = r.pass;
      notes.push(r.note);
      break;
    }
  }

  return {
    taskId: task.id,
    family: task.family,
    arm: trace.arm,
    answerPass,
    planCoverage: coverage,
    gapEscalated,
    overEscalationRate,
    nonGapLeafCount,
    escalatedNonGapLeafCount,
    integrationScore,
    collapse,
    frontierTokens: frontierTokens(trace),
    brainTokens: trace.brainPromptTokens + trace.brainCompletionTokens,
    totalTokens: totalTokens(trace),
    notes: notes.length ? notes.join("; ") : undefined,
  };
}

/** Score a whole arm's traces (one per task). Tasks are matched by id. */
export async function scoreArm(
  tasks: OrchTask[],
  traces: OrchTrace[],
): Promise<TaskScore[]> {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const out: TaskScore[] = [];
  for (const trace of traces) {
    const task = byId.get(trace.taskId);
    if (!task) continue;
    out.push(await scoreTask(task, trace));
  }
  return out;
}
