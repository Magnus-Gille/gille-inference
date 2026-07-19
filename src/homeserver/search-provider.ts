/**
 * Pluggable SEARCH layer for the deep-research harness.
 *
 * Providers: SearXNG (primary), Brave, Tavily (fallbacks).
 * Wraps primary+fallback behind a CircuitBreaker.
 * Utility: normalizeUrl, urlTier, dedupeAndRank.
 *
 * All network calls go through injectable `fetchImpl` so tests never hit the network.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join } from "node:path";
import type { SearchHit, SearchProvider, SourceTier } from "./deep-research-types.js";
import type { DeepResearchConfig } from "./deep-research-config.js";

/** Repo root, resolved from this module — so a relative ddgs script path does NOT depend on cwd. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const execFileAsync = promisify(execFile);

// ─── URL utilities ────────────────────────────────────────────────────────────

const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
  "utm_reader",
  "utm_name",
  "utm_cid",
  "fbclid",
  "gclid",
  "ref",
  "mc_cid",
  "mc_eid",
]);

const DEFAULT_PORTS: Record<string, string> = {
  "http:": "80",
  "https:": "443",
};

/**
 * Strip tracking params (utm_*, fbclid, gclid, ref), fragment, default ports;
 * lowercase host; remove a single trailing slash on the path.
 * Returns the cleaned URL string. Invalid → input unchanged.
 */
export function normalizeUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }

  parsed.hostname = parsed.hostname.toLowerCase();

  // Remove default port
  if (parsed.port && DEFAULT_PORTS[parsed.protocol] === parsed.port) {
    parsed.port = "";
  }

  // Strip tracking params
  for (const key of [...parsed.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(key.toLowerCase()) || key.toLowerCase().startsWith("utm_")) {
      parsed.searchParams.delete(key);
    }
  }

  // Remove fragment
  parsed.hash = "";

  // Remove a single trailing slash from the path (but leave "/" alone)
  if (parsed.pathname.length > 1 && parsed.pathname.endsWith("/")) {
    parsed.pathname = parsed.pathname.slice(0, -1);
  }

  return parsed.toString();
}

// ─── Source tier ──────────────────────────────────────────────────────────────

const PRIMARY_DOMAINS = new Set([
  "arxiv.org",
  "nih.gov",
  "who.int",
  "nature.com",
  "science.org",
  "ieee.org",
  "pubmed.ncbi.nlm.nih.gov",
  "ncbi.nlm.nih.gov",
  "cdc.gov",
  "fda.gov",
  "nist.gov",
  "nsf.gov",
  "nasa.gov",
  "epa.gov",
]);

const SECONDARY_DOMAINS = new Set([
  "wikipedia.org",
  "reuters.com",
  "apnews.com",
  "bbc.co.uk",
  "bbc.com",
  "nytimes.com",
  "theguardian.com",
  "washingtonpost.com",
  "economist.com",
  "scientificamerican.com",
  "newscientist.com",
  "technologyreview.mit.edu",
]);

function getHostname(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Domain-heuristic source tier.
 * primary: hostname ends with .gov/.edu/.mil/.ac.<tld> or is a known primary domain,
 *          or matches *.gov.uk.
 * secondary: wikipedia.org, reuters.com, apnews.com, bbc.co.uk/bbc.com, nytimes.com, major orgs.
 * tertiary: everything else.
 */
export function urlTier(url: string): SourceTier {
  const host = getHostname(url);
  if (!host) return "tertiary";

  // Exact match or subdomain match against known primaries
  if (PRIMARY_DOMAINS.has(host)) return "primary";
  for (const domain of PRIMARY_DOMAINS) {
    if (host.endsWith("." + domain)) return "primary";
  }

  // TLD-based: .gov, .edu, .mil
  if (host.endsWith(".gov") || host.endsWith(".edu") || host.endsWith(".mil")) return "primary";

  // *.gov.uk
  if (host.endsWith(".gov.uk")) return "primary";

  // .ac.<tld> — academic institutions globally
  const parts = host.split(".");
  if (parts.length >= 3 && parts[parts.length - 2] === "ac") return "primary";

  // Secondary domains — exact or subdomain match
  for (const domain of SECONDARY_DOMAINS) {
    if (host === domain || host.endsWith("." + domain)) return "secondary";
  }

  return "tertiary";
}

// ─── Dedup + ranking ──────────────────────────────────────────────────────────

/**
 * Dedup hits by normalizeUrl, drop any whose normalized URL is in `seenUrls`,
 * then STABLE-sort by tier (primary→secondary→tertiary) preserving original order
 * within a tier. Does not mutate input.
 */
export function dedupeAndRank(
  hits: SearchHit[],
  opts?: { seenUrls?: Set<string> },
): SearchHit[] {
  const seenUrls = opts?.seenUrls ?? new Set<string>();
  const seen = new Set<string>(seenUrls);
  const deduped: SearchHit[] = [];

  for (const hit of hits) {
    const norm = normalizeUrl(hit.url);
    if (seen.has(norm)) continue;
    seen.add(norm);
    deduped.push(hit);
  }

  // Stable sort: assign numeric rank, sort, stable because we preserve index
  const tierRank: Record<SourceTier, number> = { primary: 0, secondary: 1, tertiary: 2 };

  // tag with original index for stable sort
  const tagged = deduped.map((h, i) => ({ h, i, tier: urlTier(h.url) }));
  tagged.sort((a, b) => {
    const td = tierRank[a.tier] - tierRank[b.tier];
    return td !== 0 ? td : a.i - b.i;
  });

  return tagged.map((t) => t.h);
}

// ─── Circuit breaker ──────────────────────────────────────────────────────────

/**
 * Generic circuit breaker. After `threshold` consecutive failures it is open for
 * `cooldownMs`; isOpen() returns false again after cooldown elapses (half-open:
 * next call is allowed; recordSuccess() resets). `now` is injectable for tests.
 */
export class CircuitBreaker {
  private failures = 0;
  private openedAt: number | null = null;

  constructor(
    private readonly threshold: number,
    private readonly cooldownMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  isOpen(): boolean {
    if (this.openedAt === null) return false;
    const elapsed = this.now() - this.openedAt;
    if (elapsed >= this.cooldownMs) {
      // half-open: allow the next attempt (don't reset yet; recordSuccess will)
      return false;
    }
    return true;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.openedAt = null;
  }

  recordFailure(): void {
    this.failures += 1;
    if (this.failures >= this.threshold) {
      this.openedAt = this.now();
    }
  }
}

// ─── Provider helpers ─────────────────────────────────────────────────────────

function isOk(status: number): boolean {
  return status >= 200 && status < 300;
}

// ─── SearXNG ──────────────────────────────────────────────────────────────────

interface SearxngResult {
  url?: string;
  title?: string;
  content?: string;
}

interface SearxngResponse {
  results?: SearxngResult[];
}

export class SearxngProvider implements SearchProvider {
  readonly name = "searxng";
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly resultsPerQuery: number;

  constructor(opts: {
    baseUrl: string;
    fetchImpl?: typeof fetch;
    resultsPerQuery?: number;
  }) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.resultsPerQuery = opts.resultsPerQuery ?? 8;
  }

  async search(query: string): Promise<SearchHit[]> {
    const url = `${this.baseUrl}/search?q=${encodeURIComponent(query)}&format=json`;
    const resp = await this.fetchImpl(url, {
      headers: { Accept: "application/json" },
    });

    if (!isOk(resp.status)) {
      throw new Error(`SearXNG returned ${resp.status} for query: ${query}`);
    }

    let body: SearxngResponse;
    try {
      body = (await resp.json()) as SearxngResponse;
    } catch {
      throw new Error(`SearXNG returned non-JSON body for query: ${query}`);
    }

    const results = body.results ?? [];
    return results.slice(0, this.resultsPerQuery).map((r) => ({
      url: r.url ?? "",
      title: r.title ?? "",
      snippet: r.content ?? "",
    }));
  }
}

// ─── Brave ────────────────────────────────────────────────────────────────────

interface BraveWebResult {
  url?: string;
  title?: string;
  description?: string;
}

interface BraveResponse {
  web?: {
    results?: BraveWebResult[];
  };
}

export class BraveProvider implements SearchProvider {
  readonly name = "brave";
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly resultsPerQuery: number;

  constructor(opts: {
    apiKey: string;
    fetchImpl?: typeof fetch;
    resultsPerQuery?: number;
  }) {
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.resultsPerQuery = opts.resultsPerQuery ?? 8;
  }

  async search(query: string): Promise<SearchHit[]> {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${this.resultsPerQuery}`;
    const resp = await this.fetchImpl(url, {
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": this.apiKey,
      },
    });

    if (!isOk(resp.status)) {
      throw new Error(`Brave Search returned ${resp.status} for query: ${query}`);
    }

    let body: BraveResponse;
    try {
      body = (await resp.json()) as BraveResponse;
    } catch {
      throw new Error(`Brave Search returned non-JSON body for query: ${query}`);
    }

    const results = body.web?.results ?? [];
    return results.slice(0, this.resultsPerQuery).map((r) => ({
      url: r.url ?? "",
      title: r.title ?? "",
      snippet: r.description ?? "",
    }));
  }
}

// ─── Tavily ───────────────────────────────────────────────────────────────────

interface TavilyResult {
  url?: string;
  title?: string;
  content?: string;
}

interface TavilyResponse {
  results?: TavilyResult[];
}

export class TavilyProvider implements SearchProvider {
  readonly name = "tavily";
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly resultsPerQuery: number;

  constructor(opts: {
    apiKey: string;
    fetchImpl?: typeof fetch;
    resultsPerQuery?: number;
  }) {
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.resultsPerQuery = opts.resultsPerQuery ?? 8;
  }

  async search(query: string): Promise<SearchHit[]> {
    const resp = await this.fetchImpl("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        api_key: this.apiKey,
        query,
        max_results: this.resultsPerQuery,
      }),
    });

    if (!isOk(resp.status)) {
      throw new Error(`Tavily returned ${resp.status} for query: ${query}`);
    }

    let body: TavilyResponse;
    try {
      body = (await resp.json()) as TavilyResponse;
    } catch {
      throw new Error(`Tavily returned non-JSON body for query: ${query}`);
    }

    const results = body.results ?? [];
    return results.slice(0, this.resultsPerQuery).map((r) => ({
      url: r.url ?? "",
      title: r.title ?? "",
      snippet: r.content ?? "",
    }));
  }
}

// ─── FallbackSearchProvider ───────────────────────────────────────────────────

/**
 * Try `primary` unless its breaker is open; on throw OR empty results, record a failure
 * and use `fallback`. Successful primary call → recordSuccess.
 * name = `${primary.name}->${fallback.name}`.
 */
export class FallbackSearchProvider implements SearchProvider {
  readonly name: string;
  private readonly breaker: CircuitBreaker;

  constructor(
    private readonly primary: SearchProvider,
    private readonly fallback: SearchProvider,
    opts: {
      breakerThreshold: number;
      cooldownMs: number;
      now?: () => number;
    },
  ) {
    this.name = `${primary.name}->${fallback.name}`;
    this.breaker = new CircuitBreaker(opts.breakerThreshold, opts.cooldownMs, opts.now);
  }

  async search(query: string): Promise<SearchHit[]> {
    if (!this.breaker.isOpen()) {
      try {
        const results = await this.primary.search(query);
        if (results.length > 0) {
          this.breaker.recordSuccess();
          return results;
        }
        // empty result — treat as failure, fall through to fallback
        this.breaker.recordFailure();
      } catch {
        this.breaker.recordFailure();
      }
    }
    return this.fallback.search(query);
  }
}

// ─── ddgs (Docker-free, no key — the box's v1 default) ──────────────────────────

/** Runs the `ddgs_search.py` helper: (python, [script, query, max]) → stdout JSON. Injectable. */
export type SearchShellRunner = (python: string, args: string[]) => Promise<string>;

const defaultDdgsRunner: SearchShellRunner = async (python, args) => {
  // execFile with an ARG ARRAY (never a shell string) → the query is a single argv slot, no injection.
  const { stdout } = await execFileAsync(python, args, { timeout: 30_000, maxBuffer: 8_000_000 });
  return stdout;
};

interface DdgsRow {
  url?: string;
  title?: string;
  snippet?: string;
}

/**
 * Docker-free search via the `ddgs` Python package (DuckDuckGo et al.) — no server, no API key.
 * Shells out to scripts/ddgs_search.py, which prints a normalized JSON array. A non-zero exit
 * (rate limit, import error) rejects → the circuit breaker trips and the fallback provider runs.
 */
export class DdgsProvider implements SearchProvider {
  readonly name = "ddgs";
  private readonly python: string;
  private readonly script: string;
  private readonly resultsPerQuery: number;
  private readonly runner: SearchShellRunner;

  constructor(opts: {
    python: string;
    script: string;
    resultsPerQuery?: number;
    runner?: SearchShellRunner;
  }) {
    this.python = opts.python;
    // A relative script path is resolved against the repo root (NOT process.cwd()), so the helper
    // is found regardless of the caller's working directory (e.g. a systemd service on the box).
    this.script = isAbsolute(opts.script) ? opts.script : join(REPO_ROOT, opts.script);
    this.resultsPerQuery = opts.resultsPerQuery ?? 8;
    this.runner = opts.runner ?? defaultDdgsRunner;
  }

  async search(query: string): Promise<SearchHit[]> {
    const out = await this.runner(this.python, [this.script, query, String(this.resultsPerQuery)]);
    let rows: DdgsRow[];
    try {
      rows = JSON.parse(out) as DdgsRow[];
    } catch {
      throw new Error(`ddgs returned non-JSON output for query: ${query}`);
    }
    if (!Array.isArray(rows)) throw new Error(`ddgs returned a non-array body for query: ${query}`);
    // Filter BEFORE the cap so url-less rows don't shrink the result count below resultsPerQuery.
    return rows
      .map((r) => ({ url: r.url ?? "", title: r.title ?? "", snippet: r.snippet ?? "" }))
      .filter((h) => h.url)
      .slice(0, this.resultsPerQuery);
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

function makePrimaryProvider(
  name: string,
  config: DeepResearchConfig,
  fetchImpl: typeof fetch,
): SearchProvider {
  switch (name) {
    case "ddgs":
      return new DdgsProvider({
        python: config.ddgsPython,
        script: config.ddgsScript,
        resultsPerQuery: config.resultsPerQuery,
      });
    case "searxng":
      return new SearxngProvider({
        baseUrl: config.searchUrl,
        fetchImpl,
        resultsPerQuery: config.resultsPerQuery,
      });
    case "brave":
      return new BraveProvider({
        apiKey: config.searchApiKey,
        fetchImpl,
        resultsPerQuery: config.resultsPerQuery,
      });
    case "tavily":
      return new TavilyProvider({
        apiKey: config.searchApiKey,
        fetchImpl,
        resultsPerQuery: config.resultsPerQuery,
      });
    default:
      throw new Error(
        `Unknown search provider: "${name}". Valid values: ddgs, searxng, brave, tavily.`,
      );
  }
}

/**
 * Build the configured primary + fallback providers and wrap them.
 * Unknown provider name → throw a clear Error.
 * fetchImpl is threaded into all providers for testability.
 */
export function makeSearchProvider(
  config: DeepResearchConfig,
  fetchImpl: typeof fetch = fetch,
): SearchProvider {
  const primary = makePrimaryProvider(config.searchProvider, config, fetchImpl);
  const fallback = makePrimaryProvider(config.searchFallbackProvider, config, fetchImpl);
  return new FallbackSearchProvider(primary, fallback, {
    breakerThreshold: config.breakerThreshold,
    cooldownMs: config.breakerCooldownMs,
  });
}
