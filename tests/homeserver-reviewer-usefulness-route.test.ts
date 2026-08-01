import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../src/db.js";
import { recordDelegation, getDelegationById } from "../src/homeserver/ledger.js";
import { createDirectGatewayHarness, type DirectGatewayHarness } from "./helpers/direct-gateway.js";

let harness: DirectGatewayHarness;
let adminKey = "";
let guestKey = "";
let monitorKey = "";

const DEFAULTS = { rpm: 1000, tpm: 1_000_000, dailyTokenBudget: 0, maxParallel: 2 };
const NOTES = "ref:gille-inference#112 check:manual";

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "hs-reviewer-usefulness-route-test-"));
  initDb(join(dir, "test.db"));

  process.env["HOMESERVER_HOST"] = "127.0.0.1";
  process.env["HOMESERVER_PORT"] = "0";
  delete process.env["HOMESERVER_API_KEYS"];
  delete process.env["HOMESERVER_ADMIN_API_KEYS"];
  delete process.env["HOMESERVER_MONITOR_API_KEYS"];

  const ks = await import("../src/homeserver/keystore.js");
  adminKey = ks.mintKey({ alias: "reviewer-admin", tier: "owner", scope: "admin" }, DEFAULTS).plaintextKey;
  guestKey = ks.mintKey({ alias: "reviewer-guest", tier: "guest" }, DEFAULTS).plaintextKey;
  monitorKey = ks.mintKey({ alias: "reviewer-monitor", tier: "guest", scope: "monitor" }, DEFAULTS).plaintextKey;

  harness = createDirectGatewayHarness();
});

interface ReviewerUsefulnessWriteResponse {
  ledgerId: string;
  taskType: string;
  reviewerUsefulness: "pass" | "partial" | "redo" | "wrong";
  reviewerIdentity: string;
  reviewerUsefulnessTs: string;
  notesPresent: boolean;
  noteChars: number;
  writeState: "recorded" | "unchanged";
}

function makeReviewBoundedRow(): string {
  return recordDelegation({
    taskType: "review-bounded",
    modelId: "qwen3-coder-next-80b",
    prompt: "gille review-bounded contract v1 ...",
    outcome: "pass",
    verifier: "reviewBoundedVerifier",
    source: "gateway",
  });
}

function makeNonReviewRow(): string {
  return recordDelegation({
    taskType: "summarize",
    modelId: "qwen3-coder-next-80b",
    prompt: "summarize this",
    outcome: "pass",
    verifier: "jsonValid",
    source: "gateway",
  });
}

async function putReviewerUsefulness(
  ledgerId: string,
  body: string | Record<string, unknown>,
  token?: string
) {
  return harness.invoke({
    method: "PUT",
    path: `/ledger/${ledgerId}/reviewer-usefulness`,
    token,
    headers: { "content-type": "application/json" },
    body,
  });
}

describe("PUT /ledger/:id/reviewer-usefulness", () => {
  it("records reviewer usefulness for a review-bounded row, stamps the authenticated reviewer identity, and does not echo notes", async () => {
    const ledgerId = makeReviewBoundedRow();
    const res = await putReviewerUsefulness(ledgerId, {
      usefulness: "pass",
      notes: NOTES,
    }, adminKey);
    expect(res.status).toBe(201);
    const body = res.json as ReviewerUsefulnessWriteResponse;
    expect(body).toMatchObject({
      ledgerId,
      taskType: "review-bounded",
      reviewerUsefulness: "pass",
      reviewerIdentity: "reviewer-admin",
      notesPresent: true,
      noteChars: NOTES.length,
      writeState: "recorded",
    });
    expect(body.reviewerUsefulnessTs).toMatch(/Z$/);
    expect(res.text).not.toContain(NOTES);

    const row = getDelegationById(ledgerId);
    expect(row?.reviewerUsefulness).toBe("pass");
    expect(row?.reviewerUsefulnessBy).toBe("reviewer-admin");
    expect(row?.reviewerUsefulnessNotes).toBe(NOTES);
    expect(row?.reviewerUsefulnessTs).toBe(body.reviewerUsefulnessTs);
  });

  it("treats an exact retry as idempotent and preserves the original timestamp", async () => {
    const ledgerId = makeReviewBoundedRow();
    const first = await putReviewerUsefulness(ledgerId, {
      usefulness: "partial",
      notes: NOTES,
    }, adminKey);
    expect(first.status).toBe(201);
    const firstBody = first.json as ReviewerUsefulnessWriteResponse;

    const second = await putReviewerUsefulness(ledgerId, {
      usefulness: "partial",
      notes: NOTES,
    }, adminKey);
    expect(second.status).toBe(200);
    const secondBody = second.json as ReviewerUsefulnessWriteResponse;
    expect(secondBody.writeState).toBe("unchanged");
    expect(secondBody.reviewerUsefulnessTs).toBe(firstBody.reviewerUsefulnessTs);

    const row = getDelegationById(ledgerId);
    expect(row?.reviewerUsefulness).toBe("partial");
    expect(row?.reviewerUsefulnessTs).toBe(firstBody.reviewerUsefulnessTs);
  });

  it("fails closed on a conflicting overwrite and does not leak notes in the conflict response", async () => {
    const ledgerId = makeReviewBoundedRow();
    await putReviewerUsefulness(ledgerId, {
      usefulness: "pass",
      notes: NOTES,
    }, adminKey);

    const conflicting = await putReviewerUsefulness(ledgerId, {
      usefulness: "wrong",
      notes: "ref:gille-inference#112 verdict:refuted",
    }, adminKey);
    expect(conflicting.status).toBe(409);
    const body = conflicting.json as {
      error: {
        code: string;
        message: string;
      };
    };
    expect(body.error.code).toBe("reviewer_usefulness_conflict");
    expect(body.error.message).toContain("Exact retries are idempotent");
    expect(body.error.message).toContain("reviewer-admin");
    expect(body.error.message).toContain("pass");
    expect(conflicting.text).not.toContain(NOTES);
    expect(conflicting.text).not.toContain("ref:gille-inference#112 verdict:refuted");

    const row = getDelegationById(ledgerId);
    expect(row?.reviewerUsefulness).toBe("pass");
    expect(row?.reviewerUsefulnessNotes).toBe(NOTES);
  });

  it("rejects malformed or non-content-blind / bounded input", async () => {
    const ledgerId = makeReviewBoundedRow();
    const invalidJson = await putReviewerUsefulness(ledgerId, "{", adminKey);
    expect(invalidJson.status).toBe(400);
    expect(invalidJson.json as { error: { message: string } }).toMatchObject({
      error: { message: "Request body must be valid JSON." },
    });

    const invalidCases = [
      { usefulness: "helpful", notes: NOTES },
      { usefulness: "pass", notes: "this is free text" },
      { usefulness: "pass", notes: `ref:${"a".repeat(200)}` },
      { usefulness: "pass", notes: NOTES, judgedBy: "caller-supplied" },
    ];
    for (const body of invalidCases) {
      const res = await putReviewerUsefulness(ledgerId, body, adminKey);
      expect(res.status).toBe(400);
      const payload = res.json as { error: { code: string } };
      expect(payload.error.code).toBe("invalid_request_error");
    }
  });

  it("404s for an unknown ledger id", async () => {
    const res = await putReviewerUsefulness("no-such-ledger-id", {
      usefulness: "pass",
      notes: NOTES,
    }, adminKey);
    expect(res.status).toBe(404);
    expect(res.json as { error: { code: string } }).toMatchObject({
      error: { code: "not_found" },
    });
  });

  it("rejects a ledger row that is not review-bounded", async () => {
    const ledgerId = makeNonReviewRow();
    const res = await putReviewerUsefulness(ledgerId, {
      usefulness: "pass",
      notes: NOTES,
    }, adminKey);
    expect(res.status).toBe(409);
    const body = res.json as { error: { code: string; message: string } };
    expect(body.error.code).toBe("reviewer_usefulness_conflict");
    expect(body.error.message).toContain("review-bounded");
    expect(body.error.message).toContain("summarize");
    expect(getDelegationById(ledgerId)?.reviewerUsefulness).toBeNull();
  });

  it("stays owner-authenticated: unauthenticated, guest, and monitor callers cannot write", async () => {
    const ledgerId = makeReviewBoundedRow();

    const unauthenticated = await putReviewerUsefulness(ledgerId, { usefulness: "pass", notes: NOTES });
    expect(unauthenticated.status).toBe(401);

    const guest = await putReviewerUsefulness(ledgerId, { usefulness: "pass", notes: NOTES }, guestKey);
    expect(guest.status).toBe(403);

    const monitor = await putReviewerUsefulness(ledgerId, { usefulness: "pass", notes: NOTES }, monitorKey);
    expect(monitor.status).toBe(403);

    expect(getDelegationById(ledgerId)?.reviewerUsefulness).toBeNull();
  });
});
