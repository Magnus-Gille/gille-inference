/**
 * M5 dogfood — run the deep-research pipeline against the LIVE box models.
 *
 * Validates the §4c model-role assignments (planner=qwen3-coder-next-80b, distiller=mellum,
 * synthesizer=qwen3-coder-next-80b) on real Strix-Halo hardware, BEFORE the SearXNG/Trafilatura
 * sidecars exist: search + reader are stubbed with realistic canned pages (one carrying a
 * deliberate numeric conflict, to exercise deterministic DISPUTED detection), while every MODEL
 * call is real and metered through llama-swap. Records each sub-step to the ledger and prints a
 * per-role capability table — the dogfooding signal the project exists to gather (RQ5/RQ6/RQ7).
 *
 *   RESEARCH_GATEWAY_URL=http://127.0.0.1:18091/v1 tsx scripts/m5-dogfood-deep-research.ts
 *
 * (Point RESEARCH_GATEWAY_URL at a port-forward of the box's llama-swap :8091, or the box itself.)
 */

import { setDeepResearchConfig, resetDeepResearchConfig } from "../src/homeserver/deep-research-config.js";
import { makeChatFn } from "../src/homeserver/deep-research-cli.js";
import { runResearch } from "../src/homeserver/deep-research.js";
import type {
  ResearchDeps,
  SearchProvider,
  Reader,
  SearchHit,
  ReadResult,
  DelegationRecord,
} from "../src/homeserver/deep-research-types.js";

const GATEWAY = process.env["RESEARCH_GATEWAY_URL"] ?? "http://127.0.0.1:18091/v1";
const PLANNER = process.env["RESEARCH_PLANNER_MODEL"] ?? "qwen3-coder-next-80b";
const DISTILL = process.env["RESEARCH_DISTILL_MODEL"] ?? "mellum";
const SYNTH = process.env["RESEARCH_SYNTH_MODEL"] ?? "qwen3-coder-next-80b";

// ── canned corpus (realistic; quotes are verbatim so citations should resolve) ──
const CORPUS: { url: string; title: string; markdown: string }[] = [
  {
    url: "https://www.nist.gov/si-redefinition/speed-light",
    title: "Speed of light — NIST",
    markdown:
      "The speed of light in vacuum is exactly 299,792,458 metres per second. " +
      "This value was fixed by definition in 1983, when the metre was redefined in terms of the " +
      "distance light travels in 1/299,792,458 of a second. Because the value is now a defined " +
      "constant, it has no measurement uncertainty.",
  },
  {
    url: "https://en.wikipedia.org/wiki/R%C3%B8mer%27s_determination",
    title: "Rømer's determination of the speed of light — Wikipedia",
    markdown:
      "Ole Rømer made the first quantitative estimate of the speed of light in 1676 by observing " +
      "the eclipses of Jupiter's moon Io. He concluded that light took time to travel, and his data " +
      "imply a speed of roughly 220,000 kilometres per second — about 26% below the modern value, " +
      "mainly because the size of Earth's orbit was not yet known accurately.",
  },
  {
    url: "https://example-blog.com/speed-of-light-myths",
    title: "Common myths about the speed of light",
    markdown:
      "Some popular sources incorrectly state that the speed of light is 300,000 kilometres per " +
      "second exactly; the precise rounded value is 299,792 kilometres per second. It is also often " +
      "repeated that Rømer measured the speed of light in 1676 as roughly 200,000 kilometres per " +
      "second, a figure that differs from more careful reconstructions of his data.",
  },
];

const search: SearchProvider = {
  name: "stub",
  async search(): Promise<SearchHit[]> {
    return CORPUS.map((c) => ({ url: c.url, title: c.title, snippet: c.markdown.slice(0, 120) }));
  },
};
const reader: Reader = {
  name: "stub",
  async read(url: string): Promise<ReadResult> {
    const c = CORPUS.find((x) => x.url === url);
    return { url, title: c?.title ?? url, markdown: c?.markdown ?? "", isThin: false };
  },
};

function fmt(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

async function main(): Promise<void> {
  resetDeepResearchConfig();
  const config = setDeepResearchConfig({
    gatewayUrl: GATEWAY,
    gatewayApiKey: "",
    plannerModel: PLANNER,
    distillModel: DISTILL,
    synthModel: SYNTH,
    maxSourcesPerIter: 3,
    maxQueriesPerIter: 3,
  });

  const ledger: DelegationRecord[] = [];
  const deps: ResearchDeps = {
    search,
    read: reader,
    chat: {
      planner: makeChatFn(GATEWAY, "", PLANNER),
      distiller: makeChatFn(GATEWAY, "", DISTILL),
      synthesizer: makeChatFn(GATEWAY, "", SYNTH),
    },
    config,
    recordLedger: (rec) => ledger.push(rec),
    log: (m) => process.stderr.write(`  · ${m}\n`),
  };

  console.log(`\n=== M5 deep-research dogfood ===`);
  console.log(`gateway: ${GATEWAY}`);
  console.log(`roles: plan/gap=${PLANNER}  distill=${DISTILL}  synth=${SYNTH}\n`);

  const t0 = Date.now();
  const res = await runResearch(
    { query: "How fast is the speed of light, and who first measured it?", depth: "quick", nowIso: new Date().toISOString() },
    deps
  );
  const wall = Date.now() - t0;

  // ── per-role capability table (the dogfooding signal) ──
  console.log(`\n--- per-role outcomes (n=${ledger.length} model calls, wall ${fmt(wall)}) ---`);
  console.log("role".padEnd(16) + "model".padEnd(24) + "outcome".padEnd(10) + "lat".padEnd(8) + "compl".padEnd(7) + "t/s");
  for (const r of ledger) {
    console.log(
      r.taskType.padEnd(16) +
        String(r.modelId).slice(0, 23).padEnd(24) +
        String(r.outcome).padEnd(10) +
        fmt(r.latencyMs ?? 0).padEnd(8) +
        String(r.completionTokens ?? 0).padEnd(7) +
        String(r.tokPerSec ?? "?")
    );
  }

  console.log(`\n--- pipeline stats ---`);
  console.log(JSON.stringify(res.stats, null, 2));
  console.log(`\n--- disputed clusters: ${res.report.disputed.length} ---`);
  for (const d of res.report.disputed) console.log(`  ⚠ ${d.text}  [${d.sourceIds.join(", ")}]`);
  console.log(`\n--- distilled-claim citation precision: ${(res.report.citations.precision * 100).toFixed(0)}% ` +
    `(${res.report.citations.resolved.length} resolved / ${res.report.citations.unresolved.length} unresolved) ---`);

  // ── Phase-2: report-sentence → cited-source verification (the hallucination gate) ──
  const rc = res.report.reportCitations;
  const citedSentences = rc.supported.length + rc.unsupported.length;
  console.log(`\n--- report-sentence support (Phase-2): ${(res.stats.reportSentencePrecision * 100).toFixed(0)}% ` +
    `(${rc.supported.length}/${citedSentences} cited sentences grounded; ${rc.uncitedSentenceCount} uncited) ---`);
  if (rc.unsupported.length === 0) {
    console.log(`  ✓ every cited sentence traced to its cited source`);
  } else {
    for (const u of rc.unsupported) {
      console.log(`  ✗ UNSUPPORTED [cited ${u.citedSourceIds.join(", ")}, best ratio ${u.matchRatio.toFixed(2)}]: "${u.sentence}"`);
    }
  }

  console.log(`\n========== REPORT (first 2500 chars) ==========\n`);
  console.log(res.report.markdown.slice(0, 2500));
  console.log(`\n========== POPULAR: "${res.popular.title}" (first 800 chars) ==========\n`);
  console.log(res.popular.markdown.slice(0, 800));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
