/**
 * T2 / Gate-B ROUTING accuracy — the metric that matches Gate B's actual purpose.
 *
 * The migration plan (docs/migration-go-no-go-plan.md §T2) proposes "≥90% top-1 task-type
 * accuracy". But Gate B's stated purpose is "the router is trustworthy" — what matters is whether
 * each prompt reaches the RIGHT MODEL/TIER, not whether the task-type label is letter-perfect.
 * Top-1 accuracy is a leaky proxy: distinct task types that share a route (regex / unit-test-gen /
 * code-implement all → mellum, per docs/m5-routing.json) are routing-EQUIVALENT — calling one the
 * other changes nothing downstream. This script measures three things side by side:
 *
 *   1. top-1 task-type accuracy   (the raw proxy — what the plan currently quotes)
 *   2. ROUTING accuracy           (collapse gold + predicted via routingTarget(); did it reach the
 *                                  right model?) — the metric that matches Gate B's purpose
 *   3. gap-type recall            (of prompts whose gold routes to FRONTIER, how many predicted
 *                                  also escalate) — the SAFETY-critical ≥98% criterion
 *
 * It also prints the confusion broken into ROUTING-EQUIVALENT disagreements (harmless: same model)
 * vs GENUINE routing errors (the residual that actually matters).
 *
 * Two modes:
 *   LIVE   (default): classify all rows via mellum on the box. Requires a port-forward to llama-swap.
 *                     With --dump <path>, caches every {prompt, gold, predicted, raw, fellBack} row.
 *   REPLAY (--replay <path>): recompute all metrics offline from a cache — NO box, instant, free.
 *
 * Live command (after `ssh -L 8091:localhost:8091 m5 -N &`):
 *   MELLUM_BASE_URL=http://localhost:8091/v1 \
 *     tsx scripts/t2-routing-accuracy.ts --dump data/t2-routing-cache.jsonl
 * Offline re-analysis:
 *   tsx scripts/t2-routing-accuracy.ts --replay data/t2-routing-cache.jsonl
 *
 * No OpenRouter credits are used — mellum is a free local model.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChatFn } from "../src/homeserver/deep-research-types.js";
import { makeChatFn } from "../src/homeserver/deep-research-cli.js";
import { classifyTaskLLM } from "../src/homeserver/task-classifier-llm.js";
import { classifyTask } from "../src/homeserver/taxonomy.js";
import { routingTarget, FRONTIER, UNKNOWN_ROUTE } from "../src/homeserver/routing-table.js";

// ─── Data ───────────────────────────────────────────────────────────────────

interface Row {
  task_type: string;
  prompt_excerpt: string;
  source: string;
}

interface Classified extends Row {
  predicted: string;
  raw: string;
  fellBack: boolean;
}

const RESEARCH_ROLES = new Set([
  "research-plan",
  "source-distill",
  "claim-verify",
  "gap-check",
  "synthesis",
]);

function loadRows(): Row[] {
  const repoRoot = fileURLToPath(new URL("../", import.meta.url));
  const candidates = [
    join(process.cwd(), "data", "delegations-excerpts.jsonl"),
    join(repoRoot, "data", "delegations-excerpts.jsonl"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      return readFileSync(p, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Row);
    }
  }
  throw new Error("data/delegations-excerpts.jsonl not found");
}

// ─── Metrics ──────────────────────────────────────────────────────────────────

interface CutMetrics {
  label: string;
  n: number;
  top1: number; // correct top-1 count
  routed: number; // correct ROUTING count (same target)
  // scorable = rows whose GOLD type has a real route (model id or FRONTIER) — the routing-accuracy
  // denominator. outOfScope = rows whose gold type is absent from the table (UNKNOWN), e.g. the
  // deep-research pipeline roles, which are stage-assigned not content-classified; they are NOT
  // scored (an UNKNOWN gold has no "correct route", so crediting UNKNOWN==UNKNOWN would score a
  // classification failure as a routing success — the bug this guards against).
  scorable: number;
  outOfScope: number;
  // confusion: gold→predicted disagreements, split by routing-equivalence (scorable rows only)
  equivDisagreements: Map<string, number>; // same routing target (harmless)
  routingErrors: Map<string, number>; // different routing target (the residual)
  // gap-type (FRONTIER) recall
  gapTotal: number;
  gapRecalled: number;
}

function computeCut(label: string, rows: Classified[]): CutMetrics {
  const m: CutMetrics = {
    label,
    n: rows.length,
    top1: 0,
    routed: 0,
    scorable: 0,
    outOfScope: 0,
    equivDisagreements: new Map(),
    routingErrors: new Map(),
    gapTotal: 0,
    gapRecalled: 0,
  };
  for (const r of rows) {
    const goldTarget = routingTarget(r.task_type);
    const predTarget = routingTarget(r.predicted);
    if (r.predicted === r.task_type) m.top1++;

    // Routing accuracy is only defined where the GOLD type has a real route. Rows whose gold is
    // UNKNOWN (absent from the table — the pipeline-assigned deep-research roles) are out of scope:
    // counting predTarget===goldTarget when both are UNKNOWN would credit a classification failure
    // (model fell back to "other", also UNKNOWN) as a correct route.
    if (goldTarget === UNKNOWN_ROUTE) {
      m.outOfScope++;
    } else {
      m.scorable++;
      if (predTarget === goldTarget) m.routed++;
      if (r.predicted !== r.task_type) {
        const key = `${r.task_type} → ${r.predicted}`;
        if (predTarget === goldTarget) {
          m.equivDisagreements.set(key, (m.equivDisagreements.get(key) ?? 0) + 1);
        } else {
          m.routingErrors.set(key, (m.routingErrors.get(key) ?? 0) + 1);
        }
      }
      if (goldTarget === FRONTIER) {
        m.gapTotal++;
        if (predTarget === FRONTIER) m.gapRecalled++;
      }
    }
  }
  return m;
}

function pct(num: number, den: number): string {
  return den > 0 ? ((100 * num) / den).toFixed(1) + "%" : "—";
}

function printCut(m: CutMetrics, keywordTop1: number, gateEligible: boolean): void {
  console.log(`\n${"═".repeat(72)}`);
  console.log(`  ${m.label}  (n=${m.n})`);
  console.log("═".repeat(72));
  const kw = Number.isFinite(keywordTop1) ? keywordTop1.toFixed(1) + "%" : "—";
  console.log(`  top-1 task-type accuracy : ${m.top1}/${m.n} = ${pct(m.top1, m.n)}   (keyword baseline ${kw})`);
  // Routing accuracy is over SCORABLE rows (gold has a real route), not all rows — see computeCut.
  const routingPct = m.scorable > 0 ? (100 * m.routed) / m.scorable : NaN;
  const scopeNote = m.outOfScope > 0 ? `  (${m.outOfScope} rows out-of-scope: gold type not in routing table)` : "";
  console.log(`  ROUTING accuracy         : ${m.routed}/${m.scorable} = ${pct(m.routed, m.scorable)}   ← matches Gate B's purpose${scopeNote}`);
  if (gateEligible) {
    const gateRouting = m.scorable > 0 && routingPct >= 90;
    console.log(`     → ≥90% routing gate    : ${gateRouting ? "✅ PASS" : "❌ fail"}`);
  } else {
    console.log(`     → NOT gate-eligible (diagnostic cut; routing accuracy over scorable rows only)`);
  }
  if (m.gapTotal > 0) {
    const gapRec = (100 * m.gapRecalled) / m.gapTotal;
    console.log(`  gap-type recall (→FRONTIER): ${m.gapRecalled}/${m.gapTotal} = ${pct(m.gapRecalled, m.gapTotal)}   ${gapRec >= 98 ? "✅ ≥98%" : "❌ <98% (DANGEROUS)"}`);
  } else {
    console.log(`  gap-type recall (→FRONTIER): no escalation-type rows in this cut`);
  }

  const equivN = [...m.equivDisagreements.values()].reduce((a, b) => a + b, 0);
  const errN = [...m.routingErrors.values()].reduce((a, b) => a + b, 0);
  console.log(`\n  disagreements: ${equivN + errN} total = ${equivN} routing-EQUIVALENT (harmless) + ${errN} genuine routing errors`);

  if (m.routingErrors.size > 0) {
    console.log(`\n  GENUINE routing errors (gold → predicted), these change the model:`);
    [...m.routingErrors.entries()]
      .sort((a, b) => b[1] - a[1])
      .forEach(([k, v]) => {
        const [gold, pred] = k.split(" → ");
        console.log(`    ${String(v).padStart(3)}  ${k.padEnd(34)}  [${routingTarget(gold!)} → ${routingTarget(pred!)}]`);
      });
  }
  if (m.equivDisagreements.size > 0) {
    console.log(`\n  routing-equivalent disagreements (same model — harmless for routing):`);
    [...m.equivDisagreements.entries()]
      .sort((a, b) => b[1] - a[1])
      .forEach(([k, v]) => {
        const [gold] = k.split(" → ");
        console.log(`    ${String(v).padStart(3)}  ${k.padEnd(34)}  [both → ${routingTarget(gold!)}]`);
      });
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function classifyLive(rows: Row[], dumpPath?: string): Promise<Classified[]> {
  const baseUrl = process.env["MELLUM_BASE_URL"] ?? "http://localhost:8091/v1";
  const apiKey = process.env["MELLUM_API_KEY"] ?? "x";
  const model = process.env["MELLUM_MODEL"] ?? "mellum";
  console.log(`  LIVE mode: mellum @ ${baseUrl} model=${model}`);
  const chat: ChatFn = makeChatFn(baseUrl, apiKey, model);

  const out: Classified[] = [];
  let done = 0;
  for (const row of rows) {
    const res = await classifyTaskLLM(row.prompt_excerpt, chat);
    out.push({ ...row, predicted: res.taskType, raw: res.raw, fellBack: res.fellBack });
    done++;
    if (done % 50 === 0 || done === rows.length) process.stdout.write(`  classified ${done}/${rows.length}\r`);
  }
  process.stdout.write("\n");
  if (dumpPath) {
    writeFileSync(dumpPath, out.map((r) => JSON.stringify(r)).join("\n") + "\n");
    console.log(`  cached ${out.length} predictions → ${dumpPath} (replay offline with --replay)`);
  }
  return out;
}

function loadReplay(path: string): Classified[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Classified);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const replayIdx = args.indexOf("--replay");
  const dumpIdx = args.indexOf("--dump");
  const replayPath = replayIdx >= 0 ? args[replayIdx + 1] : undefined;
  const dumpPath = dumpIdx >= 0 ? args[dumpIdx + 1] : undefined;

  console.log("T2 / Gate-B ROUTING accuracy\n");

  const rows = loadRows();
  console.log(`  Loaded ${rows.length} rows from delegations-excerpts.jsonl`);

  const classified = replayPath
    ? (console.log(`  REPLAY mode: ${replayPath} (no box, offline)`), loadReplay(replayPath))
    : await classifyLive(rows, dumpPath);

  const fellBack = classified.filter((r) => r.fellBack).length;
  console.log(`  Keyword fallback fired on ${fellBack}/${classified.length} (${pct(fellBack, classified.length)})`);

  // Cuts: the generic cut (research roles excluded) is the Gate-B cut (== cartography here).
  const generic = classified.filter((r) => !RESEARCH_ROLES.has(r.task_type));
  const all = classified;

  // Keyword top-1 baselines (re-derived inline for transparency). Guarded against an empty cut
  // (NaN) — loadRows throws on a missing file, but a present-but-empty file or a degenerate filter
  // would otherwise surface "NaN%".
  const kwBaseline = (sub: Classified[]): number =>
    sub.length > 0 ? (100 * sub.filter((r) => classifyTask(r.prompt_excerpt).taskType === r.task_type).length) / sub.length : NaN;
  const kwGeneric = kwBaseline(generic);
  const kwAll = kwBaseline(all);

  // Only the GENERIC cut (every gold type has a route) is gate-eligible. The ALL cut includes
  // pipeline-assigned deep-research roles (no content route) → diagnostic only, no PASS/FAIL verdict.
  printCut(computeCut("GENERIC cut (research roles excluded) — the Gate-B cut", generic), kwGeneric, true);
  printCut(computeCut("ALL delegations (incl. deep-research roles)", all), kwAll, false);

  console.log(`\n${"═".repeat(72)}`);
  console.log("  Gate B = 'the router is trustworthy'. The safety criterion is gap-type recall");
  console.log("  (escalation types must reach FRONTIER); routing accuracy is the coverage metric.");
  console.log("  Routing-equivalent disagreements (e.g. regex→code-implement, both→mellum) do not");
  console.log("  affect either — they are top-1 noise, not routing failures.");
  console.log("  NOTE: gap-type recall currently covers exactly ONE escalation type (sql) — the only");
  console.log("  FRONTIER route in m5-routing.json; it widens as more escalation types are characterized.");
  console.log("═".repeat(72) + "\n");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
