/**
 * Direct-import unit tests for round 5 (Sol xhigh re-review of PR #55, gille-inference#49)
 * additions to scripts/routing-lifecycle-cli.ts: the `rollback` command's brief-retry mutation-lock
 * acquisition (finding 5), and `buildAdoptDeps`'s `deleteTable` wiring (finding 6a — previously
 * unwired in production, so `reconcileAdoptionIntent`'s first-ever-table delete path could never
 * actually complete outside tests). Safe to import directly — see
 * routing-lifecycle-cli-resolution.test.ts's header for why (the script only runs `main()` when
 * invoked as the entrypoint, never on a plain import).
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireMutationLockWithBriefRetry, buildAdoptDeps } from "../scripts/routing-lifecycle-cli.js";
import { acquireMutationLock, MutationLockBusyError } from "../src/homeserver/mutation-lock.js";
import type { HomeserverConfig } from "../src/homeserver/config.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "cli-round5-"));
}

describe("acquireMutationLockWithBriefRetry (round 5 finding 5) — rollback never bypasses the lease", () => {
  it("succeeds immediately when the lease is free", async () => {
    const dataDir = tmp();
    const handle = await acquireMutationLockWithBriefRetry(dataDir);
    expect(handle.token).toBeGreaterThan(0);
    handle.release();
  });

  it("retries briefly, then succeeds once the holder releases mid-retry", async () => {
    const dataDir = tmp();
    const holder = acquireMutationLock(dataDir);
    setTimeout(() => holder.release(), 20);
    const handle = await acquireMutationLockWithBriefRetry(dataDir, { attempts: 5, delayMs: 20 });
    expect(handle.token).toBeGreaterThan(holder.token);
    handle.release();
  });

  it("exhausts its retries and throws MutationLockBusyError — never silently bypasses the lease", async () => {
    const dataDir = tmp();
    const holder = acquireMutationLock(dataDir);
    await expect(acquireMutationLockWithBriefRetry(dataDir, { attempts: 2, delayMs: 5 })).rejects.toThrow(MutationLockBusyError);
    holder.release();
  });
});

describe("buildAdoptDeps deleteTable (round 5 finding 6a) — the first-ever-adoption undo path is wired in production", () => {
  it("deps.deleteTable actually removes the file (previously unwired: restoreWriteOk was always false in production)", () => {
    const dataDir = tmp();
    const tablePath = join(dataDir, "m5-routing.json");
    writeFileSync(tablePath, "{}", "utf8");
    expect(existsSync(tablePath)).toBe(true);

    const config = { gatewayHost: "127.0.0.1", gatewayPort: 8080, policy: {} } as unknown as HomeserverConfig;
    const deps = buildAdoptDeps([], config, tablePath);

    expect(typeof deps.deleteTable).toBe("function");
    deps.deleteTable!(tablePath);
    expect(existsSync(tablePath)).toBe(false);
  });
});
