/**
 * Canonical content-blind predicate for one M5 compute request.
 *
 * The gateway writes a transport row for every HTTP/MCP request, but an MCP ask also writes one
 * `/mcp/ask` inference row.  Usage consumers must apply this predicate so the transport envelope
 * is not counted as a second model call.  Keep the route allow-list closed: a new route is not a
 * compute metric until it is deliberately added here.
 */

/**
 * Filter epoch for M5 compute utilization.
 *
 * Historical rows/panels produced before this epoch used inconsistent route-only filters and are
 * not directly comparable: they could include `/mcp` transport rows, non-M5 rows, or attempts
 * rejected before admission.  Consumers should show the epoch when comparing a time series.
 */
export const COMPUTE_REQUEST_FILTER_EPOCH = "m5-admitted-compute-v2" as const;

/** Actual inference rows, including MCP `ask` and async image-worker completion rows. */
export const M5_COMPUTE_ROUTES = [
  "/v1/chat/completions",
  "/v1/audio/transcriptions",
  "/v1/images/generations",
  "image",
  "/delegate",
  "/mcp/ask",
] as const;

// `code_loop` turns use the gateway's chat route through the caged relay; they do not create a
// second code-loop transport row that should be counted separately.

export type M5ComputeRoute = (typeof M5_COMPUTE_ROUTES)[number];

/** Minimal request-log shape needed by the predicate; no identity or content fields. */
export interface ComputeRequestFields {
  node: string | null | undefined;
  route: string | null | undefined;
  model: string | null | undefined;
  admission: string | null | undefined;
}

/**
 * True only for an admitted inference row executed on M5.
 *
 * `model = "none"` is the canonical non-inference/transport sentinel.  The route allow-list
 * independently excludes `/mcp` transport and discovery/monitoring routes.
 */
export function isAdmittedM5ComputeRequest(row: ComputeRequestFields): boolean {
  return row.node === "m5"
    && row.admission === "admitted"
    && typeof row.model === "string"
    && row.model !== "none"
    && typeof row.route === "string"
    && (M5_COMPUTE_ROUTES as readonly string[]).includes(row.route);
}

const ROUTES_SQL = M5_COMPUTE_ROUTES.map((route) => `'${route}'`).join(",");

/** SQL equivalent of {@link isAdmittedM5ComputeRequest}, for all usage rollups. */
export const COMPUTE_REQUEST_FILTER_SQL = [
  "node = 'm5'",
  "admission = 'admitted'",
  "model IS NOT NULL",
  "model <> 'none'",
  `route IN (${ROUTES_SQL})`,
].join("\n  AND ");
