#!/usr/bin/env tsx
/**
 * Export a deterministic, content-blind M5 adoption evidence bundle.
 *
 * This is a local read-only report. It never contacts M5, Heimdall, a provider, or a
 * credential store, and it writes JSON only to stdout.
 *
 * Usage:
 *   tsx scripts/export-m5-adoption-evidence.ts --from 2026-08-01T00:00:00.000Z \
 *     --through-exclusive 2026-09-01T00:00:00.000Z [--db <path>]
 */
import Database from "better-sqlite3";
import { pathToFileURL } from "node:url";
import { closeReadOnlyDb, openReadOnlyDb } from "../src/db.js";
import {
  buildAdoptionEvidenceBundle,
  type AdoptionEvidenceBundle,
  type EvidenceBundleOptions,
} from "../src/homeserver/adoption-evidence-bundle.js";

export interface ParsedExportArgs extends EvidenceBundleOptions {
  dbPath: string;
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): ParsedExportArgs {
  let dbPath = env["EVAL_DB_PATH"] ?? "./data/eval.db";
  let from: string | undefined;
  let throughExclusive: string | undefined;
  let generatedAt: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const argument = argv[i];
    if (argument === "--db") dbPath = argv[++i] ?? "";
    else if (argument === "--from") from = argv[++i];
    else if (argument === "--through-exclusive") throughExclusive = argv[++i];
    else if (argument === "--generated-at") generatedAt = argv[++i];
    else throw new Error(`unknown option: ${argument}`);
  }
  if (!from) throw new Error("--from is required");
  if (!throughExclusive) throw new Error("--through-exclusive is required");
  return { dbPath, from, throughExclusive, ...(generatedAt ? { generatedAt } : {}) };
}

export interface ExportEvidenceDependencies {
  openReadOnlyDb?: (dbPath: string) => Database.Database;
  closeReadOnlyDb?: (db: Database.Database) => void;
  buildBundle?: (db: Database.Database, options: EvidenceBundleOptions) => AdoptionEvidenceBundle;
  writeStdout?: (text: string) => void;
  writeStderr?: (text: string) => void;
}

export function main(
  argv = process.argv.slice(2),
  dependencies: ExportEvidenceDependencies = {},
): number {
  const writeStdout = dependencies.writeStdout ?? ((text: string) => process.stdout.write(text));
  const writeStderr = dependencies.writeStderr ?? ((text: string) => process.stderr.write(text));
  let args: ParsedExportArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    writeStderr(`[m5-adoption-evidence] ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  const open = dependencies.openReadOnlyDb ?? openReadOnlyDb;
  const close = dependencies.closeReadOnlyDb ?? closeReadOnlyDb;
  const build = dependencies.buildBundle ?? buildAdoptionEvidenceBundle;
  let db: Database.Database;
  try {
    db = open(args.dbPath);
  } catch (error) {
    writeStderr(`[m5-adoption-evidence] cannot open read-only database: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  try {
    const { dbPath: _dbPath, ...options } = args;
    const bundle = build(db, options);
    writeStdout(`${JSON.stringify(bundle, null, 2)}\n`);
    return 0;
  } catch (error) {
    writeStderr(`[m5-adoption-evidence] export refused: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  } finally {
    close(db);
  }
}

const isMain = process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) process.exitCode = main();
