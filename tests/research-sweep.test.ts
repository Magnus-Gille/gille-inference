/** Pure-helper tests for weekly-research-sweep.ts (no network/spawn). */
import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  selectQueries,
  isoWeek,
  buildSynthPrompt,
  renderProposalsMarkdown,
  describeSpawnFailure,
  clearStaleOutput,
  QUERY_SET,
} from "../scripts/weekly-research-sweep.js";
import type { ResearchProposal } from "../src/homeserver/research-proposals.js";

describe("QUERY_SET", () => {
  it("every theme has both an English and a Chinese query", () => {
    for (const t of QUERY_SET) {
      expect(t.en.length).toBeGreaterThan(10);
      expect(t.zh.length).toBeGreaterThan(5);
      expect(/[一-鿿]/.test(t.zh)).toBe(true); // contains CJK
    }
  });
});

describe("selectQueries", () => {
  it("returns the requested count and rotates by week", () => {
    const a = selectQueries(6, 10);
    const b = selectQueries(6, 11);
    expect(a.length).toBe(6);
    expect(a.map((q) => q.query)).not.toEqual(b.map((q) => q.query)); // window advanced
  });
  it("returns all queries when max >= total (order-stable)", () => {
    const all = selectQueries(999, 3);
    expect(all.length).toBe(QUERY_SET.length * 2);
  });
});

describe("isoWeek", () => {
  it("computes a plausible ISO week", () => {
    expect(isoWeek(new Date("2026-01-05T00:00:00Z"))).toBe(2);
    const w = isoWeek(new Date("2026-06-29T00:00:00Z"));
    expect(w).toBeGreaterThan(20);
    expect(w).toBeLessThan(30);
  });
});

describe("buildSynthPrompt", () => {
  it("embeds the summaries and demands a JSON array of proposals", () => {
    const p = buildSynthPrompt([{ theme: "quant", query: "q", text: "use imatrix" }]);
    expect(p).toContain("use imatrix");
    expect(p).toContain("JSON array");
    expect(p).toContain("expectedGain");
  });
});

describe("renderProposalsMarkdown", () => {
  const prop: ResearchProposal = { title: "Spec decode", idea: "draft model", rationale: "2x", expectedGain: "speed", effort: "M", sources: ["https://x"] };
  it("renders a heading per proposal with gain/effort and sources", () => {
    const md = renderProposalsMarkdown([prop], "2026-06-29T00:00:00Z");
    expect(md).toContain("# Stuff we should try");
    expect(md).toContain("## Spec decode");
    expect(md).toContain("effort M");
    expect(md).toContain("<https://x>");
  });
  it("handles the empty case", () => {
    expect(renderProposalsMarkdown([], "2026-06-29T00:00:00Z")).toContain("No proposals");
  });
});

describe("describeSpawnFailure", () => {
  it("surfaces a spawn-level error (e.g. npx missing from PATH) instead of swallowing it (#200)", () => {
    const reason = describeSpawnFailure({ error: new Error("spawn npx ENOENT"), status: null });
    expect(reason).toContain("spawn npx ENOENT");
  });
  it("includes captured stderr when the subprocess ran but exited non-zero", () => {
    const reason = describeSpawnFailure({ status: 1, stderr: "search provider not configured: SEARCH_PROVIDER unset" });
    expect(reason).toContain("1");
    expect(reason).toContain("SEARCH_PROVIDER unset");
  });
  it("flags a non-zero exit with no captured stderr rather than going silent", () => {
    const reason = describeSpawnFailure({ status: 1, stderr: "" });
    expect(reason.toLowerCase()).toContain("no stderr");
  });
  it("returns empty string on success", () => {
    expect(describeSpawnFailure({ status: 0, stderr: "" })).toBe("");
  });
});

describe("clearStaleOutput", () => {
  it("removes an existing proposals.json so a failed run can't leave a stale success behind (#230 review)", () => {
    const dir = mkdtempSync(join(tmpdir(), "hs-sweep-stale-test-"));
    const path = join(dir, "proposals.json");
    writeFileSync(path, JSON.stringify({ proposals: [{ title: "old", idea: "x" }] }));
    clearStaleOutput(dir);
    expect(existsSync(path)).toBe(false);
  });
  it("is a no-op when there is nothing to clear", () => {
    const dir = mkdtempSync(join(tmpdir(), "hs-sweep-stale-test-"));
    expect(() => clearStaleOutput(dir)).not.toThrow();
  });
});
