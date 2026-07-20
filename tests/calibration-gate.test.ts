/**
 * HOLD/GO gate tests (issue #6). The critical property: with today's tiny/absent audited sample the
 * gate MUST compute HOLD with a specific, non-generic reason — never fabricate a GO. A GO is only
 * reachable when every trusted lane/verifier-class group AND the long-context stratum clear the
 * thresholds at the conservative confidence-interval bound with n >= minStratumN.
 */
import { describe, it, expect } from "vitest";
import type { CalibrationSampleRow } from "../src/homeserver/ledger.js";
import type { QualityReceiptRef } from "../src/homeserver/calibration-quality-receipts.js";
import { joinSampleToReceipts } from "../src/homeserver/calibration-quality-receipts.js";
import { stratumKeyOf } from "../src/homeserver/calibration-sample.js";
import { computeCalibrationMetrics } from "../src/homeserver/calibration-metrics.js";
import { evaluateCalibrationGate, attachReviewedDecision } from "../src/homeserver/calibration-gate.js";
import { CURRENT_CALIBRATION_POLICY, DEFAULT_CALIBRATION_THRESHOLDS, calibrationPolicyId } from "../src/homeserver/calibration-policy.js";

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
    promptTokens: 20_000, // xl bucket by default in these tests, so the long-context stratum is exercised too
    source: "harvest",
    lane: "mcp-ask",
    evidenceIdentityHash: null,
    judgePolicy: "ctx-tools-parts-v1|ctx=24000",
    shadow: false,
    score: 0.95,
    ...overrides,
  };
}

function receiptFor(r: CalibrationSampleRow, rating: QualityReceiptRef["rating"]): QualityReceiptRef {
  return {
    receiptId: `qr-${r.id}`,
    receiptDigest: "sha256:" + "d".repeat(64),
    bindingKey: `row:${r.id}`,
    rating,
    disposition: rating === "pass" ? "accepted" : "rejected",
    rubricVersion: "hugin-rubric-v1",
    reviewerId: "reviewer-1",
  };
}

function gateFor(rows: CalibrationSampleRow[], receipts: QualityReceiptRef[]) {
  const joined = joinSampleToReceipts(rows, receipts);
  const strataByRowId = new Map(rows.map((r) => [r.id, stratumKeyOf(r)]));
  const policyId = calibrationPolicyId(CURRENT_CALIBRATION_POLICY);
  const metrics = computeCalibrationMetrics({ policyId, joined, strataByRowId, thresholds: DEFAULT_CALIBRATION_THRESHOLDS });
  return evaluateCalibrationGate({
    policyId,
    generatedAt: "2026-07-20T00:00:00.000Z",
    metrics,
    thresholds: DEFAULT_CALIBRATION_THRESHOLDS,
  });
}

describe("evaluateCalibrationGate — HOLD is the honest default", () => {
  it("HOLD with a specific insufficient-audited-sample reason when there is NO ledger data at all", () => {
    const gate = gateFor([], []);
    expect(gate.verdict).toBe("HOLD");
    expect(gate.reasons.length).toBeGreaterThan(0);
    expect(gate.reasons.some((r) => /insufficient audited sample/.test(r))).toBe(true);
  });

  it("HOLD when rows exist but NO Quality Receipts were supplied — a real, current, reproducible state (issue #6)", () => {
    const rows = Array.from({ length: 50 }, () => row());
    const gate = gateFor(rows, []);
    expect(gate.verdict).toBe("HOLD");
    expect(gate.reasons.some((r) => /0 of 50 sampled rows joined/.test(r))).toBe(true);
  });

  it("HOLD when the sample is present and labeled but below minStratumN", () => {
    const rows = [row(), row()];
    const receipts = rows.map((r) => receiptFor(r, "pass"));
    const gate = gateFor(rows, receipts);
    expect(gate.verdict).toBe("HOLD");
    expect(gate.reasons.some((r) => /insufficient audited sample/.test(r))).toBe(true);
  });

  it("a mechanical-format-only sample NEVER reaches GO, however clean its numbers", () => {
    const rows = Array.from({ length: 60 }, () => row({ verifier: "containsAll", verifierKind: "mechanical-format" }));
    const receipts = rows.map((r) => receiptFor(r, "pass")); // "perfect" agreement — still must HOLD
    const gate = gateFor(rows, receipts);
    expect(gate.verdict).toBe("HOLD");
  });

  it("a well-measured lane does NOT paper over a second, unmeasured lane — per-lane gating is real (regression, #6 dogfood review)", () => {
    const truePos = Array.from({ length: 116 }, () => row({ lane: "mcp-ask", outcome: "pass", score: 0.95 }));
    const falseNeg = Array.from({ length: 4 }, () => row({ lane: "mcp-ask", outcome: "fail", score: 0.1 }));
    // A second lane with only 3 trusted rows — far below minStratumN — must hold the WHOLE gate back,
    // proving byLane's trustedForGate is no longer permanently false (which would make this lane
    // invisible to the gate and let the well-measured mcp-ask lane alone produce a GO).
    const thinLane = Array.from({ length: 3 }, () => row({ lane: "chat", outcome: "pass", score: 0.95 }));
    const rows = [...truePos, ...falseNeg, ...thinLane];
    const receipts = rows.map((r) => receiptFor(r, "pass"));
    const gate = gateFor(rows, receipts);
    expect(gate.verdict).toBe("HOLD");
    expect(gate.reasons.some((r) => /lane lane:chat/.test(r) && /insufficient/.test(r))).toBe(true);
  });

  it("HOLD reasons are SPECIFIC, not a generic placeholder string", () => {
    const gate = gateFor([], []);
    for (const reason of gate.reasons) {
      expect(reason.length).toBeGreaterThan(15);
      expect(reason).not.toBe("HOLD");
      expect(reason).not.toBe("insufficient evidence");
    }
  });

  it("the decision artifact is machine-readable: JSON round-trips and carries verdict/reasons/metrics/policyId", () => {
    const gate = gateFor([], []);
    const roundTripped = JSON.parse(JSON.stringify(gate));
    expect(roundTripped.verdict).toBe("HOLD");
    expect(roundTripped.schemaVersion).toBe(1);
    expect(typeof roundTripped.policyId).toBe("string");
    expect(Array.isArray(roundTripped.reasons)).toBe(true);
    expect(roundTripped.enabling).toBeNull();
  });
});

describe("evaluateCalibrationGate — a well-measured sample CAN reach GO", () => {
  it("GO when every trusted group and the long-context stratum clear the thresholds with a large, mostly-correct sample", () => {
    // 120 llm-judge rows in one lane, all xl-bucket (exercises the long-context stratum too): 116
    // true positives, 2 false negatives (judge said fail, receipt says pass), 2 rows the judge
    // skipped (no score/outcome → excluded from judge precision/recall), all receipts non-conflicted.
    const truePos = Array.from({ length: 116 }, () => row({ outcome: "pass", score: 0.95 }));
    const falseNeg = Array.from({ length: 4 }, () => row({ outcome: "fail", score: 0.1 }));
    const rows = [...truePos, ...falseNeg];
    const receipts = rows.map((r) => receiptFor(r, "pass"));
    const gate = gateFor(rows, receipts);
    if (gate.verdict !== "GO") {
      // Surface the actual reasons on failure so a threshold tweak is diagnosable, not a mystery.
      throw new Error(`expected GO, got HOLD: ${gate.reasons.join(" | ")}`);
    }
    expect(gate.verdict).toBe("GO");
    expect(gate.enabling).toBeNull(); // a measured GO does NOT self-enable anything
  });
});

describe("attachReviewedDecision", () => {
  const decision = { reviewerId: "magnus", reason: "reviewed 2026-07-20", decisionRef: "grimnir#88", reviewedAt: "2026-07-20T00:00:00.000Z" };

  it("refuses to attach a reviewed decision to a HOLD gate", () => {
    const gate = gateFor([], []);
    expect(() => attachReviewedDecision(gate, decision)).toThrow(/refusing to attach/);
  });

  it("attaches cleanly to a measured GO gate, returning a NEW object", () => {
    const truePos = Array.from({ length: 116 }, () => row({ outcome: "pass", score: 0.95 }));
    const falseNeg = Array.from({ length: 4 }, () => row({ outcome: "fail", score: 0.1 }));
    const rows = [...truePos, ...falseNeg];
    const receipts = rows.map((r) => receiptFor(r, "pass"));
    const gate = gateFor(rows, receipts);
    expect(gate.verdict).toBe("GO");
    const enabled = attachReviewedDecision(gate, decision);
    expect(enabled.enabling).toEqual(decision);
    expect(gate.enabling).toBeNull(); // original untouched
  });

  it("evaluateCalibrationGate NEVER calls attachReviewedDecision itself — enabling is always null from evaluation alone", () => {
    const gate = gateFor([], []);
    expect(gate.enabling).toBeNull();
  });
});
