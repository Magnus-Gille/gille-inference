/**
 * Tests for post-research-sweep-panel.ts (#200): the poster must never crash on missing/empty
 * input — it must turn "the sweep produced nothing" into an explicit status=fail Heimdall panel.
 *   readProposals   — pure(ish) fs reader, now returns a discriminated result instead of throwing
 *   buildFailPanel  — pure panel builder for the failure case
 * Plus an ACCEPTANCE test that drives the real CLI as a subprocess against a nonexistent
 * proposals.json (the exact #200 repro) and asserts it does not crash.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readProposals, buildFailPanel } from "../scripts/post-research-sweep-panel.js";
import { PANEL_ID_RE } from "../src/homeserver/heimdall-push.js";

const REPO_ROOT = resolve(__dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "post-research-sweep-panel.ts");
const TSX = join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");

describe("readProposals", () => {
  it("returns ok:false with a clear reason when the file does not exist (#200 repro)", () => {
    const dir = mkdtempSync(join(tmpdir(), "hs-research-panel-test-"));
    const result = readProposals(join(dir, "does-not-exist.json"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("no proposals file");
      expect(result.reason.toLowerCase()).toContain("prerequisite");
    }
  });

  it("returns ok:false when the file parses but has zero proposals (the silent-zero-summary case)", () => {
    const dir = mkdtempSync(join(tmpdir(), "hs-research-panel-test-"));
    const path = join(dir, "proposals.json");
    writeFileSync(path, JSON.stringify({ generatedAt: "2026-07-05T06:00:00Z", proposals: [] }));
    const result = readProposals(path);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("zero proposals");
  });

  it("returns ok:false when the file is not valid JSON (does not throw)", () => {
    const dir = mkdtempSync(join(tmpdir(), "hs-research-panel-test-"));
    const path = join(dir, "proposals.json");
    writeFileSync(path, "not json at all");
    expect(() => readProposals(path)).not.toThrow();
    const result = readProposals(path);
    expect(result.ok).toBe(false);
  });

  it("returns ok:false (does not throw) when the file contains the JSON literal null (#230 review)", () => {
    const dir = mkdtempSync(join(tmpdir(), "hs-research-panel-test-"));
    const path = join(dir, "proposals.json");
    writeFileSync(path, "null");
    expect(() => readProposals(path)).not.toThrow();
    const result = readProposals(path);
    expect(result.ok).toBe(false);
  });

  it("returns ok:false when the top-level JSON value is an array, not an object", () => {
    const dir = mkdtempSync(join(tmpdir(), "hs-research-panel-test-"));
    const path = join(dir, "proposals.json");
    writeFileSync(path, JSON.stringify(["not", "an", "object"]));
    const result = readProposals(path);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("zero proposals");
  });

  it("returns ok:false when the 'proposals' field is a string instead of an array", () => {
    const dir = mkdtempSync(join(tmpdir(), "hs-research-panel-test-"));
    const path = join(dir, "proposals.json");
    writeFileSync(path, JSON.stringify({ proposals: "invalid", generatedAt: "2023-01-01" }));
    const result = readProposals(path);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("zero proposals");
  });

  it("returns ok:true with filtered proposals for a valid file", () => {
    const dir = mkdtempSync(join(tmpdir(), "hs-research-panel-test-"));
    const path = join(dir, "proposals.json");
    writeFileSync(
      path,
      JSON.stringify({
        generatedAt: "2026-07-05T06:00:00Z",
        proposals: [
          { title: "Speculative decoding", idea: "Use a draft model", rationale: "2x", expectedGain: "speed", effort: "M", sources: [] },
          { no_title: true },
        ],
      })
    );
    const result = readProposals(path);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.file.proposals.length).toBe(1);
      expect(result.file.proposals[0]!.title).toBe("Speculative decoding");
      expect(result.file.generatedAt).toBe("2026-07-05T06:00:00Z");
    }
  });
});

describe("buildFailPanel", () => {
  it("emits a valid status=fail panel carrying the reason", () => {
    const panel = buildFailPanel("no proposals file at data/research-sweep/proposals.json");
    expect(panel.kind).toBe("status");
    expect(panel.state).toBe("fail");
    expect(panel.service).toBe("m5-inference");
    expect(PANEL_ID_RE.test(panel.panel)).toBe(true);
    expect(panel.message).toContain("no proposals file");
  });
});

describe("post-research-sweep-panel CLI (acceptance, #200)", () => {
  it("does not crash on a missing proposals.json — prints a status=fail panel instead", () => {
    const dir = mkdtempSync(join(tmpdir(), "hs-research-panel-cli-test-"));
    const missing = join(dir, "proposals.json");
    const res = spawnSync(process.execPath, [TSX, SCRIPT, "--dry-run", "--in", missing], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 30_000,
    });
    // No uncaught-exception stack trace (the pre-fix crash mode).
    expect(res.stderr).not.toContain("at readProposals");
    expect(res.stderr).not.toContain("ENOENT");
    const parsed = JSON.parse(res.stdout);
    expect(parsed.kind).toBe("status");
    expect(parsed.state).toBe("fail");
  });
});
