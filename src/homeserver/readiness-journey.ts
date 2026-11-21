/**
 * readiness-journey.ts — producer-owned `gateway-model-readiness` synthetic journey (INFER-250).
 *
 * Runs ONE content-free readiness attempt against the gateway with a read-only monitor key and
 * reports the closed `synthetic-journey-outcome` v1 document to Heimdall's
 * `POST /api/synthetic-journeys` (contract owned by heimdall/src/synthetic-journeys.js, HEIM-49).
 *
 * Steps (exactly the two declared ones, bound to one attempt):
 *   - `gateway-readiness`: GET /healthz (public; sent without the key) answers 200 `{ok:true}`.
 *   - `model-readiness`:   GET /models/residency answers 200 with a `models` array, i.e. the
 *                          inference backend's running snapshot is observable. A 503
 *                          `{status:"unavailable"}` is a dependency failure. An idle backend (empty
 *                          `models`) is still ready: this proves the backend can be observed, not
 *                          that any particular model is loaded, and never grades model quality.
 *
 * Content-free by construction: only HTTP status and two booleans are read from responses. No
 * prompt, model name, alias, key, response body or trace is ever copied into the outcome. The
 * outcome object is built from closed enums and validated by a local mirror of Heimdall's
 * contract before any network send, so a producer bug fails as `runner-failed` instead of
 * posting a malformed document.
 *
 * Runner failure (missing config, validation bug) is kept distinct from dependency failure
 * (gateway/model not ready). Missing or partial evidence never passes.
 */
import { randomBytes } from "node:crypto";

export const JOURNEY_ID = "gateway-model-readiness";
export const PRODUCER = "gille-inference";
export const STEP_IDS = ["gateway-readiness", "model-readiness"] as const;
export const MAX_AGE_SECONDS = 900;
const MAX_LATENCY_MS = 10 * 60 * 1000;
const MAX_BODY_BYTES = 64 * 1024;

export type StepOutcome = "pass" | "fail" | "skipped";
export interface JourneyStep {
  id: (typeof STEP_IDS)[number];
  outcome: StepOutcome;
  latency_ms: number | null;
  error_class: string | null;
}
export interface JourneyOutcome {
  kind: "synthetic-journey-outcome";
  schema_version: "v1";
  journey_id: typeof JOURNEY_ID;
  producer: typeof PRODUCER;
  attempt_id: string;
  version: string;
  started_at: string;
  observed_at: string;
  max_age_seconds: number;
  outcome: "pass" | "fail" | "partial" | "unknown";
  runner_outcome: "ok" | "failed";
  latency_ms: number | null;
  error_class: string | null;
  trace_id: string | null;
  steps: JourneyStep[];
  extensions: [];
}

const SAFE_TEXT_RE = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,95}$/;
const ERROR_RE = /^[a-z][a-z0-9-]{1,63}$/;
const UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

const validLatency = (v: unknown): boolean =>
  v === null || (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= MAX_LATENCY_MS);

/** Local mirror of heimdall validateJourneyOutcome for this journey. Returns error codes. */
export function validateOutcome(value: JourneyOutcome): string[] {
  const errors: string[] = [];
  if (value.kind !== "synthetic-journey-outcome") errors.push("kind");
  if (value.schema_version !== "v1") errors.push("version");
  if (value.journey_id !== JOURNEY_ID) errors.push("journey-id");
  if (value.producer !== PRODUCER) errors.push("producer");
  if (!SAFE_TEXT_RE.test(value.attempt_id)) errors.push("attempt");
  if (!SAFE_TEXT_RE.test(value.version)) errors.push("producer-version");
  const started = UTC_RE.test(value.started_at) ? Date.parse(value.started_at) : NaN;
  const observed = UTC_RE.test(value.observed_at) ? Date.parse(value.observed_at) : NaN;
  if (!Number.isFinite(started) || !Number.isFinite(observed) || started > observed) errors.push("timestamps");
  if (!Number.isSafeInteger(value.max_age_seconds) || value.max_age_seconds < 1 || value.max_age_seconds > 86400) errors.push("max-age");
  if (!validLatency(value.latency_ms)) errors.push("latency");
  if (value.error_class !== null && !ERROR_RE.test(value.error_class)) errors.push("error-class");
  if (value.trace_id !== null && !/^[a-f0-9]{32}$/.test(value.trace_id)) errors.push("trace-id");
  if (value.extensions.length !== 0) errors.push("extensions");
  const seen = new Set<string>();
  for (const step of value.steps) {
    if (!(STEP_IDS as readonly string[]).includes(step.id) || seen.has(step.id)) errors.push("step-id");
    seen.add(step.id);
    if (!validLatency(step.latency_ms)) errors.push("step-latency");
    if (step.error_class !== null && !ERROR_RE.test(step.error_class)) errors.push("step-error-class");
    if (step.outcome === "pass" && (step.error_class !== null || step.latency_ms === null)) errors.push("step-pass-shape");
  }
  const complete = STEP_IDS.every((id) => seen.has(id)) && seen.size === STEP_IDS.length;
  const allPass = complete && value.steps.every((s) => s.outcome === "pass");
  const anyFail = value.steps.some((s) => s.outcome === "fail");
  if (value.outcome === "pass" && (value.runner_outcome !== "ok" || !allPass || value.error_class !== null)) errors.push("pass-consistency");
  if (value.outcome === "fail" && (value.runner_outcome !== "ok" || !complete || !anyFail || value.error_class === null)) errors.push("fail-consistency");
  if (value.outcome === "partial" && (value.runner_outcome !== "ok" || complete)) errors.push("partial-consistency");
  if (value.runner_outcome === "failed" && (value.outcome !== "unknown" || value.error_class === null)) errors.push("runner-consistency");
  return errors;
}

export interface ReadinessOptions {
  /** Gateway origin: https, or plain http only to loopback (e.g. http://127.0.0.1:8080). */
  gatewayUrl: string | undefined;
  /** Read-only monitor-scope key (never logged, never in the outcome). */
  monitorKey: string | undefined;
  version?: string;
  timeoutMs?: number;
  /** Injectable clock (ms) and fetch for tests. */
  now?: () => number;
  fetchFn?: typeof fetch;
  /** Fixed attempt id, so a retried delivery re-sends the identical document. */
  attemptId?: string;
}

const iso = (ms: number): string => new Date(ms).toISOString();
const newAttemptId = (): string => `attempt-${randomBytes(12).toString("hex")}`;
const step = (id: JourneyStep["id"], outcome: StepOutcome, latency: number | null, error: string | null = null): JourneyStep =>
  ({ id, outcome, latency_ms: latency, error_class: error });

function classifyError(err: unknown): string {
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) return "timeout";
  if (err instanceof Error && err.name === "ResponseTooLarge") return "invalid-response";
  return "dependency-network";
}

function tooLarge(): Error {
  const e = new Error("too large");
  e.name = "ResponseTooLarge";
  return e;
}

/**
 * Read at most MAX_BODY_BYTES of the body, then parse it as JSON (null when unparseable). A
 * declared or streamed length over the bound cancels the body instead of buffering it, so a
 * hostile or broken upstream cannot make the runner hold more than the bound in memory.
 */
export async function boundedJson(res: Response, maxBytes = MAX_BODY_BYTES): Promise<unknown> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  if (!res.body) return null;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  const text = Buffer.concat(chunks, total).toString("utf8");
  try { return JSON.parse(text); } catch { return null; }
}

interface Observation { ok: boolean; errorClass: string | null; latencyMs: number }

async function observe(
  url: string,
  key: string | null,
  fetchFn: typeof fetch,
  timeoutMs: number,
  now: () => number,
  accept: (status: number, body: unknown) => string | null,
): Promise<Observation> {
  const t0 = now();
  try {
    const res = await fetchFn(url, {
      method: "GET",
      redirect: "error",
      headers: key === null ? { Accept: "application/json" } : { Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const latencyMs = Math.min(MAX_LATENCY_MS, Math.max(0, Math.round(now() - t0)));
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel().catch(() => undefined);
      return { ok: false, errorClass: "auth-denied", latencyMs };
    }
    const body = await boundedJson(res);
    const err = accept(res.status, body);
    return { ok: err === null, errorClass: err, latencyMs };
  } catch (err) {
    return { ok: false, errorClass: classifyError(err), latencyMs: Math.min(MAX_LATENCY_MS, Math.max(0, Math.round(now() - t0))) };
  }
}

const acceptHealthz = (status: number, body: unknown): string | null => {
  if (status !== 200) return "dependency-http";
  return (body as { ok?: unknown } | null)?.ok === true ? null : "invalid-response";
};
const acceptResidency = (status: number, body: unknown): string | null => {
  const b = body as { status?: unknown; models?: unknown } | null;
  if (status === 503 || b?.status === "unavailable") return "backend-unavailable";
  if (status !== 200) return "dependency-http";
  return Array.isArray(b?.models) ? null : "invalid-response";
};

/** Run one attempt. Never throws; configuration/validation problems become runner failures. */
export async function runReadinessAttempt(opts: ReadinessOptions): Promise<JourneyOutcome> {
  const now = opts.now ?? Date.now;
  const startMs = now();
  const base = {
    kind: "synthetic-journey-outcome" as const,
    schema_version: "v1" as const,
    journey_id: JOURNEY_ID as typeof JOURNEY_ID,
    producer: PRODUCER as typeof PRODUCER,
    attempt_id: opts.attemptId ?? newAttemptId(),
    version: opts.version ?? "gille-inference@0.0.0",
    started_at: iso(startMs),
    max_age_seconds: MAX_AGE_SECONDS,
    trace_id: null,
    extensions: [] as [],
  };
  const runnerFailure = (errorClass: string): JourneyOutcome => ({
    ...base,
    observed_at: iso(Math.max(startMs, now())),
    outcome: "unknown",
    runner_outcome: "failed",
    latency_ms: 0,
    error_class: errorClass,
    steps: STEP_IDS.map((id) => step(id, "skipped", null, "runner-unavailable")),
  });

  const origin = safeGatewayOrigin(opts.gatewayUrl);
  if (origin === null) return runnerFailure("runner-config");
  if (!opts.monitorKey) return runnerFailure("runner-config");

  const fetchFn = opts.fetchFn ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 5000;
  // GET /healthz is a public liveness route, so the monitor key is not sent there. The key is
  // presented only to /models/residency, where the gateway checks it. A 401/403 on either route
  // (for /healthz that would be an authenticating proxy in front of the gateway) means the runner
  // cannot authenticate: a runner failure, not a gateway or model failure.
  const gateway = await observe(`${origin}/healthz`, null, fetchFn, timeoutMs, now, acceptHealthz);
  const steps: JourneyStep[] = [];
  let errorClass: string | null = null;
  if (gateway.errorClass === "auth-denied") return runnerFailure("runner-auth");
  if (gateway.ok) {
    steps.push(step("gateway-readiness", "pass", gateway.latencyMs));
    const model = await observe(`${origin}/models/residency`, opts.monitorKey, fetchFn, timeoutMs, now, acceptResidency);
    if (model.errorClass === "auth-denied") return runnerFailure("runner-auth");
    if (model.ok) steps.push(step("model-readiness", "pass", model.latencyMs));
    else {
      steps.push(step("model-readiness", "fail", model.latencyMs, model.errorClass));
      errorClass = model.errorClass;
    }
  } else {
    steps.push(step("gateway-readiness", "fail", gateway.latencyMs, gateway.errorClass));
    steps.push(step("model-readiness", "skipped", null, "blocked-by-gateway"));
    errorClass = gateway.errorClass;
  }
  const endMs = Math.max(startMs, now());
  const outcome: JourneyOutcome = {
    ...base,
    observed_at: iso(endMs),
    outcome: errorClass === null ? "pass" : "fail",
    runner_outcome: "ok",
    latency_ms: Math.min(MAX_LATENCY_MS, Math.round(endMs - startMs)),
    error_class: errorClass,
    steps,
  };
  // A local contract violation is a producer bug, never a green result.
  if (validateOutcome(outcome).length > 0) return runnerFailure("runner-invalid-outcome");
  return outcome;
}

export interface DeliveryOptions {
  /** Full Heimdall URL, e.g. https://heimdall.example/api/synthetic-journeys. */
  url: string | undefined;
  token: string | undefined;
  timeoutMs?: number;
  /** Delays between attempts; the identical document (same attempt_id) is re-sent. */
  retryDelaysMs?: number[];
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}
export interface DeliveryResult {
  delivered: boolean;
  attempts: number;
  status?: number;
  /** Failure class only — never the token, payload or response body. */
  error?: string;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Shared transport rule for every URL that carries a credential: https, or plain http only to a
 * loopback host, and never userinfo in the URL. A misconfigured plain-http remote host would
 * otherwise send the bearer key in cleartext.
 */
function credentialSafeUrl(u: URL): boolean {
  const transportOk = u.protocol === "https:" || (u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname));
  return transportOk && u.username === "" && u.password === "";
}

/** Gateway origin for the monitor key, or null when the URL is unusable or unsafe. */
export function safeGatewayOrigin(raw: string | undefined): string | null {
  try {
    const u = new URL(raw ?? "");
    return credentialSafeUrl(u) ? u.origin : null;
  } catch {
    return null;
  }
}

/** https only (plain http solely for loopback), exact ingest path, no userinfo/query/fragment. */
function safeDeliveryUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return credentialSafeUrl(u) && u.pathname === "/api/synthetic-journeys" && u.search === "" && u.hash === "";
  } catch {
    return false;
  }
}

/** POST the outcome; retry only transport errors and 5xx. 4xx (including replay conflicts) are final. */
export async function deliverOutcome(outcome: JourneyOutcome, opts: DeliveryOptions): Promise<DeliveryResult> {
  if (!opts.url || !opts.token) return { delivered: false, attempts: 0, error: "delivery-config" };
  if (!safeDeliveryUrl(opts.url)) return { delivered: false, attempts: 0, error: "delivery-config" };
  const errors = validateOutcome(outcome);
  if (errors.length > 0) return { delivered: false, attempts: 0, error: "invalid-outcome" };
  const fetchFn = opts.fetchFn ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const delays = opts.retryDelaysMs ?? [0, 1000, 4000];
  const body = JSON.stringify(outcome);
  let last: DeliveryResult = { delivered: false, attempts: 0, error: "delivery-transport" };
  for (let i = 0; i < delays.length; i += 1) {
    if (delays[i]! > 0) await sleep(delays[i]!);
    try {
      const res = await fetchFn(opts.url, {
        method: "POST",
        redirect: "error",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.token}` },
        body,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
      });
      await res.body?.cancel().catch(() => undefined);
      last = { delivered: res.ok, attempts: i + 1, status: res.status, ...(res.ok ? {} : { error: res.status >= 500 ? "delivery-server-error" : "delivery-rejected" }) };
      if (res.ok || res.status < 500) return last;
    } catch {
      last = { delivered: false, attempts: i + 1, error: "delivery-transport" };
    }
  }
  return last;
}
