import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../src/db.js";
import type { HomeserverConfig } from "../src/homeserver/config.js";

/**
 * Fix #1 residual (flagged by the push security review): the implicit-admin
 * (no-token) grant must be FROZEN at startup and gated on a loopback bind.
 *
 * The original #1 patch closed the keystore-only bypass but still (a) re-evaluated
 * listKeys() per request and (b) never checked loopback — so a 0.0.0.0/Tunnel bind
 * that started WITH keys (passing the bind-guard) and later had all keys revoked or
 * expire would fail OPEN, handing a no-token request implicit admin.
 */

let isImplicitAdminAllowed: (cfg: HomeserverConfig, loopback: boolean) => boolean;
let mintKey: typeof import("../src/homeserver/keystore.js")["mintKey"];
let revokeKey: typeof import("../src/homeserver/keystore.js")["revokeKey"];

const cfg = (
  apiKeys: string[],
  adminApiKeys: string[],
  monitorApiKeys: string[] = []
): HomeserverConfig =>
  ({ apiKeys, adminApiKeys, monitorApiKeys } as unknown as HomeserverConfig);

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "hs-implicit-admin-"));
  initDb(join(dir, "test.db"));
  ({ isImplicitAdminAllowed } = await import("../src/homeserver/gateway.js"));
  ({ mintKey, revokeKey } = await import("../src/homeserver/keystore.js"));
});

describe("implicit-admin posture — loopback-gated & frozen (Fix #1 residual)", () => {
  it("NON-loopback bind with zero keys must FAIL CLOSED (no implicit admin)", () => {
    expect(isImplicitAdminAllowed(cfg([], []), false)).toBe(false);
  });

  it("loopback bind with zero credentials allows implicit admin (local bootstrap)", () => {
    expect(isImplicitAdminAllowed(cfg([], []), true)).toBe(true);
  });

  it("any env key disables implicit admin, even on loopback", () => {
    expect(isImplicitAdminAllowed(cfg(["user-key"], []), true)).toBe(false);
    expect(isImplicitAdminAllowed(cfg([], ["admin-key"]), true)).toBe(false);
    // A read-only monitor key is still a credential — it must disable implicit admin too.
    expect(isImplicitAdminAllowed(cfg([], [], ["monitor-key"]), true)).toBe(false);
  });

  it("a minted store key disables implicit admin; revoking it re-enables on loopback only", () => {
    const { record } = mintKey(
      { alias: "boot", tier: "owner" },
      { rpm: 1, tpm: 1, dailyTokenBudget: 0, maxParallel: 1 }
    );
    expect(isImplicitAdminAllowed(cfg([], []), true)).toBe(false);
    // Even with the store key gone, a non-loopback bind stays closed.
    revokeKey(record.alias);
    expect(isImplicitAdminAllowed(cfg([], []), false)).toBe(false);
    expect(isImplicitAdminAllowed(cfg([], []), true)).toBe(true);
  });
});
