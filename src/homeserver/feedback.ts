import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Feedback storage — appends one JSON line per submission to HOMESERVER_FEEDBACK_FILE
 * (default ./data/feedback.jsonl).
 *
 * Fields stored:
 *   ts        — epoch ms (number)
 *   text      — verbatim user-submitted text (this IS content the user chose to send)
 *   alias     — keystore alias when an authenticated bearer key was present, null otherwise
 *   userAgent — truncated User-Agent header (max 200 chars)
 *   page      — optional pathname string from the client, null when omitted
 *
 * Write is best-effort: any I/O failure is logged to stderr and returns false without
 * throwing. The caller must NOT check the return value for correctness — it is purely
 * advisory. A write failure NEVER surfaces as an HTTP error.
 */

export interface FeedbackRecord {
  text: string;
  alias: string | null;
  userAgent: string | null;
  page: string | null;
}

const MAX_UA_LEN = 200;
const MAX_PAGE_LEN = 512;

function feedbackFilePath(): string {
  return process.env["HOMESERVER_FEEDBACK_FILE"] ?? "./data/feedback.jsonl";
}

/**
 * Append one feedback record. Best-effort: returns true on success, false on any failure.
 * Never throws.
 */
export function recordFeedback(record: FeedbackRecord): boolean {
  const line: Record<string, unknown> = {
    ts: Date.now(),
    text: record.text,
    alias: record.alias,
    userAgent: record.userAgent ? record.userAgent.slice(0, MAX_UA_LEN) : null,
    page: record.page ? record.page.slice(0, MAX_PAGE_LEN) : null,
  };
  const path = feedbackFilePath();
  try {
    // Ensure the data directory exists (idempotent).
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(line) + "\n", "utf-8");
    return true;
  } catch (err) {
    console.error("[feedback] failed to write feedback record (ignored):", err);
    return false;
  }
}
