#!/usr/bin/env tsx
/**
 * routing-lifecycle-cli.ts — the IO composition root for the reviewed routing-table lifecycle
 * (issue #7). All safety logic lives in src/homeserver/routing-lifecycle.ts (pure/DI); this script
 * only wires it to the ledger, the served-model catalogue, the filesystem, and the live gateway's
 * `/admin/routing-table/reload` endpoint.
 *
 * PRODUCTION-ROUTING-MUTATION: `review` NEVER mutates anything — it is the default/dry-run path.
 * `adopt` is the ONLY mutating command, and it REQUIRES --approved-by/--reason/--decision-ref (a
 * recorded human approval action); there is no flag that skips this. `rollback` is the documented
 * manual-recovery command (automatic rollback already happens inside `adopt` on a failed reload or
 * canary).
 *
 * USAGE
 *   tsx scripts/routing-lifecycle-cli.ts review [--out artifact.json] [--table docs/m5-routing.json]
 *       [--calibration-gate gate.json] [--freshness-max-age-ms 604800000] [--db ...] [--data-dir ...]
 *     Prints the human-readable diff + validation summary to stderr, the machine-readable
 *     RoutingDecisionArtifact JSON to stdout (and --out, if given). Exit 0 iff validation passed —
 *     a non-zero exit means "do not approve this candidate", never "something crashed".
 *
 *   tsx scripts/routing-lifecycle-cli.ts adopt --artifact artifact.json \
 *       --approved-by <name> --reason "<why>" --decision-ref <issue/PR> \
 *       [--table docs/m5-routing.json] [--gateway-url http://127.0.0.1:8080] [--db ...]
 *     Adopts a PREVIOUSLY REVIEWED artifact (produced by `review`). Refuses (throws, no write) if
 *     the artifact failed validation, or if the routing policy changed since it was reviewed.
 *     Snapshots the current table, writes the candidate, reloads the live gateway (no restart via
 *     ROUTING_LIFECYCLE_ADMIN_KEY-authenticated POST /admin/routing-table/reload), runs a canary
 *     over changed routes, and rolls back to the exact prior bytes on any failure.
 *
 *   tsx scripts/routing-lifecycle-cli.ts rollback --snapshot prior-table.json --reason "<why>" \
 *       [--table docs/m5-routing.json] [--gateway-url http://127.0.0.1:8080]
 *     The documented MANUAL rollback command: restores an exact snapshot file and reloads.
 *
 * ENV: EVAL_DB_PATH (ledger DB, default ./data/eval.db); GATEWAY_URL (default http://127.0.0.1:8080);
 *      ROUTING_LIFECYCLE_ADMIN_KEY (owner/admin gateway key used ONLY to call the reload endpoint).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { loadConfig } from "../src/homeserver/config.js";
import { ledgerReport } from "../src/homeserver/ledger.js";
import { listModels } from "../src/homeserver/model-admin.js";
import { readRegistry, DEFAULT_REGISTRY_PATH } from "../src/homeserver/model-registry.js";
import { contentDigest } from "../src/homeserver/evidence-identity.js";
import { routableTaskTypes, type SourceManifestEntry } from "../src/homeserver/routing-table-generator.js";
import type { DiffableRoutingTable } from "../src/homeserver/routing-table-diff.js";
import type { CalibrationGateDecision } from "../src/homeserver/calibration-gate.js";
import {
  buildCandidatePair,
  buildDecisionArtifact,
  approveArtifact,
  adoptRoutingTable,
  manualRollback,
  type RoutingDecisionArtifact,
  type AdoptDeps,
} from "../src/homeserver/routing-lifecycle.js";

const DEFAULT_TABLE_PATH = resolve("./docs/m5-routing.json");
const DEFAULT_FRESHNESS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function readFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith("--")) return undefined;
  return v;
}

function loadAdoptedTable(path: string): DiffableRoutingTable | null {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  try {
    return JSON.parse(raw) as DiffableRoutingTable;
  } catch (err) {
    throw new Error(
      `adopted table at ${path} is corrupt (${err instanceof Error ? err.message : String(err)}) — refusing to diff against an unreadable table.`
    );
  }
}

async function loadServableModelIds(): Promise<string[] | null> {
  try {
    const models = await listModels();
    const ids = models.map((m) => m.key).filter((id) => id.trim() !== "");
    return ids;
  } catch (err) {
    process.stderr.write(
      `serving catalogue unavailable (${err instanceof Error ? err.message : String(err)}) — validation will fail closed on every named-model route.\n`
    );
    return null;
  }
}

function loadCalibrationGate(path: string | undefined): CalibrationGateDecision | null {
  if (!path) return null;
  const raw = readFileSync(resolve(path), "utf8");
  const parsed = JSON.parse(raw) as CalibrationGateDecision;
  if (parsed.verdict !== "HOLD" && parsed.verdict !== "GO") {
    throw new Error(`--calibration-gate ${path}: not a recognisable CalibrationGateDecision (bad "verdict")`);
  }
  return parsed;
}

function policyEpochHash(policy: unknown): string {
  return contentDigest(JSON.stringify(policy));
}

// ─── review ─────────────────────────────────────────────────────────────────────

async function cmdReview(args: string[]): Promise<void> {
  if (readFlag(args, "--db")) process.env["EVAL_DB_PATH"] = readFlag(args, "--db");
  const config = loadConfig();
  const tablePath = resolve(readFlag(args, "--table") ?? DEFAULT_TABLE_PATH);
  const outPath = readFlag(args, "--out");
  const freshnessMaxAgeMs = Number(readFlag(args, "--freshness-max-age-ms") ?? DEFAULT_FRESHNESS_MAX_AGE_MS);
  const calibrationGate = loadCalibrationGate(readFlag(args, "--calibration-gate"));

  const verdicts = ledgerReport(config.policy);
  const deterministicVerdicts = ledgerReport(config.policy, { excludeOrganicJudge: true });
  const registry = readRegistry(DEFAULT_REGISTRY_PATH);
  const servableModelIds = await loadServableModelIds();
  const generatedAt = new Date().toISOString();

  const sources: SourceManifestEntry[] = [
    {
      source: "capability-ledger (delegations table, full evidence)",
      path: resolve(process.env["EVAL_DB_PATH"] ?? "./data/eval.db"),
      present: true,
      records: verdicts.length,
      latest: null,
      note: "ledgerReport(policy) — see scripts/generate-routing-table.ts for the canonical generator IO",
    },
    {
      source: "model-scout registry (JSONL)",
      path: DEFAULT_REGISTRY_PATH,
      present: existsSync(DEFAULT_REGISTRY_PATH),
      records: registry.length,
      latest: null,
    },
  ];

  const { candidate, deterministicCandidate } = buildCandidatePair({
    verdicts,
    deterministicVerdicts,
    registry,
    sources,
    generatedAt,
    policy: { minSamples: config.policy.minSamples },
    servableModelIds: servableModelIds ?? undefined,
  });

  const adopted = loadAdoptedTable(tablePath);
  const epochHash = policyEpochHash(config.policy);

  const artifact = buildDecisionArtifact({
    candidate,
    deterministicCandidate,
    adopted,
    servableModelIds,
    requiredTaskTypes: routableTaskTypes(),
    freshnessMaxAgeMs,
    nowIso: generatedAt,
    calibrationGate,
    policyEpochHash: epochHash,
    expectedPolicyEpochHash: epochHash,
  });

  process.stderr.write(artifact.humanDiff);
  process.stderr.write(
    `\nvalidation: ${artifact.validation.ok ? "PASS" : "REFUSED"} (${artifact.validation.issues.length} issue(s))\n`
  );
  for (const issue of artifact.validation.issues) {
    process.stderr.write(`  [${issue.code}]${issue.taskType ? ` ${issue.taskType}:` : ""} ${issue.detail}\n`);
  }
  const organicDependent = artifact.lineage.filter((l) => l.organicJudgeDependent);
  if (organicDependent.length > 0) {
    process.stderr.write(
      `organic-judge-dependent route change(s): ${organicDependent.map((l) => l.taskType).join(", ")} ` +
        `(#6 gate consulted: ${artifact.calibrationGate ? `${artifact.calibrationGate.verdict}${artifact.calibrationGate.enabled ? "+enabled" : ""}` : "none"})\n`
    );
  }

  const json = JSON.stringify(artifact, null, 2) + "\n";
  if (outPath) {
    writeFileSync(resolve(outPath), json, "utf8");
    process.stderr.write(`wrote review artifact to ${outPath}\n`);
  }
  process.stdout.write(json);
  process.exitCode = artifact.validation.ok ? 0 : 1;
}

// ─── adopt ──────────────────────────────────────────────────────────────────────

function gatewayUrl(args: string[]): string {
  return (readFlag(args, "--gateway-url") ?? process.env["GATEWAY_URL"] ?? "http://127.0.0.1:8080").replace(/\/$/, "");
}

async function callReloadEndpoint(base: string, adminKey: string): Promise<{ ok: boolean; error?: string }> {
  if (!adminKey) {
    return { ok: false, error: "ROUTING_LIFECYCLE_ADMIN_KEY not set — cannot authenticate to the reload endpoint" };
  }
  try {
    const res = await fetch(`${base}/admin/routing-table/reload`, {
      method: "POST",
      headers: { authorization: `Bearer ${adminKey}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, error: `HTTP ${res.status}: ${body.slice(0, 300)}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function cmdAdopt(args: string[]): Promise<void> {
  if (readFlag(args, "--db")) process.env["EVAL_DB_PATH"] = readFlag(args, "--db");
  const artifactPath = readFlag(args, "--artifact");
  const approvedBy = readFlag(args, "--approved-by");
  const reason = readFlag(args, "--reason");
  const decisionRef = readFlag(args, "--decision-ref");
  const tablePath = resolve(readFlag(args, "--table") ?? DEFAULT_TABLE_PATH);
  if (!artifactPath || !approvedBy || !reason || !decisionRef) {
    process.stderr.write(
      "adopt requires --artifact <path> --approved-by <name> --reason \"<why>\" --decision-ref <issue/PR>\n"
    );
    process.exitCode = 2;
    return;
  }

  const artifact = JSON.parse(readFileSync(resolve(artifactPath), "utf8")) as RoutingDecisionArtifact;
  const approval = approveArtifact(artifact, { approvedBy, reason, decisionRef, approvedAt: new Date().toISOString() });

  const base = gatewayUrl(args);
  const adminKey = process.env["ROUTING_LIFECYCLE_ADMIN_KEY"] ?? "";
  const config = loadConfig();

  const deps: AdoptDeps = {
    tablePath,
    readTable: (p) => readFileSync(p, "utf8"),
    writeTable: (p, d) => writeFileSync(p, d, "utf8"),
    reload: () => callReloadEndpoint(base, adminKey),
    servableModelIdsAfterReload: () => loadServableModelIds(),
    nowIso: () => new Date().toISOString(),
    currentPolicyEpochHash: policyEpochHash(config.policy),
  };

  const result = await adoptRoutingTable(artifact, approval, deps);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  if (result.outcome === "adopted") {
    process.stderr.write(`ADOPTED — candidateHash=${result.record.candidateHash} approvedBy=${result.record.approvedBy}\n`);
    process.exitCode = 0;
  } else if (result.outcome === "rolled-back") {
    process.stderr.write(`ROLLED BACK (canary failed) — ${result.rollback.reason}\n`);
    process.exitCode = 1;
  } else if (result.outcome === "write-failed") {
    process.stderr.write(`WRITE FAILED, rolled back — ${result.rollback.reason}\n`);
    process.exitCode = 1;
  } else {
    process.stderr.write(`RELOAD FAILED, rolled back — ${result.rollback.reason}\n`);
    process.exitCode = 1;
  }
  if (result.outcome !== "adopted" && !result.rollback.restoreWriteOk) {
    process.stderr.write(
      `\n!! ROLLBACK RESTORE WRITE ALSO FAILED (${result.rollback.restoreWriteError ?? "unknown error"}) !!\n` +
        `The table on disk is in an UNKNOWN state — MANUAL RECOVERY REQUIRED. Restore the last-known-good\n` +
        `snapshot by hand (e.g. from git history or an operator backup) and re-run:\n` +
        `  tsx scripts/routing-lifecycle-cli.ts rollback --snapshot <path> --reason "manual recovery after failed automatic rollback"\n`
    );
  }
}

// ─── rollback (documented manual command) ────────────────────────────────────────

async function cmdRollback(args: string[]): Promise<void> {
  const snapshotPath = readFlag(args, "--snapshot");
  const reason = readFlag(args, "--reason") ?? "manual rollback (scripts/routing-lifecycle-cli.ts rollback)";
  const tablePath = resolve(readFlag(args, "--table") ?? DEFAULT_TABLE_PATH);
  if (!snapshotPath) {
    process.stderr.write("rollback requires --snapshot <path-to-exact-prior-table.json>\n");
    process.exitCode = 2;
    return;
  }
  const snapshotRaw = readFileSync(resolve(snapshotPath), "utf8");
  const base = gatewayUrl(args);
  const adminKey = process.env["ROUTING_LIFECYCLE_ADMIN_KEY"] ?? "";

  const deps: AdoptDeps = {
    tablePath,
    readTable: (p) => readFileSync(p, "utf8"),
    writeTable: (p, d) => writeFileSync(p, d, "utf8"),
    reload: () => callReloadEndpoint(base, adminKey),
    servableModelIdsAfterReload: () => loadServableModelIds(),
    nowIso: () => new Date().toISOString(),
    currentPolicyEpochHash: "", // not consulted by manualRollback
  };

  const record = await manualRollback({ deps, snapshotRaw, reason });
  process.stdout.write(JSON.stringify(record, null, 2) + "\n");
  process.stderr.write(`ROLLED BACK to ${snapshotPath} (reload ${record.reloadOk ? "ok" : "FAILED"})\n`);
  process.exitCode = record.reloadOk ? 0 : 1;
}

// ─── main ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "review") return cmdReview(rest);
  if (cmd === "adopt") return cmdAdopt(rest);
  if (cmd === "rollback") return cmdRollback(rest);
  process.stderr.write("usage: routing-lifecycle-cli.ts <review|adopt|rollback> [flags]\n");
  process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 2;
  });
}
