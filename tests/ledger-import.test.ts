/**
 * TDD suite for ledger.importDelegations() — the durable-evidence import path (issue #151).
 *
 * Written BEFORE the implementation (red→green). Incident (#150): the 2026-06-23 extra-probes
 * battery results lived ONLY in a JSONL file on ephemeral disk; when the file evaporated, the
 * routing-table generator lost the reason-hard evidence and the type silently regressed to
 * escalate-frontier. Probe evidence the generator consumes must land in the capability ledger
 * (the durable, WAL-backed store the verdicts are computed from). importDelegations() is the
 * idempotent bridge for battery outputs produced outside delegate()/cartography (which already
 * write the ledger at probe time).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, initDb } from "../src/db.js";
import { DEFAULT_POLICY } from "../src/homeserver/config.js";
import {
  importDelegations,
  getVerdict,
  ledgerReport,
  type ImportableDelegation,
} from "../src/homeserver/ledger.js";

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "hs-ledger-import-test-"));
  initDb(join(dir, "test.db"));
});

function probeResult(overrides: Partial<ImportableDelegation> = {}): ImportableDelegation {
  return {
    ts: "2026-06-23T12:00:00.000Z",
    taskType: "reason-hard",
    modelId: "qwen3-coder-next-80b",
    prompt: "hard reasoning probe #1",
    outcome: "pass",
    score: 1,
    verifier: "=42",
    source: "extra-probes",
    ...overrides,
  };
}

describe("importDelegations — durable probe-evidence import", () => {
  it("imports records and makes them visible to getVerdict/ledgerReport", () => {
    const records = [
      probeResult({ prompt: "p1" }),
      probeResult({ prompt: "p2", ts: "2026-06-23T12:01:00.000Z" }),
      probeResult({ prompt: "p3", ts: "2026-06-23T12:02:00.000Z" }),
    ];
    const res = importDelegations(records);
    expect(res.inserted).toBe(3);
    expect(res.skipped).toBe(0);

    const v = getVerdict("reason-hard", "qwen3-coder-next-80b", DEFAULT_POLICY);
    expect(v.attempts).toBe(3);
    expect(v.passes).toBe(3);
    expect(v.verdict).toBe("viable");

    const row = ledgerReport(DEFAULT_POLICY).find(
      (r) => r.taskType === "reason-hard" && r.modelId === "qwen3-coder-next-80b"
    );
    expect(row?.recommendation).toBe("delegate-local");
  });

  it("is IDEMPOTENT — re-importing the same records inserts nothing", () => {
    const records = [
      probeResult({ taskType: "reason-logic", prompt: "q1" }),
      probeResult({ taskType: "reason-logic", prompt: "q2" }),
    ];
    expect(importDelegations(records).inserted).toBe(2);
    const again = importDelegations(records);
    expect(again.inserted).toBe(0);
    expect(again.skipped).toBe(2);
    expect(getVerdict("reason-logic", "qwen3-coder-next-80b", DEFAULT_POLICY).attempts).toBe(2);
  });

  it("preserves the ORIGINAL probe-time timestamp (evidence freshness must not be forged)", () => {
    importDelegations([probeResult({ taskType: "reason-date", ts: "2026-06-23T09:30:00.000Z" })]);
    // getDb() returns the singleton opened in beforeAll — initDb() would RE-open the default path.
    const row = getDb()
      .prepare(`SELECT ts, source FROM delegations WHERE task_type = 'reason-date'`)
      .get() as { ts: string; source: string };
    expect(row.ts).toBe("2026-06-23T09:30:00.000Z");
    expect(row.source).toBe("extra-probes");
  });

  it("rejects a record with an invalid outcome instead of silently storing junk", () => {
    expect(() =>
      importDelegations([probeResult({ outcome: "great" as ImportableDelegation["outcome"] })])
    ).toThrow(/outcome/i);
  });

  it("rejects a record without a timestamp (undated evidence is not durable evidence)", () => {
    expect(() => importDelegations([probeResult({ ts: "" })])).toThrow(/ts/i);
  });

  // Self-review finding (PR #153): batteries can stamp a run-level ts on every line and repeat
  // the SAME probe N times — identity must not collapse distinct trials into one "duplicate".
  it("does NOT collapse two distinct trials that differ only in repeat counter (same ts)", () => {
    const base = probeResult({ taskType: "reason-repeat", prompt: "" });
    const res = importDelegations([
      { ...base, repeat: 1 },
      { ...base, repeat: 2 },
    ]);
    expect(res.inserted).toBe(2);
    expect(getVerdict("reason-repeat", "qwen3-coder-next-80b", DEFAULT_POLICY).attempts).toBe(2);
  });

  it("does NOT collapse two distinct probes that differ only in probe identity (notes), same ts + empty prompt", () => {
    const base = probeResult({ taskType: "reason-probeid", prompt: "" });
    const res = importDelegations([
      { ...base, notes: "probe:h-tank" },
      { ...base, notes: "probe:h-discount" },
    ]);
    expect(res.inserted).toBe(2);
    expect(getVerdict("reason-probeid", "qwen3-coder-next-80b", DEFAULT_POLICY).attempts).toBe(2);
  });

  // #8 regression: importDelegations previously built its INSERT column list without `shadow`,
  // so an ImportableDelegation carrying `shadow: true` (a real, documented field on the type) was
  // silently written as a NON-shadow row — recordDelegation() already persisted it correctly, only
  // this second write path dropped it. Found while wiring the Hugin experiment-outcome importer,
  // which relies on shadow rows to retain a failed/inconclusive experiment's evidence without it
  // influencing routing (getVerdict/ledgerReport exclude shadow=1 by default).
  it("propagates `shadow: true` through to the stored row (previously silently dropped)", () => {
    const res = importDelegations([probeResult({ taskType: "reason-shadow-import", shadow: true })]);
    expect(res.inserted).toBe(1);
    const row = getDb()
      .prepare(`SELECT shadow FROM delegations WHERE task_type = 'reason-shadow-import'`)
      .get() as { shadow: number };
    expect(row.shadow).toBe(1);
    // Excluded from default evidence reads, same as a recordDelegation()-written shadow row.
    expect(getVerdict("reason-shadow-import", "qwen3-coder-next-80b", DEFAULT_POLICY).attempts).toBe(0);
    expect(getVerdict("reason-shadow-import", "qwen3-coder-next-80b", DEFAULT_POLICY, "m5", { includeShadow: true }).attempts).toBe(1);
  });
});
