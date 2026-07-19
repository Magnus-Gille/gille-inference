/**
 * Named-verifier registry — build a deterministic {@link Verifier} from a JSON spec.
 *
 * This is the mechanism HTTP callers (Hugin's nightly sub-tasks routed through `/delegate`, per
 * ADR-004) use to attach a verifier so the orchestrator can grade the local model's output
 * pass/fail and feed a real verdict into the capability ledger. A bare prompt carries no verifier,
 * so the ledger can never learn from it — a verifier SPEC closes that gap WITHOUT letting the
 * caller inject arbitrary code (only this allow-list of parameterised verifiers is constructible).
 *
 * `/delegate` is owner-tier-only (the gateway restricts it), so the caller is trusted — but we
 * still validate every field and surface a clean 400 on a bad spec rather than throwing.
 *
 * Example specs:
 *   { "type": "answerIs", "expected": "42" }
 *   { "type": "jsonValid" }
 *   { "type": "numeric", "expected": 3.14, "tol": 0.01 }
 *   { "type": "containsAll", "subs": ["foo", "bar"], "ci": true }
 */

import {
  type Verifier,
  nonEmpty,
  exact,
  answerIs,
  containsAll,
  matches,
  numeric,
  maxLength,
  jsonValid,
} from "./verifier.js";

export interface VerifierSpec {
  type: string;
  [key: string]: unknown;
}

export interface BuiltVerifier {
  verifier: Verifier;
  /** Stable label stored in the ledger's verifier column. */
  name: string;
}

export interface VerifierBuildError {
  error: string;
}

export function isVerifierBuildError(v: BuiltVerifier | VerifierBuildError): v is VerifierBuildError {
  return "error" in v;
}

/**
 * Build a Verifier from an untrusted JSON spec. Returns `{ error }` (never throws) on a malformed
 * spec so the caller can map it to a 400.
 */
export function buildVerifier(spec: unknown): BuiltVerifier | VerifierBuildError {
  if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
    return { error: "verifier must be an object" };
  }
  const s = spec as Record<string, unknown>;
  if (typeof s["type"] !== "string") {
    return { error: "verifier requires a string 'type'" };
  }
  // `ci` defaults to case-INSENSITIVE matching for the substring/answer verifiers (the common case
  // for grading free-form model output); pass `"ci": false` for an exact-case match.
  const ci = s["ci"] !== false;

  switch (s["type"]) {
    case "nonEmpty": {
      const minLen = typeof s["minLen"] === "number" ? (s["minLen"] as number) : 1;
      if (minLen < 0) return { error: "'minLen' must be >= 0" };
      return { verifier: nonEmpty(minLen), name: `nonEmpty(${minLen})` };
    }
    case "answerIs": {
      if (typeof s["expected"] !== "string") return { error: "answerIs requires string 'expected'" };
      return { verifier: answerIs(s["expected"] as string, { ci }), name: "answerIs" };
    }
    case "exact": {
      if (typeof s["expected"] !== "string") return { error: "exact requires string 'expected'" };
      return { verifier: exact(s["expected"] as string, { ci }), name: "exact" };
    }
    case "containsAll": {
      const subs = s["subs"];
      if (!Array.isArray(subs) || subs.length === 0 || !subs.every((x) => typeof x === "string")) {
        return { error: "containsAll requires a non-empty string[] 'subs'" };
      }
      return { verifier: containsAll(subs as string[], { ci }), name: "containsAll" };
    }
    case "matches": {
      // ACCEPTED RISK (Codex finding 5, low): this compiles an arbitrary RegExp from the spec and
      // runs it over model output, so a catastrophic-backtracking pattern could stall the event
      // loop. It is NOT guest-exploitable — /delegate is owner-tier-only (the gateway enforces it),
      // so the pattern author is the trusted owner / Hugin. We reject the stateful flags (g/y),
      // whose lastIndex carry-over would make a reused verifier non-deterministic. If `matches` ever
      // needs untrusted callers, gate it behind a safe-regex check or a worker timeout.
      if (typeof s["pattern"] !== "string") return { error: "matches requires string 'pattern'" };
      const flags = typeof s["flags"] === "string" ? (s["flags"] as string) : undefined;
      if (flags !== undefined && /[gy]/.test(flags)) {
        return { error: "matches 'flags' may not include 'g' or 'y'" };
      }
      let re: RegExp;
      try {
        re = new RegExp(s["pattern"] as string, flags);
      } catch {
        return { error: "matches 'pattern' is not a valid regular expression" };
      }
      return { verifier: matches(re), name: "matches" };
    }
    case "numeric": {
      if (typeof s["expected"] !== "number") return { error: "numeric requires number 'expected'" };
      const tol = typeof s["tol"] === "number" ? (s["tol"] as number) : undefined;
      const expected = s["expected"] as number;
      return {
        verifier: tol !== undefined ? numeric(expected, tol) : numeric(expected),
        name: "numeric",
      };
    }
    case "maxLength": {
      if (typeof s["max"] !== "number") return { error: "maxLength requires number 'max'" };
      const min = typeof s["min"] === "number" ? (s["min"] as number) : undefined;
      return {
        verifier: maxLength(s["max"] as number, min !== undefined ? { min } : {}),
        name: "maxLength",
      };
    }
    case "jsonValid": {
      return { verifier: jsonValid(), name: "jsonValid" };
    }
    default:
      return { error: `unknown verifier type '${String(s["type"])}'` };
  }
}
