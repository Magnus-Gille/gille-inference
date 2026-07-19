import { describe, it, expect, beforeEach } from "vitest";
import { runAgentResearch } from "../src/homeserver/deep-research-agent.js";
import { setDeepResearchConfig, resetDeepResearchConfig } from "../src/homeserver/deep-research-config.js";
import type {
  ChatFn,
  ChatRequest,
  ChatResponse,
  ResearchDeps,
  SearchProvider,
  Reader,
  ReadResult,
} from "../src/homeserver/deep-research-types.js";
import type { DelegationRecord as LedgerRecord } from "../src/homeserver/ledger.js";

// ─── fakes ────────────────────────────────────────────────────────────────────────

const S1_PAGE = "Paris is the capital of France. The population is 2.1 million people in the city.";
const S2_PAGE = "France is a country in Western Europe with a population of about 68 million people.";

/** A ChatFn that returns a queue of canned action strings, one per call (last value repeats). */
function scriptedChat(
  script: string[],
  opts: { model?: string; completionTokens?: number; calls?: ChatRequest[] } = {}
): ChatFn {
  let i = 0;
  return async (req: ChatRequest): Promise<ChatResponse> => {
    opts.calls?.push(req);
    const text = i < script.length ? script[i]! : script[script.length - 1] ?? "";
    i++;
    return {
      text,
      promptTokens: 10,
      completionTokens: opts.completionTokens ?? 20,
      model: opts.model ?? "tongyi-dr",
    };
  };
}

function fakeSearch(): SearchProvider {
  return {
    name: "fake",
    async search() {
      return [
        { url: "https://a.gov/paris", title: "Paris (gov)", snippet: "Paris is the capital of France." },
        { url: "https://b.com/france", title: "France (blog)", snippet: "France is in Western Europe." },
      ];
    },
  };
}

function fakeReader(over?: (url: string) => ReadResult): Reader {
  return {
    name: "fake",
    async read(url: string): Promise<ReadResult> {
      if (over) return over(url);
      const markdown = url.includes("a.gov") ? S1_PAGE : S2_PAGE;
      return { url, title: `Title ${url}`, markdown, isThin: false };
    },
  };
}

function makeDeps(
  chat: { planner: ChatFn },
  over: Partial<ResearchDeps> = {}
): { deps: ResearchDeps; ledger: LedgerRecord[] } {
  const ledger: LedgerRecord[] = [];
  const deps: ResearchDeps = {
    search: fakeSearch(),
    read: fakeReader(),
    // distiller/synthesizer are unused by the agent loop but the type requires them.
    chat: {
      planner: chat.planner,
      distiller: scriptedChat([""]),
      synthesizer: scriptedChat([""]),
    },
    config: setDeepResearchConfig({
      agentMaxTurns: 12,
      agentTokenBudget: 60000,
      agentReadCharCap: 4000,
      agentDialect: "generic",
    }),
    recordLedger: (rec) => ledger.push(rec),
    ...over,
  };
  return { deps, ledger };
}

const REQ = { query: "What is the capital of France?", nowIso: "2026-06-21T00:00:00Z" } as const;

describe("deep-research-agent: runAgentResearch (offline, DI)", () => {
  beforeEach(() => resetDeepResearchConfig());

  it("happy path: search → read S1 → read S2 → answer with [S1][S2]", async () => {
    const script = [
      JSON.stringify({ action: "search", query: "france capital" }),
      JSON.stringify({ action: "read", url: "https://a.gov/paris" }),
      JSON.stringify({ action: "read", url: "https://b.com/france" }),
      JSON.stringify({
        action: "answer",
        report:
          "## Overview\nParis is the capital of France [S1]. France is a country in Western Europe [S2].",
      }),
    ];
    const { deps } = makeDeps({ planner: scriptedChat(script) });
    const res = await runAgentResearch(deps, REQ);

    expect(res.report.sources.length).toBe(2);
    expect(res.report.sources.map((s) => s.id)).toEqual(["S1", "S2"]);
    // trust anchor ran and computed a precision
    expect(typeof res.report.reportCitations.precision).toBe("number");
    expect(res.report.reportCitations.supported.length).toBeGreaterThan(0);
    // rendered markdown has the standard sections
    expect(res.report.markdown).toContain("## Sources");
    expect(res.report.markdown).toContain("[S1]");
    expect(res.report.markdown).toContain("Paris is the capital of France [S1]");
    // stats populated
    expect(res.stats.searchQueries).toBe(1);
    expect(res.stats.sourcesFetched).toBe(2);
    expect(res.stats.totalCompletionTokens).toBeGreaterThan(0);
    expect(res.stats.modelCalls.agent).toBeGreaterThan(0);
    expect(res.report.brain).toBe("local");
    // popular summary is real, not empty
    expect(res.popular.markdown.trim().length).toBeGreaterThan(0);
  });

  it("trust anchor integrated: an [S1]-cited sentence not in S1 lands in unsupported", async () => {
    const script = [
      JSON.stringify({ action: "read", url: "https://a.gov/paris" }),
      JSON.stringify({
        action: "answer",
        report:
          "## Overview\nParis is the capital of France [S1]. Paris hosts a Mars colony with teleport pods by 2100 [S1].",
      }),
    ];
    const { deps } = makeDeps({ planner: scriptedChat(script) });
    const res = await runAgentResearch(deps, REQ);

    const unsupportedText = res.report.reportCitations.unsupported.map((u) => u.sentence).join(" | ");
    expect(res.report.reportCitations.unsupported.length).toBeGreaterThan(0);
    expect(unsupportedText.toLowerCase()).toContain("mars");
    expect(res.report.reportCitations.precision).toBeLessThan(1);
    expect(res.report.markdown).toContain("## Unsupported sentences");
  });

  it("agentMaxTurns cap: a brain that never answers force-finalizes with a report", async () => {
    // Always emits a (valid) reflect — never an answer. Must terminate at the turn cap.
    const { deps } = makeDeps(
      { planner: scriptedChat([JSON.stringify({ action: "reflect", note: "still thinking" })]) },
      { config: setDeepResearchConfig({ agentMaxTurns: 4, agentTokenBudget: 60000, agentDialect: "generic" }) }
    );
    const res = await runAgentResearch(deps, REQ);
    expect(res.stats.iterations).toBeLessThanOrEqual(4);
    expect(res.report.markdown.trim().length).toBeGreaterThan(0);
    // no sources read, no answer → safe insufficient-sources report (no hallucination)
    expect(res.report.markdown.toLowerCase()).toMatch(/insufficient|no sources/);
  });

  it("token-budget cap: a brain reporting large completion tokens stops at budget", async () => {
    // Each call burns 5000 tokens; budget 8000 → loop stops after ~2 calls without an answer.
    const { deps } = makeDeps(
      {
        planner: scriptedChat([JSON.stringify({ action: "reflect", note: "thinking" })], {
          completionTokens: 5000,
        }),
      },
      { config: setDeepResearchConfig({ agentMaxTurns: 50, agentTokenBudget: 8000, agentDialect: "generic" }) }
    );
    const res = await runAgentResearch(deps, REQ);
    // stopped well before the 50-turn cap because the token budget bit
    expect(res.stats.iterations).toBeLessThan(50);
    expect(res.stats.totalCompletionTokens).toBeGreaterThanOrEqual(8000);
    expect(res.report.markdown.trim().length).toBeGreaterThan(0);
  });

  it("retry-on-blank: blank then a valid action → wrapper retries and proceeds", async () => {
    const script = [
      "", // blank → retry
      JSON.stringify({ action: "read", url: "https://a.gov/paris" }),
      JSON.stringify({ action: "answer", report: "## Overview\nParis is the capital of France [S1]." }),
    ];
    const calls: ChatRequest[] = [];
    const { deps } = makeDeps(
      { planner: scriptedChat(script, { calls }) },
      { config: setDeepResearchConfig({ agentMaxTurns: 12, agentMaxBlankRetries: 2, agentDialect: "generic" }) }
    );
    const res = await runAgentResearch(deps, REQ);
    // the blank was retried (so the read still happened) and we ended with a real source
    expect(res.report.sources.length).toBe(1);
    expect(res.report.sources[0]!.id).toBe("S1");
    // retried at least once → more brain calls than turns that produced an action
    expect(calls.length).toBeGreaterThanOrEqual(3);
  });

  it("dedup: reading the same url twice does not create a duplicate Source", async () => {
    const script = [
      JSON.stringify({ action: "read", url: "https://a.gov/paris" }),
      JSON.stringify({ action: "read", url: "https://a.gov/paris" }), // same url again
      JSON.stringify({ action: "answer", report: "## Overview\nParis is the capital of France [S1]." }),
    ];
    const { deps } = makeDeps({ planner: scriptedChat(script) });
    const res = await runAgentResearch(deps, REQ);
    expect(res.report.sources.length).toBe(1);
    expect(res.report.sources[0]!.id).toBe("S1");
  });

  it("malformed/unknown action: 3 consecutive parse failures force-finalize (no infinite loop)", async () => {
    // Prose with no JSON action; the guard must correct then force-finalize after K=3.
    const { deps } = makeDeps(
      { planner: scriptedChat(["I think the answer is probably Paris but I am not sure."]) },
      { config: setDeepResearchConfig({ agentMaxTurns: 30, agentTokenBudget: 60000, agentDialect: "generic" }) }
    );
    const res = await runAgentResearch(deps, REQ);
    // terminated well before the 30-turn cap (parse-failure force-finalize at 3)
    expect(res.stats.iterations).toBeLessThan(30);
    expect(res.report.markdown.trim().length).toBeGreaterThan(0);
  });

  it("read failure: reader.read throws (SSRF-blocked) → caught, loop proceeds", async () => {
    let answered = false;
    const script = [
      JSON.stringify({ action: "read", url: "https://blocked.internal/secret" }),
      JSON.stringify({ action: "read", url: "https://a.gov/paris" }),
      JSON.stringify({ action: "answer", report: "## Overview\nParis is the capital of France [S1]." }),
    ];
    const throwingReader: Reader = {
      name: "fake",
      async read(url: string): Promise<ReadResult> {
        if (url.includes("blocked.internal")) throw new Error("reader: blocked host: blocked.internal");
        return { url, title: `Title ${url}`, markdown: S1_PAGE, isThin: false };
      },
    };
    const { deps } = makeDeps({ planner: scriptedChat(script) }, { read: throwingReader });
    const res = await runAgentResearch(deps, REQ);
    answered = res.report.markdown.includes("Paris is the capital of France [S1]");
    // the blocked read did not create a source; the good read did
    expect(res.report.sources.length).toBe(1);
    expect(res.report.sources[0]!.url).toContain("a.gov");
    expect(answered).toBe(true);
  });

  it("tolerates a fenced ```json action block and <think> wrapper", async () => {
    const script = [
      "<think>I should look this up</think>\n```json\n" +
        JSON.stringify({ action: "read", url: "https://a.gov/paris" }) +
        "\n```",
      "```json\n" +
        JSON.stringify({ action: "answer", report: "## Overview\nParis is the capital of France [S1]." }) +
        "\n```",
    ];
    const { deps } = makeDeps({ planner: scriptedChat(script) });
    const res = await runAgentResearch(deps, REQ);
    expect(res.report.sources.length).toBe(1);
    expect(res.report.markdown).toContain("Paris is the capital of France [S1]");
  });

  it("unclosed <think> in the answer body is stripped, never leaked into the report", async () => {
    // Tongyi is a reasoning model that can truncate mid-thought → an UNCLOSED <think> block.
    // The body strip must remove it to EOF (never render raw reasoning as the report), which
    // leaves an empty answer → safe force-finalize fallback from the source actually read.
    const script = [
      JSON.stringify({ action: "read", url: "https://a.gov/paris" }),
      JSON.stringify({
        action: "answer",
        report: "<think>SECRET_REASONING_TOKEN let me decide what to write about paris and how to",
      }),
    ];
    const { deps } = makeDeps({ planner: scriptedChat(script) });
    const res = await runAgentResearch(deps, REQ);
    expect(res.report.markdown).not.toContain("SECRET_REASONING_TOKEN");
    expect(JSON.stringify(res.report.sections)).not.toContain("SECRET_REASONING_TOKEN");
    // still produced a real, non-empty report (the deterministic fallback over the read source)
    expect(res.report.markdown.trim().length).toBeGreaterThan(0);
  });
});
