/**
 * manual-promotion.ts — transactional roster promotion for hand-picked models (#217).
 *
 * The retired auto-promoter (`scripts/promote-model.ts`, removed in #221) was the only path
 * with backup → apply → restart → health-check → auto-restore-on-failure safety. Hand-picked
 * models (e.g. ornith-1.5-35b) were applied by hand with no automatic rollback. This module
 * gives the manual lane the same safety property for a named model plus an explicit,
 * reviewed serving-contract spec — never a registry lookup, never more than one entry.
 *
 * Safety properties (all preserved from the retired core):
 * - additive only: an existing key is never modified, only a new key appended;
 * - served-count ceiling and one promotion per run;
 * - timestamped backup before any write; byte-identical restore + restart on ANY failure;
 * - applied bytes verified against the rendered candidate before restarting;
 * - production ownership/permissions via install(1), never a bare write;
 * - dry-run renders without touching disk, services, or the network.
 *
 * This module performs no I/O except through its explicit dependencies, so every failure
 * path above is unit-testable against temp dirs and stubbed commands.
 */

const SPEC_FIELDS = new Set([
  "key",
  "gguf",
  "runtime_bin",
  "ctx",
  "ngl",
  "ubatch",
  "np",
  "jinja",
  "fa",
  "cache_ram_mib",
  "ctk",
  "ctv",
  "mmproj",
  "image_min_tokens",
  "spec_type",
  "spec_draft_n_max",
  "reasoning_format",
  "reasoning",
  "ttl",
]);

const REQUIRED_SPEC_FIELDS = [
  "key",
  "gguf",
  "runtime_bin",
  "ctx",
  "ngl",
  "ubatch",
  "cache_ram_mib",
  "ctk",
  "ctv",
  "ttl",
] as const;

const KV_QUANT_RE = /^(f16|q[458]_[01])$/;
const ABSOLUTE_PATH_RE = /^\//;

export interface ManualServingSpec {
  key: string;
  gguf: string;
  runtimeBin: string;
  ctx: number;
  ngl: number;
  ubatch: number;
  np: number | null;
  jinja: boolean;
  fa: "on" | "off";
  cacheRamMib: number;
  ctk: string;
  ctv: string;
  mmproj: string | null;
  imageMinTokens: number | null;
  specType: string | null;
  specDraftNMax: number | null;
  reasoningFormat: string | null;
  reasoning: string | null;
  ttl: number;
}

export interface PromotionDefaults {
  configPath: string;
  llamaswapUrl: string;
  maxServed: number;
  restartCommand: string;
}

/**
 * Corrected box-layout defaults (#217). The retired script defaulted to paths that do not
 * exist here (/etc/llama-swap/config.yaml, /srv/models, /opt/llama.cpp/…); every default
 * below is the actual live layout and remains env-overridable at the CLI boundary.
 */
export const PROMOTION_DEFAULTS: PromotionDefaults = {
  configPath: "/etc/gille-inference/llama-swap/config.yaml",
  llamaswapUrl: "http://127.0.0.1:8091",
  maxServed: 12,
  restartCommand: "sudo systemctl restart llama-swap",
};

function fail(message: string): never {
  throw new Error(`[manual-promotion] ${message}`);
}

function positiveInt(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    fail(`spec field '${field}' must be a positive integer`);
  }
  return value;
}

function boundedInt(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    fail(`spec field '${field}' must be an integer in ${min}..${max}`);
  }
  return value;
}

function absolutePath(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || !ABSOLUTE_PATH_RE.test(value)) {
    fail(`spec field '${field}' must be an absolute path`);
  }
  if (value.includes("\0") || value.includes("\n") || /(^|\/)(\.\.)(\/|$)/.test(value)) {
    fail(`spec field '${field}' must not contain NUL, newlines, or '..' segments`);
  }
  return value;
}

function flagToken(value: unknown, field: string, allowed: RegExp): string {
  if (typeof value !== "string" || value.length === 0 || !allowed.test(value)) {
    fail(`spec field '${field}' has an unsupported value`);
  }
  return value;
}

/**
 * Parse a reviewed serving-contract spec. The format is a strict flat `key: value` subset —
 * one entry per line, `#` comments and blank lines allowed, scalar strings (bare or
 * single/double-quoted), integers, and booleans only. Unknown fields, duplicates, and
 * missing required fields are rejected: a spec that cannot be read exactly cannot promote.
 */
export function parseManualSpec(text: string): ManualServingSpec {
  const raw = new Map<string, string>();
  for (const line of text.split("\n")) {
    const stripped = line.trim();
    if (stripped === "" || stripped.startsWith("#")) continue;
    const colon = stripped.indexOf(":");
    if (colon < 0) fail(`unparseable spec line: '${stripped.slice(0, 60)}'`);
    const field = stripped.slice(0, colon).trim();
    let value = stripped.slice(colon + 1).trim();
    if (!SPEC_FIELDS.has(field)) fail(`unknown spec field '${field}'`);
    if (raw.has(field)) fail(`duplicate spec field '${field}'`);
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    raw.set(field, value);
  }
  for (const field of REQUIRED_SPEC_FIELDS) {
    if (!raw.has(field)) fail(`missing required spec field '${field}'`);
  }
  const get = (field: string): string => raw.get(field) as string;
  const opt = (field: string): string | null => (raw.has(field) ? (raw.get(field) as string) : null);
  const optInt = (field: string): number | null => {
    const value = opt(field);
    return value === null ? null : positiveInt(Number(value), field);
  };
  const bool = (field: string, fallback: boolean): boolean => {
    const value = opt(field);
    if (value === null) return fallback;
    if (value !== "true" && value !== "false") fail(`spec field '${field}' must be true or false`);
    return value === "true";
  };

  const fa = get("fa");
  if (fa !== "on" && fa !== "off") fail("spec field 'fa' must be 'on' or 'off'");
  const specType = opt("spec_type");
  const specDraftNMax = optInt("spec_draft_n_max");
  if ((specType === null) !== (specDraftNMax === null)) {
    fail("spec fields 'spec_type' and 'spec_draft_n_max' must be set together");
  }
  if (specType !== null) flagToken(specType, "spec_type", /^[a-z][a-z0-9-]*$/);
  const reasoningFormat = opt("reasoning_format");
  const reasoning = opt("reasoning");
  if ((reasoningFormat === null) !== (reasoning === null)) {
    fail("spec fields 'reasoning_format' and 'reasoning' must be set together");
  }

  return {
    key: flagToken(get("key"), "key", /^[a-z0-9][a-z0-9.-]{0,63}$/),
    gguf: absolutePath(get("gguf"), "gguf"),
    runtimeBin: absolutePath(get("runtime_bin"), "runtime_bin"),
    ctx: boundedInt(Number(get("ctx")), "ctx", 1024, 1048576),
    ngl: boundedInt(Number(get("ngl")), "ngl", 0, 999),
    ubatch: boundedInt(Number(get("ubatch")), "ubatch", 1, 8192),
    np: optInt("np"),
    jinja: bool("jinja", true),
    fa,
    cacheRamMib: boundedInt(Number(get("cache_ram_mib")), "cache_ram_mib", 64, 65536),
    ctk: flagToken(get("ctk"), "ctk", KV_QUANT_RE),
    ctv: flagToken(get("ctv"), "ctv", KV_QUANT_RE),
    mmproj: opt("mmproj") === null ? null : absolutePath(opt("mmproj"), "mmproj"),
    imageMinTokens: optInt("image_min_tokens"),
    specType,
    specDraftNMax,
    reasoningFormat:
      reasoningFormat === null ? null : flagToken(reasoningFormat, "reasoning_format", /^[a-z]+$/),
    reasoning: reasoning === null ? null : flagToken(reasoning, "reasoning", /^[a-z]+$/),
    ttl: boundedInt(Number(get("ttl")), "ttl", 60, 86400),
  };
}

/**
 * Render one llama-swap model entry block in the exact house format (2-space key, `cmd: |`
 * stanza, `ttl:`), with the full modern flag set the retired minimal template could not
 * express. Field order mirrors the shipped qwen38-27b / ornith-1.5-35b entries so a rendered
 * candidate diffs cleanly against reviewed stanzas. Pure and deterministic.
 */
export function renderManualEntry(spec: ManualServingSpec): string {
  const lines = [
    `  "${spec.key}":`,
    `    cmd: |`,
    `      ${spec.runtimeBin}`,
    `      --host 127.0.0.1 --port \${PORT}`,
    `      -m ${spec.gguf}`,
  ];
  if (spec.mmproj !== null) lines.push(`      -mm ${spec.mmproj}`);
  if (spec.imageMinTokens !== null) lines.push(`      --image-min-tokens ${spec.imageMinTokens}`);
  lines.push(
    `      -ngl ${spec.ngl} -ub ${spec.ubatch} -c ${spec.ctx}` +
      (spec.np !== null ? ` -np ${spec.np}` : "") +
      (spec.jinja ? " --jinja" : "") +
      ` -fa ${spec.fa}`,
  );
  if (spec.specType !== null) {
    lines.push(`      --spec-type ${spec.specType} --spec-draft-n-max ${spec.specDraftNMax as number}`);
  }
  if (spec.reasoningFormat !== null) {
    lines.push(`      --reasoning-format ${spec.reasoningFormat} --reasoning ${spec.reasoning as string}`);
  }
  lines.push(`      --cache-ram ${spec.cacheRamMib} -ctk ${spec.ctk} -ctv ${spec.ctv}`);
  lines.push(`    ttl: ${spec.ttl}`);
  lines.push("");
  return lines.join("\n");
}

/** The set of model keys already present in a config.yaml (pure, regex on the `  "key":` lines). */
export function existingKeys(configText: string): Set<string> {
  const keys = new Set<string>();
  for (const m of configText.matchAll(/^\s{2}"([^"]+)":\s*$/gm)) keys.add(m[1]!);
  return keys;
}

/**
 * Safe to append a model entry at EOF? Only when `models:` is the LAST top-level key —
 * otherwise an appended 2-space-indented block would land under a later top-level map and
 * corrupt the config. No YAML parser dependency, so guard structurally and ABORT if unsafe.
 */
export function modelsIsLastTopLevel(configText: string): boolean {
  const topLevel = [...configText.matchAll(/^([A-Za-z][\w-]*):/gm)];
  const modelsIdx = topLevel.findIndex((m) => m[1] === "models");
  return modelsIdx >= 0 && modelsIdx === topLevel.length - 1;
}

export interface PromotionCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ManualPromotionDeps {
  readConfig: () => string;
  fileExists: (path: string) => boolean;
  writeBackup: (backupPath: string, content: string) => Promise<void>;
  applyConfig: (content: string) => Promise<void>;
  readBackConfig: () => string;
  restoreBackup: (backupPath: string) => Promise<void>;
  runCommand: (argv: string[]) => Promise<PromotionCommandResult>;
  modelsListed: () => Promise<string[]>;
  warmupModel: (key: string) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  maxServed?: number;
  restartCommand?: string[];
  listTimeoutMs?: number;
}

export interface ManualPromotionResult {
  key: string;
  backupPath: string;
  restored: boolean;
}

/**
 * Apply one hand-picked roster entry transactionally. Pre-write guards (existing key,
 * ceiling, structural safety, GGUF presence) fail before any backup is taken; once the
 * backup exists, ANY later failure restores the exact prior bytes and restarts the service
 * before the error surfaces. Never modifies an existing entry, never promotes two models.
 */
export async function applyManualPromotion(
  spec: ManualServingSpec,
  deps: ManualPromotionDeps,
): Promise<ManualPromotionResult> {
  const maxServed = deps.maxServed ?? PROMOTION_DEFAULTS.maxServed;
  const restartCommand = deps.restartCommand ?? PROMOTION_DEFAULTS.restartCommand.split(" ");
  const listTimeoutMs = deps.listTimeoutMs ?? 60_000;

  const configText = deps.readConfig();
  const keys = existingKeys(configText);
  if (keys.has(spec.key)) {
    fail(`refusing to modify existing entry '${spec.key}' — promotion is additive only`);
  }
  if (keys.size >= maxServed) {
    fail(`served-count ceiling reached (${keys.size}/${maxServed}) — prune the model list first`);
  }
  if (!modelsIsLastTopLevel(configText)) {
    fail("config has a top-level key after `models:` — refusing to append (would corrupt)");
  }
  if (!deps.fileExists(spec.gguf)) {
    fail(`served GGUF not present on disk: ${spec.gguf}`);
  }
  if (spec.mmproj !== null && !deps.fileExists(spec.mmproj)) {
    fail(`served mmproj not present on disk: ${spec.mmproj}`);
  }

  const entryBlock = renderManualEntry(spec);
  const newText = configText.endsWith("\n") ? configText + entryBlock : configText + "\n" + entryBlock;
  const stamp = deps
    .now()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..+$/, "");
  const backupPath = `manual-promotion-backup-${stamp}`;

  const rollback = async (cause: unknown): Promise<never> => {
    const msg = cause instanceof Error ? cause.message : String(cause);
    try {
      await deps.restoreBackup(backupPath);
    } catch (restoreError) {
      const detail = restoreError instanceof Error ? restoreError.message : String(restoreError);
      fail(`FAILED (${msg}) and rollback restore failed (${detail}) — inspect the service manually`);
    }
    try {
      const restarted = await deps.runCommand(restartCommand);
      if (restarted.code !== 0) throw new Error(`restart command exited ${restarted.code}`);
    } catch (restartError) {
      const detail = restartError instanceof Error ? restartError.message : String(restartError);
      fail(`FAILED (${msg}) and restart after rollback failed (${detail}) — inspect the service manually`);
    }
    fail(`FAILED (${msg}) — restored backup and restarted the service`);
  };

  await deps.writeBackup(backupPath, configText);
  try {
    await deps.applyConfig(newText);
    if (deps.readBackConfig() !== newText) {
      throw new Error("applied bytes differ from the rendered candidate");
    }
    const restart = await deps.runCommand(restartCommand);
    if (restart.code !== 0) throw new Error(`restart command exited ${restart.code}`);
    const deadline = Date.now() + listTimeoutMs;
    let listed = false;
    while (Date.now() < deadline) {
      try {
        if ((await deps.modelsListed()).includes(spec.key)) {
          listed = true;
          break;
        }
      } catch {
        // Service still coming up after restart — retry until deadline.
      }
      await deps.sleep(2000);
    }
    if (!listed) throw new Error(`'${spec.key}' did not appear in /v1/models within timeout`);
    await deps.warmupModel(spec.key);
  } catch (error) {
    await rollback(error);
  }
  return { key: spec.key, backupPath, restored: false };
}
