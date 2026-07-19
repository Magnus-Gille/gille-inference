import { listModels } from "./model-admin.js";

/**
 * Trusted model catalogue + canonicalizer.
 *
 * Background (the Codex LOW this fixes): the original synchronous canonicalizeModel() returned null
 * ("none") for ALL empty-allow-list keys, because validating a model required a network round-trip
 * it deliberately avoided in the hot path. The side effect: owner/admin traffic (which uses empty
 * allow-lists) lost its per-model metric/log label — every owner request showed up as model="none".
 *
 * Fix: keep a cached set of resident model ids from model-admin (the trusted backend catalogue),
 * refreshed in the BACKGROUND (fire-and-forget) on a short TTL. canonicalization reads the CURRENT
 * cache SYNCHRONOUSLY — it never blocks the request on a model-list round-trip (the original code's
 * explicit warning: a listModels() call in the hot path would stall admission for the whole upstream
 * timeout on a busy/stalled backend). The trade-off: the very first request after startup, before
 * the first refresh resolves, sees an empty cache and yields "unknown" — content-blind and safe,
 * and self-heals on the next request once the cache warms.
 *
 * PRIVACY / SAFETY (does NOT weaken C3): a raw, user-controlled model string is NEVER used as a
 * label or log value. Only a catalogue-validated id (which the operator put in the backend config)
 * or the literal "unknown" can be returned. An attacker-supplied string not in the catalogue
 * collapses to "unknown" — never echoed verbatim.
 */

// Short TTL: the resident set changes only when the operator loads/unloads a model, so a few
// seconds of staleness is harmless. Refresh is background-only and off the request critical path.
const CATALOGUE_TTL_MS = 10_000;

let cache: Set<string> = new Set();
let cacheAt = 0;
let refreshing = false;

/** Kick a background refresh if the cache is stale and one is not already in flight. Never awaits. */
function maybeRefresh(): void {
  const now = Date.now();
  if (refreshing || now - cacheAt < CATALOGUE_TTL_MS) return;
  refreshing = true;
  void (async () => {
    try {
      const models = await listModels();
      cache = new Set(models.map((m) => m.key));
      cacheAt = Date.now();
    } catch {
      // Backend unreachable: keep the previous cache (don't wipe a good set on a transient blip).
      // Bump cacheAt so we don't hammer a down backend every request.
      cacheAt = Date.now();
    } finally {
      refreshing = false;
    }
  })();
}

/**
 * Force-refresh the catalogue and AWAIT it. Used at gateway startup to warm the cache before the
 * first request, and by tests. Resolves to the (possibly empty) resident set; never throws.
 */
export async function warmCatalogue(): Promise<Set<string>> {
  try {
    const models = await listModels();
    cache = new Set(models.map((m) => m.key));
  } catch {
    // Leave the prior cache in place.
  }
  cacheAt = Date.now();
  return cache;
}

/** The current cached resident set (synchronous; may be empty before the first refresh). */
export function getTrustedCatalogue(): Set<string> {
  maybeRefresh();
  return cache;
}

/**
 * Canonicalize a user-supplied model string into a label SAFE for Prometheus + the request_log.
 * SYNCHRONOUS — never a network round-trip in the request hot path.
 *
 *   • null / empty            → null   (non-inference route; the record site maps null → "none")
 *   • non-empty allow-list    → the requested id if on the allow-list, else "unknown"
 *                               (the allow-list is authoritative; the catalogue is not consulted)
 *   • empty allow-list        → the requested id if it is in the CURRENT trusted-catalogue cache,
 *                               else "unknown" (and a background refresh is kicked if stale)
 *
 * Never returns the raw request string unless it exactly matches a trusted id (allow-list entry or
 * catalogue id), preserving the content-blind / label-cardinality invariant.
 */
export function canonicalizeModelTrusted(requested: string | null, allowList: string[]): string | null {
  if (requested === null || requested.trim() === "") return null;

  if (allowList.length > 0) {
    return allowList.includes(requested) ? requested : "unknown";
  }

  // Empty allow-list (owner/admin): validate against the current cache (sync), refresh in bg.
  return getTrustedCatalogue().has(requested) ? requested : "unknown";
}

/** Reset the cache. FOR TESTS ONLY. */
export function resetCatalogueCache(): void {
  cache = new Set();
  cacheAt = 0;
  refreshing = false;
}
