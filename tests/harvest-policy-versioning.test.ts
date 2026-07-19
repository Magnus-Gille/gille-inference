/**
 * TDD suite for harvest grading-policy versioning + explicit rejudge semantics (issue #217).
 *
 * Written BEFORE the implementation (red→green). Incident class (2026-07-11): three separate
 * hand-deletions of stale shadow verdicts were needed to regrade rows after the #216/#222
 * interpretation-policy changes — the idempotency key (`#<id>` in notes, per source) encodes no
 * policy epoch, so a verdict graded under an obsolete policy blocks regrading forever, and the
 * pre-#213 context-blind cohort is separable from context-aware rows only by timestamp tribal
 * knowledge. This suite covers:
 *   (a) every new harvest verdict carries a judge_policy stamp (version + effective settings);
 *   (b) --rejudge-existing semantics: supersede-not-duplicate — old rows are marked
 *       superseded_at (audit trail preserved), never double-counted, and the operation is
 *       idempotent + crash-safe (supersede-first ordering self-heals);
 *   (c) NULL judge_policy IS the mechanical pre-epoch taint marker — no date arithmetic needed;
 *   (d) evidence readers (getVerdict / getLaneEvidence / ledgerReport) exclude superseded rows.
 */
import { describe, it, expect, beforeAll } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, initDb } from "../src/db.js";
import { DEFAULT_POLICY } from "../src/homeserver/config.js";
import {
  importDelegations,
  supersedeHarvestVerdicts,
  getVerdict,
  getLaneEvidence,
  ledgerReport,
  recentDelegations,
  type ImportableDelegation,
} from "../src/homeserver/ledger.js";
import {
  HARVEST_JUDGE_POLICY,
  buildJudgePolicyStamp,
  policyVersionOf,
  isCurrentPolicy,
  harvestRecord,
} from "../src/homeserver/harvest.js";
import {
  loadHarvestPolicyState,
  loadHarvestedSourceIds,
  selectRowsForRun,
  planRowAction,
} from "../scripts/harvest-verdicts.js";

let dbPath: string;

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "hs-policy-versioning-test-"));
  dbPath = join(dir, "test.db");
  initDb(dbPath);
  // Simulate a PRE-#217 production DB: the delegations table already exists WITHOUT the
  // judge_policy/superseded_at columns, so ledger.ts's first call must migrate it additively
  // (the #210 lesson: old-DB migration order is where live deploys break).
  getDb().exec(`
    CREATE TABLE delegations (
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
  `);
});

function shadowRec(overrides: Partial<ImportableDelegation> = {}): ImportableDelegation {
  return {
    ts: "2026-07-11T10:00:00.000Z",
    taskType: "extract",
    modelId: "qwen3-30b-instruct",
    prompt: "extract the value from this record",
    outcome: "unverified",
    score: 0,
    verifier: "harvest-shadow:llm-judge:gpt-oss-120b",
    source: "harvest-shadow",
    notes: "would=fail score=0.00 #101: old-policy reason",
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// (a) The policy stamp — pure helpers + harvestRecord carries it
// ─────────────────────────────────────────────────────────────────────────
describe("judge-policy stamp (pure)", () => {
  it("buildJudgePolicyStamp = current version + effective context setting, round-trippable", () => {
    const stamp = buildJudgePolicyStamp(24_000);
    expect(stamp).toBe(`${HARVEST_JUDGE_POLICY}|ctx=24000`);
    expect(policyVersionOf(stamp)).toBe(HARVEST_JUDGE_POLICY);
    expect(isCurrentPolicy(stamp)).toBe(true);
  });

  it("policyVersionOf: bare version, null, empty, and foreign stamps", () => {
    expect(policyVersionOf(HARVEST_JUDGE_POLICY)).toBe(HARVEST_JUDGE_POLICY);
    expect(policyVersionOf(null)).toBeNull();
    expect(policyVersionOf(undefined)).toBeNull();
    expect(policyVersionOf("")).toBeNull();
    expect(policyVersionOf("old-epoch-v0|ctx=600")).toBe("old-epoch-v0");
    expect(isCurrentPolicy("old-epoch-v0|ctx=600")).toBe(false);
    expect(isCurrentPolicy(null)).toBe(false); // NULL = pre-epoch taint marker, never current
  });

  it("harvestRecord stamps judgePolicy in BOTH shadow and on modes", () => {
    const row = { id: 7, ts: "2026-07-11T10:00:00.000Z", model: "mellum" };
    const judge = { verdict: "pass" as const, score: 1, reason: "ok" };
    const stamp = buildJudgePolicyStamp(18_000);
    const shadow = harvestRecord({ row, taskType: "extract", prompt: "p", judge, judgeModel: "gpt-oss-120b", mode: "shadow", judgePolicy: stamp });
    const real = harvestRecord({ row, taskType: "extract", prompt: "p", judge, judgeModel: "gpt-oss-120b", mode: "on", judgePolicy: stamp });
    expect(shadow.judgePolicy).toBe(stamp);
    expect(real.judgePolicy).toBe(stamp);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Migration + import identity
// ─────────────────────────────────────────────────────────────────────────
describe("old-DB migration + import identity (#217)", () => {
  it("importDelegations persists judge_policy on a migrated pre-#217 table", () => {
    const r = importDelegations([shadowRec({ judgePolicy: buildJudgePolicyStamp(24_000) })]);
    expect(r.inserted).toBe(1);
    const row = getDb()
      .prepare(`SELECT judge_policy, superseded_at FROM delegations WHERE notes LIKE '%#101:%'`)
      .get() as { judge_policy: string | null; superseded_at: string | null };
    expect(row.judge_policy).toBe(`${HARVEST_JUDGE_POLICY}|ctx=24000`);
    expect(row.superseded_at).toBeNull();
  });

  it("legacy records (no judgePolicy) keep their pre-#217 content-hash id — re-imports stay idempotent", () => {
    const legacy = shadowRec({ notes: "would=pass score=1.00 #102: legacy reason" });
    expect(importDelegations([legacy]).inserted).toBe(1);
    // Byte-identical re-import must still dedupe to zero — the id derivation for policy-less
    // records must NOT change shape, or every historical JSONL re-import would double-count.
    expect(importDelegations([legacy]).inserted).toBe(0);
  });

  it("the same evidence WITH a judgePolicy is a DISTINCT row identity (a rejudge never collides with the legacy row)", () => {
    const legacy = shadowRec({ notes: "would=pass score=1.00 #103: same reason" });
    const rejudged = shadowRec({ notes: "would=pass score=1.00 #103: same reason", judgePolicy: buildJudgePolicyStamp(24_000) });
    expect(importDelegations([legacy]).inserted).toBe(1);
    expect(importDelegations([rejudged]).inserted).toBe(1); // NOT deduped against the legacy row
  });
});

// ─────────────────────────────────────────────────────────────────────────
// (b) Supersede-not-duplicate
// ─────────────────────────────────────────────────────────────────────────
describe("supersedeHarvestVerdicts (#217)", () => {
  it("marks only the targeted (source, #id) rows, returns the count, and is idempotent", () => {
    importDelegations([
      shadowRec({ notes: "would=fail score=0.00 #201: stale one" }),
      shadowRec({ notes: "would=fail score=0.00 #202: stays live" }),
    ]);
    const n = supersedeHarvestVerdicts({
      sourceTag: "harvest-shadow",
      sourceRowIds: [201],
      nowIso: "2026-07-11T12:00:00.000Z",
    });
    expect(n).toBe(1);
    const rows = getDb()
      .prepare(`SELECT notes, superseded_at FROM delegations WHERE notes LIKE '%#201:%' OR notes LIKE '%#202:%'`)
      .all() as { notes: string; superseded_at: string | null }[];
    expect(rows.find((r) => r.notes.includes("#201:"))!.superseded_at).toBe("2026-07-11T12:00:00.000Z");
    expect(rows.find((r) => r.notes.includes("#202:"))!.superseded_at).toBeNull();
    // Idempotent: already-superseded rows are not re-marked.
    expect(
      supersedeHarvestVerdicts({ sourceTag: "harvest-shadow", sourceRowIds: [201], nowIso: "2026-07-11T13:00:00.000Z" })
    ).toBe(0);
  });

  it("a '#id:' inside the judge REASON cannot be superseded as if it were the row's identity (codex review)", () => {
    // The canonical source link is the FIRST '#<id>' token (same parse the idempotency loader
    // uses); free-text judge reasons may quote other rows — matching them would silently retire
    // unrelated live evidence.
    importDelegations([
      shadowRec({ notes: "would=fail score=0.00 #250: judge says row #251: is similar" }),
      shadowRec({ notes: "would=pass score=1.00 #251: fine" }),
    ]);
    const n = supersedeHarvestVerdicts({
      sourceTag: "harvest-shadow",
      sourceRowIds: [251],
      nowIso: "2026-07-11T12:00:00.000Z",
    });
    expect(n).toBe(1); // ONLY the row whose canonical token is #251
    const rows = getDb()
      .prepare(`SELECT notes, superseded_at FROM delegations WHERE notes LIKE '%#250:%' OR notes LIKE '%#251: fine%'`)
      .all() as { notes: string; superseded_at: string | null }[];
    expect(rows.find((r) => r.notes.includes("#250:"))!.superseded_at).toBeNull();
    expect(rows.find((r) => r.notes.includes("#251: fine"))!.superseded_at).not.toBeNull();
  });

  it("an id prefix cannot over-match (#21 must not supersede #210's rows)", () => {
    importDelegations([shadowRec({ notes: "would=fail score=0.00 #210: longer id" })]);
    const n = supersedeHarvestVerdicts({
      sourceTag: "harvest-shadow",
      sourceRowIds: [21],
      nowIso: "2026-07-11T12:00:00.000Z",
    });
    expect(n).toBe(0);
  });

  it("does not touch other sources", () => {
    importDelegations([shadowRec({ source: "harvest", outcome: "pass", notes: "#301: real verdict" })]);
    const n = supersedeHarvestVerdicts({
      sourceTag: "harvest-shadow",
      sourceRowIds: [301],
      nowIso: "2026-07-11T12:00:00.000Z",
    });
    expect(n).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// (d) Evidence readers exclude superseded rows
// ─────────────────────────────────────────────────────────────────────────
describe("readers exclude superseded evidence (#217)", () => {
  const TASK = "classify";
  const MODEL = "mellum";

  it("getVerdict stops counting a verdict once it is superseded", () => {
    importDelegations([
      shadowRec({
        taskType: TASK,
        modelId: MODEL,
        outcome: "pass",
        score: 1,
        verifier: "answerIs",
        source: "harvest",
        notes: "#401: to be superseded",
      }),
    ]);
    const before = getVerdict(TASK, MODEL, DEFAULT_POLICY);
    supersedeHarvestVerdicts({ sourceTag: "harvest", sourceRowIds: [401], nowIso: "2026-07-11T12:00:00.000Z" });
    const after = getVerdict(TASK, MODEL, DEFAULT_POLICY);
    expect(before.attempts).toBe(1); // counted while live…
    expect(after.attempts).toBe(0); // …invisible once superseded
  });

  it("ledgerReport aggregates only live rows", () => {
    const liveBefore = ledgerReport(DEFAULT_POLICY).find((r) => r.taskType === TASK && r.modelId === MODEL);
    // the only (classify, mellum) row was superseded above → the lane vanishes or zeroes
    expect(liveBefore?.attempts ?? 0).toBe(0);
  });

  it("getLaneEvidence sees no samples from superseded rows", () => {
    const lane = getLaneEvidence(TASK, MODEL, "answerIs", DEFAULT_POLICY);
    expect(lane.attempts).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// The policy-state loader — what the harvest loop skips vs rejudges
// ─────────────────────────────────────────────────────────────────────────
describe("loadHarvestPolicyState (#217)", () => {
  it("classifies ids: current policy vs stale (legacy NULL or older version); superseded rows are invisible", () => {
    importDelegations([
      shadowRec({ notes: "would=pass score=1.00 #501: current", judgePolicy: buildJudgePolicyStamp(24_000) }),
      shadowRec({ notes: "would=pass score=1.00 #502: legacy null" }),
      shadowRec({ notes: "would=pass score=1.00 #503: older epoch", judgePolicy: "old-epoch-v0|ctx=600" }),
      shadowRec({ notes: "would=pass score=1.00 #504: superseded current", judgePolicy: buildJudgePolicyStamp(24_000) }),
    ]);
    supersedeHarvestVerdicts({ sourceTag: "harvest-shadow", sourceRowIds: [504], nowIso: "2026-07-11T12:00:00.000Z" });
    const state = loadHarvestPolicyState("harvest-shadow", dbPath);
    expect(state.current.has(501)).toBe(true);
    expect(state.stale.has(502)).toBe(true);
    expect(state.stale.has(503)).toBe(true);
    // #504's only verdict is superseded → the id is FREE to grade again (in neither set).
    expect(state.current.has(504)).toBe(false);
    expect(state.stale.has(504)).toBe(false);
  });

  it("an id with BOTH a current and a stale live row counts as current (no accidental rejudge)", () => {
    importDelegations([
      shadowRec({ notes: "would=pass score=1.00 #505: old row" }),
      shadowRec({ notes: "would=fail score=0.00 #505: new row", judgePolicy: buildJudgePolicyStamp(24_000) }),
    ]);
    const state = loadHarvestPolicyState("harvest-shadow", dbPath);
    expect(state.current.has(505)).toBe(true);
    expect(state.stale.has(505)).toBe(false);
  });

  it("loadHarvestedSourceIds (back-compat) = current ∪ stale", () => {
    const state = loadHarvestPolicyState("harvest-shadow", dbPath);
    const legacy = loadHarvestedSourceIds("harvest-shadow", dbPath);
    for (const id of state.current) expect(legacy.has(id)).toBe(true);
    for (const id of state.stale) expect(legacy.has(id)).toBe(true);
  });

  it("recentDelegations keeps superseded rows visible but LABELS them (audit view, codex review)", () => {
    const recents = recentDelegations(500);
    const superseded = recents.filter((r) => r.supersededAt != null);
    const live = recents.filter((r) => r.supersededAt == null);
    expect(superseded.length).toBeGreaterThan(0); // rows superseded by earlier tests are labelled…
    expect(live.length).toBeGreaterThan(0); // …and live rows carry null
  });

  it("a pre-#217 DB (no judge_policy/superseded_at columns) → every harvested id is stale, nothing crashes", () => {
    const oldDir = mkdtempSync(join(tmpdir(), "hs-policy-old-db-"));
    const oldPath = join(oldDir, "old.db");
    const raw = new Database(oldPath);
    raw.exec(`
      CREATE TABLE delegations (
        id TEXT PRIMARY KEY, ts TEXT NOT NULL, task_type TEXT NOT NULL, model_id TEXT NOT NULL,
        prompt_hash TEXT NOT NULL, outcome TEXT NOT NULL, source TEXT, notes TEXT
      );
    `);
    raw
      .prepare(`INSERT INTO delegations (id, ts, task_type, model_id, prompt_hash, outcome, source, notes) VALUES (?,?,?,?,?,?,?,?)`)
      .run("x1", "2026-07-01T00:00:00.000Z", "extract", "mellum", "h", "unverified", "harvest-shadow", "would=pass score=1.00 #601: old world");
    raw.close();
    const state = loadHarvestPolicyState("harvest-shadow", oldPath);
    expect(state.current.size).toBe(0);
    expect(state.stale.has(601)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Rejudge selection + per-row action plan (codex review of #226)
// ─────────────────────────────────────────────────────────────────────────
describe("selectRowsForRun (#217 — eligibility before the cap)", () => {
  const mk = (id: number) => ({ id });
  const rows = Array.from({ length: 30 }, (_, i) => mk(i + 1));

  it("flag off → rows pass through untouched (the loader already applied --n)", () => {
    expect(selectRowsForRun(rows, new Set([1, 2]), false, 10)).toEqual(rows);
  });

  it("flag on → current ids are excluded BEFORE the cap, so repeated runs drain a stale cohort larger than --n", () => {
    // The old shape (loader stride-samples to n, THEN the loop skips current ids) reselected the
    // same now-current rows forever — a tainted cohort bigger than --n could never be drained.
    const current = new Set([1, 2, 3]);
    const first = selectRowsForRun(rows, current, true, 10);
    expect(first.map((r) => r.id)).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    // Simulate the run succeeding (those ids become current) → the NEXT run advances.
    const after = new Set([...current, ...first.map((r) => r.id)]);
    const second = selectRowsForRun(rows, after, true, 10);
    expect(second.map((r) => r.id)).toEqual([14, 15, 16, 17, 18, 19, 20, 21, 22, 23]);
  });

  it("flag on with fewer eligible rows than the cap returns just those", () => {
    const current = new Set(rows.slice(0, 28).map((r) => r.id));
    expect(selectRowsForRun(rows, current, true, 10).map((r) => r.id)).toEqual([29, 30]);
  });
});

describe("planRowAction (#217 — one decision point for the harvest loop)", () => {
  const base = { inCurrent: false, inStale: false, rejudgeExisting: false, writeVerdict: true };

  it("current verdict always wins: skip", () => {
    expect(planRowAction({ ...base, inCurrent: true })).toBe("skip-current");
    expect(planRowAction({ ...base, inCurrent: true, rejudgeExisting: true })).toBe("skip-current");
  });

  it("stale without the flag: skip (nightly never rejudges on its own)", () => {
    expect(planRowAction({ ...base, inStale: true })).toBe("skip-stale-policy");
  });

  it("excluded task type: plain skip for fresh rows, RETIREMENT for stale rows under the flag (codex review: a stale mode=on verdict whose type is now excluded must not keep teaching routing)", () => {
    expect(planRowAction({ ...base, writeVerdict: false })).toBe("skip-excluded-type");
    // stale + excluded WITHOUT the flag: the stale-policy skip wins (the operator's signal that
    // --rejudge-existing will handle it — as a retirement, per the next assertion).
    expect(planRowAction({ ...base, inStale: true, writeVerdict: false })).toBe("skip-stale-policy");
    expect(planRowAction({ ...base, inStale: true, rejudgeExisting: true, writeVerdict: false })).toBe(
      "retire-excluded-type"
    );
  });

  it("gradable rows: grade, or grade-rejudge when superseding an older epoch", () => {
    expect(planRowAction(base)).toBe("grade");
    expect(planRowAction({ ...base, inStale: true, rejudgeExisting: true })).toBe("grade-rejudge");
  });
});
