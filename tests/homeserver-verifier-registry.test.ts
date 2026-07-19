import { describe, it, expect } from "vitest";
import { buildVerifier, isVerifierBuildError } from "../src/homeserver/verifier-registry.js";

/** Build, assert no error, and run the verifier against `output`. */
async function run(spec: unknown, output: string) {
  const built = buildVerifier(spec);
  if (isVerifierBuildError(built)) throw new Error(`unexpected build error: ${built.error}`);
  return built.verifier(output);
}

describe("buildVerifier — named-verifier registry (#14)", () => {
  it("rejects non-object / missing-type specs", () => {
    expect(isVerifierBuildError(buildVerifier(null))).toBe(true);
    expect(isVerifierBuildError(buildVerifier("nope"))).toBe(true);
    expect(isVerifierBuildError(buildVerifier([]))).toBe(true);
    expect(isVerifierBuildError(buildVerifier({}))).toBe(true);
    expect(isVerifierBuildError(buildVerifier({ type: "does-not-exist" }))).toBe(true);
  });

  it("answerIs passes when the answer is present (ci default on), fails otherwise", async () => {
    expect((await run({ type: "answerIs", expected: "42" }, "the result is 42.")).outcome).toBe("pass");
    expect((await run({ type: "answerIs", expected: "PARIS" }, "the capital is paris")).outcome).toBe("pass");
    const fail = await run({ type: "answerIs", expected: "99" }, "the result is 42.");
    expect(fail.outcome).not.toBe("pass");
  });

  it("answerIs requires a string 'expected'", () => {
    const built = buildVerifier({ type: "answerIs", expected: 42 });
    expect(isVerifierBuildError(built)).toBe(true);
  });

  it("numeric matches the last number within tolerance", async () => {
    expect((await run({ type: "numeric", expected: 3.14, tol: 0.01 }, "pi ≈ 3.14159")).outcome).toBe("pass");
    const fail = await run({ type: "numeric", expected: 3.14, tol: 0.0001 }, "pi ≈ 3.2");
    expect(fail.outcome).not.toBe("pass");
  });

  it("jsonValid passes on valid JSON, errors on garbage", async () => {
    expect((await run({ type: "jsonValid" }, '{"ok": true}')).outcome).toBe("pass");
    expect((await run({ type: "jsonValid" }, "not json at all")).outcome).toBe("error");
  });

  it("containsAll requires a non-empty string[] and grades partial", async () => {
    expect(isVerifierBuildError(buildVerifier({ type: "containsAll", subs: [] }))).toBe(true);
    expect(isVerifierBuildError(buildVerifier({ type: "containsAll", subs: [1, 2] }))).toBe(true);
    expect((await run({ type: "containsAll", subs: ["foo", "bar"] }, "foo and BAR")).outcome).toBe("pass");
  });

  it("matches builds a RegExp and rejects an invalid pattern", async () => {
    expect((await run({ type: "matches", pattern: "^\\d{3}$" }, "123")).outcome).toBe("pass");
    expect(isVerifierBuildError(buildVerifier({ type: "matches", pattern: "(" }))).toBe(true);
  });

  it("matches rejects stateful flags g/y (non-determinism guard — Codex finding 5)", () => {
    expect(isVerifierBuildError(buildVerifier({ type: "matches", pattern: "a", flags: "g" }))).toBe(true);
    expect(isVerifierBuildError(buildVerifier({ type: "matches", pattern: "a", flags: "gy" }))).toBe(true);
    // A benign flag like 'i' is still accepted.
    expect(isVerifierBuildError(buildVerifier({ type: "matches", pattern: "A", flags: "i" }))).toBe(false);
  });

  it("exposes a stable name for the ledger", () => {
    const built = buildVerifier({ type: "numeric", expected: 1 });
    if (isVerifierBuildError(built)) throw new Error("unexpected");
    expect(built.name).toBe("numeric");
  });
});
