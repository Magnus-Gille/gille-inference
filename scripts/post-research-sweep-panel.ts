#!/usr/bin/env tsx
/**
 * post-research-sweep-panel.ts — publish the weekly research sweep proposals to Heimdall (Job B).
 *
 * Reads the synthesized proposals (data/research-sweep/proposals.json, written by
 * weekly-research-sweep.ts) and pushes a `research-proposals` table panel to Heimdall on service
 * `m5-inference` (renders on /services/m5-inference). The full reports are surfaced separately on
 * Heimdall's /read page via the mimir inbox sync. BEST-EFFORT (shares heimdall-push).
 *
 * #200: a missing proposals.json (the sweep aborted before writing output — e.g. the search/reader
 * prerequisite failed) or a file with zero proposals is NOT treated as "nothing to push" anymore —
 * it pushes a status=fail panel in place of the table, so a failed pipeline says so on the
 * dashboard instead of only leaving a line in an on-box log nobody is watching.
 *
 * USAGE   tsx scripts/post-research-sweep-panel.ts [--in <proposals.json>] [--dry-run]
 * ENV     HEIMDALL_PANELS_URL, HEIMDALL_FLEET_TOKEN, RESEARCH_SWEEP_PROPOSALS
 */
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { pushPanel, type PanelPayload, type StatusPanel, type TablePanel } from "../src/homeserver/heimdall-push.js";
import { isResearchProposal, type ResearchProposal } from "../src/homeserver/research-proposals.js";

const SERVICE = "m5-inference";
const PANEL = "research-proposals";
const DEFAULT_IN = "./data/research-sweep/proposals.json";

interface ProposalsFile {
  generatedAt: string;
  proposals: ResearchProposal[];
}

/** Outcome of reading the proposals file — every failure mode is a value, never a throw (#200). */
export type ReadProposalsResult = { ok: true; file: ProposalsFile } | { ok: false; reason: string };

/** Build the Heimdall table panel from proposals (pure → testable). */
export function buildProposalsPanel(proposals: ResearchProposal[], generatedAt?: string): TablePanel {
  const rows = proposals.slice(0, 50).map((p) => ({
    proposal: p.title,
    gain: p.expectedGain,
    effort: p.effort,
    idea: p.idea.slice(0, 300),
    source: p.sources[0] ?? "",
  }));
  const label = generatedAt
    ? `Stuff we should try — weekly research sweep (${generatedAt.slice(0, 10)})`
    : "Stuff we should try — weekly research sweep";
  return {
    service: SERVICE,
    panel: PANEL,
    kind: "table",
    label,
    cols: ["proposal", "gain", "effort", "idea", "source"],
    rows,
  };
}

/**
 * Build the status=fail panel shown IN PLACE of the table when the sweep produced nothing (#200):
 * a missing proposals.json (the prerequisite step never wrote output) or a file with zero proposals
 * (synthesis ran but produced nothing) must be visible on the dashboard, not just a swallowed exit code.
 */
export function buildFailPanel(reason: string): StatusPanel {
  return {
    service: SERVICE,
    panel: PANEL,
    kind: "status",
    label: "Stuff we should try — weekly research sweep",
    state: "fail",
    message: reason,
  };
}

/** Read + validate the proposals file. Never throws — every failure becomes a ReadProposalsResult. */
export function readProposals(path: string): ReadProposalsResult {
  if (!existsSync(path)) {
    return {
      ok: false,
      reason: `no proposals file at ${path} — the sweep produced no output (check the search/reader prerequisite).`,
    };
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    return { ok: false, reason: `could not read ${path}: ${err instanceof Error ? err.message : String(err)}` };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: `could not parse ${path} as JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  // JSON.parse("null") succeeds with a null value — accessing .proposals on it would throw and
  // defeat the "never throws" contract (#230 review), so a non-object top-level value is its own
  // explicit failure branch rather than falling through to the property-access line below.
  if (json === null || typeof json !== "object") {
    return { ok: false, reason: `${path} did not parse to a JSON object (got ${json === null ? "null" : typeof json}).` };
  }
  const parsed = json as Partial<ProposalsFile>;
  const proposals = (Array.isArray(parsed.proposals) ? parsed.proposals.filter(isResearchProposal) : []) as ResearchProposal[];
  const generatedAt = typeof parsed.generatedAt === "string" ? parsed.generatedAt : "";
  if (proposals.length === 0) {
    return { ok: false, reason: `${path} parsed but contained zero proposals — the sweep ran but synthesized nothing.` };
  }
  return { ok: true, file: { generatedAt, proposals } };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const inIdx = args.indexOf("--in");
  const path = (inIdx >= 0 ? args[inIdx + 1] : undefined) ?? process.env["RESEARCH_SWEEP_PROPOSALS"] ?? DEFAULT_IN;

  const result = readProposals(path);
  if (!result.ok) console.error(`[research-panel] ${result.reason}`);
  const panel: PanelPayload = result.ok ? buildProposalsPanel(result.file.proposals, result.file.generatedAt) : buildFailPanel(result.reason);

  if (dryRun) {
    console.log(JSON.stringify(panel, null, 2));
    return;
  }
  const r = await pushPanel(panel);
  if (!r.ok) {
    console.error(`[research-panel] push failed: ${r.error ?? `HTTP ${r.status}: ${r.body}`}`);
    process.exit(1);
  }
  console.log(
    result.ok
      ? `[research-panel] pushed ${result.file.proposals.length} proposal(s) (HTTP ${r.status})`
      : `[research-panel] pushed fail-status panel (HTTP ${r.status})`
  );
  if (!result.ok) process.exitCode = 1; // panel landed on the dashboard, but still signal failure to the caller
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
  });
}
