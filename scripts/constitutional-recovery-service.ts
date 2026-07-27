#!/usr/bin/env tsx
import {
  authenticateRecoveryJournal,
  RecoveryRegistry,
  startRecoveryService,
  type RecoveryJournalView,
} from "../src/homeserver/constitutional-recovery-service.js";
import { constitutionalPaths } from "../src/homeserver/constitutional-routing-controller.js";
import { readConstitutionalResourceReadonly } from "../src/homeserver/constitutional-fenced-lease.js";
import { ConstitutionalRouteDatabase } from "../src/homeserver/constitutional-route-database.js";
import {
  boundedProtectedRead,
  PRODUCTION_AUTHORITY_CONFIG,
  PRODUCTION_ROUTE_TABLE,
  PRODUCTION_STATE_DIR,
  RECOVERY_ACTION_SOCKET,
  RECOVERY_REGISTRATION_SOCKET,
  assertRecoverySignerReady,
  runJsonBin,
  loadAuthorityConfig,
  protectedPath,
} from "./constitutional-routing-cli.js";

const RECOVERY_CONFIG = "/etc/gille-inference/autonomy/recovery-config.json";
const RECOVERY_REGISTRY_DIR = "/var/lib/gille-inference/autonomy-recovery";
const json = (path: string) => JSON.parse(boundedProtectedRead(path, 1_000_000, 0)) as any;

function authorityConfig(): any {
  const value = loadAuthorityConfig(PRODUCTION_AUTHORITY_CONFIG);
  if (value.canonical_state_dir !== PRODUCTION_STATE_DIR || value.canonical_route_table_path !== PRODUCTION_ROUTE_TABLE) {
    throw new Error("recovery authority target roots are not canonical");
  }
  return value;
}

function currentProtectedAuthority(config = authorityConfig()): any {
  return {
    authorization: json(config.authorization_path),
    constitution: json(config.constitution_path),
    coverage: json(config.coverage_path),
    attestations: json(config.owner_attestations_path),
    recoveryRegistry: json(config.recovery_registry_path),
    pinnedOwnerPublicKeyPem: boundedProtectedRead(config.pinned_owner_public_key_path, 64_000, 0),
    checkpoint: json(config.authorization_checkpoint_path),
    runtimeNarrowing: json(config.runtime_narrowing_path),
    runtimeNarrowingCheckpoint: json(config.runtime_narrowing_checkpoint_path),
  };
}

function journalView(journalId: string, protectedAuthority?: unknown): RecoveryJournalView {
  const paths = constitutionalPaths(PRODUCTION_STATE_DIR);
  const journalBytes = readConstitutionalResourceReadonly(paths.lock, paths.journal);
  if (journalBytes === undefined) throw new Error("recovery journal is missing");
  const journal = JSON.parse(journalBytes) as any;
  const snapshot = protectedAuthority === undefined
    ? currentProtectedAuthority()
    : structuredClone(protectedAuthority);
  return authenticateRecoveryJournal({
    journalId,
    journal,
    protectedSnapshot: snapshot,
  });
}

function inheritedFd(name: string): number | undefined {
  const count = Number(process.env["LISTEN_FDS"] ?? "0");
  const names = (process.env["LISTEN_FDNAMES"] ?? "").split(":");
  const index = names.indexOf(name);
  return index >= 0 && index < count ? 3 + index : undefined;
}

const recoveryConfig = JSON.parse(
  boundedProtectedRead(protectedPath(RECOVERY_CONFIG, 0), 64_000, 0),
) as Record<string, unknown>;
if (Object.keys(recoveryConfig).sort().join(",") !== "recovery_signer_bin") {
  throw new Error("invalid closed recovery-only config");
}
if (typeof recoveryConfig.recovery_signer_bin !== "string") {
  throw new Error("recovery signer path is required");
}
if (!recoveryConfig.recovery_signer_bin.startsWith("/etc/gille-inference/autonomy/")) {
  throw new Error("recovery signer must stay below the protected root");
}
assertRecoverySignerReady(recoveryConfig.recovery_signer_bin, 0);

await startRecoveryService({
  registrationSocketPath: RECOVERY_REGISTRATION_SOCKET,
  actionSocketPath: RECOVERY_ACTION_SOCKET,
  registrationFd: inheritedFd("registration"),
  actionFd: inheritedFd("action"),
  registry: new RecoveryRegistry(RECOVERY_REGISTRY_DIR),
  journalAuthority: {
    read: journalView,
    protectedAuthority: () => currentProtectedAuthority(),
  },
  route: new ConstitutionalRouteDatabase(PRODUCTION_ROUTE_TABLE),
  demote: (input) => runJsonBin(String(recoveryConfig.recovery_signer_bin), input),
  // Longer than the 120-second oneshot ceiling so a live operation never
  // loses its resource-local fence before systemd terminates it.
  routeLeaseOptions: { durationMs: 150_000 },
});
