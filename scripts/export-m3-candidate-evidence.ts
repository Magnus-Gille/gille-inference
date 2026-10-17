#!/usr/bin/env tsx

/** Export the read-only, content-blind M3 candidate evidence diagnostic. */
import Database from "better-sqlite3";
import { pathToFileURL } from "node:url";
import { closeReadOnlyDb, openReadOnlyDb } from "../src/db.js";
import {
  buildCandidateEvidenceReport,
  type CandidateEvidenceOptions,
  type CandidateEvidenceReport,
} from "../src/homeserver/candidate-evidence-report.js";

export interface ParsedCandidateEvidenceArgs extends CandidateEvidenceOptions { dbPath: string; }
export interface ExportCandidateEvidenceDependencies {
  openReadOnlyDb?: (path: string) => Database.Database;
  closeReadOnlyDb?: (db: Database.Database) => void;
  buildReport?: (db: Database.Database, options: CandidateEvidenceOptions) => CandidateEvidenceReport;
  writeStdout?: (text: string) => void;
  writeStderr?: (text: string) => void;
}

export function parseArgs(argv: string[]): ParsedCandidateEvidenceArgs {
  let dbPath: string | undefined;
  let from: string | undefined;
  let throughExclusive: string | undefined;
  let generatedAt: string | undefined;
  const seen = new Set<string>();
  const valueFor = (flag: string): string => {
    if (seen.has(flag)) throw new Error(`${flag} may only be specified once`);
    seen.add(flag);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    i += 1;
    return value;
  };
  let i = 0;
  for (; i < argv.length; i += 1) {
    switch (argv[i]) {
      case "--db": dbPath = valueFor("--db"); break;
      case "--from": from = valueFor("--from"); break;
      case "--through-exclusive": throughExclusive = valueFor("--through-exclusive"); break;
      case "--generated-at": generatedAt = valueFor("--generated-at"); break;
      default: throw new Error("unknown option");
    }
  }
  if (!dbPath) throw new Error("--db is required");
  if (!from) throw new Error("--from is required");
  if (!throughExclusive) throw new Error("--through-exclusive is required");
  if (!generatedAt) throw new Error("--generated-at is required");
  return { dbPath, from, throughExclusive, generatedAt };
}

export function main(argv = process.argv.slice(2), dependencies: ExportCandidateEvidenceDependencies = {}): number {
  const stdout = dependencies.writeStdout ?? ((text: string) => process.stdout.write(text));
  const stderr = dependencies.writeStderr ?? ((text: string) => process.stderr.write(text));
  let args: ParsedCandidateEvidenceArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    stderr(`[m5-candidate-evidence] ${error instanceof Error ? error.message : "invalid arguments"}\n`);
    return 2;
  }
  const open = dependencies.openReadOnlyDb ?? openReadOnlyDb;
  const close = dependencies.closeReadOnlyDb ?? closeReadOnlyDb;
  const build = dependencies.buildReport ?? buildCandidateEvidenceReport;
  let db: Database.Database;
  try { db = open(args.dbPath); } catch { stderr("[m5-candidate-evidence] unavailable: cannot open read-only database\n"); return 2; }
  let output: string | undefined;
  let buildFailed = false;
  try {
    const { dbPath: _dbPath, ...options } = args;
    output = `${JSON.stringify(build(db, options), null, 2)}\n`;
  } catch { buildFailed = true; }
  let closeFailed = false;
  try { close(db); } catch { closeFailed = true; }
  if (closeFailed) { stderr("[m5-candidate-evidence] unavailable: cannot close read-only database\n"); return 2; }
  if (buildFailed) { stderr("[m5-candidate-evidence] export refused: invalid bounds or unreadable schema\n"); return 2; }
  stdout(output!);
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
