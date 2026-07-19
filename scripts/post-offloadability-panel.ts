/**
 * post-offloadability-panel.ts — push the nightly offloadability trend to Heimdall.
 *
 * Reads the structured trend spine (data/gate-chat-replay-trend.jsonl, written by
 * gate-chat-replay --trend-jsonl) and POSTs a single Heimdall typed-panel envelope to
 * `POST <HEIMDALL_PANELS_URL>/api/panels` (kind=timeseries + a by-model detail table).
 * Heimdall renders it on /services/m5-inference with NO Heimdall code change.
 *
 * The producer is the M5 box; the nightly wrapper calls this AFTER the GPU-leased replay
 * (this step is a plain HTTP call — no GPU). It is BEST-EFFORT: any failure exits non-zero
 * but must never break the replay that already ran.
 *
 * Env:
 *   HEIMDALL_PANELS_URL   full URL of the ingest endpoint (e.g. http://<pi>:3033/api/panels)
 *   HEIMDALL_FLEET_TOKEN  bearer token (same token the fleet push-agents use)
 * Flags:
 *   --trend-jsonl <path>  trend spine to read (default data/gate-chat-replay-trend.jsonl)
 *   --dry-run             build + print the payload, do NOT POST
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { DEFAULT_MIN_RELIABLE_N, type TrendRecord } from "./gate-chat-replay.js";
import { verifyPanelLanded, verifyProblem } from "../src/homeserver/heimdall-push.js";

const SERVICE = "m5-inference";
const PANEL = "offloadability";
const MAX_POINTS = 500;
// Read-back freshness window: the panel we just pushed must have updated within this window.
const READBACK_MAX_AGE_MS = 5 * 60 * 1000;

export interface PanelPayload {
  service: string;
  panel: string;
  kind: "timeseries";
  label: string;
  unit: string;
  points: { t: string; y: number }[];
  summary?: { latest: number; window: string; n: number; lowSample: boolean };
  detail?: { kind: "table"; rows: { model: string; disagree: string }[] };
}

/** Build the Heimdall typed-panel envelope from accumulated trend records (pure → testable). */
export function buildPanelPayload(records: TrendRecord[]): PanelPayload {
  // Only windowed records make a consistent series (drop any stray all-time runs).
  const windowed = records.filter((r) => r.window !== "all-time");
  // Dedup by date, keeping the last occurrence (a manual re-run shouldn't double a day).
  const byDate = new Map<string, TrendRecord>();
  for (const r of windowed) byDate.set(r.date, r);
  const ordered = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  const points = ordered.map((r) => ({ t: r.date, y: r.fireRatePct })).slice(-MAX_POINTS);
  const last = ordered[ordered.length - 1];

  const payload: PanelPayload = {
    service: SERVICE,
    panel: PANEL,
    kind: "timeseries",
    label: "Offloadability — nightly gate fire-rate (lower = more offloadable)",
    unit: "percent",
    points,
  };
  if (last) {
    // Backward compat: records written before `lowSample` existed (the real box's trend jsonl
    // predates this field) don't carry it — derive it from the already-present `n` using the same
    // threshold, so historical low-n rows are correctly flagged rather than silently reading as fine.
    const lowSample = typeof last.lowSample === "boolean" ? last.lowSample : last.n < DEFAULT_MIN_RELIABLE_N;
    payload.summary = { latest: last.fireRatePct, window: last.window, n: last.n, lowSample };
    if (last.byModel.length) payload.detail = { kind: "table", rows: last.byModel };
  }
  return payload;
}

/** Minimal structural guard — a valid-JSON-but-wrong line ({}, null) must not break the push. */
export function isTrendRecord(x: unknown): x is TrendRecord {
  if (!x || typeof x !== "object") return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r["date"] === "string" &&
    typeof r["window"] === "string" &&
    typeof r["n"] === "number" &&
    typeof r["fireRatePct"] === "number" &&
    Array.isArray(r["byModel"])
  );
}

function readRecords(path: string): TrendRecord[] {
  const out: TrendRecord[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const s = line.trim();
    if (!s) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(s);
    } catch {
      continue; // skip a malformed line rather than abort the whole push
    }
    // Skip valid-JSON-but-wrong-shape lines silently (never log record contents).
    if (isTrendRecord(parsed)) out.push(parsed);
  }
  return out;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const dryRun = args.includes("--dry-run");
  const trendPath = flag("--trend-jsonl") ?? "data/gate-chat-replay-trend.jsonl";

  const records = readRecords(trendPath);
  const payload = buildPanelPayload(records);
  if (payload.points.length === 0) {
    console.error(`[post-panel] no windowed records in ${trendPath} — nothing to push.`);
    process.exit(dryRun ? 0 : 1);
  }

  if (dryRun) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  const url = process.env["HEIMDALL_PANELS_URL"];
  const token = process.env["HEIMDALL_FLEET_TOKEN"];
  if (!url || !token) {
    console.error("[post-panel] HEIMDALL_PANELS_URL and HEIMDALL_FLEET_TOKEN must both be set.");
    process.exit(1);
  }

  // Bounded — a stalled Heimdall must not hang the nightly process indefinitely.
  const timeoutMs = Number(process.env["HEIMDALL_POST_TIMEOUT_MS"] ?? 10_000);
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // Never include the token or body — just the failure class (timeout / network).
    const msg = err instanceof Error && err.name === "TimeoutError" ? `timed out after ${timeoutMs}ms` : err instanceof Error ? err.message : String(err);
    console.error(`[post-panel] POST failed: ${msg}`);
    process.exit(1);
  }
  const body = await resp.text();
  if (!resp.ok) {
    console.error(`[post-panel] HTTP ${resp.status}: ${body.slice(0, 200)}`);
    process.exit(1);
  }
  console.log(`[post-panel] pushed ${payload.points.length} point(s), latest ${payload.summary?.latest}% → ${body.slice(0, 160)}`);

  // A 200 only means "accepted" — read it back to prove it's actually stored/visible
  // (heimdall#102: pushes landed in an invisible drawer while every push returned 200).
  const v = await verifyPanelLanded(SERVICE, PANEL, { maxAgeMs: READBACK_MAX_AGE_MS });
  if (v.ok) {
    console.log(`[post-panel] verified '${PANEL}' landed (read-back ok)`);
  } else {
    console.error(`[post-panel] READ-BACK FAILED for '${PANEL}': ${verifyProblem(v)} — panel may not be visible in Heimdall`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : err);
    process.exit(1);
  });
}
