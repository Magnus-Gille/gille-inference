import { describe, expect, it, vi } from "vitest";
import { hashInstallBackendInventory } from "../src/homeserver/install-backend-inventory.js";
import { evaluateInstallCoverage, observeInstallCoverage, type InstallCoverageCollectors } from "../src/homeserver/install-coverage.js";

function fixture() {
  const now = Date.now();
  const at = new Date(now).toISOString();
  const inventory = { schemaVersion: 1, hostBootIdSha256: "a".repeat(64),
    backends: [{ id: "runtime", kind: "runtime", ingressIds: ["direct", "lifecycle"] }],
    ingresses: [{ id: "direct", kind: "direct", backendIds: ["runtime"] }, { id: "lifecycle", kind: "lifecycle", backendIds: ["runtime"] }],
  };
  const inventorySha256 = hashInstallBackendInventory(inventory);
  const binding = { schemaVersion: 1, inventorySha256, boundaryIdentitySha256: "b".repeat(64), expiresAt: new Date(now + 60_000).toISOString(), maxObservationAgeMs: 60_000 };
  const receipt = { source: "host-inventory-v1", state: "observed", observedAt: at, hostBootIdSha256: inventory.hostBootIdSha256, inventorySha256,
    boundaryIdentitySha256: binding.boundaryIdentitySha256, scope: "all-host-inference", backendIds: ["runtime"], ingressIds: ["direct", "lifecycle"], unclassifiedBackendCount: 0, unclassifiedIngressCount: 0 };
  const activity = { source: "backend-work-v1", state: "observed", observedAt: at, hostBootIdSha256: inventory.hostBootIdSha256, inventorySha256,
    identityBeforeSha256: "c".repeat(64), identityAfterSha256: "c".repeat(64), active: 0 as number | null, queued: 0 as number | null, loading: 0 as number | null, fenceExpiresAt: undefined as string | undefined };
  const evidence = { schemaVersion: 1, inventoryBefore: structuredClone(receipt), inventoryAfter: structuredClone(receipt),
    backends: [{ ...activity, id: "runtime" }], ingresses: ["direct", "lifecycle"].map(id => ({ ...activity, id, source: "ingress-work-v1" })) };
  return { now, inventory, binding, evidence };
}
describe("accepted inventory and traffic coverage", () => {
  it("requires all backend, direct and lifecycle evidence before calling a sample idle", () => {
    const { inventory, binding, evidence, now } = fixture();
    expect(evaluateInstallCoverage(inventory, binding, evidence, now)).toMatchObject({ coverage: "complete", activity: "idle", reasons: [] });
  });
  it.each(["active", "queued", "loading"] as const)("preserves known busy %s without summing overlapping pipeline counters", field => {
    const f = fixture(); f.evidence.ingresses[1][field] = 1;
    expect(evaluateInstallCoverage(f.inventory, f.binding, f.evidence, f.now)).toMatchObject({ coverage: "complete", activity: "busy", reasons: [{ code: "ingress-busy", component: "lifecycle" }] });
  });
  it.each(["active", "queued", "loading"] as const)("blocks null %s even when every other count is zero", field => {
    const f = fixture(); f.evidence.backends[0][field] = null;
    expect(evaluateInstallCoverage(f.inventory, f.binding, f.evidence, f.now)).toMatchObject({ coverage: "unknown", activity: "unknown" });
  });
  it.each([
    ["missing sidecar", (f: ReturnType<typeof fixture>) => { f.evidence.inventoryAfter.backendIds.push("unlisted-sidecar"); }],
    ["missing lifecycle evidence", (f: ReturnType<typeof fixture>) => { f.evidence.ingresses.pop(); }],
    ["duplicate backend evidence", (f: ReturnType<typeof fixture>) => { f.evidence.backends.push({ ...f.evidence.backends[0] }); }],
    ["unclassified process", (f: ReturnType<typeof fixture>) => { f.evidence.inventoryBefore.unclassifiedBackendCount = 1; }],
    ["unclassified ingress", (f: ReturnType<typeof fixture>) => { f.evidence.inventoryAfter.unclassifiedIngressCount = 1; }],
    ["changed host", (f: ReturnType<typeof fixture>) => { f.evidence.ingresses[0].hostBootIdSha256 = "d".repeat(64); }],
    ["changed boundary", (f: ReturnType<typeof fixture>) => { f.evidence.inventoryAfter.boundaryIdentitySha256 = "d".repeat(64); }],
    ["changed configuration", (f: ReturnType<typeof fixture>) => { f.evidence.inventoryAfter.inventorySha256 = "d".repeat(64); }],
    ["process replacement", (f: ReturnType<typeof fixture>) => { f.evidence.backends[0].identityAfterSha256 = "d".repeat(64); }],
    ["gateway-only count source", (f: ReturnType<typeof fixture>) => { f.evidence.ingresses[0].source = "gateway-admission-v1"; }],
    ["scheduler-only count source", (f: ReturnType<typeof fixture>) => { f.evidence.backends[0].source = "llamacpp-metrics-v1"; }],
    ["unknown inventory", (f: ReturnType<typeof fixture>) => { f.evidence.inventoryBefore.state = "unknown"; }],
    ["expired binding", (f: ReturnType<typeof fixture>) => { f.binding.expiresAt = new Date(f.now).toISOString(); }],
    ["unaccepted manifest", (f: ReturnType<typeof fixture>) => { f.binding.inventorySha256 = "d".repeat(64); }],
    ["old sample", (f: ReturnType<typeof fixture>) => { f.evidence.backends[0].observedAt = new Date(f.now - 60_001).toISOString(); }],
    ["future sample", (f: ReturnType<typeof fixture>) => { f.evidence.inventoryAfter.observedAt = new Date(f.now + 1).toISOString(); }],
    ["sample before inventory bracket", (f: ReturnType<typeof fixture>) => { f.evidence.backends[0].observedAt = new Date(f.now - 1).toISOString(); }],
  ] as const)("blocks %s", (_name, change) => {
    const f = fixture(); change(f);
    const result = evaluateInstallCoverage(f.inventory, f.binding, f.evidence, f.now);
    expect(result.coverage).toBe("unknown"); expect(result.reasons.length).toBeGreaterThan(0);
  });
  it("requires a fresh drained fence and rejects a mere enabled fence", () => {
    const f = fixture(); const ingress = f.evidence.ingresses[0]; ingress.source = "ingress-fence-v1";
    expect(evaluateInstallCoverage(f.inventory, f.binding, f.evidence, f.now).coverage).toBe("unknown");
    ingress.fenceExpiresAt = new Date(f.now + 1000).toISOString();
    expect(evaluateInstallCoverage(f.inventory, f.binding, f.evidence, f.now).coverage).toBe("complete");
    ingress.queued = 1;
    expect(evaluateInstallCoverage(f.inventory, f.binding, f.evidence, f.now).coverage).toBe("unknown");
  });
  it("rejects malformed schemas without echoing input", () => {
    const f = fixture();
    for (const result of [evaluateInstallCoverage({ secret: "DO_NOT_ECHO" }, f.binding, f.evidence), evaluateInstallCoverage(f.inventory, {}, f.evidence), evaluateInstallCoverage(f.inventory, f.binding, { secret: "DO_NOT_ECHO" })]) {
      expect(result.coverage).toBe("unknown"); expect(JSON.stringify(result)).not.toContain("DO_NOT_ECHO");
    }
  });
  it("does not echo component labels from a manifest that was not accepted", () => {
    const f = fixture();
    f.inventory.backends[0].id = "PRIVATE_KEY";
    for (const ingress of f.inventory.ingresses) ingress.backendIds = ["PRIVATE_KEY"];
    f.evidence.backends[0].id = "PRIVATE_KEY";
    f.evidence.backends[0].active = 1;
    const result = evaluateInstallCoverage(f.inventory, f.binding, f.evidence, f.now);
    expect(result.reasons).toEqual([{ code: "inventory-unbound" }]);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_KEY");
  });
});

function collectors(f: ReturnType<typeof fixture>): InstallCoverageCollectors {
  return {
    inventory: async () => ({ ...f.evidence.inventoryBefore, observedAt: new Date().toISOString() }),
    backend: async target => ({ ...f.evidence.backends[0], id: target.id, observedAt: new Date().toISOString() }),
    ingress: async target => ({ ...f.evidence.ingresses[0], id: target.id, observedAt: new Date().toISOString() }),
  };
}
describe("bounded live adapter orchestration", () => {
  it("brackets all receipts with inventory and returns the oldest sample", async () => {
    const f = fixture(); const c = collectors(f); const inventory = vi.fn(c.inventory); c.inventory = inventory;
    expect(await observeInstallCoverage(f.inventory, f.binding, c)).toMatchObject({ coverage: "complete", activity: "idle" });
    expect(inventory).toHaveBeenCalledTimes(2);
  });
  it("rejects a partial inventory before invoking backend or ingress collectors", async () => {
    const f = fixture(); const c = collectors(f); c.inventory = async () => ({ ...f.evidence.inventoryBefore, unclassifiedIngressCount: 1 });
    const backend = vi.fn(c.backend); c.backend = backend;
    expect((await observeInstallCoverage(f.inventory, f.binding, c)).coverage).toBe("unknown");
    expect(backend).not.toHaveBeenCalled();
  });
  it("retains a busy receipt when a later adapter reuses and mutates its object", async () => {
    const f = fixture(); const c = collectors(f);
    f.evidence.backends[0].active = 1;
    c.backend = async () => { f.evidence.backends[0].observedAt = new Date().toISOString(); return f.evidence.backends[0]; };
    const ingress = c.ingress;
    c.ingress = async (target, signal) => { f.evidence.backends[0].active = 0; return ingress(target, signal); };
    expect(await observeInstallCoverage(f.inventory, f.binding, c)).toMatchObject({ coverage: "complete", activity: "busy" });
  });
  it("bounds stalled reads and never starts late follow-up work", async () => {
    const f = fixture(); const c = collectors(f);
    let release!: (value: unknown) => void; let signal!: AbortSignal;
    c.inventory = received => { signal = received; return new Promise(resolve => { release = resolve; }); };
    const backend = vi.fn(c.backend); c.backend = backend;
    expect((await observeInstallCoverage(f.inventory, f.binding, c, { timeoutMs: 5 })).reasons).toEqual([{ code: "timeout" }]);
    expect(signal.aborted).toBe(true); release(f.evidence.inventoryBefore);
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(backend).not.toHaveBeenCalled();
  });
  it("cancels at binding expiry even while the inventory reader is stalled", async () => {
    const f = fixture(); f.binding.expiresAt = new Date(Date.now() + 15).toISOString();
    const c = collectors(f); c.inventory = () => new Promise(() => {});
    expect((await observeInstallCoverage(f.inventory, f.binding, c, { timeoutMs: 80 })).reasons).toEqual([{ code: "binding-expired" }]);
  });
  it("honors an already cancelled caller without calling any adapter", async () => {
    const f = fixture(); const c = collectors(f); const inventory = vi.fn(c.inventory); c.inventory = inventory;
    const abort = new AbortController(); abort.abort();
    expect((await observeInstallCoverage(f.inventory, f.binding, c, { signal: abort.signal })).reasons).toEqual([{ code: "cancelled" }]);
    expect(inventory).not.toHaveBeenCalled();
  });
});
