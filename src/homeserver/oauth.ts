import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type Database from "better-sqlite3";
import { getDb } from "../db.js";
import { lookupActiveKeyByAlias, type ApiKeyRecord, type KeyScope } from "./keystore.js";

/**
 * OAuth 2.1 authorization layer for the MCP transport (INFER-518).
 *
 * Purpose: let remote MCP clients that cannot hold a static bearer — chiefly claude.ai custom
 * connectors used by cloud Claude sessions (claude.ai/code, Claude Projects, routines) — reach
 * `POST /mcp` without a secret ever being copied into a third-party container.
 *
 * Authority model (fail-closed):
 *   - Every grant is bound to ONE operator-minted backing key in `api_keys`. The OAuth token is
 *     only a handle; tier, scope, model allow-lists, RPM/TPM/daily budgets and the credit row all
 *     come from that key. Revoking or expiring the backing key ends every token bound to it.
 *   - A backing key must be scope `ask` or `inference`. `admin`, `agent` (code_loop, owner
 *     execution authority) and `monitor` keys can never be bound.
 *   - OAuth access tokens are accepted ONLY on `POST /mcp` (enforced in gateway.ts).
 *   - Consent requires a one-time consent code minted on the box with
 *     `homeserver oauth consent-code --key <alias>`. Dynamic client registration alone grants
 *     nothing, and redirect URIs must match an exact operator allow-list.
 *   - PKCE S256 is mandatory; authorization codes are single-use and short-lived; refresh tokens
 *     rotate on every use, and reuse of a spent refresh token or code revokes the whole grant.
 *   - Only sha256 hashes of codes and tokens are stored; plaintext exists only in transit.
 */

import { type OAuthConfig } from "./oauth-config.js";
export { DEFAULT_OAUTH_REDIRECT_URIS, normalizeIssuer, type OAuthConfig } from "./oauth-config.js";

export const OAUTH_BINDABLE_SCOPES: ReadonlySet<KeyScope> = new Set<KeyScope>(["ask", "inference"]);

const AUTH_CODE_TTL_SECONDS = 120;
const CONSENT_CODE_DEFAULT_TTL_SECONDS = 15 * 60;
const CONSENT_CODE_MAX_TTL_SECONDS = 24 * 60 * 60;
const MAX_ACTIVE_CLIENTS = 200;
/** Registered clients that never obtained a grant are pruned after this long. */
const UNUSED_CLIENT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 16 * 1024;

export const ACCESS_TOKEN_PREFIX = "hs_oat_";
const REFRESH_TOKEN_PREFIX = "hs_ort_";
const AUTH_CODE_PREFIX = "hs_oac_";
const CONSENT_CODE_PREFIX = "hs_ocn_";

export function isOAuthAccessToken(token: string): boolean {
  return token.startsWith(ACCESS_TOKEN_PREFIX);
}

export function mcpResource(cfg: OAuthConfig): string {
  return `${cfg.issuer}/mcp`;
}

export function protectedResourceMetadataUrl(cfg: OAuthConfig): string {
  return `${cfg.issuer}/.well-known/oauth-protected-resource/mcp`;
}

// ─── Schema ───────────────────────────────────────────────────────────────────────

let _oauthInitDb: Database.Database | null = null;

function oauthDb(): Database.Database {
  const db = getDb();
  if (_oauthInitDb === db) return db;
  db.exec(`
    CREATE TABLE IF NOT EXISTS oauth_clients (
      client_id      TEXT PRIMARY KEY,
      client_name    TEXT NOT NULL,
      redirect_uris  TEXT NOT NULL,
      created_at     TEXT NOT NULL,
      revoked_at     TEXT
    );
    CREATE TABLE IF NOT EXISTS oauth_consent_codes (
      code_hash      TEXT PRIMARY KEY,
      label          TEXT NOT NULL,
      key_alias      TEXT NOT NULL,
      created_at     TEXT NOT NULL,
      expires_at     TEXT NOT NULL,
      used_at        TEXT,
      used_grant_id  TEXT
    );
    CREATE TABLE IF NOT EXISTS oauth_grants (
      grant_id       TEXT PRIMARY KEY,
      client_id      TEXT NOT NULL,
      key_alias      TEXT NOT NULL,
      consent_label  TEXT NOT NULL,
      created_at     TEXT NOT NULL,
      last_used_at   TEXT,
      revoked_at     TEXT,
      revoked_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_oauth_grants_key ON oauth_grants(key_alias);
    CREATE TABLE IF NOT EXISTS oauth_codes (
      code_hash      TEXT PRIMARY KEY,
      grant_id       TEXT NOT NULL,
      client_id      TEXT NOT NULL,
      redirect_uri   TEXT NOT NULL,
      code_challenge TEXT NOT NULL,
      expires_at     TEXT NOT NULL,
      used_at        TEXT
    );
    CREATE TABLE IF NOT EXISTS oauth_tokens (
      token_hash     TEXT PRIMARY KEY,
      kind           TEXT NOT NULL CHECK (kind IN ('access','refresh')),
      grant_id       TEXT NOT NULL,
      created_at     TEXT NOT NULL,
      expires_at     TEXT NOT NULL,
      revoked_at     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_oauth_tokens_grant ON oauth_tokens(grant_id);
  `);
  _oauthInitDb = db;
  return db;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function newSecret(prefix: string): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

// ─── Errors ───────────────────────────────────────────────────────────────────────

/** RFC 6749 §5.2 / RFC 7591 §3.2.2 error. `code` is the wire `error` value. */
export class OAuthError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
    this.name = "OAuthError";
  }
}

// ─── Clients (RFC 7591 dynamic registration) ────────────────────────────────────────

export interface OAuthClient {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  createdAt: string;
  revokedAt: string | null;
}

interface ClientRow {
  client_id: string;
  client_name: string;
  redirect_uris: string;
  created_at: string;
  revoked_at: string | null;
}

function rowToClient(row: ClientRow): OAuthClient {
  return {
    clientId: row.client_id,
    clientName: row.client_name,
    redirectUris: JSON.parse(row.redirect_uris) as string[],
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}

export function registerClient(
  body: unknown,
  cfg: OAuthConfig,
  now: Date = new Date()
): OAuthClient {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new OAuthError("invalid_client_metadata", "Registration body must be a JSON object.");
  }
  const meta = body as Record<string, unknown>;
  const redirectUris = meta["redirect_uris"];
  if (!Array.isArray(redirectUris) || redirectUris.length === 0 || redirectUris.length > 5 ||
      redirectUris.some((u) => typeof u !== "string")) {
    throw new OAuthError("invalid_redirect_uri", "redirect_uris must be a non-empty array of strings.");
  }
  const allowed = new Set(cfg.redirectUriAllowList);
  const rejected = (redirectUris as string[]).filter((u) => !allowed.has(u));
  if (rejected.length > 0) {
    throw new OAuthError("invalid_redirect_uri", "One or more redirect_uris are not on this server's allow-list.");
  }
  const authMethod = meta["token_endpoint_auth_method"];
  if (authMethod !== undefined && authMethod !== "none") {
    throw new OAuthError("invalid_client_metadata", "Only public clients (token_endpoint_auth_method=none) are supported.");
  }
  const grantTypes = meta["grant_types"];
  if (grantTypes !== undefined && (!Array.isArray(grantTypes) ||
      grantTypes.some((g) => g !== "authorization_code" && g !== "refresh_token"))) {
    throw new OAuthError("invalid_client_metadata", "Only authorization_code and refresh_token grants are supported.");
  }
  const responseTypes = meta["response_types"];
  if (responseTypes !== undefined && (!Array.isArray(responseTypes) || responseTypes.some((r) => r !== "code"))) {
    throw new OAuthError("invalid_client_metadata", "Only response_type=code is supported.");
  }
  const rawName = typeof meta["client_name"] === "string" ? meta["client_name"] : "unnamed client";
  // Display-only, operator-visible text: strip control characters and bound the length.
  const clientName = rawName.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 100) || "unnamed client";

  const db = oauthDb();
  return db.transaction(() => {
    // Prune clients that registered but never obtained a grant, so unauthenticated registration
    // cannot grow the table without bound.
    db.prepare(
      `DELETE FROM oauth_clients WHERE created_at < ? AND client_id NOT IN (SELECT client_id FROM oauth_grants)`
    ).run(iso(now.getTime() - UNUSED_CLIENT_TTL_MS));
    const active = (db.prepare(`SELECT COUNT(*) AS n FROM oauth_clients WHERE revoked_at IS NULL`).get() as { n: number }).n;
    if (active >= MAX_ACTIVE_CLIENTS) {
      throw new OAuthError("temporarily_unavailable", "Client registration is temporarily unavailable.", 503);
    }
    const client: OAuthClient = {
      clientId: `hsc_${randomUUID()}`,
      clientName,
      redirectUris: redirectUris as string[],
      createdAt: now.toISOString(),
      revokedAt: null,
    };
    db.prepare(
      `INSERT INTO oauth_clients (client_id, client_name, redirect_uris, created_at, revoked_at)
       VALUES (?, ?, ?, ?, NULL)`
    ).run(client.clientId, client.clientName, JSON.stringify(client.redirectUris), client.createdAt);
    return client;
  })();
}

export function getActiveClient(clientId: string): OAuthClient | null {
  const row = oauthDb()
    .prepare(`SELECT * FROM oauth_clients WHERE client_id = ? AND revoked_at IS NULL`)
    .get(clientId) as ClientRow | undefined;
  return row ? rowToClient(row) : null;
}

export function listClients(): OAuthClient[] {
  return (oauthDb().prepare(`SELECT * FROM oauth_clients ORDER BY created_at`).all() as ClientRow[]).map(rowToClient);
}

// ─── Consent codes (operator-minted, one-time) ──────────────────────────────────────

export interface ConsentCodeResult {
  code: string; // plaintext, shown once
  label: string;
  keyAlias: string;
  expiresAt: string;
}

function assertBindableKey(keyAlias: string, now: Date): ApiKeyRecord {
  const rec = lookupActiveKeyByAlias(keyAlias, now);
  if (!rec) throw new OAuthError("invalid_request", `No active key with alias '${keyAlias}'.`);
  if (!OAUTH_BINDABLE_SCOPES.has(rec.scope)) {
    throw new OAuthError(
      "invalid_request",
      `Key '${keyAlias}' has scope '${rec.scope}'; only ask or inference keys may back an OAuth grant.`
    );
  }
  return rec;
}

export function createConsentCode(
  opts: { keyAlias: string; ttlSeconds?: number; label?: string },
  now: Date = new Date()
): ConsentCodeResult {
  const ttl = opts.ttlSeconds ?? CONSENT_CODE_DEFAULT_TTL_SECONDS;
  if (!Number.isInteger(ttl) || ttl <= 0 || ttl > CONSENT_CODE_MAX_TTL_SECONDS) {
    throw new OAuthError("invalid_request", `Consent code TTL must be 1..${CONSENT_CODE_MAX_TTL_SECONDS} seconds.`);
  }
  assertBindableKey(opts.keyAlias, now);
  const code = newSecret(CONSENT_CODE_PREFIX);
  const label = opts.label ?? `consent-${now.toISOString().replace(/[:.]/g, "-")}`;
  const expiresAt = iso(now.getTime() + ttl * 1000);
  oauthDb()
    .prepare(
      `INSERT INTO oauth_consent_codes (code_hash, label, key_alias, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(sha256Hex(code), label, opts.keyAlias, now.toISOString(), expiresAt);
  return { code, label, keyAlias: opts.keyAlias, expiresAt };
}

// ─── Authorization request ─────────────────────────────────────────────────────────

export interface AuthorizationRequest {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string | null;
  client: OAuthClient;
}

/**
 * Validate an authorization request. Errors that make the redirect target untrustworthy
 * (unknown client, unregistered redirect_uri) throw with `redirectable=false`; the caller shows
 * them on the page instead of redirecting (RFC 6749 §4.1.2.1).
 */
export class AuthorizeError extends OAuthError {
  constructor(code: string, message: string, public redirectable: boolean) {
    super(code, message);
    this.name = "AuthorizeError";
  }
}

export function validateAuthorizationRequest(params: URLSearchParams, cfg: OAuthConfig): AuthorizationRequest {
  const clientId = params.get("client_id") ?? "";
  const client = clientId ? getActiveClient(clientId) : null;
  if (!client) throw new AuthorizeError("invalid_client", "Unknown or revoked client_id.", false);
  const redirectUri = params.get("redirect_uri") ?? "";
  if (!client.redirectUris.includes(redirectUri) || !cfg.redirectUriAllowList.includes(redirectUri)) {
    throw new AuthorizeError("invalid_request", "redirect_uri is not registered for this client.", false);
  }
  if (params.get("response_type") !== "code") {
    throw new AuthorizeError("unsupported_response_type", "Only response_type=code is supported.", true);
  }
  const codeChallenge = params.get("code_challenge") ?? "";
  if (params.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) {
    throw new AuthorizeError("invalid_request", "PKCE with code_challenge_method=S256 is required.", true);
  }
  const resource = params.get("resource");
  if (resource !== null && resource.replace(/\/+$/, "") !== mcpResource(cfg)) {
    throw new AuthorizeError("invalid_target", "resource must be this server's MCP endpoint.", true);
  }
  return { clientId, redirectUri, codeChallenge, state: params.get("state"), client };
}

export function errorRedirect(req: AuthorizationRequest, code: string, description: string): string {
  const url = new URL(req.redirectUri);
  url.searchParams.set("error", code);
  url.searchParams.set("error_description", description);
  if (req.state !== null) url.searchParams.set("state", req.state);
  return url.toString();
}

/**
 * Consume a consent code, create a grant bound to the code's backing key, and return the
 * redirect URL carrying a fresh single-use authorization code.
 */
export function approveAuthorization(
  req: AuthorizationRequest,
  consentCode: string,
  now: Date = new Date()
): { redirectUrl: string; grantId: string; keyAlias: string } {
  const db = oauthDb();
  return db.transaction(() => {
    const row = db
      .prepare(`SELECT * FROM oauth_consent_codes WHERE code_hash = ?`)
      .get(sha256Hex(consentCode.trim())) as
      | { code_hash: string; label: string; key_alias: string; expires_at: string; used_at: string | null }
      | undefined;
    if (!row || row.used_at !== null || new Date(row.expires_at).getTime() <= now.getTime()) {
      throw new OAuthError("access_denied", "The consent code is invalid, expired or already used.", 403);
    }
    assertBindableKey(row.key_alias, now);
    const grantId = `hsg_${randomUUID()}`;
    db.prepare(
      `INSERT INTO oauth_grants (grant_id, client_id, key_alias, consent_label, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(grantId, req.clientId, row.key_alias, row.label, now.toISOString());
    db.prepare(`UPDATE oauth_consent_codes SET used_at = ?, used_grant_id = ? WHERE code_hash = ?`)
      .run(now.toISOString(), grantId, row.code_hash);
    const code = newSecret(AUTH_CODE_PREFIX);
    db.prepare(
      `INSERT INTO oauth_codes (code_hash, grant_id, client_id, redirect_uri, code_challenge, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(sha256Hex(code), grantId, req.clientId, req.redirectUri, req.codeChallenge,
      iso(now.getTime() + AUTH_CODE_TTL_SECONDS * 1000));
    const url = new URL(req.redirectUri);
    url.searchParams.set("code", code);
    if (req.state !== null) url.searchParams.set("state", req.state);
    return { redirectUrl: url.toString(), grantId, keyAlias: row.key_alias };
  })();
}

// ─── Grants and tokens ───────────────────────────────────────────────────────────

export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

interface GrantRow {
  grant_id: string;
  client_id: string;
  key_alias: string;
  consent_label: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  revoked_reason: string | null;
}

function revokeGrantTx(db: Database.Database, grantId: string, reason: string, now: Date): boolean {
  const ts = now.toISOString();
  const info = db
    .prepare(`UPDATE oauth_grants SET revoked_at = ?, revoked_reason = ? WHERE grant_id = ? AND revoked_at IS NULL`)
    .run(ts, reason, grantId);
  db.prepare(`UPDATE oauth_tokens SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL`).run(ts, grantId);
  return info.changes > 0;
}

function activeGrant(db: Database.Database, grantId: string, now: Date): GrantRow | null {
  const grant = db
    .prepare(`SELECT * FROM oauth_grants WHERE grant_id = ? AND revoked_at IS NULL`)
    .get(grantId) as GrantRow | undefined;
  if (!grant) return null;
  if (!getActiveClient(grant.client_id)) return null;
  if (!lookupActiveKeyByAlias(grant.key_alias, now)) return null;
  return grant;
}

function issueTokens(db: Database.Database, grantId: string, cfg: OAuthConfig, now: Date): TokenResponse {
  const access = newSecret(ACCESS_TOKEN_PREFIX);
  const refresh = newSecret(REFRESH_TOKEN_PREFIX);
  const insert = db.prepare(
    `INSERT INTO oauth_tokens (token_hash, kind, grant_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`
  );
  insert.run(sha256Hex(access), "access", grantId, now.toISOString(), iso(now.getTime() + cfg.accessTokenTtlSeconds * 1000));
  insert.run(sha256Hex(refresh), "refresh", grantId, now.toISOString(), iso(now.getTime() + cfg.refreshTokenTtlSeconds * 1000));
  return {
    access_token: access,
    token_type: "Bearer",
    expires_in: cfg.accessTokenTtlSeconds,
    refresh_token: refresh,
    scope: "mcp",
  };
}

function pkceMatches(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const computed = Buffer.from(createHash("sha256").update(verifier).digest("base64url"));
  const expected = Buffer.from(challenge);
  return computed.length === expected.length && timingSafeEqual(computed, expected);
}

export function exchangeToken(form: URLSearchParams, cfg: OAuthConfig, now: Date = new Date()): TokenResponse {
  const grantType = form.get("grant_type");
  const clientId = form.get("client_id") ?? "";
  if (form.has("client_secret")) {
    throw new OAuthError("invalid_client", "Public clients must not send a client_secret.", 401);
  }
  if (!clientId || !getActiveClient(clientId)) throw new OAuthError("invalid_client", "Unknown or revoked client.", 401);
  const resource = form.get("resource");
  if (resource !== null && resource.replace(/\/+$/, "") !== mcpResource(cfg)) {
    throw new OAuthError("invalid_target", "resource must be this server's MCP endpoint.");
  }
  const db = oauthDb();

  // Each branch runs in one transaction that RETURNS either tokens or an error. Throwing inside
  // the transaction would roll back the side effects that must persist on failure: consuming a
  // code, and revoking a grant on code replay or refresh-token reuse.
  const settle = (result: TokenResponse | OAuthError): TokenResponse => {
    if (result instanceof OAuthError) throw result;
    return result;
  };

  if (grantType === "authorization_code") {
    const code = form.get("code") ?? "";
    const verifier = form.get("code_verifier") ?? "";
    const redirectUri = form.get("redirect_uri") ?? "";
    return settle(db.transaction((): TokenResponse | OAuthError => {
      const row = db.prepare(`SELECT * FROM oauth_codes WHERE code_hash = ?`).get(sha256Hex(code)) as
        | { code_hash: string; grant_id: string; client_id: string; redirect_uri: string; code_challenge: string;
            expires_at: string; used_at: string | null }
        | undefined;
      if (!row || row.client_id !== clientId) return new OAuthError("invalid_grant", "Invalid authorization code.");
      if (row.used_at !== null) {
        // RFC 6749 §4.1.2: a replayed code revokes everything issued from it.
        revokeGrantTx(db, row.grant_id, "authorization_code_replay", now);
        return new OAuthError("invalid_grant", "Authorization code already used; the grant has been revoked.");
      }
      // Single use: consumed by the first presentation, successful or not.
      db.prepare(`UPDATE oauth_codes SET used_at = ? WHERE code_hash = ?`).run(now.toISOString(), row.code_hash);
      if (new Date(row.expires_at).getTime() <= now.getTime()) return new OAuthError("invalid_grant", "Authorization code expired.");
      if (row.redirect_uri !== redirectUri) return new OAuthError("invalid_grant", "redirect_uri does not match the authorization request.");
      if (!pkceMatches(verifier, row.code_challenge)) return new OAuthError("invalid_grant", "PKCE verification failed.");
      if (!activeGrant(db, row.grant_id, now)) return new OAuthError("invalid_grant", "The grant is no longer active.");
      return issueTokens(db, row.grant_id, cfg, now);
    })());
  }

  if (grantType === "refresh_token") {
    const refresh = form.get("refresh_token") ?? "";
    return settle(db.transaction((): TokenResponse | OAuthError => {
      const row = db.prepare(`SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = 'refresh'`)
        .get(sha256Hex(refresh)) as
        | { token_hash: string; grant_id: string; expires_at: string; revoked_at: string | null }
        | undefined;
      if (!row) return new OAuthError("invalid_grant", "Invalid refresh token.");
      const grant = db.prepare(`SELECT * FROM oauth_grants WHERE grant_id = ?`).get(row.grant_id) as GrantRow | undefined;
      if (!grant || grant.client_id !== clientId) return new OAuthError("invalid_grant", "Invalid refresh token.");
      if (row.revoked_at !== null) {
        // Refresh-token reuse detection (OAuth 2.1 §4.3.1): a spent token presented again means
        // it leaked, so the whole grant dies.
        revokeGrantTx(db, row.grant_id, "refresh_token_reuse", now);
        return new OAuthError("invalid_grant", "Refresh token already used; the grant has been revoked.");
      }
      if (new Date(row.expires_at).getTime() <= now.getTime()) return new OAuthError("invalid_grant", "Refresh token expired.");
      if (!activeGrant(db, row.grant_id, now)) return new OAuthError("invalid_grant", "The grant is no longer active.");
      const ts = now.toISOString();
      db.prepare(`UPDATE oauth_tokens SET revoked_at = ? WHERE token_hash = ?`).run(ts, row.token_hash);
      // Rotation retires the grant's previous access tokens too: at most one live pair per grant.
      db.prepare(`UPDATE oauth_tokens SET revoked_at = ? WHERE grant_id = ? AND kind = 'access' AND revoked_at IS NULL`)
        .run(ts, row.grant_id);
      return issueTokens(db, row.grant_id, cfg, now);
    })());
  }

  throw new OAuthError("unsupported_grant_type", "Only authorization_code and refresh_token are supported.");
}

/**
 * Resolve an OAuth access token to its backing key record, or null. Null covers unknown,
 * expired or revoked tokens, revoked grants and clients, and revoked/expired/unbindable keys.
 */
export function resolveAccessToken(
  token: string,
  now: Date = new Date()
): { grantId: string; key: ApiKeyRecord } | null {
  if (!isOAuthAccessToken(token)) return null;
  const db = oauthDb();
  const row = db
    .prepare(`SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = 'access' AND revoked_at IS NULL`)
    .get(sha256Hex(token)) as { grant_id: string; expires_at: string } | undefined;
  if (!row || new Date(row.expires_at).getTime() <= now.getTime()) return null;
  const grant = activeGrant(db, row.grant_id, now);
  if (!grant) return null;
  const key = lookupActiveKeyByAlias(grant.key_alias, now);
  if (!key || !OAUTH_BINDABLE_SCOPES.has(key.scope)) return null;
  db.prepare(`UPDATE oauth_grants SET last_used_at = ? WHERE grant_id = ?`).run(now.toISOString(), grant.grant_id);
  return { grantId: grant.grant_id, key };
}

/** RFC 7009: revoke the grant behind a presented access or refresh token. Always "succeeds". */
export function revokePresentedToken(token: string, now: Date = new Date()): void {
  const db = oauthDb();
  const row = db.prepare(`SELECT grant_id FROM oauth_tokens WHERE token_hash = ?`).get(sha256Hex(token)) as
    | { grant_id: string }
    | undefined;
  if (row) db.transaction(() => revokeGrantTx(db, row.grant_id, "client_revocation", now))();
}

// ─── Operator surface ────────────────────────────────────────────────────────────

export interface OAuthGrantPublic {
  grantId: string;
  clientId: string;
  clientName: string | null;
  keyAlias: string;
  consentLabel: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
}

export function listGrants(opts: { includeRevoked?: boolean } = {}): OAuthGrantPublic[] {
  const db = oauthDb();
  const rows = db
    .prepare(
      `SELECT g.*, c.client_name FROM oauth_grants g LEFT JOIN oauth_clients c ON c.client_id = g.client_id
       ${opts.includeRevoked ? "" : "WHERE g.revoked_at IS NULL"} ORDER BY g.created_at`
    )
    .all() as Array<GrantRow & { client_name: string | null }>;
  return rows.map((r) => ({
    grantId: r.grant_id,
    clientId: r.client_id,
    clientName: r.client_name,
    keyAlias: r.key_alias,
    consentLabel: r.consent_label,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    revokedAt: r.revoked_at,
    revokedReason: r.revoked_reason,
  }));
}

export function revokeGrant(grantId: string, now: Date = new Date()): boolean {
  const db = oauthDb();
  return db.transaction(() => revokeGrantTx(db, grantId, "operator", now))();
}

/** Revoke a client and every grant it holds. */
export function revokeClient(clientId: string, now: Date = new Date()): { client: boolean; grants: number } {
  const db = oauthDb();
  return db.transaction(() => {
    const info = db.prepare(`UPDATE oauth_clients SET revoked_at = ? WHERE client_id = ? AND revoked_at IS NULL`)
      .run(now.toISOString(), clientId);
    const grants = db.prepare(`SELECT grant_id FROM oauth_grants WHERE client_id = ? AND revoked_at IS NULL`)
      .all(clientId) as Array<{ grant_id: string }>;
    for (const g of grants) revokeGrantTx(db, g.grant_id, "operator_client", now);
    return { client: info.changes > 0, grants: grants.length };
  })();
}

/** Revoke every grant bound to a backing key (the key itself is untouched). */
export function revokeGrantsForKey(keyAlias: string, now: Date = new Date()): number {
  const db = oauthDb();
  return db.transaction(() => {
    const grants = db.prepare(`SELECT grant_id FROM oauth_grants WHERE key_alias = ? AND revoked_at IS NULL`)
      .all(keyAlias) as Array<{ grant_id: string }>;
    for (const g of grants) revokeGrantTx(db, g.grant_id, "operator_key", now);
    return grants.length;
  })();
}

// ─── HTTP surface ────────────────────────────────────────────────────────────────

export const OAUTH_PUBLIC_PATHS: ReadonlySet<string> = new Set([
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
  "/.well-known/oauth-authorization-server",
  "/oauth/register",
  "/oauth/authorize",
  "/oauth/token",
  "/oauth/revoke",
]);

export function protectedResourceMetadata(cfg: OAuthConfig): Record<string, unknown> {
  return {
    resource: mcpResource(cfg),
    authorization_servers: [cfg.issuer],
    bearer_methods_supported: ["header"],
    scopes_supported: ["mcp"],
    resource_name: "Gille Inference M5 (MCP)",
  };
}

export function authorizationServerMetadata(cfg: OAuthConfig): Record<string, unknown> {
  return {
    issuer: cfg.issuer,
    authorization_endpoint: `${cfg.issuer}/oauth/authorize`,
    token_endpoint: `${cfg.issuer}/oauth/token`,
    registration_endpoint: `${cfg.issuer}/oauth/register`,
    revocation_endpoint: `${cfg.issuer}/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["mcp"],
    authorization_response_iss_parameter_supported: true,
  };
}

async function readSmallBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new OAuthError("invalid_request", "Request body too large.", 413);
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function noStore(res: ServerResponse): void {
  res.setHeader("cache-control", "no-store");
  res.setHeader("pragma", "no-cache");
}

function sendOAuthJson(res: ServerResponse, status: number, body: unknown): void {
  noStore(res);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function sendOAuthError(res: ServerResponse, err: OAuthError): void {
  sendOAuthJson(res, err.status, { error: err.code, error_description: err.message });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function sendPage(res: ServerResponse, status: number, cfg: OAuthConfig, body: string): void {
  noStore(res);
  const redirectOrigins = [...new Set(cfg.redirectUriAllowList.map((u) => new URL(u).origin))].join(" ");
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    // The consent form posts to itself and the response redirects to an allow-listed client
    // origin; browsers apply form-action to that redirect, so those origins are listed too.
    "content-security-policy":
      `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${redirectOrigins}; frame-ancestors 'none'; base-uri 'none'`,
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
  res.end(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>Authorize M5 access</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem;color:#1b1b1b;background:#fff}` +
      `code{background:#f2f2f2;padding:.1em .3em;border-radius:3px}input{width:100%;padding:.5rem;font:inherit;box-sizing:border-box}` +
      `button{margin-top:1rem;padding:.5rem 1rem;font:inherit}.muted{color:#555}</style></head><body>${body}</body></html>`
  );
}

function authorizeErrorPage(res: ServerResponse, cfg: OAuthConfig, message: string): void {
  sendPage(res, 400, cfg, `<h1>Authorization failed</h1><p>${escapeHtml(message)}</p>`);
}

function consentForm(req: AuthorizationRequest, params: URLSearchParams, error: string | null): string {
  const hidden = [...params.entries()]
    .filter(([k]) => k !== "consent_code")
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
    .join("");
  const redirectHost = new URL(req.redirectUri).host;
  return (
    `<h1>Authorize M5 access</h1>` +
    `<p><strong>${escapeHtml(req.client.clientName)}</strong> asks to use this gateway's MCP endpoint. ` +
    `After approval you will be sent back to <code>${escapeHtml(redirectHost)}</code>.</p>` +
    `<p class="muted">The access is limited to the key the consent code was minted for: its scope, models, rate limits and credits. ` +
    `Mint a code on the box with <code>homeserver oauth consent-code --key &lt;alias&gt;</code>. It works once and expires.</p>` +
    (error ? `<p role="alert"><strong>${escapeHtml(error)}</strong></p>` : "") +
    `<form method="post" action="/oauth/authorize">${hidden}` +
    `<label for="consent_code">Consent code</label>` +
    `<input id="consent_code" name="consent_code" autocomplete="off" required>` +
    `<button type="submit">Approve</button></form>`
  );
}

export type OAuthLogOutcome = { status: number; outcome: string; errorClass: string | null; route: string };

/**
 * Handle one OAuth/metadata route. Returns null when `path` is not an OAuth route, so the
 * gateway can continue dispatch. Callers must apply the public per-IP throttle first.
 */
export async function handleOAuthRequest(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  url: URL,
  cfg: OAuthConfig,
  onGrant?: (info: { grantId: string; keyAlias: string; clientId: string }) => void
): Promise<OAuthLogOutcome | null> {
  if (!OAUTH_PUBLIC_PATHS.has(path)) return null;
  const route = path;
  const done = (status: number, outcome: string, errorClass: string | null = null): OAuthLogOutcome =>
    ({ status, outcome, errorClass, route });

  if (cfg.enabled !== "on") {
    sendOAuthJson(res, 404, { error: "not_found", error_description: "OAuth is not enabled on this gateway." });
    return done(404, "not_found", "oauth_disabled");
  }

  try {
    if (path.startsWith("/.well-known/")) {
      if (method !== "GET") throw new OAuthError("invalid_request", "Use GET.", 405);
      const body = path === "/.well-known/oauth-authorization-server"
        ? authorizationServerMetadata(cfg)
        : protectedResourceMetadata(cfg);
      res.setHeader("access-control-allow-origin", "*");
      sendOAuthJson(res, 200, body);
      return done(200, "ok");
    }

    if (path === "/oauth/register") {
      if (method !== "POST") throw new OAuthError("invalid_request", "Use POST.", 405);
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readSmallBody(req));
      } catch (err) {
        if (err instanceof OAuthError) throw err;
        throw new OAuthError("invalid_client_metadata", "Registration body must be JSON.");
      }
      const client = registerClient(parsed, cfg);
      sendOAuthJson(res, 201, {
        client_id: client.clientId,
        client_id_issued_at: Math.floor(new Date(client.createdAt).getTime() / 1000),
        client_name: client.clientName,
        redirect_uris: client.redirectUris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      });
      return done(201, "ok");
    }

    if (path === "/oauth/authorize") {
      if (method !== "GET" && method !== "POST") throw new OAuthError("invalid_request", "Use GET or POST.", 405);
      const params = method === "GET" ? url.searchParams : new URLSearchParams(await readSmallBody(req));
      let authz: AuthorizationRequest;
      try {
        authz = validateAuthorizationRequest(params, cfg);
      } catch (err) {
        if (err instanceof AuthorizeError && !err.redirectable) {
          authorizeErrorPage(res, cfg, err.message);
          return done(400, "invalid_request", err.code);
        }
        if (err instanceof AuthorizeError) {
          // Redirectable errors need a validated client + redirect_uri; re-derive them safely.
          const client = getActiveClient(params.get("client_id") ?? "")!;
          const target = errorRedirect(
            { clientId: client.clientId, redirectUri: params.get("redirect_uri")!, codeChallenge: "", state: params.get("state"), client },
            err.code,
            err.message
          );
          noStore(res);
          res.writeHead(302, { location: target });
          res.end();
          return done(302, "invalid_request", err.code);
        }
        throw err;
      }
      if (method === "GET") {
        sendPage(res, 200, cfg, consentForm(authz, params, null));
        return done(200, "ok");
      }
      const consentCode = params.get("consent_code") ?? "";
      try {
        const approved = approveAuthorization(authz, consentCode);
        // RFC 9207: the iss parameter carries this server's issuer identifier.
        const redirect = new URL(approved.redirectUrl);
        redirect.searchParams.set("iss", cfg.issuer);
        onGrant?.({ grantId: approved.grantId, keyAlias: approved.keyAlias, clientId: authz.clientId });
        noStore(res);
        res.writeHead(302, { location: redirect.toString() });
        res.end();
        return done(302, "ok");
      } catch (err) {
        if (err instanceof OAuthError && err.code === "access_denied") {
          sendPage(res, 403, cfg, consentForm(authz, params, err.message));
          return done(403, "forbidden", "access_denied");
        }
        throw err;
      }
    }

    if (path === "/oauth/token") {
      if (method !== "POST") throw new OAuthError("invalid_request", "Use POST.", 405);
      const form = new URLSearchParams(await readSmallBody(req));
      const tokens = exchangeToken(form, cfg);
      sendOAuthJson(res, 200, tokens);
      return done(200, "ok");
    }

    if (path === "/oauth/revoke") {
      if (method !== "POST") throw new OAuthError("invalid_request", "Use POST.", 405);
      const form = new URLSearchParams(await readSmallBody(req));
      const token = form.get("token");
      if (token) revokePresentedToken(token);
      noStore(res);
      res.writeHead(200);
      res.end();
      return done(200, "ok");
    }
  } catch (err) {
    if (err instanceof OAuthError) {
      sendOAuthError(res, err);
      return done(err.status, err.status >= 500 ? "unavailable" : "invalid_request", err.code);
    }
    throw err;
  }
  return null;
}
