/**
 * Per-call "do not log content" opt-out (#487).
 *
 * An owner caller may mark one request `content_capture: "none"` (MCP `ask` / `code_loop_start`
 * argument) or send `X-Content-Capture: none` (HTTP). The gateway then persists metadata only:
 * `owner_request_log` keeps alias/model/timings/token counts/outcome with empty content columns
 * and `content_capture = 'suppressed'`; the capability ledger keeps no prompt excerpt or prompt
 * hash; harvest/backfill readers skip the row; code_loop keeps its result in memory only and
 * removes its sandbox as soon as cleanup is proved. A surface that cannot honour the flag refuses
 * the request explicitly instead of silently capturing content.
 *
 * The request value is `none`; the effective marker the gateway records and echoes is
 * `suppressed`. Unknown values are rejected (fail closed) rather than treated as the default.
 */

/** Stable capability identifier advertised to callers that can preflight the opt-out. */
export const CONTENT_CAPTURE_OPT_OUT_CONTRACT = "content-capture-none-v1";
/** HTTP request header (case-insensitive) and response echo header. */
export const CONTENT_CAPTURE_HEADER = "x-content-capture";
/** The only accepted request value. */
export const CONTENT_CAPTURE_NONE = "none";
/** Marker persisted in metadata rows and echoed to the caller when the opt-out was honoured. */
export const CONTENT_CAPTURE_SUPPRESSED = "suppressed";

export type ContentCapture = "default" | "suppressed";

export type ContentCaptureParse =
  | { ok: true; capture: ContentCapture }
  | { ok: false; message: string };

const INVALID_ARGUMENT = "'content_capture' must be 'none' when supplied.";
const INVALID_HEADER = "X-Content-Capture must be 'none' when supplied.";

/** Parse the MCP/JSON argument. `undefined` keeps the default; anything other than "none" fails. */
export function parseContentCaptureArgument(value: unknown): ContentCaptureParse {
  if (value === undefined) return { ok: true, capture: "default" };
  if (value === CONTENT_CAPTURE_NONE) return { ok: true, capture: "suppressed" };
  return { ok: false, message: INVALID_ARGUMENT };
}

/**
 * Parse the HTTP header value. Node joins repeated custom headers with ", ", so a duplicated or
 * conflicting header is rejected rather than guessed at. The value is never echoed back.
 */
export function parseContentCaptureHeader(value: string | string[] | undefined): ContentCaptureParse {
  if (value === undefined) return { ok: true, capture: "default" };
  if (typeof value !== "string" || value.trim().toLowerCase() !== CONTENT_CAPTURE_NONE) {
    return { ok: false, message: INVALID_HEADER };
  }
  return { ok: true, capture: "suppressed" };
}

/** Combine the transport header with a per-call argument: either one suppresses. */
export function combineContentCapture(...captures: ContentCapture[]): ContentCapture {
  return captures.includes("suppressed") ? "suppressed" : "default";
}

export function isContentCaptureSuppressed(capture: ContentCapture | undefined): boolean {
  return capture === "suppressed";
}
