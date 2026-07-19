/**
 * gate-e-bench.test.ts — OFFLINE smoke tests for the Gate E bench harness.
 *
 * Injects synthetic brain + leaf executor into runOrchestration (the injection seam)
 * and asserts the returned OrchTrace has the expected shape and that feeding it to
 * scoreTask (from gate-e-score) produces the correct Tier-1 metrics.
 *
 * NO network calls. NO model calls. Deterministic and fast.
 */
import { describe, it, expect } from "vitest";
import {
  runOrchestration,
  makeSyntheticBrain,
  makeSyntheticLeafExecutor,
  makeRealLeafExecutor,
  makeCorpusLeafExecutor,
  bestWindow,
  coerceEscalate,
  parsePlan,
} from "../scripts/gate-e-bench.js";
import type { CorpusReadState } from "../scripts/gate-e-bench.js";
import { scoreTask } from "../scripts/gate-e-score.js";
import { getTask } from "../scripts/gate-e-tasks.js";
import type { OrchTrace, OrchOptions, LeafCall } from "../scripts/gate-e-types.js";
import type { ChatFn } from "../src/homeserver/deep-research-types.js";
import type { LeafExecutorFn } from "../scripts/gate-e-bench.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function synOpts(arm: OrchOptions["arm"] = "a1"): OrchOptions {
  return {
    arm,
    brainModel: "synthetic",
    escalationModel: "synthetic-frontier",
    advisorK: 3,
  };
}

// ─── parsePlan ────────────────────────────────────────────────────────────────

describe("parsePlan", () => {
  it("parses a clean JSON array", () => {
    const text = JSON.stringify([
      { label: "extract data", taskType: "extract", input: "do it", escalate: false },
    ]);
    const result = parsePlan(text);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(1);
    expect(result![0]!.label).toBe("extract data");
    expect(result![0]!.taskType).toBe("extract");
  });

  it("strips ```json fences", () => {
    const text = "Here is the plan:\n```json\n[{\"label\":\"step\",\"taskType\":\"qa-factual\",\"input\":\"x\"}]\n```\n";
    const result = parsePlan(text);
    expect(result).not.toBeNull();
    expect(result![0]!.label).toBe("step");
  });

  it("strips <think> blocks before parsing", () => {
    const text = "<think>Reasoning...</think>[{\"label\":\"go\",\"taskType\":\"summarize\",\"input\":\"do\"}]";
    const result = parsePlan(text);
    expect(result).not.toBeNull();
    expect(result![0]!.label).toBe("go");
  });

  it("returns null when no JSON array present", () => {
    expect(parsePlan("I will do: step 1, step 2, step 3.")).toBeNull();
    expect(parsePlan("{}")).toBeNull();
    expect(parsePlan("")).toBeNull();
  });

  it("returns null for an empty array", () => {
    expect(parsePlan("[]")).toBeNull();
  });

  it("tolerates extra prose around the array", () => {
    const text = "Sure! Here's the plan: [{\"label\":\"do thing\",\"taskType\":\"extract\",\"input\":\"go\"}] That's it.";
    expect(parsePlan(text)).not.toBeNull();
  });

  it("coerces missing fields to defaults", () => {
    const text = JSON.stringify([{ label: "only label" }]);
    const result = parsePlan(text);
    expect(result).not.toBeNull();
    expect(result![0]!.taskType).toBe("qa-factual"); // default
  });

  it("parses a fenced array whose string value contains a ```ts fence (Opus D2-03 regression)", () => {
    // Opus wrapped its plan in ```json and the input value instructed "return code in a ```ts
    // block". The old non-greedy fence regex matched the FIRST ``` — the one INSIDE the JSON
    // string — and truncated the array so it never parsed. Balanced extraction must ignore
    // brackets/fences inside string literals.
    const text =
      "```json\n[\n" +
      '  {\n' +
      '    "label": "Implement parseDuration",\n' +
      '    "taskType": "code-implement",\n' +
      '    "input": "Parse \\"1h30m\\" into seconds. Return only code in a single ```ts block.",\n' +
      '    "escalate": false\n' +
      "  }\n]\n```";
    const result = parsePlan(text);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(1);
    expect(result![0]!.taskType).toBe("code-implement");
    expect(result![0]!.input).toContain("```ts");
  });

  it("ignores a closing bracket inside a string value", () => {
    // A ']' inside a string must not terminate the array early.
    const text = '[{"label":"a]b","taskType":"extract","input":"x]y","escalate":false}]';
    const result = parsePlan(text);
    expect(result).not.toBeNull();
    expect(result![0]!.label).toBe("a]b");
  });

  it("skips a bracketed prose aside before the real array", () => {
    // First '[' is prose ("[draft]") that isn't valid JSON — must scan forward to the array.
    const text = 'Here is [draft] then the plan:\n```json\n[{"label":"go","taskType":"summarize","input":"x"}]\n```';
    const result = parsePlan(text);
    expect(result).not.toBeNull();
    expect(result![0]!.label).toBe("go");
  });

  it("skips an empty array and finds the real non-empty one", () => {
    const text = 'note: [] \n [{"label":"real","taskType":"extract","input":"x"}]';
    const result = parsePlan(text);
    expect(result).not.toBeNull();
    expect(result![0]!.label).toBe("real");
  });

  it("handles escaped backslashes in a string value", () => {
    const text = '[{"label":"a","taskType":"code-implement","input":"path C:\\\\x\\\\y"}]';
    const result = parsePlan(text);
    expect(result).not.toBeNull();
    expect(result![0]!.input).toBe("path C:\\x\\y");
  });
});

// ─── Plan-parse failure path ───────────────────────────────────────────────────

describe("runOrchestration — plan-parse failure", () => {
  it("sets runtimeError and returns empty plan when brain emits non-JSON", async () => {
    const task = getTask("D3-01")!;
    const badBrain: ChatFn = async () => ({
      text: "I cannot plan this task.",
      promptTokens: 10,
      completionTokens: 5,
      model: "synthetic",
    });
    const noopLeaf: LeafExecutorFn = async (subtask, taskType) => ({
      subtask,
      taskType,
      modelId: "synthetic",
      escalated: false,
      output: "",
      promptTokens: 0,
      completionTokens: 0,
    });

    const trace = await runOrchestration(task, badBrain, noopLeaf, synOpts());
    expect(trace.plan).toHaveLength(0);
    expect(trace.runtimeError).toMatch(/plan-parse-failure/);
    expect(trace.finalAnswer).toBe("");
  });
});

// ─── D3 task (pipeline family) ────────────────────────────────────────────────

describe("runOrchestration — D3 task (D3-04 top users)", () => {
  const task = getTask("D3-04")!;

  it("synthetic brain produces a trace with correct plan length and finalAnswer", async () => {
    const brain = makeSyntheticBrain(task);
    const leafExec = makeSyntheticLeafExecutor(task);

    const trace = await runOrchestration(task, brain, leafExec, synOpts());

    // Plan should cover the required subtasks
    expect(trace.plan.length).toBeGreaterThanOrEqual(task.requiredSubtasks.length);
    // LeafCalls should exist (one per plan step)
    expect(trace.leafCalls.length).toBeGreaterThan(0);
    expect(trace.leafCalls.length).toBe(trace.plan.length);
    // finalAnswer should contain the gold tokens (alice, bob, carol)
    expect(trace.finalAnswer.toLowerCase()).toMatch(/alice|bob|carol/);
    // D3 — no advisor calls
    expect(trace.advisorCalls).toHaveLength(0);
    // wallMs is non-negative (a synthetic run can complete within one millisecond)
    expect(trace.wallMs).toBeGreaterThanOrEqual(0);
  });

  it("scoreTask on a passing synthetic trace yields answerPass=1", async () => {
    const brain = makeSyntheticBrain(task);
    const leafExec = makeSyntheticLeafExecutor(task);
    const trace = await runOrchestration(task, brain, leafExec, synOpts());
    const s = await scoreTask(task, trace);
    expect(s.answerPass).toBe(1);
    expect(s.collapse).toBeNull();
  });
});

// ─── D4 task (ambiguous/recovery family) ──────────────────────────────────────

describe("runOrchestration — D4 task (D4-01 sql gap)", () => {
  const task = getTask("D4-01")!;

  it("synthetic leaf marks the sql gap leaf as escalated", async () => {
    const brain = makeSyntheticBrain(task);
    const leafExec = makeSyntheticLeafExecutor(task);
    const trace = await runOrchestration(task, brain, leafExec, synOpts());

    // The D4-01 task has gapLeaves=["sql"]; the first plan step has taskType="sql"
    const sqlLeaf = trace.leafCalls.find((lc) => lc.taskType === "sql" || lc.subtask.toLowerCase().includes("sql"));
    expect(sqlLeaf).toBeDefined();
    expect(sqlLeaf!.escalated).toBe(true);
    expect(sqlLeaf!.modelId).toBe("synthetic-frontier");
  });

  it("scoreTask yields gapEscalated=true when sql leaf is escalated", async () => {
    const brain = makeSyntheticBrain(task);
    const leafExec = makeSyntheticLeafExecutor(task);
    const trace = await runOrchestration(task, brain, leafExec, synOpts());
    const s = await scoreTask(task, trace);
    expect(s.gapEscalated).toBe(true);
    expect(s.answerPass).toBe(1);
  });
});

// ─── Token accounting ─────────────────────────────────────────────────────────

describe("token accounting", () => {
  it("brain tokens are accumulated from plan + integrate calls only", async () => {
    const task = getTask("D3-01")!;
    const brain = makeSyntheticBrain(task);
    const leafExec = makeSyntheticLeafExecutor(task);
    const trace = await runOrchestration(task, brain, leafExec, synOpts());

    // Synthetic brain returns 50 prompt + 100 completion per call (plan + integrate = 2 calls)
    expect(trace.brainPromptTokens).toBe(100);   // 50 * 2
    expect(trace.brainCompletionTokens).toBe(200); // 100 * 2
  });

  it("leaf tokens are NOT included in brainTokens", async () => {
    const task = getTask("D4-02")!;
    const brain = makeSyntheticBrain(task);
    const leafExec = makeSyntheticLeafExecutor(task);
    const trace = await runOrchestration(task, brain, leafExec, synOpts());

    // Leaf tokens (20+30 each) should NOT appear in brainPromptTokens
    // Brain = 2 calls × 50 = 100 prompt tokens
    expect(trace.brainPromptTokens).toBe(100);
    // Leaf calls have their own token counts
    const leafTotal = trace.leafCalls.reduce((sum, lc) => sum + lc.promptTokens + lc.completionTokens, 0);
    expect(leafTotal).toBeGreaterThan(0);
  });
});

// ─── A3 advisor path ──────────────────────────────────────────────────────────

describe("A3 advisor arm", () => {
  it("calls advisorFn for escalated steps, caps at advisorK", async () => {
    const task = getTask("D4-01")!; // has gapLeaves=["sql"]
    let advisorCallCount = 0;
    const advisorFn: ChatFn = async (req) => {
      advisorCallCount++;
      return { text: `advisor answer for: ${req.prompt.slice(0, 30)}`, promptTokens: 30, completionTokens: 60, model: "frontier" };
    };

    // Synthetic brain that marks the first step as escalate:true + action:ASK_ADVISOR
    const brain: ChatFn = async () => {
      const plan = task.requiredSubtasks.map((rs, i) => ({
        label: rs,
        taskType: i === 0 ? "sql" : "qa-factual",
        input: rs,
        escalate: i === 0,
        action: i === 0 ? "ASK_ADVISOR" : undefined,
        question: i === 0 ? rs : undefined,
      }));
      if (advisorCallCount > 0) {
        // Second call (integrate): return gold answer
        return { text: `The Enterprise segment.`, promptTokens: 50, completionTokens: 100, model: "synthetic" };
      }
      return { text: JSON.stringify(plan), promptTokens: 50, completionTokens: 100, model: "synthetic" };
    };

    const noopLeaf: LeafExecutorFn = async (subtask, taskType) => ({
      subtask, taskType, modelId: "synthetic-local", escalated: false,
      output: "result", promptTokens: 10, completionTokens: 10,
    });

    const opts: OrchOptions = { arm: "a3", brainModel: "synthetic", escalationModel: "frontier", advisorK: 1, advisorFn };
    const trace = await runOrchestration(task, brain, noopLeaf, opts);

    // The advisor should have been called for the sql/ASK_ADVISOR step
    expect(advisorCallCount).toBe(1);
    expect(trace.advisorCalls.length).toBe(1);
    expect(trace.advisorCalls[0]!.model).toBe("frontier");
  });
});

// ─── D2 producedCode extraction ───────────────────────────────────────────────

describe("D2 producedCode extraction", () => {
  it("extracts a ```ts block from leaf or integrate output", async () => {
    const task = getTask("D2-01")!;

    // Brain returns a plan with a code-implement step, then a ts block in integrate
    let callNum = 0;
    const brain: ChatFn = async () => {
      callNum++;
      if (callNum === 1) {
        return {
          text: JSON.stringify([{ label: "implement chunkBy", taskType: "code-implement", input: task.prompt, escalate: false }]),
          promptTokens: 50, completionTokens: 100, model: "synthetic",
        };
      }
      // Integrate: return a ts block
      return {
        text: "Here is the code:\n```ts\nexport function chunkBy<T>(arr: T[], size: number): T[][] {\n  if (size < 1) throw new RangeError(\"size\");\n  const out: T[][] = [];\n  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));\n  return out;\n}\n```",
        promptTokens: 50, completionTokens: 100, model: "synthetic",
      };
    };
    const leafExec: LeafExecutorFn = async (subtask, taskType) => ({
      subtask, taskType, modelId: "synthetic", escalated: false,
      output: "leaf result (no code block here)", promptTokens: 20, completionTokens: 30,
    });

    const trace = await runOrchestration(task, brain, leafExec, synOpts());
    expect(trace.producedCode).toBeDefined();
    expect(trace.producedCode).toMatch(/chunkBy/);
  });
});

describe("A3 advisor token accounting — no double-count", () => {
  it("advisor tokens are counted ONCE in frontierTokens (not via both advisorCalls and the leafCall)", async () => {
    const task = getTask("D4-01")!; // gap leaf = sql; brain marks the sql step escalate:true
    const brain: ChatFn = async (req) => {
      if (req.prompt.includes("Decompose")) {
        return {
          text: JSON.stringify([
            { label: "run the sql aggregation", taskType: "sql", input: "SELECT ...", escalate: true },
            { label: "draft the slack message", taskType: "rewrite", input: "write it", escalate: false },
          ]),
          promptTokens: 40,
          completionTokens: 40,
          model: "local",
        };
      }
      return { text: "The enterprise segment exceeded $10k.", promptTokens: 30, completionTokens: 30, model: "local" };
    };
    const advisorFn: ChatFn = async () => ({
      text: "enterprise",
      promptTokens: 100,
      completionTokens: 200, // 300 advisor tokens
      model: "opus",
    });
    // Local leaf executor: the non-gap rewrite leaf runs local, 25 tokens.
    const leafExec: LeafExecutorFn = async (subtask, taskType) => ({
      subtask,
      taskType,
      modelId: "mellum",
      escalated: false,
      output: "slack draft",
      promptTokens: 10,
      completionTokens: 15,
    });
    const opts: OrchOptions = {
      arm: "a3",
      brainModel: "qwen3-coder-next-80b",
      escalationModel: "opus",
      advisorK: 3,
      advisorFn,
    };
    const trace = await runOrchestration(task, brain, leafExec, opts);
    // The advisor handled the sql step → 1 advisor call (300 tok), and a zero-token leafCall.
    expect(trace.advisorCalls).toHaveLength(1);
    const { frontierTokens, totalTokens } = await import("../scripts/gate-e-score.js");
    // frontier = advisor 300 only (the escalated leaf carries 0 tokens) — NOT 600.
    expect(frontierTokens(trace)).toBe(300);
    // total = brain (80 plan + 60 integrate) + advisor (300) + local leaf (25) = 465.
    expect(totalTokens(trace)).toBe(465);
  });
});

describe("coerceEscalate — no string-truthiness trap (Codex #6)", () => {
  it("treats string 'false' as NOT escalation", () => {
    expect(coerceEscalate("false")).toBe(false);
    expect(coerceEscalate("False")).toBe(false);
    expect(coerceEscalate(false)).toBe(false);
    expect(coerceEscalate(0)).toBe(false);
    expect(coerceEscalate(undefined)).toBe(false);
  });
  it("treats real true / 'true' / 'yes' / 1 as escalation", () => {
    expect(coerceEscalate(true)).toBe(true);
    expect(coerceEscalate("true")).toBe(true);
    expect(coerceEscalate("YES")).toBe(true);
    expect(coerceEscalate(1)).toBe(true);
  });
  it("parsePlan applies it — string 'false' does not become an escalation", () => {
    const steps = parsePlan(JSON.stringify([{ label: "x", taskType: "sql", input: "q", escalate: "false" }]));
    expect(steps?.[0]?.escalate).toBe(false);
  });
});

describe("runOrchestration — a thrown leaf becomes an error collapse (Codex #7)", () => {
  it("records runtimeError and lets the scorer flag collapse=error instead of aborting", async () => {
    const task = getTask("D3-01")!;
    const brain: ChatFn = async (req) =>
      req.prompt.includes("Decompose")
        ? {
            text: JSON.stringify([{ label: "extract", taskType: "extract", input: "go", escalate: false }]),
            promptTokens: 10,
            completionTokens: 10,
            model: "local",
          }
        : { text: "answer", promptTokens: 10, completionTokens: 10, model: "local" };
    const throwingLeaf: LeafExecutorFn = async () => {
      throw new Error("simulated API failure");
    };
    const trace = await runOrchestration(task, brain, throwingLeaf, synOpts());
    expect(trace.runtimeError).toMatch(/leaf-error/);
    const { scoreTask } = await import("../scripts/gate-e-score.js");
    const s = await scoreTask(task, trace);
    expect(s.collapse).toBe("error");
  });
});

describe("makeCorpusLeafExecutor — D1 grounding in the frozen corpus (Codex #1)", () => {
  it("reads frozen sources, tags [S#], and records concrete reads in state", async () => {
    // A tiny in-memory corpus (no disk dependency).
    const corpus = {
      query: "q",
      sources: [
        { id: "a", url: "http://a", title: "Apollo program", tier: "primary" as const, markdown: "Apollo facts about the moon landing in 1969." },
        { id: "b", url: "http://b", title: "World Cup history", tier: "secondary" as const, markdown: "France won the FIFA World Cup in 1998." },
      ],
    };
    const state: CorpusReadState = { readIds: new Set(), corpusSize: corpus.sources.length, sources: [] };
    let distillCalls = 0;
    const distill: ChatFn = async (req) => {
      distillCalls++;
      // Echo a faithful distilled snippet so we can assert it's source-grounded.
      return { text: req.prompt.includes("World Cup") ? "France, 1998" : "moon, 1969", promptTokens: 5, completionTokens: 5, model: "mellum" };
    };
    const exec = makeCorpusLeafExecutor(corpus, distill, state);
    const lc = await exec("which country held the cup", "summarize", "FIFA World Cup holder", false, "", 256);
    expect(distillCalls).toBe(1);
    expect(lc.escalated).toBe(false);
    expect(lc.output).toMatch(/\[S2\] World Cup history/); // best-matched source, tagged
    expect(state.readIds.size).toBe(1);
    // A second leaf prefers the UNREAD source.
    const lc2 = await exec("apollo", "summarize", "moon landing", false, "", 256);
    expect(lc2.output).toMatch(/\[S1\] Apollo program/);
    expect(state.readIds.size).toBe(2);
  });
});

describe("bestWindow — query-aware retrieval reaches deep gold facts (Codex re-review #B)", () => {
  it("selects the window containing the gold fact even when it's past char 8000", () => {
    const filler = "lorem ipsum dolor ".repeat(1200); // ~21k chars of noise
    const md = `${filler} The 2000 census population was 506132 people. ${filler}`;
    const q = new Set(["census", "population", "506132"]);
    const win = bestWindow(md, q);
    expect(win).toMatch(/506132/);
  });
  it("returns the whole source when it fits in one window", () => {
    expect(bestWindow("short source", new Set(["short"]))).toBe("short source");
  });
});

describe("D1 A3 grounding — advisor never preempts the corpus executor (Codex re-review #A)", () => {
  it("an escalate:true D1 step still reads the frozen corpus and does NOT call the advisor", async () => {
    const task = getTask("D1-02")!; // D1, corpusRef set
    const corpus = {
      query: "q",
      sources: [
        { id: "a", url: "http://a", title: "World Cup history", tier: "secondary" as const, markdown: "France won the FIFA World Cup in 1998." },
      ],
    };
    const state: CorpusReadState = {
      readIds: new Set(),
      corpusSize: 1,
      sources: [
        { id: "S1", url: "http://a", title: "World Cup history", tier: "secondary", markdown: "France won the FIFA World Cup in 1998.", contentHash: "0" },
      ],
    };
    const distill: ChatFn = async () => ({ text: "France, 1998", promptTokens: 5, completionTokens: 5, model: "mellum" });
    const corpusLeaf = makeCorpusLeafExecutor(corpus, distill, state);
    let advisorCalls = 0;
    const advisorFn: ChatFn = async () => {
      advisorCalls++;
      return { text: "ungrounded parametric answer", promptTokens: 50, completionTokens: 50, model: "opus" };
    };
    const brain: ChatFn = async (req) =>
      req.prompt.includes("Decompose")
        ? {
            text: JSON.stringify([{ label: "find holder", taskType: "qa-factual", input: "who held the cup", escalate: true }]),
            promptTokens: 10,
            completionTokens: 10,
            model: "local",
          }
        : { text: "Report [S1]\nFinal Answer: France", promptTokens: 10, completionTokens: 10, model: "local" };
    const trace = await runOrchestration(task, brain, corpusLeaf, {
      arm: "a3",
      brainModel: "local",
      escalationModel: "opus",
      advisorK: 3,
      advisorFn,
      corpusState: state, // D1 grounded → advisor must NOT preempt
    });
    expect(advisorCalls).toBe(0); // advisor was NOT called
    expect(trace.advisorCalls).toHaveLength(0);
    expect(state.readIds.size).toBe(1); // the corpus WAS read
    expect(trace.leafCalls[0]?.output).toMatch(/\[S1\] World Cup history/);
    expect(trace.sourcesRead).toBe(1);
  });
});

describe("makeRealLeafExecutor — brain-hinted escalation (Path 1)", () => {
  it("routes an escalate:true leaf to the injected frontier ChatFn", async () => {
    let frontierCalls = 0;
    const frontierChat: ChatFn = async (req) => {
      frontierCalls++;
      return { text: `frontier-answer for: ${req.prompt}`, promptTokens: 11, completionTokens: 22, model: "opus" };
    };
    const exec = makeRealLeafExecutor(frontierChat);
    const lc = await exec("the sql join step", "sql", "run the join", true, "anthropic/claude-opus-4-5", 256);
    expect(frontierCalls).toBe(1);
    expect(lc.escalated).toBe(true);
    expect(lc.modelId).toBe("anthropic/claude-opus-4-5");
    expect(lc.output).toMatch(/frontier-answer/);
    expect(lc.promptTokens).toBe(11);
    expect(lc.completionTokens).toBe(22);
  });
  it("without a frontier ChatFn, a hinted leaf is NOT forced to frontier (falls to substrate)", async () => {
    // No frontierChat → Path 1 is skipped; we don't call delegate() here (would hit the box),
    // so just assert the executor is constructed without throwing and is a function.
    const exec = makeRealLeafExecutor();
    expect(typeof exec).toBe("function");
  });
});
