#!/usr/bin/env tsx
/**
 * post-harvest-decision-panel.ts — surface the harvest learning-loop decision on Heimdall.
 *
 * DATA SOURCE: delegations ledger + harvest-trend.log. The panel is content-blind: it publishes
 * only counts, task/model ids, and operational error counts. No prompts, answers, or judge notes.
 *
 * USAGE   tsx scripts/post-harvest-decision-panel.ts [--dry-run] [--db <path>] [--harvest-log <path>]
 * ENV     HEIMDALL_PANELS_URL, HEIMDALL_FLEET_TOKEN
 */
import Database from "better-sqlite3";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import {
  pushPanel,
  verifyPanelLanded,
  verifyProblem,
  type StatusPanel,
} from "../src/homeserver/heimdall-push.js";

const SERVICE = "m5-inference";
const PANEL = "harvest-decision";
const READBACK_MAX_AGE_MS = 5 * 60 * 1000;
const DEFAULT_JUDGE = "gpt-oss-120b";

export type HarvestRecommendation = "GO" | "HARVEST_MORE" | "HOLD" | "ON";

export interface HarvestVerdictCounts {
  total: number;
  pass: number;
  partial: number;
  fail: number;
  unknown: number;
}

export interface HarvestBucketCounts extends HarvestVerdictCounts {
  key: string;
}

export interface LatestHarvestRun {
  ts: string;
  mode: string;
  judge: string;
  n: number;
  recent: string;
  sampled: number;
  graded: number;
  alreadyHarvested: number;
  selfGrade: number;
  judgeErr: number;
  parseFail: number;
  inserted: number | null;
}

export interface HarvestDecisionInput {
  mode: "shadow" | "on" | "unknown";
  gptOss: HarvestVerdictCounts;
  realHarvestRows: number;
  latestRun: LatestHarvestRun | null;
  topModels: HarvestBucketCounts[];
  topTasks: HarvestBucketCounts[];
}

export interface HarvestDecision {
  recommendation: HarvestRecommendation;
  state: "pass" | "warn" | "fail";
  reason: string;
  nextAction: string;
}

export function hasDelegationsTable(db: Database.Database): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'delegations'`)
    .get() as { name: string } | undefined;
  return row?.name === "delegations";
}

function emptyCounts(): HarvestVerdictCounts {
  return { total: 0, pass: 0, partial: 0, fail: 0, unknown: 0 };
}

/**
 * `AND <alias>.superseded_at IS NULL` when the column exists, else a no-op (#217). The panel
 * reads whatever DB it is pointed at read-only — it must not assume the migration has run.
 */
function liveRowsSql(db: Database.Database, alias: string): string {
  const cols = db.prepare(`PRAGMA table_info(delegations)`).all() as Array<{ name: string }>;
  return cols.some((c) => c.name === "superseded_at") ? ` AND ${alias}.superseded_at IS NULL` : "";
}

function wouldCaseSql(alias: string): string {
  return `
    SUM(CASE WHEN ${alias}.notes LIKE 'would=pass%' THEN 1 ELSE 0 END) AS pass,
    SUM(CASE WHEN ${alias}.notes LIKE 'would=partial%' THEN 1 ELSE 0 END) AS partial,
    SUM(CASE WHEN ${alias}.notes LIKE 'would=fail%' THEN 1 ELSE 0 END) AS fail,
    SUM(CASE WHEN ${alias}.notes IS NULL
              OR (${alias}.notes NOT LIKE 'would=pass%'
              AND ${alias}.notes NOT LIKE 'would=partial%'
              AND ${alias}.notes NOT LIKE 'would=fail%') THEN 1 ELSE 0 END) AS unknown`;
}

function mapCounts(row: Record<string, unknown> | undefined): HarvestVerdictCounts {
  if (!row) return emptyCounts();
  return {
    total: Number(row["total"] ?? 0),
    pass: Number(row["pass"] ?? 0),
    partial: Number(row["partial"] ?? 0),
    fail: Number(row["fail"] ?? 0),
    unknown: Number(row["unknown"] ?? 0),
  };
}

export function queryGptOssShadowCounts(db: Database.Database, judge = DEFAULT_JUDGE): HarvestVerdictCounts {
  if (!hasDelegationsTable(db)) return emptyCounts();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total, ${wouldCaseSql("d")}
       FROM delegations d
       WHERE d.source = 'harvest-shadow'
         AND d.verifier = @verifier${liveRowsSql(db, "d")}`
    )
    .get({ verifier: `harvest-shadow:llm-judge:${judge}` }) as Record<string, unknown> | undefined;
  return mapCounts(row);
}

export function queryRealHarvestRows(db: Database.Database): number {
  if (!hasDelegationsTable(db)) return 0;
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM delegations d WHERE source = 'harvest'${liveRowsSql(db, "d")}`)
    .get() as { n: number } | undefined;
  return row?.n ?? 0;
}

export function queryHarvestBuckets(
  db: Database.Database,
  field: "model_id" | "task_type",
  judge = DEFAULT_JUDGE,
  limit = 6
): HarvestBucketCounts[] {
  if (!hasDelegationsTable(db)) return [];
  const rows = db
    .prepare(
      `SELECT ${field} AS key, COUNT(*) AS total, ${wouldCaseSql("d")}
       FROM delegations d
       WHERE d.source = 'harvest-shadow'
         AND d.verifier = @verifier${liveRowsSql(db, "d")}
       GROUP BY ${field}
       ORDER BY total DESC, key ASC
       LIMIT @limit`
    )
    .all({ verifier: `harvest-shadow:llm-judge:${judge}`, limit }) as Record<string, unknown>[];
  return rows.map((r) => ({ key: String(r["key"] ?? "(unknown)"), ...mapCounts(r) }));
}

export function parseLatestHarvestRun(logText: string): LatestHarvestRun | null {
  const starts = [...logText.matchAll(/^===== .+$/gm)].map((m) => m.index ?? 0);
  if (!starts.length) return null;
  const blocks = starts.map((start, i) => logText.slice(start, starts[i + 1] ?? logText.length));

  for (const block of blocks.reverse()) {
    const header = /^===== (\S+) mode=(\S+) judge=(\S+) n=(\d+) recent=(\S+) =====/m.exec(block);
    if (!header) continue;
    // Token-wise parsing (#217 review of the old rigid regex): the summary parens gain new
    // counters over time (excluded-type #204, with-context #213, stale-policy/rejudged #217) and
    // a positional regex silently failed on every post-#204 block, so "latest run" fell back to
    // whatever ancient block still matched. Each stat is now matched independently; only the two
    // the decision logic depends on (judge-err, parse-fail) are required.
    const summary = /sampled \/ graded\s+\.+\s+(\d+)\s+\/\s+(\d+)\s+\(([^)]*)/m.exec(block);
    if (!summary) continue;
    const stats = summary[3]!;
    const stat = (name: string): number | null => {
      const m = new RegExp(`${name}\\s+(\\d+)`).exec(stats);
      return m ? Number(m[1]) : null;
    };
    const judgeErr = stat("judge-err");
    const parseFail = stat("parse-fail");
    if (judgeErr === null || parseFail === null) continue;
    const inserted = /ledger writes\s+\.+\s+inserted=(\d+)/m.exec(block);
    return {
      ts: header[1]!,
      mode: header[2]!,
      judge: header[3]!,
      n: Number(header[4]),
      recent: header[5]!,
      sampled: Number(summary[1]),
      graded: Number(summary[2]),
      alreadyHarvested: stat("already-harvested") ?? 0,
      selfGrade: stat("self-grade") ?? 0,
      judgeErr,
      parseFail,
      inserted: inserted ? Number(inserted[1]) : null,
    };
  }
  return null;
}

export function decideHarvest(input: HarvestDecisionInput): HarvestDecision {
  if (input.mode === "on" || input.realHarvestRows > 0) {
    return {
      recommendation: "ON",
      state: "pass",
      reason: `Harvest is already writing real verdicts (${input.realHarvestRows} source=harvest rows).`,
      nextAction: "Monitor routing impact; this panel no longer represents a shadow-only go/no-go.",
    };
  }

  if (input.mode !== "shadow") {
    return {
      recommendation: "HOLD",
      state: "fail",
      reason: "Harvest mode could not be confirmed as shadow.",
      nextAction: "Verify cron/wrapper config before changing anything.",
    };
  }

  const latest = input.latestRun;
  const latestProblems = latest ? latest.judgeErr + latest.parseFail : 0;
  const latestAttempts = latest ? latest.graded + latestProblems : 0;
  const latestProblemRate = latestAttempts ? latestProblems / latestAttempts : 0;
  if (latest && latestProblems > 0 && latestProblemRate > 0.05) {
    return {
      recommendation: "HOLD",
      state: "fail",
      reason: `Latest ${latest.judge} harvest had ${formatCount(latest.judgeErr, "judge error")} and ${formatCount(latest.parseFail, "parse failure")}.`,
      nextAction: "Investigate judge instability before allowing harvest rows to affect routing.",
    };
  }

  if (input.gptOss.total < 40) {
    return {
      recommendation: "HARVEST_MORE",
      state: "warn",
      reason: `Only ${input.gptOss.total} gpt-oss shadow rows are available.`,
      nextAction: "Keep shadow harvesting or run another backfill before deciding.",
    };
  }

  if (!latest || latest.graded < 20) {
    return {
      recommendation: "HARVEST_MORE",
      state: "warn",
      reason: latest ? `Latest nightly graded only ${latest.graded} rows.` : "No parseable harvest nightly summary found.",
      nextAction: "Wait for another nightly run or run a larger shadow backfill.",
    };
  }

  return {
    recommendation: "GO",
    state: "pass",
    reason: `${input.gptOss.total} gpt-oss shadow rows and latest run is stable.`,
    nextAction: "Consider enabling HARVEST_MODE=on for safe non-judgment task types; keep code-review whitelist gated.",
  };
}

export function buildHarvestDecisionPanel(input: HarvestDecisionInput): StatusPanel {
  const decision = decideHarvest(input);
  const latest = input.latestRun;
  const verdictSummary = `${input.gptOss.total} rows: ${input.gptOss.pass} pass / ${input.gptOss.partial} partial / ${input.gptOss.fail} fail`;
  return {
    service: SERVICE,
    panel: PANEL,
    kind: "status",
    label: "Harvest learning loop — shadow decision",
    state: decision.state,
    message:
      `${decision.recommendation}: ${decision.reason} ` +
      "Shadow rows are practice verdicts and do not affect routing.",
    detail: {
      kind: "table",
      cols: ["metric", "value"],
      rows: [
        { metric: "recommendation", value: decision.recommendation },
        { metric: "next action", value: decision.nextAction },
        { metric: "mode", value: input.mode },
        { metric: "gpt-oss shadow verdicts", value: verdictSummary },
        {
          metric: "latest run",
          value: latest
            ? `${latest.ts} ${latest.mode}/${latest.judge}: sampled ${latest.sampled}, graded ${latest.graded}, judgeErr ${latest.judgeErr}, parseFail ${latest.parseFail}`
            : "none found",
        },
        { metric: "top models", value: input.topModels.map(formatBucket).join("; ") || "none" },
        { metric: "top task types", value: input.topTasks.map(formatBucket).join("; ") || "none" },
      ],
    },
  };
}

function formatBucket(b: HarvestBucketCounts): string {
  return `${b.key} ${b.total} (${b.pass}/${b.partial}/${b.fail})`;
}

function formatCount(n: number, singular: string): string {
  return `${n} ${singular}${n === 1 ? "" : "s"}`;
}

function readHarvestLog(path: string): string {
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf8");
}

function modeFromLatest(latest: LatestHarvestRun | null, realHarvestRows: number): "shadow" | "on" | "unknown" {
  if (realHarvestRows > 0) return "on";
  if (latest?.mode === "shadow" || latest?.mode === "on") return latest.mode;
  return "unknown";
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const dbPath = flag(args, "--db") ?? process.env["EVAL_DB_PATH"] ?? "./data/eval.db";
  const harvestLog = flag(args, "--harvest-log") ?? "./data/harvest-trend.log";

  const db = existsSync(dbPath) ? new Database(dbPath, { readonly: true, fileMustExist: true }) : new Database(":memory:");
  try {
    const latestRun = parseLatestHarvestRun(readHarvestLog(harvestLog));
    const realHarvestRows = queryRealHarvestRows(db);
    const input: HarvestDecisionInput = {
      mode: modeFromLatest(latestRun, realHarvestRows),
      gptOss: queryGptOssShadowCounts(db),
      realHarvestRows,
      latestRun,
      topModels: queryHarvestBuckets(db, "model_id"),
      topTasks: queryHarvestBuckets(db, "task_type"),
    };
    const panel = buildHarvestDecisionPanel(input);

    if (dryRun) {
      console.log(JSON.stringify(panel, null, 2));
      return;
    }

    const r = await pushPanel(panel);
    if (!r.ok) {
      console.error(`[harvest-panel] push failed: ${r.error ?? `HTTP ${r.status}: ${r.body}`}`);
      process.exit(1);
    }
    console.log(`[harvest-panel] pushed '${PANEL}' (${panel.state}) → ${r.body?.slice(0, 160) ?? ""}`);

    const v = await verifyPanelLanded(SERVICE, PANEL, { maxAgeMs: READBACK_MAX_AGE_MS });
    if (v.ok) {
      console.log(`[harvest-panel] verified '${PANEL}' landed (read-back ok)`);
    } else {
      console.error(`[harvest-panel] READ-BACK FAILED for '${PANEL}': ${verifyProblem(v)} — panel may not be visible in Heimdall`);
      process.exit(1);
    }
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
  });
}
