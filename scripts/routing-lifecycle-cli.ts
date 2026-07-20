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
 *       [--calibration-gate gate.json] [--calibration-receipts receipts.json]
 *       [--freshness-max-age-ms 604800000] [--db ...] [--data-dir ...]
 *     Prints the human-readable diff + validation summary to stderr, the machine-readable
 *     RoutingDecisionArtifact JSON to stdout (and --out, if given). Exit 0 iff validation passed —
 *     a non-zero exit means "do not approve this candidate", never "something crashed". The #6
 *     calibration gate attached to the artifact is `--calibration-gate <path>` when given (e.g. a
 *     human-reviewed GO+enabled decision); otherwise it is evaluated LIVE from current ledger
 *     evidence (optionally joined to `--calibration-receipts <path>`) — never a bare `null` (issue
 *     #37).
 *
 *   tsx scripts/routing-lifecycle-cli.ts adopt --artifact artifact.json \
 *       --approved-by <name> --reason "<why>" --decision-ref <issue/PR> \
 *       [--table docs/m5-routing.json] [--gateway-url http://...] [--db ...] \
 *       [--calibration-gate gate.json] [--calibration-receipts receipts.json]
 *     Adopts a PREVIOUSLY REVIEWED artifact (produced by `review`). Refuses (throws, no write) if
 *     the artifact failed validation, or if the routing policy changed since it was reviewed. If any
 *     lineage entry is organic-judge-dependent, ALSO recomputes the LIVE #6 gate right now and
 *     refuses (no write) unless it still admits it (issue #37 — defense-in-depth against a stale
 *     review). Snapshots the current table, writes the candidate, reloads the live gateway (no
 *     restart via an owner-key-authenticated POST /admin/routing-table/reload — see resolveAdminKey),
 *     runs a canary over changed routes, and rolls back to the exact prior bytes on any failure.
 *     `--gateway-url` defaults to the gateway's OWN configured listener, not loopback (issue #38 —
 *     see resolveGatewayUrl).
 *
 *   tsx scripts/routing-lifecycle-cli.ts rollback --snapshot prior-table.json --reason "<why>" \
 *       [--table docs/m5-routing.json] [--gateway-url http://...]
 *     The documented MANUAL rollback command: restores an exact snapshot file and reloads.
 *
 *   tsx scripts/routing-lifecycle-cli.ts watch [--dry-run] [--data-dir ./data] \
 *       [--table docs/m5-routing.json] [--gateway-url http://...] [--db ...]
 *     The post-adoption regression watchdog (issue #47). Evaluates every `pending` adoption's watch
 *     window: computes guard metrics (error/escalation/verifier-fail/retry rate, latency) on the
 *     affected task types from the ledger, for a post-adoption window and an equal-length
 *     pre-adoption baseline, and compares them (src/homeserver/adoption-watchdog.ts). A regression
 *     beyond its bound (with sufficient sample) auto-reverts to the exact adoption snapshot via the
 *     SAME #7 rollback primitives (`manualRollback` + `runCanary`) and QUARANTINEs the affected task
 *     types (refused at `review`/`adopt` until a cooldown elapses AND a fresh candidate clears a
 *     stronger margin). Suitable for cron. `--dry-run` reports what WOULD happen (verdicts, would-be
 *     reverts) without mutating any durable state. Respects `AUTONOMY_KILL_SWITCH=on`: still
 *     evaluates and records, but performs no auto-revert/quarantine write (reports what it would
 *     have done). Durable watch state lives under `--data-dir` (default ./data,
 *     `<data-dir>/adoption-watchdog/`) — a path deploy-gateway.sh's rsync NEVER touches (issue #44
 *     discipline), so it survives restarts and redeploys.
 *
 * ENV: EVAL_DB_PATH (ledger DB, default ./data/eval.db);
 *      GATEWAY_URL (explicit override; else derived from the gateway's OWN configured listener —
 *        HOMESERVER_HOST/HOMESERVER_PORT via loadConfig() — falling back to http://127.0.0.1:8080
 *        only when nothing configures a host at all; see resolveGatewayUrl, issue #38);
 *      ROUTING_LIFECYCLE_ADMIN_KEY, or HOMESERVER_OWNER_KEY as a fallback (owner/admin gateway key
 *        used ONLY to call the reload endpoint; see resolveAdminKey, issue #38);
 *      AUTONOMY_KILL_SWITCH=on (issue #47): the `watch` command still evaluates/records but performs
 *        no auto-revert/quarantine write. Absent/anything else = acting ENABLED — fail-closed here
 *        means REVERTING to the known-good snapshot, the safe direction, not refusing to.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { loadConfig, type HomeserverConfig } from "../src/homeserver/config.js";
import { ledgerReport, listCalibrationSampleRows, guardMetricsWindow } from "../src/homeserver/ledger.js";
import { listModels } from "../src/homeserver/model-admin.js";
import { readRegistry, DEFAULT_REGISTRY_PATH } from "../src/homeserver/model-registry.js";
import { contentDigest } from "../src/homeserver/evidence-identity.js";
import { routableTaskTypes, type SourceManifestEntry } from "../src/homeserver/routing-table-generator.js";
import type { DiffableRoutingTable } from "../src/homeserver/routing-table-diff.js";
import type { CalibrationGateDecision } from "../src/homeserver/calibration-gate.js";
import type { QualityReceiptRef } from "../src/homeserver/calibration-quality-receipts.js";
import { computeLiveCalibrationGate } from "../src/homeserver/calibration-gate-live.js";
import {
  buildCandidatePair,
  buildDecisionArtifact,
  approveArtifact,
  adoptRoutingTable,
  manualRollback,
  summarizeCalibrationGate,
  gateAdmitsOrganicEvidence,
  type RoutingDecisionArtifact,
  type AdoptDeps,
} from "../src/homeserver/routing-lifecycle.js";
import {
  evaluateQuarantineGate,
  loadQuarantineState,
  recordAdoptionForWatch,
  runAdoptionWatch,
  DEFAULT_WATCHDOG_POLICY,
} from "../src/homeserver/adoption-watchdog.js";

const DEFAULT_TABLE_PATH = resolve("./docs/m5-routing.json");
const DEFAULT_FRESHNESS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEFAULT_DATA_DIR = resolve("./data");

function resolveDataDir(args: string[]): string {
  return resolve(readFlag(args, "--data-dir") ?? DEFAULT_DATA_DIR);
}

/** Task types whose route actually CHANGED vs the adopted table — the axes both the watchdog and the
 *  quarantine gate operate on. Same expression `adoptRoutingTable` uses internally for its own
 *  changed-route canary scope (routing-lifecycle.ts) — kept identical here rather than re-derived. */
function changedTaskTypesOf(diff: { changes: Array<{ kind: string; taskType: string }> }): string[] {
  return diff.changes.filter((c) => c.kind !== "unchanged").map((c) => c.taskType);
}

/**
 * Issue #47: refuse (fail closed) when any task type this candidate CHANGES is currently
 * quarantined and has not cleared (cooldown elapsed AND a stronger margin δ′ satisfied — see
 * adoption-watchdog.ts's `evaluateQuarantineGate`, the single definition both `review` and `adopt`
 * consult here). Returns the gate result so callers can both print it and decide whether to refuse.
 */
function checkQuarantineGate(p: {
  dataDir: string;
  diff: { changes: Array<{ kind: string; taskType: string }> };
  candidateRouting: Record<string, { passRate?: number } | undefined>;
  nowIso: string;
}): ReturnType<typeof evaluateQuarantineGate> {
  const changedTaskTypes = changedTaskTypesOf(p.diff);
  const quarantine = loadQuarantineState(p.dataDir);
  const candidatePassRateByTaskType: Record<string, number | null | undefined> = {};
  for (const t of changedTaskTypes) candidatePassRateByTaskType[t] = p.candidateRouting[t]?.passRate ?? null;
  return evaluateQuarantineGate({ changedTaskTypes, quarantine, nowIso: p.nowIso, candidatePassRateByTaskType });
}

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

/** Loads an EXPLICIT, previously-computed gate file (e.g. a human-reviewed GO with `enabling`
 *  populated by calibration-gate.ts's `attachReviewedDecision`) — the only way `enabling` is ever
 *  non-null, since `computeLiveCalibrationGate`/`evaluateCalibrationGate` always leave it null. This
 *  stays the preferred, explicit path when given; see `resolveCalibrationGate` for the fallback. */
export function loadCalibrationGate(path: string | undefined): CalibrationGateDecision | null {
  if (!path) return null;
  const raw = readFileSync(resolve(path), "utf8");
  const parsed = JSON.parse(raw) as CalibrationGateDecision;
  if (parsed.verdict !== "HOLD" && parsed.verdict !== "GO") {
    throw new Error(`--calibration-gate ${path}: not a recognisable CalibrationGateDecision (bad "verdict")`);
  }
  return parsed;
}

/** Loads a `--calibration-receipts <path>` Quality Receipts export for the live-gate computation
 *  (mirrors scripts/harvest-judge-calibration-gate.ts's own `--receipts` validation). Optional —
 *  omitting it computes the live gate with zero receipts, which honestly evaluates to HOLD
 *  ("insufficient audited sample") rather than skipping the gate. */
export function loadCalibrationReceipts(path: string | undefined): QualityReceiptRef[] {
  if (!path) return [];
  const raw = readFileSync(resolve(path), "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`--calibration-receipts ${path}: expected a JSON array of QualityReceiptRef objects`);
  }
  for (const [i, r] of parsed.entries()) {
    const o = r as Record<string, unknown>;
    const requiredStrings = ["receiptId", "receiptDigest", "bindingKey", "disposition", "rubricVersion", "reviewerId"];
    for (const field of requiredStrings) {
      if (typeof o[field] !== "string") {
        throw new Error(`--calibration-receipts ${path}: row ${i} missing/invalid string field "${field}"`);
      }
    }
    if (!["pass", "partial", "fail", "conflicted"].includes(o["rating"] as string)) {
      throw new Error(`--calibration-receipts ${path}: row ${i} has invalid "rating" (expected pass|partial|fail|conflicted)`);
    }
  }
  return parsed as QualityReceiptRef[];
}

/**
 * Resolve the #6 calibration gate the CLI attaches to a decision artifact (issue #37): an explicit
 * `--calibration-gate <path>` file (e.g. a human-reviewed GO+enabled decision) takes precedence when
 * given; otherwise this evaluates the LIVE gate from current ledger evidence
 * (`computeLiveCalibrationGate`) and an optional `--calibration-receipts <path>` export, so the
 * artifact never defaults to a bare `null` merely because no file was piped in.
 */
export function resolveCalibrationGate(args: string[], generatedAt: string): CalibrationGateDecision | null {
  const overridePath = readFlag(args, "--calibration-gate");
  if (overridePath) return loadCalibrationGate(overridePath);
  const rows = listCalibrationSampleRows({ includeShadow: true });
  const receipts = loadCalibrationReceipts(readFlag(args, "--calibration-receipts"));
  return computeLiveCalibrationGate({ rows, receipts, generatedAt });
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
  const generatedAt = new Date().toISOString();
  // #37: the live #6 gate, not a hardcoded null — see resolveCalibrationGate's doc comment.
  const calibrationGate = resolveCalibrationGate(args, generatedAt);

  const verdicts = ledgerReport(config.policy);
  const deterministicVerdicts = ledgerReport(config.policy, { excludeOrganicJudge: true });
  const registry = readRegistry(DEFAULT_REGISTRY_PATH);
  const servableModelIds = await loadServableModelIds();

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
  // #37: always surface the gate verdict for the reviewer, not only when it happens to gate a
  // change — an absent/HOLD gate is a decision-relevant fact even on a run with no organic-dependent
  // routes this time.
  process.stderr.write(
    `calibration gate (#6): ${
      artifact.calibrationGate
        ? `${artifact.calibrationGate.verdict}${artifact.calibrationGate.enabled ? "+enabled" : ""} ` +
          `(policy ${artifact.calibrationGate.policyId.slice(0, 12)}, generated ${artifact.calibrationGate.generatedAt})`
        : "none consulted"
    }\n`
  );
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

  // #47: report-time quarantine visibility — the hard refusal lives at `adopt` (fail closed, before
  // any write); surfacing it here too means a reviewer sees the block BEFORE spending an approval on
  // a candidate that would only be refused later.
  const dataDir = resolveDataDir(args);
  const quarantineGate = checkQuarantineGate({ dataDir, diff: artifact.diff, candidateRouting: artifact.candidate.routing, nowIso: generatedAt });
  if (quarantineGate.blocked) {
    process.stderr.write(`\nquarantine (#47): BLOCKED — ${quarantineGate.blockedAxes.length} axis(es) refused:\n`);
    for (const b of quarantineGate.blockedAxes) process.stderr.write(`  [axis-quarantined] ${b.taskType}: ${b.reason}\n`);
  }

  const json = JSON.stringify(artifact, null, 2) + "\n";
  if (outPath) {
    writeFileSync(resolve(outPath), json, "utf8");
    process.stderr.write(`wrote review artifact to ${outPath}\n`);
  }
  process.stdout.write(json);
  process.exitCode = artifact.validation.ok && !quarantineGate.blocked ? 0 : 1;
}

// ─── adopt ──────────────────────────────────────────────────────────────────────

/**
 * Resolve the gateway base URL to call for `/admin/routing-table/reload` (issue #38). Precedence:
 * `--gateway-url` (explicit) > `GATEWAY_URL` env (explicit) > the gateway's OWN configured listener
 * — `config.gatewayHost`/`config.gatewayPort`, i.e. `HOMESERVER_HOST`/`HOMESERVER_PORT` via
 * `loadConfig()`, the EXACT host/port `gateway.ts`'s `server.listen(cfg.gatewayPort, cfg.gatewayHost, ...)`
 * binds (config.ts). In the live deployment `HOMESERVER_HOST` is already set to the box's tailnet
 * interface (deploy/README.md's "Live deployment (authoritative)" section, issue #23) — deriving
 * from config means a cron/no-flag `adopt` run ON the box resolves the real listener automatically,
 * instead of defaulting to loopback while the gateway only binds the tailnet address. Only when
 * NOTHING configures a host (bare local dev, no `.env`) does this still fall back to the historical
 * `http://127.0.0.1:8080` default, because that is `loadConfig()`'s own default for `gatewayHost`.
 */
export function resolveGatewayUrl(args: string[], config: Pick<HomeserverConfig, "gatewayHost" | "gatewayPort">): string {
  const explicit = readFlag(args, "--gateway-url") ?? process.env["GATEWAY_URL"];
  if (explicit) return explicit.replace(/\/$/, "");
  return `http://${config.gatewayHost}:${config.gatewayPort}`;
}

/** The env vars checked, in order, for the owner/admin bearer key that authenticates the reload
 *  call (issue #38). `ROUTING_LIFECYCLE_ADMIN_KEY` is the dedicated var; `HOMESERVER_OWNER_KEY` is
 *  the pre-existing owner-tier bearer-key convention this repo already uses for the same purpose
 *  (`scripts/deploy-gateway.sh`'s `DEPLOY_CAPABILITY_KEY_ENV` default, deploy/README.md's
 *  "Credential-safe authenticated capability smoke test") — falling back to it means a box that
 *  already exports an owner key for deploy/capability checks does not need a second key minted and
 *  wired just for `adopt`. As of this change NEITHER var is guaranteed to be present in the
 *  deployed gateway `.env` (see deploy/README.md's "Adopting a routing-table change" section) —
 *  `callReloadEndpoint`'s error names both when neither is set.
 */
export const ADMIN_KEY_ENV_VARS = ["ROUTING_LIFECYCLE_ADMIN_KEY", "HOMESERVER_OWNER_KEY"] as const;

export function resolveAdminKey(): string {
  for (const name of ADMIN_KEY_ENV_VARS) {
    const v = process.env[name];
    if (v && v.trim() !== "") return v;
  }
  return "";
}

async function callReloadEndpoint(base: string, adminKey: string): Promise<{ ok: boolean; error?: string }> {
  if (!adminKey) {
    return {
      ok: false,
      error:
        `no admin key available — set ${ADMIN_KEY_ENV_VARS.join(" or ")} in the environment to an ` +
        `owner-tier bearer key (mint one with 'tsx src/homeserver/cli.ts keys mint --alias <name> ` +
        `--tier owner'). See deploy/README.md's "Adopting a routing-table change" section for what ` +
        `the deployed .env must contain for a zero-flag/cron adopt.`,
    };
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

/** Composes the #7 `AdoptDeps` used by `adopt`, `rollback`, AND `watch` (issue #47) — one definition
 *  so all three commands resolve the gateway URL/admin key/servable-catalogue probe identically.
 *  Exported so `scripts/autonomy-tick-cli.ts` (issue #49) reuses the EXACT same gateway-reload
 *  wiring for its own adopt/watch composition instead of a second, possibly-diverging copy. */
export function buildAdoptDeps(args: string[], config: HomeserverConfig, tablePath: string): AdoptDeps {
  const base = resolveGatewayUrl(args, config);
  const adminKey = resolveAdminKey();
  return {
    tablePath,
    readTable: (p) => readFileSync(p, "utf8"),
    writeTable: (p, d) => writeFileSync(p, d, "utf8"),
    reload: () => callReloadEndpoint(base, adminKey),
    servableModelIdsAfterReload: () => loadServableModelIds(),
    nowIso: () => new Date().toISOString(),
    currentPolicyEpochHash: policyEpochHash(config.policy),
  };
}

async function cmdAdopt(args: string[]): Promise<void> {
  if (readFlag(args, "--db")) process.env["EVAL_DB_PATH"] = readFlag(args, "--db");
  const artifactPath = readFlag(args, "--artifact");
  const approvedBy = readFlag(args, "--approved-by");
  const reason = readFlag(args, "--reason");
  const decisionRef = readFlag(args, "--decision-ref");
  const tablePath = resolve(readFlag(args, "--table") ?? DEFAULT_TABLE_PATH);
  const dataDir = resolveDataDir(args);
  if (!artifactPath || !approvedBy || !reason || !decisionRef) {
    process.stderr.write(
      "adopt requires --artifact <path> --approved-by <name> --reason \"<why>\" --decision-ref <issue/PR>\n"
    );
    process.exitCode = 2;
    return;
  }

  const artifact = JSON.parse(readFileSync(resolve(artifactPath), "utf8")) as RoutingDecisionArtifact;

  // #37: adopt-time re-validation of the #6 admissibility rule, as defense-in-depth alongside
  // adoptRoutingTable's own policy-epoch staleness check. `artifact.calibrationGate` is a
  // review-time snapshot (frozen when `review` ran); if any lineage entry was flagged
  // organic-judge-dependent, recompute the LIVE gate right now and refuse adoption unless it STILL
  // admits it (gateAdmitsOrganicEvidence — the exact same predicate validateCandidate itself uses,
  // never a second copy). This does not alter validateCandidate/adoptRoutingTable/approveArtifact —
  // it is an additional CLI-level refusal that runs BEFORE approveArtifact/adoptRoutingTable are
  // ever called, so a stale-good review can never coast an organic-dependent change through on a
  // gate that has since gone HOLD.
  const organicDependentTaskTypes = artifact.lineage.filter((l) => l.organicJudgeDependent).map((l) => l.taskType);
  if (organicDependentTaskTypes.length > 0) {
    const liveGate = resolveCalibrationGate(args, new Date().toISOString());
    const liveGateSummary = summarizeCalibrationGate(liveGate);
    if (!gateAdmitsOrganicEvidence(liveGateSummary)) {
      process.stderr.write(
        `adopt refused: organic-judge-dependent route change(s) [${organicDependentTaskTypes.join(", ")}] require ` +
          `the LIVE #6 gate to be GO+enabled at adopt time (current: ${
            liveGateSummary ? `${liveGateSummary.verdict}${liveGateSummary.enabled ? "+enabled" : ""}` : "none consulted"
          }). Re-review and re-approve once the gate clears; approval is never overridden here.\n`
      );
      process.exitCode = 1;
      return;
    }
    process.stderr.write(
      `organic-judge-dependent route change(s) [${organicDependentTaskTypes.join(", ")}] confirmed admissible by the ` +
        `LIVE #6 gate at adopt time (${liveGateSummary!.verdict}+enabled).\n`
    );
  }

  // #47: quarantine re-check — the SAME fail-closed, additional-CLI-refusal pattern as the #37
  // organic-gate check just above (runs BEFORE approveArtifact/adoptRoutingTable; never trusts a
  // stale review). A currently-quarantined axis this candidate touches is refused until the
  // cooldown has elapsed AND the candidate's own passRate clears the stronger margin δ′ recorded at
  // quarantine time — never overridden by approval.
  const quarantineGate = checkQuarantineGate({
    dataDir,
    diff: artifact.diff,
    candidateRouting: artifact.candidate.routing,
    nowIso: new Date().toISOString(),
  });
  if (quarantineGate.blocked) {
    process.stderr.write(`adopt refused: quarantined axis(es) not yet cleared:\n`);
    for (const b of quarantineGate.blockedAxes) process.stderr.write(`  [axis-quarantined] ${b.taskType}: ${b.reason}\n`);
    process.exitCode = 1;
    return;
  }

  const approval = approveArtifact(artifact, { approvedBy, reason, decisionRef, approvedAt: new Date().toISOString() });

  const config = loadConfig();
  const deps = buildAdoptDeps(args, config, tablePath);

  // #47: capture the EXACT pre-adopt bytes (best-effort — absent on a first-ever adoption) so a
  // successful adopt below can hand them to `recordAdoptionForWatch` as the watchdog's durable
  // revert snapshot. Read BEFORE adoptRoutingTable's own write, mirroring its internal `priorRaw`
  // read — duplicated here deliberately rather than threading a new return field through the
  // reviewed #7 module, keeping that module's contract unchanged.
  const priorRawForWatchdog = ((): string | null => {
    try {
      return readFileSync(tablePath, "utf8");
    } catch {
      return null;
    }
  })();

  const result = await adoptRoutingTable(artifact, approval, deps);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  if (result.outcome === "adopted") {
    process.stderr.write(`ADOPTED — candidateHash=${result.record.candidateHash} approvedBy=${result.record.approvedBy}\n`);
    const watchRecord = recordAdoptionForWatch({
      dataDir,
      adoptedAt: result.record.adoptedAt,
      candidateHash: result.record.candidateHash,
      decisionRef: result.record.decisionRef,
      approvedBy: result.record.approvedBy,
      changedTaskTypes: changedTaskTypesOf(artifact.diff),
      priorRaw: priorRawForWatchdog,
    });
    process.stderr.write(
      `watchdog (#47): queued adoption watch record ${watchRecord.id} for [${watchRecord.changedTaskTypes.join(", ")}] ` +
        `(snapshot ${watchRecord.snapshotPath ? "captured" : "none — first-ever adoption"}); run 'watch' to evaluate.\n`
    );
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
  const config = loadConfig();
  const deps = buildAdoptDeps(args, config, tablePath);

  const record = await manualRollback({ deps, snapshotRaw, reason });
  process.stdout.write(JSON.stringify(record, null, 2) + "\n");
  process.stderr.write(`ROLLED BACK to ${snapshotPath} (reload ${record.reloadOk ? "ok" : "FAILED"})\n`);
  process.exitCode = record.reloadOk ? 0 : 1;
}

// ─── watch (issue #47 — post-adoption regression watchdog) ───────────────────────

function killSwitchOn(): boolean {
  return (process.env["AUTONOMY_KILL_SWITCH"] ?? "").trim().toLowerCase() === "on";
}

async function cmdWatch(args: string[]): Promise<void> {
  if (readFlag(args, "--db")) process.env["EVAL_DB_PATH"] = readFlag(args, "--db");
  const tablePath = resolve(readFlag(args, "--table") ?? DEFAULT_TABLE_PATH);
  const dataDir = resolveDataDir(args);
  const dryRun = args.includes("--dry-run");

  const config = loadConfig();
  const adoptDeps = buildAdoptDeps(args, config, tablePath);
  const killActive = killSwitchOn();

  const report = await runAdoptionWatch(
    {
      dataDir,
      queryGuardMetrics: (taskTypes, sinceIso, untilIso) => guardMetricsWindow({ taskTypes, sinceIso, untilIso }),
      nowIso: () => new Date().toISOString(),
      killSwitchOn,
      adoptDeps,
    },
    DEFAULT_WATCHDOG_POLICY,
    { dryRun }
  );

  process.stdout.write(JSON.stringify(report, null, 2) + "\n");

  if (report.items.length === 0) {
    process.stderr.write("watch: no pending adoption watch records (nothing to evaluate).\n");
  }
  let needsAttention = false;
  for (const item of report.items) {
    const { record, evaluation, action, revert, quarantined } = item;
    process.stderr.write(
      `[${record.candidateHash.slice(0, 12)}] ${record.changedTaskTypes.join(",")} -> verdict=${evaluation.verdict} action=${action}` +
        (dryRun ? " (dry-run — no mutation)" : "") +
        (killActive ? " (AUTONOMY_KILL_SWITCH=on — no mutation)" : "") +
        "\n"
    );
    if (evaluation.verdict === "breach") {
      for (const t of evaluation.perTaskType) {
        if (t.status === "breach") {
          for (const b of t.breaches) {
            process.stderr.write(`  BREACH ${t.taskType}.${b.metric}: baseline=${b.baseline} current=${b.current} delta=${b.delta}\n`);
          }
        }
      }
      if (revert) process.stderr.write(`  revert: ${revert.status}\n`);
      if (quarantined.length > 0) process.stderr.write(`  quarantined: ${quarantined.join(", ")}\n`);
      if (revert?.status === "unknown") needsAttention = true;
    }
    if (evaluation.verdict === "inconclusive") {
      process.stderr.write(`  window ended without sufficient sample on: ${evaluation.perTaskType.filter((t) => t.status === "insufficient-sample").map((t) => t.taskType).join(", ")} — surfaced for review, nothing mutated.\n`);
      needsAttention = true;
    }
  }

  process.exitCode = needsAttention ? 1 : 0;
}

// ─── main ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "review") return cmdReview(rest);
  if (cmd === "adopt") return cmdAdopt(rest);
  if (cmd === "rollback") return cmdRollback(rest);
  if (cmd === "watch") return cmdWatch(rest);
  process.stderr.write("usage: routing-lifecycle-cli.ts <review|adopt|rollback|watch> [flags]\n");
  process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 2;
  });
}
