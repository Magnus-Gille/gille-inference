#!/usr/bin/env tsx
/**
 * Production composition root for ADR-008 micro-routing mutation/recovery.
 *
 * It is intentionally inert unless an explicit, owner-installed protected
 * authority config is supplied. The repository ships no key, live
 * authorization, recovery signer, or arming state.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir, uptime } from "node:os";
import { isAbsolute, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ConstitutionalRoutingController,
  ConstitutionalRoutingWatchdog,
  MICRO_ROUTING_CONSTITUTIONAL_POLICY,
  constitutionalPaths,
  type AuthoritySnapshot,
  type ConstitutionalRouteStore,
  type ProtectedAuthorityReader,
  type RecoveryRegistrar,
  type RestoreOnlyCapability,
  type RouteMutationPlan,
} from "../src/homeserver/constitutional-routing-controller.js";
import {
  composeImmutablePlan,
  parseRouteMutationProposal,
  persistImmutablePlan,
  removeExpiredImmutablePlan,
} from "../src/homeserver/constitutional-routing-scheduler.js";
import {
  constitutionalResourceExists,
  readConstitutionalResource,
} from "../src/homeserver/constitutional-fenced-lease.js";

export interface AuthorityConfig {
  schema_version: 1;
  authorization_path: string;
  constitution_path: string;
  coverage_path: string;
  owner_attestations_path: string;
  recovery_registry_path: string;
  pinned_owner_public_key_path: string;
  authorization_checkpoint_path: string;
  runtime_narrowing_path: string;
  runtime_narrowing_checkpoint_path: string;
  kill_switch_path: string;
  liveness_path: string;
  current_digests_path: string;
  clock_health_path: string;
  verifier_bin: string;
  canonical_state_dir: string;
  canonical_route_table_path: string;
  canonical_plan_path: string;
}
export const PRODUCTION_AUTHORITY_CONFIG = "/etc/gille-inference/autonomy/authority-config.json";
export const PRODUCTION_STATE_DIR = "/var/lib/gille-inference/autonomy";
export const PRODUCTION_ROUTE_TABLE = "/var/lib/gille-inference/routing/m5-routing.db";
export const PRODUCTION_PLAN = "/var/lib/gille-inference/autonomy/immutable-plan.json";
export const PRODUCTION_PROPOSAL = "/var/lib/gille-inference/proposals/micro-routing.json";
export const RECOVERY_REGISTRATION_SOCKET = "/run/gille-inference/autonomy/recovery-register.sock";
export const RECOVERY_ACTION_SOCKET = "/run/gille-inference/autonomy/recovery-action.sock";

function readFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

export function boundedProtectedRead(path: string, maxBytes = 1_000_000, requiredUid?: number): string {
  const checked = protectedPath(path, requiredUid);
  const before = lstatSync(checked);
  const fd = openSync(checked, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!sameOpenedInode(before, stat)) throw new Error(`protected input changed during open: ${path}`);
    if (!stat.isFile() || stat.size > maxBytes) throw new Error(`protected input is not a bounded regular file: ${path}`);
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

export function sameOpenedInode(before: { dev: number | bigint; ino: number | bigint }, opened: { dev: number | bigint; ino: number | bigint }): boolean {
  return before.dev === opened.dev && before.ino === opened.ino;
}

export function protectedPath(path: string, requiredUid?: number): string {
  if (!isAbsolute(path)) throw new Error(`protected path must be absolute: ${path}`);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`protected path must not be a symlink: ${path}`);
  if ((stat.mode & 0o022) !== 0) throw new Error(`protected path is group/world writable: ${path}`);
  const allowedUids = requiredUid === undefined
    ? new Set([0, ...(typeof process.getuid === "function" ? [process.getuid()] : [])])
    : new Set([requiredUid]);
  if (!allowedUids.has(stat.uid)) throw new Error(`protected path has an unexpected owner: ${path}`);
  let parent = dirname(path);
  while (parent !== dirname(parent)) {
    const parentStat = lstatSync(parent);
    if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) throw new Error(`protected parent is not a real directory: ${parent}`);
    if ((parentStat.mode & 0o022) !== 0 || !allowedUids.has(parentStat.uid)) {
      throw new Error(`protected parent is writable or unexpectedly owned: ${parent}`);
    }
    parent = dirname(parent);
  }
  return path;
}

function exactKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

export function loadAuthorityConfig(path: string): AuthorityConfig {
  const config = JSON.parse(boundedProtectedRead(protectedPath(resolve(path), 0), 64_000, 0)) as unknown;
  const keys = [
    "schema_version",
    "authorization_path",
    "constitution_path",
    "coverage_path",
    "owner_attestations_path",
    "recovery_registry_path",
    "pinned_owner_public_key_path",
    "authorization_checkpoint_path",
    "runtime_narrowing_path",
    "runtime_narrowing_checkpoint_path",
    "kill_switch_path",
    "liveness_path",
    "current_digests_path",
    "clock_health_path",
    "verifier_bin",
    "canonical_state_dir",
    "canonical_route_table_path",
    "canonical_plan_path",
  ];
  if (!exactKeys(config, keys) || config.schema_version !== 1) throw new Error("invalid closed authority config");
  for (const key of keys.slice(1).filter((key) => !key.startsWith("canonical_"))) {
    const value = config[key];
    if (typeof value !== "string") throw new Error(`authority config ${key} must be a path`);
    if (!resolve(value).startsWith("/etc/gille-inference/autonomy/")) {
      throw new Error(`authority config ${key} must stay below the protected root`);
    }
    protectedPath(value, 0);
  }
  if (
    config.canonical_state_dir !== PRODUCTION_STATE_DIR
    || config.canonical_route_table_path !== PRODUCTION_ROUTE_TABLE
    || config.canonical_plan_path !== PRODUCTION_PLAN
  ) throw new Error("authority config canonical target paths do not match the compiled production roots");
  return config as unknown as AuthorityConfig;
}

function json(path: string): unknown {
  return JSON.parse(boundedProtectedRead(protectedPath(path, 0), 1_000_000, 0)) as unknown;
}

interface ProtectedFreshnessRecord {
  observed_at: string;
  boot_id: string;
  monotonic_ns: string;
  digest: string;
}

function currentBootId(): string {
  return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
}

function currentMonotonicNs(): bigint {
  return BigInt(Math.floor(uptime() * 1_000_000_000));
}

export function verifiedFreshness(
  value: unknown,
  extraKeys: string[],
  unsigned: Record<string, unknown>,
  nowMs = Date.now(),
  bootId = currentBootId(),
  monotonicNs = currentMonotonicNs(),
): asserts value is ProtectedFreshnessRecord {
  const keys = ["observed_at", "boot_id", "monotonic_ns", "digest", ...extraKeys];
  if (!exactKeys(value, keys)) throw new Error("invalid closed protected freshness record");
  const record = value as Record<string, unknown>;
  if (
    typeof record.observed_at !== "string"
    || typeof record.boot_id !== "string"
    || typeof record.monotonic_ns !== "string"
    || typeof record.digest !== "string"
    || !/^\d+$/.test(record.monotonic_ns)
  ) throw new Error("invalid protected freshness fields");
  const observedMs = Date.parse(record.observed_at);
  const observedMonotonic = BigInt(record.monotonic_ns);
  const expected = `sha256:${createHash("sha256").update(JSON.stringify(unsigned)).digest("hex")}`;
  if (
    !Number.isFinite(observedMs)
    || observedMs > nowMs + 1_000
    || nowMs - observedMs > 900_000
    || record.boot_id !== bootId
    || observedMonotonic > monotonicNs
    || monotonicNs - observedMonotonic > 900_000_000_000n
    || record.digest !== expected
  ) throw new Error("protected freshness record is replayed, future-dated, cross-boot, or stale");
}

function authorityReader(config: AuthorityConfig): ProtectedAuthorityReader {
  return {
    read: (): AuthoritySnapshot => ({
      authorization: json(config.authorization_path),
      constitution: json(config.constitution_path),
      coverage: json(config.coverage_path),
      attestations: json(config.owner_attestations_path),
      recoveryRegistry: json(config.recovery_registry_path),
      pinnedOwnerPublicKeyPem: boundedProtectedRead(protectedPath(config.pinned_owner_public_key_path, 0), 64_000, 0),
      checkpoint: json(config.authorization_checkpoint_path),
      runtimeNarrowing: json(config.runtime_narrowing_path),
      runtimeNarrowingCheckpoint: json(config.runtime_narrowing_checkpoint_path),
    }),
    killSwitchActive: () => {
      try {
        const value = json(config.kill_switch_path);
        return !exactKeys(value, ["active"]) || typeof value.active !== "boolean" || value.active;
      } catch {
        return true;
      }
    },
    trustedNowIso: () => {
      const value = json(config.clock_health_path);
      const record = value as Record<string, unknown>;
      if (
        record.synchronized !== true
        || typeof record.max_error_ms !== "number"
        || record.max_error_ms < 0
        || record.max_error_ms > 1_000
      ) {
        throw new Error("invalid or unsynchronized protected clock-health record");
      }
      verifiedFreshness(value, ["synchronized", "max_error_ms"], {
        observed_at: record.observed_at,
        boot_id: record.boot_id,
        monotonic_ns: record.monotonic_ns,
        synchronized: record.synchronized,
        max_error_ms: record.max_error_ms,
      });
      // Time advances independently of controller-writable files. ProtectClock
      // on every consumer unit prevents those identities from setting it.
      return new Date(Math.floor(Date.now() / 1000) * 1000).toISOString().replace(".000Z", "Z");
    },
    liveness: () => {
      const value = json(config.liveness_path);
      const record = value as Record<string, unknown>;
      if (typeof record.healthy !== "boolean") {
        throw new Error("invalid closed protected liveness record");
      }
      verifiedFreshness(value, ["healthy"], {
        healthy: record.healthy,
        observed_at: record.observed_at,
        boot_id: record.boot_id,
        monotonic_ns: record.monotonic_ns,
      });
      return { healthy: record.healthy, observedAt: String(record.observed_at), digest: String(record.digest) };
    },
    currentDigests: () => {
      const value = json(config.current_digests_path);
      if (!exactKeys(value, ["config", "evidence", "policy", "postconditions"]) || Object.values(value).some((entry) => typeof entry !== "string")) {
        throw new Error("invalid closed protected current-digests record");
      }
      return value as unknown as { config: string; evidence: string; policy: string; postconditions: string };
    },
  };
}

function atomicWrite(path: string, value: string): void {
  const temporary = `${path}.${process.pid}.tmp`;
  const fd = openSync(temporary, "wx", 0o660);
  try {
    writeFileSync(fd, value, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  const directory = openSync(dirname(path), "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

function boundedTargetRead(path: string, maxBytes = 1_000_000): string {
  const before = lstatSync(path);
  if (before.isSymbolicLink() || !before.isFile() || before.size > maxBytes) {
    throw new Error(`target is not a bounded regular file: ${path}`);
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (!sameOpenedInode(before, opened)) throw new Error(`target changed during open: ${path}`);
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

export function runJsonBin(path: string, input: unknown): any {
  const checked = protectedPath(path);
  const before = lstatSync(checked);
  const fd = openSync(checked, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (
      !sameOpenedInode(before, opened)
      || !opened.isFile()
      || (opened.mode & 0o111) === 0
    ) {
      throw new Error(`protected helper changed during open or is not executable: ${path}`);
    }
    const stdout = execFileSync("/dev/fd/3", [], {
      input: `${JSON.stringify(input)}\n`,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 1_000_000,
      stdio: ["pipe", "pipe", "inherit", fd],
    });
    return JSON.parse(stdout) as unknown;
  } finally {
    closeSync(fd);
  }
}

export function assertProtectedExecutable(path: string, requiredUid?: number): void {
  const checked = protectedPath(path, requiredUid);
  const before = lstatSync(checked);
  const fd = openSync(checked, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (
      !sameOpenedInode(before, opened)
      || !opened.isFile()
      || opened.size > 1_000_000
      || (opened.mode & 0o111) === 0
    ) {
      throw new Error(`recovery signer is not a bounded regular executable: ${path}`);
    }
  } finally {
    closeSync(fd);
  }
}

export function assertRecoverySignerReady(path: string, requiredUid?: number): void {
  assertProtectedExecutable(path, requiredUid);
  let result: unknown;
  try {
    result = runJsonBin(path, {
      kind: "constitutional-recovery-signer-readiness",
      schema_version: 1,
    });
  } catch (error) {
    throw new Error(`recovery signer readiness failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (
    !exactKeys(result, ["kind", "schema_version", "ready"])
    || result.kind !== "constitutional-recovery-signer-readiness"
    || result.schema_version !== 1
    || result.ready !== true
  ) {
    throw new Error("recovery signer readiness returned an invalid closed response");
  }
}

export type RecoverySocketEndpoint =
  | "/register"
  | "/actuate"
  | "/demote"
  | "/fence/acquire"
  | "/fence/release"
  | "/route/read"
  | "/route/fence/acquire"
  | "/route/fence/release"
  | "/route/apply"
  | "/route/block"
  | "/route/unblock"
  | "/route/digest";

export type UnixJsonTransport = (
  socket: string,
  endpoint: RecoverySocketEndpoint,
  input: unknown,
) => any;

export function runUnixJson(
  socket: string,
  endpoint: RecoverySocketEndpoint,
  input: unknown,
): any {
  const stdout = execFileSync("/usr/bin/curl", [
    "--fail-with-body",
    "--silent",
    "--show-error",
    "--max-time", "30",
    "--unix-socket", socket,
    "-H", "content-type: application/json",
    "--data-binary", JSON.stringify(input),
    `http://localhost${endpoint}`,
  ], { encoding: "utf8", timeout: 35_000, maxBuffer: 1_000_000 });
  return JSON.parse(stdout) as unknown;
}

export function createControllerRecoverySocketClient(
  socket = RECOVERY_REGISTRATION_SOCKET,
  transport: UnixJsonTransport = runUnixJson,
): {
  store: ConstitutionalRouteStore;
  recoveryRegistrar: RecoveryRegistrar;
  activeRegistration(): {
    handle: string;
    journalId: string;
    bindingDigest: string;
    targetScopeDigest: string;
  } | undefined;
} {
  let activeRegistration: {
    handle: string;
    journalId: string;
    bindingDigest: string;
    targetScopeDigest: string;
  } | undefined;
  const store: ConstitutionalRouteStore = {
    read: (): string => {
      const result = transport(socket, "/route/read", {});
      if (!exactKeys(result, ["value"]) || typeof result.value !== "string") {
        throw new Error("route service returned an invalid closed read");
      }
      return result.value;
    },
    acquireWriterLease: () => {
      const acquired = transport(socket, "/route/fence/acquire", {});
      if (!exactKeys(acquired, ["epoch", "token"])) {
        throw new Error("route service returned an invalid controller fence");
      }
      const fence = { epoch: Number(acquired.epoch), token: String(acquired.token) };
      return {
        ...fence,
        release: () => {
          const released = transport(socket, "/route/fence/release", fence);
          if (!exactKeys(released, ["released"]) || released.released !== true) {
            throw new Error("route service refused the controller fence release");
          }
        },
      };
    },
    compareAndSwap: (_expected: string, next: string, fence: { epoch: number; token: string }): boolean => {
      if (!activeRegistration) throw new Error("route apply requires durable recovery preregistration");
      const result = transport(socket, "/route/apply", {
        ...activeRegistration,
        candidate: next,
        fenceEpoch: fence.epoch,
        fenceToken: fence.token,
      });
      if (!exactKeys(result, ["applied"]) || typeof result.applied !== "boolean") {
        throw new Error("route service returned an invalid closed apply result");
      }
      return result.applied;
    },
    clearCandidateDeadline: (candidate, fence): boolean => {
      const result = transport(socket, "/route/promote", { ...candidate, ...fence });
      if (!exactKeys(result, ["promoted"]) || typeof result.promoted !== "boolean") {
        throw new Error("route service returned an invalid closed promotion result");
      }
      return result.promoted;
    },
  };
  const recoveryRegistrar: RecoveryRegistrar = {
    registerPreRecovery: (input) => {
      const { baseline: _baseline, ...closedRequest } = input;
      const result = transport(socket, "/register", closedRequest);
      if (!exactKeys(result, ["handle", "registrationDigest"])) {
        throw new Error("recovery registration service returned an invalid closed receipt");
      }
      activeRegistration = {
        handle: String(result.handle),
        journalId: input.journalId,
        bindingDigest: input.bindingDigest,
        targetScopeDigest: input.targetScopeDigest,
      };
      return { handle: activeRegistration.handle, registrationDigest: String(result.registrationDigest) };
    },
  };
  return {
    store,
    recoveryRegistrar,
    activeRegistration: () => activeRegistration === undefined
      ? undefined
      : structuredClone(activeRegistration),
  };
}

export function createWatchdogRecoverySocketClient(
  socket = RECOVERY_ACTION_SOCKET,
  transport: UnixJsonTransport = runUnixJson,
): RestoreOnlyCapability {
  return {
    recoveryWorkerIdentity: "micro-route-revert-worker",
    acquireRouteFence: () => {
      const result = transport(socket, "/fence/acquire", {});
      if (!exactKeys(result, ["epoch", "token"])) throw new Error("recovery service returned an invalid route fence");
      return { epoch: Number(result.epoch), token: String(result.token) };
    },
    releaseRouteFence: (fence) => {
      const result = transport(socket, "/fence/release", fence);
      if (!exactKeys(result, ["released"]) || result.released !== true) {
        throw new Error("recovery service refused the route-fence release");
      }
    },
    blockRoute: (fence) => {
      const result = transport(socket, "/route/block", fence);
      if (!exactKeys(result, ["changed"]) || result.changed !== true) {
        throw new Error("recovery service refused the route block");
      }
    },
    clearRouteBlock: (fence) => {
      const result = transport(socket, "/route/unblock", fence);
      if (!exactKeys(result, ["changed"]) || result.changed !== true) {
        throw new Error("recovery service refused the route unblock");
      }
    },
    clearCandidateDeadline: (candidate, fence) => {
      const result = transport(socket, "/route/promote", { ...candidate, ...fence });
      if (!exactKeys(result, ["promoted"]) || result.promoted !== true) {
        throw new Error("recovery service refused committed deadline reconciliation");
      }
    },
    readRouteDigest: (fence) => {
      const result = transport(socket, "/route/digest", fence);
      if (!exactKeys(result, ["digest"]) || !/^sha256:[a-f0-9]{64}$/.test(String(result.digest))) {
        throw new Error("recovery service returned an invalid route digest");
      }
      return String(result.digest);
    },
    actuatePreRegisteredRecovery: (input) => {
      const result = transport(socket, "/actuate", input);
      if (!exactKeys(result, ["classification", "registrationDigest"])) {
        throw new Error("recovery action service returned an invalid closed result");
      }
      return ["restored", "already-baseline", "superseded", "failed"].includes(String(result.classification))
        ? result.classification
        : "failed";
    },
    signAndPersistDemotion: (input) => {
      const result = transport(socket, "/demote", input);
      if (!exactKeys(result, ["ledger", "registry", "checkpoint"])) {
        throw new Error("recovery signer returned an invalid closed response");
      }
      return result as unknown as { ledger: unknown; registry: unknown; checkpoint: unknown };
    },
  };
}

export async function run(args: string[]): Promise<number> {
  const command = args[0];
  if (!["controller", "begin", "commit", "watchdog"].includes(command ?? "")) {
    process.stderr.write("usage: constitutional-routing-cli.ts controller|begin|commit|watchdog\n");
    return 2;
  }
  const configPath = resolveAuthorityConfigPath(args, process.env["GILLE_AUTONOMY_AUTHORITY_CONFIG"]);
  if (readFlag(args, "--data-dir") || readFlag(args, "--table") || readFlag(args, "--plan")) {
    throw new Error("production target/state/plan paths are fixed; arbitrary path flags are refused");
  }
  const config = loadAuthorityConfig(configPath);
  const dataDir = PRODUCTION_STATE_DIR;
  const authority = authorityReader(config);
  const controllerSocket = createControllerRecoverySocketClient();
  const store = controllerSocket.store;
  const verifier = { verify: (verificationInput: {
    configDigest: string;
    evidenceDigest: string;
    policyDigest: string;
    candidateDigest: string;
    postconditionsDigest: string;
  }) => {
    const result = runJsonBin(config.verifier_bin, {
      kind: "constitutional-micro-route-verify",
      candidate_digest: verificationInput.candidateDigest,
      config_digest: verificationInput.configDigest,
      evidence_digest: verificationInput.evidenceDigest,
      policy_digest: verificationInput.policyDigest,
      postconditions_digest: verificationInput.postconditionsDigest,
    });
    if (!exactKeys(result, ["ok", "candidate_digest", "postconditions_digest", "proof_digest"])) {
      throw new Error("verifier returned an invalid closed proof");
    }
    return {
      ok: result.ok === true,
      candidateDigest: String(result.candidate_digest),
      postconditionsDigest: String(result.postconditions_digest),
      proofDigest: String(result.proof_digest),
    };
  } };
    if (command === "controller" || command === "begin" || command === "commit") {
      const recoveryRegistrar = controllerSocket.recoveryRegistrar;
      const controller = new ConstitutionalRoutingController(dataDir, store, authority, verifier, recoveryRegistrar);
      let operation: "begin" | "commit" = command === "commit" ? "commit" : "begin";
      let plan: RouteMutationPlan | undefined;
      if (command === "controller") {
        const paths = constitutionalPaths(dataDir);
        if (constitutionalResourceExists(paths.lock, paths.journal)) {
          const journal = JSON.parse(readConstitutionalResource(paths.lock, paths.journal)!) as { entries?: Array<{ phase?: string; recorded_at?: string }> };
          const phase = journal.entries?.at(-1)?.phase;
          if (phase !== "watch") {
            process.stdout.write(`${JSON.stringify({ outcome: "noop", reason: `journal-${phase ?? "invalid"}-awaits-watchdog-or-owner` })}\n`);
            return 0;
          }
          const watchReceipt = journal.entries?.find((entry) => entry.phase === "watch");
          const watchStartedAt = Date.parse(String(watchReceipt?.recorded_at));
          if (!Number.isFinite(watchStartedAt)) throw new Error("durable watch receipt is missing or invalid");
          if (Date.parse(authority.trustedNowIso()) < watchStartedAt + MICRO_ROUTING_CONSTITUTIONAL_POLICY.minimumWatchSeconds * 1000) {
            process.stdout.write(`${JSON.stringify({ outcome: "waiting", reason: "watch-window-active" })}\n`);
            return 0;
          }
          operation = "commit";
        } else {
          operation = "begin";
          removeExpiredImmutablePlan(PRODUCTION_PLAN, authority.trustedNowIso());
          if (!existsSync(PRODUCTION_PLAN)) {
            const proposal = parseRouteMutationProposal(JSON.parse(boundedProtectedRead(PRODUCTION_PROPOSAL)));
            persistImmutablePlan(PRODUCTION_PLAN, composeImmutablePlan(
              proposal,
              store.read(),
              authority.read(),
              authority.trustedNowIso(),
            ));
          }
        }
      }
      if (operation === "begin") plan = JSON.parse(boundedTargetRead(PRODUCTION_PLAN)) as RouteMutationPlan;
      const result = operation === "begin" ? controller.begin(plan!) : controller.commit();
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return result.outcome === "unknown" ? 3 : 0;
  }

  const recovery = createWatchdogRecoverySocketClient();
  const watchdog = new ConstitutionalRoutingWatchdog(
    dataDir,
    authority,
    recovery,
    () => undefined,
    undefined,
    undefined,
    verifier,
  );
  const result = watchdog.tick();
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result.outcome === "terminally-blocked" ? 3 : 0;
}

export function resolveAuthorityConfigPath(args: string[], configuredPath?: string, _home = homedir()): string {
  if (readFlag(args, "--authority-config")) throw new Error("production authority config path is fixed; arbitrary --authority-config is refused");
  const fixed = PRODUCTION_AUTHORITY_CONFIG;
  if (configuredPath && resolve(configuredPath) !== fixed) throw new Error("authority config substitution is refused");
  return fixed;
}

function contentSha(value: string): string {
  // Kept local to avoid another authority-affecting serialization helper.
  return createHash("sha256").update(value).digest("hex");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 2;
    });
}
