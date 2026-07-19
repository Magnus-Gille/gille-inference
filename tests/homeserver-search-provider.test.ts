/**
 * Tests for src/homeserver/search-provider.ts
 *
 * All network calls go through fake fetchImpl — no real HTTP ever fires.
 */

import { describe, it, expect, vi } from "vitest";
import type { SearchHit } from "../src/homeserver/deep-research-types.js";
import type { DeepResearchConfig } from "../src/homeserver/deep-research-config.js";
import {
  normalizeUrl,
  urlTier,
  dedupeAndRank,
  CircuitBreaker,
  SearxngProvider,
  BraveProvider,
  TavilyProvider,
  FallbackSearchProvider,
  DdgsProvider,
  makeSearchProvider,
} from "../src/homeserver/search-provider.js";

// ─── normalizeUrl ─────────────────────────────────────────────────────────────

describe("normalizeUrl", () => {
  it("strips utm_* tracking params", () => {
    const url = "https://example.com/page?utm_source=google&utm_campaign=test&id=42";
    const norm = normalizeUrl(url);
    expect(norm).not.toContain("utm_source");
    expect(norm).not.toContain("utm_campaign");
    expect(norm).toContain("id=42");
  });

  it("strips fbclid and gclid", () => {
    const url = "https://example.com/page?fbclid=abc123&gclid=xyz&q=hello";
    const norm = normalizeUrl(url);
    expect(norm).not.toContain("fbclid");
    expect(norm).not.toContain("gclid");
    expect(norm).toContain("q=hello");
  });

  it("strips ref param", () => {
    const url = "https://example.com/page?ref=twitter&title=foo";
    const norm = normalizeUrl(url);
    expect(norm).not.toContain("ref=");
    expect(norm).toContain("title=foo");
  });

  it("removes fragment", () => {
    const url = "https://example.com/page#section-2";
    expect(normalizeUrl(url)).not.toContain("#");
  });

  it("lowercases the host", () => {
    const url = "https://EXAMPLE.COM/page";
    expect(normalizeUrl(url)).toContain("example.com");
  });

  it("removes the default HTTPS port 443", () => {
    const url = "https://example.com:443/page";
    const norm = normalizeUrl(url);
    expect(norm).not.toContain(":443");
  });

  it("removes the default HTTP port 80", () => {
    const url = "http://example.com:80/page";
    const norm = normalizeUrl(url);
    expect(norm).not.toContain(":80");
  });

  it("keeps a non-default port", () => {
    const url = "http://localhost:8888/search";
    expect(normalizeUrl(url)).toContain(":8888");
  });

  it("removes a single trailing slash from the path", () => {
    const url = "https://example.com/some/path/";
    const norm = normalizeUrl(url);
    expect(norm).toMatch(/\/some\/path$/);
  });

  it("leaves the root path / alone", () => {
    const url = "https://example.com/";
    // root slash is fine — don't remove it entirely (URL spec keeps it)
    expect(normalizeUrl(url)).toBe("https://example.com/");
  });

  it("leaves a clean URL unchanged", () => {
    const url = "https://arxiv.org/abs/2301.00001";
    expect(normalizeUrl(url)).toBe(url);
  });

  it("returns input unchanged for an invalid URL", () => {
    const bad = "not a url at all";
    expect(normalizeUrl(bad)).toBe(bad);
  });
});

// ─── urlTier ──────────────────────────────────────────────────────────────────

describe("urlTier", () => {
  it("arxiv.org → primary", () => {
    expect(urlTier("https://arxiv.org/abs/1234.5678")).toBe("primary");
  });

  it("foo.gov → primary (TLD .gov)", () => {
    expect(urlTier("https://data.gov/dataset/foo")).toBe("primary");
  });

  it("mit.edu → primary (TLD .edu)", () => {
    expect(urlTier("https://mit.edu/research")).toBe("primary");
  });

  it("subdomain of .edu → primary", () => {
    expect(urlTier("https://cs.stanford.edu/~person")).toBe("primary");
  });

  it(".mil → primary", () => {
    expect(urlTier("https://afrl.mil/research")).toBe("primary");
  });

  it("*.gov.uk → primary", () => {
    expect(urlTier("https://www.nhs.gov.uk/conditions")).toBe("primary");
  });

  it(".ac.<tld> → primary (UK academic)", () => {
    expect(urlTier("https://ox.ac.uk/research")).toBe("primary");
  });

  it("nature.com → primary (known domain)", () => {
    expect(urlTier("https://www.nature.com/articles/s41586")).toBe("primary");
  });

  it("ieee.org → primary (known domain)", () => {
    expect(urlTier("https://ieeexplore.ieee.org/document/123")).toBe("primary");
  });

  it("wikipedia.org → secondary", () => {
    expect(urlTier("https://en.wikipedia.org/wiki/Foo")).toBe("secondary");
  });

  it("reuters.com → secondary", () => {
    expect(urlTier("https://www.reuters.com/article/foo")).toBe("secondary");
  });

  it("apnews.com → secondary", () => {
    expect(urlTier("https://apnews.com/article/foo-bar")).toBe("secondary");
  });

  it("bbc.co.uk → secondary", () => {
    expect(urlTier("https://www.bbc.co.uk/news/foo")).toBe("secondary");
  });

  it("bbc.com → secondary", () => {
    expect(urlTier("https://www.bbc.com/news/foo")).toBe("secondary");
  });

  it("nytimes.com → secondary", () => {
    expect(urlTier("https://www.nytimes.com/2024/foo")).toBe("secondary");
  });

  it("some-blog.com → tertiary", () => {
    expect(urlTier("https://some-blog.com/my-post")).toBe("tertiary");
  });

  it("random subdomain → tertiary", () => {
    expect(urlTier("https://news.ycombinator.com/item?id=1234")).toBe("tertiary");
  });

  it("invalid URL → tertiary", () => {
    expect(urlTier("not-a-url")).toBe("tertiary");
  });
});

// ─── dedupeAndRank ────────────────────────────────────────────────────────────

function hit(url: string, title = "T", snippet = "S"): SearchHit {
  return { url, title, snippet };
}

describe("dedupeAndRank", () => {
  it("removes exact duplicate URLs", () => {
    const hits = [hit("https://example.com/page"), hit("https://example.com/page")];
    expect(dedupeAndRank(hits)).toHaveLength(1);
  });

  it("dedupes by normalized URL (trailing slash)", () => {
    const hits = [hit("https://example.com/page/"), hit("https://example.com/page")];
    expect(dedupeAndRank(hits)).toHaveLength(1);
  });

  it("dedupes by normalized URL (tracking param)", () => {
    const hits = [
      hit("https://example.com/page?utm_source=foo"),
      hit("https://example.com/page"),
    ];
    expect(dedupeAndRank(hits)).toHaveLength(1);
  });

  it("drops URLs already in seenUrls", () => {
    const seen = new Set(["https://example.com/page"]);
    const hits = [hit("https://example.com/page"), hit("https://other.com/")];
    const result = dedupeAndRank(hits, { seenUrls: seen });
    expect(result).toHaveLength(1);
    expect(result[0].url).toBe("https://other.com/");
  });

  it("orders primary before tertiary", () => {
    const hits = [
      hit("https://some-blog.com/post"),   // tertiary
      hit("https://arxiv.org/abs/1234"),    // primary
    ];
    const result = dedupeAndRank(hits);
    expect(urlTier(result[0].url)).toBe("primary");
    expect(urlTier(result[1].url)).toBe("tertiary");
  });

  it("orders primary → secondary → tertiary", () => {
    const hits = [
      hit("https://some-blog.com/post"),         // tertiary
      hit("https://en.wikipedia.org/wiki/Foo"),  // secondary
      hit("https://arxiv.org/abs/1234"),          // primary
    ];
    const result = dedupeAndRank(hits);
    expect(urlTier(result[0].url)).toBe("primary");
    expect(urlTier(result[1].url)).toBe("secondary");
    expect(urlTier(result[2].url)).toBe("tertiary");
  });

  it("is stable within a tier (preserves input order)", () => {
    const hits = [
      hit("https://blog-a.com/post"),   // tertiary
      hit("https://blog-b.com/post"),   // tertiary
      hit("https://blog-c.com/post"),   // tertiary
    ];
    const result = dedupeAndRank(hits);
    expect(result[0].url).toContain("blog-a");
    expect(result[1].url).toContain("blog-b");
    expect(result[2].url).toContain("blog-c");
  });

  it("does not mutate the input array", () => {
    const hits = [hit("https://blog.com/a"), hit("https://arxiv.org/abs/1")];
    const copy = [...hits];
    dedupeAndRank(hits);
    expect(hits).toEqual(copy);
  });
});

// ─── CircuitBreaker ───────────────────────────────────────────────────────────

describe("CircuitBreaker", () => {
  it("is closed initially", () => {
    const b = new CircuitBreaker(3, 60_000);
    expect(b.isOpen()).toBe(false);
  });

  it("remains closed below threshold failures", () => {
    const b = new CircuitBreaker(3, 60_000);
    b.recordFailure();
    b.recordFailure();
    expect(b.isOpen()).toBe(false);
  });

  it("opens on reaching threshold failures", () => {
    let now = 1000;
    const b = new CircuitBreaker(3, 60_000, () => now);
    b.recordFailure();
    b.recordFailure();
    b.recordFailure();
    expect(b.isOpen()).toBe(true);
  });

  it("stays open during cooldown", () => {
    let now = 1000;
    const b = new CircuitBreaker(2, 60_000, () => now);
    b.recordFailure();
    b.recordFailure();
    now += 30_000; // half cooldown elapsed
    expect(b.isOpen()).toBe(true);
  });

  it("half-opens after cooldown elapses (isOpen returns false)", () => {
    let now = 1000;
    const b = new CircuitBreaker(2, 60_000, () => now);
    b.recordFailure();
    b.recordFailure();
    now += 60_000; // cooldown elapsed
    expect(b.isOpen()).toBe(false);
  });

  it("recordSuccess resets the breaker", () => {
    let now = 1000;
    const b = new CircuitBreaker(2, 60_000, () => now);
    b.recordFailure();
    b.recordFailure();
    expect(b.isOpen()).toBe(true);
    // advance past cooldown so a call goes through (half-open)
    now += 60_001;
    b.recordSuccess();
    expect(b.isOpen()).toBe(false);
    // and it shouldn't trip again until threshold new failures
    b.recordFailure();
    expect(b.isOpen()).toBe(false);
  });

  it("resets failure count on recordSuccess", () => {
    let now = 1000;
    const b = new CircuitBreaker(3, 60_000, () => now);
    b.recordFailure();
    b.recordFailure();
    b.recordSuccess();
    b.recordFailure();
    b.recordFailure();
    // only 2 failures since last success; threshold is 3
    expect(b.isOpen()).toBe(false);
  });
});

// ─── SearxngProvider ──────────────────────────────────────────────────────────

function makeFetch(status: number, body: unknown): typeof fetch {
  return vi.fn().mockResolvedValue({
    status,
    ok: status >= 200 && status < 300,
    json: () => Promise.resolve(body),
  }) as unknown as typeof fetch;
}

const SEARXNG_BODY = {
  results: [
    { url: "https://arxiv.org/abs/1", title: "Paper One", content: "Abstract one" },
    { url: "https://example.com/a", title: "Example A", content: "Snippet A" },
    { url: "https://example.com/b", title: "Example B", content: "Snippet B" },
  ],
};

describe("SearxngProvider", () => {
  it("parses a valid response into SearchHit[]", async () => {
    const p = new SearxngProvider({
      baseUrl: "http://searxng.local",
      fetchImpl: makeFetch(200, SEARXNG_BODY),
      resultsPerQuery: 10,
    });
    const hits = await p.search("test query");
    expect(hits).toHaveLength(3);
    expect(hits[0]).toEqual({ url: "https://arxiv.org/abs/1", title: "Paper One", snippet: "Abstract one" });
  });

  it("slices to resultsPerQuery", async () => {
    const p = new SearxngProvider({
      baseUrl: "http://searxng.local",
      fetchImpl: makeFetch(200, SEARXNG_BODY),
      resultsPerQuery: 2,
    });
    const hits = await p.search("test");
    expect(hits).toHaveLength(2);
  });

  it("sends a GET to /search?q=...&format=json", async () => {
    const fakeFetch = makeFetch(200, { results: [] });
    const p = new SearxngProvider({ baseUrl: "http://searxng.local", fetchImpl: fakeFetch });
    await p.search("hello world");
    const url = (fakeFetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(url).toContain("/search?q=");
    expect(url).toContain("format=json");
    expect(url).toContain(encodeURIComponent("hello world"));
  });

  it("returns [] for an empty results array (valid JSON, no hits)", async () => {
    const p = new SearxngProvider({
      baseUrl: "http://searxng.local",
      fetchImpl: makeFetch(200, { results: [] }),
    });
    expect(await p.search("noop")).toEqual([]);
  });

  it("throws on a non-2xx response", async () => {
    const p = new SearxngProvider({
      baseUrl: "http://searxng.local",
      fetchImpl: makeFetch(403, {}),
    });
    await expect(p.search("fail")).rejects.toThrow(/403/);
  });
});

// ─── BraveProvider ────────────────────────────────────────────────────────────

const BRAVE_BODY = {
  web: {
    results: [
      { url: "https://reuters.com/article/1", title: "Reuters 1", description: "Desc 1" },
      { url: "https://blog.com/post", title: "Blog Post", description: "Desc 2" },
    ],
  },
};

describe("BraveProvider", () => {
  it("parses a valid response into SearchHit[]", async () => {
    const p = new BraveProvider({
      apiKey: "test-key",
      fetchImpl: makeFetch(200, BRAVE_BODY),
      resultsPerQuery: 10,
    });
    const hits = await p.search("news");
    expect(hits).toHaveLength(2);
    expect(hits[0]).toEqual({
      url: "https://reuters.com/article/1",
      title: "Reuters 1",
      snippet: "Desc 1",
    });
  });

  it("maps description → snippet", async () => {
    const p = new BraveProvider({
      apiKey: "k",
      fetchImpl: makeFetch(200, BRAVE_BODY),
    });
    const hits = await p.search("q");
    expect(hits[0].snippet).toBe("Desc 1");
  });

  it("slices to resultsPerQuery", async () => {
    const p = new BraveProvider({
      apiKey: "k",
      fetchImpl: makeFetch(200, BRAVE_BODY),
      resultsPerQuery: 1,
    });
    expect(await p.search("q")).toHaveLength(1);
  });

  it("sends X-Subscription-Token header", async () => {
    const fakeFetch = makeFetch(200, { web: { results: [] } });
    const p = new BraveProvider({ apiKey: "my-key", fetchImpl: fakeFetch });
    await p.search("q");
    const opts = (fakeFetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    expect((opts.headers as Record<string, string>)["X-Subscription-Token"]).toBe("my-key");
  });

  it("throws on non-2xx", async () => {
    const p = new BraveProvider({ apiKey: "k", fetchImpl: makeFetch(401, {}) });
    await expect(p.search("q")).rejects.toThrow(/401/);
  });
});

// ─── TavilyProvider ───────────────────────────────────────────────────────────

const TAVILY_BODY = {
  results: [
    { url: "https://nature.com/article/1", title: "Nature Study", content: "Study content" },
    { url: "https://medium.com/post", title: "Medium Post", content: "Post content" },
  ],
};

describe("TavilyProvider", () => {
  it("parses a valid response into SearchHit[]", async () => {
    const p = new TavilyProvider({
      apiKey: "tv-key",
      fetchImpl: makeFetch(200, TAVILY_BODY),
      resultsPerQuery: 10,
    });
    const hits = await p.search("studies");
    expect(hits).toHaveLength(2);
    expect(hits[0]).toEqual({
      url: "https://nature.com/article/1",
      title: "Nature Study",
      snippet: "Study content",
    });
  });

  it("maps content → snippet", async () => {
    const p = new TavilyProvider({ apiKey: "k", fetchImpl: makeFetch(200, TAVILY_BODY) });
    const hits = await p.search("q");
    expect(hits[0].snippet).toBe("Study content");
  });

  it("slices to resultsPerQuery", async () => {
    const p = new TavilyProvider({
      apiKey: "k",
      fetchImpl: makeFetch(200, TAVILY_BODY),
      resultsPerQuery: 1,
    });
    expect(await p.search("q")).toHaveLength(1);
  });

  it("POSTs to api.tavily.com/search with api_key + query + max_results in body", async () => {
    const fakeFetch = makeFetch(200, { results: [] });
    const p = new TavilyProvider({ apiKey: "tv", fetchImpl: fakeFetch, resultsPerQuery: 5 });
    await p.search("climate change");
    const call = (fakeFetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const url = call[0] as string;
    const opts = call[1] as RequestInit;
    expect(url).toContain("tavily.com/search");
    expect(opts.method).toBe("POST");
    const body = JSON.parse(opts.body as string);
    expect(body.api_key).toBe("tv");
    expect(body.query).toBe("climate change");
    expect(body.max_results).toBe(5);
  });

  it("throws on non-2xx", async () => {
    const p = new TavilyProvider({ apiKey: "k", fetchImpl: makeFetch(429, {}) });
    await expect(p.search("q")).rejects.toThrow(/429/);
  });
});

// ─── FallbackSearchProvider ───────────────────────────────────────────────────

function makeProvider(
  name: string,
  impl: (q: string) => Promise<SearchHit[]>,
): SearchProvider & { searchSpy: ReturnType<typeof vi.fn> } {
  const spy = vi.fn(impl);
  return {
    name,
    search: spy,
    searchSpy: spy,
  };
}

const FAKE_HITS: SearchHit[] = [
  { url: "https://fallback.com/a", title: "FB A", snippet: "sn" },
];

const PRIMARY_HITS: SearchHit[] = [
  { url: "https://primary.com/a", title: "PR A", snippet: "sn" },
];

describe("FallbackSearchProvider", () => {
  it("name is primary->fallback", () => {
    const p = makeProvider("searxng", async () => PRIMARY_HITS);
    const f = makeProvider("brave", async () => FAKE_HITS);
    const fb = new FallbackSearchProvider(p, f, { breakerThreshold: 3, cooldownMs: 60_000 });
    expect(fb.name).toBe("searxng->brave");
  });

  it("uses primary when it succeeds", async () => {
    const p = makeProvider("searxng", async () => PRIMARY_HITS);
    const f = makeProvider("brave", async () => FAKE_HITS);
    const fb = new FallbackSearchProvider(p, f, { breakerThreshold: 3, cooldownMs: 60_000 });
    const result = await fb.search("q");
    expect(result).toEqual(PRIMARY_HITS);
    expect(f.searchSpy).not.toHaveBeenCalled();
  });

  it("falls back when primary throws", async () => {
    const p = makeProvider("searxng", async () => { throw new Error("503"); });
    const f = makeProvider("brave", async () => FAKE_HITS);
    const fb = new FallbackSearchProvider(p, f, { breakerThreshold: 3, cooldownMs: 60_000 });
    const result = await fb.search("q");
    expect(result).toEqual(FAKE_HITS);
    expect(f.searchSpy).toHaveBeenCalledOnce();
  });

  it("falls back when primary returns empty results", async () => {
    const p = makeProvider("searxng", async () => []);
    const f = makeProvider("brave", async () => FAKE_HITS);
    const fb = new FallbackSearchProvider(p, f, { breakerThreshold: 3, cooldownMs: 60_000 });
    const result = await fb.search("q");
    expect(result).toEqual(FAKE_HITS);
    expect(f.searchSpy).toHaveBeenCalledOnce();
  });

  it("after threshold primary failures the breaker is open and primary is skipped", async () => {
    let now = 1000;
    const p = makeProvider("searxng", async () => { throw new Error("503"); });
    const f = makeProvider("brave", async () => FAKE_HITS);
    const fb = new FallbackSearchProvider(p, f, {
      breakerThreshold: 2,
      cooldownMs: 60_000,
      now: () => now,
    });

    // Two failures → breaker opens
    await fb.search("q1");
    await fb.search("q2");

    // Clear call history
    p.searchSpy.mockClear();
    f.searchSpy.mockClear();

    // Third call — breaker is open; primary should NOT be called
    await fb.search("q3");
    expect(p.searchSpy).not.toHaveBeenCalled();
    expect(f.searchSpy).toHaveBeenCalledOnce();
  });

  it("primary not called again during cooldown after breaker trips", async () => {
    let now = 1000;
    const p = makeProvider("searxng", async () => { throw new Error("err"); });
    const f = makeProvider("brave", async () => FAKE_HITS);
    const fb = new FallbackSearchProvider(p, f, {
      breakerThreshold: 1,
      cooldownMs: 60_000,
      now: () => now,
    });

    await fb.search("q1"); // trips breaker
    p.searchSpy.mockClear();

    now += 30_000; // still in cooldown
    await fb.search("q2");
    expect(p.searchSpy).not.toHaveBeenCalled();
  });
});

// ─── makeSearchProvider ───────────────────────────────────────────────────────

function minConfig(overrides: Partial<DeepResearchConfig> = {}): DeepResearchConfig {
  return {
    plannerModel: "planner",
    distillModel: "distill",
    synthModel: "synth",
    verifyModel: "",
    brain: "local",
    gatewayUrl: "http://127.0.0.1:8080/v1",
    gatewayApiKey: "",
    hybridBaseUrl: "",
    hybridApiKey: "",
    hybridPlanModel: "",
    hybridSynthModel: "",
    maxIters: 3,
    maxSourcesPerIter: 12,
    maxQueriesPerIter: 5,
    resultsPerQuery: 8,
    distillMaxChars: 24_000,
    searchProvider: "searxng",
    searchFallbackProvider: "brave",
    searchUrl: "http://127.0.0.1:8888",
    searchApiKey: "test-key",
    ddgsPython: "python3",
    ddgsScript: "scripts/ddgs_search.py",
    readerProvider: "trafilatura",
    readerFallbackProvider: "jina",
    readerThinChars: 500,
    trafilaturaCmd: "trafilatura",
    jinaBaseUrl: "https://r.jina.ai",
    breakerThreshold: 3,
    breakerCooldownMs: 60_000,
    citationMatchThreshold: 0.8,
    outputDir: "./data/research",
    mimirResearchDir: "",
    mimirReadingDir: "",
    ...overrides,
  };
}

describe("DdgsProvider (Docker-free shell-out)", () => {
  const canned = JSON.stringify([
    { url: "https://a.gov/x", title: "A", snippet: "alpha" },
    { url: "https://b.com/y", title: "B", snippet: "beta" },
  ]);

  it("parses the helper's JSON into SearchHit[] and passes the query as a separate arg", async () => {
    const calls: { python: string; args: string[] }[] = [];
    const p = new DdgsProvider({
      python: "py",
      script: "s.py",
      resultsPerQuery: 8,
      runner: async (python, args) => {
        calls.push({ python, args });
        return canned;
      },
    });
    const hits = await p.search("speed of light");
    expect(hits).toEqual([
      { url: "https://a.gov/x", title: "A", snippet: "alpha" },
      { url: "https://b.com/y", title: "B", snippet: "beta" },
    ]);
    // query is argv[1], never interpolated into a shell string
    expect(calls[0]!.python).toBe("py");
    // a relative script path is resolved against the repo root → cwd-independent (not bare "s.py")
    expect(calls[0]!.args[0]).toMatch(/[/\\]s\.py$/);
    expect(calls[0]!.args[0]).not.toBe("s.py");
    expect(calls[0]!.args.slice(1)).toEqual(["speed of light", "8"]);
  });

  it("keeps an absolute script path unchanged", async () => {
    const calls: string[][] = [];
    const p = new DdgsProvider({
      python: "py",
      script: "/opt/app/ddgs_search.py",
      runner: async (_python, args) => {
        calls.push(args);
        return canned;
      },
    });
    await p.search("q");
    expect(calls[0]![0]).toBe("/opt/app/ddgs_search.py");
  });

  it("drops rows without a url BEFORE applying the resultsPerQuery cap", async () => {
    // url-less row FIRST with cap 2: slice-then-filter would yield only 1 hit; filter-then-slice → 2.
    const body = JSON.stringify([
      { title: "no url", snippet: "" },
      { url: "https://a.com", title: "A", snippet: "" },
      { url: "https://b.com", title: "B", snippet: "" },
    ]);
    const p = new DdgsProvider({ python: "py", script: "s.py", resultsPerQuery: 2, runner: async () => body });
    const hits = await p.search("q");
    expect(hits).toEqual([
      { url: "https://a.com", title: "A", snippet: "" },
      { url: "https://b.com", title: "B", snippet: "" },
    ]);
  });

  it("throws on non-JSON output (so the breaker trips → fallback)", async () => {
    const p = new DdgsProvider({ python: "py", script: "s.py", runner: async () => "ddgs search failed: rate limit" });
    await expect(p.search("q")).rejects.toThrow(/non-JSON/);
  });

  it("propagates a runner rejection (helper exited non-zero)", async () => {
    const p = new DdgsProvider({
      python: "py",
      script: "s.py",
      runner: async () => {
        throw new Error("Command failed: exit 1");
      },
    });
    await expect(p.search("q")).rejects.toThrow();
  });
});

describe("makeSearchProvider", () => {
  it("builds a ddgs->brave provider when configured", () => {
    const provider = makeSearchProvider(minConfig({ searchProvider: "ddgs", searchFallbackProvider: "brave" }));
    expect(provider.name).toBe("ddgs->brave");
  });
  it("builds a searxng->brave provider by default config", () => {
    const fakeFetch = makeFetch(200, { results: [] });
    const provider = makeSearchProvider(minConfig(), fakeFetch);
    expect(provider.name).toBe("searxng->brave");
  });

  it("builds a searxng->tavily provider when fallback is tavily", () => {
    const fakeFetch = makeFetch(200, { results: [] });
    const provider = makeSearchProvider(
      minConfig({ searchProvider: "searxng", searchFallbackProvider: "tavily" }),
      fakeFetch,
    );
    expect(provider.name).toBe("searxng->tavily");
  });

  it("builds a brave->tavily provider", () => {
    const fakeFetch = makeFetch(200, { web: { results: [] } });
    const provider = makeSearchProvider(
      minConfig({ searchProvider: "brave", searchFallbackProvider: "tavily" }),
      fakeFetch,
    );
    expect(provider.name).toBe("brave->tavily");
  });

  it("throws a clear error for an unknown primary provider", () => {
    expect(() =>
      makeSearchProvider(minConfig({ searchProvider: "perplexity" })),
    ).toThrow(/unknown search provider.*perplexity/i);
  });

  it("throws a clear error for an unknown fallback provider", () => {
    expect(() =>
      makeSearchProvider(minConfig({ searchFallbackProvider: "duckduckgo" })),
    ).toThrow(/unknown search provider.*duckduckgo/i);
  });

  it("threads fetchImpl into providers (verified via live search call)", async () => {
    const fakeFetch = makeFetch(200, { results: [
      { url: "https://arxiv.org/abs/1", title: "T", content: "S" },
    ]});
    const provider = makeSearchProvider(minConfig(), fakeFetch);
    const hits = await provider.search("anything");
    // The fake fetch was used (real fetch would fail; our fake returns a result)
    expect(hits.length).toBeGreaterThan(0);
    expect(fakeFetch as ReturnType<typeof vi.fn>).toHaveBeenCalled();
  });
});
