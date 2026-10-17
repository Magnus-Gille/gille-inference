import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, initDb } from "../src/db.js";
import { createDirectGatewayHarness, type DirectGatewayHarness } from "./helpers/direct-gateway.js";

/**
 * A keyless loopback listener is useful while the operator provisions the first key with the
 * local CLI, but it must never turn an anonymous HTTP request into an owner/admin principal.
 * Exercise the request handler directly so auth and later keystore changes can be tested without
 * opening a local socket.
 */

let harness: DirectGatewayHarness;
let mintKey: typeof import("../src/homeserver/keystore.js")["mintKey"];
let revokeKey: typeof import("../src/homeserver/keystore.js")["revokeKey"];
let createInvite: typeof import("../src/homeserver/keystore.js")["createInvite"];

const DEFAULTS = { rpm: 1000, tpm: 1_000_000, dailyTokenBudget: 0, maxParallel: 2 };

beforeAll(async () => {
  initDb(join(mkdtempSync(join(tmpdir(), "hs-no-implicit-admin-")), "test.db"));

  process.env["HOMESERVER_HOST"] = "127.0.0.1";
  process.env["HOMESERVER_PORT"] = "0";
  process.env["HOMESERVER_EMBEDDING_MEDIA_ENABLED"] = "false";
  process.env["HOMESERVER_CODE_LOOP"] = "off";
  process.env["LMSTUDIO_BASE_URL"] = "http://127.0.0.1:1/v1";
  delete process.env["HOMESERVER_API_KEYS"];
  delete process.env["HOMESERVER_ADMIN_API_KEYS"];
  delete process.env["HOMESERVER_MONITOR_API_KEYS"];

  const keystore = await import("../src/homeserver/keystore.js");
  mintKey = keystore.mintKey;
  revokeKey = keystore.revokeKey;
  createInvite = keystore.createInvite;
  harness = createDirectGatewayHarness();
});

describe("gateway with zero credentials at loopback startup", () => {
  it("retains the non-loopback empty-key startup refusal", async () => {
    const { resetConfig } = await import("../src/homeserver/config.js");
    const { startGateway } = await import("../src/homeserver/gateway.js");
    process.env["HOMESERVER_HOST"] = "0.0.0.0";
    resetConfig();
    await expect(startGateway()).rejects.toThrow(/no API keys/);
    process.env["HOMESERVER_HOST"] = "127.0.0.1";
    resetConfig();
  });

  it("keeps live keyless HTTP protected before and after local mint and revoke", async () => {
    const { resetConfig } = await import("../src/homeserver/config.js");
    const { startGateway } = await import("../src/homeserver/gateway.js");
    process.env["HOMESERVER_HOST"] = "127.0.0.1";
    process.env["HOMESERVER_PORT"] = "0";
    resetConfig();
    const gateway = await startGateway();
    const base = `http://127.0.0.1:${gateway.port}`;

    try {
      const anonymousRead = await fetch(`${base}/admin/keys`, {
        headers: { origin: "https://attacker.example", host: "attacker.example" },
      });
      expect(anonymousRead.status).toBe(401);

      const anonymousMint = await fetch(`${base}/admin/keys`, {
        method: "POST",
        headers: {
          origin: "https://attacker.example",
          host: "attacker.example",
          "content-type": "text/plain;charset=UTF-8",
        },
        body: JSON.stringify({ alias: "browser-live-admin", tier: "owner", scope: "admin" }),
      });
      expect(anonymousMint.status).toBe(401);
      expect(await anonymousMint.text()).not.toContain("plaintextKey");

      const anonymousInference = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "m1", messages: [{ role: "user", content: "hello" }] }),
      });
      expect(anonymousInference.status).toBe(401);

      // This is the same keystore path used by `keys mint`; minting locally while the listener
      // runs must add a credential without changing anonymous requests into authenticated ones.
      const localAdmin = mintKey(
        { alias: "live-local-bootstrap-admin", tier: "owner", scope: "admin" },
        DEFAULTS,
      );
      const authenticatedMint = await fetch(`${base}/admin/keys`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${localAdmin.plaintextKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ alias: "live-minted-over-http", tier: "guest" }),
      });
      expect(authenticatedMint.status).toBe(201);
      expect(authenticatedMint.headers.get("cache-control")).toBe("no-store");
      expect((await fetch(`${base}/admin/keys`)).status).toBe(401);
      expect((await fetch(`${base}/admin/keys`, {
        headers: { authorization: `Bearer ${localAdmin.plaintextKey}` },
      })).status).toBe(200);

      revokeKey(localAdmin.record.alias);
      expect((await fetch(`${base}/admin/keys`)).status).toBe(401);
      expect((await fetch(`${base}/admin/keys`, {
        headers: { authorization: `Bearer ${localAdmin.plaintextKey}` },
      })).status).toBe(401);
    } finally {
      await gateway.stop();
      resetConfig();
    }
  });

  it("does not re-enable anonymous admin after the last key is revoked or expires", async () => {
    const revoked = mintKey({ alias: "last-admin-revoked", tier: "owner", scope: "admin" }, DEFAULTS);
    expect((await harness.invoke({
      method: "GET",
      path: "/admin/keys",
      token: revoked.plaintextKey,
    })).status).toBe(200);
    revokeKey(revoked.record.alias);
    expect((await harness.invoke({ method: "GET", path: "/admin/keys" })).status).toBe(401);
    expect((await harness.invoke({
      method: "GET",
      path: "/admin/keys",
      token: revoked.plaintextKey,
    })).status).toBe(401);

    const expired = mintKey({ alias: "last-admin-expired", tier: "owner", scope: "admin" }, DEFAULTS);
    getDb().prepare("UPDATE api_keys SET expires_at = ? WHERE alias = ?")
      .run(new Date(0).toISOString(), expired.record.alias);
    expect((await harness.invoke({ method: "GET", path: "/admin/keys" })).status).toBe(401);
    expect((await harness.invoke({
      method: "GET",
      path: "/admin/keys",
      token: expired.plaintextKey,
    })).status).toBe(401);
  });

  it("keeps public health, portal, and client routes available while protected routes require a key", async () => {
    expect((await harness.invoke({ method: "GET", path: "/healthz" })).status).toBe(200);
    expect((await harness.invoke({ method: "GET", path: "/portal" })).status).toBe(200);
    expect((await harness.invoke({ method: "GET", path: "/hs" })).status).toBe(200);

    expect((await harness.invoke({ method: "GET", path: "/admin/keys" })).status).toBe(401);
    const inference = await harness.invoke({
      method: "POST",
      path: "/v1/chat/completions",
      headers: { "content-type": "application/json" },
      body: { model: "m1", messages: [{ role: "user", content: "hello" }] },
    });
    expect(inference.status).toBe(401);
  });

  it("rejects browser-shaped requests and does not mint or disclose an admin key", async () => {
    const response = await harness.invoke({
      method: "POST",
      path: "/admin/keys",
      headers: {
        origin: "https://attacker.example",
        host: "attacker.example",
        "content-type": "text/plain;charset=UTF-8",
      },
      body: JSON.stringify({ alias: "browser-admin", tier: "owner", scope: "admin" }),
    });

    expect(response.status).toBe(401);
    expect(response.text).not.toContain("plaintextKey");
    expect(getDb().prepare("SELECT count(*) AS count FROM api_keys WHERE alias = ?").get("browser-admin"))
      .toMatchObject({ count: 0 });
  });

  it("accepts a local CLI-minted scoped key without reopening anonymous access", async () => {
    const admin = mintKey({ alias: "local-bootstrap-admin", tier: "owner", scope: "admin" }, DEFAULTS);

    const anonymous = await harness.invoke({ method: "GET", path: "/admin/keys" });
    expect(anonymous.status).toBe(401);

    const authenticated = await harness.invoke({
      method: "POST",
      path: "/admin/keys",
      token: admin.plaintextKey,
      headers: { "content-type": "application/json" },
      body: { alias: "minted-over-http", tier: "guest" },
    });
    expect(authenticated.status).toBe(201);
    expect(authenticated.headers["cache-control"]).toBe("no-store");
    expect(authenticated.json).toMatchObject({ record: { alias: "minted-over-http" } });

    const agent = mintKey({ alias: "local-bootstrap-agent", tier: "owner", scope: "agent" }, DEFAULTS);
    const agentAdmin = await harness.invoke({
      method: "GET",
      path: "/admin/keys",
      token: agent.plaintextKey,
    });
    expect(agentAdmin.status).toBe(403);
    const agentUserRoute = await harness.invoke({
      method: "GET",
      path: "/v1/capabilities/review-lane",
      token: agent.plaintextKey,
    });
    expect(agentUserRoute.status).toBe(200);

    const invite = createInvite({ label: "no-admin-bootstrap-invite", tier: "owner", creditLimit: 100 });
    const redeemed = await harness.invoke({
      method: "POST",
      path: "/portal/redeem",
      headers: { "content-type": "application/json" },
      body: { code: invite.code },
    });
    expect(redeemed.status).toBe(200);
    expect(redeemed.json).toMatchObject({ alias: expect.stringMatching(/^friend-/) });
    const redeemedKey = (redeemed.json as { key: string }).key;
    expect((await harness.invoke({
      method: "GET",
      path: "/admin/keys",
      token: redeemedKey,
    })).status).toBe(403);
  });

});
