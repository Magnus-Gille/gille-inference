import { describe, expect, it } from "vitest";
import {
  hashInstallBackendInventory,
  installBackendInventorySchema,
  type InstallBackendInventory,
} from "../src/homeserver/install-backend-inventory.js";

const VALID: InstallBackendInventory = {
  schemaVersion: 1,
  hostBootIdSha256: "a".repeat(64),
  backends: [
    { id: "runtime_a", kind: "runtime", ingressIds: ["direct_a", "lifecycle_a"] },
    { id: "sidecar_a", kind: "sidecar", ingressIds: ["direct_a", "lifecycle_a"] },
  ],
  ingresses: [
    { id: "direct_a", kind: "direct", backendIds: ["runtime_a", "sidecar_a"] },
    { id: "lifecycle_a", kind: "lifecycle", backendIds: ["runtime_a", "sidecar_a"] },
  ],
};

function validWith(change: (copy: InstallBackendInventory) => void): InstallBackendInventory {
  const copy = structuredClone(VALID);
  change(copy);
  return copy;
}

describe("install backend inventory contract", () => {
  it("accepts the bounded strict inventory shape", () => {
    expect(installBackendInventorySchema.safeParse(VALID).success).toBe(true);
    expect(installBackendInventorySchema.safeParse({ ...VALID, extra: true }).success).toBe(false);
  });

  it("enforces identifier, digest, and collection bounds", () => {
    expect(installBackendInventorySchema.safeParse(validWith((copy) => {
      copy.backends[0].id = "contains space";
    })).success).toBe(false);
    expect(installBackendInventorySchema.safeParse(validWith((copy) => {
      copy.hostBootIdSha256 = "A".repeat(64);
    })).success).toBe(false);
    expect(installBackendInventorySchema.safeParse(validWith((copy) => {
      copy.backends[0].ingressIds = [];
    })).success).toBe(false);
    expect(installBackendInventorySchema.safeParse(validWith((copy) => {
      copy.backends = Array.from({ length: 65 }, (_, index) => ({
        id: `runtime_${index}`,
        kind: "runtime" as const,
        ingressIds: ["direct_a", "lifecycle_a"],
      }));
    })).success).toBe(false);
    expect(installBackendInventorySchema.safeParse(validWith((copy) => {
      copy.ingresses = Array.from({ length: 129 }, (_, index) => ({
        id: `direct_${index}`,
        kind: "direct" as const,
        backendIds: ["runtime_a"],
      }));
    })).success).toBe(false);
    expect(installBackendInventorySchema.safeParse(validWith((copy) => {
      copy.backends[0].ingressIds = Array.from({ length: 129 }, (_, index) => `ingress_${index}`);
    })).success).toBe(false);
    expect(installBackendInventorySchema.safeParse(validWith((copy) => {
      copy.ingresses[0].backendIds = Array.from({ length: 65 }, (_, index) => `backend_${index}`);
    })).success).toBe(false);
  });

  it("rejects duplicate global IDs and duplicate links", () => {
    expect(installBackendInventorySchema.safeParse(validWith((copy) => {
      copy.backends[1].id = copy.backends[0].id;
    })).success).toBe(false);
    expect(installBackendInventorySchema.safeParse(validWith((copy) => {
      copy.backends[0].ingressIds.push("direct_a");
    })).success).toBe(false);
    expect(installBackendInventorySchema.safeParse(validWith((copy) => {
      copy.ingresses[0].backendIds.push("runtime_a");
    })).success).toBe(false);
    expect(installBackendInventorySchema.safeParse(validWith((copy) => {
      copy.ingresses[0].id = "runtime_a";
    })).success).toBe(false);
  });

  it("rejects missing or asymmetric references", () => {
    expect(installBackendInventorySchema.safeParse(validWith((copy) => {
      copy.backends[0].ingressIds[0] = "unknown";
    })).success).toBe(false);
    expect(installBackendInventorySchema.safeParse(validWith((copy) => {
      copy.ingresses[0].backendIds = ["runtime_a"];
    })).success).toBe(false);
    expect(installBackendInventorySchema.safeParse(validWith((copy) => {
      copy.ingresses[0].backendIds[0] = "unknown";
    })).success).toBe(false);
  });

  it("requires every backend to have direct and lifecycle ingress coverage", () => {
    expect(installBackendInventorySchema.safeParse(validWith((copy) => {
      copy.backends[0].ingressIds = ["direct_a"];
    })).success).toBe(false);
    expect(installBackendInventorySchema.safeParse(validWith((copy) => {
      copy.backends[0].ingressIds = ["lifecycle_a"];
    })).success).toBe(false);
  });

  it("produces an order-invariant hash without mutating the caller", () => {
    const shuffled = structuredClone(VALID);
    shuffled.backends.reverse();
    shuffled.backends[0].ingressIds.reverse();
    shuffled.ingresses.reverse();
    shuffled.ingresses[0].backendIds.reverse();
    const before = structuredClone(shuffled);
    expect(hashInstallBackendInventory(shuffled)).toBe(hashInstallBackendInventory(VALID));
    expect(shuffled).toEqual(before);
  });

  it("changes the hash for topology, host, and kind changes", () => {
    const base = hashInstallBackendInventory(VALID);
    expect(hashInstallBackendInventory(validWith((copy) => {
      copy.backends[0].ingressIds = ["direct_a", "lifecycle_a"];
      copy.backends.push({ id: "runtime_b", kind: "runtime", ingressIds: ["direct_a", "lifecycle_a"] });
      copy.ingresses[0].backendIds.push("runtime_b");
      copy.ingresses[1].backendIds.push("runtime_b");
    }))).not.toBe(base);
    expect(hashInstallBackendInventory(validWith((copy) => {
      copy.hostBootIdSha256 = "b".repeat(64);
    }))).not.toBe(base);
    expect(hashInstallBackendInventory(validWith((copy) => {
      copy.backends[0].kind = "sidecar";
    }))).not.toBe(base);
  });
});
