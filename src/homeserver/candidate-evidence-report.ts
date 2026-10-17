import type Database from "better-sqlite3";

import { evidenceIdentityHash, type EvidenceIdentityBundle, type IdentityField, type IdentityOrigin, type IdentityUnknownReason } from "./evidence-identity.js";
import { EXECUTION_FEEDBACK_EPOCH } from "./execution-feedback-contract.js";

/** Read-only diagnostic contract for preparing candidate-bound M3 evidence. */
export const CANDIDATE_EVIDENCE_CONTRACT = "m5-candidate-evidence-v1" as const;
export const CANDIDATE_EVIDENCE_VERSION = 1 as const;

export interface CandidateEvidenceWindow { from: string; throughExclusive: string; }
export interface CandidateEvidenceOptions extends CandidateEvidenceWindow { generatedAt: string; }
type Availability = "available" | "unavailable";
type Count = { established: number; missing: number };

export interface CandidateEvidenceReport {
  contract: typeof CANDIDATE_EVIDENCE_CONTRACT;
  version: typeof CANDIDATE_EVIDENCE_VERSION;
  generatedAt: string;
  window: CandidateEvidenceWindow;
  availability: Availability;
  unavailableReason?: "missing_table" | "missing_column";
  qualification: { status: "hold"; reason: "diagnostic_only"; selectedCandidate: null; enablingDecision: null };
  rows: { inWindow: number; malformedTimestamp: number; currentM5: number; organic: number; evaluation: number; synthetic: number; unknownPurpose: number };
  identity: {
    availability: Availability; unavailableReason?: "missing_table" | "missing_column";
    referenced: number; resolved: number; missingSnapshot: number; malformedHash: number;
    malformedSnapshot: number; hashMismatch: number; duplicateSnapshot: number;
  };
  bindings: {
    /** Presence of the stored model identity digest; this is not proof of artifact bytes. */
    artifactDigest: Count;
    artifactBinding: { status: "unknown"; reason: "digest_not_bound_to_artifact_bytes" };
    verifierRubric: Count; taxonomy: Count; lane: Count; policy: Count;
    runtime: { status: "unknown"; reason: "not_stored" };
    verifierTrust: { status: "unknown"; reason: "not_stored" };
  };
  feedback: {
    availability: Availability; unavailableReason?: "missing_table" | "missing_column"; epoch: typeof EXECUTION_FEEDBACK_EPOCH;
    byPurpose: { organic: number; evaluation: number; synthetic: number; unknown: number };
    organic: { completed: number; assessed: number; missing: number; pass: number; partial: number; redo: number; wrong: number };
    missing: number; duplicate: number; conflicting: number; legacyEpoch: number; unavailable: number;
  };
  outcomes: { pass: number; partial: number; fail: number; error: number; unverified: number; other: number };
  cost: { availability: Availability; unavailableReason?: "missing_table" | "missing_column"; rows: number; linked: number; missing: number; duplicate: number; costAssessment: "unassessed" };
  diagnostics: {
    failedOutcomes: number; unavailableOutcomes: number; unassessedFeedback: number;
    unknownPurpose: number; duplicateFeedback: number; duplicateCost: number;
  };
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const LANES = new Set(["chat", "mcp-ask", "delegate", "delegate-disagreement", "delegate-shadow", "code-loop"]);
const IDENTITY_FIELDS = ["modelArtifact", "configEpoch", "logicalTask", "renderedPrompt", "harness", "taxonomyVersion", "verifierRubric", "sampling", "toolPolicy"] as const;
const ORIGINS = new Set<IdentityOrigin>(["learning-task-stamp", "server-observed", "operator-declared"]);
const UNKNOWN_REASONS = new Set<IdentityUnknownReason>(["not-applicable", "not-observed", "legacy", "producer-error", "policy-unavailable"]);

function parseIso(name: string, value: string): number {
  if (!ISO_UTC.test(value)) throw new RangeError(`${name} must be a canonical RFC3339 UTC timestamp`);
  const canonical = value.length === 20 ? value.replace("Z", ".000Z") : value;
  const parsed = Date.parse(canonical);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== canonical) throw new RangeError(`${name} is malformed`);
  return parsed;
}
function storedIso(value: unknown): number | null {
  if (typeof value !== "string" || !ISO_UTC.test(value)) return null;
  const canonical = value.length === 20 ? value.replace("Z", ".000Z") : value;
  const parsed = Date.parse(canonical);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === canonical ? parsed : null;
}
function tableExists(db: Database.Database, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}
function columns(db: Database.Database, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((r) => r.name));
}
function hasColumns(db: Database.Database, table: string, required: readonly string[]): boolean {
  const present = columns(db, table);
  return required.every((name) => present.has(name));
}
function empty(): CandidateEvidenceReport {
  return {
    contract: CANDIDATE_EVIDENCE_CONTRACT, version: CANDIDATE_EVIDENCE_VERSION,
    generatedAt: "", window: { from: "", throughExclusive: "" }, availability: "unavailable", unavailableReason: "missing_table",
    qualification: { status: "hold", reason: "diagnostic_only", selectedCandidate: null, enablingDecision: null },
    rows: { inWindow: 0, malformedTimestamp: 0, currentM5: 0, organic: 0, evaluation: 0, synthetic: 0, unknownPurpose: 0 },
    identity: { availability: "unavailable", unavailableReason: "missing_table", referenced: 0, resolved: 0, missingSnapshot: 0, malformedHash: 0, malformedSnapshot: 0, hashMismatch: 0, duplicateSnapshot: 0 },
    bindings: {
      artifactDigest: { established: 0, missing: 0 },
      artifactBinding: { status: "unknown", reason: "digest_not_bound_to_artifact_bytes" },
      verifierRubric: { established: 0, missing: 0 }, taxonomy: { established: 0, missing: 0 },
      lane: { established: 0, missing: 0 }, policy: { established: 0, missing: 0 },
      runtime: { status: "unknown", reason: "not_stored" }, verifierTrust: { status: "unknown", reason: "not_stored" },
    },
    feedback: { availability: "unavailable", epoch: EXECUTION_FEEDBACK_EPOCH, byPurpose: { organic: 0, evaluation: 0, synthetic: 0, unknown: 0 }, organic: { completed: 0, assessed: 0, missing: 0, pass: 0, partial: 0, redo: 0, wrong: 0 }, missing: 0, duplicate: 0, conflicting: 0, legacyEpoch: 0, unavailable: 0 },
    outcomes: { pass: 0, partial: 0, fail: 0, error: 0, unverified: 0, other: 0 },
    cost: { availability: "unavailable", rows: 0, linked: 0, missing: 0, duplicate: 0, costAssessment: "unassessed" },
    diagnostics: { failedOutcomes: 0, unavailableOutcomes: 0, unassessedFeedback: 0, unknownPurpose: 0, duplicateFeedback: 0, duplicateCost: 0 },
  };
}

function validIdentityField(value: unknown): value is IdentityField {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const field = value as Record<string, unknown>;
  if (field.kind === "unknown") return typeof field.reason === "string" && UNKNOWN_REASONS.has(field.reason as IdentityUnknownReason)
    && (field.detail === undefined || (typeof field.detail === "string" && field.detail.length > 0));
  if (field.kind === "label") return typeof field.label === "string" && field.label.length > 0 && ORIGINS.has(field.origin as IdentityOrigin);
  return field.kind === "digest" && typeof field.id === "string" && field.id.length > 0
    && typeof field.version === "string" && field.version.length > 0
    && typeof field.digest === "string" && SHA256.test(field.digest) && ORIGINS.has(field.origin as IdentityOrigin);
}
function validBundle(value: unknown): value is EvidenceIdentityBundle {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const bundle = value as Record<string, unknown>;
  const keys = Object.keys(bundle).sort();
  const expected = [...IDENTITY_FIELDS, "lane"].sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index])
    && IDENTITY_FIELDS.every((field) => validIdentityField(bundle[field]))
    && (typeof bundle.lane === "string" && (LANES.has(bundle.lane) || bundle.lane === "unknown"));
}
function established(value: IdentityField, requiresDigest = false): boolean {
  return requiresDigest ? value.kind === "digest" : value.kind === "digest" || value.kind === "label";
}

function unavailableReport(options: CandidateEvidenceOptions, reason: "missing_table" | "missing_column"): CandidateEvidenceReport {
  const report = empty();
  return { ...report, generatedAt: options.generatedAt, window: { from: options.from, throughExclusive: options.throughExclusive }, unavailableReason: reason };
}

/** Build the content-blind candidate evidence diagnostic. This function never creates schema or writes. */
export function buildCandidateEvidenceReport(db: Database.Database, options: CandidateEvidenceOptions): CandidateEvidenceReport {
  const fromMs = parseIso("from", options.from);
  const throughMs = parseIso("throughExclusive", options.throughExclusive);
  const generatedAtMs = parseIso("generatedAt", options.generatedAt);
  if (fromMs >= throughMs) throw new RangeError("from must be before throughExclusive");
  if (generatedAtMs < throughMs) throw new RangeError("generatedAt must be at or after throughExclusive");
  const blank = empty();
  const base: CandidateEvidenceReport = {
    ...blank,
    availability: "available", unavailableReason: undefined,
    generatedAt: options.generatedAt,
    window: { from: options.from, throughExclusive: options.throughExclusive },
    identity: { ...blank.identity, availability: "available", unavailableReason: undefined },
    feedback: { ...blank.feedback, availability: "available", unavailableReason: undefined },
    cost: { ...blank.cost, availability: "available", unavailableReason: undefined },
  };
  const requirements: Record<string, readonly string[]> = {
    delegations: ["id", "ts", "node_id", "model_id", "task_type", "outcome", "shadow", "superseded_at", "evidence_identity_hash"],
    evidence_identity_snapshots: ["identity_hash", "bundle_json"],
    execution_feedback: ["ledger_id", "traffic_purpose", "epoch", "usefulness", "available"],
    delegation_costs: ["id", "delegation_id"],
  };
  const schemaStatus = (table: string): "available" | "missing_table" | "missing_column" => {
    if (!tableExists(db, table)) return "missing_table";
    return hasColumns(db, table, requirements[table]) ? "available" : "missing_column";
  };
  const delegationStatus = schemaStatus("delegations");
  if (delegationStatus !== "available") return unavailableReport(options, delegationStatus);
  const snapshotStatus = schemaStatus("evidence_identity_snapshots");
  const feedbackStatus = schemaStatus("execution_feedback");
  const costStatus = schemaStatus("delegation_costs");
  if (snapshotStatus !== "available") { base.identity.availability = "unavailable"; base.identity.unavailableReason = snapshotStatus; }
  if (feedbackStatus !== "available") { base.feedback.availability = "unavailable"; base.feedback.unavailableReason = feedbackStatus; }
  if (costStatus !== "available") { base.cost.availability = "unavailable"; base.cost.unavailableReason = costStatus; }

  const allSnapshots = snapshotStatus === "available"
    ? db.prepare("SELECT identity_hash, bundle_json FROM evidence_identity_snapshots ORDER BY rowid ASC").all() as Array<{ identity_hash: unknown; bundle_json: unknown }>
    : [];
  const snapshots = new Map<string, { bundle?: EvidenceIdentityBundle; duplicate: boolean; malformed: boolean }>();
  for (const row of allSnapshots) {
    const key = typeof row.identity_hash === "string" ? row.identity_hash : "";
    const current = snapshots.get(key);
    const parsed = (() => { try { return JSON.parse(String(row.bundle_json)); } catch { return null; } })();
    const next = { bundle: validBundle(parsed) ? parsed : undefined, duplicate: Boolean(current), malformed: !validBundle(parsed) };
    if (!current) snapshots.set(key, next);
    else current.duplicate = true;
  }
  const delegations = db.prepare("SELECT id, ts, node_id, model_id, task_type, outcome, shadow, superseded_at, evidence_identity_hash FROM delegations ORDER BY rowid ASC").all() as Array<Record<string, unknown>>;
  const rows = delegations.filter((row) => {
    const time = storedIso(row.ts);
    if (time === null) { base.rows.malformedTimestamp += 1; return false; }
    return time >= fromMs && time < throughMs;
  });
  base.rows.inWindow = rows.length;
  for (const row of rows) {
    const currentM5 = row.node_id === "m5" && row.shadow === 0 && row.superseded_at === null;
    if (currentM5) base.rows.currentM5 += 1;
    const rawOutcome = typeof row.outcome === "string" ? row.outcome : "";
    const knownOutcome = new Set(["pass", "partial", "fail", "error", "unverified"]);
    const outcome = knownOutcome.has(rawOutcome) ? rawOutcome as keyof CandidateEvidenceReport["outcomes"] : "other";
    if (outcome === "other") base.outcomes.other += 1;
    else base.outcomes[outcome] += 1;
    if (outcome === "fail" || outcome === "error") base.diagnostics.failedOutcomes += 1;
    if (outcome === "unverified" || outcome === "other" || rawOutcome === "") base.diagnostics.unavailableOutcomes += 1;
    const hash = row.evidence_identity_hash;
    if (hash === null || hash === undefined || hash === "") { base.identity.missingSnapshot += 1; continue; }
    base.identity.referenced += 1;
    if (typeof hash !== "string" || !SHA256.test(hash)) { base.identity.malformedHash += 1; continue; }
    const snapshot = snapshots.get(hash);
    if (!snapshot) { base.identity.missingSnapshot += 1; continue; }
    if (snapshot.duplicate) { base.identity.duplicateSnapshot += 1; continue; }
    if (snapshot.malformed || !snapshot.bundle) { base.identity.malformedSnapshot += 1; continue; }
    if (evidenceIdentityHash(snapshot.bundle) !== hash) { base.identity.hashMismatch += 1; continue; }
    base.identity.resolved += 1;
    const b = snapshot.bundle;
    for (const [name, field, immutable] of [
      ["artifactDigest", b.modelArtifact, true], ["verifierRubric", b.verifierRubric, true], ["taxonomy", b.taxonomyVersion, false],
    ] as const) {
      if (established(field, immutable)) base.bindings[name].established += 1; else base.bindings[name].missing += 1;
    }
    if (b.lane !== "unknown") base.bindings.lane.established += 1; else base.bindings.lane.missing += 1;
    if (established(b.toolPolicy, true)) base.bindings.policy.established += 1; else base.bindings.policy.missing += 1;
  }
  base.bindings.artifactDigest.missing = rows.length - base.bindings.artifactDigest.established;
  base.bindings.verifierRubric.missing = rows.length - base.bindings.verifierRubric.established;
  base.bindings.taxonomy.missing = rows.length - base.bindings.taxonomy.established;
  base.bindings.lane.missing = rows.length - base.bindings.lane.established;
  base.bindings.policy.missing = rows.length - base.bindings.policy.established;

  const feedbackRows = feedbackStatus === "available"
    ? db.prepare("SELECT ledger_id, traffic_purpose, epoch, usefulness, available FROM execution_feedback ORDER BY rowid ASC").all() as Array<Record<string, unknown>>
    : [];
  const feedbackById = new Map<string, Array<Record<string, unknown>>>();
  for (const feedback of feedbackRows) {
    const id = typeof feedback.ledger_id === "string" && feedback.ledger_id.trim() !== "" ? feedback.ledger_id : null;
    if (id === null) continue;
    const list = feedbackById.get(id) ?? [];
    list.push(feedback);
    feedbackById.set(id, list);
  }
  for (const row of rows) {
    const id = typeof row.id === "string" && row.id.trim() !== "" ? row.id : null;
    const matches = id === null ? [] : feedbackById.get(id) ?? [];
    if (matches.length === 0) {
      base.feedback.missing += 1;
      base.feedback.byPurpose.unknown += 1;
      base.rows.unknownPurpose += 1;
      continue;
    }
    const purposes = new Set(matches.map((m) => {
      const purpose = m.traffic_purpose;
      return purpose === "organic" || purpose === "evaluation" || purpose === "synthetic" ? purpose : "unknown";
    }));
    const purpose = purposes.size === 1 ? [...purposes][0] : "unknown";
    const rowPurpose = purpose === "organic" || purpose === "evaluation" || purpose === "synthetic" ? purpose : "unknownPurpose";
    base.rows[rowPurpose] += 1;
    base.feedback.byPurpose[purpose] += 1;
    if (matches.length !== 1) {
      base.feedback.duplicate += 1; base.diagnostics.duplicateFeedback += 1;
      const signatures = new Set(matches.map((m) => JSON.stringify([m.traffic_purpose, m.epoch, m.usefulness, m.available])));
      if (signatures.size > 1) base.feedback.conflicting += 1;
      continue;
    }
    const feedback = matches[0];
    if (feedback.epoch !== EXECUTION_FEEDBACK_EPOCH) { base.feedback.legacyEpoch += 1; continue; }
    if (feedback.available !== 1) { base.feedback.unavailable += 1; continue; }
    if (purpose !== "organic") continue;
    const knownOutcome = row.outcome === "pass" || row.outcome === "partial"
      || row.outcome === "fail" || row.outcome === "unverified";
    const eligible = row.node_id === "m5" && row.shadow === 0 && row.superseded_at === null && knownOutcome;
    if (!eligible) continue;
    base.feedback.organic.completed += 1;
    const usefulness = feedback.usefulness;
    if (typeof usefulness === "string" && ["pass", "partial", "redo", "wrong"].includes(usefulness)) {
      base.feedback.organic.assessed += 1;
      base.feedback.organic[usefulness as "pass" | "partial" | "redo" | "wrong"] += 1;
    } else {
      base.feedback.organic.missing += 1;
      base.diagnostics.unassessedFeedback += 1;
    }
  }
  base.diagnostics.unknownPurpose = base.rows.unknownPurpose;

  const selectedIds = new Set(rows.flatMap((row) => typeof row.id === "string" && row.id.trim() !== "" ? [row.id] : []));
  const costs = costStatus === "available"
    ? (db.prepare("SELECT id, delegation_id FROM delegation_costs ORDER BY rowid ASC").all() as Array<Record<string, unknown>>)
      .filter((cost) => typeof cost.delegation_id === "string" && selectedIds.has(cost.delegation_id))
    : [];
  const costById = new Map<string, number>();
  for (const cost of costs) {
    const id = typeof cost.delegation_id === "string" ? cost.delegation_id : "";
    costById.set(id, (costById.get(id) ?? 0) + 1);
  }
  base.cost.rows = costs.length;
  for (const row of rows) {
    const id = typeof row.id === "string" ? row.id : "";
    const count = costById.get(id) ?? 0;
    if (count === 1) base.cost.linked += 1;
    else if (count === 0) base.cost.missing += 1;
    else {
      base.cost.duplicate += 1;
      base.diagnostics.duplicateCost += 1;
    }
  }
  return base;
}
