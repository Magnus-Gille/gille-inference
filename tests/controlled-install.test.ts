import { describe, expect, it } from "vitest";
import {
  evaluateControlledInstall,
  evaluateControlledInstallRestoration,
  runControlledInstall,
} from "../src/homeserver/controlled-install.js";

const RELEASE_SHA = "a".repeat(40);
const INPUTS_SHA = "b".repeat(64);
const PROTECTED_UNIT = "home-gateway.service";

type Plan = {
  schemaVersion: 1;
  releaseSha: string;
  inputsSha256: string;
  expiresAt: string;
  residency: "preserve" | "allow-idle-changes";
  resources: {
    memoryMaxBytes: number;
    cpuQuotaPercent: number;
    tasksMax: number;
    reserveBytes: number;
    minCpuIdlePercent: number;
  };
  timing: {
    pollMs: number;
    observationTimeoutMs: number;
    maxObservationAgeMs: number;
    maxRunMs: number;
    stopTimeoutMs: number;
    cleanupTimeoutMs: number;
  };
};

type Observation = {
  observedAt: string;
  source: "host-probe-v1";
  releaseSha: string;
  inputsSha256: string;
  residentModels: string[];
  gateway: { active: number | null; queued: number | null; leaseHeld: boolean | null };
  backend: { coverage: "complete" | "unknown"; active: number | null; queued: number | null };
  resources: {
    availableMemoryBytes: number | null;
    cpuIdlePercent: number | null;
    limitsVerified: boolean;
    memoryMaxBytes: number;
    cpuQuotaPercent: number;
    tasksMax: number;
  };
  oomKills: number | null;
  protectedServices: Array<{
    unit: string;
    active: boolean;
    invocationId: string;
    restarts: number;
  }>;
  maintenanceActive: boolean | null;
};

function makePlan(overrides: Partial<Plan> = {}): Plan {
  const now = Date.now();
  return {
    schemaVersion: 1,
    releaseSha: RELEASE_SHA,
    inputsSha256: INPUTS_SHA,
    expiresAt: new Date(now + 5_000).toISOString(),
    residency: "preserve",
    resources: {
      memoryMaxBytes: 4_000_000_000,
      cpuQuotaPercent: 80,
      tasksMax: 32,
      reserveBytes: 500_000_000,
      minCpuIdlePercent: 20,
    },
    timing: {
      pollMs: 5,
      observationTimeoutMs: 100,
      maxObservationAgeMs: 1_000,
      maxRunMs: 300,
      stopTimeoutMs: 100,
      cleanupTimeoutMs: 100,
    },
    ...overrides,
  };
}

function makeObservation(overrides: Partial<Observation> = {}): Observation {
  return {
    observedAt: new Date().toISOString(),
    source: "host-probe-v1",
    releaseSha: RELEASE_SHA,
    inputsSha256: INPUTS_SHA,
    residentModels: ["model-a"],
    gateway: { active: 0, queued: 0, leaseHeld: false },
    backend: { coverage: "complete", active: 0, queued: 0 },
    resources: {
      availableMemoryBytes: 8_000_000_000,
      cpuIdlePercent: 80,
      limitsVerified: true,
      memoryMaxBytes: 4_000_000_000,
      cpuQuotaPercent: 80,
      tasksMax: 32,
    },
    oomKills: 0,
    protectedServices: [{ unit: PROTECTED_UNIT, active: true, invocationId: "invocation-1", restarts: 0 }],
    maintenanceActive: false,
    ...overrides,
  };
}

function reasonText(decision: unknown): string {
  return ((decision as { reasons?: unknown }).reasons ?? []).join(" ");
}

describe("controlled install admission policy", () => {
  it("captures current residency on the first evaluation instead of comparing it to an empty baseline", () => {
    const decision = evaluateControlledInstall(makePlan(), makeObservation());

    expect(decision).toMatchObject({ admit: true, source: "host-probe-v1" });
    expect(decision.observedAt).toBeTruthy();
  });

  it("admits an empty resident set when all activity is idle", () => {
    const decision = evaluateControlledInstall(makePlan(), makeObservation({ residentModels: [] }));

    expect(decision.admit).toBe(true);
  });

  it("rejects unknown activity and incomplete backend evidence", () => {
    const decision = evaluateControlledInstall(
      makePlan(),
      makeObservation({
        gateway: { active: null, queued: 0, leaseHeld: null },
        backend: { coverage: "unknown", active: null, queued: null },
      }),
    );

    expect(decision.admit).toBe(false);
    expect(reasonText(decision)).toMatch(/unknown|activity|gateway|backend/i);
  });

  it.each([
    ["active", { active: 1, queued: 0 }, "backend-busy"],
    ["queued", { active: 0, queued: 1 }, "backend-busy"],
  ])("rejects backend %s work even when the gateway is idle", (_label, activity, reason) => {
    const decision = evaluateControlledInstall(
      makePlan(),
      makeObservation({ backend: { coverage: "complete", ...activity } }),
    );

    expect(decision.admit).toBe(false);
    expect(decision.reasons).toContain(reason);
  });

  it.each([
    ["active", { active: 1, queued: 0, leaseHeld: false }],
    ["queued", { active: 0, queued: 1, leaseHeld: false }],
    ["leased", { active: 0, queued: 0, leaseHeld: true }],
  ])("rejects gateway %s activity", (_label, gateway) => {
    const decision = evaluateControlledInstall(makePlan(), makeObservation({ gateway }));

    expect(decision.admit).toBe(false);
    expect(decision.reasons).toContain("gateway-busy");
  });

  it("allows dynamic residency only under the explicit idle-change policy", () => {
    const baseline = makeObservation({ residentModels: ["model-a"] });
    const current = makeObservation({ residentModels: ["model-a", "model-b"] });

    const preserve = evaluateControlledInstall(makePlan(), current, baseline);
    const allowIdleChanges = evaluateControlledInstall(
      makePlan({ residency: "allow-idle-changes" }),
      current,
      baseline,
    );

    expect(preserve.admit).toBe(false);
    expect(allowIdleChanges.admit).toBe(true);
  });

  it("rejects resource-limit drift even when the host still has spare capacity", () => {
    const decision = evaluateControlledInstall(
      makePlan(),
      makeObservation({
        resources: {
          ...makeObservation().resources,
          memoryMaxBytes: 3_000_000_000,
        },
      }),
    );

    expect(decision.admit).toBe(false);
    expect(reasonText(decision)).toMatch(/limit|resource|drift/i);
  });

  it.each([
    ["insufficient memory", { availableMemoryBytes: 1 }, "memory-headroom"],
    ["unknown memory", { availableMemoryBytes: null }, "memory-headroom"],
    ["insufficient CPU idle", { cpuIdlePercent: 1 }, "cpu-headroom"],
    ["unknown CPU idle", { cpuIdlePercent: null }, "cpu-headroom"],
  ])("rejects %s", (_label, resources, reason) => {
    const decision = evaluateControlledInstall(
      makePlan(),
      makeObservation({ resources: { ...makeObservation().resources, ...resources } }),
    );

    expect(decision.admit).toBe(false);
    expect(decision.reasons).toContain(reason);
  });

  it("rejects an OOM counter increase from the preserved baseline", () => {
    const decision = evaluateControlledInstall(
      makePlan(),
      makeObservation({ oomKills: 2 }),
      makeObservation({ oomKills: 1 }),
    );

    expect(decision.admit).toBe(false);
    expect(reasonText(decision)).toMatch(/oom/i);
  });

  it("accepts a fresh observation and rejects stale or future observations", () => {
    const nowMs = Date.parse("2026-10-10T12:00:00.000Z");
    const plan = makePlan({ expiresAt: new Date(nowMs + 5_000).toISOString() });
    const fresh = evaluateControlledInstall(
      plan,
      makeObservation({ observedAt: new Date(nowMs).toISOString() }),
      undefined,
      nowMs,
    );
    const stale = evaluateControlledInstall(
      plan,
      makeObservation({ observedAt: new Date(nowMs - 1_001).toISOString() }),
      undefined,
      nowMs,
    );
    const future = evaluateControlledInstall(
      plan,
      makeObservation({ observedAt: new Date(nowMs + 1).toISOString() }),
      undefined,
      nowMs,
    );

    expect(fresh.admit).toBe(true);
    expect(stale.reasons).toContain("observation-not-fresh");
    expect(future.reasons).toContain("observation-not-fresh");
  });

  it("rejects an expired plan and immutable release or input mismatches", () => {
    const nowMs = Date.parse("2026-10-10T12:00:00.000Z");
    const validPlan = makePlan({ expiresAt: new Date(nowMs + 5_000).toISOString() });
    const expired = evaluateControlledInstall(
      { ...validPlan, expiresAt: new Date(nowMs - 1).toISOString() },
      makeObservation({ observedAt: new Date(nowMs).toISOString() }),
      undefined,
      nowMs,
    );
    const releaseMismatch = evaluateControlledInstall(
      validPlan,
      makeObservation({ observedAt: new Date(nowMs).toISOString(), releaseSha: "c".repeat(40) }),
      undefined,
      nowMs,
    );
    const inputsMismatch = evaluateControlledInstall(
      validPlan,
      makeObservation({ observedAt: new Date(nowMs).toISOString(), inputsSha256: "d".repeat(64) }),
      undefined,
      nowMs,
    );

    expect(expired.reasons).toContain("approval-expired");
    expect(releaseMismatch.reasons).toContain("identity-mismatch");
    expect(inputsMismatch.reasons).toContain("identity-mismatch");
  });

  it("rejects a malformed baseline before comparing it", () => {
    const decision = evaluateControlledInstall(makePlan(), makeObservation(), { malformed: true });

    expect(decision.admit).toBe(false);
    expect(decision.reasons).toContain("invalid-baseline");
  });

  it("treats residency as a set, while rejecting duplicate inventory entries", () => {
    const baseline = makeObservation({ residentModels: ["model-a", "model-b"] });
    const reordered = evaluateControlledInstall(
      makePlan(),
      makeObservation({ residentModels: ["model-b", "model-a"] }),
      baseline,
    );
    const duplicateModel = evaluateControlledInstall(
      makePlan(),
      makeObservation({ residentModels: ["model-a", "model-a"] }),
    );
    const duplicateProtected = evaluateControlledInstall(
      makePlan(),
      makeObservation({
        protectedServices: [
          ...makeObservation().protectedServices,
          { ...makeObservation().protectedServices[0] },
        ],
      }),
    );

    expect(reordered.admit).toBe(true);
    expect(duplicateModel.reasons).toContain("invalid-observation");
    expect(duplicateProtected.reasons).toContain("invalid-observation");
  });

  it.each([
    ["invocation change", { invocationId: "invocation-2" }, /invocation|protected/i],
    ["restart increase", { restarts: 1 }, /restart|protected/i],
    ["activity change", { active: false }, /active|protected/i],
  ])("rejects protected-service %s", (_label, change, reason) => {
    const baseline = makeObservation();
    const protectedServices = [{ ...baseline.protectedServices[0], ...change }];
    const decision = evaluateControlledInstall(makePlan(), makeObservation({ protectedServices }), baseline);

    expect(decision.admit).toBe(false);
    expect(reasonText(decision)).toMatch(reason);
  });

  it("rejects protected-service set drift", () => {
    const baseline = makeObservation();
    const decision = evaluateControlledInstall(
      makePlan(),
      makeObservation({
        protectedServices: [...baseline.protectedServices, {
          unit: "llama-swap.service",
          active: true,
          invocationId: "invocation-2",
          restarts: 0,
        }],
      }),
      baseline,
    );

    expect(decision.admit).toBe(false);
    expect(reasonText(decision)).toMatch(/protected|service|set/i);
  });
});

describe("controlled install restoration policy", () => {
  const nowMs = Date.parse("2026-10-10T12:00:00.000Z");

  function finalEvidence(overrides: Partial<Observation> = {}): Observation {
    return makeObservation({ observedAt: new Date(nowMs).toISOString(), ...overrides });
  }

  it("accepts new customer activity after the owned workload is independently stopped", () => {
    const customerActivity = finalEvidence({
      gateway: { active: 1, queued: 0, leaseHeld: false },
      backend: { coverage: "unknown", active: null, queued: null },
    });

    const decision = evaluateControlledInstallRestoration(
      makePlan({ expiresAt: new Date(nowMs + 5_000).toISOString() }),
      customerActivity,
      finalEvidence(),
      nowMs,
    );

    expect(decision).toMatchObject({ admit: true, source: "host-probe-v1" });
  });

  it.each([
    ["stale evidence", { observedAt: new Date(nowMs - 1_001).toISOString() }, "observation-not-fresh"],
    ["identity drift", { releaseSha: "c".repeat(40) }, "identity-mismatch"],
    ["unknown OOM counter", { oomKills: null }, "oom-unknown"],
    ["maintenance overlap", { maintenanceActive: true }, "maintenance-not-idle"],
    ["unknown maintenance", { maintenanceActive: null }, "maintenance-not-idle"],
    ["protected health drift", { protectedServices: [{ ...makeObservation().protectedServices[0], active: false }] }, "protected-service-unhealthy"],
  ])("rejects final restoration evidence with %s", (_label, change, reason) => {
    const plan = makePlan({ expiresAt: new Date(nowMs + 5_000).toISOString() });
    const decision = evaluateControlledInstallRestoration(
      plan,
      finalEvidence(change),
      finalEvidence(),
      nowMs,
    );

    expect(decision.admit).toBe(false);
    expect(decision.reasons).toContain(reason);
  });

  it.each([
    ["OOM drift", { oomKills: 1 }, "oom-drift"],
    ["protected invocation drift", { protectedServices: [{ ...makeObservation().protectedServices[0], invocationId: "invocation-2" }] }, "protected-service-drift"],
    ["residency drift", { residentModels: ["model-b"] }, "residency-drift"],
  ])("rejects final restoration evidence with %s", (_label, change, reason) => {
    const baseline = finalEvidence();
    const decision = evaluateControlledInstallRestoration(
      makePlan({ expiresAt: new Date(nowMs + 5_000).toISOString() }),
      finalEvidence(change),
      baseline,
      nowMs,
    );

    expect(decision.admit).toBe(false);
    expect(decision.reasons).toContain(reason);
  });

  it("fails closed for an invalid clock or expired approval", () => {
    const evidence = finalEvidence();
    const baseline = finalEvidence();
    const expired = evaluateControlledInstallRestoration(
      makePlan({ expiresAt: new Date(nowMs - 1).toISOString() }), evidence, baseline, nowMs,
    );
    const invalidClock = evaluateControlledInstallRestoration(
      makePlan({ expiresAt: new Date(nowMs + 5_000).toISOString() }), evidence, baseline, Number.NaN,
    );

    expect(expired.reasons).toContain("approval-expired");
    expect(invalidClock.reasons).toContain("invalid-clock");
  });
});

type Operations = {
  observe: (signal: AbortSignal) => Promise<unknown>;
  run: (signal: AbortSignal) => Promise<void>;
  stop: (signal: AbortSignal) => Promise<void>;
  cleanup: (signal: AbortSignal) => Promise<void>;
  verifyRestoration: (baseline: unknown, signal: AbortSignal) => Promise<void>;
};

function makeOperations(observations: unknown[] = [makeObservation()]): Operations & Record<string, number> {
  let observationIndex = 0;
  const operations = {
    observe: async (_signal: AbortSignal) => observations[Math.min(observationIndex++, observations.length - 1)],
    run: async (_signal: AbortSignal) => undefined,
    stop: async (_signal: AbortSignal) => undefined,
    cleanup: async (_signal: AbortSignal) => undefined,
    verifyRestoration: async (_baseline: unknown, _signal: AbortSignal) => undefined,
    observeCalls: 0,
    runCalls: 0,
    stopCalls: 0,
    cleanupCalls: 0,
    verifyRestorationCalls: 0,
  };

  const originalObserve = operations.observe;
  operations.observe = async (signal) => {
    operations.observeCalls += 1;
    return originalObserve(signal);
  };
  const originalRun = operations.run;
  operations.run = async (signal) => {
    operations.runCalls += 1;
    return originalRun(signal);
  };
  const originalStop = operations.stop;
  operations.stop = async (signal) => {
    operations.stopCalls += 1;
    return originalStop(signal);
  };
  const originalCleanup = operations.cleanup;
  operations.cleanup = async (signal) => {
    operations.cleanupCalls += 1;
    return originalCleanup(signal);
  };
  const originalVerify = operations.verifyRestoration;
  operations.verifyRestoration = async (baseline, signal) => {
    operations.verifyRestorationCalls += 1;
    return originalVerify(baseline, signal);
  };
  return operations;
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
}

describe("controlled install lifecycle", () => {
  it("retains the rejected watchdog observation time and provenance after cleanup", async () => {
    const baseline = makeObservation();
    const busy = makeObservation({ backend: { coverage: "complete", active: 1, queued: 0 } });
    const operations = makeOperations([baseline, busy, makeObservation()]);
    operations.run = async () => new Promise<void>(() => undefined);
    const result = await runControlledInstall(makePlan(), operations);
    expect(result).toMatchObject({
      status: "stopped", restored: true,
      checks: { stop: { admit: false, reasons: ["backend-busy"], observedAt: busy.observedAt, source: "host-probe-v1" } },
    });
  });
  it("rejects an already-cancelled run without invoking the observer", async () => {
    const operations = makeOperations();
    const cancellation = new AbortController();
    cancellation.abort();
    await expect(runControlledInstall(makePlan(), operations, cancellation.signal)).resolves.toMatchObject({
      status: "rejected", reasons: ["operator-cancelled"],
    });
    expect(operations.observeCalls).toBe(0);
    expect(operations.runCalls).toBe(0);
  });
  it("stops, cleans up, and verifies restoration after successful work", async () => {
    const operations = makeOperations();
    const result = await runControlledInstall(makePlan(), operations);

    expect(result).toMatchObject({ status: "completed", restored: true });
    expect(operations.runCalls).toBe(1);
    expect(operations.stopCalls).toBe(1);
    expect(operations.cleanupCalls).toBe(1);
    expect(operations.verifyRestorationCalls).toBe(1);
  });

  it("cancels hung work promptly and still waits for verified stop", async () => {
    const operations = makeOperations();
    operations.run = async (_signal) => {
      operations.runCalls += 1;
      await new Promise<void>(() => undefined);
    };
    const controller = new AbortController();
    const resultPromise = runControlledInstall(makePlan(), operations, controller.signal);
    setTimeout(() => controller.abort(), 20);

    const result = await resultPromise;
    expect(result.status).toBe("stopped");
    expect(operations.stopCalls).toBe(1);
    expect(operations.cleanupCalls).toBe(1);
  });

  it("stops work when the watchdog observes new gateway activity", async () => {
    const operations = makeOperations([makeObservation(), makeObservation({ gateway: { active: 1, queued: 0, leaseHeld: false } })]);
    operations.run = async signal => {
      operations.runCalls += 1;
      await waitForAbort(signal);
    };

    const result = await runControlledInstall(makePlan(), operations);

    expect(result.status).toBe("stopped");
    expect(result.reasons).toContain("gateway-busy");
    expect(result.restored).toBe(true);
    expect(operations.stopCalls).toBe(1);
    expect(operations.cleanupCalls).toBe(1);
  });

  it("bounds a hung watchdog observation and still runs bounded restoration", async () => {
    const operations = makeOperations();
    const baseline = makeObservation();
    let calls = 0;
    operations.observe = async _signal => {
      calls += 1;
      if (calls === 1) return baseline;
      if (calls === 2) await new Promise<void>(() => undefined);
      return baseline;
    };
    operations.run = async signal => {
      operations.runCalls += 1;
      await waitForAbort(signal);
    };

    const result = await runControlledInstall(
      makePlan({ timing: { ...makePlan().timing, observationTimeoutMs: 20 } }),
      operations,
    );

    expect(result.status).toBe("stopped");
    expect(result.reasons).toContain("observation-failed");
    expect(result.restored).toBe(true);
    expect(operations.stopCalls).toBe(1);
  });

  it("stops at the maximum approved runtime deadline", async () => {
    const operations = makeOperations();
    operations.run = async signal => {
      operations.runCalls += 1;
      await waitForAbort(signal);
    };

    const result = await runControlledInstall(
      makePlan({ timing: { ...makePlan().timing, maxRunMs: 25 } }),
      operations,
    );

    expect(result).toMatchObject({ status: "stopped", restored: true });
    expect(result.reasons).toContain("work-deadline");
    expect(operations.stopCalls).toBe(1);
  });

  it("rejects before running when the expiry reserve leaves no approved work time", async () => {
    const operations = makeOperations();
    const timing = {
      ...makePlan().timing,
      observationTimeoutMs: 200,
      maxRunMs: 100,
      stopTimeoutMs: 500,
      cleanupTimeoutMs: 500,
    };
    const result = await runControlledInstall(
      makePlan({ expiresAt: new Date(Date.now() + 1_100).toISOString(), timing }),
      operations,
    );

    expect(result).toMatchObject({ status: "rejected", restored: false });
    expect(result.reasons).toContain("insufficient-approved-time");
    expect(operations.runCalls).toBe(0);
    expect(operations.stopCalls).toBe(0);
  });

  it("skips cleanup when stop fails", async () => {
    const operations = makeOperations([
      makeObservation(),
      makeObservation({ gateway: { active: 1, queued: 0, leaseHeld: false } }),
    ]);
    operations.stop = async (_signal) => {
      operations.stopCalls += 1;
      throw new Error("stop failed");
    };

    const result = await runControlledInstall(makePlan(), operations);

    expect(result.status).toBe("restoration-failed");
    expect(operations.cleanupCalls).toBe(0);
    expect(result.restored).toBe(false);
  });

  it("returns restoration-failed and skips cleanup when stop times out", async () => {
    const operations = makeOperations();
    operations.stop = async (_signal) => {
      operations.stopCalls += 1;
      await new Promise<void>(() => undefined);
    };

    const result = await runControlledInstall(
      makePlan({ timing: { ...makePlan().timing, stopTimeoutMs: 20 } }),
      operations,
    );

    expect(result.status).toBe("restoration-failed");
    expect(operations.cleanupCalls).toBe(0);
  });

  it("bounds cleanup and reports restoration failure when cleanup hangs", async () => {
    const operations = makeOperations();
    operations.cleanup = async (_signal) => {
      operations.cleanupCalls += 1;
      await new Promise<void>(() => undefined);
    };

    const result = await runControlledInstall(
      makePlan({ timing: { ...makePlan().timing, cleanupTimeoutMs: 20 } }),
      operations,
    );

    expect(result.status).toBe("restoration-failed");
    expect(operations.verifyRestorationCalls).toBe(0);
  });

  it("reports restoration failure when explicit restoration verification fails", async () => {
    const operations = makeOperations();
    operations.verifyRestoration = async (_baseline, _signal) => {
      operations.verifyRestorationCalls += 1;
      throw new Error("protected state drifted");
    };

    const result = await runControlledInstall(makePlan(), operations);

    expect(result.status).toBe("restoration-failed");
    expect(operations.cleanupCalls).toBe(1);
    expect(operations.verifyRestorationCalls).toBe(1);
    expect(result.restored).toBe(false);
  });
});
