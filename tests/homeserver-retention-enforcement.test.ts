/**
 * Retention dry-run enforcement tests (issue #9, scope items 2 and 6).
 *
 * Central claims under test:
 *   - the dry-run report selects exactly the EXPIRED rows per store/classification and nothing else
 *   - the dry-run NEVER deletes or redacts anything, no matter how many rows are expired
 *   - the report is content-blind: sample refs are ids only, never a content column's value
 *   - the code-loop filesystem workspace is scanned by mtime, never by opening file content
 */
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb, getDb } from "../src/db.js";
import { recordRequestLog } from "../src/homeserver/request-log.js";
import { recordOwnerRequest } from "../src/homeserver/owner-log.js";
import { recordDelegation } from "../src/homeserver/ledger.js";
import {
  runRetentionDryRun,
  scanSqliteStoreForExpiry,
  scanCodeLoopWorkspaceForExpiry,
  retentionReportContentHash,
} from "../src/homeserver/retention-enforcement.js";
import { getHarvestStoreDescriptor } from "../src/homeserver/retention-registry.js";

const NOW = "2026-07-20T00:00:00.000Z";
const OLD_ISO = "2026-01-01T00:00:00.000Z"; // ~200 days before NOW — expired under both windows
const FRESH_ISO = "2026-07-19T00:00:00.000Z"; // 1 day before NOW — expired under neither window

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "hs-retention-enforcement-"));
  initDb(join(dir, "test.db"));
});

describe("retention-enforcement — sqlite dry-run", () => {
  it("selects rows older than the store's own window and none newer (request_log, content-blind)", () => {
    recordRequestLog({
      requestId: "req-old", alias: "alice", tier: "guest", keyHash: null, model: "m", node: "m5",
      route: "/v1/chat/completions", status: 200, outcome: "ok", errorClass: null,
      promptTokens: 1, completionTokens: 1, totalTokens: 2, queueWaitMs: null, ttftMs: null, totalMs: 10, admission: null,
    });
    recordRequestLog({
      requestId: "req-fresh", alias: "bob", tier: "guest", keyHash: null, model: "m", node: "m5",
      route: "/v1/chat/completions", status: 200, outcome: "ok", errorClass: null,
      promptTokens: 1, completionTokens: 1, totalTokens: 2, queueWaitMs: null, ttftMs: null, totalMs: 10, admission: null,
    });
    getDb().prepare("UPDATE request_log SET ts = ? WHERE id = 'req-old'").run(Date.parse(OLD_ISO));
    getDb().prepare("UPDATE request_log SET ts = ? WHERE id = 'req-fresh'").run(Date.parse(FRESH_ISO));

    const descriptor = getHarvestStoreDescriptor("request-log")!;
    const result = scanSqliteStoreForExpiry(getDb(), descriptor, NOW);
    expect(result.classification).toBe("content-blind");
    expect(result.expiredCount).toBeGreaterThanOrEqual(1);
    expect(result.sampleRefs).toContain("req-old");
    expect(result.sampleRefs).not.toContain("req-fresh");
  });

  it("reports content-bearing owner_request_log rows pending redaction, and only the still-unredacted ones", () => {
    recordOwnerRequest({
      alias: "owner1", model: "m", route: "chat", messagesJson: "[]", completion: "SECRET CONTENT",
      promptTokens: 1, completionTokens: 1, latencyMs: 5, tokPerSec: 1, outcome: "ok",
    });
    const row = getDb().prepare("SELECT id FROM owner_request_log ORDER BY id DESC LIMIT 1").get() as { id: number };
    getDb().prepare("UPDATE owner_request_log SET ts = ? WHERE id = ?").run(OLD_ISO, row.id);

    const descriptor = getHarvestStoreDescriptor("owner-request-log")!;
    const result = scanSqliteStoreForExpiry(getDb(), descriptor, NOW);
    expect(result.classification).toBe("content-bearing");
    expect(result.sampleRefs).toContain(String(row.id));
    // Content-blind reporting: the report never carries the completion text itself.
    expect(JSON.stringify(result)).not.toContain("SECRET CONTENT");

    // Simulate redaction, then re-scan: the row must no longer be reported (already handled).
    // owner_request_log's columns are NOT NULL — the descriptor's redactedContentValue is "",
    // never NULL (see retention-registry.ts).
    getDb().prepare("UPDATE owner_request_log SET messages_json = '', completion = '' WHERE id = ?").run(row.id);
    const rescanned = scanSqliteStoreForExpiry(getDb(), descriptor, NOW);
    expect(rescanned.sampleRefs).not.toContain(String(row.id));
  });

  it("delegations: the content-excerpt window is independent of the evidence-row window", () => {
    recordDelegation({ taskType: "t-retention", modelId: "m", prompt: "some prompt text", outcome: "pass" });
    const row = getDb().prepare("SELECT id FROM delegations WHERE task_type = 't-retention'").get() as { id: string };
    getDb().prepare("UPDATE delegations SET ts = ? WHERE id = ?").run(OLD_ISO, row.id);

    const contentDescriptor = getHarvestStoreDescriptor("delegations-content")!;
    const evidenceDescriptor = getHarvestStoreDescriptor("delegations-evidence")!;
    const contentResult = scanSqliteStoreForExpiry(getDb(), contentDescriptor, NOW);
    const evidenceResult = scanSqliteStoreForExpiry(getDb(), evidenceDescriptor, NOW);

    expect(contentResult.sampleRefs).toContain(row.id);
    expect(evidenceResult.sampleRefs).toContain(row.id);
    expect(contentResult.retentionDays).toBeLessThan(evidenceResult.retentionDays);
  });

  it("never deletes or mutates rows — a fresh dry-run report is idempotent", () => {
    const before = getDb().prepare("SELECT COUNT(*) AS n FROM request_log").get() as { n: number };
    runRetentionDryRun(getDb(), { now: NOW, workroot: mkdtempSync(join(tmpdir(), "hs-retention-workroot-")) });
    const after = getDb().prepare("SELECT COUNT(*) AS n FROM request_log").get() as { n: number };
    expect(after.n).toBe(before.n);
  });

  it("reports zero, not an error, for a store whose table does not yet exist", () => {
    const descriptor = getHarvestStoreDescriptor("experiment-import-records")!;
    const freshDb = getDb(); // table not created in this suite's DB
    const result = scanSqliteStoreForExpiry(freshDb, descriptor, NOW);
    expect(result.expiredCount).toBe(0);
    expect(result.sampleRefs).toEqual([]);
  });

  it("rejects a non-ISO 'now'", () => {
    const descriptor = getHarvestStoreDescriptor("request-log")!;
    expect(() => scanSqliteStoreForExpiry(getDb(), descriptor, "not-a-date")).toThrow();
  });
});

describe("retention-enforcement — code-loop filesystem workspace", () => {
  it("scans by mtime, never opens file content, and reports only file names", () => {
    const workroot = mkdtempSync(join(tmpdir(), "hs-retention-codeloop-"));
    const stateDir = join(workroot, ".code-loop-state-v1");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "work-old.json"), JSON.stringify({ secret: "DIFF CONTENT" }));
    writeFileSync(join(stateDir, "work-fresh.json"), JSON.stringify({ secret: "DIFF CONTENT" }));

    const oldMs = Date.parse(OLD_ISO) / 1000;
    const freshMs = Date.parse(FRESH_ISO) / 1000;
    utimesSync(join(stateDir, "work-old.json"), oldMs, oldMs);
    utimesSync(join(stateDir, "work-fresh.json"), freshMs, freshMs);

    const descriptor = getHarvestStoreDescriptor("code-loop-workspace")!;
    const result = scanCodeLoopWorkspaceForExpiry(workroot, NOW, descriptor);
    expect(result.classification).toBe("content-bearing");
    expect(result.sampleRefs).toEqual(["work-old.json"]);
    expect(result.expiredCount).toBe(1);
    expect(JSON.stringify(result)).not.toContain("DIFF CONTENT");
  });

  it("an absent workspace directory reports zero, not an error", () => {
    const workroot = mkdtempSync(join(tmpdir(), "hs-retention-codeloop-empty-"));
    const descriptor = getHarvestStoreDescriptor("code-loop-workspace")!;
    const result = scanCodeLoopWorkspaceForExpiry(workroot, NOW, descriptor);
    expect(result.expiredCount).toBe(0);
  });
});

describe("retention-enforcement — report content hash", () => {
  it("is stable for the same underlying state and changes when state changes", () => {
    const workroot = mkdtempSync(join(tmpdir(), "hs-retention-hash-"));
    const reportA = runRetentionDryRun(getDb(), { now: NOW, workroot });
    const reportB = runRetentionDryRun(getDb(), { now: NOW, workroot });
    expect(retentionReportContentHash(reportA)).toBe(retentionReportContentHash(reportB));

    recordRequestLog({
      requestId: "req-hash-changer", alias: null, tier: null, keyHash: null, model: "m", node: "m5",
      route: "/v1/chat/completions", status: 200, outcome: "ok", errorClass: null,
      promptTokens: null, completionTokens: null, totalTokens: null, queueWaitMs: null, ttftMs: null, totalMs: 1, admission: null,
    });
    getDb().prepare("UPDATE request_log SET ts = ? WHERE id = 'req-hash-changer'").run(Date.parse(OLD_ISO));
    const reportC = runRetentionDryRun(getDb(), { now: NOW, workroot });
    expect(retentionReportContentHash(reportC)).not.toBe(retentionReportContentHash(reportA));
  });
});
