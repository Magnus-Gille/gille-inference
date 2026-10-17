import type Database from "better-sqlite3";

const MAX_WINDOW_MS = 24 * 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALIAS_RE = /^[A-Za-z0-9._:-]{1,128}$/;

const ROUTES = new Set([
  "/v1/chat/completions",
  "/mcp/ask",
  "/mcp",
  "/healthz",
  "/v1/models",
]);

const OUTCOMES = new Set([
  "ok", "error", "rate_limited", "busy", "bad_request", "forbidden",
  "credits_exhausted", "upstream_unavailable", "upstream_timeout", "memory_refused",
  "client_closed", "degenerate", "model_temporarily_unavailable",
]);

const ERROR_CLASSES = new Set([
  "upstream_error", "upstream_unavailable", "upstream_timeout", "server_busy",
  "rate_limit_exceeded", "model_not_allowed", "insufficient_memory",
  "memory_admission_unavailable", "invalid_request_error", "model_temporarily_unavailable",
  "route_not_allowed", "credits_exhausted", "internal_error",
]);

const REQUIRED_COLUMNS = [
  "id", "ts", "alias", "tier", "model", "node", "route", "status", "outcome",
  "error_class", "admission", "total_ms",
] as const;

export class IncidentWindowOptionsError extends TypeError {
  constructor() {
    super("Invalid incident window options");
    this.name = "IncidentWindowOptionsError";
  }
}

export interface IncidentWindowOptions {
  fromMs: number;
  toMs: number;
  limit: number;
  requestLogEnabled: boolean;
  knownModelIds: ReadonlySet<string> | readonly string[];
}

export interface IncidentWindowRequest {
  request_id: string | null;
  at_ms: number;
  caller_alias: string | null;
  tier: "owner" | "guest" | null;
  model: string;
  node: "m5" | "orin" | "unknown";
  route: string;
  http_status: number | null;
  outcome: string;
  error_class: string | null;
  admission: "admitted" | "busy" | "n/a" | null;
  duration_ms: number | null;
}

export type IncidentWindowResponse =
  | {
      schema: "incident_window_v1";
      status: "available";
      from_ms: number;
      to_ms: number;
      coverage: "retained_rows_only";
      causality: "not_established";
      truncated: boolean;
      requests: IncidentWindowRequest[];
    }
  | {
      schema: "incident_window_v1";
      status: "disabled";
      from_ms: number;
      to_ms: number;
      coverage: "retained_rows_only";
      causality: "not_established";
      truncated: false;
      requests: [];
    }
  | {
      schema: "incident_window_v1";
      status: "unavailable";
      from_ms: number;
      to_ms: number;
      coverage: "retained_rows_only";
      causality: "not_established";
      truncated: false;
      requests: [];
      reason: "missing_request_log" | "unsupported_schema";
    };

interface RawRequestRow {
  id: unknown;
  ts: unknown;
  alias: unknown;
  tier: unknown;
  model: unknown;
  node: unknown;
  route: unknown;
  status: unknown;
  outcome: unknown;
  error_class: unknown;
  admission: unknown;
  total_ms: unknown;
}

function validOptions(options: IncidentWindowOptions): boolean {
  if (
    !options ||
    !Number.isSafeInteger(options.fromMs) || options.fromMs < 0 ||
    !Number.isSafeInteger(options.toMs) || options.toMs < options.fromMs ||
    options.toMs - options.fromMs > MAX_WINDOW_MS ||
    !Number.isInteger(options.limit) || options.limit < 1 || options.limit > 500 ||
    typeof options.requestLogEnabled !== "boolean"
  ) return false;

  if (options.knownModelIds instanceof Set) {
    for (const id of options.knownModelIds) if (typeof id !== "string") return false;
    return true;
  }
  return Array.isArray(options.knownModelIds) && options.knownModelIds.every((id) => typeof id === "string");
}

function emptyResponse(
  status: "disabled" | "unavailable",
  fromMs: number,
  toMs: number,
  reason?: "missing_request_log" | "unsupported_schema",
): IncidentWindowResponse {
  const base = {
    schema: "incident_window_v1" as const,
    status,
    from_ms: fromMs,
    to_ms: toMs,
    coverage: "retained_rows_only" as const,
    causality: "not_established" as const,
    truncated: false as const,
    requests: [] as [],
  };
  if (status === "unavailable") return { ...base, status, reason: reason! };
  return { ...base, status };
}

function asKnownModel(model: unknown, known: ReadonlySet<string> | readonly string[]): string {
  if (model === "none" || model === "unknown") return model;
  if (typeof model !== "string") return "unknown";
  if (Array.isArray(known)) return known.includes(model) ? model : "unknown";
  return (known as ReadonlySet<string>).has(model) ? model : "unknown";
}

function projectRow(row: RawRequestRow, known: ReadonlySet<string> | readonly string[]): IncidentWindowRequest {
  const id = typeof row.id === "string" && UUID_RE.test(row.id) ? row.id : null;
  const atMs = typeof row.ts === "number" && Number.isInteger(row.ts) ? row.ts : 0;
  const alias = typeof row.alias === "string" && ALIAS_RE.test(row.alias) ? row.alias : null;
  const tier = row.tier === "owner" || row.tier === "guest" ? row.tier : null;
  const node = row.node === "m5" || row.node === "orin" ? row.node : "unknown";
  const route = typeof row.route === "string" && ROUTES.has(row.route) ? row.route : "/mcp";
  const status = typeof row.status === "number" && Number.isInteger(row.status) && row.status >= 100 && row.status <= 599
    ? row.status
    : null;
  const outcome = typeof row.outcome === "string" && OUTCOMES.has(row.outcome) ? row.outcome : "unknown";
  const errorClass = row.error_class === null
    ? null
    : typeof row.error_class === "string" && ERROR_CLASSES.has(row.error_class)
      ? row.error_class
      : "unknown";
  const admission = row.admission === "admitted" || row.admission === "busy" || row.admission === "n/a"
    ? row.admission
    : null;
  const duration = typeof row.total_ms === "number" && Number.isFinite(row.total_ms) && Number.isInteger(row.total_ms) && row.total_ms >= 0
    ? row.total_ms
    : null;

  return {
    request_id: id,
    at_ms: atMs,
    caller_alias: alias,
    tier,
    model: asKnownModel(row.model, known),
    node,
    route,
    http_status: status,
    outcome,
    error_class: errorClass,
    admission,
    duration_ms: duration,
  };
}

/** Read a bounded, content-blind window from the existing request_log without initializing it. */
export function queryIncidentWindow(
  db: Database.Database,
  options: IncidentWindowOptions,
): IncidentWindowResponse {
  if (!validOptions(options)) throw new IncidentWindowOptionsError();
  const { fromMs, toMs, limit, requestLogEnabled, knownModelIds } = options;
  if (!requestLogEnabled) return emptyResponse("disabled", fromMs, toMs);

  const table = db.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'request_log'",
  ).get() as { present: 1 } | undefined;
  if (!table) return emptyResponse("unavailable", fromMs, toMs, "missing_request_log");

  const columns = db.prepare("PRAGMA table_info(request_log)").all() as Array<{ name: string }>;
  const availableColumns = new Set(columns.map((column) => column.name));
  if (!REQUIRED_COLUMNS.every((column) => availableColumns.has(column))) {
    return emptyResponse("unavailable", fromMs, toMs, "unsupported_schema");
  }

  const rows = db.prepare(
    `SELECT id, ts, alias, tier, model, node, route, status, outcome, error_class, admission, total_ms
       FROM request_log
      WHERE ts >= @fromMs AND ts <= @toMs
        AND route IN ('/v1/chat/completions', '/mcp/ask', '/mcp', '/healthz', '/v1/models')
      ORDER BY ts ASC, id ASC
      LIMIT @fetchLimit`,
  ).all({ fromMs, toMs, fetchLimit: limit + 1 }) as RawRequestRow[];
  const truncated = rows.length > limit;
  return {
    schema: "incident_window_v1",
    status: "available",
    from_ms: fromMs,
    to_ms: toMs,
    coverage: "retained_rows_only",
    causality: "not_established",
    truncated,
    requests: rows.slice(0, limit).map((row) => projectRow(row, knownModelIds)),
  };
}
