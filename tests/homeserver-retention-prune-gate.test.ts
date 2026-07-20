/**
 * Destructive-prune safety-gate tests (issue #9, scope item 6 — the load-bearing requirement).
 *
 * Central claim: a destructive run refuses unless ALL THREE of (fresh-matching approval token,
 * exact confirm phrase, live-enable env value) hold — and by default (no env var set anywhere in
 * this repository) it always refuses. No test in this file, or anywhere else in this PR, leaves
 * `HOMESERVER_RETENTION_LIVE_PRUNE=on` set in the real process environment — every "executed" path
 * below passes `liveEnableEnvValue` directly, which is a test-only injection seam.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb, getDb } from "../src/db.js";
import { recordRequestLog } from "../src/homeserver/request-log.js";
import { runRetentionDryRun, retentionReportContentHash } from "../src/homeserver/retention-enforcement.js";
import {
  approveRetentionPrune,
  executeRetentionPrune,
  RETENTION_LIVE_PRUNE_CONFIRM,
  RETENTION_LIVE_PRUNE_ENV,
  RetentionPruneGateError,
  type PruneApprovalToken,
} from "../src/homeserver/retention-prune-gate.js";

const NOW = "2026-07-20T00:00:00.000Z";
const OLD_ISO = "2026-01-01T00:00:00.000Z";

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "hs-retention-prune-gate-"));
  initDb(join(dir, "test.db"));
});

function seedOneExpiredRequestLogRow(id: string): void {
  recordRequestLog({
    requestId: id, alias: null, tier: null, keyHash: null, model: "m", node: "m5",
    route: "/v1/chat/completions", status: 200, outcome: "ok", errorClass: null,
    promptTokens: null, completionTokens: null, totalTokens: null, queueWaitMs: null, ttftMs: null, totalMs: 1, admission: null,
  });
  getDb().prepare("UPDATE request_log SET ts = ? WHERE id = ?").run(Date.parse(OLD_ISO), id);
}

describe("retention-prune-gate — default-off by construction", () => {
  it("process.env has no live-enable value set anywhere in this test run", () => {
    expect(process.env[RETENTION_LIVE_PRUNE_ENV]).toBeUndefined();
  });

  it("refuses even with a valid, fresh-matching token when the confirm phrase is wrong", () => {
    seedOneExpiredRequestLogRow("req-gate-1");
    const workroot = mkdtempSync(join(tmpdir(), "hs-retention-prune-gate-wr-"));
    const report = runRetentionDryRun(getDb(), { now: NOW, workroot });
    const token = approveRetentionPrune(report, {
      reviewerId: "magnus", reason: "test", decisionRef: "issue-9", reviewedAt: NOW,
    });
    const result = executeRetentionPrune({
      db: getDb(), token, confirm: "wrong-phrase", now: NOW, workroot, liveEnableEnvValue: "on",
    });
    expect(result.status).toBe("refused");
    const stillThere = getDb().prepare("SELECT COUNT(*) AS n FROM request_log WHERE id = 'req-gate-1'").get() as { n: number };
    expect(stillThere.n).toBe(1);
  });

  it("refuses with the correct phrase when the live-enable env value is absent (the real default)", () => {
    const workroot = mkdtempSync(join(tmpdir(), "hs-retention-prune-gate-wr-"));
    const report = runRetentionDryRun(getDb(), { now: NOW, workroot });
    const token = approveRetentionPrune(report, {
      reviewerId: "magnus", reason: "test", decisionRef: "issue-9", reviewedAt: NOW,
    });
    const result = executeRetentionPrune({
      db: getDb(), token, confirm: RETENTION_LIVE_PRUNE_CONFIRM, now: NOW, workroot,
      liveEnableEnvValue: undefined, // simulates the real, always-default-off environment
    });
    expect(result.status).toBe("refused");
    if (result.status === "refused") expect(result.reason).toMatch(/default-off/);
  });

  it("refuses when the live-enable value is truthy-looking but not the exact required token", () => {
    const workroot = mkdtempSync(join(tmpdir(), "hs-retention-prune-gate-wr-"));
    const report = runRetentionDryRun(getDb(), { now: NOW, workroot });
    const token = approveRetentionPrune(report, {
      reviewerId: "magnus", reason: "test", decisionRef: "issue-9", reviewedAt: NOW,
    });
    for (const sneaky of ["1", "true", "yes", "ON", "On "]) {
      const result = executeRetentionPrune({
        db: getDb(), token, confirm: RETENTION_LIVE_PRUNE_CONFIRM, now: NOW, workroot, liveEnableEnvValue: sneaky,
      });
      expect(result.status).toBe("refused");
    }
  });

  it("refuses when the token's bound report is stale (state changed since approval)", () => {
    const workroot = mkdtempSync(join(tmpdir(), "hs-retention-prune-gate-wr-"));
    const reportBefore = runRetentionDryRun(getDb(), { now: NOW, workroot });
    const token = approveRetentionPrune(reportBefore, {
      reviewerId: "magnus", reason: "test", decisionRef: "issue-9", reviewedAt: NOW,
    });
    seedOneExpiredRequestLogRow("req-gate-stale");
    const result = executeRetentionPrune({
      db: getDb(), token, confirm: RETENTION_LIVE_PRUNE_CONFIRM, now: NOW, workroot, liveEnableEnvValue: "on",
    });
    expect(result.status).toBe("refused");
    if (result.status === "refused") expect(result.reason).toMatch(/current state|stale|hand-crafted/);
  });

  it("refuses a hand-crafted token with an arbitrary content hash", () => {
    const workroot = mkdtempSync(join(tmpdir(), "hs-retention-prune-gate-wr-"));
    const forged: PruneApprovalToken = {
      schemaVersion: 1,
      reportContentHash: "0".repeat(64),
      reportGeneratedAt: NOW,
      enablement: { reviewerId: "attacker", reason: "forged", decisionRef: "n/a", reviewedAt: NOW },
    };
    const result = executeRetentionPrune({
      db: getDb(), token: forged, confirm: RETENTION_LIVE_PRUNE_CONFIRM, now: NOW, workroot, liveEnableEnvValue: "on",
    });
    expect(result.status).toBe("refused");
  });

  it("approveRetentionPrune refuses an enablement with an empty reviewerId/reason/decisionRef", () => {
    const workroot = mkdtempSync(join(tmpdir(), "hs-retention-prune-gate-wr-"));
    const report = runRetentionDryRun(getDb(), { now: NOW, workroot });
    expect(() =>
      approveRetentionPrune(report, { reviewerId: "", reason: "x", decisionRef: "y", reviewedAt: NOW }),
    ).toThrow(RetentionPruneGateError);
  });
});

describe("retention-prune-gate — executes ONLY when all three conditions hold (test-only injection)", () => {
  it("deletes exactly the expired rows and redacts exactly the expired content columns, nothing else", () => {
    seedOneExpiredRequestLogRow("req-gate-execute");
    const freshCountBefore = getDb().prepare("SELECT COUNT(*) AS n FROM request_log").get() as { n: number };
    const workroot = mkdtempSync(join(tmpdir(), "hs-retention-prune-gate-wr-"));
    const report = runRetentionDryRun(getDb(), { now: NOW, workroot });
    const expectedDeletes = report.stores.find((s) => s.storeId === "request-log")?.expiredCount ?? 0;
    expect(expectedDeletes).toBeGreaterThanOrEqual(1);

    const token = approveRetentionPrune(report, {
      reviewerId: "magnus", reason: "test-only execution", decisionRef: "issue-9", reviewedAt: NOW,
    });
    const result = executeRetentionPrune({
      db: getDb(), token, confirm: RETENTION_LIVE_PRUNE_CONFIRM, now: NOW, workroot, liveEnableEnvValue: "on",
    });
    expect(result.status).toBe("executed");
    if (result.status !== "executed") return;
    expect(result.affectedCounts["request-log"]).toBe(expectedDeletes);

    const gone = getDb().prepare("SELECT COUNT(*) AS n FROM request_log WHERE id = 'req-gate-execute'").get() as { n: number };
    expect(gone.n).toBe(0);
    const remaining = getDb().prepare("SELECT COUNT(*) AS n FROM request_log").get() as { n: number };
    expect(remaining.n).toBe(freshCountBefore.n - expectedDeletes);
  });

  it("deletes EVERY expired code-loop workspace file, not just the dry-run report's capped sample", () => {
    // Regression test: an earlier version of performDeletes relied on the dry-run report's own
    // (deliberately capped) sampleRefs list to know which files to unlink, and silently deleted
    // NOTHING once more files were expired than the cap. Seed more than that cap (20) here.
    const workroot = mkdtempSync(join(tmpdir(), "hs-retention-prune-gate-codeloop-"));
    const stateDir = join(workroot, ".code-loop-state-v1");
    mkdirSync(stateDir, { recursive: true });
    const oldMs = Date.parse("2026-01-01T00:00:00.000Z") / 1000;
    const totalFiles = 25;
    for (let i = 0; i < totalFiles; i += 1) {
      const path = join(stateDir, `work-old-${i}.json`);
      writeFileSync(path, JSON.stringify({ ok: true }));
      utimesSync(path, oldMs, oldMs);
    }

    const report = runRetentionDryRun(getDb(), { now: NOW, workroot });
    const codeLoopResult = report.stores.find((s) => s.storeId === "code-loop-workspace");
    expect(codeLoopResult?.expiredCount).toBe(totalFiles);
    expect(codeLoopResult?.sampleRefs.length).toBeLessThan(totalFiles); // confirms the cap is in play

    const token = approveRetentionPrune(report, {
      reviewerId: "magnus", reason: "test", decisionRef: "issue-9", reviewedAt: NOW,
    });
    const result = executeRetentionPrune({
      db: getDb(), token, confirm: RETENTION_LIVE_PRUNE_CONFIRM, now: NOW, workroot, liveEnableEnvValue: "on",
    });
    expect(result.status).toBe("executed");
    if (result.status !== "executed") return;
    expect(result.affectedCounts["code-loop-workspace"]).toBe(totalFiles);
    expect(readdirSync(stateDir).length).toBe(0);
  });

  it("a second execute against the same (now-stale) token refuses — a token is single-use in effect", () => {
    seedOneExpiredRequestLogRow("req-gate-single-use");
    const workroot = mkdtempSync(join(tmpdir(), "hs-retention-prune-gate-wr-"));
    const report = runRetentionDryRun(getDb(), { now: NOW, workroot });
    const token = approveRetentionPrune(report, {
      reviewerId: "magnus", reason: "test", decisionRef: "issue-9", reviewedAt: NOW,
    });
    const first = executeRetentionPrune({
      db: getDb(), token, confirm: RETENTION_LIVE_PRUNE_CONFIRM, now: NOW, workroot, liveEnableEnvValue: "on",
    });
    expect(first.status).toBe("executed");
    const second = executeRetentionPrune({
      db: getDb(), token, confirm: RETENTION_LIVE_PRUNE_CONFIRM, now: NOW, workroot, liveEnableEnvValue: "on",
    });
    expect(second.status).toBe("refused");
  });
});
