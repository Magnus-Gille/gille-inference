/**
 * corpus-version.test.ts — pins the weekly-scout probe battery's version + content fingerprint
 * (#12 AC: "the corpus and exact evaluation configuration are versioned and reproducible").
 *
 * The pinned CURRENT_FINGERPRINT mirrors the gate-d/verify-fixtures.sh GATE_D_STRICT_PIN pattern:
 * an accidental edit to any probe's id/taskType/prompt/systemPrompt/verifierName/maxTokens/
 * reviewExpectedFindings changes the fingerprint and fails this test until the change is
 * acknowledged (update PROBE_BATTERY_VERSION + this pinned value together, deliberately).
 */
import { describe, it, expect } from "vitest";
import { PROBES, PROBE_BATTERY_VERSION, CORPUS_FINGERPRINT } from "../src/homeserver/probes.js";
import { computeCorpusFingerprint } from "../src/homeserver/corpus-version.js";
import type { Probe } from "../src/homeserver/probes.js";

// Pinned golden value for the CURRENT corpus. Recompute deliberately (never copy blindly) when
// PROBES intentionally changes, and bump PROBE_BATTERY_VERSION in the same change.
const CURRENT_FINGERPRINT = "f4284272894602b1";

describe("PROBE_BATTERY_VERSION + CORPUS_FINGERPRINT — reproducibility pin", () => {
  it("is a non-empty version string", () => {
    expect(typeof PROBE_BATTERY_VERSION).toBe("string");
    expect(PROBE_BATTERY_VERSION.length).toBeGreaterThan(0);
  });

  it("CORPUS_FINGERPRINT is computed from PROBES itself, not a hand-copied literal", () => {
    expect(CORPUS_FINGERPRINT).toBe(computeCorpusFingerprint(PROBES));
  });

  it("is deterministic across repeated calls", () => {
    expect(computeCorpusFingerprint(PROBES)).toBe(computeCorpusFingerprint(PROBES));
  });

  // The pin itself: fails loudly (not silently) the moment the corpus content actually changes.
  it("matches the pinned fingerprint for the current corpus (bump deliberately on a real corpus edit)", () => {
    expect(CORPUS_FINGERPRINT).toBe(CURRENT_FINGERPRINT);
  });

  it("changes when a probe's prompt changes (sensitivity to real drift)", () => {
    const mutated: Probe[] = PROBES.map((p, i) => (i === 0 ? { ...p, prompt: p.prompt + " " } : p));
    expect(computeCorpusFingerprint(mutated)).not.toBe(CORPUS_FINGERPRINT);
  });

  it("changes when a seeded-bug expected-findings count changes", () => {
    const idx = PROBES.findIndex((p) => p.reviewExpectedFindings !== undefined);
    expect(idx).toBeGreaterThanOrEqual(0);
    const mutated: Probe[] = PROBES.map((p, i) =>
      i === idx ? { ...p, reviewExpectedFindings: (p.reviewExpectedFindings ?? 0) + 1 } : p
    );
    expect(computeCorpusFingerprint(mutated)).not.toBe(CORPUS_FINGERPRINT);
  });

  it("is sensitive to probe ORDER (not just content, since order affects reproducibility claims)", () => {
    if (PROBES.length < 2) return;
    const reordered = [PROBES[1]!, PROBES[0]!, ...PROBES.slice(2)];
    expect(computeCorpusFingerprint(reordered)).not.toBe(computeCorpusFingerprint(PROBES));
  });

  it("is empty-input stable (does not throw on an empty battery)", () => {
    expect(() => computeCorpusFingerprint([])).not.toThrow();
  });
});
