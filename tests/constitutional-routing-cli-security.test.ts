import { chmodSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  boundedProtectedRead,
  protectedPath,
  resolveAuthorityConfigPath,
  sameOpenedInode,
} from "../scripts/constitutional-routing-cli.js";

describe("constitutional CLI protected roots", () => {
  it("refuses authority-config and owner-pin root substitution", () => {
    const fixed = resolveAuthorityConfigPath([], undefined, "/home/service");
    expect(fixed).toBe("/home/service/.config/gille-inference/authority-config.json");
    expect(() => resolveAuthorityConfigPath(["--authority-config", "/tmp/attacker.json"], undefined, "/home/service")).toThrow(/fixed/);
    expect(() => resolveAuthorityConfigPath([], "/tmp/replacement.json", "/home/service")).toThrow(/substitution/);
  });

  it("refuses a symlink even when its target is a regular non-writable file", () => {
    const root = mkdtempSync(join(tmpdir(), "constitutional-symlink-"));
    const target = join(root, "target");
    const link = join(root, "link");
    writeFileSync(target, "safe");
    chmodSync(target, 0o400);
    symlinkSync(target, link);
    expect(() => protectedPath(link)).toThrow(/symlink/);
    expect(() => boundedProtectedRead(link)).toThrow(/symlink/);
  });

  it("refuses a protected file below a world-writable parent", () => {
    const root = mkdtempSync(join(tmpdir(), "constitutional-parent-"));
    const file = join(root, "pin.pem");
    writeFileSync(file, "not-a-real-pin");
    chmodSync(file, 0o400);
    chmodSync(root, 0o777);
    expect(() => protectedPath(file)).toThrow(/parent is writable/);
  });

  it("rejects a rename/swap when the opened inode is not the validated inode", () => {
    expect(sameOpenedInode({ dev: 1, ino: 10 }, { dev: 1, ino: 10 })).toBe(true);
    expect(sameOpenedInode({ dev: 1, ino: 10 }, { dev: 1, ino: 11 })).toBe(false);
    expect(sameOpenedInode({ dev: 1, ino: 10 }, { dev: 2, ino: 10 })).toBe(false);
  });
});
