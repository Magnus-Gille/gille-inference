import { randomUUID, timingSafeEqual } from "node:crypto";
import type { AdmissionController } from "./admission.js";

export interface MaintenanceGpuLease {
  release(): Promise<void>;
}

export interface MaintenanceWindowOptions {
  ttlMs: number;
  drainTimeoutMs: number;
  model: string;
  purpose: string;
  signal?: AbortSignal;
}

export interface MaintenanceWindowEvidence {
  mode: "exclusive";
  startedAt: string;
  expiresAt: string;
  inflight: number;
  ownerQueued: number;
  runningModels: Array<{ model: string; state: string; ttlSeconds: number | null }>;
}

export interface OpenMaintenanceWindowResult {
  token: string;
  evidence: MaintenanceWindowEvidence;
}

export class MaintenanceWindowBusyError extends Error {}
export class MaintenanceWindowDrainError extends Error {}
export class MaintenanceWindowTokenError extends Error {}
export class MaintenanceWindowLeaseLostError extends Error {}

export interface MaintenanceWindowDependencies {
  acquireLease(options: {
    model: string;
    purpose: string;
    etaMs: number;
    signal?: AbortSignal;
    onLeaseLost?: () => void;
  }): Promise<MaintenanceGpuLease>;
  observeRunning(): Promise<Array<{ model: string; state: string; ttlSeconds: number | null }>>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  createToken?: () => string;
}

interface ActiveWindow {
  token: string;
  lease: MaintenanceGpuLease;
  timer: NodeJS.Timeout;
  evidence: MaintenanceWindowEvidence;
}

function tokensEqual(a: string, b: string): boolean {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}

/**
 * Owns the process-local half of issue #196's maintenance contract. The gateway process acquires
 * the canonical filesystem lease using its isolated service identity, then engages the distinct
 * all-traffic admission fence and refuses success until admitted work has drained and llama-swap
 * reports a stable, non-starting residency snapshot. A TTL timer restores both resources even if
 * the operator client disappears.
 *
 * This class deliberately never executes the operator's command. The client process retains its
 * existing authority; the gateway lends it only a bounded exclusion window.
 */
export class ExclusiveMaintenanceWindow {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly createToken: () => string;
  private opening = false;
  private active: ActiveWindow | null = null;

  constructor(
    private readonly controller: AdmissionController,
    private readonly deps: MaintenanceWindowDependencies,
  ) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.createToken = deps.createToken ?? randomUUID;
  }

  status(): MaintenanceWindowEvidence | null {
    return this.active?.evidence ?? null;
  }

  isBusy(): boolean {
    return this.opening || this.active !== null;
  }

  async open(options: MaintenanceWindowOptions): Promise<OpenMaintenanceWindowResult> {
    if (this.opening || this.active !== null) {
      throw new MaintenanceWindowBusyError("an exclusive maintenance window is already active");
    }
    if (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0) {
      throw new RangeError("ttlMs must be finite and greater than zero");
    }
    if (!Number.isFinite(options.drainTimeoutMs) || options.drainTimeoutMs <= 0) {
      throw new RangeError("drainTimeoutMs must be finite and greater than zero");
    }

    this.opening = true;
    let lease: MaintenanceGpuLease | null = null;
    let fenceEngaged = false;
    const operationAbort = new AbortController();
    const abortFromClient = (): void => operationAbort.abort();
    options.signal?.addEventListener("abort", abortFromClient, { once: true });
    if (options.signal?.aborted === true) operationAbort.abort();
    const onLeaseLost = (): void => {
      operationAbort.abort(new MaintenanceWindowLeaseLostError("GPU lease was reclaimed"));
      if (lease !== null && this.active?.lease === lease) {
        void this.closeInternal(this.active.token).catch((error) => {
          console.error("[maintenance-window] lease-loss restore failed:", error);
        });
      }
    };
    try {
      operationAbort.signal.throwIfAborted();
      lease = await this.deps.acquireLease({
        model: options.model,
        purpose: options.purpose,
        etaMs: options.ttlMs,
        signal: operationAbort.signal,
        onLeaseLost,
      });
      // Cover the bounded drain phase as well as the requested command window. Once the drain is
      // proven, renew to the exact operator TTL so evidence and automatic restore agree.
      this.controller.setMaintenanceMode(true, options.ttlMs + options.drainTimeoutMs, "exclusive");
      fenceEngaged = true;
      await this.waitForDrain(options.drainTimeoutMs, operationAbort.signal);
      const runningModels = await this.waitForStableResidency(options.drainTimeoutMs, operationAbort.signal);
      operationAbort.signal.throwIfAborted();
      // Let the manager's release timer run before the controller's lazy fallback can admit a
      // request. The extra second is only an ordering guard; evidence still names the requested
      // window deadline, and closeInternal restores both resources together.
      this.controller.setMaintenanceMode(true, options.ttlMs + 1_000, "exclusive");
      const startedAtMs = this.now();
      const token = this.createToken();
      const evidence: MaintenanceWindowEvidence = {
        mode: "exclusive",
        startedAt: new Date(startedAtMs).toISOString(),
        expiresAt: new Date(startedAtMs + options.ttlMs).toISOString(),
        inflight: 0,
        ownerQueued: 0,
        runningModels,
      };
      const timer = setTimeout(() => {
        void this.closeInternal(token).catch((error) => {
          console.error("[maintenance-window] automatic restore failed:", error);
        });
      }, options.ttlMs);
      timer.unref();
      this.active = { token, lease, timer, evidence };
      return { token, evidence };
    } catch (error) {
      if (fenceEngaged) this.controller.setMaintenanceMode(false);
      if (lease !== null) await lease.release();
      throw error;
    } finally {
      options.signal?.removeEventListener("abort", abortFromClient);
      this.opening = false;
    }
  }

  async close(token: string): Promise<void> {
    if (this.active === null || !tokensEqual(token, this.active.token)) {
      throw new MaintenanceWindowTokenError("maintenance window token is invalid or expired");
    }
    await this.closeInternal(token);
  }

  async shutdown(): Promise<void> {
    if (this.active !== null) await this.closeInternal(this.active.token);
  }

  private async closeInternal(token: string): Promise<void> {
    const active = this.active;
    if (active === null || !tokensEqual(token, active.token)) return;
    this.active = null;
    clearTimeout(active.timer);
    try {
      await active.lease.release();
    } finally {
      this.controller.setMaintenanceMode(false);
    }
  }

  private async waitForDrain(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    const deadline = this.now() + timeoutMs;
    while (true) {
      signal?.throwIfAborted();
      const state = this.controller.snapshot();
      if (state.inflight === 0 && state.ownerQueued === 0) return;
      if (this.now() >= deadline) {
        throw new MaintenanceWindowDrainError(
          `inference did not drain before timeout (inflight=${state.inflight}, ownerQueued=${state.ownerQueued})`,
        );
      }
      await this.sleep(Math.min(100, Math.max(1, deadline - this.now())));
    }
  }

  private async waitForStableResidency(
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Array<{ model: string; state: string; ttlSeconds: number | null }>> {
    const deadline = this.now() + timeoutMs;
    let previous: string | null = null;
    while (true) {
      signal?.throwIfAborted();
      const snapshot = await this.deps.observeRunning();
      const canonical = JSON.stringify(
        [...snapshot].sort((a, b) => a.model.localeCompare(b.model)),
      );
      if (!snapshot.some((entry) => entry.state === "starting") && canonical === previous) {
        return JSON.parse(canonical) as Array<{ model: string; state: string; ttlSeconds: number | null }>;
      }
      if (this.now() >= deadline) {
        throw new MaintenanceWindowDrainError("llama-swap residency did not become stable before timeout");
      }
      previous = canonical;
      await this.sleep(Math.min(100, Math.max(1, deadline - this.now())));
    }
  }
}
