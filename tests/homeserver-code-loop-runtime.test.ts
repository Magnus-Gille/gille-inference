import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { piVisibilityBinds } from "../src/homeserver/code-loop-runtime.js";

/**
 * piVisibilityBinds — derives the narrow ro-binds that make the pi install visible inside the
 * cage (the 2026-07-02 live-smoke bug: `--tmpfs $HOME` hid ~/.local/bin/pi — a symlink into
 * ~/.local/lib/node_modules — and the provider config, so pi was ENOENT in-cage). Three paths
 * must surface: the bin dir holding the symlink, the node_modules ROOT containing the realpath'd
 * target, and the agent dir's models.json FILE — never the agent dir itself, which on the box
 * ALSO holds pi's auth.json (its OAuth/API-key credential store) that must stay hidden.
 */

// A REAL fixture mimicking the box layout:
//   <base>/.local/bin/pi -> ../lib/node_modules/@x/pi/dist/cli.js
//   <base>/.pi-code-loop/{models.json, auth.json}
let base = "";

beforeEach(() => {
  // realpath the base so expectations survive a symlinked tmpdir.
  base = realpathSync(mkdtempSync(join(tmpdir(), "cl-rt-")));
  mkdirSync(join(base, ".local", "lib", "node_modules", "@x", "pi", "dist"), { recursive: true });
  writeFileSync(join(base, ".local", "lib", "node_modules", "@x", "pi", "dist", "cli.js"), "// cli\n");
  mkdirSync(join(base, ".local", "bin"), { recursive: true });
  symlinkSync(join("..", "lib", "node_modules", "@x", "pi", "dist", "cli.js"), join(base, ".local", "bin", "pi"));
  mkdirSync(join(base, ".pi-code-loop"));
  writeFileSync(join(base, ".pi-code-loop", "models.json"), "{}\n");
  writeFileSync(join(base, ".pi-code-loop", "auth.json"), "{}\n"); // pi's credential store — must NOT be bound
});

describe("piVisibilityBinds", () => {
  it("returns the bin dir, the realpath'd node_modules root, and the agent dir's models.json FILE (the box layout)", () => {
    const binds = piVisibilityBinds(join(base, ".local", "bin", "pi"), join(base, ".pi-code-loop"));
    expect(binds).toEqual([
      join(base, ".local", "bin"),
      join(base, ".local", "lib", "node_modules"),
      join(base, ".pi-code-loop", "models.json"),
    ]);
  });

  it("NEVER binds the agent dir itself — auth.json (pi's credential store) must stay hidden", () => {
    const binds = piVisibilityBinds(join(base, ".local", "bin", "pi"), join(base, ".pi-code-loop"));
    expect(binds).not.toContain(join(base, ".pi-code-loop"));
    expect(binds.join(" ")).not.toContain("auth.json");
  });

  it("canonicalizes the bin dir through symlinks (lexical dirname alone is not trustworthy)", () => {
    // <base>/linked-bin -> <base>/.local/bin — the LEXICAL dirname is the symlink; the bind
    // must be the realpath'd canonical dir.
    symlinkSync(join(base, ".local", "bin"), join(base, "linked-bin"));
    const binds = piVisibilityBinds(join(base, "linked-bin", "pi"), join(base, ".pi-code-loop"));
    expect(binds[0]).toBe(join(base, ".local", "bin"));
    expect(binds).not.toContain(join(base, "linked-bin"));
  });

  it("keeps the LAST node_modules segment when the realpath nests several", () => {
    // <base>/.local/lib/node_modules/@x/pi/node_modules/dep/run.js
    const nested = join(base, ".local", "lib", "node_modules", "@x", "pi", "node_modules", "dep");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "run.js"), "");
    const binds = piVisibilityBinds(join(nested, "run.js"), join(base, ".pi-code-loop"));
    expect(binds).toContain(join(base, ".local", "lib", "node_modules", "@x", "pi", "node_modules"));
  });

  it("falls back to the realpath's dirname when the target is not under node_modules", () => {
    const plainDir = join(base, "opt", "pi-standalone");
    mkdirSync(plainDir, { recursive: true });
    writeFileSync(join(plainDir, "pi.js"), "");
    symlinkSync(join(plainDir, "pi.js"), join(base, ".local", "bin", "pi2"));
    const binds = piVisibilityBinds(join(base, ".local", "bin", "pi2"), join(base, ".pi-code-loop"));
    expect(binds).toEqual([join(base, ".local", "bin"), plainDir, join(base, ".pi-code-loop", "models.json")]);
  });

  it("falls back to the lexical paths when piBin does not exist (realpathSync throws)", () => {
    const missing = join(base, "nope", ".local", "bin", "pi");
    const binds = piVisibilityBinds(missing, join(base, ".pi-code-loop"));
    expect(binds).toEqual([dirname(missing), join(base, ".pi-code-loop", "models.json")]);
  });

  it("dedupes when the binary is NOT a symlink (bin dir === realpath dirname)", () => {
    const direct = join(base, ".local", "lib", "node_modules", "@x", "pi", "dist", "cli.js");
    const binds = piVisibilityBinds(direct, join(base, ".pi-code-loop"));
    expect(binds).toEqual([
      join(base, ".local", "lib", "node_modules", "@x", "pi", "dist"),
      join(base, ".local", "lib", "node_modules"),
      join(base, ".pi-code-loop", "models.json"),
    ]);
    expect(new Set(binds).size).toBe(binds.length);
  });

  it("empty piBin / piAgentDir contribute nothing (unprovisioned box)", () => {
    expect(piVisibilityBinds("", "")).toEqual([]);
    expect(piVisibilityBinds("", join(base, ".pi-code-loop"))).toEqual([join(base, ".pi-code-loop", "models.json")]);
  });
});
