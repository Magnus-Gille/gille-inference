#!/usr/bin/env tsx

/**
 * Export the content-blind exact execution-feedback report for an explicit UTC
 * time window. The source database is opened through the read-only snapshot
 * helper; this command never creates or migrates a database.
 * An existing database with an unavailable schema is a successful report (exit
 * 0 with availability="unavailable"); an unreadable or missing database exits
 * 2 because no report can be built.
 */

import Database from "better-sqlite3";
import { pathToFileURL } from "node:url";

import { closeReadOnlyDb, openReadOnlyDb } from "../src/db.js";
import {
  buildExecutionFeedbackReport,
  type ExecutionFeedbackReport,
  type ExecutionFeedbackReportWindow,
} from "../src/homeserver/execution-feedback-report.js";

export interface ParsedExecutionFeedbackExportArgs
  extends ExecutionFeedbackReportWindow {
  dbPath: string;
}

export interface ExportExecutionFeedbackDependencies {
  openReadOnlyDb?: (dbPath: string) => Database.Database;
  closeReadOnlyDb?: (db: Database.Database) => void;
  buildReport?: (
    db: Database.Database,
    bounds: ExecutionFeedbackReportWindow,
  ) => ExecutionFeedbackReport;
  writeStdout?: (text: string) => void;
  writeStderr?: (text: string) => void;
}

export function parseArgs(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): ParsedExecutionFeedbackExportArgs {
  let dbPath = env["EVAL_DB_PATH"] ?? "./data/eval.db";
  let since: string | undefined;
  let until: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--db":
        dbPath = argv[++index] ?? "";
        break;
      case "--since":
        since = argv[++index];
        break;
      case "--until":
        until = argv[++index];
        break;
      default:
        throw new Error("unknown option");
    }
  }

  if (since === undefined || since.length === 0) {
    throw new Error("--since is required");
  }
  if (until === undefined || until.length === 0) {
    throw new Error("--until is required");
  }

  return { dbPath, since, until };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

export function main(
  argv: string[] = process.argv.slice(2),
  dependencies: ExportExecutionFeedbackDependencies = {},
): number {
  const writeStdout = dependencies.writeStdout ?? ((text: string) => process.stdout.write(text));
  const writeStderr = dependencies.writeStderr ?? ((text: string) => process.stderr.write(text));

  let args: ParsedExecutionFeedbackExportArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    writeStderr(`[execution-feedback] ${errorText(error)}\n`);
    return 2;
  }

  const open = dependencies.openReadOnlyDb ?? openReadOnlyDb;
  const close = dependencies.closeReadOnlyDb ?? closeReadOnlyDb;
  const buildReport = dependencies.buildReport ?? buildExecutionFeedbackReport;

  let db: Database.Database;
  try {
    db = open(args.dbPath);
  } catch {
    // Keep paths and driver details out of the CLI's machine-readable surface.
    writeStderr("[execution-feedback] unavailable: cannot open read-only database\n");
    return 2;
  }

  try {
    const report = buildReport(db, {
      since: args.since,
      until: args.until,
    });
    writeStdout(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  } catch {
    writeStderr("[execution-feedback] export refused: invalid bounds or unreadable schema\n");
    return 2;
  } finally {
    close(db);
  }
}

const isMain = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  process.exitCode = main();
}
