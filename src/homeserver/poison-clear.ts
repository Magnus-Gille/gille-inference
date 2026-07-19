/**
 * Recurrent-model poison-clear — the Qwen3-Next "?????" degeneration resilience fix.
 *
 * Problem (root cause: docs/m5-qwen3next-recurrent-degeneration-2026-06-24.md): a hybrid
 * recurrent-memory model (qwen3-coder-next-80b's Gated-DeltaNet layers) keeps a fixed-size SSM
 * state in llama.cpp's separate recurrent store. On an ABRUPT client disconnect mid-generation,
 * llama-server's slot.release()/reset() does NOT clear that buffer (intentional, for prompt-cache
 * reuse), and recurrent memory cannot be partially truncated — so the half-written SSM state
 * persists and every later cache-reuse request inherits a dirty seed → a long run of a single
 * repeated token. It never self-recovers; only a model RELOAD zero-inits the buffer and restores
 * it. Full-attention models (mellum) truncate cleanly and are immune.
 *
 * Fix: on an abrupt disconnect of a request to an ALLOW-LISTED recurrent model, unload the model so
 * the next request loads a clean one. Three jobs are balanced by a small per-model state machine:
 *
 *   1. RECOVER — the FIRST disconnect (out of cooldown) fires an unload immediately; recovery of a
 *      genuine degeneration is never delayed.
 *   2. ANTI-THRASH / DoS — at most one unload per `cooldownMs` window, so a client that repeatedly
 *      connects-and-aborts cannot keep the model perpetually cold-loading.
 *   3. NO SILENT DROP — a disconnect that lands inside the cooldown window OR while an earlier unload
 *      is still in flight is NOT dropped (dropping it would re-introduce the permanent-brick failure:
 *      a second abrupt disconnect re-poisons the model, and if all later traffic completes cleanly
 *      nothing ever re-triggers a clear). Instead it schedules a single TRAILING unload at the window
 *      boundary, which fires UNCONDITIONALLY (the backend unload is idempotent). So any window with
 *      ≥1 disconnect ends with a clean model — dirty time is bounded by `cooldownMs` and the guarantee
 *      does NOT depend on how long any single unload takes — while unloads stay capped at one per
 *      window.
 *
 * Scope guard: ONLY models in the configured allow-list are ever unloaded. mellum and every other
 * full-attention model are immune by construction (never in the list). An empty allow-list disables
 * the feature entirely.
 *
 * Tradeoff (intentional, documented): unloading is process-global for that model, so a request
 * mid-flight to the SAME recurrent model is cut short. That request was already at risk of inheriting
 * the dirty state, and the gateway degrades it gracefully (terminal SSE frame / upstream_unavailable,
 * billed 0). Both are strictly better than serving garbage to every user until a human restarts the box.
 */

import { unloadModel } from "./model-admin.js";
import { recordPoisonClear } from "./metrics.js";

export interface PoisonClearState {
  /** model → epoch-ms of the last unload FIRED (immediate or trailing). Drives the cooldown. */
  lastClearAt: Map<string, number>;
  /** models with an unload currently in flight — a synchronous guard against a concurrent burst. */
  inFlight: Set<string>;
  /** models with a trailing unload already scheduled for the current cooldown window. */
  scheduled: Set<string>;
}

export function makePoisonClearState(): PoisonClearState {
  return { lastClearAt: new Map(), inFlight: new Set(), scheduled: new Set() };
}

/** Process-wide state shared across all requests so bursts collapse and cooldowns persist. */
const defaultState = makePoisonClearState();

export type ClearDecision = "fire" | "defer" | "skip";

/**
 * Pure decision for an abrupt-disconnect poison-clear. Does NOT mutate state.
 *   "skip"  — not a recurrent model (or null/empty). Nothing to do.
 *   "fire"  — eligible, out of cooldown, and no unload already running → unload now.
 *   "defer" — eligible but an unload is already in flight OR we are inside the cooldown window →
 *             schedule a trailing unload at the window boundary.
 * The cooldown boundary is inclusive (now - last >= cooldownMs fires).
 *
 * An in-flight unload yields "defer", NOT "skip": it must collapse the IMMEDIATE unload (we don't
 * fire a concurrent one), but it must still SCHEDULE the boundary backstop — otherwise a re-poison
 * arriving during a slow/failing unload would be silently dropped and the window could end dirty.
 */
export function decidePoisonClear(
  model: string | null | undefined,
  recurrentModelIds: readonly string[],
  cooldownMs: number,
  now: number,
  state: PoisonClearState
): ClearDecision {
  if (!model) return "skip";
  if (!recurrentModelIds.includes(model)) return "skip";
  const last = state.lastClearAt.get(model);
  const outOfCooldown = last === undefined || now - last >= cooldownMs;
  if (outOfCooldown && !state.inFlight.has(model)) return "fire";
  return "defer";
}

export interface PoisonClearDeps {
  /** The unload primitive. Defaults to model-admin.unloadModel; injected in tests. */
  unload?: (modelId: string) => Promise<{ ok: boolean; message: string }>;
  /** Clock source. Defaults to Date.now; injected for deterministic cooldown tests. */
  now?: () => number;
  /** Best-effort operational log sink (lands in the systemd journal). Defaults to console.warn. */
  log?: (line: string) => void;
  /** One-shot scheduler for the trailing unload. Defaults to an unref'd setTimeout; injected in tests. */
  schedule?: (fn: () => void, ms: number) => void;
  /** State container. Defaults to the process singleton; injected for test isolation. */
  state?: PoisonClearState;
}

const defaultLog = (line: string): void => {
  // Operational event, not request content — safe to log. Goes to stderr → systemd journal.
  console.warn(line);
};

const defaultSchedule = (fn: () => void, ms: number): void => {
  const t = setTimeout(fn, ms);
  // Don't keep the process alive just for a trailing unload (e.g. on shutdown / in tests).
  (t as unknown as { unref?: () => void }).unref?.();
};

/**
 * Fire the actual unload, detached. Marks the model in-flight (synchronous burst guard), records the
 * cooldown timestamp, and accounts the result to the metric. On FAILURE the cooldown timestamp is
 * cleared so the next disconnect can retry promptly rather than being suppressed for a full window.
 * Never throws back into the caller.
 */
function fireUnload(
  id: string,
  ts: number,
  state: PoisonClearState,
  unload: (modelId: string) => Promise<{ ok: boolean; message: string }>,
  log: (line: string) => void,
  reason: string
): void {
  state.lastClearAt.set(id, ts);
  state.inFlight.add(id);
  log(`poison-clear: unloading recurrent model '${id}' (clearing dirty SSM state — ${reason})`);
  // Detached: a failure here must never crash the request path. Deferring through Promise.resolve()
  // also keeps even a (contractually-impossible) synchronous throw from an injected unload off the
  // caller's stack — it surfaces as a rejection on this chain instead.
  void Promise.resolve()
    .then(() => unload(id))
    .then((r) => {
      recordPoisonClear(id, r.ok ? "ok" : "failed");
      if (!r.ok) {
        log(`poison-clear: unload '${id}' did not succeed: ${r.message}`);
        state.lastClearAt.delete(id); // a failed unload did not clean the model → allow a prompt retry
      }
    })
    .catch((err: unknown) => {
      recordPoisonClear(id, "failed");
      log(`poison-clear: unload '${id}' threw: ${err instanceof Error ? err.message : String(err)}`);
      state.lastClearAt.delete(id);
    })
    .finally(() => {
      state.inFlight.delete(id);
    });
}

/**
 * Handle an abrupt client disconnect for a (possibly recurrent) model. Fire-and-forget; the return
 * value is informational (the decision taken) — the gateway ignores it.
 *
 * "fire": unload now. "defer": schedule one trailing unload at the cooldown boundary so a re-poison
 * inside the window still clears (no permanent brick) without thrashing. "skip": nothing to do.
 */
export function poisonClearOnDisconnect(
  model: string | null | undefined,
  recurrentModelIds: readonly string[],
  cooldownMs: number,
  deps: PoisonClearDeps = {}
): ClearDecision {
  return requestPoisonClear(model, recurrentModelIds, cooldownMs, "abrupt disconnect", deps);
}

/**
 * Trigger-agnostic core: request a poison-clear unload of a recurrent `model`, deduped/cooled by the
 * SAME per-model state machine that poisonClearOnDisconnect uses. `reason` only colours the log line
 * (e.g. "abrupt disconnect" vs "degeneracy watchdog") — the recover / anti-thrash / no-silent-drop
 * guarantees are identical regardless of what triggered the clear, and sharing the state means a
 * disconnect and a watchdog trip for the same model collapse to one unload per cooldown window.
 */
export function requestPoisonClear(
  model: string | null | undefined,
  recurrentModelIds: readonly string[],
  cooldownMs: number,
  reason: string,
  deps: PoisonClearDeps = {}
): ClearDecision {
  const state = deps.state ?? defaultState;
  const nowFn = deps.now ?? Date.now;
  const unload = deps.unload ?? unloadModel;
  const log = deps.log ?? defaultLog;
  const schedule = deps.schedule ?? defaultSchedule;

  const now = nowFn();
  const decision = decidePoisonClear(model, recurrentModelIds, cooldownMs, now, state);
  if (decision === "skip") return "skip";
  const id = model as string; // non-null/recurrent guaranteed by decidePoisonClear

  if (decision === "fire") {
    fireUnload(id, now, state, unload, log, reason);
    return "fire";
  }

  // "defer": an unload is already in flight, or we are inside the cooldown window. Schedule ONE
  // trailing unload at the window boundary so a re-poisoning disconnect is never silently dropped —
  // the window must end with a clean model even if the in-flight unload failed — while keeping
  // unloads capped at one per window. The trailing records the BOUNDARY timestamp (not the actual,
  // possibly jittered, callback time) so the next window is measured from the intended boundary.
  if (!state.scheduled.has(id)) {
    state.scheduled.add(id);
    const last = state.lastClearAt.get(id) ?? now;
    const boundary = last + cooldownMs;
    const delay = Math.max(0, boundary - now);
    schedule(() => {
      state.scheduled.delete(id);
      // Fire unconditionally: the trailing's job is to guarantee the window ends clean even if an
      // earlier unload is somehow still in flight (the backend unload is idempotent). This is what
      // makes the "ends clean" invariant independent of how long any single unload takes.
      fireUnload(id, boundary, state, unload, log, `${reason} (trailing)`);
    }, delay);
  }
  return "defer";
}

/** Test hook: clear the process-wide state. Never call in production. */
export function resetPoisonClearState(): void {
  defaultState.lastClearAt.clear();
  defaultState.inFlight.clear();
  defaultState.scheduled.clear();
}
