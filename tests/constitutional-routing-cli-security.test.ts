import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertRecoverySignerReady,
  boundedProtectedRead,
  createWatchdogRecoverySocketClient,
  loadAuthorityConfig,
  protectedPath,
  resolveAuthorityConfigPath,
  sameOpenedInode,
  type UnixJsonTransport,
  verifiedFreshness,
} from "../scripts/constitutional-routing-cli.js";

describe("constitutional CLI protected roots", () => {
  it("refuses authority-config and owner-pin root substitution", () => {
    const fixed = resolveAuthorityConfigPath([], undefined, "/home/service");
    expect(fixed).toBe("/etc/gille-inference/autonomy/authority-config.json");
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

  it("requires the production config root to be owned by root, not merely the service UID", () => {
    const root = mkdtempSync(join(tmpdir(), "constitutional-same-uid-config-"));
    const file = join(root, "authority-config.json");
    writeFileSync(file, "{}");
    chmodSync(file, 0o600);
    expect(() => loadAuthorityConfig(file)).toThrow(/unexpected owner/);
  });

  it("rejects a rename/swap when the opened inode is not the validated inode", () => {
    expect(sameOpenedInode({ dev: 1, ino: 10 }, { dev: 1, ino: 10 })).toBe(true);
    expect(sameOpenedInode({ dev: 1, ino: 10 }, { dev: 1, ino: 11 })).toBe(false);
    expect(sameOpenedInode({ dev: 1, ino: 10 }, { dev: 2, ino: 10 })).toBe(false);
  });

  it("rejects a non-executable or protocol-unready recovery signer before arming", () => {
    expect(() => assertRecoverySignerReady("/etc/hosts", 0)).toThrow();
    expect(() => assertRecoverySignerReady("/usr/bin/true", 0)).toThrow(/readiness/);
  });

  it("expires replayed clock/liveness evidence against independent wall and monotonic time", () => {
    const unsigned = {
      healthy: true,
      observed_at: "2026-07-27T10:00:00Z",
      boot_id: "boot-a",
      monotonic_ns: "100000000000",
    };
    const record = {
      ...unsigned,
      digest: `sha256:${createHash("sha256").update(JSON.stringify(unsigned)).digest("hex")}`,
    };
    expect(() => verifiedFreshness(
      record,
      ["healthy"],
      unsigned,
      Date.parse("2026-07-27T10:14:59Z"),
      "boot-a",
      999_000_000_000n,
    )).not.toThrow();
    expect(() => verifiedFreshness(
      record,
      ["healthy"],
      unsigned,
      Date.parse("2026-07-27T10:15:01Z"),
      "boot-a",
      1_001_000_000_000n,
    )).toThrow(/replayed|stale/);
    expect(() => verifiedFreshness(
      record,
      ["healthy"],
      unsigned,
      Date.parse("2026-07-27T10:01:00Z"),
      "boot-b",
      160_000_000_000n,
    )).toThrow(/cross-boot/);
  });

  it("rejects a malformed route digest returned by the recovery service", () => {
    const transport: UnixJsonTransport = (_socket, endpoint) => {
      if (endpoint !== "/route/digest") throw new Error(`unexpected endpoint ${endpoint}`);
      return { digest: "sha256:not-a-real-digest" };
    };
    const client = createWatchdogRecoverySocketClient("/tmp/not-used.sock", transport);
    expect(() => client.readRouteDigest({
      epoch: 1,
      token: "11111111-1111-4111-8111-111111111111",
    })).toThrow(/invalid route digest/);
  });
});
