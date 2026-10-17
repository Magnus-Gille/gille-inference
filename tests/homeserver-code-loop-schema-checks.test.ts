import { describe, expect, it } from "vitest";
import {
  isSchemaGroundingResult,
  validateSchemaChecks,
} from "../src/homeserver/code-loop-schema-checks.js";
import { validateCodeLoopRequestStructure } from "../src/homeserver/code-loop.js";
import { codeLoopRequestFingerprint } from "../src/homeserver/code-loop-store.js";
import type { CodeLoopRequest } from "../src/homeserver/code-loop-types.js";

const encoder = new TextEncoder();

function check(name = "check", command = "printf ok"): { name: string; command: string } {
  return { name, command };
}

function expectInvalid(value: unknown, description: RegExp): void {
  const result = validateSchemaChecks(value);
  if (typeof result !== "string") {
    throw new Error(`expected validation failure matching ${description}, got ${String(result)}`);
  }
  expect(result.trim().length).toBeGreaterThan(0);
  expect(result).toMatch(description);
}

function expectGroundingInvalid(value: unknown, diff = "", summary = ""): void {
  expect(isSchemaGroundingResult(value, diff, summary)).toBe(false);
}

describe("validateSchemaChecks", () => {
  describe("optional and top-level array bounds", () => {
    it("allows an omitted optional schema-check list", () => {
      expect(validateSchemaChecks(undefined)).toBeNull();
    });

    it("accepts one check and the maximum of eight checks", () => {
      expect(validateSchemaChecks([check("a", "echo a")])).toBeNull();
      expect(
        validateSchemaChecks(
          Array.from({ length: 8 }, (_, index) => check(`check-${index}`, `echo ${index}`)),
        ),
      ).toBeNull();
    });

    it("accepts the two fields in either object insertion order", () => {
      expect(validateSchemaChecks([{ command: "echo ok", name: "a" }])).toBeNull();
    });

    it("rejects null and every non-array top-level type", () => {
      for (const value of [null, "checks", 1, true, false, {}, new Map(), new Set()]) {
        expectInvalid(value, /array|schema|check/i);
      }
    });

    it("rejects an empty list, a ninth check, and sparse entries", () => {
      expectInvalid([], /array|at least|check/i);
      expectInvalid(
        Array.from({ length: 9 }, (_, index) => check(`check-${index}`)),
        /array|eight|max|check/i,
      );

      const sparse: unknown[] = [];
      sparse.length = 1;
      expectInvalid(sparse, /object|entry|check/i);
    });
  });

  describe("exact check object shape", () => {
    it("requires each entry to be an object", () => {
      for (const value of [null, undefined, "check", 7, true, false, [], new Date()]) {
        expectInvalid([value], /object|entry|check/i);
      }
    });

    it("requires both name and command properties", () => {
      expectInvalid([{}], /name|command|field|property/i);
      expectInvalid([{ name: "a" }], /command/i);
      expectInvalid([{ command: "echo" }], /name/i);
      expectInvalid([{ name: undefined, command: "echo" }], /name/i);
      expectInvalid([{ name: "a", command: undefined }], /command/i);
    });

    it("rejects any extra own property", () => {
      expectInvalid([{ name: "a", command: "echo", description: "extra" }], /key|property|field|schema|check/i);
    });
  });

  describe("check-name grammar and uniqueness", () => {
    it("accepts the shortest name, numeric first character, all allowed suffix characters, and 80 ASCII characters", () => {
      expect(validateSchemaChecks([check("a")])).toBeNull();
      expect(validateSchemaChecks([check("0")])).toBeNull();
      expect(validateSchemaChecks([check("a0._:-")])).toBeNull();
      expect(validateSchemaChecks([check("a".repeat(80))])).toBeNull();
    });

    it("rejects empty, uppercase, invalid-leading, invalid-suffix, non-ASCII, and overlong names", () => {
      for (const name of [
        "",
        "A",
        "-a",
        "_a",
        ".a",
        ":a",
        "a b",
        "a/b",
        "a!",
        "å",
        "aå",
        "a\0",
        "a".repeat(81),
      ]) {
        expectInvalid([check(name)], /name/i);
      }
    });

    it("rejects duplicate names even when commands differ", () => {
      expectInvalid(
        [check("a", "echo one"), check("a", "echo two")],
        /duplicate|unique|name/i,
      );
    });
  });

  describe("command constraints", () => {
    it("accepts nonblank commands, including multibyte UTF-8 text", () => {
      expect(validateSchemaChecks([check("a", "echo å")])).toBeNull();
      expect(validateSchemaChecks([check("a", "x")])).toBeNull();
    });

    it("rejects empty and whitespace-only commands", () => {
      for (const command of ["", " ", "\t", "\n", "\r\n", " \t\r\n ", "\u00a0"]) {
        expectInvalid([check("a", command)], /command|blank|empty|whitespace/i);
      }
    });

    it("rejects commands containing a NUL byte", () => {
      expectInvalid([check("a", "echo\0ok")], /command|NUL|byte/i);
      expectInvalid([check("a", "\0")], /command|NUL|byte/i);
    });

    it("uses UTF-8 byte length at the per-command 8192-byte boundary", () => {
      const asciiAtLimit = "x".repeat(8192);
      expect(encoder.encode(asciiAtLimit).byteLength).toBe(8192);
      expect(validateSchemaChecks([check("a", asciiAtLimit)])).toBeNull();
      expectInvalid([check("a", `${asciiAtLimit}x`)], /command|8192|byte|size/i);

      const twoByteAtLimit = "é".repeat(4096);
      expect(encoder.encode(twoByteAtLimit).byteLength).toBe(8192);
      expect(validateSchemaChecks([check("a", twoByteAtLimit)])).toBeNull();
      expectInvalid([check("a", `${twoByteAtLimit}é`)], /command|8192|byte|size/i);

      const fourByteAtLimit = "😀".repeat(2048);
      expect(encoder.encode(fourByteAtLimit).byteLength).toBe(8192);
      expect(validateSchemaChecks([check("a", fourByteAtLimit)])).toBeNull();
      expectInvalid([check("a", `${fourByteAtLimit}😀`)], /command|8192|byte|size/i);
    });
  });

  describe("aggregate command byte limit", () => {
    it("accepts exactly 32768 total command bytes", () => {
      const checks = Array.from({ length: 4 }, (_, index) => check(`check-${index}`, "x".repeat(8192)));
      expect(checks.reduce((total, item) => total + encoder.encode(item.command).byteLength, 0)).toBe(32768);
      expect(validateSchemaChecks(checks)).toBeNull();
    });

    it("rejects total command bytes above 32768 even when every command is individually valid", () => {
      const checks = Array.from({ length: 4 }, (_, index) => check(`check-${index}`, "x".repeat(8192)));
      checks.push(check("fifth", "x"));
      expectInvalid(checks, /total|aggregate|command|32768|byte|size/i);
    });
  });

  describe("isSchemaGroundingResult", () => {
    it("accepts not-requested, passed, failed, and skipped evidence states", () => {
      expect(isSchemaGroundingResult(
        { schema_version: 1, state: "not-requested", checks: [] },
        "diff is allowed when no checks were requested",
        "summary is allowed when no checks were requested",
      )).toBe(true);

      expect(isSchemaGroundingResult(
        { schema_version: 1, state: "passed", checks: [{ name: "compile", ran: true, exit_code: 0, output_tail: "ok" }] },
        "diff",
        "summary",
      )).toBe(true);

      expect(isSchemaGroundingResult(
        { schema_version: 1, state: "failed", checks: [{ name: "compile", ran: true, exit_code: 1, output_tail: "failed" }] },
        "",
        "",
      )).toBe(true);

      expect(isSchemaGroundingResult(
        { schema_version: 1, state: "skipped", checks: [{ name: "compile", ran: false, exit_code: null, output_tail: "" }] },
        "",
        "",
      )).toBe(true);
    });

    it("accepts a 4096-character output tail and valid exit-code boundaries", () => {
      expect(isSchemaGroundingResult(
        { schema_version: 1, state: "failed", checks: [
          { name: "first", ran: true, exit_code: 255, output_tail: "x".repeat(4096) },
          { name: "second", ran: false, exit_code: null, output_tail: "" },
        ] },
        "",
        "",
      )).toBe(true);
    });

    it("rejects missing, malformed, empty, and overlong grounding structures", () => {
      for (const value of [
        undefined,
        null,
        {},
        { schema_version: 2, state: "not-requested", checks: [] },
        { schema_version: 1, state: "not-requested" },
        { schema_version: 1, state: "unknown", checks: [] },
        { schema_version: 1, state: "passed", checks: [] },
        { schema_version: 1, state: "failed", checks: [] },
        { schema_version: 1, state: "skipped", checks: [] },
        { schema_version: 1, state: "not-requested", checks: [{ name: "a", ran: false, exit_code: null, output_tail: "" }] },
        { schema_version: 1, state: "failed", checks: Array.from({ length: 9 }, () => ({ name: "a", ran: true, exit_code: 1, output_tail: "" })) },
      ]) {
        expectGroundingInvalid(value);
      }
    });

    it("rejects duplicate and invalid check names", () => {
      expectGroundingInvalid({
        schema_version: 1,
        state: "failed",
        checks: [
          { name: "same", ran: true, exit_code: 1, output_tail: "first" },
          { name: "same", ran: true, exit_code: 2, output_tail: "second" },
        ],
      });
      for (const name of ["", "Upper", "-leading", "a/b", "å", "a".repeat(81)]) {
        expectGroundingInvalid({
          schema_version: 1,
          state: "failed",
          checks: [{ name, ran: true, exit_code: 1, output_tail: "failed" }],
        });
      }
    });

    it("rejects malformed check records, oversized tails, and invalid exit codes", () => {
      for (const check of [
        { name: "a", ran: true, exit_code: 1, output_tail: "x".repeat(4097) },
        { name: "a", ran: true, exit_code: -1, output_tail: "" },
        { name: "a", ran: true, exit_code: 256, output_tail: "" },
        { name: "a", ran: true, exit_code: 1.5, output_tail: "" },
        { name: "a", ran: false, exit_code: 1, output_tail: "" },
        { name: "a", ran: "yes", exit_code: 1, output_tail: "" },
        { name: "a", ran: true, exit_code: 1, output_tail: 7 },
        { name: "a", ran: true, exit_code: 1 },
        { name: "a", exit_code: 1, output_tail: "" },
      ]) {
        expectGroundingInvalid({ schema_version: 1, state: "failed", checks: [check] });
      }
    });

    it("rejects a passed state unless every check ran and passed", () => {
      expectGroundingInvalid({
        schema_version: 1,
        state: "passed",
        checks: [{ name: "a", ran: true, exit_code: 1, output_tail: "failed" }],
      });
      expectGroundingInvalid({
        schema_version: 1,
        state: "passed",
        checks: [{ name: "a", ran: false, exit_code: null, output_tail: "" }],
      });
    });

    it("rejects failed evidence when all checks passed", () => {
      expectGroundingInvalid({
        schema_version: 1,
        state: "failed",
        checks: [{ name: "a", ran: true, exit_code: 0, output_tail: "ok" }],
      });
    });

    it("rejects skipped evidence when any check actually ran", () => {
      expectGroundingInvalid({
        schema_version: 1,
        state: "skipped",
        checks: [{ name: "a", ran: true, exit_code: 1, output_tail: "failed" }],
      });
    });

    it("rejects diff or summary disclosure for failed and skipped evidence", () => {
      const failed = { schema_version: 1, state: "failed", checks: [{ name: "a", ran: true, exit_code: 1, output_tail: "failed" }] };
      const skipped = { schema_version: 1, state: "skipped", checks: [{ name: "a", ran: false, exit_code: null, output_tail: "" }] };
      for (const value of [failed, skipped]) {
        expectGroundingInvalid(value, "disclosed diff", "");
        expectGroundingInvalid(value, "", "disclosed summary");
      }
    });
  });

  describe("schema_checks request identity and admission", () => {
    const baseRequest: CodeLoopRequest = {
      instruction: "implement the bounded change",
      files: [{ path: "src/example.ts", content: "export const value = 1;\n" }],
    };

    it("preserves the omitted-schema_checks fingerprint for explicit undefined", () => {
      expect(codeLoopRequestFingerprint(baseRequest)).toBe(
        codeLoopRequestFingerprint({ ...baseRequest, schema_checks: undefined }),
      );
    });

    it("binds supplied schema-check names and commands into request identity", () => {
      const named = codeLoopRequestFingerprint({
        ...baseRequest,
        schema_checks: [{ name: "shape", command: "npm test -- shape" }],
      });
      expect(named).not.toBe(codeLoopRequestFingerprint(baseRequest));
      expect(named).not.toBe(codeLoopRequestFingerprint({
        ...baseRequest,
        schema_checks: [{ name: "other", command: "npm test -- shape" }],
      }));
      expect(named).not.toBe(codeLoopRequestFingerprint({
        ...baseRequest,
        schema_checks: [{ name: "shape", command: "npm test -- other" }],
      }));
    });

    it("canonicalizes schema-check object property order", () => {
      const first = codeLoopRequestFingerprint({
        ...baseRequest,
        schema_checks: [{ name: "shape", command: "npm test -- shape" }],
      });
      const reordered = codeLoopRequestFingerprint({
        ...baseRequest,
        schema_checks: [{ command: "npm test -- shape", name: "shape" }],
      });
      expect(reordered).toBe(first);
    });

    it("binds schema-check array ordering into request identity", () => {
      const first = codeLoopRequestFingerprint({
        ...baseRequest,
        schema_checks: [
          { name: "first", command: "npm test -- first" },
          { name: "second", command: "npm test -- second" },
        ],
      });
      const reordered = codeLoopRequestFingerprint({
        ...baseRequest,
        schema_checks: [
          { name: "second", command: "npm test -- second" },
          { name: "first", command: "npm test -- first" },
        ],
      });
      expect(reordered).not.toBe(first);
    });

    it("rejects malformed schema_checks at the request-structure boundary", () => {
      const malformed: unknown[] = [
        null,
        [],
        Array.from({ length: 9 }, (_, index) => ({ name: `check-${index}`, command: "echo ok" })),
        [{ name: "Upper", command: "echo ok" }],
        [{ name: "valid", command: "" }],
        [{ name: "valid", command: "echo\0ok" }],
        [{ name: "valid", command: "echo ok", extra: true }],
      ];
      for (const schema_checks of malformed) {
        const result = validateCodeLoopRequestStructure({
          ...baseRequest,
          schema_checks,
        } as unknown as CodeLoopRequest);
        expect(result.ok).toBe(false);
      }
    });
  });
});
