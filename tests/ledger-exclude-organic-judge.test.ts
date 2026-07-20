/**
 * Unit coverage for ledger.ts's `excludeOrganicJudge` EvidenceReadOpts (issue #7). This is the
 * read-time filter the reviewed routing lifecycle uses to compute what the evidence would say
 * WITHOUT harvest-derived organic-judge rows (`llm-judge:<model>` / `harvest-shadow:llm-judge:<model>`
 * verifiers — see harvest.ts, calibration-sample.ts's verifierClassOf), so it can detect a route
 * change explained ONLY by that evidence (routing-lifecycle.test.ts exercises the full detection;
 * this pins the underlying DB filter in isolation).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../src/db.js";
import { recordDelegation, ledgerReport } from "../src/homeserver/ledger.js";
import { DEFAULT_POLICY } from "../src/homeserver/config.js";

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-exclude-organic-judge-test-"));
  initDb(join(dir, "eval.db"));

  // Deterministic/verifier-backed evidence for reason-math.
  for (let i = 0; i < 5; i++) {
    recordDelegation({
      taskType: "reason-math",
      modelId: "qwen3-coder-next-80b",
      prompt: `math probe ${i}`,
      outcome: "pass",
      verifier: "tsGate",
      source: "test-seed",
    });
  }

  // Organic-judge evidence for a DIFFERENT type — real (non-shadow) harvest rows.
  for (let i = 0; i < 5; i++) {
    recordDelegation({
      taskType: "qa-factual",
      modelId: "mellum",
      prompt: `judge probe ${i}`,
      outcome: "pass",
      verifier: "llm-judge:gpt-oss-120b",
      source: "harvest",
    });
  }

  // Harvest-shadow-judge evidence — already excluded by the default shadow=0 filter, but must ALSO
  // be excluded under excludeOrganicJudge (defense in depth / explicit coverage of the prefix).
  for (let i = 0; i < 3; i++) {
    recordDelegation({
      taskType: "qa-factual",
      modelId: "mellum",
      prompt: `shadow judge probe ${i}`,
      outcome: "pass",
      verifier: "harvest-shadow:llm-judge:gpt-oss-120b",
      source: "harvest",
      shadow: true,
    });
  }
});

describe("ledgerReport(policy, { excludeOrganicJudge: true })", () => {
  it("keeps deterministic/verifier-backed evidence (tsGate) untouched", () => {
    const full = ledgerReport(DEFAULT_POLICY);
    const deterministic = ledgerReport(DEFAULT_POLICY, { excludeOrganicJudge: true });
    const fullRow = full.find((r) => r.taskType === "reason-math" && r.modelId === "qwen3-coder-next-80b");
    const detRow = deterministic.find((r) => r.taskType === "reason-math" && r.modelId === "qwen3-coder-next-80b");
    expect(fullRow?.attempts).toBe(5);
    expect(detRow?.attempts).toBe(5);
  });

  it("excludes real (non-shadow) llm-judge rows entirely", () => {
    const full = ledgerReport(DEFAULT_POLICY);
    const deterministic = ledgerReport(DEFAULT_POLICY, { excludeOrganicJudge: true });
    const fullRow = full.find((r) => r.taskType === "qa-factual" && r.modelId === "mellum");
    const detRow = deterministic.find((r) => r.taskType === "qa-factual" && r.modelId === "mellum");
    expect(fullRow?.attempts).toBe(5); // shadow rows already excluded by default
    expect(detRow).toBeUndefined(); // the cell disappears entirely once its only rows are organic-judge
  });

  it("excludeOrganicJudge + includeShadow still excludes the harvest-shadow judge prefix", () => {
    const withShadow = ledgerReport(DEFAULT_POLICY, { includeShadow: true, excludeOrganicJudge: true });
    const row = withShadow.find((r) => r.taskType === "qa-factual" && r.modelId === "mellum");
    expect(row).toBeUndefined();
  });
});
