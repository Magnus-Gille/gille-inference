import { describe, expect, it } from "vitest";
import * as contract from "../src/homeserver/accepted-host-manifest.js";

const digest = (character: string): string => character.repeat(64);

function validManifest() {
  return {
    schemaVersion: 1,
    source: "accepted-host-manifest-v1",
    hostId: "m5-owner",
    hostBootIdSha256: digest("a"),
    namespaces: {
      pidSha256: digest("b"),
      networkSha256: digest("c"),
      userSha256: digest("d"),
      mountSha256: digest("e"),
    },
    processes: [
      {
        id: "p-producer",
        unit: "inference.service",
        uid: 1000,
        cgroup: "/sys/fs/cgroup/inference",
        executable: { path: "/usr/bin/producer", sha256: digest("f") },
        configSha256: digest("0"),
        unitFileSha256: digest("1"),
        containmentSha256: digest("2"),
        reviewSha256: digest("3"),
        control: "root-owned-nonwritable",
        role: { kind: "producer", producerId: "producer-1" },
      },
      {
        id: "p-observer",
        unit: "observer.service",
        uid: 1001,
        cgroup: "/sys/fs/cgroup/observer",
        executable: { path: "/usr/bin/observer", sha256: digest("4") },
        configSha256: digest("5"),
        unitFileSha256: digest("6"),
        containmentSha256: digest("7"),
        reviewSha256: digest("8"),
        control: "root-owned-nonwritable",
        role: { kind: "owned", purpose: "observer", runIdSha256: digest("9") },
      },
      {
        id: "p-excluded",
        unit: "other.service",
        uid: 1002,
        cgroup: "/sys/fs/cgroup/other",
        executable: { path: "/usr/bin/other", sha256: digest("a") },
        configSha256: digest("b"),
        unitFileSha256: digest("c"),
        containmentSha256: digest("d"),
        reviewSha256: digest("e"),
        control: "root-owned-nonwritable",
        role: { kind: "excluded", reason: "reviewed-non-inference" },
      },
    ],
    listeners: [
      {
        id: "listener-api",
        processId: "p-producer",
        transport: "tcp",
        address: "0:0:0:0:0:0:0:1",
        port: 8080,
      },
    ],
    activations: [
      {
        id: "activation-inference",
        unit: "inference.service",
        unitFileSha256: digest("1"),
        kind: "manual-unit",
        targetProcessIds: ["p-observer", "p-producer", "p-excluded"],
      },
    ],
  };
}

describe("accepted host manifest contract", () => {
  it("accepts a bounded declarative manifest and canonicalizes IPv6", () => {
    const parsed = contract.acceptedHostManifestSchema.parse(validManifest());
    expect(parsed.listeners[0]?.address).toBe("::1");
    expect(parsed.processes).toHaveLength(3);
    expect(parsed.processes.some((process) => process.role.kind === "producer")).toBe(true);
  });

  it("is strict at every nested object and exports only declaration APIs", () => {
    const withUnknown = structuredClone(validManifest()) as Record<string, unknown>;
    (withUnknown.processes as Array<Record<string, unknown>>)[0]!.unexpected = true;
    expect(() => contract.acceptedHostManifestSchema.parse(withUnknown)).toThrow();
    expect(Object.keys(contract).sort()).toEqual([
      "acceptedHostManifestSchema",
      "hashAcceptedHostManifest",
    ]);
  });

  it("rejects malformed paths, service units, digests, and UID boundaries", () => {
    for (const path of ["/", "//x", "/x/", "/x/../y", "/x*", "/x\\y"]) {
      const candidate = structuredClone(validManifest());
      candidate.processes[0]!.cgroup = path;
      expect(() => contract.acceptedHostManifestSchema.parse(candidate)).toThrow();
    }
    for (const unit of ["@.service", "inference@.service", "inference@@worker.service", "inference.socket"]) {
      const candidate = structuredClone(validManifest());
      candidate.processes[0]!.unit = unit;
      expect(() => contract.acceptedHostManifestSchema.parse(candidate)).toThrow();
    }
    const badDigest = structuredClone(validManifest());
    badDigest.hostBootIdSha256 = digest("A");
    expect(() => contract.acceptedHostManifestSchema.parse(badDigest)).toThrow();
    for (const uid of [-1, 4_294_967_295]) {
      const candidate = structuredClone(validManifest());
      candidate.processes[0]!.uid = uid;
      expect(() => contract.acceptedHostManifestSchema.parse(candidate)).toThrow();
    }
  });

  it("rejects invalid roles and all duplicate or dangling identities", () => {
    const invalidRole = structuredClone(validManifest());
    invalidRole.processes[0]!.role = { kind: "producer", producerId: "bad id" };
    expect(() => contract.acceptedHostManifestSchema.parse(invalidRole)).toThrow();

    const duplicateProcessId = structuredClone(validManifest());
    duplicateProcessId.processes[1]!.id = duplicateProcessId.processes[0]!.id;
    expect(() => contract.acceptedHostManifestSchema.parse(duplicateProcessId)).toThrow();

    const duplicateTuple = structuredClone(validManifest());
    duplicateTuple.processes[1]!.unit = duplicateTuple.processes[0]!.unit;
    duplicateTuple.processes[1]!.uid = duplicateTuple.processes[0]!.uid;
    duplicateTuple.processes[1]!.cgroup = duplicateTuple.processes[0]!.cgroup;
    duplicateTuple.processes[1]!.executable.path = duplicateTuple.processes[0]!.executable.path;
    expect(() => contract.acceptedHostManifestSchema.parse(duplicateTuple)).toThrow();

    const danglingListener = structuredClone(validManifest());
    danglingListener.listeners[0]!.processId = "missing-process";
    expect(() => contract.acceptedHostManifestSchema.parse(danglingListener)).toThrow();

    const missingActivation = structuredClone(validManifest());
    missingActivation.activations[0]!.targetProcessIds = ["p-producer"];
    expect(() => contract.acceptedHostManifestSchema.parse(missingActivation)).toThrow();
  });

  it("allows identity-checked producer evidence but requires root control for exclusions and owned roles", () => {
    const producerIdentity = structuredClone(validManifest());
    producerIdentity.processes[0]!.control = "identity-checked";
    expect(() => contract.acceptedHostManifestSchema.parse(producerIdentity)).not.toThrow();

    const excludedIdentity = structuredClone(validManifest());
    excludedIdentity.processes[2]!.control = "identity-checked";
    expect(() => contract.acceptedHostManifestSchema.parse(excludedIdentity)).toThrow();

    const ownedIdentity = structuredClone(validManifest());
    ownedIdentity.processes[1]!.control = "identity-checked";
    expect(() => contract.acceptedHostManifestSchema.parse(ownedIdentity)).toThrow();
  });

  it("rejects conflicting raw unit-file identities across declarations", () => {
    const candidate = validManifest();
    candidate.activations[0].unitFileSha256 = digest("a");
    expect(contract.acceptedHostManifestSchema.safeParse(candidate).success).toBe(false);
  });

  it("bounds total activation target references across rows", () => {
    const candidate = structuredClone(validManifest());
    candidate.processes = Array.from({ length: 4_096 }, (_, index) => ({
      id: `p-${index}`,
      unit: "bulk.service",
      uid: index,
      cgroup: `/sys/fs/cgroup/p-${index}`,
      executable: { path: `/usr/bin/p-${index}`, sha256: digest("a") },
      configSha256: digest("b"),
      unitFileSha256: digest("c"),
      containmentSha256: digest("d"),
      reviewSha256: digest("e"),
      control: "root-owned-nonwritable" as const,
      role: index === 0
        ? { kind: "producer" as const, producerId: "producer-bulk" }
        : { kind: "excluded" as const, reason: "reviewed-non-inference" as const },
    }));
    candidate.listeners = [];
    const allProcessIds = candidate.processes.map((process) => process.id);
    candidate.activations = Array.from({ length: 5 }, (_, index) => ({
      id: `activation-${index}`,
      unit: `bulk-${index}.service`,
      unitFileSha256: digest("f"),
      kind: "preload" as const,
      targetProcessIds: index < 4 ? [...allProcessIds] : ["p-0"],
    }));
    expect(() => contract.acceptedHostManifestSchema.parse(candidate)).toThrow();
  });

  it("rejects equivalent duplicate IPv6 endpoints after canonicalization", () => {
    const candidate = structuredClone(validManifest());
    candidate.listeners.push({
      id: "listener-duplicate",
      processId: "p-observer",
      transport: "tcp",
      address: "::1",
      port: 8080,
    });
    expect(() => contract.acceptedHostManifestSchema.parse(candidate)).toThrow();
  });

  it("hashes canonically across collection ordering without mutating the input", () => {
    const first = validManifest();
    const before = structuredClone(first);
    const second = structuredClone(first);
    second.processes.reverse();
    second.listeners.reverse();
    second.activations.reverse();
    second.activations[0]!.targetProcessIds.reverse();
    expect(contract.hashAcceptedHostManifest(first)).toMatch(/^[a-f0-9]{64}$/);
    expect(contract.hashAcceptedHostManifest(first)).toBe(contract.hashAcceptedHostManifest(second));
    expect(first).toEqual(before);

    const changed = structuredClone(first);
    changed.hostId = "another-host";
    expect(contract.hashAcceptedHostManifest(changed)).not.toBe(contract.hashAcceptedHostManifest(first));
  });
});
