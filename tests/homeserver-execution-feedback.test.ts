import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, initDb } from "../src/db.js";
import { recordDelegation, getDelegationById } from "../src/homeserver/ledger.js";
import {
  executionFeedbackOwner,
  bindExecutionFeedback,
  publishDurableExecutionFeedback,
  recordExecutionFeedback,
} from "../src/homeserver/execution-feedback.js";

const owner = { keyHash: "owner-key-hash", alias: "owner-test" };
function row(overrides = {}) {
  return recordDelegation({ taskType: "code-edit", modelId: "test-model", prompt: "private task",
    outcome: "unverified", source: "mcp-ask", keyAlias: owner.alias, ...overrides });
}
function bind(ledgerId: string, overrides = {}) {
  return bindExecutionFeedback({ ledgerId, owner, surface: "ask", trafficPurpose: "organic",
    outputAvailable: true, ...overrides });
}
beforeEach(() => initDb(join(mkdtempSync(join(tmpdir(), "exact-feedback-")), "test.db")));

describe("exact execution feedback", () => {
  it("admits only explicitly minted owner agent/admin callers", () => {
    const principal = { tier: "owner", scope: "agent", keyHash: owner.keyHash, alias: owner.alias };
    expect(executionFeedbackOwner(principal)).toEqual(owner);
    expect(executionFeedbackOwner({ ...principal, scope: "admin" })).toEqual(owner);
    for (const change of [{ tier: "guest" }, { scope: "monitor" }, { scope: "inference" },
      { keyHash: null }, { keyHash: "" }, { alias: "" }]) {
      expect(executionFeedbackOwner({ ...principal, ...change })).toBeNull();
    }
  });

  it("binds one opaque handle and one immutable judgment without changing verifier evidence", () => {
    const id = row();
    const before = getDelegationById(id);
    const handle = bind(id)!;
    expect(handle).toMatch(/^[0-9a-f-]{36}$/);
    expect(handle).not.toBe(id);
    expect(bind(id)).toBe(handle);
    expect(recordExecutionFeedback({ handle, owner, usefulness: "pass" })).toEqual({ kind: "recorded" });
    expect(recordExecutionFeedback({ handle, owner, usefulness: "pass" })).toEqual({ kind: "unchanged" });
    expect(recordExecutionFeedback({ handle, owner, usefulness: "wrong" })).toEqual({ kind: "conflict" });
    expect(getDelegationById(id)).toEqual(before);
    expect(getDb().prepare("SELECT usefulness, conflict_count FROM execution_feedback").get())
      .toEqual({ usefulness: "pass", conflict_count: 1 });
  });

  it("hides existence from another key even if its alias matches", () => {
    const handle = bind(row())!;
    const other = { ...owner, keyHash: "other-key" };
    expect(recordExecutionFeedback({ handle, owner: other, usefulness: "pass" }))
      .toEqual({ kind: "not_found" });
    expect(recordExecutionFeedback({ handle: "unknown", owner, usefulness: "pass" }))
      .toEqual({ kind: "not_found" });
    expect(bind(row(), { owner: { ...owner, alias: "different" } })).toBeNull();
  });

  it("never mints handles for unknown, shadow, superseded, failed execution or withheld output", () => {
    expect(bind("unknown")).toBeNull();
    expect(bind(row({ shadow: true }))).toBeNull();
    expect(bind(row({ outcome: "error" }))).toBeNull();
    expect(bind(row(), { outputAvailable: false })).toBeNull();
    const id = row();
    getDb().prepare("UPDATE delegations SET superseded_at = '2026-01-01' WHERE id = ?").run(id);
    expect(bind(id)).toBeNull();
  });

  it("keeps unknown and laboratory traffic out of organic feedback, including rebinding attempts", () => {
    for (const trafficPurpose of ["unknown", "evaluation", "synthetic"] as const) {
      const id = row();
      const handle = bind(id, { trafficPurpose })!;
      expect(handle).toBeTruthy();
      expect(bind(id)).toBeNull();
      expect(recordExecutionFeedback({ handle, owner, usefulness: "pass" })).toEqual({ kind: "ineligible" });
    }
  });

  it("rechecks current evidence on every feedback write, including identical retries", () => {
    const id = row();
    const handle = bind(id)!;
    expect(recordExecutionFeedback({ handle, owner, usefulness: "partial" }).kind).toBe("recorded");
    getDb().prepare("UPDATE delegations SET superseded_at = '2026-01-01' WHERE id = ?").run(id);
    expect(recordExecutionFeedback({ handle, owner, usefulness: "partial" })).toEqual({ kind: "ineligible" });
  });

  it("requires durable availability and the current feedback epoch", () => {
    const handle = bind(row({ source: "code-loop" }), { surface: "code_loop", deferAvailability: true })!;
    expect(recordExecutionFeedback({ handle, owner, usefulness: "pass" }).kind).toBe("ineligible");
    publishDurableExecutionFeedback(handle);
    expect(recordExecutionFeedback({ handle, owner, usefulness: "pass" }).kind).toBe("recorded");
    getDb().prepare("UPDATE execution_feedback SET epoch = 'retired' WHERE handle = ?").run(handle);
    expect(recordExecutionFeedback({ handle, owner, usefulness: "pass" }).kind).toBe("ineligible");
  });
});
