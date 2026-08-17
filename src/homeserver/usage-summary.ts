import type Database from "better-sqlite3";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Actual M5 compute surfaces. The outer `/mcp` row is deliberately absent: an MCP ask writes its
 * own `/mcp/ask` inference row, so counting both would turn one model call into two requests.
 */
export const M5_INFERENCE_ROUTES = [
  "/v1/chat/completions",
  "/v1/audio/transcriptions",
  "/v1/images/generations",
  "/delegate",
  "/mcp/ask",
] as const;

const ROUTES_SQL = M5_INFERENCE_ROUTES.map((route) => `'${route}'`).join(",");
const COMPUTE_FILTER = `
  node = 'm5'
  AND admission = 'admitted'
  AND route IN (${ROUTES_SQL})
`;

export interface UsageWindow {
  requests: number;
  /** Sum of request wall-clock time. This is not claimed as GPU occupancy. */
  requestTimeMs: number;
}

export interface DailyM5Usage extends UsageWindow {
  /** UTC calendar date, YYYY-MM-DD. */
  date: string;
}

export interface M5UsageByTier {
  owner: UsageWindow;
  guest: UsageWindow;
  /** Legacy or otherwise unclassified admitted compute calls. */
  other: UsageWindow;
}

export interface M5UsageSummary {
  generatedAt: string;
  activeRequests: number;
  lastUsedAt: string | null;
  last24Hours: UsageWindow;
  /** Content-blind aggregate split for the same trailing 24-hour window. */
  last24HoursByTier: M5UsageByTier;
  last7Days: UsageWindow;
  /** Newest day first. Zero-activity days are present explicitly. */
  daily: DailyM5Usage[];
}

interface DbUsageWindow {
  requests: number;
  request_time_ms: number | null;
}

interface DbUsageByTier extends DbUsageWindow {
  owner_requests: number;
  owner_request_time_ms: number | null;
  guest_requests: number;
  guest_request_time_ms: number | null;
  other_requests: number;
  other_request_time_ms: number | null;
}

function utcDayStart(ms: number): number {
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function windowOf(row: DbUsageWindow): UsageWindow {
  return {
    requests: row.requests,
    requestTimeMs: row.request_time_ms ?? 0,
  };
}

/**
 * Read the small, content-blind usage shape used by Heimdall. Only admitted requests on the M5
 * compute node are counted. No aliases, key hashes, content, tokens, or per-model dimensions leave
 * this function.
 */
export function queryM5UsageSummary(
  db: Database.Database,
  options: { now?: number; days?: number; activeRequests?: number } = {},
): M5UsageSummary {
  const now = options.now ?? Date.now();
  const days = options.days ?? 7;
  if (!Number.isInteger(days) || days < 1 || days > 31) {
    throw new RangeError("days must be an integer from 1 to 31");
  }
  if (!Number.isFinite(now)) throw new RangeError("now must be a finite epoch-millisecond value");

  const calendarStart = utcDayStart(now) - (days - 1) * DAY_MS;
  const dailyRows = db.prepare(`
    SELECT
      strftime('%Y-%m-%d', ts / 1000, 'unixepoch') AS date,
      COUNT(*) AS requests,
      COALESCE(SUM(CASE WHEN total_ms > 0 THEN total_ms ELSE 0 END), 0) AS request_time_ms
    FROM request_log
    WHERE ${COMPUTE_FILTER}
      AND ts >= @since
      AND ts <= @now
    GROUP BY date
  `).all({ since: calendarStart, now }) as Array<DbUsageWindow & { date: string }>;

  const byDate = new Map(dailyRows.map((row) => [row.date, row]));
  const daily: DailyM5Usage[] = [];
  for (let offset = 0; offset < days; offset += 1) {
    const date = utcDate(utcDayStart(now) - offset * DAY_MS);
    const row = byDate.get(date);
    daily.push({ date, ...(row ? windowOf(row) : { requests: 0, requestTimeMs: 0 }) });
  }

  const last24Row = db.prepare(`
    SELECT
      COUNT(*) AS requests,
      COALESCE(SUM(CASE WHEN total_ms > 0 THEN total_ms ELSE 0 END), 0) AS request_time_ms,
      SUM(CASE WHEN tier = 'owner' THEN 1 ELSE 0 END) AS owner_requests,
      COALESCE(SUM(CASE WHEN tier = 'owner' AND total_ms > 0 THEN total_ms ELSE 0 END), 0)
        AS owner_request_time_ms,
      SUM(CASE WHEN tier = 'guest' THEN 1 ELSE 0 END) AS guest_requests,
      COALESCE(SUM(CASE WHEN tier = 'guest' AND total_ms > 0 THEN total_ms ELSE 0 END), 0)
        AS guest_request_time_ms,
      SUM(CASE WHEN tier IS NULL OR tier NOT IN ('owner', 'guest') THEN 1 ELSE 0 END)
        AS other_requests,
      COALESCE(SUM(CASE
        WHEN (tier IS NULL OR tier NOT IN ('owner', 'guest')) AND total_ms > 0 THEN total_ms
        ELSE 0
      END), 0) AS other_request_time_ms
    FROM request_log
    WHERE ${COMPUTE_FILTER}
      AND ts >= @since
      AND ts <= @now
  `).get({ since: now - DAY_MS, now }) as DbUsageByTier;

  const latest = db.prepare(`
    SELECT MAX(ts) AS last_used_at
    FROM request_log
    WHERE ${COMPUTE_FILTER}
      AND ts <= @now
  `).get({ now }) as { last_used_at: number | null };

  const last7Days = daily.reduce<UsageWindow>(
    (total, day) => ({
      requests: total.requests + day.requests,
      requestTimeMs: total.requestTimeMs + day.requestTimeMs,
    }),
    { requests: 0, requestTimeMs: 0 },
  );

  const rawActive = options.activeRequests ?? 0;
  const activeRequests = Number.isFinite(rawActive)
    ? Math.max(0, Math.trunc(rawActive))
    : 0;

  return {
    generatedAt: new Date(now).toISOString(),
    activeRequests,
    lastUsedAt: latest.last_used_at === null ? null : new Date(latest.last_used_at).toISOString(),
    last24Hours: windowOf(last24Row),
    last24HoursByTier: {
      owner: {
        requests: last24Row.owner_requests,
        requestTimeMs: last24Row.owner_request_time_ms ?? 0,
      },
      guest: {
        requests: last24Row.guest_requests,
        requestTimeMs: last24Row.guest_request_time_ms ?? 0,
      },
      other: {
        requests: last24Row.other_requests,
        requestTimeMs: last24Row.other_request_time_ms ?? 0,
      },
    },
    last7Days,
    daily,
  };
}
