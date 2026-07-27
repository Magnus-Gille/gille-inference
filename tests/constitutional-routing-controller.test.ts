import {
  createHash,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ConstitutionalRoutingController,
  ConstitutionalRoutingWatchdog,
  constitutionalPaths,
  type AuthoritySnapshot,
  type ConstitutionalRouteStore,
  type ProtectedAuthorityReader,
  type RecoveryRegistrar,
  type RestoreOnlyCapability,
  type RouteMutationPlan,
} from "../src/homeserver/constitutional-routing-controller.js";
import {
  canonicalJson,
  digestJson,
  validateJournalV1,
  validateJournalV1Prefix,
} from "../src/homeserver/autonomy-contract-v1.js";
import {
  ConstitutionalRouteDatabase,
  initializeConstitutionalRouteDatabase,
} from "../src/homeserver/constitutional-route-database.js";
import {
  ConstitutionalFencedLease,
  readConstitutionalResource,
} from "../src/homeserver/constitutional-fenced-lease.js";

const contractRoot = new URL("../contracts/grimnir-autonomy-v1/", import.meta.url).pathname;
const artifact = (name: string): any => JSON.parse(readFileSync(join(contractRoot, name), "utf8"));
const fixture = (name: string): any => JSON.parse(readFileSync(join(contractRoot, "fixtures", name), "utf8"));
const sha = (bytes: Buffer): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const CONFIG = `sha256:${"b".repeat(64)}`;
const EVIDENCE = `sha256:${"c".repeat(64)}`;
const POLICY = `sha256:${"d".repeat(64)}`;
const POSTCONDITIONS = `sha256:${"f".repeat(64)}`;

function signObject(value: Record<string, unknown>, key: KeyObject): string {
  return sign(null, Buffer.from(canonicalJson(value)), key).toString("base64");
}

/**
 * Creates disposable cryptographic fixtures entirely in memory. These are
 * synthetic test authorities, not an owner key or deployable configuration.
 */
function syntheticAuthority() {
  const owner = generateKeyPairSync("ed25519");
  const recovery = generateKeyPairSync("ed25519");
  const ownerPem = owner.publicKey.export({ type: "spki", format: "pem" }).toString();
  const recoveryPem = recovery.publicKey.export({ type: "spki", format: "pem" }).toString();
  const ownerFingerprint = sha(owner.publicKey.export({ type: "spki", format: "der" }));
  const recoveryFingerprint = sha(recovery.publicKey.export({ type: "spki", format: "der" }));
  const constitution = artifact("constitution.json");
  const coverage = fixture("coverage-armed-canary.json");
  const attestations = artifact("owner-attestations.json");
  const recoveryRegistry: any = {
    kind: "autonomy-recovery-worker-registry",
    schema_version: "v1",
    registry_id: "synthetic-recovery-workers",
    entries: [{
      domain: "micro-routing",
      target_scope_digest: coverage.domains[0].bindings[0].target_scope_digest,
      recovery_worker_identity: "micro-route-revert-worker",
      public_key_pem: recoveryPem,
      public_key_fingerprint: recoveryFingerprint,
    }],
    registry_digest: "",
    extensions: [],
  };
  recoveryRegistry.registry_digest = digestJson(recoveryRegistry, "registry_digest");
  const unsignedAuthorization: any = {
    kind: "autonomy-owner-authorization",
    schema_version: "v1",
    authorization_id: "synthetic-owner-authorization",
    authorization_sequence: 1,
    previous_authorization_digest: null,
    issued_at: "2026-07-26T00:00:00Z",
    authority: {
      key_id: "synthetic-owner-key",
      algorithm: "Ed25519",
      public_key_pem: ownerPem,
      public_key_fingerprint: ownerFingerprint,
    },
    bindings: {
      constitution_digest: digestJson(constitution, "constitution_digest"),
      coverage_intent_digest: digestJson(coverage, "registry_digest"),
      owner_attestation_registry_digest: digestJson(attestations, "registry_digest"),
      recovery_worker_registry_digest: digestJson(recoveryRegistry, "registry_digest"),
    },
  };
  const authorization = {
    ...unsignedAuthorization,
    signature: { algorithm: "Ed25519", value_base64: signObject(unsignedAuthorization, owner.privateKey) },
  };
  const authorizationDigest = digestJson(authorization);
  const checkpoint = {
    kind: "autonomy-owner-authorization-checkpoint",
    schema_version: "v1",
    authorization_digest: authorizationDigest,
    minimum_sequence: 1,
  };
  const emptyNarrowing = {
    kind: "autonomy-runtime-narrowing",
    schema_version: "v1",
    ledger_id: "synthetic-runtime-narrowing",
    owner_authorization_digest: authorizationDigest,
    entries: [],
    extensions: [],
  };
  const emptyTail = {
    kind: "autonomy-runtime-narrowing-checkpoint",
    schema_version: "v1",
    owner_authorization_digest: authorizationDigest,
    ledger_tail_digest: null,
    minimum_entries: 0,
  };
  const snapshot: AuthoritySnapshot = {
    authorization,
    constitution,
    coverage,
    attestations,
    recoveryRegistry,
    pinnedOwnerPublicKeyPem: ownerPem,
    checkpoint,
    runtimeNarrowing: emptyNarrowing,
    runtimeNarrowingCheckpoint: emptyTail,
  };
  return { snapshot, recoveryPrivateKey: recovery.privateKey, authorizationDigest };
}

function fakeAuthority(snapshot: AuthoritySnapshot) {
  let now = "2026-07-26T00:00:00Z";
  let killed = false;
  let healthy = true;
  const reader: ProtectedAuthorityReader = {
    read: () => structuredClone(snapshot),
    killSwitchActive: () => killed,
    trustedNowIso: () => now,
    liveness: () => ({ healthy, observedAt: now, digest: `sha256:${"9".repeat(64)}` }),
    currentDigests: () => ({ config: CONFIG, evidence: EVIDENCE, policy: POLICY, postconditions: POSTCONDITIONS }),
  };
  return {
    reader,
    setNow: (value: string) => { now = value; },
    setKilled: (value: boolean) => { killed = value; },
    setHealthy: (value: boolean) => { healthy = value; },
  };
}

function fakeStore(initial = '{"route":"mellum"}\n') {
  let value = initial;
  let throwAfterWrite = false;
  let fence = { epoch: 0, token: "owner-init" };
  const store: ConstitutionalRouteStore = {
    read: () => value,
    acquireWriterLease: () => {
      fence = {
        epoch: fence.epoch + 1,
        token: `${String(fence.epoch + 1).padStart(8, "0")}-0000-4000-8000-000000000000`,
      };
      return { ...fence, release: () => undefined };
    },
    compareAndSwap: (expected, next, suppliedFence) => {
      if (suppliedFence.epoch !== fence.epoch || suppliedFence.token !== fence.token) return false;
      if (value !== expected) return false;
      value = next;
      if (throwAfterWrite) throw new Error("simulated kill -9 after route write");
      return true;
    },
  };
  return {
    store,
    read: () => value,
    write: (next: string) => { value = next; },
    restore: (expectedDigest: string, next: string, nextFence: { epoch: number; token: string }) => {
      if (`sha256:${createHash("sha256").update(value).digest("hex")}` !== expectedDigest) return false;
      if (nextFence.epoch !== fence.epoch || nextFence.token !== fence.token) return false;
      value = next;
      return true;
    },
    crashAfterWrite: () => { throwAfterWrite = true; },
  };
}

function plan(store: ReturnType<typeof fakeStore>, snapshot: AuthoritySnapshot): RouteMutationPlan {
  return {
    mutationId: "micro-route-mutation",
    attemptId: "micro-route-attempt",
    recoveryDisarmId: "micro-route-disarm",
    idempotencyKey: "micro-route-idempotency",
    journalId: "micro-route-journal",
    baseline: store.read(),
    candidate: '{"route":"qwen"}\n',
    targetScopeDigest: `sha256:${"1".repeat(64)}`,
    configDigest: CONFIG,
    evidenceDigest: EVIDENCE,
    policyDigest: POLICY,
    postconditionsDigest: POSTCONDITIONS,
    recoveryDescriptorDigest: digestJson(snapshot),
    deadline: "2026-07-26T01:00:00Z",
    watchDeadline: "2026-07-26T00:30:00Z",
    contentRef: "ref:micro-route-candidate",
  };
}

function recoveryCapability(
  store: ReturnType<typeof fakeStore>,
  privateKey: KeyObject,
  authorizationDigest: string,
  snapshot: AuthoritySnapshot,
  opts: { restoreFails?: boolean } = {},
): RestoreOnlyCapability {
  let activeRouteLease: { epoch: number; token: string; release(): void } | undefined;
  return {
    recoveryWorkerIdentity: "micro-route-revert-worker",
    acquireRouteFence: () => {
      activeRouteLease = store.store.acquireWriterLease();
      return { epoch: activeRouteLease.epoch, token: activeRouteLease.token };
    },
    releaseRouteFence: (fence) => {
      if (activeRouteLease?.epoch === fence.epoch && activeRouteLease.token === fence.token) {
        activeRouteLease.release();
        activeRouteLease = undefined;
      }
    },
    actuatePreRegisteredRecovery: ({ candidateDigest, fenceEpoch, fenceToken }) => {
      if (opts.restoreFails) return "failed";
      const current = `sha256:${createHash("sha256").update(store.read()).digest("hex")}`;
      const baseline = '{"route":"mellum"}\n';
      const baselineDigest = `sha256:${createHash("sha256").update(baseline).digest("hex")}`;
      if (current === baselineDigest) return "already-baseline";
      if (current !== candidateDigest) return "superseded";
      if (!store.restore(candidateDigest, baseline, { epoch: fenceEpoch, token: fenceToken })) return "failed";
      return `sha256:${createHash("sha256").update(store.read()).digest("hex")}` === baselineDigest ? "restored" : "failed";
    },
    signAndPersistDemotion: ({ targetScopeDigest, journalReceiptDigest }) => {
      const unsignedEntry: any = {
        sequence: 1,
        recorded_at: "2026-07-26T01:00:01Z",
        domain: "micro-routing",
        target_scope_digest: targetScopeDigest,
        from_state: "armed-canary",
        to_state: "shadow",
        recovery_worker_identity: "micro-route-revert-worker",
        journal_receipt_digest: journalReceiptDigest,
        previous_entry_digest: null,
      };
      unsignedEntry.entry_digest = digestJson(unsignedEntry);
      const entry = {
        ...unsignedEntry,
        signature: { algorithm: "Ed25519", value_base64: signObject(unsignedEntry, privateKey) },
      };
      const ledger = {
        kind: "autonomy-runtime-narrowing",
        schema_version: "v1",
        ledger_id: "synthetic-runtime-narrowing",
        owner_authorization_digest: authorizationDigest,
        entries: [entry],
        extensions: [],
      };
      return {
        ledger,
        registry: snapshot.recoveryRegistry,
        checkpoint: {
          kind: "autonomy-runtime-narrowing-checkpoint",
          schema_version: "v1",
          owner_authorization_digest: authorizationDigest,
          ledger_tail_digest: entry.entry_digest,
          minimum_entries: 1,
        },
      };
    },
  };
}

const recoveryRegistrar: RecoveryRegistrar = {
  registerPreRecovery: () => ({
    handle: "recovery-00000000-0000-4000-8000-000000000000",
    registrationDigest: `sha256:${"6".repeat(64)}`,
  }),
};

const proofVerifier = {
  verify: (input: { candidateDigest: string; postconditionsDigest: string }) => ({
    ok: true,
    candidateDigest: input.candidateDigest,
    postconditionsDigest: input.postconditionsDigest,
    proofDigest: `sha256:${"7".repeat(64)}`,
  }),
};

describe("constitutional micro-routing controller", () => {
  it.each(["kill9", "stop"] as const)("recovers through the real child-process %s fault harness", async (mode) => {
    const root = mkdtempSync(join(tmpdir(), `constitutional-real-${mode}-`));
    const tablePath = join(root, "routing.db");
    const snapshotPath = join(root, "snapshot.json");
    const planPath = join(root, "plan.json");
    const synthetic = syntheticAuthority();
    const authority = fakeAuthority(synthetic.snapshot);
    const table = fakeStore();
    const baseline = table.read();
    const mutation = plan(table, synthetic.snapshot);
    initializeConstitutionalRouteDatabase(tablePath, baseline);
    writeFileSync(snapshotPath, JSON.stringify(synthetic.snapshot));
    writeFileSync(planPath, JSON.stringify(mutation));
    const child = spawn(process.execPath, [
      "--import",
      "tsx",
      join(process.cwd(), "tests/fixtures/constitutional-controller-child.ts"),
      mode,
      root,
      tablePath,
      snapshotPath,
      planPath,
    ], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    if (mode === "kill9") {
      await new Promise<void>((resolve, reject) => {
        child.once("exit", (_code, signal) => signal === "SIGKILL" ? resolve() : reject(new Error(`unexpected child exit ${signal}`)));
        child.once("error", reject);
      });
    } else {
      await new Promise<void>((resolve, reject) => {
        child.stdout!.once("data", (chunk) => String(chunk).includes("AFTER-CLIENT-CHECK-BEFORE-RESOURCE-MUTATION")
          ? resolve()
          : reject(new Error("child did not stop after its client check")));
        child.once("error", reject);
      });
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const routeDb = new ConstitutionalRouteDatabase(tablePath);
    const parentTable = {
      store: routeDb,
      read: () => routeDb.read(),
      write: (next: string) => {
        const lease = routeDb.acquireWriterLease();
        const fence = { epoch: lease.epoch, token: lease.token };
        if (!routeDb.compareAndSwap(routeDb.read(), next, fence)) throw new Error("test route write failed");
        lease.release();
      },
      restore: (expected: string, next: string, fence: { epoch: number; token: string }) => {
        return routeDb.restoreExact(expected, next, fence);
      },
    };
    authority.setNow("2026-07-26T01:00:01Z");
    const watchdog = new ConstitutionalRoutingWatchdog(
      root,
      authority.reader,
      recoveryCapability(parentTable as ReturnType<typeof fakeStore>, synthetic.recoveryPrivateKey, synthetic.authorizationDigest, synthetic.snapshot),
      () => undefined,
      undefined,
      { durationMs: 150 },
    );
    expect(watchdog.tick().outcome).toBe("reverted");
    expect(routeDb.read()).toBe(baseline);
    if (mode === "stop") {
      const exited = new Promise<{ code: number | null; stderr: string }>((resolve) => {
        let stderr = "";
        child.stderr!.on("data", (chunk) => { stderr += String(chunk); });
        child.once("exit", (code) => resolve({ code, stderr }));
      });
      process.kill(child.pid!, "SIGCONT");
      const resumed = await exited;
      expect(resumed.code).not.toBe(0);
      expect(resumed.stderr).toMatch(/expired or superseded/);
      expect(routeDb.read()).toBe(baseline);
    }
  }, 15_000);

  it("writes a schema-valid authoritative prefix before apply and commits only after fresh rechecks", () => {
    const root = mkdtempSync(join(tmpdir(), "constitutional-controller-"));
    const synthetic = syntheticAuthority();
    const authority = fakeAuthority(synthetic.snapshot);
    const table = fakeStore();
    const mutation = plan(table, synthetic.snapshot);
    const controller = new ConstitutionalRoutingController(root, table.store, authority.reader, proofVerifier, recoveryRegistrar);
    expect(controller.begin(mutation).outcome).toBe("watching");
    const paths = constitutionalPaths(root);
    const journal = JSON.parse(readConstitutionalResource(paths.lock, paths.journal)!);
    const recoveryMaterial = JSON.parse(readConstitutionalResource(paths.lock, paths.recoveryMaterial)!);
    expect(recoveryMaterial).not.toHaveProperty("baseline");
    expect(recoveryMaterial.plan).not.toHaveProperty("baseline");
    expect(recoveryMaterial.recovery_handle).toMatch(/^recovery-/);
    expect(validateJournalV1Prefix(
      journal,
      synthetic.snapshot.constitution,
      synthetic.snapshot.coverage,
      synthetic.snapshot.attestations,
    )).toMatchObject({ phase: "watch", terminal: false });
    authority.setNow("2026-07-26T00:30:00Z");
    const committed = controller.commit();
    expect(committed.outcome).toBe("committed");
    expect(validateJournalV1(
      committed.journal,
      synthetic.snapshot.constitution,
      synthetic.snapshot.coverage,
      synthetic.snapshot.attestations,
    )).toMatchObject({ terminal: "commit" });
  });

  it("kill -9 after the route write is recovered exactly by the independent restore-only worker", () => {
    const root = mkdtempSync(join(tmpdir(), "constitutional-kill9-"));
    const synthetic = syntheticAuthority();
    const authority = fakeAuthority(synthetic.snapshot);
    const table = fakeStore();
    const baseline = table.read();
    const mutation = plan(table, synthetic.snapshot);
    table.crashAfterWrite();
    const controller = new ConstitutionalRoutingController(root, table.store, authority.reader, proofVerifier, recoveryRegistrar);
    expect(() => controller.begin(mutation)).toThrow(/simulated kill -9/);
    expect(table.read()).toBe(mutation.candidate);
    authority.setNow("2026-07-26T01:00:01Z");
    const watchdog = new ConstitutionalRoutingWatchdog(
      root,
      authority.reader,
      recoveryCapability(table, synthetic.recoveryPrivateKey, synthetic.authorizationDigest, synthetic.snapshot),
    );
    const result = watchdog.tick();
    expect(result.outcome).toBe("reverted");
    expect(table.read()).toBe(baseline);
    expect(result.journal?.entries.map((entry) => entry.phase)).toEqual(["prepare", "unknown", "revert", "disarm"]);
  });

  it("recovers a kill-STOP during watch after the absolute deadline even when notification is offline", () => {
    const root = mkdtempSync(join(tmpdir(), "constitutional-stop-"));
    const synthetic = syntheticAuthority();
    const authority = fakeAuthority(synthetic.snapshot);
    const table = fakeStore();
    const baseline = table.read();
    const mutation = plan(table, synthetic.snapshot);
    new ConstitutionalRoutingController(root, table.store, authority.reader, proofVerifier, recoveryRegistrar).begin(mutation);
    authority.setNow("2026-07-26T01:00:01Z");
    const watchdog = new ConstitutionalRoutingWatchdog(
      root,
      authority.reader,
      recoveryCapability(table, synthetic.recoveryPrivateKey, synthetic.authorizationDigest, synthetic.snapshot),
      () => { throw new Error("observer offline"); },
    );
    expect(watchdog.tick().outcome).toBe("reverted");
    expect(table.read()).toBe(baseline);
  });

  it("terminally blocks and consumes recovery when exact restore fails", () => {
    const root = mkdtempSync(join(tmpdir(), "constitutional-restore-fail-"));
    const synthetic = syntheticAuthority();
    const authority = fakeAuthority(synthetic.snapshot);
    const table = fakeStore();
    const mutation = plan(table, synthetic.snapshot);
    new ConstitutionalRoutingController(root, table.store, authority.reader, proofVerifier, recoveryRegistrar).begin(mutation);
    authority.setNow("2026-07-26T01:00:01Z");
    const watchdog = new ConstitutionalRoutingWatchdog(
      root,
      authority.reader,
      recoveryCapability(table, synthetic.recoveryPrivateKey, synthetic.authorizationDigest, synthetic.snapshot, { restoreFails: true }),
    );
    expect(watchdog.tick()).toMatchObject({ outcome: "terminally-blocked", reason: "exact-baseline-restore-failed" });
    expect(watchdog.tick()).toMatchObject({ outcome: "noop", reason: "terminal-signed-demotion-reconciled" });
  });

  it("durably blocks the target before parsing corrupt recovery material", () => {
    const root = mkdtempSync(join(tmpdir(), "constitutional-corrupt-material-"));
    const synthetic = syntheticAuthority();
    const authority = fakeAuthority(synthetic.snapshot);
    const table = fakeStore();
    new ConstitutionalRoutingController(root, table.store, authority.reader, proofVerifier, recoveryRegistrar)
      .begin(plan(table, synthetic.snapshot));
    const paths = constitutionalPaths(root);
    const corruptor = ConstitutionalFencedLease.acquire(paths.lock);
    corruptor.writeResource(paths.recoveryMaterial, "{broken");
    corruptor.release();
    const result = new ConstitutionalRoutingWatchdog(
      root,
      authority.reader,
      recoveryCapability(table, synthetic.recoveryPrivateKey, synthetic.authorizationDigest, synthetic.snapshot),
    ).tick();
    expect(result).toMatchObject({ outcome: "terminally-blocked", reason: expect.stringMatching(/^recovery-input-unreadable:/) });
    expect(readConstitutionalResource(paths.lock, paths.targetBlock)).toBeDefined();
  });

  it("rejects a kill switch, stale liveness, concurrent journal, and second attempt without mutating", () => {
    const root = mkdtempSync(join(tmpdir(), "constitutional-refusals-"));
    const synthetic = syntheticAuthority();
    const authority = fakeAuthority(synthetic.snapshot);
    const table = fakeStore();
    const mutation = plan(table, synthetic.snapshot);
    authority.setKilled(true);
    expect(() => new ConstitutionalRoutingController(root, table.store, authority.reader, proofVerifier, recoveryRegistrar).begin(mutation)).toThrow(/kill switch/);
    authority.setKilled(false);
    authority.setHealthy(false);
    expect(() => new ConstitutionalRoutingController(root, table.store, authority.reader, proofVerifier, recoveryRegistrar).begin(mutation)).toThrow(/liveness/);
    authority.setHealthy(true);
    new ConstitutionalRoutingController(root, table.store, authority.reader, proofVerifier, recoveryRegistrar).begin(mutation);
    expect(() => new ConstitutionalRoutingController(root, table.store, authority.reader, proofVerifier, recoveryRegistrar).begin({ ...mutation, attemptId: "second-route-attempt" })).toThrow(/prior constitutional attempt|in flight/);
  });
});
