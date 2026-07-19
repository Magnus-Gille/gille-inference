#!/usr/bin/env tsx
/**
 * post-model-scout-panels.ts — publish the weekly Model Scout results to Heimdall.
 *
 * Reads the durable scout registry (data/model-scout-registry.jsonl) and pushes two typed
 * panels to Heimdall on service `m5-inference` (renders on /services/m5-inference, no Heimdall
 * code change):
 *   • table      `model-evals`        — latest evaluation per model (quant, size, scores, verdict)
 *   • timeseries `models-evaluated`   — distinct models evaluated per day
 *
 * BEST-EFFORT (shares heimdall-push): a stalled/offline Heimdall never breaks the scout that
 * already ran. The same registry feeds the portal's "New model evaluations" section.
 *
 * USAGE   tsx scripts/post-model-scout-panels.ts [--dry-run]
 * ENV     HEIMDALL_PANELS_URL, HEIMDALL_FLEET_TOKEN, SCOUT_REGISTRY
 */
import { pathToFileURL } from "node:url";

import { DEFAULT_REGISTRY_PATH, latestByModel, readRegistry } from "../src/homeserver/model-registry.js";
import { pushPanel, type TablePanel, type TimeseriesPanel } from "../src/homeserver/heimdall-push.js";
import type { RegistryEntry } from "../src/homeserver/scout-types.js";

const SERVICE = "m5-inference";
const MAX_POINTS = 500;
const DEFAULT_TABLE_LIMIT = 20;

const pct = (x: number): number => Math.round(x * 1000) / 10; // 0.873 → 87.3

/** Latest-per-model rows, newest first → a Heimdall table panel (pure → testable). */
export function buildEvalsTablePanel(entries: RegistryEntry[], limit = DEFAULT_TABLE_LIMIT): TablePanel {
  const rows = [...latestByModel(entries).values()]
    .sort((a, b) => b.evaluatedAt.localeCompare(a.evaluatedAt))
    .slice(0, limit)
    .map((e) => ({
      model: e.id,
      quant: e.quant || "—",
      sizeGB: e.sizeGB,
      "pass%": pct(e.passRate),
      "review recall%": e.codeReviewRecall === undefined ? "—" : pct(e.codeReviewRecall),
      "review precision%": e.codeReviewPrecision === undefined ? "—" : pct(e.codeReviewPrecision),
      "clean confab%": e.codeReviewCleanConfabulationRate === undefined ? "—" : pct(e.codeReviewCleanConfabulationRate),
      "error%": e.probeErrorRate === undefined ? "—" : pct(e.probeErrorRate),
      "empty%": e.probeEmptyOutputRate === undefined ? "—" : pct(e.probeEmptyOutputRate),
      "trunc%": e.probeTruncationRate === undefined ? "—" : pct(e.probeTruncationRate),
      "finish reasons": e.probeFinishReasons
        ? Object.entries(e.probeFinishReasons)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([reason, count]) => `${reason}:${count}`)
            .join(", ") || "—"
        : "—",
      "tok/s": e.avgTokPerSec ?? "—",
      verdict: e.verdict,
      served: e.served ? "✓" : "",
      evaluated: e.evaluatedAt.slice(0, 10),
    }));
  return {
    service: SERVICE,
    panel: "model-evals",
    kind: "table",
    label: "New model evaluations — trending HF models tested on the M5",
    cols: [
      "model",
      "quant",
      "sizeGB",
      "pass%",
      "review recall%",
      "review precision%",
      "clean confab%",
      "error%",
      "empty%",
      "trunc%",
      "finish reasons",
      "tok/s",
      "verdict",
      "served",
      "evaluated",
    ],
    rows,
  };
}

/** Distinct models evaluated per day → a timeseries panel (pure → testable). */
export function buildEvaluatedTimeseries(entries: RegistryEntry[]): TimeseriesPanel {
  const byDate = new Map<string, Set<string>>();
  for (const e of entries) {
    const d = e.evaluatedAt.slice(0, 10);
    if (!byDate.has(d)) byDate.set(d, new Set());
    byDate.get(d)!.add(e.id);
  }
  const points = [...byDate.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([t, ids]) => ({ t, y: ids.size }))
    .slice(-MAX_POINTS);
  const panel: TimeseriesPanel = {
    service: SERVICE,
    panel: "models-evaluated",
    kind: "timeseries",
    label: "Models evaluated by the weekly scout (distinct models/day)",
    unit: "count",
    points,
  };
  const last = points[points.length - 1];
  if (last) panel.summary = { latest: last.y, window: "day", n: entries.length };
  return panel;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const registry = process.env["SCOUT_REGISTRY"] ?? DEFAULT_REGISTRY_PATH;
  const entries = readRegistry(registry);

  if (entries.length === 0) {
    console.error(`[scout-panels] no registry entries in ${registry} — nothing to push.`);
    process.exit(dryRun ? 0 : 1);
  }

  const table = buildEvalsTablePanel(entries);
  const series = buildEvaluatedTimeseries(entries);

  if (dryRun) {
    console.log(JSON.stringify({ table, series }, null, 2));
    return;
  }

  let failures = 0;
  for (const panel of [table, series] as const) {
    const r = await pushPanel(panel);
    if (r.ok) console.log(`[scout-panels] pushed '${panel.panel}' (HTTP ${r.status})`);
    else {
      failures++;
      console.error(`[scout-panels] push '${panel.panel}' failed: ${r.error ?? `HTTP ${r.status}: ${r.body}`}`);
    }
  }
  if (failures) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
  });
}
