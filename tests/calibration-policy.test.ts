/**
 * Calibration judge-policy identity tests (issue #6, AC: "judge-policy changes supersede rather
 * than rewrite old evidence").
 */
import { describe, it, expect } from "vitest";
import {
  CURRENT_CALIBRATION_POLICY,
  DEFAULT_CALIBRATION_THRESHOLDS,
  calibrationPolicyId,
  supersedes,
  type CalibrationPolicy,
} from "../src/homeserver/calibration-policy.js";

function policy(overrides: Partial<CalibrationPolicy> = {}): CalibrationPolicy {
  return { ...CURRENT_CALIBRATION_POLICY, thresholds: { ...DEFAULT_CALIBRATION_THRESHOLDS }, ...overrides };
}

describe("calibrationPolicyId", () => {
  it("is deterministic for identical policies", () => {
    expect(calibrationPolicyId(policy())).toBe(calibrationPolicyId(policy()));
  });

  it("changes when the judge model changes", () => {
    const a = calibrationPolicyId(policy({ judgeModel: "gpt-oss-120b" }));
    const b = calibrationPolicyId(policy({ judgeModel: "qwen3-coder-next-80b" }));
    expect(a).not.toBe(b);
  });

  it("changes when a THRESHOLD alone changes — a threshold tightening is a real policy change", () => {
    const a = calibrationPolicyId(policy());
    const b = calibrationPolicyId(policy({ thresholds: { ...DEFAULT_CALIBRATION_THRESHOLDS, minPrecisionLowerBound: 0.95 } }));
    expect(a).not.toBe(b);
  });

  it("changes when rubricVersion changes", () => {
    const a = calibrationPolicyId(policy({ rubricVersion: "v1" }));
    const b = calibrationPolicyId(policy({ rubricVersion: "v2" }));
    expect(a).not.toBe(b);
  });

  it("is a sha256: content digest", () => {
    expect(calibrationPolicyId(policy())).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});

describe("supersedes", () => {
  it("starts a fresh lineage with supersedesId null when previous is null", () => {
    const entry = supersedes(policy(), null);
    expect(entry.supersedesId).toBeNull();
    expect(entry.id).toBe(calibrationPolicyId(policy()));
  });

  it("records the OLD policy's id as supersedesId — old evidence stays keyed to the old id", () => {
    const oldPolicy = policy({ judgeModel: "gpt-oss-120b" });
    const newPolicy = policy({ judgeModel: "qwen3-coder-next-80b" });
    const entry = supersedes(newPolicy, oldPolicy);
    expect(entry.supersedesId).toBe(calibrationPolicyId(oldPolicy));
    expect(entry.id).toBe(calibrationPolicyId(newPolicy));
    expect(entry.supersedesId).not.toBe(entry.id);
  });

  it("throws rather than fabricate lineage for two byte-identical policies", () => {
    const p = policy();
    expect(() => supersedes(p, p)).toThrow(/hash identically/);
  });

  it("REWRITES nothing — building a new lineage entry does not mutate the previous policy object", () => {
    const oldPolicy = policy({ judgeModel: "gpt-oss-120b" });
    const oldId = calibrationPolicyId(oldPolicy);
    supersedes(policy({ judgeModel: "qwen3-coder-next-80b" }), oldPolicy);
    expect(calibrationPolicyId(oldPolicy)).toBe(oldId); // unchanged
  });
});
