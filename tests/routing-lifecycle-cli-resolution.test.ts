/**
 * Direct-import unit tests for scripts/routing-lifecycle-cli.ts's gateway-URL and admin-key
 * resolution helpers (issue #38). These are pure/env-driven (no subprocess, no network) so they are
 * exercised here by importing the script module directly — safe because the script only executes
 * its `main()` entrypoint when `import.meta.url` matches `process.argv[1]` (see the file's own
 * bottom guard), which is never true when Vitest imports it.
 *
 * Context: before this change, `adopt`'s reload call always defaulted to `http://127.0.0.1:8080`
 * and only ever read `ROUTING_LIFECYCLE_ADMIN_KEY` — on the real M5 box the gateway binds the
 * tailnet interface, not loopback (issue #23), and the deployed .env had no admin key at all, so a
 * cron/no-flag `adopt` failed closed on both (grimnir#88's first live-adoption dry run). These tests
 * pin the fix: URL resolution prefers the real configured listener over loopback, and the admin key
 * falls back to the documented `HOMESERVER_OWNER_KEY` convention — never anything hardcoded.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  resolveGatewayUrl,
  resolveAdminKey,
  ADMIN_KEY_ENV_VARS,
} from "../scripts/routing-lifecycle-cli.js";

const ENV_KEYS = ["GATEWAY_URL", "ROUTING_LIFECYCLE_ADMIN_KEY", "HOMESERVER_OWNER_KEY"] as const;
const savedEnv: Record<string, string | undefined> = {};

function stashEnv(): void {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
}
function restoreEnv(): void {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
}

describe("resolveGatewayUrl (issue #38)", () => {
  afterEach(restoreEnv);

  it("prefers an explicit --gateway-url flag over everything else", () => {
    stashEnv();
    process.env["GATEWAY_URL"] = "http://env-should-lose:9999";
    const url = resolveGatewayUrl(["--gateway-url", "http://explicit-flag:1234"], {
      gatewayHost: "127.0.0.1",
      gatewayPort: 8080,
    });
    expect(url).toBe("http://explicit-flag:1234");
  });

  it("strips a trailing slash from an explicit --gateway-url", () => {
    const url = resolveGatewayUrl(["--gateway-url", "http://explicit-flag:1234/"], {
      gatewayHost: "127.0.0.1",
      gatewayPort: 8080,
    });
    expect(url).toBe("http://explicit-flag:1234");
  });

  it("prefers the GATEWAY_URL env var over the derived config listener when no flag is given", () => {
    stashEnv();
    process.env["GATEWAY_URL"] = "http://env-override:5555";
    const url = resolveGatewayUrl([], { gatewayHost: "100.64.1.2", gatewayPort: 8080 });
    expect(url).toBe("http://env-override:5555");
  });

  it("derives from the gateway's OWN configured listener (not loopback) when nothing explicit is set — the #38 fix", () => {
    stashEnv();
    delete process.env["GATEWAY_URL"];
    // Mimics the live box: HOMESERVER_HOST set to the tailnet interface, HOMESERVER_PORT default.
    const url = resolveGatewayUrl([], { gatewayHost: "100.76.72.59", gatewayPort: 8080 });
    expect(url).toBe("http://100.76.72.59:8080");
  });

  it("still falls back to the historical loopback default when config itself resolves to loopback (bare local dev, no .env)", () => {
    stashEnv();
    delete process.env["GATEWAY_URL"];
    const url = resolveGatewayUrl([], { gatewayHost: "127.0.0.1", gatewayPort: 8080 });
    expect(url).toBe("http://127.0.0.1:8080");
  });
});

describe("resolveAdminKey (issue #38)", () => {
  afterEach(restoreEnv);

  it("ROUTING_LIFECYCLE_ADMIN_KEY is checked first when set", () => {
    stashEnv();
    process.env["ROUTING_LIFECYCLE_ADMIN_KEY"] = "dedicated-key";
    process.env["HOMESERVER_OWNER_KEY"] = "owner-key";
    expect(resolveAdminKey()).toBe("dedicated-key");
  });

  it("falls back to HOMESERVER_OWNER_KEY — the pre-existing owner-tier bearer-key convention — when ROUTING_LIFECYCLE_ADMIN_KEY is unset", () => {
    stashEnv();
    delete process.env["ROUTING_LIFECYCLE_ADMIN_KEY"];
    process.env["HOMESERVER_OWNER_KEY"] = "owner-key";
    expect(resolveAdminKey()).toBe("owner-key");
  });

  it("treats a blank ROUTING_LIFECYCLE_ADMIN_KEY as unset and falls back", () => {
    stashEnv();
    process.env["ROUTING_LIFECYCLE_ADMIN_KEY"] = "   ";
    process.env["HOMESERVER_OWNER_KEY"] = "owner-key";
    expect(resolveAdminKey()).toBe("owner-key");
  });

  it("returns an empty string when NEITHER var is set — never a fabricated key", () => {
    stashEnv();
    delete process.env["ROUTING_LIFECYCLE_ADMIN_KEY"];
    delete process.env["HOMESERVER_OWNER_KEY"];
    expect(resolveAdminKey()).toBe("");
  });

  it("ADMIN_KEY_ENV_VARS names both candidate env vars, in precedence order", () => {
    expect(ADMIN_KEY_ENV_VARS).toEqual(["ROUTING_LIFECYCLE_ADMIN_KEY", "HOMESERVER_OWNER_KEY"]);
  });
});
