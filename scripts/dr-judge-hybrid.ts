/**
 * Hybrid cross-family judge of SAVED reports — minimal OpenRouter spend.
 *   o4-mini judge -> OpenRouter (cross-family guard against Opus self-preference; ~$0.03 / 3 queries)
 *   Opus judge    -> Claude subscription via a Claude Code subagent (FREE — NOT OpenRouter)
 *
 * Reads <dir>/q<N>-<system>.md (present files only). Blind-shuffles ONCE per query; the SAME
 * blinded bundle is scored by o4-mini here AND emitted to <dir>/hybrid/q<N>.md for the sub-Opus
 * judge, so both judges score identical content under identical neutral labels. Re-run with
 * --aggregate to merge the sub-Opus scores in.
 *
 *   Phase 1: tsx scripts/dr-judge-hybrid.ts <dir> A_baseline,A_reground,B_claude
 *   (then a Claude subagent judges <dir>/hybrid/q*.md, writing <dir>/hybrid/opus-sub.json)
 *   Phase 2: tsx scripts/dr-judge-hybrid.ts <dir> A_baseline,A_reground,B_claude --aggregate <dir>/hybrid/opus-sub.json
 */
import OpenAI from "openai";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadEnv } from "../src/env.js";
import { looseJson } from "../src/homeserver/deep-research.js";

loadEnv();
const DIR = process.argv[2] ?? "data/research/qualitymax-depth";
const SYSTEMS = (process.argv[3] ?? "A_baseline,A_reground,B_claude").split(",");
const aggIdx = process.argv.indexOf("--aggregate");
const AGG: string | null = aggIdx >= 0 ? (process.argv[aggIdx + 1] ?? null) : null;
const DIMS = ["factual_accuracy", "depth_coverage", "citation_quality", "coherence", "usefulness"];
const QUERIES = [
  "What are the main health benefits and risks of intermittent fasting, according to recent clinical evidence?",
  "How does the EU AI Act classify and regulate general-purpose AI (GPAI) models, and what obligations apply?",
  "What is the current scientific consensus on the cardiovascular effects of moderate coffee consumption?",
  "What are the leading proposed resolutions to the Fermi paradox, and how well-supported is each?",
  "How effective and safe are GLP-1 receptor agonists (e.g. semaglutide) for weight loss in adults without diabetes?",
];
const HYB = join(DIR, "hybrid");
const LABELS = ["Report 1", "Report 2", "Report 3", "Report 4"];

function buildPrompt(query: string, pres: { label: string; md: string }[]): { body: string; prompt: string } {
  const body = pres.map((p) => `### ${p.label}\n\n${p.md.slice(0, 6000)}`).join("\n\n---\n\n");
  const prompt = `Impartial judge of research reports answering the same question. Judge content only.\n\nQUESTION: ${query}\n\n${body}\n\nScore EACH 1-5 on ${DIMS.join(", ")}, then overall rank (1=best). Penalise unsupported claims / missing citations. JSON keyed by label: {"${pres[0]!.label}":{${DIMS.map((d) => `"${d}":4`).join(",")},"rank":1}}`;
  return { body, prompt };
}

function aggregate(perJudge: Record<string, any>[]): string {
  const agg: Record<string, { dim: Record<string, number>; n: number; rankSum: number; wins: number }> =
    Object.fromEntries(SYSTEMS.map((s) => [s, { dim: Object.fromEntries(DIMS.map((d) => [d, 0])), n: 0, rankSum: 0, wins: 0 }]));
  for (const row of perJudge) {
    for (const s of SYSTEMS) {
      const r = row[s]; if (!r) continue;
      for (const d of DIMS) agg[s]!.dim[d]! += Number(r[d]) || 0;
      agg[s]!.n++; const rk = Number(r.rank) || 0; if (rk > 0) { agg[s]!.rankSum += rk; if (rk === 1) agg[s]!.wins++; }
    }
  }
  const lines = [`# Hybrid judged (sub-Opus + OpenRouter o4-mini) — ${DIR}`, "", `| system | ${DIMS.join(" | ")} | avg | mean-rank | wins |`, `|---|${DIMS.map(() => "---").join("|")}|---|---|---|`];
  for (const s of SYSTEMS) {
    const a = agg[s]!; if (!a.n) { lines.push(`| ${s} | (no scores) |`); continue; }
    const davg = (d: string) => (a.dim[d]! / a.n).toFixed(2);
    const overall = (DIMS.reduce((x, d) => x + a.dim[d]!, 0) / (a.n * DIMS.length)).toFixed(2);
    lines.push(`| ${s} | ${DIMS.map(davg).join(" | ")} | **${overall}** | ${(a.rankSum / a.n).toFixed(2)} | ${a.wins} |`);
  }
  lines.push("", `_n = ${perJudge.length} (judge,query) score-sets · 2 judges × queries-with-files. Cross-family: Opus (sub) + o4-mini (OpenRouter)._`);
  return lines.join("\n");
}

async function main(): Promise<void> {
  mkdirSync(HYB, { recursive: true });
  if (AGG) {
    const o4 = JSON.parse(readFileSync(join(HYB, "o4mini.json"), "utf-8")) as Record<string, any>;
    const mapping = JSON.parse(readFileSync(join(HYB, "mapping.json"), "utf-8")) as Record<string, Record<string, string>>;
    const opus = JSON.parse(readFileSync(AGG, "utf-8")) as Record<string, any>;
    const perJudge: Record<string, any>[] = [];
    for (const qKey of Object.keys(mapping)) {
      const map = mapping[qKey]!;
      for (const src of [o4[qKey], opus[qKey]]) {
        if (!src) continue;
        const bySys: Record<string, any> = {};
        for (const label of Object.keys(map)) { if (src[label]) bySys[map[label]!] = src[label]; }
        if (Object.keys(bySys).length) perJudge.push(bySys);
      }
    }
    const table = aggregate(perJudge);
    writeFileSync(join(DIR, "JUDGED-hybrid.md"), table + "\n");
    console.log(table);
    return;
  }
  const KEY = process.env["OPENROUTER_API_KEY"] ?? ""; if (!KEY) throw new Error("OPENROUTER_API_KEY not set");
  const or = new OpenAI({ baseURL: "https://openrouter.ai/api/v1", apiKey: KEY, timeout: 900_000, maxRetries: 2 });
  const mapping: Record<string, Record<string, string>> = {}, queriesOut: Record<string, string> = {}, o4out: Record<string, any> = {};
  for (let qi = 0; qi < QUERIES.length; qi++) {
    const avail = SYSTEMS.filter((s) => existsSync(join(DIR, `q${qi + 1}-${s}.md`)));
    if (avail.length < 2) continue;
    // Deterministic counterbalance (rotate by query index) so each system occupies different
    // positions across queries — kills position bias without relying on a lucky random draw.
    const rot = qi % avail.length;
    const order = avail.slice(rot).concat(avail.slice(0, rot));
    const pres = order.map((s, i) => ({ label: LABELS[i]!, system: s, md: readFileSync(join(DIR, `q${qi + 1}-${s}.md`), "utf-8") }));
    const qKey = `q${qi + 1}`;
    mapping[qKey] = Object.fromEntries(pres.map((p) => [p.label, p.system]));
    queriesOut[qKey] = QUERIES[qi]!;
    const { body, prompt } = buildPrompt(QUERIES[qi]!, pres);
    writeFileSync(join(HYB, `${qKey}.md`), `QUESTION: ${QUERIES[qi]}\n\n${body}\n`);
    console.error(`${qKey}: o4-mini judging ${order.join(", ")}`);
    try {
      const r = await or.chat.completions.create({ model: "openai/o4-mini", messages: [{ role: "user", content: prompt }], max_tokens: 2000 });
      const p = looseJson(r.choices[0]?.message?.content ?? "");
      if (p && typeof p === "object") o4out[qKey] = p; else console.error(`${qKey}: o4-mini parse failed`);
    } catch (e) { console.error(`${qKey}: o4-mini error: ${(e as Error).message}`); }
  }
  writeFileSync(join(HYB, "mapping.json"), JSON.stringify(mapping, null, 2));
  writeFileSync(join(HYB, "queries.json"), JSON.stringify(queriesOut, null, 2));
  writeFileSync(join(HYB, "o4mini.json"), JSON.stringify(o4out, null, 2));
  console.log(`Phase 1 done. o4-mini scored: ${Object.keys(o4out).join(", ") || "(none)"}. Blind bundles -> ${HYB}/q*.md`);
}
main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });
