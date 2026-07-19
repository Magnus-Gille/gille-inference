import { loadConfig } from "./config.js";
import { listModels, loadModel, unloadModel, downloadModel, ensureLoaded, getLoaded } from "./model-admin.js";
import { delegate } from "./orchestrator.js";
import { ledgerReport, recentDelegations } from "./ledger.js";
import { PROBES, getProbe } from "./probes.js";
import { startGateway } from "./gateway.js";
import { mintKey, rotateKey, listKeys, revokeKey, KeyAliasExistsError, createInvite, listInvites, type Tier, type InvitePublic } from "./keystore.js";
import { runCli as runDeepResearch } from "./deep-research-cli.js";
import { acquireGpuLease, gpuLeaseStatus, type HolderSelection } from "./gpu-lease.js";
import { buildCageArgv } from "./code-loop-cage.js";
import { runCageSelfTestWithRelay, piVisibilityBinds } from "./code-loop-runtime.js";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

/**
 * Home-server scaffold CLI.
 *
 *   tsx src/homeserver/cli.ts <command> [options]
 *
 * Commands:
 *   serve                         Start the authenticated gateway (LAN inference endpoint)
 *   models                        List models on disk + which is loaded
 *   load <key> [--ctx N]          Load/swap the active model
 *   unload [<key>|--all]          Unload model(s)
 *   ensure-ctx [--ctx N]          Reload the active model at >= N context (fixes 4096)
 *   download <key> [--wait]       Download a model from the catalogue
 *   probe [--all|--id X|--type T] Run the experiment battery through the orchestrator
 *   delegate --prompt "..."       One-off delegation (--type T, --model local-id, --delegator cloud-id)
 *   ledger                        Print the learning report (verdicts per task type × model)
 */

/**
 * Build a copy-pasteable "Share with <name>:" block for an invite code.
 *
 * Pure function — no side effects, no DB access, safe to unit-test.
 *
 * @param name      Friend's name (alias prefix used when creating the invite)
 * @param code      The one-time invite code (plaintext, shown once)
 * @param credits   Lifetime token budget (0 = unlimited)
 * @param baseUrl   Public base URL of the inference gateway (no trailing slash)
 */
export function shareBlock(name: string, code: string, credits: number, baseUrl: string): string {
  const formatted = credits === 0 ? "unlimited" : credits.toLocaleString("en-US");
  const url = baseUrl.replace(/\/$/, "");
  return [
    `Share with ${name}:`,
    `  URL:      ${url}`,
    `  Credits:  ${formatted} tokens (lifetime cap)`,
    `  Redeem:   Go to ${url}/portal → "Have an invite code?" → Create my key`,
    `  Code:     ${code}`,
    `  Docs:     See the "How to use it" section on the portal page.`,
  ].join("\n");
}

/**
 * Format a list of invites as an aligned table string.
 *
 * Pure function — no side effects, no DB access, safe to unit-test.
 * Returns the full table (header + rows) as a single string, or a
 * "no invites yet" line when the list is empty.
 */
export function formatInvitesTable(invites: InvitePublic[]): string {
  if (invites.length === 0) return "No invites yet. Use `keys invite --credits N` to create one.";

  const header =
    `${"LABEL".padEnd(24)} ${"TIER".padEnd(6)} ${"CREDITS".padEnd(12)} ${"CREATED".padEnd(12)} STATUS`;
  const rows = invites.map((inv) => {
    const credits = inv.creditLimit === 0 ? "unlimited" : String(inv.creditLimit);
    const created = inv.createdAt.slice(0, 10); // YYYY-MM-DD
    const status =
      inv.redeemedKeyAlias !== null ? `redeemed → ${inv.redeemedKeyAlias}` : "unused";
    return (
      `${inv.label.slice(0, 23).padEnd(24)} ${inv.tier.padEnd(6)} ${credits.padEnd(12)} ${created.padEnd(12)} ${status}`
    );
  });

  return [header, ...rows].join("\n");
}

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function numFlag(flags: Record<string, string | boolean>, name: string): number | undefined {
  const v = flags[name];
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/**
 * Strict numeric flag for key-management commands (#99 Codex follow-up). ABSENT → undefined
 * (caller inherits / applies a default). PRESENT → must carry a finite numeric value; a bare
 * `--credits` (boolean) or a non-numeric `--credits abc` THROWS rather than silently collapsing
 * to undefined. The silent path is dangerous on rotate: `--credits` was meant to CAP a key, but
 * an invalid value would "inherit the current cap" and leave e.g. an unlimited key uncapped.
 * mintKey/rotateKey still enforce the non-negative-integer rule on the parsed value.
 */
export function strictNumFlag(
  flags: Record<string, string | boolean>,
  name: string
): number | undefined {
  if (!(name in flags)) return undefined;
  const v = flags[name];
  if (typeof v !== "string") throw new Error(`keys: --${name} requires a numeric value`);
  // Trim and reject empty FIRST: Number("") and Number("   ") are both 0, which is the
  // unlimited-credits sentinel — so `--credits "$UNSET_VAR"` would silently uncap a key.
  const raw = v.trim();
  if (raw === "") throw new Error(`keys: --${name} requires a numeric value`);
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`keys: --${name} must be a number (got '${v}')`);
  return n;
}

async function cmdModels(): Promise<void> {
  const models = await listModels();
  console.log(`${"KEY".padEnd(40)} ${"TYPE".padEnd(6)} ${"QUANT".padEnd(8)} ${"CTX".padEnd(8)} LOADED`);
  for (const m of models) {
    const loaded = m.loaded ? `yes @${m.loadedContext}` : "";
    console.log(
      `${m.key.slice(0, 39).padEnd(40)} ${(m.type ?? "").padEnd(6)} ${(m.quantization ?? "").padEnd(8)} ${String(
        m.maxContextLength ?? ""
      ).padEnd(8)} ${loaded}`
    );
  }
}

async function cmdLoad(args: ParsedArgs): Promise<void> {
  const key = args.positional[0];
  if (!key) throw new Error("usage: load <model-key> [--ctx N] [--parallel N] [--gpu max]");
  const r = await loadModel(key, {
    contextLength: numFlag(args.flags, "ctx"),
    parallel: numFlag(args.flags, "parallel"),
    gpu: typeof args.flags["gpu"] === "string" ? (args.flags["gpu"] as string) : undefined,
    ttlSeconds: numFlag(args.flags, "ttl"),
  });
  console.log(`${r.ok ? "✓" : "✗"} ${r.message} (ctx=${r.contextLength}, ${r.durationMs}ms)`);
}

async function cmdUnload(args: ParsedArgs): Promise<void> {
  const key = args.flags["all"] ? undefined : args.positional[0];
  const r = await unloadModel(key);
  console.log(`${r.ok ? "✓" : "✗"} ${r.message}`);
}

async function cmdEnsureCtx(args: ParsedArgs): Promise<void> {
  const cfg = loadConfig();
  const minCtx = numFlag(args.flags, "ctx") ?? cfg.minContextLength;
  const key = args.positional[0] ?? (await getLoaded())[0]?.key;
  if (!key) throw new Error("no model loaded and no <key> given");
  const r = await ensureLoaded(key, minCtx);
  console.log(`${r.ok ? "✓" : "✗"} ${key}: ${r.message}`);
}

async function cmdDownload(args: ParsedArgs): Promise<void> {
  const key = args.positional[0];
  if (!key) throw new Error("usage: download <model-key> [--wait]");
  const r = await downloadModel(key, { wait: args.flags["wait"] === true });
  console.log(`${r.ok ? "✓" : "✗"} ${r.message}`);
}

async function cmdProbe(args: ParsedArgs): Promise<void> {
  let probes = PROBES;
  if (typeof args.flags["id"] === "string") {
    const p = getProbe(args.flags["id"]);
    if (!p) throw new Error(`unknown probe: ${args.flags["id"]}`);
    probes = [p];
  } else if (typeof args.flags["type"] === "string") {
    probes = PROBES.filter((p) => p.taskType === args.flags["type"]);
  } else if (!args.flags["all"]) {
    console.log("Refusing to run all probes without --all (the full battery is slow). Use --all, --type T, or --id X.");
    return;
  }

  const source = typeof args.flags["source"] === "string" ? (args.flags["source"] as string) : "probe";
  console.log(`Running ${probes.length} probe(s) through the orchestrator...\n`);
  const tally: Record<string, number> = {};
  for (const p of probes) {
    const t0 = Date.now();
    const r = await delegate({
      prompt: p.prompt,
      taskType: p.taskType,
      systemPrompt: p.systemPrompt,
      maxTokens: p.maxTokens,
      temperature: p.temperature,
      verifier: p.verifier,
      verifierName: p.verifierName,
      source,
      // Local CLI activity is owner-controlled exposure even though it has no HTTP principal.
      keyAlias: "local:cli-probe",
    });
    tally[r.outcome ?? (r.delegated ? "unverified" : "escalated")] =
      (tally[r.outcome ?? (r.delegated ? "unverified" : "escalated")] ?? 0) + 1;
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const mark =
      r.outcome === "pass" ? "✓" : r.outcome === "partial" ? "~" : !r.delegated ? "⤴" : "✗";
    const tps = r.metrics ? `${r.metrics.tokPerSec}tps` : "";
    console.log(
      `${mark} ${p.id.padEnd(20)} [${p.taskType.padEnd(14)}] ${(r.outcome ?? (r.delegated ? "unverified" : "escalated")).padEnd(10)} ${secs}s ${tps}` +
        (r.verifierNotes ? `  — ${r.verifierNotes.slice(0, 80)}` : "") +
        (!r.delegated ? `  — ${r.decisionReason}` : "")
    );
  }
  console.log(`\nSummary: ${Object.entries(tally).map(([k, v]) => `${v} ${k}`).join(", ")}`);
}

async function cmdDelegate(args: ParsedArgs): Promise<void> {
  const prompt = typeof args.flags["prompt"] === "string" ? (args.flags["prompt"] as string) : args.positional.join(" ");
  if (!prompt) {
    throw new Error(
      'usage: delegate --prompt "..." [--type T] [--model <local-id>] [--frontier <model-id>] [--delegator <model-id>]'
    );
  }
  const frontierModelId = typeof args.flags["frontier"] === "string" ? (args.flags["frontier"] as string) : undefined;
  const modelId = typeof args.flags["model"] === "string" ? (args.flags["model"] as string) : undefined;
  const delegatorModelId = typeof args.flags["delegator"] === "string" ? (args.flags["delegator"] as string) : undefined;
  const premiumBaselineModelId =
    typeof args.flags["premium-baseline"] === "string" ? (args.flags["premium-baseline"] as string) : undefined;
  const r = await delegate({
    prompt,
    taskType: typeof args.flags["type"] === "string" ? (args.flags["type"] as string) : undefined,
    maxTokens: numFlag(args.flags, "max-tokens"),
    modelId,
    frontierModelId,
    delegatorModelId,
    premiumBaselineModelId,
    source: "cli",
    // Local CLI activity is owner-controlled exposure even though it has no HTTP principal.
    keyAlias: "local:cli-delegate",
  });
  const display: Record<string, unknown> = { ...r, output: r.output?.slice(0, 2000) };
  if (r.frontierOutput !== undefined) display["frontierOutput"] = r.frontierOutput.slice(0, 2000);
  console.log(JSON.stringify(display, null, 2));
  if (r.escalate && r.frontierOutput) {
    console.log(`\n— frontier (${r.frontierModelId}) —\n${r.frontierOutput}`);
  } else if (r.escalate && r.frontierError) {
    console.error(`\n— frontier error: ${r.frontierError}`);
  }
}

function cmdLedger(): void {
  const cfg = loadConfig();
  const rows = ledgerReport(cfg.policy);
  if (rows.length === 0) {
    console.log("Ledger is empty — run `probe --all` first.");
    return;
  }
  console.log("CAPABILITY LEDGER — verdicts per task type × model\n");
  console.log(
    `${"TASK TYPE".padEnd(16)} ${"MODEL".padEnd(22)} ${"VERDICT".padEnd(11)} ${"P/Pa/F/E".padEnd(10)} ${"RATE".padEnd(6)} ${"REC".padEnd(18)} ${"LAT".padEnd(8)} TPS`
  );
  for (const r of rows) {
    const counts = `${r.passes}/${r.partials}/${r.fails}/${r.errors}`;
    const frozen = r.frozen ? "*" : " ";
    console.log(
      `${r.taskType.padEnd(16)} ${r.modelId.slice(0, 21).padEnd(22)} ${(r.verdict + frozen).padEnd(11)} ${counts.padEnd(10)} ${String(r.successRate).padEnd(6)} ${r.recommendation.padEnd(18)} ${String(r.avgLatencyMs ?? "").padEnd(8)} ${r.avgTokPerSec ?? ""}`
    );
  }
  console.log("\n(* = verdict frozen; P/Pa/F/E = pass/partial/fail/error; LAT = avg ms)");

  const recent = recentDelegations(8);
  console.log("\nMost recent delegations:");
  for (const d of recent) {
    console.log(`  ${d.ts.slice(11, 19)} ${d.taskType.padEnd(14)} ${d.outcome.padEnd(10)} ${d.verifier ?? ""}`);
  }
}

function cmdKeys(args: ParsedArgs): void {
  const sub = args.positional[0];
  const cfg = loadConfig();

  if (sub === "mint") {
    const alias = typeof args.flags["alias"] === "string" ? (args.flags["alias"] as string) : undefined;
    const tier = typeof args.flags["tier"] === "string" ? (args.flags["tier"] as string) : undefined;
    if (!alias || (tier !== "owner" && tier !== "guest")) {
      throw new Error("usage: keys mint --alias A --tier owner|guest [--models a,b] [--rpm N] [--tpm N] [--daily N] [--parallel N] [--credits N] [--ttl S]");
    }
    const models =
      typeof args.flags["models"] === "string"
        ? (args.flags["models"] as string).split(",").map((s) => s.trim()).filter(Boolean)
        : undefined;
    let minted;
    try {
      minted = mintKey(
        {
          alias,
          tier: tier as Tier,
          modelAllowList: models,
          rpm: strictNumFlag(args.flags, "rpm"),
          tpm: strictNumFlag(args.flags, "tpm"),
          dailyTokenBudget: strictNumFlag(args.flags, "daily"),
          maxParallel: strictNumFlag(args.flags, "parallel"),
          creditLimit: strictNumFlag(args.flags, "credits"),
          ttlSeconds: strictNumFlag(args.flags, "ttl"),
        },
        cfg.keyDefaults
      );
    } catch (err) {
      // #99: the alias is the PRIMARY KEY, so a revoked row still owns the name and re-minting
      // it fails. Point the operator at `keys rotate` instead of leaving them to hand-roll a
      // fresh-alias pipeline (which silently clobbered the Keychain when the mint errored).
      if (err instanceof KeyAliasExistsError) {
        throw new Error(
          `${err.message}. To rotate it, use:  keys rotate --alias ${alias}  (revokes the old key + mints a fresh one).`
        );
      }
      throw err;
    }
    console.log(`✓ minted ${minted.record.tier} key '${minted.record.alias}'`);
    console.log(`\n  ${minted.plaintextKey}\n`);
    console.warn("⚠  This is the ONLY time the key is shown — store it now. Only its sha256 hash is persisted.");
    return;
  }

  if (sub === "rotate") {
    const alias = typeof args.flags["alias"] === "string" ? (args.flags["alias"] as string) : args.positional[1];
    const tierRaw = typeof args.flags["tier"] === "string" ? (args.flags["tier"] as string) : undefined;
    if (!alias) {
      throw new Error(
        "usage: keys rotate --alias A [--tier owner|guest] [--models a,b] [--rpm N] [--tpm N] [--daily N] [--parallel N] [--credits N] [--ttl S]\n" +
          "  Revokes the active key(s) for A and mints a fresh one, inheriting tier+limits from the\n" +
          "  current key (override with flags). --tier is required only for a brand-new name."
      );
    }
    if (tierRaw !== undefined && tierRaw !== "owner" && tierRaw !== "guest") {
      throw new Error("keys rotate: --tier must be owner|guest");
    }
    const models =
      typeof args.flags["models"] === "string"
        ? (args.flags["models"] as string).split(",").map((s) => s.trim()).filter(Boolean)
        : undefined;
    const { plaintextKey, newAlias, revokedAliases } = rotateKey(
      alias,
      {
        ...(tierRaw ? { tier: tierRaw as Tier } : {}),
        ...(models ? { modelAllowList: models } : {}),
        rpm: strictNumFlag(args.flags, "rpm"),
        tpm: strictNumFlag(args.flags, "tpm"),
        dailyTokenBudget: strictNumFlag(args.flags, "daily"),
        maxParallel: strictNumFlag(args.flags, "parallel"),
        creditLimit: strictNumFlag(args.flags, "credits"),
        ttlSeconds: strictNumFlag(args.flags, "ttl"),
      },
      cfg.keyDefaults
    );
    console.log(`✓ rotated '${alias}' → new active key '${newAlias}'`);
    console.log(
      revokedAliases.length
        ? `  revoked prior: ${revokedAliases.join(", ")}`
        : `  (no prior active key for '${alias}' — minted fresh)`
    );
    console.log(`\n  ${plaintextKey}\n`);
    console.warn("⚠  This is the ONLY time the key is shown — store it now. Only its sha256 hash is persisted.");
    return;
  }

  if (sub === "list") {
    const keys = listKeys({ includeRevoked: args.flags["all"] === true });
    if (keys.length === 0) {
      console.log("No keys minted. Use `keys mint --alias A --tier guest`.");
      return;
    }
    console.log(
      `${"ALIAS".padEnd(20)} ${"LOGICAL".padEnd(16)} ${"TIER".padEnd(6)} ${"RPM".padEnd(7)} ${"TPM".padEnd(9)} ${"DAILY".padEnd(9)} ${"PAR".padEnd(4)} ${"EXPIRES".padEnd(22)} REVOKED`
    );
    for (const k of keys) {
      // LOGICAL is the rotation family a key belongs to (#99) — what you pass to `keys rotate`.
      const logical = k.logicalAlias ?? "";
      console.log(
        `${k.alias.slice(0, 19).padEnd(20)} ${logical.slice(0, 15).padEnd(16)} ${k.tier.padEnd(6)} ${String(k.rpm).padEnd(7)} ${String(k.tpm).padEnd(9)} ${String(k.dailyTokenBudget).padEnd(9)} ${String(k.maxParallel).padEnd(4)} ${(k.expiresAt ?? "never").padEnd(22)} ${k.revokedAt ?? ""}`
      );
    }
    return;
  }

  if (sub === "revoke") {
    const alias = typeof args.flags["alias"] === "string" ? (args.flags["alias"] as string) : args.positional[1];
    if (!alias) throw new Error("usage: keys revoke --alias A");
    const ok = revokeKey(alias);
    console.log(ok ? `✓ revoked '${alias}'` : `✗ no such active key '${alias}'`);
    return;
  }

  if (sub === "invites") {
    const invites = listInvites();
    console.log(formatInvitesTable(invites));
    return;
  }

  if (sub === "invite") {
    const credits = numFlag(args.flags, "credits");
    if (credits === undefined || credits < 0) {
      throw new Error(
        "usage: keys invite --credits N [--tier guest|owner] [--model M] [--alias-prefix P]\n" +
          "  --credits N is required (the lifetime token budget; 0 = unlimited)"
      );
    }
    const tier = typeof args.flags["tier"] === "string" ? (args.flags["tier"] as string) : "guest";
    if (tier !== "owner" && tier !== "guest") throw new Error("--tier must be owner|guest");
    const model = typeof args.flags["model"] === "string" ? (args.flags["model"] as string) : undefined;
    const aliasPrefix =
      typeof args.flags["alias-prefix"] === "string" ? (args.flags["alias-prefix"] as string) : undefined;
    // The invite row needs a unique operator-facing label; derive a stable, readable one.
    const label =
      (typeof args.flags["label"] === "string" ? (args.flags["label"] as string) : undefined) ??
      `invite-${new Date().toISOString().replace(/[:.]/g, "-")}`;

    const { code } = createInvite({
      label,
      tier: tier as Tier,
      creditLimit: credits,
      modelAllowList: model ? [model] : undefined,
      aliasPrefix,
    });
    const baseUrl = (process.env["HOMESERVER_PUBLIC_URL"] ?? "https://inference.example.com").replace(/\/$/, "");
    const friendName = aliasPrefix ?? label;
    console.log(`✓ created ${tier} invite '${label}' (credits=${credits === 0 ? "unlimited" : credits})`);
    console.log(`\n  ${code}\n`);
    console.warn("⚠  This is the ONLY time the invite code is shown — share it now. Only its sha256 hash is persisted.");
    console.log(`\n${shareBlock(friendName, code, credits, baseUrl)}`);
    return;
  }

  console.log("usage: keys <mint|rotate|list|revoke|invite|invites> ...");
}

function strFlag(flags: Record<string, string | boolean>, name: string): string | undefined {
  const v = flags[name];
  return typeof v === "string" ? v : undefined;
}

async function cmdDeepResearch(args: ParsedArgs): Promise<void> {
  const query = strFlag(args.flags, "query") ?? args.positional.join(" ");
  if (!query) throw new Error('deep-research: --query "..." (or positional text) is required');
  const depthRaw = strFlag(args.flags, "depth");
  const brainRaw = strFlag(args.flags, "brain");
  const res = await runDeepResearch({
    query,
    nowIso: new Date().toISOString(),
    ...(depthRaw === "quick" || depthRaw === "thorough" ? { depth: depthRaw } : {}),
    ...(brainRaw === "local" || brainRaw === "hybrid" ? { brain: brainRaw } : {}),
    ...(args.flags["sensitive"] ? { sensitive: true } : {}),
    ...(strFlag(args.flags, "out") ? { outputDir: strFlag(args.flags, "out")! } : {}),
    ...(args.flags["no-ledger"] ? { noLedger: true } : {}),
  });
  console.log(JSON.stringify({ slug: res.slug, reportPath: res.reportPath, popularPath: res.popularPath, stats: res.stats }, null, 2));
}

/**
 * Parse a human duration ("30s", "10m", "2h", or a bare number = seconds) to milliseconds.
 * Pure — returns null for anything unparseable. Exported for unit testing.
 */
export function parseDurationMs(raw: string | undefined): number | null {
  if (!raw) return null;
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h)?$/i.exec(raw.trim());
  if (!m) return null;
  const n = parseFloat(m[1]!);
  const unit = (m[2] ?? "s").toLowerCase();
  const mult = unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : 1_000;
  return Math.round(n * mult);
}

/**
 * Render the GPU-lease queue as an aligned table for `gpu status`. Pure (takes a snapshot + a
 * clock) so it is unit-testable. `now` lets remaining-ETA be computed deterministically.
 */
export function formatGpuStatus(sel: HolderSelection, now: number): string {
  if (sel.live.length === 0) return "GPU is idle — no leases held or queued.";
  const fmtAgo = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)}m`);
  const lines = sel.live.map((t, i) => {
    const role = i === 0 ? "HOLDING" : `queued#${i}`;
    const held = fmtAgo(now - t.enqueuedAt);
    const eta =
      t.etaMs != null ? ` eta~${fmtAgo(Math.max(0, t.etaMs - (now - t.enqueuedAt)))}` : "";
    const purpose = t.purpose ? ` "${t.purpose}"` : "";
    return `  ${role.padEnd(9)} ${t.model.padEnd(22)} ${held.padStart(4)}${eta} [${t.host}/${t.pid}]${purpose}`;
  });
  return [`GPU leases (${sel.live.length} live${sel.stale.length ? `, ${sel.stale.length} stale` : ""}):`, ...lines].join("\n");
}

/**
 * `gpu` — coordinate heavy batch jobs against the serial GPU (issue #88).
 *   gpu status                                              show who holds the GPU + the queue
 *   gpu run --model X [--eta 10m] [--purpose "…"] -- <cmd>  acquire (FIFO), run <cmd>, release
 */
async function cmdGpu(argv: string[]): Promise<void> {
  const sub = argv[0];
  const cfg = loadConfig();
  const dir = cfg.gpuLeaseDir;
  const staleMs = cfg.gpuLeaseStaleMs;

  if (sub === "status") {
    console.log(formatGpuStatus(await gpuLeaseStatus(dir, { staleMs }), Date.now()));
    return;
  }

  if (sub === "run") {
    const sepIdx = argv.indexOf("--");
    if (sepIdx < 0 || sepIdx === argv.length - 1) {
      throw new Error('gpu run: usage `gpu run --model <id> [--eta 10m] [--purpose "…"] -- <command…>`');
    }
    const flags = parseArgs(argv.slice(1, sepIdx)).flags;
    const command = argv.slice(sepIdx + 1);
    const model = strFlag(flags, "model") ?? "(unspecified)";
    const purpose = strFlag(flags, "purpose") ?? command.join(" ").slice(0, 80);
    const etaMs = parseDurationMs(strFlag(flags, "eta"));

    // While WAITING, Ctrl-C aborts the queue wait (releases our ticket and exits).
    const ac = new AbortController();
    const abortWait = () => ac.abort();
    process.once("SIGINT", abortWait);
    process.once("SIGTERM", abortWait);

    let lease;
    let lastMsg = "";
    // Holds the running child so a stolen-lease event can terminate it. Set once we spawn.
    const childRef: { proc?: ReturnType<typeof spawn> } = {};
    let leaseLost = false;
    try {
      lease = await acquireGpuLease({
        model,
        purpose,
        etaMs,
        dir,
        staleMs,
        signal: ac.signal,
        onLeaseLost: () => {
          // The GPU was reclaimed out from under us (a stale-reclaim during an event-loop stall).
          // Stop our job NOW so we don't run concurrently with the new holder.
          leaseLost = true;
          console.error("[gpu] WARNING: lease lost (reclaimed by another job) — terminating.");
          childRef.proc?.kill("SIGTERM");
        },
        onWait: (pos, holder) => {
          const msg = holder
            ? `waiting for GPU — position ${pos} behind ${holder.model} [${holder.host}/${holder.pid}]${holder.purpose ? ` "${holder.purpose}"` : ""}`
            : `waiting for GPU — position ${pos}`;
          if (msg !== lastMsg) {
            console.error(`[gpu] ${msg}`);
            lastMsg = msg;
          }
        },
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        console.error("[gpu] cancelled while waiting — released our place in line.");
        process.exit(130);
      }
      throw err;
    }
    process.removeListener("SIGINT", abortWait);
    process.removeListener("SIGTERM", abortWait);
    console.error(`[gpu] acquired — running: ${command.join(" ")}`);

    // While HOLDING, forward signals to the child and release once it exits.
    const code = await new Promise<number>((resolve) => {
      const child = spawn(command[0]!, command.slice(1), { stdio: "inherit" });
      childRef.proc = child;
      const forward = (sig: NodeJS.Signals) => {
        if (!child.killed) child.kill(sig);
      };
      process.on("SIGINT", forward);
      process.on("SIGTERM", forward);
      child.on("error", (err) => {
        console.error(`[gpu] failed to spawn command: ${err.message}`);
        resolve(127);
      });
      child.on("exit", (c, signal) => {
        process.removeListener("SIGINT", forward);
        process.removeListener("SIGTERM", forward);
        resolve(c ?? (signal ? 1 : 0));
      });
    });
    await lease.release();
    // A lost lease is a failure even if the (killed) child happened to exit 0.
    const exitCode = leaseLost ? 75 : code; // 75 = EX_TEMPFAIL (retryable)
    console.error(`[gpu] released (exit ${exitCode}${leaseLost ? ", lease lost" : ""}).`);
    process.exit(exitCode);
  }

  console.log(
    "gpu: coordinate heavy batch jobs on the serial GPU (issue #88)\n" +
      "  gpu status\n" +
      '  gpu run --model <id> [--eta 10m] [--purpose "…"] -- <command…>'
  );
}

/**
 * code-loop admin (#116). Phase 1 exposes the CAGE SELF-TEST — the ship gate: it runs the
 * confinement probe inside the exact cage argv (systemd-run resource caps + pasta egress block +
 * bwrap filesystem view) with the gateway relay up, and asserts secrets are unreadable, writes to
 * the read-only toolchain fail, external egress is blocked, and the gateway is reachable (200).
 *
 *   tsx src/homeserver/cli.ts code-loop cage-test
 *   # On the box the gateway binds the tailnet IP, so target it explicitly:
 *   HOMESERVER_HOST=192.0.2.10 tsx src/homeserver/cli.ts code-loop cage-test
 *   tsx src/homeserver/cli.ts code-loop cage-test --gateway-url http://192.0.2.10:8080
 */
async function cmdCodeLoop(rawArgs: string[]): Promise<void> {
  const sub = rawArgs[0];
  if (sub !== "cage-test") {
    console.log("Usage: code-loop cage-test [--gateway-url http://host:port]");
    process.exitCode = 2;
    return;
  }
  const cfg = loadConfig();
  const home = homedir();
  const nmPath = join(process.cwd(), "node_modules");
  const nm = existsSync(nmPath) ? nmPath : null;

  // Resolve the gateway target: --gateway-url overrides HOMESERVER_HOST/PORT (the worktree has no
  // .env, so the config defaults to loopback; on the box the gateway binds the tailnet IP).
  let gwHost = cfg.gatewayHost;
  let gwPort = cfg.gatewayPort;
  const gi = rawArgs.indexOf("--gateway-url");
  if (gi !== -1 && rawArgs[gi + 1]) {
    try {
      const u = new URL(rawArgs[gi + 1]!);
      gwHost = u.hostname;
      gwPort = u.port ? Number(u.port) : 8080;
    } catch {
      console.error(`invalid --gateway-url: ${rawArgs[gi + 1]}`);
      process.exitCode = 2;
      return;
    }
  }

  // Mirror the runtime's wiring: punch the pi-visibility ro holes through the home tmpfs and
  // (when provisioned) assert job RUNNABILITY — pi + its models.json visible in-cage — not just
  // confinement (the arm the 2026-07-02 live smoke was missing).
  const extraRoBinds = piVisibilityBinds(cfg.codeLoopPiBin, cfg.codeLoopPiAgentDir);
  const runnability = {
    piBin: cfg.codeLoopPiBin !== "" ? cfg.codeLoopPiBin : null,
    piAgentDir: cfg.codeLoopPiAgentDir !== "" ? cfg.codeLoopPiAgentDir : null,
  };
  const cageBuildArgv = (sandboxDir: string, unitName: string): string[] =>
    buildCageArgv({ sandboxDir, homeDir: home, forwardPort: cfg.codeLoopForwardPort, nodeModulesDir: nm, unitName, extraRoBinds });

  const r = await runCageSelfTestWithRelay(
    cageBuildArgv,
    join(process.cwd(), ".env"),
    cfg.codeLoopForwardPort,
    gwHost,
    gwPort,
    "required",
    runnability
  );
  if (r.ok) {
    const runnable = [
      ...(runnability.piBin !== null ? [`pi visible at ${runnability.piBin}`] : []),
      ...(runnability.piAgentDir !== null ? [`models.json visible at ${runnability.piAgentDir}/models.json`] : []),
    ];
    console.log(
      `cage self-test: PASS (secrets unreadable, ro-mount write denied, egress blocked, gateway ${gwHost}:${gwPort} reachable` +
        (runnable.length > 0 ? `, ${runnable.join(", ")}` : "") +
        ")"
    );
  } else {
    console.error("cage self-test: FAIL");
    for (const f of r.failures) console.error(`  - ${f}`);
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const args = parseArgs(argv.slice(1));

  switch (cmd) {
    case "serve":
      await startGateway();
      break;
    case "models":
      await cmdModels();
      break;
    case "load":
      await cmdLoad(args);
      break;
    case "unload":
      await cmdUnload(args);
      break;
    case "ensure-ctx":
      await cmdEnsureCtx(args);
      break;
    case "download":
      await cmdDownload(args);
      break;
    case "probe":
      await cmdProbe(args);
      break;
    case "delegate":
      await cmdDelegate(args);
      break;
    case "ledger":
      cmdLedger();
      break;
    case "keys":
      cmdKeys(args);
      break;
    case "deep-research":
      await cmdDeepResearch(args);
      break;
    case "gpu":
      // gpu needs the RAW argv (the `--` command separator is meaningful), not parsed flags.
      await cmdGpu(argv.slice(1));
      break;
    case "code-loop":
      await cmdCodeLoop(argv.slice(1));
      break;
    default:
      console.log(
        "Commands: serve | models | load | unload | ensure-ctx | download | probe | delegate | ledger | keys | deep-research | gpu | code-loop\n" +
          "Examples:\n" +
          "  tsx src/homeserver/cli.ts ensure-ctx --ctx 32768\n" +
          "  tsx src/homeserver/cli.ts probe --all\n" +
          '  tsx src/homeserver/cli.ts delegate --prompt "Return OK" --model mellum --delegator openai/gpt-5.5   # local model + cloud brain\n' +
          "  tsx src/homeserver/cli.ts ledger\n" +
          "  tsx src/homeserver/cli.ts keys mint --alias laptop --tier owner\n" +
          "  tsx src/homeserver/cli.ts keys rotate --alias harness   # revoke old + mint fresh (#99)\n" +
          "  tsx src/homeserver/cli.ts keys invite --credits 500000 --tier guest --model qwen3\n" +
          "  tsx src/homeserver/cli.ts keys list\n" +
          '  tsx src/homeserver/cli.ts deep-research --query "impact of GLP-1 drugs on cardiovascular outcomes" --depth thorough\n' +
          "  tsx src/homeserver/cli.ts gpu status\n" +
          '  tsx src/homeserver/cli.ts gpu run --model qwen3-coder-next-80b --eta 20m --purpose cascade -- tsx scripts/cascade-gate-experiment.ts\n' +
          "  tsx src/homeserver/cli.ts serve"
      );
  }
}

// Run main() only when invoked as the entrypoint — NOT when imported (e.g. a test importing the
// pure helpers shouldn't execute the CLI and print help as a side-effect).
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
