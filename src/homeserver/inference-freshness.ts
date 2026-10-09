import type Database from "better-sqlite3";

import {
  COMPUTE_REQUEST_FILTER_EPOCH,
  COMPUTE_REQUEST_FILTER_SQL,
} from "./compute-request-filter.js";

/**
 * Return the timestamp of the newest observed successful admitted M5 inference.
 *
 * The query exposes only the timestamp. It deliberately does not read or return model, alias,
 * route, token, or content dimensions. Database errors propagate so callers can report unavailable
 * state instead of presenting a missing or stale timestamp as authoritative.
 */
export function queryLatestSuccessfulM5InferenceAt(
  db: Database.Database,
  now: number = Date.now(),
): string | null {
  if (!Number.isFinite(now) || !Number.isFinite(new Date(now).getTime())) {
    throw new RangeError("now must be a valid epoch-millisecond timestamp");
  }

  const row = db.prepare(`
    SELECT MAX(ts) AS latest_ts
    FROM request_log
    WHERE ${COMPUTE_REQUEST_FILTER_SQL}
      AND compute_filter_epoch = @epoch
      AND outcome = 'ok'
      AND status >= 200
      AND status < 300
      AND ts <= @now
  `).get({ epoch: COMPUTE_REQUEST_FILTER_EPOCH, now }) as { latest_ts: number | null };

  if (row.latest_ts === null) return null;
  if (!Number.isFinite(row.latest_ts) || !Number.isFinite(new Date(row.latest_ts).getTime())) {
    throw new RangeError("request_log contains an invalid inference timestamp");
  }
  return new Date(row.latest_ts).toISOString();
}
