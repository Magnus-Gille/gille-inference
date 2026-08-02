import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, initDb } from "../src/db.js";
import {
  mintKey,
  preflightKeyRotation,
  stageKeyRotation,
  type KeyDefaults,
} from "../src/homeserver/keystore.js";
import { createDirectGatewayHarness, type DirectGatewayHarness } from "./helpers/direct-gateway.js";

const DEFAULTS: KeyDefaults = { rpm: 1_000, tpm: 1_000_000, dailyTokenBudget: 0, maxParallel: 2 };

function keyUse(alias: string): { lastUsedAt: string | null; useCount: number } {
  return getDb().prepare(`
    SELECT last_used_at AS lastUsedAt, use_count AS useCount
      FROM api_keys
     WHERE alias = ?
  `).get(alias) as { lastUsedAt: string | null; useCount: number };
}

describe("staged rotation proof routes", () => {
  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "hs-rotation-proof-test-"));
    initDb(join(dir, "test.db"));
    process.env["HOMESERVER_HOST"] = "127.0.0.1";
    process.env["HOMESERVER_PORT"] = "0";
    delete process.env["HOMESERVER_API_KEYS"];
    delete process.env["HOMESERVER_ADMIN_API_KEYS"];
    delete process.env["HOMESERVER_MONITOR_API_KEYS"];
  });

  it("counts only a successful authenticated protected route toward staged replacement preflight", async () => {
    mintKey({ alias: "rotation-proof", tier: "guest" }, DEFAULTS);
    const staged = stageKeyRotation("rotation-proof", {}, DEFAULTS, { overlapSeconds: 3_600 });
    const harness: DirectGatewayHarness = createDirectGatewayHarness();
    const expectNoProof = () => {
      expect(() => preflightKeyRotation(staged.plan.planId))
        .toThrow(/no successful post-stage gateway authentication/i);
      expect(keyUse(staged.newAlias)).toMatchObject({
        lastUsedAt: null,
        useCount: 0,
      });
    };

    const publicRoutes = [
      { path: "/healthz", status: 200 },
      { path: "/hs", status: 200 },
      { path: "/portal/stats", status: 200 },
    ] as const;
    for (const route of publicRoutes) {
      const res = await harness.invoke({
        method: "GET",
        path: route.path,
        token: staged.plaintextKey,
      });
      expect(res.status).toBe(route.status);
      expectNoProof();
    }

    const anonymous = await harness.invoke({
      method: "GET",
      path: "/v1/capabilities/review-lane",
    });
    expect(anonymous.status).toBe(401);
    expectNoProof();

    const forbidden = await harness.invoke({
      method: "GET",
      path: "/ledger",
      token: staged.plaintextKey,
    });
    expect(forbidden.status).toBe(403);
    expectNoProof();

    const allowed = await harness.invoke({
      method: "GET",
      path: "/v1/capabilities/review-lane",
      token: staged.plaintextKey,
    });
    expect(allowed.status).toBe(200);
    expect(keyUse(staged.newAlias).useCount).toBe(1);
    expect(preflightKeyRotation(staged.plan.planId)).toMatchObject({
      replacementAlias: staged.newAlias,
      preflightUseCount: 1,
    });
  });
});
