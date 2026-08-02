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
  importDelegations,
  importId,
  type ReviewerUsefulnessResult,
} from "../src/homeserver/ledger.js";
import { buildVerifier, isVerifierBuildError } from "../src/homeserver/verifier-registry.js";

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

function gatewayVerifierName(spec: Record<string, unknown>): string {
  const built = buildVerifier(spec);
  if (isVerifierBuildError(built)) throw new Error(`invalid test verifier spec: ${built.error}`);
  return built.name;
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
    expect(row?.reviewerUsefulnessHidden).toBe(false);
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

  it.each(["none", "none(ungraded)", "   "])(
    "rejects review-bounded rows with the ungraded verifier sentinel %j",
    (verifier) => {
      const id = recordDelegation({
        taskType: "review-bounded",
        modelId: "qwen3-coder-next-80b",
        prompt: "gille review-bounded contract v1 ...",
        outcome: "unverified",
        verifier,
      });

      expect(recordReviewerUsefulness({
        ledgerId: id,
        usefulness: "pass",
        judgedBy: "grimnir-session-2026-07-24",
      })).toMatchObject({
        kind: "conflict",
        conflict: { kind: "missing_verifier" },
      });
    },
  );

  it("rejects an unverified row even with an exact verifier without mutating it", () => {
    const id = recordDelegation({
      taskType: "review-bounded",
      modelId: "qwen3-coder-next-80b",
      prompt: "gille review-bounded contract v1 ...",
      outcome: "unverified",
      verifier: gatewayVerifierName({ type: "exact", expected: "{\"ok\":true}" }),
    });
    const db = initDb(dbPath);
    const before = db.prepare(`
      SELECT reviewer_usefulness AS reviewerUsefulness,
             reviewer_usefulness_notes AS reviewerUsefulnessNotes,
             reviewer_usefulness_by AS reviewerUsefulnessBy,
             reviewer_usefulness_ts AS reviewerUsefulnessTs,
             reviewer_usefulness_legacy_json AS legacyJson,
             reviewer_usefulness_legacy_reason AS legacyReason,
             reviewer_usefulness_legacy_quarantined_at AS legacyQuarantinedAt
        FROM delegations
       WHERE id = ?
    `).get(id);

    expect(recordReviewerUsefulness({
      ledgerId: id,
      usefulness: "pass",
      judgedBy: "grimnir-session-2026-07-24",
    })).toMatchObject({
      kind: "conflict",
      conflict: { kind: "missing_verifier" },
    });

    expect(db.prepare(`
      SELECT reviewer_usefulness AS reviewerUsefulness,
             reviewer_usefulness_notes AS reviewerUsefulnessNotes,
             reviewer_usefulness_by AS reviewerUsefulnessBy,
             reviewer_usefulness_ts AS reviewerUsefulnessTs,
             reviewer_usefulness_legacy_json AS legacyJson,
             reviewer_usefulness_legacy_reason AS legacyReason,
             reviewer_usefulness_legacy_quarantined_at AS legacyQuarantinedAt
        FROM delegations
       WHERE id = ?
    `).get(id)).toEqual(before);
    expect(getDelegationById(id)).toMatchObject({
      reviewerUsefulness: null,
      reviewerUsefulnessNotes: null,
      reviewerUsefulnessBy: null,
      reviewerUsefulnessTs: null,
      reviewerUsefulnessHidden: false,
    });
  });

  it("hides pre-existing reviewer usefulness on an unverified exact row", () => {
    const id = recordDelegation({
      taskType: "review-bounded",
      modelId: "qwen3-coder-next-80b",
      prompt: "gille review-bounded contract v1 ...",
      outcome: "unverified",
      verifier: gatewayVerifierName({ type: "exact", expected: "{\"ok\":true}" }),
    });
    const db = initDb(dbPath);
    const notes = "ref:gille-inference#112 hidden:unverified";
    db.prepare(`
      UPDATE delegations
         SET reviewer_usefulness = 'wrong',
             reviewer_usefulness_notes = @notes,
             reviewer_usefulness_by = 'grimnir-session-2026-07-24-unverified',
             reviewer_usefulness_ts = '2026-08-01T10:00:00.000Z'
       WHERE id = @id
    `).run({ id, notes });

    expect(getDelegationById(id)).toMatchObject({
      reviewerUsefulness: null,
      reviewerUsefulnessNotes: null,
      reviewerUsefulnessBy: null,
      reviewerUsefulnessTs: null,
      reviewerUsefulnessHidden: true,
      reviewerUsefulnessNotesPresent: true,
      reviewerUsefulnessNoteChars: notes.length,
    });
  });

  it.each(["pass", "partial", "fail", "error"] as const)(
    "keeps %s graded rows eligible with an exact verifier",
    (outcome) => {
      const id = recordDelegation({
        taskType: "review-bounded",
        modelId: "qwen3-coder-next-80b",
        prompt: "gille review-bounded contract v1 ...",
        outcome,
        verifier: gatewayVerifierName({ type: "exact", expected: "{\"ok\":true}" }),
      });
      expect(recordReviewerUsefulness({
        ledgerId: id,
        usefulness: "pass",
        judgedBy: "grimnir-session-2026-07-24",
      })).toMatchObject({
        kind: "recorded",
        taskType: "review-bounded",
      });
    },
  );

  it("requires a genuine grade: gateway-built exact passes, gateway-built nonEmpty(0) does not", () => {
    const exactId = recordDelegation({
      taskType: "review-bounded",
      modelId: "qwen3-coder-next-80b",
      prompt: "gille review-bounded contract v1 ...",
      outcome: "pass",
      verifier: gatewayVerifierName({ type: "exact", expected: "{\"ok\":true}" }),
    });
    expect(recordReviewerUsefulness({
      ledgerId: exactId,
      usefulness: "pass",
      judgedBy: "grimnir-session-2026-07-24",
    })).toMatchObject({
      kind: "recorded",
      taskType: "review-bounded",
    });

    const nonEmptyId = recordDelegation({
      taskType: "review-bounded",
      modelId: "qwen3-coder-next-80b",
      prompt: "gille review-bounded contract v1 ...",
      outcome: "pass",
      verifier: gatewayVerifierName({ type: "nonEmpty", minLen: 0 }),
    });
    expect(recordReviewerUsefulness({
      ledgerId: nonEmptyId,
      usefulness: "pass",
      judgedBy: "grimnir-session-2026-07-24",
    })).toMatchObject({
      kind: "conflict",
      conflict: { kind: "missing_verifier" },
    });
  });

  it.each([
    ["none+NONE(ungraded)", "conflict"],
    ["nonEmpty+jsonValid", "conflict"],
    ["nonEmpty+predicate", "recorded"],
  ] as const)("applies the shared quality predicate to combined verifier %s", (verifier, expectedKind) => {
    const id = recordDelegation({
      taskType: "review-bounded",
      modelId: "qwen3-coder-next-80b",
      prompt: "gille review-bounded contract v1 combined verifier",
      outcome: "pass",
      verifier,
    });

    const result = recordReviewerUsefulness({
      ledgerId: id,
      usefulness: "pass",
      judgedBy: "grimnir-session-2026-07-24",
    });
    expect(result.kind).toBe(expectedKind);
    if (expectedKind === "conflict") {
      expect(result).toMatchObject({ conflict: { kind: "missing_verifier" } });
      expect(getDelegationById(id)?.reviewerUsefulness).toBeNull();
    } else {
      expect(getDelegationById(id)?.reviewerUsefulness).toBe("pass");
    }
  });

  it.each(["none+NONE(ungraded)", "nonEmpty+jsonValid"] as const)(
    "hides pre-existing usefulness for ineligible combined verifier %s",
    (verifier) => {
      const id = recordDelegation({
        taskType: "review-bounded",
        modelId: "qwen3-coder-next-80b",
        prompt: "gille review-bounded contract v1 hidden combined verifier",
        outcome: "pass",
        verifier,
      });
      const db = initDb(dbPath);
      const notes = "ref:gille-inference#112 hidden:combined-verifier";
      db.prepare(`
        UPDATE delegations
           SET reviewer_usefulness = 'wrong',
               reviewer_usefulness_notes = @notes,
               reviewer_usefulness_by = 'grimnir-session-2026-07-24-hidden-combined',
               reviewer_usefulness_ts = '2026-08-01T10:00:00.000Z'
         WHERE id = @id
      `).run({ id, notes });

      expect(getDelegationById(id)).toMatchObject({
        reviewerUsefulness: null,
        reviewerUsefulnessNotes: null,
        reviewerUsefulnessBy: null,
        reviewerUsefulnessTs: null,
        reviewerUsefulnessHidden: true,
        reviewerUsefulnessNotesPresent: true,
        reviewerUsefulnessNoteChars: notes.length,
      });
    },
  );

  it("rejects imported free-text sentinel and structural verifier variants", () => {
    const noneImported = {
      ts: "2026-07-30T09:00:00.000Z",
      taskType: "review-bounded",
      modelId: "qwen3-coder-next-80b",
      prompt: "gille review-bounded contract v1 import none",
      outcome: "pass" as const,
      verifier: " None ",
      source: "probe-import",
    };
    importDelegations([noneImported]);
    expect(recordReviewerUsefulness({
      ledgerId: importId(noneImported),
      usefulness: "pass",
      judgedBy: "grimnir-session-2026-07-24",
    })).toMatchObject({
      kind: "conflict",
      conflict: { kind: "missing_verifier" },
    });

    const structuralImported = {
      ts: "2026-07-30T09:05:00.000Z",
      taskType: "review-bounded",
      modelId: "qwen3-coder-next-80b",
      prompt: "gille review-bounded contract v1 import structural",
      outcome: "pass" as const,
      verifier: " nonEmpty(0) ",
      source: "probe-import",
    };
    importDelegations([structuralImported]);
    expect(recordReviewerUsefulness({
      ledgerId: importId(structuralImported),
      usefulness: "pass",
      judgedBy: "grimnir-session-2026-07-24",
    })).toMatchObject({
      kind: "conflict",
      conflict: { kind: "missing_verifier" },
    });
  });

  it("rejects shadow and superseded rows before recording usefulness", () => {
    const shadowId = recordDelegation({
      taskType: "review-bounded",
      modelId: "qwen3-coder-next-80b",
      prompt: "gille review-bounded contract v1 ...",
      outcome: "pass",
      verifier: gatewayVerifierName({ type: "exact", expected: "{\"ok\":true}" }),
      shadow: true,
    });
    expect(recordReviewerUsefulness({
      ledgerId: shadowId,
      usefulness: "pass",
      judgedBy: "grimnir-session-2026-07-24",
    })).toMatchObject({
      kind: "conflict",
      conflict: { kind: "shadow" },
    });

    const supersededId = recordDelegation({
      taskType: "review-bounded",
      modelId: "qwen3-coder-next-80b",
      prompt: "gille review-bounded contract v1 ...",
      outcome: "pass",
      verifier: gatewayVerifierName({ type: "exact", expected: "{\"ok\":true}" }),
    });
    initDb(dbPath).prepare(`
      UPDATE delegations
         SET superseded_at = '2026-07-31T10:00:00.000Z'
       WHERE id = ?
    `).run(supersededId);
    expect(recordReviewerUsefulness({
      ledgerId: supersededId,
      usefulness: "pass",
      judgedBy: "grimnir-session-2026-07-24",
    })).toMatchObject({
      kind: "conflict",
      conflict: { kind: "superseded" },
    });
  });

  it("hides previously recorded reviewer usefulness once the row is superseded", () => {
    const id = recordDelegation({
      taskType: "review-bounded",
      modelId: "qwen3-coder-next-80b",
      prompt: "gille review-bounded contract v1 ...",
      outcome: "pass",
      verifier: gatewayVerifierName({ type: "exact", expected: "{\"ok\":true}" }),
    });
    expect(recordReviewerUsefulness({
      ledgerId: id,
      usefulness: "pass",
      notes: "ref:gille-inference#112 check:manual",
      judgedBy: "grimnir-session-2026-07-24",
    })).toMatchObject({
      kind: "recorded",
      record: {
        reviewerUsefulness: "pass",
        notesPresent: true,
      },
    });

    initDb(dbPath).prepare(`
      UPDATE delegations
         SET superseded_at = '2026-08-01T10:00:00.000Z'
       WHERE id = ?
    `).run(id);

    expect(getDelegationById(id)).toMatchObject({
      reviewerUsefulness: null,
      reviewerUsefulnessNotes: null,
      reviewerUsefulnessBy: null,
      reviewerUsefulnessTs: null,
      reviewerUsefulnessHidden: true,
      reviewerUsefulnessNotesPresent: true,
      reviewerUsefulnessNoteChars: "ref:gille-inference#112 check:manual".length,
    });
  });

  it("does not treat legacy partially populated reviewer-usefulness columns as a current recorded verdict", () => {
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

    expect(getDelegationById(id)).toMatchObject({
      reviewerUsefulness: null,
      reviewerUsefulnessNotes: null,
      reviewerUsefulnessBy: null,
      reviewerUsefulnessTs: null,
      reviewerUsefulnessHidden: true,
    });
  });

  it("marks populated reviewer usefulness on a now-ineligible row as hidden instead of silently disappearing", () => {
    const id = recordDelegation({
      taskType: "review-bounded",
      modelId: "qwen3-coder-next-80b",
      prompt: "gille review-bounded contract v1 ...",
      outcome: "pass",
      verifier: gatewayVerifierName({ type: "exact", expected: "{\"ok\":true}" }),
    });
    const db = initDb(dbPath);
    db.prepare(`
      UPDATE delegations
         SET task_type = 'summarize',
             reviewer_usefulness = @usefulness,
             reviewer_usefulness_notes = @notes,
             reviewer_usefulness_by = @judgedBy,
             reviewer_usefulness_ts = @ts
       WHERE id = @id
    `).run({
      usefulness: "wrong",
      notes: "ref:gille-inference#112 hidden:legacy",
      judgedBy: "grimnir-session-2026-07-24-hidden",
      ts: "2026-08-01T10:00:00.000Z",
      id,
    });

    expect(getDelegationById(id)).toMatchObject({
      reviewerUsefulness: null,
      reviewerUsefulnessNotes: null,
      reviewerUsefulnessBy: null,
      reviewerUsefulnessTs: null,
      reviewerUsefulnessHidden: true,
      reviewerUsefulnessNotesPresent: true,
      reviewerUsefulnessNoteChars: "ref:gille-inference#112 hidden:legacy".length,
    });
  });

  it("quarantines malformed legacy reviewer-usefulness columns and allows a later first valid write", () => {
    const id = recordDelegation({
      taskType: "review-bounded",
      modelId: "qwen3-coder-next-80b",
      prompt: "gille review-bounded contract v1 ...",
      outcome: "pass",
      verifier: gatewayVerifierName({ type: "exact", expected: "{\"ok\":true}" }),
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
      usefulness: "wrong",
      notes: "ref:gille-inference#112 legacy:partial",
      judgedBy: "grimnir-session-2026-07-24-legacy",
      id,
    });

    expect(getDelegationById(id)).toMatchObject({
      reviewerUsefulness: null,
      reviewerUsefulnessNotes: null,
      reviewerUsefulnessBy: null,
      reviewerUsefulnessTs: null,
      reviewerUsefulnessHidden: true,
    });

    expect(recordReviewerUsefulness({
      ledgerId: id,
      usefulness: "partial",
      notes: "ref:gille-inference#112 check:manual",
      judgedBy: "grimnir-session-2026-07-24",
    })).toMatchObject({
      kind: "recorded",
      record: {
        reviewerUsefulness: "partial",
        reviewerUsefulnessBy: "grimnir-session-2026-07-24",
      },
    });

    const repaired = db.prepare(`
      SELECT reviewer_usefulness AS reviewerUsefulness,
             reviewer_usefulness_notes AS reviewerUsefulnessNotes,
             reviewer_usefulness_by AS reviewerUsefulnessBy,
             reviewer_usefulness_ts AS reviewerUsefulnessTs,
             reviewer_usefulness_legacy_json AS legacyJson,
             reviewer_usefulness_legacy_reason AS legacyReason,
             reviewer_usefulness_legacy_quarantined_at AS legacyQuarantinedAt
        FROM delegations
       WHERE id = ?
    `).get(id) as {
      reviewerUsefulness: string | null;
      reviewerUsefulnessNotes: string | null;
      reviewerUsefulnessBy: string | null;
      reviewerUsefulnessTs: string | null;
      legacyJson: string | null;
      legacyReason: string | null;
      legacyQuarantinedAt: string | null;
    };

    expect(repaired.reviewerUsefulness).toBe("partial");
    expect(repaired.reviewerUsefulnessNotes).toBe("ref:gille-inference#112 check:manual");
    expect(repaired.reviewerUsefulnessBy).toBe("grimnir-session-2026-07-24");
    expect(repaired.reviewerUsefulnessTs).not.toBeNull();
    expect(repaired.legacyReason).toBe("malformed_live_columns");
    expect(repaired.legacyQuarantinedAt).not.toBeNull();
    expect(JSON.parse(repaired.legacyJson ?? "null")).toMatchObject({
      reviewerUsefulness: "wrong",
      reviewerUsefulnessNotes: "ref:gille-inference#112 legacy:partial",
      reviewerUsefulnessBy: "grimnir-session-2026-07-24-legacy",
      reviewerUsefulnessTs: null,
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
