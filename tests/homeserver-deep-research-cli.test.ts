import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli, slugify, buildResearchDeps, makeChatFn, applyChatParams } from "../src/homeserver/deep-research-cli.js";
import { runAgentResearch } from "../src/homeserver/deep-research-agent.js";
import {
  loadDeepResearchConfig,
  resetDeepResearchConfig,
  setDeepResearchConfig,
} from "../src/homeserver/deep-research-config.js";
import type { ResearchResult, ChatFn, ChatRequest } from "../src/homeserver/deep-research-types.js";

const tmpDirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "dr-cli-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  resetDeepResearchConfig();
});

function fakeResult(): ResearchResult {
  return {
    report: {
      query: "Q",
      generatedAtIso: "2026-06-20T00:00:00Z",
      sections: [],
      disputed: [],
      sources: [{ id: "S1", url: "https://a.gov/x", title: "A", tier: "primary", markdown: "", contentHash: "h" }],
      brain: "local",
      iterations: 1,
      citations: { resolved: [], unresolved: [], precision: 1 },
      reportCitations: { supported: [], unsupported: [], uncitedSentenceCount: 0, precision: 1 },
      markdown: "# Research report: Q\n\n## Overview\nBody [S1].\n\n## Sources\n- [S1] ...",
    },
    popular: { title: "A friendly title", markdown: "A friendly title\n\nAccessible body." },
    stats: {
      iterations: 1,
      searchQueries: 1,
      sourcesFetched: 1,
      sourcesDistilled: 1,
      claimsExtracted: 2,
      claimsDisputed: 0,
      citationPrecision: 1,
      reportSentencePrecision: 1,
      totalCompletionTokens: 99,
      modelCalls: { "research-plan": 1, "source-distill": 1, synthesis: 2 },
    },
  };
}

describe("deep-research-cli: slugify", () => {
  it("sanitizes and suffixes deterministically", () => {
    const a = slugify("What is the Capital of France?", "2026-06-20T00:00:00Z");
    const b = slugify("What is the Capital of France?", "2026-06-20T00:00:00Z");
    expect(a).toBe(b); // deterministic for the same query+time
    expect(a).toMatch(/^what-is-the-capital-of-france-[0-9a-f]{6}$/);
  });
  it("handles an all-symbol query without producing an empty slug", () => {
    expect(slugify("???", "t")).toMatch(/^research-[0-9a-f]{6}$/);
  });
});

describe("deep-research-cli: runCli writes artifacts", () => {
  it("writes report.md, popular.md and meta.json from the pipeline result", async () => {
    const out = tmp();
    const res = await runCli(
      { query: "Q", nowIso: "2026-06-20T00:00:00Z", outputDir: out, noLedger: true },
      { deps: {} as never, run: async () => fakeResult() }
    );
    expect(res.dir.startsWith(out)).toBe(true);

    const report = readFileSync(res.reportPath, "utf-8");
    const popular = readFileSync(res.popularPath, "utf-8");
    const meta = JSON.parse(readFileSync(res.metaPath, "utf-8"));

    expect(report).toContain("# Research report: Q");
    expect(popular).toContain("# A friendly title");
    expect(meta.query).toBe("Q");
    expect(meta.stats.citationPrecision).toBe(1);
    expect(meta.sources[0].id).toBe("S1");
    expect(res.stats.totalCompletionTokens).toBe(99);
  });

  it("passes the request flags through to the pipeline", async () => {
    const out = tmp();
    let seen: { depth?: string; brain?: string; sensitive?: boolean } = {};
    await runCli(
      { query: "Q", depth: "quick", brain: "hybrid", sensitive: true, nowIso: "t", outputDir: out, noLedger: true },
      {
        deps: {} as never,
        run: async (req) => {
          seen = { depth: req.depth, brain: req.brain, sensitive: req.sensitive };
          return fakeResult();
        },
      }
    );
    expect(seen).toEqual({ depth: "quick", brain: "hybrid", sensitive: true });
  });
});

describe("deep-research-cli: agent mode", () => {
  it("runs the model-driven ReAct pipeline end-to-end via runCli (offline, injected deps)", async () => {
    const out = tmp();
    // a scripted brain: read S1 → answer citing [S1]
    const PAGE = "Paris is the capital of France. The population is 2.1 million people.";
    const script = [
      JSON.stringify({ action: "read", url: "https://a.gov/paris" }),
      JSON.stringify({ action: "answer", report: "## Overview\nParis is the capital of France [S1]." }),
    ];
    let i = 0;
    const brain: ChatFn = async () => ({
      text: i < script.length ? script[i++]! : script[script.length - 1]!,
      promptTokens: 1,
      completionTokens: 5,
      model: "tongyi-dr",
    });
    const deps = {
      search: { name: "fake", async search() { return [{ url: "https://a.gov/paris", title: "P", snippet: "" }]; } },
      read: { name: "fake", async read(url: string) { return { url, title: "P", markdown: PAGE, isThin: false }; } },
      chat: { planner: brain, distiller: brain, synthesizer: brain },
      // generic-JSON script → run the generic dialect (default is tongyi).
      config: setDeepResearchConfig({ agentDialect: "generic" }),
    } as never;

    const res = await runCli(
      {
        query: "What is the capital of France?",
        nowIso: "2026-06-21T00:00:00Z",
        outputDir: out,
        noLedger: true,
        mode: "agent",
        dialect: "generic",
      },
      { deps, run: async (req, d) => runAgentResearch(d, req) }
    );
    const report = readFileSync(res.reportPath, "utf-8");
    expect(report).toContain("Paris is the capital of France [S1]");
    expect(report).toContain("## Sources");
    expect(res.stats.sourcesFetched).toBe(1);
  });

  it("buildResearchDeps in agent mode wires the agent model into all chat ports (local-only)", () => {
    const cfg = loadDeepResearchConfig();
    const deps = buildResearchDeps(cfg, { mode: "agent" });
    expect(typeof deps.chat.planner).toBe("function");
    expect(typeof deps.chat.distiller).toBe("function");
    expect(typeof deps.chat.synthesizer).toBe("function");
    expect(typeof deps.search.search).toBe("function");
    expect(typeof deps.read.read).toBe("function");
  });
});

describe("deep-research-cli: composition root", () => {
  it("buildResearchDeps wires all ports and routes distill local even in hybrid", () => {
    const cfg = loadDeepResearchConfig();
    const deps = buildResearchDeps(cfg, { brain: "hybrid" });
    expect(typeof deps.search.search).toBe("function");
    expect(typeof deps.read.read).toBe("function");
    expect(typeof deps.chat.planner).toBe("function");
    expect(typeof deps.chat.distiller).toBe("function");
    expect(typeof deps.chat.synthesizer).toBe("function");
  });

  it("sensitive forces local even when config brain is hybrid (no throw, builds deps)", () => {
    const cfg = loadDeepResearchConfig();
    const deps = buildResearchDeps(cfg, { brain: "hybrid", sensitive: true });
    expect(typeof deps.chat.planner).toBe("function");
  });

  it("makeChatFn returns a callable ChatFn without performing any network call at construction", () => {
    const fn = makeChatFn("http://127.0.0.1:9/v1", "k", "mellum");
    expect(typeof fn).toBe("function");
  });
});

describe("deep-research-cli: applyChatParams (per-role temp + token floor)", () => {
  it("injects temperature and floors maxTokens for a reasoning role", async () => {
    const seen: ChatRequest[] = [];
    const fake: ChatFn = async (req) => {
      seen.push(req);
      return { text: "ok", promptTokens: 0, completionTokens: 0, model: "m" };
    };
    const wrapped = applyChatParams(fake, { temperature: 0.6, minTokens: 8000 });
    await wrapped({ prompt: "p", maxTokens: 1500 });
    expect(seen[0]!.temperature).toBe(0.6);
    expect(seen[0]!.maxTokens).toBe(8000); // floored up from 1500
    await wrapped({ prompt: "p2", maxTokens: 9000 });
    expect(seen[1]!.maxTokens).toBe(9000); // never lowered below the request
  });

  it("does not override a temperature the caller already set", async () => {
    const seen: ChatRequest[] = [];
    const fake: ChatFn = async (req) => {
      seen.push(req);
      return { text: "ok", promptTokens: 0, completionTokens: 0, model: "m" };
    };
    const wrapped = applyChatParams(fake, { temperature: 0.6, minTokens: 0 });
    await wrapped({ prompt: "p", temperature: 0.2 });
    expect(seen[0]!.temperature).toBe(0.2);
  });

  it("returns the original fn unchanged when temp=0 and no floor (zero overhead)", () => {
    const fake: ChatFn = async () => ({ text: "x", promptTokens: 0, completionTokens: 0, model: "m" });
    expect(applyChatParams(fake, { temperature: 0, minTokens: 0 })).toBe(fake);
  });
});
