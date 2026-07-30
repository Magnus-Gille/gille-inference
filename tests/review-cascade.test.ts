import { describe, expect, it } from "vitest";
import {
  buildAdjudicationPrompt,
  parseAdjudications,
  parseReviewFindings,
  parseReviewSource,
} from "../src/homeserver/review-cascade.js";

const source = "L1|const x = 1;\nL2|db.exec(`SELECT * FROM users WHERE id=${id}`);";

describe("review cascade strict contracts", () => {
  it("accepts a cited finding whose evidence is an exact source excerpt", () => {
    const parsed = parseReviewFindings(JSON.stringify({ findings: [{
      id: "sql-injection", severity: "high", lineIds: ["L2"],
      evidence: "db.exec(`SELECT * FROM users WHERE id=${id}`);",
      claim: "Untrusted data is interpolated into SQL.",
    }] }), source);
    expect(parsed).toMatchObject({ ok: true });
  });

  it("fails closed on fabricated spans, evidence, duplicate ids, and unknown fields", () => {
    for (const finding of [
      { id: "x", severity: "high", lineIds: ["L99"], evidence: "invented", claim: "bad" },
      { id: "x", severity: "high", lineIds: ["L2"], evidence: "invented", claim: "bad" },
      { id: "x", severity: "high", lineIds: ["L2"], evidence: "db.exec(`SELECT * FROM users WHERE id=${id}`);", claim: "bad", extra: true },
    ]) {
      expect(parseReviewFindings(JSON.stringify({ findings: [finding] }), source)).toMatchObject({ ok: false });
    }
    expect(parseReviewFindings(JSON.stringify({ findings: [{ id: "x", severity: "high", lineIds: ["L2"], evidence: "db.exec(`SELECT * FROM users WHERE id=${id}`);", claim: "bad" }, { id: "x", severity: "high", lineIds: ["L2"], evidence: "db.exec(`SELECT * FROM users WHERE id=${id}`);", claim: "bad" }] }), source)).toMatchObject({ ok: false });
  });

  it("requires an exhaustive, non-duplicated Qwen decision for every candidate", () => {
    const expected = ["f1", "f2"];
    expect(parseAdjudications(JSON.stringify({ adjudications: [{ findingId: "f1", decision: "confirm", rationale: "grounded" }] }), expected)).toMatchObject({ ok: false });
    expect(parseAdjudications(JSON.stringify({ adjudications: [
      { findingId: "f1", decision: "confirm", rationale: "grounded" },
      { findingId: "f2", decision: "refute", rationale: "not present" },
    ] }), expected)).toMatchObject({ ok: true });
  });

  it("accepts only line-addressable source and gives Qwen the complete candidate set", () => {
    expect(parseReviewSource("unlabelled source")).toMatchObject({ ok: false });
    const prompt = buildAdjudicationPrompt(source, [{
      id: "f1", severity: "low", lineIds: ["L1"], evidence: "const x = 1;", claim: "unused",
    }]);
    expect(prompt).toContain('"id":"f1"');
    expect(prompt).toContain("L1|const x = 1;");
  });
});
