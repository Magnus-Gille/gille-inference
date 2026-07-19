/**
 * gate-e-judge.ts — o4-mini blind judge over the SAVED Gate E arm traces → JudgeScores per
 * arm (the E5 input that `gate-e-apply-verdict --judge` consumes). This is the Gate-E-shaped
 * analogue of dr-judge-hybrid.ts, which is hardcoded to the 5 deep-research queries and
 * q<N>-<system>.md filenames and so CANNOT judge the 20 D1–D4 tasks. Here, per task, every
 * present arm's deliverable (plan + report/code + final answer) is blind-shuffled and scored
 * by o4-mini on plan_quality / integration_coherence / citation_quality / overall (1–5); the
 * per-arm means become JudgeScores { …, overall, minDimension }.
 *
 * o4-mini ALONE is a single-family judge (the cross-family Opus-sub confirmation in
 * dr-judge-hybrid needs an interactive Claude subagent, unavailable unattended on the box).
 * Used for the overnight pass; the Opus cross-check is a watched morning follow-up.
 *
 * Usage: tsx scripts/gate-e-judge.ts <dir> [arms=a0,a1,a2,a3] [--out <dir>/judge.json]
 */
import OpenAI from "openai";
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadEnv } from "../src/env.js";
import { looseJson } from "../src/homeserver/deep-research.js";
import { getTask } from "./gate-e-tasks.js";
import type { ArmId, JudgeScores, OrchTrace } from "./gate-e-types.js";

const ALL_ARMS: ArmId[] = ["a0", "a1", "a2", "a3"];
const DIMS = ["plan_quality", "integration_coherence", "citation_quality"] as const;

export interface TaskJudgement {
  arm: ArmId;
  plan_quality: number;
  integration_coherence: number;
  citation_quality: number;
  overall: number;
}

/**
 * Pure: average each dimension per arm across tasks → JudgeScores. minDimension is the
 * lowest of the three sub-dimension means (the "no dimension < acceptable floor" check in
 * E5); overall is the mean of the per-task overall scores. Disk-free → unit-tested.
 */
export function aggregateJudgeScores(
  judgements: TaskJudgement[],
): Partial<Record<ArmId, JudgeScores>> {
  const byArm = new Map<ArmId, TaskJudgement[]>();
  for (const j of judgements) {
    const a = byArm.get(j.arm) ?? [];
    a.push(j);
    byArm.set(j.arm, a);
  }
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const round = (n: number) => Math.round(n * 1000) / 1000;
  const out: Partial<Record<ArmId, JudgeScores>> = {};
  for (const [arm, js] of byArm) {
    const planQuality = mean(js.map((j) => j.plan_quality));
    const integrationCoherence = mean(js.map((j) => j.integration_coherence));
    const citationQuality = mean(js.map((j) => j.citation_quality));
    out[arm] = {
      planQuality: round(planQuality),
      integrationCoherence: round(integrationCoherence),
      citationQuality: round(citationQuality),
      overall: round(mean(js.map((j) => j.overall))),
      minDimension: round(Math.min(planQuality, integrationCoherence, citationQuality)),
    };
  }
  return out;
}

function loadArmTraces(dir: string, arm: ArmId): Map<string, OrchTrace> {
  const armDir = join(dir, arm);
  const m = new Map<string, OrchTrace>();
  if (!existsSync(armDir)) return m;
  for (const f of readdirSync(armDir).filter((f) => f.endsWith(".trace.json"))) {
    const t = JSON.parse(readFileSync(join(armDir, f), "utf-8")) as OrchTrace;
    m.set(t.taskId, t);
  }
  return m;
}

function deliverable(t: OrchTrace): string {
  const parts: string[] = [];
  if (t.plan?.length) parts.push("PLAN:\n" + t.plan.map((p, i) => `${i + 1}. ${p}`).join("\n"));
  if (t.reportMarkdown) parts.push("REPORT:\n" + t.reportMarkdown);
  if (t.producedCode) parts.push("CODE:\n" + t.producedCode);
  if (t.finalAnswer) parts.push("ANSWER:\n" + t.finalAnswer);
  const s = parts.join("\n\n").trim();
  return (s || "(no output produced)").slice(0, 3500);
}

const LABELS = ["System A", "System B", "System C", "System D"];

async function main(): Promise<void> {
  loadEnv();
  const args = process.argv.slice(2);
  const allowPartial = args.includes("--allow-partial");
  // Consume the --out VALUE so it isn't mistaken for the positional `arms` arg (which silently
  // loaded zero traces and wrote an empty judge.json).
  const outIdx = args.indexOf("--out");
  const flagValueIdx = outIdx >= 0 ? outIdx + 1 : -1;
  const positional = args.filter((a, i) => !a.startsWith("--") && i !== flagValueIdx);
  const dir = positional[0];
  if (!dir) {
    console.error("usage: tsx scripts/gate-e-judge.ts <dir> [arms=a0,a1,a2,a3] [--out file] [--allow-partial]");
    process.exit(1);
  }
  const arms = (positional[1]?.split(",") as ArmId[] | undefined) ?? ALL_ARMS;
  const unknown = arms.filter((a) => !ALL_ARMS.includes(a));
  if (unknown.length) {
    console.error(`unknown arm(s): ${unknown.join(", ")} (valid: ${ALL_ARMS.join(", ")})`);
    process.exit(1);
  }
  const outFile = outIdx >= 0 ? args[outIdx + 1]! : join(dir, "judge.json");

  const key = process.env["OPENROUTER_API_KEY"];
  if (!key) {
    console.error("OPENROUTER_API_KEY required for the o4-mini judge");
    process.exit(1);
  }
  const or = new OpenAI({ baseURL: "https://openrouter.ai/api/v1", apiKey: key, timeout: 900_000, maxRetries: 2 });

  const traces = new Map<ArmId, Map<string, OrchTrace>>();
  for (const arm of arms) traces.set(arm, loadArmTraces(dir, arm));
  const taskIds = [...new Set([...traces.values()].flatMap((m) => [...m.keys()]))].sort();

  const judgements: TaskJudgement[] = [];
  let expected = 0;
  for (let ti = 0; ti < taskIds.length; ti++) {
    const taskId = taskIds[ti]!;
    const task = getTask(taskId);
    const present = arms.filter((a) => traces.get(a)!.has(taskId));
    if (present.length === 0) continue;
    expected += present.length;
    // Blind-shuffle by index rotation (deterministic, no Math.random) so label↔arm varies.
    const order = present.map((_, i) => present[(i + ti) % present.length]!);
    const labelToArm = new Map<string, ArmId>();
    const blocks: string[] = [];
    order.forEach((arm, i) => {
      labelToArm.set(LABELS[i]!, arm);
      blocks.push(`### ${LABELS[i]}\n\n${deliverable(traces.get(arm)!.get(taskId)!)}`);
    });
    const prompt =
      `You are an impartial judge of AI orchestrator outputs answering the same task. Judge content only — ignore length and formatting.\n\n` +
      `TASK: ${task?.title ?? taskId}\n${task?.prompt ?? ""}\n\n` +
      blocks.join("\n\n---\n\n") +
      `\n\nScore EACH system 1-5 on plan_quality (did the plan decompose the task sensibly), ` +
      `integration_coherence (is the final answer coherent and well-assembled from the parts), ` +
      `citation_quality (are claims grounded/traceable; for code, is it complete and correct-looking), ` +
      `and overall. Penalise unsupported claims, missing steps, and incoherent or empty output. ` +
      `Return ONLY JSON keyed by label: {"System A":{"plan_quality":4,"integration_coherence":4,"citation_quality":4,"overall":4}}`;

    try {
      const r = await or.chat.completions.create({
        model: "openai/o4-mini",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 2000,
      });
      const parsed = looseJson(r.choices[0]?.message?.content ?? "") as Record<string, Record<string, number>> | null;
      if (!parsed) {
        console.error(`${taskId}: o4-mini parse failed — skipping`);
        continue;
      }
      for (const [label, arm] of labelToArm) {
        const sc = parsed[label];
        if (!sc) continue;
        judgements.push({
          arm,
          plan_quality: Number(sc["plan_quality"] ?? sc["overall"] ?? 0),
          integration_coherence: Number(sc["integration_coherence"] ?? sc["overall"] ?? 0),
          citation_quality: Number(sc["citation_quality"] ?? sc["overall"] ?? 0),
          overall: Number(sc["overall"] ?? 0),
        });
      }
      console.error(`${taskId}: judged ${present.join(", ")}`);
    } catch (e) {
      console.error(`${taskId}: o4-mini error: ${(e as Error).message}`);
    }
  }

  // Fail CLOSED: a partial judge.json (from parse/API failures) would feed wrong E5 means and
  // could overwrite a complete prior run. Refuse to write unless every expected (task,arm)
  // judgement landed, unless --allow-partial is given explicitly.
  if (judgements.length < expected && !allowPartial) {
    console.error(
      `incomplete judging: ${judgements.length}/${expected} (task,arm) judgements — ` +
        `NOT writing ${outFile}. Re-run, or pass --allow-partial to accept the partial set.`,
    );
    process.exit(1);
  }

  const scores = aggregateJudgeScores(judgements);
  writeFileSync(outFile, JSON.stringify(scores, null, 2), "utf-8");
  console.log(`\nwrote ${outFile} (${judgements.length}/${expected} judgements)`);
  for (const arm of arms) {
    const s = scores[arm];
    if (s) console.log(`  ${arm}: overall ${s.overall}  min-dim ${s.minDimension}  (plan ${s.planQuality} / integ ${s.integrationCoherence} / cite ${s.citationQuality})`);
  }
}

// Run only when invoked directly — NOT on import (the unit tests import aggregateJudgeScores).
const isEntrypoint = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
