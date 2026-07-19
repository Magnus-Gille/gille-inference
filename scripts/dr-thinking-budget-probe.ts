/**
 * Thinking-budget probe: does raising max_tokens stop qwen35-a3b (a reasoning MoE) from blanking on
 * the aiact synth, or is something else going on? Calls the SAME cached aiact corpus synth prompt at
 * several budgets × reps and reports content vs reasoning-content length, finish_reason, tokens, time.
 *
 *   tsx scripts/dr-thinking-budget-probe.ts
 */
import OpenAI from "openai";
import { readFileSync } from "node:fs";
import { buildSynthPrompt } from "../src/homeserver/deep-research.js";
import type { Source, DistilledNote, ClaimCluster, ResearchPlan } from "../src/homeserver/deep-research-types.js";

const GATEWAY = process.env["DRX_GATEWAY"] ?? "http://127.0.0.1:18091/v1";
const MODEL = process.env["PROBE_MODEL"] ?? "qwen35-a3b";
const TEMP = Number(process.env["PROBE_TEMP"] ?? 0.6);
const BUDGETS = (process.env["PROBE_BUDGETS"] ?? "8000,16000,24000").split(",").map(Number);
const REPS = Number(process.env["PROBE_REPS"] ?? 3);

const c = JSON.parse(readFileSync("data/dr-exp/corpus/aiact.json", "utf-8")) as {
  query: string; plan: ResearchPlan; notes: DistilledNote[]; disputed: ClaimCluster[]; sources: Source[];
};
const req = buildSynthPrompt(c.query, c.plan.subQuestions, c.notes, c.disputed);
const client = new OpenAI({ baseURL: GATEWAY, apiKey: "x", timeout: 900_000 });
const strip = (t: string) => t.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/<\/?think>/gi, "").trim();

console.log(`model=${MODEL} temp=${TEMP} prompt≈${Math.round(req.prompt.length / 4)} tok\n`);
console.log("budget  rep  finish     compl_tok  content_c  reasoning_c  blank?  secs");
for (const max of BUDGETS) {
  for (let r = 0; r < REPS; r++) {
    const t0 = Date.now();
    try {
      const resp = await client.chat.completions.create({
        model: MODEL,
        messages: [{ role: "system", content: req.system }, { role: "user", content: req.prompt }],
        max_tokens: max,
        temperature: TEMP,
      });
      const ch = resp.choices[0];
      const content = strip(ch?.message?.content ?? "");
      const reasoning = (ch?.message as { reasoning_content?: string } | undefined)?.reasoning_content ?? "";
      const secs = ((Date.now() - t0) / 1000).toFixed(0);
      console.log(
        `${String(max).padEnd(7)} ${String(r).padEnd(4)} ${String(ch?.finish_reason).padEnd(10)} ${String(resp.usage?.completion_tokens).padEnd(10)} ${String(content.length).padEnd(10)} ${String(reasoning.length).padEnd(12)} ${(content.length < 200 ? "BLANK" : "ok").padEnd(7)} ${secs}`
      );
    } catch (e) {
      console.log(`${String(max).padEnd(7)} ${String(r).padEnd(4)} ERROR ${(e as Error).message.slice(0, 60)}`);
    }
  }
}
