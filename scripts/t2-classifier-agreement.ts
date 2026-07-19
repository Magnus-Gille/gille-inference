/**
 * T2 (Gate B) cheap-win probe: how reliable is the cheap keyword classifier `classifyTask()`
 * — the one wired into the /mcp/ask usage telemetry (#1) — relative to a small-LLM classifier
 * (mellum on the M5, labels saved in data/prompts-taxonomy-classified.jsonl)?
 *
 * Neither is ground truth, but their AGREEMENT bounds how noisy the production task_type tags
 * will be, and the DISAGREEMENT PATTERNS show exactly which task types the keyword heuristic
 * confuses — the actionable T2 fail→forward. No box, no network: pure local computation.
 */
import { readFileSync } from "node:fs";
import { classifyTask } from "../src/homeserver/taxonomy.js";

interface Extracted { prompt: string }
interface Mellum { id: number; type: string }

const extracted = readFileSync("data/prompts-extracted.jsonl", "utf8")
  .split("\n").filter(Boolean).map((l) => JSON.parse(l) as Extracted);
const mellum = readFileSync("data/prompts-taxonomy-classified.jsonl", "utf8")
  .split("\n").filter(Boolean).map((l) => JSON.parse(l) as Mellum);

const mById = new Map<number, string>(mellum.map((r) => [r.id, r.type]));

let n = 0, agree = 0;
const perClass = new Map<string, { n: number; agree: number }>();
const confusion = new Map<string, number>();   // "keyword → mellum" mismatch counts
const keywordDist = new Map<string, number>();

for (let i = 0; i < extracted.length; i++) {
  const mLabel = mById.get(i);
  if (mLabel === undefined) continue;
  const kLabel = classifyTask(extracted[i]!.prompt).taskType;
  n++;
  keywordDist.set(kLabel, (keywordDist.get(kLabel) ?? 0) + 1);
  const ok = kLabel === mLabel;
  if (ok) agree++;
  const pc = perClass.get(mLabel) ?? { n: 0, agree: 0 };
  pc.n++; if (ok) pc.agree++; perClass.set(mLabel, pc);
  if (!ok) {
    const key = `${kLabel} → ${mLabel}`;
    confusion.set(key, (confusion.get(key) ?? 0) + 1);
  }
}

const pct = (a: number, b: number): string => (b > 0 ? `${((100 * a) / b).toFixed(0)}%` : "—");
console.log(`\nOverall agreement (keyword classifyTask vs mellum): ${agree}/${n} = ${((100 * agree) / n).toFixed(1)}%\n`);

console.log("Per mellum-label agreement (where the keyword heuristic lands the same label):");
[...perClass.entries()].sort((a, b) => b[1].n - a[1].n)
  .forEach(([k, v]) => console.log(`  ${k.padEnd(16)} ${String(v.agree).padStart(3)}/${String(v.n).padStart(3)}  ${pct(v.agree, v.n)}`));

console.log("\nWhat classifyTask() actually emits (its label distribution):");
[...keywordDist.entries()].sort((a, b) => b[1] - a[1])
  .forEach(([k, v]) => console.log(`  ${k.padEnd(16)} ${String(v).padStart(3)}  ${pct(v, n)}`));

console.log("\nTop disagreements (keyword said → mellum said):");
[...confusion.entries()].sort((a, b) => b[1] - a[1]).slice(0, 18)
  .forEach(([k, v]) => console.log(`  ${String(v).padStart(3)}  ${k}`));
