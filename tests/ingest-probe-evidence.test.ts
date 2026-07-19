/**
 * TDD suite for scripts/ingest-probe-evidence.ts — the JSONL → capability-ledger bridge (#151).
 *
 * Written BEFORE the implementation (red→green). Battery outputs like extra-probes-results.jsonl
 * and cartography-*.jsonl are field-name-inconsistent (camelCase vs snake_case, model vs modelId)
 * and can contain resume-duplicated or corrupt lines. The parser must map every known shape into
 * an ImportableDelegation, and must surface malformed lines LOUDLY (never silently drop evidence
 * or store junk).
 */
import { describe, it, expect } from "vitest";
import { parseProbeEvidenceJsonl } from "../scripts/ingest-probe-evidence.js";

const CARTO_LINE = JSON.stringify({
  ts: "2026-06-23T12:00:00.000Z",
  runId: "extra-probes-0623",
  model: "qwen3-coder-next-80b",
  probeId: "hard-syllogism-1",
  taskType: "reason-hard",
  verifierName: "=42",
  repeat: 1,
  outcome: "pass",
  score: 1,
  latencyMs: 4200,
  tokPerSec: 69.1,
});

const SNAKE_LINE = JSON.stringify({
  ts: "2026-06-23T12:01:00.000Z",
  task_type: "reason-hard",
  model_id: "mellum",
  prompt: "hard probe 2",
  outcome: "fail",
  score: 0,
  tok_per_s: 140.2,
  verifier: "=42",
  error_class: null,
});

describe("parseProbeEvidenceJsonl", () => {
  it("parses a cartography-shaped line (camelCase, model/probeId)", () => {
    const { records, errors } = parseProbeEvidenceJsonl(CARTO_LINE + "\n", { source: "extra-probes" });
    expect(errors).toHaveLength(0);
    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.ts).toBe("2026-06-23T12:00:00.000Z");
    expect(r.taskType).toBe("reason-hard");
    expect(r.modelId).toBe("qwen3-coder-next-80b");
    expect(r.outcome).toBe("pass");
    expect(r.tokPerSec).toBe(69.1);
    expect(r.verifier).toBe("=42");
    expect(r.source).toBe("extra-probes");
    // probe identity is preserved for auditability
    expect(r.notes ?? "").toMatch(/hard-syllogism-1/);
  });

  it("parses a snake_case line (task_type/model_id/tok_per_s)", () => {
    const { records, errors } = parseProbeEvidenceJsonl(SNAKE_LINE + "\n", { source: "extra-probes" });
    expect(errors).toHaveLength(0);
    const r = records[0]!;
    expect(r.taskType).toBe("reason-hard");
    expect(r.modelId).toBe("mellum");
    expect(r.outcome).toBe("fail");
    expect(r.tokPerSec).toBe(140.2);
  });

  it("skips blank lines without error", () => {
    const { records, errors } = parseProbeEvidenceJsonl(`\n${CARTO_LINE}\n\n`, { source: "x" });
    expect(records).toHaveLength(1);
    expect(errors).toHaveLength(0);
  });

  it("reports a corrupt JSON line with its line number instead of dropping it silently", () => {
    const { records, errors } = parseProbeEvidenceJsonl(`${CARTO_LINE}\n{ not json\n`, { source: "x" });
    expect(records).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.line).toBe(2);
    expect(errors[0]?.reason).toMatch(/json/i);
  });

  it("reports lines missing required fields (ts / task type / model / outcome)", () => {
    const noTs = JSON.stringify({ taskType: "classify", model: "mellum", outcome: "pass" });
    const noModel = JSON.stringify({ ts: "2026-01-01T00:00:00Z", taskType: "classify", outcome: "pass" });
    const badOutcome = JSON.stringify({ ts: "2026-01-01T00:00:00Z", taskType: "classify", model: "mellum", outcome: "great" });
    const { records, errors } = parseProbeEvidenceJsonl([noTs, noModel, badOutcome].join("\n"), { source: "x" });
    expect(records).toHaveLength(0);
    expect(errors).toHaveLength(3);
    expect(errors.map((e) => e.line)).toEqual([1, 2, 3]);
    expect(errors[0]?.reason).toMatch(/ts|timestamp/i);
    expect(errors[1]?.reason).toMatch(/model/i);
    expect(errors[2]?.reason).toMatch(/outcome/i);
  });

  // Self-review finding (PR #153): an invalid errorClass must be a LINE ERROR, not silently
  // nulled — getVerdict excludes error_class="infra" from capability math, so a mistyped
  // "Infra" silently flipping to null would count an infra error as a capability failure.
  it("reports an invalid errorClass instead of silently nulling it (infra-exclusion integrity)", () => {
    const line = JSON.stringify({
      ts: "2026-01-01T00:00:00Z",
      taskType: "classify",
      model: "mellum",
      outcome: "error",
      error_class: "Infra",
    });
    const { records, errors } = parseProbeEvidenceJsonl(line, { source: "x" });
    expect(records).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.reason).toMatch(/errorClass/i);
  });

  it("maps ttft, escalated and repeat (evidence fidelity — nothing silently dropped)", () => {
    const line = JSON.stringify({
      ts: "2026-01-01T00:00:00Z",
      taskType: "classify",
      model: "mellum",
      outcome: "pass",
      ttft_ms: 120,
      escalated: true,
      repeat: 3,
    });
    const { records, errors } = parseProbeEvidenceJsonl(line, { source: "x" });
    expect(errors).toHaveLength(0);
    expect(records[0]?.ttftMs).toBe(120);
    expect(records[0]?.escalated).toBe(true);
    expect(records[0]?.repeat).toBe(3);
  });

  it("a line-level source field wins over the CLI default", () => {
    const line = JSON.stringify({
      ts: "2026-01-01T00:00:00Z",
      taskType: "classify",
      model: "mellum",
      outcome: "pass",
      source: "m5-cartography",
    });
    const { records } = parseProbeEvidenceJsonl(line, { source: "cli-default" });
    expect(records[0]?.source).toBe("m5-cartography");
  });
});
