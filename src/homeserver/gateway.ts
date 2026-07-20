import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual, createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { clampMaxTokensForModel, loadConfig, type HomeserverConfig } from "./config.js";
import { listModels, loadModel, unloadModel, downloadModel } from "./model-admin.js";
import { delegate } from "./orchestrator.js";
import type { Verifier } from "./verifier.js";
import { buildVerifier, isVerifierBuildError } from "./verifier-registry.js";
import type { ResponseFormat } from "../runner/openrouter-client.js";
import { ledgerReport, recentDelegations, getDelegationById } from "./ledger.js";
import { resetRoutingTable, loadRoutingTable } from "./routing-table.js";
import { parseHuginExperimentOutcomeBundle, importHuginExperimentOutcome } from "./experiment-import.js";
import {
  lookupKey,
  mintKey,
  revokeKey,
  listKeys,
  redeemInvite,
  reserveCredits,
  reconcileCredits,
  recordUsage as recordCreditUsage,
  KeyAliasExistsError,
  InviteInvalidError,
  InvalidParamError,
  type Tier,
} from "./keystore.js";
import { checkQuota, recordUsage, checkRateWindow, type QuotaLimits, type QuotaReservation } from "./quota.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { AdmissionController, AdmissionRejected, type Lane } from "./admission.js";
import { makeError, sendError, classifyUpstreamError } from "./errors.js";
import { createAccessLogger, setDefaultLogger, defaultLogger } from "./access-log.js";
import { handleMcpPost } from "./mcp.js";
import { execFile } from "node:child_process";
import { sweepCodeLoopSandboxes } from "./code-loop.js";
import { recordRequest, recordAdmissionRejection, recordRateLimited, recordTtft, recordAudioSeconds, recordImagesGenerated, recordDegeneracyDetected, inflightInc, inflightDec, renderMetrics } from "./metrics.js";
import { recordFeedback } from "./feedback.js";
import { modelEvalsPayload } from "./model-evals-portal.js";
import { poisonClearOnDisconnect, requestPoisonClear } from "./poison-clear.js";
import { DegeneracyWatchdog } from "./degeneracy-watchdog.js";
import { recordOwnerRequest } from "./owner-log.js";
import { recordRequestLog, cachedRequestLogTotals } from "./request-log.js";
import { canonicalizeModelTrusted, warmCatalogue } from "./catalogue.js";
import { isComputeNodeId, orinEnabled, probeOrin, runOrinChat } from "./nodes.js";
import { parseMultipart } from "./multipart.js";
import { parseImageRequest, isImageRequestError, IMAGE_MODEL_IDS, type ParsedImageRequest } from "./image-request.js";
import { generateImages, ImageSidecarError } from "./image-sidecar.js";
import {
  startImageWorker,
  submitImageJob,
  getImageJob,
  cancelImageJob,
  type ImageJobSubmission,
} from "./image-jobs.js";
import {
  initializeTaskExposureRegistry,
  lookupTaskExposures,
  parseTaskExposureLookupRequest,
  recordMessageTaskExposuresBestEffort,
  recordExternalProducerHeartbeat,
} from "./task-exposure.js";
import { ingestExposureReceipt } from "./exposure-receipt-intake.js";
import { exposureReceiptSurfaceSchema } from "./exposure-receipt-schema.js";
import {
  LEARNING_TASK_PREFLIGHT_ENDPOINT,
  LEARNING_TASK_PREFLIGHT_TTL_MS,
  LearningTaskContractError,
  createLearningTaskGatewayEcho,
  createLearningTaskCapabilityEpoch,
  learningTaskObservedRequestFingerprint,
  parseHuginRequestStamp,
  validateHuginRequestStamp,
  type HuginRequestStamp,
  type LearningTaskGatewayEcho,
  type LearningTaskCapabilityEpoch,
} from "./learning-task-contract.js";
import {
  claimLearningTaskAdmission,
  lookupLearningTaskAdmission,
} from "./learning-task-admission-store.js";

/**
 * Authenticated LAN gateway — the "endpoint with suitable auth" that sits in front of
 * LM Studio. LM Studio's own server ignores its API key, so this gateway is what makes
 * the box safe to plug into the router:
 *
 *   • per-key bearer-token auth (keystore) with a legacy static-key fallback
 *   • two-lane admission control (owner preempts guest under GPU contention)
 *   • per-key RPM / TPM / daily-token quotas
 *   • a uniform OpenAI-shaped error envelope on every auth / inference failure
 *   • OpenAI-compatible /v1/chat/completions proxy + /delegate orchestrated path
 *   • /admin/models/* + /admin/keys* (mint / list / revoke)
 *   • /ledger, /healthz, /models (read-only)
 *
 * Safety default: it refuses to bind a non-loopback host with no API keys configured —
 * you cannot accidentally expose an unauthenticated endpoint to the LAN.
 */

// ─── Principal resolution ──────────────────────────────────────────────────────────

interface PrincipalContext {
  alias: string;
  tier: Tier;
  isAdmin: boolean;
  /** Read-only monitoring principal — limited to GET /healthz, /ledger, /metrics, /models. */
  isMonitor?: boolean;
  modelAllowList: string[];
  limits: QuotaLimits;
  maxParallel: number;
  /**
   * sha256(token) for a minted store key — the handle credit accounting keys on. null for
   * legacy static keys / implicit-admin (which have no per-key credit row).
   */
  keyHash: string | null;
  /** Lifetime credit cap snapshot (0 = unlimited). null when there is no credit row. */
  creditLimit: number;
  creditsUsed: number;
}

function keyMatches(provided: string, keys: string[]): boolean {
  if (keys.length === 0) return false;
  const ph = createHash("sha256").update(provided).digest();
  return keys.some((k) => timingSafeEqual(ph, createHash("sha256").update(k).digest()));
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers["authorization"] ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(Array.isArray(header) ? header[0] ?? "" : header);
  return m ? m[1]!.trim() : null;
}

/**
 * Resolve a request to a principal. The keystore is the primary path; the legacy static
 * keys are a fallback so existing deployments keep working. Returns null on no/invalid key.
 */
/**
 * Whether a no-token request may be granted implicit owner/admin. SAFE ONLY on a
 * loopback bind with truly zero credentials of any kind (no legacy env keys AND no
 * minted store keys). Computed ONCE at startup and frozen by startGateway() — never on
 * a LAN/internet bind, and not re-derived per request — so it cannot fail open if keys
 * are later revoked or expire while a 0.0.0.0/Tunnel-bound server is running.
 */
export function isImplicitAdminAllowed(cfg: HomeserverConfig, loopback: boolean): boolean {
  return (
    loopback &&
    cfg.apiKeys.length === 0 &&
    cfg.adminApiKeys.length === 0 &&
    cfg.monitorApiKeys.length === 0 &&
    listKeys().length === 0
  );
}

function resolvePrincipal(
  req: IncomingMessage,
  cfg: HomeserverConfig,
  implicitAdminAllowed: boolean
): PrincipalContext | null {
  const token = bearerToken(req);
  if (!token) {
    // Implicit-admin (no-token) is granted only when the startup-frozen posture permits
    // it (loopback + zero credentials). See isImplicitAdminAllowed().
    if (implicitAdminAllowed) {
      return {
        alias: "static:admin",
        tier: "owner",
        isAdmin: true,
        modelAllowList: [],
        limits: keyLimits(cfg),
        maxParallel: cfg.keyDefaults.maxParallel,
        keyHash: null,
        creditLimit: 0,
        creditsUsed: 0,
      };
    }
    return null;
  }

  // (1) keystore
  const rec = lookupKey(token);
  if (rec) {
    return {
      alias: rec.alias,
      tier: rec.tier,
      isAdmin: rec.tier === "owner",
      modelAllowList: rec.modelAllowList,
      limits: { rpm: rec.rpm, tpm: rec.tpm, dailyTokenBudget: rec.dailyTokenBudget },
      maxParallel: rec.maxParallel,
      keyHash: rec.keyHash,
      creditLimit: rec.creditLimit,
      creditsUsed: rec.creditsUsed,
    };
  }

  // (2) legacy admin static key
  if (keyMatches(token, cfg.adminApiKeys)) {
    return {
      alias: "static:admin",
      tier: "owner",
      isAdmin: true,
      modelAllowList: [],
      limits: keyLimits(cfg),
      maxParallel: cfg.keyDefaults.maxParallel,
      keyHash: null,
      creditLimit: 0,
      creditsUsed: 0,
    };
  }

  // (3) legacy user static key
  if (keyMatches(token, cfg.apiKeys)) {
    return {
      alias: "static:user",
      tier: "guest",
      isAdmin: false,
      modelAllowList: [],
      limits: keyLimits(cfg),
      maxParallel: cfg.keyDefaults.maxParallel,
      keyHash: null,
      creditLimit: 0,
      creditsUsed: 0,
    };
  }

  // (4) legacy monitor static key — a read-only monitoring scope (e.g. Heimdall's dashboard).
  // isAdmin stays false (admin gating is unaffected); the request handler restricts this
  // principal to GET /healthz, /ledger, /metrics and 403s everything else.
  if (keyMatches(token, cfg.monitorApiKeys)) {
    return {
      alias: "static:monitor",
      tier: "guest",
      isAdmin: false,
      isMonitor: true,
      modelAllowList: [],
      limits: keyLimits(cfg),
      maxParallel: cfg.keyDefaults.maxParallel,
      keyHash: null,
      creditLimit: 0,
      creditsUsed: 0,
    };
  }

  return null;
}

function keyLimits(cfg: HomeserverConfig): QuotaLimits {
  return {
    rpm: cfg.keyDefaults.rpm,
    tpm: cfg.keyDefaults.tpm,
    dailyTokenBudget: cfg.keyDefaults.dailyTokenBudget,
  };
}

// ─── Per-key in-flight tracking ──────────────────────────────────────────────────────

const keyInflight = new Map<string, number>();

function incInflight(alias: string): void {
  keyInflight.set(alias, (keyInflight.get(alias) ?? 0) + 1);
}
function decInflight(alias: string): void {
  const n = (keyInflight.get(alias) ?? 1) - 1;
  if (n <= 0) keyInflight.delete(alias);
  else keyInflight.set(alias, n);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────────

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}

// ─── Portal HTML (self-service invite → key page) ──────────────────────────────────

const PORTAL_HTML_PATH = join(dirname(fileURLToPath(import.meta.url)), "portal.html");
let _portalHtml: string | null = null;

/**
 * Load the portal page. Cached after the first read (it is a static asset that ships with
 * the gateway). The page is fully self-contained — inline CSS/JS, no external assets — so it
 * works behind Tailscale / Cloudflare with no CDN dependency.
 */
function portalHtml(): string {
  if (_portalHtml === null) _portalHtml = readFileSync(PORTAL_HTML_PATH, "utf-8");
  return _portalHtml;
}

// ─── hs CLI (client/hs.mjs — served unauthenticated so friends can install before they have a key) ──

// hs.mjs lives two levels up from src/homeserver/ → repo root / client / hs.mjs.
// __dirname equivalent is the directory of this compiled/source file; step back to repo root.
const HS_MJS_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "client", "hs.mjs");
let _hsMjs: string | null = null;

/**
 * Load the hs CLI. Cached after the first read (static asset — never changes at runtime).
 * This file is served unauthenticated at GET /hs (and alias GET /client/hs.mjs) so friends
 * can install it before they have a key, without needing public GitHub repo access.
 */
function hsMjs(): string {
  if (_hsMjs === null) _hsMjs = readFileSync(HS_MJS_PATH, "utf-8");
  return _hsMjs;
}

function sendJs(res: ServerResponse, status: number, js: string): void {
  res.writeHead(status, {
    "content-type": "text/javascript; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(js);
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  // Hardening (Fix #7): tell the browser not to sniff the content type, and a tight CSP so the
  // self-contained portal page (inline CSS/JS only, no external assets) cannot pull or execute
  // anything off-origin. no-store keeps the unauthenticated page out of shared caches.
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
  });
  res.end(html);
}

/**
 * Best-effort client IP for the per-IP public-surface throttle. Behind Cloudflare the real
 * client IP is in CF-Connecting-IP (the socket address is Cloudflare's edge). Fall back to the
 * raw socket address when that header is absent (direct LAN access). "unknown" is a single
 * shared bucket — fine as a conservative default (it only over-throttles).
 */
/** Strip an IPv4-mapped-IPv6 prefix so ::ffff:127.0.0.1 compares as 127.0.0.1. */
function normalizeIp(ip: string): string {
  return ip.startsWith("::ffff:") ? ip.slice("::ffff:".length) : ip;
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    n = ((n << 8) | octet) >>> 0;
  }
  return n;
}

/** True if `ip` is inside `entry` (an IPv4 CIDR) or exactly equals it (any family). */
function ipInCidr(ip: string, entry: string): boolean {
  const e = normalizeIp(entry.trim());
  if (e === "") return false;
  if (e === ip) return true; // exact match — covers ::1 and a bare IPv4
  const slash = e.indexOf("/");
  if (slash === -1) return false;
  const bits = Number(e.slice(slash + 1));
  const ipInt = ipv4ToInt(ip);
  const rangeInt = ipv4ToInt(e.slice(0, slash));
  if (ipInt === null || rangeInt === null || !Number.isInteger(bits) || bits < 0 || bits > 32) {
    return false;
  }
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipInt & mask) === (rangeInt & mask);
}

/** True only when the immediate socket peer is a configured trusted reverse proxy. */
export function isTrustedProxy(remoteAddr: string, trusted: string[]): boolean {
  const ip = normalizeIp(remoteAddr);
  return trusted.some((entry) => ipInCidr(ip, entry));
}

/**
 * Resolve the rate-limit client identity. A forwarded client-IP header (CF-Connecting-IP)
 * is honored ONLY when the immediate socket peer is a trusted reverse proxy (e.g. the local
 * cloudflared tunnel); otherwise it is attacker-controlled and would let a client forge a fresh
 * rate-limit bucket per request — so we key on the real socket address. "unknown" is a single
 * conservative bucket (only over-throttles).
 */
export function clientIp(req: IncomingMessage, trustedProxies: string[]): string {
  const remote = req.socket.remoteAddress ?? "unknown";
  if (remote !== "unknown" && isTrustedProxy(remote, trustedProxies)) {
    const cf = req.headers["cf-connecting-ip"];
    const hdr = Array.isArray(cf) ? cf[0] : cf;
    if (typeof hdr === "string" && hdr.trim() !== "") return hdr.trim();
  }
  return normalizeIp(remote);
}

async function readBody(req: IncomingMessage, maxBytes = 4 * 1024 * 1024): Promise<string> {
  // Early rejection on a declared Content-Length over the cap (mirrors readBuffer) — do NOT destroy
  // the socket: the caller must stay able to write the 413 response. resume() drains in-flight bytes.
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) {
    req.resume();
    return Promise.reject(new BodyTooLargeError());
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      if (settled) return;
      size += c.length;
      if (size > maxBytes) {
        // #15 / Codex finding 2: typed so the top-level catch maps it to a uniform 413 envelope.
        // Stop buffering and reject, but keep the connection WRITABLE so the 413 can be sent — the
        // old req.destroy() here raced the response write and the client saw a connection reset.
        // resume() drains the rest of the upload instead of destroying the socket.
        settled = true;
        chunks.length = 0;
        req.resume();
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf-8"));
    });
    req.on("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

/** Thrown by readBuffer when the body exceeds the size cap — caller maps it to HTTP 413. */
class BodyTooLargeError extends Error {
  constructor() {
    super("request body too large");
    this.name = "BodyTooLargeError";
  }
}

/**
 * Read the request body as a raw Buffer (BINARY-SAFE — never decodes to utf-8). Used for the
 * multipart audio upload, where a utf-8 round-trip would corrupt the audio bytes.
 *
 * Hardening (DoS):
 *   • A declared Content-Length above `maxBytes` is rejected up-front (before buffering a single
 *     byte) — a malicious client cannot make us allocate by lying about a small body.
 *   • The actual streamed size is still capped during read (a chunked/unknown-length body, or a
 *     client whose body exceeds its own Content-Length, is aborted the moment it crosses the cap).
 *   • An idle-read timeout (`idleMs`) drops a slow-loris client that opens the connection and
 *     dribbles (or sends nothing): if no data arrives for idleMs, the socket is destroyed.
 *
 * Both the up-front and mid-stream over-cap cases reject with BodyTooLargeError so the caller can
 * return a distinct 413 (payload_too_large) rather than a generic 400.
 */
async function readBuffer(
  req: IncomingMessage,
  maxBytes = 32 * 1024 * 1024,
  idleMs = 30_000
): Promise<Buffer> {
  // Early rejection on a declared Content-Length over the cap — before buffering anything. We do
  // NOT destroy the socket here: the caller still has to write a 413 response, which requires the
  // connection to stay writable. resume() drains any in-flight body bytes so the socket is not held.
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) {
    req.resume();
    return Promise.reject(new BodyTooLargeError());
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    let settled = false;
    let idle: NodeJS.Timeout | null = null;
    const clearIdle = (): void => {
      if (idle) {
        clearTimeout(idle);
        idle = null;
      }
    };
    const armIdle = (): void => {
      clearIdle();
      idle = setTimeout(() => {
        if (settled) return;
        settled = true;
        // A slow-loris that never finishes: there is no clean response to send, so drop the socket.
        req.destroy();
        reject(new Error("request body read timed out"));
      }, idleMs);
    };
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      clearIdle();
      reject(err);
    };
    armIdle();
    req.on("data", (c: Buffer) => {
      if (settled) return;
      armIdle(); // reset the idle clock on every chunk
      size += c.length;
      if (size > maxBytes) {
        settled = true;
        clearIdle();
        // Stop buffering and reject, but keep the connection writable so the caller can send a 413.
        // Drop our reference to the buffered chunks and drain the rest of the upload.
        chunks.length = 0;
        req.resume();
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      clearIdle();
      resolve(Buffer.concat(chunks));
    });
    req.on("error", fail);
  });
}

/** Estimate request token cost: prompt chars/4 + the (capped) max_tokens reservation. */
function estimateTokens(rawBody: string, effectiveMax: number): number {
  return Math.ceil(rawBody.length / 4) + effectiveMax;
}

interface ParsedChatBody {
  obj: Record<string, unknown>;
  model: string | null;
  requestedMax: number | null;
  stream: boolean;
  node: unknown;
}

function parseChatBody(raw: string): ParsedChatBody {
  const obj = JSON.parse(raw) as Record<string, unknown>;
  const model = typeof obj["model"] === "string" ? (obj["model"] as string) : null;
  const mt = obj["max_tokens"] ?? obj["maxTokens"];
  const requestedMax = typeof mt === "number" ? mt : null;
  const stream = obj["stream"] === true;
  return { obj, model, requestedMax, stream, node: obj["node"] };
}

// ─── Spine wrapper ─────────────────────────────────────────────────────────────────

/**
 * Logging-aware spine wrapper: same semantics as admitAndMeter but also updates the
 * per-request LogCtx with admission outcome, quota/busy error class, token counts,
 * and status. The LogCtx is emitted by handleRequest's finally block.
 *
 * handleChatProxy and handleDelegate return the actual token count used; for admission
 * and quota rejections the token count remains null (no inference ran).
 */
async function admitAndMeterLogged(
  res: ServerResponse,
  cfg: HomeserverConfig,
  controller: AdmissionController,
  principal: PrincipalContext,
  requestedModel: string | null,
  estTokens: number,
  lctx: LogCtx,
  handler: () => Promise<MeteredResult>
): Promise<void> {
  // Lifetime credit cap (non-resetting). Refuse BEFORE any inference if the key has spent
  // its budget. Distinct from the daily-resetting quota below: this never frees up on its own.
  //
  // Done as an ATOMIC conditional reservation, not a snapshot read: the principal's
  // creditsUsed was read at auth time and could be stale, and two concurrent requests could
  // both pass a snapshot gate then both accrue real usage, overspending the cap (MEDIUM-1/2).
  // reserveCredits() debits `reserve` in a single conditional UPDATE that only succeeds while
  // the key is still under its limit; SQLite serializes the writes, so the cap holds under
  // concurrency. We reconcile reserve→real after the call. keyHash null = no credit row
  // (legacy static / implicit-admin) → skip; those are uncapped by design.
  const creditReserve = estTokens;
  let creditReserved = false;
  if (principal.keyHash !== null && principal.creditLimit > 0) {
    if (!reserveCredits(principal.keyHash, creditReserve).ok) {
      lctx.status = 402;
      lctx.outcome = "credits_exhausted";
      lctx.errorClass = "credits_exhausted";
      lctx.admission = "n/a";
      sendError(res, makeError("credits_exhausted"));
      return;
    }
    creditReserved = true;
  }

  // Unwind the credit reservation on any pre-inference rejection below (allow-list / quota /
  // busy): reconcile reserve→0 so a request that never ran is not charged. Idempotent.
  const releaseReserve = (): void => {
    if (creditReserved) {
      reconcileCredits(principal.keyHash!, creditReserve, 0);
      creditReserved = false;
    }
  };

  // Model allow-list check.
  if (principal.modelAllowList.length > 0) {
    if (requestedModel === null) {
      releaseReserve();
      lctx.status = 403;
      lctx.outcome = "forbidden";
      lctx.errorClass = "model_not_allowed";
      lctx.admission = "n/a";
      sendError(
        res,
        makeError("model_not_allowed", {
          param: "model",
          message: `Your API key must specify a 'model'. Allowed models: ${principal.modelAllowList.join(", ")}.`,
        })
      );
      return;
    }
    if (!principal.modelAllowList.includes(requestedModel)) {
      releaseReserve();
      lctx.status = 403;
      lctx.outcome = "forbidden";
      lctx.errorClass = "model_not_allowed";
      lctx.admission = "n/a";
      sendError(
        res,
        makeError("model_not_allowed", {
          param: "model",
          message: `Your API key is not permitted to use model '${requestedModel}'.`,
        })
      );
      return;
    }
  }

  // Quota. On success this returns a reservation handle (M1): the daily budget is debited
  // atomically here, and the handle lets recordUsage() reconcile the exact event + daily delta.
  const q = checkQuota(principal.alias, principal.limits, estTokens);
  if (!q.ok) {
    releaseReserve();
    const windowLabel = q.reason === "daily" ? "the daily token budget" : `the ${q.reason} window`;
    lctx.status = 429;
    lctx.outcome = "rate_limited";
    lctx.errorClass = "rate_limit_exceeded";
    lctx.retryAfterS = q.retryAfterSeconds;
    lctx.admission = "n/a";
    recordRateLimited("quota");
    sendError(
      res,
      makeError("rate_limit_exceeded", {
        retryAfterSeconds: q.retryAfterSeconds,
        message: `Rate limit reached for ${windowLabel}. Retry after ${q.retryAfterSeconds}s.`,
        rateLimit: {
          limit: q.reason === "tpm" ? q.snapshot.tpmLimit : q.snapshot.rpmLimit,
          remaining: 0,
          resetSeconds: q.snapshot.resetSeconds,
        },
      })
    );
    return;
  }

  // Admission.
  const admitStart = Date.now();
  let release: () => void;
  try {
    release = await controller.acquire({
      lane: principal.tier as Lane,
      requestedModel,
      keyMaxParallel: principal.maxParallel,
      keyInflight: keyInflight.get(principal.alias) ?? 0,
      keyId: principal.alias,
    });
    // queueWaitMs > 0 only when the owner had to wait (the acquire resolved via drainQueue).
    // For a direct admit it rounds to ~0ms, which we record as null (not meaningful).
    const waited = Date.now() - admitStart;
    lctx.queueWaitMs = waited > 5 ? waited : null;
    lctx.admission = "admitted";
  } catch (err) {
    if (err instanceof AdmissionRejected) {
      releaseReserve();
      // M1: the quota check already DEBITED the daily estimate; a request rejected at admission
      // never ran, so roll that reservation back (reconcile to 0) — otherwise a busy box would
      // silently burn each rejected request's estimate against the caller's daily budget.
      recordUsage(principal.alias, 0, Date.now(), q.reservation);
      lctx.status = 503;
      lctx.outcome = "busy";
      lctx.errorClass = "server_busy";
      lctx.retryAfterS = err.retryAfterSeconds;
      lctx.admission = "busy";
      recordAdmissionRejection(principal.tier);
      sendError(res, makeError("server_busy", { retryAfterSeconds: err.retryAfterSeconds }));
      return;
    }
    releaseReserve();
    recordUsage(principal.alias, 0, Date.now(), q.reservation);
    throw err;
  }

  incInflight(principal.alias);
  // Content-blind concurrency gauge: increment on admission acquire, decrement on release (below).
  inflightInc(principal.tier);
  // C2 (HIGH): start at 0, NOT estTokens. The real usage is assigned only after handler()
  // RESOLVES successfully; if the upstream throws (timeout / connection reset / stream error)
  // actualTokens stays 0, so the finally block reconciles the credit reservation and the quota
  // estimate to ZERO — a failed request is never billed at the full estimate.
  let actualTokens = 0;
  let creditsCharged = 0;
  try {
    const result = await handler();
    actualTokens = result.totalTokens;
    // R6: the handler may already have classified a DISTINCT failure outcome (an upstream
    // connection/timeout failure, or a mid-stream abort that cannot change the already-sent 200
    // status). Preserve that — do NOT clobber it with the generic ok/error derivation below.
    // HANDLER_OWNED_OUTCOMES is the small allow-list of outcomes the handler sets itself.
    const handlerOwned = HANDLER_OWNED_OUTCOMES.has(lctx.outcome);
    // handler() (handleChatProxy or handleDelegate) writes its own status before returning.
    // Best-effort: read res.statusCode if it was set.
    if (!handlerOwned) {
      lctx.status = res.statusCode > 0 ? res.statusCode : 200;
      lctx.outcome = lctx.status < 400 ? "ok" : "error";
    }
    // M3: carry the real prompt/completion breakdown so the token + credit Prometheus counters
    // increment for real traffic (the record site reads these from lctx).
    lctx.promptTokens = result.promptTokens;
    lctx.completionTokens = result.completionTokens;
    lctx.totalTokens = actualTokens;
    lctx.ttftMs = result.ttftMs;
    // C3: use the handler's canonicalized served model when present; otherwise KEEP the route's
    // already-canonicalized lctx.model (set before the spine ran). Never the raw request string,
    // and never an extra async call here — settling credits/quota in the finally must not be
    // delayed behind a listModels() round-trip.
    if (result.canonicalModel !== null) lctx.model = result.canonicalModel;
    // Content-blind TTFT histogram (streaming only — non-streaming leaves ttftMs null). Label is
    // the canonical served model only.
    if (result.ttftMs !== null) recordTtft(lctx.model, result.ttftMs);
  } finally {
    release();
    decInflight(principal.alias);
    inflightDec(principal.tier);
    // M1: reconcile the EXACT admitted quota event + daily delta via the reservation handle.
    recordUsage(principal.alias, actualTokens, Date.now(), q.reservation);
    // Settle the lifetime credit ledger for minted store keys (keyHash present). Legacy
    // static keys and implicit-admin have no credit row and are skipped.
    if (principal.keyHash !== null) {
      if (creditReserved) {
        // Reconcile the atomic reservation to real usage: adjust by (real − reserve). An
        // errored/non-completed call has actualTokens 0 (C2/HIGH-2), so the reserve is fully
        // released — no charge for a failed completion.
        reconcileCredits(principal.keyHash, creditReserve, actualTokens);
      } else {
        // Uncapped key (creditLimit 0): nothing was reserved, so accrue real usage directly.
        recordCreditUsage(principal.keyHash, actualTokens);
      }
      creditsCharged = actualTokens;
    }
    // M3: feed the credits charged for this request into the metrics record site.
    lctx.creditsCharged = creditsCharged;
  }
}

// ─── Route handlers ──────────────────────────────────────────────────────────────────

/**
 * Structured outcome of a metered handler (chat proxy / delegate). Carries the token breakdown
 * (M3 — so the Prometheus token + credit counters actually increment for real traffic) and the
 * credits charged for this request (the reconciled real usage, or 0 for an errored call).
 *
 * canonicalModel is the model string SAFE to use as a metrics/log label (C3): it is null when no
 * recognised model was served, so the record site maps it to "unknown" rather than leaking the
 * raw, user-controlled `model` field into Prometheus labels / the access log.
 */
export interface MeteredResult {
  totalTokens: number;
  promptTokens: number | null;
  completionTokens: number | null;
  canonicalModel: string | null;
  /** Time-to-first-token (ms) for a streaming completion; null for non-streaming / no content. */
  ttftMs: number | null;
}

// L1 (Codex LOW): the stale exported canonicalizeModel() helper was removed. It pre-dated the
// trusted-catalogue contract and contradicted it (it collapsed ALL empty-allow-list keys to "none",
// whereas canonicalizeModelTrusted() validates them against the resident catalogue → real id). No
// HTTP path imported it; every record site now uses canonicalizeModelTrusted() (catalogue.ts).

/** Estimate prompt tokens from the raw body when no usage frame is available. */
function estimatePromptTokens(rawBody: string): number {
  return Math.ceil(rawBody.length / 4);
}

/** A metered result that charges nothing (errored / non-2xx upstream). */
const ZERO_RESULT: MeteredResult = { totalTokens: 0, promptTokens: null, completionTokens: null, canonicalModel: null, ttftMs: null };

/**
 * R6: outcomes a metered handler classifies ITSELF (and that the spine must NOT overwrite with
 * the generic ok/error derivation). These are the graceful-degradation upstream/streaming
 * failures — the handler has already written the right status/envelope (or terminal SSE frame)
 * and set lctx.outcome/errorClass, so the spine preserves them verbatim for the request_log.
 */
const HANDLER_OWNED_OUTCOMES = new Set([
  "upstream_unavailable",
  "upstream_timeout",
  "stream_failed",
  // #22: a client disconnect mid-call — the handler aborted the upstream + billed 0; the spine
  // must not reclassify it from the (already-sent or moot) status.
  "client_closed",
  // Fix #2: the degeneracy watchdog aborted a "?????" run + billed 0; the handler owns this 200.
  "degenerate",
  // An exact stamped retry recovered its immutable admission echo, but v1 does not yet retain
  // the original delegation outcome. The handler returns a truthful 200/error envelope so Hugin
  // can preserve the join evidence without triggering another model call.
  "learning_task_admission_recovered",
]);

async function handleChatProxy(
  rawBody: string,
  parsed: ParsedChatBody,
  res: ServerResponse,
  cfg: HomeserverConfig,
  effectiveMax: number,
  lctx: LogCtx,
  principal: PrincipalContext
): Promise<MeteredResult> {
  // C3: the model is safe to label only after upstream returns 2xx for it. We thread the
  // already-canonicalized lctx.model (set at the route) through as the canonicalModel.
  const servedModel = lctx.model;
  // OWNER-ONLY full request log. The guard is strictly owner-tier AND a real minted key
  // (keyHash !== null), which EXCLUDES implicit-admin and legacy static admins (both keyHash
  // null). Guests are never content-logged. See owner-log.ts for the full rationale.
  // The exposure digest is content-blind and must cover every owner-tier ingress, including the
  // legacy/implicit admin posture, or the lookup could report a false-fresh holdout. The full raw
  // owner log remains deliberately narrower: only a real minted owner key may write content.
  const ownerExposure = principal.tier === "owner";
  const ownerLog = cfg.ownerRequestLog === "on" && ownerExposure && principal.keyHash !== null;
  const reqMessages: unknown = ownerExposure && Array.isArray(parsed.obj["messages"])
    ? parsed.obj["messages"]
    : [];
  const chatStart = Date.now();

  // Rewrite max_tokens to the capped value before proxying upstream.
  const body: Record<string, unknown> = { ...parsed.obj, max_tokens: effectiveMax };
  delete body["maxTokens"];
  delete body["node"];

  if (parsed.stream) {
    // Ask LM Studio to emit a terminal usage frame so we can reconcile real token cost.
    body["stream_options"] = { include_usage: true };
  }

  // The Orin's Ollama exposes native /api/chat rather than its optional OpenAI shim. Adapt the
  // single non-streaming result here so callers retain the gateway's OpenAI-compatible contract.
  // Streaming remains M5-only for now: inventing SSE usage/finish semantics would make quota and
  // TTFT accounting dishonest. Hugin's small Orin lanes are bounded leaf tasks, not chat streams.
  if (lctx.node === "orin") {
    if (parsed.stream) {
      lctx.status = 400;
      lctx.outcome = "bad_request";
      lctx.errorClass = "invalid_request_error";
      sendError(res, makeError("invalid_request_error", { param: "stream", message: "Streaming is not supported by the Orin backend." }));
      return ZERO_RESULT;
    }
    if (ownerExposure) {
      recordMessageTaskExposuresBestEffort({
        messages: reqMessages,
        lane: "chat",
        modelId: servedModel,
        harnessId: "openai-chat",
      });
    }
    const messages = Array.isArray(body["messages"])
      ? body["messages"].filter((m): m is { role: string; content: unknown } =>
          m !== null && typeof m === "object" && typeof (m as Record<string, unknown>)["role"] === "string"
        ).map((m) => ({ role: m.role, content: m.content ?? "" }))
      : [];
    const r = await runOrinChat(parsed.model ?? cfg.orin.model, messages, {
      maxTokens: effectiveMax,
      temperature: typeof body["temperature"] === "number" ? body["temperature"] : 0,
      signal: AbortSignal.timeout(cfg.callTimeoutMs),
    }, cfg);
    if (!r.ok) {
      const timeout = /timeout|abort/i.test(r.error);
      lctx.status = timeout ? 504 : 502;
      lctx.outcome = timeout ? "upstream_timeout" : "upstream_unavailable";
      lctx.errorClass = lctx.outcome;
      sendError(
        res,
        timeout
          ? makeError("upstream_timeout", { retryAfterSeconds: cfg.busyRetryAfterSeconds })
          : makeError("upstream_unavailable")
      );
      return ZERO_RESULT;
    }
    const v = r.value;
    const openAi = {
      id: `chatcmpl-orin-${randomUUID()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: cfg.orin.model,
      choices: [{ index: 0, message: { role: "assistant", content: v.response }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: v.promptTokens,
        completion_tokens: v.completionTokens,
        total_tokens: v.promptTokens + v.completionTokens,
      },
    };
    sendJson(res, 200, openAi);
    lctx.status = 200;
    lctx.outcome = "ok";
    if (ownerLog) recordOwnerChat(principal, parsed.model, reqMessages, v.response, v.promptTokens, v.completionTokens, Date.now() - chatStart, "ok");
    return {
      totalTokens: v.promptTokens + v.completionTokens,
      promptTokens: v.promptTokens,
      completionTokens: v.completionTokens,
      canonicalModel: servedModel,
      ttftMs: null,
    };
  }

  // TTFT clock: ms from the upstream call start to the first CONTENT chunk we receive (streaming).
  const upstreamCallStart = Date.now();
  // #22: wire a client-disconnect AbortController into the upstream fetch signal. If the client
  // goes away (closes the connection before we finish), we abort the upstream fetch so the GPU
  // generation is CANCELLED (not left running to completion, wasted) and the call is billed 0.
  // `clientAborted` disambiguates this from the AbortSignal.timeout firing — classifyUpstreamError
  // maps BOTH to AbortError, but a client-close must NOT be mislabeled as an upstream_timeout (504).
  const clientGone = new AbortController();
  let clientAborted = false;
  // Fix #2 (silent backstop): for a recurrent model, watch the decoded SSE content for a degenerate
  // single-token "?????" run that an EARLIER disconnect seeded into the recurrent buffer (THIS request
  // sees no disconnect, so the disconnect-keyed poison-clear never fires). On a trip we abort the
  // stream like an upstream failure and force a poison-clear. null for full-attention models (immune)
  // or when the threshold is 0 (disabled). degenerateGone drives the same abort path as clientGone.
  const watchdog =
    cfg.degeneracyRunThreshold > 0 && parsed.model !== null && cfg.recurrentModelIds.includes(parsed.model)
      ? new DegeneracyWatchdog(cfg.degeneracyRunThreshold)
      : null;
  const degenerateGone = new AbortController();
  let degenerate = false;
  res.on("close", () => {
    // 'close' also fires on a normal end after res.end(); only treat an UNFINISHED response as a
    // client disconnect. Abort once.
    if (!res.writableEnded && !clientAborted) {
      clientAborted = true;
      clientGone.abort();
    }
  });
  // R6 (graceful degradation): the upstream fetch can THROW — connection refused/reset (the
  // backend is down) or the AbortSignal timeout firing (a slow or cold-loading backend). Map
  // each to its DISTINCT OpenAI-shaped envelope (502 upstream_unavailable / 504 upstream_timeout)
  // instead of letting it bubble to the generic 500 in startGateway's catch. We are still BEFORE
  // any writeHead here, so the status is freely settable. Returning ZERO_RESULT keeps the C2
  // billing invariant intact (actualTokens stays 0 → the spine reconciles credits + quota to 0 —
  // a failed call is never charged), and setting lctx makes the metered finally + request_log
  // record the real outcome rather than a generic "error".
  let upstream: Response;
  try {
    if (ownerExposure) {
      recordMessageTaskExposuresBestEffort({
        messages: reqMessages,
        lane: "chat",
        modelId: servedModel,
        harnessId: "openai-chat",
      });
    }
    upstream = await fetch(`${cfg.lmStudioBaseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      // Abort on EITHER the call timeout OR a client disconnect (whichever fires first).
      signal: AbortSignal.any([AbortSignal.timeout(cfg.callTimeoutMs), clientGone.signal]),
    });
  } catch (err) {
    // #22: a client disconnect during the initial fetch — bill 0, record a distinct outcome, and
    // do NOT misclassify it as an upstream timeout. The client is gone, so the envelope is moot.
    if (clientAborted) {
      lctx.status = 499;
      lctx.outcome = "client_closed";
      lctx.errorClass = "client_closed";
      // Recurrent poison-clear: the abrupt disconnect may have interrupted a decode mid-write to a
      // hybrid recurrent model's SSM state — unload it (allow-listed + cooldown) so the next request
      // loads a clean model instead of inheriting a dirty seed.
      poisonClearOnDisconnect(parsed.model, cfg.recurrentModelIds, cfg.poisonClearCooldownMs);
      return ZERO_RESULT;
    }
    const kind = classifyUpstreamError(err);
    if (kind === "upstream_timeout") {
      lctx.status = 504;
      lctx.outcome = "upstream_timeout";
      lctx.errorClass = "upstream_timeout";
      sendError(res, makeError("upstream_timeout", { retryAfterSeconds: cfg.busyRetryAfterSeconds }));
      return ZERO_RESULT;
    }
    if (kind === "upstream_unavailable") {
      lctx.status = 502;
      lctx.outcome = "upstream_unavailable";
      lctx.errorClass = "upstream_unavailable";
      sendError(res, makeError("upstream_unavailable"));
      return ZERO_RESULT;
    }
    // Not a recognised upstream connection/timeout failure — re-throw so it surfaces as a generic
    // 500 (detail logged server-side). We do NOT mask an unexpected logic bug as a friendly 502.
    throw err;
  }

  // ── Streaming path: pipe bytes straight through, never buffer. ──
  // Buffering a stream:true response (await upstream.text()) sends zero bytes until the
  // final token, which trips Cloudflare's 524 idle timeout on long generations. Instead we
  // pipe the upstream SSE body directly to the client as it arrives, sniffing the terminal
  // usage frame for accounting without holding the response.
  if (parsed.stream) {
    // A streaming 404/error from upstream still arrives as a stream; if the status is an
    // error we surface the uniform envelope (the body is small in that case).
    if (upstream.status >= 400) {
      const text = await upstream.text();
      if (upstream.status === 404 || /model.*not.*found/i.test(text)) {
        lctx.errorClass = "model_not_found";
        sendError(
          res,
          makeError("model_not_found", {
            param: "model",
            message: parsed.model
              ? `The model '${parsed.model}' does not exist or is not loaded.`
              : undefined,
          })
        );
        return ZERO_RESULT;
      }
      // #23: any other non-2xx upstream status — DO NOT echo the upstream body verbatim. An
      // LM Studio / llama-swap error body can carry internal detail (file/model paths, host:port,
      // stack-like text) that would leak to a friend-facing client. Normalize to a static
      // upstream_unavailable envelope. Charge NOTHING (billing invariant — no completion).
      lctx.status = 502;
      lctx.outcome = "upstream_unavailable";
      lctx.errorClass = "upstream_unavailable";
      sendError(res, makeError("upstream_unavailable"));
      return ZERO_RESULT;
    }

    res.writeHead(upstream.status, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });

    if (!upstream.body) {
      // L2 (billing invariant C2): no completion was produced — charge ZERO, not effectiveMax.
      // The old code returned totalTokens:effectiveMax here, billing a full request on a path
      // where NO tokens were ever generated. Returning ZERO_RESULT keeps C2 intact (a failed /
      // no-op response is never billed). Outcome is upstream_unavailable (the backend provided
      // an empty-body response — a backend fault, not a clean completion).
      lctx.status = 502;
      lctx.outcome = "upstream_unavailable";
      lctx.errorClass = "upstream_unavailable";
      res.end();
      return ZERO_RESULT;
    }

    // Tap the stream to recover the terminal `data: {... usage ...}` frame while forwarding
    // every chunk untouched. Keep only a small tail so a long stream never grows memory.
    // When owner-logging is active we additionally accumulate the streamed
    // `choices[].delta.content` as it passes through this SAME tap (no second upstream call),
    // assembling the full completion text for the owner-log row.
    let tail = "";
    // SINGLE SSE line buffer, ALWAYS maintained (not just under owner-logging). It drives BOTH
    // TTFT detection and owner-log assembly off COMPLETE frames, so a `data:` frame split across
    // two TCP chunks is reassembled before we look for content (M4). extractStreamedContent never
    // throws on a partial/malformed frame — it just contributes nothing until the line completes.
    let sseBuf = "";
    let assembled = ownerLog ? "" : null;
    // TTFT: the first COMPLETE SSE frame carrying non-empty delta content marks "first token". A
    // leading SSE comment / role-only frame is not content. Detection runs on whole buffered lines,
    // never on a raw TCP chunk — so a content frame split across chunks still records TTFT.
    let ttftMs: number | null = null;
    const nodeStream = Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]);
    nodeStream.on("data", (chunk: Buffer) => {
      const s = chunk.toString("utf-8");
      tail = (tail + s).slice(-8192);
      // Buffer across chunk boundaries; process only COMPLETE SSE lines (split on "\n").
      sseBuf += s;
      const nl = sseBuf.lastIndexOf("\n");
      if (nl !== -1) {
        const complete = sseBuf.slice(0, nl + 1);
        sseBuf = sseBuf.slice(nl + 1);
        const content = extractStreamedContent(complete);
        if (ttftMs === null && content !== "") {
          ttftMs = Date.now() - upstreamCallStart;
        }
        if (assembled !== null) assembled += content;
        // Fix #2: feed decoded content to the degeneracy watchdog (recurrent models only). On the
        // first trip, signal the abort path — the relay promise destroys the upstream stream and
        // rejects, which the `degenerate` branch below turns into a terminal "retry" frame + unload.
        if (watchdog !== null && !degenerate && content !== "" && watchdog.feed(content)) {
          degenerate = true;
          degenerateGone.abort();
        }
      }
    });

    // R6 (mid-stream failure signalling): once SSE bytes are flowing, the HTTP status + headers
    // are already on the wire — we CANNOT turn a truncated stream into a 5xx. Instead, if the
    // upstream stream errors/aborts, we emit a TERMINAL error frame so the client knows the
    // stream was cut short (not cleanly finished), then end. We pipe WITHOUT auto-ending res
    // ({ end: false }) so we always control the final bytes ourselves. Best-effort: any failure
    // here is swallowed (never throws past the handler / crashes the gateway), and the call is
    // billed NOTHING (ZERO_RESULT) since no clean completion was produced.
    let streamFailed = false;
    try {
      await new Promise<void>((resolve, reject) => {
        nodeStream.on("error", reject);
        // The web-stream → node-stream bridge can also surface an upstream abort as a normal
        // "end" with a destroyed/erroring underlying socket; the "error" path covers the abort.
        res.on("error", () => {
          /* client went away — let the end() below no-op, do not crash */
        });
        // #22: a client disconnect mid-stream must STOP us draining the upstream (which would
        // otherwise run the GPU generation to completion and bill the full token count for a
        // response the client never received). The res 'close' handler above aborts clientGone →
        // reject here so we stop reading and bill 0. Destroy the node stream to release the
        // upstream socket promptly. If clientGone already fired (or fires later), reject once.
        const onClientGone = (): void => {
          nodeStream.destroy();
          reject(new Error("client disconnected mid-stream"));
        };
        if (clientGone.signal.aborted) onClientGone();
        else clientGone.signal.addEventListener("abort", onClientGone, { once: true });
        // Fix #2: a watchdog trip aborts the relay the same way a client disconnect does — stop
        // draining the (degenerate) upstream and reject so the `degenerate` branch handles cleanup.
        const onDegenerate = (): void => {
          nodeStream.destroy();
          reject(new Error("degenerate single-token run detected mid-stream"));
        };
        if (degenerateGone.signal.aborted) onDegenerate();
        else degenerateGone.signal.addEventListener("abort", onDegenerate, { once: true });
        nodeStream.on("end", resolve);
        nodeStream.pipe(res, { end: false });
      });
    } catch {
      streamFailed = true;
    }

    if (degenerate) {
      // Fix #2 (silent backstop): the upstream returned a degenerate single-token "?????" run — a
      // dirty recurrent buffer seeded by an EARLIER disconnect, surfacing on a request that saw no
      // disconnect of its own. The 200 + SSE headers are already on the wire, so we cannot turn it
      // into a 5xx: emit a terminal error frame telling the client to retry, then force a
      // poison-clear so the NEXT request loads a clean model. Shares the poison-clear cooldown state
      // with the disconnect path, so a disconnect + a watchdog trip collapse to one unload/window.
      lctx.status = 200;
      lctx.outcome = "degenerate";
      lctx.errorClass = "upstream_error";
      requestPoisonClear(parsed.model, cfg.recurrentModelIds, cfg.poisonClearCooldownMs, "degeneracy watchdog");
      recordDegeneracyDetected(parsed.model);
      try {
        if (!res.writableEnded) {
          res.write(
            'data: {"error":{"message":"The model backend produced a degenerate response and was reset — please retry.","type":"server_error","code":"upstream_error"}}\n\n'
          );
          res.write("data: [DONE]\n\n");
          res.end();
        }
      } catch {
        // Terminal frame is best-effort; never let it crash the request.
      }
      if (assembled !== null) {
        recordOwnerChat(principal, parsed.model, reqMessages, assembled, null, null, Date.now() - chatStart, "degenerate");
      }
      // A degenerate (garbage) completion is not a valid response → charge 0.
      return ZERO_RESULT;
    }

    if (streamFailed && clientAborted) {
      // #22: the failure was a CLIENT disconnect, not an upstream truncation. The client is gone,
      // so do NOT write a terminal frame (no one is listening) and do NOT label it stream_failed.
      // Record a distinct client_closed outcome; the upstream fetch was aborted (GPU freed). Bill 0.
      lctx.status = 499;
      lctx.outcome = "client_closed";
      lctx.errorClass = "client_closed";
      // Recurrent poison-clear (PRIMARY trigger): an abrupt mid-stream disconnect is exactly what
      // leaves a hybrid recurrent model's SSM state half-written and poisons later cache-reuse
      // requests. Unload it (allow-listed + cooldown) so the box self-heals without a restart.
      poisonClearOnDisconnect(parsed.model, cfg.recurrentModelIds, cfg.poisonClearCooldownMs);
      if (assembled !== null) {
        recordOwnerChat(principal, parsed.model, reqMessages, assembled, null, null, Date.now() - chatStart, "client_closed");
      }
      return ZERO_RESULT;
    }

    if (streamFailed) {
      // The 200 + SSE headers are already on the wire; the client received a 200 whose body was
      // truncated and terminated with our error frame. Record 200 (what the client saw) with the
      // distinct stream_failed outcome — the status alone never tells the truncation story.
      lctx.status = 200;
      lctx.outcome = "stream_failed";
      lctx.errorClass = "upstream_error";
      // Terminal error frame + [DONE] so a streaming client distinguishes truncation from a
      // clean finish. Guarded: if the client already disconnected, end() is a harmless no-op.
      try {
        if (!res.writableEnded) {
          res.write(
            'data: {"error":{"message":"The model backend stream ended unexpectedly — the response was truncated. Please retry.","type":"server_error","code":"upstream_error"}}\n\n'
          );
          res.write("data: [DONE]\n\n");
          res.end();
        }
      } catch {
        // Writing the terminal frame is best-effort; never let it crash the request.
      }
      if (assembled !== null) {
        recordOwnerChat(principal, parsed.model, reqMessages, assembled, null, null, Date.now() - chatStart, "stream_failed");
      }
      // Billing invariant: a truncated/failed stream is not a successful completion → charge 0.
      return ZERO_RESULT;
    }

    // Clean end: close the response we deliberately kept open above.
    if (!res.writableEnded) res.end();

    const usage = parseTrailingUsage(tail);
    const { prompt, completion } = parseTrailingUsageBreakdown(tail);
    // Flush any trailing partial buffer (a final line without a newline) for TTFT + assembly.
    if (sseBuf !== "") {
      const content = extractStreamedContent(sseBuf);
      if (ttftMs === null && content !== "") {
        ttftMs = Date.now() - upstreamCallStart;
      }
      if (assembled !== null) assembled += content;
      // Fix #2: also feed the watchdog the trailing (newline-less) frame — a degeneration confined
      // to the final unterminated frame would otherwise slip past the mid-stream tap. The body is
      // already on the wire so we cannot abort, but we still self-heal (poison-clear) and bill 0.
      if (watchdog !== null && !degenerate && content !== "" && watchdog.feed(content)) {
        degenerate = true;
      }
    }
    if (degenerate) {
      lctx.status = 200;
      lctx.outcome = "degenerate";
      lctx.errorClass = "upstream_error";
      requestPoisonClear(parsed.model, cfg.recurrentModelIds, cfg.poisonClearCooldownMs, "degeneracy watchdog (trailing frame)");
      recordDegeneracyDetected(parsed.model);
      if (assembled !== null) {
        recordOwnerChat(principal, parsed.model, reqMessages, assembled, null, null, Date.now() - chatStart, "degenerate");
      }
      return ZERO_RESULT;
    }
    if (assembled !== null) {
      recordOwnerChat(principal, parsed.model, reqMessages, assembled, prompt, completion, Date.now() - chatStart, "ok");
    }
    if (usage !== null) {
      return { totalTokens: usage, promptTokens: prompt, completionTokens: completion, canonicalModel: servedModel, ttftMs };
    }
    // No usage frame: fall back to a conservative estimate (prompt + capped completion).
    return {
      totalTokens: estimatePromptTokens(rawBody) + effectiveMax,
      promptTokens: estimatePromptTokens(rawBody),
      completionTokens: effectiveMax,
      canonicalModel: servedModel,
      ttftMs,
    };
  }

  // ── Non-streaming path: buffer (so 404 normalization + usage read still work). ──
  // R6 (mid-body upstream reset): after a successful fetch() the upstream may still reset the
  // connection while we are reading the response body (upstream.text()). This surfaces as a
  // TypeError (UND_ERR_SOCKET / "terminated") — identical in kind to a pre-fetch connection
  // failure — and must be classified via classifyUpstreamError → 502 upstream_unavailable.
  // Without this guard the throw reaches the top-level handler as a generic 500, and lctx
  // carries no outcome, so the request_log row is wrong and C2 (credits=0) is only preserved
  // by accident (the spine's finally block reconciles to 0 anyway), but the client gets the
  // wrong error code. With the guard: distinct 502, outcome correctly set, ZERO_RESULT (C2).
  let text: string;
  try {
    text = await upstream.text();
  } catch (err) {
    // #22: a client disconnect while we buffer the (non-streaming) upstream body aborted the
    // upstream fetch — bill 0, record client_closed, and do NOT misclassify it as a timeout.
    if (clientAborted) {
      lctx.status = 499;
      lctx.outcome = "client_closed";
      lctx.errorClass = "client_closed";
      // Recurrent poison-clear: a non-streaming abort can also interrupt a decode mid-write to the
      // recurrent SSM state — unload it (allow-listed + cooldown) so the next request is clean.
      poisonClearOnDisconnect(parsed.model, cfg.recurrentModelIds, cfg.poisonClearCooldownMs);
      return ZERO_RESULT;
    }
    const kind = classifyUpstreamError(err);
    if (kind === "upstream_timeout") {
      lctx.status = 504;
      lctx.outcome = "upstream_timeout";
      lctx.errorClass = "upstream_timeout";
      sendError(res, makeError("upstream_timeout", { retryAfterSeconds: cfg.busyRetryAfterSeconds }));
      return ZERO_RESULT;
    }
    if (kind === "upstream_unavailable") {
      lctx.status = 502;
      lctx.outcome = "upstream_unavailable";
      lctx.errorClass = "upstream_unavailable";
      sendError(res, makeError("upstream_unavailable"));
      return ZERO_RESULT;
    }
    // Not a recognised upstream failure — re-throw so it surfaces as a generic 500.
    throw err;
  }

  // An upstream ERROR response (Codex finding 1: this whole block is gated on `status >= 400`, so
  // a successful 2xx completion whose body legitimately contains the text "model not found" is
  // NEVER reclassified — only error responses are inspected, matching the streaming path).
  //   • 404 / "model not found" → uniform model_not_found (400).
  //   • #23: any other non-404 error → static 502; NEVER echo the upstream body verbatim (it can
  //     leak internal detail — file/model paths, host:port, stack-like text).
  // Either way charge NOTHING (billing invariant — no successful completion ⇒ no credit charge).
  if (upstream.status >= 400) {
    if (upstream.status === 404 || /model.*not.*found/i.test(text)) {
      lctx.errorClass = "model_not_found";
      sendError(
        res,
        makeError("model_not_found", {
          param: "model",
          message: parsed.model
            ? `The model '${parsed.model}' does not exist or is not loaded.`
            : undefined,
        })
      );
      return ZERO_RESULT;
    }
    lctx.status = 502;
    lctx.outcome = "upstream_unavailable";
    lctx.errorClass = "upstream_unavailable";
    sendError(res, makeError("upstream_unavailable"));
    return ZERO_RESULT;
  }

  // 2xx success: forward the upstream body as-is.
  res.writeHead(upstream.status, {
    "content-type": upstream.headers.get("content-type") ?? "application/json",
  });
  res.end(text);

  // Reconcile real token usage from the upstream response when available.
  try {
    const json = JSON.parse(text) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number };
    };
    // Fix #2 (non-streaming arm of the silent backstop): a non-streaming completion can also be a
    // degenerate "?????" body from a dirty recurrent buffer. The body is already on the wire
    // (res.end(text) above) so we cannot change it, but we still bill 0 (a garbage completion is
    // not a valid response — C2) and force a poison-clear so the NEXT request loads clean. Reuses
    // the same per-model cooldown state as the disconnect + streaming paths.
    const nsContent = json.choices?.[0]?.message?.content ?? "";
    if (watchdog !== null && nsContent !== "" && watchdog.feed(nsContent)) {
      lctx.status = 200;
      lctx.outcome = "degenerate";
      lctx.errorClass = "upstream_error";
      requestPoisonClear(parsed.model, cfg.recurrentModelIds, cfg.poisonClearCooldownMs, "degeneracy watchdog (non-streaming)");
      recordDegeneracyDetected(parsed.model);
      if (ownerLog) {
        recordOwnerChat(principal, parsed.model, reqMessages, nsContent, null, null, Date.now() - chatStart, "degenerate");
      }
      return ZERO_RESULT;
    }
    if (ownerLog) {
      recordOwnerChat(
        principal,
        parsed.model,
        reqMessages,
        json.choices?.[0]?.message?.content ?? "",
        json.usage?.prompt_tokens ?? null,
        json.usage?.completion_tokens ?? null,
        Date.now() - chatStart,
        "ok"
      );
    }
    if (json.usage?.total_tokens !== undefined) {
      return {
        totalTokens: json.usage.total_tokens,
        promptTokens: json.usage.prompt_tokens ?? null,
        completionTokens: json.usage.completion_tokens ?? null,
        canonicalModel: servedModel,
        ttftMs: null,
      };
    }
  } catch {
    // Non-JSON 2xx body — we cannot read real usage and there is no reliable completion
    // count, so charge only the prompt estimate (never the full effectiveMax reservation,
    // which would over-bill an unmetered response).
    return {
      totalTokens: estimatePromptTokens(rawBody),
      promptTokens: estimatePromptTokens(rawBody),
      completionTokens: null,
      canonicalModel: servedModel,
      ttftMs: null,
    };
  }
  // 2xx JSON without a usage frame — fall back to the prompt-only estimate as well.
  return {
    totalTokens: estimatePromptTokens(rawBody),
    promptTokens: estimatePromptTokens(rawBody),
    completionTokens: null,
    canonicalModel: servedModel,
    ttftMs: null,
  };
}

/**
 * Best-effort: scan the tail of an SSE stream for the last `data: {...}` frame carrying a
 * `usage.total_tokens` field. Returns null if none is found (caller falls back to estimate).
 * Never throws — a malformed frame just means "no usage", not a failed request.
 */
function parseTrailingUsage(tail: string): number | null {
  const lines = tail.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line.startsWith("data:")) continue;
    const payload = line.slice("data:".length).trim();
    if (payload === "" || payload === "[DONE]") continue;
    let json: { usage?: { total_tokens?: number } };
    try {
      json = JSON.parse(payload) as { usage?: { total_tokens?: number } };
    } catch {
      continue;
    }
    if (typeof json.usage?.total_tokens === "number") return json.usage.total_tokens;
  }
  return null;
}

// ─── Owner-log helpers ─────────────────────────────────────────────────────────────────

/**
 * Extract the concatenated `choices[].delta.content` from a run of complete SSE lines.
 * Never throws — a malformed frame just contributes nothing. Used to assemble the full
 * completion text for the owner-log row as the stream passes through the existing tap, with
 * NO second upstream call.
 */
function extractStreamedContent(sse: string): string {
  let out = "";
  for (const raw of sse.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("data:")) continue;
    const payload = line.slice("data:".length).trim();
    if (payload === "" || payload === "[DONE]") continue;
    try {
      const json = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> };
      const piece = json.choices?.[0]?.delta?.content;
      if (typeof piece === "string") out += piece;
    } catch {
      // Partial / non-JSON frame — skip it.
    }
  }
  return out;
}

/**
 * Best-effort prompt/completion token breakdown from the terminal usage frame of an SSE tail.
 * Returns nulls when no usage frame is found (the owner-log row just records null token counts).
 */
function parseTrailingUsageBreakdown(tail: string): { prompt: number | null; completion: number | null } {
  const lines = tail.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line.startsWith("data:")) continue;
    const payload = line.slice("data:".length).trim();
    if (payload === "" || payload === "[DONE]") continue;
    try {
      const json = JSON.parse(payload) as {
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      if (json.usage !== undefined) {
        return {
          prompt: typeof json.usage.prompt_tokens === "number" ? json.usage.prompt_tokens : null,
          completion: typeof json.usage.completion_tokens === "number" ? json.usage.completion_tokens : null,
        };
      }
    } catch {
      continue;
    }
  }
  return { prompt: null, completion: null };
}

/**
 * Build and record one owner-log row for a chat completion. Best-effort (the record call itself
 * swallows errors). tok/s is completion_tokens / (latency seconds) when both are known.
 */
function recordOwnerChat(
  principal: PrincipalContext,
  model: string | null,
  messages: unknown,
  completion: string,
  promptTokens: number | null,
  completionTokens: number | null,
  latencyMs: number,
  outcome: string
): void {
  const tokPerSec =
    completionTokens !== null && latencyMs > 0 ? completionTokens / (latencyMs / 1000) : null;
  recordOwnerRequest({
    alias: principal.alias,
    model,
    route: "chat",
    messagesJson: JSON.stringify(messages ?? []),
    completion,
    promptTokens,
    completionTokens,
    latencyMs,
    tokPerSec,
    outcome,
  });
}

/** Validated /delegate params (the verifier is already built from its spec). */
interface DelegateParams {
  prompt: string;
  taskType?: string;
  systemPrompt?: string;
  modelId?: string;
  nodeId?: "m5" | "orin";
  frontierModelId?: string;
  delegatorModelId?: string;
  premiumBaselineModelId?: string;
  verifier?: Verifier;
  verifierName?: string;
  responseFormat?: ResponseFormat;
  temperature?: number;
  topP?: number;
  topK?: number;
  minP?: number;
  /** Optional v1 handshake. Unstamped /delegate remains the legacy, learning-ineligible lane. */
  learningTaskStamp?: HuginRequestStamp;
  learningTaskObservedFingerprint?: string;
}

/**
 * Validate an optional /delegate `responseFormat` (#166). Accepts only the three OpenAI shapes and
 * reconstructs a minimal well-formed value (never forwards unknown fields from an untrusted body):
 *   { type: "text" } | { type: "json_object" } | { type: "json_schema", json_schema: { name, schema, strict? } }
 * A grammar-constrained json_schema is the strongest way to stop gpt-oss-120b's harmony 500; a bad
 * value gets a clean 400 rather than a downstream llama.cpp error. PURE (no I/O).
 */
export function parseResponseFormat(
  value: unknown
): { ok: true; value: ResponseFormat } | { ok: false; message: string } {
  if (value === null || typeof value !== "object") {
    return { ok: false, message: "'responseFormat' must be an object." };
  }
  const t = (value as Record<string, unknown>)["type"];
  if (t === "text" || t === "json_object") {
    return { ok: true, value: { type: t } };
  }
  if (t === "json_schema") {
    const js = (value as Record<string, unknown>)["json_schema"];
    if (js === null || typeof js !== "object") {
      return { ok: false, message: "'responseFormat.json_schema' must be an object." };
    }
    const name = (js as Record<string, unknown>)["name"];
    const schema = (js as Record<string, unknown>)["schema"];
    const strict = (js as Record<string, unknown>)["strict"];
    // Match OpenAI's json_schema.name contract ([A-Za-z0-9_-], ≤64) so a bad name gets a clean 400
    // here rather than a downstream llama.cpp failure — the whole point of validating at the edge.
    if (typeof name !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
      return {
        ok: false,
        message: "'responseFormat.json_schema.name' must match [A-Za-z0-9_-] and be 1–64 characters.",
      };
    }
    if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
      return { ok: false, message: "'responseFormat.json_schema.schema' must be an object." };
    }
    return {
      ok: true,
      value: {
        type: "json_schema",
        json_schema: {
          name,
          schema: schema as Record<string, unknown>,
          ...(typeof strict === "boolean" ? { strict } : {}),
        },
      },
    };
  }
  return {
    ok: false,
    message: "'responseFormat.type' must be one of: text, json_object, json_schema.",
  };
}

type DelegateParse =
  | { ok: true; params: DelegateParams; requestedMax: number | null }
  | { ok: false; param: string | null; message: string };

/**
 * Parse + validate a /delegate body. PURE (no I/O) so the route can validate BEFORE admission —
 * a malformed/incomplete request must 400 even when the key is credit-exhausted or the box is busy,
 * and must never acquire a GPU admission slot just to be rejected (Codex finding 3).
 */
function parseDelegateBody(rawBody: string): DelegateParse {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return { ok: false, param: null, message: "Request body must be valid JSON." };
  }
  if (typeof body["prompt"] !== "string" || (body["prompt"] as string).length === 0) {
    return { ok: false, param: "prompt", message: "Missing required field 'prompt'." };
  }
  // #14: forward modelId / frontierModelId so the caller (Hugin's nightly sub-tasks, per ADR-004)
  // can pin the local model and request a frontier-fallback arm. Validate types — a clean 400 beats
  // a silently-ignored field.
  for (const f of [
    "modelId",
    "frontierModelId",
    "delegatorModelId",
    "premiumBaselineModelId",
    "taskType",
    "systemPrompt",
    "nodeId",
  ] as const) {
    if (body[f] !== undefined && typeof body[f] !== "string") {
      return { ok: false, param: f, message: `'${f}' must be a string.` };
    }
  }
  if (body["nodeId"] !== undefined && !isComputeNodeId(body["nodeId"])) {
    return { ok: false, param: "nodeId", message: "'nodeId' must be 'm5' or 'orin'." };
  }
  const samplerSpecs = [
    ["temperature", 0, 2, false],
    ["topP", 0, 1, false],
    ["topK", 0, Number.MAX_SAFE_INTEGER, true],
    ["minP", 0, 1, false],
  ] as const;
  for (const [field, min, max, integer] of samplerSpecs) {
    const value = body[field];
    if (value === undefined) continue;
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < min ||
      value > max ||
      (integer && !Number.isInteger(value))
    ) {
      return {
        ok: false,
        param: field,
        message: `'${field}' must be ${integer ? "an integer" : "a number"} in [${min}, ${max}].`,
      };
    }
  }
  // #14: an optional verifier SPEC lets the caller attach a deterministic pass/fail grader so the
  // orchestrator records a real verdict into the capability ledger (without it, every delegated
  // run is "unverified" and the ledger can't learn). The spec is an allow-list of parameterised
  // verifiers — never arbitrary code.
  let verifier: Verifier | undefined;
  let verifierName: string | undefined;
  if (body["verifier"] !== undefined) {
    const built = buildVerifier(body["verifier"]);
    if (isVerifierBuildError(built)) {
      return { ok: false, param: "verifier", message: built.error };
    }
    verifier = built.verifier;
    verifierName = built.name;
  }
  // #166: an optional response_format lets a caller (e.g. ratatoskr triage) request grammar-constrained
  // JSON — a hard well-formedness guarantee that also side-steps gpt-oss-120b's harmony 500. Validated
  // to an allow-list of shapes; JSON-shaped task types still get a json_object default when this is absent.
  let responseFormat: ResponseFormat | undefined;
  if (body["responseFormat"] !== undefined) {
    const parsed = parseResponseFormat(body["responseFormat"]);
    if (!parsed.ok) {
      return { ok: false, param: "responseFormat", message: parsed.message };
    }
    responseFormat = parsed.value;
  }
  let learningTaskStamp: HuginRequestStamp | undefined;
  let learningTaskObservedFingerprint: string | undefined;
  if (body["learningTaskStamp"] !== undefined) {
    try {
      learningTaskStamp = parseHuginRequestStamp(body["learningTaskStamp"]);
      learningTaskObservedFingerprint = learningTaskObservedRequestFingerprint(body);
    } catch (err) {
      return {
        ok: false,
        param: "learningTaskStamp",
        message: err instanceof LearningTaskContractError ? err.message : "Invalid 'learningTaskStamp'.",
      };
    }
  }
  return {
    ok: true,
    requestedMax: typeof body["maxTokens"] === "number" ? (body["maxTokens"] as number) : null,
    params: {
      prompt: body["prompt"] as string,
      taskType: body["taskType"] as string | undefined,
      systemPrompt: body["systemPrompt"] as string | undefined,
      modelId: body["modelId"] as string | undefined,
      nodeId: body["nodeId"] as "m5" | "orin" | undefined,
      frontierModelId: body["frontierModelId"] as string | undefined,
      delegatorModelId: body["delegatorModelId"] as string | undefined,
      premiumBaselineModelId: body["premiumBaselineModelId"] as string | undefined,
      verifier,
      verifierName,
      responseFormat,
      temperature: body["temperature"] as number | undefined,
      topP: body["topP"] as number | undefined,
      topK: body["topK"] as number | undefined,
      minP: body["minP"] as number | undefined,
      learningTaskStamp,
      learningTaskObservedFingerprint,
    },
  };
}

function sendLearningTaskAdmissionRecovery(
  res: ServerResponse,
  lctx: LogCtx,
  gatewayEcho: LearningTaskGatewayEcho,
): void {
  lctx.status = 200;
  lctx.outcome = "learning_task_admission_recovered";
  lctx.errorClass = "learning_task_outcome_unavailable";
  sendJson(res, 200, {
    outcome: "error",
    decisionReason:
      "Exact LearningTaskContract admission recovered; the original delegation outcome is unavailable and inference was not replayed.",
    learningTaskAdmission: {
      recovered: true,
      outcomeAvailable: false,
    },
    learningTaskGatewayEcho: gatewayEcho,
  });
}

async function handleDelegate(
  params: DelegateParams,
  res: ServerResponse,
  effectiveMax: number,
  keyAlias: string,
  lctx: LogCtx,
): Promise<MeteredResult> {
  let learningTaskGatewayEcho: LearningTaskGatewayEcho | undefined;
  if (params.learningTaskStamp !== undefined) {
    const stamp = params.learningTaskStamp;
    if (params.learningTaskObservedFingerprint === undefined) {
      throw new Error("stamped /delegate request is missing its observed request fingerprint");
    }
    learningTaskGatewayEcho = createLearningTaskGatewayEcho(stamp, {
      authenticatedPrincipalId: keyAlias,
      authentication: "gateway-owner-auth",
      gatewayRequestId: `opaque:${lctx.requestId}`,
      admissionId: `opaque:${randomUUID()}`,
      admittedAt: new Date(),
    });
    const claim = claimLearningTaskAdmission({
      principalId: keyAlias,
      clientId: stamp.client_id,
      taskInstanceId: stamp.task_instance_id,
      attemptId: stamp.attempt_id,
      requestId: stamp.request_id,
      idempotencyKey: stamp.idempotency_key,
      requestFingerprint: params.learningTaskObservedFingerprint,
      surface: "delegate",
      gatewayEcho: learningTaskGatewayEcho,
    });
    if (claim.kind === "existing") {
      sendLearningTaskAdmissionRecovery(res, lctx, claim.record.gatewayEcho);
      return ZERO_RESULT;
    }
    if (claim.kind === "conflict") {
      lctx.status = 409;
      lctx.outcome = "learning_task_conflict";
      lctx.errorClass = "learning_task_conflict";
      sendError(res, makeError("learning_task_conflict"));
      return {
        totalTokens: 0,
        promptTokens: null,
        completionTokens: null,
        canonicalModel: null,
        ttftMs: null,
      };
    }
  }
  const runDelegate = () => delegate({
    prompt: params.prompt,
    taskType: params.taskType,
    systemPrompt: params.systemPrompt,
    maxTokens: effectiveMax,
    modelId: params.modelId,
    nodeId: params.nodeId,
    frontierModelId: params.frontierModelId,
    delegatorModelId: params.delegatorModelId,
    premiumBaselineModelId: params.premiumBaselineModelId,
    verifier: params.verifier,
    verifierName: params.verifierName,
    responseFormat: params.responseFormat,
    temperature: params.temperature,
    topP: params.topP,
    topK: params.topK,
    minP: params.minP,
    source: "gateway",
    keyAlias,
    // #4: the stamp was structurally validated in parseDelegateBody and — on the live /delegate
    // route — semantically validated by validateHuginRequestStamp before handleDelegate ever runs.
    // raw_fingerprint.digest is the canonical logical-task identity; record it alongside (never
    // instead of) the rendered `prompt` fingerprint the orchestrator already captures.
    canonicalTaskFingerprintSha256: params.learningTaskStamp?.raw_fingerprint.digest ?? null,
    // #5: the SAME admitted stamp, carried through in full so the delegate lane can bind ledger
    // evidence to its mechanically-verified prompt/harness/tool-policy/taxonomy identity — see
    // evidence-identity.ts's evidenceIdentityFromAdmittedStamp and orchestrator.ts's
    // deriveEvidenceIdentity. Undefined for every unstamped request, exactly like the fingerprint.
    learningTaskStamp: params.learningTaskStamp,
  });
  // A stamped claim is the durable "execution may have begun" boundary. delegate() can throw
  // after the upstream model has already answered (for example while persisting its ledger row),
  // so no exception from this point proves that replay is safe. Preserve the claim on every
  // failure; an exact retry will recover its echo with outcomeUnavailable instead of inferring
  // twice. All pre-model credit/quota/GPU refusals occur before handleDelegate and create no claim.
  const result = await runDelegate();
  sendJson(res, 200, {
    ...result,
    ...(learningTaskGatewayEcho === undefined
      ? {}
      : { learningTaskGatewayEcho }),
  });
  lctx.node = result.nodeId;
  lctx.model = result.modelId;
  const m = result.metrics;
  if (m) {
    return {
      totalTokens: m.promptTokens + m.completionTokens,
      promptTokens: m.promptTokens,
      completionTokens: m.completionTokens,
      // /delegate lets the orchestrator pick ANY model; that id is not a user-controlled label
      // but it is also not allow-list-canonicalized here, so keep it out of metrics → null.
      canonicalModel: null,
      ttftMs: null,
    };
  }
  return { totalTokens: effectiveMax, promptTokens: null, completionTokens: null, canonicalModel: null, ttftMs: null };
}

// ─── Speech-to-text (OpenAI /v1/audio/transcriptions) ─────────────────────────────────

/** The single whisper model the backend serves. Accepted client aliases all map to it. */
const WHISPER_MODEL = "whisper-1";
const WHISPER_ALIASES = new Set(["whisper-1", "kb-whisper-large", "whisper"]);

/** Backend verbose_json response shape (we always request verbose_json so `duration` is present). */
interface WhisperVerbose {
  task?: string;
  language?: string;
  duration?: number;
  text?: string;
  segments?: unknown[];
}

/**
 * Handle POST /v1/audio/transcriptions.
 *
 * Flow (mirrors the chat metered path's invariants, with a post-hoc audio-seconds cost):
 *   1. credit gate — refuse a key already over its lifetime cap (402) BEFORE transcribing.
 *   2. admission — acquire a GPU slot (owner preempts guest), same as chat.
 *   3. forward the audio to whisper-server as multipart, ALWAYS asking for verbose_json.
 *   4. meter by audio-seconds: cost = ceil(duration) * audioCreditsPerSecond, debited POST-HOC
 *      (the real cost is unknown until the backend returns duration). A failed upstream call
 *      charges 0 (billing invariant).
 *   5. owner-log the transcript ONLY under the owner guard; never log a guest's transcript, and
 *      never write the transcript to request_log / metrics (content-blind).
 *   6. return the client's requested response_format (json | verbose_json | text).
 *
 * lctx is populated directly here (this route does NOT go through admitAndMeterLogged): totalTokens
 * carries the audio SECONDS (a numeric, content-blind field) and creditsCharged the real cost.
 */
async function handleAudioTranscription(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: HomeserverConfig,
  controller: AdmissionController,
  principal: PrincipalContext,
  lctx: LogCtx
): Promise<void> {
  // Parse the incoming OpenAI multipart body (binary-safe). Hardened (DoS): an oversized upload is
  // rejected EARLY (413, on the declared Content-Length when present — before buffering) and the
  // read carries an idle/socket timeout so a slow-loris client cannot hold the connection open.
  const contentType = String(req.headers["content-type"] ?? "");
  let body: Buffer;
  try {
    body = await readBuffer(req, cfg.audioMaxBytes, cfg.audioReadIdleMs);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      // Map an oversized body to 413 payload_too_large (NOT a generic 400).
      lctx.status = 413;
      lctx.outcome = "payload_too_large";
      lctx.errorClass = "payload_too_large";
      sendError(res, makeError("payload_too_large", { message: "The uploaded audio file is too large." }));
      return;
    }
    // A read timeout / socket error — treat as a bad request (the body never fully arrived).
    lctx.status = 400;
    lctx.outcome = "bad_request";
    lctx.errorClass = "invalid_request_error";
    sendError(res, makeError("invalid_request_error", { message: "Could not read the request body." }));
    return;
  }

  let parsed;
  try {
    parsed = parseMultipart(body, contentType);
  } catch {
    lctx.status = 400;
    lctx.outcome = "bad_request";
    lctx.errorClass = "invalid_request_error";
    sendError(
      res,
      makeError("invalid_request_error", { message: "Expected a multipart/form-data body with an audio 'file'." })
    );
    return;
  }

  const file = parsed.files.find((f) => f.name === "file") ?? parsed.files[0];
  if (!file) {
    lctx.status = 400;
    lctx.outcome = "bad_request";
    lctx.errorClass = "invalid_request_error";
    sendError(
      res,
      makeError("invalid_request_error", { param: "file", message: "An audio 'file' part is required." })
    );
    return;
  }

  // Model: accept any whisper alias (all map to the single backend model). Canonicalize for the
  // log label and the allow-list check; the client's raw value is never used as a label.
  const requestedModelRaw = typeof parsed.fields["model"] === "string" ? parsed.fields["model"] : null;
  const requestedModel = requestedModelRaw && WHISPER_ALIASES.has(requestedModelRaw)
    ? WHISPER_MODEL
    : requestedModelRaw;
  lctx.model = WHISPER_MODEL;

  // Per-key allow-list (consistent with chat): empty list = allowed. A non-empty list must include
  // the requested whisper model (or the canonical WHISPER_MODEL when no model was specified).
  if (principal.modelAllowList.length > 0) {
    const candidate = requestedModel ?? WHISPER_MODEL;
    if (!principal.modelAllowList.includes(candidate)) {
      lctx.status = 403;
      lctx.outcome = "forbidden";
      lctx.errorClass = "model_not_allowed";
      sendError(
        res,
        makeError("model_not_allowed", {
          param: "model",
          message: `Your API key is not permitted to use model '${candidate}'.`,
        })
      );
      return;
    }
  }

  const responseFormat =
    typeof parsed.fields["response_format"] === "string" ? parsed.fields["response_format"] : "json";
  const language =
    typeof parsed.fields["language"] === "string" && parsed.fields["language"].trim() !== ""
      ? parsed.fields["language"].trim()
      : cfg.audioDefaultLanguage;

  // Validate/clamp the optional `temperature` BEFORE forwarding (cheap LOW). OpenAI's whisper
  // temperature is in [0, 1]; an out-of-range or non-numeric value is a clean 400 rather than a
  // value silently passed to the backend. Absent → leave it unset (backend default).
  const temperatureRaw = typeof parsed.fields["temperature"] === "string" ? parsed.fields["temperature"] : null;
  let temperature: number | null = null;
  if (temperatureRaw !== null) {
    const t = Number(temperatureRaw);
    if (!Number.isFinite(t) || t < 0 || t > 1) {
      lctx.status = 400;
      lctx.outcome = "bad_request";
      lctx.errorClass = "invalid_request_error";
      sendError(
        res,
        makeError("invalid_request_error", {
          param: "temperature",
          message: "temperature must be a number in the range [0, 1].",
        })
      );
      return;
    }
    temperature = t;
  }

  // ── Abuse control: mirror the chat metered path's discipline (reserve→reconcile + quota). ──
  //
  // The real cost is unknown until the backend returns `duration`, but we must NOT let that turn
  // into either an overdraft (HIGH) or a free ride (the zero-duration / TOCTOU MEDIUMs). So we take
  // the WORST CASE up-front: reserve ceil(audioMaxSeconds) * rate atomically against the lifetime
  // credit cap, exactly as the chat path reserves its token estimate. If the key cannot cover the
  // worst case the request is refused 402 BEFORE any transcription runs (this closes the TOCTOU and
  // the overdraft). After the backend responds we reconcile DOWN to the real audio-seconds cost.
  const worstCaseSeconds = Math.ceil(cfg.audioMaxSeconds);
  const worstCaseCost = worstCaseSeconds * cfg.audioCreditsPerSecond;
  let creditReserved = false;
  if (principal.keyHash !== null && principal.creditLimit > 0) {
    if (!reserveCredits(principal.keyHash, worstCaseCost).ok) {
      lctx.status = 402;
      lctx.outcome = "credits_exhausted";
      lctx.errorClass = "credits_exhausted";
      sendError(res, makeError("credits_exhausted"));
      return;
    }
    creditReserved = true;
  }
  // Unwind the credit reservation on any pre-transcription rejection below. Idempotent.
  const releaseReserve = (): void => {
    if (creditReserved) {
      reconcileCredits(principal.keyHash!, worstCaseCost, 0);
      creditReserved = false;
    }
  };

  // RPM / TPM / daily quota — the audio route must not bypass per-key rate limits (mirror chat).
  // We meter the WORST-CASE audio-seconds against TPM (the chat path's "estimate"); recordUsage()
  // reconciles down to the real seconds after the call. A reservation handle reconciles the exact
  // admitted event under concurrency, exactly as chat does.
  const quotaEst = worstCaseSeconds;
  const q = checkQuota(principal.alias, principal.limits, quotaEst);
  if (!q.ok) {
    releaseReserve();
    const windowLabel = q.reason === "daily" ? "the daily token budget" : `the ${q.reason} window`;
    lctx.status = 429;
    lctx.outcome = "rate_limited";
    lctx.errorClass = "rate_limit_exceeded";
    lctx.retryAfterS = q.retryAfterSeconds;
    lctx.admission = "n/a";
    recordRateLimited("quota");
    sendError(
      res,
      makeError("rate_limit_exceeded", {
        retryAfterSeconds: q.retryAfterSeconds,
        message: `Rate limit reached for ${windowLabel}. Retry after ${q.retryAfterSeconds}s.`,
        rateLimit: {
          limit: q.reason === "tpm" ? q.snapshot.tpmLimit : q.snapshot.rpmLimit,
          remaining: 0,
          resetSeconds: q.snapshot.resetSeconds,
        },
      })
    );
    return;
  }

  // Admission: a transcription is GPU work, so it shares the chat lane budget (owner preempts guest).
  const admitStart = Date.now();
  let release: () => void;
  try {
    release = await controller.acquire({
      lane: principal.tier as Lane,
      requestedModel: WHISPER_MODEL,
      keyMaxParallel: principal.maxParallel,
      keyInflight: keyInflight.get(principal.alias) ?? 0,
      keyId: principal.alias,
    });
    const waited = Date.now() - admitStart;
    lctx.queueWaitMs = waited > 5 ? waited : null;
    lctx.admission = "admitted";
  } catch (err) {
    if (err instanceof AdmissionRejected) {
      releaseReserve();
      // Roll back the quota reservation — a request rejected at admission never ran.
      recordUsage(principal.alias, 0, Date.now(), q.reservation);
      lctx.status = 503;
      lctx.outcome = "busy";
      lctx.errorClass = "server_busy";
      lctx.retryAfterS = err.retryAfterSeconds;
      lctx.admission = "busy";
      recordAdmissionRejection(principal.tier);
      sendError(res, makeError("server_busy", { retryAfterSeconds: err.retryAfterSeconds }));
      return;
    }
    releaseReserve();
    recordUsage(principal.alias, 0, Date.now(), q.reservation);
    throw err;
  }

  incInflight(principal.alias);
  inflightInc(principal.tier);
  const callStart = Date.now();
  // Reconciliation accumulators. Default to 0 so EVERY early-return failure path below (upstream
  // down/timeout, non-2xx, non-JSON) results in a FULL REFUND: the finally block reconciles the
  // credit reservation and the quota reservation to 0 — a failed call is never billed (mirrors the
  // chat path's C2 invariant; keeps the existing "0 charge on upstream failure" tests green). The
  // success path overwrites these with the real audio-seconds cost (or the clamped worst case on a
  // bogus/over-cap duration FAULT — never 0 on a 2xx).
  let actualSeconds = 0;
  let actualCost = 0;
  try {
    // Forward to whisper-server. ALWAYS request verbose_json so the backend returns the top-level
    // `duration` (full audio length in seconds) we meter on — regardless of what the client asked.
    const form = new FormData();
    // Copy the file bytes into a fresh ArrayBuffer-backed Uint8Array — a valid BlobPart whose
    // backing buffer is statically known to be ArrayBuffer (not SharedArrayBuffer), and binary-safe.
    const fileBytes = Uint8Array.from(file.data);
    form.append("file", new Blob([fileBytes], { type: file.contentType ?? "application/octet-stream" }), file.filename ?? "audio");
    form.append("response_format", "verbose_json");
    form.append("language", language);
    // Forward the validated/clamped temperature (already range-checked above) — never the raw field.
    if (temperature !== null) form.append("temperature", String(temperature));
    if (typeof parsed.fields["prompt"] === "string") form.append("prompt", parsed.fields["prompt"]);

    let upstream: Response;
    try {
      upstream = await fetch(`${cfg.whisperUrl}/inference`, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(cfg.callTimeoutMs),
      });
    } catch (err) {
      // Graceful degradation: reuse the same envelopes/outcomes as the chat path. Charge 0.
      const kind = classifyUpstreamError(err);
      if (kind === "upstream_timeout") {
        lctx.status = 504;
        lctx.outcome = "upstream_timeout";
        lctx.errorClass = "upstream_timeout";
        sendError(res, makeError("upstream_timeout", { retryAfterSeconds: cfg.busyRetryAfterSeconds }));
        return;
      }
      if (kind === "upstream_unavailable") {
        lctx.status = 502;
        lctx.outcome = "upstream_unavailable";
        lctx.errorClass = "upstream_unavailable";
        sendError(res, makeError("upstream_unavailable"));
        return;
      }
      throw err;
    }

    let text: string;
    try {
      text = await upstream.text();
    } catch (err) {
      const kind = classifyUpstreamError(err);
      if (kind === "upstream_timeout") {
        lctx.status = 504;
        lctx.outcome = "upstream_timeout";
        lctx.errorClass = "upstream_timeout";
        sendError(res, makeError("upstream_timeout", { retryAfterSeconds: cfg.busyRetryAfterSeconds }));
        return;
      }
      if (kind === "upstream_unavailable") {
        lctx.status = 502;
        lctx.outcome = "upstream_unavailable";
        lctx.errorClass = "upstream_unavailable";
        sendError(res, makeError("upstream_unavailable"));
        return;
      }
      throw err;
    }

    // Any non-2xx from the backend is an errored response — forward a uniform 502 and charge 0.
    if (upstream.status >= 400) {
      lctx.status = 502;
      lctx.outcome = "upstream_unavailable";
      lctx.errorClass = "upstream_unavailable";
      sendError(res, makeError("upstream_unavailable"));
      return;
    }

    let backend: WhisperVerbose;
    try {
      backend = JSON.parse(text) as WhisperVerbose;
    } catch {
      // The backend returned a non-JSON 2xx body — treat as a backend fault, charge 0.
      lctx.status = 502;
      lctx.outcome = "upstream_unavailable";
      lctx.errorClass = "upstream_unavailable";
      sendError(res, makeError("upstream_unavailable"));
      return;
    }

    const transcript = typeof backend.text === "string" ? backend.text : "";
    // Meter by audio-seconds from the backend's top-level duration.
    //
    // A VALID duration is a finite number in (0, audioMaxSeconds] → charge ceil(duration)*rate and
    // reconcile the worst-case reservation DOWN to it (refund the rest).
    //
    // A duration that is missing / 0 / non-finite / negative / ABOVE audioMaxSeconds is a backend
    // FAULT (it ignored verbose_json, or reported nonsense). We must NOT let that be a free ride
    // (the zero-duration MEDIUM) and must NOT under-charge: charge the CLAMPED worst case
    // (audioMaxSeconds * rate) — never 0 on a 2xx. This is the up-front reservation, so the
    // reconcile is a no-op (we keep the full reservation).
    const rawDuration = backend.duration;
    const durationValid =
      typeof rawDuration === "number" &&
      Number.isFinite(rawDuration) &&
      rawDuration > 0 &&
      rawDuration <= cfg.audioMaxSeconds;
    const durationSec = durationValid ? rawDuration : 0;
    // audioSeconds is the BILLED seconds: ceil(real) for a valid duration, else the clamped cap.
    const audioSeconds = durationValid ? Math.ceil(rawDuration) : worstCaseSeconds;
    actualSeconds = audioSeconds;
    actualCost = audioSeconds * cfg.audioCreditsPerSecond;

    // CONTENT-BLIND accounting fields for the request_log + metrics (set on lctx; emitted in the
    // finally block). totalTokens carries the audio SECONDS (numeric, content-blind). The transcript
    // is NEVER placed on lctx. The credit/quota reconciliation itself runs in finally.
    lctx.totalTokens = audioSeconds;
    lctx.creditsCharged = actualCost;
    lctx.status = 200;
    lctx.outcome = "ok";
    recordAudioSeconds(WHISPER_MODEL, audioSeconds);

    // OWNER-ONLY transcript capture — identical guard to the chat path (tier owner AND a real
    // minted key). Guests / legacy static / implicit-admin NEVER get a content row.
    if (cfg.ownerRequestLog === "on" && principal.tier === "owner" && principal.keyHash !== null) {
      recordOwnerRequest({
        alias: principal.alias,
        model: WHISPER_MODEL,
        route: "audio",
        // No prompt messages for transcription — record the request params (NOT the audio bytes).
        messagesJson: JSON.stringify({ language, response_format: responseFormat, durationSec }),
        completion: transcript,
        promptTokens: null,
        completionTokens: null,
        latencyMs: Date.now() - callStart,
        tokPerSec: null,
        outcome: "ok",
      });
    }

    // Map the backend's verbose_json to the client's requested response_format.
    if (responseFormat === "verbose_json") {
      sendJson(res, 200, backend);
    } else if (responseFormat === "text") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end(transcript);
    } else {
      // Default "json" → OpenAI's minimal {text} shape.
      sendJson(res, 200, { text: transcript });
    }
  } finally {
    release();
    decInflight(principal.alias);
    inflightDec(principal.tier);
    // Reconcile the quota reservation to the REAL audio-seconds (worst-case estimate → actual).
    // A failed call left actualSeconds 0, so the TPM/daily reservation is fully released; the chat
    // path's recordUsage(...reservation) contract reconciles by event id under concurrency.
    recordUsage(principal.alias, actualSeconds, Date.now(), q.reservation);
    // Settle the lifetime credit ledger for minted store keys. We reserved worstCaseCost up-front;
    // reconcile it DOWN to the real cost (a valid duration refunds the difference; a fault keeps the
    // full reservation; a failed call → actualCost 0 → full refund). Legacy static / implicit-admin
    // (keyHash null) reserved nothing and are uncapped by design.
    if (principal.keyHash !== null) {
      if (creditReserved) {
        reconcileCredits(principal.keyHash, worstCaseCost, actualCost);
        creditReserved = false;
      } else {
        // Uncapped minted key (creditLimit 0): nothing reserved → accrue real usage directly
        // (recordCreditUsage is a no-op for cost 0, so a failed call still charges nothing).
        recordCreditUsage(principal.keyHash, actualCost);
      }
    }
  }
}

// ─── Image generation (OpenAI /v1/images/generations) ─────────────────────────────────

/**
 * Handle POST /v1/images/generations (text→image).
 *
 * Self-meters like the audio path (reserve worst-case credits → quota → admission → dispatch →
 * reconcile), but with a tier split:
 *   • fast tier  → SYNCHRONOUS: acquire a GPU slot, block on the sidecar, return {created, data}.
 *   • bal/high   → ASYNC: reserve credits+quota, enqueue a job, return 202. The single-slot worker
 *     then acquires admission, dispatches, and OWNS the reconcile/refund from there.
 *
 * Inert when HOMESERVER_IMAGE_URL is unset → 404 (so merging the code changes nothing on a box).
 */
async function handleImageGeneration(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: HomeserverConfig,
  controller: AdmissionController,
  principal: PrincipalContext,
  lctx: LogCtx
): Promise<void> {
  if (cfg.imageUrl === "") {
    lctx.status = 404;
    lctx.outcome = "not_found";
    lctx.errorClass = "not_found";
    sendError(res, makeError("not_found", { message: "Image generation is not enabled on this server." }));
    return;
  }

  let raw: string;
  try {
    raw = await readBody(req);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      lctx.status = 413;
      lctx.outcome = "payload_too_large";
      lctx.errorClass = "payload_too_large";
      sendError(res, makeError("payload_too_large"));
      return;
    }
    throw err;
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    lctx.status = 400;
    lctx.outcome = "bad_request";
    lctx.errorClass = "invalid_request_error";
    sendError(res, makeError("invalid_request_error", { message: "Request body must be valid JSON." }));
    return;
  }

  const parsed = parseImageRequest(json, cfg, principal.modelAllowList);
  if (isImageRequestError(parsed)) {
    lctx.status = parsed.error.status;
    lctx.outcome = parsed.error.status === 403 ? "forbidden" : "bad_request";
    lctx.errorClass = parsed.error.class;
    sendError(res, makeError(parsed.error.class, { param: parsed.error.param, message: parsed.error.message }));
    return;
  }
  lctx.model = parsed.model;

  // Bench/maintenance mode (#108): refuse GUEST image work outright. This covers the ASYNC
  // (balanced/high) path — which otherwise returns 202 and runs later on the shared GPU slot,
  // bypassing the admission gate — as well as the sync path. Owners are unaffected. Placed
  // BEFORE any credit/quota reservation so there is nothing to refund. Same server_busy
  // envelope + maintenance Retry-After as the chat/audio admission rejection.
  if (controller.isMaintenanceMode() && principal.tier !== "owner") {
    const retryAfterSeconds = cfg.maintenanceRetryAfterSeconds;
    lctx.status = 503;
    lctx.outcome = "busy";
    lctx.errorClass = "server_busy";
    lctx.retryAfterS = retryAfterSeconds;
    lctx.admission = "busy";
    recordAdmissionRejection(principal.tier);
    sendError(res, makeError("server_busy", { retryAfterSeconds }));
    return;
  }

  // ── Reserve worst-case credits up-front (mirror audio): n × per-image price, atomically against
  //    the lifetime cap. A near-cap key is refused 402 BEFORE any work runs. ──
  const creditsPerImage = cfg.imageCreditsPerImage[parsed.tier];
  const worstCaseCost = parsed.n * creditsPerImage;
  const capped = principal.keyHash !== null && principal.creditLimit > 0;
  let creditReserved = false;
  if (capped) {
    if (!reserveCredits(principal.keyHash!, worstCaseCost).ok) {
      lctx.status = 402;
      lctx.outcome = "credits_exhausted";
      lctx.errorClass = "credits_exhausted";
      sendError(res, makeError("credits_exhausted"));
      return;
    }
    creditReserved = true;
  }
  const releaseReserve = (): void => {
    if (creditReserved) {
      reconcileCredits(principal.keyHash!, worstCaseCost, 0);
      creditReserved = false;
    }
  };

  // ── Quota: meter n IMAGE UNITS through the same path audio meters seconds (1 request vs RPM,
  //    n units vs the TPM-style budget). Reconciled to the delivered count after the call. ──
  const q = checkQuota(principal.alias, principal.limits, parsed.n);
  if (!q.ok) {
    releaseReserve();
    const windowLabel = q.reason === "daily" ? "the daily token budget" : `the ${q.reason} window`;
    lctx.status = 429;
    lctx.outcome = "rate_limited";
    lctx.errorClass = "rate_limit_exceeded";
    lctx.retryAfterS = q.retryAfterSeconds;
    lctx.admission = "n/a";
    recordRateLimited("quota");
    sendError(
      res,
      makeError("rate_limit_exceeded", {
        retryAfterSeconds: q.retryAfterSeconds,
        message: `Rate limit reached for ${windowLabel}. Retry after ${q.retryAfterSeconds}s.`,
        rateLimit: {
          limit: q.reason === "tpm" ? q.snapshot.tpmLimit : q.snapshot.rpmLimit,
          remaining: 0,
          resetSeconds: q.snapshot.resetSeconds,
        },
      })
    );
    return;
  }

  const ownerCapture =
    cfg.ownerRequestLog === "on" && principal.tier === "owner" && principal.keyHash !== null;
  const backendModel = cfg.imageBackendModels[parsed.tier];

  // ── Async (balanced/high): hand to the worker; it owns the reconcile/refund from here. ──
  if (!parsed.sync) {
    try {
      const sub: ImageJobSubmission = {
        parsed,
        alias: principal.alias,
        keyHash: principal.keyHash,
        lane: principal.tier as "owner" | "guest",
        creditsReserved: creditReserved ? worstCaseCost : 0,
        capped,
        creditsPerImage,
        quotaReservation: q.reservation,
        backendModel,
        ownerCapture,
      };
      const view = submitImageJob(controller, sub);
      // The worker counts the delivered units on completion; don't double-count on the submit row.
      lctx.status = 202;
      lctx.outcome = "ok";
      lctx.admission = "n/a";
      sendJson(res, 202, {
        id: view.id,
        status: view.status,
        model: view.model,
        n: view.n,
        created: view.created,
        expires_at: view.expiresAt,
      });
    } catch (err) {
      // Scheduling failed before the job was persisted → refund everything.
      releaseReserve();
      recordUsage(principal.alias, 0, Date.now(), q.reservation);
      console.error("[gateway] image job submission failed:", err);
      lctx.status = 500;
      lctx.outcome = "error";
      lctx.errorClass = "internal_error";
      sendError(res, makeError("internal_error"));
    }
    return;
  }

  // ── Sync (fast): acquire a GPU slot (owner preempts guest), dispatch, reconcile in finally. ──
  const admitStart = Date.now();
  let release: () => void;
  try {
    release = await controller.acquire({
      lane: principal.tier as Lane,
      requestedModel: backendModel,
      keyMaxParallel: principal.maxParallel,
      keyInflight: keyInflight.get(principal.alias) ?? 0,
      keyId: principal.alias,
    });
    const waited = Date.now() - admitStart;
    lctx.queueWaitMs = waited > 5 ? waited : null;
    lctx.admission = "admitted";
  } catch (err) {
    if (err instanceof AdmissionRejected) {
      releaseReserve();
      recordUsage(principal.alias, 0, Date.now(), q.reservation);
      lctx.status = 503;
      lctx.outcome = "busy";
      lctx.errorClass = "server_busy";
      lctx.retryAfterS = err.retryAfterSeconds;
      lctx.admission = "busy";
      recordAdmissionRejection(principal.tier);
      sendError(res, makeError("server_busy", { retryAfterSeconds: err.retryAfterSeconds }));
      return;
    }
    releaseReserve();
    recordUsage(principal.alias, 0, Date.now(), q.reservation);
    throw err;
  }

  incInflight(principal.alias);
  inflightInc(principal.tier);
  const callStart = Date.now();
  let delivered = 0;
  let actualCost = 0;
  try {
    let b64: string[];
    try {
      b64 = await generateImages(
        cfg.imageUrl,
        { prompt: parsed.prompt, model: backendModel, n: parsed.n, size: parsed.size },
        cfg.imageJobTimeoutMs
      );
    } catch (err) {
      if (err instanceof ImageSidecarError) {
        if (err.kind === "upstream_timeout") {
          lctx.status = 504;
          lctx.outcome = "upstream_timeout";
          lctx.errorClass = "upstream_timeout";
          sendError(res, makeError("upstream_timeout", { retryAfterSeconds: cfg.busyRetryAfterSeconds }));
          return;
        }
        lctx.status = 502;
        lctx.outcome = "upstream_unavailable";
        lctx.errorClass = "upstream_unavailable";
        sendError(res, makeError("upstream_unavailable"));
        return;
      }
      throw err;
    }

    delivered = b64.length;
    actualCost = delivered * creditsPerImage;
    lctx.totalTokens = delivered;
    lctx.creditsCharged = actualCost;
    lctx.status = 200;
    lctx.outcome = "ok";
    recordImagesGenerated(parsed.model, delivered);
    if (ownerCapture) {
      recordOwnerRequest({
        alias: principal.alias,
        model: parsed.model,
        route: "image",
        messagesJson: JSON.stringify({ prompt: parsed.prompt, size: parsed.size, n: parsed.n }),
        completion: `${delivered} image(s) generated`,
        promptTokens: null,
        completionTokens: null,
        latencyMs: Date.now() - callStart,
        tokPerSec: null,
        outcome: "ok",
      });
    }
    sendJson(res, 200, { created: Math.floor(callStart / 1000), data: b64.map((s) => ({ b64_json: s })) });
  } finally {
    release();
    decInflight(principal.alias);
    inflightDec(principal.tier);
    // Reconcile quota to delivered images (failed call → 0 → full release).
    recordUsage(principal.alias, delivered, Date.now(), q.reservation);
    if (principal.keyHash !== null) {
      if (creditReserved) {
        reconcileCredits(principal.keyHash, worstCaseCost, actualCost);
        creditReserved = false;
      } else {
        recordCreditUsage(principal.keyHash, actualCost);
      }
    }
  }
}

/**
 * GET /v1/images/generations/jobs/{id} — poll an async job. Scoped to the creator; a non-owner /
 * unknown id returns a bare 404 (no enumeration oracle).
 */
function handleImageJobGet(res: ServerResponse, principal: PrincipalContext, id: string, lctx: LogCtx): void {
  lctx.route = "/v1/images/generations/jobs/:id";
  const view = getImageJob(id, { keyHash: principal.keyHash, alias: principal.alias });
  if (!view) {
    lctx.status = 404;
    lctx.outcome = "not_found";
    lctx.errorClass = "not_found";
    sendError(res, makeError("not_found", { message: "No such image job." }));
    return;
  }
  lctx.status = 200;
  lctx.outcome = "ok";
  lctx.admission = "n/a";
  lctx.model = view.model;
  sendJson(res, 200, {
    id: view.id,
    status: view.status,
    model: view.model,
    n: view.n,
    created: view.created,
    expires_at: view.expiresAt,
    error: view.errorClass ? { code: view.errorClass } : undefined,
    data: view.data,
  });
}

/** DELETE /v1/images/generations/jobs/{id} — cancel + refund, idempotent. Scoped to the creator. */
function handleImageJobCancel(
  res: ServerResponse,
  controller: AdmissionController,
  principal: PrincipalContext,
  id: string,
  lctx: LogCtx
): void {
  lctx.route = "/v1/images/generations/jobs/:id";
  const out = cancelImageJob(controller, id, { keyHash: principal.keyHash, alias: principal.alias });
  if (!out.found) {
    lctx.status = 404;
    lctx.outcome = "not_found";
    lctx.errorClass = "not_found";
    sendError(res, makeError("not_found", { message: "No such image job." }));
    return;
  }
  lctx.status = 200;
  lctx.outcome = "ok";
  lctx.admission = "n/a";
  sendJson(res, 200, { id, status: out.status ?? "cancelled" });
}

async function handleAdminLoad(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = JSON.parse(await readBody(req)) as {
    modelKey?: string;
    contextLength?: number;
    parallel?: number;
    gpu?: string;
    ttlSeconds?: number;
  };
  if (!body.modelKey) {
    sendError(res, makeError("invalid_request_error", { param: "modelKey", message: "Missing required field 'modelKey'." }));
    return;
  }
  const r = await loadModel(body.modelKey, {
    contextLength: body.contextLength,
    parallel: body.parallel,
    gpu: body.gpu,
    ttlSeconds: body.ttlSeconds,
  });
  sendJson(res, r.ok ? 200 : 500, r);
}

async function handleAdminUnload(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = JSON.parse(await readBody(req)) as { modelKey?: string };
  const r = await unloadModel(body.modelKey);
  sendJson(res, r.ok ? 200 : 500, r);
}

async function handleAdminDownload(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = JSON.parse(await readBody(req)) as { modelKey?: string; wait?: boolean };
  if (!body.modelKey) {
    sendError(res, makeError("invalid_request_error", { param: "modelKey", message: "Missing required field 'modelKey'." }));
    return;
  }
  const r = await downloadModel(body.modelKey, { wait: body.wait });
  sendJson(res, r.ok ? 200 : 500, r);
}

async function handleKeysMint(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: HomeserverConfig
): Promise<void> {
  const body = JSON.parse(await readBody(req)) as {
    alias?: string;
    tier?: Tier;
    modelAllowList?: string[];
    rpm?: number;
    tpm?: number;
    dailyTokenBudget?: number;
    maxParallel?: number;
    creditLimit?: number;
    ttlSeconds?: number;
  };
  if (!body.alias || (body.tier !== "owner" && body.tier !== "guest")) {
    sendError(res, makeError("invalid_request_error", { message: "Require 'alias' and 'tier' (owner|guest)." }));
    return;
  }
  let result;
  try {
    result = mintKey(
      {
        alias: body.alias,
        tier: body.tier,
        modelAllowList: body.modelAllowList,
        rpm: body.rpm,
        tpm: body.tpm,
        dailyTokenBudget: body.dailyTokenBudget,
        maxParallel: body.maxParallel,
        creditLimit: body.creditLimit,
        ttlSeconds: body.ttlSeconds,
      },
      cfg.keyDefaults
    );
  } catch (err) {
    // A bad numeric limit (negative / fractional creditLimit, rpm, …) is a clean client error
    // (Fix #5): return the enveloped invalid_request_error naming the offending param rather
    // than letting a "-1 ⇒ unlimited" value through or surfacing a 500.
    if (err instanceof InvalidParamError) {
      sendError(
        res,
        makeError("invalid_request_error", { param: err.param, message: err.message })
      );
      return;
    }
    // A duplicate alias is a clean client error, not a server fault — return 409 without
    // ever surfacing the raw SQLite constraint string. Any other error propagates to the
    // top-level handler (which returns a generic 500).
    if (err instanceof KeyAliasExistsError) {
      sendError(res, makeError("alias_exists", { message: `A key with alias '${err.alias}' already exists.` }));
      return;
    }
    throw err;
  }
  sendJson(res, 201, result);
}

// ─── Server ──────────────────────────────────────────────────────────────────────────

export interface GatewayHandle {
  /** The bound port (useful when HOMESERVER_PORT=0 picks an ephemeral port). */
  port: number;
  /** Stop the server (resolves when fully closed). */
  stop: () => Promise<void>;
}

export function startGateway(): Promise<GatewayHandle> {
  const cfg = loadConfig();
  try {
    // #257: install the content-blind exposure schema and finish the idempotent retained-log
    // backfill before the port accepts traffic. The lookup route itself remains strictly read-only.
    initializeTaskExposureRegistry();
  } catch (err) {
    return Promise.reject(new Error(`Could not initialize task exposure registry: ${(err as Error).message}`));
  }
  const loopback =
    cfg.gatewayHost === "127.0.0.1" || cfg.gatewayHost === "localhost" || cfg.gatewayHost === "::1";
  // "No keys" now means no legacy keys AND no store keys.
  const noStoreKeys = listKeys().length === 0;
  const noKeys =
    cfg.apiKeys.length === 0 &&
    cfg.adminApiKeys.length === 0 &&
    cfg.monitorApiKeys.length === 0 &&
    noStoreKeys;

  if (noKeys && !loopback) {
    return Promise.reject(
      new Error(
        `Refusing to bind ${cfg.gatewayHost} with no API keys — set HOMESERVER_API_KEYS (and HOMESERVER_ADMIN_API_KEYS) or mint a key before exposing to the LAN.`
      )
    );
  }

  // Install a no-op access logger when logging is disabled (HOMESERVER_ACCESS_LOG=off).
  if (cfg.accessLog === "off") {
    setDefaultLogger(createAccessLogger(() => { /* no-op */ }));
  }

  const controller = new AdmissionController({
    maxInflight: cfg.maxInflight,
    ownerQueueMaxMs: cfg.ownerQueueMaxMs,
    retryAfterAtCapSeconds: cfg.busyRetryAfterSeconds,
    maintenanceRetryAfterSeconds: cfg.maintenanceRetryAfterSeconds,
    maintenanceMode: cfg.maintenanceModeAtStart,
  });
  if (cfg.maintenanceModeAtStart) {
    console.warn("⚠  bench/maintenance mode ENGAGED at startup — guest admission is refused (#108).");
  }

  // Start the single-slot diffusion worker only when an image sidecar is configured. When unset the
  // whole image surface is inert, so there is nothing to schedule. Runs restart-recovery on start.
  const imageWorker = cfg.imageUrl !== "" ? startImageWorker(cfg, controller) : null;

  // Freeze the implicit-admin posture once, here, from the actual bind host. Never
  // re-derived per request, so it cannot drift open as keys are revoked/expire.
  const implicitAdminAllowed = isImplicitAdminAllowed(cfg, loopback);
  // Process/configuration epoch for LearningTaskContract advertisements. Its secret rotates on
  // every gateway start, so cached preflight evidence from an earlier deployment fails closed.
  const learningTaskCapabilityEpoch = createLearningTaskCapabilityEpoch();

  // Warm the trusted-catalogue cache in the background so empty-allow-list (owner/admin) requests
  // get a per-model label from the first request onward. Fire-and-forget — never blocks startup,
  // and a failure just leaves the cache empty (→ "unknown" labels) until the next refresh.
  void warmCatalogue();

  // code_loop (#116): sweep at startup AND periodically. Source-bearing durable results must
  // expire without requiring a gateway restart; no-overlap keeps maintenance work bounded.
  let codeLoopSweepTimer: NodeJS.Timeout | null = null;
  if (cfg.codeLoop === "on") {
    const sweepCfg = { workroot: resolve(cfg.codeLoopWorkroot), retentionTtlMs: 24 * 60 * 60 * 1000 };
    const sweepDeps = {
      now: Date.now,
      stopUnit: (unit: string) =>
        new Promise<void>((done) => {
          execFile("systemctl", ["--user", "stop", unit], () => done());
        }),
    };
    let sweepInFlight = false;
    const sweepOnce = (): void => {
      if (sweepInFlight) return;
      sweepInFlight = true;
      void sweepCodeLoopSandboxes(sweepCfg, sweepDeps)
        .catch((err) => console.error("[code-loop] periodic sweep failed (ignored):", err))
        .finally(() => { sweepInFlight = false; });
    };
    sweepOnce();
    codeLoopSweepTimer = setInterval(sweepOnce, 60_000);
    codeLoopSweepTimer.unref();
  }

  const server: Server = createServer((req, res) => {
    void handleRequest(
      req,
      res,
      cfg,
      controller,
      implicitAdminAllowed,
      learningTaskCapabilityEpoch,
    ).catch((err) => {
      // Never leak raw error detail (SQLite internals, stack traces, etc.) to the client.
      // Log the detail server-side; return a generic uniform envelope.
      console.error("[gateway] unhandled request error:", err);
      if (!res.headersSent) sendError(res, makeError("internal_error"));
      else res.end();
    });
  });

  return new Promise((resolve) => {
    server.listen(cfg.gatewayPort, cfg.gatewayHost, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : cfg.gatewayPort;
      console.log(`home-server gateway on http://${cfg.gatewayHost}:${port}`);
      if (noKeys)
        console.warn(
          "⚠  AUTH DISABLED (no API keys, loopback only). Set HOMESERVER_API_KEYS for LAN use."
        );
      console.log(`   proxying LM Studio at ${cfg.lmStudioBaseUrl}`);
      resolve({
        port,
        stop: () =>
          new Promise<void>((r) => {
            if (imageWorker) imageWorker.stop();
            if (codeLoopSweepTimer !== null) clearInterval(codeLoopSweepTimer);
            server.close(() => r());
          }),
      });
    });
  });
}

// ─── Access-log context (accumulated per request, emitted once in finally) ─────────────

interface LogCtx {
  requestId: string;
  method: string;
  route: string;
  principal: string | null;
  tier: "owner" | "guest" | null;
  model: string | null;
  node: "m5" | "orin";
  status: number | null;
  outcome: string;
  errorClass: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  creditsCharged: number | null;
  queueWaitMs: number | null;
  ttftMs: number | null;
  totalMs: number | null;
  admission: string | null;
  retryAfterS: number | null;
  /** sha256(token) of the minted key — for the owner's own request_log joins. null otherwise. */
  keyHash: string | null;
}

/**
 * Percent-decode a raw `:id`/`:alias` path segment. decodeURIComponent throws a URIError on
 * malformed percent-encoding (e.g. a bare '%' or an incomplete escape) — without this guard
 * that surfaced as an unhandled 500 instead of a 400 (#229). On failure this writes the
 * invalid_request_error response itself (400 — malformed input is a client error, not a
 * missing-resource 404) and updates lctx; callers just check for null and return.
 */
function decodePathSegmentOrSend(raw: string, res: ServerResponse, lctx: LogCtx): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    lctx.status = 400;
    lctx.outcome = "bad_request";
    lctx.errorClass = "invalid_request_error";
    lctx.admission = "n/a";
    sendError(
      res,
      makeError("invalid_request_error", { message: "Malformed percent-encoding in the URL path." })
    );
    return null;
  }
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: HomeserverConfig,
  controller: AdmissionController,
  implicitAdminAllowed: boolean,
  learningTaskCapabilityEpoch: LearningTaskCapabilityEpoch,
): Promise<void> {
  const startMs = Date.now();
  // Create lctx and logThis BEFORE any parsing — so a URL-parse failure is still logged.
  const lctx: LogCtx = {
    requestId: randomUUID(),
    method: req.method ?? "GET",
    route: "/",
    principal: null,
    tier: null,
    model: null,
    node: "m5",
    status: null,
    outcome: "ok",
    errorClass: null,
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
    creditsCharged: null,
    queueWaitMs: null,
    ttftMs: null,
    totalMs: null,
    admission: null,
    retryAfterS: null,
    keyHash: null,
  };
  // Default: log every request. Healthz is gated by cfg.accessLogHealthz (default off).
  let logThis = true;

  // Single finally block — the ONLY emit site for gateway_request events.
  try {
    // URL parsing uses a safe base; a malformed Host header won't prevent logging.
    const parsedUrl = new URL(req.url ?? "/", "http://localhost");
    const path = parsedUrl.pathname;
    const method = lctx.method;
    lctx.route = path;

    // Resolve the caller's principal once, up front, so the read-only MONITOR scope is enforced
    // before ANY route dispatch — including the public /portal*, /portal/feedback and /hs routes
    // below. principal may be null (no/invalid token): public routes tolerate that; protected
    // routes reject at the canonical 401 gate further down.
    const principal = resolvePrincipal(req, cfg, implicitAdminAllowed);
    if (principal?.isMonitor) {
      const monitorOk =
        method === "GET" &&
        (path === "/ledger" || path.startsWith("/ledger/") || path === "/healthz" || path === "/metrics" || path === "/models");
      if (!monitorOk) {
        lctx.status = 403;
        lctx.outcome = "forbidden";
        lctx.errorClass = "model_not_allowed";
        sendError(
          res,
          makeError("model_not_allowed", {
            param: null,
            message: "This is a read-only monitor key (allowed: GET /healthz, /ledger, /metrics, /models).",
          })
        );
        return;
      }
    }

    // Health is unauthenticated (for router/uptime checks) — minimal liveness only.
    // Gate healthz logging behind the config toggle (default: off, to avoid noise).
    if (path === "/healthz" && method === "GET") {
      const orin = await probeOrin(cfg);
      sendJson(res, 200, { ok: true, nodes: [{ id: "m5", ok: true }, orin] });
      lctx.status = 200;
      lctx.outcome = "ok";
      lctx.admission = "n/a";
      logThis = cfg.accessLogHealthz === "on";
      return;
    }

    // MCP transport is POST-only (Streamable HTTP, JSON-RPC). A GET is rejected with 405
    // before auth — it carries no JSON-RPC message to process and needs no credential to
    // refuse. (POST /mcp is authenticated below, alongside the other bearer routes.)
    if (path === "/mcp" && method === "GET") {
      res.writeHead(405, { "content-type": "application/json", allow: "POST" });
      res.end(JSON.stringify({ error: { message: "Use POST for the MCP endpoint.", type: "invalid_request_error", code: "method_not_allowed", param: null } }));
      lctx.status = 405;
      lctx.outcome = "method_not_allowed";
      lctx.admission = "n/a";
      return;
    }

    // ─── Self-service portal (UNauthenticated surface) ───
    // GET / and GET /portal serve the static page. POST /portal/redeem trades an invite code
    // for a fresh key — the code IS the credential, so no bearer token is required here.
    //
    // Per-IP in-app throttle (Fix #2 / HIGH-1): defence-in-depth behind any upstream WAF so the
    // public surface cannot be hammered (invite brute-force / page flooding) even if the WAF is
    // misconfigured or absent. Returns the uniform rate_limit_exceeded envelope with Retry-After.
    const throttlePublic = (): boolean => {
      const rl = checkRateWindow(`ip:${clientIp(req, cfg.trustedProxies)}`, cfg.redeemRpm, cfg.publicWindowMs);
      if (rl.ok) return true;
      lctx.status = 429;
      lctx.outcome = "rate_limited";
      lctx.errorClass = "rate_limit_exceeded";
      lctx.retryAfterS = rl.retryAfterSeconds;
      lctx.admission = "n/a";
      recordRateLimited("redeem");
      sendError(
        res,
        makeError("rate_limit_exceeded", {
          retryAfterSeconds: rl.retryAfterSeconds,
          message: `Too many requests from your IP. Retry after ${rl.retryAfterSeconds}s.`,
        })
      );
      return false;
    };

    if ((path === "/portal" || path === "/") && method === "GET") {
      lctx.route = "/portal";
      if (!throttlePublic()) return;
      sendHtml(res, 200, portalHtml());
      lctx.status = 200;
      lctx.outcome = "ok";
      lctx.admission = "n/a";
      return;
    }
    if (path === "/portal/model-evals.json" && method === "GET") {
      // Public, content-blind feed for the portal's "New model evaluations" section.
      lctx.route = "/portal/model-evals.json";
      lctx.admission = "n/a";
      if (!throttlePublic()) return;
      let payload: ReturnType<typeof modelEvalsPayload>;
      try {
        payload = modelEvalsPayload();
      } catch {
        payload = { generatedAt: new Date().toISOString(), count: 0, models: [] };
      }
      res.setHeader("cache-control", "public, max-age=300");
      sendJson(res, 200, payload);
      lctx.status = 200;
      lctx.outcome = "ok";
      return;
    }
    if (path === "/portal/redeem" && method === "POST") {
      lctx.route = "/portal/redeem";
      lctx.admission = "n/a";
      if (!throttlePublic()) return;
      const raw = await readBody(req);
      let code: string | null = null;
      try {
        const b = JSON.parse(raw) as { code?: unknown };
        if (typeof b.code === "string" && b.code.trim() !== "") code = b.code.trim();
      } catch {
        // fall through to the bad-request envelope below
      }
      if (code === null) {
        lctx.status = 400;
        lctx.outcome = "bad_request";
        lctx.errorClass = "invalid_request_error";
        sendError(
          res,
          makeError("invalid_request_error", { param: "code", message: "A non-empty invite 'code' is required." })
        );
        return;
      }
      try {
        const minted = redeemInvite(code, cfg.keyDefaults);
        // no-store: the response body carries the plaintext key ONCE — keep it out of caches.
        res.setHeader("cache-control", "no-store");
        sendJson(res, 200, {
          key: minted.plaintextKey,
          alias: minted.record.alias,
          model: minted.record.modelAllowList.length > 0 ? minted.record.modelAllowList[0] : null,
          models: minted.record.modelAllowList,
          creditLimit: minted.record.creditLimit,
        });
        lctx.status = 200;
        lctx.outcome = "ok";
        lctx.principal = minted.record.alias;
      } catch (err) {
        // Uniform 409 for both unknown and already-used codes — never an enumeration oracle.
        // Dedicated invite_invalid code with the canonical uniform message (Fix #6): we do NOT
        // pass err.message through, so the body is identical regardless of which case it was.
        if (err instanceof InviteInvalidError) {
          lctx.status = 409;
          lctx.outcome = "invite_invalid";
          lctx.errorClass = "invite_invalid";
          res.setHeader("cache-control", "no-store");
          sendError(res, makeError("invite_invalid", { param: "code" }));
          return;
        }
        throw err;
      }
      return;
    }

    // GET /portal/stats — PUBLIC, UNAUTHENTICATED, content-blind grand aggregate that powers the
    // "served so far" card on the portal page. It exposes ONLY fleet-wide totals (total tokens,
    // total requests, since-date) summed from the DURABLE request_log — so the figure survives
    // restarts (unlike the in-memory Prometheus counters). It NEVER exposes per-user, per-key,
    // per-alias, per-model, or any content dimension. This is deliberately NOT /metrics (which is
    // authed and richer): the public surface gets nothing beyond grand totals. Cache-friendly.
    if (path === "/portal/stats" && method === "GET") {
      lctx.route = "/portal/stats";
      lctx.admission = "n/a";
      if (!throttlePublic()) return;
      let totals: { totalTokens: number; totalRequests: number; since: number | null };
      try {
        // cachedRequestLogTotals() avoids a full-table scan on every public hit by memoizing
        // the result for STATS_TTL_MS (30 s). The TTL matches the Cache-Control max-age so
        // cooperating clients and the origin cache agree on the freshness window.
        totals = cachedRequestLogTotals();
      } catch (err) {
        // On DB failure: log server-side, return 503 with no-store so the zeroed body is not
        // cached by intermediaries and the portal JS hides the stats card on non-OK responses.
        console.error("[gateway] /portal/stats db error:", err);
        res.setHeader("cache-control", "no-store");
        sendJson(res, 503, { error: { code: "stats_unavailable", message: "Stats temporarily unavailable." } });
        lctx.status = 503;
        lctx.outcome = "error";
        return;
      }
      // Small client/CDN cache so the public card can refresh without hammering SQLite.
      res.setHeader("cache-control", "public, max-age=30");
      sendJson(res, 200, {
        total_tokens: totals.totalTokens,
        total_requests: totals.totalRequests,
        since: totals.since,
      });
      lctx.status = 200;
      lctx.outcome = "ok";
      return;
    }

    // ─── Feedback (unauthenticated, but accepts an optional bearer key for alias capture) ───
    // POST /portal/feedback accepts plain text from any user — authenticated or not. Its purpose
    // is to let even a stuck user (e.g. cannot redeem yet) report a problem. When a valid bearer
    // key IS present the sender's alias is captured; otherwise alias is null.
    //
    // The feedback TEXT is user-submitted content the user chose to send — storing it verbatim
    // is correct and intentional. It is written to a private JSONL file, never to metrics labels
    // or the content-blind request_log.
    if (path === "/portal/feedback" && method === "POST") {
      lctx.route = "/portal/feedback";
      lctx.admission = "n/a";

      // Per-IP throttle: distinct from the redeem throttle (uses its own bucket prefix so it
      // does not share the public window with GET /portal / POST /portal/redeem).
      const feedbackRl = checkRateWindow(
        `fb:${clientIp(req, cfg.trustedProxies)}`,
        cfg.feedbackRpm,
        cfg.publicWindowMs
      );
      if (!feedbackRl.ok) {
        lctx.status = 429;
        lctx.outcome = "rate_limited";
        lctx.errorClass = "rate_limit_exceeded";
        lctx.retryAfterS = feedbackRl.retryAfterSeconds;
        recordRateLimited("feedback");
        sendError(
          res,
          makeError("rate_limit_exceeded", {
            retryAfterSeconds: feedbackRl.retryAfterSeconds,
            message: `Too many feedback submissions from your IP. Retry after ${feedbackRl.retryAfterSeconds}s.`,
          })
        );
        return;
      }

      // Optional auth: capture alias if a valid key is present, but do NOT reject on bad/absent key.
      // (A monitor key never reaches here — the early monitor gate 403s it before route dispatch.)
      const senderAlias = principal?.alias ?? null;

      // Parse body — size-capped to 16 KB to block body-stuffing.
      let raw: string;
      try {
        raw = await readBody(req, 16 * 1024);
      } catch (err) {
        // Codex finding 2: an over-cap body is a 413 payload_too_large, not a generic 400.
        const tooLarge = err instanceof BodyTooLargeError;
        lctx.status = tooLarge ? 413 : 400;
        lctx.outcome = "bad_request";
        lctx.errorClass = tooLarge ? "payload_too_large" : "invalid_request_error";
        sendError(res, makeError(tooLarge ? "payload_too_large" : "invalid_request_error"));
        return;
      }

      let feedbackText: string | null = null;
      let feedbackPage: string | null = null;
      try {
        const b = JSON.parse(raw) as { text?: unknown; page?: unknown };
        if (typeof b.text === "string") feedbackText = b.text;
        if (typeof b.page === "string") feedbackPage = b.page;
      } catch {
        // Malformed JSON — fall through to the validation error below.
      }

      // Validate: non-empty, non-whitespace, max 4000 chars.
      // Both checks operate on the trimmed value for consistent semantics: leading/trailing
      // whitespace is not meaningful feedback content and should not cause an over-length error.
      const feedbackTextTrimmed = feedbackText === null ? "" : feedbackText.trim();
      if (feedbackTextTrimmed === "") {
        lctx.status = 400;
        lctx.outcome = "bad_request";
        lctx.errorClass = "invalid_request_error";
        sendError(
          res,
          makeError("invalid_request_error", {
            param: "text",
            message: "A non-empty 'text' string is required.",
          })
        );
        return;
      }
      if (feedbackTextTrimmed.length > 4000) {
        lctx.status = 400;
        lctx.outcome = "bad_request";
        lctx.errorClass = "invalid_request_error";
        sendError(
          res,
          makeError("invalid_request_error", {
            param: "text",
            message: "Feedback text must be 4000 characters or fewer.",
          })
        );
        return;
      }
      // Store the trimmed text so callers don't need to worry about whitespace in the JSONL.
      feedbackText = feedbackTextTrimmed;

      const ua = req.headers["user-agent"];
      const userAgent = Array.isArray(ua) ? (ua[0] ?? null) : (ua ?? null);

      // Best-effort write — a storage failure is logged server-side but never surfaces as a
      // client error (the user already wrote their message; we don't want to punish a disk issue).
      recordFeedback({
        text: feedbackText,
        alias: senderAlias,
        userAgent,
        page: feedbackPage,
      });

      sendJson(res, 200, { ok: true });
      lctx.status = 200;
      lctx.outcome = "ok";
      return;
    }

    // ─── hs CLI download (UNauthenticated — friends install this before they have a key) ───
    // GET /hs and GET /client/hs.mjs both serve client/hs.mjs as text/javascript.
    // Only these two paths are exposed; no other repo files are served from here.
    if ((path === "/hs" || path === "/client/hs.mjs") && method === "GET") {
      lctx.route = "/hs";
      if (!throttlePublic()) return;
      sendJs(res, 200, hsMjs());
      lctx.status = 200;
      lctx.outcome = "ok";
      lctx.admission = "n/a";
      return;
    }

    // All authenticated routes go through the main handler body below. `principal` was resolved
    // up front; reject here when a protected route is reached with no/invalid credentials.
    if (!principal) {
      lctx.status = 401;
      lctx.outcome = "auth_failed";
      lctx.errorClass = "invalid_api_key";
      sendError(res, makeError("invalid_api_key"));
      return;
    }

    lctx.principal = principal.alias;
    lctx.tier = principal.tier;
    // keyHash is stored only in the owner-queryable request_log (never in the access log / metrics).
    lctx.keyHash = principal.keyHash;

    // Authenticated, content-blind LearningTaskContract negotiation. The response shape is the
    // accepted Grimnir v1 schema exactly; feature count is the closed four-item array, advertised_at
    // is the observation clock, and advertisement_id binds this process/configuration epoch.
    if (path === LEARNING_TASK_PREFLIGHT_ENDPOINT && method === "GET") {
      res.setHeader("cache-control", `private, max-age=${LEARNING_TASK_PREFLIGHT_TTL_MS / 1_000}`);
      sendJson(res, 200, learningTaskCapabilityEpoch.advertise());
      lctx.status = 200;
      lctx.outcome = "ok";
      lctx.admission = "n/a";
      return;
    }

    const requireAdmin = (): boolean => {
      if (!principal.isAdmin) {
        lctx.status = 403;
        lctx.outcome = "forbidden";
        // This is a ROUTE-permission failure (the key may not use this admin endpoint), NOT a
        // model-allow-list violation. Labelling it `model_not_allowed` mislabelled the metrics +
        // request_log (an internal service polling /ledger with a non-admin key surfaced as
        // hundreds of phantom model-allow-list rejections). `route_not_allowed` is the honest class.
        lctx.errorClass = "route_not_allowed";
        sendError(
          res,
          makeError("route_not_allowed", {
            param: null,
            message: "This endpoint requires an owner/admin key.",
          })
        );
        return false;
      }
      return true;
    };

    // ─── Owner-only, content-blind task exposure lookup (#257) ───
    // A real minted owner key is required, matching the owner-content/code_loop boundary. Legacy
    // static/implicit admins have no per-principal identity and cannot query this privacy-sensitive
    // freshness oracle. The handler performs SELECTs only: migrations/backfill happen at startup.
    if (path === "/admin/task-exposures/lookup" && method === "POST") {
      lctx.admission = "n/a";
      if (principal.tier !== "owner" || principal.keyHash === null) {
        lctx.status = 403;
        lctx.outcome = "forbidden";
        lctx.errorClass = "route_not_allowed";
        sendError(
          res,
          makeError("route_not_allowed", {
            message: "This endpoint requires a minted owner key.",
          })
        );
        return;
      }
      let raw: string;
      try {
        raw = await readBody(req, 32 * 1024);
      } catch (err) {
        const tooLarge = err instanceof BodyTooLargeError;
        lctx.status = tooLarge ? 413 : 400;
        lctx.outcome = "bad_request";
        lctx.errorClass = tooLarge ? "payload_too_large" : "invalid_request_error";
        sendError(res, makeError(tooLarge ? "payload_too_large" : "invalid_request_error"));
        return;
      }
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        lctx.status = 400;
        lctx.outcome = "bad_request";
        lctx.errorClass = "invalid_request_error";
        sendError(res, makeError("invalid_request_error", { message: "Request body must be valid JSON." }));
        return;
      }
      const parsed = parseTaskExposureLookupRequest(body);
      if (!parsed.ok) {
        lctx.status = 400;
        lctx.outcome = "bad_request";
        lctx.errorClass = "invalid_request_error";
        sendError(
          res,
          makeError("invalid_request_error", { param: parsed.param, message: parsed.message })
        );
        return;
      }
      res.setHeader("cache-control", "no-store");
      sendJson(res, 200, lookupTaskExposures(parsed.value));
      lctx.status = 200;
      lctx.outcome = "ok";
      return;
    }

    // ─── External-surface exposure-receipt intake (#10) ───
    // Authenticated, content-blind producer-receipt path for Codex App/Codex CLI/Pi exposure
    // observations — gille's half of the pair with Magnus-Gille/hugin#237. Same boundary as
    // /admin/task-exposures/lookup: a real minted owner key is required (every external producer/
    // subscription is provisioned its own minted key); legacy static/implicit admins have no
    // per-principal identity to bind a subscription alias to and are denied. The authenticated
    // principal's OWN alias — never a body-supplied claim — becomes the receipt's subscription
    // alias, so a receipt can never impersonate a different subscription.
    if (path === "/admin/exposure-receipts" && method === "POST") {
      lctx.admission = "n/a";
      if (principal.tier !== "owner" || principal.keyHash === null) {
        lctx.status = 403;
        lctx.outcome = "forbidden";
        lctx.errorClass = "route_not_allowed";
        sendError(res, makeError("route_not_allowed", { message: "This endpoint requires a minted owner key." }));
        return;
      }
      let raw: string;
      try {
        raw = await readBody(req, 16 * 1024);
      } catch (err) {
        const tooLarge = err instanceof BodyTooLargeError;
        lctx.status = tooLarge ? 413 : 400;
        lctx.outcome = "bad_request";
        lctx.errorClass = tooLarge ? "payload_too_large" : "invalid_request_error";
        sendError(res, makeError(tooLarge ? "payload_too_large" : "invalid_request_error"));
        return;
      }
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        lctx.status = 400;
        lctx.outcome = "bad_request";
        lctx.errorClass = "invalid_request_error";
        sendError(res, makeError("invalid_request_error", { message: "Request body must be valid JSON." }));
        return;
      }
      const result = ingestExposureReceipt(body, principal.alias);
      res.setHeader("cache-control", "no-store");
      if (result.status === "rejected") {
        sendJson(res, 400, result);
        lctx.status = 400;
        lctx.outcome = "bad_request";
        lctx.errorClass = `exposure_receipt_${result.reason}`;
        return;
      }
      sendJson(res, 200, result);
      lctx.status = 200;
      lctx.outcome = "ok";
      return;
    }

    // ─── External-surface producer heartbeat (#10) ───
    // Lightweight liveness signal with nothing to expose (an idle Codex App/Codex CLI/Pi
    // session) — same authenticated-owner-key boundary as the receipt endpoint above. A missing
    // or stale heartbeat for a REGISTERED surface prevents an "unseen"-covered claim anywhere in
    // /admin/task-exposures/lookup (see task-exposure.ts's externalProducerSurfaceHeartbeats).
    if (path === "/admin/exposure-receipts/heartbeat" && method === "POST") {
      lctx.admission = "n/a";
      if (principal.tier !== "owner" || principal.keyHash === null) {
        lctx.status = 403;
        lctx.outcome = "forbidden";
        lctx.errorClass = "route_not_allowed";
        sendError(res, makeError("route_not_allowed", { message: "This endpoint requires a minted owner key." }));
        return;
      }
      let raw: string;
      try {
        raw = await readBody(req, 4 * 1024);
      } catch (err) {
        const tooLarge = err instanceof BodyTooLargeError;
        lctx.status = tooLarge ? 413 : 400;
        lctx.outcome = "bad_request";
        lctx.errorClass = tooLarge ? "payload_too_large" : "invalid_request_error";
        sendError(res, makeError(tooLarge ? "payload_too_large" : "invalid_request_error"));
        return;
      }
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        lctx.status = 400;
        lctx.outcome = "bad_request";
        lctx.errorClass = "invalid_request_error";
        sendError(res, makeError("invalid_request_error", { message: "Request body must be valid JSON." }));
        return;
      }
      const surfaceParsed = exposureReceiptSurfaceSchema.safeParse(
        body !== null && typeof body === "object" ? (body as Record<string, unknown>)["surface"] : undefined
      );
      if (!surfaceParsed.success) {
        lctx.status = 400;
        lctx.outcome = "bad_request";
        lctx.errorClass = "invalid_request_error";
        sendError(
          res,
          makeError("invalid_request_error", {
            param: "surface",
            message: "surface must be one of codex_app, codex_cli, pi.",
          })
        );
        return;
      }
      recordExternalProducerHeartbeat({ surface: surfaceParsed.data, principalAlias: principal.alias });
      res.setHeader("cache-control", "no-store");
      sendJson(res, 200, { status: "ok", surface: surfaceParsed.data, subscriptionAlias: principal.alias });
      lctx.status = 200;
      lctx.outcome = "ok";
      return;
    }

    // ─── Hugin experiment-outcome import (#8) ───
    // Owner/admin authenticated service path, same idiom as the rest of the /admin surface
    // (requireAdmin() — no new auth scheme). This bridges a completed Hugin champion/challenger
    // experiment into the capability ledger as durable, content-addressed evidence; it never
    // touches routing (see experiment-import.ts's module doc). A structurally malformed bundle is
    // a 400; a structurally valid but business-inadmissible ARM is a 200 with that arm's specific
    // rejection reason — one bad arm must not block the rest of the same bundle from being admitted.
    if (path === "/admin/experiments/import" && method === "POST") {
      lctx.admission = "n/a";
      if (!requireAdmin()) return;
      let raw: string;
      try {
        raw = await readBody(req, 1 * 1024 * 1024);
      } catch (err) {
        const tooLarge = err instanceof BodyTooLargeError;
        lctx.status = tooLarge ? 413 : 400;
        lctx.outcome = "bad_request";
        lctx.errorClass = tooLarge ? "payload_too_large" : "invalid_request_error";
        sendError(res, makeError(tooLarge ? "payload_too_large" : "invalid_request_error"));
        return;
      }
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        lctx.status = 400;
        lctx.outcome = "bad_request";
        lctx.errorClass = "invalid_request_error";
        sendError(res, makeError("invalid_request_error", { message: "Request body must be valid JSON." }));
        return;
      }
      const parsed = parseHuginExperimentOutcomeBundle(body);
      if (!parsed.ok) {
        lctx.status = 400;
        lctx.outcome = "bad_request";
        lctx.errorClass = "invalid_request_error";
        sendError(
          res,
          makeError("invalid_request_error", { param: parsed.param, message: parsed.message })
        );
        return;
      }
      const result = importHuginExperimentOutcome(parsed.value);
      res.setHeader("cache-control", "no-store");
      sendJson(res, 200, result);
      lctx.status = 200;
      lctx.outcome = "ok";
      return;
    }

    // ─── Reviewed routing-table reload (#7) ───
    // The atomic-reload seam the reviewed lifecycle depends on: scripts/routing-lifecycle-cli.ts's
    // `adopt` writes docs/m5-routing.json on disk, then calls THIS endpoint so the LIVE gateway
    // process picks it up WITHOUT a restart (AC: "gateway adoption does not depend on an
    // undocumented manual restart"). Same requireAdmin() idiom as the rest of /admin — no new auth
    // scheme. Never writes the file itself; it only re-parses whatever is currently on disk, so a
    // malformed write is reported as a 500 (and the caller rolls back) rather than crashing the
    // gateway's already-loaded table.
    if (path === "/admin/routing-table/reload" && method === "POST") {
      lctx.admission = "n/a";
      if (!requireAdmin()) return;
      resetRoutingTable();
      try {
        const reloaded = loadRoutingTable();
        sendJson(res, 200, {
          reloaded: true,
          routableTaskTypes: Object.keys(reloaded.routing).length,
          escalateToFrontier: reloaded.escalateToFrontier.length,
        });
        lctx.status = 200;
        lctx.outcome = "ok";
      } catch (err) {
        // A corrupt/missing table on disk must not crash the process — surface it as a failed
        // reload so the caller (adoptRoutingTable) rolls back to the last-known-good snapshot.
        sendError(
          res,
          makeError("internal_error", {
            message: `routing-table reload failed: ${err instanceof Error ? err.message : String(err)}`,
          })
        );
        lctx.status = 500;
        lctx.outcome = "error";
        lctx.errorClass = "internal_error";
      }
      return;
    }

    // ─── MCP transport (Streamable HTTP, JSON-RPC) ───
    // Authenticated above (principal resolved). The `ask` tool runs completions through the
    // SAME metered path (credit reserve → quota → admission → reconcile) and the SAME model
    // allow-list as /v1/chat/completions, via the shared runChatCompletion helper.
    if (path === "/mcp" && method === "POST") {
      const raw = await readBody(req);
      await handleMcpPost(raw, res, {
        principal,
        cfg,
        controller,
        gatewayRequestId: `opaque:${lctx.requestId}`,
        learningTaskCapabilityEpoch,
        inflight: {
          inc: incInflight,
          dec: decInflight,
          current: (alias: string) => keyInflight.get(alias) ?? 0,
        },
      });
      lctx.status = res.statusCode > 0 ? res.statusCode : 200;
      lctx.outcome = lctx.status < 400 ? "ok" : "error";
      lctx.admission = "n/a";
      return;
    }

    // ─── Inference surface (through the spine) ───
    if (path === "/v1/chat/completions" && method === "POST") {
      const raw = await readBody(req);
      const parsed = parseChatBody(raw);
      if (parsed.node !== undefined && !isComputeNodeId(parsed.node)) {
        lctx.status = 400; lctx.outcome = "bad_request"; lctx.errorClass = "invalid_request_error";
        sendError(res, makeError("invalid_request_error", { param: "node", message: "'node' must be 'm5' or 'orin'." }));
        return;
      }
      if (parsed.node === "orin" && (!orinEnabled(cfg) || parsed.model !== cfg.orin.model)) {
        lctx.status = 400; lctx.outcome = "bad_request"; lctx.errorClass = "invalid_request_error";
        sendError(res, makeError("invalid_request_error", { param: "node", message: "Orin is unavailable or only permits its configured small model." }));
        return;
      }
      lctx.node = parsed.node ?? "m5";
      // C3: never put the raw, user-controlled `model` string into the access log / metrics.
      // Canonicalize against trusted server state — the key's allow-list, then (for empty-allow-list
      // owner/admin keys) the cached resident catalogue. A known id is preserved; an unrecognised
      // value becomes "unknown" (NOT the raw string). The catalogue lookup is a short-TTL cache, so
      // this is near-zero cost on warm traffic. The spine overwrites this with the served model on
      // a successful completion.
      lctx.model = canonicalizeModelTrusted(parsed.model, principal.modelAllowList);
      // #8: clamp the OpenAI `n` parameter to a single completion BEFORE reserving credits and
      // proxying upstream. n>1 is GPU amplification + credit under-reservation (the estimate
      // assumes one completion), so we force n=1 rather than honour a guest-supplied fan-out.
      if (parsed.obj["n"] !== undefined && parsed.obj["n"] !== 1) {
        parsed.obj["n"] = 1;
      }
      // A non-positive max_tokens (0 / negative) would collapse the quota reservation — reject
      // it outright rather than silently clamp it to the cap.
      if (parsed.requestedMax !== null && parsed.requestedMax <= 0) {
        lctx.status = 400;
        lctx.outcome = "bad_request";
        lctx.errorClass = "invalid_request_error";
        sendError(
          res,
          makeError("invalid_request_error", {
            param: "max_tokens",
            message: "max_tokens must be a positive integer.",
          })
        );
        return;
      }
      // Floor at 1, ceiling at the per-request cap.
      const effectiveMax = clampMaxTokensForModel(cfg, parsed.model, parsed.requestedMax);
      const est = estimateTokens(raw, effectiveMax);
      await admitAndMeterLogged(res, cfg, controller, principal, parsed.model, est, lctx, () =>
        handleChatProxy(raw, parsed, res, cfg, effectiveMax, lctx, principal)
      );
      return;
    }
    if (path === "/v1/audio/transcriptions" && method === "POST") {
      // OpenAI Whisper-compatible speech-to-text. Authenticated above (principal resolved).
      // This route self-meters (credit gate → admission → post-hoc audio-seconds debit) rather
      // than going through admitAndMeterLogged, because the cost is an audio-seconds function of
      // the backend's reported duration, not a token estimate. It populates lctx directly so the
      // finally block records the content-blind request_log row + metrics.
      await handleAudioTranscription(req, res, cfg, controller, principal, lctx);
      return;
    }
    // ─── Image generation (text→image). Inert when HOMESERVER_IMAGE_URL is unset (→ 404). ───
    if (path === "/v1/images/generations" && method === "POST") {
      await handleImageGeneration(req, res, cfg, controller, principal, lctx);
      return;
    }
    {
      const jobMatch = /^\/v1\/images\/generations\/jobs\/([^/]+)$/.exec(path);
      if (jobMatch) {
        lctx.route = "/v1/images/generations/jobs/:id";
        const jobId = decodePathSegmentOrSend(jobMatch[1]!, res, lctx);
        if (jobId === null) return;
        if (method === "GET") {
          handleImageJobGet(res, principal, jobId, lctx);
          return;
        }
        if (method === "DELETE") {
          handleImageJobCancel(res, controller, principal, jobId, lctx);
          return;
        }
      }
    }
    if (path === "/delegate" && method === "POST") {
      // /delegate hands an unscoped prompt to the orchestrator, which then picks ANY model —
      // bypassing per-key allow-lists. Until it honours allow-lists, restrict it to owner-tier
      // principals (interim fix). A non-owner key is refused before any orchestration runs.
      if (principal.tier !== "owner") {
        lctx.status = 403;
        lctx.outcome = "forbidden";
        lctx.errorClass = "route_not_allowed";
        sendError(
          res,
          makeError("route_not_allowed", {
            param: null,
            message: "/delegate is restricted to owner-tier keys.",
          })
        );
        return;
      }
      const raw = await readBody(req);
      // Codex finding 3: validate BEFORE admission — a bad request must 400 (not 402/429/503) and
      // must not acquire a GPU slot just to be rejected inside the metered handler.
      const parsed = parseDelegateBody(raw);
      if (!parsed.ok) {
        lctx.status = 400;
        lctx.outcome = "bad_request";
        lctx.errorClass = "invalid_request_error";
        lctx.admission = "n/a";
        sendError(res, makeError("invalid_request_error", { param: parsed.param, message: parsed.message }));
        return;
      }
      if (parsed.params.learningTaskStamp !== undefined) {
        if (parsed.params.taskType === undefined || parsed.params.taskType.trim() === "") {
          lctx.status = 400;
          lctx.outcome = "bad_request";
          lctx.errorClass = "invalid_request_error";
          lctx.admission = "n/a";
          sendError(res, makeError("invalid_request_error", {
            param: "taskType",
            message: "Stamped /delegate requests must include an explicit 'taskType'.",
          }));
          return;
        }
        const stamp = parsed.params.learningTaskStamp;
        const observedFingerprint = parsed.params.learningTaskObservedFingerprint;
        if (observedFingerprint === undefined) {
          throw new Error("stamped /delegate request is missing its observed request fingerprint");
        }
        // A verified principal may recover only the exact, content-blind identity already bound
        // to it. This read must precede epoch/freshness and all metering/admission gates: after a
        // restart, the original epoch is intentionally gone, and a retry must never execute again.
        const recovery = lookupLearningTaskAdmission({
          principalId: principal.alias,
          clientId: stamp.client_id,
          taskInstanceId: stamp.task_instance_id,
          attemptId: stamp.attempt_id,
          requestId: stamp.request_id,
          idempotencyKey: stamp.idempotency_key,
          requestFingerprint: observedFingerprint,
          surface: "delegate",
        });
        if (recovery.kind === "existing") {
          lctx.admission = "n/a";
          sendLearningTaskAdmissionRecovery(res, lctx, recovery.record.gatewayEcho);
          return;
        }
        if (recovery.kind === "conflict") {
          lctx.status = 409;
          lctx.outcome = "learning_task_conflict";
          lctx.errorClass = "learning_task_conflict";
          lctx.admission = "n/a";
          sendError(res, makeError("learning_task_conflict"));
          return;
        }
        try {
          validateHuginRequestStamp(stamp, {
            capabilityEpoch: learningTaskCapabilityEpoch,
            authenticatedPrincipalId: principal.alias,
            authentication: "gateway-owner-auth",
            effectiveTaskType: parsed.params.taskType,
          });
        } catch (err) {
          lctx.status = 400;
          lctx.outcome = "bad_request";
          lctx.errorClass = "invalid_request_error";
          lctx.admission = "n/a";
          sendError(res, makeError("invalid_request_error", {
            param: "learningTaskStamp",
            message: err instanceof LearningTaskContractError
              ? err.message
              : "LearningTaskContract validation failed.",
          }));
          return;
        }
      }
      const effectiveMax = clampMaxTokensForModel(
        cfg,
        parsed.params.modelId,
        parsed.requestedMax
      );
      const est = estimateTokens(raw, effectiveMax);
      await admitAndMeterLogged(res, cfg, controller, principal, null, est, lctx, () =>
        handleDelegate(parsed.params, res, effectiveMax, principal.alias, lctx)
      );
      return;
    }

    // ─── Read-only authenticated surface ───
    if (path === "/portal/me" && method === "GET") {
      // The dashboard's data source: the authenticated key reports its own limits + usage.
      // no-store: per-key usage data must not be cached by intermediaries (Fix #7).
      res.setHeader("cache-control", "no-store");
      sendJson(res, 200, {
        alias: principal.alias,
        tier: principal.tier,
        models: principal.modelAllowList,
        creditLimit: principal.creditLimit,
        creditsUsed: principal.creditsUsed,
        rpm: principal.limits.rpm,
        tpm: principal.limits.tpm,
      });
      lctx.status = 200;
      lctx.outcome = "ok";
      lctx.admission = "n/a";
      return;
    }
    if (path === "/models" && method === "GET") {
      sendJson(res, 200, { models: await listModels() });
      lctx.status = 200;
      lctx.outcome = "ok";
      lctx.admission = "n/a";
      return;
    }
    if (path === "/v1/models" && method === "GET") {
      // OpenAI-compatible model list (so OpenAI SDKs / LiteLLM / IDE plugins that probe
      // /v1/models work). Filtered to the key's allow-list — empty allow-list = all models.
      const all = await listModels();
      const allow = principal.modelAllowList;
      const visible = allow.length === 0 ? all : all.filter((m) => allow.includes(m.key));
      const data = visible.map((m) => ({ id: m.key, object: "model", created: 0, owned_by: "home-gateway" }));
      // Advertise the speech-to-text model alongside the chat models (empty allow-list = visible;
      // otherwise only when the key is permitted the whisper model). So OpenAI SDKs that probe
      // /v1/models can discover the transcription endpoint's model id.
      if (allow.length === 0 || allow.includes(WHISPER_MODEL)) {
        data.push({ id: WHISPER_MODEL, object: "model", created: 0, owned_by: "home-gateway" });
      }
      // Advertise the image-generation tiers — only when the box has an image sidecar configured
      // (HOMESERVER_IMAGE_URL set) AND the key is permitted each id (empty allow-list = all).
      if (cfg.imageUrl !== "") {
        for (const id of IMAGE_MODEL_IDS) {
          if (allow.length === 0 || allow.includes(id)) {
            data.push({ id, object: "model", created: 0, owned_by: "home-gateway" });
          }
        }
      }
      sendJson(res, 200, { object: "list", data });
      lctx.status = 200;
      lctx.outcome = "ok";
      lctx.admission = "n/a";
      return;
    }
    if (path === "/ledger" && method === "GET") {
      // #7: owner-gated, plus an explicit read-only MONITOR scope (e.g. Heimdall). The ledger
      // exposes internal capability + delegation data, so guests/users still may not read it.
      // A non-admin/non-monitor key here is a ROUTE-permission failure (consistent with
      // requireAdmin's relabel, PR #39) — NOT a model-allow-list violation; `route_not_allowed`
      // is the honest class so an internal poller doesn't surface as phantom model rejections.
      if (!principal.isAdmin && !principal.isMonitor) {
        lctx.status = 403;
        lctx.outcome = "forbidden";
        lctx.errorClass = "route_not_allowed";
        sendError(
          res,
          makeError("route_not_allowed", {
            param: null,
            message: "The ledger requires an owner/admin or monitor key.",
          })
        );
        return;
      }
      // #234: shadow candidate rows are excluded by default. The explicit query opt-in is kept on
      // this already owner/monitor-gated route so dashboards can inspect candidate evidence without
      // ever letting it leak into the production capability view.
      const includeShadow = ["1", "true"].includes(
        (parsedUrl.searchParams.get("includeShadow") ?? "").toLowerCase()
      );
      sendJson(res, 200, {
        report: ledgerReport(cfg.policy, { includeShadow }),
        recent: recentDelegations(20),
        includeShadow,
      });
      lctx.status = 200;
      lctx.outcome = "ok";
      lctx.admission = "n/a";
      return;
    }
    if (path.startsWith("/ledger/") && method === "GET") {
      // #227: id-addressable read — the join target for a `ledgerId` returned by POST /delegate
      // (echoed as costTrace.delegationId). Same auth gate as GET /ledger — this exposes the same
      // internal capability/delegation data, just scoped to one row instead of the recent window.
      lctx.route = "/ledger/:id";
      if (!principal.isAdmin && !principal.isMonitor) {
        lctx.status = 403;
        lctx.outcome = "forbidden";
        lctx.errorClass = "route_not_allowed";
        sendError(
          res,
          makeError("route_not_allowed", {
            param: null,
            message: "The ledger requires an owner/admin or monitor key.",
          })
        );
        return;
      }
      const id = decodePathSegmentOrSend(path.slice("/ledger/".length), res, lctx);
      if (id === null) return;
      const row = getDelegationById(id);
      if (!row) {
        lctx.status = 404;
        lctx.outcome = "not_found";
        lctx.errorClass = "not_found";
        sendError(res, makeError("not_found", { message: `No such ledger row '${id}'.` }));
        return;
      }
      sendJson(res, 200, row);
      lctx.status = 200;
      lctx.outcome = "ok";
      lctx.admission = "n/a";
      return;
    }
    if (path === "/metrics" && method === "GET") {
      res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" });
      res.end(renderMetrics());
      lctx.status = 200;
      lctx.outcome = "ok";
      lctx.admission = "n/a";
      return;
    }

    // ─── Admin surface ───
    if (path === "/admin/models/load" && method === "POST") {
      if (!requireAdmin()) return;
      await handleAdminLoad(req, res);
      lctx.status = res.statusCode;
      lctx.outcome = res.statusCode < 300 ? "ok" : "error";
      lctx.admission = "n/a";
      return;
    }
    if (path === "/admin/models/unload" && method === "POST") {
      if (!requireAdmin()) return;
      await handleAdminUnload(req, res);
      lctx.status = res.statusCode;
      lctx.outcome = res.statusCode < 300 ? "ok" : "error";
      lctx.admission = "n/a";
      return;
    }
    if (path === "/admin/models/download" && method === "POST") {
      if (!requireAdmin()) return;
      await handleAdminDownload(req, res);
      lctx.status = res.statusCode;
      lctx.outcome = res.statusCode < 300 ? "ok" : "error";
      lctx.admission = "n/a";
      return;
    }
    if (path === "/admin/keys" && method === "POST") {
      if (!requireAdmin()) return;
      await handleKeysMint(req, res, cfg);
      lctx.status = res.statusCode;
      lctx.outcome = res.statusCode < 300 ? "ok" : "error";
      lctx.admission = "n/a";
      return;
    }
    if (path === "/admin/keys" && method === "GET") {
      if (!requireAdmin()) return;
      sendJson(res, 200, { keys: listKeys() });
      lctx.status = 200;
      lctx.outcome = "ok";
      lctx.admission = "n/a";
      return;
    }
    if (path.startsWith("/admin/keys/") && method === "DELETE") {
      lctx.route = "/admin/keys/:alias";
      if (!requireAdmin()) return;
      const alias = decodePathSegmentOrSend(path.slice("/admin/keys/".length), res, lctx);
      if (alias === null) return;
      const ok = revokeKey(alias);
      if (ok) {
        sendJson(res, 200, { revoked: true });
        lctx.status = 200;
      } else {
        sendError(res, makeError("not_found", { message: `No such active key '${alias}'.` }));
        lctx.status = 404;
      }
      lctx.outcome = ok ? "ok" : "not_found";
      lctx.admission = "n/a";
      return;
    }

    // Bench / maintenance mode (#108) — owner/admin toggle. When ON, guests are refused (503)
    // while owner traffic flows, so a heavy batch/benchmark job can reserve the box. Content-blind.
    if (path === "/admin/maintenance" && method === "GET") {
      if (!requireAdmin()) return;
      const s = controller.snapshot();
      sendJson(res, 200, {
        maintenance: s.maintenanceMode === true,
        inflight: s.inflight,
        ownerQueued: s.ownerQueued,
        maxInflight: s.maxInflight,
      });
      lctx.status = 200;
      lctx.outcome = "ok";
      lctx.admission = "n/a";
      return;
    }
    if (path === "/admin/maintenance" && method === "POST") {
      if (!requireAdmin()) return;
      // Parse to unknown and validate the container before reading `on`: a bare `null` (or a
      // JSON array/scalar) is valid JSON, so dereferencing it directly would throw a TypeError
      // and surface as a 500 instead of the documented 400.
      const parsedBody = JSON.parse(await readBody(req)) as unknown;
      const isPlainObject =
        typeof parsedBody === "object" && parsedBody !== null && !Array.isArray(parsedBody);
      const on = isPlainObject ? (parsedBody as { on?: unknown }).on : undefined;
      if (typeof on !== "boolean") {
        sendError(
          res,
          makeError("invalid_request_error", {
            param: "on",
            message: "Field 'on' (boolean) is required.",
          })
        );
        lctx.status = 400;
        lctx.outcome = "bad_request";
        lctx.errorClass = "invalid_request_error";
        lctx.admission = "n/a";
        return;
      }
      // #105: optional auto-expiry so an unattended batch job that dies mid-window (crash, OOM,
      // SIGKILL) before calling {on:false} can't leave guests locked out forever. Only validated
      // when on:true — setMaintenanceMode() provably discards ttlSeconds when on:false, so a
      // caller that mirrors the same body shape for both calls must not get spuriously 400'd.
      const ttlSecondsRaw =
        on && isPlainObject ? (parsedBody as { ttlSeconds?: unknown }).ttlSeconds : undefined;
      let ttlMs: number | undefined;
      if (ttlSecondsRaw !== undefined) {
        if (typeof ttlSecondsRaw !== "number" || !Number.isFinite(ttlSecondsRaw) || ttlSecondsRaw <= 0) {
          sendError(
            res,
            makeError("invalid_request_error", {
              param: "ttlSeconds",
              message: "Field 'ttlSeconds', if present, must be a finite number > 0.",
            })
          );
          lctx.status = 400;
          lctx.outcome = "bad_request";
          lctx.errorClass = "invalid_request_error";
          lctx.admission = "n/a";
          return;
        }
        ttlMs = ttlSecondsRaw * 1000;
      }
      const newState = controller.setMaintenanceMode(on, ttlMs);
      const s = controller.snapshot();
      sendJson(res, 200, {
        maintenance: newState,
        inflight: s.inflight,
        ownerQueued: s.ownerQueued,
        maxInflight: s.maxInflight,
      });
      lctx.status = 200;
      lctx.outcome = "ok";
      lctx.admission = "n/a";
      return;
    }

    // #15: unknown route → uniform OpenAI-shaped 404 envelope (not a bare { error } body).
    sendError(res, makeError("not_found", { message: `No route for ${method} ${path}.` }));
    lctx.status = 404;
    lctx.outcome = "not_found";
    lctx.errorClass = "not_found";
    lctx.admission = "n/a";
  } catch (err) {
    // #15: a client-side body error (invalid JSON / oversized body) is a 4xx, not a 500.
    // Map it to the uniform envelope here BEFORE the generic 500 fallthrough.
    if (err instanceof BodyTooLargeError) {
      if (!res.headersSent) sendError(res, makeError("payload_too_large"));
      lctx.status = 413;
      lctx.outcome = "bad_request";
      lctx.errorClass = "payload_too_large";
      return;
    }
    if (err instanceof SyntaxError) {
      // JSON.parse of a request body threw — a malformed body is the client's fault (400),
      // never a server 500. Content-blind: we do not echo the parser's message.
      if (!res.headersSent) {
        sendError(
          res,
          makeError("invalid_request_error", { message: "Request body must be valid JSON." })
        );
      }
      lctx.status = 400;
      lctx.outcome = "bad_request";
      lctx.errorClass = "invalid_request_error";
      return;
    }
    // An unhandled throw is a 500 (the outer createServer .catch sends the envelope).
    // Mark it as such so the access log records the error rather than the default "ok".
    if (lctx.status === null || lctx.status < 400) {
      lctx.status = 500;
      lctx.outcome = "error";
      lctx.errorClass = lctx.errorClass ?? "internal_error";
    }
    throw err;
  } finally {
    lctx.totalMs = Date.now() - startMs;
    recordRequest({
      // C3: lctx.model is canonicalized (allow-list / resident catalogue) for the inference
      // surface — never the raw request string. Non-inference routes leave it null → "none".
      model: lctx.model,
      node: lctx.node,
      outcome: lctx.outcome,
      tier: lctx.tier,
      // M3: the metered spine populates these from real usage so the token + credit counters
      // actually increment for live traffic.
      promptTokens: lctx.promptTokens,
      completionTokens: lctx.completionTokens,
      durationMs: lctx.totalMs,
      creditsCharged: lctx.creditsCharged,
    });
    // Durable CONTENT-BLIND request_log row (best-effort; a write failure never breaks the request).
    // Mirrors the access-log fields to SQLite so the owner can query #users / concurrency / TTFT /
    // throughput / outcomes. NO content is ever written here. The model label is already
    // canonicalized; coerce null → "none" to mirror the metrics convention.
    if (cfg.requestLog === "on") {
      recordRequestLog({
        requestId: lctx.requestId,
        alias: lctx.principal,
        tier: lctx.tier,
        keyHash: lctx.keyHash,
        model: lctx.model ?? "none",
        node: lctx.node,
        route: lctx.route,
        status: lctx.status ?? 0,
        outcome: lctx.outcome,
        errorClass: lctx.errorClass,
        promptTokens: lctx.promptTokens,
        completionTokens: lctx.completionTokens,
        totalTokens: lctx.totalTokens,
        queueWaitMs: lctx.queueWaitMs,
        ttftMs: lctx.ttftMs,
        totalMs: lctx.totalMs ?? 0,
        admission: lctx.admission,
      });
    }
    if (logThis) defaultLogger.log({ event: "gateway_request", ...lctx });
  }
}
