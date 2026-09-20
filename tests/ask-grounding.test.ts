import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  askGroundingFixtureSchema,
  checkAskGrounding,
  type AskGroundingFixture,
} from "../src/homeserver/ask-grounding.js";

const HERE = dirname(fileURLToPath(import.meta.url));

function loadFixture(): AskGroundingFixture {
  return askGroundingFixtureSchema.parse(
    JSON.parse(readFileSync(join(HERE, "..", "benchmarks", "ask-grounding", "tasks", "munin-recovery-checklist.json"), "utf8")),
  );
}

const FAILING_OUTPUT = `1. Check ~/.munin-memory/munin.db for recovery state.
2. Copy your checkout .env over the production .env with \`cp .env /deploy/.env\`.
3. Run \`npm install\` to install dependencies.
4. Verify backups with \`backup-to-nas.sh --dry-run\`.
5. The database is ready.`;

const PASSING_OUTPUT = `1. Copy the recovered database to an immutable copy before touching it. The canonical path is ~/.munin-memory/memory.db.
2. The install command is unknown from the supplied facts — request source material before proceeding.
3. Verification steps beyond offline integrity verification are unknown from the supplied facts.
4. Never overwrite the production .env.`;

describe("ask grounding checker (#237)", () => {
  it("loads the shipped fixture against the schema", () => {
    expect(loadFixture().id).toBe("munin-recovery-checklist");
  });

  it("fails the reported response on every cited invention class", () => {
    const result = checkAskGrounding(loadFixture(), FAILING_OUTPUT);
    expect(result.pass).toBe(false);
    const classes = result.findings.map((finding) => finding.findingClass);
    expect(classes).toContain("forbidden-path");
    expect(classes).toContain("forbidden-command");
    expect(classes).toContain("forbidden-flag");
    expect(classes).toContain("missing-uncertainty");
    expect(result.findings.some((finding) => finding.detail.includes("munin.db"))).toBe(true);
    expect(result.findings.some((finding) => finding.detail.includes("--dry-run"))).toBe(true);
  });

  it("passes a response that stays inside the closed facts with markers", () => {
    const result = checkAskGrounding(loadFixture(), PASSING_OUTPUT);
    expect(result.findings).toEqual([]);
    expect(result.pass).toBe(true);
  });

  it("fails novel versions and hosts absent from the input", () => {
    const fixture = loadFixture();
    const result = checkAskGrounding(fixture, "Deploy version 2.4.1 to db-primary.example.com after copying.");
    const classes = result.findings.map((finding) => finding.findingClass);
    expect(result.pass).toBe(false);
    expect(classes).toContain("novel-version");
    expect(classes).toContain("novel-host");
  });

  it("never reads a filename suffix as a host", () => {
    const result = checkAskGrounding(loadFixture(), "Check ~/.munin-memory/munin.db for state.");
    expect(result.findings.map((finding) => finding.findingClass)).not.toContain("novel-host");
    expect(result.findings.map((finding) => finding.findingClass)).toContain("forbidden-path");
  });

  it("is deterministic across runs", () => {
    const fixture = loadFixture();
    const first = checkAskGrounding(fixture, FAILING_OUTPUT);
    const second = checkAskGrounding(fixture, FAILING_OUTPUT);
    expect(second).toEqual(first);
  });
});
