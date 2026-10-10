import { describe, expect, it } from "vitest";
import { evaluateLiveInstall, liveInstallPlanSchema, LiveInstallEvidenceSession } from "../src/homeserver/live-install-observation.js";

const hash = (c: string) => c.repeat(64);
const wallMs = 2_000_000;
const clock = { wallMs, monotonicMs: 20_000, expectedNonceSha256: hash("c") };
const producer = { producerId: "runtime", instanceSha256: hash("1"), buildSha256: hash("2"), configSha256: hash("3") };
function plan() {
  return {
    schemaVersion: 2,
    install: {
      schemaVersion: 1, releaseSha: "a".repeat(40), inputsSha256: hash("b"), expiresAt: new Date(wallMs + 10_000).toISOString(), residency: "preserve",
      resources: { memoryMaxBytes: 100, cpuQuotaPercent: 50, tasksMax: 16, reserveBytes: 50, minCpuIdlePercent: 50 },
      timing: { pollMs: 100, observationTimeoutMs: 100, maxObservationAgeMs: 1500, maxRunMs: 1000, stopTimeoutMs: 100, cleanupTimeoutMs: 100 },
    },
    binding: { hostBootIdSha256: hash("4"), manifestSha256: hash("5"), runIdSha256: hash("6"), producers: [{ ...producer }], protectedUnits: ["model.service"] },
  };
}
function observation(previous = false): any {
  return {
    source: "host-probe-v2", observedAt: new Date(wallMs - (previous ? 100 : 0)).toISOString(),
    observedMonotonicMs: clock.monotonicMs - (previous ? 100 : 0),
    releaseSha: "a".repeat(40), inputsSha256: hash("b"), residentModels: ["model"],
    hostBootIdSha256: hash("4"), manifestSha256: hash("5"), coverage: "complete",
    observer: { instanceSha256: hash("7"), sequence: previous ? 1 : 2, requestNonceSha256: hash(previous ? "d" : "c") },
    installLease: { runIdSha256: hash("6"), held: true },
    gpuLease: { state: "free", owner: null },
    gateway: { active: 0, queued: 0, leaseHeld: false },
    producers: [{ ...producer, active: 0, queued: 0, loading: 0, workStarted: 3 }],
    resources: { memoryMaxBytes: 100, cpuQuotaPercent: 50, tasksMax: 16, availableMemoryBytes: 200, cpuIdlePercent: 80, limitsVerified: true },
    oomKills: 0, protectedServices: [{ unit: "model.service", active: true, invocationId: "one", restarts: 0, oomKills: 0 }], maintenanceActive: false,
  };
}
const assess = (current = observation(), previous: unknown = observation(true), approved: unknown = plan(), time: unknown = clock) => evaluateLiveInstall(approved, current, previous, time);

describe("versioned live install evidence", () => {
  it("requires two complete idle observations for the accepted binding", () => {
    expect(assess()).toMatchObject({ admit: true, reasons: [], source: "host-probe-v2" });
    expect(evaluateLiveInstall(plan(), observation(), undefined, clock).admit).toBe(false);
  });
  it("catches a request completed entirely between polls", () => {
    const current = observation(); current.producers[0].workStarted++;
    expect(assess(current).reasons).toContain("work-started");
  });
  it.each(["active", "queued", "loading"])("refuses %s work", key => {
    const current = observation(); current.producers[0][key] = 1;
    expect(assess(current).reasons).toContain("producer-busy");
  });
  it.each(["active", "queued", "loading", "workStarted"])("refuses unknown %s", key => {
    const current = observation(); current.producers[0][key] = null;
    expect(assess(current).reasons).toContain("producer-activity-unknown");
  });
  it.each(["instanceSha256", "buildSha256", "configSha256"])("binds producer %s", key => {
    const current = observation(); current.producers[0][key] = hash("f");
    expect(assess(current).reasons).toContain("producer-identity-mismatch");
  });
  it.each(["hostBootIdSha256", "manifestSha256"])("rejects changed %s", key => {
    const current = observation(); current[key] = hash("f");
    expect(assess(current).admit).toBe(false);
  });
  it("rejects incomplete, omitted, duplicate and unexpected producers", () => {
    const unknown = observation(); unknown.coverage = "unknown";
    const omitted = observation(); omitted.producers = [];
    const duplicate = observation(); duplicate.producers.push({ ...duplicate.producers[0] });
    const extra = observation(); extra.producers.push({ ...extra.producers[0], producerId: "unapproved" });
    for (const sample of [unknown, omitted, duplicate, extra]) expect(assess(sample).admit).toBe(false);
  });
  it("rejects replay, clock rollback and stale evidence on either clock", () => {
    for (const change of [
      (x: any) => x.observer.sequence = 1,
      (x: any) => x.observedMonotonicMs = 19_900,
      (x: any) => x.observedMonotonicMs = 30_000,
      (x: any) => x.observedMonotonicMs = 1,
      (x: any) => x.observedAt = new Date(wallMs - 2000).toISOString(),
      (x: any) => x.observedAt = new Date(wallMs + 1).toISOString(),
      (x: any) => x.observer.requestNonceSha256 = hash("d"),
    ]) { const current = observation(); change(current); expect(assess(current).admit).toBe(false); }
  });
  it("rejects an observer restart, sequence reset and a busy baseline", () => {
    const restart = observation(); restart.observer.instanceSha256 = hash("f");
    const reset = observation(); reset.producers[0].workStarted = 0;
    const busy = observation(true); busy.producers[0].active = 1;
    expect(assess(restart).admit).toBe(false);
    expect(assess(reset).admit).toBe(false);
    expect(assess(observation(), busy).admit).toBe(false);
  });
  it("requires the approved install lease and actual free GPU ownership", () => {
    for (const change of [
      (x: any) => x.installLease.held = false,
      (x: any) => x.installLease.runIdSha256 = hash("f"),
      (x: any) => x.gpuLease = { state: "held", owner: { ownerIdSha256: hash("a"), purpose: "inference" } },
      (x: any) => x.gpuLease = { state: "free", owner: { ownerIdSha256: hash("a"), purpose: "inference" } },
      (x: any) => x.gateway.leaseHeld = true,
    ]) { const current = observation(); change(current); expect(assess(current).admit).toBe(false); }
  });
  it("binds protected inventory and per-cgroup OOM counts", () => {
    for (const change of [
      (x: any) => x.protectedServices = [],
      (x: any) => x.protectedServices[0].unit = "other.service",
      (x: any) => x.protectedServices[0].oomKills = null,
      (x: any) => x.protectedServices[0].oomKills = 1,
      (x: any) => x.protectedServices[0].invocationId = "two",
      (x: any) => x.protectedServices[0].active = false,
      (x: any) => x.oomKills = 1,
    ]) { const current = observation(); change(current); expect(assess(current).admit).toBe(false); }
  });
  it("retains release, expiry, resource and residency checks", () => {
    for (const change of [
      (x: any) => x.releaseSha = "f".repeat(40),
      (x: any) => x.resources.limitsVerified = false,
      (x: any) => x.resources.availableMemoryBytes = 149,
      (x: any) => x.resources.cpuIdlePercent = 49,
      (x: any) => x.residentModels = [],
      (x: any) => x.maintenanceActive = true,
    ]) { const current = observation(); change(current); expect(assess(current).admit).toBe(false); }
    const expired = plan(); expired.install.expiresAt = new Date(wallMs).toISOString();
    expect(assess(observation(), observation(true), expired).admit).toBe(false);
  });
  it("does not accept legacy or diagnostic evidence as live proof", () => {
    for (const source of ["host-probe-v1", "install-coverage-check-v1", "linux-host-inventory-v1"]) {
      const current = observation(); current.source = source;
      expect(assess(current).admit).toBe(false);
    }
  });
  it("rejects duplicate binding IDs, unknown fields and invalid clock without leaking input", () => {
    const p = plan(); p.binding.producers.push({ ...producer });
    expect(liveInstallPlanSchema.safeParse(p).success).toBe(false);
    const sample = observation(); sample.secret = "DO-NOT-ECHO";
    expect(JSON.stringify(assess(sample))).not.toContain("DO-NOT-ECHO");
    expect(assess(sample).admit).toBe(false);
    for (const time of [null, { ...clock, wallMs: NaN }, { ...clock, monotonicMs: -1 }]) expect(assess(observation(), observation(true), plan(), time).admit).toBe(false);
  });
});


describe("live evidence session", () => {
  function started() {
    const session = new LiveInstallEvidenceSession(plan());
    expect(session.observe(observation(true), { wallMs: wallMs - 100, monotonicMs: 19900, expectedNonceSha256: hash("d") }).state).toBe("priming");
    expect(session.observe(observation(), clock).state).toBe("admitted");
    return session;
  }
  it("only issues a permit after two samples, capped by the age of evidence", () => {
    const session = started();
    expect(session.check(clock).permitUntilMonotonicMs).toBe(21500);
    expect(session.check({ ...clock, wallMs: wallMs + 1000, monotonicMs: 21000 }).permitUntilMonotonicMs).toBe(21500);
    expect(session.check({ ...clock, wallMs: wallMs + 1500, monotonicMs: 21500 }).state).toBe("revoked");
  });
  it("cannot renew via heartbeat or resurrect after evidence expiry", () => {
    const session = started();
    const later = observation(); later.observedAt = new Date(wallMs + 1500).toISOString(); later.observedMonotonicMs = 21500;
    later.observer.sequence = 3; later.observer.requestNonceSha256 = hash("e");
    expect(session.observe(later, { wallMs: wallMs + 1500, monotonicMs: 21500, expectedNonceSha256: hash("e") }).state).toBe("revoked");
    expect(session.observe(observation(), clock).state).toBe("revoked");
  });
  it("latches unknown/busy evidence and refuses a replacement baseline", () => {
    const session = started();
    const later = observation(); later.producers[0].active = 1;
    expect(session.observe(later, clock).state).toBe("revoked");
    expect(session.observe(observation(), clock).state).toBe("revoked");
  });
  it("copies accepted evidence so caller mutation cannot erase between-poll work", () => {
    const session = new LiveInstallEvidenceSession(plan());
    const prior = observation(true);
    session.observe(prior, { ...clock, expectedNonceSha256: hash("d") });
    prior.producers[0].workStarted = 4;
    const current = observation(); current.producers[0].workStarted = 4;
    expect(session.observe(current, clock).decision.reasons).toContain("work-started");
  });
  it("caps the permit at approval expiry", () => {
    const p = plan(); p.install.expiresAt = new Date(wallMs + 250).toISOString();
    const session = new LiveInstallEvidenceSession(p);
    session.observe(observation(true), { ...clock, expectedNonceSha256: hash("d") });
    expect(session.observe(observation(), clock).permitUntilMonotonicMs).toBe(20250);
  });
  it("revokes on clock rollback and explicit cancellation", () => {
    expect(started().check({ ...clock, monotonicMs: 19999 }).state).toBe("revoked");
    expect(started().check({ ...clock, wallMs: wallMs - 1 }).state).toBe("revoked");
    const session = started(); session.revoke();
    expect(session.check(clock).state).toBe("revoked");
  });
});
