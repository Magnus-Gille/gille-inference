import { loadEnv } from "../env.js";
import type { ShadowLaneConfig } from "./shadow-lane.js";

export type { ShadowLaneConfig };

/**
 * Home-server scaffold configuration.
 *
 * This is the first-version config for the BosGame box (Strix Halo 128GB). On the
 * dev laptop it talks to LM Studio on localhost; on the box it is meant to bind the
 * gateway to the LAN so the router can reach an authenticated inference endpoint.
 *
 * Everything is env-driven (read once via loadConfig()) so the same code runs on the
 * laptop today and the box later with only environment changes.
 */

// ─── Learning / routing policy ──────────────────────────────────────────────────

export interface PolicyConfig {
  /** Minimum attempts before a (task_type, model) verdict is anything but "unknown". */
  minSamples: number;
  /** Hard cap on attempts — verdict freezes here even if still "marginal". */
  maxSamples: number;
  /**
   * If a (task_type, model) accrues this many capability failures with ZERO passes,
   * it is declared not_viable and frozen — we stop wasting local calls on it. This is
   * the "don't re-delegate a failing task type more than needed to learn" rule.
   */
  maxFails: number;
  /** successRate >= this → viable. */
  viableThreshold: number;
  /** successRate in [marginalThreshold, viableThreshold) → marginal (keep sampling). */
  marginalThreshold: number;
  /**
   * Probability of re-probing a frozen not_viable type anyway, to detect that a model
   * upgrade (new quant / new model) has made it viable. Verdicts are per-model, so a
   * genuinely new model resets to unknown automatically; this covers same-id changes.
   */
  explorationRate: number;
  /**
   * JUDGMENT-QUALITY task types (issue #156): task types whose quality a STRUCTURAL verifier
   * (nonEmpty/jsonValid/maxLength — see verifier-classification.ts) cannot measure. This list
   * SELECTS which task types are graded under the trusted-verifier WHITELIST below
   * (#168 `trustedVerifiersForJudgment`): for a type in this list, a ledger row is admissible
   * evidence only if its verifier is trusted, so an opaque/structural pass can never manufacture
   * a false viable / delegate-local (the code-review inflation: mellum passRate 1.0 on `nonEmpty`
   * yet 5.9% ground-truth recall). A type left with no admissible evidence resolves to `unknown`
   * (→ frontier), not a fabricated viable. Kept a small EXPLICIT list, never applied globally.
   * Default `["code-review"]`; set the env var to `""` to disable the whitelist gating entirely
   * (those types then use ordinary verdict math again).
   */
  judgmentQualityTaskTypes: string[];
  /**
   * Verifiers TRUSTED to grade JUDGMENT-QUALITY output (issue #168 — the whitelist that supersedes
   * #156's structural blacklist). For a judgment-quality task type, a ledger row is admissible as
   * verdict evidence IFF its (base-named) verifier is in this set. A whitelist is strictly stronger
   * than #156's blacklist and subsumes it: #156 could exclude KNOWN-structural verifiers, but it
   * still admitted opaque/non-adversarial checks (the model-scout's own `predicate` code-review
   * probe, `matches`) that pass while finding ~6% of real seeded bugs (2026-07-05 ground-truth
   * sweep). Only positively-trusted evidence should be able to move a judgment verdict.
   *
   * DEFAULT EMPTY — intentionally. No local verifier yet grades review quality against ground
   * truth, so with an empty whitelist `code-review` has 0 admissible rows → `unknown` → escalate-
   * frontier (the honest state), never a fabricated `viable`/`not_viable`. #158's ground-truth
   * code-review probe is what will populate this set (add its verifier name → code-review earns a
   * real local verdict). Env `HOMESERVER_TRUSTED_JUDGMENT_VERIFIERS` (comma-separated); unset OR
   * empty → empty set (empty IS the intended default, so no "unset vs empty" distinction is needed).
   */
  trustedVerifiersForJudgment: string[];
  /**
   * Discount format-only evidence for JUDGMENT-FLAVORED task types (issue #233): a pass/partial
   * graded by a `mechanical-format` verifier (see verifier-classification.ts's classifyVerifierKind
   * — deterministic shape/pattern/fixed-value checks: `jsonValid`, `containsAll`, `answerIs`, …) is
   * real but WEAKER evidence than a `truth-oriented` one (execution-based ground truth, or a model
   * judge) — it can be gamed by output that merely LOOKS right. Default OFF (behaviour-preserving):
   * a format-only pass counts as full evidence exactly as before, until this is validated against
   * real routing decisions. Env `HOMESERVER_DISCOUNT_FORMAT_ONLY_EVIDENCE=on` to enable.
   */
  discountFormatOnlyEvidence: boolean;
  /**
   * Task types the discount (above) applies to when enabled — types where an expected-value/pattern
   * match is not a strong proxy for a genuinely correct answer. Default: classify, qa-factual,
   * triage, claim-verify (issue #233's own examples: `qa-factual` 3/3 ledger-pass with one row
   * confirmed factually wrong; `classify` 6/7 pass with one confirmed wrong). Env
   * `HOMESERVER_FORMAT_DISCOUNT_TASK_TYPES` (CSV); unset → this default, set to `""` → disable for
   * every type (equivalent to leaving discountFormatOnlyEvidence off).
   */
  formatOnlyDiscountTaskTypes: string[];
  /**
   * Weight (0..1) applied to a format-only-verified pass/partial's contribution to successRate when
   * the discount is active. A format-only pass is not thrown away (0 would be the #168 whitelist's
   * job, a different, harder gate) — it is still real, just weaker, evidence. Default 0.5 (half
   * credit). Env `HOMESERVER_FORMAT_DISCOUNT_WEIGHT`.
   */
  formatOnlyDiscountWeight: number;
}

/**
 * Task types whose verdict must be backed by QUALITY-BEARING evidence (issue #156). Kept minimal
 * and explicit — code-review is the proven case (structural `nonEmpty` passes fabricated a viable
 * verdict at 0% ground-truth recall). Grow this list only with a demonstrated inflation, never as
 * a blanket policy.
 */
export const DEFAULT_JUDGMENT_QUALITY_TASK_TYPES: readonly string[] = ["code-review"];

/**
 * Judgment-flavored task types the #233 format-only discount applies to by default — see
 * `PolicyConfig.formatOnlyDiscountTaskTypes`. Deliberately a DIFFERENT list from
 * DEFAULT_JUDGMENT_QUALITY_TASK_TYPES above: that one hard-excludes untrusted-verifier evidence
 * entirely (#168's whitelist gate); this one soft-weights format-only evidence lower, for task
 * types where SOME format-verifier signal is still informative, just not full-strength.
 */
export const DEFAULT_FORMAT_ONLY_DISCOUNT_TASK_TYPES: readonly string[] = [
  "classify",
  "qa-factual",
  "triage",
  "claim-verify",
];

/**
 * Task types the HARVEST worker must NOT write real verdicts for in mode=on. `other` is the
 * taxonomy's broad catch-all fallback — a bucket of wholly unrelated prompts, so its pass/fail
 * mix measures the bucket's noise, not any model's capability (2026-07-09 nightly: 16 `other`
 * rows, 12 fails, spanning unrelated work). Shadow-mode rows are unaffected (they are
 * outcome='unverified' — zero routing impact — and keep judge-evaluation stats flowing).
 * Env HOMESERVER_HARVEST_EXCLUDED_TASK_TYPES: unset → this default; set to "" → disable.
 */
export const DEFAULT_HARVEST_EXCLUDED_TASK_TYPES: readonly string[] = ["other"];

/**
 * Per-model completion ceilings above the conservative fleet-wide default. VibeThinker is a
 * long-horizon reasoning model and our own `reason-hard` probes request 16,384 tokens, so its
 * explicit-request ceiling is 32K. Omitted max_tokens still uses the global default; this only
 * permits an informed caller to ask for more headroom without widening every model/key request.
 */
export const DEFAULT_MODEL_MAX_TOKENS: Readonly<Record<string, number>> = {
  "vibethinker-3b": 32_768,
};

export const DEFAULT_POLICY: PolicyConfig = {
  minSamples: 3,
  maxSamples: 8,
  maxFails: 3,
  viableThreshold: 0.7,
  marginalThreshold: 0.4,
  explorationRate: 0.1,
  judgmentQualityTaskTypes: [...DEFAULT_JUDGMENT_QUALITY_TASK_TYPES],
  // #168: empty by default — no local verifier yet trusted to grade review quality (see interface).
  trustedVerifiersForJudgment: [],
  // #233: off by default — format-only passes count as full evidence exactly as before.
  discountFormatOnlyEvidence: false,
  formatOnlyDiscountTaskTypes: [...DEFAULT_FORMAT_ONLY_DISCOUNT_TASK_TYPES],
  formatOnlyDiscountWeight: 0.5,
};

export type DelegatePolicyMode = "off" | "shadow" | "enforce";

export interface DelegatePolicyConfig {
  /**
   * Production delegation gate:
   * - off: current learning-oriented behaviour.
   * - shadow: compute allow/shadow/deny but do not change routing.
   * - enforce: only allow certified lanes to call local inference.
   */
  mode: DelegatePolicyMode;
  /** Verified lane attempts required before automatic production delegation. */
  minSamples: number;
  /** Default required success rate for automatic production delegation. */
  minSuccessRate: number;
  /** Lower threshold for low-risk draft lanes where rough output is acceptable. */
  lowRiskSuccessRate: number;
  /** Maximum capability-error rate allowed for automatic production delegation. */
  maxErrorRate: number;
  /** Maximum p90 latency for automatic production delegation. */
  maxP90LatencyMs: number;
}

/**
 * Shadow lane (issue #234) — the escape hatch from the evidence ABSORBING STATE (#199).
 *
 * When the router escalates a leaf to frontier it makes NO local call, so no new evidence about the
 * local model is ever recorded, so the frontier-only verdict can never change (the 2026-07-12 harvest:
 * 8/8 code-review/code-edit leaves escalated with zero local attempt). With `mode: "on"` the
 * orchestrator ALSO runs the configured local candidate on such a leaf — in the background, after the
 * caller already has their frontier answer — and records the graded result as a ledger row flagged
 * `shadow`, which every default rollup excludes.
 *
 * DEFAULT OFF. The lane spends GPU on work nobody asked for, so it is opt-in per box.
 * The shape lives in shadow-lane.ts (its owner); this is only the env-driven default.
 */
export const DEFAULT_SHADOW_LANE: ShadowLaneConfig = {
  mode: "off",
  model: "",
  taskTypes: [],
  // 0 = "use the same token budget the caller's task would have had". A SMALLER shadow budget than
  // the real task is a trap: the candidate truncates, grades `fail`, and the ledger learns a lie
  // about the model rather than about the box's budget. Set a positive cap only deliberately.
  maxTokens: 0,
  timeoutMs: 120_000,
  agreementThreshold: 0.7,
};

export const DEFAULT_DELEGATE_POLICY: DelegatePolicyConfig = {
  mode: "off",
  minSamples: 10,
  minSuccessRate: 0.95,
  lowRiskSuccessRate: 0.9,
  maxErrorRate: 0.05,
  maxP90LatencyMs: 30_000,
};

// ─── Top-level config ────────────────────────────────────────────────────────────

export interface HomeserverConfig {
  /** OpenAI-compatible base, e.g. http://127.0.0.1:1234/v1 */
  lmStudioBaseUrl: string;
  /** LM Studio native REST base, e.g. http://127.0.0.1:1234/api/v1 (richer model info) */
  lmStudioRestUrl: string;
  /**
   * Which model-admin backend to use. Default: "llamaswap". The "lmstudio" adapter is
   * DEPRECATED (#146) — kept for one release for callers still pointed at LM Studio, but
   * an env omission (fresh deploy, restore from backup) must land on llamaswap, not
   * silently reactivate the deprecated adapter.
   */
  backend: "lmstudio" | "llamaswap";
  /** Explicit remote small-model backend. Empty URL keeps the gateway M5-only. */
  orin: {
    url: string;
    model: string;
    eligibleTaskTypes: string[];
    healthTimeoutMs: number;
  };
  /**
   * Use the evidence-based routing table (docs/m5-routing.json, via routing-table.ts) to pick the
   * local model per task type and force-escalate the characterized gap types (sql) to a frontier
   * model. Default "off" — behaviour-preserving: the orchestrator resolves the model the old way
   * (loaded model + ledger). When "on", an explicit task.modelId still wins over the routing table.
   */
  useRoutingTable: "on" | "off";
  /**
   * Cross-model DISAGREEMENT gate (docs/cascade-gate-experiment-design.md). On the UNVERIFIED
   * delegation path (no deterministic verifier verdict), run a SECOND cheap local model and
   * escalate to frontier when the two local answers disagree — the instance-level escalation
   * signal that beats self-confidence (AUROC 0.986 vs 0.807 on real owner sub-tasks). Modes:
   *   - "off"    (default): behaviour-preserving — never runs the second model.
   *   - "shadow": runs the second model + RECORDS the disagreement in the ledger, but does NOT
   *               change routing. The "validate in the live ledger before default" path.
   *   - "on":     runs the second model AND escalates on disagreement.
   */
  disagreementGate: "off" | "shadow" | "on";
  /** The SECOND local model the gate compares against the primary. Default "qwen3-coder-next-80b". */
  disagreementGateModel: string;
  /** disagreementScore ≥ this → escalate. Default 0.3 (reproduces the validated ~10.5% operating point). */
  disagreementGateThreshold: number;
  /**
   * Directory backing the FIFO GPU lease (issue #88) — one ticket file per heavy batch job that
   * `homeserver gpu run` serializes against the serial GPU. Gitignored under ./data. Default
   * "./data/gpu-leases".
   */
  gpuLeaseDir: string;
  /**
   * GPU-lease heartbeat-staleness window (ms): a ticket whose session stops heartbeating for
   * longer than this is reclaimed by the next waiter, so a dead job never holds the GPU forever.
   * Default 30_000 (must comfortably exceed the lease's 5s heartbeat). */
  gpuLeaseStaleMs: number;
  /** Host the gateway binds to. 127.0.0.1 (safe default) → 0.0.0.0 for LAN serving. */
  gatewayHost: string;
  gatewayPort: number;
  /** Bearer tokens accepted for normal (inference / delegate / ledger) endpoints. */
  apiKeys: string[];
  /** Bearer tokens additionally allowed to hit /admin/* (load/unload/download). */
  adminApiKeys: string[];
  /** Bearer tokens for a read-only MONITOR scope — may ONLY GET /healthz, /ledger, /metrics, /models. */
  monitorApiKeys: string[];
  /** Minimum context length the orchestrator requires of a loaded model. */
  minContextLength: number;
  /** Default per-call token budget for local delegations (reasoning needs headroom). */
  defaultMaxTokens: number;
  /** Per-call wall-clock ceiling for a local delegation (ms). */
  callTimeoutMs: number;
  /**
   * When true (default), JSON-shaped task types (taxonomy `jsonOutput` — e.g. triage, source-distill)
   * that don't carry an explicit `responseFormat` are delegated with `{ type: "json_object" }`. That
   * engages llama.cpp grammar-constrained decoding and structurally prevents gpt-oss-120b's harmony/PEG
   * HTTP-500 on strict-JSON prompts (#166 — the robust fix behind the #164 retry). Set
   * HOMESERVER_AUTO_JSON_RESPONSE_FORMAT=off to disable (e.g. a backend that ignores response_format).
   */
  autoJsonResponseFormat: boolean;
  /** GPU slot budget — total concurrent in-flight inference requests across all keys. */
  maxInflight: number;
  /** How long an owner request may wait (queue) for a slot before a 503. */
  ownerQueueMaxMs: number;
  /** Retry-After (seconds) returned on a guest 503 when the box is at capacity. */
  busyRetryAfterSeconds: number;
  /** Retry-After (seconds) returned on a guest 503 caused by bench/maintenance mode (#108). */
  maintenanceRetryAfterSeconds: number;
  /** Whether the gateway starts in bench/maintenance mode (guests refused). Default: off. */
  maintenanceModeAtStart: boolean;
  /** Hard cap applied (via min()) to every request's max_tokens. */
  perRequestMaxTokens: number;
  /** Exact model id → explicit-request max_tokens ceiling; CSV env `model=limit,...`. */
  modelMaxTokens: Record<string, number>;
  /** Defaults applied to newly-minted keys (and to legacy static keys). */
  keyDefaults: { rpm: number; tpm: number; dailyTokenBudget: number; maxParallel: number };
  /**
   * Task types EXCLUDED from verdict-WRITING harvest (HARVEST_MODE=on). Default ["other"] — the
   * broad catch-all bucket is too noisy to teach routing (see DEFAULT_HARVEST_EXCLUDED_TASK_TYPES).
   * Shadow-mode harvest ignores this list. Env HOMESERVER_HARVEST_EXCLUDED_TASK_TYPES (CSV);
   * unset → default, set to "" → disable the exclusion.
   */
  harvestExcludedTaskTypes: string[];
  policy: PolicyConfig;
  delegatePolicy: DelegatePolicyConfig;
  /** #234: background candidate-evidence lane on router-escalated leaves. Default OFF. */
  shadowLane: ShadowLaneConfig;
  /** Whether structured access logging is enabled ('on' | 'off'). Default: 'on'. */
  accessLog: "on" | "off";
  /**
   * Whether the OWNER-ONLY full request log is enabled ('on' | 'off'). Default: 'on'.
   * When 'on', requests from a real owner keystore key persist the full prompt + completion +
   * metrics for operator analysis. Guests are NEVER content-logged regardless of this toggle.
   */
  ownerRequestLog: "on" | "off";
  /**
   * Whether the durable CONTENT-BLIND request_log (SQLite) is written ('on' | 'off'). Default:
   * 'on'. This table is METADATA-ONLY for everyone (no prompt/response text, ever) — it powers
   * the owner's fleet queries (#distinct users, concurrency, TTFT, throughput). Distinct from
   * ownerRequestLog above, which captures CONTENT and is strictly owner-only.
   */
  requestLog: "on" | "off";
  /**
   * Durable per-delegation savings accounting. Default "on": writes a content-blind row to
   * delegation_costs for each /delegate outcome, including zero verified savings for unverified
   * or failed local attempts.
   */
  delegationCostLog: "on" | "off";
  /**
   * Optional caller/default "smart model" baseline. When set, savings are estimated against the
   * actual delegator model as well as the fixed premium baseline. Callers may override per /delegate
   * request with `delegatorModelId`.
   */
  defaultDelegatorModelId: string;
  /** Fixed high-end baseline used for "premium baseline" savings. Default Claude Fable 5. */
  premiumBaselineModelId: string;
  /** Local electricity / marginal service cost in USD per 1M local tokens. Default 0. */
  m5MarginalUsdPerMTok: number;
  /** Hardware-amortization allocation in USD per 1M local tokens. Default 0 until calibrated. */
  m5AmortizedUsdPerMTok: number;
  /** Dashboard conversion rate for SEK panels. Default 10.5. */
  usdToSek: number;
  /** Whether /healthz hits are included in the access log ('on' | 'off'). Default: 'off'. */
  accessLogHealthz: "on" | "off";
  /**
   * Per-IP throttle on the UNauthenticated public surface (GET / , GET /portal,
   * POST /portal/redeem) — defence-in-depth behind any upstream WAF. Max attempts per
   * `publicWindowMs` per client IP; 0 disables the in-app throttle. Default 10 / 10 min.
   */
  redeemRpm: number;
  /** Window (ms) for the per-IP public-surface throttle. Default 600_000 (10 min). */
  publicWindowMs: number;
  /**
   * Per-IP throttle on POST /portal/feedback. Default 5 per publicWindowMs.
   * 0 disables the in-app throttle. A lower limit than redeemRpm is intentional —
   * feedback submissions are expected to be rare.
   */
  feedbackRpm: number;
  /** Reverse-proxy peers (IP / CIDR) trusted to set CF-Connecting-IP. Default: loopback only. */
  trustedProxies: string[];
  /**
   * Model ids whose recurrent (SSM-style) memory is corrupted by an ABRUPT mid-stream disconnect
   * (the Qwen3-Next "?????" degeneration). On such a disconnect the gateway fire-and-forget unloads
   * the model so the next request loads a clean one. ONLY ids in this list are ever unloaded —
   * full-attention models (mellum, …) truncate cleanly and are immune, so they are never listed.
   * Default: ["qwen3-coder-next-80b"]. Set HOMESERVER_RECURRENT_MODEL_IDS="" to disable the feature.
   * See docs/m5-qwen3next-recurrent-degeneration-2026-06-24.md.
   */
  recurrentModelIds: string[];
  /**
   * Per-model cooldown (ms) for the recurrent poison-clear: at most one unload per model per window.
   * The FIRST disconnect always clears immediately (recovery is never delayed); a disconnect INSIDE
   * the window schedules a single TRAILING unload at the window boundary (so a re-poison never sticks,
   * but unloads stay capped at one per window). Because that cap holds at ANY value, the cooldown can
   * no longer be thrashed into a DoS regardless of how fast a client disconnects — so this knob is now
   * a recovery-latency vs reload-frequency dial, not a security control. Default 60_000 (1 min):
   * above the observed ~22–38 s cold-load of qwen3-coder-next-80b, bounds the worst-case "dirty" window
   * to ≤1 min, and caps attacker-forced reloads to ≤1/min. Raise it to reduce reload churn; lower it
   * for faster recovery from a rare second genuine degeneration within the window.
   */
  poisonClearCooldownMs: number;
  /**
   * Degeneracy-watchdog threshold (Fix #2, the SILENT backstop): while relaying a recurrent model's
   * SSE stream, if the decoded output contains a run of this many consecutive identical NON-whitespace
   * characters (the "?????" single-token degeneration), the gateway aborts the stream, forces a
   * poison-clear unload, and tells the client to retry — catching the case where an EARLIER disconnect
   * dirtied the recurrent buffer but THIS request saw no disconnect to trigger the primary fix. Only
   * applies to recurrentModelIds. Default 400 (no legitimate text/code/table has 400 identical
   * non-whitespace chars in a row; the degeneration emits thousands). Set 0 to disable the watchdog.
   * See docs/m5-qwen3next-recurrent-degeneration-2026-06-24.md (ranked fix #2).
   */
  degeneracyRunThreshold: number;
  /**
   * Base URL of the box's whisper-server (speech-to-text). Its only endpoint is
   * POST /inference (multipart). Default http://127.0.0.1:8092.
   */
  whisperUrl: string;
  /**
   * Credits charged per second of transcribed audio. cost = ceil(duration_seconds) * this.
   * Default 50 (mirrors the per-token credit scale so a one-minute clip ≈ 3000 credits).
   */
  audioCreditsPerSecond: number;
  /**
   * Default `language` forwarded to whisper-server when the client omits it. "auto" lets the
   * backend detect the language. Default "auto".
   */
  audioDefaultLanguage: string;
  /**
   * Upper bound on metered/billable audio length (seconds). Drives the WORST-CASE credit
   * reservation taken BEFORE transcribing (ceil(audioMaxSeconds) * audioCreditsPerSecond), so a
   * key can never overdraft its lifetime cap, and clamps a bogus/over-long reported duration at
   * reconcile time. Default 1800 (30 min).
   */
  audioMaxSeconds: number;
  /**
   * Hard cap on the transcription upload body size (bytes). A declared Content-Length above this
   * is rejected with 413 BEFORE buffering; a streamed body that exceeds it is aborted with 413.
   * Default 33_554_432 (32 MiB).
   */
  audioMaxBytes: number;
  /**
   * Idle/socket timeout (ms) on the transcription upload read. If no body bytes arrive for this
   * long, the connection is dropped so a slow-loris client cannot hold it open indefinitely.
   * Default 30_000 (30 s).
   */
  audioReadIdleMs: number;

  /**
   * Base URL of the box's image-generation sidecar (text→image). Its endpoint is
   * POST /v1/images/generations (OpenAI-shaped). DEFAULT "" → the whole image surface is INERT:
   * the routes return 404, /v1/models does NOT advertise image-* models, and the async worker is a
   * no-op. So merging the image code changes NOTHING on a box until its .env sets this to point at a
   * live sidecar (Phase 3). Loopback-only in production (http://127.0.0.1:8093).
   */
  imageUrl: string;
  /** Max images requestable per call (`n`). Clamped to this. Default 4. */
  imageMaxN: number;
  /** Hard cap on the prompt length (chars) accepted for image generation. Default 2000. */
  imagePromptMaxChars: number;
  /** Allowed `size` values (WxH). A request outside this list is rejected 400. */
  imageSizes: string[];
  /** Default `size` applied when the client omits it (must be a member of imageSizes). */
  imageDefaultSize: string;
  /**
   * Concurrent diffusion jobs the worker runs. Only 1 is supported today (the worker serializes
   * regardless) — the knob exists so a future multi-GPU box can raise it. Default 1.
   */
  imageGpuSlots: number;
  /** Per-job wall-clock ceiling for one diffusion dispatch (ms). Default 300_000 (5 min). */
  imageJobTimeoutMs: number;
  /** Directory holding async job result files (b64 JSON). Gitignored under ./data. */
  imageResultDir: string;
  /** TTL (ms) after which a finished job's result file is swept and the job marked expired. Default 3_600_000 (1 h). */
  imageResultTtlMs: number;
  /** Per-image credit price by tier. Reserved worst-case (n × price) at submit; reconciled to delivered. */
  imageCreditsPerImage: { fast: number; balanced: number; high: number };
  /** Backend (sidecar) model id forwarded for each tier. The advertised image-* alias maps to these. */
  imageBackendModels: { fast: string; balanced: string; high: string };

  /**
   * Blind-context delegation (issue #128): allowlist ROOT directories the MCP `ask` tool's
   * OWNER-ONLY `files` parameter may read from (colon-separated, absolute paths). DEFAULT EMPTY —
   * the feature is DISABLED by construction: any `files` request then errors with an actionable
   * message rather than silently doing nothing. Enforcement lives in blind-context.ts
   * (expandBlindContext); this config is threaded through unmodified. See src/homeserver/README.md
   * "MCP transport" for the security model.
   */
  blindContextRoots: string[];
  /** Per-file byte cap for a blind-context attachment (checked via stat, before the read). Default 262144 (256 KiB). */
  blindContextMaxFileBytes: number;
  /** Cumulative byte cap across every file attached in one `ask` call. Default 1048576 (1 MiB). */
  blindContextMaxTotalBytes: number;

  /**
   * code_loop (#116, docs/agentic-code-tool-design.md): owner-only sandboxed pi-driven agentic
   * coding tool. Default "off" — a deploy without box provisioning is inert (the MCP tools are
   * still visible to minted owner keys, but code_loop_start returns a structured `disabled`
   * refusal).
   */
  codeLoop: "on" | "off";
  /** Absolute path to the pinned pi binary (vendor install OUTSIDE the rsync root). "" = unprovisioned. */
  codeLoopPiBin: string;
  /** The dedicated owner-tier service key pi calls the gateway back with (real keystore key —
   *  keyHash !== null is what makes owner_request_log fire per turn). Never logged. */
  codeLoopApiKey: string;
  /** Sandbox work root. Under ./data so rsync deploys never touch it and `npx --no-install`
   *  resolves node_modules by walk-up. */
  codeLoopWorkroot: string;
  /** The single loop model (allow-listed on the service key). */
  codeLoopModel: string;
  /** PI_CODING_AGENT_DIR passed to the pi subprocess. On the box it holds models.json (the
   *  provider config — no secret; apiKey is an env-var NAME reference) AND auth.json (pi's
   *  OAuth/API-key credential store, created by pi itself). The cage binds ONLY
   *  `<dir>/models.json` into the sandbox view — auth.json must stay hidden in-cage. */
  codeLoopPiAgentDir: string;
  /**
   * OS-cage posture. "required" (default): a failing cage self-test refuses every job with
   * `cage-unavailable`. "off" exists ONLY for offline unit tests — never set it on the box.
   */
  codeLoopConfinement: "required" | "off";
  /**
   * Loopback port the cage's pasta `-T` forwards to the host relay → gateway. The caged pi reaches
   * the gateway ONLY at http://127.0.0.1:<this>/v1; all other egress is blocked. Must match the
   * baseUrl in the provisioned pi models.json. Default 18080.
   */
  codeLoopForwardPort: number;
  /** Cap defaults + hard maxima (design §7). */
  codeLoopCaps: {
    wallSDefault: number;
    wallSMax: number;
    turnsDefault: number;
    turnsMax: number;
    tokensDefault: number;
    tokensMax: number;
  };
}

function envList(name: string): string[] {
  const raw = process.env[name];
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function envNum(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** Parse `model=positive_integer,...`; malformed entries are ignored rather than weakening caps. */
export function parseModelMaxTokens(raw: string | undefined): Record<string, number> {
  if (raw === undefined) return { ...DEFAULT_MODEL_MAX_TOKENS };
  if (raw.trim() === "") return {};
  const out: Record<string, number> = {};
  for (const entry of raw.split(",")) {
    const eq = entry.lastIndexOf("=");
    if (eq <= 0) continue;
    const model = entry.slice(0, eq).trim();
    const value = Number(entry.slice(eq + 1).trim());
    if (model !== "" && Number.isSafeInteger(value) && value > 0) out[model] = value;
  }
  return out;
}

/** Model-specific ceiling, falling back to the fleet-wide cap. */
export function maxTokensLimitForModel(cfg: HomeserverConfig, model: string | null | undefined): number {
  return (model && Object.hasOwn(cfg.modelMaxTokens, model) ? cfg.modelMaxTokens[model] : undefined)
    ?? cfg.perRequestMaxTokens;
}

/**
 * Omitted max_tokens retains the conservative global default. An explicit request may use the
 * selected model's larger ceiling, but never exceed it.
 */
export function clampMaxTokensForModel(
  cfg: HomeserverConfig,
  model: string | null | undefined,
  requested: number | null | undefined
): number {
  const wanted = requested ?? cfg.perRequestMaxTokens;
  return Math.min(Math.max(Math.floor(wanted), 1), maxTokensLimitForModel(cfg, model));
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** Colon-separated list (POSIX PATH-style) — used for absolute directory allowlists. */
function envColonList(name: string): string[] {
  const raw = process.env[name];
  if (!raw) return [];
  return raw
    .split(":")
    .map((s) => s.trim())
    .filter(Boolean);
}

let _config: HomeserverConfig | null = null;

export function loadConfig(): HomeserverConfig {
  if (_config) return _config;
  loadEnv();

  // LM Studio reachable base — accept either a /v1 URL or a bare host:port.
  const lmBase = (process.env["LMSTUDIO_BASE_URL"] ?? "http://127.0.0.1:1234/v1").replace(/\/$/, "");
  const origin = lmBase.replace(/\/v1$/, "");
  // The shared lmstudio-client reads LMSTUDIO_BASE_URL directly; keep it aligned so the
  // orchestrator and the raw client never disagree on where LM Studio lives.
  if (!process.env["LMSTUDIO_BASE_URL"]) process.env["LMSTUDIO_BASE_URL"] = lmBase;

  _config = {
    lmStudioBaseUrl: lmBase,
    lmStudioRestUrl: `${origin}/api/v1`,
    backend: (process.env["HOMESERVER_BACKEND"] === "lmstudio" ? "lmstudio" : "llamaswap"),
    orin: {
      // Tailscale address belongs in deployment env, never source. Unset = disabled.
      url: (process.env["HOMESERVER_ORIN_URL"] ?? "").replace(/\/$/, ""),
      model: process.env["HOMESERVER_ORIN_MODEL"] ?? "qwen2.5-coder:3b",
      eligibleTaskTypes: envList("HOMESERVER_ORIN_ELIGIBLE_TASK_TYPES"),
      healthTimeoutMs: envNum("HOMESERVER_ORIN_HEALTH_TIMEOUT_MS", 2_000),
    },
    useRoutingTable: (process.env["HOMESERVER_USE_ROUTING_TABLE"] ?? "off") === "on" ? "on" : "off",
    disagreementGate: (() => {
      const v = process.env["HOMESERVER_DISAGREEMENT_GATE"];
      return v === "on" || v === "shadow" ? v : "off";
    })(),
    disagreementGateModel: process.env["HOMESERVER_DISAGREEMENT_GATE_MODEL"] ?? "qwen3-coder-next-80b",
    disagreementGateThreshold: envNum("HOMESERVER_DISAGREEMENT_GATE_THRESHOLD", 0.3),
    gpuLeaseDir: process.env["HOMESERVER_GPU_LEASE_DIR"] ?? "./data/gpu-leases",
    gpuLeaseStaleMs: envNum("HOMESERVER_GPU_LEASE_STALE_MS", 30_000),
    gatewayHost: process.env["HOMESERVER_HOST"] ?? "127.0.0.1",
    gatewayPort: envNum("HOMESERVER_PORT", 8080),
    apiKeys: envList("HOMESERVER_API_KEYS"),
    adminApiKeys: envList("HOMESERVER_ADMIN_API_KEYS"),
    monitorApiKeys: envList("HOMESERVER_MONITOR_API_KEYS"),
    minContextLength: envNum("HOMESERVER_MIN_CONTEXT", 32768),
    defaultMaxTokens: envNum("HOMESERVER_MAX_TOKENS", 12288),
    callTimeoutMs: envNum("HOMESERVER_CALL_TIMEOUT_MS", 600_000),
    // Default ON: grammar-constrain JSON-shaped task types unless an operator explicitly opts out.
    autoJsonResponseFormat: process.env["HOMESERVER_AUTO_JSON_RESPONSE_FORMAT"] !== "off",
    maxInflight: envNum("HOMESERVER_MAX_INFLIGHT", 2),
    ownerQueueMaxMs: envNum("HOMESERVER_OWNER_QUEUE_MAX_MS", 5_000),
    busyRetryAfterSeconds: envNum("HOMESERVER_BUSY_RETRY_AFTER_S", 2),
    maintenanceRetryAfterSeconds: envNum("HOMESERVER_MAINTENANCE_RETRY_AFTER_S", 30),
    maintenanceModeAtStart: (process.env["HOMESERVER_MAINTENANCE_MODE"] ?? "off") === "on",
    perRequestMaxTokens: envNum("HOMESERVER_PER_REQUEST_MAX_TOKENS", envNum("HOMESERVER_MAX_TOKENS", 12288)),
    modelMaxTokens: parseModelMaxTokens(process.env["HOMESERVER_MODEL_MAX_TOKENS"]),
    keyDefaults: {
      rpm: envNum("HOMESERVER_KEY_DEFAULT_RPM", 60),
      tpm: envNum("HOMESERVER_KEY_DEFAULT_TPM", 60_000),
      dailyTokenBudget: envNum("HOMESERVER_KEY_DEFAULT_DAILY_TOKENS", 0),
      maxParallel: envNum("HOMESERVER_KEY_DEFAULT_MAX_PARALLEL", 1),
    },
    // Distinguish "unset → default ['other']" from "set to empty → disable the exclusion",
    // mirroring recurrentModelIds / judgmentQualityTaskTypes.
    harvestExcludedTaskTypes:
      process.env["HOMESERVER_HARVEST_EXCLUDED_TASK_TYPES"] !== undefined
        ? envList("HOMESERVER_HARVEST_EXCLUDED_TASK_TYPES")
        : [...DEFAULT_HARVEST_EXCLUDED_TASK_TYPES],
    policy: {
      minSamples: envNum("HOMESERVER_POLICY_MIN_SAMPLES", DEFAULT_POLICY.minSamples),
      maxSamples: envNum("HOMESERVER_POLICY_MAX_SAMPLES", DEFAULT_POLICY.maxSamples),
      maxFails: envNum("HOMESERVER_POLICY_MAX_FAILS", DEFAULT_POLICY.maxFails),
      viableThreshold: envNum("HOMESERVER_POLICY_VIABLE", DEFAULT_POLICY.viableThreshold),
      marginalThreshold: envNum("HOMESERVER_POLICY_MARGINAL", DEFAULT_POLICY.marginalThreshold),
      explorationRate: envNum("HOMESERVER_POLICY_EXPLORATION", DEFAULT_POLICY.explorationRate),
      // Distinguish "unset → default" from "set to empty → disable the exclusion": an empty env
      // value yields [] so the operator can turn #156 verdict-hygiene off, while an absent var
      // keeps code-review guarded.
      judgmentQualityTaskTypes:
        process.env["HOMESERVER_JUDGMENT_QUALITY_TASK_TYPES"] !== undefined
          ? envList("HOMESERVER_JUDGMENT_QUALITY_TASK_TYPES")
          : [...DEFAULT_JUDGMENT_QUALITY_TASK_TYPES],
      // #168: the trusted-verifier WHITELIST for judgment-quality types. Empty by default AND when
      // set empty — envList() yields [] for unset/empty alike, which is the intended honest default
      // (no verifier trusted yet → code-review escalates). #158 populates it with its ground-truth
      // probe's verifier name.
      trustedVerifiersForJudgment: envList("HOMESERVER_TRUSTED_JUDGMENT_VERIFIERS"),
      // #233: off by default — behaviour-preserving until validated against real routing decisions.
      discountFormatOnlyEvidence:
        (process.env["HOMESERVER_DISCOUNT_FORMAT_ONLY_EVIDENCE"] ?? "off") === "on",
      // Distinguish "unset → default" from "set to empty → disable for every type", mirroring
      // judgmentQualityTaskTypes above.
      formatOnlyDiscountTaskTypes:
        process.env["HOMESERVER_FORMAT_DISCOUNT_TASK_TYPES"] !== undefined
          ? envList("HOMESERVER_FORMAT_DISCOUNT_TASK_TYPES")
          : [...DEFAULT_FORMAT_ONLY_DISCOUNT_TASK_TYPES],
      // Clamped to [0,1] — a misconfigured value outside that range (e.g. HOMESERVER_FORMAT_DISCOUNT_WEIGHT=5
      // or a negative) must never push a weighted successRate outside [0,1] and corrupt verdict banding
      // (Codex review finding, PR #237).
      formatOnlyDiscountWeight: clamp(
        envNum("HOMESERVER_FORMAT_DISCOUNT_WEIGHT", DEFAULT_POLICY.formatOnlyDiscountWeight),
        0,
        1
      ),
    },
    delegatePolicy: {
      mode: (() => {
        const v = process.env["HOMESERVER_DELEGATE_POLICY"];
        return v === "shadow" || v === "enforce" ? v : DEFAULT_DELEGATE_POLICY.mode;
      })(),
      minSamples: envNum("HOMESERVER_DELEGATE_POLICY_MIN_SAMPLES", DEFAULT_DELEGATE_POLICY.minSamples),
      minSuccessRate: envNum(
        "HOMESERVER_DELEGATE_POLICY_MIN_SUCCESS",
        DEFAULT_DELEGATE_POLICY.minSuccessRate
      ),
      lowRiskSuccessRate: envNum(
        "HOMESERVER_DELEGATE_POLICY_LOW_RISK_SUCCESS",
        DEFAULT_DELEGATE_POLICY.lowRiskSuccessRate
      ),
      maxErrorRate: envNum(
        "HOMESERVER_DELEGATE_POLICY_MAX_ERROR_RATE",
        DEFAULT_DELEGATE_POLICY.maxErrorRate
      ),
      maxP90LatencyMs: envNum(
        "HOMESERVER_DELEGATE_POLICY_MAX_P90_LATENCY_MS",
        DEFAULT_DELEGATE_POLICY.maxP90LatencyMs
      ),
    },
    shadowLane: {
      // Default OFF: the lane spends GPU on work nobody asked for. Only "on" enables it.
      mode: (process.env["HOMESERVER_SHADOW_LANE"] ?? "off") === "on" ? "on" : "off",
      model: process.env["HOMESERVER_SHADOW_LANE_MODEL"] ?? DEFAULT_SHADOW_LANE.model,
      taskTypes: envList("HOMESERVER_SHADOW_LANE_TASK_TYPES"),
      maxTokens: Math.max(
        0,
        Math.floor(envNum("HOMESERVER_SHADOW_LANE_MAX_TOKENS", DEFAULT_SHADOW_LANE.maxTokens))
      ),
      timeoutMs: Math.max(
        1,
        Math.floor(envNum("HOMESERVER_SHADOW_LANE_TIMEOUT_MS", DEFAULT_SHADOW_LANE.timeoutMs))
      ),
      // Clamped to [0,1]: outside it, every shadow row would grade a trivial pass (<0) or fail (>1),
      // manufacturing exactly the fake evidence this lane is designed not to produce.
      agreementThreshold: clamp(
        envNum("HOMESERVER_SHADOW_LANE_AGREEMENT", DEFAULT_SHADOW_LANE.agreementThreshold),
        0,
        1
      ),
    },
    accessLog: (process.env["HOMESERVER_ACCESS_LOG"] ?? "on") === "off" ? "off" : "on",
    ownerRequestLog:
      (process.env["HOMESERVER_OWNER_REQUEST_LOG"] ?? "on") === "off" ? "off" : "on",
    requestLog: (process.env["HOMESERVER_REQUEST_LOG"] ?? "on") === "off" ? "off" : "on",
    delegationCostLog:
      (process.env["HOMESERVER_DELEGATION_COST_LOG"] ?? "on") === "off" ? "off" : "on",
    defaultDelegatorModelId: process.env["HOMESERVER_DEFAULT_DELEGATOR_MODEL_ID"] ?? "",
    premiumBaselineModelId: process.env["HOMESERVER_PREMIUM_BASELINE_MODEL_ID"] ?? "claude-fable-5",
    m5MarginalUsdPerMTok: envNum("HOMESERVER_M5_MARGINAL_USD_PER_MTOK", 0),
    m5AmortizedUsdPerMTok: envNum("HOMESERVER_M5_AMORTIZED_USD_PER_MTOK", 0),
    usdToSek: envNum("HOMESERVER_USD_TO_SEK", 10.5),
    accessLogHealthz:
      (process.env["HOMESERVER_ACCESS_LOG_HEALTHZ"] ?? "off") === "on" ? "on" : "off",
    redeemRpm: envNum("HOMESERVER_REDEEM_RPM", 10),
    publicWindowMs: envNum("HOMESERVER_PUBLIC_WINDOW_MS", 600_000),
    feedbackRpm: envNum("HOMESERVER_FEEDBACK_RPM", 5),
    trustedProxies:
      process.env["HOMESERVER_TRUSTED_PROXIES"] !== undefined
        ? envList("HOMESERVER_TRUSTED_PROXIES")
        : ["127.0.0.1", "::1"],
    // Distinguish "unset → default" from "set to empty → disable": an empty env value yields [] so
    // the operator can turn the feature off, while an absent var keeps the known recurrent model.
    recurrentModelIds:
      process.env["HOMESERVER_RECURRENT_MODEL_IDS"] !== undefined
        ? envList("HOMESERVER_RECURRENT_MODEL_IDS")
        : ["qwen3-coder-next-80b"],
    poisonClearCooldownMs: envNum("HOMESERVER_POISON_CLEAR_COOLDOWN_MS", 60_000),
    degeneracyRunThreshold: envNum("HOMESERVER_DEGENERACY_RUN_THRESHOLD", 400),
    whisperUrl: (process.env["HOMESERVER_WHISPER_URL"] ?? "http://127.0.0.1:8092").replace(/\/$/, ""),
    audioCreditsPerSecond: envNum("HOMESERVER_AUDIO_CREDITS_PER_SECOND", 50),
    audioDefaultLanguage: process.env["HOMESERVER_AUDIO_DEFAULT_LANGUAGE"] ?? "auto",
    audioMaxSeconds: envNum("HOMESERVER_AUDIO_MAX_SECONDS", 1800),
    audioMaxBytes: envNum("HOMESERVER_AUDIO_MAX_BYTES", 32 * 1024 * 1024),
    audioReadIdleMs: envNum("HOMESERVER_AUDIO_READ_IDLE_MS", 30_000),
    // Image generation. imageUrl defaults to "" → the surface is INERT until a box sets it.
    imageUrl: (process.env["HOMESERVER_IMAGE_URL"] ?? "").replace(/\/$/, ""),
    imageMaxN: envNum("HOMESERVER_IMAGE_MAX_N", 4),
    imagePromptMaxChars: envNum("HOMESERVER_IMAGE_PROMPT_MAX_CHARS", 2000),
    imageSizes: (() => {
      const list = envList("HOMESERVER_IMAGE_SIZES");
      return list.length > 0 ? list : ["512x512", "768x768", "1024x1024"];
    })(),
    imageDefaultSize: process.env["HOMESERVER_IMAGE_DEFAULT_SIZE"] ?? "1024x1024",
    imageGpuSlots: envNum("HOMESERVER_IMAGE_GPU_SLOTS", 1),
    imageJobTimeoutMs: envNum("HOMESERVER_IMAGE_JOB_TIMEOUT_MS", 300_000),
    imageResultDir: process.env["HOMESERVER_IMAGE_RESULT_DIR"] ?? "./data/image-results",
    imageResultTtlMs: envNum("HOMESERVER_IMAGE_RESULT_TTL_MS", 3_600_000),
    imageCreditsPerImage: {
      fast: envNum("HOMESERVER_IMAGE_CREDITS_PER_IMAGE_FAST", 5_000),
      balanced: envNum("HOMESERVER_IMAGE_CREDITS_PER_IMAGE_BALANCED", 20_000),
      high: envNum("HOMESERVER_IMAGE_CREDITS_PER_IMAGE_HIGH", 60_000),
    },
    imageBackendModels: {
      fast: process.env["HOMESERVER_IMAGE_MODEL_FAST"] ?? "sdxl-turbo",
      balanced: process.env["HOMESERVER_IMAGE_MODEL_BALANCED"] ?? "sd3.5-large-turbo",
      high: process.env["HOMESERVER_IMAGE_MODEL_HIGH"] ?? "flux.1-schnell",
    },
    blindContextRoots: envColonList("HOMESERVER_BLIND_CONTEXT_ROOTS"),
    blindContextMaxFileBytes: envNum("HOMESERVER_BLIND_CONTEXT_MAX_FILE_BYTES", 262_144),
    blindContextMaxTotalBytes: envNum("HOMESERVER_BLIND_CONTEXT_MAX_TOTAL_BYTES", 1_048_576),
    // code_loop (#116). Default off → the surface is visible to owners but inert until provisioned.
    codeLoop: (process.env["HOMESERVER_CODE_LOOP"] ?? "off") === "on" ? "on" : "off",
    codeLoopPiBin: process.env["HOMESERVER_CODE_LOOP_PI_BIN"] ?? "",
    codeLoopApiKey: process.env["HOMESERVER_CODE_LOOP_API_KEY"] ?? "",
    codeLoopWorkroot: process.env["HOMESERVER_CODE_LOOP_WORKROOT"] ?? "./data/code-loop-work",
    codeLoopModel: process.env["HOMESERVER_CODE_LOOP_MODEL"] ?? "qwen3-coder-next-80b",
    codeLoopPiAgentDir: process.env["HOMESERVER_CODE_LOOP_PI_AGENT_DIR"] ?? "",
    // "off" only when explicitly set — anything else (incl. unset) is the safe "required".
    codeLoopConfinement: process.env["HOMESERVER_CODE_LOOP_CONFINEMENT"] === "off" ? "off" : "required",
    codeLoopForwardPort: envNum("HOMESERVER_CODE_LOOP_FORWARD_PORT", 18080),
    codeLoopCaps: {
      wallSDefault: envNum("HOMESERVER_CODE_LOOP_WALL_S", 480),
      wallSMax: envNum("HOMESERVER_CODE_LOOP_WALL_S_MAX", 900),
      turnsDefault: envNum("HOMESERVER_CODE_LOOP_TURNS", 24),
      turnsMax: envNum("HOMESERVER_CODE_LOOP_TURNS_MAX", 40),
      tokensDefault: envNum("HOMESERVER_CODE_LOOP_TOKENS", 60_000),
      tokensMax: envNum("HOMESERVER_CODE_LOOP_TOKENS_MAX", 120_000),
    },
  };
  return _config;
}

/** Test/CLI hook to override config (e.g. point at a throwaway DB or a different port). */
export function setConfig(partial: Partial<HomeserverConfig>): HomeserverConfig {
  _config = { ...loadConfig(), ...partial };
  return _config;
}

/** Test hook: clear the cached config so the next loadConfig() rebuilds from the environment. */
export function resetConfig(): void {
  _config = null;
}
