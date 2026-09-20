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

  it("catches unquoted curated threats", () => {
    const result = checkAskGrounding(loadFixture(), "Run cp .env now.");
    expect(result.pass).toBe(false);
    expect(result.findings.map((finding) => finding.findingClass)).toContain("forbidden-command");
  });

  it("fails lone unknown code spans and exact-allow spans", () => {
    const lone = checkAskGrounding(loadFixture(), "Then run `reboot`.");
    expect(lone.pass).toBe(false);
    expect(lone.findings.map((finding) => finding.findingClass)).toContain("novel-command");
    const fixture: AskGroundingFixture = {
      ...loadFixture(),
      allowed: { ...loadFixture().allowed, commands: ["echo ok"] },
    };
    const smuggled = checkAskGrounding(fixture, "Run `echo ok; reboot` now.");
    expect(smuggled.pass).toBe(false);
    expect(smuggled.findings.map((finding) => finding.findingClass)).toContain("novel-command");
    const exact = checkAskGrounding(fixture, "Run `echo ok` now.");
    expect(exact.findings.map((finding) => finding.findingClass)).not.toContain("novel-command");
  });

  it("catches relative paths and evil-suffixed allowed paths", () => {
    const relative = checkAskGrounding(loadFixture(), "Restore data/recovered.sqlite first.");
    expect(relative.findings.map((finding) => finding.findingClass)).toContain("novel-path");
    const evil = checkAskGrounding(loadFixture(), "Use ~/.munin-memory/memory.db@evil today.");
    expect(evil.pass).toBe(false);
    expect(evil.findings.map((finding) => finding.findingClass)).toContain("novel-path");
  });

  it("catches URL hosts, case variants, fragments, short flags, and IPv6", () => {
    const fixture = loadFixture();
    const url = checkAskGrounding(fixture, "Send backups to https://evil.example.com nightly.");
    expect(url.findings.map((finding) => finding.findingClass)).toContain("novel-host");
    const cased = checkAskGrounding(fixture, "Check ~/.MUNIN-MEMORY/MEMORY.DB.");
    expect(cased.pass).toBe(false);
    const fragment = checkAskGrounding(fixture, "/memory.db holds the state.");
    expect(fragment.findings.map((finding) => finding.findingClass)).toContain("novel-path");
    const short = checkAskGrounding(fixture, "Run with -f to force it.");
    expect(short.findings.map((finding) => finding.findingClass)).toContain("novel-flag");
    const v6 = checkAskGrounding(fixture, "Connect to [2001:db8::1] for replication.");
    expect(v6.findings.map((finding) => finding.findingClass)).toContain("novel-host");
  });

  it("keeps allowed values out of sibling categories", () => {
    const fixture: AskGroundingFixture = {
      ...loadFixture(),
      allowed: { ...loadFixture().allowed, hosts: ["10.0.0.9"] },
    };
    const result = checkAskGrounding(fixture, "Ping 10.0.0.9 for status.");
    expect(result.findings.map((finding) => finding.findingClass)).not.toContain("novel-version");
    const quoted = checkAskGrounding(loadFixture(), 'Use "~/.munin-memory/memory.db" now.');
    expect(quoted.findings.map((finding) => finding.findingClass)).not.toContain("novel-command");
  });

  it("keeps keyword and marker together across path punctuation", () => {
    const result = checkAskGrounding(
      loadFixture(),
      "Verification command for ~/.munin-memory/memory.db is unknown.",
    );
    expect(result.findings.map((finding) => finding.findingClass)).not.toContain("missing-uncertainty");
  });

  it("rejects resolved-unknowns as an uncertainty marker", () => {
    const result = checkAskGrounding(
      loadFixture(),
      "Install command: unknowns resolved; proceed automatically.",
    );
    expect(result.findings.map((finding) => finding.findingClass)).toContain("missing-uncertainty");
  });

  it("lets prohibitions mention forbidden items without failing", () => {
    const result = checkAskGrounding(
      loadFixture(),
      "Never run `npm install`. Never use ~/.munin-memory/munin.db for anything.",
    );
    expect(result.pass).toBe(true);
  });

  it("catches unquoted curated threats and lone spans", () => {
    const unquoted = checkAskGrounding(loadFixture(), "Run cp .env now.");
    expect(unquoted.findings.map((finding) => finding.findingClass)).toContain("forbidden-command");
    const lone = checkAskGrounding(loadFixture(), "Then run `reboot`.");
    expect(lone.pass).toBe(false);
    expect(lone.findings.map((finding) => finding.findingClass)).toContain("novel-command");
    const fixture: AskGroundingFixture = {
      ...loadFixture(),
      allowed: { ...loadFixture().allowed, commands: ["echo ok"] },
    };
    const smuggled = checkAskGrounding(fixture, "Run `echo ok; reboot` now.");
    expect(smuggled.pass).toBe(false);
    const exact = checkAskGrounding(fixture, "Run `echo ok` now.");
    expect(exact.findings.map((finding) => finding.findingClass)).not.toContain("novel-command");
  });

  it("catches evil-suffixed paths, URL hosts, case variants, short flags, IPv6", () => {
    const fixture = loadFixture();
    const evil = checkAskGrounding(fixture, "Use ~/.munin-memory/memory.db@evil today.");
    expect(evil.pass).toBe(false);
    const url = checkAskGrounding(fixture, "Send backups to https://evil.example.com nightly.");
    expect(url.findings.map((finding) => finding.findingClass)).toContain("novel-host");
    const cased = checkAskGrounding(fixture, "Check ~/.MUNIN-MEMORY/MEMORY.DB.");
    expect(cased.pass).toBe(false);
    const short = checkAskGrounding(fixture, "Run with -f to force it.");
    expect(short.findings.map((finding) => finding.findingClass)).toContain("novel-flag");
    const v6 = checkAskGrounding(fixture, "Connect to [2001:db8::1] for replication.");
    expect(v6.findings.map((finding) => finding.findingClass)).toContain("novel-host");
  });

  it("rejects resolved-unknowns and negated markers as uncertainty", () => {
    const resolved = checkAskGrounding(
      loadFixture(),
      "Install command: unknowns resolved; proceed automatically.",
    );
    expect(resolved.findings.map((finding) => finding.findingClass)).toContain("missing-uncertainty");
    const denied = checkAskGrounding(loadFixture(), "Install command: unknown is false; proceed.");
    expect(denied.findings.map((finding) => finding.findingClass)).toContain("missing-uncertainty");
  });

  it("exempts only what follows the negation word", () => {
    const after = checkAskGrounding(loadFixture(), "Run `npm install` to avoid downtime.");
    expect(after.findings.map((finding) => finding.findingClass)).toContain("forbidden-command");
    const listed = checkAskGrounding(loadFixture(), "Never use `npm install`, `yarn install`, or `reboot`.");
    expect(listed.pass).toBe(true);
  });

  it("does not let new prescriptions hide behind list continuation", () => {
    const mixed = checkAskGrounding(loadFixture(), "Never use `reboot`; restart via `npm ci`.");
    expect(mixed.pass).toBe(false);
    expect(mixed.findings.map((finding) => finding.findingClass)).toContain("forbidden-command");
  });

  it("catches prescriptions hiding behind switch-style continuations", () => {
    const mixed = checkAskGrounding(loadFixture(), "Never use `reboot`; switch to `npm ci`.");
    expect(mixed.pass).toBe(false);
    expect(mixed.findings.map((finding) => finding.findingClass)).toContain("forbidden-command");
  });

  it("enforces explicitly forbidden paths however they are written", () => {
    const fixture: AskGroundingFixture = {
      ...loadFixture(),
      forbidden: { ...loadFixture().forbidden, paths: ["data/backup"] },
    };
    const relative = checkAskGrounding(fixture, "Restore data/backup before leaving.");
    expect(relative.findings.map((finding) => finding.findingClass)).toContain("forbidden-path");
    const fragment = checkAskGrounding(
      { ...loadFixture(), forbidden: { ...loadFixture().forbidden, paths: ["memory.db"] } },
      "Check ~/.munin-memory/memory.db for state.",
    );
    expect(fragment.findings.map((finding) => finding.findingClass)).not.toContain("forbidden-path");
  });

  it("scopes negation to its own clause", () => {
    const mixed = checkAskGrounding(loadFixture(), "To avoid downtime, run `npm install`.");
    expect(mixed.findings.map((finding) => finding.findingClass)).toContain("forbidden-command");
  });

  it("is deterministic across runs", () => {
    const fixture = loadFixture();
    const first = checkAskGrounding(fixture, FAILING_OUTPUT);
    const second = checkAskGrounding(fixture, FAILING_OUTPUT);
    expect(second).toEqual(first);
  });
});
