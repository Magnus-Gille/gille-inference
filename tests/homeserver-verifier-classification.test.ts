import { describe, it, expect } from "vitest";
import {
  STRUCTURAL_VERIFIERS,
  MECHANICAL_FORMAT_VERIFIERS,
  verifierBaseName,
  isStructuralVerifier,
  isQualityBearingVerifier,
  isTrustedJudgmentVerifier,
  classifyVerifierKind,
} from "../src/homeserver/verifier-classification.js";

// #156 (proposal 1): structural vs quality-bearing verifier classification. STRUCTURAL verifiers
// check shape/presence only (nonEmpty/jsonValid/maxLength); QUALITY-BEARING ones grade the answer.

describe("verifierBaseName", () => {
  it("strips a parameter suffix", () => {
    expect(verifierBaseName("nonEmpty(1)")).toBe("nonEmpty");
    expect(verifierBaseName("nonEmpty(0)")).toBe("nonEmpty");
    expect(verifierBaseName("maxLength")).toBe("maxLength");
  });
  it("is a no-op for an unparameterised name", () => {
    expect(verifierBaseName("answerIs")).toBe("answerIs");
  });
});

describe("isStructuralVerifier", () => {
  it("recognises the three structural verifiers (with or without params)", () => {
    expect(isStructuralVerifier("nonEmpty(1)")).toBe(true);
    expect(isStructuralVerifier("nonEmpty")).toBe(true);
    expect(isStructuralVerifier("jsonValid")).toBe(true);
    expect(isStructuralVerifier("maxLength")).toBe(true);
    // the set is exactly these three
    expect([...STRUCTURAL_VERIFIERS].sort()).toEqual(["jsonValid", "maxLength", "nonEmpty"]);
  });
  it("is false for quality-bearing, unknown, and absent verifiers", () => {
    expect(isStructuralVerifier("answerIs")).toBe(false);
    expect(isStructuralVerifier("predicate")).toBe(false);
    expect(isStructuralVerifier(null)).toBe(false);
    expect(isStructuralVerifier(undefined)).toBe(false);
    expect(isStructuralVerifier("")).toBe(false);
  });
});

describe("isQualityBearingVerifier", () => {
  it("is FALSE for structural verifiers (shape/presence ≠ quality)", () => {
    for (const v of ["nonEmpty(1)", "nonEmpty", "jsonValid", "maxLength"]) {
      expect(isQualityBearingVerifier(v)).toBe(false);
    }
  });

  it("is FALSE for an ungraded row (null / empty verifier)", () => {
    expect(isQualityBearingVerifier(null)).toBe(false);
    expect(isQualityBearingVerifier(undefined)).toBe(false);
    expect(isQualityBearingVerifier("")).toBe(false);
    expect(isQualityBearingVerifier("   ")).toBe(false);
  });

  it("is TRUE for the registry's grading verifiers and probe-native checks", () => {
    // verifier-registry.ts named verifiers + the probe-native predicate/tsGate names.
    for (const v of ["answerIs", "exact", "containsAll", "numeric", "matches", "predicate", "tsGate"]) {
      expect(isQualityBearingVerifier(v)).toBe(true);
    }
  });

  it("treats an UNKNOWN/future verifier name as quality-bearing (conservative default)", () => {
    expect(isQualityBearingVerifier("someFutureVerifier")).toBe(true);
  });

  it("is FALSE for the orchestrator's ungraded 'none' sentinel (no verifier ran)", () => {
    // orchestrator.ts writes verifier:"none" when no verifier was configured — admissibility-
    // equivalent to a null verifier, NOT quality-bearing.
    expect(isQualityBearingVerifier("none")).toBe(false);
  });

  it("keeps a named 'custom' verifier (a real grading function) quality-bearing", () => {
    // orchestrator.ts writes verifier:"custom" when an unnamed but REAL verifier fn graded the row.
    expect(isQualityBearingVerifier("custom")).toBe(true);
  });
});

// #168: the WHITELIST counterpart — admissible for a judgment-quality type IFF positively trusted.
describe("isTrustedJudgmentVerifier", () => {
  it("is TRUE only for a base name in the trusted set", () => {
    const trusted = new Set(["gtReview"]);
    expect(isTrustedJudgmentVerifier("gtReview", trusted)).toBe(true);
    expect(isTrustedJudgmentVerifier("predicate", trusted)).toBe(false);
    expect(isTrustedJudgmentVerifier("answerIs", trusted)).toBe(false);
  });

  it("matches a parameterised verifier on its base name", () => {
    const trusted = new Set(["gtReview"]);
    expect(isTrustedJudgmentVerifier("gtReview(strict)", trusted)).toBe(true);
  });

  it("is FALSE for an ungraded row (null / undefined / empty / whitespace) even if the set is broad", () => {
    const trusted = new Set(["gtReview", ""]);
    expect(isTrustedJudgmentVerifier(null, trusted)).toBe(false);
    expect(isTrustedJudgmentVerifier(undefined, trusted)).toBe(false);
    expect(isTrustedJudgmentVerifier("", trusted)).toBe(false);
    expect(isTrustedJudgmentVerifier("   ", trusted)).toBe(false);
  });

  it("is FALSE for every verifier under the default empty whitelist (code-review escalates until #158)", () => {
    const empty = new Set<string>();
    for (const v of ["predicate", "matches", "nonEmpty(1)", "answerIs", "custom", "gtReview"]) {
      expect(isTrustedJudgmentVerifier(v, empty)).toBe(false);
    }
  });
});

// #233: mechanical-format vs truth-oriented — a COARSER, orthogonal axis to structural/quality-bearing
// above. Deterministic pattern/value-match verifiers (containsAll, exact, answerIs, numeric, matches)
// are QUALITY-BEARING under #156 (they check something about content) but are still gameable by output
// that merely LOOKS right (contains the right substring) without the full answer being correct — the
// harvest evidence behind #233 (qa-factual 3/3 ledger-pass, one confirmed factually wrong by a human).
describe("classifyVerifierKind", () => {
  it("classifies the full mechanical-format set (with or without params)", () => {
    for (const v of [
      "nonEmpty",
      "nonEmpty(1)",
      "jsonValid",
      "maxLength",
      "maxLength(100)",
      "matches",
      "containsAll",
      "containsNone",
      "exact",
      "answerIs",
      "numeric",
      "shadow-vs-frontier",
    ]) {
      expect(classifyVerifierKind(v)).toBe("mechanical-format");
    }
    expect([...MECHANICAL_FORMAT_VERIFIERS].sort()).toEqual(
      ["answerIs", "containsAll", "containsNone", "exact", "jsonValid", "maxLength", "matches", "nonEmpty", "numeric", "shadow-vs-frontier"].sort()
    );
  });

  it("classifies ground-truth execution and model-judge verifiers as truth-oriented", () => {
    for (const v of ["tsGate", "sqlExec", "llm-judge:gpt-oss-120b", "harvest-shadow:llm-judge:mellum"]) {
      expect(classifyVerifierKind(v)).toBe("truth-oriented");
    }
  });

  it("defaults an unrecognised/future verifier to truth-oriented (conservative — never silently discount unknown evidence)", () => {
    expect(classifyVerifierKind("predicate")).toBe("truth-oriented");
    expect(classifyVerifierKind("custom")).toBe("truth-oriented");
    expect(classifyVerifierKind("check-cmd")).toBe("truth-oriented");
    expect(classifyVerifierKind("someFutureVerifier")).toBe("truth-oriented");
  });

  it("classifies a null/empty/none verifier as ungraded", () => {
    expect(classifyVerifierKind(null)).toBe("ungraded");
    expect(classifyVerifierKind(undefined)).toBe("ungraded");
    expect(classifyVerifierKind("")).toBe("ungraded");
    expect(classifyVerifierKind("   ")).toBe("ungraded");
    expect(classifyVerifierKind("none")).toBe("ungraded");
  });

  it("classifies a probe-native '+'-combined name as mechanical-format only if EVERY component is", () => {
    // probes.ts combos: real cases from the probe battery
    expect(classifyVerifierKind("containsAll+containsNone")).toBe("mechanical-format");
    // predicate is truth-oriented, so a combo including it is truth-oriented even alongside a
    // mechanical-format component — a real judgment ran as part of the pass.
    expect(classifyVerifierKind("maxLength+predicate")).toBe("truth-oriented");
    expect(classifyVerifierKind("nonEmpty+predicate")).toBe("truth-oriented");
  });
});
