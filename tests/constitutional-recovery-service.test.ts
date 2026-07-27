import { createHash } from "node:crypto";
import { request } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  authenticateRecoveryJournal,
  RecoveryRegistry,
  startRecoveryService,
  type RecoveryRegistrationRequest,
} from "../src/homeserver/constitutional-recovery-service.js";
import { digestJson } from "../src/homeserver/autonomy-contract-v1.js";

const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const baseline = '{"route":"mellum"}\n';
const candidate = '{"route":"qwen"}\n';
const fence = { fenceEpoch: 2, fenceToken: "22222222-2222-4222-8222-222222222222" };
const contractRoot = new URL("../contracts/grimnir-autonomy-v1/", import.meta.url).pathname;
const artifact = (name: string): any => JSON.parse(readFileSync(join(contractRoot, name), "utf8"));
const fixture = (name: string): any => JSON.parse(readFileSync(join(contractRoot, "fixtures", name), "utf8"));
const pem = (name: string): string => readFileSync(join(contractRoot, "fixtures", name), "utf8");
const registration = (): RecoveryRegistrationRequest => ({
  journalId: "micro-route-journal",
  bindingDigest: `sha256:${"1".repeat(64)}`,
  targetScopeDigest: `sha256:${"2".repeat(64)}`,
  baselineDigest: digest(baseline),
  candidateDigest: digest(candidate),
  descriptorDigest: `sha256:${"3".repeat(64)}`,
});

function journalAuthority(phase: "prepare" | "unknown" | "revert" = "prepare") {
  let currentPhase = phase;
  return {
    authority: {
      read: () => ({
        journalId: "micro-route-journal",
        bindingDigest: `sha256:${"1".repeat(64)}`,
        targetScopeDigest: `sha256:${"2".repeat(64)}`,
        baselineDigest: digest(baseline),
        candidateDigest: digest(candidate),
        descriptorDigest: `sha256:${"3".repeat(64)}`,
        ownerAuthorizationDigest: `sha256:${"5".repeat(64)}`,
        phase: currentPhase,
        receiptDigest: `sha256:${"4".repeat(64)}`,
      }),
    },
    setPhase: (next: "prepare" | "unknown" | "revert") => { currentPhase = next; },
  };
}

function route(initial: string) {
  let current = initial;
  let writes = 0;
  let currentFence = { epoch: fence.fenceEpoch, token: fence.fenceToken };
  return {
    read: () => current,
    writes: () => writes,
    set: (next: string) => { current = next; },
    acquireWriterLease: (options?: { durationMs?: number }) => {
      currentFence = {
        epoch: currentFence.epoch + 1,
        token: `${String(currentFence.epoch + 1).padStart(8, "0")}-0000-4000-8000-000000000000`,
      };
      const owned = { ...currentFence };
      const expiresAt = Date.now() + (options?.durationMs ?? 45_000);
      let released = false;
      return {
        ...owned,
        isCurrent: () => !released
          && Date.now() < expiresAt
          && currentFence.epoch === owned.epoch
          && currentFence.token === owned.token,
        release: () => { released = true; },
      };
    },
    restoreExact: (expectedCandidateDigest: string, next: string, suppliedFence: { epoch: number; token: string }) => {
      if (suppliedFence.epoch !== currentFence.epoch || suppliedFence.token !== currentFence.token) return false;
      if (digest(current) !== expectedCandidateDigest) return false;
      writes += 1;
      current = next;
      return true;
    },
  };
}

describe("recovery-owned preregistration", () => {
  it("authenticates prepare receipts against protected pins/checkpoints and rejects their substitution", () => {
    const snapshot = {
      authorization: fixture("test-owner-authorization.json"),
      constitution: artifact("constitution.json"),
      coverage: fixture("coverage-armed-canary.json"),
      attestations: artifact("owner-attestations.json"),
      recoveryRegistry: fixture("test-recovery-worker-registry.json"),
      pinnedOwnerPublicKeyPem: pem("test-owner-ed25519-public.pem"),
      checkpoint: fixture("test-owner-authorization-checkpoint.json"),
      runtimeNarrowing: fixture("test-runtime-narrowing.json"),
      runtimeNarrowingCheckpoint: fixture("test-runtime-narrowing-checkpoint.json"),
    };
    const journal = fixture("journal-happy-commit.json");
    journal.entries = [journal.entries[0]];
    journal.binding.recovery.descriptor_digest = digestJson(snapshot);
    journal.binding_digest = digestJson(journal.binding);
    journal.entries[0].binding_digest = journal.binding_digest;
    journal.entries[0].previous_receipt_digest = null;
    journal.entries[0].receipt_digest = digestJson(journal.entries[0], "receipt_digest");
    expect(authenticateRecoveryJournal({
      journalId: journal.journal_id,
      journal,
      protectedSnapshot: snapshot,
    })).toMatchObject({ phase: "prepare", receiptDigest: journal.entries[0].receipt_digest });
    expect(() => authenticateRecoveryJournal({
      journalId: journal.journal_id,
      journal,
      protectedSnapshot: {
        ...snapshot,
        pinnedOwnerPublicKeyPem: pem("test-attacker-ed25519-public.pem"),
      },
    })).toThrow(/pinned|fingerprint|signature/);
    const staleCheckpoint = structuredClone(snapshot);
    staleCheckpoint.checkpoint.minimum_sequence = 2;
    expect(() => authenticateRecoveryJournal({
      journalId: journal.journal_id,
      journal,
      protectedSnapshot: staleCheckpoint,
    })).toThrow(/sequence|checkpoint/);
  });

  it("restores only candidate to the exact preregistered baseline", () => {
    const root = mkdtempSync(join(tmpdir(), "constitutional-recovery-"));
    const registry = new RecoveryRegistry(root);
    const live = route(baseline);
    const journal = journalAuthority();
    const receipt = registry.register(registration(), live, journal.authority);
    journal.setPhase("unknown");
    live.set(candidate);
    expect(registry.actuate({
      handle: receipt.handle,
      journalId: "micro-route-journal",
      bindingDigest: `sha256:${"1".repeat(64)}`,
      targetScopeDigest: `sha256:${"2".repeat(64)}`,
      journalReceiptDigest: `sha256:${"4".repeat(64)}`,
      ...fence,
    }, live, journal.authority)).toMatchObject({ classification: "restored", registrationDigest: receipt.registrationDigest });
    expect(live.read()).toBe(baseline);
    expect(live.writes()).toBe(1);
  });

  it("classifies baseline as no-op and never writes", () => {
    const registry = new RecoveryRegistry(mkdtempSync(join(tmpdir(), "constitutional-recovery-")));
    const live = route(baseline);
    const journal = journalAuthority();
    const receipt = registry.register(registration(), live, journal.authority);
    journal.setPhase("unknown");
    expect(registry.actuate({
      handle: receipt.handle,
      journalId: "micro-route-journal",
      bindingDigest: `sha256:${"1".repeat(64)}`,
      targetScopeDigest: `sha256:${"2".repeat(64)}`,
      journalReceiptDigest: `sha256:${"4".repeat(64)}`,
      ...fence,
    }, live, journal.authority).classification).toBe("already-baseline");
    expect(live.writes()).toBe(0);
  });

  it("classifies a third revision as superseded without overwriting it", () => {
    const registry = new RecoveryRegistry(mkdtempSync(join(tmpdir(), "constitutional-recovery-")));
    const live = route(baseline);
    const journal = journalAuthority();
    const receipt = registry.register(registration(), live, journal.authority);
    journal.setPhase("unknown");
    const superseded = route('{"route":"owner-newer"}\n');
    expect(registry.actuate({
      handle: receipt.handle,
      journalId: "micro-route-journal",
      bindingDigest: `sha256:${"1".repeat(64)}`,
      targetScopeDigest: `sha256:${"2".repeat(64)}`,
      journalReceiptDigest: `sha256:${"4".repeat(64)}`,
      ...fence,
    }, superseded, journal.authority).classification).toBe("superseded");
    expect(superseded.read()).toBe('{"route":"owner-newer"}\n');
    expect(superseded.writes()).toBe(0);
  });

  it("rejects forged binding and arbitrary journal receipts", () => {
    const registry = new RecoveryRegistry(mkdtempSync(join(tmpdir(), "constitutional-recovery-")));
    const live = route(baseline);
    const journal = journalAuthority();
    expect(() => registry.register({
      ...registration(),
      bindingDigest: `sha256:${"9".repeat(64)}`,
    }, live, journal.authority)).toThrow(/invalid recovery preregistration/);
    const receipt = registry.register(registration(), live, journal.authority);
    journal.setPhase("unknown");
    live.set(candidate);
    expect(() => registry.actuate({
      handle: receipt.handle,
      journalId: "micro-route-journal",
      bindingDigest: `sha256:${"1".repeat(64)}`,
      targetScopeDigest: `sha256:${"2".repeat(64)}`,
      journalReceiptDigest: `sha256:${"8".repeat(64)}`,
      ...fence,
    }, live, journal.authority)).toThrow(/exact eligible unknown journal receipt/);
    expect(live.read()).toBe(candidate);
  });

  it("replays safely after a crash between exact restore and consumed-state commit", () => {
    const registry = new RecoveryRegistry(mkdtempSync(join(tmpdir(), "constitutional-recovery-")));
    const live = route(baseline);
    const journal = journalAuthority();
    const receipt = registry.register(registration(), live, journal.authority);
    journal.setPhase("unknown");
    live.set(candidate);
    const crashingRoute = {
      read: live.read,
      acquireWriterLease: live.acquireWriterLease,
      restoreExact: (expected: string, next: string, suppliedFence: { epoch: number; token: string }) => {
        live.restoreExact(expected, next, suppliedFence);
        throw new Error("simulated recovery crash after route restore");
      },
    };
    const request = {
      handle: receipt.handle,
      journalId: "micro-route-journal",
      bindingDigest: `sha256:${"1".repeat(64)}`,
      targetScopeDigest: `sha256:${"2".repeat(64)}`,
      journalReceiptDigest: `sha256:${"4".repeat(64)}`,
      ...fence,
    };
    expect(() => registry.actuate(request, crashingRoute, journal.authority)).toThrow(/simulated recovery crash/);
    expect(live.read()).toBe(baseline);
    expect(registry.actuate(request, live, journal.authority).classification).toBe("already-baseline");
  });
});

function post(socketPath: string, path: string, body: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, method: "POST", headers: { "content-type": "application/json" } }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      }));
    });
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

describe("permission-separated AF_UNIX recovery service", () => {
  it("exposes registration only on the controller socket and actuation only on the watchdog socket", async () => {
    const root = mkdtempSync("/private/tmp/constitutional-recovery-sockets-");
    const registrationSocketPath = join(root, "register.sock");
    const actionSocketPath = join(root, "action.sock");
    const live = route(baseline);
    const journal = journalAuthority();
    const service = await startRecoveryService({
      registrationSocketPath,
      actionSocketPath,
      registry: new RecoveryRegistry(join(root, "registrations")),
      route: live,
      journalAuthority: journal.authority,
      demote: () => ({ ledger: {}, registry: {}, checkpoint: {} }),
      routeLeaseOptions: { durationMs: 20 },
    });
    try {
      expect((await post(actionSocketPath, "/register", registration())).status).toBe(404);
      expect((await post(registrationSocketPath, "/register", {
        ...registration(),
        bindingDigest: `sha256:${"9".repeat(64)}`,
      })).status).toBe(400);
      const registered = await post(registrationSocketPath, "/register", registration());
      expect(registered.status).toBe(200);
      expect(registered.body).toMatchObject({ handle: expect.stringMatching(/^recovery-/) });
      journal.setPhase("unknown");
      live.set(candidate);
      expect((await post(registrationSocketPath, "/actuate", {})).status).toBe(404);
      const acquired = await post(actionSocketPath, "/fence/acquire", {});
      expect(acquired).toMatchObject({ status: 200, body: { epoch: expect.any(Number), token: expect.any(String) } });
      expect((await post(actionSocketPath, "/fence/acquire", {})).status).toBe(400);
      await new Promise((resolve) => setTimeout(resolve, 30));
      const superseding = await post(actionSocketPath, "/fence/acquire", {});
      expect(superseding.status).toBe(200);
      expect(superseding.body.epoch).toBeGreaterThan(acquired.body.epoch);
      expect((await post(actionSocketPath, "/fence/release", acquired.body)).status).toBe(400);
      const heldFence = { fenceEpoch: superseding.body.epoch, fenceToken: superseding.body.token };
      const actuated = await post(actionSocketPath, "/actuate", {
        handle: registered.body.handle,
        journalId: "micro-route-journal",
        bindingDigest: `sha256:${"1".repeat(64)}`,
        targetScopeDigest: `sha256:${"2".repeat(64)}`,
        journalReceiptDigest: `sha256:${"4".repeat(64)}`,
        ...heldFence,
      });
      expect(actuated.body.classification).toBe("restored");
      journal.setPhase("revert");
      expect((await post(actionSocketPath, "/demote", {
        journalId: "micro-route-journal",
        extra: "signer-oracle-probe",
        ownerAuthorizationDigest: `sha256:${"5".repeat(64)}`,
        domain: "micro-routing",
        targetScopeDigest: `sha256:${"2".repeat(64)}`,
        journalReceiptDigest: `sha256:${"8".repeat(64)}`,
        ...heldFence,
      })).status).toBe(400);
      expect((await post(actionSocketPath, "/demote", {
        journalId: "micro-route-journal",
        ownerAuthorizationDigest: `sha256:${"9".repeat(64)}`,
        domain: "micro-routing",
        targetScopeDigest: `sha256:${"2".repeat(64)}`,
        journalReceiptDigest: `sha256:${"4".repeat(64)}`,
        ...heldFence,
      })).status).toBe(400);
      expect((await post(actionSocketPath, "/demote", {
        journalId: "micro-route-journal",
        ownerAuthorizationDigest: `sha256:${"5".repeat(64)}`,
        domain: "micro-routing",
        targetScopeDigest: `sha256:${"2".repeat(64)}`,
        journalReceiptDigest: `sha256:${"8".repeat(64)}`,
        ...heldFence,
      })).status).toBe(400);
      expect((await post(actionSocketPath, "/demote", {
        journalId: "micro-route-journal",
        ownerAuthorizationDigest: `sha256:${"5".repeat(64)}`,
        domain: "micro-routing",
        targetScopeDigest: `sha256:${"2".repeat(64)}`,
        journalReceiptDigest: `sha256:${"4".repeat(64)}`,
        ...heldFence,
      })).status).toBe(200);
      expect((await post(actionSocketPath, "/fence/release", {
        epoch: superseding.body.epoch,
        token: superseding.body.token,
      })).status).toBe(200);
    } finally {
      await service.close();
    }
  });
});
