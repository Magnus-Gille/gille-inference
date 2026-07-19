/**
 * TDD tests for code-edit probe verifiers.
 *
 * Each test asserts PASS on a hand-written CORRECT edited output and FAIL (or partial/error)
 * on the original unedited code — confirming the verifier is actually checking the edit,
 * not just passing everything.
 *
 * Tests for the two tsGate-backed probes (edit-off-by-one, edit-make-async, edit-default-param,
 * edit-add-early-return) exercise compile+run, so they carry a generous timeout.
 */

import { describe, it, expect } from "vitest";
import { PROBES } from "../src/homeserver/probes.js";

function getProbe(id: string) {
  const p = PROBES.find((pr) => pr.id === id);
  if (!p) throw new Error(`Probe not found: ${id}`);
  return p;
}

// ─── edit-rename-fn ──────────────────────────────────────────────────────────

describe("code-edit probe: edit-rename-fn", () => {
  const p = getProbe("edit-rename-fn");

  it("PASS: output contains fetchUser and no getUser", async () => {
    const correct =
      "```ts\nfunction fetchUser(id: number): string {\n  return `user-${id}`;\n}\n\nconst name = fetchUser(42);\nconsole.log(name);\n```";
    const result = await p.verifier(correct);
    expect(result.outcome).toBe("pass");
  });

  it("FAIL: original code with getUser not renamed", async () => {
    const original =
      "```ts\nfunction getUser(id: number): string {\n  return `user-${id}`;\n}\n\nconst name = getUser(42);\nconsole.log(name);\n```";
    const result = await p.verifier(original);
    expect(result.outcome).toBe("fail");
  });

  it("FAIL: partial rename — function renamed but call site not updated", async () => {
    const partial =
      "```ts\nfunction fetchUser(id: number): string {\n  return `user-${id}`;\n}\n\nconst name = getUser(42);\nconsole.log(name);\n```";
    const result = await p.verifier(partial);
    // containsNone fires because getUser is still present
    expect(result.outcome).toBe("fail");
  });
});

// ─── edit-rename-fn (FIX-3: call-site must be present) ──────────────────────

describe("code-edit probe: edit-rename-fn (FIX-3 negative)", () => {
  const p = getProbe("edit-rename-fn");

  it("FIX-3: NOT-PASS: defines fetchUser but drops the call site entirely", async () => {
    // The function is renamed but the `const name = fetchUser(42)` call-site line is gone.
    // FIX-3 requires the call-site args pattern (fetchUser(42)) to be present.
    // containsAll returns "partial" (not "pass") when fetchUser is found but fetchUser(42) is not.
    const droppedCallSite =
      "```ts\nfunction fetchUser(id: number): string {\n  return `user-${id}`;\n}\n```";
    const result = await p.verifier(droppedCallSite);
    expect(result.outcome).not.toBe("pass");
  });
});

// ─── edit-off-by-one ─────────────────────────────────────────────────────────

describe("code-edit probe: edit-off-by-one", () => {
  const p = getProbe("edit-off-by-one");

  it("PASS: fixed last() returns arr[arr.length - 1]", async () => {
    const correct =
      "```ts\nfunction last<T>(arr: T[]): T {\n  return arr[arr.length - 1];\n}\n```";
    const result = await p.verifier(correct);
    expect(result.outcome).toBe("pass");
  }, 60_000);

  it("FAIL: original code with off-by-one returns undefined", async () => {
    const original =
      "```ts\nfunction last<T>(arr: T[]): T {\n  return arr[arr.length];\n}\n```";
    const result = await p.verifier(original);
    // Harness throws because arr[arr.length] === undefined !== 3
    expect(result.outcome).toBe("fail");
  }, 60_000);
});

// ─── edit-add-null-guard ─────────────────────────────────────────────────────

describe("code-edit probe: edit-add-null-guard", () => {
  const p = getProbe("edit-add-null-guard");

  it("PASS: function has null guard returning empty string", async () => {
    const correct =
      "```ts\nfunction trim(s: string | null | undefined): string {\n  if (s == null) return '';\n  return s.trim();\n}\n```";
    const result = await p.verifier(correct);
    expect(result.outcome).toBe("pass");
  });

  it("PASS: function uses !== null check + undefined check", async () => {
    const correct2 =
      "```ts\nfunction trim(s: string | null | undefined): string {\n  if (s === null || s === undefined) return '';\n  return s.trim();\n}\n```";
    const result = await p.verifier(correct2);
    expect(result.outcome).toBe("pass");
  });

  it("FAIL: original code without any guard", async () => {
    const original =
      "```ts\nfunction trim(s: string | null | undefined): string {\n  return s.trim();\n}\n```";
    const result = await p.verifier(original);
    // no null/undefined guard pattern → predicate fails
    expect(result.outcome).toBe("fail");
  });

  it("FIX-2: FAIL: malformed guard — checks null but not undefined, crashes on undefined.trim()", async () => {
    // This guard returns "" for null but re-accesses s.trim() for undefined, which throws.
    // Behavior-based verifier must catch this: trim(undefined) must return "" not crash.
    const malformed =
      "```ts\nfunction trim(s: string | null | undefined): string {\n  if (s !== null) return '';\n  return s.trim();\n}\n```";
    const result = await p.verifier(malformed);
    expect(result.outcome).toBe("fail");
  }, 60_000);

  it("FIX-2: PASS: correct guard handles null, undefined, and trims strings", async () => {
    const correct =
      "```ts\nfunction trim(s: string | null | undefined): string {\n  if (s == null) return '';\n  return s.trim();\n}\n```";
    const result = await p.verifier(correct);
    expect(result.outcome).toBe("pass");
  }, 60_000);
});

// ─── edit-make-async ─────────────────────────────────────────────────────────

describe("code-edit probe: edit-make-async", () => {
  const p = getProbe("edit-make-async");

  it("PASS: async add() resolves to the correct sum", async () => {
    const correct =
      "```ts\nasync function add(a: number, b: number): Promise<number> {\n  return await Promise.resolve(a + b);\n}\n```";
    const result = await p.verifier(correct);
    expect(result.outcome).toBe("pass");
  }, 60_000);

  it("FIX-1: FAIL: original SYNC function scores FAIL under corrected harness", async () => {
    // The corrected harness rejects non-Promises: `const ret = add(3,4); if (!(ret instanceof Promise)) throw ...`
    // A sync function returns a plain number, not a Promise, so the harness must throw → FAIL.
    const syncAdd =
      "```ts\nfunction add(a: number, b: number): number {\n  return a + b;\n}\n```";
    const result = await p.verifier(syncAdd);
    expect(result.outcome).toBe("fail");
  }, 60_000);
});

// ─── edit-default-param ──────────────────────────────────────────────────────

describe("code-edit probe: edit-default-param", () => {
  const p = getProbe("edit-default-param");

  it("PASS: repeat with default n=0 makes repeat('x') return ''", async () => {
    const correct =
      "```ts\nfunction repeat(s: string, n: number = 0): string {\n  return s.repeat(n);\n}\n```";
    const result = await p.verifier(correct);
    expect(result.outcome).toBe("pass");
  }, 60_000);

  it("NOT-PASS: original code without default — tsc flags missing arg (partial) or runtime throws", async () => {
    const original =
      "```ts\nfunction repeat(s: string, n: number): string {\n  return s.repeat(n);\n}\n```";
    const result = await p.verifier(original);
    // tsc catches the missing argument in the harness → partial (type error, not runtime fail)
    // Either way, the outcome is not "pass"
    expect(result.outcome).not.toBe("pass");
  }, 60_000);
});

// ─── edit-add-early-return ───────────────────────────────────────────────────

describe("code-edit probe: edit-add-early-return", () => {
  const p = getProbe("edit-add-early-return");

  it("PASS: divide() returns 0 when b is 0", async () => {
    const correct =
      "```ts\nfunction divide(a: number, b: number): number {\n  if (b === 0) return 0;\n  return a / b;\n}\n```";
    const result = await p.verifier(correct);
    expect(result.outcome).toBe("pass");
  }, 60_000);

  it("FAIL: original code returns Infinity for divide(5,0)", async () => {
    const original =
      "```ts\nfunction divide(a: number, b: number): number {\n  return a / b;\n}\n```";
    const result = await p.verifier(original);
    // 5/0 === Infinity, not 0 → harness throws
    expect(result.outcome).toBe("fail");
  }, 60_000);
});
