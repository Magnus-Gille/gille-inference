import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  applyEditDeadlinePolicy,
  clampCaps,
  codeLoopToolDefs,
  seedSandbox,
  validateCodeLoopRequest,
} from "../src/homeserver/code-loop.js";
import type { CodeLoopCapsConfig } from "../src/homeserver/code-loop-types.js";

/**
 * Seeding containment (docs/agentic-code-tool-design.md §5) — the HARDENED check: lexical
 * containment + realpath verification of the parent directory + `wx` creation. Written
 * red-first: these are the security tests for the only host-side write path that consumes
 * caller-supplied paths.
 */

const CAPS: CodeLoopCapsConfig = {
  wallSDefault: 480,
  wallSMax: 900,
  turnsDefault: 24,
  turnsMax: 40,
  tokensDefault: 60_000,
  tokensMax: 120_000,
};

let sandbox = "";
let outside = "";

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "cl-seed-test-"));
  sandbox = join(root, "sandbox");
  outside = join(root, "outside");
  mkdirSync(sandbox);
  mkdirSync(outside);
});

describe("seedSandbox — containment", () => {
  it("writes a plain nested relative path", () => {
    seedSandbox(sandbox, [{ path: "src/a/b.ts", content: "export {};\n" }]);
    expect(readFileSync(join(sandbox, "src/a/b.ts"), "utf8")).toBe("export {};\n");
  });

  it("rejects a ../ traversal path", () => {
    expect(() => seedSandbox(sandbox, [{ path: "../pwned.txt", content: "x" }])).toThrow(/escap|contain|relative/i);
    expect(existsSync(join(sandbox, "..", "pwned.txt"))).toBe(false);
  });

  it("rejects an embedded traversal (a/../../x)", () => {
    expect(() => seedSandbox(sandbox, [{ path: "a/../../x", content: "x" }])).toThrow(/escap|contain|relative/i);
  });

  it("rejects an absolute path", () => {
    expect(() => seedSandbox(sandbox, [{ path: "/etc/cron.d/pwn", content: "x" }])).toThrow(/absolute|escap|relative/i);
  });

  it("rejects a NUL byte in the path", () => {
    expect(() => seedSandbox(sandbox, [{ path: "a\0b", content: "x" }])).toThrow();
  });

  it("rejects seeding into .git/ (protects the diff baseline + host-side git ops)", () => {
    expect(() => seedSandbox(sandbox, [{ path: ".git/hooks/post-checkout", content: "#!/bin/sh\n" }])).toThrow(/\.git/);
    expect(() => seedSandbox(sandbox, [{ path: "sub/.git/config", content: "[core]" }])).toThrow(/\.git/);
  });

  it("rejects a symlink-parent escape (realpath verification, not just lexical)", () => {
    // A symlink INSIDE the sandbox pointing outside: lexically "evil/pwned.txt" is contained,
    // but the real parent directory is outside. resolveContained()-style lexical checks pass
    // this; the hardened seeder must not.
    symlinkSync(outside, join(sandbox, "evil"));
    expect(() => seedSandbox(sandbox, [{ path: "evil/pwned.txt", content: "x" }])).toThrow(/escap|symlink|contain/i);
    expect(existsSync(join(outside, "pwned.txt"))).toBe(false);
  });

  it("refuses to follow a pre-existing entry at the target (wx creation)", () => {
    writeFileSync(join(sandbox, "existing.txt"), "old");
    expect(() => seedSandbox(sandbox, [{ path: "existing.txt", content: "new" }])).toThrow();
    expect(readFileSync(join(sandbox, "existing.txt"), "utf8")).toBe("old");
  });
});

describe("validateCodeLoopRequest — bounds", () => {
  const okFiles = [{ path: "a.ts", content: "x" }];

  it("requires a non-empty instruction", () => {
    const r = validateCodeLoopRequest({ instruction: "", files: okFiles }, CAPS);
    expect(r.ok).toBe(false);
  });

  it("requires at least one seed file (Phase-1 inline seeding)", () => {
    const r = validateCodeLoopRequest({ instruction: "do it", files: [] }, CAPS);
    expect(r.ok).toBe(false);
  });

  it("rejects more than 64 files", () => {
    const files = Array.from({ length: 65 }, (_, i) => ({ path: `f${i}.ts`, content: "x" }));
    const r = validateCodeLoopRequest({ instruction: "do it", files }, CAPS);
    expect(r.ok).toBe(false);
  });

  it("rejects more than 2 MB total seed content", () => {
    const files = [{ path: "big.txt", content: "x".repeat(2 * 1024 * 1024 + 1) }];
    const r = validateCodeLoopRequest({ instruction: "do it", files }, CAPS);
    expect(r.ok).toBe(false);
  });

  it("accepts a valid request and returns clamped caps", () => {
    const r = validateCodeLoopRequest({ instruction: "do it", files: okFiles }, CAPS);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.caps).toEqual({ wall_s: 480, turns: 24, completion_tokens: 60_000 });
    }
  });

  it("accepts a valid edit deadline and binds it to the effective turn cap", () => {
    const r = validateCodeLoopRequest({
      instruction: "do it",
      files: okFiles,
      caps: { turns: 13, edit_deadline_turn: 6 },
    }, CAPS);
    expect(r).toEqual({
      ok: true,
      caps: { wall_s: 480, turns: 13, completion_tokens: 60_000, edit_deadline_turn: 6 },
    });
  });

  it("rejects invalid or unreachable edit deadlines instead of silently clamping them", () => {
    for (const edit_deadline_turn of [0, -1, 1.5, Number.NaN]) {
      const r = validateCodeLoopRequest({
        instruction: "do it",
        files: okFiles,
        caps: { turns: 13, edit_deadline_turn },
      }, CAPS);
      expect(r.ok).toBe(false);
    }
    const beyond = validateCodeLoopRequest({
      instruction: "do it",
      files: okFiles,
      caps: { turns: 5, edit_deadline_turn: 6 },
    }, CAPS);
    expect(beyond.ok).toBe(false);
  });
});

describe("clampCaps — defaults + hard maxima", () => {
  it("applies defaults when caps are omitted", () => {
    expect(clampCaps(undefined, CAPS)).toEqual({ wall_s: 480, turns: 24, completion_tokens: 60_000 });
  });

  it("clamps to the hard maxima", () => {
    expect(clampCaps({ wall_s: 5000, turns: 999, completion_tokens: 10_000_000 }, CAPS)).toEqual({
      wall_s: 900,
      turns: 40,
      completion_tokens: 120_000,
    });
  });

  it("floors at 1 and ignores non-finite values", () => {
    expect(clampCaps({ wall_s: 0, turns: -3, completion_tokens: Number.NaN }, CAPS)).toEqual({
      wall_s: 1,
      turns: 1,
      completion_tokens: 60_000,
    });
  });
});

describe("edit-deadline contract", () => {
  it("leaves the instruction byte-for-byte unchanged when the policy is absent", () => {
    const instruction = "fix a.ts\nthen run tests\n";
    expect(applyEditDeadlinePolicy(instruction, undefined)).toBe(instruction);
  });

  it("uses a stable versioned wrapper when the policy is enabled", () => {
    const wrapped = applyEditDeadlinePolicy("fix it", 6);
    expect(wrapped).toContain("edit-deadline policy v1");
    expect(wrapped).toContain("no later than agent turn 6");
    expect(wrapped.endsWith("fix it")).toBe(true);
  });

  it("advertises edit_deadline_turn in the owner MCP tool schema", () => {
    const start = codeLoopToolDefs().find(
      (tool) => (tool as { name?: string }).name === "code_loop_start"
    ) as { inputSchema: { properties: { caps: { properties: Record<string, unknown> } } } };
    expect(start.inputSchema.properties.caps.properties).toHaveProperty("edit_deadline_turn");
  });
});

// ─── Relative sandboxDir (the live default HOMESERVER_CODE_LOOP_WORKROOT=./data/…) ────────
// First live smoke 2026-07-02: every seed was refused as "escapes the sandbox" because the
// lexical check compared resolve()'s ABSOLUTE result against the RELATIVE sandbox string.
describe("seedSandbox with a RELATIVE sandboxDir", () => {
  it("accepts a plain relative seed path (the live-default workroot shape)", () => {
    const abs = mkdtempSync(join(tmpdir(), "cl-seed-rel-"));
    const rel = relative(process.cwd(), abs);
    seedSandbox(rel, [{ path: "greet.js", content: "console.log('hi');\n" }]);
    expect(readFileSync(join(abs, "greet.js"), "utf8")).toBe("console.log('hi');\n");
  });
  it("still rejects traversal from a relative sandboxDir", () => {
    const abs = mkdtempSync(join(tmpdir(), "cl-seed-rel-"));
    const rel = relative(process.cwd(), abs);
    expect(() => seedSandbox(rel, [{ path: "../escape.txt", content: "x" }])).toThrow(/escapes the sandbox/);
  });
});
