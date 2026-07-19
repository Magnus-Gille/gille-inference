import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../src/db.js";
import { DEFAULT_POLICY, type PolicyConfig } from "../src/homeserver/config.js";
import { recordDelegation, getVerdict, type Outcome } from "../src/homeserver/ledger.js";

// #168 (verdict hygiene — WHITELIST): tighten #156's structural blacklist into a whitelist for
// JUDGMENT-QUALITY task types. A row is admissible as verdict evidence for such a type IFF its
// verifier is in policy.trustedVerifiersForJudgment. Default whitelist is EMPTY, so `code-review`
// survives on NOTHING — not on the model-scout's opaque `predicate` probe, not on `matches`, not on
// structural `nonEmpty` — and resolves to `unknown` → escalate-frontier (the honest state), never a
// fabricated `viable`. #156 could not know an opaque `predicate`/`matches` is non-adversarial
// (mellum passes it while finding ~6% of real seeded bugs — 2026-07-05 sweep); positive trust does.

// Isolate the ledger in a throwaway DB before any ledger call touches the singleton.
beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "hs-verdict-hygiene-whitelist-"));
  initDb(join(dir, "test.db"));
});

function rec(taskType: string, modelId: string, outcome: Outcome, verifier: string | null): void {
  recordDelegation({ taskType, modelId, prompt: "x", outcome, verifier });
}

const withTrusted = (...names: string[]): PolicyConfig => ({
  ...DEFAULT_POLICY,
  trustedVerifiersForJudgment: names,
});

describe("#168 verdict hygiene — trusted-verifier whitelist for judgment-quality types", () => {
  it("(a) code-review with only predicate/matches/nonEmpty rows resolves to UNKNOWN (not viable) under the default empty whitelist", () => {
    // The exact shape that propped up the false `viable` in production: the scout's own opaque
    // `predicate` probe + a `matches` + structural `nonEmpty` passes. None is TRUSTED → all excluded.
    for (let i = 0; i < 5; i++) rec("code-review", "mellum", "pass", "predicate");
    for (let i = 0; i < 3; i++) rec("code-review", "mellum", "pass", "matches");
    for (let i = 0; i < 4; i++) rec("code-review", "mellum", "pass", "nonEmpty(1)");
    const v = getVerdict("code-review", "mellum", DEFAULT_POLICY);
    expect(v.attempts).toBe(0);
    expect(v.verdict).toBe("unknown");
  });

  it("(b) code-review WITH rows graded by a whitelisted verifier earns its verdict normally", () => {
    for (let i = 0; i < 5; i++) rec("code-review", "gpt-oss-120b", "pass", "gtReview");
    const v = getVerdict("code-review", "gpt-oss-120b", withTrusted("gtReview"));
    expect(v.attempts).toBe(5);
    expect(v.verdict).toBe("viable");
  });

  it("(c) a NON-judgment type (classify) with the same predicate rows is UNAFFECTED by the whitelist — still viable", () => {
    for (let i = 0; i < 5; i++) rec("classify", "mellum", "pass", "predicate");
    const v = getVerdict("classify", "mellum", DEFAULT_POLICY);
    expect(v.attempts).toBe(5);
    expect(v.verdict).toBe("viable");
  });

  it("(d) the whitelist is genuinely configurable: identical rows are inadmissible when empty, admissible once the verifier is whitelisted", () => {
    // Same evidence, two verdicts — the only difference is whether the verifier is trusted.
    for (let i = 0; i < 5; i++) rec("code-review", "config-demo", "pass", "reviewGrader");

    const empty = getVerdict("code-review", "config-demo", DEFAULT_POLICY);
    expect(empty.attempts).toBe(0);
    expect(empty.verdict).toBe("unknown");

    const admitted = getVerdict("code-review", "config-demo", withTrusted("reviewGrader"));
    expect(admitted.attempts).toBe(5);
    expect(admitted.verdict).toBe("viable");
  });

  it("(e) whitelisting is per-verifier: a whitelist that names a DIFFERENT verifier does not admit these rows", () => {
    for (let i = 0; i < 5; i++) rec("code-review", "wrong-name", "pass", "reviewGrader");
    const v = getVerdict("code-review", "wrong-name", withTrusted("someOtherVerifier"));
    expect(v.attempts).toBe(0);
    expect(v.verdict).toBe("unknown");
  });

  it("(f) a parameterised trusted verifier name is matched on its base name", () => {
    for (let i = 0; i < 4; i++) rec("code-review", "param", "pass", "gtReview(strict)");
    const v = getVerdict("code-review", "param", withTrusted("gtReview"));
    expect(v.attempts).toBe(4);
    expect(v.verdict).toBe("viable");
  });
});
