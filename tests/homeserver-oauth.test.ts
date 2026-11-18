import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../src/db.js";

/**
 * INFER-518: OAuth 2.1 on POST /mcp so remote MCP clients (claude.ai connectors used by cloud
 * Claude sessions) can reach the M5 without holding a static bearer. Runs the real gateway with
 * HOMESERVER_OAUTH=on and walks the full connector flow plus the fail-closed edges.
 */

const DEFAULTS = { rpm: 1000, tpm: 1_000_000, dailyTokenBudget: 0, maxParallel: 2 };
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

let upstream: Server;
let upstreamPort = 0;
let gatewayPort = 0;
let issuer = "";
let stopGateway: (() => Promise<void>) | null = null;
let keystore: typeof import("../src/homeserver/keystore.js");
let oauth: typeof import("../src/homeserver/oauth.js");
let ownerAdminKey = "";

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "hs-oauth-"));
  initDb(join(dir, "test.db"));
  upstream = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "GET" && req.url === "/running") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ running: [] }));
      return;
    }
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "mellum", object: "model" }] }));
      return;
    }
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "cmpl-1",
        choices: [{ message: { role: "assistant", content: "STUB" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
      }));
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => {
    upstreamPort = (upstream.address() as { port: number }).port;
    resolve();
  }));

  // The issuer is a loopback http origin only because this is a test; production requires https.
  // Its port is irrelevant to routing: the gateway serves the paths regardless of issuer host.
  issuer = "http://127.0.0.1:9";
  process.env["LMSTUDIO_BASE_URL"] = `http://127.0.0.1:${upstreamPort}/v1`;
  process.env["HOMESERVER_HOST"] = "127.0.0.1";
  process.env["HOMESERVER_PORT"] = "0";
  process.env["HOMESERVER_MAX_INFLIGHT"] = "2";
  process.env["HOMESERVER_PER_REQUEST_MAX_TOKENS"] = "256";
  process.env["HOMESERVER_REQUEST_LOG"] = "off";
  process.env["HOMESERVER_OAUTH"] = "on";
  process.env["HOMESERVER_OAUTH_ISSUER"] = issuer;
  delete process.env["HOMESERVER_OAUTH_REDIRECT_URIS"];
  delete process.env["HOMESERVER_API_KEYS"];
  delete process.env["HOMESERVER_ADMIN_API_KEYS"];
  delete process.env["HOMESERVER_MONITOR_API_KEYS"];

  keystore = await import("../src/homeserver/keystore.js");
  oauth = await import("../src/homeserver/oauth.js");
  ownerAdminKey = keystore.mintKey({ alias: "oauth-admin", tier: "owner", scope: "admin" }, DEFAULTS).plaintextKey;
  keystore.mintKey({ alias: "cloud-ask", tier: "owner", scope: "ask", modelAllowList: ["mellum"] }, DEFAULTS);
  keystore.mintKey({ alias: "cloud-agent", tier: "owner", scope: "agent" }, DEFAULTS);
  keystore.mintKey({ alias: "cloud-guest", tier: "guest", scope: "inference" }, DEFAULTS);

  const gw = await import("../src/homeserver/gateway.js");
  const handle = await gw.startGateway();
  gatewayPort = handle.port;
  stopGateway = handle.stop;
});

afterAll(async () => {
  if (stopGateway) await stopGateway();
  await new Promise<void>((r) => upstream.close(() => r()));
  for (const k of ["HOMESERVER_OAUTH", "HOMESERVER_OAUTH_ISSUER", "HOMESERVER_REQUEST_LOG"]) delete process.env[k];
});

const url = (path: string) => `http://127.0.0.1:${gatewayPort}${path}`;

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

async function register(redirectUris: string[] = [REDIRECT]): Promise<Response> {
  return fetch(url("/oauth/register"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Claude", redirect_uris: redirectUris, token_endpoint_auth_method: "none" }),
  });
}

function authorizeParams(clientId: string, challenge: string, extra: Record<string, string> = {}): URLSearchParams {
  return new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "st-123",
    resource: `${issuer}/mcp`,
    ...extra,
  });
}

async function approve(params: URLSearchParams, consentCode: string): Promise<Response> {
  const body = new URLSearchParams(params);
  body.set("consent_code", consentCode);
  return fetch(url("/oauth/authorize"), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    redirect: "manual",
  });
}

async function token(form: Record<string, string>): Promise<Response> {
  return fetch(url("/oauth/token"), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
}

async function mcp(bearer: string | null, method: string, params?: unknown): Promise<Response> {
  return fetch(url("/mcp"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) }),
  });
}

/** Full happy-path connector flow; returns the client and token pair. */
async function connect(keyAlias = "cloud-ask"): Promise<{
  clientId: string; verifier: string; access: string; refresh: string; grantId: string;
}> {
  const reg = await register();
  expect(reg.status).toBe(201);
  const { client_id: clientId } = (await reg.json()) as { client_id: string };
  const { verifier, challenge } = pkce();
  const params = authorizeParams(clientId, challenge);
  const { code: consent } = oauth.createConsentCode({ keyAlias });
  const res = await approve(params, consent);
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get("location")!);
  expect(`${location.origin}${location.pathname}`).toBe(REDIRECT);
  expect(location.searchParams.get("state")).toBe("st-123");
  expect(location.searchParams.get("iss")).toBe(issuer);
  const code = location.searchParams.get("code")!;
  const tok = await token({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT });
  expect(tok.status).toBe(200);
  expect(tok.headers.get("cache-control")).toBe("no-store");
  const body = (await tok.json()) as { access_token: string; refresh_token: string; token_type: string };
  expect(body.token_type).toBe("Bearer");
  const grant = oauth.listGrants().find((g) => g.clientId === clientId)!;
  return { clientId, verifier, access: body.access_token, refresh: body.refresh_token, grantId: grant.grantId };
}

describe("INFER-518 OAuth discovery", () => {
  it("advertises protected-resource and authorization-server metadata", async () => {
    const pr = await fetch(url("/.well-known/oauth-protected-resource/mcp"));
    expect(pr.status).toBe(200);
    expect(await pr.json()).toMatchObject({ resource: `${issuer}/mcp`, authorization_servers: [issuer] });
    const as = await fetch(url("/.well-known/oauth-authorization-server"));
    expect(as.status).toBe(200);
    expect(await as.json()).toMatchObject({
      issuer,
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      registration_endpoint: `${issuer}/oauth/register`,
    });
  });

  it("401 on /mcp without a token points at the resource metadata", async () => {
    const res = await mcp(null, "tools/list");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource/mcp"`
    );
  });

  it("does not add the OAuth challenge to other protected routes", async () => {
    const res = await fetch(url("/v1/models"));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBeNull();
  });
});

describe("INFER-518 OAuth connector flow", () => {
  it("connects end to end and the token reaches MCP with the backing key's authority", async () => {
    const { access } = await connect();
    const res = await mcp(access, "tools/list");
    expect(res.status).toBe(200);
    const names = ((await res.json()) as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name);
    // An ask-scope backing key: list_models + ask, never code_loop.
    expect(names).toContain("list_models");
    expect(names).toContain("ask");
    expect(names.some((n) => n.startsWith("code_loop"))).toBe(false);
    // The original cloud-session question: "is model X live?" answered through list_models.
    const lm = await mcp(access, "tools/call", { name: "list_models", arguments: {} });
    expect(lm.status).toBe(200);
    const lmBody = (await lm.json()) as { result: { content: Array<{ text: string }>; isError?: boolean } };
    expect(lmBody.result.isError ?? false).toBe(false);
    expect(lmBody.result.content.map((c) => c.text).join("\n")).toContain("mellum");
  });

  it("refuses the OAuth token on every route except POST /mcp", async () => {
    const { access } = await connect();
    for (const [method, path] of [["GET", "/v1/models"], ["GET", "/portal/me"], ["GET", "/admin/keys"], ["POST", "/v1/chat/completions"]]) {
      const res = await fetch(url(path!), {
        method,
        headers: { authorization: `Bearer ${access}`, "content-type": "application/json" },
        ...(method === "POST" ? { body: JSON.stringify({ model: "mellum", messages: [{ role: "user", content: "hi" }] }) } : {}),
      });
      expect(res.status, `${method} ${path}`).toBe(403);
    }
  });

  it("shows a consent page that escapes client-controlled text and forbids framing", async () => {
    const reg = await fetch(url("/oauth/register"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "<script>x</script>", redirect_uris: [REDIRECT] }),
    });
    const { client_id: clientId } = (await reg.json()) as { client_id: string };
    const res = await fetch(url(`/oauth/authorize?${authorizeParams(clientId, pkce().challenge).toString()}`));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });

  it("rotates refresh tokens and revokes the grant when a spent refresh token is replayed", async () => {
    const { clientId, access, refresh } = await connect();
    const r1 = await token({ grant_type: "refresh_token", refresh_token: refresh, client_id: clientId });
    expect(r1.status).toBe(200);
    const next = (await r1.json()) as { access_token: string; refresh_token: string };
    expect(next.refresh_token).not.toBe(refresh);
    // The previous access token is retired by rotation; the new one works.
    expect((await mcp(access, "tools/list")).status).toBe(401);
    expect((await mcp(next.access_token, "tools/list")).status).toBe(200);
    // Replay the spent refresh token: the whole grant dies, including the fresh pair.
    const replay = await token({ grant_type: "refresh_token", refresh_token: refresh, client_id: clientId });
    expect(replay.status).toBe(400);
    expect(((await replay.json()) as { error: string }).error).toBe("invalid_grant");
    expect((await mcp(next.access_token, "tools/list")).status).toBe(401);
    const again = await token({ grant_type: "refresh_token", refresh_token: next.refresh_token, client_id: clientId });
    expect(again.status).toBe(400);
  });

  it("revoking or expiring the backing key ends the OAuth token", async () => {
    keystore.mintKey({ alias: "cloud-ephemeral", tier: "owner", scope: "ask" }, DEFAULTS);
    const { access } = await connect("cloud-ephemeral");
    expect((await mcp(access, "tools/list")).status).toBe(200);
    expect(keystore.revokeKey("cloud-ephemeral")).toBe(true);
    expect((await mcp(access, "tools/list")).status).toBe(401);
  });

  it("operator revocation by grant ends the token", async () => {
    const { access, grantId } = await connect();
    expect(oauth.revokeGrant(grantId)).toBe(true);
    expect((await mcp(access, "tools/list")).status).toBe(401);
  });

  it("RFC 7009 revocation by the client ends the grant", async () => {
    const { access, refresh } = await connect();
    const res = await fetch(url("/oauth/revoke"), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: refresh }).toString(),
    });
    expect(res.status).toBe(200);
    expect((await mcp(access, "tools/list")).status).toBe(401);
  });
});

describe("INFER-518 OAuth fail-closed edges", () => {
  it("rejects registration with a redirect URI outside the allow-list", async () => {
    const res = await register(["https://evil.example/callback"]);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_redirect_uri");
  });

  it("refuses to bind agent, admin or monitor keys, and accepts guest inference keys", () => {
    expect(() => oauth.createConsentCode({ keyAlias: "cloud-agent" })).toThrow(/only ask or inference/);
    expect(() => oauth.createConsentCode({ keyAlias: "oauth-admin" })).toThrow(/only ask or inference/);
    expect(() => oauth.createConsentCode({ keyAlias: "no-such-key" })).toThrow(/No active key/);
    expect(oauth.createConsentCode({ keyAlias: "cloud-guest" }).code).toMatch(/^hs_ocn_/);
  });

  it("does not redirect for an unregistered redirect_uri", async () => {
    const reg = await register();
    const { client_id: clientId } = (await reg.json()) as { client_id: string };
    const params = authorizeParams(clientId, pkce().challenge, { redirect_uri: "https://claude.com/api/mcp/auth_callback" });
    const res = await fetch(url(`/oauth/authorize?${params.toString()}`), { redirect: "manual" });
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });

  it("requires PKCE S256", async () => {
    const reg = await register();
    const { client_id: clientId } = (await reg.json()) as { client_id: string };
    const params = authorizeParams(clientId, pkce().challenge, { code_challenge_method: "plain" });
    const res = await fetch(url(`/oauth/authorize?${params.toString()}`), { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location")!).searchParams.get("error")).toBe("invalid_request");
  });

  it("rejects a wrong, reused or expired consent code without creating a grant", async () => {
    const reg = await register();
    const { client_id: clientId } = (await reg.json()) as { client_id: string };
    const params = authorizeParams(clientId, pkce().challenge);
    expect((await approve(params, "hs_ocn_wrong")).status).toBe(403);
    const { code } = oauth.createConsentCode({ keyAlias: "cloud-ask" });
    expect((await approve(params, code)).status).toBe(302);
    expect((await approve(params, code)).status).toBe(403);
    const past = new Date(Date.now() - 60 * 60 * 1000);
    const expired = oauth.createConsentCode({ keyAlias: "cloud-ask", ttlSeconds: 60 }, past);
    expect((await approve(params, expired.code)).status).toBe(403);
    expect(oauth.listGrants().filter((g) => g.clientId === clientId)).toHaveLength(1);
  });

  it("rejects a wrong PKCE verifier and revokes the grant on code replay", async () => {
    const reg = await register();
    const { client_id: clientId } = (await reg.json()) as { client_id: string };
    const { verifier, challenge } = pkce();
    const params = authorizeParams(clientId, challenge);
    const res = await approve(params, oauth.createConsentCode({ keyAlias: "cloud-ask" }).code);
    const code = new URL(res.headers.get("location")!).searchParams.get("code")!;
    const bad = await token({ grant_type: "authorization_code", code, code_verifier: pkce().verifier, client_id: clientId, redirect_uri: REDIRECT });
    expect(bad.status).toBe(400);
    // The code was consumed by the failed attempt; presenting it again revokes the grant.
    const replay = await token({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT });
    expect(replay.status).toBe(400);
    const grant = oauth.listGrants({ includeRevoked: true }).find((g) => g.clientId === clientId)!;
    expect(grant.revokedReason).toBe("authorization_code_replay");
  });

  it("an unknown hs_oat_ token never falls through to static or keystore auth", async () => {
    expect((await mcp("hs_oat_not-a-real-token", "tools/list")).status).toBe(401);
  });

  it("existing bearer keys keep working on every route", async () => {
    const res = await fetch(url("/admin/keys"), { headers: { authorization: `Bearer ${ownerAdminKey}` } });
    expect(res.status).toBe(200);
  });
});

describe("INFER-518 OAuth config", () => {
  it("requires an https issuer when enabled", async () => {
    const { loadOAuthConfig } = await import("../src/homeserver/oauth-config.js");
    expect(() => loadOAuthConfig({ HOMESERVER_OAUTH: "on" })).toThrow(/ISSUER/);
    expect(() => loadOAuthConfig({ HOMESERVER_OAUTH: "on", HOMESERVER_OAUTH_ISSUER: "http://inference.example.com" })).toThrow(/https/);
    expect(() => loadOAuthConfig({ HOMESERVER_OAUTH: "on", HOMESERVER_OAUTH_ISSUER: "https://inference.example.com/mcp" })).toThrow(/bare origin/);
    expect(loadOAuthConfig({}).enabled).toBe("off");
    const ok = loadOAuthConfig({ HOMESERVER_OAUTH: "on", HOMESERVER_OAUTH_ISSUER: "https://inference.example.com/" });
    expect(ok.issuer).toBe("https://inference.example.com");
    expect(ok.redirectUriAllowList).toEqual(["https://claude.ai/api/mcp/auth_callback", "https://claude.com/api/mcp/auth_callback"]);
  });
});
