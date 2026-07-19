/**
 * Blind cross-family judge for the distillation-ablation grid. Reports live at
 * data/dr-ablation/reports/<q>-<system>/report.md. Per query: blind-shuffle the available systems,
 * o4-mini (OpenRouter) scores each on 5 dims (1-5) + overall rank, and a blind bundle is emitted for
 * a sub-Opus judge. Phase-2 (--aggregate) merges both judges into the distill x synth heatmap.
 *
 *   Phase 1: tsx scripts/dr-ablation-judge.ts <systems-csv> <queries-csv>
 *   (then a Claude subagent scores each data/dr-ablation/judge/<q>/bundle.md -> <q>/opus.json)
 *   Phase 2: tsx scripts/dr-ablation-judge.ts <systems-csv> <queries-csv> --aggregate
 */
import OpenAI from "openai";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadEnv } from "../src/env.js";
import { looseJson } from "../src/homeserver/deep-research.js";

loadEnv();
const ROOT = "data/dr-ablation";
const REPORTS = join(ROOT, "reports");
const JUDGE = join(ROOT, "judge");
const DEFAULT_SYS = "terse-mellum-80b,rich-mellum-80b,rich-80b-80b,none-80b,terse-mellum-opus,rich-mellum-opus,none-opus,none-sonnet";
const SYSTEMS = (process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : DEFAULT_SYS).split(",");
const QS = (process.argv[3] && !process.argv[3].startsWith("--") ? process.argv[3] : "q1,q2,q3,q4,q5,q6,q7,q8,q9").split(",");
const AGG = process.argv.includes("--aggregate");
const DIMS = ["factual_accuracy", "depth_coverage", "citation_quality", "coherence", "usefulness"];
const LABELS = Array.from({ length: 24 }, (_, i) => `Report ${i + 1}`);
const CAP = 4500;

function rpath(q: string, sys: string): string { return join(REPORTS, `${q}-${sys}`, "report.md"); }
function shuffle<T>(a: T[]): T[] { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [b[i], b[j]] = [b[j]!, b[i]!]; } return b; }

function judgePrompt(query: string, pres: { label: string; md: string }[]): string {
  const body = pres.map((p) => `### ${p.label}\n\n${p.md.slice(0, CAP)}`).join("\n\n---\n\n");
  return `Impartial judge of research reports answering the same question. Judge CONTENT only; you do not know which system wrote which. ` +
    `Be discriminating — do NOT cluster scores; reward genuine traceable depth and punish unsupported/over-claimed or padded text.\n\n` +
    `QUESTION: ${query}\n\n${body}\n\nScore EACH report 1-5 on ${DIMS.join(", ")}, then give an overall rank (1 = best). ` +
    `Return ONLY JSON keyed by label: {"${pres[0]!.label}":{${DIMS.map((d) => `"${d}":4`).join(",")},"rank":1}, ...}`;
}

interface Agg { dim: Record<string, number>; n: number; rankSum: number; firsts: number }
function emptyAgg(): Agg { return { dim: Object.fromEntries(DIMS.map((d) => [d, 0])), n: 0, rankSum: 0, firsts: 0 }; }

function aggregate(): void {
  const agg: Record<string, Agg> = Object.fromEntries(SYSTEMS.map((s) => [s, emptyAgg()]));
  for (const q of QS) {
    const mapF = join(JUDGE, q, "mapping.json");
    if (!existsSync(mapF)) continue;
    const map = JSON.parse(readFileSync(mapF, "utf-8")) as Record<string, string>; // label -> system
    for (const jf of ["o4mini.json", "opus.json"]) {
      const f = join(JUDGE, q, jf);
      if (!existsSync(f)) continue;
      let sc: Record<string, any>; try { sc = JSON.parse(readFileSync(f, "utf-8")); } catch { continue; }
      for (const [label, sys] of Object.entries(map)) {
        const row = sc[label]; if (!row) continue;
        const a = agg[sys]; if (!a) continue;
        for (const d of DIMS) a.dim[d]! += Number(row[d]) || 0;
        a.n++; const rk = Number(row.rank) || 0; if (rk > 0) { a.rankSum += rk; if (rk === 1) a.firsts++; }
      }
    }
  }
  const lines = [`# Distillation-ablation judged heatmap`, "", `system | ${DIMS.join(" | ")} | **avg** | mean-rank | n | firsts`, `---|${DIMS.map(() => "---").join("|")}|---|---|---|---`];
  const rows = SYSTEMS.map((s) => {
    const a = agg[s]!; if (!a.n) return { s, overall: -1, line: `${s} | (no scores)` };
    const davg = (d: string) => (a.dim[d]! / a.n).toFixed(2);
    const overall = DIMS.reduce((x, d) => x + a.dim[d]!, 0) / (a.n * DIMS.length);
    return { s, overall, line: `${s} | ${DIMS.map(davg).join(" | ")} | **${overall.toFixed(2)}** | ${(a.rankSum / a.n).toFixed(1)} | ${a.n} | ${a.firsts}` };
  });
  rows.sort((x, y) => y.overall - x.overall);
  for (const r of rows) lines.push(r.line);
  const out = lines.join("\n");
  writeFileSync(join(ROOT, "JUDGED-heatmap.md"), out + "\n");
  console.log(out);
}

async function phase1(): Promise<void> {
  const KEY = process.env["OPENROUTER_API_KEY"] ?? ""; if (!KEY) throw new Error("OPENROUTER_API_KEY not set");
  const or = new OpenAI({ baseURL: "https://openrouter.ai/api/v1", apiKey: KEY, timeout: 900_000, maxRetries: 2 });
  for (const q of QS) {
    const avail = SYSTEMS.filter((s) => existsSync(rpath(q, s)));
    if (avail.length < 2) { console.error(`${q}: <2 systems, skip`); continue; }
    const corpus = JSON.parse(readFileSync(join(ROOT, "corpus", `${q}.json`), "utf-8")) as { query: string };
    const order = shuffle(avail);
    const pres = order.map((s, i) => ({ label: LABELS[i]!, system: s, md: readFileSync(rpath(q, s), "utf-8") }));
    mkdirSync(join(JUDGE, q), { recursive: true });
    writeFileSync(join(JUDGE, q, "mapping.json"), JSON.stringify(Object.fromEntries(pres.map((p) => [p.label, p.system])), null, 2));
    const prompt = judgePrompt(corpus.query, pres);
    writeFileSync(join(JUDGE, q, "bundle.md"), `QUESTION: ${corpus.query}\n\n` + pres.map((p) => `### ${p.label}\n\n${p.md.slice(0, CAP)}`).join("\n\n---\n\n") + "\n");
    writeFileSync(join(JUDGE, q, "query.txt"), corpus.query);
    console.error(`${q}: o4-mini judging ${avail.length} systems`);
    try {
      const r = await or.chat.completions.create({ model: "openai/o4-mini", messages: [{ role: "user", content: prompt }], max_tokens: 4000 });
      const p = looseJson(r.choices[0]?.message?.content ?? "");
      if (p && typeof p === "object") writeFileSync(join(JUDGE, q, "o4mini.json"), JSON.stringify(p, null, 2));
      else console.error(`${q}: o4-mini parse fail`);
    } catch (e) { console.error(`${q}: o4-mini error ${(e as Error).message}`); }
  }
  console.log(`Phase 1 done. Bundles + o4mini scores in ${JUDGE}/<q>/. Now score each <q>/bundle.md with a sub-Opus judge -> <q>/opus.json, then --aggregate.`);
}

(AGG ? Promise.resolve(aggregate()) : phase1()).catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });
