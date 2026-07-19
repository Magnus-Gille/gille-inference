import { randomUUID, createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { getDb } from "../db.js";
import { DEFAULT_FORMAT_ONLY_DISCOUNT_TASK_TYPES, DEFAULT_JUDGMENT_QUALITY_TASK_TYPES, type PolicyConfig } from "./config.js";
import {
  classifyVerifierKind,
  isTrustedJudgmentVerifier,
  verifierBaseName,
  type VerifierKind,
} from "./verifier-classification.js";

/**
 * Capability ledger.
 *
 * Every time the orchestrator delegates a task to a local model, the attempt and its
 * verified outcome are recorded here. Aggregating the rows per (task_type, model)
 * gives a verdict — viable / marginal / not_viable / unknown — which the routing
 * policy uses to decide whether to keep delegating that kind of task to that model,
 * or to stop and escalate to a frontier model. This is how the system *learns* what
 * the local hardware can and cannot do, and stops wasting calls re-failing.
 */

// ─── Outcomes ────────────────────────────────────────────────────────────────────

/** unverified = ran but we had no verifier to judge it (does not affect verdicts). */
export type Outcome = "pass" | "partial" | "fail" | "error" | "unverified";

/**
 * Sub-classification for `error` outcomes. Only "infra" is excluded from verdict math
 * (a connection refused / 5xx says nothing about the model's capability). Everything
 * else — empty/truncated (budget-ceiling spirals, see overnight findings F1/F3),
 * timeout, unparseable output — IS capability-relevant and counts as a failure.
 */
export type ErrorClass = "empty" | "truncated" | "timeout" | "parse" | "infra";

const INFRA_ERROR_CLASSES: ReadonlySet<string> = new Set(["infra"]);

export interface DelegationRecord {
  /** Physical compute node that produced this evidence. Defaults to the legacy M5 path. */
  nodeId?: "m5" | "orin";
  taskType: string;
  modelId: string;
  prompt: string;
  outcome: Outcome;
  score?: number | null;
  latencyMs?: number | null;
  ttftMs?: number | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  tokPerSec?: number | null;
  verifier?: string | null;
  errorClass?: ErrorClass | null;
  /** True if the orchestrator handed the task off to a frontier model. */
  escalated?: boolean;
  /** Where the delegation came from: 'probe' | 'gateway' | 'build-chunk' | 'cli' ... */
  source?: string;
  /** Authenticated gateway/MCP key alias. Nullable for probes, CLI runs, and imports. */
  keyAlias?: string | null;
  notes?: string | null;
  /**
   * #91: structured mirror of the disagreement gate's signal (previously only encoded as a
   * `gate(shadow):<model> score=.. disagree=..` free-text note, queryable only by regex). All
   * four are nullable/optional — omitted entirely for a delegation the gate never ran against.
   */
  gateMode?: "off" | "shadow" | "on" | null;
  gateScore?: number | null;
  gateWouldEscalate?: boolean | null;
  gateError?: string | null;
  /**
   * #234: this row is CANDIDATE evidence from the shadow lane — a local model was run on a leaf the
   * router had already escalated to frontier, and nobody consumed its output. Such a row is real
   * evidence about the model, but it is NOT evidence of production performance, so every evidence
   * reader below (getVerdict / getLaneEvidence / ledgerReport) excludes it unless the caller opts in
   * with `includeShadow`. Defaults to false — an ordinary delegation is never shadow.
   */
  shadow?: boolean;
}

// ─── Verdict ───────────────────────────────────────────────────────────────────

export type Verdict = "unknown" | "viable" | "marginal" | "not_viable";

export interface VerdictResult {
  nodeId: "m5" | "orin";
  taskType: string;
  modelId: string;
  verdict: Verdict;
  attempts: number; // verdict-relevant attempts (infra errors excluded)
  passes: number;
  partials: number;
  fails: number;
  errors: number; // capability-relevant errors only
  successRate: number; // (passes + 0.5*partials) / attempts, weighted by evidenceWeight() (#233)
  /** Verdict is stable — enough evidence gathered; stop changing it. */
  frozen: boolean;
  /**
   * #233: of `attempts`, how many passed/partialled on a `mechanical-format` verifier (shape/pattern
   * check) rather than a `truth-oriented` one. Exposed so a report rollup can compute formatOnlyShare
   * without a second query; also what `evidenceWeight()` discounts when
   * `policy.discountFormatOnlyEvidence` is on for this task type.
   */
  mechanicalFormatAttempts: number;
}

export interface DelegationDecision {
  delegate: boolean;
  reason: string;
  verdict: VerdictResult;
}

// ─── Schema (additive; lives alongside the eval tables in the shared DB) ──────────

let _initialised = false;

function ensureSchema(db: Database.Database): void {
  if (_initialised) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS delegations (
      id                TEXT PRIMARY KEY,
      ts                TEXT NOT NULL,
      task_type         TEXT NOT NULL,
      node_id           TEXT NOT NULL DEFAULT 'm5',
      model_id          TEXT NOT NULL,
      prompt_hash       TEXT NOT NULL,
      prompt_excerpt    TEXT,
      outcome           TEXT NOT NULL,
      score             REAL,
      latency_ms        INTEGER,
      ttft_ms           INTEGER,
      prompt_tokens     INTEGER,
      completion_tokens INTEGER,
      tok_per_s         REAL,
      verifier          TEXT,
      error_class       TEXT,
      escalated         INTEGER NOT NULL DEFAULT 0,
      source            TEXT,
      notes             TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_deleg_type_model ON delegations(task_type, model_id);
    CREATE INDEX IF NOT EXISTS idx_deleg_ts         ON delegations(ts);
  `);

  // #91: additive, idempotent migration — structured mirror of the disagreement gate's signal
  // (see DelegationRecord.gateMode/gateScore/gateWouldEscalate/gateError). Guarded by the
  // table_info check so re-running on an already-migrated DB is a no-op (same pattern as
  // keystore.ts's logical_alias migration).
  const cols = db.prepare(`PRAGMA table_info(delegations)`).all() as Array<{ name: string }>;
  const names = new Set(cols.map((c) => c.name));
  db.transaction(() => {
    if (!names.has("gate_mode")) db.exec(`ALTER TABLE delegations ADD COLUMN gate_mode TEXT`);
    if (!names.has("gate_score")) db.exec(`ALTER TABLE delegations ADD COLUMN gate_score REAL`);
    if (!names.has("gate_would_escalate")) {
      db.exec(`ALTER TABLE delegations ADD COLUMN gate_would_escalate INTEGER`);
    }
    if (!names.has("gate_error")) db.exec(`ALTER TABLE delegations ADD COLUMN gate_error TEXT`);
    if (!names.has("key_alias")) db.exec(`ALTER TABLE delegations ADD COLUMN key_alias TEXT`);
    if (!names.has("node_id")) db.exec(`ALTER TABLE delegations ADD COLUMN node_id TEXT NOT NULL DEFAULT 'm5'`);
    // #217: grading-policy epoch + supersede marker. NULL judge_policy = pre-epoch verdicts (the
    // excluded-taint window); superseded_at non-NULL = replaced by a rejudge under a newer policy
    // (audit trail preserved — evidence readers must filter `superseded_at IS NULL`).
    if (!names.has("judge_policy")) db.exec(`ALTER TABLE delegations ADD COLUMN judge_policy TEXT`);
    if (!names.has("superseded_at")) db.exec(`ALTER TABLE delegations ADD COLUMN superseded_at TEXT`);
    // #234: shadow-lane candidate evidence. NOT NULL DEFAULT 0 so every legacy row reads as a real
    // (non-shadow) delegation — the evidence readers only ever EXCLUDE shadow=1, never re-include a
    // legacy row by accident.
    if (!names.has("shadow")) db.exec(`ALTER TABLE delegations ADD COLUMN shadow INTEGER NOT NULL DEFAULT 0`);
  })();
  db.exec(`CREATE INDEX IF NOT EXISTS idx_deleg_gate_mode ON delegations(gate_mode)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_deleg_key_alias ON delegations(key_alias)`);
  // The column may have just been added above on an existing production DB, so create this index
  // only AFTER the additive migration. Creating it in the initial CREATE batch makes startup fail
  // before ALTER TABLE gets a chance to add node_id (#206 live-deploy regression).
  db.exec(`CREATE INDEX IF NOT EXISTS idx_deleg_node_type_model ON delegations(node_id, task_type, model_id)`);

  _initialised = true;
}

function ledgerDb(): Database.Database {
  const db = getDb();
  ensureSchema(db);
  return db;
}

/** Eagerly create the delegations schema (idempotent). Useful for migrations and tests. */
export function ensureLedgerSchema(): void {
  ensureSchema(getDb());
}

function hashPrompt(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex").slice(0, 16);
}

// ─── Write ───────────────────────────────────────────────────────────────────────

export function recordDelegation(rec: DelegationRecord): string {
  const db = ledgerDb();
  const id = randomUUID();
  const ts = new Date().toISOString();
  const excerpt = rec.prompt.slice(0, 280);

  db.prepare(
    `INSERT INTO delegations
       (id, ts, task_type, node_id, model_id, prompt_hash, prompt_excerpt, outcome, score,
        latency_ms, ttft_ms, prompt_tokens, completion_tokens, tok_per_s, verifier,
        error_class, escalated, source, notes,
        gate_mode, gate_score, gate_would_escalate, gate_error, key_alias, shadow)
     VALUES
       (@id, @ts, @taskType, @nodeId, @modelId, @promptHash, @promptExcerpt, @outcome, @score,
        @latencyMs, @ttftMs, @promptTokens, @completionTokens, @tokPerSec, @verifier,
        @errorClass, @escalated, @source, @notes,
        @gateMode, @gateScore, @gateWouldEscalate, @gateError, @keyAlias, @shadow)`
  ).run({
    id,
    ts,
    taskType: rec.taskType,
    nodeId: rec.nodeId ?? "m5",
    modelId: rec.modelId,
    promptHash: hashPrompt(rec.prompt),
    promptExcerpt: excerpt,
    outcome: rec.outcome,
    score: rec.score ?? null,
    latencyMs: rec.latencyMs ?? null,
    ttftMs: rec.ttftMs ?? null,
    promptTokens: rec.promptTokens ?? null,
    completionTokens: rec.completionTokens ?? null,
    tokPerSec: rec.tokPerSec ?? null,
    verifier: rec.verifier ?? null,
    errorClass: rec.errorClass ?? null,
    escalated: rec.escalated ? 1 : 0,
    source: rec.source ?? null,
    notes: rec.notes ?? null,
    gateMode: rec.gateMode ?? null,
    gateScore: rec.gateScore ?? null,
    gateWouldEscalate: rec.gateWouldEscalate === null || rec.gateWouldEscalate === undefined ? null : rec.gateWouldEscalate ? 1 : 0,
    gateError: rec.gateError ?? null,
    keyAlias: rec.keyAlias ?? null,
    shadow: rec.shadow ? 1 : 0,
  });
  return id;
}

// ─── Durable import of externally-produced probe evidence (#151) ──────────────────
//
// Incident (#150): a probe battery's results lived only in a JSONL file on ephemeral disk;
// when the file evaporated the routing-table generator lost the reason-hard evidence and the
// type silently regressed to escalate-frontier. Probe paths that go through delegate() or the
// cartography already write the ledger at probe time — this is the idempotent bridge for
// battery outputs produced OUTSIDE those paths (ad-hoc JSONL batteries, recovered artifacts),
// so the evidence class lands in the durable store instead of only on disk.

export interface ImportableDelegation extends DelegationRecord {
  /** Original probe-time timestamp (ISO). Preserved verbatim — evidence freshness is data. */
  ts: string;
  /**
   * Grading-policy epoch stamp (#217, e.g. "ctx-tools-parts-v1|ctx=24000") — set by harvest
   * writers via buildJudgePolicyStamp. Absent/NULL = pre-epoch evidence (probe imports and the
   * pre-2026-07-11 harvest cohort). Part of the content-hash identity WHEN present, so a
   * rejudge under a new policy inserts alongside the legacy row instead of colliding with it.
   */
  judgePolicy?: string | null;
  /**
   * Repeat counter from the battery (identity only, not stored — the delegations schema has no
   * repeat column). Batteries can stamp one run-level ts on every line and run the same probe N
   * times; without this in the id, distinct trials would collapse into one "duplicate".
   */
  repeat?: number | null;
}

const VALID_OUTCOMES: ReadonlySet<string> = new Set([
  "pass",
  "partial",
  "fail",
  "error",
  "unverified",
]);

/**
 * Deterministic content-hash id: byte-identical evidence imports to the same row. `notes`
 * (carrying the probe id) and `repeat` are part of the identity — probe prompts are often
 * absent from battery JSONL (cartography lines carry only an output preview), so without them
 * two distinct trials sharing a timestamp would silently merge and undercount attempts.
 */
function importId(rec: ImportableDelegation): string {
  const key = JSON.stringify([
    rec.ts,
    rec.taskType,
    rec.nodeId ?? "m5",
    rec.modelId,
    hashPrompt(rec.prompt),
    rec.outcome,
    rec.score ?? null,
    rec.verifier ?? null,
    rec.source ?? null,
    rec.notes ?? null,
    rec.repeat ?? null,
    // #217: appended ONLY when present so every pre-policy record hashes exactly as before —
    // changing the key shape unconditionally would break idempotent re-imports of historical
    // JSONL (every legacy row would re-import under a new id). A policy-stamped rejudge is a
    // DISTINCT identity on purpose: it must insert alongside the (superseded) legacy row.
    ...(rec.judgePolicy != null ? [rec.judgePolicy] : []),
  ]);
  return "imp-" + createHash("sha256").update(key).digest("hex").slice(0, 32);
}

/**
 * Idempotently import probe evidence into the delegations ledger. Every record is validated
 * up front (invalid outcome / missing timestamp throws — junk evidence must never be stored
 * silently) and inserted with a deterministic content-hash id, so re-importing the same JSONL
 * (or a resumed battery's duplicated lines) inserts nothing new.
 */
export function importDelegations(records: ImportableDelegation[]): {
  inserted: number;
  skipped: number;
} {
  for (const [i, rec] of records.entries()) {
    if (!rec.ts || typeof rec.ts !== "string") {
      throw new Error(`importDelegations: record ${i} has no ts (undated evidence is not durable evidence)`);
    }
    if (!VALID_OUTCOMES.has(rec.outcome)) {
      throw new Error(
        `importDelegations: record ${i} has invalid outcome ${JSON.stringify(rec.outcome)} (expected one of ${[...VALID_OUTCOMES].join("|")})`
      );
    }
    if (!rec.taskType || !rec.modelId) {
      throw new Error(`importDelegations: record ${i} is missing taskType/modelId`);
    }
  }

  const db = ledgerDb();
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO delegations
       (id, ts, task_type, node_id, model_id, prompt_hash, prompt_excerpt, outcome, score,
        latency_ms, ttft_ms, prompt_tokens, completion_tokens, tok_per_s, verifier,
        error_class, escalated, source, notes, judge_policy)
     VALUES
       (@id, @ts, @taskType, @nodeId, @modelId, @promptHash, @promptExcerpt, @outcome, @score,
        @latencyMs, @ttftMs, @promptTokens, @completionTokens, @tokPerSec, @verifier,
        @errorClass, @escalated, @source, @notes, @judgePolicy)`
  );

  let inserted = 0;
  db.transaction(() => {
    for (const rec of records) {
      const info = stmt.run({
        id: importId(rec),
        ts: rec.ts,
        taskType: rec.taskType,
        nodeId: rec.nodeId ?? "m5",
        modelId: rec.modelId,
        promptHash: hashPrompt(rec.prompt),
        promptExcerpt: rec.prompt.slice(0, 280),
        outcome: rec.outcome,
        score: rec.score ?? null,
        latencyMs: rec.latencyMs ?? null,
        ttftMs: rec.ttftMs ?? null,
        promptTokens: rec.promptTokens ?? null,
        completionTokens: rec.completionTokens ?? null,
        tokPerSec: rec.tokPerSec ?? null,
        verifier: rec.verifier ?? null,
        errorClass: rec.errorClass ?? null,
        escalated: rec.escalated ? 1 : 0,
        source: rec.source ?? "probe-import",
        notes: rec.notes ?? null,
        judgePolicy: rec.judgePolicy ?? null,
      });
      inserted += info.changes;
    }
  })();

  return { inserted, skipped: records.length - inserted };
}

/**
 * Supersede-not-duplicate (#217): mark every LIVE harvest verdict for the given source rows as
 * superseded, so a policy-epoch rejudge replaces old evidence without deleting the audit trail
 * and without double-counting attempts (all evidence readers filter `superseded_at IS NULL`).
 * The rejudge flow calls this BEFORE importing the new verdicts — a crash in between leaves the
 * id verdict-less (neither current nor stale), which the next `--rejudge-existing` run regrades:
 * self-healing, never double-counted. Row identity = the FIRST `#<id>` token in notes, parsed in
 * JS with the exact regex the idempotency loader uses — never an unanchored SQL LIKE, which would
 * also match ids quoted in judge reason text (and #21 must not match "#210:").
 */
export function supersedeHarvestVerdicts(p: {
  sourceTag: string;
  sourceRowIds: number[];
  nowIso: string;
}): number {
  if (p.sourceRowIds.length === 0) return 0;
  const db = ledgerDb();
  // A row's source identity is the FIRST `#<id>` token in notes — the exact parse the harvest
  // idempotency loader uses. An unanchored SQL LIKE would also match `#<id>:` quoted inside a
  // judge's free-text REASON and silently retire unrelated live evidence (codex review of #226),
  // so candidate rows are parsed in JS and updated by primary key.
  const wanted = new Set(p.sourceRowIds);
  const candidates = db
    .prepare(
      `SELECT id, notes FROM delegations
       WHERE source = ? AND superseded_at IS NULL AND notes LIKE '%#%'`
    )
    .all(p.sourceTag) as { id: string; notes: string | null }[];
  const rowPks = candidates
    .filter((r) => {
      const m = r.notes?.match(/#(\d+)/);
      return m ? wanted.has(Number(m[1])) : false;
    })
    .map((r) => r.id);
  if (rowPks.length === 0) return 0;
  const stmt = db.prepare(`UPDATE delegations SET superseded_at = @now WHERE id = @pk AND superseded_at IS NULL`);
  let changed = 0;
  db.transaction(() => {
    for (const pk of rowPks) changed += stmt.run({ now: p.nowIso, pk }).changes;
  })();
  return changed;
}

// ─── Verdict computation ───────────────────────────────────────────────────────

interface OutcomeRow {
  outcome: string;
  error_class: string | null;
  verifier: string | null;
}

interface LaneOutcomeRow extends OutcomeRow {
  latency_ms: number | null;
  source: string | null;
  ts: string;
}

export interface LaneEvidence {
  taskType: string;
  modelId: string;
  verifier: string | null;
  attempts: number;
  passes: number;
  partials: number;
  fails: number;
  errors: number;
  successRate: number;
  errorRate: number;
  p50LatencyMs: number | null;
  p90LatencyMs: number | null;
  latestTs: string | null;
  sources: Record<string, number>;
}

const EXCLUDED_LANE_EVIDENCE_SOURCES: ReadonlySet<string> = new Set(["harvest-shadow"]);

function normalizedVerifierName(name: string | null | undefined): string | null {
  const trimmed = name?.trim();
  if (!trimmed || verifierBaseName(trimmed) === "none") return null;
  return trimmed;
}

function percentile(values: number[], p: number): number | null {
  const xs = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const idx = Math.min(xs.length - 1, Math.floor((xs.length - 1) * p));
  return Math.round(xs[idx]!);
}

function judgmentEvidenceConfig(policy: PolicyConfig): {
  judgmentQualityTypes: string[];
  trustedJudgmentVerifiers: ReadonlySet<string>;
} {
  return {
    judgmentQualityTypes: policy.judgmentQualityTaskTypes ?? DEFAULT_JUDGMENT_QUALITY_TASK_TYPES,
    trustedJudgmentVerifiers: new Set(policy.trustedVerifiersForJudgment ?? []),
  };
}

/**
 * #233: weight for one pass/partial row's contribution to successRate. A `mechanical-format`
 * verifier's pass on a JUDGMENT-FLAVORED task type (policy.formatOnlyDiscountTaskTypes) is real but
 * weaker evidence than a `truth-oriented` one — gameable by output that merely looks right. Returns 1
 * (full weight, current behaviour) unless the discount is enabled AND this row's task type is
 * configured AND its verifier classifies as mechanical-format.
 */
function evidenceWeight(taskType: string, verifierName: string | null, policy: PolicyConfig): number {
  if (!policy.discountFormatOnlyEvidence) return 1;
  const discountTypes = policy.formatOnlyDiscountTaskTypes ?? DEFAULT_FORMAT_ONLY_DISCOUNT_TASK_TYPES;
  if (!discountTypes.includes(taskType)) return 1;
  return classifyVerifierKind(verifierName) === "mechanical-format" ? policy.formatOnlyDiscountWeight : 1;
}

/**
 * #234: default-off evidence toggle. `includeShadow: true` re-admits shadow-lane candidate rows into
 * an evidence query — the ONLY way to see them, used by an explicit `?includeShadow=1` reader and by
 * a future promotion gate (#158). Every reader defaults to EXCLUDING shadow rows.
 */
export interface EvidenceReadOpts {
  includeShadow?: boolean;
}

/** SQL fragment excluding shadow rows unless the caller opts in. Empty string re-admits them. */
function shadowFilter(opts?: EvidenceReadOpts): string {
  return opts?.includeShadow ? "" : " AND shadow = 0";
}

export function getVerdict(
  taskType: string,
  modelId: string,
  policy: PolicyConfig,
  nodeId: "m5" | "orin" = "m5",
  opts?: EvidenceReadOpts
): VerdictResult {
  const db = ledgerDb();
  const rows = db
    .prepare(
      `SELECT outcome, error_class, verifier FROM delegations
       WHERE task_type = ? AND model_id = ? AND node_id = ? AND outcome != 'unverified'
         AND superseded_at IS NULL${shadowFilter(opts)}`
    )
    .all(taskType, modelId, nodeId) as OutcomeRow[];

  // #168 verdict hygiene (WHITELIST, superseding #156's blacklist): for a JUDGMENT-QUALITY task type
  // (code-review at minimum) a row is admissible as evidence ONLY IF its verifier is one we
  // positively TRUST to grade that quality (policy.trustedVerifiersForJudgment). A whitelist is
  // strictly stronger than #156's structural blacklist and subsumes it — the blacklist could exclude
  // KNOWN-structural verifiers but still admitted opaque/non-adversarial checks (the scout's own
  // `predicate` probe, `matches`) that pass while finding ~6% of real seeded bugs (2026-07-05 sweep),
  // so a nonEmpty pass — or a `predicate` pass — must not manufacture a verdict in EITHER direction.
  // Only the whitelist runs for judgment types (never both, redundantly). The default whitelist is
  // EMPTY, so a judgment type with only ordinary local-verifier rows has attempts=0 → `unknown`
  // (→ frontier), never a false viable/not_viable — the honest state until #158 lands a ground-truth
  // reviewer-grading verifier and adds its name here. Non-judgment types are unaffected (all their
  // verifier rows remain valid evidence).
  const judgmentQualityTypes = policy.judgmentQualityTaskTypes ?? DEFAULT_JUDGMENT_QUALITY_TASK_TYPES;
  const isJudgmentType = judgmentQualityTypes.includes(taskType);
  const trustedJudgmentVerifiers = new Set(policy.trustedVerifiersForJudgment ?? []);

  let passes = 0;
  let partials = 0;
  let fails = 0;
  let errors = 0;
  let effective = 0; // #233: weighted pass/partial sum — discounted for format-only evidence when enabled
  let mechanicalFormatAttempts = 0;
  for (const r of rows) {
    if (isJudgmentType && !isTrustedJudgmentVerifier(r.verifier, trustedJudgmentVerifiers)) {
      continue; // inadmissible: only whitelisted-verifier evidence grades a judgment-quality type
    }
    // Infra errors are not the model's fault — exclude from capability verdict.
    if (r.outcome === "error" && r.error_class && INFRA_ERROR_CLASSES.has(r.error_class)) {
      continue;
    }
    const isMechanicalFormat = classifyVerifierKind(r.verifier) === "mechanical-format";
    switch (r.outcome) {
      case "pass":
        passes++;
        if (isMechanicalFormat) mechanicalFormatAttempts++;
        effective += evidenceWeight(taskType, r.verifier, policy);
        break;
      case "partial":
        partials++;
        if (isMechanicalFormat) mechanicalFormatAttempts++;
        effective += 0.5 * evidenceWeight(taskType, r.verifier, policy);
        break;
      case "fail":
        fails++;
        break;
      case "error":
        errors++;
        break;
      default:
        break;
    }
  }

  const attempts = passes + partials + fails + errors;
  const successRate = attempts > 0 ? effective / attempts : 0;
  const capabilityFails = fails + errors;

  let verdict: Verdict;
  if (attempts === 0) {
    verdict = "unknown";
  } else if (passes === 0 && capabilityFails >= policy.maxFails) {
    verdict = "not_viable"; // clear, fast strike-out
  } else if (attempts < policy.minSamples) {
    verdict = "unknown";
  } else if (successRate >= policy.viableThreshold) {
    verdict = "viable";
  } else if (successRate >= policy.marginalThreshold) {
    verdict = "marginal";
  } else {
    verdict = "not_viable";
  }

  const frozen =
    (verdict === "not_viable" && passes === 0 && capabilityFails >= policy.maxFails) ||
    attempts >= policy.maxSamples ||
    (verdict === "viable" && attempts >= policy.minSamples) ||
    (verdict === "not_viable" && attempts >= policy.minSamples);

  return {
    nodeId,
    taskType,
    modelId,
    verdict,
    attempts,
    passes,
    partials,
    fails,
    errors,
    successRate: Math.round(successRate * 100) / 100,
    frozen,
    mechanicalFormatAttempts,
  };
}

/**
 * Content-blind evidence for one production lane: task type × local model × verifier.
 *
 * This is stricter than getVerdict() because production delegation needs to know whether the exact
 * verifier-backed lane is reliable, not merely whether any verifier has ever passed for the task
 * type/model pair. It deliberately ignores unverified rows and excludes infra errors from both
 * attempts and latency, matching getVerdict()'s "not a model capability signal" rule.
 */
export function getLaneEvidence(
  taskType: string,
  modelId: string,
  verifier: string | null | undefined,
  policy: PolicyConfig,
  nodeId: "m5" | "orin" = "m5",
  opts?: EvidenceReadOpts
): LaneEvidence {
  const db = ledgerDb();
  const wantedVerifier = normalizedVerifierName(verifier);
  const rows = db
    .prepare(
      `SELECT outcome, error_class, verifier, latency_ms, source, ts
       FROM delegations
       WHERE task_type = ? AND model_id = ? AND node_id = ? AND outcome != 'unverified'
         AND superseded_at IS NULL${shadowFilter(opts)}`
    )
    .all(taskType, modelId, nodeId) as LaneOutcomeRow[];

  const { judgmentQualityTypes, trustedJudgmentVerifiers } = judgmentEvidenceConfig(policy);
  const isJudgmentType = judgmentQualityTypes.includes(taskType);

  let passes = 0;
  let partials = 0;
  let fails = 0;
  let errors = 0;
  let effective = 0; // #233: weighted pass/partial sum — discounted for format-only evidence when enabled
  let latestTs: string | null = null;
  const latencies: number[] = [];
  const sources: Record<string, number> = Object.create(null) as Record<string, number>;

  for (const r of rows) {
    const source = r.source ?? "unknown";
    if (EXCLUDED_LANE_EVIDENCE_SOURCES.has(source)) continue;

    const rowVerifier = normalizedVerifierName(r.verifier);
    if (rowVerifier !== wantedVerifier) continue;
    if (isJudgmentType && !isTrustedJudgmentVerifier(r.verifier, trustedJudgmentVerifiers)) continue;
    if (r.outcome === "error" && r.error_class && INFRA_ERROR_CLASSES.has(r.error_class)) continue;

    sources[source] = (sources[source] ?? 0) + 1;
    if (r.latency_ms !== null) latencies.push(r.latency_ms);
    if (latestTs === null || r.ts > latestTs) latestTs = r.ts;

    switch (r.outcome) {
      case "pass":
        passes++;
        effective += evidenceWeight(taskType, r.verifier, policy);
        break;
      case "partial":
        partials++;
        effective += 0.5 * evidenceWeight(taskType, r.verifier, policy);
        break;
      case "fail":
        fails++;
        break;
      case "error":
        errors++;
        break;
      default:
        break;
    }
  }

  const attempts = passes + partials + fails + errors;
  const successRate = attempts > 0 ? effective / attempts : 0;
  const errorRate = attempts > 0 ? errors / attempts : 0;

  return {
    taskType,
    modelId,
    verifier: wantedVerifier,
    attempts,
    passes,
    partials,
    fails,
    errors,
    successRate,
    errorRate,
    p50LatencyMs: percentile(latencies, 0.5),
    p90LatencyMs: percentile(latencies, 0.9),
    latestTs,
    sources,
  };
}

// ─── Routing decision ────────────────────────────────────────────────────────────

/**
 * Decide whether to delegate (task_type, model) to the local model.
 *
 * The learning rule: once a type is a *frozen* not_viable, stop delegating it (escalate
 * to a frontier model instead) — except for an occasional exploration re-probe to catch
 * a model that has since improved. Unknown / marginal / viable types are delegated
 * (we either still need data, or it works).
 *
 * `rand` is injectable so tests are deterministic.
 */
export function shouldDelegate(
  taskType: string,
  modelId: string,
  policy: PolicyConfig,
  rand: () => number = Math.random,
  nodeId: "m5" | "orin" = "m5"
): DelegationDecision {
  const verdict = getVerdict(taskType, modelId, policy, nodeId);

  // Once a non-viable verdict is FROZEN (enough evidence gathered), stop delegating —
  // this covers both not_viable AND a marginal verdict that has hit the sample cap, so
  // a consistently-mediocre task type is not re-delegated forever. An occasional
  // exploration re-probe still fires to catch a model that has since improved.
  const frozenNonViable =
    verdict.frozen && (verdict.verdict === "not_viable" || verdict.verdict === "marginal");
  if (frozenNonViable) {
    if (rand() < policy.explorationRate) {
      return {
        delegate: true,
        reason: `exploration re-probe of frozen ${verdict.verdict} (${verdict.passes}/${verdict.attempts})`,
        verdict,
      };
    }
    return {
      delegate: false,
      reason: `${verdict.verdict} & frozen (${verdict.passes}/${verdict.attempts} pass, rate ${verdict.successRate}) — escalate to frontier`,
      verdict,
    };
  }

  return {
    delegate: true,
    reason: `${verdict.verdict} (${verdict.passes}/${verdict.attempts} pass, rate ${verdict.successRate})`,
    verdict,
  };
}

// ─── Reporting ─────────────────────────────────────────────────────────────────

export interface LedgerReportRow extends VerdictResult {
  recommendation: "delegate-local" | "explore" | "escalate-frontier";
  avgLatencyMs: number | null;
  avgTokPerSec: number | null;
  /**
   * #233: share of ALL rows recorded for this cell (including the ones excluded from `attempts`,
   * e.g. unverified) that were never checked at all (`outcome === "unverified"`) — successful-but-
   * never-verified evidence, invisible to verdict math but real usage. 0 when the cell has no rows
   * (never happens — a cell only exists here because it has ≥1 row) or none are unverified.
   */
  unverifiedShare: number;
  /**
   * #233: of `attempts` (the verdict-relevant, non-unverified population), the share that passed on a
   * `mechanical-format` verifier rather than a `truth-oriented` one — see verifier-classification.ts.
   * High formatOnlyShare on a judgment-flavored task type means the headline pass rate is weaker
   * evidence than it looks. 0 (never NaN) when `attempts` is 0.
   */
  formatOnlyShare: number;
}

export function ledgerReport(policy: PolicyConfig, opts?: EvidenceReadOpts): LedgerReportRow[] {
  const db = ledgerDb();
  // The shadow filter applies to the CELL ENUMERATION too, not just the per-cell verdict: a task
  // type whose ONLY rows are shadow rows must not surface as a cell at all in the default report
  // (it would read as a real, zero-attempt lane and quietly imply the router has looked at it).
  const pairs = db
    .prepare(
      `SELECT node_id AS nodeId, task_type AS taskType, model_id AS modelId,
              AVG(latency_ms) AS avgLatencyMs, AVG(tok_per_s) AS avgTokPerSec,
              COUNT(*) AS totalRows,
              SUM(CASE WHEN outcome = 'unverified' THEN 1 ELSE 0 END) AS unverifiedRows
       FROM delegations
       WHERE superseded_at IS NULL${shadowFilter(opts)}
       GROUP BY node_id, task_type, model_id
       ORDER BY node_id, task_type, model_id`
    )
    .all() as Array<{
    nodeId: "m5" | "orin";
    taskType: string;
    modelId: string;
    avgLatencyMs: number | null;
    avgTokPerSec: number | null;
    totalRows: number;
    unverifiedRows: number;
  }>;

  return pairs.map((p) => {
    const v = getVerdict(p.taskType, p.modelId, policy, p.nodeId, opts);
    let recommendation: LedgerReportRow["recommendation"];
    if (v.verdict === "viable") recommendation = "delegate-local";
    else if (v.frozen && (v.verdict === "not_viable" || v.verdict === "marginal"))
      recommendation = "escalate-frontier";
    else recommendation = "explore";
    return {
      ...v,
      recommendation,
      avgLatencyMs: p.avgLatencyMs !== null ? Math.round(p.avgLatencyMs) : null,
      avgTokPerSec: p.avgTokPerSec !== null ? Math.round(p.avgTokPerSec * 10) / 10 : null,
      unverifiedShare: p.totalRows > 0 ? p.unverifiedRows / p.totalRows : 0,
      formatOnlyShare: v.attempts > 0 ? v.mechanicalFormatAttempts / v.attempts : 0,
    };
  });
}

export interface RecentDelegation {
  id: string;
  ts: string;
  nodeId: "m5" | "orin";
  taskType: string;
  modelId: string;
  outcome: string;
  score: number | null;
  latencyMs: number | null;
  verifier: string | null;
  source: string | null;
  keyAlias: string | null;
  gateMode: "off" | "shadow" | "on" | null;
  gateScore: number | null;
  gateWouldEscalate: boolean | null;
  gateError: string | null;
  /** Non-null when a policy-epoch rejudge replaced this row (#217) — audit-visible, evidence-invisible. */
  supersededAt: string | null;
  /** #233: mechanical-format | truth-oriented | ungraded, derived from `verifier` — see verifier-classification.ts. */
  verifierKind: VerifierKind;
  /** #234: shadow-lane candidate evidence — audit-visible here, invisible to every default rollup. */
  shadow: boolean;
}

interface RecentDelegationRow {
  id: string;
  ts: string;
  nodeId: "m5" | "orin";
  taskType: string;
  modelId: string;
  outcome: string;
  score: number | null;
  latencyMs: number | null;
  verifier: string | null;
  source: string | null;
  keyAlias: string | null;
  gateMode: "off" | "shadow" | "on" | null;
  gateScore: number | null;
  gateWouldEscalate: 0 | 1 | null;
  gateError: string | null;
  /** Non-null when a policy-epoch rejudge replaced this row (#217) — audit-visible, evidence-invisible. */
  supersededAt: string | null;
  shadow: 0 | 1;
}

export function recentDelegations(limit = 50): RecentDelegation[] {
  const db = ledgerDb();
  // Deliberately an AUDIT view (#217): superseded rows stay VISIBLE — unlike the evidence
  // readers, which exclude them — but carry supersededAt so they are distinguishable.
  const rows = db
    .prepare(
      `SELECT id, ts, node_id AS nodeId, task_type AS taskType, model_id AS modelId, outcome, score,
              latency_ms AS latencyMs, verifier, source, key_alias AS keyAlias,
              gate_mode AS gateMode, gate_score AS gateScore,
              gate_would_escalate AS gateWouldEscalate, gate_error AS gateError,
              superseded_at AS supersededAt, shadow
       FROM delegations ORDER BY ts DESC LIMIT ?`
    )
    .all(limit) as RecentDelegationRow[];
  return rows.map((r) => ({
    ...r,
    gateWouldEscalate: r.gateWouldEscalate === null ? null : r.gateWouldEscalate === 1,
    verifierKind: classifyVerifierKind(r.verifier),
    shadow: r.shadow === 1,
  }));
}

/**
 * Id-addressable single-row read (#227): `recordDelegation`'s return value is the same `id`
 * stored here, and POST /delegate echoes it as `costTrace.delegationId` — this is the join back
 * from a held ledgerId to its exact evidence row, with no timestamp matching. Superseded rows
 * (#217 rejudge) are still resolvable by id — the audit trail stays addressable even after a
 * newer verdict replaces it in evidence-reading queries.
 */
export function getDelegationById(id: string): RecentDelegation | null {
  const db = ledgerDb();
  const row = db
    .prepare(
      `SELECT id, ts, node_id AS nodeId, task_type AS taskType, model_id AS modelId, outcome, score,
              latency_ms AS latencyMs, verifier, source, key_alias AS keyAlias,
              gate_mode AS gateMode, gate_score AS gateScore,
              gate_would_escalate AS gateWouldEscalate, gate_error AS gateError,
              superseded_at AS supersededAt, shadow
       FROM delegations WHERE id = ?`
    )
    .get(id) as RecentDelegationRow | undefined;
  if (!row) return null;
  return {
    ...row,
    gateWouldEscalate: row.gateWouldEscalate === null ? null : row.gateWouldEscalate === 1,
    verifierKind: classifyVerifierKind(row.verifier),
    shadow: row.shadow === 1,
  };
}

// ─── Gate fire-rate (#91) ──────────────────────────────────────────────────────
// Replaces the `notes LIKE 'gate(shadow):%disagree=1%'` regex query (docs/cascade-gate-
// experiment-design.md) with a clean predicate over the structured gate_* columns.

export interface GateFireRateResult {
  /** Rows the gate actually ran against (gate_mode matches the filter, or is non-NULL if unfiltered). */
  gated: number;
  /** Of those, how many the gate would have escalated (gate_would_escalate = 1). */
  wouldEscalate: number;
  /** Of those, how many the secondary model itself errored on (gate_error IS NOT NULL). */
  secondaryErrors: number;
  /** wouldEscalate / gated, or 0 (never NaN) when gated is 0. */
  rate: number;
}

export function gateFireRate(mode?: "off" | "shadow" | "on"): GateFireRateResult {
  const db = ledgerDb();
  const where = mode !== undefined ? `WHERE gate_mode = @mode` : `WHERE gate_mode IS NOT NULL`;
  const row = db
    .prepare(
      `SELECT
         COUNT(*) AS gated,
         COALESCE(SUM(gate_would_escalate), 0) AS wouldEscalate,
         COALESCE(SUM(CASE WHEN gate_error IS NOT NULL THEN 1 ELSE 0 END), 0) AS secondaryErrors
       FROM delegations ${where}`
    )
    .get(mode !== undefined ? { mode } : {}) as { gated: number; wouldEscalate: number; secondaryErrors: number };
  return { ...row, rate: row.gated > 0 ? row.wouldEscalate / row.gated : 0 };
}
