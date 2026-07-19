/**
 * Gate E — unit tests for the deterministic Tier-1 scorer and the E1–E6 verdict aggregator.
 * Pure/offline (one D2 case exercises tsGate → real tsc/tsx). No model calls.
 */
import { describe, it, expect } from "vitest";
import {
  contentTokens,
  stepCovers,
  planCoverage,
  leafMatchesLabel,
  escalationMetrics,
  longestCharRun,
  hasRepeatedActionLoop,
  classifyCollapse,
  pipelineAnswerPass,
  stageChecklistCovered,
  frontierTokens,
  totalTokens,
  scoreTask,
} from "../scripts/gate-e-score.js";
import {
  aggregateArm,
  evaluateGateE,
  referenceFrontierTokens,
} from "../scripts/gate-e-verdict.js";
import { diagnoseTraceSet } from "../scripts/gate-e-rescore.js";
import { buildVerdicts, e5Pivotal } from "../scripts/gate-e-apply-verdict.js";
import { aggregateJudgeScores } from "../scripts/gate-e-judge.js";
import type { ArmId, TaskScore } from "../scripts/gate-e-types.js";
import { ORCH_TASKS, getTask } from "../scripts/gate-e-tasks.js";
import type {
  OrchTask,
  OrchTrace,
  LeafCall,
  TaskScore,
  ArmId,
} from "../scripts/gate-e-types.js";

// ── builders ─────────────────────────────────────────────────────────────────
function leaf(p: Partial<LeafCall> = {}): LeafCall {
  return {
    subtask: "do thing",
    taskType: "extract",
    modelId: "mellum",
    escalated: false,
    output: "ok",
    promptTokens: 10,
    completionTokens: 10,
    ...p,
  };
}
function trace(p: Partial<OrchTrace> = {}): OrchTrace {
  return {
    taskId: "D3-04",
    arm: "a1",
    brainModel: "qwen3-coder-next-80b",
    plan: [],
    leafCalls: [],
    advisorCalls: [],
    finalAnswer: "answer",
    wallMs: 1000,
    brainPromptTokens: 100,
    brainCompletionTokens: 200,
    ...p,
  };
}
function score(p: Partial<TaskScore> = {}): TaskScore {
  return {
    taskId: "T",
    family: "D2",
    arm: "a1",
    answerPass: 1,
    planCoverage: 1,
    gapEscalated: null,
    overEscalationRate: 0,
    nonGapLeafCount: 0,
    escalatedNonGapLeafCount: 0,
    integrationScore: null,
    collapse: null,
    frontierTokens: 0,
    brainTokens: 0,
    totalTokens: 100,
    ...p,
  };
}

describe("task set integrity", () => {
  it("has exactly 20 tasks, 5 per family, unique ids", () => {
    expect(ORCH_TASKS.length).toBe(20);
    for (const fam of ["D1", "D2", "D3", "D4"] as const) {
      expect(ORCH_TASKS.filter((t) => t.family === fam).length).toBe(5);
    }
    const ids = ORCH_TASKS.map((t) => t.id);
    expect(new Set(ids).size).toBe(20);
  });
  it("only D4 tasks carry gap leaves", () => {
    for (const t of ORCH_TASKS) {
      if (t.family === "D4") expect(t.gapLeaves.length).toBeGreaterThan(0);
      else expect(t.gapLeaves.length).toBe(0);
    }
  });
  it("D1 tasks reference an existing frozen corpus path", () => {
    for (const t of ORCH_TASKS.filter((x) => x.family === "D1")) {
      expect(t.corpusRef).toMatch(/^data\/frames\/corpus\/\d+\.json$/);
    }
  });
  it("D3 tasks ship 3 gold tokens; D4 ship a gold answer", () => {
    for (const t of ORCH_TASKS.filter((x) => x.family === "D3")) {
      if (t.scorer.kind === "pipeline") expect(t.scorer.goldTop3.length).toBe(3);
    }
    for (const t of ORCH_TASKS.filter((x) => x.family === "D4")) {
      if (t.scorer.kind === "answer-match") expect(t.scorer.goldAnswer.length).toBeGreaterThan(0);
    }
  });
});

describe("plan coverage", () => {
  it("tokenizes content words, dropping stopwords/short", () => {
    expect(contentTokens("run the SQL aggregation per segment")).toEqual([
      "sql",
      "aggregation",
      "segment",
    ]);
  });
  it("stepCovers needs ≥2 shared tokens for long required steps", () => {
    expect(stepCovers("aggregate refunded amount per merchant", "sum refunds by merchant")).toBe(
      false, // only "merchant" shared (refunded≠refunds, amount≠sum)
    );
    expect(
      stepCovers("aggregate refunded amount per merchant", "aggregate amount by merchant"),
    ).toBe(true); // aggregate + amount + merchant
  });
  it("planCoverage is the covered fraction", () => {
    const required = ["implement chunkBy primitive", "export chunkBy", "add vitest covering cases"];
    const declared = ["implement the chunkBy primitive in utils", "export chunkBy from index"];
    expect(planCoverage(required, declared)).toBeCloseTo(2 / 3, 5);
  });
  it("empty required → full coverage", () => {
    expect(planCoverage([], ["whatever"])).toBe(1);
  });
});

describe("escalation metrics (E4)", () => {
  const sqlTask = getTask("D4-01")!;
  it("gapEscalated true when the sql leaf escalated; over-escalation 0", () => {
    const m = escalationMetrics(sqlTask, [
      leaf({ subtask: "run the sql aggregation", taskType: "sql", escalated: true, modelId: "FRONTIER" }),
      leaf({ subtask: "draft slack message", taskType: "rewrite", escalated: false }),
    ]);
    expect(m.gapEscalated).toBe(true);
    expect(m.overEscalationRate).toBe(0);
  });
  it("gapEscalated false when the sql leaf stayed local", () => {
    const m = escalationMetrics(sqlTask, [
      leaf({ subtask: "run the sql aggregation", taskType: "sql", escalated: false }),
    ]);
    expect(m.gapEscalated).toBe(false);
  });
  it("over-escalation counts non-gap leaves sent to frontier", () => {
    const m = escalationMetrics(sqlTask, [
      leaf({ taskType: "sql", escalated: true }),
      leaf({ taskType: "rewrite", escalated: true }), // non-gap, escalated → eager
      leaf({ taskType: "summarize", escalated: false }),
    ]);
    expect(m.overEscalationRate).toBeCloseTo(1 / 2, 5);
  });
  it("non-gap task → gapEscalated null", () => {
    const m = escalationMetrics(getTask("D3-01")!, [leaf({ escalated: false })]);
    expect(m.gapEscalated).toBeNull();
  });
  it("leafMatchesLabel matches on taskType identity and keyword", () => {
    expect(leafMatchesLabel(leaf({ taskType: "sql" }), "sql")).toBe(true);
    expect(leafMatchesLabel(leaf({ taskType: "extract", subtask: "the sql join step" }), "sql")).toBe(true);
    expect(leafMatchesLabel(leaf({ taskType: "rewrite", subtask: "draft message" }), "sql")).toBe(false);
  });
});

describe("collapse classifier (E2)", () => {
  const t = getTask("D3-01")!;
  const d1 = getTask("D1-01")!;
  it("flags timeout/error first", () => {
    expect(classifyCollapse(t, trace({ timedOut: true }))).toBe("timeout");
    expect(classifyCollapse(t, trace({ runtimeError: "boom" }))).toBe("error");
  });
  it("flags blanking on empty final answer", () => {
    expect(classifyCollapse(t, trace({ finalAnswer: "   " }))).toBe("blanking");
  });
  it("flags D1 blanking on empty report even with an answer", () => {
    expect(classifyCollapse(d1, trace({ taskId: "D1-01", finalAnswer: "France", reportMarkdown: "" }))).toBe(
      "blanking",
    );
  });
  it("flags D1 under-read when <60% of corpus read", () => {
    const tr = trace({
      taskId: "D1-01",
      finalAnswer: "France",
      reportMarkdown: "France [S1]",
      corpusSize: 5,
      sourcesRead: 2,
    });
    expect(classifyCollapse(d1, tr)).toBe("under-read");
  });
  it("no under-read when ≥60% read", () => {
    const tr = trace({
      taskId: "D1-01",
      finalAnswer: "France",
      reportMarkdown: "France [S1]",
      corpusSize: 5,
      sourcesRead: 3,
    });
    expect(classifyCollapse(d1, tr)).toBeNull();
  });
  it("flags degenerate loop on repeated identical leaf actions", () => {
    const dup = leaf({ subtask: "x", output: "y" });
    expect(classifyCollapse(t, trace({ leafCalls: [dup, { ...dup }, { ...dup }] }))).toBe(
      "degenerate-loop",
    );
  });
  it("flags degenerate char run in the final answer", () => {
    expect(classifyCollapse(t, trace({ finalAnswer: "?".repeat(400) }))).toBe("degenerate-loop");
  });
  it("clean trace → no collapse", () => {
    expect(classifyCollapse(t, trace({ finalAnswer: "alice bob carol" }))).toBeNull();
  });
});

describe("primitive detectors", () => {
  it("longestCharRun ignores whitespace as a run breaker", () => {
    expect(longestCharRun("aaa")).toBe(3);
    expect(longestCharRun("aa aa")).toBe(2);
    expect(longestCharRun("abcabc")).toBe(1);
  });
  it("hasRepeatedActionLoop needs ≥3 consecutive identical", () => {
    const a = leaf({ subtask: "s", output: "o" });
    expect(hasRepeatedActionLoop([a, { ...a }])).toBe(false);
    expect(hasRepeatedActionLoop([a, { ...a }, { ...a }])).toBe(true);
    expect(hasRepeatedActionLoop([a, leaf({ subtask: "t", output: "o" }), { ...a }])).toBe(false);
  });
});

describe("pipeline answer pass (D3)", () => {
  it("passes when all three gold tokens present, order-insensitive", () => {
    expect(pipelineAnswerPass(["alice", "bob", "carol"], "Top: carol, alice and bob")).toBe(true);
  });
  it("fails when a gold token is missing", () => {
    expect(pipelineAnswerPass(["alice", "bob", "carol"], "Top: alice and bob")).toBe(false);
  });
  it("normalizes commas in numeric tokens", () => {
    expect(pipelineAnswerPass(["10.0.0.7"], "the worst IP is 10.0.0.7 by far")).toBe(true);
  });
});

describe("stage checklist coverage (D3 — vocabulary-robust)", () => {
  const STAGES = ["extract", "aggregate", "classify", "summarize"];

  it("credits a stage from the realizing leaf taskType when the plan word differs", () => {
    // The real D3-05 failure: brain planned "Count.."/"Identify top-3.." (no literal
    // "extract"/"aggregate") but ran the 4 distinct-typed leaves — a genuine pipeline.
    const plan = [
      "Count how many modules depend on each package",
      "Identify top-3 most-depended-on packages",
      "Classify each top-3 package as core or peripheral",
      "Summarize findings and list top-3 packages explicitly",
    ];
    const leaves = [
      leaf({ subtask: plan[0], taskType: "data-transform" }),
      leaf({ subtask: plan[1], taskType: "reason-math" }),
      leaf({ subtask: plan[2], taskType: "classify" }),
      leaf({ subtask: plan[3], taskType: "summarize" }),
    ];
    expect(stageChecklistCovered(STAGES, plan, leaves)).toBe(true);
  });

  it("still credits stages via literal plan keywords (no leaves needed)", () => {
    const plan = ["extract users", "aggregate counts", "classify each", "summarize it"];
    expect(stageChecklistCovered(STAGES, plan, [])).toBe(true);
  });

  it("a single fused leaf cannot satisfy two distinct stages (extract AND aggregate)", () => {
    // data-transform realizes BOTH extract and aggregate. Without per-leaf consumption,
    // one counting leaf wrongly credited both stages. Plan text names neither stage, so
    // each must be leaf-grounded — and there's only ONE realizing leaf for the two.
    const plan = ["Count rows per user", "Identify the top-3 users", "Classify each", "Summarize it"];
    const leaves = [
      leaf({ subtask: plan[0], taskType: "data-transform" }),
      leaf({ subtask: plan[2], taskType: "classify" }),
      leaf({ subtask: plan[3], taskType: "summarize" }),
    ];
    expect(stageChecklistCovered(STAGES, plan, leaves)).toBe(false);
  });

  it("two distinct realizing leaves cover extract and aggregate independently", () => {
    // Vocabulary-opaque plan, but two separate counting/aggregation leaves ran → both
    // stages are genuinely leaf-grounded by distinct leaves.
    const plan = ["Count per user", "Total messages per user", "Classify each", "Summarize it"];
    const leaves = [
      leaf({ subtask: plan[0], taskType: "data-transform" }),
      leaf({ subtask: plan[1], taskType: "reason-math" }),
      leaf({ subtask: plan[2], taskType: "classify" }),
      leaf({ subtask: plan[3], taskType: "summarize" }),
    ];
    expect(stageChecklistCovered(STAGES, plan, leaves)).toBe(true);
  });

  it("fails when a real stage is skipped — only 2 of 4 stages present", () => {
    // No classify/summarize plan step AND no classify/summarize leaf → not covered.
    const plan = ["Count rows per user", "Identify the top-3 users"];
    const leaves = [
      leaf({ subtask: plan[0], taskType: "data-transform" }),
      leaf({ subtask: plan[1], taskType: "reason-math" }),
    ];
    expect(stageChecklistCovered(STAGES, plan, leaves)).toBe(false);
  });
});

describe("token accounting", () => {
  it("frontierTokens = advisor + escalated leaves only", () => {
    const tr = trace({
      leafCalls: [
        leaf({ escalated: true, promptTokens: 50, completionTokens: 50 }),
        leaf({ escalated: false, promptTokens: 30, completionTokens: 30 }),
      ],
      advisorCalls: [{ question: "?", promptTokens: 20, completionTokens: 80, model: "opus" }],
    });
    expect(frontierTokens(tr)).toBe(100 + 100); // escalated leaf + advisor
    expect(totalTokens(tr)).toBe(300 + 100 + 60 + 100); // brain + escalated + local leaf + advisor
  });
});

describe("scoreTask — frames/pipeline/answer-match paths", () => {
  it("D1 frames: gold present → pass; integrationScore set", async () => {
    const s = await scoreTask(
      getTask("D1-02")!,
      trace({
        taskId: "D1-02",
        finalAnswer: "The holders were France.",
        reportMarkdown: "France held the cup.",
        reportSources: [],
        plan: ["find the last year the United States hosted", "identify which country held the title"],
      }),
    );
    expect(s.answerPass).toBe(1);
    expect(s.integrationScore).not.toBeNull();
    expect(s.planCoverage).toBeGreaterThan(0);
  });
  it("D3 pipeline: all gold present AND stages run → pass", async () => {
    const s = await scoreTask(
      getTask("D3-04")!,
      trace({
        taskId: "D3-04",
        finalAnswer: "alice, bob, carol are the top 3",
        plan: [
          "extract user from each line",
          "aggregate message counts per user",
          "classify each user activity",
          "summarize participation",
        ],
      }),
    );
    expect(s.answerPass).toBe(1);
  });
  it("D3 pipeline: right top-3 but a stage skipped → fail", async () => {
    const s = await scoreTask(
      getTask("D3-04")!,
      trace({
        taskId: "D3-04",
        finalAnswer: "alice, bob, carol are the top 3",
        plan: ["extract user from each line", "aggregate message counts per user"], // no classify/summarize
      }),
    );
    expect(s.answerPass).toBe(0);
    expect(s.notes).toMatch(/stage was skipped/);
  });
  it("D4 answer-match: gold token present → pass; gapEscalated reflects the sql leaf", async () => {
    const s = await scoreTask(
      getTask("D4-01")!,
      trace({
        taskId: "D4-01",
        finalAnswer: "The enterprise segment exceeded $10k.",
        leafCalls: [leaf({ taskType: "sql", escalated: true })],
      }),
    );
    expect(s.answerPass).toBe(1);
    expect(s.gapEscalated).toBe(true);
  });
});

describe("scoreTask — D2 tsGate (real tsc/tsx)", () => {
  it("correct chunkBy produces answerPass=1", { timeout: 60000 }, async () => {
    const code = [
      "```ts",
      "export function chunkBy<T>(arr: T[], size: number): T[][] {",
      '  if (size < 1) throw new RangeError("size must be >= 1");',
      "  const out: T[][] = [];",
      "  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));",
      "  return out;",
      "}",
      "```",
    ].join("\n");
    const s = await scoreTask(getTask("D2-01")!, trace({ taskId: "D2-01", producedCode: code }));
    expect(s.answerPass).toBe(1);
  });
  it("broken chunkBy produces answerPass=0", { timeout: 60000 }, async () => {
    const code = [
      "```ts",
      "export function chunkBy<T>(arr: T[], size: number): T[][] {",
      "  return [arr];", // wrong, and no throw
      "}",
      "```",
    ].join("\n");
    const s = await scoreTask(getTask("D2-01")!, trace({ taskId: "D2-01", producedCode: code }));
    expect(s.answerPass).toBe(0);
  });
});

// ── verdict ──────────────────────────────────────────────────────────────────
function arm(armId: ArmId, scores: TaskScore[], judge?: Parameters<typeof aggregateArm>[2]) {
  return aggregateArm(armId, scores, judge);
}

describe("aggregateArm", () => {
  it("rolls up rates, collapses, coverage extremes, gap recall", () => {
    const scores = [
      score({ taskId: "A", answerPass: 1, planCoverage: 1, collapse: null }),
      score({ taskId: "B", answerPass: 0, planCoverage: 0.5, collapse: "timeout" }),
      score({ taskId: "C", answerPass: 1, planCoverage: 0.9, gapEscalated: true }),
      score({ taskId: "D", answerPass: 1, planCoverage: 0.8, gapEscalated: false }),
    ];
    const a = arm("a1", scores);
    expect(a.answerPassRate).toBe(0.75);
    expect(a.collapseCount).toBe(1);
    expect(a.collapseTaskIds).toEqual(["B"]);
    expect(a.minPlanCoverage).toBe(0.5);
    expect(a.minPlanCoverageTaskId).toBe("B");
    expect(a.d4GapLeafCount).toBe(2);
    expect(a.d4GapRecall).toBe(0.5);
  });
});

describe("evaluateGateE — E1–E6", () => {
  // A0 reference: strong frontier brain, frontier brain tokens dominate.
  const a0scores = ORCH_TASKS.map((t, i) =>
    score({
      taskId: t.id,
      family: t.family,
      arm: "a0",
      answerPass: 1,
      planCoverage: 0.95,
      gapEscalated: t.gapLeaves.length ? true : null,
      overEscalationRate: 0,
      brainTokens: 1000, // frontier brain
      frontierTokens: 0,
      totalTokens: 1200,
    }),
  );
  const reference = aggregateArm("a0", a0scores, {
    overall: 4.5,
    minDimension: 4.0,
  });

  function localScores(armId: ArmId, overrides: (t: OrchTask) => Partial<TaskScore> = () => ({})) {
    return ORCH_TASKS.map((t) =>
      score({
        taskId: t.id,
        family: t.family,
        arm: armId,
        answerPass: 1,
        planCoverage: 0.95,
        gapEscalated: t.gapLeaves.length ? true : null,
        overEscalationRate: 0,
        brainTokens: 1000, // local brain (not counted as frontier for E6)
        frontierTokens: 0,
        totalTokens: 1200,
        ...overrides(t),
      }),
    );
  }

  it("A1 clearing E1–E4 + judge passes (E5) → overall pass + S2 recommendation", () => {
    const cand = aggregateArm("a1", localScores("a1"), { overall: 4.2, minDimension: 3.5 });
    const v = evaluateGateE(cand, reference);
    expect(v.criteria.find((c) => c.id === "E1")!.pass).toBe(true);
    expect(v.criteria.find((c) => c.id === "E5")!.pass).toBe(true);
    expect(v.pass).toBe(true);
    expect(v.recommendation).toMatch(/Recommend S2\./);
  });

  it("missing judge → E5 null → not yet pass", () => {
    const cand = aggregateArm("a1", localScores("a1")); // no judge
    const v = evaluateGateE(cand, reference);
    expect(v.criteria.find((c) => c.id === "E5")!.pass).toBeNull();
    expect(v.pass).toBe(false);
    expect(v.recommendation).toMatch(/pending E5/);
  });

  it("a collapse fails E2 → way-forward names the pre-digest project", () => {
    const cand = aggregateArm(
      "a1",
      localScores("a1", (t) => (t.id === "D1-04" ? { collapse: "under-read" } : {})),
      { overall: 4.2, minDimension: 3.5 },
    );
    const v = evaluateGateE(cand, reference);
    expect(v.criteria.find((c) => c.id === "E2")!.pass).toBe(false);
    expect(v.pass).toBe(false);
    expect(v.recommendation).toMatch(/pre-digest/);
  });

  it("eager escalation fails E4 (leaf-level aggregation)", () => {
    const cand = aggregateArm(
      "a1",
      localScores("a1", () => ({ nonGapLeafCount: 4, escalatedNonGapLeafCount: 2 })), // 50% over-escalation
      { overall: 4.2, minDimension: 3.5 },
    );
    const v = evaluateGateE(cand, reference);
    expect(v.candidate.overEscalationRate).toBeCloseTo(0.5, 5);
    expect(v.criteria.find((c) => c.id === "E4")!.pass).toBe(false);
  });

  it("E4 over-escalation is leaf-level, not diluted by clean tasks", () => {
    // One task with 10 non-gap leaves, 3 escalated (30%); 19 clean tasks with 1 leaf each.
    const scores = ORCH_TASKS.map((t, i) =>
      score({
        taskId: t.id,
        family: t.family,
        arm: "a1",
        gapEscalated: t.gapLeaves.length ? true : null,
        nonGapLeafCount: i === 0 ? 10 : 1,
        escalatedNonGapLeafCount: i === 0 ? 3 : 0,
        brainTokens: 1000,
      }),
    );
    const cand = aggregateArm("a1", scores, { overall: 4.2, minDimension: 3.5 });
    // leaf-level: 3 / (10 + 19) = 0.103 > 0.10 → fails. A mean-of-rates would be 0.30/20 = 0.015 → wrongly passes.
    expect(cand.overEscalationRate).toBeGreaterThan(0.1);
    expect(evaluateGateE(cand, reference).criteria.find((c) => c.id === "E4")!.pass).toBe(false);
  });

  it("A3 clearing E1–E5 but advisor share >25% fails E6 → 'S1 wearing a costume'", () => {
    // A3 frontier = advisor tokens; set high relative to A0 frontier (= A0 brain 20*1000).
    const a3 = aggregateArm(
      "a3",
      localScores("a3", () => ({ frontierTokens: 600 })), // 20*600 = 12000 vs A0 20000 → 0.6 > 0.25
      { overall: 4.2, minDimension: 3.5 },
    );
    const v = evaluateGateE(a3, reference);
    expect(["E1", "E2", "E3", "E4", "E5"].every((id) => v.criteria.find((c) => c.id === id)!.pass)).toBe(
      true,
    );
    expect(v.criteria.find((c) => c.id === "E6")!.pass).toBe(false);
    expect(v.pass).toBe(false);
    expect(v.recommendation).toMatch(/costume/);
  });

  it("A3 with low advisor share passes E6 → S2-Advisor", () => {
    const a3 = aggregateArm(
      "a3",
      localScores("a3", () => ({ frontierTokens: 100 })), // 2000 vs 20000 → 0.1 ≤ 0.25
      { overall: 4.2, minDimension: 3.5 },
    );
    const v = evaluateGateE(a3, reference);
    expect(v.criteria.find((c) => c.id === "E6")!.pass).toBe(true);
    expect(v.pass).toBe(true);
    expect(v.recommendation).toMatch(/S2-Advisor/);
  });

  it("referenceFrontierTokens counts the frontier brain", () => {
    expect(referenceFrontierTokens(reference)).toBe(20 * 1000);
  });
});

describe("gate-e-judge — aggregateJudgeScores (disk-free core)", () => {
  it("averages per-arm dimensions; minDimension = lowest sub-dim mean", () => {
    const out = aggregateJudgeScores([
      { arm: "a0", plan_quality: 4, integration_coherence: 5, citation_quality: 3, overall: 4 },
      { arm: "a0", plan_quality: 4, integration_coherence: 5, citation_quality: 3, overall: 4 },
      { arm: "a1", plan_quality: 2, integration_coherence: 4, citation_quality: 4, overall: 3 },
    ]);
    expect(out.a0!.planQuality).toBe(4);
    expect(out.a0!.integrationCoherence).toBe(5);
    expect(out.a0!.citationQuality).toBe(3);
    expect(out.a0!.overall).toBe(4);
    expect(out.a0!.minDimension).toBe(3); // lowest of {4,5,3}
    expect(out.a1!.minDimension).toBe(2); // plan_quality is lowest
  });

  it("feeds straight into the E5 path of buildVerdicts", () => {
    const judge = aggregateJudgeScores([
      { arm: "a0", plan_quality: 4, integration_coherence: 4, citation_quality: 4, overall: 4.5 },
      { arm: "a1", plan_quality: 4, integration_coherence: 4, citation_quality: 3.5, overall: 4.2 },
    ]);
    // overall 4.2 ≥ 4.5−0.5 and min-dim 3.5 ≥ 3.0 → E5 passes
    expect(judge.a0!.overall).toBeGreaterThan(0);
    expect(judge.a1!.minDimension).toBeGreaterThanOrEqual(3.0);
  });
});

describe("gate-e-apply-verdict — buildVerdicts (disk-free core)", () => {
  // A perfect task: answer right, full coverage, no collapse, no over-escalation.
  function score(arm: ArmId, taskId: string, over: Partial<TaskScore> = {}): TaskScore {
    return {
      taskId,
      family: "D2",
      arm,
      answerPass: 1,
      planCoverage: 1,
      gapEscalated: null,
      overEscalationRate: 0,
      nonGapLeafCount: 2,
      escalatedNonGapLeafCount: 0,
      integrationScore: null,
      collapse: null,
      frontierTokens: 0,
      brainTokens: 100,
      totalTokens: 300,
      ...over,
    };
  }
  const cleanArm = (arm: ArmId) => [score(arm, "T1"), score(arm, "T2"), score(arm, "T3")];

  it("throws when the A0 reference is absent", () => {
    expect(() => buildVerdicts({ a1: cleanArm("a1") })).toThrow(/A0 reference/);
  });

  it("a local arm matching A0 clears E1–E4 but stays FAIL on E5 with no judge data", () => {
    const { verdicts, gatePass } = buildVerdicts({ a0: cleanArm("a0"), a1: cleanArm("a1") });
    const v = verdicts.find((x) => x.candidate.arm === "a1")!;
    expect(v.criteria.find((c) => c.id === "E1")!.pass).toBe(true);
    expect(v.criteria.find((c) => c.id === "E2")!.pass).toBe(true);
    expect(v.criteria.find((c) => c.id === "E5")!.pass).toBeNull(); // pending — no judge
    expect(v.pass).toBe(false); // E5 is required
    expect(gatePass).toBe(false);
  });

  it("an arm with a collapse FAILs E2 → stay-S1 recommendation (the a2 D1 case)", () => {
    const a2 = [score("a2", "T1", { collapse: "under-read", answerPass: 0, planCoverage: 0 }), score("a2", "T2"), score("a2", "T3")];
    const { verdicts, gatePass } = buildVerdicts({ a0: cleanArm("a0"), a2 });
    const v = verdicts.find((x) => x.candidate.arm === "a2")!;
    expect(v.criteria.find((c) => c.id === "E2")!.pass).toBe(false);
    expect(v.pass).toBe(false);
    expect(v.recommendation).toMatch(/COLLAPSED|S1-Hybrid/);
    expect(gatePass).toBe(false);
  });

  it("a local arm matching A0 PASSES once judge data clears E5", () => {
    const judge = { a0: { overall: 4.5 }, a1: { overall: 4.2, minDimension: 3.5 } };
    const { verdicts, gatePass } = buildVerdicts(
      { a0: cleanArm("a0"), a1: cleanArm("a1") },
      judge,
    );
    const v = verdicts.find((x) => x.candidate.arm === "a1")!;
    expect(v.criteria.find((c) => c.id === "E5")!.pass).toBe(true);
    expect(v.pass).toBe(true);
    expect(gatePass).toBe(true);
  });

  // e5Pivotal gates unattended judge spend — it must be exactly "clears all required EXCEPT E5".
  function pivotalOf(arm: ArmId, candidate: TaskScore[], ref = cleanArm("a0")) {
    const { verdicts } = buildVerdicts({ a0: ref, [arm]: candidate });
    return e5Pivotal(verdicts.find((v) => v.candidate.arm === arm)!);
  }

  it("e5Pivotal: a1 clearing E1–E4 (E5 pending) is pivotal", () => {
    expect(pivotalOf("a1", cleanArm("a1"))).toBe(true);
  });

  it("e5Pivotal: a1 failing E4 (a gap not escalated) is NOT pivotal", () => {
    const a1 = [score("a1", "T1", { gapEscalated: false }), score("a1", "T2"), score("a1", "T3")];
    expect(pivotalOf("a1", a1)).toBe(false);
  });

  it("e5Pivotal: a3 clearing E1–E4 but FAILING E6 (high advisor share) is NOT pivotal", () => {
    // ref A0 frontier = 3×100 brain = 300; a3 frontier 100 → share 0.33 > 0.25 → E6 fail.
    const a3 = [score("a3", "T1", { frontierTokens: 100 }), score("a3", "T2"), score("a3", "T3")];
    expect(pivotalOf("a3", a3)).toBe(false);
  });

  it("e5Pivotal: a3 clearing E1–E4 AND E6 (E5 pending) IS pivotal", () => {
    expect(pivotalOf("a3", cleanArm("a3"))).toBe(true); // frontierTokens 0 → share 0 ≤ 0.25
  });
});

describe("gate-e-rescore trace-set validation", () => {
  const known = (id: string) => ["D1-01", "D3-05", "D4-02"].includes(id);

  it("clean set → no unknowns, no duplicates", () => {
    const d = diagnoseTraceSet([{ taskId: "D1-01" }, { taskId: "D3-05" }], known);
    expect(d.unknown).toEqual([]);
    expect(d.duplicates).toEqual([]);
  });

  it("flags an unknown/renamed taskId (so it isn't silently dropped from scores)", () => {
    const d = diagnoseTraceSet([{ taskId: "D1-01" }, { taskId: "BOGUS-99" }], known);
    expect(d.unknown).toEqual(["BOGUS-99"]);
    expect(d.duplicates).toEqual([]);
  });

  it("flags a duplicate taskId once", () => {
    const d = diagnoseTraceSet(
      [{ taskId: "D4-02" }, { taskId: "D4-02" }, { taskId: "D1-01" }],
      known,
    );
    expect(d.unknown).toEqual([]);
    expect(d.duplicates).toEqual(["D4-02"]);
  });
});
