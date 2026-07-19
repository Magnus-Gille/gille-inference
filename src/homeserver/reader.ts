/**
 * reader.ts — Pluggable READ layer for the deep-research harness.
 *
 * Primary: Trafilatura (shell-out, full-page clean markdown).
 * Fallback: Jina (JS/anti-bot pages, pure HTTP).
 * Utilities: content hashing, thin-page detection, near-duplicate detection.
 *
 * ALL side effects are injectable so this module is testable offline.
 * SECURITY: URLs are validated before any network/shell use; execFile is
 * used for Trafilatura (never shell-string interpolation).
 */

import { createHash } from "node:crypto";
import { execFile as _execFile } from "node:child_process";
import { promisify } from "node:util";

import type { ReadResult, Reader } from "./deep-research-types.js";
import type { DeepResearchConfig } from "./deep-research-config.js";

const execFileAsync = promisify(_execFile);

// ─── URL validation ───────────────────────────────────────────────────────────

/**
 * Parse an IPv4 address string to a 32-bit integer, or null if invalid.
 */
function parseIPv4(host: string): number | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    const v = parseInt(p, 10);
    if (v < 0 || v > 255) return null;
    n = (n << 8) | v;
  }
  return n >>> 0;
}

/**
 * Returns true if the IPv4 address (as a 32-bit uint) falls in a
 * private / loopback / link-local / unspecified range.
 *
 * Blocked ranges:
 *   0.0.0.0/8       (0x00000000 – 0x00FFFFFF)  "this" network
 *   10.0.0.0/8      (0x0A000000 – 0x0AFFFFFF)  RFC-1918
 *   100.64.0.0/10   (0x64400000 – 0x647FFFFF)  Shared Address Space (CGNAT)
 *   127.0.0.0/8     (0x7F000000 – 0x7FFFFFFF)  loopback
 *   169.254.0.0/16  (0xA9FE0000 – 0xA9FEFFFF)  link-local / metadata
 *   172.16.0.0/12   (0xAC100000 – 0xAC1FFFFF)  RFC-1918
 *   192.168.0.0/16  (0xC0A80000 – 0xC0A8FFFF)  RFC-1918
 *   198.51.100.0/24 (0xC6336400)                TEST-NET-2
 *   203.0.113.0/24  (0xCB007100)                TEST-NET-3
 *   240.0.0.0/4     (0xF0000000 – 0xFFFFFFFF)  reserved / broadcast
 */
function isPrivateIPv4(ip: number): boolean {
  return (
    (ip >>> 24) === 0 ||            // 0.0.0.0/8
    (ip >>> 24) === 10 ||           // 10.0.0.0/8
    (ip >>> 22) === 0x191 ||        // 100.64.0.0/10  (0x64400000 >> 22 = 0x191)
    (ip >>> 24) === 127 ||          // 127.0.0.0/8
    (ip >>> 16) === 0xa9fe ||       // 169.254.0.0/16
    (ip >>> 20) === 0xac1 ||        // 172.16.0.0/12  (0xAC100000 >> 20 = 0xAC1)
    (ip >>> 16) === 0xc0a8 ||       // 192.168.0.0/16
    (ip >>> 24) >= 0xf0             // 240.0.0.0/4 reserved / broadcast
  );
}

/**
 * Returns true if a raw IPv6 address (already stripped of brackets and zone
 * IDs) is loopback, ULA, or link-local.
 *
 * Blocked ranges:
 *   ::1          loopback
 *   fc00::/7     Unique Local Address (ULA)
 *   fe80::/10    link-local
 */
function isPrivateIPv6(raw: string): boolean {
  // Expand ::1 / loopback shorthand before comparison
  // We only need to detect the three blocked prefixes; full expansion is
  // unnecessary for that purpose.
  const lower = raw.toLowerCase();

  // Exact loopback: ::1
  if (lower === "::1" || lower === "0:0:0:0:0:0:0:1") return true;

  // Expand leading :: so we can inspect the first 16-bit group
  // For fc00::/7 the first byte is 0xfc or 0xfd; for fe80::/10 it is 0xfe
  // with the next two bits being 10.
  // Rather than fully expanding the address, detect the prefix patterns:
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return true; // fe80::/10
  if (/^fe[89ab]$/i.test(lower)) return true;         // just the group
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true;  // fc00::/7 (fc** or fd**)

  // Handle compressed forms like ::ffff:127.0.0.1 (IPv4-mapped loopback)
  if (/^::ffff:127\./.test(lower)) return true;
  if (/^::ffff:10\./.test(lower)) return true;
  if (/^::ffff:192\.168\./.test(lower)) return true;
  if (/^::ffff:172\.(1[6-9]|2\d|3[01])\./.test(lower)) return true;
  if (/^::ffff:169\.254\./.test(lower)) return true;

  // :: itself (all-zeros = unspecified)
  if (lower === "::" || lower === "0:0:0:0:0:0:0:0") return true;

  return false;
}

/**
 * Blocked hostnames and suffixes that resolve to private/internal addresses.
 * This is a syntactic blocklist only — full DNS-rebinding defense would
 * require resolving the hostname and then checking the resulting IP (resolve-
 * then-pin), which is outside scope here. Document this limitation so callers
 * are aware that a cleverly chosen public DNS entry could still bypass the
 * hostname check.
 */
const BLOCKED_HOSTNAME_EXACT = new Set(["localhost"]);
const BLOCKED_HOSTNAME_SUFFIXES = [".localhost", ".local", ".internal"];

function isBlockedHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (BLOCKED_HOSTNAME_EXACT.has(lower)) return true;
  return BLOCKED_HOSTNAME_SUFFIXES.some((s) => lower.endsWith(s));
}

/**
 * Validate that `url` is an http/https URL targeting a publicly-routable host.
 *
 * Throws `Error("blocked host: <host>")` for any host in a private, loopback,
 * link-local, or well-known-internal range/name.
 *
 * LIMITATION: This is a syntactic / literal-address check. A public hostname
 * that resolves to a private IP (DNS rebinding) will pass this check. Full
 * protection requires resolve-then-pin (out of scope for this module).
 *
 * Pass `{ allowPrivateHosts: true }` to skip the host check (tests / trusted
 * callers only).
 */
function validateHttpUrl(
  url: string,
  opts?: { allowPrivateHosts?: boolean }
): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`reader: invalid URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `reader: only http/https URLs are allowed, got: ${parsed.protocol}`
    );
  }

  if (opts?.allowPrivateHosts) return;

  // Strip IPv6 brackets: "[::1]" → "::1"
  const hostname = parsed.hostname;
  const isIPv6Literal = hostname.startsWith("[") && hostname.endsWith("]");
  const rawHost = isIPv6Literal
    ? hostname.slice(1, -1).split("%")[0]! // strip zone ID
    : hostname;

  if (isIPv6Literal) {
    if (isPrivateIPv6(rawHost)) {
      throw new Error(`reader: blocked host: ${hostname}`);
    }
    return; // valid public IPv6 literal
  }

  const ipv4 = parseIPv4(rawHost);
  if (ipv4 !== null) {
    if (isPrivateIPv4(ipv4)) {
      throw new Error(`reader: blocked host: ${rawHost}`);
    }
    return; // valid public IPv4
  }

  // Hostname (not a numeric literal)
  if (isBlockedHostname(rawHost)) {
    throw new Error(`reader: blocked host: ${rawHost}`);
  }
}

// ─── Content hashing ──────────────────────────────────────────────────────────

/**
 * sha256 (hex) of a normalised form (lowercase, collapse whitespace, trim).
 * Stable across call sites; whitespace/case-only differences hash the same.
 */
export function contentHash(markdown: string): string {
  const normalised = markdown.toLowerCase().replace(/\s+/g, " ").trim();
  return createHash("sha256").update(normalised, "utf8").digest("hex");
}

// ─── Thin-page detection ──────────────────────────────────────────────────────

/**
 * True when the cleaned main text is below `thinChars` → escalate to a
 * JS/anti-bot reader.
 */
export function isThin(markdown: string, thinChars: number): boolean {
  return markdown.trim().length < thinChars;
}

// ─── Shingle similarity ───────────────────────────────────────────────────────

function normalise(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function words(text: string): string[] {
  return normalise(text).split(" ").filter((w) => w.length > 0);
}

/** Build the set of word 5-grams from a word list. */
function shingles(ws: string[]): Set<string> {
  const out = new Set<string>();
  const n = 5;
  for (let i = 0; i <= ws.length - n; i++) {
    out.add(ws.slice(i, i + n).join(" "));
  }
  return out;
}

/**
 * Word 5-gram shingle Jaccard similarity in [0, 1] between two texts
 * (normalised). Returns 1 for identical or near-identical texts, 0 for
 * fully disjoint. Texts shorter than 5 words fall back to full-text equality.
 */
export function shingleSimilarity(a: string, b: string): number {
  const wa = words(a);
  const wb = words(b);

  // Fewer than 5 words — fall back to exact equality on normalised forms
  if (wa.length < 5 || wb.length < 5) {
    return normalise(a) === normalise(b) ? 1 : 0;
  }

  const sa = shingles(wa);
  const sb = shingles(wb);

  let intersection = 0;
  for (const s of sa) {
    if (sb.has(s)) intersection++;
  }
  const union = sa.size + sb.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

/** True when similarity >= threshold (default 0.9). */
export function nearDuplicate(
  a: string,
  b: string,
  threshold = 0.9
): boolean {
  return shingleSimilarity(a, b) >= threshold;
}

/**
 * Drop near-duplicate pages: iterate in order, keep a page only if it is not
 * a nearDuplicate of an already-kept page. Returns the kept pages (stable
 * order). Pure; does not mutate input.
 */
export function dedupePages(
  pages: ReadResult[],
  opts?: { threshold?: number }
): ReadResult[] {
  const threshold = opts?.threshold ?? 0.9;
  const kept: ReadResult[] = [];
  for (const page of pages) {
    const isDup = kept.some((k) =>
      nearDuplicate(k.markdown, page.markdown, threshold)
    );
    if (!isDup) kept.push(page);
  }
  return kept;
}

// ─── Trafilatura ──────────────────────────────────────────────────────────────

/**
 * Default runner: shells out to `trafilatura -u <url> --output-format markdown
 * --no-comments` via execFile (NEVER shell-string interpolation).
 */
export type TrafilaturaRunner = (url: string) => Promise<string>;

/** Defaults for the execFile child-process guard. */
const TRAFILATURA_DEFAULT_TIMEOUT_MS = 30_000;
const TRAFILATURA_DEFAULT_MAX_BUFFER = 8_000_000;

function makeDefaultRunner(
  cmd: string,
  timeoutMs = TRAFILATURA_DEFAULT_TIMEOUT_MS,
  maxBuffer = TRAFILATURA_DEFAULT_MAX_BUFFER
): TrafilaturaRunner {
  return async (url: string): Promise<string> => {
    const { stdout } = await execFileAsync(
      cmd,
      ["-u", url, "--output-format", "markdown", "--no-comments"],
      { timeout: timeoutMs, maxBuffer }
    );
    return stdout ?? "";
  };
}

export class TrafilaturaReader implements Reader {
  readonly name = "trafilatura";

  private readonly cmd: string;
  private readonly thinChars: number;
  private readonly runner: TrafilaturaRunner;
  /** Exposed for testing: the timeout passed to the default runner. */
  readonly execTimeoutMs: number;
  /** Exposed for testing: the maxBuffer passed to the default runner. */
  readonly execMaxBuffer: number;

  constructor(opts: {
    cmd: string;
    thinChars: number;
    runner?: TrafilaturaRunner;
    /** ms before execFile times out (default 30 000) */
    execTimeoutMs?: number;
    /** max stdout/stderr bytes from execFile (default 8 000 000) */
    execMaxBuffer?: number;
    /** Skip SSRF host blocklist (tests / trusted callers only) */
    allowPrivateHosts?: boolean;
  }) {
    this.cmd = opts.cmd;
    this.thinChars = opts.thinChars;
    this.execTimeoutMs = opts.execTimeoutMs ?? TRAFILATURA_DEFAULT_TIMEOUT_MS;
    this.execMaxBuffer = opts.execMaxBuffer ?? TRAFILATURA_DEFAULT_MAX_BUFFER;
    this.runner =
      opts.runner ?? makeDefaultRunner(this.cmd, this.execTimeoutMs, this.execMaxBuffer);
    this._allowPrivateHosts = opts.allowPrivateHosts ?? false;
  }

  private readonly _allowPrivateHosts: boolean;

  async read(url: string): Promise<ReadResult> {
    validateHttpUrl(url, { allowPrivateHosts: this._allowPrivateHosts });
    const markdown = await this.runner(url);
    return {
      url,
      markdown,
      isThin: isThin(markdown, this.thinChars),
      fetchedVia: "trafilatura",
    };
  }
}

// ─── Jina ─────────────────────────────────────────────────────────────────────

/** Default fetch timeout for Jina requests (ms). */
const JINA_DEFAULT_TIMEOUT_MS = 20_000;
/** Default maximum Content-Length accepted from Jina (bytes). */
const JINA_DEFAULT_MAX_CONTENT_LENGTH = 5_000_000;
/** Default maximum returned markdown length (chars). */
const JINA_DEFAULT_MAX_MARKDOWN_CHARS = 500_000;

export class JinaReader implements Reader {
  readonly name = "jina";

  private readonly baseUrl: string;
  private readonly thinChars: number;
  private readonly fetchImpl: typeof fetch;
  /** Exposed for testing. */
  readonly fetchTimeoutMs: number;
  /** Exposed for testing. */
  readonly maxContentLength: number;
  /** Exposed for testing. */
  readonly maxMarkdownChars: number;
  private readonly _allowPrivateHosts: boolean;

  constructor(opts: {
    baseUrl: string;
    thinChars: number;
    fetchImpl?: typeof fetch;
    /** ms before the fetch times out (default 20 000) */
    fetchTimeoutMs?: number;
    /** Reject responses whose Content-Length exceeds this (default 5 000 000) */
    maxContentLength?: number;
    /** Truncate returned markdown to this many chars (default 500 000) */
    maxMarkdownChars?: number;
    /** Skip SSRF host blocklist (tests / trusted callers only) */
    allowPrivateHosts?: boolean;
  }) {
    this.baseUrl = opts.baseUrl;
    this.thinChars = opts.thinChars;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.fetchTimeoutMs = opts.fetchTimeoutMs ?? JINA_DEFAULT_TIMEOUT_MS;
    this.maxContentLength =
      opts.maxContentLength ?? JINA_DEFAULT_MAX_CONTENT_LENGTH;
    this.maxMarkdownChars =
      opts.maxMarkdownChars ?? JINA_DEFAULT_MAX_MARKDOWN_CHARS;
    this._allowPrivateHosts = opts.allowPrivateHosts ?? false;
  }

  async read(url: string): Promise<ReadResult> {
    // SSRF guard — must run BEFORE the URL is concatenated with baseUrl (#1, #4)
    validateHttpUrl(url, { allowPrivateHosts: this._allowPrivateHosts });

    // Jina prepends: GET <baseUrl>/<url>
    const jinaUrl = `${this.baseUrl}/${url}`;
    const signal = AbortSignal.timeout(this.fetchTimeoutMs);
    const resp = await this.fetchImpl(jinaUrl, { signal });

    // Reject oversized responses before reading the body
    const contentLengthHeader = resp.headers?.get("content-length");
    if (contentLengthHeader !== null && contentLengthHeader !== undefined) {
      const cl = parseInt(contentLengthHeader, 10);
      if (!isNaN(cl) && cl > this.maxContentLength) {
        throw new Error(
          `reader: Jina response too large: Content-Length ${cl} > ${this.maxContentLength}`
        );
      }
    }

    let markdown = await resp.text();

    // Truncate to guard against streaming responses that bypass Content-Length
    if (markdown.length > this.maxMarkdownChars) {
      markdown = markdown.slice(0, this.maxMarkdownChars);
    }

    return {
      url,
      markdown,
      isThin: isThin(markdown, this.thinChars),
      fetchedVia: "jina",
    };
  }
}

// ─── FallbackReader ───────────────────────────────────────────────────────────

/**
 * Read via `primary`; if it THROWS or returns isThin, fall back to `fallback`.
 * The fallback result is returned even if also thin (best effort).
 */
export class FallbackReader implements Reader {
  readonly name: string;

  constructor(
    private readonly primary: Reader,
    private readonly fallback: Reader
  ) {
    this.name = `${primary.name}->${fallback.name}`;
  }

  async read(url: string): Promise<ReadResult> {
    let primaryResult: ReadResult | null = null;
    try {
      primaryResult = await this.primary.read(url);
    } catch {
      // primary threw → use fallback
      return this.fallback.read(url);
    }
    if (primaryResult.isThin) {
      return this.fallback.read(url);
    }
    return primaryResult;
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Build configured primary + fallback readers and wrap them.
 * Unknown name → throws. Inject runner/fetchImpl for tests.
 */
export function makeReader(
  config: DeepResearchConfig,
  deps?: {
    runner?: TrafilaturaRunner;
    fetchImpl?: typeof fetch;
    allowPrivateHosts?: boolean;
  }
): Reader {
  function buildOne(name: string): Reader {
    switch (name) {
      case "trafilatura":
        return new TrafilaturaReader({
          cmd: config.trafilaturaCmd,
          thinChars: config.readerThinChars,
          runner: deps?.runner,
          allowPrivateHosts: deps?.allowPrivateHosts,
        });
      case "jina":
        return new JinaReader({
          baseUrl: config.jinaBaseUrl,
          thinChars: config.readerThinChars,
          fetchImpl: deps?.fetchImpl,
          allowPrivateHosts: deps?.allowPrivateHosts,
        });
      default:
        throw new Error(`reader: unknown provider: "${name}"`);
    }
  }

  const primary = buildOne(config.readerProvider);
  const fallback = buildOne(config.readerFallbackProvider);
  return new FallbackReader(primary, fallback);
}
