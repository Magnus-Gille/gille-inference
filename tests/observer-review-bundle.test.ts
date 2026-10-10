import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, symlink, link, mkdir, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, afterEach } from "vitest";
import {
  checkObserverReviewBundle,
  observerReviewPacketDigest,
  observerReviewPacketSchema,
} from "../src/homeserver/observer-review-bundle.js";

const ROLES = [
  "observer", "unit", "apparmor", "busPolicy", "polkitPolicy", "hostManifest",
  "buildProvenance", "linuxQualification", "operations", "rollback",
] as const;
const CREATED_AT = "2026-10-10T00:00:00.000Z";
const EXPIRES_AT = "2026-10-10T00:01:00.000Z";
const NOW = Date.parse("2026-10-10T00:00:30.000Z");
const DIGEST = "a".repeat(64);
const RELEASE_SHA = "b".repeat(40);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function makePacket() {
  const artifacts = Object.fromEntries(ROLES.map((role) => {
    const content = `synthetic-${role}-artifact`;
    return [role, {
      file: `${role}.txt`,
      sha256: sha256(content),
      bytes: Buffer.byteLength(content),
    }];
  }));
  return {
    schemaVersion: 1,
    gate: "G1",
    goal: "qualify-read-only-observer",
    host: "synthetic-host",
    hostBootIdSha256: DIGEST,
    releaseSha: RELEASE_SHA,
    createdAt: CREATED_AT,
    expiresAt: EXPIRES_AT,
    artifacts,
    target: {
      unitPrefix: "gille-observer-eval-synthetic-",
      unit: "gille-observer-eval-synthetic-1.service",
      profile: "gille-observer-eval-synthetic",
      observerPath: "/var/lib/gille-observer-eval/observer",
      unitPath: "/etc/systemd/system/gille-observer-eval-synthetic-1.service",
      apparmorPath: "/etc/apparmor.d/gille-observer-eval-synthetic",
      busPolicyPath: "/etc/dbus-1/system.d/gille-observer-eval.xml",
      polkitPolicyPath: "/etc/polkit-1/rules.d/60-gille-observer-eval.rules",
      outputDirectory: "/var/lib/gille-observer-eval/output",
      existingIdentity: { name: "gilleobserver", uid: 1234, gid: 1234 },
      pathsMustBeAbsent: true,
      provisionIdentity: false,
    },
    privileges: {
      capabilities: ["CAP_SYS_PTRACE", "CAP_DAC_READ_SEARCH"],
      apparmor: "enforce",
      systemBus: "method-filtered-read-only",
      polkit: "explicit-deny",
      hostPidAndNetworkVisibility: true,
      ipNetwork: false,
      subprocess: false,
      ptrace: false,
      processMemory: false,
      secretReads: false,
    },
    limits: {
      memoryMaxBytes: 64 * 1024 * 1024,
      memorySwapMaxBytes: 0,
      cpuQuotaPercent: 10,
      tasksMax: 8,
      windowMs: 60 * 1000,
      maxRuns: 1,
      outputMaxBytes: 1024 * 1024,
      stopTimeoutMs: 1000,
      cleanupTimeoutMs: 5000,
      restorationTimeoutMs: 5000,
    },
    priorState: {
      gatewayReleaseSha: RELEASE_SHA,
      maintenanceActive: false,
      residentModelIds: ["synthetic-model"],
      services: [{
        unit: "home-gateway.service",
        invocationIdSha256: DIGEST,
        executableSha256: DIGEST,
        configSha256: DIGEST,
        active: true,
        oomKills: 0,
      }],
    },
    safeguards: {
      allowedMutation: "create-and-remove-only-named-observer-artifacts",
      maintenance: "exclude-through-restoration",
      cleanup: "owned-paths-only-after-proven-stop",
      restoration: "protected-state-and-oom-unchanged",
      productionChanges: false,
      inferenceRequests: false,
      inferenceRestarts: false,
      credentialChanges: false,
      automaticRetryAfterMutation: false,
      reconfirmOn: [
        "scope-change", "weaker-safeguards", "expired", "production-or-credential-access",
        "oom", "protected-state-change", "stop-failure", "restoration-failure",
      ],
    },
  };
}

type Packet = ReturnType<typeof makePacket>;

async function createBundle(packet: Packet = makePacket(), writeArtifacts = true): Promise<{
  root: string;
  packet: Packet;
  digest: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "observer-review-bundle-"));
  roots.push(root);
  if (writeArtifacts) {
    for (const role of ROLES) {
      const artifact = packet.artifacts[role];
      const content = `synthetic-${role}-artifact`;
      await writeFile(join(root, artifact.file), content, "utf8");
    }
  }
  await writeFile(join(root, "packet.json"), JSON.stringify(packet), "utf8");
  return { root, packet, digest: observerReviewPacketDigest(packet) };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

describe("observer review packet schema", () => {
  it("rejects case-folded artifact collisions including the packet filename", () => {
    const packet = makePacket();
    packet.artifacts.unit.file = packet.artifacts.observer.file.toUpperCase();
    expect(observerReviewPacketSchema.safeParse(packet).success).toBe(false);
    const reserved = makePacket();
    reserved.artifacts.unit.file = "PACKET.JSON";
    expect(observerReviewPacketSchema.safeParse(reserved).success).toBe(false);
  });
  it("allows smaller capability sets but rejects duplicate or excessive privileges", () => {
    for (const capabilities of [[], ["CAP_DAC_READ_SEARCH"]]) {
      const packet = makePacket();
      packet.privileges.capabilities = capabilities;
      expect(observerReviewPacketSchema.safeParse(packet).success).toBe(true);
    }
    for (const capabilities of [["CAP_SYS_PTRACE", "CAP_SYS_PTRACE"], ["CAP_SYS_ADMIN"]]) {
      const packet = makePacket();
      packet.privileges.capabilities = capabilities;
      expect(observerReviewPacketSchema.safeParse(packet).success).toBe(false);
    }
  });
  it.each([
    ["root unknown key", (packet: Packet) => ({ ...packet, unknown: "raw-secret" })],
    ["nested unknown key", (packet: Packet) => ({ ...packet, target: { ...packet.target, unknown: "raw-secret" } })],
    ["missing required artifact", (packet: Packet) => {
      const next = clone(packet);
      delete next.artifacts.observer;
      return next;
    }],
    ["weakened provision safeguard", (packet: Packet) => ({ ...packet, target: { ...packet.target, provisionIdentity: true } })],
    ["weakened network safeguard", (packet: Packet) => ({ ...packet, privileges: { ...packet.privileges, ipNetwork: true } })],
    ["tasks ceiling", (packet: Packet) => ({ ...packet, limits: { ...packet.limits, tasksMax: 33 } })],
    ["memory ceiling", (packet: Packet) => ({ ...packet, limits: { ...packet.limits, memoryMaxBytes: 128 * 1024 * 1024 + 1 } })],
    ["artifact ceiling", (packet: Packet) => {
      const next = clone(packet);
      next.artifacts.observer.bytes = 64 * 1024 * 1024 + 1;
      return next;
    }],
  ])("rejects %s", (_, mutate) => {
    expect(() => observerReviewPacketSchema.parse(mutate(makePacket()))).toThrow();
  });

  it.each([
    ["duplicate artifact file", (packet: Packet) => {
      const next = clone(packet);
      next.artifacts.unit.file = next.artifacts.observer.file;
      return next;
    }],
    ["unit prefix mismatch", (packet: Packet) => ({ ...packet, target: { ...packet.target, unit: "other-eval.service" } })],
    ["unit path conflict", (packet: Packet) => ({ ...packet, target: { ...packet.target, unitPath: "/etc/systemd/system/other.service" } })],
    ["apparmor path conflict", (packet: Packet) => ({ ...packet, target: { ...packet.target, apparmorPath: "/etc/apparmor.d/other-profile" } })],
    ["nested path conflict", (packet: Packet) => ({ ...packet, target: { ...packet.target, outputDirectory: `${packet.target.observerPath}/nested` } })],
    ["duplicate target path", (packet: Packet) => ({ ...packet, target: { ...packet.target, outputDirectory: packet.target.observerPath } })],
    ["protected prior unit", (packet: Packet) => {
      const next = clone(packet);
      next.priorState.services[0].unit = next.target.unit;
      return next;
    }],
  ])("rejects %s", (_, mutate) => {
    expect(() => observerReviewPacketSchema.parse(mutate(makePacket()))).toThrow(/inconsistent|Unrecognized|Invalid/);
  });

  it.each([
    ["zero-length window", (packet: Packet) => ({ ...packet, expiresAt: packet.createdAt })],
    ["window beyond limit", (packet: Packet) => ({ ...packet, expiresAt: "2026-10-10T00:02:01.000Z" })],
    ["reordered stopping conditions", (packet: Packet) => {
      const next = clone(packet);
      next.safeguards.reconfirmOn.reverse();
      return next;
    }],
  ])("rejects %s", (_, mutate) => {
    expect(() => observerReviewPacketSchema.parse(mutate(makePacket()))).toThrow();
  });
});

describe("observer review packet digest", () => {
  it("is stable across object key order and changes when a value changes", () => {
    const packet = makePacket();
    const reordered = {
      ...packet,
      artifacts: Object.fromEntries(Object.entries(packet.artifacts).reverse()),
      privileges: Object.fromEntries(Object.entries(packet.privileges).reverse()),
      limits: Object.fromEntries(Object.entries(packet.limits).reverse()),
      target: {
        ...packet.target,
        existingIdentity: { gid: packet.target.existingIdentity.gid, uid: packet.target.existingIdentity.uid, name: packet.target.existingIdentity.name },
      },
    };
    expect(observerReviewPacketDigest(reordered)).toBe(observerReviewPacketDigest(packet));
    expect(observerReviewPacketDigest({ ...packet, host: "synthetic-host-changed" }))
      .not.toBe(observerReviewPacketDigest(packet));
  });
});

describe("offline observer review bundle checks", () => {
  it.each(["productionChanges", String.raw`production\u0043hanges`])("rejects duplicate JSON safety keys (%s) before hashing", async (duplicateKey) => {
    const bundle = await createBundle();
    const ambiguous = JSON.stringify(bundle.packet).replace('"productionChanges":false',
      `"productionChanges":true,"${duplicateKey}":false`);
    await writeFile(join(bundle.root, "packet.json"), ambiguous);
    expect(await checkObserverReviewBundle(bundle.root, bundle.digest, NOW)).toMatchObject({
      valid: false, packetSha256: null, reasons: ["invalid-packet"],
    });
  });
  it("accepts a valid synthetic bundle while never authorizing mutation", async () => {
    const bundle = await createBundle();
    await expect(checkObserverReviewBundle(bundle.root, bundle.digest, NOW)).resolves.toEqual({
      source: "observer-review-bundle-v1",
      valid: true,
      authorizesMutation: false,
      packetSha256: bundle.digest,
      reasons: [],
    });
  });

  it.each([
    ["tampered", async (root: string, packet: Packet) => {
      await writeFile(join(root, packet.artifacts.observer.file), "tampered-observer", "utf8");
    }, "artifact-mismatch"],
    ["truncated", async (root: string, packet: Packet) => {
      await writeFile(join(root, packet.artifacts.observer.file), "short", "utf8");
    }, "artifact-mismatch"],
    ["missing", async (root: string, packet: Packet) => {
      await unlink(join(root, packet.artifacts.observer.file));
    }, "bundle-read-failed"],
    ["oversized", async (root: string, packet: Packet) => {
      await writeFile(join(root, packet.artifacts.observer.file), "x".repeat(packet.artifacts.observer.bytes + 1), "utf8");
    }, "bundle-read-failed"],
  ])("rejects a %s artifact", async (_, mutate, reason) => {
    const bundle = await createBundle();
    await mutate(bundle.root, bundle.packet);
    const report = await checkObserverReviewBundle(bundle.root, bundle.digest, NOW);
    expect(report.valid).toBe(false);
    expect(report.authorizesMutation).toBe(false);
    expect(report.reasons).toContain(reason);
  });

  it("does not read artifacts when the independently supplied packet digest mismatches", async () => {
    const bundle = await createBundle(makePacket(), false);
    const report = await checkObserverReviewBundle(bundle.root, "c".repeat(64), NOW);
    expect(report).toMatchObject({ valid: false, authorizesMutation: false, packetSha256: bundle.digest });
    expect(report.reasons).toEqual(["packet-digest-mismatch"]);
  });

  it("enforces the start-inclusive and expiry-exclusive window", async () => {
    const bundle = await createBundle();
    await expect(checkObserverReviewBundle(bundle.root, bundle.digest, Date.parse(CREATED_AT)))
      .resolves.toMatchObject({ valid: true, reasons: [] });
    await expect(checkObserverReviewBundle(bundle.root, bundle.digest, Date.parse(EXPIRES_AT)))
      .resolves.toMatchObject({ valid: false, reasons: ["packet-outside-window"] });
    await expect(checkObserverReviewBundle(bundle.root, bundle.digest, Date.parse(CREATED_AT) - 1))
      .resolves.toMatchObject({ valid: false, reasons: ["packet-outside-window"] });
  });

  it("sanitizes unknown input and malformed packet content to bounded reason codes", async () => {
    const root = await mkdtemp(join(tmpdir(), "observer-review-bundle-"));
    roots.push(root);
    const rawPath = "/private/host/secret/raw-prompt.txt";
    const rawContent = "RAW_CONTENT_MUST_NOT_LEAK";
    await writeFile(join(root, "packet.json"), JSON.stringify({ unknown: rawContent, path: rawPath }), "utf8");
    const report = await checkObserverReviewBundle(root, "invalid-expected-digest", NOW);
    expect(report).toEqual({
      source: "observer-review-bundle-v1",
      valid: false,
      authorizesMutation: false,
      packetSha256: null,
      reasons: ["invalid-check-input"],
    });
    expect(JSON.stringify(report)).not.toContain(rawPath);
    expect(JSON.stringify(report)).not.toContain(rawContent);

    const malformed = await createBundle();
    await writeFile(join(malformed.root, "packet.json"), JSON.stringify({ ...makePacket(), unknown: rawContent, path: rawPath }), "utf8");
    const malformedReport = await checkObserverReviewBundle(malformed.root, malformed.digest, NOW);
    expect(malformedReport.reasons).toEqual(["invalid-packet"]);
    expect(JSON.stringify(malformedReport)).not.toContain(rawPath);
    expect(JSON.stringify(malformedReport)).not.toContain(rawContent);
  });

  it("rejects an oversized packet before parsing it", async () => {
    const bundle = await createBundle(makePacket(), false);
    await writeFile(join(bundle.root, "packet.json"), `${JSON.stringify(bundle.packet)}${"x".repeat(1024 * 1024)}`, "utf8");
    const report = await checkObserverReviewBundle(bundle.root, bundle.digest, NOW);
    expect(report).toMatchObject({ valid: false, authorizesMutation: false, packetSha256: null, reasons: ["bundle-read-failed"] });
  });

  it("rejects symlink roots and symlink artifacts", async () => {
    const bundle = await createBundle();
    const rootLink = `${bundle.root}-link`;
    await symlink(bundle.root, rootLink);
    roots.push(rootLink);
    expect((await checkObserverReviewBundle(rootLink, bundle.digest, NOW)).reasons).toEqual(["bundle-read-failed"]);

    const artifactPath = join(bundle.root, bundle.packet.artifacts.observer.file);
    const backingPath = join(bundle.root, "backing-observer.txt");
    await writeFile(backingPath, "synthetic-observer-artifact", "utf8");
    await unlink(artifactPath);
    await symlink(backingPath, artifactPath);
    expect((await checkObserverReviewBundle(bundle.root, bundle.digest, NOW)).reasons).toEqual(["bundle-read-failed"]);
  });

  it("rejects hardlinks, directories, and FIFOs as artifacts without blocking", async () => {
    const hardlinkBundle = await createBundle();
    const hardlinkPath = join(hardlinkBundle.root, hardlinkBundle.packet.artifacts.observer.file);
    const secondLink = join(hardlinkBundle.root, "second-observer-link.txt");
    await link(hardlinkPath, secondLink);
    expect((await checkObserverReviewBundle(hardlinkBundle.root, hardlinkBundle.digest, NOW)).reasons).toEqual(["bundle-read-failed"]);

    const directoryBundle = await createBundle();
    const directoryPath = join(directoryBundle.root, directoryBundle.packet.artifacts.observer.file);
    await unlink(directoryPath);
    await mkdir(directoryPath);
    expect((await checkObserverReviewBundle(directoryBundle.root, directoryBundle.digest, NOW)).reasons).toEqual(["bundle-read-failed"]);

    const fifoBundle = await createBundle();
    const fifoPath = join(fifoBundle.root, fifoBundle.packet.artifacts.observer.file);
    await unlink(fifoPath);
    execFileSync("mkfifo", [fifoPath]);
    expect((await checkObserverReviewBundle(fifoBundle.root, fifoBundle.digest, NOW)).reasons).toEqual(["bundle-read-failed"]);
  });
});
