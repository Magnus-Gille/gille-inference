#!/usr/bin/env tsx
/**
 * retention-cli.ts — the IO composition root for retention dry-run reporting and (gated) pruning
 * (issue #9). All safety logic lives in src/homeserver/retention-enforcement.ts and
 * retention-prune-gate.ts (pure/DB-injected); this script only wires them to the eval DB and the
 * code-loop workroot, and prints/persists their output.
 *
 * SAFETY: `dry-run` is the default and ONLY command wired into any operational workflow by this
 * PR. `prune` exists so the mechanism is exercisable end-to-end, but it REFUSES unless an operator
 * supplies --approved-by/--reason/--decision-ref (mirrors `routing-lifecycle-cli.ts adopt`'s
 * required-approval flags) AND sets HOMESERVER_RETENTION_LIVE_PRUNE=on in the real environment —
 * a value this repository's own code, config, and CI never set. Nothing in this PR runs `prune`.
 *
 * USAGE
 *   tsx scripts/retention-cli.ts dry-run [--out report.json] [--db path] [--workroot path]
 *     Prints the human-readable summary to stderr and the machine-readable RetentionDryRunReport
 *     JSON to stdout (and --out, if given). Deletes and redacts NOTHING. Exit 0 always (a non-zero
 *     exit here would mean "something crashed", never "found expired rows").
 *
 *   tsx scripts/retention-cli.ts prune --report report.json \
 *       --approved-by <name> --reason "<why>" --decision-ref <issue/PR> \
 *       [--db path] [--workroot path]
 *     Attempts to execute a PREVIOUSLY REVIEWED dry-run report. Refuses (exit 1, no write) unless
 *     the live-report state still matches the reviewed report AND HOMESERVER_RETENTION_LIVE_PRUNE=on.
 *
 * ENV: EVAL_DB_PATH (default ./data/eval.db); HOMESERVER_CODE_LOOP_WORKROOT (default
 *      ./data/code-loop-work); HOMESERVER_RETENTION_LIVE_PRUNE (must be exactly "on" for `prune`
 *      to do anything — unset by default, and never set by this repository).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getDb } from "../src/db.js";
import {
  runRetentionDryRun,
  retentionReportContentHash,
  type RetentionDryRunReport,
} from "../src/homeserver/retention-enforcement.js";
import {
  approveRetentionPrune,
  executeRetentionPrune,
  RETENTION_LIVE_PRUNE_CONFIRM,
  RETENTION_LIVE_PRUNE_ENV,
} from "../src/homeserver/retention-prune-gate.js";

function readFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith("--")) return undefined;
  return v;
}

function resolveWorkroot(args: string[]): string {
  return resolve(readFlag(args, "--workroot") ?? process.env["HOMESERVER_CODE_LOOP_WORKROOT"] ?? "./data/code-loop-work");
}

function summarize(report: RetentionDryRunReport): string {
  const lines = [
    `retention dry-run — generatedAt=${report.generatedAt} totalExpiredRows=${report.totalExpiredRows}`,
  ];
  for (const s of report.stores) {
    lines.push(
      `  ${s.storeId.padEnd(24)} classification=${s.classification.padEnd(14)} action=${s.pruneAction.padEnd(14)} ` +
        `retentionDays=${s.retentionDays} expiredCount=${s.expiredCount}`,
    );
  }
  return lines.join("\n");
}

async function cmdDryRun(args: string[]): Promise<void> {
  const dbPath = readFlag(args, "--db");
  if (dbPath) process.env["EVAL_DB_PATH"] = dbPath;
  const db = getDb();
  const workroot = resolveWorkroot(args);
  const now = new Date().toISOString();

  const report = runRetentionDryRun(db, { now, workroot });
  const outPath = readFlag(args, "--out");
  const json = JSON.stringify(report, null, 2);
  if (outPath) writeFileSync(resolve(outPath), json + "\n", "utf8");
  process.stdout.write(json + "\n");
  process.stderr.write(summarize(report) + "\n");
  process.stderr.write(`report content hash: ${retentionReportContentHash(report)}\n`);
  process.stderr.write("This is a DRY RUN — nothing was deleted or redacted.\n");
}

async function cmdPrune(args: string[]): Promise<void> {
  const dbPath = readFlag(args, "--db");
  if (dbPath) process.env["EVAL_DB_PATH"] = dbPath;
  const db = getDb();
  const workroot = resolveWorkroot(args);

  const reportPath = readFlag(args, "--report");
  const approvedBy = readFlag(args, "--approved-by");
  const reason = readFlag(args, "--reason");
  const decisionRef = readFlag(args, "--decision-ref");
  if (!reportPath || !existsSync(resolve(reportPath))) {
    process.stderr.write("prune requires --report <path-to-reviewed-dry-run-report.json> (produced by `dry-run --out`)\n");
    process.exitCode = 2;
    return;
  }
  if (!approvedBy || !reason || !decisionRef) {
    process.stderr.write("prune requires --approved-by <name> --reason \"<why>\" --decision-ref <issue/PR>\n");
    process.exitCode = 2;
    return;
  }

  const report = JSON.parse(readFileSync(resolve(reportPath), "utf8")) as RetentionDryRunReport;
  const now = new Date().toISOString();
  const token = approveRetentionPrune(report, { reviewerId: approvedBy, reason, decisionRef, reviewedAt: now });

  const result = executeRetentionPrune({
    db, token, now, workroot,
    confirm: RETENTION_LIVE_PRUNE_CONFIRM,
    // Deliberately reads the REAL environment here (unlike the test-only injection seam) — this is
    // the one place in the repository that consults it, and only because an operator explicitly
    // invoked `prune`.
    liveEnableEnvValue: process.env[RETENTION_LIVE_PRUNE_ENV],
  });

  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  if (result.status === "refused") {
    process.stderr.write(`REFUSED: ${result.reason}\n`);
    process.exitCode = 1;
    return;
  }
  process.stderr.write(`EXECUTED — affected counts: ${JSON.stringify(result.affectedCounts)}\n`);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "dry-run" || cmd === undefined) return cmdDryRun(rest);
  if (cmd === "prune") return cmdPrune(rest);
  process.stderr.write("usage: retention-cli.ts <dry-run|prune> [flags]\n");
  process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 2;
  });
}
