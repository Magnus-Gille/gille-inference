import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
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
import {
  ConstitutionalRouteDatabase,
  initializeConstitutionalRouteDatabase,
} from "../src/homeserver/constitutional-route-database.js";

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

function journalAuthority(phase: "prepare" | "unknown" | "revert" | "commit" = "prepare") {
  let currentPhase = phase;
  let currentProtectedAuthority = { epoch: "prepared-authority" };
  const preparedProtectedAuthority = structuredClone(currentProtectedAuthority);
  return {
    authority: {
      read: (_journalId: string, expectedAuthority?: unknown) => {
        if (
          expectedAuthority !== undefined
          && JSON.stringify(expectedAuthority) !== JSON.stringify(preparedProtectedAuthority)
          && JSON.stringify(expectedAuthority) !== JSON.stringify(currentProtectedAuthority)
        ) {
          throw new Error("wrong protected authority");
        }
        return ({
        journalId: "micro-route-journal",
        bindingDigest: `sha256:${"1".repeat(64)}`,
        targetScopeDigest: `sha256:${"2".repeat(64)}`,
        baselineDigest: digest(baseline),
        candidateDigest: digest(candidate),
        attemptId: "micro-route-attempt",
        deadline: "2030-07-26T01:10:00Z",
        descriptorDigest: `sha256:${"3".repeat(64)}`,
        ownerAuthorizationDigest: `sha256:${"5".repeat(64)}`,
        watchdogIdentity: "micro-route-watchdog",
        phase: currentPhase,
        receiptDigest: `sha256:${"4".repeat(64)}`,
        });
      },
      protectedAuthority: () => structuredClone(currentProtectedAuthority),
    },
    setPhase: (next: "prepare" | "unknown" | "revert" | "commit") => { currentPhase = next; },
    rotateAuthority: () => { currentProtectedAuthority = { epoch: "rotated-authority" }; },
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
    clearCandidateDeadline: (_candidate: unknown, suppliedFence: { epoch: number; token: string }) => (
      suppliedFence.epoch === currentFence.epoch && suppliedFence.token === currentFence.token
    ),
    clearOwnedBlock: (suppliedFence: { epoch: number; token: string }) => (
      suppliedFence.epoch === currentFence.epoch && suppliedFence.token === currentFence.token
    ),
    compareAndSwap: (expected: string, next: string, suppliedFence: { epoch: number; token: string }) => {
      if (suppliedFence.epoch !== currentFence.epoch || suppliedFence.token !== currentFence.token) return false;
      if (current !== expected) return false;
      writes += 1;
      current = next;
      return true;
    },
    block: (suppliedFence: { epoch: number; token: string }) => (
      suppliedFence.epoch === currentFence.epoch && suppliedFence.token === currentFence.token
    ),
    clearBlock: (suppliedFence: { epoch: number; token: string }) => (
      suppliedFence.epoch === currentFence.epoch && suppliedFence.token === currentFence.token
    ),
  };
}

describe("recovery-owned preregistration", () => {
  it("rejects the frozen v1 journal at the privileged recovery boundary", () => {
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
    expect(() => authenticateRecoveryJournal({
      journalId: journal.journal_id,
      journal,
      protectedSnapshot: snapshot,
    })).toThrow(/unsupported recovery journal contract epoch/);
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

  it("clears a candidate serving deadline only for the exact durable commit", () => {
    const registry = new RecoveryRegistry(mkdtempSync(join(tmpdir(), "constitutional-recovery-")));
    const live = route(baseline);
    const journal = journalAuthority();
    registry.register(registration(), live, journal.authority);
    const lease = live.acquireWriterLease();
    journal.setPhase("commit");
    expect(registry.promoteCandidate({
      journalId: "micro-route-journal",
      attemptId: "micro-route-attempt",
      bindingDigest: `sha256:${"1".repeat(64)}`,
      targetScopeDigest: `sha256:${"2".repeat(64)}`,
      candidateDigest: digest(candidate),
      notAfter: "2030-07-26T01:10:00Z",
    }, { epoch: lease.epoch, token: lease.token }, live, journal.authority)).toBe(true);
    expect(() => registry.promoteCandidate({
      journalId: "micro-route-journal",
      attemptId: "forged-attempt",
      bindingDigest: `sha256:${"1".repeat(64)}`,
      targetScopeDigest: `sha256:${"2".repeat(64)}`,
      candidateDigest: digest(candidate),
      notAfter: "2030-07-26T01:10:00Z",
    }, { epoch: lease.epoch, token: lease.token }, live, journal.authority)).toThrow(/exact committed journal/);
    lease.release();
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

  it("replays a completed recovery through a successor resource fence", () => {
    const registry = new RecoveryRegistry(mkdtempSync(join(tmpdir(), "constitutional-recovery-")));
    const live = route(baseline);
    const journal = journalAuthority();
    const receipt = registry.register(registration(), live, journal.authority);
    journal.setPhase("unknown");
    live.set(candidate);
    const firstLease = live.acquireWriterLease();
    const request = {
      handle: receipt.handle,
      journalId: "micro-route-journal",
      bindingDigest: `sha256:${"1".repeat(64)}`,
      targetScopeDigest: `sha256:${"2".repeat(64)}`,
      journalReceiptDigest: `sha256:${"4".repeat(64)}`,
      fenceEpoch: firstLease.epoch,
      fenceToken: firstLease.token,
    };
    expect(registry.actuate(request, live, journal.authority).classification).toBe("restored");
    firstLease.release();
    const successor = live.acquireWriterLease();
    expect(registry.actuate({
      ...request,
      fenceEpoch: successor.epoch,
      fenceToken: successor.token,
    }, live, journal.authority).classification).toBe("restored");
    expect(live.writes()).toBe(1);
    successor.release();
  });

  it("retains the authenticated prepare authority across later authority rotation", () => {
    const registry = new RecoveryRegistry(mkdtempSync(join(tmpdir(), "constitutional-recovery-")));
    const live = route(baseline);
    const journal = journalAuthority();
    const receipt = registry.register(registration(), live, journal.authority);
    journal.rotateAuthority();
    journal.setPhase("unknown");
    live.set(candidate);
    expect(registry.actuate({
      handle: receipt.handle,
      journalId: "micro-route-journal",
      bindingDigest: `sha256:${"1".repeat(64)}`,
      targetScopeDigest: `sha256:${"2".repeat(64)}`,
      journalReceiptDigest: `sha256:${"4".repeat(64)}`,
      ...fence,
    }, live, journal.authority).classification).toBe("restored");
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

function runSocketClient(args: string[]): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--import",
      "tsx",
      new URL("./fixtures/constitutional-cli-socket-client.ts", import.meta.url).pathname,
      ...args,
    ], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`socket client exited ${code}: ${Buffer.concat(stderr).toString("utf8")}`));
        return;
      }
      resolve(JSON.parse(Buffer.concat(stdout).toString("utf8")));
    });
  });
}

describe("permission-separated AF_UNIX recovery service", () => {
  it("exposes registration only on the controller socket and actuation only on the watchdog socket", async () => {
    const root = mkdtempSync(join(tmpdir(), "constitutional-recovery-sockets-"));
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
      routeLeaseOptions: { durationMs: 100 },
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
      const controllerFence = await post(registrationSocketPath, "/route/fence/acquire", {});
      expect(controllerFence.status).toBe(200);
      expect((await post(registrationSocketPath, "/route/apply", {
        handle: registered.body.handle,
        journalId: "micro-route-journal",
        bindingDigest: `sha256:${"1".repeat(64)}`,
        targetScopeDigest: `sha256:${"2".repeat(64)}`,
        candidate,
        fenceEpoch: controllerFence.body.epoch,
        fenceToken: controllerFence.body.token,
      }))).toMatchObject({ status: 200, body: { applied: true } });
      expect((await post(registrationSocketPath, "/route/read", {})).body.value).toBe(candidate);
      expect((await post(registrationSocketPath, "/route/fence/release", controllerFence.body)).status).toBe(200);
      journal.setPhase("unknown");
      expect((await post(registrationSocketPath, "/actuate", {})).status).toBe(404);
      expect((await post(actionSocketPath, "/actuate", {
        handle: registered.body.handle,
        journalId: "micro-route-journal",
        bindingDigest: `sha256:${"1".repeat(64)}`,
        targetScopeDigest: `sha256:${"2".repeat(64)}`,
        journalReceiptDigest: `sha256:${"4".repeat(64)}`,
        ...fence,
      })).status).toBe(400);
      const acquired = await post(actionSocketPath, "/fence/acquire", {});
      expect(acquired).toMatchObject({ status: 200, body: { epoch: expect.any(Number), token: expect.any(String) } });
      expect((await post(actionSocketPath, "/fence/acquire", {})).status).toBe(400);
      await new Promise((resolve) => setTimeout(resolve, 120));
      const superseding = await post(actionSocketPath, "/fence/acquire", {});
      expect(superseding.status).toBe(200);
      expect(superseding.body.epoch).toBeGreaterThan(acquired.body.epoch);
      expect((await post(actionSocketPath, "/fence/release", acquired.body)).status).toBe(400);
      const heldFence = { fenceEpoch: superseding.body.epoch, fenceToken: superseding.body.token };
      // AF_UNIX peer authorization permits an action request, not a caller-
      // supplied watchdog owner tuple. The service must derive it from the
      // authenticated journal it owns.
      expect((await post(actionSocketPath, "/route/block", {
        ...superseding.body,
        owner: {
          journalId: "attacker-journal", attemptId: "attacker-attempt",
          bindingDigest: `sha256:${"9".repeat(64)}`,
          targetScopeDigest: `sha256:${"8".repeat(64)}`,
          watchdogIdentity: "attacker-watchdog",
        },
      })).status).toBe(400);
      journal.setPhase("watch" as any);
      expect(await post(actionSocketPath, "/route/block", {
        ...superseding.body,
        journalId: "micro-route-journal",
      })).toMatchObject({ status: 200, body: { changed: true } });
      expect(await post(actionSocketPath, "/route/unblock-owned", {
        ...superseding.body,
        journalId: "micro-route-journal",
      })).toMatchObject({ status: 200, body: { changed: true } });
      journal.setPhase("unknown");
      expect((await post(actionSocketPath, "/route/block", superseding.body)).status).toBe(200);
      const actuated = await post(actionSocketPath, "/actuate", {
        handle: registered.body.handle,
        journalId: "micro-route-journal",
        bindingDigest: `sha256:${"1".repeat(64)}`,
        targetScopeDigest: `sha256:${"2".repeat(64)}`,
        journalReceiptDigest: `sha256:${"4".repeat(64)}`,
        ...heldFence,
      });
      expect(actuated.body.classification).toBe("restored");
      expect(live.read()).toBe(baseline);
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
      // Generic unblock is intentionally not exposed: the recovery service
      // clears only an owner it has derived from an authenticated journal.
      expect((await post(actionSocketPath, "/route/unblock", superseding.body)).status).toBe(404);
      expect((await post(actionSocketPath, "/fence/release", {
        epoch: superseding.body.epoch,
        token: superseding.body.token,
      })).status).toBe(200);
    } finally {
      await service.close();
    }
  });

  it("uses the production CLI socket mapping and recovers a lost apply response under a successor fence", async () => {
    const root = mkdtempSync(join(tmpdir(), "constitutional-cli-sockets-"));
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
      routeLeaseOptions: { durationMs: 2_000 },
    });
    try {
      const controller = await runSocketClient([
        "controller-response-loss",
        registrationSocketPath,
      ]);
      expect(controller.lost).toMatch(/simulated response loss/);
      expect(controller.activeRegistration).toMatchObject({
        handle: expect.stringMatching(/^recovery-/),
        journalId: "micro-route-journal",
      });
      expect(live.read()).toBe(candidate);

      journal.setPhase("unknown");
      const watchdog = await runSocketClient([
        "watchdog-recover",
        actionSocketPath,
        controller.activeRegistration.handle,
      ]);
      expect(watchdog.classification).toBe("restored");
      expect(live.read()).toBe(baseline);
    } finally {
      await service.close();
    }
  });

  it("proves the real route digest through the service and production CLI under only the current fence", async () => {
    const root = mkdtempSync(join(tmpdir(), "constitutional-route-digest-"));
    const registrationSocketPath = join(root, "register.sock");
    const actionSocketPath = join(root, "action.sock");
    const routePath = join(root, "routing.db");
    initializeConstitutionalRouteDatabase(routePath, baseline);
    const live = new ConstitutionalRouteDatabase(routePath);
    const journal = journalAuthority();
    const service = await startRecoveryService({
      registrationSocketPath,
      actionSocketPath,
      registry: new RecoveryRegistry(join(root, "registrations")),
      route: live,
      journalAuthority: journal.authority,
      demote: () => ({ ledger: {}, registry: {}, checkpoint: {} }),
      // The production CLI performs four sequential synchronous curl calls
      // while holding this fence. Give loaded CI a deterministic margin while
      // remaining 75x below the 150-second production lease.
      routeLeaseOptions: { durationMs: 2_000 },
    });
    try {
      const cli = await runSocketClient([
        "watchdog-route-digest",
        actionSocketPath,
      ]);
      expect(cli.digest).toBe(digest(baseline));
      expect(live.isBlocked()).toBe(false);

      const acquired = await post(actionSocketPath, "/fence/acquire", {});
      expect(acquired.status).toBe(200);
      expect((await post(actionSocketPath, "/route/digest", {
        epoch: acquired.body.epoch,
        token: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      })).status).toBe(400);

      await new Promise((resolve) => setTimeout(resolve, 2_100));
      const successor = await post(actionSocketPath, "/fence/acquire", {});
      expect(successor.status).toBe(200);
      expect(successor.body.epoch).toBeGreaterThan(acquired.body.epoch);
      expect((await post(actionSocketPath, "/route/digest", acquired.body)).status).toBe(400);
      expect(await post(actionSocketPath, "/route/digest", successor.body)).toMatchObject({
        status: 200,
        body: { digest: digest(baseline) },
      });
      expect((await post(actionSocketPath, "/fence/release", successor.body)).status).toBe(200);
    } finally {
      await service.close();
    }
  });
});
