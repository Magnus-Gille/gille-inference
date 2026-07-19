/**
 * gate-e-apply-verdict.ts — apply the E1–E6 Gate E criteria to the SAVED arm scores
 * (no model calls, $0). The aggregator (gate-e-verdict.ts) is pure over TaskScore[]; this
 * is the disk/CLI layer that loads each arm's <dir>/<arm>/scores.json, aggregates it,
 * evaluates every candidate (a1/a2/a3) against the A0 frontier reference, and prints the
 * per-criterion verdict + the overall S1/S2 recommendation. Mirrors gate-e-rescore.ts.
 *
 * E5 (judge quality) needs blind-judge data — supply it via --judge <file.json> where the
 * file is { "a0": JudgeScores, "a1": JudgeScores, ... } as emitted by dr-judge-hybrid.
 * Without it, E5 reads "pending" and the arm cannot PASS (E5 is a required criterion).
 *
 * Usage: tsx scripts/gate-e-apply-verdict.ts <dir> [--judge judge.json]
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { aggregateArm, evaluateGateE } from "./gate-e-verdict.js";
import type { ArmId, GateEVerdict, JudgeScores, TaskScore } from "./gate-e-types.js";

const CANDIDATE_ARMS: ArmId[] = ["a1", "a2", "a3"];

/**
 * Is E5 (the judge) the DECIDER for this arm? True iff it clears every required criterion
 * EXCEPT E5 (E1–E4, plus E6 for A3). If no arm is E5-pivotal, Gate E is a deterministic
 * FAIL and the judge need not run — the finisher uses this to gate unattended judge spend.
 */
export function e5Pivotal(v: GateEVerdict): boolean {
  const need: string[] = v.candidate.arm === "a3" ? ["E1", "E2", "E3", "E4", "E6"] : ["E1", "E2", "E3", "E4"];
  return need.every((id) => v.criteria.find((c) => c.id === id)?.pass === true);
}

function loadScores(dir: string, arm: ArmId): TaskScore[] | null {
  const p = join(dir, arm, "scores.json");
  if (!existsSync(p)) return null;
  const scores = JSON.parse(readFileSync(p, "utf-8")) as TaskScore[];
  // Validate so a corrupt/cross-pasted scores.json can't silently skew an aggregate: every
  // row must belong to this arm, and taskIds must be unique (a dup would double-count).
  const seen = new Set<string>();
  for (const s of scores) {
    if (s.arm !== arm) throw new Error(`${p}: row ${s.taskId} has arm=${s.arm}, expected ${arm}`);
    if (seen.has(s.taskId)) throw new Error(`${p}: duplicate taskId ${s.taskId}`);
    seen.add(s.taskId);
  }
  return scores;
}

/**
 * Pure core: aggregate + evaluate each present candidate against A0. Separated from disk IO
 * so it's unit-testable with synthetic scores. Throws if the A0 reference is absent — every
 * E-criterion is relative to it, so a verdict without A0 is meaningless.
 */
export function buildVerdicts(
  scoresByArm: Partial<Record<ArmId, TaskScore[]>>,
  judgeByArm: Partial<Record<ArmId, JudgeScores>> = {},
): { verdicts: GateEVerdict[]; gatePass: boolean } {
  const a0Scores = scoresByArm["a0"];
  if (!a0Scores) throw new Error("A0 reference scores missing — run arm a0 first (the E1–E6 ceiling).");
  const reference = aggregateArm("a0", a0Scores, judgeByArm["a0"]);

  const verdicts: GateEVerdict[] = [];
  for (const arm of CANDIDATE_ARMS) {
    const s = scoresByArm[arm];
    if (!s) continue;
    const candidate = aggregateArm(arm, s, judgeByArm[arm]);
    verdicts.push(evaluateGateE(candidate, reference));
  }
  // Gate E PASSES iff ANY candidate arm cleared all its required criteria.
  const gatePass = verdicts.some((v) => v.pass);
  return { verdicts, gatePass };
}

function fmtRef(r: GateEVerdict["reference"]): string {
  return [
    `answerPass ${r.answerPassRate}`,
    `collapses ${r.collapseCount}`,
    `meanCov ${r.meanPlanCoverage} (min ${r.minPlanCoverage})`,
    `gapRecall ${r.d4GapRecall}`,
    `overEsc ${r.overEscalationRate}`,
    `frontierTok ${r.frontierTokens + r.brainTokens}`,
    r.judge ? `judge ${r.judge.overall}` : "judge —",
  ].join("  ");
}

function printVerdicts(dir: string, verdicts: GateEVerdict[], gatePass: boolean): void {
  const ref = verdicts[0]?.reference;
  console.log(`\nGate E — E1–E6 verdict  (dir: ${dir})`);
  if (ref) console.log(`Reference A0 (frontier brain):  ${fmtRef(ref)}`);

  for (const v of verdicts) {
    console.log(`\n── ${v.candidate.arm}  ${v.pass ? "✅ PASS" : "❌ FAIL"} ──`);
    for (const c of v.criteria) {
      const mark = c.pass === true ? "PASS" : c.pass === false ? "FAIL" : "—   ";
      console.log(`  ${c.id} ${mark}  ${c.label}\n        ${c.detail}`);
    }
    console.log(`  → ${v.recommendation}`);
  }

  console.log(
    `\n${"═".repeat(70)}\nGATE E: ${gatePass ? "PASS → S2 unlocked" : "FAIL → stay S1-Hybrid"}` +
      (gatePass ? "" : "  (no candidate arm cleared all required criteria)"),
  );
}

function main(): void {
  const args = process.argv.slice(2);
  const positional = args.filter((a) => !a.startsWith("--"));
  const dir = positional[0];
  if (!dir) {
    console.error("usage: tsx scripts/gate-e-apply-verdict.ts <dir> [--judge judge.json]");
    process.exit(1);
  }
  const judgeIdx = args.indexOf("--judge");
  let judgeByArm: Partial<Record<ArmId, JudgeScores>> = {};
  if (judgeIdx !== -1) {
    const jf = args[judgeIdx + 1];
    if (!jf) {
      console.error("--judge needs a file path");
      process.exit(1);
    }
    judgeByArm = JSON.parse(readFileSync(jf, "utf-8")) as Partial<Record<ArmId, JudgeScores>>;
  }

  const scoresByArm: Partial<Record<ArmId, TaskScore[]>> = {};
  for (const arm of ["a0", ...CANDIDATE_ARMS] as ArmId[]) {
    const s = loadScores(dir, arm);
    if (s) scoresByArm[arm] = s;
  }

  const { verdicts, gatePass } = buildVerdicts(scoresByArm, judgeByArm);
  const missingCandidates = CANDIDATE_ARMS.filter((a) => !scoresByArm[a]);

  // Machine-readable pivotal check for the finisher: which arms make E5 the decider? An
  // incomplete arm set could mislead the spend gate (a not-yet-run arm reads as "not pivotal"),
  // so report `incomplete` rather than `none` when a candidate arm's scores are absent.
  if (args.includes("--check-pivotal")) {
    if (missingCandidates.length) {
      console.error(`(missing candidate arm scores: ${missingCandidates.join(", ")})`);
      console.log("PIVOTAL=incomplete");
      return;
    }
    const pivotal = verdicts.filter(e5Pivotal).map((v) => v.candidate.arm);
    console.log(`PIVOTAL=${pivotal.length ? pivotal.join(",") : "none"}`);
    return;
  }

  if (missingCandidates.length) {
    console.error(`⚠ verdict computed WITHOUT candidate arm(s): ${missingCandidates.join(", ")} (no scores.json found)`);
  }
  printVerdicts(dir, verdicts, gatePass);
}

// Run only when invoked directly (tsx scripts/gate-e-apply-verdict.ts …) — NOT on import.
const isEntrypoint =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) {
  try {
    main();
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
