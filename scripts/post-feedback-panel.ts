#!/usr/bin/env tsx
/**
 * post-feedback-panel.ts — publish the portal's free-text feedback to Heimdall.
 *
 * Reads data/feedback.jsonl (written by src/homeserver/feedback.ts, one JSON line per portal
 * feedback submission) and pushes a single table panel to Heimdall on service `m5-inference`
 * (renders on /services/m5-inference, no Heimdall code change).
 *
 * The feedback text is shown VERBATIM (clear-text) — this was an explicit ask, not an oversight:
 * the point is for the owner to actually see what friends wrote, which today sits unread in a
 * JSONL file nobody looks at.
 *
 * BEST-EFFORT (shares heimdall-push): a stalled/offline Heimdall never breaks anything — there is
 * no upstream job this could block.
 *
 * USAGE   tsx scripts/post-feedback-panel.ts [--dry-run]
 * ENV     HEIMDALL_PANELS_URL, HEIMDALL_FLEET_TOKEN, HOMESERVER_FEEDBACK_FILE (default ./data/feedback.jsonl)
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { pushPanel, type TablePanel } from "../src/homeserver/heimdall-push.js";

const SERVICE = "m5-inference";
const DEFAULT_TABLE_LIMIT = 30;
const DEFAULT_FEEDBACK_PATH = "./data/feedback.jsonl";

export interface FeedbackRow {
  ts: number;
  text: string;
  alias: string | null;
  page: string | null;
}

/** Structural guard — a valid-JSON-but-wrong-shape line must not break the read. */
export function isFeedbackRow(x: unknown): x is FeedbackRow {
  if (!x || typeof x !== "object") return false;
  const r = x as Record<string, unknown>;
  return typeof r["ts"] === "number" && typeof r["text"] === "string";
}

/** Read + tolerantly parse the feedback JSONL. Missing file or malformed lines never throw. */
export function readFeedback(path: string): FeedbackRow[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return [];
  }
  const rows: FeedbackRow[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // best-effort: skip a corrupt line rather than aborting the whole read
    }
    if (isFeedbackRow(parsed)) {
      rows.push({ ts: parsed.ts, text: parsed.text, alias: parsed.alias ?? null, page: parsed.page ?? null });
    }
  }
  return rows;
}

/** Recent feedback, newest first → a Heimdall table panel (pure → testable). */
export function buildFeedbackTablePanel(entries: FeedbackRow[], limit = DEFAULT_TABLE_LIMIT): TablePanel {
  const rows = [...entries]
    .sort((a, b) => b.ts - a.ts)
    .slice(0, limit)
    .map((e) => ({
      when: new Date(e.ts).toISOString().slice(0, 16).replace("T", " "),
      from: e.alias ?? "anonymous",
      page: e.page ?? "—",
      feedback: e.text,
    }));
  return {
    service: SERVICE,
    panel: "portal-feedback",
    kind: "table",
    label: `Portal feedback (${entries.length} total)`,
    cols: ["when", "from", "page", "feedback"],
    rows,
  };
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const path = process.env["HOMESERVER_FEEDBACK_FILE"] ?? DEFAULT_FEEDBACK_PATH;
  const entries = readFeedback(path);
  const panel = buildFeedbackTablePanel(entries);

  if (dryRun) {
    console.log(JSON.stringify(panel, null, 2));
    return;
  }
  if (entries.length === 0) {
    console.log(`[feedback-panel] no feedback in ${path} — nothing to push.`);
    return;
  }

  const r = await pushPanel(panel);
  if (r.ok) console.log(`[feedback-panel] pushed '${panel.panel}' (${entries.length} total, HTTP ${r.status})`);
  else {
    console.error(`[feedback-panel] push failed: ${r.error ?? `HTTP ${r.status}: ${r.body}`}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
  });
}
