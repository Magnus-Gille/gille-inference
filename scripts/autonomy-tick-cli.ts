#!/usr/bin/env tsx
/**
 * autonomy-tick-cli.ts — the IO composition root for the autonomy controller (issue #49). One
 * idempotent cron entrypoint: RECONCILE any crashed prior tick's adoption intent → WATCH (#47) →
 * ACKNOWLEDGE/DEMOTE → REVIEW (#7, live-table baseline read AFTER watch + live #48 gate) →
 * PREDICATES → DECIDE BY TIER → ADOPT at most ONE axis → TIER LADDER → NOTIFY. All decision logic
 * lives in src/homeserver/autonomy-controller.ts (pure/DI); this script only wires it to the
 * ledger, the served-model catalogue, the filesystem, and the live gateway's reload endpoint — the
 * exact same IO surface scripts/routing-lifecycle-cli.ts already composes for the human-driven
 * `review`/`adopt`/`watch` commands (`buildAdoptDeps` is imported from there rather than re-wired
 * here).
 *
 * Unlike `routing-lifecycle-cli.ts review`, this script NEVER accepts a `--calibration-gate
 * <path>` override — an unattended cron tick always computes the LIVE #6/#48 gate from current
 * evidence (`computeLiveCalibrationGate`, default mode "both": human receipts merged additively
 * with #48's verifier-anchored feed, exactly like the human `review` command's own default). This
 * script also supplies `recomputeCalibrationGate` — a FRESH ledger read + gate computation invoked
 * again by the controller immediately before any organic-dependent adopt attempt (Sol-xhigh review
 * finding 6), never the single review-time snapshot reused stale.
 *
 * USAGE
 *   tsx scripts/autonomy-tick-cli.ts [--dry-run] [--table docs/m5-routing.json] [--data-dir ./data]
 *       [--decision-ref gille-inference#49] [--gateway-url http://...] [--db ...]
 *     Prints the machine-readable AutonomyTickReport JSON to stdout and a human-readable summary
 *     to stderr. Exit 0 always (a refused/ineligible axis is a normal, honest outcome, not a
 *     script failure) unless an unexpected exception propagates.
 *
 * ENV: EVAL_DB_PATH (ledger DB, default ./data/eval.db);
 *      GATEWAY_URL / ROUTING_LIFECYCLE_ADMIN_KEY / HOMESERVER_OWNER_KEY — see
 *        routing-lifecycle-cli.ts's own header (issue #38), reused verbatim via `buildAdoptDeps`;
 *      AUTONOMY_KILL_SWITCH=on — evaluate + record everything, adopt/promote nothing (demotion
 *        still applies). Absent/anything else = acting ENABLED;
 *      AUTONOMY_NOTIFY_CMD — when set, invoked with a short content-blind JSON summary on stdin
 *        after any adopt/revert/tier-change (issue #49 item 8). Never an HTTP call — the box wires
 *        Ratatoskr or anything else behind this command itself.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { loadConfig } from "../src/homeserver/config.js";
import { ledgerReport, listCalibrationSampleRows, guardMetricsWindow } from "../src/homeserver/ledger.js";
import { listModels } from "../src/homeserver/model-admin.js";
import { readRegistry, DEFAULT_REGISTRY_PATH } from "../src/homeserver/model-registry.js";
import { contentDigest } from "../src/homeserver/evidence-identity.js";
import { routableTaskTypes } from "../src/homeserver/routing-table-generator.js";
import { computeLiveCalibrationGate } from "../src/homeserver/calibration-gate-live.js";
import { buildCandidatePair } from "../src/homeserver/routing-lifecycle.js";
import { DEFAULT_WATCHDOG_POLICY } from "../src/homeserver/adoption-watchdog.js";
import { buildAdoptDeps } from "./routing-lifecycle-cli.js";
import {
  runAutonomyTick,
  DEFAULT_AUTONOMY_POLICY,
  type AutonomyTickDeps,
} from "../src/homeserver/autonomy-controller.js";

const DEFAULT_TABLE_PATH = resolve("./docs/m5-routing.json");
const DEFAULT_FRESHNESS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEFAULT_DATA_DIR = resolve("./data");
const DEFAULT_DECISION_REF = "gille-inference#49";

function readFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith("--")) return undefined;
  return v;
}

function killSwitchOn(): boolean {
  return (process.env["AUTONOMY_KILL_SWITCH"] ?? "").trim().toLowerCase() === "on";
}

async function loadServableModelIds(): Promise<string[] | null> {
  try {
    const models = await listModels();
    return models.map((m) => m.key).filter((id) => id.trim() !== "");
  } catch (err) {
    process.stderr.write(
      `serving catalogue unavailable (${err instanceof Error ? err.message : String(err)}) — validation will fail closed on every named-model route.\n`
    );
    return null;
  }
}

function policyEpochHash(policy: unknown): string {
  return contentDigest(JSON.stringify(policy));
}

/** Invokes AUTONOMY_NOTIFY_CMD (if set) with `summaryJson` on stdin — never an HTTP channel; the
 *  box wires Ratatoskr or anything else behind this env var's own command. Absent env = the
 *  durable event alone is the notification (issue #49 item 8). */
function notifyIfConfigured(summaryJson: string): void {
  const cmd = process.env["AUTONOMY_NOTIFY_CMD"];
  if (!cmd || cmd.trim() === "") return;
  try {
    execFileSync("/bin/sh", ["-c", cmd], { input: summaryJson, stdio: ["pipe", "inherit", "inherit"] });
  } catch (err) {
    process.stderr.write(`autonomy-tick: AUTONOMY_NOTIFY_CMD failed: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (readFlag(args, "--db")) process.env["EVAL_DB_PATH"] = readFlag(args, "--db");
  const dryRun = args.includes("--dry-run");
  const tablePath = resolve(readFlag(args, "--table") ?? DEFAULT_TABLE_PATH);
  const dataDir = resolve(readFlag(args, "--data-dir") ?? DEFAULT_DATA_DIR);
  const decisionRef = readFlag(args, "--decision-ref") ?? DEFAULT_DECISION_REF;

  const config = loadConfig();
  const generatedAt = new Date().toISOString();

  const verdicts = ledgerReport(config.policy);
  const deterministicVerdicts = ledgerReport(config.policy, { excludeOrganicJudge: true });
  const registry = readRegistry(DEFAULT_REGISTRY_PATH);
  const servableModelIds = await loadServableModelIds();

  const { candidate, deterministicCandidate } = buildCandidatePair({
    verdicts,
    deterministicVerdicts,
    registry,
    sources: [],
    generatedAt,
    policy: { minSamples: config.policy.minSamples },
    servableModelIds: servableModelIds ?? undefined,
  });

  // NOTE (Sol-xhigh review finding 1): the adopted routing table is deliberately NOT read here.
  // `runAutonomyTick` re-reads the LIVE table itself, AFTER its own WATCH phase runs — reading it
  // here (before WATCH) would hand the controller a baseline WATCH might revert/quarantine out
  // from under, exactly the staleness bug the fix addresses. This CLI's only job for REVIEW is to
  // supply the ledger-derived CANDIDATE (which does not depend on the adopted table at all) and the
  // review-time #6/#48 gate snapshot.

  // Always the LIVE #6/#48 gate — see module header on why this CLI never accepts an override file.
  const rows = listCalibrationSampleRows({ includeShadow: true });
  const calibrationGate = computeLiveCalibrationGate({ rows, receipts: [], generatedAt });

  const epochHash = policyEpochHash(config.policy);
  const adoptDeps = buildAdoptDeps(args, config, tablePath);

  // Finding 6: recompute the LIVE gate again, FRESH, at the exact moment of an organic-dependent
  // adopt attempt — a fresh ledger read each call, never the `calibrationGate` snapshot above.
  const recomputeCalibrationGate = () => {
    const freshRows = listCalibrationSampleRows({ includeShadow: true });
    return computeLiveCalibrationGate({ rows: freshRows, receipts: [], generatedAt: new Date().toISOString() });
  };

  const deps: AutonomyTickDeps = {
    dataDir,
    nowIso: () => new Date().toISOString(),
    killSwitchOn,
    decisionRef,
    policy: DEFAULT_AUTONOMY_POLICY,
    watchdogPolicy: DEFAULT_WATCHDOG_POLICY,
    review: {
      candidate,
      deterministicCandidate,
      servableModelIds,
      requiredTaskTypes: routableTaskTypes(),
      freshnessMaxAgeMs: DEFAULT_FRESHNESS_MAX_AGE_MS,
      calibrationGate,
      policyEpochHash: epochHash,
      expectedPolicyEpochHash: epochHash,
    },
    queryGuardMetrics: (taskTypes, sinceIso, untilIso) => guardMetricsWindow({ taskTypes, sinceIso, untilIso }),
    adoptDeps,
    recomputeCalibrationGate,
    notify: (json) => notifyIfConfigured(json),
  };

  const report = await runAutonomyTick(deps, { dryRun });

  const outPath = readFlag(args, "--out");
  const json = JSON.stringify(report, null, 2) + "\n";
  if (outPath) writeFileSync(resolve(outPath), json, "utf8");
  process.stdout.write(json);

  process.stderr.write(
    `autonomy tick @ ${report.evaluatedAt} — tier ${report.tierBefore}->${report.tierAfter}` +
      `${report.tierEvent ? ` (${report.tierEvent.kind}: ${report.tierEvent.reason})` : ""}\n`
  );
  process.stderr.write(
    `  kill-switch: ${report.killSwitchActive ? "ON (no adopt/promote)" : "off"}${dryRun ? " | DRY-RUN (zero mutation)" : ""} | healthy-cycle: ${report.healthyCycle}\n`
  );
  process.stderr.write(`  watch: ${report.watch.items.length} window(s) evaluated\n`);
  for (const warning of report.warnings) {
    process.stderr.write(`  WARNING: ${warning}\n`);
  }
  if (report.noop) {
    process.stderr.write("  review: no semantic routing changes — healthy no-op cycle\n");
  } else {
    process.stderr.write(`  review: ${report.axisEvaluations.length} changed axis(es)\n`);
    for (const axis of report.axisEvaluations) {
      const wasAdopted = report.adopted.some((a) => a.taskType === axis.taskType && a.outcome.outcome === "adopted");
      process.stderr.write(
        `    [${axis.taskType}] eligible=${axis.eligible} adopted=${wasAdopted}${axis.reasons.length ? ` (${axis.reasons.join("; ")})` : ""}\n`
      );
    }
  }
  process.exitCode = 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 2;
  });
}
