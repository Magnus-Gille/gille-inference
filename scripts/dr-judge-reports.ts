/**
 * Blind-judge ALREADY-SAVED benchmark reports (so a credit-limit blocker doesn't waste the M5 runs).
 * Reads <dir>/q<N>-<system>.md for each system, blind-shuffles, judges with Opus-4.8 + o4-mini,
 * aggregates. Use when the OpenRouter weekly limit resets (or with a fresh key).
 *
 *   OPENROUTER_API_KEY=... tsx scripts/dr-judge-reports.ts <dir> [system1,system2,...]
 *   e.g. tsx scripts/dr-judge-reports.ts data/research/qualitymax-depth A_baseline,A_reground,B_claude
 */
import OpenAI from "openai";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadEnv } from "../src/env.js";
import { looseJson } from "../src/homeserver/deep-research.js";

loadEnv();
const KEY = process.env["OPENROUTER_API_KEY"] ?? "";
const DIR = process.argv[2] ?? "data/research/qualitymax-depth";
const SYSTEMS = (process.argv[3] ?? "A_baseline,A_reground,B_claude").split(",");
const JUDGES = ["anthropic/claude-opus-4.8", "openai/o4-mini"];
const DIMS = ["factual_accuracy", "depth_coverage", "citation_quality", "coherence", "usefulness"] as const;
// The 5 canonical queries (qN ↔ index); only those with files present are judged.
const QUERIES = [
  "What are the main health benefits and risks of intermittent fasting, according to recent clinical evidence?",
  "How does the EU AI Act classify and regulate general-purpose AI (GPAI) models, and what obligations apply?",
  "What is the current scientific consensus on the cardiovascular effects of moderate coffee consumption?",
  "What are the leading proposed resolutions to the Fermi paradox, and how well-supported is each?",
  "How effective and safe are GLP-1 receptor agonists (e.g. semaglutide) for weight loss in adults without diabetes?",
];
const or = new OpenAI({ baseURL: "https://openrouter.ai/api/v1", apiKey: KEY, timeout: 900_000, maxRetries: 2 });
function shuffle<T>(a: T[]): T[] { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [b[i], b[j]] = [b[j]!, b[i]!]; } return b; }

async function judge(model: string, query: string, pres: { label: string; md: string }[]): Promise<Record<string, Record<string, number> & { rank: number }> | null> {
  const body = pres.map((p) => `### ${p.label}\n\n${p.md.slice(0, 6000)}`).join("\n\n---\n\n");
  const prompt = `Impartial judge of research reports answering the same question. Judge content only.\n\nQUESTION: ${query}\n\n${body}\n\nScore EACH 1-5 on ${DIMS.join(", ")}, then overall rank (1=best). Penalise unsupported claims / missing citations. JSON keyed by label: {"${pres[0]!.label}":{${DIMS.map((d) => `"${d}":4`).join(",")},"rank":1}}`;
  try {
    const r = await or.chat.completions.create({ model, messages: [{ role: "user", content: prompt }], max_tokens: 2000 });
    const p = looseJson(r.choices[0]?.message?.content ?? "");
    return p && typeof p === "object" ? (p as never) : null;
  } catch (e) { console.error(`judge ${model}: ${(e as Error).message}`); return null; }
}

async function main(): Promise<void> {
  if (!KEY) throw new Error("OPENROUTER_API_KEY not set");
  const agg = Object.fromEntries(SYSTEMS.map((s) => [s, { dim: Object.fromEntries(DIMS.map((d) => [d, 0])) as Record<string, number>, n: 0, rankSum: 0, wins: 0 }]));
  for (let qi = 0; qi < QUERIES.length; qi++) {
    const avail = SYSTEMS.filter((s) => existsSync(join(DIR, `q${qi + 1}-${s}.md`)));
    if (avail.length < 2) continue;
    const labels = ["Report 1", "Report 2", "Report 3", "Report 4"];
    const order = shuffle(avail);
    const pres = order.map((s, i) => ({ label: labels[i]!, md: readFileSync(join(DIR, `q${qi + 1}-${s}.md`), "utf-8") }));
    const l2s = new Map(order.map((s, i) => [labels[i]!, s]));
    console.error(`Q${qi + 1}: judging ${avail.join(", ")}`);
    for (const jm of JUDGES) {
      const sc = await judge(jm, QUERIES[qi]!, pres);
      if (!sc) continue;
      for (const [label, sys] of l2s) {
        const row = sc[label]; if (!row) continue;
        for (const d of DIMS) agg[sys]!.dim[d]! += Number((row as Record<string, unknown>)[d]) || 0;
        agg[sys]!.n++;
        const rk = Number(row.rank) || 0; if (rk > 0) { agg[sys]!.rankSum += rk; if (rk === 1) agg[sys]!.wins++; }
      }
    }
  }
  const lines = [`# Judged saved reports — ${DIR}`, "", `| system | ${DIMS.join(" | ")} | avg | mean-rank | wins |`, `|---|${DIMS.map(() => "---").join("|")}|---|---|---|`];
  for (const s of SYSTEMS) {
    const a = agg[s]!; if (!a.n) { lines.push(`| ${s} | (no scores) |`); continue; }
    const davg = (d: string) => (a.dim[d]! / a.n).toFixed(2);
    const overall = (DIMS.reduce((x, d) => x + a.dim[d]!, 0) / (a.n * DIMS.length)).toFixed(2);
    lines.push(`| ${s} | ${DIMS.map(davg).join(" | ")} | **${overall}** | ${(a.rankSum / a.n).toFixed(2)} | ${a.wins} |`);
  }
  const out = lines.join("\n");
  writeFileSync(join(DIR, "JUDGED.md"), out + "\n", "utf-8");
  console.log(out);
}
main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });
