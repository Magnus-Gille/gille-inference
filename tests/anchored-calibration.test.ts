/**
 * anchored-calibration.ts tests (issue #48) — verifier-anchored judge auto-calibration.
 *
 * The critical properties: (1) a judge whose rolling anchored agreement clears kappa over a
 * sufficient, fresh overlap sample contributes trusted labels with ZERO human receipts, and the
 * existing #6 gate can reach a real GO from them; (2) below-kappa agreement, insufficient overlap,
 * and a stale (aged-out) window all fail closed to HOLD, exactly like #6's own machinery; (3) a
 * same-family judge/candidate pair is excluded from its own anchored evidence (no self-grading);
 * (4) human and anchored receipts merge, with a genuine disagreement surfacing as "conflicted"
 * rather than a silent pick of one source.
 */
import { describe, it, expect } from "vitest";
import type { CalibrationSampleRow } from "../src/homeserver/ledger.js";
import type { QualityReceiptRef } from "../src/homeserver/calibration-quality-receipts.js";
import {
  judgeModelOf,
  judgeIdentityOf,
  buildAnchoredOverlapItems,
  computeAnchoredCalibration,
  anchoredReceiptsFrom,
  mergeCalibrationReceipts,
  DEFAULT_ANCHORED_CALIBRATION_CONFIG,
} from "../src/homeserver/anchored-calibration.js";
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

/** One "attempt": a judge-graded row and a deterministic-verifier-graded row sharing a binding key
 *  (the SAME underlying attempt, graded twice — the overlap this whole module exists to find). */
function overlapPair(p: {
  i: number;
  ts?: string;
  candidateModelId?: string;
  judgeModel?: string;
  judgeOutcome: "pass" | "partial" | "fail";
  anchorOutcome: "pass" | "partial" | "fail";
  promptTokens?: number;
  verifierAnchorName?: string;
}): { judgeRow: CalibrationSampleRow; anchorRow: CalibrationSampleRow } {
  const hash = `sha256:${"a".repeat(56)}${String(p.i).padStart(8, "0")}`;
  const candidateModelId = p.candidateModelId ?? "qwen3-coder-next-80b";
  const judgeModel = p.judgeModel ?? "gpt-oss-120b";
  const ts = p.ts ?? "2026-07-15T00:00:00.000Z";
  const promptTokens = p.promptTokens ?? 20_000;
  const judgeRow = row({
    id: `judge-${p.i}`,
    ts,
    modelId: candidateModelId,
    outcome: p.judgeOutcome,
    score: p.judgeOutcome === "pass" ? 0.95 : p.judgeOutcome === "fail" ? 0.1 : 0.5,
    verifier: `llm-judge:${judgeModel}`,
    evidenceIdentityHash: hash,
    promptTokens,
  });
  const anchorRow = row({
    id: `anchor-${p.i}`,
    ts,
    modelId: candidateModelId,
    outcome: p.anchorOutcome,
    score: p.anchorOutcome === "pass" ? 1 : p.anchorOutcome === "fail" ? 0 : 0.5,
    verifier: p.verifierAnchorName ?? "tsGate",
    evidenceIdentityHash: hash,
    promptTokens,
  });
  return { judgeRow, anchorRow };
}

/** Build N overlap pairs, `agreeN` of which agree (judge predicts the anchor's own truth) and the
 *  remainder disagree (judge predicts "fail" when the anchor's truth is "pass"). */
function buildPairs(
  n: number,
  agreeN: number,
  opts: { ts?: string; candidateModelId?: string; judgeModel?: string } = {}
): { judgeRows: CalibrationSampleRow[]; anchorRows: CalibrationSampleRow[] } {
  const judgeRows: CalibrationSampleRow[] = [];
  const anchorRows: CalibrationSampleRow[] = [];
  for (let i = 0; i < n; i++) {
    const { judgeRow, anchorRow } = overlapPair({
      i,
      judgeOutcome: i < agreeN ? "pass" : "fail",
      anchorOutcome: "pass",
      ...opts,
    });
    judgeRows.push(judgeRow);
    anchorRows.push(anchorRow);
  }
  return { judgeRows, anchorRows };
}

function receiptFor(bindingKey: string, rating: QualityReceiptRef["rating"]): QualityReceiptRef {
  return {
    receiptId: `qr-${bindingKey}`,
    receiptDigest: "sha256:" + "d".repeat(64),
    bindingKey,
    rating,
    disposition: rating === "pass" ? "accepted" : "rejected",
    rubricVersion: "hugin-rubric-v1",
    reviewerId: "reviewer-1",
  };
}

// ─── Identity helpers ─────────────────────────────────────────────────────────────

describe("judgeModelOf / judgeIdentityOf", () => {
  it("recovers the judge model from a real (non-shadow) verifier string", () => {
    expect(judgeModelOf("llm-judge:gpt-oss-120b")).toBe("gpt-oss-120b");
  });
  it("recovers the judge model from a shadow verifier string", () => {
    expect(judgeModelOf("harvest-shadow:llm-judge:gpt-oss-120b")).toBe("gpt-oss-120b");
  });
  it("returns null for a non-judge verifier", () => {
    expect(judgeModelOf("tsGate")).toBeNull();
    expect(judgeModelOf(null)).toBeNull();
    expect(judgeModelOf(undefined)).toBeNull();
  });
  it("stamps model+policy identity, defaulting a missing policy to an honest sentinel", () => {
    expect(judgeIdentityOf("gpt-oss-120b", "ctx-tools-parts-v1|ctx=24000")).toBe(
      "gpt-oss-120b@ctx-tools-parts-v1|ctx=24000"
    );
    expect(judgeIdentityOf("gpt-oss-120b", null)).toBe("gpt-oss-120b@(unknown)");
  });
});

// ─── Overlap item construction ────────────────────────────────────────────────────

describe("buildAnchoredOverlapItems", () => {
  it("finds no overlap when only judge rows exist (no deterministic verifier ever ran)", () => {
    const rows = Array.from({ length: 5 }, (_, i) => row({ id: `j-${i}`, evidenceIdentityHash: `sha256:${i}` }));
    expect(buildAnchoredOverlapItems(rows)).toHaveLength(0);
  });

  it("finds no overlap when only anchor rows exist (no organic judge ever graded it)", () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      row({ id: `a-${i}`, verifier: "tsGate", evidenceIdentityHash: `sha256:${i}` })
    );
    expect(buildAnchoredOverlapItems(rows)).toHaveLength(0);
  });

  it("pairs a judge row and an anchor row sharing a binding key into one overlap item", () => {
    const { judgeRow, anchorRow } = overlapPair({ i: 1, judgeOutcome: "pass", anchorOutcome: "pass" });
    const items = buildAnchoredOverlapItems([judgeRow, anchorRow]);
    expect(items).toHaveLength(1);
    expect(items[0]!.agree).toBe(true);
    expect(items[0]!.judgeVerdict).toBe("pass");
    expect(items[0]!.anchorVerdict).toBe("pass");
  });

  it("marks disagreement honestly when the judge's verdict does not match the anchor's", () => {
    const { judgeRow, anchorRow } = overlapPair({ i: 1, judgeOutcome: "fail", anchorOutcome: "pass" });
    const items = buildAnchoredOverlapItems([judgeRow, anchorRow]);
    expect(items[0]!.agree).toBe(false);
  });

  it("legacy rows without an evidenceIdentityHash never accidentally overlap with each other", () => {
    const judgeRow = row({ id: "legacy-judge", evidenceIdentityHash: null });
    const anchorRow = row({ id: "legacy-anchor", verifier: "tsGate", evidenceIdentityHash: null });
    // Falls back to `row:<id>` per row — distinct ids, so these never land in the same binding group.
    expect(buildAnchoredOverlapItems([judgeRow, anchorRow])).toHaveLength(0);
  });

  it("skips a binding key whose anchor rows disagree with each other (ambiguous ground truth)", () => {
    const hash = "sha256:ambiguous";
    const judgeRow = row({ id: "j", verifier: "llm-judge:gpt-oss-120b", outcome: "pass", evidenceIdentityHash: hash });
    const anchor1 = row({ id: "a1", verifier: "tsGate", outcome: "pass", evidenceIdentityHash: hash });
    const anchor2 = row({ id: "a2", verifier: "sqlExec", outcome: "fail", evidenceIdentityHash: hash });
    expect(buildAnchoredOverlapItems([judgeRow, anchor1, anchor2])).toHaveLength(0);
  });

  it("flags self-graded items when the judge and candidate share a model family", () => {
    // qwen3-coder-next-80b and qwen36-a3b are both "qwen" family (routing-table-generator.ts).
    const { judgeRow, anchorRow } = overlapPair({
      i: 1,
      candidateModelId: "qwen36-a3b",
      judgeModel: "qwen3-coder-next-80b",
      judgeOutcome: "pass",
      anchorOutcome: "pass",
    });
    const items = buildAnchoredOverlapItems([judgeRow, anchorRow]);
    expect(items[0]!.selfGraded).toBe(true);
  });

  it("does not flag self-grading across different families", () => {
    const { judgeRow, anchorRow } = overlapPair({ i: 1, judgeOutcome: "pass", anchorOutcome: "pass" });
    const items = buildAnchoredOverlapItems([judgeRow, anchorRow]);
    expect(items[0]!.selfGraded).toBe(false);
  });
});

// ─── Per-judge agreement + admissibility ─────────────────────────────────────────

describe("computeAnchoredCalibration — admissibility", () => {
  it("a judge above kappa with a sufficient overlap sample is admissible", () => {
    const { judgeRows, anchorRows } = buildPairs(120, 116); // 96.7% raw agreement
    const report = computeAnchoredCalibration({ rows: [...judgeRows, ...anchorRows], asOf: "2026-07-20T00:00:00.000Z" });
    expect(report.judges).toHaveLength(1);
    const j = report.judges[0]!;
    expect(j.windowedN).toBe(120);
    expect(j.sufficient).toBe(true);
    expect(j.agreement.ciLower).not.toBeNull();
    expect(j.agreement.ciLower!).toBeGreaterThanOrEqual(DEFAULT_ANCHORED_CALIBRATION_CONFIG.kappa);
    expect(j.admissible).toBe(true);
    expect(j.reasons[0]).toMatch(/admissible/);
  });

  it("a judge below kappa is inadmissible even with a large, sufficient sample", () => {
    const { judgeRows, anchorRows } = buildPairs(120, 60); // 50% agreement — well below kappa=0.85
    const report = computeAnchoredCalibration({ rows: [...judgeRows, ...anchorRows], asOf: "2026-07-20T00:00:00.000Z" });
    const j = report.judges[0]!;
    expect(j.sufficient).toBe(true);
    expect(j.admissible).toBe(false);
    expect(j.reasons[0]).toMatch(/CI lower bound .* < required kappa/);
  });

  it("insufficient overlap sample is inadmissible regardless of a perfect raw agreement rate", () => {
    const { judgeRows, anchorRows } = buildPairs(5, 5); // 100% agreement, but n=5 < minOverlapN=30
    const report = computeAnchoredCalibration({ rows: [...judgeRows, ...anchorRows], asOf: "2026-07-20T00:00:00.000Z" });
    const j = report.judges[0]!;
    expect(j.sufficient).toBe(false);
    expect(j.admissible).toBe(false);
    expect(j.reasons[0]).toMatch(/insufficient verifier-anchored overlap/);
  });

  it("zero overlap evidence at all reports the honest zero-sample reason", () => {
    const report = computeAnchoredCalibration({ rows: [], asOf: "2026-07-20T00:00:00.000Z" });
    expect(report.judges).toHaveLength(0);
    expect(report.items).toHaveLength(0);
  });

  it("self-graded items never count toward a judge's agreement sample", () => {
    // 40 legitimate (different-family) pairs, all agreeing, PLUS 40 same-family (self-graded) pairs
    // that would also all agree — if self-grading leaked in, this judge would look admissible with
    // n=80; it must instead report exactly n=40 and the self-graded pairs must not inflate it.
    const legit = buildPairs(40, 40);
    const selfGraded = buildPairs(40, 40, { candidateModelId: "qwen36-a3b", judgeModel: "qwen3-coder-next-80b" });
    // Re-key self-graded rows so they don't collide on binding key/id with the legit set.
    const selfJudge = selfGraded.judgeRows.map((r, i) => ({ ...r, id: `self-j-${i}`, evidenceIdentityHash: `sha256:${"b".repeat(58)}${i}` }));
    const selfAnchor = selfGraded.anchorRows.map((r, i) => ({ ...r, id: `self-a-${i}`, evidenceIdentityHash: `sha256:${"b".repeat(58)}${i}` }));
    const report = computeAnchoredCalibration({
      rows: [...legit.judgeRows, ...legit.anchorRows, ...selfJudge, ...selfAnchor],
      asOf: "2026-07-20T00:00:00.000Z",
    });
    const identities = new Set(report.judges.map((j) => j.judgeIdentity));
    expect(identities.size).toBe(2); // gpt-oss-120b (legit) and qwen3-coder-next-80b (self-graded)
    const legitJudge = report.judges.find((j) => j.judgeModel === "gpt-oss-120b")!;
    expect(legitJudge.windowedN).toBe(40);
    const selfJudgeAgg = report.judges.find((j) => j.judgeModel === "qwen3-coder-next-80b")!;
    // Every item for this identity was self-graded, so it must be excluded entirely — n=0.
    expect(selfJudgeAgg.windowedN).toBe(0);
    expect(selfJudgeAgg.admissible).toBe(false);
  });
});

// ─── Decay (rolling-window freshness) ─────────────────────────────────────────────

describe("computeAnchoredCalibration — decay", () => {
  it("an admissible judge automatically decays to inadmissible once its overlap sample ages out of the window", () => {
    const { judgeRows, anchorRows } = buildPairs(120, 116, { ts: "2026-06-01T00:00:00.000Z" });
    const rows = [...judgeRows, ...anchorRows];

    const fresh = computeAnchoredCalibration({ rows, asOf: "2026-06-15T00:00:00.000Z" }); // 14d later, within default 30d window
    expect(fresh.judges[0]!.admissible).toBe(true);

    const stale = computeAnchoredCalibration({ rows, asOf: "2026-08-01T00:00:00.000Z" }); // 61d later, aged out
    expect(stale.judges[0]!.windowedN).toBe(0);
    expect(stale.judges[0]!.admissible).toBe(false);
    expect(stale.judges[0]!.reasons[0]).toMatch(/no verifier-anchored overlap evidence in the rolling window/);
  });

  it("a count-mode window keeps only the most recent N overlap items per judge", () => {
    const { judgeRows, anchorRows } = buildPairs(50, 50, { ts: "2026-07-01T00:00:00.000Z" });
    const rows = [...judgeRows, ...anchorRows];
    const report = computeAnchoredCalibration({
      rows,
      asOf: "2026-07-01T00:00:00.000Z",
      config: { window: { mode: "count", count: 10 }, minOverlapN: 5 },
    });
    expect(report.judges[0]!.windowedN).toBe(10);
  });
});

// ─── Receipt synthesis ────────────────────────────────────────────────────────────

describe("anchoredReceiptsFrom", () => {
  it("emits a receipt only for admissible judges' overlap items, rated from the ANCHOR verdict", () => {
    const { judgeRows, anchorRows } = buildPairs(120, 116);
    const report = computeAnchoredCalibration({ rows: [...judgeRows, ...anchorRows], asOf: "2026-07-20T00:00:00.000Z" });
    const receipts = anchoredReceiptsFrom(report);
    expect(receipts).toHaveLength(120);
    expect(receipts.every((r) => r.rating === "pass")).toBe(true); // anchorOutcome was "pass" for every pair
    expect(receipts.every((r) => r.disposition === "verifier-anchored")).toBe(true);
  });

  it("emits zero receipts for an inadmissible (below-kappa) judge — contributes nothing trusted", () => {
    const { judgeRows, anchorRows } = buildPairs(120, 60);
    const report = computeAnchoredCalibration({ rows: [...judgeRows, ...anchorRows], asOf: "2026-07-20T00:00:00.000Z" });
    expect(anchoredReceiptsFrom(report)).toHaveLength(0);
  });

  it("emits zero receipts for self-graded overlap items even if the judge identity is otherwise admissible", () => {
    const { judgeRows, anchorRows } = buildPairs(120, 120, { candidateModelId: "qwen36-a3b", judgeModel: "qwen3-coder-next-80b" });
    const report = computeAnchoredCalibration({ rows: [...judgeRows, ...anchorRows], asOf: "2026-07-20T00:00:00.000Z" });
    // The identity itself is inadmissible (its only items are self-graded, n=0) — belt-and-suspenders
    // with buildAnchoredOverlapItems's own selfGraded flag, both must independently block the receipt.
    expect(report.judges[0]!.admissible).toBe(false);
    expect(anchoredReceiptsFrom(report)).toHaveLength(0);
  });
});

// ─── Human + anchored merge ───────────────────────────────────────────────────────

describe("mergeCalibrationReceipts", () => {
  it("passes through anchored-only receipts when no human receipts exist", () => {
    const anchored = [receiptFor("k1", "pass")];
    expect(mergeCalibrationReceipts([], anchored)).toEqual(anchored);
  });

  it("passes through human-only receipts when no anchored receipts exist", () => {
    const human = [receiptFor("k1", "pass")];
    expect(mergeCalibrationReceipts(human, [])).toEqual(human);
  });

  it("deduplicates when human and anchored agree on the same binding key", () => {
    const merged = mergeCalibrationReceipts([receiptFor("k1", "pass")], [receiptFor("k1", "pass")]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.rating).toBe("pass");
  });

  it("marks a genuine human/anchored disagreement as conflicted, never a silent pick of one side", () => {
    const merged = mergeCalibrationReceipts([receiptFor("k1", "pass")], [receiptFor("k1", "fail")]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.rating).toBe("conflicted");
  });
});

// ─── End-to-end: the existing #6 gate reused verbatim, fed by the anchored feed ───

describe("computeLiveCalibrationGate — anchored/both mode reaches GO with zero human receipts", () => {
  it("mode 'anchored': GO from verifier-anchored overlap evidence alone", () => {
    const { judgeRows, anchorRows } = buildPairs(116, 116); // all agree
    const { judgeRows: falseNegJudge, anchorRows: falseNegAnchor } = (() => {
      // 4 additional attempts where the judge disagrees (predicts fail, anchor truth is pass) —
      // mirrors calibration-gate-live.test.ts's own 116/4 GO fixture exactly, just sourced from
      // verifier overlap instead of a human Quality Receipts export.
      const j: CalibrationSampleRow[] = [];
      const a: CalibrationSampleRow[] = [];
      for (let i = 116; i < 120; i++) {
        const pair = overlapPair({ i, judgeOutcome: "fail", anchorOutcome: "pass" });
        j.push(pair.judgeRow);
        a.push(pair.anchorRow);
      }
      return { judgeRows: j, anchorRows: a };
    })();
    const rows = [...judgeRows, ...falseNegJudge, ...anchorRows, ...falseNegAnchor];

    const gate = computeLiveCalibrationGate({
      rows,
      receipts: [],
      generatedAt: "2026-07-20T00:00:00.000Z",
      targetPerStratum: 200,
      mode: "anchored",
    });
    if (gate.verdict !== "GO") throw new Error(`expected GO, got HOLD: ${gate.reasons.join(" | ")}`);
    expect(gate.verdict).toBe("GO");
  });

  it("mode 'both' (default): identical GO with zero human receipts when overlap evidence clears kappa", () => {
    const { judgeRows, anchorRows } = buildPairs(120, 116);
    const gate = computeLiveCalibrationGate({
      rows: [...judgeRows, ...anchorRows],
      receipts: [],
      generatedAt: "2026-07-20T00:00:00.000Z",
      targetPerStratum: 200,
    });
    expect(gate.verdict).toBe("GO");
  });

  it("mode 'human': the SAME rows with no human receipts stay HOLD — anchored evidence is not silently consulted", () => {
    const { judgeRows, anchorRows } = buildPairs(120, 116);
    const gate = computeLiveCalibrationGate({
      rows: [...judgeRows, ...anchorRows],
      receipts: [],
      generatedAt: "2026-07-20T00:00:00.000Z",
      targetPerStratum: 200,
      mode: "human",
    });
    expect(gate.verdict).toBe("HOLD");
  });

  it("below-kappa judge agreement holds the gate even in 'both' mode", () => {
    const { judgeRows, anchorRows } = buildPairs(120, 60);
    const gate = computeLiveCalibrationGate({
      rows: [...judgeRows, ...anchorRows],
      receipts: [],
      generatedAt: "2026-07-20T00:00:00.000Z",
      targetPerStratum: 200,
    });
    expect(gate.verdict).toBe("HOLD");
  });

  it("insufficient overlap sample holds the gate", () => {
    const { judgeRows, anchorRows } = buildPairs(5, 5);
    const gate = computeLiveCalibrationGate({
      rows: [...judgeRows, ...anchorRows],
      receipts: [],
      generatedAt: "2026-07-20T00:00:00.000Z",
      targetPerStratum: 200,
    });
    expect(gate.verdict).toBe("HOLD");
  });

  it("a stale window decays a previously-GO anchored gate back to HOLD (fail-closed freshness)", () => {
    const { judgeRows, anchorRows } = buildPairs(120, 116, { ts: "2026-06-01T00:00:00.000Z" });
    const rows = [...judgeRows, ...anchorRows];

    const freshGate = computeLiveCalibrationGate({
      rows,
      receipts: [],
      generatedAt: "2026-06-15T00:00:00.000Z", // 14d later — within the default 30d window
      targetPerStratum: 200,
    });
    expect(freshGate.verdict).toBe("GO");

    const staleGate = computeLiveCalibrationGate({
      rows,
      receipts: [],
      generatedAt: "2026-08-01T00:00:00.000Z", // 61d later — aged out of the default 30d window
      targetPerStratum: 200,
    });
    expect(staleGate.verdict).toBe("HOLD");
  });

  it("human receipts remain a fully optional additional anchor — merging them into an already-GO anchored gate keeps GO", () => {
    const { judgeRows, anchorRows } = buildPairs(120, 116);
    const rows = [...judgeRows, ...anchorRows];
    const humanReceipts = judgeRows.slice(0, 10).map((r) => receiptFor(r.evidenceIdentityHash!, "pass"));
    const gate = computeLiveCalibrationGate({
      rows,
      receipts: humanReceipts,
      generatedAt: "2026-07-20T00:00:00.000Z",
      targetPerStratum: 200,
      mode: "both",
    });
    expect(gate.verdict).toBe("GO");
  });

  it("existing #37 human-only behavior is unaffected when rows carry no verifier-anchored overlap at all", () => {
    // Reproduces calibration-gate-live.test.ts's own GO fixture verbatim under the NEW default mode
    // ("both") — proving #37 callers who never pass `mode` see identical behavior when there is no
    // anchored evidence to find.
    const truePos = Array.from({ length: 116 }, () => row({ outcome: "pass", score: 0.95, promptTokens: 20_000 }));
    const falseNeg = Array.from({ length: 4 }, () => row({ outcome: "fail", score: 0.1, promptTokens: 20_000 }));
    const rows = [...truePos, ...falseNeg];
    const receipts = rows.map((r) => receiptFor(`row:${r.id}`, "pass"));
    const gate = computeLiveCalibrationGate({
      rows,
      receipts,
      generatedAt: "2026-07-20T00:00:00.000Z",
      targetPerStratum: 200,
    });
    expect(gate.verdict).toBe("GO");
  });
});
