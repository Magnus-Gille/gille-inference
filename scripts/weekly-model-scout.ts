#!/usr/bin/env tsx
/**
 * weekly-model-scout.ts — Job A: weekly trending-HuggingFace model scout (runs ON the M5 box).
 *
 * Each week: discover trending GGUF models that fit the box, download the top candidates, serve
 * each on an EPHEMERAL throwaway llama-server (scratch port — the live gateway/llama-swap is never
 * touched), benchmark it with the deterministic probe battery, score a verdict, and append the
 * result to the durable scout registry. WINNERS keep their GGUF and are promoted separately by
 * scripts/promote-model.ts; everything else is deleted.
 *
 * Memory: the box is 128 GB unified = 64 GB GPU VRAM carve-out + 61 GB system. With `-ngl 99`
 * the whole model lives in the 64 GB VRAM, so the fit budget is ~58 GB (leaves KV-cache headroom;
 * gpt-oss-120b at 60 GB already serves right under the ceiling).
 *
 * USAGE   tsx scripts/weekly-model-scout.ts [--dry-run]
 *   --dry-run   discover + rank + print candidates and download URLs; download/serve/score nothing.
 *
 * ENV (all optional)
 *   MEM_BUDGET_GB        58    largest GGUF (GiB) considered to fit the 64 GB VRAM
 *   SCOUT_MAX_CANDIDATES 2     how many fresh candidates to download+test this run
 *   SCOUT_TRENDING_LIMIT 40    how many trending models to fetch before filtering
 *   SCOUT_PORT           9099  ephemeral llama-server port (loopback only)
 *   SCOUT_CTX            8192  context for the ephemeral test server
 *   SCOUT_REPEATS        1     probe repeats per (model, probe)
 *   SCOUT_WINNER_PASSRATE 0.7  overall pass-rate bar to call a model a "winner" (auto-serve)
 *   SCOUT_INTERESTING_PASSRATE 0.5
 *   SCOUT_MIN_TOKPS      15    min avg tok/s for a winner (too slow to serve otherwise)
 *   SCOUT_SCRATCH        /srv/models/scratch
 *   MODELS_DIR           /srv/models
 *   LLAMA_SERVER_BIN     /opt/llama.cpp/build/bin/llama-server
 *   LLAMASWAP_URL        http://127.0.0.1:8091   (served-list + optional pre-test unload)
 *   SCOUT_UNLOAD_FIRST   1     POST /api/models/unload before the ephemeral launch (free VRAM)
 *   DISK_FREE_FLOOR_GB   100   refuse to download if free disk would drop below this
 *   SCOUT_REGISTRY       ./data/model-scout-registry.jsonl
 *   SCOUT_MAINTENANCE_KEY   ""    owner/admin gateway key (#105) — when set, engages bench/
 *                                 maintenance mode (guests get an honest 503, owners unaffected)
 *                                 around the candidate-evaluation loop. Best-effort: unset =
 *                                 skipped, not a hard failure. See docs/weekly-model-scout-runbook.md.
 *   SCOUT_MAINTENANCE_TTL_S 7200  auto-expiry safety net in case this process dies mid-run
 *   GATEWAY_URL          http://127.0.0.1:8080   local authed gateway (not llama-swap)
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readSync, closeSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  fetchTrending,
  listGgufFiles,
  pickQuant,
  resolveUrl,
} from "../src/homeserver/hf-trending.js";
import { makeChatFn, runProbes } from "../src/homeserver/probe-runner.js";
import {
  DEFAULT_REGISTRY_PATH,
  appendEntry,
  evaluatedIds,
  readRegistry,
  servedIds,
} from "../src/homeserver/model-registry.js";
import { PROBES, PROBE_BATTERY_VERSION, CORPUS_FINGERPRINT } from "../src/homeserver/probes.js";
import type { GgufFile, ProbeRunSummary, RegistryEntry, ScoutVerdict } from "../src/homeserver/scout-types.js";
import {
  evaluateScoutGate,
  misconfigFlags,
  reviewQualityFlags,
  servingConfigFlags,
  loadScoutGateConfig,
} from "../src/homeserver/scout-gate.js";

// ── Config ──────────────────────────────────────────────────────────────────────────
const MEM_BUDGET_GB = Number(process.env["MEM_BUDGET_GB"] ?? 58);
const MAX_CANDIDATES = Number(process.env["SCOUT_MAX_CANDIDATES"] ?? 2);
const TRENDING_LIMIT = Number(process.env["SCOUT_TRENDING_LIMIT"] ?? 40);
const PORT = Number(process.env["SCOUT_PORT"] ?? 9099);
const CTX = Number(process.env["SCOUT_CTX"] ?? 8192);
const REPEATS = Number(process.env["SCOUT_REPEATS"] ?? 1);
const WINNER_PASSRATE = Number(process.env["SCOUT_WINNER_PASSRATE"] ?? 0.7);
const INTERESTING_PASSRATE = Number(process.env["SCOUT_INTERESTING_PASSRATE"] ?? 0.5);
const MIN_TOKPS = Number(process.env["SCOUT_MIN_TOKPS"] ?? 15);
const SCRATCH = process.env["SCOUT_SCRATCH"] ?? "/srv/models/scratch";
const BIN = process.env["LLAMA_SERVER_BIN"] ?? "/opt/llama.cpp/build/bin/llama-server";
const LLAMASWAP_URL = (process.env["LLAMASWAP_URL"] ?? "http://127.0.0.1:8091").replace(/\/$/, "");
const UNLOAD_FIRST = process.env["SCOUT_UNLOAD_FIRST"] !== "0";
const DISK_FREE_FLOOR_GB = Number(process.env["DISK_FREE_FLOOR_GB"] ?? 100);
const REGISTRY = process.env["SCOUT_REGISTRY"] ?? DEFAULT_REGISTRY_PATH;
const EPHEMERAL_ENDPOINT = `http://127.0.0.1:${PORT}/v1`;
// #105: engage the live gateway's bench/maintenance mode around the ephemeral test window so
// guest traffic gets an honest 503 instead of silently degraded VRAM-contended service while a
// candidate model is loaded alongside (or in place of) the live one. Opt-in — a missing key just
// means this run isn't protected (existing off-peak + gpu-lease + port-free-check mitigations
// still apply), not a hard failure of the scout itself.
const MAINTENANCE_KEY = process.env["SCOUT_MAINTENANCE_KEY"] ?? "";
const MAINTENANCE_TTL_S = Number(process.env["SCOUT_MAINTENANCE_TTL_S"] ?? 7200);
const GATEWAY_URL = (process.env["GATEWAY_URL"] ?? "http://127.0.0.1:8080").replace(/\/$/, "");
// #176 auto-serve gate config (benchmark-gamed plausibility + name gaming-tells), env-overridable.
const SCOUT_GATE_CONFIG = loadScoutGateConfig();

const log = (m: string): void => console.log(`[scout ${new Date().toISOString()}] ${m}`);

/** Family key for de-duping finetune variants (strip quant/size/suffix noise). */
export function familyKey(id: string): string {
  return (id.split("/").pop() ?? id)
    .toLowerCase()
    .replace(/\.(gguf)$/i, "")
    .replace(/[-_.](i?q\d[\w]*|f16|bf16|mxfp4|gguf|gptq|awq|abliterated|uncensored|instruct|chat|it)\b/gi, "")
    .replace(/[-_.]\d+x\d+/g, "")
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 32);
}

/** A safe, lowercase-kebab model slug derived from an HF id (never the raw HF string in a path). */
export function slugifyId(id: string): string {
  return (
    (id.split("/").pop() ?? id)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "model"
  );
}

/**
 * Derive a STRICT local filename for one downloaded part. SECURITY: the HF `rfilename` is
 * attacker-influenced (any trending repo), so it is used ONLY for the download URL — never as a
 * local path. The local name is rebuilt from the sanitized slug + quant + the numeric shard indices
 * parsed out of the remote name, so it can never contain path separators, `..`, leading dashes,
 * spaces, or shell/argv metacharacters. llama.cpp still auto-loads shards because every part shares
 * the `<slug>-<quant>` base and keeps the `NNNNN-of-MMMMM` suffix.
 */
export function safeLocalName(slug: string, quant: string, remoteName: string): string {
  const q = (quant || "gguf").toUpperCase().replace(/[^A-Z0-9_]/g, "");
  const shard = remoteName.match(/(\d{5})-of-(\d{5})\.gguf$/i);
  if (shard) return `${slug}-${q}-${shard[1]}-of-${shard[2]}.gguf`;
  return `${slug}-${q}.gguf`;
}

function diskFreeGB(path: string): number {
  // df -k <path> → available KB in column 4 of the data row.
  const out = spawnSync("df", ["-Pk", path], { encoding: "utf8" });
  const line = (out.stdout ?? "").trim().split("\n").pop() ?? "";
  const availKb = Number(line.split(/\s+/)[3] ?? 0);
  return Math.round(availKb / (1024 * 1024));
}

function isGguf(path: string): boolean {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(4);
    readSync(fd, buf, 0, 4, 0);
    return buf.toString("ascii") === "GGUF";
  } finally {
    closeSync(fd);
  }
}

async function llamaSwapServed(): Promise<string[]> {
  try {
    const r = await fetch(`${LLAMASWAP_URL}/v1/models`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return [];
    const d = (await r.json()) as { data?: Array<{ id: string }> };
    return (d.data ?? []).map((m) => m.id);
  } catch {
    return [];
  }
}

async function unloadLlamaSwap(): Promise<void> {
  try {
    await fetch(`${LLAMASWAP_URL}/api/models/unload`, { method: "POST", signal: AbortSignal.timeout(15000) });
  } catch {
    /* best-effort — if it fails, the ephemeral launch may still fit */
  }
}

/** Wait for an ephemeral llama-server /health to report ready (200). */
async function waitHealthy(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(4000) });
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

interface Candidate {
  id: string;
  slug: string; // safe local slug
  trendingScore: number;
  downloads: number;
  likes: number;
  quant: string;
  sizeGB: number;
  parts: string[]; // REMOTE rfilenames (for the download URL only)
  localNames: string[]; // derived-safe local filenames (1:1 with parts)
  sharded: boolean;
}

function decideVerdict(s: ProbeRunSummary): ScoutVerdict {
  if (s.passRate >= WINNER_PASSRATE && (s.avgTokPerSec ?? 0) >= MIN_TOKPS) return "winner";
  if (s.passRate >= INTERESTING_PASSRATE) return "interesting";
  return "skip";
}

/**
 * #12: the exact ephemeral serving parameters used whenever probes actually ran, so a durable
 * row can be checked against what was promoted later (see scout-gate.ts servingConfigFlags). Kept
 * as a function (not stamped once at module load) so tests can construct a comparable entry
 * without depending on live CTX/REPEATS env resolution order.
 */
function currentEvalServingConfig(): { ctx: number; repeats: number; ngl: number; flashAttn: string } {
  return { ctx: CTX, repeats: REPEATS, ngl: 99, flashAttn: "on" };
}

export function toEntry(
  c: Candidate,
  verdict: ScoutVerdict,
  s: ProbeRunSummary | null,
  kept?: { ggufDir: string; ggufPath: string }
): RegistryEntry {
  const scoresByTaskType: Record<string, number> = {};
  for (const t of s?.byTaskType ?? []) scoresByTaskType[t.taskType] = Math.round(t.passRate * 1000) / 1000;
  const evalServingConfig = s ? currentEvalServingConfig() : undefined;
  // #176/#158/#12: gate a would-be winner that looks benchmark-gamed (perfect on hard task types),
  // whose name advertises a benchmark/marketing claim, that errored on too many probes
  // (misconfigured/broken serving, #158), or whose exact serving configuration wasn't recorded
  // (#12 — "incompatible serving configuration" can't be ruled out without knowing what was
  // actually tested). Flags do NOT change the verdict — they block unattended auto-serve in
  // promote-model; a human can still promote after review.
  const gate = evaluateScoutGate({ id: c.id, scoresByTaskType }, SCOUT_GATE_CONFIG);
  const gateFlags = [
    ...gate.flags,
    ...(s ? misconfigFlags(s, SCOUT_GATE_CONFIG) : []),
    ...(s?.reviewMetrics ? reviewQualityFlags(s.reviewMetrics, SCOUT_GATE_CONFIG) : []),
    ...(s ? servingConfigFlags({ evalServingConfig }) : []),
  ];
  const probeTotalRuns = s?.totalRuns ?? 0;
  const probeErrors = s?.error ?? 0;
  const probeEmptyOutputs = s?.emptyOutputs ?? 0;
  const probeTruncations = s?.truncations ?? 0;
  return {
    id: c.id,
    quant: c.quant,
    sizeGB: c.sizeGB,
    evaluatedAt: new Date().toISOString(),
    verdict,
    passRate: s ? Math.round(s.passRate * 1000) / 1000 : 0,
    avgTokPerSec: s?.avgTokPerSec ?? null,
    scoresByTaskType,
    // #12: stamp which exact corpus produced this row regardless of verdict (even a load_failed
    // row is useful evidence of "this corpus, at this time, could not evaluate this candidate").
    probeBatteryVersion: PROBE_BATTERY_VERSION,
    corpusFingerprint: CORPUS_FINGERPRINT,
    ...(s
      ? {
          evalServingConfig,
          probeErrors,
          probeTotalRuns,
          probeErrorRate: probeTotalRuns > 0 ? Math.round((probeErrors / probeTotalRuns) * 1000) / 1000 : 0,
          probeEmptyOutputs,
          probeEmptyOutputRate:
            probeTotalRuns > 0 ? Math.round((probeEmptyOutputs / probeTotalRuns) * 1000) / 1000 : 0,
          probeTruncations,
          probeTruncationRate:
            probeTotalRuns > 0 ? Math.round((probeTruncations / probeTotalRuns) * 1000) / 1000 : 0,
          probeFinishReasons: s.finishReasons,
          ...(s.reviewMetrics
            ? {
                codeReviewSeededBugs: s.reviewMetrics.seededBugs,
                codeReviewTruePositives: s.reviewMetrics.truePositives,
                codeReviewReportedFindings: s.reviewMetrics.reportedFindings,
                codeReviewCleanControls: s.reviewMetrics.cleanControls,
                codeReviewConfabulatedCleanControls: s.reviewMetrics.confabulatedCleanControls,
                codeReviewRecall: Math.round(s.reviewMetrics.recall * 1000) / 1000,
                codeReviewPrecision: Math.round(s.reviewMetrics.precision * 1000) / 1000,
                codeReviewCleanConfabulationRate:
                  Math.round(s.reviewMetrics.cleanConfabulationRate * 1000) / 1000,
              }
            : {}),
        }
      : {}),
    served: false,
    ggufDir: kept?.ggufDir,
    ggufPath: kept?.ggufPath,
    sharded: c.sharded,
    trendingScore: c.trendingScore,
    downloads: c.downloads,
    likes: c.likes,
    ...(gateFlags.length ? { gateFlags } : {}),
  };
}

// ── Discovery ───────────────────────────────────────────────────────────────────────
async function discover(): Promise<Candidate[]> {
  const reg = readRegistry(REGISTRY);
  const skip = new Set<string>([...evaluatedIds(reg), ...servedIds(reg), ...(await llamaSwapServed())]);
  const trending = await fetchTrending({ limit: TRENDING_LIMIT });
  log(`fetched ${trending.length} trending models; ${skip.size} already served/evaluated`);

  const chosen: Candidate[] = [];
  const families = new Set<string>();
  for (const t of trending) {
    if (chosen.length >= MAX_CANDIDATES) break;
    if (skip.has(t.id)) continue;
    const fam = familyKey(t.id);
    if (families.has(fam)) continue;
    let files: GgufFile[];
    try {
      files = await listGgufFiles(t.id);
    } catch (e) {
      log(`  skip ${t.id}: file list failed (${e instanceof Error ? e.message : e})`);
      continue;
    }
    const pick = pickQuant(files, MEM_BUDGET_GB);
    if (!pick) {
      log(`  skip ${t.id}: no GGUF quant fits ${MEM_BUDGET_GB} GB`);
      continue;
    }
    const slug = slugifyId(t.id);
    const parts = pick.parts;
    const localNames = parts.map((p) => safeLocalName(slug, pick.file.quant, p));
    families.add(fam);
    chosen.push({
      id: t.id,
      slug,
      trendingScore: t.trendingScore,
      downloads: t.downloads,
      likes: t.likes,
      quant: pick.file.quant,
      sizeGB: pick.sizeGB,
      parts,
      localNames,
      sharded: parts.length > 1,
    });
    log(`  candidate: ${t.id} [${pick.file.quant}, ${pick.sizeGB} GB, ${parts.length} part(s), trend ${t.trendingScore}]`);
  }
  return chosen;
}

/** Is something already listening on the ephemeral port? (a stale server would poison the test). */
async function portInUse(): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(2000) });
    return true; // got a response → occupied
  } catch {
    return false; // refused/timeout → free
  }
}

// ── Evaluate one candidate (download → ephemeral serve → probe → verdict) ────────────
async function evaluate(c: Candidate): Promise<RegistryEntry> {
  if (diskFreeGB(SCRATCH) < DISK_FREE_FLOOR_GB) {
    log(`  disk below floor (${DISK_FREE_FLOOR_GB} GB) — skipping ${c.id}`);
    return toEntry(c, "skip", null);
  }
  // Each model gets its OWN dir; local names are derived-safe (never the raw HF rfilename).
  const ggufDir = join(SCRATCH, c.slug);
  mkdirSync(ggufDir, { recursive: true });

  for (let i = 0; i < c.parts.length; i++) {
    const url = resolveUrl(c.id, c.parts[i]!); // remote name only in the URL (encoded)
    const local = c.localNames[i]!; // derived-safe local filename
    log(`  download ${local} …`);
    const dl = spawnSync("aria2c", ["-x8", "-s8", "--console-log-level=warn", "--allow-overwrite=true", "-d", ggufDir, "-o", local, url], {
      stdio: "inherit",
    });
    if (dl.status !== 0) {
      log(`  download failed for ${local} (aria2c exit ${dl.status})`);
      cleanup(ggufDir);
      return toEntry(c, "load_failed", null);
    }
  }
  const part1 = join(ggufDir, c.localNames[0]!);
  if (!existsSync(part1) || !isGguf(part1)) {
    log(`  ${part1} is missing or not a GGUF — load_failed`);
    cleanup(ggufDir);
    return toEntry(c, "load_failed", null);
  }

  // Fail fast if the port is occupied — otherwise a stale server would be benchmarked as this model.
  if (await portInUse()) {
    log(`  port ${PORT} already in use — aborting this candidate (stale ephemeral server?)`);
    cleanup(ggufDir);
    return toEntry(c, "load_failed", null);
  }

  // Ephemeral serve. NOTE: with SCOUT_UNLOAD_FIRST=1 this evicts llama-swap's resident model to
  // free VRAM; live serving cold-starts again on the next request. Runs off-peak under the GPU lease.
  if (UNLOAD_FIRST) await unloadLlamaSwap();
  log(`  launching ephemeral llama-server on :${PORT} …`);
  const child = spawn(
    BIN,
    ["--host", "127.0.0.1", "--port", String(PORT), "-m", part1, "-ngl", "99", "-ub", "512", "-c", String(CTX), "--jinja", "-fa", "on"],
    { stdio: "ignore" }
  );
  let entry: RegistryEntry;
  try {
    const healthy = await waitHealthy(300_000);
    if (!healthy) {
      log(`  ephemeral server never became healthy (OOM/crash?) — load_failed`);
      entry = toEntry(c, "load_failed", null);
    } else {
      log(`  healthy — running ${PROBES.length} probes × ${REPEATS} …`);
      const chat = makeChatFn({ endpoint: EPHEMERAL_ENDPOINT, apiKey: "" });
      const summary = await runProbes({ model: c.id, endpoint: EPHEMERAL_ENDPOINT, probes: PROBES, repeats: REPEATS, chat });
      const verdict = decideVerdict(summary);
      // Winner keeps its whole dir (in scratch) so promote-model can serve it; else delete.
      entry = toEntry(c, verdict, summary, verdict === "winner" ? { ggufDir, ggufPath: part1 } : undefined);
      const gated = entry.gateFlags?.length ? `  ⚠️ GATED (not auto-servable): ${entry.gateFlags.join("; ")}` : "";
      log(`  verdict: ${verdict} (pass ${(summary.passRate * 100).toFixed(0)}%, ${summary.avgTokPerSec ?? "—"} tok/s)${gated}`);
    }
  } finally {
    child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 3000));
    if (!child.killed) child.kill("SIGKILL");
  }
  if (entry.verdict !== "winner") cleanup(ggufDir);
  return entry;
}

/** Hard fallback used when a configured/passed ttlSeconds is missing or not a finite positive number. */
const MAINTENANCE_TTL_FALLBACK_S = 7200;

/**
 * Toggle the live gateway's bench/maintenance mode (#105). Best-effort by design: a missing key,
 * an unreachable gateway, or a non-2xx response are all logged and swallowed, never thrown — this
 * is a protective layer around the scout's real job, not a precondition for running it. `on:true`
 * carries an auto-expiring `ttlSeconds` (see admission.ts) so a scout process that dies mid-run
 * can never leave guests locked out forever; `on:false` never sends one (irrelevant/ignored).
 *
 * Returns whether the request is CONFIRMED to have taken effect (true), as opposed to skipped by
 * design (no key configured) or failed (network error / non-2xx) — both of the latter are false,
 * so a caller can tell "not protected because we opted out" apart from "not protected because it
 * silently broke" and react accordingly (main() logs loudly only for the second case).
 */
export async function setMaintenance(
  on: boolean,
  opts?: { apiKey?: string; ttlSeconds?: number; gatewayUrl?: string; fetchFn?: typeof fetch }
): Promise<boolean> {
  const apiKey = opts?.apiKey ?? MAINTENANCE_KEY;
  if (!apiKey) {
    log(`  maintenance mode: no SCOUT_MAINTENANCE_KEY configured — skipping (#105 protection inactive this run)`);
    return false;
  }
  const gatewayUrl = opts?.gatewayUrl ?? GATEWAY_URL;
  const fetchFn = opts?.fetchFn ?? fetch;
  // A garbage/empty/negative ttlSeconds (e.g. from a misconfigured SCOUT_MAINTENANCE_TTL_S env
  // var) would otherwise be sent as-is and get the ON request rejected by the gateway's own
  // validation — silently defeating protection for the WHOLE run. Fall back instead of failing.
  const requestedTtl = opts?.ttlSeconds ?? MAINTENANCE_TTL_S;
  const ttlSeconds = Number.isFinite(requestedTtl) && requestedTtl > 0 ? requestedTtl : MAINTENANCE_TTL_FALLBACK_S;
  if (on && ttlSeconds !== requestedTtl) {
    log(`  maintenance mode: configured ttlSeconds (${requestedTtl}) is invalid — using ${ttlSeconds}s instead`);
  }
  const body: { on: boolean; ttlSeconds?: number } = on ? { on: true, ttlSeconds } : { on: false };
  try {
    const res = await fetchFn(`${gatewayUrl}/admin/maintenance`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      log(`  maintenance mode ${on ? "ON" : "OFF"} request failed: HTTP ${res.status}`);
      return false;
    }
    log(`  maintenance mode ${on ? "ON" : "OFF"}${on ? ` (${ttlSeconds}s auto-expiry safety net)` : ""}`);
    return true;
  } catch (e) {
    log(`  maintenance mode ${on ? "ON" : "OFF"} request errored, continuing anyway: ${e instanceof Error ? e.message : e}`);
    return false;
  }
}

function cleanup(ggufDir: string): void {
  try {
    if (existsSync(ggufDir)) {
      rmSync(ggufDir, { recursive: true, force: true });
      log(`  deleted ${ggufDir}`);
    }
  } catch (e) {
    log(`  cleanup warn: ${e instanceof Error ? e.message : e}`);
  }
}

// ── Main ────────────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  mkdirSync(SCRATCH, { recursive: true });
  log(`weekly model scout — budget ${MEM_BUDGET_GB} GB, max ${MAX_CANDIDATES} candidate(s), registry ${REGISTRY}`);

  const candidates = await discover();
  if (candidates.length === 0) {
    log("no fresh fitting candidates this week — done.");
    return;
  }

  if (dryRun) {
    for (const c of candidates) {
      console.log(`DRY-RUN candidate ${c.id} [${c.quant}, ${c.sizeGB} GB]`);
      for (const p of c.parts) console.log(`   ↳ ${resolveUrl(c.id, p)}`);
    }
    return;
  }

  let winners = 0;
  const maintenanceEngaged = await setMaintenance(true); // #105: guests get an honest 503 instead of VRAM-contended service
  if (!maintenanceEngaged && MAINTENANCE_KEY) {
    // A key WAS configured (protection was requested) but the request failed — this is different
    // from the documented opt-out (no key) and must not pass silently as a single log line among
    // many others, since it means this run proceeds WITHOUT the protection it was set up to have.
    log(`  ⚠️  WARNING: maintenance-mode protection did NOT engage despite SCOUT_MAINTENANCE_KEY being set — proceeding WITHOUT guest protection this run (falling back to off-peak + lease + port-free-check only)`);
  }
  try {
    for (const c of candidates) {
      log(`── evaluating ${c.id} ──`);
      let entry: RegistryEntry;
      try {
        entry = await evaluate(c);
      } catch (e) {
        log(`  evaluate threw: ${e instanceof Error ? e.message : e} — recording load_failed`);
        entry = toEntry(c, "load_failed", null);
        cleanup(join(SCRATCH, c.slug));
      }
      appendEntry(entry, REGISTRY);
      if (entry.verdict === "winner") winners++;
    }
  } finally {
    await setMaintenance(false);
  }
  log(`done. ${candidates.length} evaluated, ${winners} winner(s). Run promote-model.ts to auto-serve winners.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
  });
}

export { decideVerdict };
