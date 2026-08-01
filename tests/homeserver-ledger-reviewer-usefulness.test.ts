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
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { initDb } from "../src/db.js";
import {
  recordDelegation,
  recordReviewerUsefulness,
  getDelegationById,
  type ReviewerUsefulnessResult,
} from "../src/homeserver/ledger.js";

const REVIEWER_USEFULNESS_WORKER = fileURLToPath(
  new URL("./fixtures/reviewer-usefulness-worker.ts", import.meta.url)
);
let dbPath = "";

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "hs-ledger-reviewer-usefulness-test-"));
  dbPath = join(dir, "test.db");
  initDb(dbPath);
});

function runReviewerUsefulnessWorker(args: {
  ledgerId: string;
  usefulness: "pass" | "partial" | "redo" | "wrong";
  judgedBy: string;
  notes: string | null;
  startAtMs: number;
}): Promise<ReviewerUsefulnessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--import",
      "tsx",
      REVIEWER_USEFULNESS_WORKER,
      dbPath,
      String(args.startAtMs),
      args.ledgerId,
      args.usefulness,
      args.judgedBy,
      args.notes ?? "__NULL__",
    ], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`reviewer usefulness worker exited ${code}: ${stderr || stdout}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as ReviewerUsefulnessResult);
      } catch (err) {
        reject(new Error(`reviewer usefulness worker emitted invalid JSON: ${stdout}\n${String(err)}`));
      }
    });
  });
}

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
        mismatchFields: ["reviewerUsefulness", "reviewerIdentity", "notes"],
      },
    });
    const row = getDelegationById(id);
    expect(row?.reviewerUsefulness).toBe("redo");
    expect(row?.reviewerUsefulnessNotes).toBeNull();
  });

  it("rejects review-bounded rows that have no verifier yet", () => {
    const id = recordDelegation({
      taskType: "review-bounded",
      modelId: "qwen3-coder-next-80b",
      prompt: "gille review-bounded contract v1 ...",
      outcome: "pass",
    });
    expect(recordReviewerUsefulness({
      ledgerId: id,
      usefulness: "pass",
      judgedBy: "grimnir-session-2026-07-24",
    })).toMatchObject({
      kind: "conflict",
      conflict: { kind: "missing_verifier" },
    });
  });

  it("fails closed on legacy partially populated reviewer-usefulness columns", () => {
    const id = recordDelegation({
      taskType: "review-bounded",
      modelId: "qwen3-coder-next-80b",
      prompt: "gille review-bounded contract v1 ...",
      outcome: "pass",
      verifier: "reviewBoundedVerifier",
    });
    const db = initDb(dbPath);
    db.prepare(`
      UPDATE delegations
         SET reviewer_usefulness = @usefulness,
             reviewer_usefulness_notes = @notes,
             reviewer_usefulness_by = @judgedBy,
             reviewer_usefulness_ts = NULL
       WHERE id = @id
    `).run({
      usefulness: "pass",
      notes: "ref:gille-inference#112 check:manual",
      judgedBy: "grimnir-session-2026-07-24",
      id,
    });

    expect(recordReviewerUsefulness({
      ledgerId: id,
      usefulness: "pass",
      notes: "ref:gille-inference#112 check:manual",
      judgedBy: "grimnir-session-2026-07-24",
    })).toMatchObject({
      kind: "conflict",
      conflict: {
        kind: "already_recorded",
        mismatchFields: [],
      },
    });
  });

  it("keeps exact concurrent double-writers idempotent on the real SQLite path", async () => {
    const id = recordDelegation({
      taskType: "review-bounded",
      modelId: "qwen3-coder-next-80b",
      prompt: "gille review-bounded contract v1 ...",
      outcome: "pass",
      verifier: "reviewBoundedVerifier",
    });
    const startAtMs = Date.now() + 500;
    const [a, b] = await Promise.all([
      runReviewerUsefulnessWorker({
        ledgerId: id,
        usefulness: "pass",
        judgedBy: "grimnir-session-2026-07-24",
        notes: "ref:gille-inference#112 check:manual",
        startAtMs,
      }),
      runReviewerUsefulnessWorker({
        ledgerId: id,
        usefulness: "pass",
        judgedBy: "grimnir-session-2026-07-24",
        notes: "ref:gille-inference#112 check:manual",
        startAtMs,
      }),
    ]);

    expect([a.kind, b.kind].sort()).toEqual(["recorded", "unchanged"]);
    expect(getDelegationById(id)).toMatchObject({
      reviewerUsefulness: "pass",
      reviewerUsefulnessBy: "grimnir-session-2026-07-24",
      reviewerUsefulnessNotes: "ref:gille-inference#112 check:manual",
    });
  });

  it("serializes genuine conflicting double-writers so only one durable verdict lands", async () => {
    const id = recordDelegation({
      taskType: "review-bounded",
      modelId: "qwen3-coder-next-80b",
      prompt: "gille review-bounded contract v1 ...",
      outcome: "pass",
      verifier: "reviewBoundedVerifier",
    });
    const startAtMs = Date.now() + 500;
    const [a, b] = await Promise.all([
      runReviewerUsefulnessWorker({
        ledgerId: id,
        usefulness: "pass",
        judgedBy: "grimnir-session-2026-07-24-a",
        notes: "ref:gille-inference#112 check:manual",
        startAtMs,
      }),
      runReviewerUsefulnessWorker({
        ledgerId: id,
        usefulness: "wrong",
        judgedBy: "grimnir-session-2026-07-24-b",
        notes: "ref:gille-inference#112 verdict:refuted",
        startAtMs,
      }),
    ]);

    expect([a.kind, b.kind].sort()).toEqual(["conflict", "recorded"]);
    const row = getDelegationById(id);
    expect(row?.reviewerUsefulness === "pass" || row?.reviewerUsefulness === "wrong").toBe(true);
    if (row?.reviewerUsefulness === "pass") {
      expect(row.reviewerUsefulnessBy).toBe("grimnir-session-2026-07-24-a");
      expect(row.reviewerUsefulnessNotes).toBe("ref:gille-inference#112 check:manual");
    } else {
      expect(row?.reviewerUsefulnessBy).toBe("grimnir-session-2026-07-24-b");
      expect(row?.reviewerUsefulnessNotes).toBe("ref:gille-inference#112 verdict:refuted");
    }
  });

  it("returns a closed not_found result for an unknown ledger id", () => {
    expect(recordReviewerUsefulness({
      ledgerId: "does-not-exist",
      usefulness: "pass",
      judgedBy: "grimnir-session-2026-07-24",
    })).toMatchObject({ kind: "not_found" });
  });

  it("initializes the delegations schema on each fresh Database object in one process", () => {
    const firstDir = mkdtempSync(join(tmpdir(), "hs-ledger-reviewer-usefulness-first-"));
    initDb(join(firstDir, "first.db"));
    const firstId = recordDelegation({
      taskType: "review-bounded",
      modelId: "qwen3-coder-next-80b",
      prompt: "gille review-bounded contract v1 ...",
      outcome: "pass",
      verifier: "reviewBoundedVerifier",
    });
    expect(getDelegationById(firstId)?.reviewerUsefulness).toBeNull();

    const secondDir = mkdtempSync(join(tmpdir(), "hs-ledger-reviewer-usefulness-second-"));
    const secondPath = join(secondDir, "second.db");
    initDb(secondPath);
    const secondId = recordDelegation({
      taskType: "review-bounded",
      modelId: "qwen3-coder-next-80b",
      prompt: "gille review-bounded contract v1 ...",
      outcome: "pass",
      verifier: "reviewBoundedVerifier",
    });
    expect(recordReviewerUsefulness({
      ledgerId: secondId,
      usefulness: "pass",
      judgedBy: "grimnir-session-2026-07-24",
    })).toMatchObject({
      kind: "recorded",
      taskType: "review-bounded",
    });

    initDb(dbPath);
  });
});
