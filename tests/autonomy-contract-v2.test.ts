import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  digestJson,
  validateJournalV2,
} from "../src/homeserver/autonomy-contract-v1.js";

const root = new URL("../contracts/grimnir-autonomy-v2/", import.meta.url).pathname;
const fixture = (name: string): any => JSON.parse(readFileSync(join(root, "fixtures", name), "utf8"));
const artifact = (name: string): any => JSON.parse(readFileSync(join(root, name), "utf8"));

function rechain(journal: any): void {
  let previous: string | null = null;
  for (const entry of journal.entries) {
    entry.previous_receipt_digest = previous;
    entry.receipt_digest = digestJson(entry, "receipt_digest");
    previous = entry.receipt_digest;
  }
}

describe("ADR-008 journal-v2 conformance", () => {
  const constitution = artifact("constitution.json");
  const coverage = fixture("coverage-armed-canary.json");
  const attestations = artifact("owner-attestations.json");

  it.each([
    "journal-happy-commit.json",
    "journal-r-exact-revert.json",
    "journal-r-forward-recovery.json",
    "journal-terminally-blocked.json",
  ])("accepts the exact merged upstream fixture %s", (name) => {
    expect(validateJournalV2(fixture(name), constitution, coverage, attestations)).toMatchObject({
      terminal: expect.any(String),
    });
  });

  it("rejects watch receipt after the 300 second apply/readback/verify budget", () => {
    const journal = fixture("journal-happy-commit.json");
    journal.entries.find((entry: any) => entry.phase === "watch").recorded_at = "2026-07-27T00:05:00.001Z";
    rechain(journal);
    expect(() => validateJournalV2(journal, constitution, coverage, attestations)).toThrow(/apply.*budget/);
  });

  it("rejects an interrupted prefix whose apply receipt alone exceeded the 300 second budget", () => {
    const journal = fixture("journal-happy-commit.json");
    journal.entries = journal.entries.slice(0, 2);
    journal.entries[1].recorded_at = "2026-07-27T00:05:00.001Z";
    rechain(journal);
    expect(() => validateJournalV2(journal, constitution, coverage, attestations)).toThrow(/apply receipt.*budget/);
  });

  it("rejects commit before 3600 seconds and after the 300 second grace", () => {
    const early = fixture("journal-happy-commit.json");
    early.entries.at(-1).recorded_at = "2026-07-27T01:04:59.999Z";
    rechain(early);
    expect(() => validateJournalV2(early, constitution, coverage, attestations)).toThrow(/minimum durable watch/);

    const late = fixture("journal-happy-commit.json");
    late.entries.find((entry: any) => entry.phase === "verify").recorded_at = "2026-07-27T00:04:59Z";
    late.entries.find((entry: any) => entry.phase === "watch").recorded_at = "2026-07-27T00:04:59Z";
    late.entries.at(-1).recorded_at = "2026-07-27T01:09:59.001Z";
    rechain(late);
    expect(() => validateJournalV2(late, constitution, coverage, attestations)).toThrow(/post-watch grace/);
  });
});
