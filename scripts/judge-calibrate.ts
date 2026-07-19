/**
 * judge-calibrate.ts — reproducible calibration of the HARVEST judge against a labeled control set.
 *
 * The harvest worker (scripts/harvest-verdicts.ts) grades REAL delegation traffic with a local model
 * and writes pass/partial/fail into the capability ledger. Before trusting a judge model (or flipping
 * HARVEST_MODE=on), we must know two things about it on ground-truth data:
 *   1. SAFETY  — does it ever PASS a bad answer? A false `pass` writes spurious capability evidence
 *      and can route a task to a model that cannot do it. This is the error that matters.
 *   2. RELIABILITY — how often does the call error (HTTP 5xx harmony-500 / empty / unparseable)?
 *      response_format {json_object} engages grammar-constrained decoding and should drive this ~0,
 *      which is the whole reason gpt-oss-120b becomes usable as a judge (#166).
 *
 * This script exercises the EXACT harvest path — buildJudgePrompt + buildJudgeBody + parseJudgeVerdict
 * from src/homeserver/harvest.ts — against a committed labeled control (tests/fixtures/judge-control.jsonl,
 * ground-truth authored, not model-generated). It does NOT retry (unlike the harvest worker): the raw
 * per-call outcome is the measurement. Local-only, no ledger writes, no frontier spend.
 *
 * Usage (run ON the box against llama-swap; wrap in the GPU lease so swaps don't thrash a live session):
 *   npx tsx src/homeserver/cli.ts gpu run --model <judge> --eta 15m --purpose judge-calibrate \
 *     -- npx tsx scripts/judge-calibrate.ts --judge-model <id> [--response-format on|off] [--repeats N]
 *
 * Flags:
 *   --judge-model <id>        model to calibrate (default: HARVEST_JUDGE_DEFAULT)
 *   --response-format on|off  send response_format {json_object} (default on). off measures the raw
 *                             format-500 rate the constraint is there to fix.
 *   --repeats <int>           calls per control row (default 1). >1 measures the non-deterministic
 *                             error rate; accuracy uses the first parseable verdict per row.
 *   --base-url <url>          OpenAI-compatible base (default $LMSTUDIO_BASE_URL || box llama-swap)
 *   --control <path>          control JSONL (default tests/fixtures/judge-control.jsonl)
 *   --timeout <ms>            per-call timeout (default 120000)
 *   --json                    also print a machine-readable summary object as the last line
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildJudgePrompt,
  buildJudgeBody,
  parseJudgeVerdict,
  HARVEST_JUDGE_DEFAULT,
} from "../src/homeserver/harvest.js";

type Verdict = "pass" | "partial" | "fail";

interface ControlRow {
  id: string;
  taskType: string;
  prompt: string;
  answer: string;
  gold: Verdict;
  trap?: string;
}

type CallOutcome =
  | { kind: "verdict"; verdict: Verdict; score: number }
  | { kind: "error"; cls: "http" | "empty" | "parse" | "network" | "timeout"; detail: string };

const DEFAULT_BASE_URL = process.env["LMSTUDIO_BASE_URL"] ?? "http://127.0.0.1:8091/v1";
const DEFAULT_CONTROL = resolve("./tests/fixtures/judge-control.jsonl");

function readFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith("--")) return undefined;
  return v;
}

const isVerdict = (v: unknown): v is Verdict => v === "pass" || v === "partial" || v === "fail";

export function loadControl(path: string): ControlRow[] {
  const text = readFileSync(path, "utf8");
  const rows: ControlRow[] = [];
  for (const [i, line] of text.split("\n").entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      throw new Error(`control line ${i + 1}: not valid JSON`);
    }
    const o = obj as Record<string, unknown>;
    if (
      typeof o["id"] !== "string" ||
      typeof o["taskType"] !== "string" ||
      typeof o["prompt"] !== "string" ||
      typeof o["answer"] !== "string" ||
      !isVerdict(o["gold"])
    ) {
      throw new Error(`control line ${i + 1} (${String(o["id"])}): missing/invalid required field`);
    }
    rows.push({
      id: o["id"],
      taskType: o["taskType"],
      prompt: o["prompt"],
      answer: o["answer"],
      gold: o["gold"],
      trap: typeof o["trap"] === "string" ? o["trap"] : undefined,
    });
  }
  if (rows.length === 0) throw new Error(`control set ${path} is empty`);
  return rows;
}

async function callJudge(
  baseUrl: string,
  model: string,
  system: string,
  user: string,
  responseFormat: { type: "json_object" } | null,
  timeoutMs: number
): Promise<CallOutcome> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer x" },
      body: JSON.stringify(buildJudgeBody(model, system, user, { responseFormat })),
      signal: ac.signal,
    });
    if (!resp.ok) {
      return { kind: "error", cls: "http", detail: `HTTP ${resp.status}: ${(await resp.text()).slice(0, 120)}` };
    }
    const data = (await resp.json()) as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim() === "") {
      return { kind: "error", cls: "empty", detail: "empty completion" };
    }
    const v = parseJudgeVerdict(content);
    if (!v) return { kind: "error", cls: "parse", detail: content.slice(0, 120).replace(/\s+/g, " ") };
    return { kind: "verdict", verdict: v.verdict, score: v.score };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const cls = /abort/i.test(msg) ? "timeout" : "network";
    return { kind: "error", cls, detail: msg.slice(0, 120) };
  } finally {
    clearTimeout(timer);
  }
}

interface RowResult {
  row: ControlRow;
  verdict: Verdict | null; // first parseable verdict across repeats
  calls: CallOutcome[];
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const judgeModel = readFlag(args, "--judge-model") ?? HARVEST_JUDGE_DEFAULT;
  const rfArg = (readFlag(args, "--response-format") ?? "on").toLowerCase();
  if (rfArg !== "on" && rfArg !== "off") {
    console.error(`--response-format: expected on|off, got ${JSON.stringify(rfArg)}`);
    process.exit(1);
  }
  const responseFormat: { type: "json_object" } | null = rfArg === "on" ? { type: "json_object" } : null;
  const repeats = Number(readFlag(args, "--repeats") ?? 1);
  if (!Number.isInteger(repeats) || repeats <= 0) {
    console.error("--repeats: expected a positive integer");
    process.exit(1);
  }
  const baseUrl = readFlag(args, "--base-url") ?? DEFAULT_BASE_URL;
  const controlPath = readFlag(args, "--control") ?? DEFAULT_CONTROL;
  const timeoutMs = Number(readFlag(args, "--timeout") ?? 120000);
  const emitJson = args.includes("--json");

  const control = loadControl(controlPath);
  console.error(
    `[setup] judge=${judgeModel} response_format=${rfArg} repeats=${repeats} ` +
      `control=${control.length} rows endpoint=${baseUrl}\n`
  );

  const results: RowResult[] = [];
  for (const row of control) {
    const { system, user } = buildJudgePrompt(row.taskType, row.prompt, row.answer);
    const calls: CallOutcome[] = [];
    let verdict: Verdict | null = null;
    for (let r = 0; r < repeats; r++) {
      const out = await callJudge(baseUrl, judgeModel, system, user, responseFormat, timeoutMs);
      calls.push(out);
      if (verdict === null && out.kind === "verdict") verdict = out.verdict;
    }
    results.push({ row, verdict, calls });
    const got = verdict ?? `ERR:${(calls.find((c) => c.kind === "error") as { cls?: string } | undefined)?.cls ?? "?"}`;
    const anyPass = calls.some((c) => c.kind === "verdict" && c.verdict === "pass");
    const mark = verdict === null ? "·" : row.gold === "fail" && anyPass ? "✗DANGER" : verdict === row.gold ? "✓" : "✗";
    console.error(`  ${pad(row.id, 26)} gold=${pad(row.gold, 8)} got=${pad(String(got), 10)} ${mark}`);
  }

  // ── Metrics ────────────────────────────────────────────────────────────────────────
  const totalCalls = results.reduce((n, r) => n + r.calls.length, 0);
  const errorCalls = results.reduce((n, r) => n + r.calls.filter((c) => c.kind === "error").length, 0);
  const errorByClass = new Map<string, number>();
  for (const r of results)
    for (const c of r.calls) if (c.kind === "error") errorByClass.set(c.cls, (errorByClass.get(c.cls) ?? 0) + 1);

  // A gold=fail row is unsafe if ANY repeat passed it, not just the first parseable verdict — the
  // judge is non-deterministic even at temp 0, so a single false pass across repeats is a real risk.
  const passedAny = (r: RowResult): boolean => r.calls.some((c) => c.kind === "verdict" && c.verdict === "pass");

  const withVerdict = results.filter((r) => r.verdict !== null);
  const exactMatches = withVerdict.filter((r) => r.verdict === r.row.gold).length;

  const goldFail = withVerdict.filter((r) => r.row.gold === "fail");
  const falsePasses = goldFail.filter(passedAny); // the dangerous error — any repeat passed a bad answer
  // null (not 1) when the denominator is empty — an all-error run must NOT report perfect safety.
  const failSafety = goldFail.length ? (goldFail.length - falsePasses.length) / goldFail.length : null;

  const goldPass = withVerdict.filter((r) => r.row.gold === "pass");
  const recalled = goldPass.filter(passedAny);
  const passRecall = goldPass.length ? recalled.length / goldPass.length : null;

  const noVerdict = results.filter((r) => r.verdict === null);

  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const fmtRate = (x: number | null) => (x === null ? "n/a (0 rows)" : pct(x));
  console.error("\n" + "─".repeat(64));
  console.error(`judge=${judgeModel}  response_format=${rfArg}  repeats=${repeats}`);
  console.error(`reliability : ${errorCalls}/${totalCalls} calls errored (${totalCalls ? pct(errorCalls / totalCalls) : "n/a"})` +
    (errorByClass.size ? `  [${[...errorByClass].map(([k, v]) => `${k}:${v}`).join(" ")}]` : ""));
  console.error(`coverage    : ${withVerdict.length}/${results.length} rows produced a verdict` +
    (noVerdict.length ? `  (no verdict: ${noVerdict.map((r) => r.row.id).join(", ")})` : ""));
  console.error(`exact acc   : ${exactMatches}/${withVerdict.length} (${withVerdict.length ? pct(exactMatches / withVerdict.length) : "n/a"}) 3-way first-verdict match`);
  console.error(`FAIL-SAFETY : ${goldFail.length - falsePasses.length}/${goldFail.length} bad answers NEVER passed (${fmtRate(failSafety)})  ← the metric that matters`);
  console.error(`pass-recall : ${recalled.length}/${goldPass.length} good answers passed on >=1 repeat (${fmtRate(passRecall)})`);
  if (falsePasses.length) {
    console.error(`\n⚠️  FALSE PASSES (judge passed a known-bad answer on >=1 repeat — unsafe):`);
    for (const r of falsePasses) console.error(`     ${r.row.id}  (${r.row.trap ?? ""})`);
  }
  console.error("─".repeat(64));

  if (emitJson) {
    const summary = {
      judgeModel,
      responseFormat: rfArg,
      repeats,
      rows: results.length,
      totalCalls,
      errorCalls,
      errorRate: totalCalls ? errorCalls / totalCalls : null,
      errorByClass: Object.fromEntries(errorByClass),
      withVerdict: withVerdict.length,
      exactAcc: withVerdict.length ? exactMatches / withVerdict.length : null,
      failSafety, // null ⇒ insufficient coverage (no gold=fail row produced a verdict)
      falsePasses: falsePasses.map((r) => r.row.id),
      passRecall, // null ⇒ insufficient coverage
      noVerdict: noVerdict.map((r) => r.row.id),
    };
    console.log(JSON.stringify(summary));
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(`[fatal] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
