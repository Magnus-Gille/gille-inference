// PRIVACY INVARIANT: This file contains ONLY aggregate counts, durations, and coarse labels.
// It MUST NEVER record request/response content, per-user identifiers, key aliases, key hashes,
// IP addresses, or any other PII. Labels are restricted to: model, outcome, tier, direction,
// lane, surface — all low-cardinality, content-blind values.

/**
 * Tiny in-memory Prometheus registry for the home-server gateway.
 *
 * No external npm dependencies — hand-rolled Prometheus 0.0.4 text exposition.
 * All state is module-level so it accumulates across requests. resetMetrics() is
 * provided for test isolation (never call in production).
 */

// ─── Label sanitization ─────────────────────────────────────────────────────

/** Escape special characters in a Prometheus label value per the 0.0.4 spec. */
function sanitizeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/** Coerce a nullable model string to a safe label value. null/empty → "none". */
function modelLabel(model: string | null | undefined): string {
  if (!model || model.trim() === "") return "none";
  return sanitizeLabel(model);
}

// ─── Internal state ──────────────────────────────────────────────────────────

/**
 * A counter map: key is a JSON-serialised label set, value is the running total.
 * Using a Map<string, number> keyed on the serialised labels avoids the overhead of
 * a nested object tree and makes iteration over distinct label combos trivial.
 */
type LabelMap = Map<string, number>;

// homeserver_requests_total{model, outcome, tier}
const requestsTotal: LabelMap = new Map();

// homeserver_tokens_total{model, direction}  direction = "prompt" | "completion"
const tokensTotal: LabelMap = new Map();

// Node-scoped counterparts preserve the long-standing model-labelled metric contracts while making
// remote-backend usage visible. Node is a fixed two-value set (m5|orin), never caller text.
const nodeRequestsTotal: LabelMap = new Map();
const nodeTokensTotal: LabelMap = new Map();

// homeserver_credits_consumed_total{tier}
const creditsTotal: LabelMap = new Map();

// homeserver_admission_rejections_total{lane}
const admissionRejectionsTotal: LabelMap = new Map();

// homeserver_rate_limited_total{surface}
const rateLimitedTotal: LabelMap = new Map();

// homeserver_audio_seconds_total{model} — total seconds of audio transcribed (speech-to-text).
// Content-blind: the only label is the canonical model. The TRANSCRIPT TEXT is never recorded here.
const audioSecondsTotal: LabelMap = new Map();

// homeserver_images_total{model} — total images generated (text→image). Content-blind: the only
// label is the canonical model. The PROMPT and the image BYTES are never recorded here.
const imagesTotal: LabelMap = new Map();

// homeserver_poison_clear_total{model, outcome} — recurrent-model poison-clear unloads (the
// Qwen3-Next "?????" resilience fix) from ANY trigger: an abrupt client disconnect (Fix #1) OR the
// degeneracy watchdog (Fix #2), which share the same fireUnload path. outcome = "ok" | "failed".
// Content-blind: the only labels are the canonical model id and the unload result — never content.
const poisonClearTotal: LabelMap = new Map();

// homeserver_degeneracy_detected_total{model} — times the degeneracy watchdog (Fix #2, the SILENT
// backstop) flagged a single-token "?????" run and forced a poison-clear, across all three arms:
// streaming SSE, non-streaming body, and the trailing newline-less frame. Distinguishes the silent
// (no-disconnect) trigger from the disconnect-keyed poison_clear path. Content-blind: only the
// canonical model id — never any request content.
const degeneracyDetectedTotal: LabelMap = new Map();

// homeserver_code_loop_runs_total{status} — terminal code_loop runs by status (#116). Content-blind:
// the only label is the terminal run status (completed | cap-exceeded | degenerate | arm-error |
// orphaned) — never the instruction, diff, or any content.
const codeLoopRunsTotal: LabelMap = new Map();

// homeserver_code_loop_interleaved_total — count of OTHER-model gateway requests admitted while a
// code_loop run held the GPU lease (the swap-thrash cost meter, design §8). No labels.
const codeLoopInterleavedTotal: LabelMap = new Map();

// homeserver_code_loop_relay_denied_total — requests the caged pi tried to send through the gateway
// relay to a NON-allowlisted path/method (e.g. /admin/*), refused with 403 WITHOUT being forwarded
// upstream. A nonzero value means the caged pi attempted to escape the two allowed routes.
// Content-blind: no path label (the path could echo an injection attempt).
const codeLoopRelayDeniedTotal: LabelMap = new Map();

// homeserver_code_loop_active — gauge: is a code_loop run currently in flight (0|1; single-flight).
// Like the inflight gauge, it is only EXPOSED once code_loop has been touched, so a fresh box
// (nothing recorded) still renders an empty /metrics body.
let codeLoopActive = 0;
let codeLoopTouched = false;

// homeserver_request_duration_seconds{model} — histogram
const DURATION_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60];

interface HistogramState {
  buckets: Map<string, Map<number, number>>; // model → bucket_le → count
  sum: Map<string, number>;                  // model → sum of observations (in seconds)
  count: Map<string, number>;                // model → observation count
}

const durationHistogram: HistogramState = {
  buckets: new Map(),
  sum: new Map(),
  count: new Map(),
};

// homeserver_ttft_seconds{model} — time-to-first-token histogram (streaming requests only).
// Finer low-end buckets than duration: TTFT is dominated by sub-second latencies on a warm model.
const TTFT_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60];

const ttftHistogram: HistogramState = {
  buckets: new Map(),
  sum: new Map(),
  count: new Map(),
};

// homeserver_inflight_requests — current in-flight count (a gauge, not a counter). Mirrors the
// admission controller's acquire/release. homeserver_inflight_by_lane{lane} is the per-lane split.
// No per-user labels — lane is "owner"|"guest" (or "unknown"), content-blind by construction.
let inflightTotal = 0;
const inflightByLane: Map<string, number> = new Map();
// Whether the gauge has ever been touched — so renderMetrics() stays "" on a truly empty registry
// (the gauge can legitimately read 0 after balanced acquire/release, which must still render).
let inflightTouched = false;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function incCounter(map: LabelMap, key: string, amount = 1): void {
  map.set(key, (map.get(key) ?? 0) + amount);
}

function labelKey(labels: Record<string, string>): string {
  // Deterministic order: sort by key name so equivalent label sets always produce the same key.
  return JSON.stringify(
    Object.fromEntries(Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)))
  );
}

/** Observe one value (seconds) into a model-labelled histogram. Shared by duration + TTFT. */
function observeHistogram(hist: HistogramState, model: string, valueSec: number, bucketLes: number[]): void {
  const buckets = hist.buckets.get(model) ?? new Map<number, number>();
  for (const le of bucketLes) {
    if (valueSec <= le) buckets.set(le, (buckets.get(le) ?? 0) + 1);
  }
  hist.buckets.set(model, buckets);
  hist.sum.set(model, (hist.sum.get(model) ?? 0) + valueSec);
  hist.count.set(model, (hist.count.get(model) ?? 0) + 1);
}

// ─── Public API ──────────────────────────────────────────────────────────────

export interface RecordRequestOpts {
  model: string | null;
  outcome: string | null;
  tier: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  durationMs: number | null;
  creditsCharged: number | null;
  /** Actual trusted compute node; absent callers are legacy M5 paths. */
  node?: "m5" | "orin";
}

/**
 * Record a completed gateway request. Called once per request from the finally block
 * in handleRequest, after lctx.totalMs is set. Content-blind by construction — callers
 * must pass only the aggregated fields listed above; never content or identifiers.
 */
export function recordRequest(opts: RecordRequestOpts): void {
  const m = modelLabel(opts.model);
  const outcome = sanitizeLabel(opts.outcome ?? "unknown");
  const tier = sanitizeLabel(opts.tier ?? "unknown");

  // requests counter
  const node = sanitizeLabel(opts.node ?? "m5");
  incCounter(requestsTotal, labelKey({ model: m, outcome, tier }));
  incCounter(nodeRequestsTotal, labelKey({ model: m, node, outcome, tier }));

  // tokens counters
  if (typeof opts.promptTokens === "number" && opts.promptTokens > 0) {
    incCounter(tokensTotal, labelKey({ model: m, direction: "prompt" }), opts.promptTokens);
    incCounter(nodeTokensTotal, labelKey({ model: m, node, direction: "prompt" }), opts.promptTokens);
  }
  if (typeof opts.completionTokens === "number" && opts.completionTokens > 0) {
    incCounter(tokensTotal, labelKey({ model: m, direction: "completion" }), opts.completionTokens);
    incCounter(nodeTokensTotal, labelKey({ model: m, node, direction: "completion" }), opts.completionTokens);
  }

  // credits counter
  if (typeof opts.creditsCharged === "number" && opts.creditsCharged > 0) {
    incCounter(creditsTotal, labelKey({ tier }), opts.creditsCharged);
  }

  // duration histogram
  if (typeof opts.durationMs === "number" && opts.durationMs >= 0) {
    observeHistogram(durationHistogram, m, opts.durationMs / 1000, DURATION_BUCKETS);
  }
}

/**
 * Record a time-to-first-token observation (ms) for a STREAMING request. Content-blind: the only
 * label is the canonical model (null/empty → "none"). Non-streaming requests do NOT call this.
 */
export function recordTtft(model: string | null | undefined, ttftMs: number): void {
  if (!Number.isFinite(ttftMs) || ttftMs < 0) return;
  observeHistogram(ttftHistogram, modelLabel(model), ttftMs / 1000, TTFT_BUCKETS);
}

/**
 * Increment the in-flight gauge on admission acquire. `lane` is the principal's tier
 * ("owner"|"guest"); any other value is coerced to a safe label. No per-user labels — the
 * per-user dimension lives in the SQLite request_log, never in Prometheus.
 */
export function inflightInc(lane: string | null | undefined): void {
  inflightTouched = true;
  inflightTotal++;
  const l = sanitizeLabel(lane && lane.trim() !== "" ? lane : "unknown");
  inflightByLane.set(l, (inflightByLane.get(l) ?? 0) + 1);
}

/** Decrement the in-flight gauge on admission release. Floored at 0 (never goes negative). */
export function inflightDec(lane: string | null | undefined): void {
  inflightTouched = true;
  inflightTotal = Math.max(0, inflightTotal - 1);
  const l = sanitizeLabel(lane && lane.trim() !== "" ? lane : "unknown");
  const next = (inflightByLane.get(l) ?? 0) - 1;
  if (next <= 0) inflightByLane.delete(l);
  else inflightByLane.set(l, next);
}

/**
 * Record seconds of transcribed audio for a speech-to-text request. Content-blind: the only
 * label is the canonical model (null/empty → "none"). The transcript text is NEVER passed here.
 */
export function recordAudioSeconds(model: string | null | undefined, seconds: number): void {
  if (!Number.isFinite(seconds) || seconds <= 0) return;
  incCounter(audioSecondsTotal, labelKey({ model: modelLabel(model) }), seconds);
}

/**
 * Record images generated for a text→image request. Content-blind: the only label is the canonical
 * model (null/empty → "none"). The PROMPT and the image bytes are NEVER passed here.
 */
export function recordImagesGenerated(model: string | null | undefined, count: number): void {
  if (!Number.isFinite(count) || count <= 0) return;
  incCounter(imagesTotal, labelKey({ model: modelLabel(model) }), count);
}

/**
 * Record a recurrent-model poison-clear unload (the abrupt-disconnect resilience fix). The only
 * labels are the canonical model id and the unload outcome ("ok" | "failed") — content-blind. A
 * rising failed-count means the box could not self-heal a dirty recurrent model and may need a
 * manual restart.
 */
export function recordPoisonClear(model: string | null | undefined, outcome: "ok" | "failed"): void {
  incCounter(poisonClearTotal, labelKey({ model: modelLabel(model), outcome: sanitizeLabel(outcome) }));
}

/**
 * Record that the streaming degeneracy watchdog flagged a degenerate single-token run for `model`
 * (the silent, no-disconnect "?????" case) and forced a poison-clear. The unload's own ok/failed
 * result is still accounted via recordPoisonClear; this counts how often the SILENT path fired.
 */
export function recordDegeneracyDetected(model: string | null | undefined): void {
  incCounter(degeneracyDetectedTotal, labelKey({ model: modelLabel(model) }));
}

/** Record a terminal code_loop run by status (#116). Content-blind: status label only. */
export function recordCodeLoopRun(status: string): void {
  codeLoopTouched = true;
  incCounter(codeLoopRunsTotal, labelKey({ status: sanitizeLabel(status) }));
}

/** Count an other-model request admitted while a code_loop run held the GPU lease (swap-thrash meter). */
export function recordCodeLoopInterleaved(): void {
  codeLoopTouched = true;
  incCounter(codeLoopInterleavedTotal, labelKey({}));
}

/** Count a request the caged pi tried to send to a non-allowlisted gateway path (relay 403). */
export function recordCodeLoopRelayDenied(): void {
  codeLoopTouched = true;
  incCounter(codeLoopRelayDeniedTotal, labelKey({}));
}

/** Set the code_loop active gauge (0|1). */
export function setCodeLoopActive(active: boolean): void {
  codeLoopTouched = true;
  codeLoopActive = active ? 1 : 0;
}

/** Read the code_loop active gauge (for the interleave hook in the gateway spine). */
export function isCodeLoopActive(): boolean {
  return codeLoopActive === 1;
}

/**
 * Record an admission rejection (503 busy). lane should reflect the tier of the
 * rejected principal (e.g. "guest") or a lane label from the admission controller.
 */
export function recordAdmissionRejection(lane: string): void {
  incCounter(admissionRejectionsTotal, labelKey({ lane: sanitizeLabel(lane) }));
}

/**
 * Record a rate-limit rejection (429). surface identifies which guard fired:
 *   "quota"  — per-key RPM/TPM/daily quota exceeded
 *   "redeem" — per-IP public-surface (redeem / portal) throttle
 */
export function recordRateLimited(surface: string): void {
  incCounter(rateLimitedTotal, labelKey({ surface: sanitizeLabel(surface) }));
}

// ─── Text exposition ──────────────────────────────────────────────────────────

/** Emit a single counter metric family in Prometheus 0.0.4 text format. */
function renderCounter(name: string, help: string, map: LabelMap): string {
  if (map.size === 0) return "";
  const lines: string[] = [`# HELP ${name} ${help}`, `# TYPE ${name} counter`];
  for (const [key, value] of map) {
    const labels = JSON.parse(key) as Record<string, string>;
    const labelStr = Object.entries(labels)
      .map(([k, v]) => `${k}="${v}"`)
      .join(",");
    lines.push(`${name}{${labelStr}} ${value}`);
  }
  return lines.join("\n") + "\n";
}

/** Emit a model-labelled histogram family in Prometheus 0.0.4 text format. */
function renderHistogram(name: string, help: string, hist: HistogramState, bucketLes: number[]): string {
  if (hist.count.size === 0) return "";

  const lines: string[] = [`# HELP ${name} ${help}`, `# TYPE ${name} histogram`];

  for (const model of hist.count.keys()) {
    const sanitizedModel = sanitizeLabel(model);
    const buckets = hist.buckets.get(model) ?? new Map<number, number>();
    const total = hist.count.get(model) ?? 0;
    const sum = hist.sum.get(model) ?? 0;

    // Emit ordered le buckets, then +Inf (= total count), then _sum and _count.
    for (const le of bucketLes) {
      const count = buckets.get(le) ?? 0;
      lines.push(`${name}_bucket{model="${sanitizedModel}",le="${le}"} ${count}`);
    }
    // +Inf bucket == total count
    lines.push(`${name}_bucket{model="${sanitizedModel}",le="+Inf"} ${total}`);
    lines.push(`${name}_sum{model="${sanitizedModel}"} ${sum}`);
    lines.push(`${name}_count{model="${sanitizedModel}"} ${total}`);
  }

  return lines.join("\n") + "\n";
}

/** Emit the in-flight gauge family (total + per-lane). Always emitted so 0 is observable. */
function renderInflightGauge(): string {
  if (!inflightTouched) return "";
  const lines: string[] = [
    "# HELP homeserver_inflight_requests Current in-flight inference requests (admission acquire − release)",
    "# TYPE homeserver_inflight_requests gauge",
    `homeserver_inflight_requests ${inflightTotal}`,
  ];
  if (inflightByLane.size > 0) {
    lines.push(
      "# HELP homeserver_inflight_by_lane Current in-flight inference requests by lane",
      "# TYPE homeserver_inflight_by_lane gauge"
    );
    for (const [lane, n] of inflightByLane) {
      lines.push(`homeserver_inflight_by_lane{lane="${lane}"} ${n}`);
    }
  }
  return lines.join("\n") + "\n";
}

/**
 * Render all metrics as a valid Prometheus 0.0.4 text exposition string.
 * Suitable for writing directly as the body of a GET /metrics response with
 * Content-Type: text/plain; version=0.0.4; charset=utf-8
 */
export function renderMetrics(): string {
  const parts: string[] = [
    renderCounter(
      "homeserver_requests_total",
      "Total gateway requests by model, outcome, and tier",
      requestsTotal
    ),
    renderCounter(
      "homeserver_tokens_total",
      "Total tokens processed by model and direction (prompt|completion)",
      tokensTotal
    ),
    renderCounter(
      "homeserver_node_requests_total",
      "Total gateway requests by actual compute node, model, outcome, and tier",
      nodeRequestsTotal
    ),
    renderCounter(
      "homeserver_node_tokens_total",
      "Total tokens by actual compute node, model, and direction (prompt|completion)",
      nodeTokensTotal
    ),
    renderCounter(
      "homeserver_credits_consumed_total",
      "Lifetime credits consumed by tier",
      creditsTotal
    ),
    renderCounter(
      "homeserver_admission_rejections_total",
      "Total admission rejections (503) by lane",
      admissionRejectionsTotal
    ),
    renderCounter(
      "homeserver_rate_limited_total",
      "Total rate-limit rejections (429) by surface",
      rateLimitedTotal
    ),
    renderCounter(
      "homeserver_audio_seconds_total",
      "Total seconds of audio transcribed (speech-to-text) by model",
      audioSecondsTotal
    ),
    renderCounter(
      "homeserver_images_total",
      "Total images generated (text-to-image) by model",
      imagesTotal
    ),
    renderCounter(
      "homeserver_poison_clear_total",
      "Recurrent-model poison-clear unload outcomes from any trigger (abrupt disconnect or degeneracy watchdog), by model and outcome",
      poisonClearTotal
    ),
    renderCounter(
      "homeserver_degeneracy_detected_total",
      "Degenerate single-token runs flagged by the watchdog (silent backstop: streaming, non-streaming, or trailing-frame), by model",
      degeneracyDetectedTotal
    ),
    renderCounter(
      "homeserver_code_loop_runs_total",
      "Terminal code_loop (agentic coding) runs by status",
      codeLoopRunsTotal
    ),
    renderCounter(
      "homeserver_code_loop_interleaved_total",
      "Other-model requests admitted while a code_loop run held the GPU lease (swap-thrash meter)",
      codeLoopInterleavedTotal
    ),
    renderCounter(
      "homeserver_code_loop_relay_denied_total",
      "Requests the caged pi tried to send to a non-allowlisted gateway path (relay 403, not forwarded)",
      codeLoopRelayDeniedTotal
    ),
    codeLoopTouched
      ? `# HELP homeserver_code_loop_active Whether a code_loop run is currently in flight (0|1)\n# TYPE homeserver_code_loop_active gauge\nhomeserver_code_loop_active ${codeLoopActive}`
      : "",
    renderHistogram(
      "homeserver_request_duration_seconds",
      "Gateway request duration in seconds",
      durationHistogram,
      DURATION_BUCKETS
    ),
    renderHistogram(
      "homeserver_ttft_seconds",
      "Time to first token in seconds (streaming requests)",
      ttftHistogram,
      TTFT_BUCKETS
    ),
    renderInflightGauge(),
  ];
  return parts.filter(Boolean).join("\n");
}

/**
 * Reset all metric state. FOR TESTS ONLY — never call in production.
 * Vitest isolates modules per file but not within a file, so each test suite
 * should call resetMetrics() in beforeEach to start from a clean slate.
 */
export function resetMetrics(): void {
  requestsTotal.clear();
  tokensTotal.clear();
  nodeRequestsTotal.clear();
  nodeTokensTotal.clear();
  creditsTotal.clear();
  admissionRejectionsTotal.clear();
  rateLimitedTotal.clear();
  audioSecondsTotal.clear();
  imagesTotal.clear();
  poisonClearTotal.clear();
  degeneracyDetectedTotal.clear();
  codeLoopRunsTotal.clear();
  codeLoopInterleavedTotal.clear();
  codeLoopRelayDeniedTotal.clear();
  codeLoopActive = 0;
  codeLoopTouched = false;
  durationHistogram.buckets.clear();
  durationHistogram.sum.clear();
  durationHistogram.count.clear();
  ttftHistogram.buckets.clear();
  ttftHistogram.sum.clear();
  ttftHistogram.count.clear();
  inflightTotal = 0;
  inflightByLane.clear();
  inflightTouched = false;
}
