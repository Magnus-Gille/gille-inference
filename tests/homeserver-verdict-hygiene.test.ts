import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../src/db.js";
import { DEFAULT_POLICY } from "../src/homeserver/config.js";
import { recordDelegation, getVerdict, ledgerReport, type Outcome, type ErrorClass } from "../src/homeserver/ledger.js";

// #156 (proposal 1 — verdict hygiene): a model can pass a STRUCTURAL verifier (nonEmpty/jsonValid/
// maxLength) on every code-review delegation — it emitted SOMETHING — and earn a viable /
// delegate-local verdict at passRate 1.0 while finding 0 of 34 real seeded bugs. Structural pass ≠
// review quality. For JUDGMENT-QUALITY task types (code-review at minimum), rows graded only by a
// structural verifier are inadmissible evidence: they must NOT manufacture a viable verdict; a type
// with no quality-bearing evidence must resolve to `unknown` (→ frontier), not a false viable.

// Isolate the ledger in a throwaway DB before any ledger call touches the singleton.
beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "hs-verdict-hygiene-"));
  initDb(join(dir, "test.db"));
});

function rec(taskType: string, modelId: string, outcome: Outcome, verifier: string | null): void {
  recordDelegation({ taskType, modelId, prompt: "x", outcome, verifier });
}

function recErr(taskType: string, modelId: string, errorClass: ErrorClass, verifier: string | null): void {
  recordDelegation({ taskType, modelId, prompt: "x", outcome: "error", errorClass, verifier });
}

describe("#156 verdict hygiene — structural passes cannot manufacture a judgment-quality verdict", () => {
  it("(a) code-review × mellum with 10 nonEmpty passes is UNKNOWN, not viable", () => {
    for (let i = 0; i < 10; i++) rec("code-review", "mellum", "pass", "nonEmpty(1)");
    const v = getVerdict("code-review", "mellum", DEFAULT_POLICY);
    expect(v.verdict).toBe("unknown");
    // The structural rows are inadmissible — they are not verdict-relevant attempts for a
    // judgment-quality type, so they can never reach the viable threshold.
    expect(v.attempts).toBe(0);
  });

  it("(a') the ledger report recommendation for code-review × mellum is NOT delegate-local", () => {
    const rows = ledgerReport(DEFAULT_POLICY);
    const cr = rows.find((r) => r.taskType === "code-review" && r.modelId === "mellum");
    expect(cr).toBeDefined();
    expect(cr!.verdict).toBe("unknown");
    expect(cr!.recommendation).not.toBe("delegate-local");
  });

  it("(b) a NON-judgment type (classify) with structural passes is UNAFFECTED — still viable", () => {
    for (let i = 0; i < 5; i++) rec("classify", "mellum", "pass", "nonEmpty(1)");
    const v = getVerdict("classify", "mellum", DEFAULT_POLICY);
    expect(v.verdict).toBe("viable");
    expect(v.attempts).toBe(5);
  });

  // #168 note: the whitelist SUPERSEDES the structural blacklist for judgment-quality types, so a
  // verdict-earning row must now be graded by a TRUSTED verifier (not merely "non-structural"). The
  // two cases below keep #156's intent — trusted evidence earns a verdict, structural rows do not —
  // expressed through the whitelist. (The stricter default-empty case is covered above and in
  // homeserver-verdict-hygiene-whitelist.test.ts.)
  it("(c) code-review WITH passes graded by a TRUSTED verifier still earns its verdict", () => {
    const policy = { ...DEFAULT_POLICY, trustedVerifiersForJudgment: ["predicate"] };
    for (let i = 0; i < 5; i++) rec("code-review", "gpt-oss-120b", "pass", "predicate");
    const v = getVerdict("code-review", "gpt-oss-120b", policy);
    expect(v.verdict).toBe("viable");
    expect(v.attempts).toBe(5);
  });

  it("(d) on the SAME pair, non-whitelisted rows are excluded while trusted rows count", () => {
    // 10 nonEmpty (never trusted) + 3 answerIs (trusted here) → only the 3 trusted rows count.
    const policy = { ...DEFAULT_POLICY, trustedVerifiersForJudgment: ["answerIs"] };
    for (let i = 0; i < 10; i++) rec("code-review", "mixed", "pass", "nonEmpty(1)");
    for (let i = 0; i < 3; i++) rec("code-review", "mixed", "pass", "answerIs");
    const v = getVerdict("code-review", "mixed", policy);
    expect(v.attempts).toBe(3);
    expect(v.verdict).toBe("viable");
  });

  it("(e) an ungraded (null-verifier) code-review row is also inadmissible", () => {
    for (let i = 0; i < 6; i++) rec("code-review", "ungraded", "pass", null);
    const v = getVerdict("code-review", "ungraded", DEFAULT_POLICY);
    expect(v.attempts).toBe(0);
    expect(v.verdict).toBe("unknown");
  });

  // Codex review finding (#156): the orchestrator writes the sentinel verifier `"none"` (not null)
  // for a no-verifier delegation, and a no-verifier FAILURE is recorded as outcome:"error" with a
  // capability-relevant errorClass. Those ungraded error rows must NOT manufacture a not_viable
  // verdict for a judgment-quality type — same inadmissibility as a null verifier.
  it("(f) ungraded error rows with the orchestrator's 'none' sentinel do not manufacture not_viable", () => {
    recErr("code-review", "none-sentinel", "timeout", "none");
    recErr("code-review", "none-sentinel", "empty", "none");
    recErr("code-review", "none-sentinel", "parse", "none");
    const v = getVerdict("code-review", "none-sentinel", DEFAULT_POLICY);
    expect(v.attempts).toBe(0);
    expect(v.verdict).toBe("unknown");
  });

  it("(g) a NON-judgment type with 'none'-sentinel error rows is unaffected (still counts)", () => {
    recErr("classify", "none-sentinel", "timeout", "none");
    recErr("classify", "none-sentinel", "empty", "none");
    recErr("classify", "none-sentinel", "parse", "none");
    const v = getVerdict("classify", "none-sentinel", DEFAULT_POLICY);
    expect(v.attempts).toBe(3);
    expect(v.verdict).toBe("not_viable");
  });
});
