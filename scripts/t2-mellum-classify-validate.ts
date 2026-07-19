/**
 * T2 Gate-B validation: mellum-backed classifyTaskLLM vs keyword baseline.
 *
 * Reads data/delegations-excerpts.jsonl (608 rows: {task_type, prompt_excerpt, source})
 * which is the ground-truth corpus for T2 (same set used by t2-classifier-on-delegations.ts).
 *
 * For each row, calls classifyTaskLLM(excerpt, mellumChat) and compares the prediction to
 * the recorded task_type. Reports three cuts for apples-to-apples vs the keyword baseline:
 *
 *   ALL           — all 608 rows including deep-research pipeline roles
 *   cartography   — source === "m5-cartography" (generic imperative sub-tasks, the mcp-ask proxy)
 *   generic-only  — research roles excluded (research-plan, source-distill, etc.)
 *
 * For each cut: overall accuracy, per-type recall, top disagreements, sql safety analysis
 * (the dangerous sql→code-implement misroute the keyword classifier makes 100% of the time).
 *
 * --mock / MOCK=1:  runs with a canned ChatFn (no network, no box) to prove plumbing works.
 *
 * Real box validation command (after port-forward to llama-swap on M5):
 *   ssh -L 8091:localhost:8091 m5 -N &
 *   MELLUM_BASE_URL=http://localhost:8091/v1 tsx scripts/t2-mellum-classify-validate.ts
 *
 * IMPORTANT: do NOT run without the --mock flag unless a port-forward to m5 is active.
 * No OpenRouter credits are used — mellum is a free local model.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChatFn } from "../src/homeserver/deep-research-types.js";
import { makeChatFn } from "../src/homeserver/deep-research-cli.js";
import { classifyTaskLLM, GENERIC_TASK_TYPES } from "../src/homeserver/task-classifier-llm.js";
import { classifyTask } from "../src/homeserver/taxonomy.js";

// ─── Data loading ─────────────────────────────────────────────────────────────

interface Row {
  task_type: string;
  prompt_excerpt: string;
  source: string;
}

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
  throw new Error(
    "data/delegations-excerpts.jsonl not found. " +
      "Tried:\n  " +
      candidates.join("\n  ")
  );
}

// ─── Mock ChatFn ──────────────────────────────────────────────────────────────

/**
 * Canned ChatFn for --mock mode.
 * Returns a deterministic response based on simple keyword heuristics so the
 * plumbing (parse + aggregate) can be tested end-to-end without a box.
 *
 * This is NOT the mellum model — it's a dev-time smoke-test substitute.
 */
function makeMockChatFn(): ChatFn {
  return async (req) => {
    const prompt = req.prompt.toLowerCase();
    // Very simple: pull the task_type from the prompt itself (mock only—the real corpus
    // line includes the category label so we can simulate near-perfect accuracy).
    // For mock mode, use the keyword fallback classifier on the last paragraph of the prompt.
    const lines = req.prompt.split("\n");
    const lastParagraph = lines.slice(-3).join(" ");
    const kwResult = classifyTask(lastParagraph);
    // For mock, just return the keyword result so the script exercises all code paths.
    const text = kwResult.taskType;
    return {
      text,
      promptTokens: req.prompt.length / 4,
      completionTokens: text.length,
      model: "mock-keyword-proxy",
    };
  };
}

// ─── Reporting ────────────────────────────────────────────────────────────────

interface SubsetResult {
  label: string;
  n: number;
  agree: number;
  perType: Map<string, { n: number; agree: number }>;
  disagreements: Map<string, number>;
  sqlRows: { recorded: string; predicted: string }[];
}

function printReport(r: SubsetResult, keywordBaseline: number): void {
  const acc = r.n > 0 ? (100 * r.agree) / r.n : 0;
  console.log(`\n${"═".repeat(68)}`);
  console.log(`  ${r.label}`);
  console.log(`${"═".repeat(68)}`);
  console.log(`  Overall accuracy:  ${r.agree}/${r.n} = ${acc.toFixed(1)}%`);
  console.log(`  Keyword baseline:  ${keywordBaseline.toFixed(1)}%`);
  const delta = acc - keywordBaseline;
  const sign = delta >= 0 ? "+" : "";
  console.log(`  Delta vs keyword:  ${sign}${delta.toFixed(1)} pp`);

  console.log("\n  Per recorded task_type recall:");
  [...r.perType.entries()]
    .sort((a, b) => b[1].n - a[1].n)
    .forEach(([k, v]) => {
      const pct = v.n > 0 ? ((100 * v.agree) / v.n).toFixed(0) + "%" : "—";
      console.log(
        `    ${k.padEnd(20)} ${String(v.agree).padStart(3)}/${String(v.n).padStart(3)}  ${pct}`
      );
    });

  console.log("\n  Top disagreements (mellum predicted → recorded):");
  [...r.disagreements.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .forEach(([k, v]) => console.log(`    ${String(v).padStart(3)}  ${k}`));

  // SQL safety analysis — the dangerous misroute
  if (r.sqlRows.length > 0) {
    const sqlN = r.sqlRows.length;
    const sqlCorrect = r.sqlRows.filter((x) => x.predicted === "sql").length;
    const sqlMisroutedToLocal = r.sqlRows.filter(
      (x) => x.predicted === "code-implement" || x.predicted === "code-edit"
    ).length;
    const sqlRecall = (100 * sqlCorrect) / sqlN;
    console.log(`\n  SQL safety analysis (the dangerous misroute):`);
    console.log(`    sql rows in subset:             ${sqlN}`);
    console.log(`    sql correctly classified:       ${sqlCorrect}/${sqlN} = ${sqlRecall.toFixed(1)}% recall`);
    console.log(`    sql mislabeled as code-*:       ${sqlMisroutedToLocal} (keyword baseline: 100%)`);
    const otherMisroutes = r.sqlRows.filter(
      (x) => x.predicted !== "sql" && x.predicted !== "code-implement" && x.predicted !== "code-edit"
    );
    if (otherMisroutes.length > 0) {
      const grouped = new Map<string, number>();
      for (const row of otherMisroutes) {
        grouped.set(row.predicted, (grouped.get(row.predicted) ?? 0) + 1);
      }
      console.log(`    other misroutes:                ${[...grouped.entries()].map(([k, v]) => `${k}(${v})`).join(", ")}`);
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const mockMode = args.includes("--mock") || process.env["MOCK"] === "1";

  console.log("T2 mellum classifier validation");
  console.log(mockMode ? "  Mode: MOCK (no network)" : "  Mode: LIVE (mellum on M5)");
  console.log();

  // Build ChatFn
  let chat: ChatFn;
  if (mockMode) {
    chat = makeMockChatFn();
    console.log("  ChatFn: mock keyword-proxy (proves plumbing, not mellum accuracy)");
  } else {
    const baseUrl = process.env["MELLUM_BASE_URL"] ?? "http://localhost:8091/v1";
    const apiKey = process.env["MELLUM_API_KEY"] ?? "x";
    const model = process.env["MELLUM_MODEL"] ?? "mellum";
    console.log(`  ChatFn: mellum @ ${baseUrl} model=${model}`);
    chat = makeChatFn(baseUrl, apiKey, model);
  }

  // Load data
  const rows = loadRows();
  console.log(`  Loaded ${rows.length} rows from delegations-excerpts.jsonl\n`);

  const researchRoles = new Set([
    "research-plan",
    "source-distill",
    "claim-verify",
    "gap-check",
    "synthesis",
  ]);

  // Define the three subsets (matching t2-classifier-on-delegations.ts cuts)
  const subsets: Array<{ label: string; filter: (r: Row) => boolean }> = [
    { label: "ALL delegations (incl. deep-research roles)", filter: () => true },
    {
      label: "cartography only (generic imperative sub-tasks — the mcp-ask proxy)",
      filter: (r) => r.source === "m5-cartography",
    },
    {
      label: "generic task types only (research roles excluded)",
      filter: (r) => !researchRoles.has(r.task_type),
    },
  ];

  // Keyword baseline accuracies (from t2-classifier-on-delegations.ts — hardcoded for comparison)
  // ALL: 34.5%, cartography: 50.0%, generic: 44.3%  (re-derive inline for transparency)
  const keywordBaselines = subsets.map(({ filter }) => {
    const sub = rows.filter(filter);
    const correct = sub.filter((r) => classifyTask(r.prompt_excerpt).taskType === r.task_type).length;
    return sub.length > 0 ? (100 * correct) / sub.length : 0;
  });

  // Classify each row once (collect results, then report per subset)
  console.log("Classifying rows" + (mockMode ? " (mock)" : "") + "...");
  interface Classified extends Row {
    predicted: string;
    fellBack: boolean;
  }
  const classified: Classified[] = [];
  let done = 0;
  for (const row of rows) {
    const result = await classifyTaskLLM(row.prompt_excerpt, chat);
    classified.push({ ...row, predicted: result.taskType, fellBack: result.fellBack });
    done++;
    if (done % 100 === 0 || done === rows.length) {
      process.stdout.write(`  ${done}/${rows.length}\r`);
    }
  }
  process.stdout.write("\n");

  const fellBackCount = classified.filter((r) => r.fellBack).length;
  console.log(
    `  Fell back to keyword classifier: ${fellBackCount}/${rows.length} ` +
      `(${((100 * fellBackCount) / rows.length).toFixed(1)}%)`
  );

  // Report per subset
  for (let i = 0; i < subsets.length; i++) {
    const { label, filter } = subsets[i];
    const sub = classified.filter(filter);

    const result: SubsetResult = {
      label,
      n: sub.length,
      agree: 0,
      perType: new Map(),
      disagreements: new Map(),
      sqlRows: [],
    };

    for (const r of sub) {
      const ok = r.predicted === r.task_type;
      if (ok) result.agree++;

      const pc = result.perType.get(r.task_type) ?? { n: 0, agree: 0 };
      pc.n++;
      if (ok) pc.agree++;
      result.perType.set(r.task_type, pc);

      if (!ok) {
        const key = `${r.predicted} → ${r.task_type}`;
        result.disagreements.set(key, (result.disagreements.get(key) ?? 0) + 1);
      }

      if (r.task_type === "sql") {
        result.sqlRows.push({ recorded: r.task_type, predicted: r.predicted });
      }
    }

    printReport(result, keywordBaselines[i]);
  }

  console.log(`\n${"═".repeat(68)}`);
  console.log("  NOTE: offline ledger re-derivation (applying this classifier to fix");
  console.log("  live delegations telemetry) is a separate follow-up requiring a schema");
  console.log("  decision (new task_type_llm column vs overwrite). Not implemented here.");
  console.log(`${"═".repeat(68)}\n`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
