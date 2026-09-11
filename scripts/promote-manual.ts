#!/usr/bin/env tsx
/**
 * promote-manual.ts — transactionally promote one hand-picked model (#217).
 *
 * The manual roster lane previously ran WITHOUT the backup → apply → restart →
 * health-check → auto-restore-on-failure safety the retired auto-promoter had. This CLI
 * gives a named model plus a reviewed serving-contract spec the same guarantee.
 *
 *   tsx scripts/promote-manual.ts --key ornith-1.5-35b --spec deploy/specs/ornith-1.5-35b.yaml --dry-run
 *   tsx scripts/promote-manual.ts --key ornith-1.5-35b --spec deploy/specs/ornith-1.5-35b.yaml
 *
 * Runs on the inference node. Production install/restart additionally requires the exact
 * release/target/action/verification/rollback approval per deploy/README.md; this tool never
 * replaces that authorization, it only makes the approved apply safe.
 *
 * ENV (corrected live-layout defaults, all overridable)
 *   LLAMASWAP_CONFIG     default /etc/gille-inference/llama-swap/config.yaml
 *   LLAMASWAP_URL        default http://127.0.0.1:8091
 *   PROMOTE_MAX_SERVED   default 12
 *   PROMOTE_RESTART_CMD  default "sudo systemctl restart llama-swap" (split on whitespace, no shell)
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  PROMOTION_DEFAULTS,
  applyManualPromotion,
  parseManualSpec,
  renderManualEntry,
  type PromotionCommandResult,
} from "../src/homeserver/manual-promotion.js";

const CONFIG = process.env["LLAMASWAP_CONFIG"] ?? PROMOTION_DEFAULTS.configPath;
const LLAMASWAP_URL = (process.env["LLAMASWAP_URL"] ?? PROMOTION_DEFAULTS.llamaswapUrl).replace(/\/$/, "");
const MAX_SERVED = Number(process.env["PROMOTE_MAX_SERVED"] ?? PROMOTION_DEFAULTS.maxServed);
const RESTART_CMD = (process.env["PROMOTE_RESTART_CMD"] ?? PROMOTION_DEFAULTS.restartCommand).split(/\s+/);

function usage(): never {
  console.error("usage: tsx scripts/promote-manual.ts --key <model-key> --spec <spec-yaml> [--dry-run]");
  process.exit(2);
}

function runCommand(argv: string[]): Promise<PromotionCommandResult> {
  return new Promise((resolve) => {
    execFile(argv[0] as string, argv.slice(1), { encoding: "utf8" }, (error, stdout, stderr) => {
      resolve({
        code: error && "code" in error ? Number((error as { code: unknown }).code) || 1 : error ? 1 : 0,
        stdout: String(stdout ?? ""),
        stderr: `${error instanceof Error ? `${error.message}\n` : ""}${String(stderr ?? "")}`,
      });
    });
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const keyIdx = args.indexOf("--key");
  const specIdx = args.indexOf("--spec");
  if (keyIdx < 0 || specIdx < 0 || !args[keyIdx + 1] || !args[specIdx + 1]) usage();
  const key = args[keyIdx + 1] as string;
  const specPath = args[specIdx + 1] as string;
  const dryRun = args.includes("--dry-run");

  const spec = parseManualSpec(readFileSync(specPath, "utf8"));
  if (spec.key !== key) {
    console.error(`[promote-manual] --key '${key}' does not match spec key '${spec.key}' — refusing`);
    process.exit(1);
  }

  if (dryRun) {
    console.log(`[promote-manual] DRY-RUN — would serve '${key}' from '${specPath}':\n${renderManualEntry(spec)}`);
    console.log("[promote-manual] DRY-RUN — would backup config, apply, verify bytes, restart, health-check.");
    return;
  }

  const backupFor = (backupId: string): string => join(dirname(CONFIG), `${backupId}.yaml`);
  // Ownership/permissions preserved exactly like the reviewed manual ceremony:
  // install(1) sets root:gille-llama-swap 0640 atomically; a bare write never touches live config.
  const installBytes = async (content: string): Promise<void> => {
    const temporary = `${CONFIG}.promote-${process.pid}.tmp`;
    writeFileSync(temporary, content, { mode: 0o600 });
    try {
      const installed = await runCommand([
        "install",
        "-o",
        "root",
        "-g",
        "gille-llama-swap",
        "-m",
        "0640",
        temporary,
        CONFIG,
      ]);
      if (installed.code !== 0) throw new Error(`install exited ${installed.code}: ${installed.stderr.slice(0, 200)}`);
    } finally {
      try {
        unlinkSync(temporary);
      } catch {
        // Best-effort temp cleanup; a leftover tmp file next to the config is harmless.
      }
    }
  };
  const result = await applyManualPromotion(spec, {
    readConfig: () => readFileSync(CONFIG, "utf8"),
    fileExists: (path) => existsSync(path),
    writeBackup: async (backupId, content) => {
      writeFileSync(backupFor(backupId), content, { mode: 0o600 });
    },
    applyConfig: installBytes,
    readBackConfig: () => readFileSync(CONFIG, "utf8"),
    restoreBackup: (backupId) => installBytes(readFileSync(backupFor(backupId), "utf8")),
    runCommand,
    modelsListed: async () => {
      const resp = await fetch(`${LLAMASWAP_URL}/v1/models`, { signal: AbortSignal.timeout(10_000) });
      if (!resp.ok) throw new Error(`/v1/models HTTP ${resp.status}`);
      const data = (await resp.json()) as { data?: Array<{ id: string }> };
      return (data.data ?? []).map((m) => m.id);
    },
    warmupModel: async (modelId) => {
      const resp = await fetch(`${LLAMASWAP_URL}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: modelId, messages: [{ role: "user", content: "hi" }], max_tokens: 1 }),
        signal: AbortSignal.timeout(180_000),
      });
      if (!resp.ok) throw new Error(`warm-up HTTP ${resp.status}`);
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => new Date(),
    maxServed: MAX_SERVED,
    restartCommand: RESTART_CMD,
  });
  console.log(`[promote-manual] '${result.key}' is live and serves (backup: ${result.backupPath}).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
  });
}
