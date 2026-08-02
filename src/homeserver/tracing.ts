import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { contentDigest } from "./evidence-identity.js";

export interface HomeserverTracingConfig {
  instrumentation: "on" | "off";
  export: "on" | "off";
  samplingRatePerMille: number;
  exportUrl: string;
  exportTimeoutMs: number;
  release: string;
  instanceId: string;
}

export interface TraceDefaults {
  taskType?: string;
  lane?: string;
  retryOrdinal?: number;
  modelArtifactIdentity?: string;
  errorClass?: string;
  taskContractId?: string;
  taskContractTimestamp?: string;
}

export interface TraceSpanRecord {
  kind: "trace-span";
  contract_id: "gille.content-blind-tracing/v1";
  service: "gille-inference";
  instance_id: string;
  release: string;
  trace_id: string;
  span_id: string;
  parent_span_id?: string;
  surface: "gateway" | "model";
  phase: TracePhase;
  started_at: string;
  ended_at: string;
  collected_at: string;
  duration_ms: number;
  sampled: boolean;
  outcome: string;
  diagnostic_ref: string;
  task_type?: string;
  lane?: string;
  retry_ordinal?: number;
  model_artifact_identity?: string;
  error_class?: string;
  task_contract_id?: string;
  task_contract_timestamp?: string;
}

export interface ServiceObservationRecord {
  kind: "service-observation";
  contract_id: "gille.content-blind-readiness/v1";
  service: "gille-inference";
  instance_id: string;
  release: string;
  slot_id: "gateway-ready" | "model-ready";
  check: { surface: "readiness" };
  outcome: string;
  observed_at: string;
  collected_at: string;
  freshness_window: "PT5M";
  diagnostic_ref: string;
  trace?: { trace_id: string; span_id: string };
  task_type?: string;
  lane?: string;
  retry_ordinal?: number;
  model_artifact_identity?: string;
  error_class?: string;
}

export type TracingRecord = TraceSpanRecord | ServiceObservationRecord;
export type TracePhase =
  | "gateway"
  | "queue"
  | "admission"
  | "model_load"
  | "ttft"
  | "inference"
  | "verification"
  | "response";

interface TraceParseResult {
  traceId: string;
  parentSpanId: string;
  sampled: boolean;
  version: string;
}

interface TraceSession {
  readonly config: HomeserverTracingConfig;
  readonly traceId: string;
  readonly sampled: boolean;
  readonly rootSpanId: string;
  readonly tracestate?: string;
  readonly responseTraceparent: string;
  defaults: TraceDefaults;
  finished: boolean;
  records: TracingRecord[];
}

interface ActiveSpan {
  readonly session: TraceSession;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly phase: TracePhase;
  readonly surface: "gateway" | "model";
  readonly startedAtMs: number;
  attrs: TraceDefaults;
}

interface TraceContext {
  readonly session: TraceSession;
  readonly span: ActiveSpan;
}

export interface TraceSpanFinish {
  outcome?: string;
  errorClass?: string;
  endedAtMs?: number;
}

export interface GatewayTraceHandle {
  readonly enabled: boolean;
  readonly responseTraceparent?: string;
  readonly responseTracestate?: string;
  run<T>(fn: () => Promise<T>): Promise<T>;
  setDefaults(partial: Partial<TraceDefaults>): void;
  finish(result?: TraceSpanFinish): void;
}

export interface TraceSpanHandle {
  readonly enabled: boolean;
  run<T>(fn: () => Promise<T>): Promise<T>;
  finish(result?: TraceSpanFinish): void;
}

interface SyntheticTraceOptions extends TraceDefaults {
  traceparent?: string;
  tracestate?: string;
  release?: string;
  instanceId?: string;
  exportEnabled?: boolean;
  instrumentationEnabled?: boolean;
  samplingRatePerMille?: number;
}

interface CompletedSpanOptions extends TraceDefaults {
  startedAtMs: number;
  endedAtMs: number;
  outcome: string;
  errorClass?: string;
  surface?: "gateway" | "model";
}

interface TracingTestHooks {
  now?: () => number;
  nextTraceId?: () => string;
  nextSpanId?: () => string;
  exporter?: (records: readonly TracingRecord[]) => Promise<void> | void;
  captureExports?: boolean;
  maxPendingExports?: number;
}

interface WithTraceSpanOptions<T> {
  surface?: "gateway" | "model";
  classifyResult?: (result: T) => TraceSpanFinish | undefined;
}

const TRACEPARENT_RE = /^([a-f0-9]{2})-([a-f0-9]{32})-([a-f0-9]{16})-([a-f0-9]{2})$/;
const TRACESTATE_KEY_RE = /^[a-z0-9][a-z0-9_*/-]*(?:@[a-z0-9][a-z0-9_*/-]{0,13})?$/;
const TRACEPARENT_VERSION = "00";
const TRACESTATE_MAX_LENGTH = 512;
const TRACESTATE_MAX_MEMBERS = 32;
const TRACESTATE_MAX_MEMBER_LENGTH = 256;
const DEFAULT_MAX_PENDING_EXPORTS = 128;
const TRACE_ID_MAX_LENGTH = 64;
const TRACE_ID_RE = /^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/;
const storage = new AsyncLocalStorage<TraceContext>();
let hooks: TracingTestHooks = {};
let pendingExports = new Set<Promise<void>>();
let capturedBatches: TracingRecord[][] = [];

function nowMs(): number {
  return hooks.now?.() ?? Date.now();
}

function nextTraceId(): string {
  return hooks.nextTraceId?.() ?? randomBytes(16).toString("hex");
}

function nextSpanId(): string {
  return hooks.nextSpanId?.() ?? randomBytes(8).toString("hex");
}

function isoAt(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Sanitize deployment identities before they become repeated trace fields. The accepted grammar
 * is a lowercase ASCII deployment token: 1–64 characters, alphanumeric at both ends, with only
 * interior lowercase letters, digits, dots, or hyphens. Invalid values are replaced wholesale by
 * the caller's safe default; they are never truncated into a partially exposed token.
 */
export function sanitizeTraceIdentity(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim() ?? "";
  return trimmed.length <= TRACE_ID_MAX_LENGTH && TRACE_ID_RE.test(trimmed) ? trimmed : fallback;
}

/**
 * Convert a caller-controlled model key into the shared fixed-length, one-way diagnostic identity.
 * This is a trace join key, not proof of a served artifact; an observed artifact can replace it at
 * the observation seam in the future.
 */
export function traceModelArtifactIdentity(modelKey: string): string {
  return contentDigest(`gille.trace.model-id.v1:${modelKey}`);
}

function safeToken(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  if (trimmed.includes("://") || trimmed.includes("?") || trimmed.includes("@") || trimmed.includes(" ")) {
    return undefined;
  }
  return trimmed.slice(0, 120);
}

function safeOutcome(value: string | undefined, fallback = "ok"): string {
  return safeToken(value) ?? fallback;
}

function isValidTracestateKey(value: string): boolean {
  return value.length <= TRACESTATE_MAX_MEMBER_LENGTH && TRACESTATE_KEY_RE.test(value);
}

function isValidTracestateValue(value: string): boolean {
  if (value === "" || value.length > TRACESTATE_MAX_MEMBER_LENGTH) return false;
  if (value !== value.trim()) return false;
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code > 0x7e || ch === "," || ch === "=") return false;
  }
  return true;
}

function sanitizeTracestate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > TRACESTATE_MAX_LENGTH) return undefined;
  const members = trimmed.split(",");
  if (members.length > TRACESTATE_MAX_MEMBERS) return undefined;
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const rawMember of members) {
    const member = rawMember.trim();
    if (member === "" || member.length > TRACESTATE_MAX_MEMBER_LENGTH) return undefined;
    const eq = member.indexOf("=");
    if (eq <= 0 || eq !== member.lastIndexOf("=")) return undefined;
    const key = member.slice(0, eq);
    const entryValue = member.slice(eq + 1);
    if (!isValidTracestateKey(key) || !isValidTracestateValue(entryValue) || seen.has(key)) {
      return undefined;
    }
    seen.add(key);
    normalized.push(`${key}=${entryValue}`);
  }
  return normalized.join(",");
}

function parseTraceparent(value: string | undefined): TraceParseResult | null {
  if (!value) return null;
  const match = TRACEPARENT_RE.exec(value.trim());
  if (!match) return null;
  const [, version, traceId, parentSpanId, flags] = match;
  if (version !== TRACEPARENT_VERSION) return null;
  if (/^0+$/.test(traceId) || /^0+$/.test(parentSpanId)) return null;
  return {
    version,
    traceId,
    parentSpanId,
    sampled: (parseInt(flags, 16) & 0x01) === 0x01,
  };
}

function formatTraceparent(traceId: string, spanId: string, sampled: boolean): string {
  return `${TRACEPARENT_VERSION}-${traceId}-${spanId}-${sampled ? "01" : "00"}`;
}

function shouldTrace(config: HomeserverTracingConfig, headers?: IncomingHttpHeaders | Record<string, string | undefined>): boolean {
  if (config.instrumentation === "on") return true;
  const traceparent = headers ? String(headers["traceparent"] ?? "") : "";
  return parseTraceparent(traceparent) !== null;
}

function shouldSample(config: HomeserverTracingConfig, inbound: TraceParseResult | null): boolean {
  if (config.export !== "on") return false;
  if (inbound) return inbound.sampled;
  const rate = Math.max(0, Math.min(1000, Math.floor(config.samplingRatePerMille)));
  if (rate <= 0) return false;
  if (rate >= 1000) return true;
  return (Math.floor(Math.random() * 1000)) < rate;
}

function defaultConfig(overrides: Partial<HomeserverTracingConfig> = {}): HomeserverTracingConfig {
  const config: HomeserverTracingConfig = {
    instrumentation: "off",
    export: "off",
    samplingRatePerMille: 0,
    exportUrl: "",
    exportTimeoutMs: 2_000,
    release: "dev",
    instanceId: "unknown",
    ...overrides,
  };
  return {
    ...config,
    release: sanitizeTraceIdentity(config.release, "dev"),
    instanceId: sanitizeTraceIdentity(config.instanceId, "unknown"),
  };
}

function currentContext(): TraceContext | undefined {
  return storage.getStore();
}

function buildSpanRecord(
  session: TraceSession,
  spanId: string,
  parentSpanId: string | undefined,
  phase: TracePhase,
  surface: "gateway" | "model",
  startedAtMs: number,
  endedAtMs: number,
  attrs: TraceDefaults,
  outcome: string,
): TraceSpanRecord {
  return {
    kind: "trace-span",
    contract_id: "gille.content-blind-tracing/v1",
    service: "gille-inference",
    instance_id: session.config.instanceId,
    release: session.config.release,
    trace_id: session.traceId,
    span_id: spanId,
    ...(parentSpanId ? { parent_span_id: parentSpanId } : {}),
    surface,
    phase,
    started_at: isoAt(startedAtMs),
    ended_at: isoAt(endedAtMs),
    collected_at: isoAt(endedAtMs),
    duration_ms: Math.max(0, endedAtMs - startedAtMs),
    sampled: session.sampled,
    outcome: safeOutcome(outcome),
    diagnostic_ref: `ref:${spanId}`,
    ...(safeToken(attrs.taskType) ? { task_type: safeToken(attrs.taskType) } : {}),
    ...(safeToken(attrs.lane) ? { lane: safeToken(attrs.lane) } : {}),
    ...(typeof attrs.retryOrdinal === "number" ? { retry_ordinal: attrs.retryOrdinal } : {}),
    ...(safeToken(attrs.modelArtifactIdentity) ? { model_artifact_identity: safeToken(attrs.modelArtifactIdentity) } : {}),
    ...(safeToken(attrs.errorClass) ? { error_class: safeToken(attrs.errorClass) } : {}),
    ...(safeToken(attrs.taskContractId) ? { task_contract_id: safeToken(attrs.taskContractId) } : {}),
    ...(safeToken(attrs.taskContractTimestamp) ? { task_contract_timestamp: safeToken(attrs.taskContractTimestamp) } : {}),
  };
}

function enqueueRecord(record: TracingRecord): void {
  const ctx = currentContext();
  if (!ctx) return;
  ctx.session.records.push(record);
}

function exportBatch(session: TraceSession): void {
  if (!session.sampled || session.records.length === 0) return;
  const batch = session.records.slice();
  if (hooks.captureExports === true) capturedBatches.push(batch);
  const maxPending = Math.max(0, hooks.maxPendingExports ?? DEFAULT_MAX_PENDING_EXPORTS);
  if (pendingExports.size >= maxPending) return;
  const exporter = hooks.exporter;
  const url = session.config.exportUrl;
  const work = (async () => {
    if (exporter) {
      await exporter(batch);
      return;
    }
    if (url === "") return;
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), session.config.exportTimeoutMs);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ records: batch }),
        signal: ctrl.signal,
      });
      // Fetch resolves after headers. Close the collector body before the pending slot is freed;
      // otherwise a collector that never finishes its body can hold an unbounded number of sockets
      // even while pendingExports remains under its cap.
      await response.body?.cancel();
    } finally {
      clearTimeout(timeout);
    }
  })().catch(() => {
    // Export is deliberately best-effort; failures never perturb request behaviour.
  });
  pendingExports.add(work);
  void work.finally(() => {
    pendingExports.delete(work);
  });
}

function createSession(
  headers: IncomingHttpHeaders | Record<string, string | undefined> | undefined,
  config: HomeserverTracingConfig,
  defaults: TraceDefaults,
): TraceSession | null {
  const safeConfig = {
    ...config,
    release: sanitizeTraceIdentity(config.release, "dev"),
    instanceId: sanitizeTraceIdentity(config.instanceId, "unknown"),
  };
  if (!shouldTrace(safeConfig, headers)) return null;
  const traceparent = headers ? String(headers["traceparent"] ?? "") : undefined;
  const inbound = parseTraceparent(traceparent);
  const sampled = shouldSample(safeConfig, inbound);
  const rootSpanId = nextSpanId();
  const traceId = inbound?.traceId ?? nextTraceId();
  return {
    config: safeConfig,
    traceId,
    sampled,
    rootSpanId,
    tracestate: inbound && headers ? sanitizeTracestate(String(headers["tracestate"] ?? "")) : undefined,
    responseTraceparent: formatTraceparent(traceId, rootSpanId, sampled),
    defaults: { ...defaults },
    finished: false,
    records: [],
  };
}

function noopHandle(): GatewayTraceHandle {
  return {
    enabled: false,
    async run<T>(fn: () => Promise<T>): Promise<T> {
      return fn();
    },
    setDefaults(): void {},
    finish(): void {},
  };
}

function noopSpanHandle(): TraceSpanHandle {
  return {
    enabled: false,
    async run<T>(fn: () => Promise<T>): Promise<T> {
      return fn();
    },
    finish(): void {},
  };
}

export function beginGatewayTrace(
  headers: IncomingHttpHeaders | Record<string, string | undefined>,
  config: HomeserverTracingConfig,
  defaults: TraceDefaults = {},
): GatewayTraceHandle {
  const session = createSession(headers, config, defaults);
  if (!session) return noopHandle();
  const startedAtMs = nowMs();
  const rootParent = parseTraceparent(String(headers["traceparent"] ?? ""))?.parentSpanId;
  return {
    enabled: true,
    responseTraceparent: session.responseTraceparent,
    responseTracestate: session.tracestate,
    async run<T>(fn: () => Promise<T>): Promise<T> {
      const rootSpan: ActiveSpan = {
        session,
        spanId: session.rootSpanId,
        parentSpanId: rootParent,
        phase: "gateway",
        surface: "gateway",
        startedAtMs,
        attrs: session.defaults,
      };
      return storage.run({ session, span: rootSpan }, fn);
    },
    setDefaults(partial: Partial<TraceDefaults>): void {
      session.defaults = { ...session.defaults, ...partial };
      const ctx = currentContext();
      if (ctx?.session === session && ctx.span.phase === "gateway") {
        ctx.span.attrs = { ...ctx.span.attrs, ...partial };
      }
    },
    finish(result = {}): void {
      if (session.finished) return;
      session.finished = true;
      const endedAtMs = result.endedAtMs ?? nowMs();
      session.records.unshift(
        buildSpanRecord(
          session,
          session.rootSpanId,
          rootParent,
          "gateway",
          "gateway",
          startedAtMs,
          endedAtMs,
          { ...session.defaults, ...(result.errorClass ? { errorClass: result.errorClass } : {}) },
          result.outcome ?? "ok",
        ),
      );
      exportBatch(session);
    },
  };
}

export function setTraceDefaults(partial: Partial<TraceDefaults>): void {
  const ctx = currentContext();
  if (!ctx) return;
  ctx.session.defaults = { ...ctx.session.defaults, ...partial };
  ctx.span.attrs = { ...ctx.span.attrs, ...partial };
}

export function updateCurrentTraceSpan(partial: Partial<TraceDefaults>): void {
  const ctx = currentContext();
  if (!ctx) return;
  ctx.span.attrs = { ...ctx.span.attrs, ...partial };
}

export function currentTraceHeaders(): Record<string, string> {
  const ctx = currentContext();
  if (!ctx) return {};
  const headers: Record<string, string> = {
    traceparent: formatTraceparent(ctx.session.traceId, ctx.span.spanId, ctx.session.sampled),
  };
  if (ctx.session.tracestate) headers["tracestate"] = ctx.session.tracestate;
  return headers;
}

export function beginTraceSpan(
  phase: TracePhase,
  attrs: TraceDefaults,
  opts: { surface?: "gateway" | "model"; startedAtMs?: number } = {},
): TraceSpanHandle {
  const ctx = currentContext();
  if (!ctx) return noopSpanHandle();
  const spanId = nextSpanId();
  const startedAtMs = opts.startedAtMs ?? nowMs();
  const child: ActiveSpan = {
    session: ctx.session,
    spanId,
    parentSpanId: ctx.span.spanId,
    phase,
    surface: opts.surface ?? "gateway",
    startedAtMs,
    attrs: { ...ctx.session.defaults, ...attrs },
  };
  let finished = false;
  return {
    enabled: true,
    async run<T>(fn: () => Promise<T>): Promise<T> {
      return storage.run({ session: ctx.session, span: child }, fn);
    },
    finish(result = {}): void {
      if (finished) return;
      finished = true;
      ctx.session.records.push(
        buildSpanRecord(
          ctx.session,
          spanId,
          child.parentSpanId,
          phase,
          child.surface,
          startedAtMs,
          result.endedAtMs ?? nowMs(),
          { ...child.attrs, ...(result.errorClass ? { errorClass: result.errorClass } : {}) },
          result.outcome ?? (result.errorClass ? "error" : "ok"),
        ),
      );
    },
  };
}

export async function withTraceSpan<T>(
  phase: TracePhase,
  attrs: TraceDefaults,
  fn: () => Promise<T>,
  opts: WithTraceSpanOptions<T> = {},
): Promise<T> {
  const span = beginTraceSpan(phase, attrs, opts);
  return span.run(async () => {
    try {
      const result = await fn();
      span.finish(opts.classifyResult?.(result) ?? {});
      return result;
    } catch (err) {
      span.finish({ outcome: "error" });
      throw err;
    }
  });
}

export function recordCompletedSpan(phase: TracePhase, options: CompletedSpanOptions): void {
  const ctx = currentContext();
  if (!ctx) return;
  const spanId = nextSpanId();
  ctx.session.records.push(
    buildSpanRecord(
      ctx.session,
      spanId,
      ctx.span.spanId,
      phase,
      options.surface ?? "gateway",
      options.startedAtMs,
      options.endedAtMs,
      { ...ctx.session.defaults, ...options },
      options.outcome,
    ),
  );
}

export function recordReadinessObservation(
  subject: "gateway" | "model",
  outcome: string,
  attrs: TraceDefaults = {},
): void {
  const ctx = currentContext();
  if (!ctx) return;
  const observedAtMs = nowMs();
  enqueueRecord({
    kind: "service-observation",
    contract_id: "gille.content-blind-readiness/v1",
    service: "gille-inference",
    instance_id: ctx.session.config.instanceId,
    release: ctx.session.config.release,
    slot_id: subject === "gateway" ? "gateway-ready" : "model-ready",
    check: { surface: "readiness" },
    outcome: safeOutcome(outcome),
    observed_at: isoAt(observedAtMs),
    collected_at: isoAt(observedAtMs),
    freshness_window: "PT5M",
    diagnostic_ref: `ref:${nextSpanId()}`,
    trace: { trace_id: ctx.session.traceId, span_id: ctx.span.spanId },
    ...(safeToken((attrs.taskType ?? ctx.session.defaults.taskType)) ? { task_type: safeToken(attrs.taskType ?? ctx.session.defaults.taskType) } : {}),
    ...(safeToken((attrs.lane ?? ctx.session.defaults.lane)) ? { lane: safeToken(attrs.lane ?? ctx.session.defaults.lane) } : {}),
    ...(typeof (attrs.retryOrdinal ?? ctx.session.defaults.retryOrdinal) === "number"
      ? { retry_ordinal: attrs.retryOrdinal ?? ctx.session.defaults.retryOrdinal }
      : {}),
    ...(safeToken(attrs.modelArtifactIdentity ?? ctx.session.defaults.modelArtifactIdentity)
      ? { model_artifact_identity: safeToken(attrs.modelArtifactIdentity ?? ctx.session.defaults.modelArtifactIdentity) }
      : {}),
    ...(safeToken(attrs.errorClass) ? { error_class: safeToken(attrs.errorClass) } : {}),
  });
}

export async function runWithSyntheticTraceForTests<T>(
  options: SyntheticTraceOptions,
  fn: () => Promise<T>,
  finish: { outcome?: string; errorClass?: string } = {},
): Promise<T> {
  const trace = beginGatewayTrace(
    {
      traceparent: options.traceparent,
      tracestate: options.tracestate,
    },
    defaultConfig({
      instrumentation: options.instrumentationEnabled === false ? "off" : "on",
      export: options.exportEnabled === true ? "on" : "off",
      samplingRatePerMille: options.samplingRatePerMille ?? 1000,
      release: options.release ?? "test",
      instanceId: options.instanceId ?? "test-instance",
    }),
    options,
  );
  return trace.run(async () => {
    try {
      return await fn();
    } finally {
      trace.finish(finish);
    }
  });
}

export async function flushTracingForTests(): Promise<readonly TracingRecord[]> {
  const work = Array.from(pendingExports);
  await Promise.all(work);
  const flat = capturedBatches.flat();
  capturedBatches = [];
  return flat;
}

export function setTracingTestHooks(next: TracingTestHooks): void {
  hooks = next;
}

export function resetTracingTestHooks(): void {
  hooks = {};
  pendingExports = new Set();
  capturedBatches = [];
}
