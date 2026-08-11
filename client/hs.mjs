#!/usr/bin/env node
/**
 * hs — Gille Inference CLI
 * Self-contained, zero external deps. Node 18+ (uses global fetch + streams).
 *
 * Config: ~/.config/hs/config.json  (chmod 0600)
 *   { "baseUrl": "https://inference.example.com", "key": "hs_..." }
 *
 * Commands:
 *   hs redeem <inv_code> [--url <base>]
 *   hs login  --url <base> --key <key>
 *   hs models
 *   hs ask    [-m <model>] [--system <s>] [sampling flags] <prompt...>
 *   hs usage
 *   hs whoami | hs config
 *   hs help
 */

/** CLI version — sent as User-Agent on every request to avoid Cloudflare BIC 403s. */
const HS_VERSION = "1.0.0";
const HS_UA = `hs-cli/${HS_VERSION}`;

import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ─── Config ──────────────────────────────────────────────────────────────────

const DEFAULT_BASE_URL = process.env["HS_BASE_URL"] ?? "http://127.0.0.1:8080";

/**
 * @param {string} [configDir]
 * @returns {string}
 */
function configPath(configDir) {
  return join(configDir ?? join(homedir(), ".config", "hs"), "config.json");
}

/**
 * @param {string} [configDir]
 * @returns {{ baseUrl: string; key: string } | null}
 */
export function loadConfig(configDir) {
  const p = configPath(configDir);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/**
 * @param {{ baseUrl: string; key: string }} cfg
 * @param {string} [configDir]
 */
export function saveConfig(cfg, configDir) {
  const dir = configDir ?? join(homedir(), ".config", "hs");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "config.json");
  writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n", { encoding: "utf8" });
  try { chmodSync(p, 0o600); } catch { /* ignore on platforms that don't support it */ }
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

/**
 * @param {Response} res
 * @returns {Promise<{ message: string; code?: string; retryAfter?: string }>}
 */
async function extractError(res) {
  // Capture Retry-After (sent on 429 / 503 / 504) so the caller can show "retry in Ns".
  const retryAfter = res.headers?.get?.("retry-after") ?? undefined;
  try {
    const j = /** @type {any} */ (await res.json());
    if (j?.error?.message) return { message: j.error.message, code: j.error.code, retryAfter };
    return { message: JSON.stringify(j), retryAfter };
  } catch {
    return { message: `HTTP ${res.status} ${res.statusText}`, retryAfter };
  }
}

// ─── Commands ────────────────────────────────────────────────────────────────

/**
 * POST /portal/redeem — unauthenticated.
 * @param {{ code: string; baseUrl?: string; configDir?: string; fetch?: typeof globalThis.fetch }} opts
 */
export async function redeem({ code, baseUrl = DEFAULT_BASE_URL, configDir, fetch: f = globalThis.fetch }) {
  const url = `${baseUrl}/portal/redeem`;
  const res = await f(url, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": HS_UA },
    body: JSON.stringify({ code }),
  });

  if (!res.ok) {
    const err = await extractError(res);
    throw Object.assign(new Error(err.message), { httpStatus: res.status, code: err.code, retryAfter: err.retryAfter });
  }

  const j = /** @type {{ key: string; alias?: string; model?: string; models?: string[]; tier?: string; creditLimit?: number }} */ (await res.json());

  saveConfig({ baseUrl, key: j.key }, configDir);

  return j;
}

/**
 * Store config manually (login).
 * @param {{ baseUrl: string; key: string; configDir?: string }} opts
 */
export function login({ baseUrl, key, configDir }) {
  saveConfig({ baseUrl, key }, configDir);
}

/**
 * GET /v1/models → string[]
 * @param {{ configDir?: string; fetch?: typeof globalThis.fetch }} [opts]
 * @returns {Promise<string[]>}
 */
export async function listModels({ configDir, fetch: f = globalThis.fetch } = {}) {
  const cfg = loadConfig(configDir);
  if (!cfg) throw new Error("Run `hs redeem <code>` or `hs login` first.");

  const res = await f(`${cfg.baseUrl}/v1/models`, {
    headers: { authorization: `Bearer ${cfg.key}`, "user-agent": HS_UA },
  });

  if (!res.ok) {
    const err = await extractError(res);
    throw Object.assign(new Error(err.message), { httpStatus: res.status, code: err.code, retryAfter: err.retryAfter });
  }

  const j = /** @type {{ data: { id: string }[] }} */ (await res.json());
  return (j.data ?? []).map((m) => m.id);
}

/**
 * POST /v1/chat/completions with stream:true — streams tokens to out.
 * Returns the full concatenated content string.
 *
 * SSE parsing: reads the response body as a ReadableStream, splits on double-newline,
 * finds lines starting with "data: ", parses JSON, extracts choices[0].delta.content,
 * stops on "data: [DONE]".
 *
 * @param {{ prompt: string; model?: string; system?: string; maxTokens?: number; temperature?: number; topP?: number; topK?: number; minP?: number; configDir?: string; fetch?: typeof globalThis.fetch; out?: { write: (s: string) => void } }} opts
 * @returns {Promise<string>}
 */
export async function ask({ prompt, model, system, maxTokens, temperature, topP, topK, minP, configDir, fetch: f = globalThis.fetch, out = process.stdout }) {
  const cfg = loadConfig(configDir);
  if (!cfg) throw new Error("Run `hs redeem <code>` or `hs login` first.");

  const samplerSpecs = [
    ["temperature", temperature, 0, 2, false],
    ["top_p", topP, 0, 1, false],
    ["top_k", topK, 0, Number.MAX_SAFE_INTEGER, true],
    ["min_p", minP, 0, 1, false],
    ["max_tokens", maxTokens, 1, Number.MAX_SAFE_INTEGER, true],
  ];
  for (const [name, value, min, max, integer] of samplerSpecs) {
    if (value === undefined) continue;
    if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
      throw new Error(`${name} must be ${integer ? "an integer" : "a number"} in [${min}, ${max}].`);
    }
  }

  // If no model specified, discover the first available one.
  let resolvedModel = model;
  if (!resolvedModel) {
    const models = await listModels({ configDir, fetch: f });
    if (models.length === 0) throw new Error("No models available on this server.");
    resolvedModel = models[0];
  }

  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: prompt });

  const res = await f(`${cfg.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${cfg.key}`,
      "user-agent": HS_UA,
    },
    body: JSON.stringify({
      model: resolvedModel,
      messages,
      stream: true,
      ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
      ...(topP !== undefined ? { top_p: topP } : {}),
      ...(topK !== undefined ? { top_k: topK } : {}),
      ...(minP !== undefined ? { min_p: minP } : {}),
    }),
  });

  if (!res.ok) {
    const err = await extractError(res);
    throw Object.assign(new Error(err.message), { httpStatus: res.status, code: err.code, retryAfter: err.retryAfter });
  }

  if (!res.body) throw new Error("No response body.");

  let accumulated = "";
  let buf = "";
  let done = false;
  // R6: a TERMINAL error frame ( data: {"error":{...}} ) can arrive MID-STREAM when the upstream
  // truncates after streaming began (the gateway emits it before [DONE]). We surface that as a
  // clear thrown error AFTER flushing whatever partial content already streamed — so the user
  // never silently gets a half-answer that looks complete.
  /** @type {{ message: string; code?: string } | null} */
  let streamError = null;

  /** Handle one "data:" payload: stream a delta, detect a terminal error frame, or [DONE]. */
  const handleData = (/** @type {string} */ data) => {
    if (data === "[DONE]") return "done";
    let chunk;
    try {
      chunk = JSON.parse(data);
    } catch {
      return null; // ignore malformed SSE lines
    }
    if (chunk?.error) {
      streamError = {
        message:
          typeof chunk.error.message === "string"
            ? chunk.error.message
            : "The model response was truncated. Please retry.",
        code: chunk.error.code,
      };
      return "done";
    }
    const token = chunk?.choices?.[0]?.delta?.content;
    if (typeof token === "string" && token.length > 0) {
      out.write(token);
      accumulated += token;
    }
    return null;
  };

  const decoder = new TextDecoder();
  const reader = res.body.getReader();

  while (!done) {
    const { done: streamDone, value } = await reader.read();
    if (streamDone) break;

    buf += decoder.decode(value, { stream: true });

    // SSE events are delimited by double newline (\n\n or \r\n\r\n)
    // We split on \n\n and process complete events
    const parts = buf.split(/\n\n/);
    // The last part may be incomplete — keep it in buf
    buf = parts.pop() ?? "";

    for (const event of parts) {
      for (const line of event.split("\n")) {
        const trimmed = line.startsWith("data: ") ? line.slice(6) : null;
        if (trimmed === null) continue;
        if (handleData(trimmed.trim()) === "done") { done = true; break; }
      }
      if (done) break;
    }
  }

  // Process any remaining buffer content after stream ends
  if (!done && buf) {
    for (const line of buf.split("\n")) {
      const trimmed = line.startsWith("data: ") ? line.slice(6) : null;
      if (trimmed === null) continue;
      if (handleData(trimmed.trim()) === "done") break;
    }
  }

  out.write("\n");

  // If the stream carried a terminal error frame, raise it now (partial content was already shown).
  if (streamError) {
    throw Object.assign(new Error(streamError.message), { code: streamError.code, midStream: true });
  }

  return accumulated;
}

/**
 * GET /portal/me → usage info.
 * @param {{ configDir?: string; fetch?: typeof globalThis.fetch }} [opts]
 * @returns {Promise<{ tier: string; models: string[]; creditsUsed: number; creditLimit: number }>}
 */
export async function usage({ configDir, fetch: f = globalThis.fetch } = {}) {
  const cfg = loadConfig(configDir);
  if (!cfg) throw new Error("Run `hs redeem <code>` or `hs login` first.");

  const res = await f(`${cfg.baseUrl}/portal/me`, {
    headers: { authorization: `Bearer ${cfg.key}`, "user-agent": HS_UA },
  });

  if (!res.ok) {
    const err = await extractError(res);
    throw Object.assign(new Error(err.message), { httpStatus: res.status, code: err.code, retryAfter: err.retryAfter });
  }

  return /** @type {any} */ (await res.json());
}

// ─── CLI arg parsing ──────────────────────────────────────────────────────────

/**
 * Simple hand-rolled arg parser.
 * @param {string[]} argv
 * @returns {{ flags: Map<string, string | true>; positional: string[] }}
 */
function parseArgs(argv) {
  /** @type {Map<string, string | true>} */
  const flags = new Map();
  /** @type {string[]} */
  const positional = [];

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        flags.set(key, next);
        i += 2;
      } else {
        flags.set(key, true);
        i += 1;
      }
    } else if (arg.startsWith("-") && arg.length === 2) {
      const key = arg.slice(1);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        flags.set(key, next);
        i += 2;
      } else {
        flags.set(key, true);
        i += 1;
      }
    } else {
      positional.push(arg);
      i += 1;
    }
  }

  return { flags, positional };
}

function numericFlag(flags, name) {
  const raw = flags.get(name);
  if (raw === undefined) return undefined;
  if (raw === true) throw new Error(`--${name} requires a numeric value.`);
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`--${name} requires a numeric value.`);
  return value;
}

function printHelp() {
  process.stdout.write(
    "hs — Gille Inference CLI\n" +
    "\n" +
    "Usage:\n" +
    "  hs redeem <inv_code> [--url <base>]   Redeem an invite code and save your key\n" +
    "  hs login --url <base> --key <key>     Store credentials manually\n" +
    "  hs models                             List available model IDs\n" +
    "  hs ask [-m <model>] [--system <s>] [--max-tokens N]\n" +
    "         [--temperature N] [--top-p N] [--top-k N] [--min-p N] <prompt...>\n" +
    "                                        Stream a chat completion to stdout\n" +
    "  hs usage                              Show your tier, models, and credit usage\n" +
    "  hs whoami                             Show stored baseUrl and masked key\n" +
    "  hs help                               Show this help\n" +
    "\n" +
    "Config: ~/.config/hs/config.json (chmod 0600)\n" +
    '  { "baseUrl": "https://inference.example.com", "key": "hs_..." }\n' +
    "Set HS_BASE_URL or pass --url when redeeming; example.com is documentation only.\n"
  );
}

/**
 * Main CLI dispatcher.
 * @param {string[]} argv  — process.argv.slice(2) or equivalent
 */
export async function main(argv) {
  const { flags, positional } = parseArgs(argv);

  const command = positional[0];

  if (!command || command === "help" || flags.has("help") || flags.has("h")) {
    printHelp();
    return;
  }

  try {
    switch (command) {
      case "redeem": {
        const code = positional[1];
        if (!code) {
          process.stderr.write("Error: invite code required. Usage: hs redeem <inv_code>\n");
          process.exit(1);
        }
        const baseUrl = /** @type {string | undefined} */ (flags.get("url")) ?? DEFAULT_BASE_URL;
        const result = await redeem({ code, baseUrl });
        const models = result.models ?? (result.model ? [result.model] : []);
        process.stdout.write(`Redeemed. Key stored to ~/.config/hs/config.json\n`);
        process.stdout.write(`Key:    ${result.key}\n`);
        if (result.alias) process.stdout.write(`Alias:  ${result.alias}\n`);
        if (result.tier) process.stdout.write(`Tier:   ${result.tier}\n`);
        if (models.length > 0) process.stdout.write(`Models: ${models.join(", ")}\n`);
        if (result.creditLimit !== undefined) {
          process.stdout.write(
            `Credits: ${result.creditLimit === 0 ? "unlimited" : result.creditLimit}\n`
          );
        }
        break;
      }

      case "login": {
        const url = /** @type {string | undefined} */ (flags.get("url"));
        const key = /** @type {string | undefined} */ (flags.get("key"));
        if (!url || !key) {
          process.stderr.write("Error: --url and --key are required. Usage: hs login --url <base> --key <key>\n");
          process.exit(1);
        }
        login({ baseUrl: url, key });
        process.stdout.write(`Credentials stored. Base URL: ${url}\n`);
        break;
      }

      case "models": {
        const ids = await listModels();
        if (ids.length === 0) {
          process.stdout.write("(no models available)\n");
        } else {
          process.stdout.write(ids.join("\n") + "\n");
        }
        break;
      }

      case "ask": {
        const model = /** @type {string | undefined} */ (flags.get("m") ?? flags.get("model"));
        const system = /** @type {string | undefined} */ (flags.get("system"));
        const maxTokens = numericFlag(flags, "max-tokens");
        const temperature = numericFlag(flags, "temperature");
        const topP = numericFlag(flags, "top-p");
        const topK = numericFlag(flags, "top-k");
        const minP = numericFlag(flags, "min-p");
        const promptParts = positional.slice(1);
        if (promptParts.length === 0) {
          process.stderr.write("Error: prompt required. Usage: hs ask [-m <model>] [--system <s>] <prompt...>\n");
          process.exit(1);
        }
        const prompt = promptParts.join(" ");
        await ask({ prompt, model, system, maxTokens, temperature, topP, topK, minP });
        break;
      }

      case "usage": {
        const info = await usage();
        const limitStr = info.creditLimit === 0 ? "unlimited" : String(info.creditLimit);
        process.stdout.write(`Tier:         ${info.tier}\n`);
        if (info.models?.length > 0) {
          process.stdout.write(`Models:       ${info.models.join(", ")}\n`);
        }
        process.stdout.write(`Credits used: ${info.creditsUsed} / ${limitStr}\n`);
        break;
      }

      case "whoami":
      case "config": {
        const cfg = loadConfig();
        if (!cfg) {
          process.stderr.write("No config found. Run `hs redeem <code>` or `hs login` first.\n");
          process.exit(1);
        }
        const maskedKey =
          cfg.key.length > 12 ? cfg.key.slice(0, 12) + "…" : cfg.key.slice(0, 4) + "…";
        process.stdout.write(`Base URL: ${cfg.baseUrl}\n`);
        process.stdout.write(`Key:      ${maskedKey}\n`);
        break;
      }

      default:
        process.stderr.write(`Unknown command: ${command}\n`);
        printHelp();
        process.exit(1);
    }
  } catch (/** @type {any} */ err) {
    const status = err.httpStatus;
    // "retry in Ns" suffix when the server sent a Retry-After (429 / 503 / 504).
    const retry = err.retryAfter ? ` (retry in ${err.retryAfter}s)` : "";
    if (status === 401 || status === 403) {
      process.stderr.write(`Auth error: ${err.message}\n`);
    } else if (status === 402) {
      process.stderr.write(`Credits exhausted: ${err.message}\n`);
    } else if (status === 429) {
      process.stderr.write(`Rate limited: ${err.message}${retry}\n`);
    } else if (status === 503) {
      // Box busy — distinct, transient, retryable.
      process.stderr.write(`Server busy: ${err.message}${retry}\n`);
    } else if (status === 502) {
      // Model backend down — distinct from a 500.
      process.stderr.write(`Backend unavailable: ${err.message}${retry}\n`);
    } else if (status === 504) {
      // Model backend timed out (often a cold model load) — retryable.
      process.stderr.write(`Backend timeout: ${err.message}${retry}\n`);
    } else if (err.midStream) {
      // The response began streaming, then was truncated by a terminal error frame.
      process.stderr.write(`Stream truncated: ${err.message}\n`);
    } else {
      process.stderr.write(`Error: ${err.message}${retry}\n`);
    }
    process.exit(1);
  }
}

// Guard: only execute when run directly (not when imported for tests)
const isMain =
  typeof process !== "undefined" &&
  process.argv[1] != null &&
  (process.argv[1].endsWith("/hs.mjs") || process.argv[1].endsWith("/hs"));

if (isMain) {
  main(process.argv.slice(2));
}
