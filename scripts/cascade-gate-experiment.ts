/**
 * cascade-gate-experiment.ts — Cross-model disagreement as a free escalation gate.
 *
 * Tests whether DISAGREEMENT between two cheap LOCAL models (mellum vs qwen3-coder-next-80b)
 * predicts leaf-task failure better than the local model's own confidence — the "gap detector
 * the local brain couldn't be" (Gate E E4). For each probe (deterministic verifier = ground
 * truth) we run both models, verify each, and capture mellum's verbalised self-confidence,
 * then compare escalation GATES by AUROC and an offload-frontier curve.
 *
 * Research basis: docs/cascade-gate-experiment-design.md. All local → ~$0.
 *
 * Run (from laptop, M5 on tailnet):
 *   HS_API_KEY=<owner-key> GATEWAY_URL=http://<m5-ip>:8080/v1 \
 *     tsx scripts/cascade-gate-experiment.ts [--out data/cascade-gate]
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PROBES, type Probe } from "../src/homeserver/probes.js";
import { HARD_PROBES } from "./hard-probes.js";

// ── Answer-comparison primitives ──────────────────────────────────────────────
// Moved to the production gate module (src/homeserver/disagreement-gate.ts) so the
// validated heuristics ARE the code the live router uses. Imported for local use AND
// re-exported so existing importers (replay-gate-experiment.ts, the test) keep working.
import {
  normTokens,
  jaccard,
  extractAnswer,
  disagreementScore,
} from "../src/homeserver/disagreement-gate.js";
export { normTokens, jaccard, extractAnswer, disagreementScore };

// ── Pure analysis helpers (unit-tested) ───────────────────────────────────────

/**
 * Rank-based AUROC (Mann–Whitney). label 1 = positive class (here: "answer is WRONG"); a
 * higher score should indicate higher P(positive). Returns NaN if a class is empty.
 */
export function auroc(scores: number[], labels: number[]): number {
  const nPos = labels.filter((l) => l === 1).length;
  const nNeg = labels.length - nPos;
  if (nPos === 0 || nNeg === 0) return NaN;
  const rows = scores.map((s, i) => ({ s, l: labels[i]! })).sort((x, y) => x.s - y.s);
  const ranks = new Array<number>(rows.length);
  let i = 0;
  while (i < rows.length) {
    let j = i;
    while (j < rows.length - 1 && rows[j + 1]!.s === rows[i]!.s) j++;
    const avg = (i + j) / 2 + 1; // 1-based average rank for ties
    for (let k = i; k <= j; k++) ranks[k] = avg;
    i = j + 1;
  }
  let sumPos = 0;
  for (let k = 0; k < rows.length; k++) if (rows[k]!.l === 1) sumPos += ranks[k]!;
  return (sumPos - (nPos * (nPos + 1)) / 2) / (nPos * nNeg);
}

export interface CurvePoint {
  threshold: number;
  frontierRate: number; // fraction escalated
  accuracy: number; // assuming frontier is correct on escalated items
}

/**
 * Offload-frontier curve for the policy "run the primary local model; escalate to frontier iff
 * gateScore ≥ threshold". Escalated items are assumed frontier-correct (the ceiling). Sweeps
 * thresholds over the observed scores. Lower frontierRate at equal accuracy = more local offload.
 */
export function offloadCurve(items: { wrong: boolean; score: number }[]): CurvePoint[] {
  const n = items.length;
  if (n === 0) return [];
  const thresholds = [...new Set(items.map((it) => it.score))].sort((a, b) => a - b);
  // include a threshold above the max (escalate nothing) and at/below min (handled by sweep)
  thresholds.push(Number.POSITIVE_INFINITY);
  return thresholds.map((t) => {
    let escalated = 0;
    let correct = 0;
    for (const it of items) {
      const esc = it.score >= t;
      if (esc) {
        escalated++;
        correct++; // frontier assumed correct
      } else if (!it.wrong) {
        correct++; // kept local and the local model was right
      }
    }
    return { threshold: t, frontierRate: escalated / n, accuracy: correct / n };
  });
}

/** Smallest frontierRate that reaches accuracy ≥ target on the curve (or null if unreachable). */
export function minFrontierForAccuracy(curve: CurvePoint[], target: number): number | null {
  const ok = curve.filter((p) => p.accuracy >= target - 1e-9);
  if (ok.length === 0) return null;
  return Math.min(...ok.map((p) => p.frontierRate));
}

// ── Runner (live, local M5) ────────────────────────────────────────────────────

const GATEWAY_URL = process.env["GATEWAY_URL"] ?? "http://127.0.0.1:8080/v1";
const HS_API_KEY = process.env["HS_API_KEY"] ?? "";
const PRIMARY = process.env["PRIMARY_MODEL"] ?? "mellum";
const SECONDARY = process.env["SECONDARY_MODEL"] ?? "qwen3-coder-next-80b";

const CALL_TIMEOUT_MS = Number(process.env["CALL_TIMEOUT_MS"] ?? 180000);

async function callModel(
  model: string,
  prompt: string,
  system: string | undefined,
  maxTokens: number,
  temperature: number,
): Promise<string> {
  const messages = system
    ? [{ role: "system", content: system }, { role: "user", content: prompt }]
    : [{ role: "user", content: prompt }];
  // Bound each call so a stuck swap / saturated shared box fails fast instead of hanging forever.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), CALL_TIMEOUT_MS);
  try {
    const resp = await fetch(`${GATEWAY_URL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${HS_API_KEY}` },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature }),
      signal: ac.signal,
    });
    if (!resp.ok) throw new Error(`${model} HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    const data = (await resp.json()) as { choices: { message: { content: string } }[] };
    return data.choices[0]?.message?.content ?? "";
  } finally {
    clearTimeout(timer);
  }
}

/** Verbalised self-confidence (P(True)) — the baseline gate the literature says fails. */
async function selfConfidence(probe: Probe, answer: string): Promise<number> {
  const q =
    `Task:\n${probe.prompt}\n\nProposed answer:\n${answer.slice(0, 1500)}\n\n` +
    `Is the proposed answer correct? Reply with ONLY a probability between 0.00 and 1.00 (your confidence it is correct).`;
  try {
    const out = await callModel(PRIMARY, q, undefined, 16, 0);
    const m = out.match(/(?:0?\.\d+|0|1(?:\.0+)?)/);
    if (!m) return 0.5;
    return Math.max(0, Math.min(1, parseFloat(m[0])));
  } catch {
    return 0.5;
  }
}

interface Row {
  id: string;
  taskType: string;
  primaryOut: string;
  secondaryOut: string;
  primaryPass: boolean;
  secondaryPass: boolean;
  primaryWrong: 0 | 1;
  disagreement: number;
  selfUncertainty: number; // 1 - confidence
  error?: string;
}

async function passed(probe: Probe, output: string): Promise<boolean> {
  const vr = await probe.verifier(output);
  return vr.outcome === "pass";
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf("--out");
  const outDir = outIdx >= 0 ? args[outIdx + 1]! : "data/cascade-gate";
  const probesIdx = args.indexOf("--probes");
  const probeSet: Probe[] = probesIdx >= 0 && args[probesIdx + 1] === "hard" ? HARD_PROBES : PROBES;
  console.error(`probe set: ${probesIdx >= 0 && args[probesIdx + 1] === "hard" ? "HARD" : "standard"} (${probeSet.length} probes)`);
  mkdirSync(outDir, { recursive: true });
  // HS_API_KEY only needed for the authed gateway (:8080); the llama-swap backend (:8091)
  // ignores auth. Warn but proceed if hitting :8091 without a key.
  if (!HS_API_KEY && GATEWAY_URL.includes(":8080")) {
    console.error("HS_API_KEY required for the authed gateway (:8080)");
    process.exit(1);
  }

  // Batch BY MODEL to minimise llama-swap cold-swaps (≈2 swaps total). Each pass CHECKPOINTS
  // every probe to <out>/<key>.jsonl as it lands, so a crash / shared-box preemption loses
  // nothing and a re-run RESUMES (skips cached probes). This is a shared GPU — runs can die.
  const errors = new Map<string, string>();

  function loadCheckpoint<T>(key: string): Map<string, T> {
    const m = new Map<string, T>();
    const p = join(outDir, `${key}.jsonl`);
    if (!existsSync(p)) return m;
    for (const line of readFileSync(p, "utf-8").split("\n").filter(Boolean)) {
      try {
        const o = JSON.parse(line) as { id: string; v: T };
        m.set(o.id, o.v);
      } catch {
        /* skip a torn last line */
      }
    }
    return m;
  }

  async function checkpointedPass<T>(
    label: string,
    key: string,
    fn: (p: Probe) => Promise<T>,
  ): Promise<Map<string, T>> {
    const store = loadCheckpoint<T>(key);
    const path = join(outDir, `${key}.jsonl`);
    console.error(`\n── pass: ${label} (${store.size}/${probeSet.length} cached) ──`);
    let i = 0;
    for (const probe of probeSet) {
      i++;
      if (store.has(probe.id)) continue;
      try {
        const v = await fn(probe);
        store.set(probe.id, v);
        appendFileSync(path, JSON.stringify({ id: probe.id, v }) + "\n");
        console.error(`  [${i}/${probeSet.length}] ${probe.id} ok`);
      } catch (e) {
        errors.set(probe.id, (e as Error).message);
        console.error(`  [${i}/${probeSet.length}] ${probe.id} ERROR ${(e as Error).message}`);
      }
    }
    return store;
  }

  const primaryOut = await checkpointedPass(`${PRIMARY} answers`, "primary", (p) =>
    callModel(PRIMARY, p.prompt, p.systemPrompt, p.maxTokens ?? 2048, p.temperature ?? 0),
  );
  const secondaryOut = await checkpointedPass(`${SECONDARY} answers`, "secondary", (p) =>
    callModel(SECONDARY, p.prompt, p.systemPrompt, p.maxTokens ?? 2048, p.temperature ?? 0),
  );
  const confidence = await checkpointedPass(`${PRIMARY} self-confidence`, "confidence", (p) =>
    selfConfidence(p, primaryOut.get(p.id) ?? ""),
  );

  const rows: Row[] = [];
  for (const probe of probeSet) {
    const pOut = primaryOut.get(probe.id) ?? "";
    const sOut = secondaryOut.get(probe.id) ?? "";
    const err = errors.get(probe.id);
    const primaryPass = err ? false : await passed(probe, pOut);
    const secondaryPass = err ? false : await passed(probe, sOut);
    rows.push({
      id: probe.id,
      taskType: probe.taskType,
      primaryOut: pOut.slice(0, 4000),
      secondaryOut: sOut.slice(0, 4000),
      primaryPass,
      secondaryPass,
      primaryWrong: primaryPass ? 0 : 1,
      disagreement: disagreementScore(pOut, sOut),
      selfUncertainty: 1 - (confidence.get(probe.id) ?? 0.5),
      ...(err ? { error: err } : {}),
    });
    console.error(
      `${probe.id.padEnd(22)} ${PRIMARY}=${primaryPass ? "P" : "F"} ${SECONDARY}=${secondaryPass ? "P" : "F"} disagree=${disagreementScore(pOut, sOut).toFixed(2)} selfUnc=${(1 - (confidence.get(probe.id) ?? 0.5)).toFixed(2)}`,
    );
  }

  writeFileSync(join(outDir, "rows.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n"), "utf-8");

  // ── Analysis ──
  const labels = rows.map((r) => r.primaryWrong);
  const errRate = labels.reduce((a, b) => a + b, 0) / rows.length;
  const aurocDisagree = auroc(rows.map((r) => r.disagreement), labels);
  const aurocSelf = auroc(rows.map((r) => r.selfUncertainty), labels);

  const curveDisagree = offloadCurve(rows.map((r) => ({ wrong: !!r.primaryWrong, score: r.disagreement })));
  const curveSelf = offloadCurve(rows.map((r) => ({ wrong: !!r.primaryWrong, score: r.selfUncertainty })));
  const target = 1 - 1e-9; // iso-quality with the all-frontier ceiling (assume frontier correct)
  const fDisagree = minFrontierForAccuracy(curveDisagree, target);
  const fSelf = minFrontierForAccuracy(curveSelf, target);

  const summary = {
    n: rows.length,
    primaryModel: PRIMARY,
    secondaryModel: SECONDARY,
    primaryErrorRate: round(errRate),
    oracleFrontierRate: round(errRate), // escalate exactly the wrong ones
    auroc: { disagreement: round(aurocDisagree), selfConfidence: round(aurocSelf) },
    minFrontierRateForIsoQuality: { disagreement: rnd(fDisagree), selfConfidence: rnd(fSelf) },
    note: "minFrontierRate = fraction sent to frontier to reach 100% accuracy (frontier-correct assumption). Lower is better = more local offload. Oracle = primaryErrorRate.",
  };
  writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 2), "utf-8");

  console.log("\n=== Cascade-gate experiment ===");
  console.log(JSON.stringify(summary, null, 2));
  console.log(
    `\nVERDICT: cross-model disagreement is a ${aurocDisagree > aurocSelf + 0.05 ? "BETTER" : aurocSelf > aurocDisagree + 0.05 ? "WORSE" : "comparable"} escalation gate than self-confidence ` +
      `(AUROC ${round(aurocDisagree)} vs ${round(aurocSelf)}).`,
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
