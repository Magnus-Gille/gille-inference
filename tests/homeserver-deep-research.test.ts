import { describe, it, expect, beforeEach } from "vitest";
import {
  looseJson,
  parsePlan,
  parseDistill,
  parseGap,
  triangulate,
  claimSimilarity,
  assignSources,
  renderReport,
  splitPopular,
  stripThink,
  runResearch,
} from "../src/homeserver/deep-research.js";
import { setDeepResearchConfig, resetDeepResearchConfig } from "../src/homeserver/deep-research-config.js";
import type {
  ChatFn,
  ChatRequest,
  ChatResponse,
  ResearchDeps,
  SearchProvider,
  Reader,
  ReadResult,
  DistilledNote,
  DelegationRecord,
} from "../src/homeserver/deep-research-types.js";
import type { DelegationRecord as LedgerRecord } from "../src/homeserver/ledger.js";

// ─── deterministic helpers ───────────────────────────────────────────────────────

describe("deep-research: JSON parsing (the don't-trust-the-model gate)", () => {
  it("looseJson parses a fenced block, raw JSON, and an embedded slice", () => {
    expect(looseJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(looseJson('{"a":2}')).toEqual({ a: 2 });
    expect(looseJson('here is the result: {"a":3} done')).toEqual({ a: 3 });
  });
  it("looseJson returns null on non-JSON", () => {
    expect(looseJson("not json at all")).toBeNull();
  });
  it("parsePlan extracts sub-questions + queries, rejects empty queries", () => {
    const p = parsePlan('{"subQuestions":["a","b"],"queries":["q1","q2"]}', 5);
    expect(p).toEqual({ subQuestions: ["a", "b"], queries: ["q1", "q2"] });
    expect(parsePlan('{"subQuestions":["a"],"queries":[]}', 5)).toBeNull();
    expect(parsePlan("garbage", 5)).toBeNull();
  });
  it("parsePlan caps queries to the budget", () => {
    const p = parsePlan('{"subQuestions":[],"queries":["q1","q2","q3","q4"]}', 2);
    expect(p?.queries).toHaveLength(2);
  });
  it("parseDistill keeps only well-formed claims", () => {
    const note = parseDistill('{"tier":"primary","claims":[{"text":"c1","quote":"q1"},{"bad":true},{"text":"c2","quote":""}]}', "S1");
    expect(note?.sourceId).toBe("S1");
    expect(note?.tier).toBe("primary");
    expect(note?.claims).toEqual([{ text: "c1", quote: "q1" }, { text: "c2", quote: "" }]);
  });
  it("parseDistill defaults an invalid tier to tertiary and rejects non-array claims", () => {
    expect(parseDistill('{"tier":"bogus","claims":[{"text":"c","quote":"q"}]}', "S2")?.tier).toBe("tertiary");
    expect(parseDistill('{"tier":"primary","claims":"nope"}', "S3")).toBeNull();
  });
  it("parseGap requires a boolean sufficient", () => {
    expect(parseGap('{"sufficient":true,"gaps":[],"newQueries":[]}', 5)?.sufficient).toBe(true);
    expect(parseGap('{"gaps":[]}', 5)).toBeNull();
  });
});

describe("deep-research: stripThink (reasoning-model chain-of-thought guard)", () => {
  it("removes a closed <think> block but keeps the real body after it", () => {
    expect(stripThink("<think>deliberating</think>The answer is Paris.")).toBe("The answer is Paris.");
  });
  it("strips an UNCLOSED <think> to end-of-text (never leaks reasoning — Codex finding)", () => {
    // truncated mid-reasoning: only the tag was removed before; the reasoning text must NOT survive
    expect(stripThink("intro\n<think>let me reason at length and never close the tag")).toBe("intro");
    expect(stripThink("<think>pure reasoning, no answer, no close")).toBe("");
  });
  it("leaves a clean body untouched (no-op for non-thinking models)", () => {
    expect(stripThink("Paris is the capital of France.")).toBe("Paris is the capital of France.");
  });
});

describe("deep-research: triangulation", () => {
  it("claimSimilarity is 1 for identical and low for unrelated", () => {
    expect(claimSimilarity("the sky is blue", "the sky is blue")).toBe(1);
    expect(claimSimilarity("the sky is blue", "bananas are yellow")).toBeLessThan(0.2);
  });
  it("marks a claim agreed when ≥2 distinct sources support it", () => {
    const notes: DistilledNote[] = [
      { sourceId: "S1", tier: "primary", claims: [{ text: "Paris is the capital of France", quote: "q" }] },
      { sourceId: "S2", tier: "secondary", claims: [{ text: "Paris is the capital of France indeed", quote: "q" }] },
    ];
    const clusters = triangulate(notes);
    const agreed = clusters.find((c) => c.status === "agreed");
    expect(agreed).toBeTruthy();
    expect(agreed?.sourceIds.sort()).toEqual(["S1", "S2"]);
  });
  it("flags a numeric disagreement between similar claims as disputed", () => {
    const notes: DistilledNote[] = [
      { sourceId: "S1", tier: "primary", claims: [{ text: "the population is 2 million people", quote: "" }] },
      { sourceId: "S2", tier: "primary", claims: [{ text: "the population is 5 million people", quote: "" }] },
    ];
    const clusters = triangulate(notes);
    expect(clusters.some((c) => c.status === "disputed")).toBe(true);
  });
  it("flags a negation-polarity split as disputed", () => {
    const notes: DistilledNote[] = [
      { sourceId: "S1", tier: "primary", claims: [{ text: "the drug is effective against the disease", quote: "" }] },
      { sourceId: "S2", tier: "primary", claims: [{ text: "the drug is not effective against the disease", quote: "" }] },
    ];
    const clusters = triangulate(notes);
    expect(clusters.some((c) => c.status === "disputed")).toBe(true);
  });
  it("leaves a single-source claim as single", () => {
    const notes: DistilledNote[] = [
      { sourceId: "S1", tier: "primary", claims: [{ text: "a unique standalone fact about widgets", quote: "" }] },
    ];
    expect(triangulate(notes)[0]?.status).toBe("single");
  });
});

describe("deep-research: source assembly + rendering", () => {
  it("assignSources ids continue from a start index, ranks tier, collapses near-dups", () => {
    const reads: ReadResult[] = [
      { url: "https://arxiv.org/abs/1", title: "Paper", markdown: "alpha beta gamma delta epsilon zeta", isThin: false },
      { url: "https://blog.example.com/2", title: "Blog", markdown: "alpha beta gamma delta epsilon zeta", isThin: false }, // near-dup
      { url: "https://other.com/3", title: "Other", markdown: "completely different content here entirely unrelated", isThin: false },
    ];
    const sources = assignSources(reads, 4);
    expect(sources[0]?.id).toBe("S5"); // continues from index 4
    expect(sources.length).toBe(2); // near-dup collapsed
    expect(sources[0]?.tier).toBe("primary"); // arxiv
    expect(sources[0]?.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });
  it("renderReport embeds the body, sources, disputed list, and precision", () => {
    const md = renderReport({
      query: "Q",
      generatedAtIso: "2026-06-20T00:00:00Z",
      brain: "local",
      iterations: 2,
      body: "## Overview\nParis is the capital [S1].",
      sources: [{ id: "S1", url: "https://a.gov/x", title: "A", tier: "primary", markdown: "", contentHash: "h" }],
      disputed: [],
      citationPrecision: 1,
      reportCitations: { supported: [], unsupported: [], uncitedSentenceCount: 0, precision: 1 },
    });
    expect(md).toContain("Paris is the capital [S1]");
    expect(md).toContain("[S1] [A](https://a.gov/x)");
    expect(md).toContain("distilled-claim citation precision: 100%");
    expect(md).toContain("## Sources");
  });

  it("renderReport surfaces the report-sentence support metric and lists unsupported sentences", () => {
    const md = renderReport({
      query: "Q",
      generatedAtIso: "2026-06-20T00:00:00Z",
      brain: "local",
      iterations: 1,
      body: "## Overview\nReal claim [S1]. Invented claim [S1].",
      sources: [{ id: "S1", url: "https://a.gov/x", title: "A", tier: "primary", markdown: "", contentHash: "h" }],
      disputed: [],
      citationPrecision: 1,
      reportCitations: {
        supported: [{ sentence: "Real claim", citedSourceIds: ["S1"], supportedBy: "S1", matchRatio: 1 }],
        unsupported: [{ sentence: "Invented claim", citedSourceIds: ["S1"], matchRatio: 0.1 }],
        uncitedSentenceCount: 0,
        precision: 0.5,
      },
    });
    expect(md).toContain("report-sentence support: 50% (1/2 cited)");
    expect(md).toContain("## Unsupported sentences");
    expect(md).toContain('"Invented claim"');
  });
  it("splitPopular pulls a title from the first line", () => {
    expect(splitPopular("Paris, briefly\n\nParis is...").title).toBe("Paris, briefly");
    expect(splitPopular("# Heading title\nbody").title).toBe("Heading title");
  });
});

// ─── full pipeline with injected fakes (no M5, no network) ───────────────────────

const PAGE = "Paris is the capital of France. The population is 2.1 million people in the city.";

function fakeChat(model: string, responder: (req: ChatRequest) => string, calls?: ChatRequest[]): ChatFn {
  return async (req: ChatRequest): Promise<ChatResponse> => {
    calls?.push(req);
    return { text: responder(req), promptTokens: 12, completionTokens: 34, model };
  };
}

const planner = (req: ChatRequest): string =>
  /sufficient/.test(req.prompt)
    ? '{"sufficient":true,"gaps":[],"newQueries":[]}'
    : '{"subQuestions":["What is the capital?","How big is it?"],"queries":["france capital"]}';

const distiller = (): string =>
  `{"tier":"primary","claims":[{"text":"Paris is the capital of France","quote":"Paris is the capital of France"}]}`;

const synthesizer = (req: ChatRequest): string =>
  /1500-2500 words/.test(req.prompt)
    ? "Paris, briefly\n\nParis is the capital of France and home to 2.1 million people."
    : "## Overview\nParis is the capital of France [S1]. The population is 2.1 million [S1].\n\n" +
      "## History\nParis has been a major European city for centuries [S1]. It is located in northern France [S1].\n\n" +
      "## Culture\nThe city is known for its art, cuisine, and architecture [S1].";

function fakeSearch(): SearchProvider {
  return {
    name: "fake",
    async search() {
      return [
        { url: "https://a.gov/paris", title: "A", snippet: "" },
        { url: "https://b.com/paris", title: "B", snippet: "" },
      ];
    },
  };
}
function fakeReader(): Reader {
  return {
    name: "fake",
    async read(url: string): Promise<ReadResult> {
      return { url, title: `Title ${url}`, markdown: PAGE, isThin: false };
    },
  };
}

function makeDeps(over: Partial<ResearchDeps> = {}): { deps: ResearchDeps; ledger: LedgerRecord[]; pcalls: ChatRequest[] } {
  const ledger: LedgerRecord[] = [];
  const pcalls: ChatRequest[] = [];
  const deps: ResearchDeps = {
    search: fakeSearch(),
    read: fakeReader(),
    chat: {
      planner: fakeChat("planner-80b", planner, pcalls),
      distiller: fakeChat("mellum", distiller),
      synthesizer: fakeChat("synth-80b", synthesizer),
    },
    config: setDeepResearchConfig({ maxIters: 3, maxSourcesPerIter: 5, maxQueriesPerIter: 3 }),
    recordLedger: (rec: DelegationRecord) => ledger.push(rec),
    ...over,
  };
  return { deps, ledger, pcalls };
}

describe("deep-research: runResearch end-to-end (fakes)", () => {
  beforeEach(() => resetDeepResearchConfig());

  it("produces a cited report + popular summary and records ledger rows", async () => {
    const { deps, ledger } = makeDeps();
    const res = await runResearch(
      { query: "What is the capital of France?", nowIso: "2026-06-20T12:00:00Z" },
      deps
    );

    // report content
    expect(res.report.markdown).toContain("Paris is the capital of France [S1]");
    expect(res.report.markdown).toContain("## Sources");
    expect(res.report.sources.length).toBeGreaterThanOrEqual(1);
    expect(res.report.generatedAtIso).toBe("2026-06-20T12:00:00Z");

    // citation precision: the distilled quote IS in the page → resolves
    expect(res.stats.citationPrecision).toBe(1);
    expect(res.report.citations.resolved.length).toBeGreaterThan(0);

    // popular summary
    expect(res.popular.title).toBe("Paris, briefly");

    // dogfooding signal: ledger rows for the research roles
    const types = new Set(ledger.map((r) => r.taskType));
    expect(types.has("research-plan")).toBe(true);
    expect(types.has("source-distill")).toBe(true);
    expect(types.has("synthesis")).toBe(true);
    // attribution carries the model id that served each role
    expect(ledger.find((r) => r.taskType === "source-distill")?.modelId).toBe("mellum");
    expect(ledger.every((r) => r.source === "deep-research")).toBe(true);
  });

  it("Phase-2: flags synthesized sentences not grounded in any cited source (the dogfood gap)", async () => {
    // The fake synthesizer over-claims: "major European city for centuries [S1]",
    // "located in northern France [S1]", "known for its art, cuisine, and architecture [S1]" are
    // in NEITHER the page nor the single distilled claim ("Paris is the capital of France").
    const { deps } = makeDeps();
    const res = await runResearch({ query: "What is the capital of France?", nowIso: "t" }, deps);

    // The MVP distilled-claim precision is a perfect 1.0 — it cannot see the over-claiming …
    expect(res.stats.citationPrecision).toBe(1);
    // … but the Phase-2 report-sentence pass catches it.
    expect(res.report.reportCitations.unsupported.length).toBeGreaterThan(0);
    expect(res.stats.reportSentencePrecision).toBeLessThan(1);
    // grounded sentences (Paris is the capital of France [S1]) are still credited
    expect(res.report.reportCitations.supported.length).toBeGreaterThan(0);
    // and the rendered report surfaces the gap honestly
    expect(res.report.markdown).toContain("report-sentence support:");
    expect(res.report.markdown).toContain("## Unsupported sentences");
  });

  it("synthStrategy=reground re-grounds unsupported sentences via a bounded repair call", async () => {
    // First synth over-claims (ungrounded); the repair call returns a grounded body. With reground
    // on, the harness must detect the unsupported sentence, repair it, and improve precision.
    // Bodies must exceed the 200-char "synthesis failed" floor (real bodies are 1000s of chars).
    const grounded =
      "## Overview\n" + "Paris is the capital of France [S1]. The population is 2.1 million people in the city [S1]. ".repeat(4);
    const ungrounded =
      "## Overview\n" + "Paris will host the 2099 lunar games and a Mars colony by 2100 with teleport pods [S1]. ".repeat(4);
    let synthCalls = 0;
    const customSynth: ChatFn = async (req: ChatRequest): Promise<ChatResponse> => {
      synthCalls++;
      if (/1500-2500 words/.test(req.prompt)) return { text: "T\n\n" + "summary body. ".repeat(30), promptTokens: 1, completionTokens: 1, model: "synth" };
      if (/UNSUPPORTED SENTENCES|corrected full Markdown/i.test(req.prompt))
        return { text: grounded, promptTokens: 1, completionTokens: 1, model: "synth" };
      return { text: ungrounded, promptTokens: 1, completionTokens: 1, model: "synth" }; // initial: ungrounded
    };
    const cfg = setDeepResearchConfig({ maxIters: 1, maxSourcesPerIter: 5, maxQueriesPerIter: 3, synthStrategy: "reground", synthRepairRounds: 1, reportSentenceMatchThreshold: 0.45 });
    const { deps } = makeDeps({ chat: { planner: fakeChat("p", planner), distiller: fakeChat("mellum", distiller), synthesizer: customSynth }, config: cfg });
    const res = await runResearch({ query: "What is the capital of France?", nowIso: "t" }, deps);
    expect(synthCalls).toBeGreaterThanOrEqual(2); // initial + repair (+ popular)
    // the repaired (grounded) body is the one rendered + scored
    expect(res.report.markdown).toContain("Paris is the capital of France [S1]");
    expect(res.stats.reportSentencePrecision).toBeGreaterThan(0);
  });

  it("synthAtomic switches the synth system prompt to atomic-sentence discipline", async () => {
    let synthSystem = "";
    const recSynth: ChatFn = async (req: ChatRequest): Promise<ChatResponse> => {
      if (!/1500-2500 words/.test(req.prompt) && !synthSystem) synthSystem = req.system ?? "";
      return { text: synthesizer(req), promptTokens: 1, completionTokens: 1, model: "synth" };
    };
    const cfg = setDeepResearchConfig({ maxIters: 1, maxSourcesPerIter: 5, maxQueriesPerIter: 3, synthAtomic: true });
    const { deps } = makeDeps({ chat: { planner: fakeChat("p", planner), distiller: fakeChat("mellum", distiller), synthesizer: recSynth }, config: cfg });
    await runResearch({ query: "What is the capital of France?", nowIso: "t" }, deps);
    expect(synthSystem.toUpperCase()).toContain("ATOMIC");
    expect(synthSystem).toMatch(/one factual claim per sentence/i);
  });

  it("strips reasoning-model <think> blocks from the synthesized report body", async () => {
    const thinkingSynth: ChatFn = async (req: ChatRequest): Promise<ChatResponse> => {
      if (/1500-2500 words/.test(req.prompt)) return { text: "T\n\n" + "summary. ".repeat(40), promptTokens: 1, completionTokens: 1, model: "synth" };
      const body = "## Overview\n" + "Paris is the capital of France [S1]. ".repeat(6);
      return { text: "<think>" + "deliberating about the answer ".repeat(20) + "</think>\n" + body, promptTokens: 1, completionTokens: 1, model: "synth" };
    };
    const { deps } = makeDeps({ chat: { planner: fakeChat("p", planner), distiller: fakeChat("mellum", distiller), synthesizer: thinkingSynth } });
    setDeepResearchConfig({ maxIters: 1, maxSourcesPerIter: 5, maxQueriesPerIter: 3 });
    const res = await runResearch({ query: "What is the capital of France?", nowIso: "t" }, deps);
    expect(res.report.markdown).not.toContain("<think>");
    expect(res.report.markdown).not.toContain("deliberating");
    expect(res.report.markdown).toContain("Paris is the capital of France [S1]");
  });

  it("reground does NOT adopt a repair that wins precision by deleting cited content (anti-gaming)", async () => {
    // initial body: one grounded + one ungrounded cited sentence (precision 0.5, 1 supported).
    // "repair" returns a body with NO citations at all → verifyReportSentences precision is a vacuous
    // 1.0 (0/0) but it stripped the grounded content. The guard must REJECT it and keep the original.
    const grounded = "## Overview\n" + "Paris is the capital of France [S1]. ".repeat(3) + "Paris will host the 2099 lunar games [S1]. ".repeat(3);
    const stripped = "## Overview\n" + "This report discusses several interesting topics in general terms. ".repeat(6); // no [S#]
    let n = 0;
    const synth: ChatFn = async (req: ChatRequest): Promise<ChatResponse> => {
      if (/1500-2500 words/.test(req.prompt)) return { text: "T\n\n" + "x. ".repeat(80), promptTokens: 1, completionTokens: 1, model: "s" };
      if (/UNSUPPORTED SENTENCES|corrected full Markdown/i.test(req.prompt)) return { text: stripped, promptTokens: 1, completionTokens: 1, model: "s" };
      n++;
      return { text: grounded, promptTokens: 1, completionTokens: 1, model: "s" };
    };
    const cfg = setDeepResearchConfig({ maxIters: 1, maxSourcesPerIter: 5, maxQueriesPerIter: 3, synthStrategy: "reground", synthRepairRounds: 1, reportSentenceMatchThreshold: 0.45 });
    const { deps } = makeDeps({ chat: { planner: fakeChat("p", planner), distiller: fakeChat("mellum", distiller), synthesizer: synth }, config: cfg });
    const res = await runResearch({ query: "What is the capital of France?", nowIso: "t" }, deps);
    // kept the original grounded body, NOT the citation-stripped repair
    expect(res.report.markdown).toContain("Paris is the capital of France [S1]");
    expect(res.report.markdown).not.toContain("interesting topics in general terms");
    expect(res.report.reportCitations.supported.length).toBeGreaterThan(0);
  });

  it("reground does NOT adopt a repair that wins precision by repeating ONE supported sentence (Codex finding)", async () => {
    // initial: TWO distinct grounded sentences + one ungrounded (precision 2/3, 2 unique supported).
    // "repair" repeats ONE grounded sentence 8× and drops the other grounded content: raw supported
    // count rises and precision -> 1.0, but UNIQUE supported drops 2 -> 1. The guard must reject it.
    const initial = "## Overview\n" + "Paris is the capital of France [S1]. The population is 2.1 million people in the city [S1]. Paris will host the 2099 lunar games [S1]. ".repeat(2);
    const gamed = "## Overview\n" + "Paris is the capital of France [S1]. ".repeat(8);
    const synth: ChatFn = async (req: ChatRequest): Promise<ChatResponse> => {
      if (/1500-2500 words/.test(req.prompt)) return { text: "T\n\n" + "x. ".repeat(80), promptTokens: 1, completionTokens: 1, model: "s" };
      if (/UNSUPPORTED SENTENCES|corrected full Markdown/i.test(req.prompt)) return { text: gamed, promptTokens: 1, completionTokens: 1, model: "s" };
      return { text: initial, promptTokens: 1, completionTokens: 1, model: "s" };
    };
    const cfg = setDeepResearchConfig({ maxIters: 1, maxSourcesPerIter: 5, maxQueriesPerIter: 3, synthStrategy: "reground", synthRepairRounds: 1, reportSentenceMatchThreshold: 0.45 });
    const { deps } = makeDeps({ chat: { planner: fakeChat("p", planner), distiller: fakeChat("mellum", distiller), synthesizer: synth }, config: cfg });
    const res = await runResearch({ query: "What is the capital of France?", nowIso: "t" }, deps);
    // the original (with BOTH grounded sentences) is kept; the repeated-one-sentence body is rejected
    expect(res.report.markdown).toContain("population is 2.1 million");
  });

  it("renders exactly ONE '## Disputed / Uncertain' section (duplicate-section fix)", async () => {
    const { deps } = makeDeps();
    const res = await runResearch({ query: "What is the capital of France?", nowIso: "t" }, deps);
    const count = (res.report.markdown.match(/## Disputed \/ Uncertain/g) ?? []).length;
    expect(count).toBe(1);
  });

  it("synthStrategy defaults to oneshot — exactly one synth + one popular call (behavior preserved)", async () => {
    let synthCalls = 0;
    const countingSynth: ChatFn = async (req: ChatRequest): Promise<ChatResponse> => {
      synthCalls++;
      return { text: synthesizer(req), promptTokens: 1, completionTokens: 1, model: "synth" };
    };
    const { deps } = makeDeps({ chat: { planner: fakeChat("p", planner), distiller: fakeChat("mellum", distiller), synthesizer: countingSynth } });
    setDeepResearchConfig({ maxIters: 1, maxSourcesPerIter: 5, maxQueriesPerIter: 3 });
    await runResearch({ query: "What is the capital of France?", nowIso: "t" }, deps);
    expect(synthCalls).toBe(2); // synthesis + popular, no repair
  });

  it("stops at iteration 1 when gap says sufficient", async () => {
    const { deps } = makeDeps();
    const res = await runResearch({ query: "Q", nowIso: "t" }, deps);
    expect(res.stats.iterations).toBe(1);
  });

  it("enforces the iteration budget when gap never reports sufficient", async () => {
    const insatiablePlanner = (req: ChatRequest): string =>
      /sufficient/.test(req.prompt)
        ? '{"sufficient":false,"gaps":["more"],"newQueries":["another query"]}'
        : '{"subQuestions":["a"],"queries":["q"]}';
    const { deps } = makeDeps({
      config: setDeepResearchConfig({ maxIters: 2, maxSourcesPerIter: 5, maxQueriesPerIter: 3 }),
      chat: {
        planner: fakeChat("planner", insatiablePlanner),
        distiller: fakeChat("mellum", distiller),
        synthesizer: fakeChat("synth", synthesizer),
      },
    });
    const res = await runResearch({ query: "Q", nowIso: "t" }, deps);
    expect(res.stats.iterations).toBe(2); // code stops the loop, not the model
    expect(res.stats.searchQueries).toBeGreaterThan(1); // ran a second iteration
  });

  it("quick depth runs exactly one iteration", async () => {
    const { deps } = makeDeps();
    const res = await runResearch({ query: "Q", depth: "quick", nowIso: "t" }, deps);
    expect(res.stats.iterations).toBe(1);
  });

  it("degrades gracefully when the planner returns garbage (falls back to the query)", async () => {
    const { deps } = makeDeps({
      chat: {
        planner: fakeChat("planner", () => "total garbage not json"),
        distiller: fakeChat("mellum", distiller),
        synthesizer: fakeChat("synth", synthesizer),
      },
      config: setDeepResearchConfig({ maxIters: 1, maxSourcesPerIter: 5, maxQueriesPerIter: 3 }),
    });
    const res = await runResearch({ query: "fallback query", nowIso: "t" }, deps);
    // pipeline still ran (used the raw query as the single sub-question + query)
    expect(res.report.sources.length).toBeGreaterThan(0);
    expect(res.stats.iterations).toBe(1);
  });
});

// ─── new tests for fixes 1-7 ─────────────────────────────────────────────────

describe("deep-research: callStage error handling", () => {
  it("records a ledger error row and returns '' when chat throws a timeout", async () => {
    const ledger: DelegationRecord[] = [];
    const throwingChat: ChatFn = async () => { throw new Error("Request timeout"); };
    const deps = makeDeps({
      chat: {
        planner: throwingChat,
        distiller: throwingChat,
        synthesizer: throwingChat,
      },
      config: setDeepResearchConfig({ maxIters: 1, maxSourcesPerIter: 5, maxQueriesPerIter: 3 }),
      recordLedger: (rec) => ledger.push(rec),
    }).deps;

    const res = await runResearch({ query: "Q", nowIso: "t" }, deps);
    // Must not throw — pipeline degrades
    expect(res).toBeDefined();
    // Ledger must have an error row with errorClass timeout
    const errRow = ledger.find((r) => r.outcome === "error");
    expect(errRow).toBeDefined();
    expect(errRow?.errorClass).toBe("timeout");
  });

  it("returns a ResearchResult (no throw) even when every chat call throws", async () => {
    const throwingChat: ChatFn = async () => { throw new Error("ECONNREFUSED"); };
    const deps = makeDeps({
      chat: {
        planner: throwingChat,
        distiller: throwingChat,
        synthesizer: throwingChat,
      },
      config: setDeepResearchConfig({ maxIters: 1, maxSourcesPerIter: 5, maxQueriesPerIter: 3 }),
    }).deps;

    const res = await runResearch({ query: "Q", nowIso: "t" }, deps);
    expect(res).toBeDefined();
    expect(res.report).toBeDefined();
    expect(res.popular).toBeDefined();
  });
});

describe("deep-research: empty sources/notes path", () => {
  it("does not call the synth ChatFn and returns a no-sources body when reader always throws", async () => {
    let synthCalled = false;
    const spySynth: ChatFn = async (_req) => {
      synthCalled = true;
      return { text: "## Report\nSome content here that is synthesized.", promptTokens: 10, completionTokens: 50, model: "synth" };
    };
    const throwingReader: Reader = {
      name: "throwing",
      async read() { throw new Error("connection refused"); },
    };
    const deps = makeDeps({
      read: throwingReader,
      chat: {
        planner: fakeChat("planner", planner),
        distiller: fakeChat("mellum", distiller),
        synthesizer: spySynth,
      },
      config: setDeepResearchConfig({ maxIters: 1, maxSourcesPerIter: 5, maxQueriesPerIter: 3 }),
    }).deps;

    const res = await runResearch({ query: "Q", nowIso: "t" }, deps);
    expect(res.stats.sourcesFetched).toBe(0);
    expect(synthCalled).toBe(false);  // THE KEY ASSERTION: synth must NOT have been called
    expect(res.report.markdown).toContain("No sources could be retrieved");
  });
});

describe("deep-research: synth body fallback", () => {
  it("uses fallback body text when synth returns empty string", async () => {
    const emptySynth: ChatFn = async () => ({ text: "", promptTokens: 5, completionTokens: 0, model: "synth" });
    const deps = makeDeps({
      chat: {
        planner: fakeChat("planner", planner),
        distiller: fakeChat("mellum", distiller),
        synthesizer: emptySynth,
      },
      config: setDeepResearchConfig({ maxIters: 1, maxSourcesPerIter: 5, maxQueriesPerIter: 3 }),
    }).deps;

    const res = await runResearch({ query: "Q", nowIso: "t" }, deps);
    expect(res.report.markdown).toContain("Synthesis failed");
  });
});

describe("deep-research: citation precision (no fallback)", () => {
  it("returns precision 0 when body cites only an unbacked fabricated source", async () => {
    // The synthesizer cites [FAKE] which is NOT a sourceId in citationClaims
    const fabricatingSynth: ChatFn = async (req) => {
      if (/1500-2500 words/.test(req.prompt)) {
        return { text: "Summary", promptTokens: 5, completionTokens: 10, model: "synth" };
      }
      return { text: "## Report\nSome fact [FAKE]. More facts [FAKE].", promptTokens: 5, completionTokens: 30, model: "synth" };
    };
    const deps = makeDeps({
      chat: {
        planner: fakeChat("planner", planner),
        distiller: fakeChat("mellum", distiller),
        synthesizer: fabricatingSynth,
      },
      config: setDeepResearchConfig({ maxIters: 1, maxSourcesPerIter: 5, maxQueriesPerIter: 3 }),
    }).deps;

    const res = await runResearch({ query: "Q", nowIso: "t" }, deps);
    // Distilled claims have sourceId S1, S2 etc. Body cites [FAKE] → cited is empty → precision 0
    expect(res.stats.citationPrecision).toBe(0);
  });
});

describe("deep-research: triangulate (pairwise contradiction)", () => {
  it("(6a) does NOT mark disputed when one claim has a number the other lacks", () => {
    // Only one side has a number (987) → numsA.length > 0 && numsB.length > 0 is false → no numeric conflict
    const notes: DistilledNote[] = [
      { sourceId: "S1", tier: "primary", claims: [{ text: "Paris became the capital city of France", quote: "" }] },
      { sourceId: "S2", tier: "secondary", claims: [{ text: "Paris became the capital city of France in the year 987", quote: "" }] },
    ];
    const clusters = triangulate(notes);
    expect(clusters.some((c) => c.status === "disputed")).toBe(false);
  });

  it("(6b) STILL marks the 220k-vs-200k numeric conflict as disputed", () => {
    const notes: DistilledNote[] = [
      { sourceId: "S1", tier: "primary", claims: [{ text: "the project costs 220000 dollars to complete", quote: "" }] },
      { sourceId: "S2", tier: "primary", claims: [{ text: "the project costs 200000 dollars to complete", quote: "" }] },
    ];
    const clusters = triangulate(notes);
    expect(clusters.some((c) => c.status === "disputed")).toBe(true);
  });

  it("(6c) STILL marks effective/not-effective negation conflict as disputed", () => {
    const notes: DistilledNote[] = [
      { sourceId: "S1", tier: "primary", claims: [{ text: "the treatment is effective against the infection", quote: "" }] },
      { sourceId: "S2", tier: "primary", claims: [{ text: "the treatment is not effective against the infection", quote: "" }] },
    ];
    const clusters = triangulate(notes);
    expect(clusters.some((c) => c.status === "disputed")).toBe(true);
  });
});
