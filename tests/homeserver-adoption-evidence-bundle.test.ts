import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildAdoptionEvidenceBundle,
  type EvidenceBundleOptions,
} from "../src/homeserver/adoption-evidence-bundle.js";
import { closeReadOnlyDb, openReadOnlyDb } from "../src/db.js";
import { main as exportMain, parseArgs as parseExportArgs } from "../scripts/export-m5-adoption-evidence.js";

const FROM = "2026-08-01T00:00:00.000Z";
const THROUGH = "2026-08-03T00:00:00.000Z";
const GENERATED = "2026-08-04T00:00:00.000Z";

function createDb(path = ":memory:"): Database.Database {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE adoption_evidence (
      recorded_day TEXT NOT NULL, harness TEXT NOT NULL, execution_mode TEXT NOT NULL,
      traffic_purpose TEXT NOT NULL, result TEXT NOT NULL, deterministic_check TEXT NOT NULL,
      reviewer_usefulness TEXT NOT NULL, fallback_reason TEXT NOT NULL,
      eligible_opportunities INTEGER NOT NULL
    );
    CREATE TABLE request_log (
      id TEXT PRIMARY KEY, ts INTEGER NOT NULL, tier TEXT, model TEXT NOT NULL, node TEXT NOT NULL,
      route TEXT NOT NULL, admission TEXT, total_ms INTEGER NOT NULL
    );
    CREATE TABLE delegations (
      id TEXT PRIMARY KEY, ts TEXT NOT NULL, task_type TEXT NOT NULL, node_id TEXT NOT NULL,
      model_id TEXT NOT NULL, outcome TEXT NOT NULL, error_class TEXT, verifier TEXT, source TEXT,
      shadow INTEGER NOT NULL DEFAULT 0, superseded_at TEXT, evidence_identity_hash TEXT,
      judge_policy TEXT, learning_task_admission_id TEXT, learning_task_instance_id TEXT,
      learning_task_attempt_id TEXT, reviewer_usefulness TEXT
    );
    CREATE TABLE delegation_costs (
      id TEXT PRIMARY KEY, ts TEXT NOT NULL, delegation_id TEXT, task_type TEXT NOT NULL,
      local_model TEXT NOT NULL, delegator_model TEXT, delegator_model_source TEXT,
      cost_status TEXT NOT NULL, prompt_tokens INTEGER, completion_tokens INTEGER, total_tokens INTEGER,
      m5_marginal_cost_usd REAL, m5_amortized_cost_usd REAL, m5_total_cost_usd REAL,
      verified_savings_actual_usd REAL, verified_savings_premium_usd REAL,
      potential_savings_actual_usd REAL, potential_savings_premium_usd REAL,
      price_catalog_version TEXT
    );
  `);
  return db;
}

function createOverflowTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE adoption_evidence_overflow (
      recorded_day TEXT NOT NULL, traffic_purpose TEXT NOT NULL, result TEXT NOT NULL,
      deterministic_check TEXT NOT NULL, reviewer_usefulness TEXT NOT NULL,
      fallback_reason TEXT NOT NULL, report_count INTEGER NOT NULL,
      eligible_opportunities INTEGER NOT NULL,
      unknown_opportunity_reports INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (recorded_day, traffic_purpose, result, deterministic_check,
                   reviewer_usefulness, fallback_reason)
    );
  `);
}

function options(overrides: Partial<EvidenceBundleOptions> = {}): EvidenceBundleOptions {
  return { from: FROM, throughExclusive: THROUGH, generatedAt: GENERATED, ...overrides };
}

function insertOrganic(db: Database.Database, values: {
  day?: string;
  result?: string;
  check?: string;
  usefulness?: string;
  opportunities?: number;
} = {}): void {
  const result = values.result ?? "completed";
  db.prepare(`INSERT INTO adoption_evidence
    (recorded_day, harness, execution_mode, traffic_purpose, result, deterministic_check,
     reviewer_usefulness, fallback_reason, eligible_opportunities)
    VALUES (?, 'claude', 'delegate', 'organic', ?, ?, ?, ?, ?)`)
    .run(values.day ?? "2026-08-01", result, values.check ?? "pass",
      values.usefulness ?? "pass", result === "completed" ? "none" : "m5_busy",
      values.opportunities ?? 1);
}

describe("buildAdoptionEvidenceBundle", () => {
  it("separates current, missing and other compute epochs without echoing stored labels", () => {
    const db = createDb();
    db.exec("ALTER TABLE request_log ADD COLUMN compute_filter_epoch TEXT");
    const insert = db.prepare(`INSERT INTO request_log
      (id, ts, tier, model, node, route, admission, total_ms, compute_filter_epoch)
      VALUES (?, ?, 'owner', 'mellum', 'm5', ?, 'admitted', 10, ?)`);
    const current = "m5-admitted-compute-v2";
    insert.run("current", Date.parse(FROM), "/mcp/ask", current);
    insert.run("legacy", Date.parse(FROM), "/mcp/ask", null);
    insert.run("other", Date.parse(FROM), "/mcp/ask", "private/epoch-label");
    insert.run("transport", Date.parse(FROM), "/mcp", null);
    insert.run("outside", Date.parse(THROUGH), "/mcp/ask", null);
    insert.run("invalid", "not-a-timestamp", "/mcp/ask", null);
    const bundle = buildAdoptionEvidenceBundle(db, options());
    expect(bundle.admittedCompute.requests).toBe(3);
    expect(bundle.admittedCompute.filter.historicalApplicability).toMatchObject({
      status: "mixed", ambiguousRows: 2, currentRows: 1, missingRows: 1, otherRows: 1,
    });
    expect(bundle.delegations.promotionReadiness.historicalMetricUnambiguous).toBe(false);
    expect(JSON.stringify(bundle)).not.toContain("private/epoch-label");
    expect(db.prepare("SELECT compute_filter_epoch FROM request_log WHERE id = 'legacy'").get())
      .toEqual({ compute_filter_epoch: null });
    db.close();
  });

  it("recognizes a current-only compute sample without clearing unrelated promotion gates", () => {
    const db = createDb();
    db.exec("ALTER TABLE request_log ADD COLUMN compute_filter_epoch TEXT");
    db.prepare(`INSERT INTO request_log
      (id, ts, tier, model, node, route, admission, total_ms, compute_filter_epoch)
      VALUES ('current', ?, 'owner', 'mellum', 'm5', '/mcp/ask', 'admitted', 10, 'm5-admitted-compute-v2')`)
      .run(Date.parse(FROM));
    const bundle = buildAdoptionEvidenceBundle(db, options());
    expect(bundle.admittedCompute.filter.historicalApplicability).toMatchObject({
      status: "current", ambiguousRows: 0, currentRows: 1, missingRows: 0, otherRows: 0,
    });
    expect(bundle.delegations.promotionReadiness.historicalMetricUnambiguous).toBe(true);
    expect(bundle.delegations.promotionReadiness.eligible).toBe(false);
    db.close();
  });

  it("keeps old-schema and empty samples unknown without migrating during export", () => {
    const db = createDb();
    const empty = buildAdoptionEvidenceBundle(db, options());
    expect(empty.admittedCompute.filter.historicalApplicability).toMatchObject({
      status: "no-evidence", ambiguousRows: 0, currentRows: 0, missingRows: 0, otherRows: 0,
    });
    expect(empty.delegations.promotionReadiness.historicalMetricUnambiguous).toBe(false);
    db.prepare(`INSERT INTO request_log
      (id, ts, tier, model, node, route, admission, total_ms)
      VALUES ('legacy', ?, 'owner', 'mellum', 'm5', '/mcp/ask', 'admitted', 10)`)
      .run(Date.parse(FROM));
    expect(buildAdoptionEvidenceBundle(db, options()).admittedCompute.filter.historicalApplicability)
      .toMatchObject({ status: "unknown", ambiguousRows: 1, currentRows: 0, missingRows: 1, otherRows: 0 });
    expect((db.prepare("PRAGMA table_info(request_log)").all() as Array<{ name: string }>)
      .some((column) => column.name === "compute_filter_epoch")).toBe(false);
    db.close();
  });

  it("builds deterministic bounded JSON and applies the shared admitted-compute predicate", () => {
    const db = createDb();
    db.prepare(`INSERT INTO request_log (id, ts, tier, model, node, route, admission, total_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run("r1", Date.parse("2026-08-01T10:00:00Z"), "owner", "mellum", "m5", "/v1/chat/completions", "admitted", 42);
    db.prepare(`INSERT INTO request_log (id, ts, tier, model, node, route, admission, total_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run("transport", Date.parse("2026-08-01T10:01:00Z"), null, "none", "m5", "/mcp", "admitted", 4);
    db.prepare(`INSERT INTO request_log (id, ts, tier, model, node, route, admission, total_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run("rejected", Date.parse("2026-08-01T10:02:00Z"), "guest", "mellum", "m5", "/v1/chat/completions", "busy", 9);
    db.prepare(`INSERT INTO request_log (id, ts, tier, model, node, route, admission, total_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run("orin", Date.parse("2026-08-01T10:03:00Z"), "owner", "mellum", "orin", "/v1/chat/completions", "admitted", 10);
    insertOrganic(db, { opportunities: 20 });
    db.prepare(`INSERT INTO delegations (id, ts, task_type, node_id, model_id, outcome, error_class, verifier, source, shadow, superseded_at, evidence_identity_hash, judge_policy, learning_task_admission_id, learning_task_instance_id, learning_task_attempt_id, reviewer_usefulness) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run("d1", "2026-08-01T10:00:00.000Z", "code-edit", "m5", "mellum", "pass", null, "answerIs(42)", "gateway", 0, null, "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "ctx-tools-parts-v1|ctx=24000", "adm", "inst", "attempt", "pass");
    db.prepare(`INSERT INTO delegation_costs (id, ts, delegation_id, task_type, local_model, delegator_model, delegator_model_source, cost_status, prompt_tokens, completion_tokens, total_tokens, m5_marginal_cost_usd, m5_amortized_cost_usd, m5_total_cost_usd, verified_savings_actual_usd, verified_savings_premium_usd, potential_savings_actual_usd, potential_savings_premium_usd, price_catalog_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run("c1", "2026-08-01T10:00:00.000Z", "d1", "code-edit", "mellum", "claude-sonnet-5", "stamped", "verified", 1, 2, 3, 0.01, 0.02, 0.12, 1.5, 2.5, 3.5, 4.5, "2026-08-29");
    const first = buildAdoptionEvidenceBundle(db, options());
    const second = buildAdoptionEvidenceBundle(db, options());
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.admittedCompute).toMatchObject({ filter: { epoch: "m5-admitted-compute-v2" }, requests: 1, requestTimeMs: 42 });
    expect(first.adoption.byPurpose.organic).toMatchObject({ reports: 1, knownOpportunities: 20, attempted: 1, useful: 1, usefulness: { pass: 1 } });
    expect(first.adoption.thresholds).toMatchObject({
      knownOpportunities: { status: "pass", observed: 20 },
      usefulAttemptedRatio: { status: "pass", observed: 1 },
    });
    expect(first.delegations.byTask).toEqual([{ bucket: "code-edit", rows: 1, attempted: 1, useful: 1 }]);
    expect(first.cost).toMatchObject({ rows: 1, reconciled: { m5TotalUsd: 0.12, verifiedSavingsActualUsd: 1.5 } });
    expect(first.delegations.promotionReadiness).toMatchObject({
      evidenceIdentityComplete: true,
      judgePolicyCurrent: true,
      learningTaskBindingComplete: true,
      stateUnambiguous: true,
      reviewerUsefulnessComplete: true,
      costCoverageComplete: true,
      computeReconciliationComplete: true,
      historicalMetricUnambiguous: false,
      eligible: false,
    });
    expect(first.admittedCompute.filter.historicalApplicability).toMatchObject({ status: "unknown", ambiguousRows: 1 });
    expect(first.nextAction.action).toBe("repair_measurement");
    expect(first.maturity.map((item) => item.label)).not.toContain("deployed/enforced");
    expect(first.adoption.filter.comparison).toContain("recorded_day >= UTC day(from)");
    expect(first.delegations.filter.timestampShape).toContain("RFC3339 UTC");
    expect(first.cost.filter.comparison).toBe("ts >= from AND ts < throughExclusive");
    expect(first.coverage.retentionSourceWindow.delegations).toMatchObject({
      validMin: "2026-08-01T10:00:00.000Z",
      validMax: "2026-08-01T10:00:00.000Z",
    });
    expect(first.coverage.retentionSourceWindow.adoptionEvidence).toMatchObject({ validMin: "2026-08-01", validMax: "2026-08-01" });
    expect(first.coverage.retentionSourceWindow.requestLog).toMatchObject({ validMin: "2026-08-01T10:00:00.000Z", validMax: "2026-08-01T10:03:00.000Z" });
    expect(first.coverage.retentionSourceWindow.costs).toMatchObject({ validMin: "2026-08-01T10:00:00.000Z", validMax: "2026-08-01T10:00:00.000Z" });
    db.close();
  });

  it("uses exact half-open bounds for timestamped rows and day bounds for adoption evidence", () => {
    const db = createDb();
    insertOrganic(db, { day: "2026-08-01", opportunities: 2 });
    insertOrganic(db, { day: "2026-08-03", opportunities: 99 });
    const insertRequest = db.prepare(`INSERT INTO request_log (id, ts, tier, model, node, route, admission, total_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    insertRequest.run("before", Date.parse("2026-07-31T23:59:59.999Z"), "owner", "mellum", "m5", "/delegate", "admitted", 1);
    insertRequest.run("inside", Date.parse("2026-08-02T23:59:59.999Z"), "owner", "mellum", "m5", "/delegate", "admitted", 2);
    insertRequest.run("at-through", Date.parse(THROUGH), "owner", "mellum", "m5", "/delegate", "admitted", 3);
    const bundle = buildAdoptionEvidenceBundle(db, options());
    expect(bundle.admittedCompute.requests).toBe(1);
    expect(bundle.adoption.byPurpose.organic.knownOpportunities).toBe(2);
    expect(bundle.window).toEqual({ from: FROM, throughExclusive: THROUGH });
    db.close();
  });

  it("collapses unbounded task/model/verifier/source values into privacy buckets", () => {
    const db = createDb();
    db.prepare(`INSERT INTO request_log (id, ts, tier, model, node, route, admission, total_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run("r1", Date.parse("2026-08-01T10:00:00Z"), "owner", "attacker/secret/path", "m5", "/delegate", "admitted", 2);
    db.prepare(`INSERT INTO delegations (id, ts, task_type, node_id, model_id, outcome, error_class, verifier, source, shadow, superseded_at, reviewer_usefulness) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run("d1", "2026-08-01T10:00:00.000Z", "prompt contains secret/path", "m5", "attacker/secret/model", "pass", null, "reviewer secret/path", "https://private.example/repo", 0, null, null);
    const bundle = buildAdoptionEvidenceBundle(db, options());
    const output = JSON.stringify(bundle);
    expect(output).not.toContain("secret/path");
    expect(output).not.toContain("private.example");
    expect(bundle.admittedCompute.byModel).toEqual([{ bucket: "other", requests: 1, requestTimeMs: 2 }]);
    expect(bundle.delegations.byTask[0]?.bucket).toBe("other");
    expect(bundle.delegations.byModel[0]?.bucket).toBe("other");
    expect(bundle.delegations.byVerifier[0]?.bucket).toBe("truth-oriented");
    expect(bundle.delegations.bySource[0]?.bucket).toBe("other");
    db.close();
  });

  it("reports missing assessments as unknowable instead of zero", () => {
    const db = createDb();
    insertOrganic(db, { opportunities: 5, check: "not_run", usefulness: "not_reported" });
    insertOrganic(db, { result: "not_attempted", opportunities: 0, check: "not_run", usefulness: "not_reported" });
    const bundle = buildAdoptionEvidenceBundle(db, options());
    expect(bundle.adoption.byPurpose.organic).toMatchObject({ knownOpportunities: 5, attempted: 1, useful: 0, unassessedAttempted: 1 });
    expect(bundle.adoption.thresholds.knownOpportunities.status).toBe("fail");
    expect(bundle.adoption.thresholds.usefulAttemptedRatio.status).toBe("unknowable");
    expect(bundle.adoption.thresholds.usefulAttemptedRatio.observed).toBe(0);
    expect(bundle.completeness.missingness.unknownOpportunityDenominators).toBe(1);
    db.close();
  });

  it("fails closed on malformed bounds and missing required schema", () => {
    const db = new Database(":memory:");
    expect(() => buildAdoptionEvidenceBundle(db, options())).toThrow(/requires table 'adoption_evidence'/);
    db.close();
    const complete = createDb();
    expect(() => buildAdoptionEvidenceBundle(complete, options({ from: "2026-08-01T12:00:00.000Z" }))).toThrow(/calendar-day boundaries/);
    complete.close();
  });

  it("never writes through the supplied database", () => {
    const db = createDb();
    const before = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master").get() as { n: number };
    buildAdoptionEvidenceBundle(db, options());
    const after = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master").get() as { n: number };
    expect(after.n).toBe(before.n);
    db.close();
  });

  it("reconciles every admitted-compute dimension and keeps non-current delegation evidence out of the matrix", () => {
    const db = createDb();
    const request = db.prepare(`INSERT INTO request_log (id, ts, tier, model, node, route, admission, total_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    request.run("owner-chat", Date.parse("2026-08-01T10:00:00.000Z"), "owner", "mellum", "m5", "/v1/chat/completions", "admitted", 5);
    request.run("guest-delegate", Date.parse("2026-08-01T10:01:00.000Z"), "guest", "qwen3-coder-next-80b", "m5", "/delegate", "admitted", 7);
    request.run("unknown-ask", Date.parse("2026-08-01T10:02:00.000Z"), null, "unknown", "m5", "/mcp/ask", "admitted", 3);
    const delegate = db.prepare(`INSERT INTO delegations (id, ts, task_type, node_id, model_id, outcome, error_class, verifier, source, shadow, superseded_at, evidence_identity_hash, judge_policy, learning_task_admission_id, learning_task_instance_id, learning_task_attempt_id, reviewer_usefulness) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    delegate.run("d-pass", "2026-08-01T10:00:00.000Z", "code-edit", "m5", "mellum", "pass", null, "answerIs", "gateway", 0, null, "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "policy-v1", "adm", "inst", "attempt", "pass");
    delegate.run("d-infra", "2026-08-01T10:01:00.000Z", "code-edit", "m5", "qwen3-coder-next-80b", "error", "infra", null, null, 0, null, null, null, null, null, null, null);
    delegate.run("d-unverified", "2026-08-01T10:02:00.000Z", "summarize", "m5", "unknown", "unverified", null, "none", "code-loop", 0, null, null, null, null, null, null, "partial");
    delegate.run("d-shadow", "2026-08-01T10:03:00.000Z", "code-edit", "m5", "mellum", "pass", null, "answerIs", "gateway", 1, null, null, null, null, null, null, "pass");
    delegate.run("d-old", "2026-08-01T10:04:00.000Z", "code-edit", "m5", "mellum", "pass", null, "answerIs", "gateway", 0, "2026-08-02T00:00:00.000Z", null, null, null, null, null, "pass");
    delegate.run("d-orin", "2026-08-01T10:05:00.000Z", "code-edit", "orin", "mellum", "pass", null, "answerIs", "gateway", 0, null, null, null, null, null, null, "pass");
    const cost = db.prepare(`INSERT INTO delegation_costs (id, ts, delegation_id, task_type, local_model, delegator_model, delegator_model_source, cost_status, prompt_tokens, completion_tokens, total_tokens, m5_marginal_cost_usd, m5_amortized_cost_usd, m5_total_cost_usd, verified_savings_actual_usd, verified_savings_premium_usd, potential_savings_actual_usd, potential_savings_premium_usd, price_catalog_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    cost.run("c-pass", "2026-08-01T10:00:00.000Z", "d-pass", "code-edit", "mellum", "claude-sonnet-5", "stamped", "verified", 1, 2, 3, 0.01, 0.02, 0.12, 1, 2, 3, 4, "2026-08-29");
    cost.run("c-unlinked", "2026-08-01T10:01:00.000Z", null, "code-edit", "mellum", null, null, "unverified", null, null, null, null, null, null, null, null, null, null, null);
    cost.run("c-shadow", "2026-08-01T10:03:00.000Z", "d-shadow", "code-edit", "mellum", "claude-sonnet-5", "stamped", "verified", 1, 2, 3, 0.01, 0.02, 0.12, 1, 2, 3, 4, "2026-08-29");
    cost.run("c-stale", "2026-08-01T10:04:00.000Z", "d-old", "code-edit", "mellum", "claude-sonnet-5", "stamped", "verified", 1, 2, 3, 0.01, 0.02, 0.12, 1, 2, 3, 4, "2026-08-29");
    const bundle = buildAdoptionEvidenceBundle(db, options());
    expect(bundle.admittedCompute.requests).toBe(3);
    expect(bundle.admittedCompute.byTier.map((row) => row.bucket)).toEqual(["guest", "other", "owner"]);
    expect(bundle.admittedCompute.reconciliation.count.allMatch).toBe(true);
    expect(bundle.admittedCompute.reconciliation.requestTimeMs).toMatchObject({ total: 15, byDay: 15, byTier: 15, byRoute: 15, byNode: 15, byModel: 15, allMatch: true });
    expect(bundle.admittedCompute.exclusions.reconciliation).toMatchObject({ inWindow: 3, byNode: 3, byAdmission: 3, byModel: 3, byRoute: 3, allMatch: true });
    expect(bundle.delegations.currentRows).toBe(3);
    expect(bundle.delegations.matrix.map((row) => row.outcome)).toEqual(["pass", "error", "unverified"]);
    expect(bundle.delegations.infraErrors).toBe(1);
    expect(bundle.delegations.unverified).toBe(1);
    expect(bundle.delegations.reviewerUsefulness).toEqual({ present: 2, missing: 1 });
    expect(bundle.delegations.stateCounts).toMatchObject({
      currentM5: 3,
      shadowM5: 1,
      supersededM5: 1,
      shadowAndSupersededM5: 0,
      nonM5: 1,
      invalid: 0,
      reconciliation: { inWindow: 6, classified: 6, allMatch: true },
    });
    expect(bundle.delegations.judgePolicy).toMatchObject({ current: 0, stale: 1, missing: 2, applicability: "historical-or-missing" });
    expect(bundle.delegations.learningTaskBinding).toMatchObject({ currentM5: 3, required: 3, present: 1, missing: 2, notRequired: 0, nonCurrentExcluded: 3 });
    expect(bundle.delegations.promotionReadiness).toMatchObject({
      evidenceIdentityComplete: false,
      judgePolicyCurrent: false,
      reviewerUsefulnessComplete: false,
      eligible: false,
    });
    expect(bundle.delegations.coverage).toMatchObject({
      evidenceIdentity: { present: 1, missing: 5 },
      judgePolicy: { present: 1, missing: 5 },
      learningTaskBinding: { present: 1, missing: 5 },
    });
    expect(bundle.cost).toMatchObject({ rows: 4, reconciled: { rows: 1, m5TotalUsd: null }, unlinked: { rows: 1, m5TotalUsd: null }, unreconciled: { rows: 2, m5TotalUsd: null }, reconciliation: { currentDelegations: 3, linkedRows: 1, linkedDelegations: 1, missingDelegations: 2, duplicateLinks: 0, duplicateRows: 0, exactlyOnePerCurrentDelegation: false } });
    expect(bundle.cost.attribution.source).toMatchObject({ stamped: 1, default: 0, missing: 0 });
    expect(bundle.cost.reconciled.confidence).toBe("partial");
    expect(bundle.nextAction.action).toBe("repair_measurement");
    db.close();
  });

  it("exposes closed adoption dimensions, fallback coverage, malformed rows, and the repair action", () => {
    const db = createDb();
    insertOrganic(db, { opportunities: 20, result: "failed", check: "not_run", usefulness: "not_reported" });
    db.prepare(`INSERT INTO adoption_evidence (recorded_day, harness, execution_mode, traffic_purpose, result, deterministic_check, reviewer_usefulness, fallback_reason, eligible_opportunities) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run("2026-08-01", "pi", "ask", "evaluation", "refused", "not_run", "not_reported", "m5_busy", 2);
    db.prepare(`INSERT INTO adoption_evidence (recorded_day, harness, execution_mode, traffic_purpose, result, deterministic_check, reviewer_usefulness, fallback_reason, eligible_opportunities) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run("2026-08-01", "codex_cli", "code_loop", "synthetic", "not_attempted", "not_run", "not_reported", "m5_unreachable", 0);
    db.prepare(`INSERT INTO adoption_evidence (recorded_day, harness, execution_mode, traffic_purpose, result, deterministic_check, reviewer_usefulness, fallback_reason, eligible_opportunities) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run("malformed-day", "claude", "delegate", "organic", "completed", "pass", "pass", "none", 100);
    db.prepare(`INSERT INTO request_log (id, ts, tier, model, node, route, admission, total_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run("bad", "not-a-timestamp", "owner", "mellum", "m5", "/delegate", "admitted", 1);
    db.prepare(`INSERT INTO delegations (id, ts, task_type, node_id, model_id, outcome, error_class, verifier, source, shadow, superseded_at, reviewer_usefulness) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run("bad", "not-a-timestamp", "code-edit", "m5", "mellum", "pass", null, "answerIs", "gateway", 0, null, "pass");
    db.prepare(`INSERT INTO delegation_costs (id, ts, delegation_id, task_type, local_model, delegator_model, delegator_model_source, cost_status, prompt_tokens, completion_tokens, total_tokens, m5_marginal_cost_usd, m5_amortized_cost_usd, m5_total_cost_usd, verified_savings_actual_usd, verified_savings_premium_usd, potential_savings_actual_usd, potential_savings_premium_usd, price_catalog_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run("bad", "not-a-timestamp", null, "code-edit", "mellum", null, null, "unverified", null, null, null, null, null, null, null, null, null, null, null);
    const bundle = buildAdoptionEvidenceBundle(db, options());
    expect(bundle.adoption.breakdowns.harness.filter((row) => row.reports > 0)).toEqual([{ bucket: "claude", reports: 1, knownOpportunities: 20, attempted: 1, useful: 0 }, { bucket: "codex_cli", reports: 1, knownOpportunities: 0, attempted: 0, useful: 0 }, { bucket: "pi", reports: 1, knownOpportunities: 2, attempted: 1, useful: 0 }]);
    expect(bundle.adoption.breakdowns.fallback.filter((row) => row.reports > 0).map((row) => row.bucket)).toEqual(["m5_busy", "m5_unreachable"]);
    expect(bundle.adoption.fallbackCoverage).toEqual({ capacity: 2, transport: 1, access: 0, unknown: 0 });
    expect(bundle.coverage.retentionSourceWindow.requestLog.malformedTimestamp).toBe(1);
    expect(bundle.coverage.retentionSourceWindow.delegations.malformedTimestamp).toBe(1);
    expect(bundle.coverage.retentionSourceWindow.costs.malformedTimestamp).toBe(1);
    expect(bundle.coverage.retentionSourceWindow.adoptionEvidence.malformedTimestamp).toBe(1);
    expect(bundle.nextAction.action).toBe("repair_measurement");
    db.close();
  });

  it("does not infer usefulness, and retains valid out-of-window rows in source coverage", () => {
    const db = createDb();
    insertOrganic(db, { day: "2026-08-01", opportunities: 1, usefulness: "wrong" });
    insertOrganic(db, { day: "2026-08-03", opportunities: 2 });
    db.prepare(`INSERT INTO request_log (id, ts, tier, model, node, route, admission, total_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("bad-duration", Date.parse("2026-08-01T10:00:00.000Z"), "owner", "mellum", "m5", "/delegate", "admitted", -1);
    db.prepare(`INSERT INTO request_log (id, ts, tier, model, node, route, admission, total_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("out-request", Date.parse("2026-08-03T10:00:00.000Z"), "owner", "mellum", "m5", "/delegate", "admitted", 1);
    const delegate = db.prepare(`INSERT INTO delegations (id, ts, task_type, node_id, model_id, outcome, shadow, superseded_at, reviewer_usefulness) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    delegate.run("d-in", "2026-08-01T10:00:00.000Z", "code-edit", "m5", "mellum", "pass", 0, null, "wrong");
    delegate.run("d-out", "2026-08-03T10:00:00.000Z", "code-edit", "m5", "mellum", "pass", 0, null, "pass");
    const cost = db.prepare(`INSERT INTO delegation_costs (id, ts, delegation_id, task_type, local_model, cost_status) VALUES (?, ?, ?, ?, ?, ?)`);
    cost.run("c-in", "2026-08-01T10:00:00.000Z", "d-in", "code-edit", "mellum", "unverified");
    cost.run("c-out", "2026-08-03T10:00:00.000Z", "d-out", "code-edit", "mellum", "unverified");
    const bundle = buildAdoptionEvidenceBundle(db, options());
    expect(bundle.adoption.byPurpose.organic.useful).toBe(0);
    expect(bundle.coverage.retentionSourceWindow).toMatchObject({
      adoptionEvidence: { rows: 2, inWindow: 1 },
      requestLog: { rows: 2, inWindow: 1 },
      delegations: { rows: 2, inWindow: 1 },
      costs: { rows: 2, inWindow: 1 },
    });
    expect(bundle.admittedCompute.missingRequestTime).toBe(1);
    expect(bundle.nextAction.action).toBe("repair_measurement");
    db.close();
  });

  it("uses exclusive delegation states, current-policy counts, and non-zero calibration for promotion", () => {
    const db = createDb();
    insertOrganic(db, { opportunities: 20 });
    db.prepare(`INSERT INTO request_log (id, ts, tier, model, node, route, admission, total_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("r1", Date.parse("2026-08-01T10:00:00.000Z"), "owner", "mellum", "m5", "/delegate", "admitted", 5);
    const delegate = db.prepare(`INSERT INTO delegations (id, ts, task_type, node_id, model_id, outcome, shadow, superseded_at, evidence_identity_hash, judge_policy, learning_task_admission_id, learning_task_instance_id, learning_task_attempt_id, reviewer_usefulness) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    delegate.run("current", "2026-08-01T10:00:00.000Z", "code-edit", "m5", "mellum", "pass", 0, null, "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "ctx-tools-parts-v1|ctx=24000", "adm", "inst", "attempt", "pass");
    delegate.run("current-empty", "2026-08-01T10:00:30.000Z", "code-edit", "m5", "mellum", "pass", 0, null, null, null, null, null, null, "");
    delegate.run("current-not-reported", "2026-08-01T10:00:45.000Z", "code-edit", "m5", "mellum", "pass", 0, null, null, null, null, null, null, "not_reported");
    delegate.run("shadow", "2026-08-01T10:01:00.000Z", "code-edit", "m5", "mellum", "unverified", 1, null, null, null, null, null, null, "not_reported");
    delegate.run("superseded", "2026-08-01T10:02:00.000Z", "code-edit", "m5", "mellum", "pass", 0, "2026-08-01T12:00:00.000Z", null, "old-policy", null, null, null, "redo");
    delegate.run("both", "2026-08-01T10:03:00.000Z", "code-edit", "m5", "mellum", "unverified", 1, "2026-08-01T12:00:00.000Z", null, null, null, null, null, "");
    delegate.run("orin", "2026-08-01T10:04:00.000Z", "code-edit", "orin", "mellum", "pass", 0, null, null, null, null, null, null, "wrong");
    delegate.run("invalid", "2026-08-01T10:05:00.000Z", "code-edit", "m5", "mellum", "pass", 2, null, null, null, null, null, null, "unknown");
    const cost = db.prepare(`INSERT INTO delegation_costs (id, ts, delegation_id, task_type, local_model, delegator_model, delegator_model_source, cost_status, prompt_tokens, completion_tokens, total_tokens, m5_marginal_cost_usd, m5_amortized_cost_usd, m5_total_cost_usd, verified_savings_actual_usd, verified_savings_premium_usd, potential_savings_actual_usd, potential_savings_premium_usd, price_catalog_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    cost.run("c-current", "2026-08-01T10:00:00.000Z", "current", "code-edit", "mellum", "claude-sonnet-5", "stamped", "verified", 1, 2, 3, 0, 0, 0.12, 1, 2, 3, 4, "2026-08-29");
    const bundle = buildAdoptionEvidenceBundle(db, options());
    expect(bundle.delegations.stateCounts).toMatchObject({ currentM5: 3, shadowM5: 1, supersededM5: 1, shadowAndSupersededM5: 1, nonM5: 1, invalid: 1, reconciliation: { inWindow: 8, classified: 8, allMatch: true } });
    expect(bundle.delegations.currentRows).toBe(3);
    expect(bundle.delegations.reviewerUsefulness).toEqual({ present: 1, missing: 2 });
    expect(bundle.cost.calibration).toEqual({ present: 0, missing: 1 });
    expect(bundle.cost.reconciled).toMatchObject({ confidence: "partial", m5TotalUsd: null });
    expect(bundle.delegations.promotionReadiness).toMatchObject({ stateUnambiguous: false, costCoverageComplete: false, eligible: false });
    expect(bundle.nextAction.action).toBe("repair_measurement");
    const output = JSON.stringify(bundle);
    expect(output).not.toContain("old-policy");
    expect(output).not.toContain("sha256:bbbb");
    db.close();
  });

  it("fails closed on duplicate cost links instead of summing a 1:N delegation", () => {
    const db = createDb();
    insertOrganic(db, { opportunities: 20 });
    db.prepare(`INSERT INTO request_log (id, ts, tier, model, node, route, admission, total_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("r1", Date.parse("2026-08-01T10:00:00.000Z"), "owner", "mellum", "m5", "/delegate", "admitted", 5);
    db.prepare(`INSERT INTO delegations (id, ts, task_type, node_id, model_id, outcome, shadow, superseded_at, evidence_identity_hash, judge_policy, learning_task_admission_id, learning_task_instance_id, learning_task_attempt_id, reviewer_usefulness) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("d1", "2026-08-01T10:00:00.000Z", "code-edit", "m5", "mellum", "pass", 0, null, "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "ctx-tools-parts-v1|ctx=24000", "adm", "inst", "attempt", "pass");
    const cost = db.prepare(`INSERT INTO delegation_costs (id, ts, delegation_id, task_type, local_model, delegator_model, delegator_model_source, cost_status, prompt_tokens, completion_tokens, total_tokens, m5_marginal_cost_usd, m5_amortized_cost_usd, m5_total_cost_usd, verified_savings_actual_usd, verified_savings_premium_usd, potential_savings_actual_usd, potential_savings_premium_usd, price_catalog_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const costValues = ["2026-08-01T10:00:00.000Z", "d1", "code-edit", "mellum", "claude-sonnet-5", "stamped", "verified", 1, 2, 3, 0.01, 0.02, 0.12, 1, 2, 3, 4, "2026-08-29"] as const;
    cost.run("c1", ...costValues);
    cost.run("c2", ...costValues);
    const bundle = buildAdoptionEvidenceBundle(db, options());
    expect(bundle.cost.reconciliation).toMatchObject({
      currentDelegations: 1,
      linkedRows: 2,
      linkedDelegations: 1,
      missingDelegations: 0,
      duplicateLinks: 1,
      duplicateRows: 1,
      unlinkedRows: 0,
      unreconciledRows: 0,
      exactlyOnePerCurrentDelegation: false,
    });
    expect(bundle.cost.reconciled).toMatchObject({ rows: 2, confidence: "partial", m5TotalUsd: null });
    expect(bundle.delegations.promotionReadiness).toMatchObject({ costCoverageComplete: false, eligible: false });
    expect(bundle.nextAction.action).toBe("repair_measurement");
    db.close();
  });

  it("includes exact overflow totals but marks capped windows incomplete", () => {
    const db = createDb();
    createOverflowTable(db);
    insertOrganic(db, { opportunities: 20 });
    db.prepare(`INSERT INTO adoption_evidence_overflow
      (recorded_day, traffic_purpose, result, deterministic_check, reviewer_usefulness,
       fallback_reason, report_count, eligible_opportunities, unknown_opportunity_reports)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      "2026-08-02", "organic", "failed", "fail", "redo", "local_result_unusable", 3, 4, 0,
    );
    const bundle = buildAdoptionEvidenceBundle(db, options());
    expect(bundle.adoption.byPurpose.organic).toMatchObject({ reports: 4, knownOpportunities: 24, attempted: 4, useful: 1 });
    expect(bundle.adoption.breakdowns.result.filter((row) => row.reports > 0)).toEqual([
      { bucket: "completed", reports: 1, knownOpportunities: 20, attempted: 1, useful: 1 },
      { bucket: "failed", reports: 3, knownOpportunities: 4, attempted: 3, useful: 0 },
    ]);
    expect(bundle.adoption.breakdowns.usefulness.filter((row) => row.reports > 0)).toEqual([
      { bucket: "pass", reports: 1, knownOpportunities: 20, attempted: 1, useful: 1 },
      { bucket: "redo", reports: 3, knownOpportunities: 4, attempted: 3, useful: 0 },
    ]);
    expect(bundle.adoption.breakdowns.fallback.filter((row) => row.reports > 0)).toEqual([
      { bucket: "local_result_unusable", reports: 3, knownOpportunities: 4, attempted: 3, useful: 0 },
      { bucket: "none", reports: 1, knownOpportunities: 20, attempted: 1, useful: 1 },
    ]);
    expect(bundle.adoption.overflow).toMatchObject({
      retainedIndividualCount: 1,
      aggregatedCount: 3,
      droppedCount: 0,
      cappedDays: ["2026-08-02"],
      affectedDays: ["2026-08-02"],
      perHarnessAttribution: "unavailable",
      complete: false,
    });
    expect(bundle.completeness.adoptionEvidence).toMatchObject({
      retainedIndividualCount: 1,
      aggregatedCount: 3,
      droppedCount: 0,
      cappedDays: ["2026-08-02"],
      affectedDays: ["2026-08-02"],
      perHarnessAttribution: "unavailable",
      complete: false,
    });
    expect(bundle.delegations.promotionReadiness.eligible).toBe(false);
    expect(bundle.nextAction).toEqual({
      action: "repair_measurement",
      reason: "adoption evidence retention is capped; overflow cannot support complete promotion evidence",
    });
    db.close();
  });

  it("preserves mixed unknown opportunity denominators in a coalesced overflow row", () => {
    const db = createDb();
    createOverflowTable(db);
    insertOrganic(db, { opportunities: 20 });
    db.prepare(`INSERT INTO adoption_evidence_overflow
      (recorded_day, traffic_purpose, result, deterministic_check, reviewer_usefulness,
       fallback_reason, report_count, eligible_opportunities, unknown_opportunity_reports)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      "2026-08-02", "organic", "failed", "fail", "redo", "local_result_unusable", 2, 7, 1,
    );

    const bundle = buildAdoptionEvidenceBundle(db, options());
    expect(bundle.adoption.byPurpose.organic).toMatchObject({
      reports: 3,
      knownOpportunities: 27,
      unknownOpportunityDenominators: 1,
    });
    expect(bundle.completeness.missingness.unknownOpportunityDenominators).toBe(1);
    db.close();
  });
});

describe("read-only snapshot integration", () => {
  it("is query-only and rejects an active source WAL", () => {
    const root = mkdtempSync(join(tmpdir(), "gille-adoption-bundle-test-"));
    const dbPath = join(root, "eval.db");
    const db = createDb(dbPath);
    db.close();
    const snapshot = openReadOnlyDb(dbPath);
    expect(() => snapshot.prepare("CREATE TABLE forbidden (value TEXT)").run()).toThrow();
    closeReadOnlyDb(snapshot);

    const writer = new Database(dbPath);
    writer.pragma("journal_mode = WAL");
    writer.prepare("INSERT INTO adoption_evidence VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("2026-08-01", "claude", "delegate", "organic", "completed", "pass", "pass", "none", 1);
    expect(() => openReadOnlyDb(dbPath)).toThrow(/active WAL/);
    writer.close();
    rmSync(root, { recursive: true, force: true });
  });
});

describe("export-m5-adoption-evidence CLI", () => {
  it("requires explicit bounds and emits JSON without a publication/write path", () => {
    expect(() => parseExportArgs([])).toThrow(/--from is required/);
    const db = createDb();
    const output: string[] = [];
    const errors: string[] = [];
    let closed = false;
    const exitCode = exportMain(
      ["--db", "/private/operator/eval.db", "--from", FROM, "--through-exclusive", THROUGH],
      {
        openReadOnlyDb: () => db,
        closeReadOnlyDb: () => { closed = true; },
        writeStdout: (text) => output.push(text),
        writeStderr: (text) => errors.push(text),
      },
    );
    expect(exitCode).toBe(0);
    expect(errors).toEqual([]);
    expect(JSON.parse(output.join(""))).toMatchObject({
      contract: "m5-adoption-evidence-bundle-v1",
      window: { from: FROM, throughExclusive: THROUGH },
    });
    expect(closed).toBe(true);
    db.close();
  });
});
