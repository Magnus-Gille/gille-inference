/**
 * Tests for the portal-feedback Heimdall panel poster (pure functions + a real-fs reader test).
 *   buildFeedbackTablePanel  — pure, no fs/network
 *   readFeedback             — reads + tolerantly parses the JSONL feedback.ts writes
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFeedbackTablePanel, readFeedback, isFeedbackRow } from "../scripts/post-feedback-panel.js";
import { PANEL_ID_RE } from "../src/homeserver/heimdall-push.js";
import type { FeedbackRow } from "../scripts/post-feedback-panel.js";

const row = (over: Partial<FeedbackRow> = {}): FeedbackRow => ({
  ts: 1782900000000,
  text: "love the box, thanks!",
  alias: "alice",
  page: "/portal",
  ...over,
});

describe("buildFeedbackTablePanel", () => {
  it("emits a valid table panel with ids matching Heimdall's pattern", () => {
    const p = buildFeedbackTablePanel([row()]);
    expect(p.kind).toBe("table");
    expect(p.service).toBe("m5-inference");
    expect(PANEL_ID_RE.test(p.service)).toBe(true);
    expect(PANEL_ID_RE.test(p.panel)).toBe(true);
  });

  it("sorts newest first", () => {
    const rows = buildFeedbackTablePanel([
      row({ ts: 1000, text: "older" }),
      row({ ts: 2000, text: "newer" }),
    ]).rows;
    expect(rows[0]!["feedback"]).toBe("newer");
    expect(rows[1]!["feedback"]).toBe("older");
  });

  it("shows 'anonymous' when alias is null (an unauthenticated portal visitor)", () => {
    const rows = buildFeedbackTablePanel([row({ alias: null })]).rows;
    expect(rows[0]!["from"]).toBe("anonymous");
  });

  it("shows the actual feedback text verbatim (clear-text, per the intent this panel was requested for)", () => {
    const rows = buildFeedbackTablePanel([row({ text: "the portal docs section is great, more examples pls" })]).rows;
    expect(rows[0]!["feedback"]).toBe("the portal docs section is great, more examples pls");
  });

  it("honors the row limit, keeping the newest", () => {
    const many = Array.from({ length: 50 }, (_, i) => row({ ts: i, text: `msg-${i}` }));
    const rows = buildFeedbackTablePanel(many, 10).rows;
    expect(rows.length).toBe(10);
    expect(rows[0]!["feedback"]).toBe("msg-49"); // newest ts
  });

  it("label reflects the TOTAL count, not just the shown rows", () => {
    const many = Array.from({ length: 50 }, (_, i) => row({ ts: i }));
    const p = buildFeedbackTablePanel(many, 10);
    expect(p.label).toContain("50");
  });
});

describe("isFeedbackRow", () => {
  it("accepts a well-formed row", () => expect(isFeedbackRow(row())).toBe(true));
  it("rejects non-objects", () => {
    expect(isFeedbackRow(null)).toBe(false);
    expect(isFeedbackRow("x")).toBe(false);
    expect(isFeedbackRow(42)).toBe(false);
  });
  it("rejects a row missing required fields", () => {
    expect(isFeedbackRow({})).toBe(false);
    expect(isFeedbackRow({ ts: 1 })).toBe(false); // no text
    expect(isFeedbackRow({ text: "x" })).toBe(false); // no ts
    expect(isFeedbackRow({ ts: "not-a-number", text: "x" })).toBe(false);
  });
  it("tolerates alias/page being absent (older rows may predate those fields)", () => {
    expect(isFeedbackRow({ ts: 1, text: "x" })).toBe(true);
  });
});

describe("readFeedback", () => {
  it("parses one JSON object per line", () => {
    const dir = mkdtempSync(join(tmpdir(), "hs-feedback-test-"));
    const path = join(dir, "feedback.jsonl");
    writeFileSync(path, `${JSON.stringify(row({ text: "a" }))}\n${JSON.stringify(row({ text: "b" }))}\n`);
    const rows = readFeedback(path);
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.text)).toEqual(["a", "b"]);
  });

  it("skips malformed/non-JSON lines rather than throwing (best-effort, matches the writer's own contract)", () => {
    const dir = mkdtempSync(join(tmpdir(), "hs-feedback-test-"));
    const path = join(dir, "feedback.jsonl");
    writeFileSync(path, `${JSON.stringify(row({ text: "good" }))}\nnot json at all\n{"ts":1}\n\n`);
    const rows = readFeedback(path);
    expect(rows.length).toBe(1);
    expect(rows[0]!.text).toBe("good");
  });

  it("returns an empty array (not an error) when the file doesn't exist yet", () => {
    expect(readFeedback("/nonexistent/path/feedback.jsonl")).toEqual([]);
  });
});
