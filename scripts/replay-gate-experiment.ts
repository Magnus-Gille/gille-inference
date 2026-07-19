/**
 * replay-gate-experiment.ts — the POWERED, real-data version of the cascade-gate experiment.
 *
 * Replays REAL owner sub-tasks (from owner_request_log) through mellum + qwen3-coder-next-80b
 * (free, local) + a frontier model (the escalation target, metered), and asks: does cheap
 * cross-model disagreement (mellum vs qwen) predict when escalating to frontier would actually
 * change the answer? Ground truth is JUDGE-FREE: "mellum diverged from frontier" (answer-level),
 * a proxy for "escalation is worth it" — honest caveat: divergence ≠ wrong for open-ended tasks
 * (frontier isn't always right, equivalent answers differ), but it's the practical signal a gate
 * needs and it uses REAL task distribution + real volume (no brittle hand golds).
 *
 * Run ON the box (owner_request_log + llama-swap are local; frontier via OpenRouter):
 *   EVAL_DB_PATH=data/eval.db LOCAL_URL=http://127.0.0.1:8091/v1 \
 *   FRONTIER_KEY=$RESEARCH_HYBRID_API_KEY FRONTIER_MODEL=anthropic/claude-opus-4-5 \
 *     tsx scripts/replay-gate-experiment.ts --limit 60 --out data/replay-gate [--smoke]
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import {
  disagreementScore,
  auroc,
  offloadCurve,
  minFrontierForAccuracy,
} from "./cascade-gate-experiment.js";

const LOCAL_URL = process.env["LOCAL_URL"] ?? "http://127.0.0.1:8091/v1";
const FRONTIER_URL = "https://openrouter.ai/api/v1";
const FRONTIER_KEY = process.env["FRONTIER_KEY"] ?? "";
const FRONTIER_MODEL = process.env["FRONTIER_MODEL"] ?? "anthropic/claude-opus-4-5";
const PRIMARY = process.env["PRIMARY_MODEL"] ?? "mellum";
const SECONDARY = process.env["SECONDARY_MODEL"] ?? "qwen3-coder-next-80b";
const DB_PATH = process.env["EVAL_DB_PATH"] ?? "data/eval.db";
const CALL_TIMEOUT_MS = Number(process.env["CALL_TIMEOUT_MS"] ?? 180000);
const DIVERGENCE_THRESHOLD = Number(process.env["DIVERGENCE_THRESHOLD"] ?? 0.5);

interface ChatMsg { role: string; content: string }

async function chat(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: ChatMsg[],
  maxTokens: number,
): Promise<string> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), CALL_TIMEOUT_MS);
  try {
    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0 }),
      signal: ac.signal,
    });
    if (!resp.ok) throw new Error(`${model} HTTP ${resp.status}: ${(await resp.text()).slice(0, 160)}`);
    const data = (await resp.json()) as { choices: { message: { content: string } }[] };
    return data.choices[0]?.message?.content ?? "";
  } finally {
    clearTimeout(timer);
  }
}

/** Coerce historical messages to valid {system|user|assistant, string} — drop tool-calls,
 *  null content, unknown roles — so a malformed old row can't error the API call. */
function sanitizeMessages(msgs: ChatMsg[]): ChatMsg[] {
  const ok: ChatMsg[] = [];
  for (const m of msgs) {
    if (!m || typeof m.content !== "string" || !m.content.trim()) continue;
    const role = m.role === "system" || m.role === "assistant" ? m.role : "user";
    ok.push({ role, content: m.content });
  }
  return ok;
}

/** Pull a deduped sample of real single-turn-ish owner sub-tasks with usable inputs. */
function loadTasks(limit: number): { id: number; messages: ChatMsg[]; servedModel: string }[] {
  const db = new Database(DB_PATH, { readonly: true });
  const rows = db
    .prepare(
      `SELECT id, messages_json, model, completion_tokens
       FROM owner_request_log
       WHERE messages_json IS NOT NULL AND length(messages_json) BETWEEN 40 AND 8000
       ORDER BY id DESC`,
    )
    .all() as { id: number; messages_json: string; model: string }[];
  // First collect ALL eligible+deduped tasks, then stride-sample evenly across the full history
  // for diversity (avoid over-representing the most recent / this-session traffic).
  const eligible: { id: number; messages: ChatMsg[]; servedModel: string }[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    let msgs: ChatMsg[];
    try {
      msgs = JSON.parse(r.messages_json) as ChatMsg[];
    } catch {
      continue;
    }
    if (!Array.isArray(msgs) || msgs.length === 0) continue;
    const lastUser = [...msgs].reverse().find((m) => m.role === "user");
    if (!lastUser || typeof lastUser.content !== "string" || lastUser.content.trim().length < 20) continue;
    const key = lastUser.content.slice(0, 300);
    if (seen.has(key)) continue;
    seen.add(key);
    eligible.push({ id: r.id, messages: msgs, servedModel: r.model });
  }
  db.close();
  if (eligible.length <= limit) return eligible;
  const step = eligible.length / limit;
  const out: { id: number; messages: ChatMsg[]; servedModel: string }[] = [];
  for (let i = 0; i < limit; i++) out.push(eligible[Math.floor(i * step)]!);
  return out;
}

interface Row {
  id: number;
  servedModel: string;
  primaryOut: string;
  secondaryOut: string;
  frontierOut: string;
  disagreement: number; // mellum vs qwen (the cheap gate signal)
  divergedFromFrontier: number; // mellum vs frontier (ground-truth proxy: 1 = escalation changes answer)
  selfUncertainty: number;
  error?: string;
}

async function selfConfidence(task: ChatMsg[], answer: string): Promise<number> {
  const lastUser = [...task].reverse().find((m) => m.role === "user")?.content ?? "";
  const q = `Task:\n${lastUser.slice(0, 1500)}\n\nProposed answer:\n${answer.slice(0, 1200)}\n\nIs the proposed answer correct and complete? Reply with ONLY a probability 0.00-1.00.`;
  try {
    const out = await chat(LOCAL_URL, "x", PRIMARY, [{ role: "user", content: q }], 16);
    const m = out.match(/(?:0?\.\d+|0|1(?:\.0+)?)/);
    return m ? Math.max(0, Math.min(1, parseFloat(m[0]))) : 0.5;
  } catch {
    return 0.5;
  }
}

function loadCheckpoint(path: string): Map<number, Row> {
  const m = new Map<number, Row>();
  if (!existsSync(path)) return m;
  for (const line of readFileSync(path, "utf-8").split("\n").filter(Boolean)) {
    try {
      const r = JSON.parse(line) as Row;
      m.set(r.id, r);
    } catch {
      /* torn line */
    }
  }
  return m;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const smoke = args.includes("--smoke");
  const limIdx = args.indexOf("--limit");
  const limit = smoke ? 2 : limIdx >= 0 ? Number(args[limIdx + 1]) : 60;
  const outIdx = args.indexOf("--out");
  const outDir = outIdx >= 0 ? args[outIdx + 1]! : "data/replay-gate";
  mkdirSync(outDir, { recursive: true });
  if (!FRONTIER_KEY) {
    console.error("FRONTIER_KEY required (the frontier reference arm spends OpenRouter)");
    process.exit(1);
  }

  const tasks = loadTasks(limit);
  console.error(`loaded ${tasks.length} real owner sub-tasks (limit ${limit}${smoke ? ", SMOKE" : ""})`);
  const ckptPath = join(outDir, "rows.jsonl");
  const done = loadCheckpoint(ckptPath);

  // Run-config manifest: refuse to resume a checkpoint built with different models/threshold
  // (its divergedFromFrontier reflects the OLD config and would silently corrupt the summary).
  const cfg: Record<string, string | number> = { PRIMARY, SECONDARY, FRONTIER_MODEL, DIVERGENCE_THRESHOLD };
  const manifestPath = join(outDir, "manifest.json");
  if (existsSync(manifestPath)) {
    const prev = JSON.parse(readFileSync(manifestPath, "utf-8")) as Record<string, string | number>;
    for (const k of Object.keys(cfg)) {
      if (prev[k] !== cfg[k]) {
        console.error(`config mismatch on resume (${k}: ${prev[k]} → ${cfg[k]}). Use a fresh --out dir.`);
        process.exit(1);
      }
    }
  } else {
    writeFileSync(manifestPath, JSON.stringify(cfg, null, 2));
  }

  // Hard frontier-spend cap (real $). Defaults to the sample size; never exceed it on resume.
  const mfcIdx = args.indexOf("--max-frontier-calls");
  const maxFrontier = mfcIdx >= 0 ? Number(args[mfcIdx + 1]) : limit;
  let frontierCalls = [...done.values()].filter((r) => !r.error).length;

  for (const t of tasks) {
    if (done.has(t.id)) continue;
    const msgs = sanitizeMessages(t.messages);
    if (msgs.length === 0) {
      // Deterministically-bad row → checkpoint a skip so resume doesn't retry it forever.
      const skip: Row = { id: t.id, servedModel: t.servedModel, primaryOut: "", secondaryOut: "", frontierOut: "", disagreement: 0, divergedFromFrontier: 0, selfUncertainty: 0, error: "empty-after-sanitize" };
      done.set(t.id, skip);
      appendFileSync(ckptPath, JSON.stringify(skip) + "\n");
      continue;
    }
    if (frontierCalls >= maxFrontier) {
      console.error(`frontier budget cap reached (${maxFrontier} calls) — stopping.`);
      break;
    }
    try {
      const maxTok = 1024;
      const primaryOut = await chat(LOCAL_URL, "x", PRIMARY, msgs, maxTok);
      const secondaryOut = await chat(LOCAL_URL, "x", SECONDARY, msgs, maxTok);
      const frontierOut = await chat(FRONTIER_URL, FRONTIER_KEY, FRONTIER_MODEL, msgs, maxTok);
      frontierCalls++;
      const conf = await selfConfidence(msgs, primaryOut);
      const row: Row = {
        id: t.id,
        servedModel: t.servedModel,
        primaryOut: primaryOut.slice(0, 4000),
        secondaryOut: secondaryOut.slice(0, 4000),
        frontierOut: frontierOut.slice(0, 4000),
        disagreement: disagreementScore(primaryOut, secondaryOut),
        divergedFromFrontier: disagreementScore(primaryOut, frontierOut) >= DIVERGENCE_THRESHOLD ? 1 : 0,
        selfUncertainty: 1 - conf,
      };
      done.set(t.id, row);
      appendFileSync(ckptPath, JSON.stringify(row) + "\n");
      console.error(
        `#${t.id} disagree=${row.disagreement.toFixed(2)} diverged=${row.divergedFromFrontier} selfUnc=${row.selfUncertainty.toFixed(2)}`,
      );
    } catch (e) {
      console.error(`#${t.id}: ERROR ${(e as Error).message}`);
    }
  }

  const rows = [...done.values()].filter((r) => !r.error); // skip/error rows are checkpointed but excluded from stats
  if (smoke) {
    console.log(`\nSMOKE ok: ${rows.length} rows. Sample frontier vs mellum divergence:`);
    for (const r of rows) console.log(`  #${r.id} disagree=${r.disagreement.toFixed(2)} diverged=${r.divergedFromFrontier}`);
    return;
  }

  const labels = rows.map((r) => r.divergedFromFrontier);
  const base = labels.reduce((a, b) => a + b, 0) / rows.length;
  const summary = {
    n: rows.length,
    primaryModel: PRIMARY,
    secondaryModel: SECONDARY,
    frontierModel: FRONTIER_MODEL,
    divergenceThreshold: DIVERGENCE_THRESHOLD,
    baseDivergenceRate: round(base), // fraction where escalation would change mellum's answer
    auroc: {
      disagreement: round(auroc(rows.map((r) => r.disagreement), labels)),
      selfConfidence: round(auroc(rows.map((r) => r.selfUncertainty), labels)),
    },
    minFrontierRateForIsoQuality: {
      disagreement: rnd(minFrontierForAccuracy(offloadCurve(rows.map((r) => ({ wrong: !!r.divergedFromFrontier, score: r.disagreement }))), 1 - 1e-9)),
      selfConfidence: rnd(minFrontierForAccuracy(offloadCurve(rows.map((r) => ({ wrong: !!r.divergedFromFrontier, score: r.selfUncertainty }))), 1 - 1e-9)),
    },
    note: "Ground truth = mellum answer diverged from frontier (proxy for 'escalation changes the answer'); NOT a correctness oracle. baseDivergenceRate = oracle frontier rate.",
  };
  writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 2), "utf-8");
  console.log("\n=== Replay-gate experiment (real owner sub-tasks) ===");
  console.log(JSON.stringify(summary, null, 2));
  console.log(
    `\nVERDICT: on REAL tasks, cross-model disagreement is a ${summary.auroc.disagreement > summary.auroc.selfConfidence + 0.05 ? "BETTER" : summary.auroc.selfConfidence > summary.auroc.disagreement + 0.05 ? "WORSE" : "comparable"} predictor of frontier-divergence than self-confidence (AUROC ${summary.auroc.disagreement} vs ${summary.auroc.selfConfidence}).`,
  );
}

function round(n: number): number {
  return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : n;
}
function rnd(n: number | null): number | null {
  return n === null ? null : round(n);
}

const isEntrypoint = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
