#!/usr/bin/env tsx
/**
 * ingest-probe-evidence.ts — the durable-evidence bridge for probe-battery JSONL outputs (#151).
 *
 * Incident (#150): the 2026-06-23 extra-probes battery results lived ONLY in
 * data/extra-probes-results.jsonl on ephemeral disk. When the file evaporated, the routing-table
 * generator lost the reason-hard evidence and the type silently regressed to escalate-frontier.
 * The capability ledger (the delegations table in EVAL_DB_PATH) is the durable store the
 * generator computes verdicts from — probe paths that go through delegate() or the cartography
 * already write it at probe time. This tool closes the remaining gap: any battery output that
 * exists (or is recovered) as JSONL can be imported into the ledger IDEMPOTENTLY, so the
 * evidence class can never again live only on disk.
 *
 * USAGE
 *   tsx scripts/ingest-probe-evidence.ts --file data/extra-probes-results.jsonl --source extra-probes
 *   tsx scripts/ingest-probe-evidence.ts --file x.jsonl --dry-run     # parse + report, no DB writes
 *   tsx scripts/ingest-probe-evidence.ts --file x.jsonl --lenient     # import valid lines despite bad ones
 *
 * Accepts both cartography-shaped (camelCase, model/probeId) and snake_case lines. STRICT by
 * default: any malformed line is reported with its line number and the import is refused —
 * evidence must be fixed or explicitly tolerated (--lenient), never silently dropped.
 * Re-running on the same file inserts nothing (content-hash ids, INSERT OR IGNORE).
 *
 * ENV: EVAL_DB_PATH (default ./data/eval.db). --db overrides it.
 */

import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { initDb } from "../src/db.js";
import { importDelegations, type ImportableDelegation } from "../src/homeserver/ledger.js";

// ── Pure parser (unit-tested in tests/ingest-probe-evidence.test.ts) ──────────────

export interface ParsedEvidence {
  records: ImportableDelegation[];
  errors: { line: number; reason: string }[];
}

const VALID_OUTCOMES = ["pass", "partial", "fail", "error", "unverified"] as const;
const VALID_ERROR_CLASSES = ["empty", "truncated", "timeout", "parse", "infra"] as const;

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

/**
 * Parse a probe-battery JSONL text into importable ledger records. Field names are mapped
 * first-present-wins across the shapes the batteries actually emit (cartography camelCase,
 * ad-hoc snake_case). Every malformed line is surfaced with its 1-based line number — a bad
 * line contributes no record but is never silently dropped.
 */
export function parseProbeEvidenceJsonl(text: string, opts: { source: string }): ParsedEvidence {
  const records: ImportableDelegation[] = [];
  const errors: { line: number; reason: string }[] = [];
  const lines = text.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNum = i + 1;
    if (line.trim() === "") continue;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch (e: unknown) {
      errors.push({ line: lineNum, reason: `invalid JSON: ${e instanceof Error ? e.message : String(e)}` });
      continue;
    }

    const ts = str(parsed["ts"] ?? parsed["timestamp"] ?? parsed["evaluatedAt"]);
    if (ts === null || ts === "") {
      errors.push({ line: lineNum, reason: "ts/timestamp is required (undated evidence is not durable evidence)" });
      continue;
    }
    const taskType = str(parsed["taskType"] ?? parsed["task_type"]);
    if (taskType === null || taskType === "") {
      errors.push({ line: lineNum, reason: "task type is required (taskType/task_type)" });
      continue;
    }
    const modelId = str(parsed["modelId"] ?? parsed["model_id"] ?? parsed["model"]);
    if (modelId === null || modelId === "") {
      errors.push({ line: lineNum, reason: "model is required (modelId/model_id/model)" });
      continue;
    }
    const outcome = str(parsed["outcome"]);
    if (outcome === null || !(VALID_OUTCOMES as readonly string[]).includes(outcome)) {
      errors.push({ line: lineNum, reason: `outcome must be one of ${VALID_OUTCOMES.join("|")}` });
      continue;
    }

    // An invalid errorClass must be a LINE ERROR, not silently nulled: getVerdict excludes
    // error_class="infra" from capability math, so a mistyped "Infra" silently flipping to null
    // would count an infra error as a capability failure — silent verdict corruption.
    const rawErrorClass = parsed["errorClass"] ?? parsed["error_class"];
    const errorClass = str(rawErrorClass);
    if (
      rawErrorClass !== undefined &&
      rawErrorClass !== null &&
      (errorClass === null || !(VALID_ERROR_CLASSES as readonly string[]).includes(errorClass))
    ) {
      errors.push({ line: lineNum, reason: `errorClass must be one of ${VALID_ERROR_CLASSES.join("|")}` });
      continue;
    }
    const lineSource = str(parsed["source"]);
    const notes = str(parsed["notes"]);
    const probeId = str(parsed["probeId"] ?? parsed["probe_id"] ?? parsed["id"]);

    records.push({
      ts,
      taskType,
      modelId,
      prompt: str(parsed["prompt"] ?? parsed["prompt_excerpt"] ?? parsed["promptExcerpt"]) ?? "",
      outcome: outcome as ImportableDelegation["outcome"],
      score: num(parsed["score"]),
      latencyMs: num(parsed["latencyMs"] ?? parsed["latency_ms"]),
      ttftMs: num(parsed["ttftMs"] ?? parsed["ttft_ms"]),
      promptTokens: num(parsed["promptTokens"] ?? parsed["prompt_tokens"]),
      completionTokens: num(parsed["completionTokens"] ?? parsed["completion_tokens"]),
      tokPerSec: num(parsed["tokPerSec"] ?? parsed["tok_per_s"]),
      verifier: str(parsed["verifier"] ?? parsed["verifierName"] ?? parsed["verifier_name"]),
      errorClass: errorClass as ImportableDelegation["errorClass"],
      escalated: typeof parsed["escalated"] === "boolean" ? parsed["escalated"] : undefined,
      repeat: num(parsed["repeat"]),
      source: lineSource !== null && lineSource.trim() !== "" ? lineSource : opts.source,
      notes: probeId !== null ? `probe:${probeId}${notes ? ` | ${notes}` : ""}` : notes,
    });
  }

  return { records, errors };
}

// ── CLI ────────────────────────────────────────────────────────────────────────────

function main(): void {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const positional = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--file" && argv[i - 1] !== "--source" && argv[i - 1] !== "--db");
  const file = flag("--file") ?? positional[0];
  const source = flag("--source") ?? "probe-import";
  const dbPath = flag("--db");
  const dryRun = argv.includes("--dry-run");
  const lenient = argv.includes("--lenient");

  if (!file) {
    process.stderr.write("usage: ingest-probe-evidence.ts --file <results.jsonl> [--source <label>] [--db <path>] [--dry-run] [--lenient]\n");
    process.exitCode = 1;
    return;
  }
  if (!existsSync(file)) {
    process.stderr.write(`no such file: ${file}\n`);
    process.exitCode = 1;
    return;
  }

  const { records, errors } = parseProbeEvidenceJsonl(readFileSync(file, "utf8"), { source });

  for (const e of errors) process.stderr.write(`line ${e.line}: ${e.reason}\n`);

  // Dry-run reports FIRST (inspection of a dirty file must not require --lenient), then the
  // strict-error exit code still surfaces so a scripted dry-run check catches malformed files.
  if (dryRun) {
    const byPair = new Map<string, number>();
    for (const r of records) {
      const k = `${r.taskType} × ${r.modelId}`;
      byPair.set(k, (byPair.get(k) ?? 0) + 1);
    }
    process.stderr.write(`[dry-run] ${records.length} record(s) parsed, ${errors.length} error(s); nothing imported.\n`);
    for (const [k, n] of [...byPair.entries()].sort()) process.stderr.write(`  ${k}: ${n}\n`);
    if (errors.length > 0 && !lenient) process.exitCode = 1;
    return;
  }

  if (errors.length > 0 && !lenient) {
    process.stderr.write(
      `REFUSING to import: ${errors.length} malformed line(s) (of ${records.length + errors.length} non-blank). ` +
        `Fix the file, or pass --lenient to import the ${records.length} valid record(s) anyway.\n`
    );
    process.exitCode = 1;
    return;
  }

  if (dbPath) process.env["EVAL_DB_PATH"] = dbPath;
  initDb(dbPath);
  const res = importDelegations(records);
  process.stderr.write(
    `imported ${res.inserted} new record(s), ${res.skipped} duplicate(s) skipped from ${file} (source label: ${source}).\n`
  );
}

// Run only when invoked directly (not when imported by a test).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
