import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gatewayRelease, parseArchiveRevision } from "../src/homeserver/gateway-release.js";

describe("gateway release identity", () => {
  it("accepts only a full immutable archive revision", () => {
    expect(parseArchiveRevision("a".repeat(40))).toBe("a".repeat(40));
    for (const value of ["$Format:%H$", "short", "A".repeat(40), "a".repeat(40) + "\n", "private/path"]) {
      expect(parseArchiveRevision(value)).toBeNull();
    }
  });
  it("advertises a closed archive identity and the matching wire contract", () => {
    expect(gatewayRelease.revision === null || /^[a-f0-9]{40}$/.test(gatewayRelease.revision)).toBe(true);
    expect(gatewayRelease.client_version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(gatewayRelease.result_contract).toBe("code-loop-pi-2026-09-05-v9");
  });
  it("git archive embeds its exact accepted revision", () => {
    const dir = mkdtempSync(join(tmpdir(), "release-archive-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      execFileSync("git", ["config", "user.name", "Archive Test"], { cwd: dir });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
      mkdirSync(join(dir, "src", "homeserver"), { recursive: true });
      writeFileSync(join(dir, ".gitattributes"), readFileSync(new URL("../.gitattributes", import.meta.url)));
      writeFileSync(join(dir, "src/homeserver/gateway-release.ts"), readFileSync(new URL("../src/homeserver/gateway-release.ts", import.meta.url)));
      execFileSync("git", ["add", "."], { cwd: dir });
      execFileSync("git", ["commit", "-qm", "fixture"], { cwd: dir });
      const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
      const archive = execFileSync("git", ["archive", "HEAD"], { cwd: dir });
      const source = execFileSync("tar", ["-xOf", "-", "src/homeserver/gateway-release.ts"], { input: archive, encoding: "utf8" });
      expect(source).toContain('const ARCHIVE_REVISION = "' + sha + '"');
      expect(source).not.toContain('$Format:%H$');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

});
