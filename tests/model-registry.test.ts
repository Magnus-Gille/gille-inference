/**
 * TDD for model-registry.ts — written BEFORE the implementation exists (red first).
 *
 * Run:  npx vitest run tests/model-registry.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendEntry,
  readRegistry,
  latestByModel,
  isEvaluated,
  servedIds,
  evaluatedIds,
  isRegistryEntry,
  DEFAULT_REGISTRY_PATH,
} from "../src/homeserver/model-registry.js";
import type { RegistryEntry } from "../src/homeserver/scout-types.js";

// ── helpers ──────────────────────────────────────────────────────────────────

const TMP = join(tmpdir(), "model-registry-test.jsonl");

function makeEntry(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    id: "org/model",
    quant: "Q4_K_M",
    sizeGB: 4.5,
    evaluatedAt: "2026-06-01T00:00:00.000Z",
    verdict: "winner",
    passRate: 0.9,
    avgTokPerSec: 42,
    scoresByTaskType: { code: 0.95 },
    served: true,
    ...overrides,
  };
}

beforeEach(() => {
  if (existsSync(TMP)) unlinkSync(TMP);
});
afterEach(() => {
  if (existsSync(TMP)) unlinkSync(TMP);
});

// ── DEFAULT_REGISTRY_PATH ────────────────────────────────────────────────────

describe("DEFAULT_REGISTRY_PATH", () => {
  it("is an absolute path ending in model-scout-registry.jsonl", () => {
    expect(DEFAULT_REGISTRY_PATH).toMatch(/model-scout-registry\.jsonl$/);
    expect(DEFAULT_REGISTRY_PATH.startsWith("/")).toBe(true);
  });
});

// ── round-trip ───────────────────────────────────────────────────────────────

describe("appendEntry + readRegistry round-trip", () => {
  it("persists a single entry and reads it back unchanged", () => {
    const e = makeEntry();
    appendEntry(e, TMP);
    const result = readRegistry(TMP);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(e);
  });

  it("preserves insertion order for multiple entries", () => {
    const a = makeEntry({ id: "org/a", evaluatedAt: "2026-06-01T00:00:00.000Z" });
    const b = makeEntry({ id: "org/b", evaluatedAt: "2026-06-02T00:00:00.000Z" });
    const c = makeEntry({ id: "org/c", evaluatedAt: "2026-06-03T00:00:00.000Z" });
    appendEntry(a, TMP);
    appendEntry(b, TMP);
    appendEntry(c, TMP);
    const result = readRegistry(TMP);
    expect(result.map((r) => r.id)).toEqual(["org/a", "org/b", "org/c"]);
  });

  it("round-trips the persisted probe error summary (#158)", () => {
    const e = makeEntry({ probeErrors: 5, probeTotalRuns: 20, probeErrorRate: 0.25 });
    appendEntry(e, TMP);
    expect(readRegistry(TMP)[0]).toEqual(e);
  });
});

// ── readRegistry resilience ──────────────────────────────────────────────────

describe("readRegistry", () => {
  it("returns [] for a non-existent path", () => {
    expect(readRegistry("/tmp/__no_such_file_xyz__.jsonl")).toEqual([]);
  });

  it("skips blank lines without throwing", () => {
    const e = makeEntry();
    writeFileSync(TMP, "\n" + JSON.stringify(e) + "\n\n");
    expect(readRegistry(TMP)).toHaveLength(1);
  });

  it("skips malformed JSON lines without throwing", () => {
    const e = makeEntry();
    writeFileSync(TMP, JSON.stringify(e) + "\n{not json}\n" + JSON.stringify(makeEntry({ id: "org/b" })) + "\n");
    const result = readRegistry(TMP);
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.id)).toEqual(["org/model", "org/b"]);
  });

  it("skips shape-invalid lines (parsed but fails isRegistryEntry)", () => {
    const good = makeEntry();
    const bad = { id: "org/bad", quant: "Q4_K_M" }; // missing required fields
    writeFileSync(TMP, JSON.stringify(good) + "\n" + JSON.stringify(bad) + "\n");
    const result = readRegistry(TMP);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("org/model");
  });

  it("handles a mix of good, blank, bad-JSON, and shape-invalid lines", () => {
    const good1 = makeEntry({ id: "org/good1" });
    const good2 = makeEntry({ id: "org/good2" });
    const lines = [
      JSON.stringify(good1),
      "",
      "{broken json}",
      JSON.stringify({ id: 123 }), // wrong type for id
      JSON.stringify(good2),
      "   ", // whitespace-only
    ].join("\n");
    writeFileSync(TMP, lines + "\n");
    const result = readRegistry(TMP);
    expect(result.map((r) => r.id)).toEqual(["org/good1", "org/good2"]);
  });
});

// ── latestByModel ────────────────────────────────────────────────────────────

describe("latestByModel", () => {
  it("returns an empty Map for empty input", () => {
    expect(latestByModel([]).size).toBe(0);
  });

  it("keeps the later evaluatedAt when two entries share an id", () => {
    const old = makeEntry({ id: "org/m", evaluatedAt: "2026-06-01T00:00:00.000Z", passRate: 0.5 });
    const newer = makeEntry({ id: "org/m", evaluatedAt: "2026-06-10T00:00:00.000Z", passRate: 0.9 });
    const m = latestByModel([old, newer]);
    expect(m.get("org/m")?.passRate).toBe(0.9);
  });

  it("is order-independent: [newer, older] produces the same result", () => {
    const old = makeEntry({ id: "org/m", evaluatedAt: "2026-06-01T00:00:00.000Z", passRate: 0.5 });
    const newer = makeEntry({ id: "org/m", evaluatedAt: "2026-06-10T00:00:00.000Z", passRate: 0.9 });
    const m = latestByModel([newer, old]);
    expect(m.get("org/m")?.passRate).toBe(0.9);
  });

  it("tracks multiple distinct ids independently", () => {
    const a = makeEntry({ id: "org/a", evaluatedAt: "2026-06-01T00:00:00.000Z" });
    const b = makeEntry({ id: "org/b", evaluatedAt: "2026-06-05T00:00:00.000Z" });
    const m = latestByModel([a, b]);
    expect(m.size).toBe(2);
    expect(m.has("org/a")).toBe(true);
    expect(m.has("org/b")).toBe(true);
  });
});

// ── servedIds ────────────────────────────────────────────────────────────────

describe("servedIds", () => {
  it("returns ids whose LATEST entry has served=true", () => {
    const e = makeEntry({ id: "org/m", served: true });
    expect(servedIds([e])).toContain("org/m");
  });

  it("excludes ids whose LATEST entry has served=false (even if an older entry had served=true)", () => {
    const old = makeEntry({ id: "org/m", evaluatedAt: "2026-06-01T00:00:00.000Z", served: true });
    const newer = makeEntry({ id: "org/m", evaluatedAt: "2026-06-10T00:00:00.000Z", served: false });
    expect(servedIds([old, newer])).not.toContain("org/m");
  });

  it("returns [] for empty input", () => {
    expect(servedIds([])).toEqual([]);
  });

  it("handles multiple models with mixed served flags", () => {
    const a = makeEntry({ id: "org/a", served: true });
    const b = makeEntry({ id: "org/b", served: false });
    const c = makeEntry({ id: "org/c", served: true });
    const ids = servedIds([a, b, c]);
    expect(ids).toContain("org/a");
    expect(ids).not.toContain("org/b");
    expect(ids).toContain("org/c");
  });
});

// ── isEvaluated ──────────────────────────────────────────────────────────────

describe("isEvaluated", () => {
  it("returns true when the id is present in entries", () => {
    expect(isEvaluated("org/model", [makeEntry()])).toBe(true);
  });

  it("returns false when the id is absent", () => {
    expect(isEvaluated("org/other", [makeEntry()])).toBe(false);
  });

  it("returns false for empty entries", () => {
    expect(isEvaluated("org/model", [])).toBe(false);
  });
});

// ── evaluatedIds ─────────────────────────────────────────────────────────────

describe("evaluatedIds", () => {
  it("returns a Set of all distinct ids", () => {
    const entries = [
      makeEntry({ id: "org/a" }),
      makeEntry({ id: "org/b" }),
      makeEntry({ id: "org/a" }), // duplicate
    ];
    const s = evaluatedIds(entries);
    expect(s.size).toBe(2);
    expect(s.has("org/a")).toBe(true);
    expect(s.has("org/b")).toBe(true);
  });

  it("returns an empty Set for empty input", () => {
    expect(evaluatedIds([]).size).toBe(0);
  });
});

// ── isRegistryEntry guard ────────────────────────────────────────────────────

describe("isRegistryEntry", () => {
  const good = makeEntry();

  it("accepts a well-formed entry", () => {
    expect(isRegistryEntry(good)).toBe(true);
  });

  it("rejects null", () => expect(isRegistryEntry(null)).toBe(false));
  it("rejects a string", () => expect(isRegistryEntry("{}")).toBe(false));
  it("rejects a number", () => expect(isRegistryEntry(42)).toBe(false));
  it("rejects {}", () => expect(isRegistryEntry({})).toBe(false));

  it("rejects when id is not a string", () => {
    expect(isRegistryEntry({ ...good, id: 123 })).toBe(false);
  });
  it("rejects when quant is not a string", () => {
    expect(isRegistryEntry({ ...good, quant: null })).toBe(false);
  });
  it("rejects when sizeGB is not a number", () => {
    expect(isRegistryEntry({ ...good, sizeGB: "4.5" })).toBe(false);
  });
  it("rejects when evaluatedAt is not a string", () => {
    expect(isRegistryEntry({ ...good, evaluatedAt: 0 })).toBe(false);
  });
  it("rejects when verdict is not a string", () => {
    expect(isRegistryEntry({ ...good, verdict: true })).toBe(false);
  });
  it("rejects when passRate is not a number", () => {
    expect(isRegistryEntry({ ...good, passRate: "0.9" })).toBe(false);
  });
  it("rejects when served is not a boolean", () => {
    expect(isRegistryEntry({ ...good, served: 1 })).toBe(false);
  });
  it("rejects when scoresByTaskType is not an object", () => {
    expect(isRegistryEntry({ ...good, scoresByTaskType: "nope" })).toBe(false);
  });
  it("rejects when scoresByTaskType is null", () => {
    expect(isRegistryEntry({ ...good, scoresByTaskType: null })).toBe(false);
  });
  it("rejects when scoresByTaskType is an array", () => {
    expect(isRegistryEntry({ ...good, scoresByTaskType: [] })).toBe(false);
  });

  // #158 probe reliability summary: optional, but when present it must be numeric and bounded.
  it("accepts a well-formed persisted probe error summary", () => {
    expect(isRegistryEntry({ ...good, probeErrors: 5, probeTotalRuns: 20, probeErrorRate: 0.25 })).toBe(true);
  });
  it("rejects malformed probe error summary fields", () => {
    expect(isRegistryEntry({ ...good, probeErrors: "5" })).toBe(false);
    expect(isRegistryEntry({ ...good, probeTotalRuns: -1 })).toBe(false);
    expect(isRegistryEntry({ ...good, probeErrorRate: 1.5 })).toBe(false);
  });
  it("accepts bounded empty/truncation and review ground-truth evidence", () => {
    expect(isRegistryEntry({
      ...good,
      probeEmptyOutputs: 2,
      probeEmptyOutputRate: 0.1,
      probeTruncations: 3,
      probeTruncationRate: 0.15,
      probeFinishReasons: { stop: 14, length: 3, missing: 1 },
      codeReviewSeededBugs: 34,
      codeReviewTruePositives: 28,
      codeReviewReportedFindings: 30,
      codeReviewCleanControls: 6,
      codeReviewConfabulatedCleanControls: 1,
      codeReviewRecall: 0.82,
      codeReviewPrecision: 0.93,
      codeReviewCleanConfabulationRate: 1 / 6,
    })).toBe(true);
  });
  it("rejects malformed extended scout evidence", () => {
    expect(isRegistryEntry({ ...good, probeEmptyOutputs: -1 })).toBe(false);
    expect(isRegistryEntry({ ...good, probeTruncationRate: 2 })).toBe(false);
    expect(isRegistryEntry({ ...good, codeReviewRecall: "0.8" })).toBe(false);
    expect(isRegistryEntry({ ...good, codeReviewPrecision: -0.1 })).toBe(false);
    expect(isRegistryEntry({ ...good, probeFinishReasons: { stop: -1 } })).toBe(false);
    expect(isRegistryEntry({ ...good, probeFinishReasons: { stop: 1.5 } })).toBe(false);
    expect(isRegistryEntry({ ...good, codeReviewSeededBugs: -1 })).toBe(false);
    expect(isRegistryEntry({ ...good, codeReviewTruePositives: 1.5 })).toBe(false);
    expect(isRegistryEntry({
      ...good,
      codeReviewSeededBugs: 2,
      codeReviewTruePositives: 3,
      codeReviewReportedFindings: 3,
      codeReviewCleanControls: 1,
      codeReviewConfabulatedCleanControls: 0,
    })).toBe(false);
    expect(isRegistryEntry({
      ...good,
      codeReviewSeededBugs: 2,
      codeReviewTruePositives: 2,
      codeReviewReportedFindings: 1,
      codeReviewCleanControls: 1,
      codeReviewConfabulatedCleanControls: 2,
    })).toBe(false);
  });

  // #176 gateFlags: optional, but when present must be a string[] (fail closed on a malformed row).
  it("accepts an absent gateFlags", () => {
    expect(isRegistryEntry(good)).toBe(true);
  });
  it("accepts a well-formed string[] gateFlags", () => {
    expect(isRegistryEntry({ ...good, gateFlags: ["name-gaming-tell: tau2"] })).toBe(true);
    expect(isRegistryEntry({ ...good, gateFlags: [] })).toBe(true);
  });
  it("rejects a non-array gateFlags", () => {
    expect(isRegistryEntry({ ...good, gateFlags: "oops" })).toBe(false);
  });
  it("rejects a gateFlags array with a non-string element", () => {
    expect(isRegistryEntry({ ...good, gateFlags: ["ok", 42] })).toBe(false);
  });
});
