/**
 * Admission control — the gateway spine.
 *
 * A single GPU-slot budget (HOMESERVER_MAX_INFLIGHT) is shared across a two-lane priority
 * scheme. `admit()` is the pure chokepoint that lets owner traffic preempt guests under
 * contention: owners are never instantly 503'd while a slot is reachable within
 * ownerQueueMaxMs; guests get an immediate, honest 503 the moment all slots are busy. A
 * per-key in-flight cap (rule 1) stops a single key monopolizing the box.
 *
 * The model-affinity hook (wouldSwapModel) is surfaced for metrics only and is NOT enforced.
 * On the M5 the serving topology is gateway → llama-swap → llama-server (see
 * docs/adr-004-m5-routing-ownership.md and bosgame-m5-architecture.md), so model swapping is
 * owned by llama-swap (co-resident models routed by the request's `model` field), not by this
 * gateway. setActiveModel()/wouldSwapModel are therefore inert by design — reserved for a
 * hypothetical future topology where the gateway itself owns swap.
 */

export type Lane = "owner" | "guest";

export interface AdmissionState {
  maxInflight: number;
  inflight: number; // total slots in use across both lanes
  ownerQueued: number; // owner requests parked waiting for a slot
  activeModel: string | null;
  /**
   * Bench / maintenance mode (issue #108). When true, GUEST admission is refused outright
   * (503 + Retry-After) regardless of free slots, while OWNER traffic proceeds normally
   * (admit / owner-queue). Lets a heavy batch or benchmarking job reserve the box without a
   * guest session crashing into it. Optional → undefined is treated as false (off).
   */
  maintenanceMode?: boolean;
}

export type AdmissionResult =
  | { decision: "admit" }
  | { decision: "queue"; maxWaitMs: number } // owner only
  | { decision: "reject"; status: 503; retryAfterSeconds: number };

export interface AdmissionRequest {
  lane: Lane;
  requestedModel: string | null;
  keyMaxParallel: number; // per-key in-flight cap
  keyInflight: number; // this key's current in-flight count (caller snapshot; controller also tracks internally)
  keyId?: string; // stable identity for this key; required for drainQueue per-key re-check
}

export interface AdmissionConfig {
  ownerQueueMaxMs: number;
  retryAfterAtCapSeconds: number;
  /**
   * Retry-After (seconds) returned on a guest 503 caused by maintenance mode (issue #108).
   * Heavy jobs run for minutes, so this is typically larger than the at-capacity value.
   * Optional → defaults to MAINTENANCE_RETRY_AFTER_DEFAULT inside admit().
   */
  maintenanceRetryAfterSeconds?: number;
}

/** Default Retry-After for a maintenance-mode guest rejection when cfg omits it. */
export const MAINTENANCE_RETRY_AFTER_DEFAULT = 30;

/**
 * THE admission decision. Pure: same inputs → same output.
 *
 * Rules (in order):
 *  0. Maintenance mode + guest → reject 503, Retry-After = maintenanceRetryAfterSeconds
 *     (issue #108: a heavy job has reserved the box; owners are unaffected and fall through).
 *  1. Per-key cap: keyInflight >= keyMaxParallel → reject 503
 *     (Retry-After = ownerQueueMaxMs/1000 for owner, 1 for guest).
 *  2. Free slot (inflight < maxInflight) → admit.
 *  3. At cap + guest → reject 503, Retry-After = retryAfterAtCapSeconds.
 *  4. At cap + owner → queue, maxWaitMs = ownerQueueMaxMs.
 */
export function admit(
  state: AdmissionState,
  req: AdmissionRequest,
  cfg: AdmissionConfig
): AdmissionResult & { wouldSwapModel: boolean } {
  const wouldSwapModel =
    req.requestedModel !== null &&
    state.activeModel !== null &&
    req.requestedModel !== state.activeModel;

  // Rule 0 — maintenance/bench mode turns guests away outright; owners are never blocked by it.
  if (state.maintenanceMode === true && req.lane === "guest") {
    return {
      decision: "reject",
      status: 503,
      retryAfterSeconds: cfg.maintenanceRetryAfterSeconds ?? MAINTENANCE_RETRY_AFTER_DEFAULT,
      wouldSwapModel,
    };
  }

  // Rule 1 — per-key cap.
  if (req.keyInflight >= req.keyMaxParallel) {
    const retryAfterSeconds =
      req.lane === "owner" ? Math.max(1, Math.ceil(cfg.ownerQueueMaxMs / 1000)) : 1;
    return { decision: "reject", status: 503, retryAfterSeconds, wouldSwapModel };
  }

  // Rule 2 — free slot.
  if (state.inflight < state.maxInflight) {
    return { decision: "admit", wouldSwapModel };
  }

  // Rule 3 — at cap, guest.
  if (req.lane === "guest") {
    return {
      decision: "reject",
      status: 503,
      retryAfterSeconds: cfg.retryAfterAtCapSeconds,
      wouldSwapModel,
    };
  }

  // Rule 4 — at cap, owner queues.
  return { decision: "queue", maxWaitMs: cfg.ownerQueueMaxMs, wouldSwapModel };
}

export class AdmissionRejected extends Error {
  constructor(public retryAfterSeconds: number) {
    super("server_busy");
    this.name = "AdmissionRejected";
  }
}

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (err: AdmissionRejected) => void;
  timer: ReturnType<typeof setTimeout>;
  keyId: string | undefined; // carried for per-key re-check in drainQueue
  keyMaxParallel: number; // cap at enqueue time
}

/**
 * Stateful controller wrapping admit() with real slot acquire/release and an async owner
 * queue. Guests never queue; owners wait up to ownerQueueMaxMs for a slot to free.
 */
export class AdmissionController {
  private maxInflight: number;
  private ownerQueueMaxMs: number;
  private retryAfterAtCapSeconds: number;
  private maintenanceRetryAfterSeconds: number;
  private inflight = 0;
  private activeModel: string | null = null;
  private maintenanceMode: boolean;
  /**
   * Auto-expiry safety net (#105 follow-up): if a batch job that engaged maintenance mode dies
   * uncleanly (crash, OOM, SIGKILL) before turning it back off, a plain boolean would stay stuck
   * ON forever, silently 503ing every guest with no recovery. When set, maintenance mode is only
   * reported/enforced as engaged until this wall-clock deadline; past it, it self-heals to off on
   * the next read — no timer, no persistence, just a lazy check against `now()`.
   */
  private maintenanceExpiresAtMs: number | null = null;
  private ownerWaiters: Waiter[] = [];
  /** Per-key in-flight tracking for drainQueue re-check. Only populated for requests that carry a keyId. */
  private keyInflight = new Map<string, number>();
  private now: () => number;

  constructor(cfg: {
    maxInflight: number;
    ownerQueueMaxMs: number;
    retryAfterAtCapSeconds: number;
    maintenanceRetryAfterSeconds?: number;
    maintenanceMode?: boolean;
    /** Injectable clock (tests). Defaults to Date.now. */
    now?: () => number;
  }) {
    this.maxInflight = cfg.maxInflight;
    this.ownerQueueMaxMs = cfg.ownerQueueMaxMs;
    this.retryAfterAtCapSeconds = cfg.retryAfterAtCapSeconds;
    this.maintenanceRetryAfterSeconds =
      cfg.maintenanceRetryAfterSeconds ?? MAINTENANCE_RETRY_AFTER_DEFAULT;
    this.maintenanceMode = cfg.maintenanceMode ?? false;
    this.now = cfg.now ?? Date.now;
  }

  /** Effective maintenance state: engaged AND (no TTL set OR TTL not yet elapsed). */
  private effectiveMaintenanceMode(): boolean {
    if (!this.maintenanceMode) return false;
    if (this.maintenanceExpiresAtMs !== null && this.now() > this.maintenanceExpiresAtMs) {
      return false;
    }
    return true;
  }

  /**
   * Resolves with a release() fn on admit; throws AdmissionRejected on guest-busy or
   * owner-queue-timeout. release() is idempotent.
   */
  acquire(req: AdmissionRequest): Promise<() => void> {
    const decision = admit(this.state(), req, {
      ownerQueueMaxMs: this.ownerQueueMaxMs,
      retryAfterAtCapSeconds: this.retryAfterAtCapSeconds,
      maintenanceRetryAfterSeconds: this.maintenanceRetryAfterSeconds,
    });

    if (decision.decision === "admit") {
      this.inflight++;
      this.incKeyInflight(req.keyId);
      return Promise.resolve(this.makeRelease(req.keyId));
    }
    if (decision.decision === "reject") {
      return Promise.reject(new AdmissionRejected(decision.retryAfterSeconds));
    }
    // queue (owner only)
    return new Promise<() => void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.ownerWaiters.findIndex((w) => w.timer === timer);
        if (idx >= 0) this.ownerWaiters.splice(idx, 1);
        reject(new AdmissionRejected(Math.max(1, Math.ceil(this.ownerQueueMaxMs / 1000))));
      }, decision.maxWaitMs);
      this.ownerWaiters.push({ resolve, reject, timer, keyId: req.keyId, keyMaxParallel: req.keyMaxParallel });
    });
  }

  private incKeyInflight(keyId: string | undefined): void {
    if (keyId === undefined) return;
    this.keyInflight.set(keyId, (this.keyInflight.get(keyId) ?? 0) + 1);
  }

  private decKeyInflight(keyId: string | undefined): void {
    if (keyId === undefined) return;
    const n = (this.keyInflight.get(keyId) ?? 1) - 1;
    if (n <= 0) this.keyInflight.delete(keyId);
    else this.keyInflight.set(keyId, n);
  }

  private makeRelease(keyId: string | undefined): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inflight--;
      this.decKeyInflight(keyId);
      this.drainQueue();
    };
  }

  private drainQueue(): void {
    // Iterate rather than shift-first: a waiter may be capped at its per-key limit
    // even when a global slot is free (M2 fix).  Skip over still-capped waiters and
    // admit the next one that fits, preserving FIFO within the same key.
    let i = 0;
    while (this.inflight < this.maxInflight && i < this.ownerWaiters.length) {
      const w = this.ownerWaiters[i];
      // Re-check per-key cap using the controller's own tracking.
      const currentKeyInflight = w.keyId !== undefined ? (this.keyInflight.get(w.keyId) ?? 0) : 0;
      if (currentKeyInflight >= w.keyMaxParallel) {
        // This waiter is capped; leave it queued and try the next one.
        i++;
        continue;
      }
      // Admit this waiter.
      this.ownerWaiters.splice(i, 1);
      clearTimeout(w.timer);
      this.inflight++;
      this.incKeyInflight(w.keyId);
      w.resolve(this.makeRelease(w.keyId));
    }
  }

  private state(): AdmissionState {
    return {
      maxInflight: this.maxInflight,
      inflight: this.inflight,
      ownerQueued: this.ownerWaiters.length,
      activeModel: this.activeModel,
      maintenanceMode: this.effectiveMaintenanceMode(),
    };
  }

  /**
   * Toggle bench / maintenance mode (issue #108). When on, new GUEST admissions are refused
   * (503 + Retry-After); owner traffic is unaffected and already-admitted guests run to
   * completion (we never abort in-flight work). Idempotent. Returns the resulting state.
   *
   * `ttlMs` (#105 follow-up) bounds how long "on" stays engaged even if nobody ever calls this
   * again with `false` — the safety net for an unattended job that crashes mid-window. Omit for
   * the original unlimited-duration behavior (a human/script is expected to turn it back off).
   * Each call replaces any previous TTL rather than stacking; turning off always clears it.
   */
  setMaintenanceMode(on: boolean, ttlMs?: number): boolean {
    this.maintenanceMode = on;
    this.maintenanceExpiresAtMs = on && ttlMs !== undefined ? this.now() + ttlMs : null;
    return this.effectiveMaintenanceMode();
  }

  /** Whether maintenance/bench mode is currently engaged. */
  isMaintenanceMode(): boolean {
    return this.effectiveMaintenanceMode();
  }

  snapshot(): AdmissionState {
    return this.state();
  }

  /**
   * Records the model currently resident, feeding the wouldSwapModel telemetry hook.
   * INTENTIONALLY UNWIRED in v1: the M5 topology delegates model swapping to llama-swap
   * (gateway → llama-swap → llama-server), so the gateway neither swaps models nor reliably
   * knows the resident set. Wiring this from release() would track a stale value — worse than
   * tracking nothing. Kept (with test coverage) for a future gateway-owned-swap topology; see
   * ADR-004 follow-up #3.
   */
  setActiveModel(model: string | null): void {
    this.activeModel = model;
  }
}
