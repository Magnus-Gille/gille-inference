#!/usr/bin/env tsx
import {
  authenticateRecoveryJournal,
  RecoveryRegistry,
  startRecoveryService,
  type RecoveryJournalView,
} from "../src/homeserver/constitutional-recovery-service.js";
import { constitutionalPaths } from "../src/homeserver/constitutional-routing-controller.js";
import { readConstitutionalResource } from "../src/homeserver/constitutional-fenced-lease.js";
import { ConstitutionalRouteDatabase } from "../src/homeserver/constitutional-route-database.js";
import {
  boundedProtectedRead,
  PRODUCTION_AUTHORITY_CONFIG,
  PRODUCTION_ROUTE_TABLE,
  PRODUCTION_STATE_DIR,
  RECOVERY_ACTION_SOCKET,
  RECOVERY_REGISTRATION_SOCKET,
  runJsonBin,
  loadAuthorityConfig,
  protectedPath,
} from "./constitutional-routing-cli.js";

const RECOVERY_CONFIG = "/etc/gille-inference/autonomy/recovery-config.json";
const RECOVERY_REGISTRY_DIR = "/var/lib/gille-inference/autonomy-recovery";
const json = (path: string) => JSON.parse(boundedProtectedRead(path)) as any;

function authorityConfig(): any {
  const value = loadAuthorityConfig(PRODUCTION_AUTHORITY_CONFIG);
  if (value.canonical_state_dir !== PRODUCTION_STATE_DIR || value.canonical_route_table_path !== PRODUCTION_ROUTE_TABLE) {
    throw new Error("recovery authority target roots are not canonical");
  }
  return value;
}

function journalView(journalId: string): RecoveryJournalView {
  const paths = constitutionalPaths(PRODUCTION_STATE_DIR);
  const journalBytes = readConstitutionalResource(paths.lock, paths.journal);
  if (journalBytes === undefined) throw new Error("recovery journal is missing");
  const journal = JSON.parse(journalBytes) as any;
  const config = authorityConfig();
  const last = journal.entries?.at(-1);
  const materialBytes = readConstitutionalResource(paths.lock, paths.recoveryMaterial);
  const preparedWithoutMaterial = last?.phase === "prepare" && materialBytes === undefined;
  const material = preparedWithoutMaterial
    ? undefined
    : JSON.parse(String(materialBytes)) as any;
  const snapshot = preparedWithoutMaterial ? {
    authorization: json(config.authorization_path),
    constitution: json(config.constitution_path),
    coverage: json(config.coverage_path),
    attestations: json(config.owner_attestations_path),
    recoveryRegistry: json(config.recovery_registry_path),
    pinnedOwnerPublicKeyPem: boundedProtectedRead(config.pinned_owner_public_key_path, 64_000),
    checkpoint: json(config.authorization_checkpoint_path),
    runtimeNarrowing: json(config.runtime_narrowing_path),
    runtimeNarrowingCheckpoint: json(config.runtime_narrowing_checkpoint_path),
  } : structuredClone(material.prepared_authority);
  // Replace every anti-rollback/authentication root with the recovery
  // process's independently root-owned copy before cryptographic validation.
  snapshot.pinnedOwnerPublicKeyPem = boundedProtectedRead(config.pinned_owner_public_key_path, 64_000);
  snapshot.checkpoint = json(config.authorization_checkpoint_path);
  snapshot.recoveryRegistry = json(config.recovery_registry_path);
  snapshot.runtimeNarrowingCheckpoint = json(config.runtime_narrowing_checkpoint_path);
  return authenticateRecoveryJournal({
    journalId,
    journal,
    material,
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
  boundedProtectedRead(protectedPath(RECOVERY_CONFIG, 0), 64_000),
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
protectedPath(recoveryConfig.recovery_signer_bin, 0);

await startRecoveryService({
  registrationSocketPath: RECOVERY_REGISTRATION_SOCKET,
  actionSocketPath: RECOVERY_ACTION_SOCKET,
  registrationFd: inheritedFd("registration"),
  actionFd: inheritedFd("action"),
  registry: new RecoveryRegistry(RECOVERY_REGISTRY_DIR),
  journalAuthority: { read: journalView },
  route: new ConstitutionalRouteDatabase(PRODUCTION_ROUTE_TABLE),
  demote: (input) => runJsonBin(String(recoveryConfig.recovery_signer_bin), input),
});
