/**
 * OAuth configuration for the MCP transport (INFER-518). Kept free of DB imports so
 * config.ts can load it; the store and HTTP surface live in oauth.ts.
 */

export interface OAuthConfig {
  /** "on" enables the metadata, registration, authorize and token routes. Default "off". */
  enabled: "on" | "off";
  /** Public https origin of the gateway, e.g. https://inference.example.com (no trailing slash). */
  issuer: string;
  /** Exact redirect URIs a dynamically registered client may use. */
  redirectUriAllowList: string[];
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  /**
   * Per-IP throttle on the public OAuth routes, per `publicWindowMs`. Separate from redeemRpm
   * because connector traffic arrives from a few shared provider egress addresses. 0 disables.
   */
  rpm: number;
}

export const DEFAULT_OAUTH_REDIRECT_URIS: readonly string[] = Object.freeze([
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
]);

/** Validate an issuer origin: https (or http on loopback, for tests), no path, query or fragment. */
export function normalizeIssuer(raw: string): string {
  const value = raw.trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("HOMESERVER_OAUTH_ISSUER must be an absolute https origin");
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("HOMESERVER_OAUTH_ISSUER must use https (http is accepted only on loopback)");
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "" || url.username !== "" || url.password !== "") {
    throw new Error("HOMESERVER_OAUTH_ISSUER must be a bare origin with no path, query, fragment or userinfo");
  }
  return url.origin;
}


/** Parse the OAuth settings from the environment. Throws on an enabled-but-invalid setup. */
export function loadOAuthConfig(env: NodeJS.ProcessEnv): OAuthConfig {
  const enabled = (env["HOMESERVER_OAUTH"] ?? "off") === "on" ? "on" : "off";
  const rawIssuer = (env["HOMESERVER_OAUTH_ISSUER"] ?? "").trim();
  const issuer = enabled === "on" || rawIssuer !== "" ? normalizeIssuer(rawIssuer) : "";
  const rawRedirects = env["HOMESERVER_OAUTH_REDIRECT_URIS"];
  const redirectUriAllowList = rawRedirects !== undefined
    ? rawRedirects.split(",").map((s) => s.trim()).filter((s) => s !== "")
    : [...DEFAULT_OAUTH_REDIRECT_URIS];
  for (const uri of redirectUriAllowList) {
    let parsed: URL;
    try {
      parsed = new URL(uri);
    } catch {
      throw new Error(`HOMESERVER_OAUTH_REDIRECT_URIS: '${uri}' is not an absolute URL`);
    }
    if (parsed.protocol !== "https:" || parsed.hash !== "") {
      throw new Error(`HOMESERVER_OAUTH_REDIRECT_URIS: '${uri}' must be an https URL without a fragment`);
    }
  }
  const num = (name: string, fallback: number, min: number, max: number): number => {
    const raw = env[name];
    const n = raw === undefined || raw.trim() === "" ? fallback : Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer in ${min}..${max}`);
    return n;
  };
  return {
    enabled,
    issuer,
    redirectUriAllowList,
    accessTokenTtlSeconds: num("HOMESERVER_OAUTH_ACCESS_TTL_SECONDS", 3600, 60, 24 * 3600),
    refreshTokenTtlSeconds: num("HOMESERVER_OAUTH_REFRESH_TTL_SECONDS", 30 * 24 * 3600, 3600, 90 * 24 * 3600),
    rpm: num("HOMESERVER_OAUTH_RPM", 120, 0, 100_000),
  };
}
