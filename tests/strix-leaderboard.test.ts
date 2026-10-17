import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

interface LeaderboardEntry {
  id: string;
  actualPopulatedContextTokens: unknown;
  evidenceLabel: string;
}

interface LeaderboardCategory {
  winner: string | null;
  scope: string;
}

interface StrixLeaderboard {
  schemaVersion: number;
  policy: { configuredContextIsNotPopulatedContext: boolean };
  categories: Record<string, LeaderboardCategory>;
  entries: LeaderboardEntry[];
}

interface StrixReferenceProfiles {
  schemaVersion: number;
  profiles: Array<{
    id: string;
    actualPopulatedContextTokens: unknown;
    evidenceLabel: "LOCAL-MEASURED" | "REPORTED";
  }>;
}

const leaderboard = JSON.parse(
  readFileSync(new URL("../benchmarks/strix-leaderboard.json", import.meta.url), "utf8"),
) as StrixLeaderboard;
const referenceProfiles = JSON.parse(
  readFileSync(new URL("../configs/strix-reference-profiles.json", import.meta.url), "utf8"),
) as StrixReferenceProfiles;

describe("Strix leaderboard", () => {
  it("keeps every category scoped and binds qualified winners to measured entries", () => {
    const ids = new Set(leaderboard.entries.map((entry) => entry.id));
    expect(Object.keys(leaderboard.categories).length).toBe(7);
    for (const category of Object.values(leaderboard.categories)) {
      expect(category.scope.trim()).not.toBe("");
      if (category.winner !== null) expect(ids.has(category.winner)).toBe(true);
    }
  });

  it("preserves the configured-versus-populated context boundary", () => {
    expect(leaderboard.schemaVersion).toBe(1);
    expect(leaderboard.policy.configuredContextIsNotPopulatedContext).toBe(true);
    for (const entry of leaderboard.entries) {
      expect(Object.hasOwn(entry, "actualPopulatedContextTokens")).toBe(true);
      expect(entry.evidenceLabel).toBe("LOCAL-MEASURED");
    }
  });

  it("keeps all five required reference families explicit without promoting reports to local evidence", () => {
    expect(referenceProfiles.schemaVersion).toBe(1);
    expect(referenceProfiles.profiles.map((profile) => profile.id)).toEqual([
      "fast-coding",
      "fast-general-agent",
      "qwen38-capability",
      "large-capability",
      "vision-specialist",
    ]);
    for (const profile of referenceProfiles.profiles) {
      expect(Object.hasOwn(profile, "actualPopulatedContextTokens")).toBe(true);
    }
    expect(referenceProfiles.profiles.find((profile) => profile.id === "fast-coding")?.evidenceLabel).toBe("REPORTED");
    expect(referenceProfiles.profiles.find((profile) => profile.id === "fast-general-agent")?.evidenceLabel).toBe("REPORTED");
    expect(referenceProfiles.profiles.find((profile) => profile.id === "vision-specialist")?.evidenceLabel).toBe("REPORTED");
  });
});
