import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  canonicalJson,
  digestJson,
  validateJournalV1Prefix,
  verifyOwnerAuthorization,
} from "./autonomy-contract-v1.js";
import Database from "better-sqlite3";
import type { RouteFence } from "./constitutional-route-database.js";
import type { ConstitutionalLeaseOptions } from "./constitutional-fenced-lease.js";

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const ID = /^[a-z][a-z0-9-]{2,120}$/;
const HANDLE = /^recovery-[a-f0-9-]{36}$/;
const sha = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

export interface RecoveryRegistrationRequest {
  journalId: string;
  bindingDigest: string;
  targetScopeDigest: string;
  baselineDigest: string;
  candidateDigest: string;
  descriptorDigest: string;
}
export interface RecoveryRegistrationReceipt {
  handle: string;
  registrationDigest: string;
}
export interface RecoveryActuationRequest {
  handle: string;
  journalId: string;
  bindingDigest: string;
  targetScopeDigest: string;
  journalReceiptDigest: string;
  fenceEpoch: number;
  fenceToken: string;
}
export type RecoveryClassification = "restored" | "already-baseline" | "superseded" | "failed";

interface StoredRegistration extends RecoveryRegistrationRequest {
  schema_version: 1;
  baseline: string;
  handle: string;
  registrationDigest: string;
  consumed: boolean;
  classification: RecoveryClassification | null;
  actuationRequestDigest: string | null;
}

export interface RecoveryJournalView {
  journalId: string;
  bindingDigest: string;
  targetScopeDigest: string;
  baselineDigest: string;
  candidateDigest: string;
  descriptorDigest: string;
  ownerAuthorizationDigest: string;
  phase: "prepare" | "unknown" | "revert" | "terminally-blocked" | "disarm" | "commit";
  receiptDigest: string;
}

export interface RecoveryJournalAuthority {
  read(journalId: string): RecoveryJournalView;
}

export function authenticateRecoveryJournal(input: {
  journalId: string;
  journal: any;
  material?: any;
  protectedSnapshot: any;
}): RecoveryJournalView {
  const { journalId, journal, material, protectedSnapshot } = input;
  const verified = verifyOwnerAuthorization(protectedSnapshot);
  validateJournalV1Prefix(
    journal,
    protectedSnapshot.constitution,
    protectedSnapshot.coverage,
    protectedSnapshot.attestations,
  );
  const last = journal.entries?.at(-1);
  if (
    journal.journal_id !== journalId
    || !last
    || last.receipt_digest !== digestJson(last, "receipt_digest")
    || digestJson(protectedSnapshot) !== journal.binding.recovery.descriptor_digest
    || (material !== undefined && (
      material.material_digest !== digestJson(material, "material_digest")
      || material.journal_id !== journalId
      || material.binding_digest !== journal.binding_digest
      || material.baseline_digest !== journal.binding.baseline_digest
      || material.candidate_digest !== journal.binding.candidate_digest
      || sha(String(material.candidate)) !== material.candidate_digest
    ))
  ) throw new Error("recovery journal/material authentication failed");
  return {
    journalId,
    bindingDigest: journal.binding_digest,
    targetScopeDigest: journal.binding.target_scope_digest,
    baselineDigest: journal.binding.baseline_digest,
    candidateDigest: journal.binding.candidate_digest,
    descriptorDigest: journal.binding.recovery.descriptor_digest,
    ownerAuthorizationDigest: verified.authorizationDigest,
    phase: last.phase,
    receiptDigest: last.receipt_digest,
  };
}

export interface RecoveryRoute {
  read(): string;
  acquireWriterLease(options?: ConstitutionalLeaseOptions): RouteLease;
  restoreExact(expectedCandidateDigest: string, baseline: string, fence: RouteFence): boolean;
}

interface RouteLease extends RouteFence {
  isCurrent(): boolean;
  release(): void;
}

function registrationDigest(value: Omit<StoredRegistration, "registrationDigest" | "consumed" | "classification" | "actuationRequestDigest">): string {
  return sha(canonicalJson(value));
}

function atomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeFileSync(fd, `${canonicalJson(value)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  const directory = openSync(dirname(path), "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

function exactRequest(stored: StoredRegistration, request: RecoveryActuationRequest): boolean {
  return stored.handle === request.handle
    && stored.journalId === request.journalId
    && stored.bindingDigest === request.bindingDigest
    && stored.targetScopeDigest === request.targetScopeDigest
    && DIGEST.test(request.journalReceiptDigest)
    && Number.isSafeInteger(request.fenceEpoch)
    && request.fenceEpoch >= 1
    && /^[a-f0-9-]{36}$/.test(request.fenceToken);
}

/**
 * Recovery-owned registry. The controller receives only an opaque handle and
 * receipt; baseline bytes never cross back out of the registration boundary.
 */
export class RecoveryRegistry {
  private readonly dbPath: string;
  constructor(root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.dbPath = join(root, "registry.db");
    const db = this.open();
    db.close();
  }

  private open(): Database.Database {
    const db = new Database(this.dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
    db.exec(`
      CREATE TABLE IF NOT EXISTS recovery_registration (
        handle TEXT PRIMARY KEY,
        record_json TEXT NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS recovery_registration_journal
        ON recovery_registration(json_extract(record_json, '$.journalId'))
    `);
    return db;
  }

  register(
    request: RecoveryRegistrationRequest,
    route: RecoveryRoute,
    authority: RecoveryJournalAuthority,
  ): RecoveryRegistrationReceipt {
    const requestKeys = [
      "journalId", "bindingDigest", "targetScopeDigest", "baselineDigest",
      "candidateDigest", "descriptorDigest",
    ];
    const journal = authority.read(request.journalId);
    const baseline = route.read();
    if (
      !ID.test(request.journalId)
      || Object.keys(request).sort().join(",") !== requestKeys.sort().join(",")
      || journal.phase !== "prepare"
      || journal.journalId !== request.journalId
      || journal.bindingDigest !== request.bindingDigest
      || journal.targetScopeDigest !== request.targetScopeDigest
      || journal.baselineDigest !== request.baselineDigest
      || journal.candidateDigest !== request.candidateDigest
      || journal.descriptorDigest !== request.descriptorDigest
      || sha(baseline) !== request.baselineDigest
      || ![
        request.bindingDigest,
        request.targetScopeDigest,
        request.baselineDigest,
        request.candidateDigest,
        request.descriptorDigest,
      ].every((value) => DIGEST.test(value))
      || request.baselineDigest === request.candidateDigest
    ) {
      throw new Error("invalid recovery preregistration");
    }
    const handle = `recovery-${randomUUID()}`;
    const immutable = { schema_version: 1 as const, ...request, baseline, handle };
    const stored: StoredRegistration = {
      ...immutable,
      registrationDigest: registrationDigest(immutable),
      consumed: false,
      classification: null,
      actuationRequestDigest: null,
    };
    const db = this.open();
    try {
      db.prepare("INSERT INTO recovery_registration(handle, record_json) VALUES(?,?)")
        .run(handle, canonicalJson(stored));
    } finally {
      db.close();
    }
    return { handle, registrationDigest: stored.registrationDigest };
  }

  actuate(
    request: RecoveryActuationRequest,
    route: RecoveryRoute,
    authority: RecoveryJournalAuthority,
  ): { classification: RecoveryClassification; registrationDigest: string } {
    if (
      Object.keys(request).sort().join(",") !== [
        "handle", "journalId", "bindingDigest", "targetScopeDigest",
        "journalReceiptDigest", "fenceEpoch", "fenceToken",
      ].sort().join(",")
      || !HANDLE.test(request.handle)
    ) throw new Error("invalid closed recovery actuation request");
    const db = this.open();
    try {
      const row = db.prepare("SELECT record_json FROM recovery_registration WHERE handle=?")
        .get(request.handle) as { record_json: string } | undefined;
      if (!row) throw new Error("unknown recovery preregistration");
      const stored = JSON.parse(row.record_json) as StoredRegistration;
      const immutable = {
        schema_version: stored.schema_version,
        journalId: stored.journalId,
        bindingDigest: stored.bindingDigest,
        targetScopeDigest: stored.targetScopeDigest,
        baseline: stored.baseline,
        baselineDigest: stored.baselineDigest,
        candidateDigest: stored.candidateDigest,
        descriptorDigest: stored.descriptorDigest,
        handle: stored.handle,
      };
      const journal = authority.read(request.journalId);
      if (
        stored.schema_version !== 1
        || stored.registrationDigest !== registrationDigest(immutable)
        || !exactRequest(stored, request)
        || journal.phase !== "unknown"
        || journal.journalId !== stored.journalId
        || journal.bindingDigest !== stored.bindingDigest
        || journal.targetScopeDigest !== stored.targetScopeDigest
        || journal.baselineDigest !== stored.baselineDigest
        || journal.candidateDigest !== stored.candidateDigest
        || journal.descriptorDigest !== stored.descriptorDigest
        || journal.receiptDigest !== request.journalReceiptDigest
      ) {
        throw new Error("recovery request is not the exact eligible unknown journal receipt");
      }
      const requestDigest = sha(canonicalJson(request));
      if (stored.consumed) {
        if (stored.actuationRequestDigest !== requestDigest || stored.classification === null) {
          throw new Error("recovery preregistration was already consumed by another request");
        }
        return { classification: stored.classification, registrationDigest: stored.registrationDigest };
      }

      // The route database is the effect-owning fence. Do not hold a
      // recovery-registry transaction across it or imply cross-DB atomicity.
      // A crash after restore but before this CAS is intentionally recovered
      // by exact idempotent replay (baseline -> already-baseline).
      const fence = { epoch: request.fenceEpoch, token: request.fenceToken };
      const live = sha(route.read());
      let classification: RecoveryClassification;
      if (live === stored.baselineDigest) {
        classification = "already-baseline";
      } else if (live !== stored.candidateDigest) {
        classification = "superseded";
      } else {
        classification = route.restoreExact(stored.candidateDigest, stored.baseline, fence)
          && sha(route.read()) === stored.baselineDigest
          ? "restored"
          : "failed";
      }
      stored.consumed = true;
      stored.classification = classification;
      stored.actuationRequestDigest = requestDigest;
      const update = db.prepare(`
        UPDATE recovery_registration SET record_json=?
        WHERE handle=? AND record_json=?
      `).run(canonicalJson(stored), stored.handle, row.record_json);
      if (update.changes !== 1) {
        throw new Error("recovery preregistration changed during actuation replay");
      }
      return { classification, registrationDigest: stored.registrationDigest };
    } finally {
      db.close();
    }
  }
}

export interface RecoveryServiceOptions {
  registrationSocketPath: string;
  actionSocketPath: string;
  registrationFd?: number;
  actionFd?: number;
  registry: RecoveryRegistry;
  route: RecoveryRoute;
  journalAuthority: RecoveryJournalAuthority;
  demote(input: {
    journalId: string;
    ownerAuthorizationDigest: string;
    domain: "micro-routing";
    targetScopeDigest: string;
    journalReceiptDigest: string;
    fenceEpoch: number;
    fenceToken: string;
  }): { ledger: unknown; registry: unknown; checkpoint: unknown };
  socketMode?: number;
  routeLeaseOptions?: ConstitutionalLeaseOptions;
}

async function readBody(request: import("node:http").IncomingMessage): Promise<unknown> {
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > 1_000_000) throw new Error("request exceeds 1 MiB");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function respond(response: import("node:http").ServerResponse, status: number, value: unknown): void {
  const body = `${canonicalJson(value)}\n`;
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

function listen(server: Server, path: string, mode: number, fd?: number): Promise<void> {
  if (fd !== undefined) {
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen({ fd }, () => {
        server.off("error", reject);
        resolve();
      });
    });
  }
  if (existsSync(path)) unlinkSync(path);
  mkdirSync(dirname(path), { recursive: true, mode: 0o750 });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      chmodSync(path, mode);
      resolve();
    });
  });
}

/**
 * Two sockets are intentional capability objects. OS ownership/mode assigns
 * the registration socket to the controller group and the action socket to
 * the watchdog group; neither endpoint accepts the other operation.
 */
export async function startRecoveryService(options: RecoveryServiceOptions): Promise<{ close(): Promise<void> }> {
  let routeLease: RouteLease | undefined;
  const registration = createServer(async (request, response) => {
    try {
      if (request.method !== "POST" || request.url !== "/register") return respond(response, 404, { error: "not-found" });
      const receipt = options.registry.register(
        await readBody(request) as RecoveryRegistrationRequest,
        options.route,
        options.journalAuthority,
      );
      respond(response, 200, receipt);
    } catch (error) {
      respond(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  const action = createServer(async (request, response) => {
    try {
  if (request.method !== "POST") return respond(response, 404, { error: "not-found" });
      const body = await readBody(request);
      if (request.url === "/fence/acquire") {
        if (typeof body !== "object" || body === null || Array.isArray(body) || Object.keys(body).length !== 0) {
          throw new Error("invalid closed route-fence acquisition request");
        }
        // A watchdog may die after acquisition and before release. Permit a
        // later request to replace only an expired/superseded in-process
        // handle; never preempt a current recovery action.
        if (routeLease?.isCurrent()) throw new Error("recovery route fence is already held");
        routeLease?.release();
        routeLease = options.route.acquireWriterLease(options.routeLeaseOptions);
        return respond(response, 200, { epoch: routeLease.epoch, token: routeLease.token });
      }
      if (request.url === "/fence/release") {
        const fence = body as RouteFence;
        if (
          routeLease === undefined
          || typeof body !== "object"
          || body === null
          || Array.isArray(body)
          || Object.keys(body).sort().join(",") !== "epoch,token"
          || fence.epoch !== routeLease.epoch
          || fence.token !== routeLease.token
        ) throw new Error("route-fence release does not match the held lease");
        routeLease.release();
        routeLease = undefined;
        return respond(response, 200, { released: true });
      }
      if (request.url === "/actuate") {
        return respond(response, 200, options.registry.actuate(
          body as RecoveryActuationRequest,
          options.route,
          options.journalAuthority,
        ));
      }
      if (request.url === "/demote") {
        const input = body as Parameters<RecoveryServiceOptions["demote"]>[0];
        if (
          typeof body !== "object"
          || body === null
          || Array.isArray(body)
          || Object.keys(body).sort().join(",")
            !== [
              "journalId", "ownerAuthorizationDigest", "domain", "targetScopeDigest",
              "journalReceiptDigest", "fenceEpoch", "fenceToken",
            ].sort().join(",")
        ) throw new Error("invalid closed demotion request");
        const journal = options.journalAuthority.read(String((input as { journalId?: unknown }).journalId ?? ""));
        if (
          !["revert", "terminally-blocked"].includes(journal.phase)
          || journal.journalId !== input.journalId
          || input.domain !== "micro-routing"
          || journal.ownerAuthorizationDigest !== input.ownerAuthorizationDigest
          || journal.targetScopeDigest !== input.targetScopeDigest
          || journal.receiptDigest !== input.journalReceiptDigest
          || !Number.isSafeInteger(input.fenceEpoch)
          || input.fenceEpoch < 1
          || !/^[a-f0-9-]{36}$/.test(input.fenceToken)
        ) throw new Error("demotion request is not the exact eligible revert receipt");
        return respond(response, 200, options.demote(input));
      }
      return respond(response, 404, { error: "not-found" });
    } catch (error) {
      respond(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  const mode = options.socketMode ?? 0o660;
  await Promise.all([
    listen(registration, options.registrationSocketPath, mode, options.registrationFd),
    listen(action, options.actionSocketPath, mode, options.actionFd),
  ]);
  return {
    close: async () => {
      routeLease?.release();
      routeLease = undefined;
      await Promise.all([registration, action].map((server) => new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      })));
      for (const path of options.registrationFd === undefined && options.actionFd === undefined
        ? [options.registrationSocketPath, options.actionSocketPath]
        : []) {
        if (existsSync(path)) unlinkSync(path);
      }
    },
  };
}
