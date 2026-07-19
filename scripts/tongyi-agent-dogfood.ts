/**
 * Live smoke for the model-driven agent loop (issue #40): does the REAL Tongyi-DR actually
 * drive the ReAct loop — emit the JSON action protocol, search/read/answer, not blank out?
 *
 * Inference-only: stub SearchProvider + Reader (a small canned corpus), but the BRAIN is the live
 * box `tongyi-dr` reached over an SSH port-forward (default :18091 → box llama-swap :8091). No box
 * files are touched; no OpenRouter (agent mode is local-brain).
 *
 *   ssh -fN -L 18091:127.0.0.1:8091 m5
 *   TONGYI_URL=http://127.0.0.1:18091/v1 tsx scripts/tongyi-agent-dogfood.ts
 */
import { makeChatFn } from "../src/homeserver/deep-research-cli.js";
import { setDeepResearchConfig, resetDeepResearchConfig } from "../src/homeserver/deep-research-config.js";
import { runAgentResearch } from "../src/homeserver/deep-research-agent.js";
import type { ResearchDeps, SearchProvider, Reader, ReadResult, SearchHit } from "../src/homeserver/deep-research-types.js";

const URL = process.env["TONGYI_URL"] ?? "http://127.0.0.1:18091/v1";
const MODEL = process.env["TONGYI_MODEL"] ?? "tongyi-dr";
const QUERY = process.env["TONGYI_QUERY"] ?? "What are the cardiovascular effects of moderate coffee consumption?";

// ── canned corpus (verbatim facts so [S#] citations can resolve) ──
const CORPUS: { url: string; title: string; markdown: string }[] = [
  {
    url: "https://pmc.ncbi.nlm.nih.gov/coffee-meta",
    title: "Coffee consumption and cardiovascular disease — dose-response meta-analysis",
    markdown:
      "A dose-response meta-analysis of prospective cohort studies found a U-shaped association between coffee " +
      "consumption and cardiovascular disease risk. Moderate consumption of three to five cups per day was associated " +
      "with the lowest risk, an 15% lower risk of cardiovascular disease compared with non-drinkers. Heavy consumption " +
      "above five cups per day showed no additional benefit. The association was similar for caffeinated and decaffeinated coffee.",
  },
  {
    url: "https://www.nature.com/coffee-bp",
    title: "Coffee, blood pressure and hypertension",
    markdown:
      "Habitual moderate coffee intake was not associated with an increased risk of hypertension in long-term cohorts. " +
      "Acute caffeine intake can transiently raise blood pressure by 3 to 8 mmHg, but tolerance develops with regular use. " +
      "Unfiltered coffee (such as boiled or French-press) raises LDL cholesterol because of the diterpenes cafestol and kahweol.",
  },
  {
    url: "https://pmc.ncbi.nlm.nih.gov/coffee-mortality",
    title: "Coffee and all-cause and cardiovascular mortality",
    markdown:
      "In a large cohort, coffee drinkers had a lower risk of all-cause mortality, with a hazard ratio of 0.85 for two to " +
      "four cups per day versus none. The inverse association held for cardiovascular mortality. Genetic variation in CYP1A2 " +
      "caffeine metabolism modifies individual responses, and most evidence is observational, so residual confounding (for " +
      "example by smoking) cannot be excluded.",
  },
];

const stubSearch: SearchProvider = {
  name: "stub",
  async search(q: string): Promise<SearchHit[]> {
    return CORPUS.map((c) => ({ url: c.url, title: c.title, snippet: c.markdown.slice(0, 120) }));
  },
};
const stubReader: Reader = {
  name: "stub",
  async read(url: string): Promise<ReadResult> {
    const c = CORPUS.find((x) => x.url === url);
    if (!c) throw new Error(`stub reader: unknown url ${url}`);
    return { url, title: c.title, markdown: c.markdown, isThin: false };
  },
};

async function main(): Promise<void> {
  resetDeepResearchConfig();
  const config = setDeepResearchConfig({
    agentModel: MODEL,
    agentMaxTurns: 8,
    agentTokenBudget: 40000,
    agentTemp: 0.7,
    agentMaxBlankRetries: 3,
    agentReadCharCap: 3000,
  });
  const brain = makeChatFn(URL, "x", MODEL, 0.7);
  const deps: ResearchDeps = {
    search: stubSearch,
    read: stubReader,
    chat: { planner: brain, distiller: brain, synthesizer: brain },
    config,
    log: (m) => console.error("· " + m),
    onProgress: (p) => console.error(`  [${p.stage}] turn ${p.iteration}: ${p.detail.slice(0, 90)}`),
  };

  console.error(`\n=== Tongyi agent dogfood — model=${MODEL} url=${URL} ===`);
  console.error(`Q: ${QUERY}\n`);
  const t0 = Date.now();
  const res = await runAgentResearch(deps, { query: QUERY, nowIso: new Date().toISOString() });
  const secs = ((Date.now() - t0) / 1000).toFixed(0);

  console.log(`\n========== RESULT (${secs}s) ==========`);
  console.log(JSON.stringify(res.stats, null, 2));
  console.log(`\nsources read: ${res.report.sources.map((s) => s.id).join(", ") || "(none)"}`);
  console.log(`report-sentence support (trust anchor): ${(res.report.reportCitations.precision * 100).toFixed(0)}% ` +
    `(${res.report.reportCitations.supported.length} supported / ${res.report.reportCitations.unsupported.length} unsupported)`);
  console.log(`\n========== REPORT.md (first 1800 chars) ==========\n`);
  console.log(res.report.markdown.slice(0, 1800));
}
main().catch((e) => { console.error("DOGFOOD ERROR:", e instanceof Error ? e.stack : e); process.exit(1); });
