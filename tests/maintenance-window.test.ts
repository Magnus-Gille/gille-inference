import { describe, expect, it } from "vitest";
import { AdmissionController, AdmissionRejected } from "../src/homeserver/admission.js";
import {
  ExclusiveMaintenanceWindow,
  MaintenanceWindowBusyError,
  MaintenanceWindowDrainError,
  MaintenanceWindowTokenError,
} from "../src/homeserver/maintenance-window.js";

function controller(): AdmissionController {
  return new AdmissionController({
    maxInflight: 1,
    ownerQueueMaxMs: 20,
    retryAfterAtCapSeconds: 1,
  });
}

const req = (lane: "owner" | "guest") => ({
  lane,
  requestedModel: "m1",
  keyMaxParallel: 1,
  keyInflight: 0,
});

describe("ExclusiveMaintenanceWindow", () => {
  it("acquires the canonical lease, fences both lanes, and restores on close", async () => {
    const ctrl = controller();
    let releases = 0;
    let now = 1_000;
    const window = new ExclusiveMaintenanceWindow(ctrl, {
      acquireLease: async () => ({ release: async () => { releases++; } }),
      observeRunning: async () => [{ model: "m1", state: "ready", ttlSeconds: 30 }],
      now: () => now,
      sleep: async () => { now += 1; },
      createToken: () => "opaque-token",
    });

    const opened = await window.open({ ttlMs: 60_000, drainTimeoutMs: 100, model: "m1", purpose: "test" });
    expect(opened.evidence).toMatchObject({ mode: "exclusive", inflight: 0, ownerQueued: 0 });
    await expect(ctrl.acquire(req("owner"))).rejects.toBeInstanceOf(AdmissionRejected);
    await expect(ctrl.acquire(req("guest"))).rejects.toBeInstanceOf(AdmissionRejected);
    await window.close(opened.token);
    expect(releases).toBe(1);
    const releaseOwner = await ctrl.acquire(req("owner"));
    releaseOwner();
  });

  it("fails closed and releases/restores when admitted work does not drain", async () => {
    const ctrl = controller();
    const activeRelease = await ctrl.acquire(req("owner"));
    let releases = 0;
    let now = 0;
    const window = new ExclusiveMaintenanceWindow(ctrl, {
      acquireLease: async () => ({ release: async () => { releases++; } }),
      observeRunning: async () => [],
      now: () => now,
      sleep: async (ms) => { now += ms; },
    });
    await expect(
      window.open({ ttlMs: 1_000, drainTimeoutMs: 5, model: "m1", purpose: "test" }),
    ).rejects.toBeInstanceOf(MaintenanceWindowDrainError);
    expect(releases).toBe(1);
    expect(ctrl.snapshot().maintenanceMode).toBe(false);
    activeRelease();
  });

  it("rejects a second window and invalid release tokens", async () => {
    const ctrl = controller();
    let now = 0;
    const window = new ExclusiveMaintenanceWindow(ctrl, {
      acquireLease: async () => ({ release: async () => undefined }),
      observeRunning: async () => [],
      now: () => now,
      sleep: async () => { now++; },
      createToken: () => "right",
    });
    const opened = await window.open({ ttlMs: 1_000, drainTimeoutMs: 10, model: "m1", purpose: "test" });
    await expect(
      window.open({ ttlMs: 1_000, drainTimeoutMs: 10, model: "m1", purpose: "test" }),
    ).rejects.toBeInstanceOf(MaintenanceWindowBusyError);
    await expect(window.close("wrong")).rejects.toBeInstanceOf(MaintenanceWindowTokenError);
    await window.close(opened.token);
  });

  it("waits out a starting llama-swap state before returning evidence", async () => {
    const ctrl = controller();
    let calls = 0;
    let now = 0;
    const window = new ExclusiveMaintenanceWindow(ctrl, {
      acquireLease: async () => ({ release: async () => undefined }),
      observeRunning: async () => {
        calls++;
        return [{ model: "m1", state: calls === 1 ? "starting" : "ready", ttlSeconds: 30 }];
      },
      now: () => now,
      sleep: async () => { now++; },
    });
    const opened = await window.open({ ttlMs: 1_000, drainTimeoutMs: 10, model: "m1", purpose: "test" });
    expect(calls).toBe(3);
    await window.close(opened.token);
  });

  it("releases the lease and restores admission when the operator disconnects during drain", async () => {
    const ctrl = controller();
    const activeRelease = await ctrl.acquire(req("owner"));
    const abort = new AbortController();
    let releases = 0;
    const window = new ExclusiveMaintenanceWindow(ctrl, {
      acquireLease: async () => ({ release: async () => { releases++; } }),
      observeRunning: async () => [],
      sleep: async () => { abort.abort(); },
    });
    await expect(window.open({
      ttlMs: 1_000,
      drainTimeoutMs: 100,
      model: "m1",
      purpose: "test",
      signal: abort.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(releases).toBe(1);
    expect(ctrl.snapshot().maintenanceMode).toBe(false);
    activeRelease();
  });

  it("uses the TTL as an independent automatic restore backstop", async () => {
    const ctrl = controller();
    let releases = 0;
    const window = new ExclusiveMaintenanceWindow(ctrl, {
      acquireLease: async () => ({ release: async () => { releases++; } }),
      observeRunning: async () => [],
    });
    await window.open({ ttlMs: 10, drainTimeoutMs: 100, model: "m1", purpose: "test" });
    expect(ctrl.snapshot().maintenanceScope).toBe("exclusive");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(releases).toBe(1);
    expect(ctrl.snapshot().maintenanceMode).toBe(false);
  });

  it("restores admission if the canonical lease is reclaimed", async () => {
    const ctrl = controller();
    let onLeaseLost: (() => void) | undefined;
    let releases = 0;
    const window = new ExclusiveMaintenanceWindow(ctrl, {
      acquireLease: async (options) => {
        onLeaseLost = options.onLeaseLost;
        return { release: async () => { releases++; } };
      },
      observeRunning: async () => [],
    });
    await window.open({ ttlMs: 1_000, drainTimeoutMs: 100, model: "m1", purpose: "test" });
    onLeaseLost?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(releases).toBe(1);
    expect(ctrl.snapshot().maintenanceMode).toBe(false);
  });
});
