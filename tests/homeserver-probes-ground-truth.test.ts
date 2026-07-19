import { describe, expect, it } from "vitest";
import {
  PROBES,
  REVIEW_CASES,
  TRIAGE_CASES,
} from "../src/homeserver/probes.js";
import { summarize } from "../src/homeserver/probe-runner.js";
import type { ProbeRunResult } from "../src/homeserver/scout-types.js";

describe("triage ground-truth corpus (#158)", () => {
  it("is a stratified 18-case production-shaped corpus", () => {
    expect(TRIAGE_CASES).toHaveLength(18);
    expect(TRIAGE_CASES.filter((c) => c.action === "ready")).toHaveLength(6);
    expect(TRIAGE_CASES.filter((c) => c.action === "clarify")).toHaveLength(6);
    expect(TRIAGE_CASES.filter((c) => c.action === "answer")).toHaveLength(6);

    const probes = PROBES.filter((p) => p.taskType === "triage");
    expect(probes).toHaveLength(18);
    expect(probes.every((p) => p.verifierName === "triageGroundTruth")).toBe(true);
    expect(probes.every((p) => p.systemPrompt?.includes("Respond with JSON only"))).toBe(true);
    expect(probes.every((p) => p.systemPrompt?.includes("When the user sends an image"))).toBe(true);
    expect(probes.every((p) => p.systemPrompt?.includes("When the user sends a document"))).toBe(true);
    expect(probes.every((p) => p.systemPrompt?.includes("## Current Munin Context"))).toBe(true);
    expect(probes.every((p) => p.prompt === TRIAGE_CASES.find((c) => c.id === p.id)?.message)).toBe(true);
    expect(PROBES.find((p) => p.id === "triage-ready-reply")?.systemPrompt).toContain("## Reply Context");
  });

  it("grades the action and action-specific shape, not mere JSON structure", async () => {
    const clarify = PROBES.find((p) => p.id === "triage-clarify-it")!;
    expect((await clarify.verifier('{"action":"clarify","question":"Which bug?"}')).outcome).toBe("pass");
    expect(
      (await clarify.verifier('{"action":"ready","task":{"prompt":"guess","context":"scratch","timeout":300,"title":"guess"}}')).outcome
    ).toBe("fail");

    const ready = PROBES.find((p) => p.id === "triage-ready-hugin-issue")!;
    expect((await ready.verifier('{"action":"ready"}')).outcome).toBe("fail");
    // Ratatoskr's strict parser defaults context and timeout; prompt+title are the serveable core.
    expect(
      (await ready.verifier('```json\n{"action":"ready","task":{"prompt":"fix it","title":"fix"}}\n```')).outcome
    ).toBe("pass");
    // Production parses the whole payload; trailing prose must fall back rather than be salvaged.
    expect(
      (await ready.verifier('{"action":"ready","task":{"prompt":"fix it","title":"fix"}} done')).outcome
    ).toBe("error");
    // Ratatoskr does not strip reasoning tags before JSON.parse; accepting these here would make
    // the scout claim production compatibility for an output that actually falls back.
    expect(
      (await ready.verifier('<think>route it</think>{"action":"ready","task":{"prompt":"fix it","title":"fix"}}')).outcome
    ).toBe("error");
  });
});

describe("adversarial code-review ground truth (#158)", () => {
  it("contains 12 mutants with 34 seeded bugs and 6 clean controls", () => {
    const mutants = REVIEW_CASES.filter((c) => c.expected.length > 0);
    const clean = REVIEW_CASES.filter((c) => c.expected.length === 0);
    expect(mutants).toHaveLength(12);
    expect(mutants.reduce((n, c) => n + c.expected.length, 0)).toBe(34);
    expect(clean).toHaveLength(6);
    expect(PROBES.filter((p) => p.verifierName === "reviewGroundTruth")).toHaveLength(18);
    expect(PROBES.filter((p) => p.verifierName === "reviewGroundTruth").every((p) =>
      p.reviewExpectedFindings !== undefined
    )).toBe(true);
    expect(PROBES.filter((p) => p.verifierName === "reviewGroundTruth").every((p) =>
      p.prompt.includes("diff --git") && p.prompt.includes("L1|+")
    )).toBe(true);
    // Every mutant mixes clean distractors with seeded defects; "report every line" is not a
    // high-precision strategy (the earlier draft accidentally made 11/12 mutants all-bug lines).
    for (const c of mutants) {
      const lineIds = c.snippet.match(/^L\d+\|/gm) ?? [];
      expect(lineIds.length).toBeGreaterThan(c.expected.length);
    }
  });

  it("keeps the zero-disables-expiry clean control internally consistent", () => {
    const cleanDocs = REVIEW_CASES.find((c) => c.id === "review-clean-docs");
    expect(cleanDocs?.expected).toEqual([]);
    expect(cleanDocs?.snippet).toContain("if (timeoutSeconds > 0) setTimeout");
  });

  it("reports recall, precision, and clean-control confabulation sufficient statistics", async () => {
    const mutant = PROBES.find((p) => p.id === "review-mutant-auth")!;
    const partial = await mutant.verifier('{"findings":["L2","L9"]}');
    expect(partial.outcome).toBe("partial");
    expect(partial.reviewMetrics).toEqual({
      expectedFindings: 3,
      truePositives: 1,
      reportedFindings: 2,
      cleanControl: false,
      cleanConfabulated: false,
    });
    expect(partial.notes).toContain("recall=1/3");
    expect(partial.notes).toContain("precision=1/2");

    const reportEverything = await mutant.verifier(
      JSON.stringify({ findings: ["L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8"] })
    );
    expect(reportEverything.reviewMetrics).toMatchObject({
      expectedFindings: 3,
      truePositives: 3,
      reportedFindings: 8,
    });

    const clean = PROBES.find((p) => p.id === "review-clean-parser")!;
    expect((await clean.verifier('{"findings":[]}')).outcome).toBe("pass");
    const invented = await clean.verifier('{"findings":["L2"]}');
    expect(invented.outcome).toBe("fail");
    expect(invented.reviewMetrics?.cleanConfabulated).toBe(true);
  });

  it("aggregates review evidence separately from ordinary pass rate", () => {
    const base: Omit<ProbeRunResult, "probeId" | "reviewMetrics"> = {
      taskType: "code-review",
      verifierName: "reviewGroundTruth",
      repeat: 1,
      outcome: "partial",
      score: 0.5,
      latencyMs: 10,
      tokPerSec: 20,
      notes: null,
      finishReason: "stop",
      emptyOutput: false,
      truncated: false,
    };
    const summary = summarize("m", "e", [
      {
        ...base,
        probeId: "mutant",
        reviewMetrics: { expectedFindings: 3, truePositives: 2, reportedFindings: 2, cleanControl: false, cleanConfabulated: false },
      },
      {
        ...base,
        probeId: "clean",
        outcome: "fail",
        score: 0,
        reviewMetrics: { expectedFindings: 0, truePositives: 0, reportedFindings: 1, cleanControl: true, cleanConfabulated: true },
      },
    ]);
    expect(summary.reviewMetrics).toMatchObject({
      seededBugs: 3,
      truePositives: 2,
      reportedFindings: 3,
      cleanControls: 1,
      confabulatedCleanControls: 1,
      recall: 2 / 3,
      precision: 2 / 3,
      cleanConfabulationRate: 1,
    });
  });
});
