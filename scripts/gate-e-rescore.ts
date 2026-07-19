/**
 * gate-e-rescore.ts — Re-score SAVED Gate E traces offline (no model calls, $0).
 *
 * The Tier-1 scorer (gate-e-score.ts) is pure over (gold OrchTask, saved OrchTrace), so a
 * scorer fix can be applied to traces collected on the box WITHOUT re-running any arm. Mirrors
 * scripts/frames-regrade.ts. Reads <dir>/<arm>/<taskId>.trace.json, re-scores with the current
 * scoreArm, rewrites <arm>/scores.json, and prints a per-family summary + a diff vs the OLD
 * scores.json (so a re-score's effect — e.g. the D3 stage-checklist loosening — is auditable).
 *
 * Usage: tsx scripts/gate-e-rescore.ts <dir> [arm ...]      (default arms: a0 a1 a2 a3)
 *        tsx scripts/gate-e-rescore.ts <dir> --dry-run      (print, do not write scores.json)
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { scoreArm } from "./gate-e-score.js";
import { getTask } from "./gate-e-tasks.js";
import type { OrchTask, OrchTrace, TaskScore } from "./gate-e-types.js";

/**
 * Audit guard: a trace whose taskId is unknown (renamed/corrupt) is silently dropped by
 * scoreArm — shrinking scores.json's denominator and making an offline re-score read
 * cleaner than the saved traces actually are. Surface unknown + duplicate taskIds so the
 * caller can refuse to overwrite scores.json with a partial/wrong set. Pure + testable.
 */
export function diagnoseTraceSet(
  traces: { taskId: string }[],
  known: (id: string) => boolean,
): { unknown: string[]; duplicates: string[] } {
  const unknown: string[] = [];
  const seen = new Set<string>();
  const dupSeen = new Set<string>();
  const duplicates: string[] = [];
  for (const t of traces) {
    if (!known(t.taskId) && !unknown.includes(t.taskId)) unknown.push(t.taskId);
    if (seen.has(t.taskId)) {
      if (!dupSeen.has(t.taskId)) {
        duplicates.push(t.taskId);
        dupSeen.add(t.taskId);
      }
    } else {
      seen.add(t.taskId);
    }
  }
  return { unknown, duplicates };
}

function loadTraces(armDir: string): OrchTrace[] {
  if (!existsSync(armDir)) return [];
  return readdirSync(armDir)
    .filter((f) => f.endsWith(".trace.json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(armDir, f), "utf-8")) as OrchTrace);
}

function loadOldScores(armDir: string): Map<string, TaskScore> {
  const p = join(armDir, "scores.json");
  if (!existsSync(p)) return new Map();
  const arr = JSON.parse(readFileSync(p, "utf-8")) as TaskScore[];
  return new Map(arr.map((s) => [s.taskId, s]));
}

async function rescoreArm(dir: string, arm: string, dryRun: boolean): Promise<void> {
  const armDir = join(dir, arm);
  const traces = loadTraces(armDir);
  if (traces.length === 0) {
    console.log(`\n=== ${arm}: no traces, skipping ===`);
    return;
  }
  const old = loadOldScores(armDir);

  // Refuse to overwrite scores.json with a partial/wrong set: an unknown taskId would be
  // silently dropped by scoreArm (smaller denominator → falsely cleaner audit).
  const { unknown, duplicates } = diagnoseTraceSet(traces, (id) => Boolean(getTask(id)));
  if (unknown.length) {
    throw new Error(
      `${arm}: ${unknown.length} trace(s) with unknown taskId(s) — would be dropped from scores.json: ${unknown.join(", ")}`,
    );
  }
  if (duplicates.length) {
    throw new Error(`${arm}: duplicate trace taskId(s): ${duplicates.join(", ")}`);
  }
  if (old.size) {
    const newIds = new Set(traces.map((t) => t.taskId));
    const missing = [...old.keys()].filter((id) => !newIds.has(id));
    const added = [...newIds].filter((id) => !old.has(id));
    if (missing.length) console.log(`  ⚠ taskIds in old scores.json but NOT re-scored: ${missing.join(", ")}`);
    if (added.length) console.log(`  + new taskIds vs old scores.json: ${added.join(", ")}`);
  }

  const tasks = traces
    .map((t) => getTask(t.taskId))
    .filter((t): t is OrchTask => Boolean(t));
  const scores = await scoreArm(tasks, traces);

  console.log(`\n=== ${arm} (${scores.length} tasks) ===`);
  const flips: string[] = [];
  // answerPass = answer-correctness only; cleanPass = a genuine task pass (answerPass AND
  // no collapse). A collapse (timeout/error/under-read/…) FAILs the task regardless of the
  // answer — so report both, or a correct-but-errored trace reads as a pass it isn't.
  const byFam = new Map<string, { pass: number; clean: number; n: number }>();
  for (const s of scores) {
    const f = byFam.get(s.family) ?? { pass: 0, clean: 0, n: 0 };
    f.pass += s.answerPass;
    f.clean += s.answerPass === 1 && s.collapse == null ? 1 : 0;
    f.n += 1;
    byFam.set(s.family, f);
    const prev = old.get(s.taskId);
    const flip =
      prev && prev.answerPass !== s.answerPass
        ? `  ${s.taskId}: answerPass ${prev.answerPass} → ${s.answerPass}` +
          (s.collapse ? ` (still collapse=${s.collapse} → not a task pass)` : "")
        : null;
    if (flip) flips.push(flip);
  }
  for (const [fam, { pass, clean, n }] of [...byFam].sort()) {
    console.log(`  ${fam}: answerPass ${pass}/${n}  cleanPass ${clean}/${n}`);
  }
  const total = scores.reduce((n, s) => n + s.answerPass, 0);
  const cleanTotal = scores.reduce(
    (n, s) => n + (s.answerPass === 1 && s.collapse == null ? 1 : 0),
    0,
  );
  console.log(`  TOTAL answerPass ${total}/${scores.length}  cleanPass ${cleanTotal}/${scores.length}`);
  if (flips.length) {
    console.log(`  flips vs old scores.json:`);
    for (const f of flips) console.log(f);
  } else if (old.size) {
    console.log(`  (no answerPass changes vs old scores.json)`);
  }

  if (!dryRun) {
    writeFileSync(join(armDir, "scores.json"), JSON.stringify(scores, null, 2), "utf-8");
    console.log(`  wrote ${join(armDir, "scores.json")}`);
  } else {
    console.log(`  --dry-run: scores.json NOT written`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const positional = args.filter((a) => !a.startsWith("--"));
  const dir = positional[0];
  if (!dir) {
    console.error("usage: tsx scripts/gate-e-rescore.ts <dir> [arm ...] [--dry-run]");
    process.exit(1);
  }
  const arms = positional.slice(1);
  const armList = arms.length ? arms : ["a0", "a1", "a2", "a3"];
  for (const arm of armList) await rescoreArm(dir, arm, dryRun);
}

// Only run the CLI when invoked directly (tsx scripts/gate-e-rescore.ts …) — NOT when this
// module is imported by the unit tests (which would otherwise fire a real re-score).
const isEntrypoint =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
