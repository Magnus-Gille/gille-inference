/**
 * tests/homeserver-reader.test.ts
 *
 * Unit tests for src/homeserver/reader.ts.
 * No Python, no network — all side effects injected.
 */

import { describe, it, expect, vi } from "vitest";
import {
  contentHash,
  isThin,
  shingleSimilarity,
  nearDuplicate,
  dedupePages,
  TrafilaturaReader,
  JinaReader,
  FallbackReader,
  makeReader,
} from "../src/homeserver/reader.js";
import type { ReadResult } from "../src/homeserver/deep-research-types.js";
import type { DeepResearchConfig } from "../src/homeserver/deep-research-config.js";

// ─── helpers ──────────────────────────────────────────────────────────────────

const LONG_TEXT =
  "The quick brown fox jumps over the lazy dog. " +
  "Pack my box with five dozen liquor jugs. " +
  "How vexingly quick daft zebras jump. " +
  "The five boxing wizards jump quickly. " +
  "Sphinx of black quartz judge my vow. " +
  "Jackdaws love my big sphinx of quartz. ";

// Repeat to get well past 5 words × 5 shingles worth of coverage
const LONG_A = LONG_TEXT.repeat(4);
// One word changed deep in the text → still near-identical
const LONG_B = LONG_A.replace("foxes", "fox").replace(
  "The quick brown fox",
  "The quick brown cat"
);
const SHORT_TEXT = "hello world";

function makeConfig(overrides: Partial<DeepResearchConfig> = {}): DeepResearchConfig {
  return {
    plannerModel: "test",
    distillModel: "test",
    synthModel: "test",
    verifyModel: "",
    brain: "local",
    gatewayUrl: "http://127.0.0.1:8080/v1",
    gatewayApiKey: "",
    hybridBaseUrl: "https://openrouter.ai/api/v1",
    hybridApiKey: "",
    hybridPlanModel: "",
    hybridSynthModel: "",
    maxIters: 3,
    maxSourcesPerIter: 12,
    maxQueriesPerIter: 5,
    resultsPerQuery: 8,
    distillMaxChars: 24000,
    searchProvider: "searxng",
    searchFallbackProvider: "brave",
    searchUrl: "http://127.0.0.1:8888",
    searchApiKey: "",
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

function makeReadResult(markdown: string, url = "https://example.com"): ReadResult {
  return { url, markdown, isThin: false };
}

// ─── contentHash ──────────────────────────────────────────────────────────────

describe("contentHash", () => {
  it("is stable across calls", () => {
    expect(contentHash("hello world")).toBe(contentHash("hello world"));
  });

  it("whitespace-only differences hash the same", () => {
    expect(contentHash("hello  world")).toBe(contentHash("hello world"));
    expect(contentHash("  hello world  ")).toBe(contentHash("hello world"));
    expect(contentHash("hello\n world\t")).toBe(contentHash("hello world"));
  });

  it("case-only differences hash the same", () => {
    expect(contentHash("Hello World")).toBe(contentHash("hello world"));
    expect(contentHash("HELLO WORLD")).toBe(contentHash("hello world"));
  });

  it("different text → different hash", () => {
    expect(contentHash("hello world")).not.toBe(contentHash("goodbye world"));
    expect(contentHash("foo")).not.toBe(contentHash("bar"));
  });

  it("returns a 64-char hex string (sha256)", () => {
    expect(contentHash("anything")).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ─── isThin ───────────────────────────────────────────────────────────────────

describe("isThin", () => {
  it("returns true when below thinChars", () => {
    expect(isThin("short", 500)).toBe(true);
    expect(isThin("", 1)).toBe(true);
  });

  it("returns false when at or above thinChars", () => {
    const text = "a".repeat(500);
    expect(isThin(text, 500)).toBe(false);
    expect(isThin(text + "b", 500)).toBe(false);
  });

  it("trims before counting", () => {
    // "   " trimmed → length 0 < 500
    expect(isThin("   ", 500)).toBe(true);
  });
});

// ─── shingleSimilarity ───────────────────────────────────────────────────────

describe("shingleSimilarity", () => {
  it("identical text → 1", () => {
    expect(shingleSimilarity(LONG_A, LONG_A)).toBe(1);
  });

  it("near-identical text (one word changed) → high score", () => {
    const sim = shingleSimilarity(LONG_A, LONG_B);
    expect(sim).toBeGreaterThan(0.8);
  });

  it("unrelated texts → low score", () => {
    const a = "alpha beta gamma delta epsilon zeta eta theta iota kappa";
    const b = "one two three four five six seven eight nine ten eleven";
    expect(shingleSimilarity(a, b)).toBeLessThan(0.1);
  });

  it("short texts (<5 words) fall back to exact equality", () => {
    expect(shingleSimilarity("hi", "hi")).toBe(1);
    expect(shingleSimilarity("hi", "bye")).toBe(0);
  });

  it("is symmetric", () => {
    expect(shingleSimilarity(LONG_A, LONG_B)).toBeCloseTo(
      shingleSimilarity(LONG_B, LONG_A),
      10
    );
  });
});

// ─── nearDuplicate ────────────────────────────────────────────────────────────

describe("nearDuplicate", () => {
  it("identical text → true", () => {
    expect(nearDuplicate(LONG_A, LONG_A)).toBe(true);
  });

  it("near-identical → true (default threshold 0.9)", () => {
    expect(nearDuplicate(LONG_A, LONG_B)).toBe(true);
  });

  it("unrelated texts → false", () => {
    const a = "alpha beta gamma delta epsilon zeta eta theta iota kappa";
    const b = "one two three four five six seven eight nine ten eleven";
    expect(nearDuplicate(a, b)).toBe(false);
  });

  it("respects custom threshold", () => {
    // Force threshold to 0 → everything is a dup
    expect(nearDuplicate("foo bar baz qux quux", "different words here again always", 0)).toBe(true);
    // Force threshold to 1 → only identical passes
    expect(nearDuplicate(LONG_A, LONG_B, 1)).toBe(false);
    expect(nearDuplicate(LONG_A, LONG_A, 1)).toBe(true);
  });
});

// ─── dedupePages ─────────────────────────────────────────────────────────────

describe("dedupePages", () => {
  it("two near-duplicate pages collapse to one", () => {
    const p1 = makeReadResult(LONG_A, "https://a.com");
    const p2 = makeReadResult(LONG_B, "https://b.com");
    const result = dedupePages([p1, p2]);
    expect(result).toHaveLength(1);
    expect(result[0]!.url).toBe("https://a.com"); // first one kept
  });

  it("distinct pages are all kept", () => {
    const p1 = makeReadResult("alpha beta gamma delta epsilon zeta eta theta", "https://a.com");
    const p2 = makeReadResult("one two three four five six seven eight nine", "https://b.com");
    const p3 = makeReadResult("Lorem ipsum dolor sit amet consectetur adipiscing", "https://c.com");
    const result = dedupePages([p1, p2, p3]);
    expect(result).toHaveLength(3);
  });

  it("preserves order of kept pages", () => {
    const urls = ["https://first.com", "https://second.com", "https://third.com"];
    const p1 = makeReadResult("Alpha beta gamma delta epsilon zeta eta theta iota", urls[0]!);
    const p2 = makeReadResult("One two three four five six seven eight nine ten", urls[1]!);
    const p3 = makeReadResult("Lorem ipsum dolor sit amet consectetur adipiscing elit", urls[2]!);
    const result = dedupePages([p1, p2, p3]);
    expect(result.map((r) => r.url)).toEqual(urls);
  });

  it("does not mutate input", () => {
    const pages = [makeReadResult(LONG_A), makeReadResult(LONG_B)];
    const orig = [...pages];
    dedupePages(pages);
    expect(pages).toEqual(orig);
  });

  it("respects custom threshold", () => {
    const p1 = makeReadResult(LONG_A, "https://a.com");
    const p2 = makeReadResult(LONG_B, "https://b.com");
    // threshold 0 → everything is a dup of kept pages (first always kept)
    const result = dedupePages([p1, p2], { threshold: 0 });
    expect(result).toHaveLength(1);
  });

  it("empty input → empty output", () => {
    expect(dedupePages([])).toEqual([]);
  });
});

// ─── TrafilaturaReader ────────────────────────────────────────────────────────

describe("TrafilaturaReader", () => {
  it("returns ReadResult with injected markdown and correct isThin (not thin)", async () => {
    const bigMarkdown = "word ".repeat(200); // 1000 chars > 500
    const runner = vi.fn().mockResolvedValue(bigMarkdown);
    const reader = new TrafilaturaReader({ cmd: "trafilatura", thinChars: 500, runner });
    const result = await reader.read("https://example.com/page");
    expect(result).toMatchObject({
      url: "https://example.com/page",
      markdown: bigMarkdown,
      isThin: false,
      fetchedVia: "trafilatura",
    });
    expect(runner).toHaveBeenCalledWith("https://example.com/page");
  });

  it("runner returns '' → isThin true", async () => {
    const runner = vi.fn().mockResolvedValue("");
    const reader = new TrafilaturaReader({ cmd: "trafilatura", thinChars: 500, runner });
    const result = await reader.read("https://example.com/empty");
    expect(result.isThin).toBe(true);
    expect(result.markdown).toBe("");
  });

  it("runner returns thin text → isThin true", async () => {
    const runner = vi.fn().mockResolvedValue("short");
    const reader = new TrafilaturaReader({ cmd: "trafilatura", thinChars: 500, runner });
    const result = await reader.read("https://example.com/thin");
    expect(result.isThin).toBe(true);
  });

  it("ftp:// URL → throws before calling runner", async () => {
    const runner = vi.fn();
    const reader = new TrafilaturaReader({ cmd: "trafilatura", thinChars: 500, runner });
    await expect(reader.read("ftp://example.com/file")).rejects.toThrow(/http/);
    expect(runner).not.toHaveBeenCalled();
  });

  it("file:// URL → throws before calling runner", async () => {
    const runner = vi.fn();
    const reader = new TrafilaturaReader({ cmd: "trafilatura", thinChars: 500, runner });
    await expect(reader.read("file:///etc/passwd")).rejects.toThrow(/http/);
    expect(runner).not.toHaveBeenCalled();
  });

  it("name is 'trafilatura'", () => {
    const reader = new TrafilaturaReader({
      cmd: "trafilatura",
      thinChars: 500,
      runner: vi.fn(),
    });
    expect(reader.name).toBe("trafilatura");
  });
});

// ─── JinaReader ───────────────────────────────────────────────────────────────

describe("JinaReader", () => {
  it("returns ReadResult from fake fetchImpl", async () => {
    const bigMarkdown = "content ".repeat(200);
    const fetchImpl = vi.fn().mockResolvedValue({
      headers: { get: vi.fn().mockReturnValue(null) },
      text: vi.fn().mockResolvedValue(bigMarkdown),
    } as unknown as Response);
    const reader = new JinaReader({
      baseUrl: "https://r.jina.ai",
      thinChars: 500,
      fetchImpl,
    });
    const result = await reader.read("https://example.com/article");
    expect(result).toMatchObject({
      url: "https://example.com/article",
      markdown: bigMarkdown,
      isThin: false,
      fetchedVia: "jina",
    });
    // Jina URL is baseUrl/targetUrl (second arg is the fetch init with AbortSignal)
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://r.jina.ai/https://example.com/article",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it("non-http URL → throws before fetching", async () => {
    const fetchImpl = vi.fn();
    const reader = new JinaReader({
      baseUrl: "https://r.jina.ai",
      thinChars: 500,
      fetchImpl,
    });
    await expect(reader.read("javascript:alert(1)")).rejects.toThrow(/http/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("ftp:// URL → throws", async () => {
    const fetchImpl = vi.fn();
    const reader = new JinaReader({
      baseUrl: "https://r.jina.ai",
      thinChars: 500,
      fetchImpl,
    });
    await expect(reader.read("ftp://files.example.com/a")).rejects.toThrow(/http/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("name is 'jina'", () => {
    const reader = new JinaReader({
      baseUrl: "https://r.jina.ai",
      thinChars: 500,
      fetchImpl: vi.fn(),
    });
    expect(reader.name).toBe("jina");
  });
});

// ─── FallbackReader ───────────────────────────────────────────────────────────

describe("FallbackReader", () => {
  const thinChars = 500;
  const bigMarkdown = "word ".repeat(300); // ~1500 chars > 500
  const thinMarkdown = "thin"; // < 500

  function makePrimary(overrides: Partial<PromiseLike<ReadResult>> & { markdown?: string; throws?: boolean }) {
    if (overrides.throws) {
      return { name: "primary", read: vi.fn().mockRejectedValue(new Error("primary failed")) };
    }
    const md = overrides.markdown ?? bigMarkdown;
    return {
      name: "primary",
      read: vi.fn().mockResolvedValue({
        url: "https://example.com",
        markdown: md,
        isThin: md.trim().length < thinChars,
        fetchedVia: "primary",
      } satisfies ReadResult),
    };
  }

  function makeFallback(markdown = bigMarkdown) {
    return {
      name: "fallback",
      read: vi.fn().mockResolvedValue({
        url: "https://example.com",
        markdown,
        isThin: markdown.trim().length < thinChars,
        fetchedVia: "fallback",
      } satisfies ReadResult),
    };
  }

  it("primary throws → fallback used", async () => {
    const primary = makePrimary({ throws: true });
    const fallback = makeFallback();
    const reader = new FallbackReader(primary, fallback);
    const result = await reader.read("https://example.com");
    expect(result.fetchedVia).toBe("fallback");
    expect(fallback.read).toHaveBeenCalledOnce();
  });

  it("primary thin → fallback used", async () => {
    const primary = makePrimary({ markdown: thinMarkdown });
    const fallback = makeFallback();
    const reader = new FallbackReader(primary, fallback);
    const result = await reader.read("https://example.com");
    expect(result.fetchedVia).toBe("fallback");
    expect(fallback.read).toHaveBeenCalledOnce();
  });

  it("primary good (not thin) → fallback NOT called", async () => {
    const primary = makePrimary({ markdown: bigMarkdown });
    const fallback = makeFallback();
    const reader = new FallbackReader(primary, fallback);
    const result = await reader.read("https://example.com");
    expect(result.fetchedVia).toBe("primary");
    expect(fallback.read).not.toHaveBeenCalled();
  });

  it("fallback result returned even if also thin (best effort)", async () => {
    const primary = makePrimary({ throws: true });
    const fallback = makeFallback(thinMarkdown); // fallback also thin
    const reader = new FallbackReader(primary, fallback);
    const result = await reader.read("https://example.com");
    expect(result.fetchedVia).toBe("fallback");
    expect(result.isThin).toBe(true); // returned as-is
  });

  it("name is primary->fallback", () => {
    const primary = makePrimary({});
    const fallback = makeFallback();
    const reader = new FallbackReader(primary, fallback);
    expect(reader.name).toBe("primary->fallback");
  });
});

// ─── makeReader ───────────────────────────────────────────────────────────────

describe("makeReader", () => {
  it("returns a FallbackReader wrapping trafilatura→jina by default", () => {
    const runner = vi.fn();
    const fetchImpl = vi.fn();
    const config = makeConfig();
    const reader = makeReader(config, { runner, fetchImpl });
    expect(reader.name).toBe("trafilatura->jina");
  });

  it("uses the injected runner for trafilatura calls", async () => {
    const bigMarkdown = "x ".repeat(400);
    const runner = vi.fn().mockResolvedValue(bigMarkdown);
    const fetchImpl = vi.fn();
    const config = makeConfig({ readerThinChars: 100 });
    const reader = makeReader(config, { runner, fetchImpl });
    const result = await reader.read("https://example.com/test");
    expect(runner).toHaveBeenCalled();
    expect(result.markdown).toBe(bigMarkdown);
  });

  it("falls through to jina when trafilatura is thin", async () => {
    const runner = vi.fn().mockResolvedValue(""); // thin
    const jinaMarkdown = "full content ".repeat(100);
    const fetchImpl = vi.fn().mockResolvedValue({
      text: vi.fn().mockResolvedValue(jinaMarkdown),
    } as unknown as Response);
    const config = makeConfig({ readerThinChars: 500 });
    const reader = makeReader(config, { runner, fetchImpl });
    const result = await reader.read("https://example.com/js-heavy");
    expect(fetchImpl).toHaveBeenCalled();
    expect(result.markdown).toBe(jinaMarkdown);
    expect(result.fetchedVia).toBe("jina");
  });

  it("unknown readerProvider → throws", () => {
    const config = makeConfig({ readerProvider: "crawl4ai" });
    expect(() => makeReader(config)).toThrow(/unknown provider/);
  });

  it("unknown readerFallbackProvider → throws", () => {
    const config = makeConfig({ readerFallbackProvider: "wget" });
    expect(() => makeReader(config)).toThrow(/unknown provider/);
  });
});

// ─── Security: SSRF host blocklist ───────────────────────────────────────────

describe("SSRF blocklist — TrafilaturaReader", () => {
  function makeBlockedRunner() {
    return vi.fn().mockResolvedValue("content ".repeat(200));
  }

  function reader(runner = makeBlockedRunner()) {
    return new TrafilaturaReader({ cmd: "trafilatura", thinChars: 500, runner });
  }

  // Loopback
  it("blocks http://127.0.0.1:8080/admin", async () => {
    const r = reader();
    await expect(r.read("http://127.0.0.1:8080/admin")).rejects.toThrow(/blocked host/);
    expect(r["runner"]).not.toHaveBeenCalled();
  });

  it("blocks http://127.0.0.1/", async () => {
    const r = reader();
    await expect(r.read("http://127.0.0.1/")).rejects.toThrow(/blocked host/);
  });

  it("blocks http://127.255.255.255/", async () => {
    const r = reader();
    await expect(r.read("http://127.255.255.255/")).rejects.toThrow(/blocked host/);
  });

  // Cloud metadata
  it("blocks http://169.254.169.254/latest/meta-data/", async () => {
    const r = reader();
    await expect(r.read("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(/blocked host/);
  });

  it("blocks http://169.254.0.1/", async () => {
    const r = reader();
    await expect(r.read("http://169.254.0.1/")).rejects.toThrow(/blocked host/);
  });

  // RFC-1918 private ranges
  it("blocks http://10.0.0.5/", async () => {
    const r = reader();
    await expect(r.read("http://10.0.0.5/")).rejects.toThrow(/blocked host/);
  });

  it("blocks http://10.255.255.255/", async () => {
    const r = reader();
    await expect(r.read("http://10.255.255.255/")).rejects.toThrow(/blocked host/);
  });

  it("blocks http://172.16.0.1/", async () => {
    const r = reader();
    await expect(r.read("http://172.16.0.1/")).rejects.toThrow(/blocked host/);
  });

  it("blocks http://172.31.255.255/", async () => {
    const r = reader();
    await expect(r.read("http://172.31.255.255/")).rejects.toThrow(/blocked host/);
  });

  it("blocks http://192.168.1.1/", async () => {
    const r = reader();
    await expect(r.read("http://192.168.1.1/")).rejects.toThrow(/blocked host/);
  });

  it("blocks http://192.168.0.255/", async () => {
    const r = reader();
    await expect(r.read("http://192.168.0.255/")).rejects.toThrow(/blocked host/);
  });

  // IPv6 loopback / ULA / link-local
  it("blocks http://[::1]/", async () => {
    const r = reader();
    await expect(r.read("http://[::1]/")).rejects.toThrow(/blocked host/);
  });

  it("blocks http://[fc00::1]/", async () => {
    const r = reader();
    await expect(r.read("http://[fc00::1]/")).rejects.toThrow(/blocked host/);
  });

  it("blocks http://[fd12:3456:789a:1::1]/", async () => {
    const r = reader();
    await expect(r.read("http://[fd12:3456:789a:1::1]/")).rejects.toThrow(/blocked host/);
  });

  it("blocks http://[fe80::1]/", async () => {
    const r = reader();
    await expect(r.read("http://[fe80::1]/")).rejects.toThrow(/blocked host/);
  });

  // Blocked hostnames
  it("blocks http://localhost/", async () => {
    const r = reader();
    await expect(r.read("http://localhost/")).rejects.toThrow(/blocked host/);
  });

  it("blocks http://foo.localhost/", async () => {
    const r = reader();
    await expect(r.read("http://foo.localhost/")).rejects.toThrow(/blocked host/);
  });

  it("blocks http://internal.local/", async () => {
    const r = reader();
    await expect(r.read("http://internal.local/")).rejects.toThrow(/blocked host/);
  });

  it("blocks http://service.internal/", async () => {
    const r = reader();
    await expect(r.read("http://service.internal/")).rejects.toThrow(/blocked host/);
  });

  // Normal public URLs pass through
  it("allows https://en.wikipedia.org/wiki/SSRF", async () => {
    const runner = vi.fn().mockResolvedValue("real content ".repeat(50));
    const r = new TrafilaturaReader({ cmd: "trafilatura", thinChars: 10, runner });
    const result = await r.read("https://en.wikipedia.org/wiki/SSRF");
    expect(result.url).toBe("https://en.wikipedia.org/wiki/SSRF");
    expect(runner).toHaveBeenCalledWith("https://en.wikipedia.org/wiki/SSRF");
  });

  it("allows https://example.com/page", async () => {
    const runner = vi.fn().mockResolvedValue("content ".repeat(100));
    const r = new TrafilaturaReader({ cmd: "trafilatura", thinChars: 10, runner });
    await expect(r.read("https://example.com/page")).resolves.toMatchObject({
      fetchedVia: "trafilatura",
    });
  });

  // allowPrivateHosts escape hatch (for tests / trusted callers)
  it("allowPrivateHosts: true bypasses blocklist", async () => {
    const runner = vi.fn().mockResolvedValue("content ".repeat(100));
    const r = new TrafilaturaReader({
      cmd: "trafilatura",
      thinChars: 10,
      runner,
      allowPrivateHosts: true,
    });
    await expect(r.read("http://127.0.0.1:8080/v1")).resolves.toMatchObject({
      fetchedVia: "trafilatura",
    });
  });
});

describe("SSRF blocklist — JinaReader", () => {
  function makeJinaReader(overrides: { allowPrivateHosts?: boolean } = {}) {
    const fetchImpl = vi.fn().mockResolvedValue({
      headers: { get: vi.fn().mockReturnValue(null) },
      text: vi.fn().mockResolvedValue("content ".repeat(200)),
    } as unknown as Response);
    const reader = new JinaReader({
      baseUrl: "https://r.jina.ai",
      thinChars: 500,
      fetchImpl,
      ...overrides,
    });
    return { reader, fetchImpl };
  }

  it("blocks http://127.0.0.1:8080/admin before Jina fetch", async () => {
    const { reader, fetchImpl } = makeJinaReader();
    await expect(reader.read("http://127.0.0.1:8080/admin")).rejects.toThrow(/blocked host/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("blocks http://169.254.169.254/latest/meta-data/", async () => {
    const { reader, fetchImpl } = makeJinaReader();
    await expect(reader.read("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(/blocked host/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("blocks http://10.0.0.5/", async () => {
    const { reader, fetchImpl } = makeJinaReader();
    await expect(reader.read("http://10.0.0.5/")).rejects.toThrow(/blocked host/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("blocks http://192.168.1.1/", async () => {
    const { reader, fetchImpl } = makeJinaReader();
    await expect(reader.read("http://192.168.1.1/")).rejects.toThrow(/blocked host/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("blocks http://[::1]/", async () => {
    const { reader, fetchImpl } = makeJinaReader();
    await expect(reader.read("http://[::1]/")).rejects.toThrow(/blocked host/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("blocks http://localhost/", async () => {
    const { reader, fetchImpl } = makeJinaReader();
    await expect(reader.read("http://localhost/")).rejects.toThrow(/blocked host/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("allows https://example.com/article", async () => {
    const { reader } = makeJinaReader();
    await expect(reader.read("https://example.com/article")).resolves.toMatchObject({
      fetchedVia: "jina",
    });
  });

  it("allowPrivateHosts: true bypasses blocklist for Jina", async () => {
    const { reader } = makeJinaReader({ allowPrivateHosts: true });
    await expect(reader.read("http://127.0.0.1:8080/v1")).resolves.toMatchObject({
      fetchedVia: "jina",
    });
  });
});

// ─── Security: Jina timeout and size cap ─────────────────────────────────────

describe("JinaReader — timeout and size limits", () => {
  it("default fetchTimeoutMs is 20000", () => {
    const reader = new JinaReader({
      baseUrl: "https://r.jina.ai",
      thinChars: 500,
      fetchImpl: vi.fn(),
    });
    expect(reader.fetchTimeoutMs).toBe(20_000);
  });

  it("default maxContentLength is 5_000_000", () => {
    const reader = new JinaReader({
      baseUrl: "https://r.jina.ai",
      thinChars: 500,
      fetchImpl: vi.fn(),
    });
    expect(reader.maxContentLength).toBe(5_000_000);
  });

  it("default maxMarkdownChars is 500_000", () => {
    const reader = new JinaReader({
      baseUrl: "https://r.jina.ai",
      thinChars: 500,
      fetchImpl: vi.fn(),
    });
    expect(reader.maxMarkdownChars).toBe(500_000);
  });

  it("custom fetchTimeoutMs is wired — AbortSignal is passed to fetchImpl", async () => {
    let capturedSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedSignal = init?.signal as AbortSignal | undefined;
      return Promise.resolve({
        headers: { get: vi.fn().mockReturnValue(null) },
        text: vi.fn().mockResolvedValue("content ".repeat(200)),
      });
    });
    const reader = new JinaReader({
      baseUrl: "https://r.jina.ai",
      thinChars: 500,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      fetchTimeoutMs: 7_000,
    });
    await reader.read("https://example.com/page");
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
  });

  it("rejects when Content-Length exceeds maxContentLength", async () => {
    const tooBig = "6000000"; // 6 MB > default 5 MB
    const fetchImpl = vi.fn().mockResolvedValue({
      headers: { get: vi.fn().mockReturnValue(tooBig) },
      text: vi.fn().mockResolvedValue("x"),
    } as unknown as Response);
    const reader = new JinaReader({
      baseUrl: "https://r.jina.ai",
      thinChars: 500,
      fetchImpl,
    });
    await expect(reader.read("https://example.com/huge")).rejects.toThrow(
      /too large/
    );
  });

  it("does NOT reject when Content-Length is within limit", async () => {
    const ok = "1000000"; // 1 MB < 5 MB default
    const fetchImpl = vi.fn().mockResolvedValue({
      headers: { get: vi.fn().mockReturnValue(ok) },
      text: vi.fn().mockResolvedValue("content ".repeat(200)),
    } as unknown as Response);
    const reader = new JinaReader({
      baseUrl: "https://r.jina.ai",
      thinChars: 500,
      fetchImpl,
    });
    await expect(reader.read("https://example.com/ok")).resolves.toMatchObject({
      fetchedVia: "jina",
    });
  });

  it("truncates markdown that exceeds maxMarkdownChars", async () => {
    const longBody = "a".repeat(600_000); // > default 500_000
    const fetchImpl = vi.fn().mockResolvedValue({
      headers: { get: vi.fn().mockReturnValue(null) },
      text: vi.fn().mockResolvedValue(longBody),
    } as unknown as Response);
    const reader = new JinaReader({
      baseUrl: "https://r.jina.ai",
      thinChars: 500,
      fetchImpl,
      maxMarkdownChars: 500_000,
    });
    const result = await reader.read("https://example.com/truncated");
    expect(result.markdown.length).toBe(500_000);
  });

  it("does not truncate markdown within maxMarkdownChars", async () => {
    const body = "b".repeat(1000);
    const fetchImpl = vi.fn().mockResolvedValue({
      headers: { get: vi.fn().mockReturnValue(null) },
      text: vi.fn().mockResolvedValue(body),
    } as unknown as Response);
    const reader = new JinaReader({
      baseUrl: "https://r.jina.ai",
      thinChars: 500,
      fetchImpl,
    });
    const result = await reader.read("https://example.com/small");
    expect(result.markdown.length).toBe(1000);
  });
});

// ─── Security: Trafilatura execFile timeout / maxBuffer ──────────────────────

describe("TrafilaturaReader — execFile timeout and maxBuffer", () => {
  it("default execTimeoutMs is 30000", () => {
    const reader = new TrafilaturaReader({
      cmd: "trafilatura",
      thinChars: 500,
      runner: vi.fn(),
    });
    expect(reader.execTimeoutMs).toBe(30_000);
  });

  it("default execMaxBuffer is 8_000_000", () => {
    const reader = new TrafilaturaReader({
      cmd: "trafilatura",
      thinChars: 500,
      runner: vi.fn(),
    });
    expect(reader.execMaxBuffer).toBe(8_000_000);
  });

  it("custom execTimeoutMs is stored on the instance", () => {
    const reader = new TrafilaturaReader({
      cmd: "trafilatura",
      thinChars: 500,
      runner: vi.fn(),
      execTimeoutMs: 5_000,
    });
    expect(reader.execTimeoutMs).toBe(5_000);
  });

  it("custom execMaxBuffer is stored on the instance", () => {
    const reader = new TrafilaturaReader({
      cmd: "trafilatura",
      thinChars: 500,
      runner: vi.fn(),
      execMaxBuffer: 1_000_000,
    });
    expect(reader.execMaxBuffer).toBe(1_000_000);
  });

  it("when no runner is injected, default runner is created with execTimeoutMs/execMaxBuffer", () => {
    // We can't observe execFileAsync directly, but we can verify the instance
    // fields reflect the values that would be passed to makeDefaultRunner.
    const reader = new TrafilaturaReader({
      cmd: "trafilatura",
      thinChars: 500,
      execTimeoutMs: 15_000,
      execMaxBuffer: 2_000_000,
    });
    expect(reader.execTimeoutMs).toBe(15_000);
    expect(reader.execMaxBuffer).toBe(2_000_000);
  });
});
