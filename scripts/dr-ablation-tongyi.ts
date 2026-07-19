/**
 * dr-ablation-tongyi.ts — Tongyi-DR agent-mode benchmark over a frozen corpus.
 *
 * For a given query id (q1..q9), loads the frozen corpus, builds stub search/reader,
 * runs `runAgentResearch` with tongyi-dr over the port-forward, writes the report to
 * data/dr-ablation/reports/<q>-tongyi-agent/report.md, and prints stats.
 *
 * Usage:
 *   tsx scripts/dr-ablation-tongyi.ts <q1|q2|...|q9>
 *
 * Prerequisites:
 *   ssh -fN -L 18091:127.0.0.1:8091 m5
 *   curl -s http://127.0.0.1:18091/v1/models should list tongyi-dr
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { makeChatFn } from "../src/homeserver/deep-research-cli.js";
import { resetDeepResearchConfig, setDeepResearchConfig } from "../src/homeserver/deep-research-config.js";
import { runAgentResearch } from "../src/homeserver/deep-research-agent.js";
import type {
  ResearchDeps,
  SearchProvider,
  Reader,
  ReadResult,
  SearchHit,
} from "../src/homeserver/deep-research-types.js";

// ─── Paths ────────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const CORPUS_DIR = join(REPO_ROOT, "data", "dr-ablation", "corpus");
const REPORTS_DIR = join(REPO_ROOT, "data", "dr-ablation", "reports");

const TONGYI_URL = process.env["TONGYI_URL"] ?? "http://127.0.0.1:18091/v1";
const TONGYI_MODEL = process.env["TONGYI_MODEL"] ?? "tongyi-dr";

// ─── Corpus types ─────────────────────────────────────────────────────────────

interface CorpusSource {
  id: string;
  url: string;
  title: string;
  tier: string;
  markdown: string;
}

interface Corpus {
  query: string;
  sources: CorpusSource[];
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const qid = process.argv[2];
  if (!qid || !/^q[1-9]$/.test(qid)) {
    console.error("Usage: tsx scripts/dr-ablation-tongyi.ts <q1|q2|...|q9>");
    process.exit(1);
  }

  const outDir = join(REPORTS_DIR, `${qid}-tongyi-agent`);
  const reportPath = join(outDir, "report.md");

  // Resumable: skip if report already written
  if (existsSync(reportPath)) {
    console.log(`[${qid}] SKIP — report already exists at ${reportPath}`);
    process.exit(0);
  }

  // Load frozen corpus
  const corpusPath = join(CORPUS_DIR, `${qid}.json`);
  if (!existsSync(corpusPath)) {
    console.error(`[${qid}] ERROR — corpus not found: ${corpusPath}`);
    process.exit(1);
  }
  const corpus: Corpus = JSON.parse(readFileSync(corpusPath, "utf-8"));
  const { query, sources } = corpus;

  console.error(`\n=== dr-ablation-tongyi [${qid}] ===`);
  console.error(`Q: ${query}`);
  console.error(`Corpus sources: ${sources.length}`);
  console.error(`Model: ${TONGYI_MODEL}  URL: ${TONGYI_URL}\n`);

  // Build stub SearchProvider: return ALL corpus sources as hits (snippet = first 200 chars)
  const stubSearch: SearchProvider = {
    name: "frozen-corpus",
    async search(_q: string): Promise<SearchHit[]> {
      return sources.map((s) => ({
        url: s.url,
        title: s.title,
        snippet: s.markdown.slice(0, 200),
      }));
    },
  };

  // Build stub Reader: return matching corpus source's markdown; throw on unknown url
  const stubReader: Reader = {
    name: "frozen-corpus",
    async read(url: string): Promise<ReadResult> {
      const src = sources.find((s) => s.url === url);
      if (!src) throw new Error(`frozen-corpus reader: unknown url ${url}`);
      return {
        url,
        title: src.title,
        markdown: src.markdown,
        isThin: false,
      };
    },
  };

  // Configure: pin tongyi-dr, tongyi dialect, autocite on, 10 turns max
  resetDeepResearchConfig();
  const config = setDeepResearchConfig({
    agentModel: TONGYI_MODEL,
    agentDialect: "tongyi",
    agentMaxTurns: 10,
    agentTokenBudget: 60000,
    agentTemp: 0.6,
    agentMaxBlankRetries: 3,
    agentReadCharCap: 4000,
    agentAutoCite: true,
  });

  const brain = makeChatFn(TONGYI_URL, "x", TONGYI_MODEL, 0.6);

  const deps: ResearchDeps = {
    search: stubSearch,
    read: stubReader,
    chat: { planner: brain, distiller: brain, synthesizer: brain },
    config,
    log: (m) => console.error(`  · ${m}`),
    onProgress: (p) => console.error(`  [${p.stage}] turn ${p.iteration}: ${p.detail.slice(0, 100)}`),
  };

  const t0 = Date.now();
  const result = await runAgentResearch(deps, {
    query,
    nowIso: new Date().toISOString(),
  });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(0);

  const { stats, report } = result;
  const wordCount = report.markdown.replace(/[#*`\[\]]/g, "").split(/\s+/).filter(Boolean).length;

  // Write report
  mkdirSync(outDir, { recursive: true });
  writeFileSync(reportPath, report.markdown, "utf-8");

  // Print stats
  console.log(`\n========== [${qid}] DONE (${elapsed}s) ==========`);
  console.log(`turns used:            ${stats.iterations}`);
  console.log(`sources fetched:       ${stats.sourcesFetched}`);
  console.log(`search queries:        ${stats.searchQueries}`);
  console.log(`report word count:     ${wordCount}`);
  console.log(`report-sentence prec:  ${(stats.reportSentencePrecision * 100).toFixed(0)}% ` +
    `(${report.reportCitations.supported.length} supported / ${report.reportCitations.unsupported.length} unsupported)`);
  console.log(`uncited sentences:     ${report.reportCitations.uncitedSentenceCount}`);
  console.log(`total compl tokens:    ${stats.totalCompletionTokens}`);
  console.log(`report written to:     ${reportPath}`);
}

main().catch((e) => {
  console.error("ERROR:", e instanceof Error ? e.stack : e);
  process.exit(1);
});
