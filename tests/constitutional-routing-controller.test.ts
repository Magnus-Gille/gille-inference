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
  validateJournalV2,
  validateJournalV2Prefix,
} from "../src/homeserver/autonomy-contract-v1.js";
import {
  ConstitutionalRouteDatabase,
  ConstitutionalRouteBlockedError,
  initializeConstitutionalRouteDatabase,
  readConstitutionalRouteDatabase,
} from "../src/homeserver/constitutional-route-database.js";
import {
  ConstitutionalFencedLease,
  readConstitutionalResource,
} from "../src/homeserver/constitutional-fenced-lease.js";

const contractRoot = new URL("../contracts/grimnir-autonomy-v2/", import.meta.url).pathname;
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
  return {
    snapshot,
    ownerPrivateKey: owner.privateKey,
    recoveryPrivateKey: recovery.privateKey,
    authorizationDigest,
  };
}

function resignSnapshot(snapshot: AuthoritySnapshot, ownerPrivateKey: KeyObject): void {
  const authorization = structuredClone(snapshot.authorization) as any;
  authorization.bindings.constitution_digest = digestJson(snapshot.constitution, "constitution_digest");
  authorization.bindings.coverage_intent_digest = digestJson(snapshot.coverage, "registry_digest");
  authorization.bindings.owner_attestation_registry_digest = digestJson(snapshot.attestations, "registry_digest");
  authorization.bindings.recovery_worker_registry_digest = digestJson(snapshot.recoveryRegistry, "registry_digest");
  const { signature: _signature, ...unsigned } = authorization;
  authorization.signature = {
    algorithm: "Ed25519",
    value_base64: signObject(unsigned, ownerPrivateKey),
  };
  snapshot.authorization = authorization;
  snapshot.checkpoint = {
    ...(snapshot.checkpoint as Record<string, unknown>),
    authorization_digest: digestJson(authorization),
  };
  (snapshot.runtimeNarrowing as any).owner_authorization_digest = digestJson(authorization);
  (snapshot.runtimeNarrowingCheckpoint as any).owner_authorization_digest = digestJson(authorization);
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
  let failDeadlineClear = false;
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
    clearCandidateDeadline: (_candidate, suppliedFence) => {
      if (failDeadlineClear) return false;
      return suppliedFence.epoch === fence.epoch && suppliedFence.token === fence.token;
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
    failNextDeadlineClear: () => { failDeadlineClear = true; },
    allowDeadlineClear: () => { failDeadlineClear = false; },
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
    deadline: "2026-07-26T01:10:00Z",
    contentRef: "ref:micro-route-candidate",
  };
}

function recoveryCapability(
  store: ReturnType<typeof fakeStore>,
  privateKey: KeyObject,
  authorizationDigest: string,
  snapshot: AuthoritySnapshot,
  opts: { restoreFails?: boolean; persistDemotion?: boolean; onSign?: () => void; onBlock?: () => void; onClearBlock?: () => void; onClearDeadline?: () => void } = {},
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
    blockRoute: () => { opts.onBlock?.(); },
    clearOwnedRouteBlock: () => false,
    clearCandidateDeadline: () => { opts.onClearDeadline?.(); },
    readRouteDigest: () => `sha256:${createHash("sha256").update(store.read()).digest("hex")}`,
    actuatePreRegisteredRecovery: ({ fenceEpoch, fenceToken }) => {
      if (opts.restoreFails) return "failed";
      const candidateDigest = `sha256:${createHash("sha256").update('{"route":"qwen"}\n').digest("hex")}`;
      const current = `sha256:${createHash("sha256").update(store.read()).digest("hex")}`;
      const baseline = '{"route":"mellum"}\n';
      const baselineDigest = `sha256:${createHash("sha256").update(baseline).digest("hex")}`;
      if (current === baselineDigest) return "already-baseline";
      if (current !== candidateDigest) return "superseded";
      if (!store.restore(candidateDigest, baseline, { epoch: fenceEpoch, token: fenceToken })) return "failed";
      return `sha256:${createHash("sha256").update(store.read()).digest("hex")}` === baselineDigest ? "restored" : "failed";
    },
    signAndPersistDemotion: ({ targetScopeDigest, journalReceiptDigest }) => {
      opts.onSign?.();
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
      const result = {
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
      if (opts.persistDemotion !== false) {
        snapshot.runtimeNarrowing = structuredClone(result.ledger);
        snapshot.runtimeNarrowingCheckpoint = structuredClone(result.checkpoint);
      }
      return result;
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
    // The watchdog must reconcile an interrupted prepare/apply immediately,
    // not leave an unreceipted candidate active until the absolute deadline.
    authority.setNow("2026-07-26T00:00:01Z");
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
    expect(validateJournalV2Prefix(
      journal,
      synthetic.snapshot.constitution,
      synthetic.snapshot.coverage,
      synthetic.snapshot.attestations,
    )).toMatchObject({ phase: "watch", terminal: false });
    authority.setNow("2026-07-26T01:00:00Z");
    const committed = controller.commit();
    expect(committed.outcome).toBe("committed");
    expect(validateJournalV2(
      committed.journal,
      synthetic.snapshot.constitution,
      synthetic.snapshot.coverage,
      synthetic.snapshot.attestations,
    )).toMatchObject({ terminal: "commit" });
  });

  it("accepts the exact 300 second commit-grace boundary and recovers one second later", () => {
    const commitRoot = mkdtempSync(join(tmpdir(), "constitutional-commit-grace-"));
    const commitSynthetic = syntheticAuthority();
    const commitAuthority = fakeAuthority(commitSynthetic.snapshot);
    const commitTable = fakeStore();
    const commitController = new ConstitutionalRoutingController(
      commitRoot,
      commitTable.store,
      commitAuthority.reader,
      proofVerifier,
      recoveryRegistrar,
    );
    commitController.begin(plan(commitTable, commitSynthetic.snapshot));
    commitAuthority.setNow("2026-07-26T01:05:00Z");
    expect(commitController.commit().outcome).toBe("committed");

    const recoveryRoot = mkdtempSync(join(tmpdir(), "constitutional-missed-grace-"));
    const recoverySynthetic = syntheticAuthority();
    const recoveryAuthority = fakeAuthority(recoverySynthetic.snapshot);
    const recoveryTable = fakeStore();
    const baseline = recoveryTable.read();
    new ConstitutionalRoutingController(
      recoveryRoot,
      recoveryTable.store,
      recoveryAuthority.reader,
      proofVerifier,
      recoveryRegistrar,
    ).begin(plan(recoveryTable, recoverySynthetic.snapshot));
    recoveryAuthority.setNow("2026-07-26T01:05:01Z");
    const result = new ConstitutionalRoutingWatchdog(
      recoveryRoot,
      recoveryAuthority.reader,
      recoveryCapability(
        recoveryTable,
        recoverySynthetic.recoveryPrivateKey,
        recoverySynthetic.authorizationDigest,
        recoverySynthetic.snapshot,
      ),
    ).tick();
    expect(result.outcome).toBe("reverted");
    expect(recoveryTable.read()).toBe(baseline);
  });

  it("reconciles the exact deadline after a failure following the durable commit receipt", () => {
    const root = mkdtempSync(join(tmpdir(), "constitutional-commit-reconcile-"));
    const synthetic = syntheticAuthority();
    const authority = fakeAuthority(synthetic.snapshot);
    const table = fakeStore();
    const controller = new ConstitutionalRoutingController(root, table.store, authority.reader, proofVerifier, recoveryRegistrar);
    controller.begin(plan(table, synthetic.snapshot));
    authority.setNow("2026-07-26T01:00:00Z");
    table.failNextDeadlineClear();
    expect(() => controller.commit()).toThrow(/deadline could not be cleared/);
    const journal = JSON.parse(readConstitutionalResource(constitutionalPaths(root).lock, constitutionalPaths(root).journal)!);
    expect(journal.entries.at(-1).phase).toBe("commit");
    table.allowDeadlineClear();
    expect(controller.commit().outcome).toBe("committed");
  });

  it("reconciles a committed deadline from the watchdog after a controller crash window", () => {
    const root = mkdtempSync(join(tmpdir(), "constitutional-watchdog-commit-reconcile-"));
    const synthetic = syntheticAuthority();
    const authority = fakeAuthority(synthetic.snapshot);
    const table = fakeStore();
    const controller = new ConstitutionalRoutingController(root, table.store, authority.reader, proofVerifier, recoveryRegistrar);
    controller.begin(plan(table, synthetic.snapshot));
    authority.setNow("2026-07-26T01:00:00Z");
    table.failNextDeadlineClear();
    expect(() => controller.commit()).toThrow(/deadline could not be cleared/);
    let clears = 0;
    expect(new ConstitutionalRoutingWatchdog(
      root,
      authority.reader,
      recoveryCapability(table, synthetic.recoveryPrivateKey, synthetic.authorizationDigest, synthetic.snapshot, {
        onClearDeadline: () => { clears += 1; },
      }),
    ).tick()).toMatchObject({ outcome: "noop", reason: "terminal-commit" });
    expect(clears).toBe(1);
  });

  it("keeps a successfully committed real route served when a later watchdog reconciles its already-cleared deadline", () => {
    const root = mkdtempSync(join(tmpdir(), "constitutional-real-commit-reconcile-"));
    const routePath = join(root, "routing.db");
    const baseline = '{"route":"mellum"}\n';
    initializeConstitutionalRouteDatabase(routePath, baseline);
    const routeDb = new ConstitutionalRouteDatabase(routePath);
    const synthetic = syntheticAuthority();
    const authority = fakeAuthority(synthetic.snapshot);
    const table = {
      store: routeDb,
      read: () => routeDb.read(),
      restore: (expected: string, next: string, fence: { epoch: number; token: string }) =>
        routeDb.restoreExact(expected, next, fence),
    } as ReturnType<typeof fakeStore>;
    const controller = new ConstitutionalRoutingController(
      root,
      routeDb,
      authority.reader,
      proofVerifier,
      recoveryRegistrar,
    );
    const mutation = plan(table, synthetic.snapshot);
    expect(controller.begin(mutation).outcome).toBe("watching");
    authority.setNow("2026-07-26T01:00:00Z");
    expect(controller.commit().outcome).toBe("committed");
    expect(readConstitutionalRouteDatabase(routePath)).toBe(mutation.candidate);

    const recovery = recoveryCapability(
      table,
      synthetic.recoveryPrivateKey,
      synthetic.authorizationDigest,
      synthetic.snapshot,
    );
    recovery.clearCandidateDeadline = (candidate, fence) => {
      if (!routeDb.clearCandidateDeadline(candidate, fence)) {
        throw new Error("real committed deadline reconciliation failed");
      }
    };
    recovery.blockRoute = (fence) => { routeDb.block(fence); };

    expect(new ConstitutionalRoutingWatchdog(root, authority.reader, recovery).tick())
      .toMatchObject({ outcome: "noop", reason: "terminal-commit" });
    expect(routeDb.isBlocked()).toBe(false);
    expect(readConstitutionalRouteDatabase(routePath)).toBe(mutation.candidate);
  });

  it("turns a verifier that crosses the 300 second pre-watch budget into immediate recovery", () => {
    const root = mkdtempSync(join(tmpdir(), "constitutional-verify-budget-"));
    const synthetic = syntheticAuthority();
    const authority = fakeAuthority(synthetic.snapshot);
    const table = fakeStore();
    const baseline = table.read();
    const result = new ConstitutionalRoutingController(
      root,
      table.store,
      authority.reader,
      {
        verify: (input) => {
          authority.setNow("2026-07-26T00:05:01Z");
          return proofVerifier.verify(input);
        },
      },
      recoveryRegistrar,
    ).begin(plan(table, synthetic.snapshot));
    expect(result).toMatchObject({ outcome: "unknown", reason: "verify-exceeded-apply-readback-budget" });
    expect(table.read()).not.toBe(baseline);
    expect(new ConstitutionalRoutingWatchdog(
      root,
      authority.reader,
      recoveryCapability(table, synthetic.recoveryPrivateKey, synthetic.authorizationDigest, synthetic.snapshot),
    ).tick().outcome).toBe("reverted");
    expect(table.read()).toBe(baseline);
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
    authority.setNow("2026-07-26T00:00:01Z");
    const watchdog = new ConstitutionalRoutingWatchdog(
      root,
      authority.reader,
      recoveryCapability(table, synthetic.recoveryPrivateKey, synthetic.authorizationDigest, synthetic.snapshot),
      undefined,
      undefined,
      undefined,
      proofVerifier,
    );
    const result = watchdog.tick();
    expect(result.outcome).toBe("reverted");
    expect(table.read()).toBe(baseline);
    expect(result.journal?.entries.map((entry) => entry.phase)).toEqual(["prepare", "unknown", "revert", "disarm"]);
  });

  it.each(["prepare", "apply", "verify"] as const)(
    "recovers an interrupted %s receipt before the deadline instead of treating it as watch",
    (phase) => {
      const root = mkdtempSync(join(tmpdir(), `constitutional-interrupted-${phase}-`));
      const synthetic = syntheticAuthority();
      const authority = fakeAuthority(synthetic.snapshot);
      const table = fakeStore();
      const baseline = table.read();
      new ConstitutionalRoutingController(
        root,
        table.store,
        authority.reader,
        proofVerifier,
        recoveryRegistrar,
      ).begin(plan(table, synthetic.snapshot));
      const paths = constitutionalPaths(root);
      const journal = JSON.parse(readConstitutionalResource(paths.lock, paths.journal)!) as {
        entries: Array<{ phase: string }>;
      };
      const terminalIndex = journal.entries.findIndex((entry) => entry.phase === phase);
      journal.entries = journal.entries.slice(0, terminalIndex + 1);
      const lease = ConstitutionalFencedLease.acquire(paths.lock);
      lease.writeResource(paths.journal, `${canonicalJson(journal)}\n`);
      lease.release();
      authority.setNow("2026-07-26T00:00:01Z");
      const result = new ConstitutionalRoutingWatchdog(
        root,
        authority.reader,
        recoveryCapability(
          table,
          synthetic.recoveryPrivateKey,
          synthetic.authorizationDigest,
          synthetic.snapshot,
        ),
        undefined,
        undefined,
        undefined,
        proofVerifier,
      ).tick();
      expect(result.outcome).toBe("reverted");
      expect(table.read()).toBe(baseline);
      expect(result.journal?.entries.at(-1)?.phase).toBe("disarm");
    },
  );

  it("recovers a kill-STOP during watch after the absolute deadline even when notification is offline", () => {
    const root = mkdtempSync(join(tmpdir(), "constitutional-stop-"));
    const synthetic = syntheticAuthority();
    const authority = fakeAuthority(synthetic.snapshot);
    const table = fakeStore();
    const baseline = table.read();
    const mutation = plan(table, synthetic.snapshot);
    new ConstitutionalRoutingController(root, table.store, authority.reader, proofVerifier, recoveryRegistrar).begin(mutation);
    authority.setNow("2026-07-26T01:10:01Z");
    const watchdog = new ConstitutionalRoutingWatchdog(
      root,
      authority.reader,
      recoveryCapability(table, synthetic.recoveryPrivateKey, synthetic.authorizationDigest, synthetic.snapshot),
      () => { throw new Error("observer offline"); },
    );
    expect(watchdog.tick().outcome).toBe("reverted");
    expect(table.read()).toBe(baseline);
  });

  it("rechecks protected liveness and candidate proof during the watch window", () => {
    const healthyRoot = mkdtempSync(join(tmpdir(), "constitutional-watch-healthy-"));
    const healthySynthetic = syntheticAuthority();
    const healthyAuthority = fakeAuthority(healthySynthetic.snapshot);
    const healthyTable = fakeStore();
    new ConstitutionalRoutingController(
      healthyRoot,
      healthyTable.store,
      healthyAuthority.reader,
      proofVerifier,
      recoveryRegistrar,
    ).begin(plan(healthyTable, healthySynthetic.snapshot));
    let healthyBlocks = 0;
    let healthyClears = 0;
    expect(new ConstitutionalRoutingWatchdog(
      healthyRoot,
      healthyAuthority.reader,
      recoveryCapability(
        healthyTable,
        healthySynthetic.recoveryPrivateKey,
        healthySynthetic.authorizationDigest,
        healthySynthetic.snapshot,
        {
          onBlock: () => { healthyBlocks += 1; },
          onClearBlock: () => { healthyClears += 1; },
        },
      ),
      undefined,
      undefined,
      undefined,
      proofVerifier,
    ).tick().outcome).toBe("waiting");
    expect(healthyBlocks).toBe(0);
    expect(healthyClears).toBe(0);

    const failedRoot = mkdtempSync(join(tmpdir(), "constitutional-watch-failed-"));
    const failedSynthetic = syntheticAuthority();
    const failedAuthority = fakeAuthority(failedSynthetic.snapshot);
    const failedTable = fakeStore();
    const baseline = failedTable.read();
    new ConstitutionalRoutingController(
      failedRoot,
      failedTable.store,
      failedAuthority.reader,
      proofVerifier,
      recoveryRegistrar,
    ).begin(plan(failedTable, failedSynthetic.snapshot));
    failedAuthority.setHealthy(false);
    const result = new ConstitutionalRoutingWatchdog(
      failedRoot,
      failedAuthority.reader,
      recoveryCapability(
        failedTable,
        failedSynthetic.recoveryPrivateKey,
        failedSynthetic.authorizationDigest,
        failedSynthetic.snapshot,
      ),
      undefined,
      undefined,
      undefined,
      proofVerifier,
    ).tick();
    expect(result).toMatchObject({ outcome: "reverted", reason: "baseline-restored-and-target-demoted" });
    expect(failedTable.read()).toBe(baseline);
  });

  it("reconciles only its exact SQLite-owned orphan guard after a crash between block and marker", () => {
    const root = mkdtempSync(join(tmpdir(), "constitutional-owned-orphan-"));
    const routePath = join(root, "routing.db");
    const baseline = '{"route":"mellum"}\n';
    initializeConstitutionalRouteDatabase(routePath, baseline);
    const routeDb = new ConstitutionalRouteDatabase(routePath);
    const synthetic = syntheticAuthority();
    const authority = fakeAuthority(synthetic.snapshot);
    const mutation = { ...plan(fakeStore(), synthetic.snapshot), baseline, candidate: '{"route":"qwen"}\n' };
    new ConstitutionalRoutingController(root, routeDb, authority.reader, proofVerifier, recoveryRegistrar).begin(mutation);
    let held: ReturnType<typeof routeDb.acquireWriterLease> | undefined;
    let crashAfterBlock = true;
    const guardJournal = JSON.parse(readConstitutionalResource(
      constitutionalPaths(root).lock,
      constitutionalPaths(root).journal,
    )!) as any;
    const ownerFor = (journalId: string) => ({
      journalId,
      attemptId: guardJournal.binding.attempt_id,
      bindingDigest: guardJournal.binding_digest,
      targetScopeDigest: guardJournal.binding.target_scope_digest,
      watchdogIdentity: guardJournal.binding.watchdog_identity,
    });
    const recovery: RestoreOnlyCapability = {
      recoveryWorkerIdentity: "micro-route-revert-worker",
      acquireRouteFence: () => {
        held = routeDb.acquireWriterLease();
        return { epoch: held.epoch, token: held.token };
      },
      releaseRouteFence: () => { held?.release(); held = undefined; },
      blockRoute: (fence, journalId) => {
        expect(routeDb.block(fence, journalId === undefined ? undefined : ownerFor(journalId))).toBe(true);
        if (crashAfterBlock) throw new Error("fault-injected crash after serving DB block");
      },
      clearOwnedRouteBlock: (fence, journalId) => routeDb.clearOwnedBlock(fence, ownerFor(journalId)),
      clearCandidateDeadline: () => undefined,
      readRouteDigest: () => `sha256:${createHash("sha256").update(routeDb.read()).digest("hex")}`,
      actuatePreRegisteredRecovery: () => "failed",
      signAndPersistDemotion: () => ({ ledger: {}, registry: {}, checkpoint: {} }),
    };
    authority.setHealthy(false);
    expect(() => new ConstitutionalRoutingWatchdog(root, authority.reader, recovery, undefined, undefined, undefined, proofVerifier).tick())
      .toThrow("fault-injected crash");
    expect(routeDb.isBlocked()).toBe(true);
    expect(readConstitutionalResource(constitutionalPaths(root).lock, constitutionalPaths(root).targetBlock)).toBeUndefined();

    crashAfterBlock = false;
    authority.setHealthy(true);
    expect(new ConstitutionalRoutingWatchdog(root, authority.reader, recovery, undefined, undefined, undefined, proofVerifier).tick())
      .toMatchObject({ outcome: "waiting" });
    expect(routeDb.isBlocked()).toBe(false);
    expect(routeDb.read()).toBe(mutation.candidate);
  });

  it("preserves a foreign SQLite serving guard during an otherwise healthy watch", () => {
    const root = mkdtempSync(join(tmpdir(), "constitutional-foreign-guard-"));
    const routePath = join(root, "routing.db");
    initializeConstitutionalRouteDatabase(routePath, '{"route":"mellum"}\n');
    const routeDb = new ConstitutionalRouteDatabase(routePath);
    const synthetic = syntheticAuthority();
    const authority = fakeAuthority(synthetic.snapshot);
    const mutation = { ...plan(fakeStore(), synthetic.snapshot), baseline: routeDb.read(), candidate: '{"route":"qwen"}\n' };
    new ConstitutionalRoutingController(root, routeDb, authority.reader, proofVerifier, recoveryRegistrar).begin(mutation);
    const foreign = routeDb.acquireWriterLease();
    expect(routeDb.block({ epoch: foreign.epoch, token: foreign.token }, {
      journalId: "other-journal", attemptId: "other-attempt", bindingDigest: `sha256:${"a".repeat(64)}`,
      targetScopeDigest: `sha256:${"b".repeat(64)}`, watchdogIdentity: "other-watchdog",
    })).toBe(true);
    foreign.release();
    let held: ReturnType<typeof routeDb.acquireWriterLease> | undefined;
    const recovery: RestoreOnlyCapability = {
      recoveryWorkerIdentity: "micro-route-revert-worker",
      acquireRouteFence: () => { held = routeDb.acquireWriterLease(); return { epoch: held.epoch, token: held.token }; },
      releaseRouteFence: () => { held?.release(); held = undefined; },
      blockRoute: () => undefined,
      clearOwnedRouteBlock: () => false,
      clearCandidateDeadline: () => undefined, readRouteDigest: () => `sha256:${createHash("sha256").update(routeDb.read()).digest("hex")}`,
      actuatePreRegisteredRecovery: () => "failed", signAndPersistDemotion: () => ({ ledger: {}, registry: {}, checkpoint: {} }),
    };
    expect(new ConstitutionalRoutingWatchdog(root, authority.reader, recovery, undefined, undefined, undefined, proofVerifier).tick())
      .toMatchObject({ outcome: "waiting" });
    expect(routeDb.isBlocked()).toBe(true);
  });

  it("does not clear a serving block it does not own when no journal exists", () => {
    const root = mkdtempSync(join(tmpdir(), "constitutional-no-journal-"));
    const synthetic = syntheticAuthority();
    const authority = fakeAuthority(synthetic.snapshot);
    const table = fakeStore();
    let clears = 0;
    expect(new ConstitutionalRoutingWatchdog(
      root,
      authority.reader,
      recoveryCapability(
        table,
        synthetic.recoveryPrivateKey,
        synthetic.authorizationDigest,
        synthetic.snapshot,
        { onClearBlock: () => { clears += 1; } },
      ),
    ).tick()).toMatchObject({ outcome: "noop", reason: "no-journal" });
    expect(clears).toBe(0);
  });

  it("keeps the target blocked when signer output was not durably persisted", () => {
    const root = mkdtempSync(join(tmpdir(), "constitutional-demotion-durability-"));
    const synthetic = syntheticAuthority();
    const authority = fakeAuthority(synthetic.snapshot);
    const table = fakeStore();
    new ConstitutionalRoutingController(
      root,
      table.store,
      authority.reader,
      proofVerifier,
      recoveryRegistrar,
    ).begin(plan(table, synthetic.snapshot));
    authority.setNow("2026-07-26T01:10:01Z");
    const result = new ConstitutionalRoutingWatchdog(
      root,
      authority.reader,
      recoveryCapability(
        table,
        synthetic.recoveryPrivateKey,
        synthetic.authorizationDigest,
        synthetic.snapshot,
        { persistDemotion: false },
      ),
    ).tick();
    expect(result).toMatchObject({
      outcome: "terminally-blocked",
      reason: expect.stringMatching(/^signed-demotion-failed:/),
    });
    expect(readConstitutionalResource(
      constitutionalPaths(root).lock,
      constitutionalPaths(root).targetBlock,
    )).toBeDefined();
  });

  it("makes a signer failure after revert durably terminal instead of retrying the signer forever", () => {
    const root = mkdtempSync(join(tmpdir(), "constitutional-terminal-signer-"));
    const synthetic = syntheticAuthority();
    const authority = fakeAuthority(synthetic.snapshot);
    const table = fakeStore();
    new ConstitutionalRoutingController(root, table.store, authority.reader, proofVerifier, recoveryRegistrar)
      .begin(plan(table, synthetic.snapshot));
    authority.setNow("2026-07-26T01:10:01Z");
    let signCalls = 0;
    const watchdog = new ConstitutionalRoutingWatchdog(
      root,
      authority.reader,
      recoveryCapability(table, synthetic.recoveryPrivateKey, synthetic.authorizationDigest, synthetic.snapshot, {
        persistDemotion: false,
        onSign: () => { signCalls += 1; },
      }),
    );
    expect(watchdog.tick()).toMatchObject({ outcome: "terminally-blocked", reason: expect.stringMatching(/^signed-demotion-failed:/) });
    expect(signCalls).toBe(1);
    expect(watchdog.tick()).toMatchObject({
      outcome: "terminally-blocked",
      reason: "terminal-owner-reconciliation-required",
    });
    expect(signCalls).toBe(1);
  });

  it("does not retry the signer when a terminal receipt could not be persisted", () => {
    const root = mkdtempSync(join(tmpdir(), "constitutional-terminal-persistence-"));
    const synthetic = syntheticAuthority();
    const authority = fakeAuthority(synthetic.snapshot);
    const table = fakeStore();
    const controller = new ConstitutionalRoutingController(
      root,
      table.store,
      authority.reader,
      proofVerifier,
      recoveryRegistrar,
    );
    controller.begin(plan(table, synthetic.snapshot));
    const paths = constitutionalPaths(root);
    const journal = JSON.parse(readConstitutionalResource(paths.lock, paths.journal)!);
    const lease = ConstitutionalFencedLease.acquire(paths.lock);
    lease.writeResource(paths.targetBlock, `${canonicalJson({
      schema_version: 1,
      target_scope_digest: journal.binding.target_scope_digest,
      binding_digest: journal.binding_digest,
      reason_digest: `sha256:${"8".repeat(64)}`,
      blocked_at: "2026-07-26T01:10:01Z",
      signed_demotion_pending: true,
      terminal_receipt_persistence_pending: true,
    })}\n`);
    lease.release();
    let signCalls = 0;
    expect(new ConstitutionalRoutingWatchdog(
      root,
      authority.reader,
      recoveryCapability(table, synthetic.recoveryPrivateKey, synthetic.authorizationDigest, synthetic.snapshot, {
        onSign: () => { signCalls += 1; },
      }),
    ).tick()).toMatchObject({
      outcome: "terminally-blocked",
      reason: "terminal-owner-reconciliation-required",
    });
    expect(signCalls).toBe(0);
  });

  it("terminally blocks and consumes recovery when exact restore fails", () => {
    const root = mkdtempSync(join(tmpdir(), "constitutional-restore-fail-"));
    const synthetic = syntheticAuthority();
    const authority = fakeAuthority(synthetic.snapshot);
    const table = fakeStore();
    const mutation = plan(table, synthetic.snapshot);
    new ConstitutionalRoutingController(root, table.store, authority.reader, proofVerifier, recoveryRegistrar).begin(mutation);
    authority.setNow("2026-07-26T01:10:01Z");
    const watchdog = new ConstitutionalRoutingWatchdog(
      root,
      authority.reader,
      recoveryCapability(table, synthetic.recoveryPrivateKey, synthetic.authorizationDigest, synthetic.snapshot, { restoreFails: true }),
    );
    expect(watchdog.tick()).toMatchObject({ outcome: "terminally-blocked", reason: "exact-baseline-restore-failed" });
    expect(watchdog.tick()).toMatchObject({
      outcome: "terminally-blocked",
      reason: "terminal-owner-reconciliation-required",
    });
    expect(readConstitutionalResource(
      constitutionalPaths(root).lock,
      constitutionalPaths(root).targetBlock,
    )).toBeDefined();
  });

  it("keeps the real route database fail-closed after failed restore and no-journal reconciliation", () => {
    const root = mkdtempSync(join(tmpdir(), "constitutional-real-restore-fail-"));
    const routePath = join(root, "routing.db");
    const baseline = '{"route":"mellum"}\n';
    initializeConstitutionalRouteDatabase(routePath, baseline);
    const routeDb = new ConstitutionalRouteDatabase(routePath);
    const synthetic = syntheticAuthority();
    const authority = fakeAuthority(synthetic.snapshot);
    const adapter = {
      store: routeDb,
      read: () => routeDb.read(),
      restore: (expected: string, next: string, fence: { epoch: number; token: string }) =>
        routeDb.restoreExact(expected, next, fence),
    } as ReturnType<typeof fakeStore>;
    const mutation = plan(adapter, synthetic.snapshot);
    new ConstitutionalRoutingController(
      root,
      routeDb,
      authority.reader,
      proofVerifier,
      recoveryRegistrar,
    ).begin(mutation);
    authority.setNow("2026-07-26T01:10:01Z");
    const recovery = recoveryCapability(
      adapter,
      synthetic.recoveryPrivateKey,
      synthetic.authorizationDigest,
      synthetic.snapshot,
      { restoreFails: true },
    );
    recovery.blockRoute = (fence) => { routeDb.block(fence); };
    const watchdog = new ConstitutionalRoutingWatchdog(root, authority.reader, recovery);

    expect(watchdog.tick()).toMatchObject({
      outcome: "terminally-blocked",
      reason: "exact-baseline-restore-failed",
    });
    expect(routeDb.isBlocked()).toBe(true);
    expect(() => readConstitutionalRouteDatabase(routePath)).toThrow(ConstitutionalRouteBlockedError);

    expect(watchdog.tick()).toMatchObject({
      outcome: "terminally-blocked",
      reason: "terminal-owner-reconciliation-required",
    });
    expect(routeDb.isBlocked()).toBe(true);
    expect(() => readConstitutionalRouteDatabase(routePath)).toThrow(ConstitutionalRouteBlockedError);

    const paths = constitutionalPaths(root);
    const lease = ConstitutionalFencedLease.acquire(paths.lock);
    lease.removeResource(paths.journal);
    lease.release();
    expect(watchdog.tick()).toMatchObject({
      outcome: "terminally-blocked",
      reason: "durable-target-block-without-journal",
    });
    expect(routeDb.isBlocked()).toBe(true);
    expect(() => readConstitutionalRouteDatabase(routePath)).toThrow(ConstitutionalRouteBlockedError);
  });

  it.each([
    ["coverage constitution binding", (coverage: any) => {
      coverage.constitution_digest = `sha256:${"0".repeat(64)}`;
    }],
    ["canonical domain registry", (coverage: any) => {
      coverage.domains.pop();
    }],
    ["unique canonical domain registry", (coverage: any) => {
      const protectedRow = structuredClone(
        coverage.domains.find((candidate: any) => candidate.domain === "credentials-and-auth"),
      );
      protectedRow.coverage = "armed-canary";
      protectedRow.target_state = "armed-canary";
      protectedRow.bindings = [structuredClone(coverage.domains[0].bindings[0])];
      coverage.domains.push(protectedRow);
    }],
    ["protected lane required levels", (coverage: any) => {
      const row = coverage.domains.find((candidate: any) => candidate.domain === "credentials-and-auth");
      row.required_for_levels = ["L4"];
    }],
    ["protected lane owner scope", (coverage: any) => {
      const row = coverage.domains.find((candidate: any) => candidate.domain === "credentials-and-auth");
      row.owner_scope = "fixed-component";
    }],
    ["protected lane owner", (coverage: any) => {
      const row = coverage.domains.find((candidate: any) => candidate.domain === "credentials-and-auth");
      row.owner = "gille-inference";
    }],
    ["protected lane recovery class", (coverage: any) => {
      const row = coverage.domains.find((candidate: any) => candidate.domain === "credentials-and-auth");
      row.recovery_class = "R-exact";
    }],
    ["protected lane coverage", (coverage: any) => {
      const row = coverage.domains.find((candidate: any) => candidate.domain === "credentials-and-auth");
      row.coverage = "shadow";
    }],
    ["protected lane target state", (coverage: any) => {
      const row = coverage.domains.find((candidate: any) => candidate.domain === "credentials-and-auth");
      row.target_state = "armed-canary";
    }],
    ["protected lane bindings", (coverage: any) => {
      const row = coverage.domains.find((candidate: any) => candidate.domain === "credentials-and-auth");
      row.bindings = [structuredClone(coverage.domains[0].bindings[0])];
    }],
    ["mutation policy", (coverage: any) => {
      coverage.mutation_policy = "recovery-worker-may-widen";
    }],
  ])("rejects owner-resigned v2 coverage that violates the %s", (_label, mutate) => {
    const root = mkdtempSync(join(tmpdir(), "constitutional-invalid-v2-coverage-"));
    const synthetic = syntheticAuthority();
    const coverage = structuredClone(synthetic.snapshot.coverage) as any;
    mutate(coverage);
    coverage.registry_digest = digestJson(coverage, "registry_digest");
    synthetic.snapshot.coverage = coverage;
    resignSnapshot(synthetic.snapshot, synthetic.ownerPrivateKey);
    const authority = fakeAuthority(synthetic.snapshot);
    const table = fakeStore();
    expect(() => new ConstitutionalRoutingController(
      root,
      table.store,
      authority.reader,
      proofVerifier,
      recoveryRegistrar,
    ).begin(plan(table, synthetic.snapshot))).toThrow(/coverage|constitution|protected|mutation|domain/i);
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

  it("refuses commit after unreadable recovery input durably blocks the target, even if controller-owned material is repaired", () => {
    const root = mkdtempSync(join(tmpdir(), "constitutional-blocked-commit-"));
    const synthetic = syntheticAuthority();
    const authority = fakeAuthority(synthetic.snapshot);
    const table = fakeStore();
    const controller = new ConstitutionalRoutingController(
      root,
      table.store,
      authority.reader,
      proofVerifier,
      recoveryRegistrar,
    );
    controller.begin(plan(table, synthetic.snapshot));
    const paths = constitutionalPaths(root);
    const material = readConstitutionalResource(paths.lock, paths.recoveryMaterial)!;
    const corruptor = ConstitutionalFencedLease.acquire(paths.lock);
    corruptor.writeResource(paths.recoveryMaterial, "{broken");
    corruptor.release();

    expect(new ConstitutionalRoutingWatchdog(
      root,
      authority.reader,
      recoveryCapability(table, synthetic.recoveryPrivateKey, synthetic.authorizationDigest, synthetic.snapshot),
    ).tick()).toMatchObject({
      outcome: "terminally-blocked",
      reason: expect.stringMatching(/^recovery-input-unreadable:/),
    });

    const repairer = ConstitutionalFencedLease.acquire(paths.lock);
    repairer.writeResource(paths.recoveryMaterial, material);
    repairer.release();
    authority.setNow("2026-07-26T01:00:00Z");
    expect(() => controller.commit()).toThrow(/persistently blocked pending signed demotion reconciliation/);
    const journal = JSON.parse(readConstitutionalResource(paths.lock, paths.journal)!);
    expect(journal.entries.at(-1).phase).toBe("watch");
    expect(JSON.parse(readConstitutionalResource(paths.lock, paths.targetBlock)!))
      .toMatchObject({ signed_demotion_pending: true });
  });

  it.each(["commit", "disarm"] as const)(
    "does not clear a serving block during terminal %s reconciliation while signed demotion remains pending",
    (terminal) => {
      const root = mkdtempSync(join(tmpdir(), `constitutional-terminal-${terminal}-block-`));
      const synthetic = syntheticAuthority();
      const authority = fakeAuthority(synthetic.snapshot);
      const table = fakeStore();
      const controller = new ConstitutionalRoutingController(
        root,
        table.store,
        authority.reader,
        proofVerifier,
        recoveryRegistrar,
      );
      controller.begin(plan(table, synthetic.snapshot));
      if (terminal === "commit") {
        authority.setNow("2026-07-26T01:00:00Z");
        expect(controller.commit().outcome).toBe("committed");
      } else {
        authority.setNow("2026-07-26T01:10:01Z");
        expect(new ConstitutionalRoutingWatchdog(
          root,
          authority.reader,
          recoveryCapability(table, synthetic.recoveryPrivateKey, synthetic.authorizationDigest, synthetic.snapshot),
        ).tick().outcome).toBe("reverted");
      }

      const paths = constitutionalPaths(root);
      const journal = JSON.parse(readConstitutionalResource(paths.lock, paths.journal)!);
      const marker = {
        schema_version: 1,
        target_scope_digest: journal.binding.target_scope_digest,
        binding_digest: journal.binding_digest,
        reason_digest: `sha256:${"8".repeat(64)}`,
        blocked_at: "2026-07-26T01:10:02Z",
        signed_demotion_pending: true,
      };
      const blocker = ConstitutionalFencedLease.acquire(paths.lock);
      blocker.writeResource(paths.targetBlock, `${canonicalJson(marker)}\n`);
      blocker.release();
      let blocks = 0;
      let clears = 0;
      const result = new ConstitutionalRoutingWatchdog(
        root,
        authority.reader,
        recoveryCapability(
          table,
          synthetic.recoveryPrivateKey,
          synthetic.authorizationDigest,
          synthetic.snapshot,
          {
            onBlock: () => { blocks += 1; },
            onClearBlock: () => { clears += 1; },
          },
        ),
      ).tick();
      expect(result).toMatchObject({
        outcome: "terminally-blocked",
        reason: "terminal-owner-reconciliation-required",
      });
      expect(blocks).toBe(1);
      expect(clears).toBe(0);
      expect(JSON.parse(readConstitutionalResource(paths.lock, paths.targetBlock)!))
        .toEqual(marker);
    },
  );

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
