/**
 * T2 (Gate B), the apples-to-apples cut: how accurately does the keyword classifier
 * `classifyTask()` — wired into the /mcp/ask telemetry (#1) — label DELEGATED-STYLE prompts
 * (imperative, keyword-rich sub-tasks), as opposed to conversational user prompts?
 *
 * Ground truth here is the task_type the probe/dogfood harness ASSIGNED to each delegation,
 * compared against classifyTask() run on that delegation's saved prompt_excerpt. This is the
 * distribution #1 actually classifies in production. No box, no network: DB excerpts already
 * pulled to data/delegations-excerpts.jsonl.
 */
import { readFileSync } from "node:fs";
import { classifyTask } from "../src/homeserver/taxonomy.js";

interface Row { task_type: string; prompt_excerpt: string; source: string }
const rows = readFileSync("data/delegations-excerpts.jsonl", "utf8")
  .split("\n").filter(Boolean).map((l) => JSON.parse(l) as Row);

function report(subset: Row[], label: string): void {
  let n = 0, agree = 0;
  const per = new Map<string, { n: number; agree: number }>();
  const conf = new Map<string, number>();
  for (const r of subset) {
    const k = classifyTask(r.prompt_excerpt).taskType;
    n++;
    const ok = k === r.task_type;
    if (ok) agree++;
    const pc = per.get(r.task_type) ?? { n: 0, agree: 0 };
    pc.n++; if (ok) pc.agree++; per.set(r.task_type, pc);
    if (!ok) conf.set(`${k} → ${r.task_type}`, (conf.get(`${k} → ${r.task_type}`) ?? 0) + 1);
  }
  console.log(`\n=== ${label}: ${agree}/${n} = ${((100 * agree) / n).toFixed(1)}% ===`);
  console.log("per recorded task_type:");
  [...per.entries()].sort((a, b) => b[1].n - a[1].n)
    .forEach(([k, v]) => console.log(`  ${k.padEnd(16)} ${String(v.agree).padStart(3)}/${String(v.n).padStart(3)}  ${v.n > 0 ? ((100 * v.agree) / v.n).toFixed(0) + "%" : "—"}`));
  console.log("top disagreements (keyword → recorded):");
  [...conf.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
    .forEach(([k, v]) => console.log(`  ${String(v).padStart(3)}  ${k}`));
}

const researchRoles = new Set(["source-distill", "synthesis", "gap-check", "research-plan", "claim-verify"]);
report(rows, "ALL delegations (incl. deep-research roles)");
report(rows.filter((r) => r.source === "m5-cartography"), "cartography only (generic imperative sub-tasks — the mcp-ask proxy)");
report(rows.filter((r) => !researchRoles.has(r.task_type)), "generic task types only (research roles excluded)");
