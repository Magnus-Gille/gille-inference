import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { getDb } from "../db.js";
import {
  parseLearningTaskGatewayEcho,
  type LearningTaskGatewayEcho,
} from "./learning-task-contract.js";

/**
 * Durable, content-blind admission identity for LearningTaskContract traffic.
 *
 * The natural keys intentionally omit `client_id`: a caller authenticated as the same principal
 * cannot evade replay protection by changing that self-asserted namespace. `client_id` is still
 * retained and must be equal on an exact retry. Separate authenticated principals remain isolated.
 */
export interface LearningTaskAdmission {
  admissionRecordId: string;
  principalId: string;
  clientId: string;
  taskInstanceId: string;
  attemptId: string;
  requestId: string;
  idempotencyKey: string;
  requestFingerprint: string;
  surface: "delegate" | "code-loop";
  gatewayEcho: LearningTaskGatewayEcho;
}

export type LearningTaskAdmissionIdentity = Omit<
  LearningTaskAdmission,
  "admissionRecordId" | "gatewayEcho"
>;

export type LearningTaskAdmissionLookup =
  | { kind: "none" }
  | { kind: "existing"; record: LearningTaskAdmission }
  | { kind: "conflict"; record: LearningTaskAdmission };

export type LearningTaskAdmissionClaim =
  | { kind: "claimed"; record: LearningTaskAdmission }
  | { kind: "existing"; record: LearningTaskAdmission }
  | { kind: "conflict"; record: LearningTaskAdmission };

interface AdmissionRow {
  admission_record_id: string;
  principal_id: string;
  client_id: string;
  task_instance_id: string;
  attempt_id: string;
  request_id: string;
  idempotency_key: string;
  request_fingerprint: string;
  surface: string;
  gateway_echo_json: string;
}

const initialized = new WeakSet<Database.Database>();

function assertIdentity(identity: LearningTaskAdmissionIdentity): void {
  if (!/^sha256:[a-f0-9]{64}$/.test(identity.requestFingerprint)) {
    throw new Error("LearningTaskContract observed request fingerprint must be sha256:<64 lowercase hex>");
  }
}

function assertCandidate(candidate: LearningTaskAdmission): void {
  assertIdentity(candidate);
  const stamp = candidate.gatewayEcho.echoed_request;
  if (candidate.gatewayEcho.authenticated_principal_id !== candidate.principalId
    || stamp.expected_transport_principal_id !== candidate.principalId
    || stamp.client_id !== candidate.clientId
    || stamp.task_instance_id !== candidate.taskInstanceId
    || stamp.attempt_id !== candidate.attemptId
    || stamp.request_id !== candidate.requestId
    || stamp.idempotency_key !== candidate.idempotencyKey) {
    throw new Error("LearningTaskContract admission fields do not match the principal-bound gateway echo");
  }
}

function ensureSchema(db: Database.Database): void {
  if (initialized.has(db)) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS learning_task_admissions (
      admission_record_id TEXT PRIMARY KEY,
      principal_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      task_instance_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL,
      surface TEXT NOT NULL CHECK (surface IN ('delegate', 'code-loop')),
      gateway_echo_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (principal_id, idempotency_key),
      UNIQUE (principal_id, task_instance_id, attempt_id),
      UNIQUE (principal_id, request_id)
    );
    CREATE INDEX IF NOT EXISTS idx_learning_task_admissions_created
      ON learning_task_admissions(created_at);
  `);
  initialized.add(db);
}

function rowToAdmission(row: AdmissionRow): LearningTaskAdmission {
  return {
    admissionRecordId: row.admission_record_id,
    principalId: row.principal_id,
    clientId: row.client_id,
    taskInstanceId: row.task_instance_id,
    attemptId: row.attempt_id,
    requestId: row.request_id,
    idempotencyKey: row.idempotency_key,
    requestFingerprint: row.request_fingerprint,
    surface: row.surface as LearningTaskAdmission["surface"],
    gatewayEcho: parseLearningTaskGatewayEcho(JSON.parse(row.gateway_echo_json)),
  };
}

function sameAdmission(left: LearningTaskAdmission, right: LearningTaskAdmissionIdentity): boolean {
  return left.principalId === right.principalId
    && left.clientId === right.clientId
    && left.taskInstanceId === right.taskInstanceId
    && left.attemptId === right.attemptId
    && left.requestId === right.requestId
    && left.idempotencyKey === right.idempotencyKey
    && left.requestFingerprint === right.requestFingerprint
    && left.surface === right.surface;
}

function findCollision(db: Database.Database, candidate: LearningTaskAdmissionIdentity): LearningTaskAdmission | null {
  const row = db.prepare(`
    SELECT admission_record_id, principal_id, client_id, task_instance_id, attempt_id,
           request_id, idempotency_key, request_fingerprint, surface, gateway_echo_json
      FROM learning_task_admissions
     WHERE principal_id = @principalId
       AND (
         idempotency_key = @idempotencyKey
         OR (task_instance_id = @taskInstanceId AND attempt_id = @attemptId)
         OR request_id = @requestId
       )
     LIMIT 1
  `).get(candidate) as AdmissionRow | undefined;
  return row === undefined ? null : rowToAdmission(row);
}

/**
 * Read an already-admitted identity without creating a new claim. Callers must derive
 * `principalId` from authenticated transport context. This lookup is deliberately content-blind:
 * it compares only the closed contract identifiers, surface, and canonical request fingerprint.
 */
export function lookupLearningTaskAdmission(
  identity: LearningTaskAdmissionIdentity,
  db: Database.Database = getDb(),
): LearningTaskAdmissionLookup {
  ensureSchema(db);
  assertIdentity(identity);
  const collision = findCollision(db, identity);
  if (collision === null) return { kind: "none" };
  return sameAdmission(collision, identity)
    ? { kind: "existing", record: collision }
    : { kind: "conflict", record: collision };
}

/**
 * Linearize one admitted request against all three durable identities. Exact retries are reported
 * as `existing`; any re-binding of an idempotency, attempt, or request identity is `conflict`.
 */
export function claimLearningTaskAdmission(
  input: Omit<LearningTaskAdmission, "admissionRecordId">,
  db: Database.Database = getDb(),
): LearningTaskAdmissionClaim {
  ensureSchema(db);
  const candidate: LearningTaskAdmission = { admissionRecordId: randomUUID(), ...input };
  assertCandidate(candidate);
  const claim = db.transaction(() => {
    const collision = findCollision(db, candidate);
    if (collision !== null) {
      return sameAdmission(collision, candidate)
        ? { kind: "existing" as const, record: collision }
        : { kind: "conflict" as const, record: collision };
    }
    db.prepare(`
      INSERT INTO learning_task_admissions (
        admission_record_id, principal_id, client_id, task_instance_id, attempt_id,
        request_id, idempotency_key, request_fingerprint, surface, gateway_echo_json, created_at
      ) VALUES (
        @admissionRecordId, @principalId, @clientId, @taskInstanceId, @attemptId,
        @requestId, @idempotencyKey, @requestFingerprint, @surface, @gatewayEchoJson, @createdAt
      )
    `).run({
      ...candidate,
      gatewayEchoJson: JSON.stringify(candidate.gatewayEcho),
      createdAt: candidate.gatewayEcho.admitted_at,
    });
    return { kind: "claimed" as const, record: candidate };
  });
  // Acquire the SQLite writer lock before the collision read so another gateway process cannot
  // interleave a competing natural-key insert between our read and write.
  return claim.immediate();
}

/**
 * Roll back only the exact newly-created record while a surface can prove execution has not begun.
 * Never call this as a generic downstream exception handler: an error may occur after model work.
 */
export function releaseLearningTaskAdmission(
  admissionRecordId: string,
  db: Database.Database = getDb(),
): boolean {
  ensureSchema(db);
  return db.prepare(`DELETE FROM learning_task_admissions WHERE admission_record_id = ?`).run(admissionRecordId).changes === 1;
}
