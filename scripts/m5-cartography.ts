#!/usr/bin/env tsx
/**
 * m5-cartography.ts — overnight probe battery for all local models on the M5.
 *
 * Maps every local model against the deterministic probe battery (PROBES from
 * src/homeserver/probes.ts) PLUS 6 harder ceiling-finding probes defined inline.
 * Results are appended to a JSONL log and every verified outcome is recorded to
 * the capability ledger (src/homeserver/ledger.ts).
 *
 * USAGE
 *   HS_API_KEY=<owner-bearer-key> tsx scripts/m5-cartography.ts [runId]
 *
 * ENV (all optional except HS_API_KEY)
 *   HS_API_KEY          Required. Owner Bearer key for the gateway.
 *   GATEWAY_URL         Default: http://127.0.0.1:8080/v1
 *   MODELS              Comma-separated model ids. Default: mellum,gemma4,qwen35-a3b,qwen3-coder-next-80b
 *   REPEATS             How many times each (model,probe) is run. Default: 3
 *   OUT                 JSONL output path. Default: ./data/cartography-<runId>.jsonl
 *   LOG                 Progress log file. Default: ./data/cartography-<runId>.log
 *   EVAL_DB_PATH        SQLite DB used by the ledger. Default: ./data/eval.db
 *
 * RESUME
 *   Re-running with the same OUT file skips any (model, probeId, repeat) already
 *   present in the JSONL. The runId must match (pass it as the first CLI arg, or
 *   derive it from the filename: cartography-<runId>.jsonl).
 *
 * JSONL SCHEMA (one line per run):
 *   { ts, runId, model, probeId, taskType, verifierName, repeat,
 *     outcome, score, notes,
 *     latencyMs, promptTokens, completionTokens, tokPerSec, reasoningChars,
 *     contentChars, outputPreview }
 */

import { appendFileSync, createWriteStream, existsSync, readFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

// ── Import real probe battery and verifiers ──────────────────────────────────────
import { PROBES, type Probe } from "../src/homeserver/probes.js";
import {
  tsGate,
  jsonValid,
  all,
  predicate,
  numeric,
  containsAll,
  answerIs,
  matches,
  maxLength,
  nonEmpty,
} from "../src/homeserver/verifier.js";
import { recordDelegation } from "../src/homeserver/ledger.js";

// ── Config ────────────────────────────────────────────────────────────────────────

const GATEWAY_URL = (process.env["GATEWAY_URL"] ?? "http://127.0.0.1:8080/v1").replace(/\/$/, "");
const HS_API_KEY = process.env["HS_API_KEY"] ?? "";
if (!HS_API_KEY) {
  console.error("ERROR: HS_API_KEY env var is required (owner Bearer key for the gateway).");
  process.exit(1);
}

const DEFAULT_MODELS = ["mellum", "gemma4", "qwen35-a3b", "qwen3-coder-next-80b"];
const MODELS: string[] = (process.env["MODELS"] ?? "").trim()
  ? process.env["MODELS"]!.split(",").map((s) => s.trim()).filter(Boolean)
  : DEFAULT_MODELS;

const REPEATS = Number(process.env["REPEATS"] ?? "3");
const PER_CALL_TIMEOUT_MS = 180_000;

// runId: CLI arg > env > timestamp
const runId: string = process.argv[2] ?? process.env["RUN_ID"] ?? `${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;

const dataDir = resolve("./data");
mkdirSync(dataDir, { recursive: true });

const OUT = process.env["OUT"] ?? resolve(dataDir, `cartography-${runId}.jsonl`);
const LOG = process.env["LOG"] ?? resolve(dataDir, `cartography-${runId}.log`);

// ── 6 extra harder ceiling-finding probes ─────────────────────────────────────────

const EXTRA_PROBES: Probe[] = [
  // (a) Algorithmic code via tsGate — longestCommonPrefix
  {
    id: "hard-algo-lcp",
    taskType: "code-implement",
    prompt:
      "Implement and export a TypeScript function `longestCommonPrefix(strs: string[]): string` " +
      "that returns the longest string that is a prefix of ALL strings in the input array. " +
      "Return an empty string if the array is empty or there is no common prefix.",
    maxTokens: 12288,
    verifier: tsGate({
      harness: [
        "const eq=(a:string,b:string)=>{ if(a!==b) throw new Error(JSON.stringify(a)+' !== '+JSON.stringify(b)); };",
        "eq(longestCommonPrefix(['flower','flow','flight']),'fl');",
        "eq(longestCommonPrefix(['dog','racecar','car']),'');",
        "eq(longestCommonPrefix([]),'');",
        "eq(longestCommonPrefix(['alone']),'alone');",
        "eq(longestCommonPrefix(['ab','a']),'a');",
      ].join("\n"),
    }),
    verifierName: "tsGate",
  },

  // (b) Debugging — fix a broken binary search
  {
    id: "hard-debug-bsearch",
    taskType: "code-implement",
    prompt:
      "The following TypeScript function has a bug that causes it to loop forever on some inputs. " +
      "Fix it and export the corrected function:\n\n" +
      "```typescript\n" +
      "export function binarySearch(arr: number[], target: number): number {\n" +
      "  let lo = 0, hi = arr.length - 1;\n" +
      "  while (lo <= hi) {\n" +
      "    const mid = Math.floor((lo + hi) / 2);\n" +
      "    if (arr[mid] === target) return mid;\n" +
      "    if (arr[mid]! < target) lo = mid;   // BUG: should be mid + 1\n" +
      "    else hi = mid - 1;\n" +
      "  }\n" +
      "  return -1;\n" +
      "}\n" +
      "```\n\n" +
      "Return only the corrected TypeScript code.",
    maxTokens: 12288,
    verifier: tsGate({
      harness: [
        "const eq=(a:number,b:number)=>{ if(a!==b) throw new Error(a+' !== '+b); };",
        "eq(binarySearch([1,3,5,7,9],7),3);",
        "eq(binarySearch([1,3,5,7,9],1),0);",
        "eq(binarySearch([1,3,5,7,9],9),4);",
        "eq(binarySearch([1,3,5,7,9],4),-1);",
        "eq(binarySearch([],5),-1);",
      ].join("\n"),
    }),
    verifierName: "tsGate",
  },

  // (c) Stricter nested JSON extraction with schema check
  {
    id: "hard-json-nested",
    taskType: "data-transform",
    prompt:
      "Convert the following data to JSON. Return ONLY a JSON object with this exact shape:\n" +
      '{ "user": { "id": <number>, "name": <string>, "roles": [<string>, ...] } }\n\n' +
      "Data: User ID is 42, name is 'Diana Prince', roles are admin and editor.",
    maxTokens: 2048,
    verifier: jsonValid((v) => {
      if (typeof v !== "object" || v === null || Array.isArray(v)) return "not an object";
      const obj = v as Record<string, unknown>;
      const user = obj["user"];
      if (typeof user !== "object" || user === null || Array.isArray(user)) return "missing .user object";
      const u = user as Record<string, unknown>;
      if (u["id"] !== 42) return `expected id=42, got ${JSON.stringify(u["id"])}`;
      if (u["name"] !== "Diana Prince") return `expected name='Diana Prince', got ${JSON.stringify(u["name"])}`;
      const roles = u["roles"];
      if (!Array.isArray(roles) || roles.length < 2) return "roles must be an array with ≥2 items";
      const rs = roles.map((r) => String(r).toLowerCase());
      if (!rs.includes("admin")) return "roles must include 'admin'";
      if (!rs.includes("editor")) return "roles must include 'editor'";
      return true;
    }),
    verifierName: "jsonValid+schema",
  },

  // (d) 3-constraint instruction following
  {
    id: "hard-3-constraint",
    taskType: "rewrite",
    prompt:
      "Write a product tagline for a project management tool that satisfies ALL THREE of these constraints:\n" +
      "1. Exactly 8 words\n" +
      "2. Contains the word 'team'\n" +
      "3. Ends with an exclamation mark\n\n" +
      "Return only the tagline.",
    maxTokens: 512,
    verifier: all([
      predicate((o) => {
        const words = o.trim().split(/\s+/).filter(Boolean);
        return words.length === 8;
      }, "exactly-8-words"),
      matches(/\bteam\b/i, "contains-team"),
      predicate((o) => o.trim().endsWith("!"), "ends-with-exclamation"),
    ]),
    verifierName: "all(8-words,team,exclamation)",
  },

  // (e) Harder word problem (numeric)
  {
    id: "hard-math-compound",
    taskType: "reason-math",
    prompt:
      "A store sells 3 product types. Type A costs $12 and 40 units are sold. " +
      "Type B costs $7.50 and 85 units are sold. Type C costs $25 and 16 units are sold. " +
      "What is the total revenue? Answer with the number only (no $ sign, no commas).",
    maxTokens: 2048,
    verifier: numeric(
      40 * 12 + 85 * 7.5 + 16 * 25, // = 480 + 637.5 + 400 = 1517.5
      0.01
    ),
    verifierName: "numeric",
  },

  // (f) SQL with JOIN + GROUP BY + HAVING
  {
    id: "hard-sql-join-having",
    taskType: "sql",
    prompt:
      "Write a SQL query that returns the department name and average salary for all departments " +
      "where the average salary exceeds 60000, given tables:\n" +
      "  employees(id, name, department_id, salary)\n" +
      "  departments(id, name)\n" +
      "Include only departments that have at least 3 employees.\n" +
      "Order by average salary descending.\n" +
      "Return only SQL.",
    maxTokens: 2048,
    verifier: all([
      containsAll(["select", "from", "join", "group by", "having", "order by"], { ci: true }),
      matches(/avg\s*\(\s*salary\s*\)/i, "avg(salary)"),
      matches(/60000|60,000/i, "salary-threshold"),
      matches(/count\s*\(\s*\*\s*\)|count\s*\(\s*[a-z]+\s*\)/i, "employee-count"),
    ]),
    verifierName: "containsAll+matches",
  },
];

const ALL_PROBES: Probe[] = [...PROBES, ...EXTRA_PROBES];

// ── JSONL result type ─────────────────────────────────────────────────────────────

interface CartographyResult {
  ts: string;
  runId: string;
  model: string;
  probeId: string;
  taskType: string;
  verifierName: string;
  repeat: number;
  outcome: string;
  score: number | null;
  notes: string | null;
  latencyMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  tokPerSec: number | null;
  reasoningChars: number | null;
  contentChars: number | null;
  outputPreview: string | null;
}

// ── Resume: load already-completed (model, probeId, repeat) tuples ───────────────

function loadCompleted(outPath: string): Set<string> {
  const done = new Set<string>();
  if (!existsSync(outPath)) return done;
  const lines = readFileSync(outPath, "utf-8").split("\n").filter(Boolean);
  for (const line of lines) {
    try {
      const r = JSON.parse(line) as Partial<CartographyResult>;
      if (r.model && r.probeId && r.repeat !== undefined) {
        done.add(`${r.model}|${r.probeId}|${r.repeat}`);
      }
    } catch {
      // corrupt line — skip
    }
  }
  return done;
}

// ── Logging ───────────────────────────────────────────────────────────────────────

const logStream = createWriteStream(LOG, { flags: "a" });

function logLine(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}`;
  process.stderr.write(line + "\n");
  logStream.write(line + "\n");
}

function appendResult(outPath: string, r: CartographyResult): void {
  appendFileSync(outPath, JSON.stringify(r) + "\n", "utf-8");
}

// ── Gateway call ──────────────────────────────────────────────────────────────────

interface GatewayResponse {
  choices: Array<{
    message: {
      content: string;
      reasoning_content?: string;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
  timings?: {
    predicted_per_second?: number;
  };
}

async function callGateway(
  model: string,
  probe: Probe
): Promise<{
  output: string;
  reasoningChars: number | null;
  latencyMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
  tokPerSec: number | null;
}> {
  const messages: Array<{ role: string; content: string }> = [];
  if (probe.systemPrompt) {
    messages.push({ role: "system", content: probe.systemPrompt });
  }
  messages.push({ role: "user", content: probe.prompt });

  const body = JSON.stringify({
    model,
    messages,
    max_tokens: probe.maxTokens ?? 2048,
    temperature: 0,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PER_CALL_TIMEOUT_MS);
  const t0 = Date.now();
  let resp: Response;
  try {
    resp = await fetch(`${GATEWAY_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${HS_API_KEY}`,
      },
      body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  const latencyMs = Date.now() - t0;

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "(unreadable)");
    throw new Error(`HTTP ${resp.status}: ${errText.slice(0, 200)}`);
  }

  const data = (await resp.json()) as GatewayResponse;
  const msg = data.choices[0]?.message;
  if (!msg) throw new Error("No choices in response");

  const output = msg.content ?? "";
  const reasoningChars = msg.reasoning_content != null ? msg.reasoning_content.length : null;
  const promptTokens = data.usage?.prompt_tokens ?? null;
  const completionTokens = data.usage?.completion_tokens ?? null;

  let tokPerSec: number | null = null;
  if (data.timings?.predicted_per_second != null) {
    tokPerSec = data.timings.predicted_per_second;
  } else if (completionTokens != null && latencyMs > 0) {
    tokPerSec = Math.round((completionTokens / (latencyMs / 1000)) * 10) / 10;
  }

  return { output, reasoningChars, latencyMs, promptTokens, completionTokens, tokPerSec };
}

// ── Per-model stats tracker ───────────────────────────────────────────────────────

interface ModelStats {
  total: number;
  pass: number;
  partial: number;
  fail: number;
  error: number;
  tokPerSecSum: number;
  tokPerSecCount: number;
}

function freshStats(): ModelStats {
  return { total: 0, pass: 0, partial: 0, fail: 0, error: 0, tokPerSecSum: 0, tokPerSecCount: 0 };
}

function passRate(s: ModelStats): string {
  if (s.total === 0) return "—";
  return ((s.pass / s.total) * 100).toFixed(1) + "%";
}

function avgTokPerSec(s: ModelStats): string {
  if (s.tokPerSecCount === 0) return "—";
  return (s.tokPerSecSum / s.tokPerSecCount).toFixed(1);
}

// ── Main ──────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const totalRuns = MODELS.length * ALL_PROBES.length * REPEATS;

  logLine(`=== m5-cartography run ${runId} ===`);
  logLine(`Gateway: ${GATEWAY_URL}`);
  logLine(`Models (${MODELS.length}): ${MODELS.join(", ")}`);
  logLine(`Probes (${ALL_PROBES.length}): ${PROBES.length} standard + ${EXTRA_PROBES.length} extra`);
  logLine(`Repeats: ${REPEATS}  |  Total runs: ${totalRuns}`);
  logLine(`Output: ${OUT}`);

  const completed = loadCompleted(OUT);
  if (completed.size > 0) {
    logLine(`Resume: ${completed.size} run(s) already in log — skipping.`);
  }

  // Per-model stats for the end summary
  const statsPerModel: Record<string, ModelStats> = {};
  // Per-(model, taskType) pass counts for the grid
  const gridPass: Record<string, Record<string, number>> = {};
  const gridTotal: Record<string, Record<string, number>> = {};

  let grandTotal = 0;

  // OUTER loop = MODEL (group to minimize llama-swap swaps)
  for (const model of MODELS) {
    const stats = freshStats();
    statsPerModel[model] = stats;
    gridPass[model] = {};
    gridTotal[model] = {};

    logLine(`\n── model: ${model} ──`);

    for (const probe of ALL_PROBES) {
      for (let rep = 1; rep <= REPEATS; rep++) {
        const key = `${model}|${probe.id}|${rep}`;
        if (completed.has(key)) {
          logLine(`  [skip] ${probe.id} #${rep}`);
          stats.total++;
          grandTotal++;
          continue;
        }

        const ts = new Date().toISOString();
        let result: CartographyResult;

        try {
          const call = await callGateway(model, probe);
          const vr = await probe.verifier(call.output);

          result = {
            ts,
            runId,
            model,
            probeId: probe.id,
            taskType: probe.taskType,
            verifierName: probe.verifierName,
            repeat: rep,
            outcome: vr.outcome,
            score: vr.score,
            notes: vr.notes ?? null,
            latencyMs: call.latencyMs,
            promptTokens: call.promptTokens,
            completionTokens: call.completionTokens,
            tokPerSec: call.tokPerSec,
            reasoningChars: call.reasoningChars,
            contentChars: call.output.length,
            outputPreview: call.output.slice(0, 200),
          };
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          result = {
            ts,
            runId,
            model,
            probeId: probe.id,
            taskType: probe.taskType,
            verifierName: probe.verifierName,
            repeat: rep,
            outcome: "error",
            score: 0,
            notes: msg.slice(0, 300),
            latencyMs: null,
            promptTokens: null,
            completionTokens: null,
            tokPerSec: null,
            reasoningChars: null,
            contentChars: null,
            outputPreview: null,
          };
        }

        // Append to JSONL
        appendResult(OUT, result);

        // Record to ledger (best-effort — don't abort the battery on a DB error)
        try {
          recordDelegation({
            taskType: probe.taskType,
            modelId: model,
            prompt: probe.prompt,
            outcome: result.outcome as Parameters<typeof recordDelegation>[0]["outcome"],
            score: result.score ?? undefined,
            latencyMs: result.latencyMs ?? undefined,
            promptTokens: result.promptTokens ?? undefined,
            completionTokens: result.completionTokens ?? undefined,
            tokPerSec: result.tokPerSec ?? undefined,
            verifier: probe.verifierName,
            source: "m5-cartography",
            notes: result.notes ?? undefined,
          });
        } catch (ledgerErr) {
          logLine(`  [ledger-err] ${String(ledgerErr).slice(0, 120)}`);
        }

        // Update stats
        stats.total++;
        if (result.outcome === "pass") stats.pass++;
        else if (result.outcome === "partial") stats.partial++;
        else if (result.outcome === "fail") stats.fail++;
        else stats.error++;

        if (result.tokPerSec != null) {
          stats.tokPerSecSum += result.tokPerSec;
          stats.tokPerSecCount++;
        }

        // Update grid
        gridTotal[model]![probe.taskType] = (gridTotal[model]![probe.taskType] ?? 0) + 1;
        if (result.outcome === "pass") {
          gridPass[model]![probe.taskType] = (gridPass[model]![probe.taskType] ?? 0) + 1;
        }

        grandTotal++;
        const tokStr = result.tokPerSec != null ? `${result.tokPerSec.toFixed(1)} tok/s` : "—";
        const msStr = result.latencyMs != null ? `${result.latencyMs}ms` : "—";
        logLine(
          `  [${model}] ${probe.id} #${rep} → ${result.outcome.padEnd(8)} (${tokStr}, ${msStr})  pass-rate so far: ${passRate(stats)}`
        );
      }
    }

    logLine(
      `\n  Model ${model} done. Pass: ${stats.pass}/${stats.total}  Partial: ${stats.partial}  Fail: ${stats.fail}  Error: ${stats.error}  avg tok/s: ${avgTokPerSec(stats)}`
    );
  }

  // ── End summary ──────────────────────────────────────────────────────────────────

  const divider = "─".repeat(72);
  const lines: string[] = [
    "",
    divider,
    `m5-cartography ${runId} — END SUMMARY`,
    divider,
    "",
    "Per-model overall:",
    "",
  ];

  const colW = 28;
  const header = [
    "Model".padEnd(colW),
    "Pass".padStart(6),
    "Partial".padStart(8),
    "Fail".padStart(6),
    "Error".padStart(6),
    "Pass%".padStart(7),
    "Avg tok/s".padStart(10),
  ].join("  ");
  lines.push(header);
  lines.push("─".repeat(header.length));

  for (const model of MODELS) {
    const s = statsPerModel[model]!;
    lines.push(
      [
        model.padEnd(colW),
        String(s.pass).padStart(6),
        String(s.partial).padStart(8),
        String(s.fail).padStart(6),
        String(s.error).padStart(6),
        passRate(s).padStart(7),
        avgTokPerSec(s).padStart(10),
      ].join("  ")
    );
  }

  // Grid: model × task_type pass-rate
  const allTaskTypes = [...new Set(ALL_PROBES.map((p) => p.taskType))];
  lines.push("");
  lines.push("Model × task_type pass-rate grid:");
  lines.push("");

  const ttColW = 22;
  const modelColW = 14;
  const gridHeader =
    "".padEnd(ttColW) + MODELS.map((m) => m.slice(0, modelColW).padStart(modelColW + 2)).join("");
  lines.push(gridHeader);
  lines.push("─".repeat(gridHeader.length));

  for (const tt of allTaskTypes) {
    let row = tt.padEnd(ttColW);
    for (const model of MODELS) {
      const total = gridTotal[model]?.[tt] ?? 0;
      const pass = gridPass[model]?.[tt] ?? 0;
      const cell = total === 0 ? "—" : `${pass}/${total}`;
      row += cell.padStart(modelColW + 2);
    }
    lines.push(row);
  }

  lines.push("");
  lines.push(`Total runs completed: ${grandTotal}  (target: ${totalRuns})`);
  lines.push(`JSONL results: ${OUT}`);
  lines.push(`Progress log:  ${LOG}`);
  lines.push(divider);

  const summary = lines.join("\n");
  process.stdout.write(summary + "\n");
  logLine(summary);

  logStream.end();
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
