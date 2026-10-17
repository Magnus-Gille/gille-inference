import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { assertTestPathOutsideRepositoryData, isTestRuntime } from "../test-runtime-path.js";

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
 * Write is best-effort in production: any I/O failure is logged to stderr and returns false
 * without throwing. The caller must NOT check the return value for correctness — it is purely
 * advisory. A write failure NEVER surfaces as an HTTP error. Test runtimes must configure an
 * explicit path and fail closed if they do not, so tests cannot append to repository data.
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
  const configured = process.env["HOMESERVER_FEEDBACK_FILE"];
  if (!configured && isTestRuntime()) {
    throw new Error(
      "Refusing the implicit ./data/feedback.jsonl test file; set HOMESERVER_FEEDBACK_FILE"
    );
  }
  const path = configured ?? "./data/feedback.jsonl";
  assertTestPathOutsideRepositoryData(path, "feedback");
  return path;
}

/**
 * Append one feedback record. Best-effort in production: returns true on success, false on any
 * I/O failure. A test runtime without an explicit path throws before attempting any I/O.
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
