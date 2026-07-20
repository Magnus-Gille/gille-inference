/**
 * Calibration metrics tests (issue #6): confidence intervals, denominators, and the SAFE-BY-DEFAULT
 * format-only-evidence discount rule (AC: "known wrong answers cannot earn trusted truth-quality
 * evidence through format checks" / "unknown verifier identities are untrusted until classified").
 */
import { describe, it, expect } from "vitest";
import type { CalibrationSampleRow } from "../src/homeserver/ledger.js";
import type { QualityReceiptRef } from "../src/homeserver/calibration-quality-receipts.js";
import { joinSampleToReceipts } from "../src/homeserver/calibration-quality-receipts.js";
import { stratumKeyOf } from "../src/homeserver/calibration-sample.js";
import {
  wilsonInterval,
  isTrustedTruthQualityVerifierClass,
  computeCalibrationMetrics,
} from "../src/homeserver/calibration-metrics.js";
import { DEFAULT_CALIBRATION_THRESHOLDS } from "../src/homeserver/calibration-policy.js";

let counter = 0;
function row(overrides: Partial<CalibrationSampleRow> = {}): CalibrationSampleRow {
  counter++;
  return {
    id: `row-${counter}`,
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

function receiptFor(r: CalibrationSampleRow, rating: QualityReceiptRef["rating"]): QualityReceiptRef {
  return {
    receiptId: `qr-${r.id}`,
    receiptDigest: "sha256:" + "b".repeat(64),
    bindingKey: `row:${r.id}`,
    rating,
    disposition: rating === "pass" ? "accepted" : "rejected",
    rubricVersion: "hugin-rubric-v1",
    reviewerId: "reviewer-1",
  };
}

describe("wilsonInterval", () => {
  it("returns null estimate for a zero denominator — never a fabricated rate", () => {
    const r = wilsonInterval(0, 0);
    expect(r.point).toBeNull();
    expect(r.ciLower).toBeNull();
    expect(r.ciUpper).toBeNull();
  });

  it("bounds are within [0,1] and straddle the point estimate", () => {
    const r = wilsonInterval(8, 10);
    expect(r.point).toBe(0.8);
    expect(r.ciLower).toBeGreaterThan(0);
    expect(r.ciLower).toBeLessThan(0.8);
    expect(r.ciUpper).toBeGreaterThan(0.8);
    expect(r.ciUpper).toBeLessThanOrEqual(1);
  });

  it("a small-N stratum has a WIDE interval, not false precision", () => {
    const small = wilsonInterval(2, 2); // 100% on n=2
    const large = wilsonInterval(100, 100); // 100% on n=100
    expect(small.ciLower!).toBeLessThan(large.ciLower!);
    expect(small.ciUpper! - small.ciLower!).toBeGreaterThan(large.ciUpper! - large.ciLower!);
  });

  it("100% on n=2 does not reach a naive 0.9 floor at the CI lower bound", () => {
    const r = wilsonInterval(2, 2);
    expect(r.ciLower!).toBeLessThan(0.9);
  });
});

describe("isTrustedTruthQualityVerifierClass", () => {
  it("trusts llm-judge and explicit truth-oriented allowlist entries", () => {
    expect(isTrustedTruthQualityVerifierClass("llm-judge")).toBe(true);
    expect(isTrustedTruthQualityVerifierClass("truth-oriented:tsGate")).toBe(true);
  });
  it("does NOT trust mechanical-format, ungraded, or unclassified", () => {
    expect(isTrustedTruthQualityVerifierClass("mechanical-format")).toBe(false);
    expect(isTrustedTruthQualityVerifierClass("ungraded")).toBe(false);
    expect(isTrustedTruthQualityVerifierClass("unclassified:predicate")).toBe(false);
  });
});

function metricsFor(rows: CalibrationSampleRow[], receipts: QualityReceiptRef[]) {
  const joined = joinSampleToReceipts(rows, receipts);
  const strataByRowId = new Map(rows.map((r) => [r.id, stratumKeyOf(r)]));
  return computeCalibrationMetrics({
    policyId: "sha256:" + "c".repeat(64),
    joined,
    strataByRowId,
    thresholds: DEFAULT_CALIBRATION_THRESHOLDS,
  });
}

describe("computeCalibrationMetrics — format-only discount is SAFE BY DEFAULT", () => {
  it("a known-wrong answer that passed only a mechanical-format check is NOT trusted evidence, however good its numbers look", () => {
    // Ten rows, all verified by a mechanical-format check (`containsAll`), all ledger outcome=pass,
    // and — the trap — the INDEPENDENT receipt agrees they're "pass" too (i.e. raw precision would
    // read as a perfect 1.0 if this were ever treated as trusted). The rule must exclude the group
    // from gate-satisfying evidence purely because of ITS VERIFIER CLASS, not because the numbers
    // are bad.
    const rows = Array.from({ length: 10 }, () =>
      row({ verifier: "containsAll", verifierKind: "mechanical-format", outcome: "pass", score: null })
    );
    const receipts = rows.map((r) => receiptFor(r, "pass"));
    const report = metricsFor(rows, receipts);
    const group = report.byVerifierClass.find((g) => g.verifierClass === "mechanical-format")!;
    expect(group.trustedForGate).toBe(false);
    // The numbers are still HONESTLY REPORTED (transparency), just never gate-trusted.
    expect(group.sampledN).toBe(10);
  });

  it("an unknown/unclassified verifier is untrusted until explicitly classified, even with clean numbers", () => {
    const rows = Array.from({ length: 10 }, () => row({ verifier: "some-future-verifier", verifierKind: "truth-oriented" }));
    const receipts = rows.map((r) => receiptFor(r, "pass"));
    const report = metricsFor(rows, receipts);
    const group = report.byVerifierClass.find((g) => g.verifierClass === "unclassified:some-future-verifier")!;
    expect(group.trustedForGate).toBe(false);
  });

  it("llm-judge evidence IS eligible to be trusted (subject to meeting the numeric thresholds elsewhere)", () => {
    const rows = Array.from({ length: 10 }, () => row());
    const receipts = rows.map((r) => receiptFor(r, "pass"));
    const report = metricsFor(rows, receipts);
    const group = report.byVerifierClass.find((g) => g.verifierClass === "llm-judge")!;
    expect(group.trustedForGate).toBe(true);
  });
});

describe("computeCalibrationMetrics — byLane is restricted to TRUSTED verifier-class evidence (regression: dogfood review, #6)", () => {
  it("a lane whose evidence is ONLY mechanical-format/unclassified reports sampledN 0 and insufficient — its rows must never silently inflate lane precision", () => {
    // Earlier version derived `trustedForGate` from a nullable `verifierClass` that byLane always
    // passed as null, so EVERY lane group's trustedForGate was permanently false — the per-lane gate
    // check was vacuous (it could never require a lane to prove itself, but it also never protected
    // against an untrusted lane's numbers being computed at all). Fixed: byLane now includes only
    // trusted-verifier-class rows in its own precision/recall/disagreement tally, exactly like the
    // long-context rollup already did.
    const rows = Array.from({ length: 20 }, () => row({ lane: "chat", verifier: "containsAll", verifierKind: "mechanical-format" }));
    const receipts = rows.map((r) => receiptFor(r, "pass"));
    const report = metricsFor(rows, receipts);
    const laneGroup = report.byLane.find((g) => g.groupKey === "lane:chat")!;
    expect(laneGroup.trustedForGate).toBe(true); // honest: this group IS restricted to trusted rows...
    expect(laneGroup.sampledN).toBe(0); // ...and it correctly contains ZERO of them
    expect(laneGroup.sufficient).toBe(false);
    expect(laneGroup.precision.denominator).toBe(0);
  });

  it("a lane mixing trusted and untrusted verifiers computes precision/recall from the TRUSTED subset only", () => {
    const trusted = Array.from({ length: 5 }, () => row({ lane: "chat", verifier: "llm-judge:gpt-oss-120b" }));
    const untrusted = Array.from({ length: 20 }, () => row({ lane: "chat", verifier: "containsAll", verifierKind: "mechanical-format" }));
    const rows = [...trusted, ...untrusted];
    const receipts = rows.map((r) => receiptFor(r, "pass"));
    const report = metricsFor(rows, receipts);
    const laneGroup = report.byLane.find((g) => g.groupKey === "lane:chat")!;
    expect(laneGroup.sampledN).toBe(5); // the 20 mechanical-format rows are excluded from this lane's own tally
  });
});

describe("computeCalibrationMetrics — denominators and matching", () => {
  it("counts unmatched rows explicitly rather than silently dropping them", () => {
    const rows = [row(), row(), row()];
    const receipts = [receiptFor(rows[0]!, "pass")]; // only one of three has a receipt
    const report = metricsFor(rows, receipts);
    expect(report.totalSampled).toBe(3);
    expect(report.totalMatched).toBe(1);
    expect(report.totalUnmatched).toBe(2);
  });

  it("a conflicted receipt is excluded from precision/recall/disagreement and tracked separately", () => {
    const rows = [row()];
    const receipts = [receiptFor(rows[0]!, "conflicted")];
    const report = metricsFor(rows, receipts);
    expect(report.totalConflicted).toBe(1);
    expect(report.totalMatched).toBe(0);
    const laneGroup = report.byLane.find((g) => g.groupKey === "lane:mcp-ask")!;
    expect(laneGroup.conflictedN).toBe(1);
    expect(laneGroup.precision.denominator).toBe(0);
  });

  it("precision counts judge false-passes correctly: judge said pass, receipt says fail", () => {
    const passRow = row({ outcome: "pass", score: 0.9 });
    const falsePassRow = row({ outcome: "pass", score: 0.9 }); // judge said pass...
    const rows = [passRow, falsePassRow];
    const receipts = [receiptFor(passRow, "pass"), receiptFor(falsePassRow, "fail")]; // ...but it was wrong
    const report = metricsFor(rows, receipts);
    const group = report.byVerifierClass.find((g) => g.verifierClass === "llm-judge")!;
    expect(group.precision.numerator).toBe(1);
    expect(group.precision.denominator).toBe(2);
    expect(group.disagreement.numerator).toBe(1);
  });

  it("recall counts judge false-negatives: receipt says pass, judge said fail", () => {
    const r1 = row({ outcome: "fail", score: 0.1 });
    const receipts = [receiptFor(r1, "pass")];
    const report = metricsFor([r1], receipts);
    const group = report.byVerifierClass.find((g) => g.verifierClass === "llm-judge")!;
    expect(group.recall.numerator).toBe(0);
    expect(group.recall.denominator).toBe(1);
  });

  it("a small stratum (n < minStratumN) reports sufficient: false", () => {
    const rows = [row(), row()];
    const receipts = rows.map((r) => receiptFor(r, "pass"));
    const report = metricsFor(rows, receipts);
    const group = report.byVerifierClass.find((g) => g.verifierClass === "llm-judge")!;
    expect(group.sufficient).toBe(false);
  });

  it("groups the long-context (xl prompt-size) stratum separately, on trusted evidence only", () => {
    const longRows = Array.from({ length: 5 }, () => row({ promptTokens: 20_000 }));
    const shortRows = Array.from({ length: 5 }, () => row({ promptTokens: 500 }));
    const receipts = [...longRows, ...shortRows].map((r) => receiptFor(r, "pass"));
    const report = metricsFor([...longRows, ...shortRows], receipts);
    expect(report.longContext.sampledN).toBe(5);
  });

  it("content-blindness: the metrics report serializes with no free-text fields", () => {
    const rows = [row()];
    const receipts = [receiptFor(rows[0]!, "pass")];
    const report = metricsFor(rows, receipts);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("promptExcerpt");
    expect(serialized).not.toContain("reviewText");
  });
});
