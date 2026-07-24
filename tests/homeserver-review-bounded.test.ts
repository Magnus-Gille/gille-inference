/**
 * Issue #74 — review-bounded prompt contract, structured-output schema, and verifier.
 *
 * "Structured output must be machine-checkable, not prose, so usefulness can be scored
 * automatically" is the ticket's core requirement. This file proves that end to end against the
 * checked-in evaluation set (tests/fixtures/review-bounded/eval-set.json): the EXACT expected
 * output grades as `pass`, and a deliberately-wrong candidate never does — with no frontier judge
 * anywhere in the loop.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyTask } from "../src/homeserver/taxonomy.js";
import {
  REVIEW_BOUNDED_TASK_TYPE,
  REVIEW_BOUNDED_CONTRACT_MARKER,
  REVIEW_BOUNDED_SCHEMA_MARKER,
  subtaskKindMarker,
  buildReviewBoundedPrompt,
  parseReviewBoundedOutput,
  reviewBoundedVerifier,
  reviewLaneCapability,
  type ReviewBoundedOutput,
  type ReviewBoundedSubtaskKind,
} from "../src/homeserver/review-bounded.js";

interface EvalEntry {
  id: string;
  subtask: ReviewBoundedSubtaskKind;
  payload: Record<string, unknown>;
  expected: ReviewBoundedOutput;
  wrong_candidate: ReviewBoundedOutput;
}

const evalSet = JSON.parse(
  readFileSync(join(__dirname, "fixtures/review-bounded/eval-set.json"), "utf8")
) as { entries: EvalEntry[] };

describe("review-bounded prompt contract markers", () => {
  it("every builder emits the fixed contract + schema + subtask markers", () => {
    const prompts: [ReviewBoundedSubtaskKind, string][] = [
      [
        "classify-findings",
        buildReviewBoundedPrompt("classify-findings", { diffExcerpt: "x", findings: [{ id: "f1", claim: "c" }] }),
      ],
      [
        "detect-anti-pattern",
        buildReviewBoundedPrompt("detect-anti-pattern", { patternId: "p", patternDescription: "d", codeExcerpt: "x" }),
      ],
      [
        "verify-output-shape",
        buildReviewBoundedPrompt("verify-output-shape", { schemaDescription: "s", candidateOutput: "o" }),
      ],
    ];
    for (const [kind, prompt] of prompts) {
      const lower = prompt.toLowerCase();
      expect(lower).toContain(REVIEW_BOUNDED_CONTRACT_MARKER);
      expect(lower).toContain(REVIEW_BOUNDED_SCHEMA_MARKER);
      expect(lower).toContain(subtaskKindMarker(kind));
    }
  });
});

describe("parseReviewBoundedOutput — exact contract validation", () => {
  it("rejects non-JSON output", () => {
    const r = parseReviewBoundedOutput("classify-findings", "sure, here you go: looks fine to me!");
    expect(r.ok).toBe(false);
  });

  it("rejects a wrong contract version", () => {
    const r = parseReviewBoundedOutput(
      "classify-findings",
      JSON.stringify({ contract: "some-other/v1", subtask: "classify-findings", classifications: [] })
    );
    expect(r.ok).toBe(false);
  });

  it("rejects a mismatched subtask discriminator", () => {
    const r = parseReviewBoundedOutput(
      "classify-findings",
      JSON.stringify({
        contract: "gille-inference.review-bounded/v1",
        subtask: "detect-anti-pattern",
        pattern_id: "x",
        detected: true,
        locations: [],
      })
    );
    expect(r.ok).toBe(false);
  });

  it("accepts a valid classify-findings payload, salvaging a fenced JSON block", () => {
    const raw =
      "Here is my answer:\n```json\n" +
      JSON.stringify({
        contract: "gille-inference.review-bounded/v1",
        subtask: "classify-findings",
        classifications: [{ id: "f1", verdict: "confirmed" }],
      }) +
      "\n```";
    const r = parseReviewBoundedOutput("classify-findings", raw);
    expect(r.ok).toBe(true);
  });
});

describe("review-bounded evaluation set (#74) — exact expected structured outputs", () => {
  it("the fixture file has at least two entries per subtask kind", () => {
    const byKind = new Map<string, number>();
    for (const e of evalSet.entries) byKind.set(e.subtask, (byKind.get(e.subtask) ?? 0) + 1);
    expect(byKind.get("classify-findings")).toBeGreaterThanOrEqual(2);
    expect(byKind.get("detect-anti-pattern")).toBeGreaterThanOrEqual(2);
    expect(byKind.get("verify-output-shape")).toBeGreaterThanOrEqual(2);
  });

  for (const entry of evalSet.entries) {
    describe(`${entry.id} (${entry.subtask})`, () => {
      it("its built prompt routes to review-bounded, not code-review", () => {
        const prompt = buildReviewBoundedPrompt(entry.subtask as "classify-findings", entry.payload as never);
        const c = classifyTask(prompt);
        expect(c.taskType).toBe(REVIEW_BOUNDED_TASK_TYPE);
      });

      it("grades the EXACT expected output as pass", () => {
        const verifier = reviewBoundedVerifier(entry.subtask, entry.expected);
        const result = verifier(JSON.stringify(entry.expected));
        expect(result).not.toBeInstanceOf(Promise);
        const r = result as { outcome: string };
        expect(r.outcome).toBe("pass");
      });

      it("does NOT grade the deliberately-wrong candidate as pass", () => {
        const verifier = reviewBoundedVerifier(entry.subtask, entry.expected);
        const result = verifier(JSON.stringify(entry.wrong_candidate));
        const r = result as { outcome: string };
        expect(r.outcome).not.toBe("pass");
      });
    });
  }
});

describe("reviewLaneCapability (#74 acceptance criterion 4/5)", () => {
  it("review-bounded is local-advisory and NOT promoted by default", () => {
    const cap = reviewLaneCapability(REVIEW_BOUNDED_TASK_TYPE, []);
    expect(cap.eligible).toBe("local-advisory");
    expect(cap.advisoryOnly).toBe(true);
    expect(cap.promoted).toBe(false);
    expect(cap.subtaskKinds).toEqual(["classify-findings", "detect-anti-pattern", "verify-output-shape"]);
  });

  it("review-bounded reports promoted:true once explicitly configured", () => {
    const cap = reviewLaneCapability(REVIEW_BOUNDED_TASK_TYPE, [REVIEW_BOUNDED_TASK_TYPE]);
    expect(cap.promoted).toBe(true);
    expect(cap.advisoryOnly).toBe(false);
  });

  it("code-review stays frontier-only, unaffected", () => {
    const cap = reviewLaneCapability("code-review", []);
    expect(cap.eligible).toBe("frontier-only");
    expect(cap.advisoryOnly).toBe(false);
  });

  it("an unrecognized task type is frontier-only by default (fail closed, no fabricated local lane)", () => {
    const cap = reviewLaneCapability("does-not-exist", []);
    expect(cap.eligible).toBe("frontier-only");
  });
});
