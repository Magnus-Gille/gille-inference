/**
 * harvest-judge-calibration-gate.ts — issue #6's reproducible HOLD/GO gate runner.
 *
 * Draws a stratified, content-blind sample of real ledger evidence (task type × prompt-size bucket
 * × model × verifier class × harness surface × pass/fail uncertainty — calibration-sample.ts), joins
 * it to independent Hugin Quality Receipts (hugin#231; calibration-quality-receipts.ts) when a
 * receipts export is supplied, computes precision/recall/disagreement with confidence intervals and
 * explicit denominators per lane and per verifier class (calibration-metrics.ts), and evaluates the
 * measured HOLD/GO gate (calibration-gate.ts). Writes a machine-readable decision artifact and never
 * enables anything — see calibration-gate.ts's doc comment for why that is a SEPARATE, human step.
 *
 * HONEST CURRENT STATE (2026-07-20): a representative human-audited sample barely exists yet — only
 * a handful of real Quality Receipts exist from dogfooding, and issue #3 (durable accounting with
 * trustworthy denominators) is not built. Running this script against the real ledger with no (or a
 * tiny) receipts export is EXPECTED to report HOLD with an "insufficient audited sample" reason —
 * that is the harness working correctly, not a bug. It is built so a LATER run, once #3/#24 land
 * more evidence and labels, can compute a real GO from the exact same code path without a rewrite.
 *
 * Usage:
 *   npx tsx scripts/harvest-judge-calibration-gate.ts [--receipts <path.json>] [--out <path.json>]
 *     [--target-per-stratum <int>] [--seed <int>] [--since <ISO>] [--include-shadow=false]
 *
 * `--receipts` points at a JSON array of QualityReceiptRef objects (calibration-quality-receipts.ts)
 * — content-blind by construction (opaque ids/digests, closed rating enum, never review text). No
 * such export exists in this repository; a real one is produced by whatever tool exports Hugin
 * Quality Receipts (out of gille-inference's ownership — see docs/learning-task-contract.md's
 * normative-ownership table: gille-inference does not own or fabricate Hugin's receipt store).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { listCalibrationSampleRows, type CalibrationSampleRow } from "../src/homeserver/ledger.js";
import { buildStratifiedSampleSpec, seededRand, stratumKeyOf } from "../src/homeserver/calibration-sample.js";
import { joinSampleToReceipts, type QualityReceiptRef } from "../src/homeserver/calibration-quality-receipts.js";
import { computeCalibrationMetrics } from "../src/homeserver/calibration-metrics.js";
import { evaluateCalibrationGate } from "../src/homeserver/calibration-gate.js";
import { CURRENT_CALIBRATION_POLICY, calibrationPolicyId } from "../src/homeserver/calibration-policy.js";

function readFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith("--")) return undefined;
  return v;
}

function loadReceipts(path: string | undefined): QualityReceiptRef[] {
  if (!path) return [];
  const text = readFileSync(resolve(path), "utf8");
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) {
    throw new Error(`--receipts ${path}: expected a JSON array of QualityReceiptRef objects`);
  }
  for (const [i, r] of parsed.entries()) {
    const o = r as Record<string, unknown>;
    const requiredStrings = ["receiptId", "receiptDigest", "bindingKey", "disposition", "rubricVersion", "reviewerId"];
    for (const field of requiredStrings) {
      if (typeof o[field] !== "string") {
        throw new Error(`--receipts ${path}: row ${i} missing/invalid string field "${field}"`);
      }
    }
    if (!["pass", "partial", "fail", "conflicted"].includes(o["rating"] as string)) {
      throw new Error(`--receipts ${path}: row ${i} has invalid "rating" (expected pass|partial|fail|conflicted)`);
    }
  }
  return parsed as QualityReceiptRef[];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const receiptsPath = readFlag(args, "--receipts");
  const outPath = readFlag(args, "--out");
  const targetPerStratum = Number(readFlag(args, "--target-per-stratum") ?? 40);
  const seed = Number(readFlag(args, "--seed") ?? 0);
  const since = readFlag(args, "--since");
  const includeShadow = readFlag(args, "--include-shadow") !== "false";

  const rows: CalibrationSampleRow[] = listCalibrationSampleRows({
    includeShadow,
    ...(since ? { since } : {}),
  });

  const spec = buildStratifiedSampleSpec(rows, { targetPerStratum, rand: seededRand(seed) });
  const selectedIds = new Set(spec.selectedRowIds);
  const selectedRows = rows.filter((r) => selectedIds.has(r.id));
  const strataByRowId = new Map(selectedRows.map((r) => [r.id, stratumKeyOf(r)]));

  const receipts = loadReceipts(receiptsPath);
  const joined = joinSampleToReceipts(selectedRows, receipts);

  const policyId = calibrationPolicyId(CURRENT_CALIBRATION_POLICY);
  const metrics = computeCalibrationMetrics({
    policyId,
    joined,
    strataByRowId,
    thresholds: CURRENT_CALIBRATION_POLICY.thresholds,
  });

  const generatedAt = new Date().toISOString();
  const gate = evaluateCalibrationGate({
    policyId,
    generatedAt,
    metrics,
    thresholds: CURRENT_CALIBRATION_POLICY.thresholds,
  });

  const artifact = {
    schemaVersion: gate.schemaVersion,
    policyId: gate.policyId,
    policy: CURRENT_CALIBRATION_POLICY,
    generatedAt: gate.generatedAt,
    sampleSpec: { targetPerStratum: spec.targetPerStratum, totalPopulation: spec.totalPopulation, totalSelected: spec.totalSelected, strata: spec.strata },
    verdict: gate.verdict,
    reasons: gate.reasons,
    thresholds: gate.thresholds,
    metrics: gate.metrics,
    enabling: gate.enabling,
  };

  const json = JSON.stringify(artifact, null, 2);
  if (outPath) {
    writeFileSync(resolve(outPath), json + "\n", "utf8");
    console.error(`[calibration-gate] wrote ${outPath}`);
  }
  console.error(
    `[calibration-gate] policy=${policyId.slice(0, 19)} population=${spec.totalPopulation} ` +
      `sampled=${spec.totalSelected} matched=${metrics.totalMatched} verdict=${gate.verdict}`
  );
  for (const reason of gate.reasons) console.error(`  - ${reason}`);
  console.log(json);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(`[fatal] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
