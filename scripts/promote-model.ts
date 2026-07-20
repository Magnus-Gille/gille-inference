#!/usr/bin/env tsx
/**
 * promote-model.ts — auto-serve a scout "winner" by editing the live llama-swap config.
 *
 * Runs on the inference node (where `/etc/llama-swap/config.yaml` and `/srv/models` exist).
 * The weekly wrapper calls this AFTER weekly-model-scout.ts. It finds the most-recent
 * registry winner that is not yet served and, transactionally:
 *   1. backs up config.yaml (timestamped)
 *   2. moves the GGUF from scratch into the models dir (if needed)
 *   3. appends a llama-swap model entry (templated to match existing entries)
 *   4. `sudo systemctl restart llama-swap`
 *   5. health-checks the new id via /v1/models + a 1-token warm-up
 * On ANY failure it restores the backup, restarts, and records served:false. It NEVER leaves
 * llama-swap down and NEVER auto-promotes more than one model per run.
 *
 * NOTE on caps: llama-swap loads ONE model at a time (ttl-swap), so resident RAM is bounded by
 * the single largest model, not the sum. The real auto-serve guards are therefore (a) the
 * candidate already fit the memory budget at selection time, (b) a total-served-count ceiling,
 * and (c) ≤1 promotion per run.
 *
 * USAGE   tsx scripts/promote-model.ts [--dry-run]
 * ENV
 *   LLAMASWAP_CONFIG     default /etc/llama-swap/config.yaml
 *   MODELS_DIR           default /srv/models
 *   LLAMA_SERVER_BIN     default /opt/llama.cpp/build/bin/llama-server
 *   LLAMASWAP_URL        default http://127.0.0.1:8091   (admin + /v1)
 *   PROMOTE_CTX          default 32768
 *   PROMOTE_FA           default on   (-fa on|off)
 *   PROMOTE_MAX_SERVED   default 12   (refuse to grow the served set beyond this)
 *   PROMOTE_RESTART_CMD  default "sudo systemctl restart llama-swap"
 *   SCOUT_REGISTRY       default ./data/model-scout-registry.jsonl
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  DEFAULT_REGISTRY_PATH,
  appendEntry,
  latestByModel,
  readRegistry,
} from "../src/homeserver/model-registry.js";
import { assertModelKey } from "../src/homeserver/lmstudio-admin.js";
import type { RegistryEntry } from "../src/homeserver/scout-types.js";
import {
  sanitizeModelName,
  evaluateScoutGate,
  misconfigFlags,
  reviewQualityFlags,
  servingConfigFlags,
  loadScoutGateConfig,
  DEFAULT_SCOUT_GATE_CONFIG,
  type ScoutGateConfig,
} from "../src/homeserver/scout-gate.js";

const CONFIG = process.env["LLAMASWAP_CONFIG"] ?? "/etc/llama-swap/config.yaml";
const MODELS_DIR = process.env["MODELS_DIR"] ?? "/srv/models";
const BIN = process.env["LLAMA_SERVER_BIN"] ?? "/opt/llama.cpp/build/bin/llama-server";
const LLAMASWAP_URL = (process.env["LLAMASWAP_URL"] ?? "http://127.0.0.1:8091").replace(/\/$/, "");
const CTX = Number(process.env["PROMOTE_CTX"] ?? 32768);
const FA = process.env["PROMOTE_FA"] === "off" ? "off" : "on";
const MAX_SERVED = Number(process.env["PROMOTE_MAX_SERVED"] ?? 12);
const RESTART_CMD = process.env["PROMOTE_RESTART_CMD"] ?? "sudo systemctl restart llama-swap";
const REGISTRY = process.env["SCOUT_REGISTRY"] ?? DEFAULT_REGISTRY_PATH;

/**
 * Derive a safe, unique llama-swap key from an HF id, e.g. "org/Foo-Bar-9B" → "foo-bar-9b".
 * Gaming/marketing tell tokens (τ²/tau2, "3.5x", composer, fable, named benchmarks) are stripped
 * FIRST (#176 sanitizeModelName), so the served id + portal never advertise a benchmark even if a
 * human manually promotes a flagged candidate.
 */
export function deriveModelKey(id: string, taken: Set<string>): string {
  const base =
    sanitizeModelName(id.split("/").pop()!)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "model";
  let key = base;
  let n = 2;
  while (taken.has(key)) key = `${base}-${n++}`;
  return key;
}

/**
 * Split un-served winners into auto-servable (no gate flags) vs gated (held for manual review). #176:
 * a benchmark-gamed / gaming-named / misconfigured winner carries gateFlags and must never auto-serve.
 */
export function partitionServableWinners<
  T extends {
    id: string;
    scoresByTaskType: Record<string, number>;
    gateFlags?: string[];
    probeErrors?: number;
    probeTotalRuns?: number;
    probeEmptyOutputs?: number;
    probeTruncations?: number;
    codeReviewSeededBugs?: number;
    codeReviewTruePositives?: number;
    codeReviewReportedFindings?: number;
    codeReviewCleanControls?: number;
    codeReviewConfabulatedCleanControls?: number;
    codeReviewRecall?: number;
    codeReviewPrecision?: number;
    codeReviewCleanConfabulationRate?: number;
    evalServingConfig?: { ctx: number; repeats: number; ngl?: number; flashAttn?: string };
  },
>(
  winners: T[],
  cfg: ScoutGateConfig = DEFAULT_SCOUT_GATE_CONFIG
): { servable: T[]; gated: Array<{ entry: T; flags: string[] }> } {
  const servable: T[] = [];
  const gated: Array<{ entry: T; flags: string[] }> = [];
  for (const e of winners) {
    // Recompute the gate FRESH (do not trust a persisted gateFlags alone): a legacy row, a
    // hand-written row, or any writer that didn't precompute gateFlags would otherwise pass straight
    // through as auto-servable even if it's incident-shaped. #158 persists probeErrors/probeTotalRuns
    // so the misconfig gate can be recomputed too, rather than trusting only stored gateFlags.
    // Merge persisted ∪ evaluated, and tolerate a malformed persisted value (non-array) rather than
    // throwing on `.join`.
    const persisted = Array.isArray(e.gateFlags) ? e.gateFlags.filter((f) => typeof f === "string") : [];
    const recomputedMisconfig =
      typeof e.probeErrors === "number" && typeof e.probeTotalRuns === "number"
        ? misconfigFlags(
            {
              error: e.probeErrors,
              totalRuns: e.probeTotalRuns,
              emptyOutputs: e.probeEmptyOutputs,
              truncations: e.probeTruncations,
            },
            cfg
          )
        : [];
    const reviewFromCounts =
      typeof e.codeReviewSeededBugs === "number" &&
      typeof e.codeReviewTruePositives === "number" &&
      typeof e.codeReviewReportedFindings === "number" &&
      typeof e.codeReviewCleanControls === "number" &&
      typeof e.codeReviewConfabulatedCleanControls === "number" &&
      e.codeReviewSeededBugs > 0 &&
      e.codeReviewCleanControls > 0
        ? {
            recall: e.codeReviewTruePositives / e.codeReviewSeededBugs,
            precision:
              e.codeReviewReportedFindings > 0
                ? e.codeReviewTruePositives / e.codeReviewReportedFindings
                : 0,
            cleanConfabulationRate:
              e.codeReviewConfabulatedCleanControls / e.codeReviewCleanControls,
          }
        : null;
    const reviewFromRates =
      typeof e.codeReviewRecall === "number" &&
      typeof e.codeReviewPrecision === "number" &&
      typeof e.codeReviewCleanConfabulationRate === "number"
        ? {
            recall: e.codeReviewRecall,
            precision: e.codeReviewPrecision,
            cleanConfabulationRate: e.codeReviewCleanConfabulationRate,
          }
        : null;
    const candidateReview = reviewFromCounts ?? reviewFromRates;
    // #12 (M5-assisted review): a malformed or hand-written row could carry NaN/Infinity/out-of-
    // range recall/precision/confabulation values (readRegistry's isRegistryEntry guard rejects
    // these for rows read from the durable JSONL, but partitionServableWinners is also called
    // directly — e.g. in tests, or by a future caller — so validate here too rather than trusting
    // the shape alone). Treat invalid values as untrustworthy evidence, distinct from genuinely
    // absent evidence, so an operator can tell "no review ran" apart from "review ran but produced
    // garbage numbers".
    const isValidRatio = (n: number): boolean => Number.isFinite(n) && n >= 0 && n <= 1;
    const recomputedReview =
      candidateReview &&
      isValidRatio(candidateReview.recall) &&
      isValidRatio(candidateReview.precision) &&
      isValidRatio(candidateReview.cleanConfabulationRate)
        ? candidateReview
        : null;
    const recomputedReviewFlags = recomputedReview
      ? reviewQualityFlags(recomputedReview, cfg)
      : candidateReview
        ? [
            "invalid-review-ground-truth: recall/precision/clean-confabulation values are non-finite or out of [0,1] — not auto-served",
          ]
        : ["missing-review-ground-truth: no #158 seeded-review evidence — not auto-served"];
    // #12: recompute the serving-config gate too — a row missing its exact eval serving
    // parameters (ctx/repeats) cannot be vouched for as tested-under-a-known-configuration, same
    // fail-closed treatment as the missing-review-ground-truth fallback above.
    const recomputedServingConfigFlags = servingConfigFlags({ evalServingConfig: e.evalServingConfig });
    const flags = [
      ...new Set([
        ...persisted,
        ...evaluateScoutGate(e, cfg).flags,
        ...recomputedMisconfig,
        ...recomputedReviewFlags,
        ...recomputedServingConfigFlags,
      ]),
    ];
    if (flags.length) gated.push({ entry: e, flags });
    else servable.push(e);
  }
  return { servable, gated };
}

/** The set of model keys already present in a config.yaml (pure, regex on the `  "key":` lines). */
export function existingKeys(configText: string): Set<string> {
  const keys = new Set<string>();
  for (const m of configText.matchAll(/^\s{2}"([^"]+)":\s*$/gm)) keys.add(m[1]!);
  return keys;
}

/**
 * Safe to append a model entry at EOF? Only when `models:` is the LAST top-level key — otherwise an
 * appended 2-space-indented block would land under a later top-level map (aliases:/groups:/…) and
 * corrupt the config. We have no YAML parser dep, so guard structurally and ABORT if unsafe (pure).
 */
export function modelsIsLastTopLevel(configText: string): boolean {
  const topLevel = [...configText.matchAll(/^([A-Za-z][\w-]*):/gm)];
  const modelsIdx = topLevel.findIndex((m) => m[1] === "models");
  return modelsIdx >= 0 && modelsIdx === topLevel.length - 1;
}

/** Render a llama-swap model entry block matching the existing house format (pure). */
export function buildConfigEntry(
  key: string,
  ggufPath: string,
  opts: { ctx: number; fa: "on" | "off"; bin: string }
): string {
  return [
    `  "${key}":`,
    `    cmd: |`,
    `      ${opts.bin}`,
    `      --host 127.0.0.1 --port \${PORT}`,
    `      -m ${ggufPath}`,
    `      -ngl 99 -ub 512 -c ${opts.ctx} --jinja -fa ${opts.fa}`,
    `    ttl: 1800`,
    "",
  ].join("\n");
}

async function modelsServed(): Promise<string[]> {
  const resp = await fetch(`${LLAMASWAP_URL}/v1/models`, { signal: AbortSignal.timeout(10_000) });
  if (!resp.ok) throw new Error(`/v1/models HTTP ${resp.status}`);
  const data = (await resp.json()) as { data?: Array<{ id: string }> };
  return (data.data ?? []).map((m) => m.id);
}

/** Fire a 1-token warm-up so we confirm the new model actually LOADS, not just lists. */
async function warmup(modelId: string): Promise<void> {
  const resp = await fetch(`${LLAMASWAP_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: modelId, messages: [{ role: "user", content: "hi" }], max_tokens: 1 }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!resp.ok) throw new Error(`warm-up HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
}

function restartLlamaSwap(): void {
  const [cmd, ...args] = RESTART_CMD.split(/\s+/);
  execFileSync(cmd!, args, { stdio: "inherit" });
}

async function waitForListed(modelId: string, timeoutMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await modelsServed()).includes(modelId)) return true;
    } catch {
      // llama-swap still coming up after restart — retry until deadline
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const entries = readRegistry(REGISTRY);
  const latest = latestByModel(entries);

  // Candidate = most-recent winner not yet served, with a usable GGUF on disk.
  const unservedWinners = [...latest.values()]
    .filter((e) => e.verdict === "winner" && !e.served && e.ggufDir && e.ggufPath)
    .sort((a, b) => b.evaluatedAt.localeCompare(a.evaluatedAt));

  // #176: a winner carrying gate flags (benchmark-gamed plausibility / name tell / #158 misconfig)
  // must NOT be auto-served. Surface it for manual review (propose-only) instead of silently going
  // live — the exact failure that promoted the gamed fable5 fine-tune.
  const { servable: candidates, gated } = partitionServableWinners(unservedWinners, loadScoutGateConfig());
  for (const g of gated) {
    console.log(`[promote] ⚠️  GATED winner NOT auto-served: ${g.entry.id} — ${g.flags.join("; ")}. Review; promote manually if legitimate.`);
  }

  if (candidates.length === 0) {
    console.log(
      `[promote] no auto-servable un-served winner in the registry — nothing to do.` +
        (gated.length ? ` (${gated.length} gated winner(s) held for review, see above)` : "")
    );
    return;
  }
  const cand = candidates[0]!;
  console.log(`[promote] candidate: ${cand.id} (${cand.quant}, ${cand.sizeGB} GB, passRate ${(cand.passRate * 100).toFixed(0)}%)`);

  if (!existsSync(CONFIG)) {
    console.error(`[promote] config not found: ${CONFIG} (are we on the box?)`);
    process.exit(1);
  }
  const configText = readFileSync(CONFIG, "utf8");
  const keys = existingKeys(configText);

  if (keys.size >= MAX_SERVED) {
    console.error(`[promote] served-count ceiling reached (${keys.size}/${MAX_SERVED}) — refusing to auto-grow. Prune the model list first.`);
    return;
  }

  // Structural safety: only append if `models:` is the last top-level key (no YAML parser dep).
  if (!modelsIsLastTopLevel(configText)) {
    console.error("[promote] config has a top-level key after `models:` — refusing to append (would corrupt). Promote manually.");
    return;
  }

  const key = deriveModelKey(cand.id, keys);
  assertModelKey(key); // charset / flag-smuggling defense

  // The model's whole directory (all shards) moves from scratch into the models dir. Both the dir
  // and part-1 file must exist. The served path = MODELS_DIR/<dir>/<part1>.
  const srcDir = cand.ggufDir!;
  const part1Name = basename(cand.ggufPath!);
  if (!existsSync(srcDir) || !existsSync(cand.ggufPath!)) {
    console.error(`[promote] GGUF dir/part missing on disk (${srcDir}) — cannot serve. Marking skip.`);
    appendEntry({ ...cand, verdict: "skip", served: false, notes: "gguf-missing-at-promote" }, REGISTRY);
    process.exit(1);
  }
  const destDir = srcDir.startsWith(MODELS_DIR) ? srcDir : join(MODELS_DIR, basename(srcDir));
  const destGguf = join(destDir, part1Name);

  const entryBlock = buildConfigEntry(key, destGguf, { ctx: CTX, fa: FA, bin: BIN });

  if (dryRun) {
    console.log(`[promote] DRY-RUN — would serve '${cand.id}' as key '${key}':\n${entryBlock}`);
    console.log(`[promote] DRY-RUN — would move dir ${srcDir} → ${destDir} (if needed) and restart llama-swap.`);
    return;
  }

  // ── Transactional edit (config + whole-dir move, both rolled back on failure) ─────
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const backup = `${CONFIG}.bak.${stamp}`;
  copyFileSync(CONFIG, backup);
  console.log(`[promote] backed up config → ${backup}`);

  let movedDir = false;
  try {
    if (destDir !== srcDir) {
      if (existsSync(destDir)) throw new Error(`destination dir already exists: ${destDir}`);
      renameSync(srcDir, destDir);
      movedDir = true;
      console.log(`[promote] moved model dir → ${destDir}`);
    }
    const newText = configText.endsWith("\n") ? configText + entryBlock : configText + "\n" + entryBlock;
    writeFileSync(CONFIG, newText, "utf8");
    console.log(`[promote] appended entry '${key}', restarting llama-swap…`);
    restartLlamaSwap();

    const listed = await waitForListed(key);
    if (!listed) throw new Error(`'${key}' did not appear in /v1/models within timeout`);
    await warmup(key);
    console.log(`[promote] ✓ '${key}' is live and serves (${cand.id}).`);

    appendEntry({ ...cand, served: true, configKey: key, ggufDir: destDir, ggufPath: destGguf, notes: "auto-promoted" }, REGISTRY);
    console.log(`[promote] registry updated: ${cand.id} served=true configKey=${key}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[promote] FAILED: ${msg} — rolling back.`);
    copyFileSync(backup, CONFIG);
    if (movedDir) {
      try {
        renameSync(destDir, srcDir); // put the model dir back where the registry expects it
        console.error(`[promote] moved model dir back → ${srcDir}`);
      } catch (me) {
        console.error(`[promote] rollback warn: could not move dir back: ${me instanceof Error ? me.message : me}`);
      }
    }
    try {
      restartLlamaSwap();
      console.error("[promote] rolled back config + restarted llama-swap (back to known-good).");
    } catch (re) {
      console.error(`[promote] CRITICAL: restart after rollback failed: ${re instanceof Error ? re.message : re}. Check llama-swap manually.`);
    }
    appendEntry({ ...cand, served: false, notes: `promote-failed: ${msg.slice(0, 160)}` }, REGISTRY);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
  });
}

export type { RegistryEntry };
