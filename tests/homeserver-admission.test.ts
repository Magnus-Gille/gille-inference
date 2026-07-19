import { describe, it, expect } from "vitest";
import {
  admit,
  AdmissionController,
  AdmissionRejected,
  MAINTENANCE_RETRY_AFTER_DEFAULT,
  type AdmissionState,
  type AdmissionRequest,
} from "../src/homeserver/admission.js";

const CFG = { ownerQueueMaxMs: 5000, retryAfterAtCapSeconds: 2 };

function state(p: Partial<AdmissionState> = {}): AdmissionState {
  return {
    maxInflight: 2,
    inflight: 0,
    ownerQueued: 0,
    activeModel: null,
    ...p,
  };
}

function reqFor(lane: "owner" | "guest", p: Partial<AdmissionRequest> = {}): AdmissionRequest {
  return {
    lane,
    requestedModel: null,
    keyMaxParallel: 4,
    keyInflight: 0,
    ...p,
  };
}

describe("admit() pure decision", () => {
  it("admits both lanes when a slot is free", () => {
    expect(admit(state(), reqFor("owner"), CFG).decision).toBe("admit");
    expect(admit(state(), reqFor("guest"), CFG).decision).toBe("admit");
  });

  it("at cap + guest → reject 503 with the at-cap retry-after", () => {
    const r = admit(state({ inflight: 2 }), reqFor("guest"), CFG);
    expect(r.decision).toBe("reject");
    if (r.decision === "reject") {
      expect(r.status).toBe(503);
      expect(r.retryAfterSeconds).toBe(CFG.retryAfterAtCapSeconds);
    }
  });

  it("at cap + owner → queue with maxWaitMs = ownerQueueMaxMs (preemption)", () => {
    const r = admit(state({ inflight: 2 }), reqFor("owner"), CFG);
    expect(r.decision).toBe("queue");
    if (r.decision === "queue") expect(r.maxWaitMs).toBe(CFG.ownerQueueMaxMs);
  });

  it("per-key cap rejects even with global slots free", () => {
    const r = admit(state({ inflight: 0 }), reqFor("owner", { keyMaxParallel: 1, keyInflight: 1 }), CFG);
    expect(r.decision).toBe("reject");
  });

  it("wouldSwapModel reflects requestedModel vs activeModel", () => {
    const swap = admit(state({ activeModel: "a" }), reqFor("owner", { requestedModel: "b" }), CFG);
    expect(swap.wouldSwapModel).toBe(true);
    const same = admit(state({ activeModel: "a" }), reqFor("owner", { requestedModel: "a" }), CFG);
    expect(same.wouldSwapModel).toBe(false);
  });

  it("wouldSwapModel is false when no model is active or none is requested", () => {
    // The live state: activeModel is always null because setActiveModel() is unwired by
    // design (llama-swap owns swap), so wouldSwapModel never fires in v1.
    expect(
      admit(state({ activeModel: null }), reqFor("owner", { requestedModel: "b" }), CFG).wouldSwapModel
    ).toBe(false);
    expect(
      admit(state({ activeModel: "a" }), reqFor("owner", { requestedModel: null }), CFG).wouldSwapModel
    ).toBe(false);
  });
});

describe("AdmissionController", () => {
  it("guest rejects immediately at cap while owner queues then admits on release", async () => {
    const ctrl = new AdmissionController({
      maxInflight: 1,
      ownerQueueMaxMs: 1000,
      retryAfterAtCapSeconds: 2,
    });

    const ownerReq = reqFor("owner");
    const release1 = await ctrl.acquire(ownerReq);
    expect(ctrl.snapshot().inflight).toBe(1);

    // Guest hits a busy box → immediate rejection.
    await expect(ctrl.acquire(reqFor("guest"))).rejects.toBeInstanceOf(AdmissionRejected);

    // Owner queues, then is admitted when the held slot frees.
    let secondAdmitted = false;
    const secondP = ctrl.acquire(reqFor("owner")).then((rel) => {
      secondAdmitted = true;
      return rel;
    });
    // Not yet admitted while slot is held.
    await new Promise((r) => setTimeout(r, 20));
    expect(secondAdmitted).toBe(false);

    release1();
    const release2 = await secondP;
    expect(secondAdmitted).toBe(true);
    release2();
  });

  it("owner queue times out to AdmissionRejected when no slot frees in time", async () => {
    const ctrl = new AdmissionController({
      maxInflight: 1,
      ownerQueueMaxMs: 30,
      retryAfterAtCapSeconds: 2,
    });
    const release = await ctrl.acquire(reqFor("owner"));
    await expect(ctrl.acquire(reqFor("owner"))).rejects.toBeInstanceOf(AdmissionRejected);
    release();
  });

  it("per-key cap rejects through the controller even with a free global slot", async () => {
    const ctrl = new AdmissionController({
      maxInflight: 4,
      ownerQueueMaxMs: 1000,
      retryAfterAtCapSeconds: 2,
    });
    await expect(
      ctrl.acquire(reqFor("owner", { keyMaxParallel: 1, keyInflight: 1 }))
    ).rejects.toBeInstanceOf(AdmissionRejected);
  });

  it("setActiveModel updates the snapshot (the intentionally-unwired model-swap hook)", () => {
    const ctrl = new AdmissionController({
      maxInflight: 2,
      ownerQueueMaxMs: 1000,
      retryAfterAtCapSeconds: 2,
    });
    // Default: the gateway tracks no active model — setActiveModel() is never called in v1
    // because llama-swap owns model swapping (see ADR-004). The hook stays covered so it
    // does not silently rot if a future topology needs gateway-owned swap.
    expect(ctrl.snapshot().activeModel).toBe(null);
    ctrl.setActiveModel("flagship");
    expect(ctrl.snapshot().activeModel).toBe("flagship");
    ctrl.setActiveModel(null);
    expect(ctrl.snapshot().activeModel).toBe(null);
  });

  // M2 regression: queued owner requests from the same key must NOT be admitted concurrently
  // when the key has maxParallel:1.  Before the fix, drainQueue() resolved all queued waiters
  // in a tight while-loop without re-checking the per-key cap, so two requests from the same
  // key could both get a slot at the same time.
  it("M2: drainQueue re-checks per-key cap — second same-key owner waits until first releases", async () => {
    // maxInflight:2 so there are two global slots available when the blocker releases;
    // both queued requests would be admitted simultaneously without the fix.
    const ctrl = new AdmissionController({
      maxInflight: 2,
      ownerQueueMaxMs: 2000,
      retryAfterAtCapSeconds: 2,
    });

    // Occupy both global slots so all new arrivals must queue.
    const blocker1 = await ctrl.acquire(reqFor("owner", { keyId: "blocker", keyMaxParallel: 10, keyInflight: 0 }));
    const blocker2 = await ctrl.acquire(reqFor("owner", { keyId: "blocker", keyMaxParallel: 10, keyInflight: 1 }));
    expect(ctrl.snapshot().inflight).toBe(2);

    // Two requests from the SAME key "alice" with maxParallel:1 — they queue.
    // keyInflight is 0 for both at enqueue time (the controller must track internally).
    const events: string[] = [];

    const p1 = ctrl.acquire(reqFor("owner", { keyId: "alice", keyMaxParallel: 1, keyInflight: 0 })).then((rel) => {
      events.push("alice-1-admitted");
      return rel;
    });
    const p2 = ctrl.acquire(reqFor("owner", { keyId: "alice", keyMaxParallel: 1, keyInflight: 0 })).then((rel) => {
      events.push("alice-2-admitted");
      return rel;
    });

    // Both are queued — neither admitted yet.
    await new Promise((r) => setTimeout(r, 20));
    expect(events).toHaveLength(0);

    // Release both global slots at once — without the fix both alice requests resolve.
    blocker1();
    blocker2();

    // Give drainQueue a tick to run.
    await new Promise((r) => setTimeout(r, 20));

    // With the fix: only ONE of the two alice requests may be admitted (keyMaxParallel:1).
    expect(events).toHaveLength(1);
    expect(events[0]).toBe("alice-1-admitted"); // FIFO order

    // The second alice is still waiting.  Release the first; now the second can proceed.
    const release1 = await p1;
    release1();

    await new Promise((r) => setTimeout(r, 20));
    expect(events).toHaveLength(2);
    expect(events[1]).toBe("alice-2-admitted");

    const release2 = await p2;
    release2();
  });
});

// Bench / maintenance mode (#108): a heavy job reserves the box — guests are refused outright
// (503 + Retry-After) while owner traffic is never blocked by it.
describe("bench/maintenance mode (#108)", () => {
  describe("admit() pure rule", () => {
    it("maintenance + guest → reject 503 with the maintenance retry-after", () => {
      const r = admit(state({ maintenanceMode: true }), reqFor("guest"), {
        ...CFG,
        maintenanceRetryAfterSeconds: 45,
      });
      expect(r.decision).toBe("reject");
      if (r.decision === "reject") {
        expect(r.status).toBe(503);
        expect(r.retryAfterSeconds).toBe(45);
      }
    });

    it("maintenance + guest uses the default retry-after when cfg omits it", () => {
      const r = admit(state({ maintenanceMode: true }), reqFor("guest"), CFG);
      expect(r.decision).toBe("reject");
      if (r.decision === "reject")
        expect(r.retryAfterSeconds).toBe(MAINTENANCE_RETRY_AFTER_DEFAULT);
    });

    it("maintenance + guest is refused even with free slots", () => {
      const r = admit(state({ maintenanceMode: true, inflight: 0, maxInflight: 4 }), reqFor("guest"), CFG);
      expect(r.decision).toBe("reject");
    });

    it("maintenance does NOT block owners — admit on a free slot", () => {
      expect(admit(state({ maintenanceMode: true }), reqFor("owner"), CFG).decision).toBe("admit");
    });

    it("maintenance + owner at cap still queues (never rejected by maintenance)", () => {
      const r = admit(state({ maintenanceMode: true, inflight: 2 }), reqFor("owner"), CFG);
      expect(r.decision).toBe("queue");
    });

    it("maintenance off (undefined) leaves guest admission unchanged", () => {
      expect(admit(state(), reqFor("guest"), CFG).decision).toBe("admit");
    });
  });

  describe("AdmissionController toggle", () => {
    const baseCfg = { maxInflight: 4, ownerQueueMaxMs: 1000, retryAfterAtCapSeconds: 2 };

    it("setMaintenanceMode flips the snapshot + isMaintenanceMode", () => {
      const ctrl = new AdmissionController(baseCfg);
      expect(ctrl.isMaintenanceMode()).toBe(false);
      expect(ctrl.snapshot().maintenanceMode).toBe(false);
      expect(ctrl.setMaintenanceMode(true)).toBe(true);
      expect(ctrl.isMaintenanceMode()).toBe(true);
      expect(ctrl.snapshot().maintenanceMode).toBe(true);
      ctrl.setMaintenanceMode(false);
      expect(ctrl.snapshot().maintenanceMode).toBe(false);
    });

    it("starts engaged when constructed with maintenanceMode:true", () => {
      const ctrl = new AdmissionController({ ...baseCfg, maintenanceMode: true });
      expect(ctrl.isMaintenanceMode()).toBe(true);
    });

    it("guest is rejected while on, owner still flows, guest admitted after off", async () => {
      const ctrl = new AdmissionController(baseCfg);
      ctrl.setMaintenanceMode(true);
      await expect(ctrl.acquire(reqFor("guest"))).rejects.toBeInstanceOf(AdmissionRejected);
      const ownerRel = await ctrl.acquire(reqFor("owner")); // owner unaffected
      ownerRel();
      ctrl.setMaintenanceMode(false);
      const guestRel = await ctrl.acquire(reqFor("guest")); // now allowed
      expect(ctrl.snapshot().inflight).toBe(1);
      guestRel();
    });

    it("the maintenance rejection carries the configured retry-after", async () => {
      const ctrl = new AdmissionController({
        ...baseCfg,
        maintenanceRetryAfterSeconds: 42,
        maintenanceMode: true,
      });
      await expect(ctrl.acquire(reqFor("guest"))).rejects.toMatchObject({ retryAfterSeconds: 42 });
    });
  });

  // #105 follow-up: an unattended batch job (weekly Model Scout) engages maintenance mode around
  // an ephemeral GPU test window. If that job dies uncleanly (OOM, SIGKILL, crash) before it can
  // call setMaintenanceMode(false), a plain boolean toggle would stay stuck ON forever — silently
  // 503ing every guest with no auto-recovery. A TTL closes that hole: the mode self-expires even
  // if nobody ever calls it off again.
  describe("AdmissionController maintenance-mode TTL auto-expiry", () => {
    const baseCfg = { maxInflight: 4, ownerQueueMaxMs: 1000, retryAfterAtCapSeconds: 2 };

    it("is still engaged before the TTL elapses", () => {
      let t = 0;
      const ctrl = new AdmissionController({ ...baseCfg, now: () => t });
      ctrl.setMaintenanceMode(true, 60_000);
      t += 59_999;
      expect(ctrl.isMaintenanceMode()).toBe(true);
      expect(ctrl.snapshot().maintenanceMode).toBe(true);
    });

    it("self-expires the instant the TTL elapses, with no further calls", () => {
      let t = 0;
      const ctrl = new AdmissionController({ ...baseCfg, now: () => t });
      ctrl.setMaintenanceMode(true, 60_000);
      t += 60_001;
      expect(ctrl.isMaintenanceMode()).toBe(false);
      expect(ctrl.snapshot().maintenanceMode).toBe(false);
    });

    it("an expired TTL actually lets a stuck-crashed job's guests back in", async () => {
      let t = 0;
      const ctrl = new AdmissionController({ ...baseCfg, now: () => t });
      ctrl.setMaintenanceMode(true, 60_000); // job "crashes" here, never calls setMaintenanceMode(false)
      await expect(ctrl.acquire(reqFor("guest"))).rejects.toBeInstanceOf(AdmissionRejected);
      t += 60_001;
      const rel = await ctrl.acquire(reqFor("guest")); // self-healed, no manual intervention
      rel();
    });

    it("omitting ttlMs preserves the old unlimited-duration behavior", () => {
      let t = 0;
      const ctrl = new AdmissionController({ ...baseCfg, now: () => t });
      ctrl.setMaintenanceMode(true);
      t += 1_000_000_000;
      expect(ctrl.isMaintenanceMode()).toBe(true);
    });

    it("setMaintenanceMode(false) clears a pending TTL so a later on-without-ttl doesn't inherit it", () => {
      let t = 0;
      const ctrl = new AdmissionController({ ...baseCfg, now: () => t });
      ctrl.setMaintenanceMode(true, 60_000);
      ctrl.setMaintenanceMode(false);
      ctrl.setMaintenanceMode(true); // re-engaged with no ttl this time
      t += 1_000_000;
      expect(ctrl.isMaintenanceMode()).toBe(true);
    });

    it("re-engaging replaces any previous TTL rather than stacking", () => {
      let t = 0;
      const ctrl = new AdmissionController({ ...baseCfg, now: () => t });
      ctrl.setMaintenanceMode(true, 60_000); // expiry at t=60_000
      t += 30_000; // t=30_000 — old expiry (60_000) hasn't passed yet
      ctrl.setMaintenanceMode(true, 60_000); // renewed from t=30_000, new expiry at t=90_000
      t += 59_999; // t=89_999 — old expiry (60_000) is long past, renewed one (90_000) isn't yet
      expect(ctrl.isMaintenanceMode()).toBe(true);
      t += 2; // t=90_001 — past the renewed expiry
      expect(ctrl.isMaintenanceMode()).toBe(false);
    });
  });
});
