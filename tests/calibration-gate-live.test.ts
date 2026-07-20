/**
 * calibration-gate-live.ts tests (issue #37) — `computeLiveCalibrationGate` factors out the exact
 * sample → join → metrics → evaluate sequence scripts/routing-lifecycle-cli.ts now calls to attach
 * a LIVE #6 gate to a decision artifact (previously always `null`, see routing-lifecycle-cli.test.ts
 * for the CLI-level acceptance coverage). This file pins the pure computation itself: the honest
 * HOLD default with no receipts, and that a well-labeled sample CAN still reach GO through this same
 * wrapper (proving the wrapper does not accidentally suppress a real GO).
 */
import { describe, it, expect } from "vitest";
import type { CalibrationSampleRow } from "../src/homeserver/ledger.js";
import type { QualityReceiptRef } from "../src/homeserver/calibration-quality-receipts.js";
import { computeLiveCalibrationGate } from "../src/homeserver/calibration-gate-live.js";

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
    promptTokens: 2_000,
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

describe("computeLiveCalibrationGate — honest default", () => {
  it("computes a real HOLD (not a null/skip) with zero rows and zero receipts", () => {
    const gate = computeLiveCalibrationGate({ rows: [], receipts: [], generatedAt: "2026-07-20T00:00:00.000Z" });
    expect(gate.verdict).toBe("HOLD");
    expect(gate.enabling).toBeNull();
    expect(gate.reasons.some((r) => /insufficient audited sample|no trusted truth-quality evidence/.test(r))).toBe(true);
  });

  it("computes HOLD when rows exist but no receipts were supplied — every sampled row is honestly unmatched", () => {
    const rows = Array.from({ length: 40 }, () => row());
    const gate = computeLiveCalibrationGate({ rows, receipts: [], generatedAt: "2026-07-20T00:00:00.000Z" });
    expect(gate.verdict).toBe("HOLD");
    expect(gate.reasons.some((r) => /0 of \d+ sampled rows joined to an independent Quality Receipt/.test(r))).toBe(true);
  });
});

describe("computeLiveCalibrationGate — a well-measured sample can still reach GO through this wrapper", () => {
  it("GO when every trusted group and the long-context stratum clear the thresholds", () => {
    // targetPerStratum large enough that the stratified draw never truncates this single-stratum
    // population — otherwise the sample/join sequence this module adds on top of
    // evaluateCalibrationGate could flakily under-sample a well-measured population and mask a real
    // GO as a false HOLD.
    const truePos = Array.from({ length: 116 }, () => row({ outcome: "pass", score: 0.95, promptTokens: 20_000 }));
    const falseNeg = Array.from({ length: 4 }, () => row({ outcome: "fail", score: 0.1, promptTokens: 20_000 }));
    const rows = [...truePos, ...falseNeg];
    const receipts = rows.map((r) => receiptFor(r, "pass"));
    const gate = computeLiveCalibrationGate({
      rows,
      receipts,
      generatedAt: "2026-07-20T00:00:00.000Z",
      targetPerStratum: 200,
    });
    if (gate.verdict !== "GO") {
      throw new Error(`expected GO, got HOLD: ${gate.reasons.join(" | ")}`);
    }
    expect(gate.verdict).toBe("GO");
    expect(gate.enabling).toBeNull(); // computeLiveCalibrationGate never self-enables — a separate human step
  });

  it("is deterministic for a fixed (rows, seed) pair — same input, same sampled verdict", () => {
    const rows = Array.from({ length: 200 }, (_, i) => row({ outcome: i % 5 === 0 ? "fail" : "pass" }));
    const a = computeLiveCalibrationGate({ rows, receipts: [], generatedAt: "2026-07-20T00:00:00.000Z", seed: 7 });
    const b = computeLiveCalibrationGate({ rows, receipts: [], generatedAt: "2026-07-20T00:00:00.000Z", seed: 7 });
    expect(a).toEqual(b);
  });
});
