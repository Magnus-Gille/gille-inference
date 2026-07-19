/**
 * Ledger honesty for the shadow lane (#234).
 *
 * A shadow row is a CANDIDATE signal — the local model ran on a leaf the router had already sent to
 * frontier, and nobody consumed its output. It must therefore be invisible to every evidence reader
 * that drives routing (getVerdict, getLaneEvidence, ledgerReport) unless a caller explicitly asks for
 * it. Anything less repeats #156: evidence that was never trusted quietly manufacturing a verdict.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../src/db.js";
import { DEFAULT_POLICY } from "../src/homeserver/config.js";
import {
  recordDelegation,
  getVerdict,
  getLaneEvidence,
  ledgerReport,
  recentDelegations,
  type Outcome,
} from "../src/homeserver/ledger.js";

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "hs-shadow-ledger-"));
  initDb(join(dir, "test.db"));
});

const MODEL = "shadow-candidate-80b";
let counter = 0;
const uniqueType = (): string => `st-${counter++}`;

function record(taskType: string, outcome: Outcome, shadow: boolean, verifier = "answerIs"): void {
  recordDelegation({ taskType, modelId: MODEL, prompt: "x", outcome, verifier, shadow });
}

describe("shadow rows are excluded from evidence by default", () => {
  it("getVerdict ignores shadow rows unless includeShadow", () => {
    const t = uniqueType();
    record(t, "pass", true);
    record(t, "pass", true);
    record(t, "pass", true);
    record(t, "pass", true);

    const normal = getVerdict(t, MODEL, DEFAULT_POLICY);
    expect(normal.attempts).toBe(0);
    expect(normal.verdict).toBe("unknown"); // four shadow passes must NOT make this viable

    const withShadow = getVerdict(t, MODEL, DEFAULT_POLICY, "m5", { includeShadow: true });
    expect(withShadow.attempts).toBe(4);
    expect(withShadow.passes).toBe(4);
    expect(withShadow.verdict).toBe("viable");
  });

  it("a shadow FAIL cannot poison a real viable verdict either — exclusion cuts both ways", () => {
    const t = uniqueType();
    record(t, "pass", false);
    record(t, "pass", false);
    record(t, "pass", false);
    record(t, "fail", true);
    record(t, "fail", true);
    record(t, "fail", true);
    record(t, "fail", true);

    const normal = getVerdict(t, MODEL, DEFAULT_POLICY);
    expect(normal.attempts).toBe(3);
    expect(normal.fails).toBe(0);
    expect(normal.verdict).toBe("viable");

    const withShadow = getVerdict(t, MODEL, DEFAULT_POLICY, "m5", { includeShadow: true });
    expect(withShadow.attempts).toBe(7);
    expect(withShadow.fails).toBe(4);
  });

  it("getLaneEvidence (the production delegate-policy gate) never counts a shadow row", () => {
    const t = uniqueType();
    record(t, "pass", true);
    record(t, "pass", true);
    const lane = getLaneEvidence(t, MODEL, "answerIs", DEFAULT_POLICY);
    expect(lane.attempts).toBe(0);
  });

  it("ledgerReport excludes shadow rows by default and includes them on request", () => {
    const t = uniqueType();
    record(t, "pass", true);
    record(t, "pass", true);

    const rows = ledgerReport(DEFAULT_POLICY);
    // The (task_type, model) cell must not even appear — it has no non-shadow evidence at all.
    expect(rows.find((r) => r.taskType === t)).toBeUndefined();

    const shadowRows = ledgerReport(DEFAULT_POLICY, { includeShadow: true });
    const cell = shadowRows.find((r) => r.taskType === t);
    expect(cell).toBeDefined();
    expect(cell!.attempts).toBe(2);
    expect(cell!.passes).toBe(2);
  });

  it("recentDelegations is an AUDIT view — shadow rows are visible there, and flagged", () => {
    const t = uniqueType();
    record(t, "pass", true);
    const row = recentDelegations(50).find((r) => r.taskType === t);
    expect(row).toBeDefined();
    expect(row!.shadow).toBe(true);
  });

  it("an ordinary row is flagged shadow:false (the flag is explicit, never undefined)", () => {
    const t = uniqueType();
    record(t, "pass", false);
    const row = recentDelegations(50).find((r) => r.taskType === t);
    expect(row!.shadow).toBe(false);
  });
});
