/**
 * Issue #74 — reviewer-usefulness evidence recording.
 *
 * Wires INTO the existing delegation ledger rather than a parallel store: local model, tokens, and
 * verifier outcome are already columns on the `delegations` row (recordDelegation); delegator model
 * + cost already join via `delegation_costs.delegation_id` (delegation-cost.ts, unchanged here).
 * This adds the one missing dimension — a REVIEWER's after-the-fact usefulness judgment
 * (pass|partial|redo|wrong), which can legitimately disagree with the deterministic verifier
 * `outcome` — as an update to the SAME row, addressed by the same ledger id `recordDelegation`
 * already returns.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../src/db.js";
import { recordDelegation, recordReviewerUsefulness, getDelegationById } from "../src/homeserver/ledger.js";

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "hs-ledger-reviewer-usefulness-test-"));
  initDb(join(dir, "test.db"));
});

describe("recordReviewerUsefulness (#74)", () => {
  it("a fresh delegation row has no reviewer usefulness yet", () => {
    const id = recordDelegation({
      taskType: "review-bounded",
      modelId: "qwen3-coder-next-80b",
      prompt: "gille review-bounded contract v1 ...",
      outcome: "pass",
      promptTokens: 500,
      completionTokens: 40,
      verifier: "reviewBoundedVerifier",
    });
    const row = getDelegationById(id);
    expect(row?.reviewerUsefulness).toBeNull();
    expect(row?.reviewerUsefulnessNotes).toBeNull();
    expect(row?.reviewerUsefulnessBy).toBeNull();
    expect(row?.reviewerUsefulnessTs).toBeNull();
  });

  it("records a usefulness verdict and it is readable back by ledger id", () => {
    const id = recordDelegation({
      taskType: "review-bounded",
      modelId: "qwen3-coder-next-80b",
      prompt: "gille review-bounded contract v1 ...",
      outcome: "pass",
      verifier: "reviewBoundedVerifier",
    });
    const changed = recordReviewerUsefulness({
      ledgerId: id,
      usefulness: "pass",
      notes: "confirmed correct on validation — see gille-inference#25",
      judgedBy: "grimnir-session-2026-07-24",
    });
    expect(changed).toBe(true);
    const row = getDelegationById(id);
    expect(row?.reviewerUsefulness).toBe("pass");
    expect(row?.reviewerUsefulnessNotes).toContain("gille-inference#25");
    expect(row?.reviewerUsefulnessBy).toBe("grimnir-session-2026-07-24");
    expect(row?.reviewerUsefulnessTs).not.toBeNull();
  });

  it("the reviewer's usefulness verdict may legitimately disagree with the deterministic verifier outcome", () => {
    // A schema-valid ("pass") output can still be judged not useful in practice (e.g. gille-
    // inference#78's whole-patch findings were structurally fine JSON but all four were refuted).
    const id = recordDelegation({
      taskType: "review-bounded",
      modelId: "qwen3-coder-next-80b",
      prompt: "gille review-bounded contract v1 ...",
      outcome: "pass",
      verifier: "reviewBoundedVerifier",
    });
    recordReviewerUsefulness({ ledgerId: id, usefulness: "wrong", notes: "refuted on validation" });
    const row = getDelegationById(id);
    expect(row?.outcome).toBe("pass");
    expect(row?.reviewerUsefulness).toBe("wrong");
  });

  it("a later call overwrites an earlier judgment (current-status field, not an append log)", () => {
    const id = recordDelegation({
      taskType: "review-bounded",
      modelId: "qwen3-coder-next-80b",
      prompt: "gille review-bounded contract v1 ...",
      outcome: "partial",
      verifier: "reviewBoundedVerifier",
    });
    recordReviewerUsefulness({ ledgerId: id, usefulness: "redo" });
    recordReviewerUsefulness({ ledgerId: id, usefulness: "partial", notes: "usable after a small edit" });
    const row = getDelegationById(id);
    expect(row?.reviewerUsefulness).toBe("partial");
    expect(row?.reviewerUsefulnessNotes).toBe("usable after a small edit");
  });

  it("returns false (never throws) for an unknown ledger id", () => {
    expect(recordReviewerUsefulness({ ledgerId: "does-not-exist", usefulness: "pass" })).toBe(false);
  });
});
