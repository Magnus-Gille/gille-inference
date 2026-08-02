import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, initDb } from "../src/db.js";
import { recordDelegation, getDelegationById } from "../src/homeserver/ledger.js";
import { buildVerifier, isVerifierBuildError } from "../src/homeserver/verifier-registry.js";
import { createDirectGatewayHarness, type DirectGatewayHarness } from "./helpers/direct-gateway.js";

let harness: DirectGatewayHarness;
let adminKey = "";
let secondAdminKey = "";
let guestKey = "";
let monitorKey = "";
let ownerMonitorKey = "";
let agentKey = "";

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
  secondAdminKey = ks.mintKey({ alias: "reviewer-admin-r2", tier: "owner", scope: "admin" }, DEFAULTS).plaintextKey;
  guestKey = ks.mintKey({ alias: "reviewer-guest", tier: "guest" }, DEFAULTS).plaintextKey;
  monitorKey = ks.mintKey({ alias: "reviewer-monitor", tier: "guest", scope: "monitor" }, DEFAULTS).plaintextKey;
  ownerMonitorKey = ks.mintKey({ alias: "reviewer-owner-monitor", tier: "owner", scope: "monitor" }, DEFAULTS).plaintextKey;
  agentKey = ks.mintKey({ alias: "reviewer-agent", tier: "owner", scope: "agent" }, DEFAULTS).plaintextKey;

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

interface ReviewerUsefulnessConflictResponse {
  error: {
    code: string;
    message: string;
    type: string;
    param: string | null;
  };
  conflict: {
    kind: string;
    mismatchFields?: string[];
    existing?: {
      reviewerUsefulness: string | null;
      reviewerIdentity: string | null;
      reviewerUsefulnessTs: string | null;
      notesPresent: boolean;
      noteChars: number;
    };
    attempted?: {
      reviewerUsefulness: string;
      reviewerIdentity: string;
      notesPresent: boolean;
      noteChars: number;
    };
    taskType?: string;
  };
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

function gatewayVerifierName(spec: Record<string, unknown>): string {
  const built = buildVerifier(spec);
  if (isVerifierBuildError(built)) throw new Error(`invalid test verifier spec: ${built.error}`);
  return built.name;
}

function makeReviewBoundedRowWithVerifier(verifier: string, overrides: Partial<{
  outcome: "pass" | "partial" | "fail" | "error" | "unverified";
  shadow: boolean;
}> = {}): string {
  return recordDelegation({
    taskType: "review-bounded",
    modelId: "qwen3-coder-next-80b",
    prompt: "gille review-bounded contract v1 ...",
    outcome: overrides.outcome ?? "pass",
    verifier,
    shadow: overrides.shadow,
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

function makeReviewBoundedRowWithoutVerifier(): string {
  return recordDelegation({
    taskType: "review-bounded",
    modelId: "qwen3-coder-next-80b",
    prompt: "gille review-bounded contract v1 ...",
    outcome: "pass",
    source: "gateway",
  });
}

function makeReviewBoundedRowWithUngradedVerifier(): string {
  return recordDelegation({
    taskType: "review-bounded",
    modelId: "qwen3-coder-next-80b",
    prompt: "gille review-bounded contract v1 ...",
    outcome: "unverified",
    verifier: "none",
    source: "gateway",
  });
}

async function putReviewerUsefulness(
  ledgerId: string,
  body: string | Record<string, unknown>,
  token?: string,
  contentType = "application/json",
) {
  return harness.invoke({
    method: "PUT",
    path: `/ledger/${ledgerId}/reviewer-usefulness`,
    token,
    headers: { "content-type": contentType },
    body,
  });
}

function latestReviewerUsefulnessRequest(alias: string | null): {
  route: string;
  status: number;
  outcome: string;
  error_class: string | null;
  admission: string | null;
} {
  const query = alias === null
    ? `
    SELECT route, status, outcome, error_class, admission
      FROM request_log
     WHERE alias IS NULL
       AND route = '/ledger/:id/reviewer-usefulness'
     ORDER BY rowid DESC
     LIMIT 1
  `
    : `
    SELECT route, status, outcome, error_class, admission
     FROM request_log
     WHERE alias = @alias
       AND route = '/ledger/:id/reviewer-usefulness'
     ORDER BY rowid DESC
     LIMIT 1
  `;
  return getDb().prepare(query).get(alias === null ? {} : { alias }) as {
    route: string;
    status: number;
    outcome: string;
    error_class: string | null;
    admission: string | null;
  };
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
    expect(latestReviewerUsefulnessRequest("reviewer-admin")).toMatchObject({
      route: "/ledger/:id/reviewer-usefulness",
      status: 201,
      outcome: "ok",
      error_class: null,
      admission: "n/a",
    });
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

  it("treats omitted notes as part of the exact-retry identity and rejects a second reviewer", async () => {
    const ledgerId = makeReviewBoundedRow();
    const first = await putReviewerUsefulness(ledgerId, {
      usefulness: "redo",
    }, adminKey);
    expect(first.status).toBe(201);

    const retry = await putReviewerUsefulness(ledgerId, {
      usefulness: "redo",
    }, adminKey);
    expect(retry.status).toBe(200);
    expect(retry.json as ReviewerUsefulnessWriteResponse).toMatchObject({
      reviewerIdentity: "reviewer-admin",
      notesPresent: false,
      noteChars: 0,
      writeState: "unchanged",
    });

    const secondReviewer = await putReviewerUsefulness(ledgerId, {
      usefulness: "redo",
    }, secondAdminKey);
    expect(secondReviewer.status).toBe(409);
    expect(secondReviewer.json as ReviewerUsefulnessConflictResponse).toMatchObject({
      error: {
        code: "reviewer_usefulness_conflict",
        type: "invalid_request_error",
        param: "ledgerId",
      },
      conflict: {
        kind: "already_recorded",
        mismatchFields: ["reviewerIdentity"],
        existing: {
          reviewerIdentity: "reviewer-admin",
          notesPresent: false,
          noteChars: 0,
        },
        attempted: {
          reviewerIdentity: "reviewer-admin-r2",
          notesPresent: false,
          noteChars: 0,
        },
      },
    });
    expect(latestReviewerUsefulnessRequest("reviewer-admin-r2")).toMatchObject({
      status: 409,
      outcome: "conflict",
      error_class: "reviewer_usefulness_conflict",
      admission: "n/a",
    });
  });

  it("fails closed on a conflicting overwrite, exposes machine conflict detail, and does not leak notes", async () => {
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
    const body = conflicting.json as ReviewerUsefulnessConflictResponse;
    expect(body.error.code).toBe("reviewer_usefulness_conflict");
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.param).toBe("ledgerId");
    expect(body.error.message).toContain("Exact retries are idempotent");
    expect(body.conflict).toMatchObject({
      kind: "already_recorded",
      mismatchFields: ["reviewerUsefulness", "notes"],
      existing: {
        reviewerUsefulness: "pass",
        reviewerIdentity: "reviewer-admin",
        notesPresent: true,
        noteChars: NOTES.length,
      },
      attempted: {
        reviewerUsefulness: "wrong",
        reviewerIdentity: "reviewer-admin",
        notesPresent: true,
      },
    });
    expect(conflicting.text).not.toContain(NOTES);
    expect(conflicting.text).not.toContain("ref:gille-inference#112 verdict:refuted");

    const row = getDelegationById(ledgerId);
    expect(row?.reviewerUsefulness).toBe("pass");
    expect(row?.reviewerUsefulnessNotes).toBe(NOTES);
  });

  it("rejects malformed, oversized, non-JSON, or non-content-blind / bounded input without changing the row", async () => {
    const ledgerId = makeReviewBoundedRow();
    const invalidJson = await putReviewerUsefulness(ledgerId, "{", adminKey);
    expect(invalidJson.status).toBe(400);
    expect(invalidJson.json as { error: { message: string } }).toMatchObject({
      error: { message: "Request body must be valid JSON." },
    });

    const wrongContentType = await putReviewerUsefulness(
      ledgerId,
      JSON.stringify({ usefulness: "pass", notes: NOTES }),
      adminKey,
      "text/plain",
    );
    expect(wrongContentType.status).toBe(400);
    expect(wrongContentType.json as { error: { code: string; param: string | null } }).toMatchObject({
      error: { code: "invalid_request_error", param: "content-type" },
    });

    const oversized = await putReviewerUsefulness(
      ledgerId,
      { usefulness: "pass", notes: `ref:${"a".repeat(5000)}` },
      adminKey,
    );
    expect(oversized.status).toBe(413);
    expect(oversized.json as { error: { code: string } }).toMatchObject({
      error: { code: "payload_too_large" },
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
    expect(getDelegationById(ledgerId)?.reviewerUsefulness).toBeNull();
    expect(latestReviewerUsefulnessRequest("reviewer-admin")).toMatchObject({
      status: 400,
      outcome: "bad_request",
      error_class: "invalid_request_error",
      admission: "n/a",
    });
  });

  it("404s for an unknown ledger id without reflecting the caller-supplied id", async () => {
    const unknownId = "no-such-ledger-id";
    const res = await putReviewerUsefulness("no-such-ledger-id", {
      usefulness: "pass",
      notes: NOTES,
    }, adminKey);
    expect(res.status).toBe(404);
    expect(res.json as { error: { code: string } }).toMatchObject({
      error: { code: "not_found" },
    });
    expect(res.text).not.toContain(unknownId);
  });

  it("rejects a ledger row that is not review-bounded", async () => {
    const ledgerId = makeNonReviewRow();
    const res = await putReviewerUsefulness(ledgerId, {
      usefulness: "pass",
      notes: NOTES,
    }, adminKey);
    expect(res.status).toBe(409);
    const body = res.json as ReviewerUsefulnessConflictResponse;
    expect(body.error).toMatchObject({
      code: "reviewer_usefulness_conflict",
      type: "invalid_request_error",
      param: "ledgerId",
    });
    expect(body.conflict).toMatchObject({
      kind: "wrong_task_type",
      taskType: "summarize",
    });
    expect(getDelegationById(ledgerId)?.reviewerUsefulness).toBeNull();
  });

  it("rejects review-bounded rows that were never verifier-backed", async () => {
    const ledgerId = makeReviewBoundedRowWithoutVerifier();
    const res = await putReviewerUsefulness(ledgerId, {
      usefulness: "pass",
      notes: NOTES,
    }, adminKey);
    expect(res.status).toBe(409);
    expect(res.json as ReviewerUsefulnessConflictResponse).toMatchObject({
      error: {
        code: "reviewer_usefulness_conflict",
        type: "invalid_request_error",
        param: "ledgerId",
      },
      conflict: {
        kind: "missing_verifier",
      },
    });
    expect(getDelegationById(ledgerId)?.reviewerUsefulness).toBeNull();
  });

  it("rejects the normal ungraded verifier sentinel emitted by the orchestrator", async () => {
    const ledgerId = makeReviewBoundedRowWithUngradedVerifier();
    const res = await putReviewerUsefulness(ledgerId, {
      usefulness: "pass",
      notes: NOTES,
    }, adminKey);

    expect(res.status).toBe(409);
    expect(res.json as ReviewerUsefulnessConflictResponse).toMatchObject({
      error: {
        code: "reviewer_usefulness_conflict",
        type: "invalid_request_error",
        param: "ledgerId",
      },
      conflict: { kind: "missing_verifier" },
    });
    expect(getDelegationById(ledgerId)?.reviewerUsefulness).toBeNull();
  });

  it("requires a genuine grade for gateway-reachable verifier labels and rejects shadow/superseded rows", async () => {
    const exactLedgerId = makeReviewBoundedRowWithVerifier(
      gatewayVerifierName({ type: "exact", expected: "{\"ok\":true}" })
    );
    const exact = await putReviewerUsefulness(exactLedgerId, {
      usefulness: "pass",
      notes: NOTES,
    }, adminKey);
    expect(exact.status).toBe(201);

    const structuralLedgerId = makeReviewBoundedRowWithVerifier(
      gatewayVerifierName({ type: "nonEmpty", minLen: 0 })
    );
    const structural = await putReviewerUsefulness(structuralLedgerId, {
      usefulness: "pass",
      notes: NOTES,
    }, adminKey);
    expect(structural.status).toBe(409);
    expect(structural.json as ReviewerUsefulnessConflictResponse).toMatchObject({
      conflict: { kind: "missing_verifier" },
    });

    const shadowLedgerId = makeReviewBoundedRowWithVerifier(
      gatewayVerifierName({ type: "exact", expected: "{\"ok\":true}" }),
      { shadow: true }
    );
    const shadow = await putReviewerUsefulness(shadowLedgerId, {
      usefulness: "pass",
      notes: NOTES,
    }, adminKey);
    expect(shadow.status).toBe(409);
    expect(shadow.json as ReviewerUsefulnessConflictResponse).toMatchObject({
      conflict: { kind: "shadow" },
    });

    const supersededLedgerId = makeReviewBoundedRowWithVerifier(
      gatewayVerifierName({ type: "exact", expected: "{\"ok\":true}" })
    );
    getDb().prepare(`
      UPDATE delegations
         SET superseded_at = '2026-07-31T10:00:00.000Z'
       WHERE id = ?
    `).run(supersededLedgerId);
    const superseded = await putReviewerUsefulness(supersededLedgerId, {
      usefulness: "pass",
      notes: NOTES,
    }, adminKey);
    expect(superseded.status).toBe(409);
    expect(superseded.json as ReviewerUsefulnessConflictResponse).toMatchObject({
      conflict: { kind: "superseded" },
    });
  });

  it("stays minted-owner-admin only: unauthenticated, guest, monitor, owner-monitor, and owner-agent callers cannot write", async () => {
    const ledgerId = makeReviewBoundedRow();

    const unauthenticated = await putReviewerUsefulness(ledgerId, { usefulness: "pass", notes: NOTES });
    expect(unauthenticated.status).toBe(401);

    const guest = await putReviewerUsefulness(ledgerId, { usefulness: "pass", notes: NOTES }, guestKey);
    expect(guest.status).toBe(403);

    const monitor = await putReviewerUsefulness(ledgerId, { usefulness: "pass", notes: NOTES }, monitorKey);
    expect(monitor.status).toBe(403);

    const ownerMonitor = await putReviewerUsefulness(ledgerId, { usefulness: "pass", notes: NOTES }, ownerMonitorKey);
    expect(ownerMonitor.status).toBe(403);

    const agent = await putReviewerUsefulness(ledgerId, { usefulness: "pass", notes: NOTES }, agentKey);
    expect(agent.status).toBe(403);

    expect(latestReviewerUsefulnessRequest(null)).toMatchObject({
      route: "/ledger/:id/reviewer-usefulness",
      status: 401,
      outcome: "auth_failed",
      error_class: "invalid_api_key",
    });
    expect(latestReviewerUsefulnessRequest("reviewer-owner-monitor")).toMatchObject({
      route: "/ledger/:id/reviewer-usefulness",
      status: 403,
      outcome: "forbidden",
      error_class: "route_not_allowed",
    });
    expect(getDelegationById(ledgerId)?.reviewerUsefulness).toBeNull();
  });

  it("surfaces hidden reviewer-usefulness state on GET /ledger/:id without leaking note bytes", async () => {
    const ledgerId = makeReviewBoundedRowWithVerifier(
      gatewayVerifierName({ type: "exact", expected: "{\"ok\":true}" })
    );
    getDb().prepare(`
      UPDATE delegations
         SET shadow = 1,
             reviewer_usefulness = @usefulness,
             reviewer_usefulness_notes = @notes,
             reviewer_usefulness_by = @judgedBy,
             reviewer_usefulness_ts = @ts
       WHERE id = @id
    `).run({
      usefulness: "pass",
      notes: NOTES,
      judgedBy: "grimnir-session-2026-08-01-hidden",
      ts: "2026-08-01T10:00:00.000Z",
      id: ledgerId,
    });

    const admin = await harness.invoke({
      method: "GET",
      path: `/ledger/${ledgerId}`,
      token: adminKey,
    });
    expect(admin.status).toBe(200);
    expect(admin.json as Record<string, unknown>).toMatchObject({
      id: ledgerId,
      reviewerUsefulness: null,
      reviewerUsefulnessNotes: null,
      reviewerUsefulnessBy: null,
      reviewerUsefulnessTs: null,
      reviewerUsefulnessHidden: true,
      reviewerUsefulnessNotesPresent: true,
      reviewerUsefulnessNoteChars: NOTES.length,
    });
    expect(admin.text).not.toContain(NOTES);

    const monitor = await harness.invoke({
      method: "GET",
      path: `/ledger/${ledgerId}`,
      token: ownerMonitorKey,
    });
    expect(monitor.status).toBe(200);
    expect(monitor.json as Record<string, unknown>).toMatchObject({
      id: ledgerId,
      reviewerUsefulness: null,
      reviewerUsefulnessNotes: null,
      reviewerUsefulnessBy: null,
      reviewerUsefulnessTs: null,
      reviewerUsefulnessHidden: true,
      reviewerUsefulnessNotesPresent: true,
      reviewerUsefulnessNoteChars: NOTES.length,
    });
    expect(monitor.text).not.toContain(NOTES);
  });

  it("hides stale recorded reviewer-usefulness state on GET /ledger/:id after the row is superseded", async () => {
    const ledgerId = makeReviewBoundedRowWithVerifier(
      gatewayVerifierName({ type: "exact", expected: "{\"ok\":true}" })
    );
    const write = await putReviewerUsefulness(ledgerId, {
      usefulness: "pass",
      notes: NOTES,
    }, adminKey);
    expect(write.status).toBe(201);

    getDb().prepare(`
      UPDATE delegations
         SET superseded_at = '2026-08-01T10:00:00.000Z'
       WHERE id = ?
    `).run(ledgerId);

    const admin = await harness.invoke({
      method: "GET",
      path: `/ledger/${ledgerId}`,
      token: adminKey,
    });
    expect(admin.status).toBe(200);
    expect(admin.json as Record<string, unknown>).toMatchObject({
      id: ledgerId,
      reviewerUsefulness: null,
      reviewerUsefulnessNotes: null,
      reviewerUsefulnessBy: null,
      reviewerUsefulnessTs: null,
      reviewerUsefulnessHidden: true,
      reviewerUsefulnessNotesPresent: true,
      reviewerUsefulnessNoteChars: NOTES.length,
    });
    expect(admin.text).not.toContain(NOTES);

    const monitor = await harness.invoke({
      method: "GET",
      path: `/ledger/${ledgerId}`,
      token: ownerMonitorKey,
    });
    expect(monitor.status).toBe(200);
    expect(monitor.json as Record<string, unknown>).toMatchObject({
      id: ledgerId,
      reviewerUsefulness: null,
      reviewerUsefulnessNotes: null,
      reviewerUsefulnessBy: null,
      reviewerUsefulnessTs: null,
      reviewerUsefulnessHidden: true,
      reviewerUsefulnessNotesPresent: true,
      reviewerUsefulnessNoteChars: NOTES.length,
    });
    expect(monitor.text).not.toContain(NOTES);
  });
});
