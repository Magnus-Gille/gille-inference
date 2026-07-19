/**
 * heimdall-push.ts — one shared, content-safe path to publish a typed panel to Heimdall.
 *
 * Heimdall ingests typed panels at `POST <HEIMDALL_PANELS_URL>/api/panels` (Bearer
 * HEIMDALL_FLEET_TOKEN). A panel is keyed by (service, panel); latest push wins (upsert) and
 * renders on /services/<service> with no Heimdall code change. Four kinds, mirrored from
 * heimdall/src/panel-ingest.js: stat | timeseries | table | status (+ optional nested detail
 * table on any kind). See scripts/post-offloadability-panel.ts for the original reference.
 *
 * This module factors out the POST so every poster (offloadability, model-scout, research)
 * shares the same bounded, never-logs-the-token, best-effort sender.
 */

/** A nested detail table renderable beneath any panel kind. */
export interface DetailTable {
  kind: "table";
  rows: Record<string, unknown>[];
  cols?: string[];
}

interface PanelCommon {
  service: string; // ^[a-z0-9][a-z0-9-]{0,63}$
  panel: string; // ^[a-z0-9][a-z0-9-]{0,63}$
  label: string; // <= 120 chars
  unit?: string;
  detail?: DetailTable;
}

export interface StatPanel extends PanelCommon {
  kind: "stat";
  value: number;
  delta?: { value: number; dir?: "up" | "down" };
}

export interface TimeseriesPanel extends PanelCommon {
  kind: "timeseries";
  points: { t: string; y: number }[];
  summary?: { latest: number; window: string; n: number };
}

export interface TablePanel extends PanelCommon {
  kind: "table";
  rows: Record<string, unknown>[];
  cols?: string[];
}

export interface StatusPanel extends PanelCommon {
  kind: "status";
  state: "pass" | "warn" | "fail";
  message?: string;
}

export type PanelPayload = StatPanel | TimeseriesPanel | TablePanel | StatusPanel;

/** Heimdall id charset — service + panel must match this or ingest hard-rejects. */
export const PANEL_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface PushResult {
  ok: boolean;
  status?: number;
  body?: string;
  error?: string; // failure class (network/timeout/config) — never contains the token or payload
}

export interface PushOptions {
  url?: string; // default: env HEIMDALL_PANELS_URL
  token?: string; // default: env HEIMDALL_FLEET_TOKEN
  timeoutMs?: number; // default: env HEIMDALL_POST_TIMEOUT_MS or 10_000
}

/**
 * POST a typed panel to Heimdall. BEST-EFFORT: returns a result object instead of throwing, so a
 * stalled/offline Heimdall never breaks the job that produced the data. Never logs the token.
 */
export async function pushPanel(payload: PanelPayload, opts: PushOptions = {}): Promise<PushResult> {
  const url = opts.url ?? process.env["HEIMDALL_PANELS_URL"];
  const token = opts.token ?? process.env["HEIMDALL_FLEET_TOKEN"];
  const timeoutMs = opts.timeoutMs ?? Number(process.env["HEIMDALL_POST_TIMEOUT_MS"] ?? 10_000);

  if (!url || !token) {
    return { ok: false, error: "HEIMDALL_PANELS_URL and HEIMDALL_FLEET_TOKEN must both be set" };
  }

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const msg =
      err instanceof Error && err.name === "TimeoutError"
        ? `timed out after ${timeoutMs}ms`
        : err instanceof Error
          ? err.message
          : String(err);
    return { ok: false, error: msg };
  }

  const body = await resp.text().catch(() => "");
  if (!resp.ok) return { ok: false, status: resp.status, body: body.slice(0, 300) };
  return { ok: true, status: resp.status, body: body.slice(0, 300) };
}

/** Outcome of a read-back verification (`GET /api/panels?service=<service>`). */
export interface VerifyResult {
  ok: boolean; // panel present AND (when maxAgeMs given) fresh — i.e. this push is actually visible
  found: boolean; // a panel with the given name exists for the service
  fresh?: boolean; // updated within maxAgeMs (only meaningful when found and maxAgeMs set)
  updatedAt?: number; // epoch ms of the stored panel's last update
  status?: number; // HTTP status of the GET
  error?: string; // failure class — never contains the token
}

export interface VerifyOptions extends PushOptions {
  maxAgeMs?: number; // if set, the found panel must have updated within this window to count as ok
  now?: number; // injectable clock (tests); defaults to Date.now()
}

/**
 * Read a panel back after pushing it. A `pushPanel` HTTP 200 only means Heimdall *accepted* the
 * POST — it does not prove the panel is stored and retrievable (heimdall#102: pushes landed in an
 * invisible drawer for weeks while every push returned 200). This closes that gap: it GETs the
 * service's panels and confirms ours is present and (optionally) freshly updated. BEST-EFFORT and
 * non-throwing, same contract as pushPanel; never logs the token.
 */
export async function verifyPanelLanded(service: string, panelName: string, opts: VerifyOptions = {}): Promise<VerifyResult> {
  const url = opts.url ?? process.env["HEIMDALL_PANELS_URL"];
  const token = opts.token ?? process.env["HEIMDALL_FLEET_TOKEN"];
  const timeoutMs = opts.timeoutMs ?? Number(process.env["HEIMDALL_POST_TIMEOUT_MS"] ?? 10_000);

  if (!url || !token) {
    return { ok: false, found: false, error: "HEIMDALL_PANELS_URL and HEIMDALL_FLEET_TOKEN must both be set" };
  }

  // Read-back shares the ingest path — same /api/panels URL, GET with a ?service= filter.
  let getUrl: string;
  try {
    const u = new URL(url);
    u.searchParams.set("service", service);
    getUrl = u.toString();
  } catch {
    getUrl = `${url}?service=${encodeURIComponent(service)}`;
  }

  let resp: Response;
  try {
    resp = await fetch(getUrl, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const msg =
      err instanceof Error && err.name === "TimeoutError"
        ? `timed out after ${timeoutMs}ms`
        : err instanceof Error
          ? err.message
          : String(err);
    return { ok: false, found: false, error: msg };
  }

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    return { ok: false, found: false, status: resp.status, error: `HTTP ${resp.status}: ${body.slice(0, 120)}` };
  }

  let data: unknown;
  try {
    data = await resp.json();
  } catch {
    return { ok: false, found: false, status: resp.status, error: "read-back response was not JSON" };
  }

  // Heimdall returns an array of {service, panel, kind, label, unit, data, updated_at} (updated_at
  // is numeric epoch ms); tolerate a {panels:[...]} envelope too.
  const items: Array<Record<string, unknown>> = Array.isArray(data)
    ? (data as Array<Record<string, unknown>>)
    : Array.isArray((data as { panels?: unknown })?.panels)
      ? ((data as { panels: Array<Record<string, unknown>> }).panels)
      : [];
  const match = items.find((p) => p && (p["panel"] === panelName || p["name"] === panelName));
  if (!match) return { ok: false, found: false, status: resp.status };

  // Canonical field is updated_at; tolerate camelCase / short aliases defensively.
  const rawUpdated = match["updated_at"] ?? match["updatedAt"] ?? match["updated"];
  const updatedAt = typeof rawUpdated === "number" ? rawUpdated : undefined;

  if (opts.maxAgeMs == null) return { ok: true, found: true, updatedAt, status: resp.status };

  const now = opts.now ?? Date.now();
  const fresh = updatedAt != null && now - updatedAt <= opts.maxAgeMs;
  return { ok: fresh, found: true, fresh, updatedAt, status: resp.status };
}

/** Human-readable reason a read-back was not ok — for log lines. Never contains the token. */
export function verifyProblem(v: VerifyResult): string {
  if (v.error) return v.error;
  if (!v.found) return "panel absent from read-back (accepted but not stored?)";
  if (v.fresh === false) {
    const age = v.updatedAt != null ? `${Math.round((Date.now() - v.updatedAt) / 1000)}s old` : "no timestamp";
    return `panel present but stale (${age}) — this push may not have overwritten it`;
  }
  return "read-back not ok";
}
