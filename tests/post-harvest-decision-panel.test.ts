import { describe, expect, it, beforeEach } from "vitest";
import Database from "better-sqlite3";

import {
  buildHarvestDecisionPanel,
  decideHarvest,
  hasDelegationsTable,
  parseLatestHarvestRun,
  queryGptOssShadowCounts,
  queryHarvestBuckets,
  queryRealHarvestRows,
  type HarvestDecisionInput,
} from "../scripts/post-harvest-decision-panel.js";
import { PANEL_ID_RE } from "../src/homeserver/heimdall-push.js";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(`
    CREATE TABLE delegations (
      ts TEXT NOT NULL,
      task_type TEXT NOT NULL,
      model_id TEXT NOT NULL,
      outcome TEXT NOT NULL,
      verifier TEXT,
      source TEXT,
      notes TEXT
    )
  `);
});

function insertShadow(over: {
  taskType?: string;
  model?: string;
  judge?: string;
  would?: "pass" | "partial" | "fail";
} = {}): void {
  const would = over.would ?? "pass";
  db.prepare(
    `INSERT INTO delegations (ts, task_type, model_id, outcome, verifier, source, notes)
     VALUES (@ts, @taskType, @model, 'unverified', @verifier, 'harvest-shadow', @notes)`
  ).run({
    ts: "2026-07-08T04:30:00.000Z",
    taskType: over.taskType ?? "qa-factual",
    model: over.model ?? "qwen3-30b-instruct",
    verifier: `harvest-shadow:llm-judge:${over.judge ?? "gpt-oss-120b"}`,
    notes: `would=${would} score=${would === "pass" ? "1.00" : "0.00"} #42: content-free test reason`,
  });
}

function baseInput(over: Partial<HarvestDecisionInput> = {}): HarvestDecisionInput {
  return {
    mode: "shadow",
    gptOss: { total: 50, pass: 35, partial: 5, fail: 10, unknown: 0 },
    realHarvestRows: 0,
    latestRun: {
      ts: "2026-07-08T04:30:01Z",
      mode: "shadow",
      judge: "gpt-oss-120b",
      n: 40,
      recent: "24h",
      sampled: 40,
      graded: 35,
      alreadyHarvested: 0,
      selfGrade: 0,
      judgeErr: 0,
      parseFail: 0,
      inserted: 35,
    },
    topModels: [],
    topTasks: [],
    ...over,
  };
}

describe("post-harvest-decision-panel", () => {
  it("detects whether the delegations table exists", () => {
    expect(hasDelegationsTable(db)).toBe(true);
    expect(hasDelegationsTable(new Database(":memory:"))).toBe(false);
  });

  it("aggregates gpt-oss shadow verdict counts from notes without reading note text", () => {
    insertShadow({ would: "pass" });
    insertShadow({ would: "partial" });
    insertShadow({ would: "fail" });
    insertShadow({ judge: "qwen3-coder-next-80b", would: "pass" });
    db.prepare(
      `INSERT INTO delegations (ts, task_type, model_id, outcome, verifier, source, notes)
       VALUES ('2026-07-08T04:30:00Z', 'qa-factual', 'mellum', 'unverified',
               'harvest-shadow:llm-judge:gpt-oss-120b', 'harvest-shadow', NULL)`
    ).run();
    expect(queryGptOssShadowCounts(db)).toEqual({ total: 4, pass: 1, partial: 1, fail: 1, unknown: 1 });
  });

  it("counts real harvest rows separately from shadow rows", () => {
    insertShadow();
    db.prepare(
      `INSERT INTO delegations (ts, task_type, model_id, outcome, verifier, source, notes)
       VALUES ('2026-07-08T00:00:00Z', 'extract', 'mellum', 'pass', 'llm-judge:gpt-oss-120b', 'harvest', '#99')`
    ).run();
    expect(queryRealHarvestRows(db)).toBe(1);
  });

  it("builds per-model and per-task count buckets", () => {
    insertShadow({ model: "qwen3-30b-instruct", taskType: "qa-factual", would: "pass" });
    insertShadow({ model: "qwen3-30b-instruct", taskType: "qa-factual", would: "fail" });
    insertShadow({ model: "mellum", taskType: "extract", would: "partial" });
    expect(queryHarvestBuckets(db, "model_id", "gpt-oss-120b", 2)).toEqual([
      { key: "qwen3-30b-instruct", total: 2, pass: 1, partial: 0, fail: 1, unknown: 0 },
      { key: "mellum", total: 1, pass: 0, partial: 1, fail: 0, unknown: 0 },
    ]);
  });

  it("parses the latest completed harvest block from harvest-trend.log", () => {
    const log = `
===== 2026-07-07T04:30:01Z mode=shadow judge=qwen3-coder-next-80b n=40 recent=24h =====
sampled / graded .......... 9 / 7  (already-harvested 2, self-grade 0, judge-err 0, parse-fail 0)
ledger writes ............. inserted=7 skipped(dupe)=0
===== 2026-07-08T04:30:01Z mode=shadow judge=gpt-oss-120b n=40 recent=24h =====
sampled / graded .......... 17 / 8  (already-harvested 3, self-grade 0, judge-err 5, parse-fail 1)
ledger writes ............. inserted=8 skipped(dupe)=0
`;
    expect(parseLatestHarvestRun(log)).toMatchObject({
      ts: "2026-07-08T04:30:01Z",
      mode: "shadow",
      judge: "gpt-oss-120b",
      sampled: 17,
      graded: 8,
      judgeErr: 5,
      parseFail: 1,
      inserted: 8,
    });
  });

  it("parses a CURRENT-format summary line (tokens added by #204/#213/#216/#217 between the classic ones)", () => {
    // The old rigid regex required `self-grade N, judge-err N` adjacency and silently failed on
    // every post-#204 block — the panel's "latest run" fell back to whatever ancient block still
    // matched. Token-wise parsing must handle the real current line.
    const log = `
===== 2026-07-11T04:30:01Z mode=shadow judge=gpt-oss-120b n=40 recent=24h =====
sampled / graded .......... 25 / 13  (already-harvested 12, self-grade 0, excluded-type 0, judge-err 2, parse-fail 1, starved-retries 0, input-too-large 0, stale-policy 3, rejudged 0, with-context 7 [real-history 7])
ledger writes ............. inserted=13 skipped(dupe)=0
`;
    expect(parseLatestHarvestRun(log)).toMatchObject({
      ts: "2026-07-11T04:30:01Z",
      judge: "gpt-oss-120b",
      sampled: 25,
      graded: 13,
      alreadyHarvested: 12,
      judgeErr: 2,
      parseFail: 1,
      inserted: 13,
    });
  });

  it("shadow counts and buckets exclude superseded rows when the column exists (#217), and tolerate its absence", () => {
    // The default fixture table has NO superseded_at column — every other test in this file
    // proves the old-schema tolerance. Here: a schema WITH the column must filter live rows.
    const db2 = new Database(":memory:");
    db2.exec(`
      CREATE TABLE delegations (
        ts TEXT NOT NULL, task_type TEXT NOT NULL, model_id TEXT NOT NULL, outcome TEXT NOT NULL,
        verifier TEXT, source TEXT, notes TEXT, superseded_at TEXT
      )
    `);
    const ins = db2.prepare(
      `INSERT INTO delegations (ts, task_type, model_id, outcome, verifier, source, notes, superseded_at)
       VALUES ('2026-07-11T00:00:00Z', 'extract', 'mellum', 'unverified', 'harvest-shadow:llm-judge:gpt-oss-120b', 'harvest-shadow', @notes, @sup)`
    );
    ins.run({ notes: "would=pass score=1.00 #1: live", sup: null });
    ins.run({ notes: "would=fail score=0.00 #1: superseded old", sup: "2026-07-11T12:00:00Z" });
    const counts = queryGptOssShadowCounts(db2, "gpt-oss-120b");
    expect(counts.total).toBe(1);
    expect(counts.pass).toBe(1);
    expect(counts.fail).toBe(0);
    const buckets = queryHarvestBuckets(db2, "model_id", "gpt-oss-120b", 5);
    expect(buckets).toEqual([{ key: "mellum", total: 1, pass: 1, partial: 0, fail: 0, unknown: 0 }]);
    db2.close();
  });

  it("recommends HOLD when the latest judge run is unstable", () => {
    const d = decideHarvest(baseInput({
      latestRun: { ...baseInput().latestRun!, graded: 8, judgeErr: 5, parseFail: 1 },
    }));
    expect(d.recommendation).toBe("HOLD");
    expect(d.state).toBe("fail");
    expect(d.reason).toBe("Latest gpt-oss-120b harvest had 5 judge errors and 1 parse failure.");
  });

  it("recommends HARVEST_MORE when volume is still too low", () => {
    const d = decideHarvest(baseInput({ gptOss: { total: 12, pass: 10, partial: 1, fail: 1, unknown: 0 } }));
    expect(d.recommendation).toBe("HARVEST_MORE");
    expect(d.state).toBe("warn");
  });

  it("recommends GO when shadow volume and latest stability are enough", () => {
    expect(decideHarvest(baseInput()).recommendation).toBe("GO");
  });

  it("builds a valid Heimdall status panel with a small explanation", () => {
    const panel = buildHarvestDecisionPanel(baseInput({
      gptOss: { total: 94, pass: 16, partial: 5, fail: 73, unknown: 0 },
      topModels: [{ key: "qwen3-30b-instruct", total: 17, pass: 11, partial: 2, fail: 4, unknown: 0 }],
      topTasks: [{ key: "qa-factual", total: 6, pass: 2, partial: 0, fail: 4, unknown: 0 }],
    }));
    expect(panel.kind).toBe("status");
    expect(panel.service).toBe("m5-inference");
    expect(panel.panel).toBe("harvest-decision");
    expect(PANEL_ID_RE.test(panel.panel)).toBe(true);
    expect(panel.message).toContain("Shadow rows are practice verdicts and do not affect routing.");
    expect(JSON.stringify(panel)).not.toContain("content-free test reason");
    expect(panel.detail?.rows.find((r) => r["metric"] === "gpt-oss shadow verdicts")?.["value"]).toBe(
      "94 rows: 16 pass / 5 partial / 73 fail"
    );
  });
});
