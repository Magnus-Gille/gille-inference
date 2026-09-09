import Database from "better-sqlite3";
import { readFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { buildEvidenceIdentityBundle, evidenceIdentityFromServedModelCmd, evidenceIdentityHash } from "../src/homeserver/evidence-identity.js";
import { CANDIDATE_EVIDENCE_CONTRACT, buildCandidateEvidenceReport } from "../src/homeserver/candidate-evidence-report.js";
import { EXECUTION_FEEDBACK_EPOCH } from "../src/homeserver/execution-feedback-contract.js";

const FROM = "2026-09-01T00:00:00.000Z";
const THROUGH = "2026-09-02T00:00:00.000Z";
const GENERATED = "2026-09-09T12:00:00.000Z";

function schema(path = ":memory:"): Database.Database {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE delegations (id TEXT, ts TEXT, node_id TEXT, model_id TEXT, task_type TEXT, outcome TEXT,
      shadow INTEGER, superseded_at TEXT, evidence_identity_hash TEXT, judge_policy TEXT, source TEXT);
    CREATE TABLE evidence_identity_snapshots (identity_hash TEXT, bundle_json TEXT, first_seen_at TEXT,
      last_seen_at TEXT, observation_count INTEGER);
    CREATE TABLE execution_feedback (handle TEXT, ledger_id TEXT, traffic_purpose TEXT, epoch TEXT,
      usefulness TEXT, available INTEGER);
    CREATE TABLE delegation_costs (id TEXT, delegation_id TEXT, ts TEXT, cost_status TEXT);
  `);
  return db;
}

function bundle() {
  return buildEvidenceIdentityBundle({
    modelArtifact: { kind: "digest", id: "artifact", version: "1", digest: "sha256:" + "a".repeat(64), origin: "server-observed" },
    verifierRubric: { kind: "digest", id: "rubric", version: "1", digest: "sha256:" + "b".repeat(64), origin: "operator-declared" },
    taxonomyVersion: { kind: "label", label: "taxonomy-v1", origin: "operator-declared" },
    toolPolicy: { kind: "digest", id: "tool-policy", version: "1", digest: "sha256:" + "c".repeat(64), origin: "operator-declared" },
    lane: "delegate",
  });
}

function insertDelegation(db: Database.Database, id: string, hash: string | null, outcome = "pass") {
  db.prepare("INSERT INTO delegations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, "2026-09-01T12:00:00.000Z", "m5", "mellum", "code-edit", outcome, 0, null, hash, "policy-v1", "mcp");
}

describe("candidate evidence report", () => {
  it("joins a resolved snapshot, exact organic feedback and cost without emitting identifiers", () => {
    const db = schema();
    const value = bundle();
    const hash = evidenceIdentityHash(value);
    insertDelegation(db, "secret-ledger", hash);
    db.prepare("INSERT INTO evidence_identity_snapshots VALUES (?, ?, ?, ?, ?)").run(hash, JSON.stringify(value), GENERATED, GENERATED, 1);
    db.prepare("INSERT INTO execution_feedback VALUES (?, ?, ?, ?, ?, ?)").run("secret-handle", "secret-ledger", "organic", EXECUTION_FEEDBACK_EPOCH, "pass", 1);
    db.prepare("INSERT INTO delegation_costs VALUES (?, ?, ?, ?)").run("secret-cost", "secret-ledger", "2026-09-01T12:00:00.000Z", "verified");
    const report = buildCandidateEvidenceReport(db, { from: FROM, throughExclusive: THROUGH, generatedAt: GENERATED });
    expect(report).toMatchObject({ contract: CANDIDATE_EVIDENCE_CONTRACT, availability: "available", qualification: { status: "hold", selectedCandidate: null, enablingDecision: null }, feedback: { organic: { completed: 1, assessed: 1, pass: 1 } }, cost: { rows: 1, linked: 1, duplicate: 0 }, identity: { resolved: 1, missingSnapshot: 0 }, bindings: { artifactDigest: { established: 1 }, artifactBinding: { status: "unknown", reason: "digest_not_bound_to_artifact_bytes" }, verifierRubric: { established: 1 }, taxonomy: { established: 1 }, lane: { established: 1 }, policy: { established: 1 }, runtime: { status: "unknown" }, verifierTrust: { status: "unknown" } } });
    const text = JSON.stringify(report);
    for (const secret of ["secret-ledger", "secret-handle", "secret-cost", "mellum", "policy-v1", "artifact-build-private"]) expect(text).not.toContain(secret);
    expect(report.cost.costAssessment).toBe("unassessed");
  });

  it("keeps missing feedback in the unknown-purpose denominator without changing source bytes", () => {
    const directory = mkdtempSync(join(tmpdir(), "m3-candidate-evidence-"));
    const path = join(directory, "evidence.db");
    const writable = schema(path);
    insertDelegation(writable, "no-feedback", null);
    writable.close();
    const before = readFileSync(path);
    const readonly = new Database(path, { readonly: true });
    const report = buildCandidateEvidenceReport(readonly, { from: FROM, throughExclusive: THROUGH, generatedAt: GENERATED });
    readonly.close();
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(report).toMatchObject({ rows: { inWindow: 1, unknownPurpose: 1 }, feedback: { missing: 1, byPurpose: { unknown: 1 } } });
    rmSync(directory, { recursive: true, force: true });
  });

  it("keeps unresolved, mismatched, duplicate, failed and non-organic rows explicit", () => {
    const db = schema();
    const value = bundle();
    const hash = evidenceIdentityHash(value);
    insertDelegation(db, "no-snapshot", "sha256:" + "c".repeat(64));
    insertDelegation(db, "mismatch", hash, "error");
    db.prepare("INSERT INTO evidence_identity_snapshots VALUES (?, ?, ?, ?, ?)").run(hash, JSON.stringify({ ...value, modelArtifact: { ...value.modelArtifact, version: "2" } }), GENERATED, GENERATED, 1);
    insertDelegation(db, "evaluation", null, "unverified");
    insertDelegation(db, "arbitrary", null, "unclassifiable-outcome");
    db.prepare("INSERT INTO execution_feedback VALUES (?, ?, ?, ?, ?, ?)").run("h1", "evaluation", "evaluation", EXECUTION_FEEDBACK_EPOCH, "redo", 1);
    db.prepare("INSERT INTO execution_feedback VALUES (?, ?, ?, ?, ?, ?)").run("h2", "evaluation", "evaluation", EXECUTION_FEEDBACK_EPOCH, "pass", 1);
    db.prepare("INSERT INTO delegation_costs VALUES (?, ?, ?, ?)").run("c1", "mismatch", "2026-09-01T12:00:00.000Z", "failed");
    db.prepare("INSERT INTO delegation_costs VALUES (?, ?, ?, ?)").run("c2", "mismatch", "2026-09-01T12:00:00.000Z", "failed");
    db.prepare("INSERT INTO delegation_costs VALUES (?, ?, ?, ?)").run("outside", "outside-window-row", "2026-09-01T12:00:00.000Z", "verified");
    const report = buildCandidateEvidenceReport(db, { from: FROM, throughExclusive: THROUGH, generatedAt: GENERATED });
    expect(report.identity).toMatchObject({ missingSnapshot: 3, hashMismatch: 1, resolved: 0 });
    expect(report.feedback).toMatchObject({ byPurpose: { evaluation: 1, unknown: 3 }, duplicate: 1, organic: { completed: 0 } });
    expect(report.rows).toMatchObject({ inWindow: 4, evaluation: 1, unknownPurpose: 3 });
    expect(report.cost).toMatchObject({ rows: 2, duplicate: 1, linked: 0 });
    expect(report.outcomes).toMatchObject({ error: 1, unverified: 1, other: 1 });
    expect(report.diagnostics).toMatchObject({ failedOutcomes: 1, unavailableOutcomes: 2, unknownPurpose: 3 });
  });

  it("does not treat the served model path digest as immutable artifact binding", () => {
    const db = schema();
    const modelPath = "/private/models/served-Q4_K_M.gguf";
    const served = evidenceIdentityFromServedModelCmd(`llama-server -m ${modelPath} --ctx-size 4096`);
    const value = buildEvidenceIdentityBundle({ ...bundle(), ...served });
    const hash = evidenceIdentityHash(value);
    insertDelegation(db, "path-derived-model", hash);
    db.prepare("INSERT INTO evidence_identity_snapshots VALUES (?, ?, ?, ?, ?)").run(hash, JSON.stringify(value), GENERATED, GENERATED, 1);
    const report = buildCandidateEvidenceReport(db, { from: FROM, throughExclusive: THROUGH, generatedAt: GENERATED });
    expect(report.bindings).toMatchObject({ artifactDigest: { established: 1 }, artifactBinding: { status: "unknown", reason: "digest_not_bound_to_artifact_bytes" } });
    const text = JSON.stringify(report);
    expect(text).not.toContain(modelPath);
    expect(text).not.toContain("llama-server");
  });

  it("keeps duplicate snapshots and malformed identity hashes as separate missingness", () => {
    const db = schema();
    const value = bundle(); const hash = evidenceIdentityHash(value);
    const malformedSnapshotHash = "sha256:" + "d".repeat(64);
    insertDelegation(db, "duplicate-snapshot", hash);
    insertDelegation(db, "malformed-hash", "sha256:not-a-valid-digest");
    insertDelegation(db, "malformed-json", malformedSnapshotHash);
    db.prepare("INSERT INTO evidence_identity_snapshots VALUES (?, ?, ?, ?, ?)").run(hash, JSON.stringify(value), GENERATED, GENERATED, 1);
    db.prepare("INSERT INTO evidence_identity_snapshots VALUES (?, ?, ?, ?, ?)").run(hash, JSON.stringify(value), GENERATED, GENERATED, 2);
    db.prepare("INSERT INTO evidence_identity_snapshots VALUES (?, ?, ?, ?, ?)").run(malformedSnapshotHash, "{malformed-json", GENERATED, GENERATED, 1);
    const report = buildCandidateEvidenceReport(db, { from: FROM, throughExclusive: THROUGH, generatedAt: GENERATED });
    expect(report.identity).toMatchObject({ referenced: 3, duplicateSnapshot: 1, malformedHash: 1, malformedSnapshot: 1, resolved: 0 });
  });

  it("keeps all recognized organic usefulness outcomes separate", () => {
    const db = schema();
    for (const [index, usefulness] of (["pass", "partial", "redo", "wrong"] as const).entries()) {
      const id = `organic-${usefulness}`;
      insertDelegation(db, id, null, index === 3 ? "unverified" : index === 2 ? "fail" : index === 1 ? "partial" : "pass");
      db.prepare("INSERT INTO execution_feedback VALUES (?, ?, ?, ?, ?, ?)").run(`h-${usefulness}`, id, "organic", EXECUTION_FEEDBACK_EPOCH, usefulness, 1);
    }
    const report = buildCandidateEvidenceReport(db, { from: FROM, throughExclusive: THROUGH, generatedAt: GENERATED });
    expect(report.feedback.organic).toMatchObject({ completed: 4, assessed: 4, pass: 1, partial: 1, redo: 1, wrong: 1, missing: 0 });
  });

  it("does not join malformed or empty ledger ids to feedback rows", () => {
    const db = schema();
    db.prepare("INSERT INTO delegations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("", "2026-09-01T12:00:00.000Z", "m5", "mellum", "code-edit", "pass", 0, null, null, "policy", "mcp");
    db.prepare("INSERT INTO delegations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(null, "2026-09-01T12:00:00.000Z", "m5", "mellum", "code-edit", "pass", 0, null, null, "policy", "mcp");
    db.prepare("INSERT INTO execution_feedback VALUES (?, ?, ?, ?, ?, ?)").run("h-empty", "", "organic", EXECUTION_FEEDBACK_EPOCH, "pass", 1);
    db.prepare("INSERT INTO execution_feedback VALUES (?, ?, ?, ?, ?, ?)").run("h-null", null, "organic", EXECUTION_FEEDBACK_EPOCH, "pass", 1);
    const report = buildCandidateEvidenceReport(db, { from: FROM, throughExclusive: THROUGH, generatedAt: GENERATED });
    expect(report).toMatchObject({ rows: { inWindow: 2, unknownPurpose: 2 }, feedback: { missing: 2, byPurpose: { unknown: 2 }, organic: { completed: 0, assessed: 0 } } });
  });

  it("does not count arbitrary outcomes as completed or assessed organic feedback", () => {
    const db = schema();
    insertDelegation(db, "arbitrary-organic", null, "provider-says-ok");
    db.prepare("INSERT INTO execution_feedback VALUES (?, ?, ?, ?, ?, ?)").run("h-arbitrary", "arbitrary-organic", "organic", EXECUTION_FEEDBACK_EPOCH, "pass", 1);
    const report = buildCandidateEvidenceReport(db, { from: FROM, throughExclusive: THROUGH, generatedAt: GENERATED });
    expect(report).toMatchObject({ outcomes: { other: 1 }, diagnostics: { unavailableOutcomes: 1 }, feedback: { byPurpose: { organic: 1 }, organic: { completed: 0, assessed: 0, missing: 0 } } });
  });

  it("keeps every purpose, failure, unavailable, legacy, duplicate, conflict and unassessed count closed", () => {
    const db = schema();
    insertDelegation(db, "organic-missing", null, "pass");
    insertDelegation(db, "organic-unavailable", null, "pass");
    insertDelegation(db, "organic-legacy", null, "pass");
    insertDelegation(db, "organic-unassessed", null, "pass");
    insertDelegation(db, "organic-duplicate", null, "pass");
    insertDelegation(db, "organic-conflict", null, "pass");
    insertDelegation(db, "evaluation-purpose", null, "pass");
    insertDelegation(db, "synthetic-purpose", null, "pass");
    insertDelegation(db, "unknown-purpose", null, "pass");
    insertDelegation(db, "failed-row", null, "fail");
    db.prepare("INSERT INTO execution_feedback VALUES (?, ?, ?, ?, ?, ?)").run("u", "organic-unavailable", "organic", EXECUTION_FEEDBACK_EPOCH, "pass", 0);
    db.prepare("INSERT INTO execution_feedback VALUES (?, ?, ?, ?, ?, ?)").run("l", "organic-legacy", "organic", "old-epoch", "pass", 1);
    db.prepare("INSERT INTO execution_feedback VALUES (?, ?, ?, ?, ?, ?)").run("n", "organic-unassessed", "organic", EXECUTION_FEEDBACK_EPOCH, null, 1);
    db.prepare("INSERT INTO execution_feedback VALUES (?, ?, ?, ?, ?, ?)").run("d1", "organic-duplicate", "organic", EXECUTION_FEEDBACK_EPOCH, "pass", 1);
    db.prepare("INSERT INTO execution_feedback VALUES (?, ?, ?, ?, ?, ?)").run("d2", "organic-duplicate", "organic", EXECUTION_FEEDBACK_EPOCH, "pass", 1);
    db.prepare("INSERT INTO execution_feedback VALUES (?, ?, ?, ?, ?, ?)").run("c1", "organic-conflict", "organic", EXECUTION_FEEDBACK_EPOCH, "pass", 1);
    db.prepare("INSERT INTO execution_feedback VALUES (?, ?, ?, ?, ?, ?)").run("c2", "organic-conflict", "evaluation", EXECUTION_FEEDBACK_EPOCH, "wrong", 1);
    db.prepare("INSERT INTO execution_feedback VALUES (?, ?, ?, ?, ?, ?)").run("e", "evaluation-purpose", "evaluation", EXECUTION_FEEDBACK_EPOCH, "pass", 1);
    db.prepare("INSERT INTO execution_feedback VALUES (?, ?, ?, ?, ?, ?)").run("s", "synthetic-purpose", "synthetic", EXECUTION_FEEDBACK_EPOCH, "pass", 1);
    db.prepare("INSERT INTO execution_feedback VALUES (?, ?, ?, ?, ?, ?)").run("x", "unknown-purpose", "future-purpose", EXECUTION_FEEDBACK_EPOCH, "pass", 1);
    const report = buildCandidateEvidenceReport(db, { from: FROM, throughExclusive: THROUGH, generatedAt: GENERATED });
    expect(report).toMatchObject({
      rows: { inWindow: 10, organic: 4, evaluation: 1, synthetic: 1, unknownPurpose: 4 },
      feedback: { missing: 2, unavailable: 1, legacyEpoch: 1, duplicate: 2, conflicting: 1, byPurpose: { organic: 4, evaluation: 1, synthetic: 1, unknown: 4 }, organic: { completed: 1, assessed: 0, missing: 1 } },
      outcomes: { fail: 1 }, diagnostics: { failedOutcomes: 1, duplicateFeedback: 2, unknownPurpose: 4, unassessedFeedback: 1 },
    });
  });

  it("uses exact half-open UTC bounds and keeps malformed nested identity shapes unavailable", () => {
    const db = schema();
    const value = bundle(); const hash = evidenceIdentityHash(value);
    insertDelegation(db, "at-from", hash);
    insertDelegation(db, "at-through", hash);
    db.prepare("UPDATE delegations SET ts = ? WHERE id = ?").run(THROUGH, "at-through");
    db.prepare("INSERT INTO delegations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("bad-ts", "2026-09-01T12:00:00+00:00", "m5", "mellum", "code-edit", "pass", 0, null, hash, "policy", "mcp");
    db.prepare("INSERT INTO evidence_identity_snapshots VALUES (?, ?, ?, ?, ?)").run(hash, JSON.stringify({ ...value, sampling: { kind: "digest", digest: "not-a-digest" } }), GENERATED, GENERATED, 1);
    const report = buildCandidateEvidenceReport(db, { from: FROM, throughExclusive: THROUGH, generatedAt: GENERATED });
    expect(report).toMatchObject({ rows: { inWindow: 1, malformedTimestamp: 1 }, identity: { malformedSnapshot: 1, resolved: 0 } });
  });

  it("reports missing optional tables and columns as section-unavailable while retaining delegation counts", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE delegations (id TEXT, ts TEXT, node_id TEXT, model_id TEXT, task_type TEXT, outcome TEXT, shadow INTEGER, superseded_at TEXT, evidence_identity_hash TEXT)");
    db.prepare("INSERT INTO delegations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run("d", "2026-09-01T12:00:00.000Z", "m5", "mellum", "code-edit", "pass", 0, null, null);
    const report = buildCandidateEvidenceReport(db, { from: FROM, throughExclusive: THROUGH, generatedAt: GENERATED });
    expect(report).toMatchObject({ availability: "available", rows: { inWindow: 1, unknownPurpose: 1 }, identity: { availability: "unavailable", unavailableReason: "missing_table" }, feedback: { availability: "unavailable", unavailableReason: "missing_table", missing: 1 }, cost: { availability: "unavailable", unavailableReason: "missing_table", missing: 1 }, qualification: { status: "hold", selectedCandidate: null, enablingDecision: null } });

    const incomplete = new Database(":memory:");
    incomplete.exec("CREATE TABLE delegations (id TEXT, ts TEXT, node_id TEXT, model_id TEXT, task_type TEXT, outcome TEXT, shadow INTEGER, superseded_at TEXT, evidence_identity_hash TEXT); CREATE TABLE execution_feedback (ledger_id TEXT, traffic_purpose TEXT, epoch TEXT, usefulness TEXT); CREATE TABLE delegation_costs (id TEXT)");
    incomplete.prepare("INSERT INTO delegations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run("d", "2026-09-01T12:00:00.000Z", "m5", "mellum", "code-edit", "pass", 0, null, null);
    const partial = buildCandidateEvidenceReport(incomplete, { from: FROM, throughExclusive: THROUGH, generatedAt: GENERATED });
    expect(partial).toMatchObject({ availability: "available", rows: { inWindow: 1, unknownPurpose: 1 }, feedback: { availability: "unavailable", unavailableReason: "missing_column", missing: 1 }, cost: { availability: "unavailable", unavailableReason: "missing_column", missing: 1 } });
  });

  it("returns fixed unavailable diagnostics for missing schema and rejects noncanonical bounds", () => {
    const report = buildCandidateEvidenceReport(new Database(":memory:"), { from: FROM, throughExclusive: THROUGH, generatedAt: GENERATED });
    expect(report).toMatchObject({ contract: CANDIDATE_EVIDENCE_CONTRACT, availability: "unavailable", unavailableReason: "missing_table" });
    expect(() => buildCandidateEvidenceReport(new Database(":memory:"), { from: "2026-09-01T00:00:00+00:00", throughExclusive: THROUGH, generatedAt: GENERATED })).toThrow();
    expect(() => buildCandidateEvidenceReport(new Database(":memory:"), { from: FROM, throughExclusive: THROUGH, generatedAt: FROM })).toThrow(/generatedAt/);
  });
});
