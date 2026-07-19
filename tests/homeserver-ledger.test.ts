import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../src/db.js";
import { DEFAULT_POLICY, type PolicyConfig } from "../src/homeserver/config.js";
import {
  recordDelegation,
  getVerdict,
  shouldDelegate,
  recentDelegations,
  getDelegationById,
  supersedeHarvestVerdicts,
  gateFireRate,
  ledgerReport,
  getLaneEvidence,
  type Outcome,
  type ErrorClass,
} from "../src/homeserver/ledger.js";

// Isolate the ledger in a throwaway DB before any ledger call touches the singleton.
beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "hs-ledger-test-"));
  initDb(join(dir, "test.db"));
});

const MODEL = "test-model";
let counter = 0;
function uniqueType(): string {
  return `t-${counter++}`;
}

function record(taskType: string, outcome: Outcome, errorClass?: ErrorClass): void {
  recordDelegation({ taskType, modelId: MODEL, prompt: "x", outcome, errorClass });
}

const always = (n: number) => () => n;

describe("capability ledger verdicts", () => {
  it("is unknown below minSamples", () => {
    const t = uniqueType();
    record(t, "pass");
    record(t, "pass");
    const v = getVerdict(t, MODEL, DEFAULT_POLICY);
    expect(v.verdict).toBe("unknown");
    expect(v.attempts).toBe(2);
  });

  it("freezes not_viable after maxFails with zero passes, and stops delegating", () => {
    const t = uniqueType();
    record(t, "fail");
    record(t, "fail");
    record(t, "fail");
    const v = getVerdict(t, MODEL, DEFAULT_POLICY);
    expect(v.verdict).toBe("not_viable");
    expect(v.frozen).toBe(true);
    // rand above explorationRate → do not delegate, escalate
    expect(shouldDelegate(t, MODEL, DEFAULT_POLICY, always(1)).delegate).toBe(false);
  });

  it("re-probes a frozen not_viable when exploration fires", () => {
    const t = uniqueType();
    record(t, "fail");
    record(t, "fail");
    record(t, "fail");
    // rand below explorationRate → exploration re-probe
    expect(shouldDelegate(t, MODEL, DEFAULT_POLICY, always(0)).delegate).toBe(true);
  });

  it("is viable at >= viableThreshold and keeps delegating", () => {
    const t = uniqueType();
    record(t, "pass");
    record(t, "pass");
    record(t, "pass");
    const v = getVerdict(t, MODEL, DEFAULT_POLICY);
    expect(v.verdict).toBe("viable");
    expect(shouldDelegate(t, MODEL, DEFAULT_POLICY, always(1)).delegate).toBe(true);
  });

  it("counts partials at half weight (marginal band)", () => {
    const t = uniqueType();
    record(t, "partial");
    record(t, "partial");
    record(t, "partial");
    record(t, "fail");
    // effective = 1.5 / 4 = 0.375 < marginal(0.4) → not_viable, but has passes? no.
    // passes==0 and capabilityFails(=1 fail) < maxFails(3) → falls through to rate branch.
    const v = getVerdict(t, MODEL, DEFAULT_POLICY);
    expect(v.successRate).toBeCloseTo(0.38, 1);
    expect(["marginal", "not_viable"]).toContain(v.verdict);
  });

  it("escalates a frozen marginal verdict (hard cap) instead of delegating forever", () => {
    const t = uniqueType();
    for (let i = 0; i < 4; i++) record(t, "pass");
    for (let i = 0; i < 4; i++) record(t, "fail");
    const v = getVerdict(t, MODEL, DEFAULT_POLICY);
    expect(v.verdict).toBe("marginal");
    expect(v.frozen).toBe(true); // attempts (8) >= maxSamples
    expect(shouldDelegate(t, MODEL, DEFAULT_POLICY, always(1)).delegate).toBe(false);
  });

  it("excludes infra errors from the verdict but counts capability errors", () => {
    const infra = uniqueType();
    record(infra, "error", "infra");
    record(infra, "error", "infra");
    record(infra, "error", "infra");
    expect(getVerdict(infra, MODEL, DEFAULT_POLICY).attempts).toBe(0);
    expect(getVerdict(infra, MODEL, DEFAULT_POLICY).verdict).toBe("unknown");

    const empty = uniqueType();
    record(empty, "error", "empty");
    record(empty, "error", "truncated");
    record(empty, "error", "timeout");
    const v = getVerdict(empty, MODEL, DEFAULT_POLICY);
    expect(v.attempts).toBe(3);
    expect(v.verdict).toBe("not_viable");
  });

  it("ignores unverified rows in verdict math", () => {
    const t = uniqueType();
    record(t, "unverified");
    record(t, "unverified");
    expect(getVerdict(t, MODEL, DEFAULT_POLICY).attempts).toBe(0);
  });
});

// #91: the disagreement gate's shadow signal was only recorded as a `gate(shadow):...` free-text
// note, queryable only by regex. These structured columns make it a clean SQL predicate instead.
describe("disagreement gate — structured gate_* columns (#91)", () => {
  // Runs FIRST in this describe block, before any other test in this file inserts a gate_mode:"on"
  // row into the shared test DB — the only way to genuinely observe the zero-rows/no-NaN case.
  it("gateFireRate() returns rate:0 (not NaN) when nothing matching the mode is gated yet", () => {
    const r = gateFireRate("on");
    expect(r.gated).toBe(0);
    expect(r.wouldEscalate).toBe(0);
    expect(r.rate).toBe(0);
    expect(Number.isNaN(r.rate)).toBe(false);
  });

  it("recordDelegation persists gate_mode/score/wouldEscalate/error, visible via recentDelegations", () => {
    const t = uniqueType();
    recordDelegation({
      taskType: t,
      modelId: MODEL,
      prompt: "x",
      outcome: "unverified",
      gateMode: "shadow",
      gateScore: 0.42,
      gateWouldEscalate: true,
    });
    const row = recentDelegations(1)[0]!;
    expect(row.gateMode).toBe("shadow");
    expect(row.gateScore).toBe(0.42);
    expect(row.gateWouldEscalate).toBe(true);
    expect(row.gateError).toBeNull();
  });

  it("a secondary-error gate row records gate_error and gateWouldEscalate:false", () => {
    const t = uniqueType();
    recordDelegation({
      taskType: t,
      modelId: MODEL,
      prompt: "x",
      outcome: "unverified",
      gateMode: "shadow",
      gateScore: 0,
      gateWouldEscalate: false,
      gateError: "upstream_timeout",
    });
    const row = recentDelegations(1)[0]!;
    expect(row.gateError).toBe("upstream_timeout");
    expect(row.gateWouldEscalate).toBe(false);
  });

  it("a delegation with no gate activity stores NULL gate_* columns (backward compatible)", () => {
    const t = uniqueType();
    record(t, "pass"); // the plain record() helper — no gate fields at all
    const row = recentDelegations(1)[0]!;
    expect(row.gateMode).toBeNull();
    expect(row.gateScore).toBeNull();
    expect(row.gateWouldEscalate).toBeNull();
    expect(row.gateError).toBeNull();
  });

  it("persists the authenticated key alias on recent delegation rows without requiring one", () => {
    const t = uniqueType();

    recordDelegation({
      taskType: t,
      modelId: MODEL,
      prompt: "x",
      outcome: "unverified",
      source: "gateway",
      keyAlias: "codex-cli",
    });

    const withAlias = recentDelegations(1)[0]!;
    expect(withAlias.keyAlias).toBe("codex-cli");

    recordDelegation({ taskType: t, modelId: MODEL, prompt: "y", outcome: "unverified" });
    const withoutAlias = recentDelegations(1)[0]!;
    expect(withoutAlias.keyAlias).toBeNull();
  });

  it("gateFireRate() computes the shadow fire-rate as a clean query, no notes-regex", () => {
    // gateFireRate("shadow") is unscoped by taskType (matches the query it replaces), so on the
    // shared test DB it also counts shadow rows from earlier tests in this file — assert the
    // DELTA this test itself contributes.
    const before = gateFireRate("shadow");
    const t = uniqueType();
    recordDelegation({ taskType: t, modelId: MODEL, prompt: "a", outcome: "unverified", gateMode: "shadow", gateScore: 0.1, gateWouldEscalate: false });
    recordDelegation({ taskType: t, modelId: MODEL, prompt: "b", outcome: "unverified", gateMode: "shadow", gateScore: 0.5, gateWouldEscalate: true });
    recordDelegation({ taskType: t, modelId: MODEL, prompt: "c", outcome: "unverified", gateMode: "shadow", gateScore: 0, gateWouldEscalate: false, gateError: "timeout" });
    recordDelegation({ taskType: t, modelId: MODEL, prompt: "d", outcome: "pass" }); // ungated — must not count

    const after = gateFireRate("shadow");
    expect(after.gated - before.gated).toBe(3);
    expect(after.wouldEscalate - before.wouldEscalate).toBe(1);
    expect(after.secondaryErrors - before.secondaryErrors).toBe(1);
  });

  it("gateFireRate() with no mode filter aggregates across shadow+on", () => {
    // Unfiltered gateFireRate() is deliberately global (matching the original unscoped
    // notes-regex query it replaces), so on the shared test DB it also counts every gated row
    // from earlier tests in this file — assert the DELTA this test itself contributes, not an
    // absolute count.
    const before = gateFireRate();
    const t = uniqueType();
    recordDelegation({ taskType: t, modelId: MODEL, prompt: "a", outcome: "unverified", gateMode: "shadow", gateScore: 0.5, gateWouldEscalate: true });
    recordDelegation({ taskType: t, modelId: MODEL, prompt: "b", outcome: "unverified", gateMode: "on", gateScore: 0.5, gateWouldEscalate: true });
    recordDelegation({ taskType: t, modelId: MODEL, prompt: "c", outcome: "pass" }); // ungated

    const after = gateFireRate();
    expect(after.gated - before.gated).toBe(2);
    expect(after.wouldEscalate - before.wouldEscalate).toBe(2);
  });

});

// #227: a delegation's `ledgerId` (recordDelegation's return value, echoed by POST /delegate as
// costTrace.delegationId) must be resolvable back to its exact evidence row — no timestamp
// archaeology required.
describe("id-addressable ledger reads (#227)", () => {
  it("recentDelegations rows carry the same id recordDelegation returned", () => {
    const t = uniqueType();
    const id = recordDelegation({ taskType: t, modelId: MODEL, prompt: "x", outcome: "pass" });
    const row = recentDelegations(1)[0]!;
    expect(row.id).toBe(id);
  });

  it("getDelegationById returns the exact row for a known id", () => {
    const t = uniqueType();
    const id = recordDelegation({
      taskType: t,
      modelId: MODEL,
      prompt: "x",
      outcome: "partial",
      score: 0.5,
      verifier: "tsGate",
      source: "gateway",
      keyAlias: "codex-cli",
    });
    const row = getDelegationById(id);
    expect(row).not.toBeNull();
    expect(row!.id).toBe(id);
    expect(row!.taskType).toBe(t);
    expect(row!.modelId).toBe(MODEL);
    expect(row!.outcome).toBe("partial");
    expect(row!.score).toBe(0.5);
    expect(row!.verifier).toBe("tsGate");
    expect(row!.source).toBe("gateway");
    expect(row!.keyAlias).toBe("codex-cli");
  });

  it("getDelegationById returns null for an unknown id", () => {
    expect(getDelegationById("no-such-id")).toBeNull();
  });

  it("a superseded row stays resolvable by id, with supersededAt set (audit trail preserved)", () => {
    const t = uniqueType();
    const id = recordDelegation({
      taskType: t,
      modelId: MODEL,
      outcome: "pass",
      prompt: "x",
      source: "test-source",
      notes: "#42 some note",
    });

    supersedeHarvestVerdicts({
      sourceTag: "test-source",
      sourceRowIds: [42],
      nowIso: "2023-01-02T00:00:00Z",
    });

    const row = getDelegationById(id);
    expect(row).not.toBeNull();
    expect(row!.supersededAt).toBe("2023-01-02T00:00:00Z");
  });
});

// #233: ledger evidence honesty — distinguish format-verified from truth-verified passes and surface
// unverified share per cell.
describe("#233 verifier kind on ledger rows", () => {
  it("recentDelegations exposes verifierKind derived from the verifier column", () => {
    const t = uniqueType();
    recordDelegation({ taskType: t, modelId: MODEL, prompt: "x", outcome: "pass", verifier: "jsonValid" });
    const row = recentDelegations(1)[0]!;
    expect(row.verifierKind).toBe("mechanical-format");
  });

  it("getDelegationById exposes verifierKind too, for a truth-oriented verifier", () => {
    const t = uniqueType();
    const id = recordDelegation({ taskType: t, modelId: MODEL, prompt: "x", outcome: "pass", verifier: "sqlExec" });
    const row = getDelegationById(id);
    expect(row!.verifierKind).toBe("truth-oriented");
  });

  it("a row with no verifier is ungraded", () => {
    const t = uniqueType();
    recordDelegation({ taskType: t, modelId: MODEL, prompt: "x", outcome: "unverified" });
    const row = recentDelegations(1)[0]!;
    expect(row.verifierKind).toBe("ungraded");
  });
});

describe("#233 ledgerReport: unverifiedShare + formatOnlyShare per cell", () => {
  it("computes both shares from a mix of unverified / format-only / truth-oriented rows", () => {
    const t = uniqueType();
    const model = `report-mix-${counter++}`;
    recordDelegation({ taskType: t, modelId: model, prompt: "a", outcome: "unverified" });
    recordDelegation({ taskType: t, modelId: model, prompt: "b", outcome: "unverified" });
    recordDelegation({ taskType: t, modelId: model, prompt: "c", outcome: "pass", verifier: "sqlExec" });
    recordDelegation({ taskType: t, modelId: model, prompt: "d", outcome: "pass", verifier: "jsonValid" });

    const row = ledgerReport(DEFAULT_POLICY).find((r) => r.taskType === t && r.modelId === model);
    expect(row).toBeDefined();
    expect(row!.attempts).toBe(2); // verdict-relevant attempts exclude the 2 unverified rows
    expect(row!.unverifiedShare).toBeCloseTo(0.5, 5); // 2 unverified / 4 total rows
    expect(row!.formatOnlyShare).toBeCloseTo(0.5, 5); // 1 mechanical-format / 2 attempts
  });

  it("is 0 (not NaN) for an all-passing, all-truth-oriented cell", () => {
    const t = uniqueType();
    const model = `report-alltruth-${counter++}`;
    recordDelegation({ taskType: t, modelId: model, prompt: "a", outcome: "pass", verifier: "tsGate" });
    recordDelegation({ taskType: t, modelId: model, prompt: "b", outcome: "pass", verifier: "tsGate" });
    const row = ledgerReport(DEFAULT_POLICY).find((r) => r.taskType === t && r.modelId === model)!;
    expect(row.unverifiedShare).toBe(0);
    expect(row.formatOnlyShare).toBe(0);
  });

  it("formatOnlyShare is 0 (not NaN) when attempts is 0 (every row unverified)", () => {
    const t = uniqueType();
    const model = `report-allunverified-${counter++}`;
    recordDelegation({ taskType: t, modelId: model, prompt: "a", outcome: "unverified" });
    const row = ledgerReport(DEFAULT_POLICY).find((r) => r.taskType === t && r.modelId === model)!;
    expect(row.attempts).toBe(0);
    expect(row.unverifiedShare).toBe(1);
    expect(row.formatOnlyShare).toBe(0);
    expect(Number.isNaN(row.formatOnlyShare)).toBe(false);
  });

  // Codex review finding (PR #237): mechanicalFormatAttempts must count only PASS/PARTIAL rows —
  // a FAILED or ERRORED mechanical-format-verified row is not a "format-only pass" and must not
  // inflate formatOnlyShare, which exists specifically to flag weak PASS evidence.
  it("does NOT count a failed/errored mechanical-format row as a format-only pass", () => {
    const t = uniqueType();
    const model = `report-mechfail-${counter++}`;
    recordDelegation({ taskType: t, modelId: model, prompt: "a", outcome: "fail", verifier: "jsonValid" });
    recordDelegation({ taskType: t, modelId: model, prompt: "b", outcome: "error", verifier: "maxLength", errorClass: "empty" });
    recordDelegation({ taskType: t, modelId: model, prompt: "c", outcome: "pass", verifier: "sqlExec" });
    const row = ledgerReport(DEFAULT_POLICY).find((r) => r.taskType === t && r.modelId === model)!;
    expect(row.attempts).toBe(3);
    expect(row.passes).toBe(1);
    // Zero PASSING evidence is format-only — the one pass was truth-oriented (sqlExec).
    expect(row.formatOnlyShare).toBe(0);
  });
});

describe("#233 format-only evidence discount (config flag, off by default)", () => {
  const withDiscount = (overrides: Partial<PolicyConfig> = {}): PolicyConfig => ({
    ...DEFAULT_POLICY,
    discountFormatOnlyEvidence: true,
    formatOnlyDiscountWeight: 0.5,
    ...overrides,
  });

  it("is a no-op when the flag is off (default) — format-only passes count fully", () => {
    const model = `discount-off-${counter++}`;
    for (let i = 0; i < 4; i++) {
      recordDelegation({ taskType: "classify", modelId: model, prompt: "x", outcome: "pass", verifier: "jsonValid" });
    }
    const v = getVerdict("classify", model, DEFAULT_POLICY);
    expect(v.successRate).toBe(1);
    expect(v.verdict).toBe("viable");
  });

  it("downweights format-only passes for a judgment-flavored type when enabled", () => {
    const model = `discount-on-${counter++}`;
    for (let i = 0; i < 4; i++) {
      recordDelegation({ taskType: "classify", modelId: model, prompt: "x", outcome: "pass", verifier: "jsonValid" });
    }
    const v = getVerdict("classify", model, withDiscount());
    // Raw tallies are UNCHANGED (still real attempts) — only the derived rate is discounted.
    expect(v.attempts).toBe(4);
    expect(v.passes).toBe(4);
    expect(v.successRate).toBeCloseTo(0.5, 5); // effective = 4 * 0.5 weight, / 4 attempts
    expect(v.verdict).toBe("marginal"); // was "viable" without the discount
  });

  it("does NOT discount a truth-oriented verifier's pass, even when enabled", () => {
    const model = `discount-truth-${counter++}`;
    for (let i = 0; i < 4; i++) {
      recordDelegation({ taskType: "classify", modelId: model, prompt: "x", outcome: "pass", verifier: "sqlExec" });
    }
    const v = getVerdict("classify", model, withDiscount());
    expect(v.successRate).toBe(1);
    expect(v.verdict).toBe("viable");
  });

  it("does NOT discount a task type outside formatOnlyDiscountTaskTypes, even when enabled", () => {
    const t = uniqueType(); // not in the default discount list
    const model = `discount-nonjudgment-${counter++}`;
    for (let i = 0; i < 4; i++) {
      recordDelegation({ taskType: t, modelId: model, prompt: "x", outcome: "pass", verifier: "jsonValid" });
    }
    const v = getVerdict(t, model, withDiscount());
    expect(v.successRate).toBe(1);
    expect(v.verdict).toBe("viable");
  });

  it("respects a custom formatOnlyDiscountTaskTypes list", () => {
    const t = uniqueType();
    const model = `discount-custom-list-${counter++}`;
    for (let i = 0; i < 4; i++) {
      recordDelegation({ taskType: t, modelId: model, prompt: "x", outcome: "pass", verifier: "jsonValid" });
    }
    const v = getVerdict(t, model, withDiscount({ formatOnlyDiscountTaskTypes: [t] }));
    expect(v.successRate).toBeCloseTo(0.5, 5);
  });

  it("also discounts format-only passes in getLaneEvidence (the production-routing evidence path)", () => {
    const model = `discount-lane-${counter++}`;
    for (let i = 0; i < 4; i++) {
      recordDelegation({ taskType: "classify", modelId: model, prompt: "x", outcome: "pass", verifier: "jsonValid" });
    }
    const withoutDiscount = getLaneEvidence("classify", model, "jsonValid", DEFAULT_POLICY);
    expect(withoutDiscount.successRate).toBe(1);
    const withDiscountEv = getLaneEvidence("classify", model, "jsonValid", withDiscount());
    expect(withDiscountEv.successRate).toBeCloseTo(0.5, 5);
  });
});
