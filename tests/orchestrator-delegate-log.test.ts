import { describe, it, expect } from "vitest";
import { summarizeDelegation } from "../src/homeserver/orchestrator.js";
import type { DelegationOutcome } from "../src/homeserver/orchestrator.js";

/**
 * Unit tests for summarizeDelegation() — the pure helper that derives the access-log
 * fields (decision, escalated, outcome) from a DelegationOutcome.
 *
 * Tests are ordered: RED first (function doesn't exist), then GREEN after implementation.
 */
describe("summarizeDelegation", () => {
  it("case 1 — delegated success: decision=delegate, escalated=false, outcome=pass", () => {
    const fo: DelegationOutcome = {
      delegated: true,
      escalate: false,
      taskType: "code_generation",
      modelId: "gemma-4b",
      decisionReason: "ledger-ok",
      outcome: "pass",
    };
    const result = summarizeDelegation(fo);
    expect(result.decision).toBe("delegate");
    expect(result.escalated).toBe(false);
    expect(result.outcome).toBe("pass");
  });

  it("case 2 — delegated then escalated: decision=delegate, escalated=true, outcome=fail", () => {
    // Local attempt was made (delegated:true) but the verifier failed (escalate:true).
    const fo: DelegationOutcome = {
      delegated: true,
      escalate: true,
      taskType: "code_generation",
      modelId: "gemma-4b",
      decisionReason: "ledger-ok",
      outcome: "fail",
    };
    const result = summarizeDelegation(fo);
    expect(result.decision).toBe("delegate");
    expect(result.escalated).toBe(true);
    expect(result.outcome).toBe("fail");
  });

  it("case 3 — policy-blocked (no local attempt): decision=escalate, escalated=true, outcome NOT 'error'", () => {
    // Policy said don't try local; delegated:false, escalate:true, no outcome field.
    const fo: DelegationOutcome = {
      delegated: false,
      escalate: true,
      taskType: "code_generation",
      modelId: "gemma-4b",
      decisionReason: "ledger-blocked",
      // outcome is intentionally absent — policy block, no inference ran
    };
    const result = summarizeDelegation(fo);
    expect(result.decision).toBe("escalate");
    expect(result.escalated).toBe(true);
    // MUST NOT be "error" — no error occurred, the system correctly policy-blocked
    expect(result.outcome).not.toBe("error");
    // Should be something neutral like "escalated"
    expect(typeof result.outcome).toBe("string");
  });

  it("case 4 — null (delegate() threw): decision=error, escalated=null, outcome=error", () => {
    const result = summarizeDelegation(null);
    expect(result.decision).toBe("error");
    expect(result.escalated).toBeNull();
    expect(result.outcome).toBe("error");
  });

  it("case 4b — undefined (same as null): decision=error, escalated=null, outcome=error", () => {
    const result = summarizeDelegation(undefined);
    expect(result.decision).toBe("error");
    expect(result.escalated).toBeNull();
    expect(result.outcome).toBe("error");
  });
});
