/**
 * Issue #74 — route-stability tests for the bounded local-review lane.
 *
 * The whole point of `review-bounded` being a NEW, separate task type from `code-review` is that
 * prompt WORDING must not silently change which lane a request lands in:
 *   - A genuine bounded-contract request (built via review-bounded.ts's prompt builders) must
 *     classify as `review-bounded` (local-eligible, advisory).
 *   - An ordinary open-ended/whole-patch review ask — even a near-miss one that happens to mention
 *     "classify" or "findings" in passing — must still classify as `code-review` (frontier-only,
 *     unaffected by this ticket), never accidentally fall into the local-eligible lane.
 */
import { describe, expect, it } from "vitest";
import { classifyTask, taskTypeEmitsJson, isKnownTaskType } from "../src/homeserver/taxonomy.js";
import {
  REVIEW_BOUNDED_TASK_TYPE,
  buildClassifyFindingsPrompt,
  buildDetectAntiPatternPrompt,
  buildVerifyOutputShapePrompt,
} from "../src/homeserver/review-bounded.js";
import { routableTaskTypes } from "../src/homeserver/routing-table-generator.js";
import { loadRoutingTable } from "../src/homeserver/routing-table.js";

describe("taxonomy: review-bounded is a known, JSON-shaped task type (#74)", () => {
  it("is registered in the taxonomy", () => {
    expect(isKnownTaskType(REVIEW_BOUNDED_TASK_TYPE)).toBe(true);
  });

  it("is declared JSON-shaped (structured, machine-checkable output)", () => {
    expect(taskTypeEmitsJson(REVIEW_BOUNDED_TASK_TYPE)).toBe(true);
  });

  it("is part of the routable universe without forcing a route", () => {
    expect(routableTaskTypes()).toContain(REVIEW_BOUNDED_TASK_TYPE);
  });
});

describe("taxonomy: genuine review-bounded contract prompts route locally-eligible (#74)", () => {
  it("classify-findings contract prompt classifies as review-bounded", () => {
    const prompt = buildClassifyFindingsPrompt({
      diffExcerpt: "- foo();\n+ bar();",
      findings: [{ id: "f1", claim: "bar() is undefined at this call site" }],
    });
    const c = classifyTask(prompt);
    expect(c.taskType).toBe(REVIEW_BOUNDED_TASK_TYPE);
    expect(c.taskType).not.toBe("code-review");
  });

  it("detect-anti-pattern contract prompt classifies as review-bounded", () => {
    const prompt = buildDetectAntiPatternPrompt({
      patternId: "bare-catch",
      patternDescription: "a catch block that swallows the error with no logging or rethrow",
      codeExcerpt: "try { risky(); } catch (e) {}",
    });
    const c = classifyTask(prompt);
    expect(c.taskType).toBe(REVIEW_BOUNDED_TASK_TYPE);
    expect(c.taskType).not.toBe("code-review");
  });

  it("verify-output-shape contract prompt classifies as review-bounded", () => {
    const prompt = buildVerifyOutputShapePrompt({
      schemaDescription: '{"ok": boolean, "id": string}',
      candidateOutput: '{"ok": true}',
    });
    const c = classifyTask(prompt);
    expect(c.taskType).toBe(REVIEW_BOUNDED_TASK_TYPE);
    expect(c.taskType).not.toBe("code-review");
  });
});

describe("taxonomy: open-ended / near-miss review asks still escalate via code-review (#74)", () => {
  const openEndedAsks = [
    "Please review this whole PR and tell me if it's good to merge.",
    "Can you critique this diff end to end before I merge it?",
    "Review this pull request thoroughly and flag anything concerning.",
    "What's wrong with this code overall?",
    // Near-miss: mentions "classify" and "findings" in ordinary prose, but carries NONE of the
    // fixed review-bounded contract markers — must not accidentally match the narrow lane.
    "Please review these findings and classify them for me before I merge.",
    // Near-miss: mentions an anti-pattern casually, no fixed contract markers.
    "Review this file and detect any anti-patterns you can find.",
    // Near-miss: asks about output shape casually, no fixed contract markers.
    "Can you review whether this response's shape matches what we expect?",
  ];

  it.each(openEndedAsks)("does NOT classify %j as review-bounded", (ask) => {
    const c = classifyTask(ask);
    expect(c.taskType).not.toBe(REVIEW_BOUNDED_TASK_TYPE);
  });

  it("the unambiguous whole-PR asks still classify as code-review", () => {
    expect(classifyTask(openEndedAsks[0]!).taskType).toBe("code-review");
    expect(classifyTask(openEndedAsks[2]!).taskType).toBe("code-review");
  });
});

describe("routing table: code-review remains an unaffected frontier-escalation gap type (#74)", () => {
  it("code-review is still present in the on-disk escalate-to-frontier set", () => {
    expect(loadRoutingTable().escalateToFrontier).toContain("code-review");
  });

  it("review-bounded is absent from the on-disk table (no evidence yet — fallthrough, never a forced route)", () => {
    const table = loadRoutingTable();
    expect(table.routing[REVIEW_BOUNDED_TASK_TYPE]).toBeUndefined();
    expect(table.escalateToFrontier).not.toContain(REVIEW_BOUNDED_TASK_TYPE);
  });
});
