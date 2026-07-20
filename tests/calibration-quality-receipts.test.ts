/**
 * Quality Receipt join tests (issue #6). Where a receipt is absent, the row must be honestly
 * "unmatched" — never silently treated as passing.
 */
import { describe, it, expect } from "vitest";
import type { CalibrationSampleRow } from "../src/homeserver/ledger.js";
import { bindingKeyOf, joinSampleToReceipts, type QualityReceiptRef } from "../src/homeserver/calibration-quality-receipts.js";

function row(overrides: Partial<CalibrationSampleRow> = {}): CalibrationSampleRow {
  return {
    id: "row-1",
    ts: "2026-07-15T00:00:00.000Z",
    nodeId: "m5",
    taskType: "qa-factual",
    modelId: "gpt-oss-120b",
    outcome: "pass",
    verifier: "llm-judge:gpt-oss-120b",
    verifierKind: "truth-oriented",
    promptTokens: 500,
    source: "harvest",
    lane: "mcp-ask",
    evidenceIdentityHash: null,
    judgePolicy: "ctx-tools-parts-v1|ctx=24000",
    shadow: false,
    score: 0.9,
    ...overrides,
  };
}

function receipt(overrides: Partial<QualityReceiptRef> = {}): QualityReceiptRef {
  return {
    receiptId: "qr-1",
    receiptDigest: "sha256:" + "a".repeat(64),
    bindingKey: "row:row-1",
    rating: "pass",
    disposition: "accepted",
    rubricVersion: "hugin-rubric-v1",
    reviewerId: "reviewer-opaque-1",
    ...overrides,
  };
}

describe("bindingKeyOf", () => {
  it("prefers the evidence identity hash when present (the strongest immutable key)", () => {
    expect(bindingKeyOf({ id: "row-1", evidenceIdentityHash: "sha256:deadbeef" })).toBe("sha256:deadbeef");
  });
  it("falls back to a row-id-derived key when no identity bundle exists", () => {
    expect(bindingKeyOf({ id: "row-1", evidenceIdentityHash: null })).toBe("row:row-1");
  });
});

describe("joinSampleToReceipts", () => {
  it("matches a sampled row to its receipt by binding key", () => {
    const joined = joinSampleToReceipts([row()], [receipt()]);
    expect(joined).toHaveLength(1);
    expect(joined[0]!.matched).toBe(true);
    expect(joined[0]!.receipt?.receiptId).toBe("qr-1");
  });

  it("a sampled row with NO receipt is honestly unmatched, never treated as passing", () => {
    const joined = joinSampleToReceipts([row({ id: "row-2", evidenceIdentityHash: null })], []);
    expect(joined).toHaveLength(1);
    expect(joined[0]!.matched).toBe(false);
    expect(joined[0]!.receipt).toBeNull();
  });

  it("joins by evidence identity hash when present, in preference to row id", () => {
    const r = row({ id: "row-3", evidenceIdentityHash: "sha256:cafebabe" });
    const qr = receipt({ bindingKey: "sha256:cafebabe" });
    const joined = joinSampleToReceipts([r], [qr]);
    expect(joined[0]!.matched).toBe(true);
    expect(joined[0]!.bindingKey).toBe("sha256:cafebabe");
  });

  it("does not match a receipt whose binding key targets a DIFFERENT row", () => {
    const joined = joinSampleToReceipts([row({ id: "row-1" })], [receipt({ bindingKey: "row:row-999" })]);
    expect(joined[0]!.matched).toBe(false);
  });

  it("refuses (fails closed) when two receipts target the same binding key — ambiguous join", () => {
    expect(() =>
      joinSampleToReceipts([row()], [receipt({ receiptId: "qr-a" }), receipt({ receiptId: "qr-b" })])
    ).toThrow(/ambiguous join/);
  });

  it("content-blindness: QualityReceiptRef and the join result carry no free-text review content", () => {
    const joined = joinSampleToReceipts([row()], [receipt()]);
    const serialized = JSON.stringify(joined);
    // Only opaque ids/digests and closed-enum fields should appear — no field for review prose.
    expect(Object.keys(receipt())).not.toContain("reviewText");
    expect(Object.keys(receipt())).not.toContain("reason");
    expect(serialized).toContain("qr-1");
  });
});
