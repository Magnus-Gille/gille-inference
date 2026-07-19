#!/usr/bin/env tsx
/**
 * generate-routing-table.ts — the WRITER for docs/m5-routing.json (issue #145).
 *
 * The routing table (docs/m5-routing.json, loaded by src/homeserver/routing-table.ts and consumed
 * by the T3 macro-router) used to be a hand-edited snapshot with no writers. This script is the
 * missing writer: it reads the evidence the system already collects and regenerates the table with
 * a freshness stamp + a source manifest, so the table LEARNS from the ledger instead of drifting.
 *
 * Sources (all read-only):
 *   1. Capability ledger — the `delegations` SQLite table (EVAL_DB_PATH), populated by cartography
 *      + nightly delegations. ledgerReport(policy) aggregates it into per-(task_type,model) verdicts.
 *      This is the canonical evidence for routing decisions.
 *   2. Cartography JSONL runs — data/cartography-*.jsonl (+ extra-probes-results.jsonl): read for
 *      PROVENANCE (row counts, latest ts). The verdicts themselves come from the ledger the
 *      cartography wrote into, so we don't double-count — we record where they came from.
 *   3. Model-Scout registry — data/model-scout-registry.jsonl: fills a model's overall pass-rate
 *      when the ledger is too thin to assert one (e.g. the qwen36-a3b overallPass hole, which the
 *      Sunday scout cron fills — this script CONSUMES that, it does not race a GPU job).
 *
 * USAGE
 *   tsx scripts/generate-routing-table.ts --dry-run          # print the would-be table, write nothing
 *   tsx scripts/generate-routing-table.ts                    # write docs/m5-routing.json (guarded)
 *   tsx scripts/generate-routing-table.ts --out /tmp/x.json  # write elsewhere
 *   tsx scripts/generate-routing-table.ts --force            # override the CLOBBER guard only —
 *                                                            # a flagged downgrade still needs --accept-downgrades
 *   tsx scripts/generate-routing-table.ts --accept-downgrades  # acknowledge a capability regression
 *
 * SAFETY (three layers):
 *   1. CLOBBER GUARD — refuses to overwrite the table when no routable task type has any ledger
 *      evidence (would emit an all-escalate table and clobber a good curated one) unless --force.
 *   2. REGRESSION ALARM (#151) — every regeneration is semantically diffed against the currently-
 *      adopted table at --out. Any capability DOWNGRADE (delegate-local → explore/escalate, or a
 *      type dropping out) is an alerted event: loud stderr report + a machine-readable
 *      `ROUTING_REGRESSION_JSON {...}` line + a best-effort Heimdall status panel, and the write
 *      is REFUSED with a non-zero exit unless --accept-downgrades explicitly acknowledges it.
 *      Downgrades caused by evidence that is EXPECTED BUT MISSING (the adopted table proves the
 *      capability was measured; the ledger now has zero attempts — the #150 incident class) are
 *      flagged as such, distinct from "genuinely never probed" pending holes, which stay quiet.
 *   3. A corrupt/unparseable adopted table is a hard error (we cannot prove no regression).
 *
 * --dry-run always prints the would-be table; it still exits non-zero on a pending downgrade so
 * cron/CI can use it as a check, but never writes and never pushes an external alert.
 *
 * ENV: EVAL_DB_PATH (default ./data/eval.db). --db overrides it.
 *      HEIMDALL_PANELS_URL + HEIMDALL_FLEET_TOKEN enable the best-effort regression alert panel.
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadConfig } from "../src/homeserver/config.js";
import { ledgerReport } from "../src/homeserver/ledger.js";
import { getDb } from "../src/db.js";
import { listModels } from "../src/homeserver/model-admin.js";
import { readRegistry, DEFAULT_REGISTRY_PATH } from "../src/homeserver/model-registry.js";
import {
  generateRoutingTable,
  summarizeEvidence,
  type SourceManifestEntry,
} from "../src/homeserver/routing-table-generator.js";
import {
  diffRoutingTables,
  formatRoutingDiff,
  type DiffableRoutingTable,
  type RoutingTableDiff,
} from "../src/homeserver/routing-table-diff.js";
import { pushPanel } from "../src/homeserver/heimdall-push.js";

// ── Arg parsing ──────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): {
  dryRun: boolean;
  force: boolean;
  acceptDowngrades: boolean;
  out: string;
  db: string | undefined;
  dataDir: string;
} {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, "..");
  return {
    dryRun: argv.includes("--dry-run"),
    force: argv.includes("--force"),
    acceptDowngrades: argv.includes("--accept-downgrades"),
    out: flag("--out") ?? join(repoRoot, "docs", "m5-routing.json"),
    db: flag("--db"),
    dataDir: flag("--data-dir") ?? resolve("./data"),
  };
}

// ── Provenance helpers ─────────────────────────────────────────────────────────────

/** Count non-empty lines + last-line `ts`/`evaluatedAt` across matching JSONL files in a dir. */
function scanJsonl(dataDir: string, matcher: (name: string) => boolean): { files: string[]; records: number; latest: string | null } {
  const files: string[] = [];
  let records = 0;
  let latest: string | null = null;
  if (!existsSync(dataDir)) return { files, records, latest };
  for (const name of readdirSync(dataDir).sort()) {
    if (!matcher(name)) continue;
    const path = join(dataDir, name);
    try {
      const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim());
      files.push(name);
      records += lines.length;
      // Last line's timestamp — appended in order, so it's the freshest in the file.
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const o = JSON.parse(lines[i]!) as { ts?: string; evaluatedAt?: string };
          const ts = o.ts ?? o.evaluatedAt ?? null;
          if (ts && (latest === null || ts > latest)) latest = ts;
          break;
        } catch {
          /* skip a corrupt trailing line, try the previous */
        }
      }
    } catch {
      /* unreadable file — skip; it just won't appear in the manifest */
    }
  }
  return { files, records, latest };
}

// ── Regression alarm (#151) ─────────────────────────────────────────────────────────

/**
 * Read the currently-adopted table at `path`. Returns null when no table exists yet (first-ever
 * generation — nothing to regress from). A present-but-unparseable table is a HARD error: we
 * cannot prove the regeneration doesn't regress a capability we can't read.
 */
function loadAdoptedTable(path: string): DiffableRoutingTable | null {
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`adopted table at ${path} is unreadable: ${String(err)}`);
  }
  try {
    return JSON.parse(raw) as DiffableRoutingTable;
  } catch (err) {
    throw new Error(
      `adopted table at ${path} is corrupt (JSON parse failed: ${String(err)}) — refusing to ` +
        `regenerate over a table we cannot diff. Inspect/restore it (git checkout, backup) first.`
    );
  }
}

async function loadServableModelIds(): Promise<string[] | undefined> {
  try {
    const models = await listModels();
    const ids = models.map((m) => m.key).filter((id) => id.trim() !== "");
    return ids.length > 0 ? ids : undefined;
  } catch (err) {
    process.stderr.write(
      `model catalogue unavailable; routing generation will not filter stale model ids (${err instanceof Error ? err.message : String(err)}).\n`
    );
    return undefined;
  }
}

/**
 * Emit the capability-regression alarm through the existing escalation path: a best-effort
 * Heimdall status panel (the same content-safe channel every nightly poster uses), plus the
 * loud stderr banner + machine-readable line the calling cron surfaces. Never throws.
 */
async function alertRegression(diff: RoutingTableDiff, generatedAt: string, accepted: boolean): Promise<void> {
  const summary =
    `routing-table regeneration DOWNGRADES ${diff.downgrades.length} task type(s) ` +
    `(${diff.missingEvidence.length} from missing evidence): ` +
    diff.downgrades.map((d) => d.taskType).join(", ");

  process.stderr.write(
    `\n!! ROUTING REGRESSION ${accepted ? "ACKNOWLEDGED (--accept-downgrades)" : "DETECTED"} !!\n` +
      diff.downgrades.map((d) => `  - ${d.detail}\n`).join("") +
      (accepted
        ? ""
        : `Refusing to adopt the regenerated table. If the downgrade is real (a measured capability\n` +
          `loss), re-run with --accept-downgrades to acknowledge it. If evidence is MISSING, restore\n` +
          `it instead: re-run the probe battery (homeserver probe / m5-cartography) or import the\n` +
          `saved battery JSONL via scripts/ingest-probe-evidence.ts — see issue #151.\n`)
  );
  // Machine-readable single line for the calling cron/CI to surface.
  process.stderr.write(
    `ROUTING_REGRESSION_JSON ${JSON.stringify({
      generatedAt,
      accepted,
      downgrades: diff.downgrades.map((d) => ({
        taskType: d.taskType,
        kind: d.kind,
        before: d.before,
        after: d.after,
        evidenceMissing: d.evidenceMissing,
      })),
    })}\n`
  );

  const push = await pushPanel({
    kind: "status",
    service: "m5-inference",
    panel: "routing-regression",
    label: "Routing-table capability regression",
    state: accepted ? "warn" : "fail",
    message: summary.slice(0, 300),
    detail: {
      kind: "table",
      rows: diff.downgrades.map((d) => ({
        taskType: d.taskType,
        before: `${d.before?.verdict ?? "(absent)"} → ${d.before?.model ?? "null"}`,
        after: `${d.after?.verdict ?? "(removed)"} → ${d.after?.model ?? "null"}`,
        evidenceMissing: d.evidenceMissing,
      })),
    },
  });
  process.stderr.write(
    push.ok
      ? `Heimdall alert panel pushed (routing-regression).\n`
      : `(Heimdall alert not sent: ${push.error ?? `HTTP ${push.status}`} — the non-zero exit + ROUTING_REGRESSION_JSON line above are the alarm.)\n`
  );
}

// ── Main ───────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.db) process.env["EVAL_DB_PATH"] = args.db;

  const config = loadConfig();
  const dbPath = resolve(args.db ?? process.env["EVAL_DB_PATH"] ?? "./data/eval.db");

  // 1. Ledger verdicts (also ensures the delegations schema exists).
  const dbPresent = existsSync(dbPath);
  const verdicts = ledgerReport(config.policy);
  let ledgerRecords = 0;
  let ledgerLatest: string | null = null;
  try {
    const row = getDb()
      .prepare(`SELECT COUNT(*) AS c, MAX(ts) AS latest FROM delegations`)
      .get() as { c: number; latest: string | null };
    ledgerRecords = row.c;
    ledgerLatest = row.latest;
  } catch {
    /* delegations table absent — leave zeroed */
  }

  // 2. Cartography provenance.
  const carto = scanJsonl(args.dataDir, (n) => /^cartography-.*\.jsonl$/.test(n));
  const extra = scanJsonl(args.dataDir, (n) => n === "extra-probes-results.jsonl");

  // 3. Model-Scout registry.
  const registry = readRegistry(DEFAULT_REGISTRY_PATH);
  const registryLatest = registry.reduce<string | null>(
    (acc, e) => (acc === null || e.evaluatedAt > acc ? e.evaluatedAt : acc),
    null
  );
  const servableModelIds = await loadServableModelIds();

  const sources: SourceManifestEntry[] = [
    {
      source: "capability-ledger (delegations table)",
      path: dbPath,
      present: dbPresent,
      records: ledgerRecords,
      latest: ledgerLatest,
      note: "canonical evidence — per-(task_type,model) verdicts via ledgerReport(policy)",
    },
    {
      source: "cartography runs (JSONL)",
      path: join(args.dataDir, "cartography-*.jsonl"),
      present: carto.files.length > 0,
      records: carto.records,
      latest: carto.latest,
      note: carto.files.length > 0 ? `files: ${carto.files.join(", ")}` : "none found (verdicts still come from the ledger)",
    },
    {
      source: "extra-probes battery (JSONL)",
      path: join(args.dataDir, "extra-probes-results.jsonl"),
      present: extra.files.length > 0,
      records: extra.records,
      latest: extra.latest,
    },
    {
      source: "model-scout registry (JSONL)",
      path: DEFAULT_REGISTRY_PATH,
      present: existsSync(DEFAULT_REGISTRY_PATH),
      records: registry.length,
      latest: registryLatest,
      note: "fills a model's overallPass when the ledger is too thin (consume, don't race the scout)",
    },
  ];

  // Build the document.
  const doc = generateRoutingTable({
    verdicts,
    registry,
    sources,
    generatedAt: new Date().toISOString(),
    policy: { minSamples: config.policy.minSamples },
    servableModelIds,
  });

  const evidence = summarizeEvidence({ verdicts });
  const holes = Object.entries(doc.routing).filter(([, e]) => e.model === null && e.attempts === 0).length;

  // Human summary → stderr (keeps stdout clean for --dry-run JSON piping).
  process.stderr.write(
    [
      `routing-table generator`,
      `  ledger rows:        ${evidence.ledgerRows} (${evidence.ledgerAttempts} attempts; ${evidence.routableAttempts} on routable types)`,
      `  task types covered: ${evidence.taskTypesWithEvidence}/${evidence.routableTaskTypes} routable`,
      `  pending holes:      ${holes} (null model, no evidence)`,
      `  escalate-frontier:  ${doc.escalateToFrontier.length} types`,
      `  cartography rows:   ${carto.records} across ${carto.files.length} file(s)`,
      `  registry entries:   ${registry.length}`,
      `  servable models:    ${servableModelIds ? servableModelIds.length : "unknown (unfiltered)"}`,
      ``,
    ].join("\n")
  );

  // Regression alarm (#151): semantic diff vs the currently-adopted table at --out. A downgrade
  // (capability rank drop or a type vanishing) must be an ALERTED event requiring explicit
  // acknowledgment — never a silent overwrite. Corrupt adopted table → loadAdoptedTable throws.
  const adopted = loadAdoptedTable(args.out);
  const diff = adopted !== null ? diffRoutingTables(adopted, doc) : null;
  if (diff !== null) process.stderr.write(formatRoutingDiff(diff));

  const json = JSON.stringify(doc, null, 2) + "\n";

  if (args.dryRun) {
    process.stdout.write(json);
    if (diff !== null && diff.downgrades.length > 0) {
      // Loud + non-zero so a cron/CI dry-run doubles as a regression check — but no external
      // alert and no write from a dry-run.
      process.stderr.write(
        `\n!! ROUTING REGRESSION DETECTED (dry-run) !!\n` +
          diff.downgrades.map((d) => `  - ${d.detail}\n`).join("")
      );
      process.exitCode = 1;
    }
    process.stderr.write(`[dry-run] would write ${args.out} (${json.length} bytes) — nothing written\n`);
    return;
  }

  if (diff !== null && diff.downgrades.length > 0) {
    await alertRegression(diff, doc.generatedAt, args.acceptDowngrades);
    if (!args.acceptDowngrades) {
      process.stderr.write(`NOT written: ${args.out} left untouched.\n`);
      process.exitCode = 1;
      return;
    }
  }

  // Clobber guard: never overwrite the curated table with an all-escalate one built from no ROUTABLE
  // evidence. Keying on routable coverage (not total attempts) stops a ledger of only excluded types
  // (other / deep-research roles) from slipping past — that would still wipe every canonical route.
  if (evidence.taskTypesWithEvidence === 0 && !args.force) {
    process.stderr.write(
      `REFUSING to write: no routable task type has any ledger evidence (${evidence.ledgerAttempts} total\n` +
        `attempts, ${evidence.routableAttempts} on routable types), so every route would be a pending\n` +
        `escalate-frontier hole — writing that would clobber the curated table. Run on the box against the\n` +
        `live ledger, or pass --force to write anyway (or --dry-run to inspect).\n`
    );
    process.exitCode = 1;
    return;
  }

  writeFileSync(args.out, json, "utf8");
  process.stderr.write(`Wrote ${args.out} (${json.length} bytes, generatedAt ${doc.generatedAt}).\n`);
}

// Run only when invoked directly (not when imported by a test).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 2;
  });
}
