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
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ConstitutionalRoutingController,
  ConstitutionalRoutingWatchdog,
  type AuthoritySnapshot,
  type ProtectedAuthorityReader,
  type RestoreOnlyCapability,
  type RouteMutationPlan,
} from "../src/homeserver/constitutional-routing-controller.js";
import { acquireMutationLock, fencedWrite } from "../src/homeserver/mutation-lock.js";

interface AuthorityConfig {
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
  recovery_signer_bin: string;
}

function readFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

export function boundedProtectedRead(path: string, maxBytes = 1_000_000): string {
  const checked = protectedPath(path);
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

export function protectedPath(path: string): string {
  if (!isAbsolute(path)) throw new Error(`protected path must be absolute: ${path}`);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`protected path must not be a symlink: ${path}`);
  if ((stat.mode & 0o022) !== 0) throw new Error(`protected path is group/world writable: ${path}`);
  const allowedUids = new Set([0, ...(typeof process.getuid === "function" ? [process.getuid()] : [])]);
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

function loadConfig(path: string): AuthorityConfig {
  const config = JSON.parse(boundedProtectedRead(protectedPath(resolve(path)), 64_000)) as unknown;
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
    "recovery_signer_bin",
  ];
  if (!exactKeys(config, keys) || config.schema_version !== 1) throw new Error("invalid closed authority config");
  for (const key of keys.slice(1)) {
    const value = config[key];
    if (typeof value !== "string") throw new Error(`authority config ${key} must be a path`);
    protectedPath(value);
  }
  return config as unknown as AuthorityConfig;
}

function json(path: string): unknown {
  return JSON.parse(boundedProtectedRead(protectedPath(path))) as unknown;
}

function authorityReader(config: AuthorityConfig): ProtectedAuthorityReader {
  return {
    read: (): AuthoritySnapshot => ({
      authorization: json(config.authorization_path),
      constitution: json(config.constitution_path),
      coverage: json(config.coverage_path),
      attestations: json(config.owner_attestations_path),
      recoveryRegistry: json(config.recovery_registry_path),
      pinnedOwnerPublicKeyPem: boundedProtectedRead(protectedPath(config.pinned_owner_public_key_path), 64_000),
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
      if (
        !exactKeys(value, ["now", "observed_at", "synchronized", "max_error_ms", "digest"])
        || typeof value.now !== "string"
        || typeof value.observed_at !== "string"
        || value.synchronized !== true
        || typeof value.max_error_ms !== "number"
        || value.max_error_ms < 0
        || value.max_error_ms > 1_000
        || typeof value.digest !== "string"
      ) {
        throw new Error("invalid or unsynchronized protected clock-health record");
      }
      const unsigned = { now: value.now, observed_at: value.observed_at, synchronized: value.synchronized, max_error_ms: value.max_error_ms };
      const expected = `sha256:${createHash("sha256").update(JSON.stringify(unsigned)).digest("hex")}`;
      if (value.digest !== expected || value.now !== value.observed_at) throw new Error("protected clock-health digest or observation mismatch");
      return value.now;
    },
    liveness: () => {
      const value = json(config.liveness_path);
      if (!exactKeys(value, ["healthy", "observed_at", "digest"]) || typeof value.healthy !== "boolean" || typeof value.observed_at !== "string" || typeof value.digest !== "string") {
        throw new Error("invalid closed protected liveness record");
      }
      return { healthy: value.healthy, observedAt: value.observed_at, digest: value.digest };
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
  const fd = openSync(temporary, "wx", 0o600);
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

function runJsonBin(path: string, input: unknown): any {
  const checked = protectedPath(path);
  const before = lstatSync(checked);
  const fd = openSync(checked, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (!sameOpenedInode(before, opened) || !opened.isFile() || (opened.mode & 0o111) === 0) {
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

export async function run(args: string[]): Promise<number> {
  const command = args[0];
  if (!["begin", "commit", "watchdog"].includes(command ?? "")) {
    process.stderr.write("usage: constitutional-routing-cli.ts begin|commit|watchdog --authority-config ABS --data-dir DIR --table FILE [--plan FILE]\n");
    return 2;
  }
  const configPath = resolveAuthorityConfigPath(args, process.env["GILLE_AUTONOMY_AUTHORITY_CONFIG"]);
  const dataDirFlag = readFlag(args, "--data-dir") ?? process.env["GILLE_AUTONOMY_DATA_DIR"];
  const tableFlag = readFlag(args, "--table") ?? process.env["GILLE_AUTONOMY_TABLE_PATH"];
  if (!configPath || !dataDirFlag || !tableFlag) throw new Error("authority config, data dir, and route table are required");
  const config = loadConfig(configPath);
  const dataDir = resolve(dataDirFlag);
  const tablePath = resolve(tableFlag);
  const authority = authorityReader(config);
  const lease = acquireMutationLock(dataDir);
  try {
    const store = {
      read: () => boundedProtectedRead(tablePath),
      compareAndSwap: (expected: string, next: string) => fencedWrite(dataDir, lease.token, () => {
        if (boundedProtectedRead(tablePath) !== expected) return false;
        atomicWrite(tablePath, next);
        return true;
      }),
    };
    if (command === "begin" || command === "commit") {
      const planPath = readFlag(args, "--plan");
      if (command === "begin" && !planPath) throw new Error("begin requires --plan");
      const plan = planPath ? JSON.parse(boundedProtectedRead(resolve(planPath))) as RouteMutationPlan : undefined;
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
      const controller = new ConstitutionalRoutingController(dataDir, store, authority, verifier);
      const result = command === "begin" ? controller.begin(plan!) : controller.commit();
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return result.outcome === "unknown" ? 3 : 0;
    }

    const recovery: RestoreOnlyCapability = {
      recoveryWorkerIdentity: "micro-route-revert-worker",
      restorePreRegisteredBaseline: ({ baseline, baselineDigest }) => fencedWrite(dataDir, lease.token, () => {
        const current = boundedProtectedRead(tablePath);
        if (`sha256:${contentSha(current)}` === baselineDigest) return "already-baseline";
        atomicWrite(tablePath, baseline);
        return `sha256:${contentSha(boundedProtectedRead(tablePath))}` === baselineDigest ? "restored" : "failed";
      }),
      signAndPersistDemotion: (input) => {
        const result = runJsonBin(config.recovery_signer_bin, input);
        if (!exactKeys(result, ["ledger", "registry", "checkpoint"])) throw new Error("recovery signer returned an invalid closed response");
        return result as unknown as { ledger: unknown; registry: unknown; checkpoint: unknown };
      },
    };
    const watchdog = new ConstitutionalRoutingWatchdog(dataDir, authority, recovery);
    const result = watchdog.tick();
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result.outcome === "terminally-blocked" ? 3 : 0;
  } finally {
    lease.release();
  }
}

export function resolveAuthorityConfigPath(args: string[], configuredPath?: string, home = homedir()): string {
  if (readFlag(args, "--authority-config")) throw new Error("production authority config path is fixed; arbitrary --authority-config is refused");
  const fixed = resolve(home, ".config", "gille-inference", "authority-config.json");
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
