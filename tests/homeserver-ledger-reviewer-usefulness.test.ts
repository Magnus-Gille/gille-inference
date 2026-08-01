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
      notes: "ref:gille-inference#25 check:manual",
      judgedBy: "grimnir-session-2026-07-24",
    });
    expect(changed).toMatchObject({
      kind: "recorded",
      record: {
        reviewerUsefulness: "pass",
        reviewerUsefulnessBy: "grimnir-session-2026-07-24",
        notesPresent: true,
        noteChars: "ref:gille-inference#25 check:manual".length,
      },
    });
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
    recordReviewerUsefulness({
      ledgerId: id,
      usefulness: "wrong",
      notes: "verdict:refuted check:manual",
      judgedBy: "grimnir-session-2026-07-24",
    });
    const row = getDelegationById(id);
    expect(row?.outcome).toBe("pass");
    expect(row?.reviewerUsefulness).toBe("wrong");
  });

  it("treats an exact retry as unchanged but rejects a differing second write", () => {
    const id = recordDelegation({
      taskType: "review-bounded",
      modelId: "qwen3-coder-next-80b",
      prompt: "gille review-bounded contract v1 ...",
      outcome: "partial",
      verifier: "reviewBoundedVerifier",
    });
    expect(recordReviewerUsefulness({
      ledgerId: id,
      usefulness: "redo",
      notes: null,
      judgedBy: "grimnir-session-2026-07-24",
    })).toMatchObject({
      kind: "recorded",
      record: {
        reviewerUsefulness: "redo",
        notesPresent: false,
        noteChars: 0,
      },
    });
    expect(recordReviewerUsefulness({
      ledgerId: id,
      usefulness: "redo",
      notes: null,
      judgedBy: "grimnir-session-2026-07-24",
    })).toMatchObject({
      kind: "unchanged",
      record: {
        reviewerUsefulness: "redo",
        notesPresent: false,
        noteChars: 0,
      },
    });
    expect(recordReviewerUsefulness({
      ledgerId: id,
      usefulness: "partial",
      notes: "check:manual action:edit",
      judgedBy: "grimnir-session-2026-07-24-r2",
    })).toMatchObject({
      kind: "conflict",
      conflict: {
        kind: "already_recorded",
        mismatchFields: ["usefulness", "reviewerIdentity", "notes"],
      },
    });
    const row = getDelegationById(id);
    expect(row?.reviewerUsefulness).toBe("redo");
    expect(row?.reviewerUsefulnessNotes).toBeNull();
  });

  it("returns a closed not_found result for an unknown ledger id", () => {
    expect(recordReviewerUsefulness({
      ledgerId: "does-not-exist",
      usefulness: "pass",
      judgedBy: "grimnir-session-2026-07-24",
    })).toMatchObject({ kind: "not_found" });
  });
});
