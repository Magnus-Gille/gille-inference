/**
 * Content-free context-overflow contract probe (INFER-510).
 *
 * Regression guard for the INFER-501 / INFER-509 defect class: a request over a model's effective
 * context must surface as a closed `400 context_length_exceeded` with zero charge, never as an
 * opaque 5xx. For each target the probe sends one request just under and one just over the
 * limit, reading the caller's own credit counter (`GET /portal/me`) around each call.
 *
 * The probe CONSUMES certified effective limits (INFER-125) from its caller; it never defines or
 * measures them. All traffic goes through the injected `fetch`, so tests are hermetic. Request
 * and response bodies are never logged or returned: the report carries only statuses, a
 * validated machine error code, unit counts and integer charge deltas. Filler is synthetic.
 *
 * Running this against a live gateway is a separately approved operation (GPU lease, admission
 * and owner-preemption rules apply); see src/homeserver/README.md.
 */

export type ProbeEndpoint = "systemone" | "chat";

export type OverflowVerdictLabel =
  | "fixed_verified"
  | "fixed_unbracketed"
  | "fix_not_effective"
  | "inconclusive";

export interface OverflowTarget {
  model: string;
  endpoint: ProbeEndpoint;
  /** Certified effective input limit in tokens (INFER-125). Consumed, not defined here. */
  effectiveLimitTokens: number;
  /** Calibrated tokens per filler word for this model's tokenizer. Default 1. */
  tokensPerFillerUnit?: number;
  /** Fraction of the limit for the under call (0 < f < 1). Default 0.95. */
  underFraction?: number;
  /** Fraction of the limit for the over call (f > 1). Default 1.05. */
  overFraction?: number;
}

export interface CallObservation {
  /** HTTP status, or null when the outcome is unknown (network error, timeout, bound exceeded). */
  httpStatus: number | null;
  /** Machine error code, only when it matches a safe snake_case shape. */
  errorCode: string | null;
  fillerUnits: number;
  /** Integer credit delta across the call, or null when either balance read failed. */
  chargeDelta: number | null;
}

export interface OverflowTargetResult {
  model: string;
  endpoint: ProbeEndpoint;
  effectiveLimitTokens: number;
  label: OverflowVerdictLabel;
  under: CallObservation | null;
  over: CallObservation | null;
  reasons: string[];
}

export interface OverflowProbeReport {
  source: "overflow-contract-probe-v1";
  results: OverflowTargetResult[];
  /** True only when every target is fixed_verified. */
  allFixedVerified: boolean;
}

export interface OverflowProbeOptions {
  baseUrl: string;
  /** Bearer token. Held in memory only; never part of the report. */
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface Resolved {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  fetchImpl: typeof fetch;
}

const MAX_BODY_BYTES = 262_144;
const MAX_RESPONSE_BYTES = 1_048_576;
const SAFE_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const VOCABULARY = ["alpha", "bravo", "delta", "echo", "gamma", "kilo", "lima", "omega", "sigma", "theta"];
const PATHS: Record<ProbeEndpoint, string> = {
  systemone: "/v1/systemone",
  chat: "/v1/chat/completions",
};

/** Deterministic synthetic filler: common short words, no real text. */
export function syntheticFiller(units: number): string {
  if (!Number.isSafeInteger(units) || units < 1) throw new Error("units-invalid");
  const words = new Array<string>(units);
  for (let i = 0; i < units; i++) words[i] = VOCABULARY[i % VOCABULARY.length]!;
  return words.join(" ");
}

export function fillerUnitsFor(target: OverflowTarget): { under: number; over: number } {
  const limit = target.effectiveLimitTokens;
  const per = target.tokensPerFillerUnit ?? 1;
  const underFraction = target.underFraction ?? 0.95;
  const overFraction = target.overFraction ?? 1.05;
  if (!Number.isSafeInteger(limit) || limit < 16) throw new Error("effective-limit-invalid");
  if (!(per > 0) || !(underFraction > 0 && underFraction < 1) || !(overFraction > 1)) {
    throw new Error("target-fractions-invalid");
  }
  const under = Math.max(1, Math.floor((limit * underFraction) / per));
  const over = Math.max(under + 1, Math.ceil((limit * overFraction) / per));
  return { under, over };
}

export function buildProbeBody(target: OverflowTarget, units: number): string {
  const filler = syntheticFiller(units);
  const body = target.endpoint === "systemone"
    ? {
        model: target.model,
        state: filler,
        questions: { q: { type: "noul", instructions: "Is the state empty?" } },
      }
    : {
        model: target.model,
        messages: [{ role: "user", content: filler }],
        max_tokens: 1,
      };
  const raw = JSON.stringify(body);
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) throw new Error("probe-body-exceeds-transport-cap");
  return raw;
}

async function readBounded(response: Response): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        return null;
      }
      parts.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(parts).toString("utf8");
}

function extractErrorCode(text: string | null): string | null {
  if (!text) return null;
  try {
    const code = (JSON.parse(text) as { error?: { code?: unknown } })?.error?.code;
    return typeof code === "string" && SAFE_CODE.test(code) ? code : null;
  } catch {
    return null;
  }
}

/** Integer lifetime credits used (includes reservations), or null when unavailable. */
async function readCreditsUsed(opts: Resolved): Promise<number | null> {
  try {
    const response = await opts.fetchImpl(new URL("/portal/me", opts.baseUrl), {
      method: "GET",
      redirect: "error",
      headers: { authorization: `Bearer ${opts.apiKey}` },
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
    const text = await readBounded(response);
    if (response.status !== 200 || text === null) return null;
    const used = (JSON.parse(text) as { creditsUsed?: unknown }).creditsUsed;
    return typeof used === "number" && Number.isSafeInteger(used) && used >= 0 ? used : null;
  } catch {
    return null;
  }
}

async function observe(target: OverflowTarget, units: number, opts: Resolved): Promise<CallObservation> {
  const body = buildProbeBody(target, units);
  const before = await readCreditsUsed(opts);
  let httpStatus: number | null = null;
  let errorCode: string | null = null;
  try {
    const response = await opts.fetchImpl(new URL(PATHS[target.endpoint], opts.baseUrl), {
      method: "POST",
      redirect: "error",
      headers: { authorization: `Bearer ${opts.apiKey}`, "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
    const text = await readBounded(response);
    httpStatus = text === null ? null : response.status;
    errorCode = httpStatus !== null && httpStatus >= 400 ? extractErrorCode(text) : null;
  } catch {
    httpStatus = null;
  }
  const after = await readCreditsUsed(opts);
  const chargeDelta = before === null || after === null ? null : after - before;
  return { httpStatus, errorCode, fillerUnits: units, chargeDelta };
}

/** Pure verdict over the two observations. Labels follow the INFER-509 c2 contract. */
export function classifyOverflow(
  under: CallObservation | null,
  over: CallObservation | null,
): { label: OverflowVerdictLabel; reasons: string[] } {
  const reasons: string[] = [];
  const bracketed = under?.httpStatus === 200;
  if (!under || under.httpStatus === null) reasons.push("under_call_outcome_unknown");
  else if (under.httpStatus !== 200) reasons.push("under_call_not_200");
  if (!over || over.httpStatus === null) {
    return { label: "inconclusive", reasons: [...reasons, "over_call_outcome_unknown"] };
  }

  const closed = over.httpStatus === 400 && over.errorCode === "context_length_exceeded";
  if (closed && over.chargeDelta === 0) {
    return { label: bracketed ? "fixed_verified" : "fixed_unbracketed", reasons };
  }
  if (closed) {
    reasons.push(over.chargeDelta === null ? "charge_evidence_missing" : "over_call_charged");
    return { label: "inconclusive", reasons };
  }
  // Not the closed shape: a 5xx, or an opaque / mismatched client error. Blame the fix only
  // with a healthy under call and proven zero charge, so a sick backend is not misread.
  const opaque = over.httpStatus >= 400;
  if (opaque && bracketed && over.chargeDelta === 0) {
    reasons.push(over.httpStatus >= 500 ? "over_call_5xx" : "over_call_opaque_4xx");
    return { label: "fix_not_effective", reasons };
  }
  reasons.push(opaque ? "over_call_unclassified" : "over_call_accepted");
  if (over.chargeDelta !== 0) reasons.push(over.chargeDelta === null ? "charge_evidence_missing" : "over_call_charged");
  return { label: "inconclusive", reasons };
}

/** Run the probe for each target sequentially (the serial GPU is a shared resource). */
export async function runOverflowProbe(
  targets: readonly OverflowTarget[],
  options: OverflowProbeOptions,
): Promise<OverflowProbeReport> {
  const opts: Resolved = {
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    timeoutMs: options.timeoutMs ?? 60_000,
    fetchImpl: options.fetchImpl ?? fetch,
  };
  const results: OverflowTargetResult[] = [];
  for (const target of targets) {
    const units = fillerUnitsFor(target);
    const under = await observe(target, units.under, opts);
    const over = await observe(target, units.over, opts);
    const { label, reasons } = classifyOverflow(under, over);
    results.push({
      model: target.model,
      endpoint: target.endpoint,
      effectiveLimitTokens: target.effectiveLimitTokens,
      label,
      under,
      over,
      reasons,
    });
  }
  return {
    source: "overflow-contract-probe-v1",
    results,
    allFixedVerified: results.length > 0 && results.every(r => r.label === "fixed_verified"),
  };
}

/** Validate an operator-supplied target list (JSON array). Throws on any malformed entry. */
export function parseOverflowTargets(value: unknown): OverflowTarget[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) throw new Error("targets-invalid");
  return value.map((raw): OverflowTarget => {
    if (typeof raw !== "object" || raw === null) throw new Error("target-invalid");
    const r = raw as Record<string, unknown>;
    const allowed = ["model", "endpoint", "effectiveLimitTokens", "tokensPerFillerUnit", "underFraction", "overFraction"];
    if (Object.keys(r).some(k => !allowed.includes(k))) throw new Error("target-field-unsupported");
    if (typeof r["model"] !== "string" || !/^[A-Za-z0-9._:/-]{1,128}$/.test(r["model"])) throw new Error("target-model-invalid");
    if (r["endpoint"] !== "systemone" && r["endpoint"] !== "chat") throw new Error("target-endpoint-invalid");
    const target: OverflowTarget = {
      model: r["model"],
      endpoint: r["endpoint"],
      effectiveLimitTokens: r["effectiveLimitTokens"] as number,
    };
    for (const key of ["tokensPerFillerUnit", "underFraction", "overFraction"] as const) {
      if (r[key] !== undefined) {
        if (typeof r[key] !== "number") throw new Error("target-fractions-invalid");
        target[key] = r[key] as number;
      }
    }
    buildProbeBody(target, fillerUnitsFor(target).over); // validates numbers and the transport cap
    return target;
  });
}

/** Offline plan: what a live run would send, with no network access and no bodies. */
export function planOverflowProbe(targets: readonly OverflowTarget[]) {
  return targets.map(t => ({
    model: t.model,
    endpoint: t.endpoint,
    effectiveLimitTokens: t.effectiveLimitTokens,
    fillerUnits: fillerUnitsFor(t),
    inferenceCalls: 2,
    balanceReads: 4,
  }));
}
