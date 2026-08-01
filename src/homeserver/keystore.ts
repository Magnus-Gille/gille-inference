import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";
import { getDb } from "../db.js";

/**
 * Per-key auth store.
 *
 * The legacy static HOMESERVER_API_KEYS / HOMESERVER_ADMIN_API_KEYS remain a fallback,
 * but this is the primary path: each key is a row carrying its tier, per-key quota,
 * model allow-list, and lifecycle (expiry / soft-revoke). Plaintext is returned ONCE at
 * mint time and never persisted — only sha256(plaintext) is stored. Lookup is timing-safe
 * (constant-time scan over active hashes, mirroring gateway.ts:keyMatches) so the auth
 * decision does not leak "this hash exists" through index timing.
 */

export type Tier = "owner" | "guest";
/**
 * Route authority carried by a key, independent of its privacy/admission tier.
 *
 * - admin: operator routes plus agent/inference surfaces
 * - agent: bounded agent/inference surfaces, never operator routes
 * - inference: ordinary inference surfaces only
 *
 * Existing rows predate this column. A null stored scope is interpreted as the
 * legacy-compatible default for its tier (owner→admin, guest→inference).
 */
export type KeyScope = "admin" | "agent" | "inference" | "monitor";

/**
 * Maximum lifetime for newly minted credentials. Existing rows with no expiry remain readable so
 * operators can inventory and migrate them, but every newly created key is bounded by default.
 */
export const MAX_KEY_LIFETIME_SECONDS: Readonly<Record<KeyScope, number>> = Object.freeze({
  admin: 30 * 24 * 60 * 60,
  agent: 90 * 24 * 60 * 60,
  inference: 365 * 24 * 60 * 60,
  monitor: 365 * 24 * 60 * 60,
});

export interface ApiKeyRecord {
  alias: string;
  keyHash: string;
  tier: Tier;
  scope: KeyScope;
  modelAllowList: string[]; // [] = all models allowed
  rpm: number;
  tpm: number;
  dailyTokenBudget: number; // 0 = unlimited
  maxParallel: number;
  /** Lifetime, non-resetting total-token credit cap. 0 = unlimited. */
  creditLimit: number;
  /** Cumulative tokens consumed against creditLimit (never resets). */
  creditsUsed: number;
  expiresAt: string | null; // ISO; null = never
  createdAt: string; // ISO
  revokedAt: string | null; // ISO; non-null = soft-revoked
  /** #99: logical name grouping a key with its rotations. null = never produced by `rotate`. */
  logicalAlias: string | null;
  /** Successful authenticated use, populated by the gateway. null means never observed. */
  lastUsedAt: string | null;
  /** Successful authenticated uses observed by the gateway. */
  useCount: number;
}

/** Public shape returned by listKeys / GET /admin/keys — keyHash REMOVED. */
export type ApiKeyPublic = Omit<ApiKeyRecord, "keyHash">;

export interface KeyDefaults {
  rpm: number;
  tpm: number;
  dailyTokenBudget: number;
  maxParallel: number;
}

export interface MintOptions {
  alias: string;
  tier: Tier;
  scope?: KeyScope;
  modelAllowList?: string[];
  rpm?: number;
  tpm?: number;
  dailyTokenBudget?: number;
  maxParallel?: number;
  creditLimit?: number; // 0 = unlimited
  ttlSeconds?: number; // → expiresAt = now + ttl
  /** #99: set by rotateKey to group a rotated key with its logical name. Omit for a plain mint. */
  logicalAlias?: string;
}

export interface MintResult {
  plaintextKey: string; // returned ONCE, never persisted
  record: ApiKeyPublic;
}

/** Thrown by mintKey when the alias (or, improbably, the key hash) already exists. */
export class KeyAliasExistsError extends Error {
  constructor(public alias: string) {
    super(`a key with alias '${alias}' already exists`);
    this.name = "KeyAliasExistsError";
  }
}

/**
 * Thrown by redeemInvite when a code is unknown OR already redeemed. The message is
 * deliberately UNIFORM across both cases so the redeem endpoint is not a user-enumeration
 * oracle (a caller cannot tell "no such code" from "already used").
 */
export class InviteInvalidError extends Error {
  constructor() {
    super("this invite code is invalid or has already been used");
    this.name = "InviteInvalidError";
  }
}

/**
 * Thrown when a numeric mint/invite parameter is not a non-negative integer. Catches the
 * "-1 ⇒ unlimited" foot-gun (a negative creditLimit would otherwise read as "never exhausted")
 * and fractional values that SQLite would silently store as-is. The gateway maps it to an
 * enveloped invalid_request_error.
 */
export class InvalidParamError extends Error {
  constructor(public param: string, public value: unknown) {
    super(`'${param}' must be a non-negative integer (got ${String(value)})`);
    this.name = "InvalidParamError";
  }
}

/** Thrown when a requested route scope is incompatible with the key's trust tier. */
export class InvalidScopeError extends Error {
  constructor(public tier: Tier, public scope: KeyScope) {
    super(
      `tier '${tier}' cannot carry '${scope}' scope`
      + (tier === "guest" ? "; use scope 'inference' or 'monitor' for guest keys" : "")
    );
    this.name = "InvalidScopeError";
  }
}

/** Thrown before persistence when a requested TTL exceeds the scope's maximum lifetime. */
export class KeyLifetimePolicyError extends Error {
  constructor(public scope: KeyScope, public ttlSeconds: number, public maximumSeconds: number) {
    super(
      `requested lifetime ${ttlSeconds}s exceeds the maximum ${maximumSeconds}s for '${scope}' scope`
    );
    this.name = "KeyLifetimePolicyError";
  }
}

/** Least-privilege default for NEW keys. Owner does not imply administrative route authority. */
export function defaultScopeForTier(tier: Tier): KeyScope {
  return tier === "owner" ? "agent" : "inference";
}

/** Preserve authority only when reading rows minted before explicit route scopes existed. */
function legacyScopeForTier(tier: Tier): KeyScope {
  return tier === "owner" ? "admin" : "inference";
}

function storedScope(tier: Tier, value: string | null): KeyScope {
  if (value === null) return legacyScopeForTier(tier);
  if (value === "inference" || value === "monitor") return value;
  if (tier === "owner" && (value === "admin" || value === "agent")) return value;
  // A malformed or tier-incompatible stored value must not expand authority.
  return "inference";
}

/**
 * Validate an optional non-negative integer parameter. `undefined` passes (caller applies a
 * default); anything present must be a finite, non-negative, whole number. Throws
 * InvalidParamError otherwise — the single guard for every minted/invited numeric limit.
 */
function assertNonNegativeInt(param: string, value: number | undefined): void {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new InvalidParamError(param, value);
  }
}

// ─── Schema (additive; coexists with runs / delegations in the shared DB) ─────────

// Tracks the EXACT connection whose schema was ensured. A bare boolean would wrongly skip
// DDL after initDb() swaps in a fresh connection (e.g. a test re-pointing the DB) — the new
// connection would then have no api_keys table. Keying on the instance re-runs the idempotent
// DDL on each distinct connection. (Codex/self-review #99.)
let _ksInitDb: Database.Database | null = null;

function ensureSchema(db: Database.Database): void {
  if (_ksInitDb === db) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      alias              TEXT PRIMARY KEY,
      key_hash           TEXT NOT NULL UNIQUE,
      tier               TEXT NOT NULL,
      scope              TEXT,
      model_allow_list   TEXT NOT NULL DEFAULT '[]',
      rpm                INTEGER NOT NULL,
      tpm                INTEGER NOT NULL,
      daily_token_budget INTEGER NOT NULL DEFAULT 0,
      max_parallel       INTEGER NOT NULL DEFAULT 1,
      credit_limit       INTEGER NOT NULL DEFAULT 0,
      credits_used       INTEGER NOT NULL DEFAULT 0,
      expires_at         TEXT,
      created_at         TEXT NOT NULL,
      revoked_at         TEXT,
      logical_alias      TEXT,
      last_used_at       TEXT,
      use_count          INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);

    CREATE TABLE IF NOT EXISTS invites (
      label              TEXT PRIMARY KEY,
      code_hash          TEXT NOT NULL UNIQUE,
      tier               TEXT NOT NULL,
      credit_limit       INTEGER NOT NULL DEFAULT 0,
      model_allow_list   TEXT NOT NULL DEFAULT '[]',
      alias_prefix       TEXT NOT NULL DEFAULT 'friend',
      created_at         TEXT NOT NULL,
      redeemed_at        TEXT,
      redeemed_key_alias TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_invites_code ON invites(code_hash);
  `);

  // Additive, idempotent migrations. SQLite has transactional DDL, so wrap them in one
  // transaction: an interrupted upgrade can never leave a half-added set of columns (the
  // PRAGMA guard would recover on restart anyway, but atomic is cleaner). Each ALTER is still
  // guarded by the table_info check so re-running on a migrated DB is a no-op.
  const cols = db.prepare(`PRAGMA table_info(api_keys)`).all() as Array<{ name: string }>;
  const names = new Set(cols.map((c) => c.name));
  db.transaction(() => {
    if (!names.has("credit_limit")) {
      db.exec(`ALTER TABLE api_keys ADD COLUMN credit_limit INTEGER NOT NULL DEFAULT 0`);
    }
    if (!names.has("credits_used")) {
      db.exec(`ALTER TABLE api_keys ADD COLUMN credits_used INTEGER NOT NULL DEFAULT 0`);
    }
    // #99: logical_alias groups a key with its rotations. NULL = a key never produced by `rotate`
    // (legacy / first-mint). Additive and nullable, so existing rows need no backfill.
    if (!names.has("logical_alias")) {
      db.exec(`ALTER TABLE api_keys ADD COLUMN logical_alias TEXT`);
    }
    if (!names.has("scope")) {
      db.exec(`ALTER TABLE api_keys ADD COLUMN scope TEXT`);
    }
    if (!names.has("last_used_at")) {
      db.exec(`ALTER TABLE api_keys ADD COLUMN last_used_at TEXT`);
    }
    if (!names.has("use_count")) {
      db.exec(`ALTER TABLE api_keys ADD COLUMN use_count INTEGER NOT NULL DEFAULT 0`);
    }
    // The index backs rotateKey's family lookup (no full scan under the write lock). Created
    // UNCONDITIONALLY (IF NOT EXISTS) — NOT only alongside the column-add — so a DB that already
    // has the column but is missing the index (partial/manual migration) still gets it. (Codex #99.)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_api_keys_logical_alias ON api_keys(logical_alias)`);
    db.exec(`
      CREATE TABLE IF NOT EXISTS key_rotation_plans (
        plan_id             TEXT PRIMARY KEY,
        logical_alias       TEXT NOT NULL,
        replacement_alias   TEXT NOT NULL,
        previous_aliases    TEXT NOT NULL,
        staged_at           TEXT NOT NULL,
        overlap_expires_at  TEXT NOT NULL,
        status              TEXT NOT NULL CHECK (status IN ('staged','committed','aborted')),
        baseline_use_count  INTEGER NOT NULL DEFAULT 0,
        preflight_at        TEXT,
        preflight_use_count INTEGER,
        preflight_last_used_at TEXT,
        completed_at        TEXT,
        FOREIGN KEY(replacement_alias) REFERENCES api_keys(alias)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_key_rotation_one_staged
        ON key_rotation_plans(logical_alias) WHERE status = 'staged';
    `);
    const rotationCols = db.prepare(`PRAGMA table_info(key_rotation_plans)`).all() as Array<{ name: string }>;
    if (!rotationCols.some((column) => column.name === "preflight_at")) {
      db.exec(`ALTER TABLE key_rotation_plans ADD COLUMN preflight_at TEXT`);
    }
    if (!rotationCols.some((column) => column.name === "baseline_use_count")) {
      db.exec(`ALTER TABLE key_rotation_plans ADD COLUMN baseline_use_count INTEGER NOT NULL DEFAULT 0`);
    }
    if (!rotationCols.some((column) => column.name === "preflight_use_count")) {
      db.exec(`ALTER TABLE key_rotation_plans ADD COLUMN preflight_use_count INTEGER`);
    }
    if (!rotationCols.some((column) => column.name === "preflight_last_used_at")) {
      db.exec(`ALTER TABLE key_rotation_plans ADD COLUMN preflight_last_used_at TEXT`);
    }
  })();

  _ksInitDb = db;
}

function ksDb(): Database.Database {
  const db = getDb();
  ensureSchema(db);
  return db;
}

// ─── Row mapping ──────────────────────────────────────────────────────────────────

interface KeyRow {
  alias: string;
  key_hash: string;
  tier: string;
  scope: string | null;
  model_allow_list: string;
  rpm: number;
  tpm: number;
  daily_token_budget: number;
  max_parallel: number;
  credit_limit: number;
  credits_used: number;
  expires_at: string | null;
  created_at: string;
  revoked_at: string | null;
  logical_alias: string | null;
  last_used_at: string | null;
  use_count: number;
}

function rowToRecord(r: KeyRow): ApiKeyRecord {
  const tier = r.tier as Tier;
  return {
    alias: r.alias,
    keyHash: r.key_hash,
    tier,
    scope: storedScope(tier, r.scope),
    modelAllowList: JSON.parse(r.model_allow_list) as string[],
    rpm: r.rpm,
    tpm: r.tpm,
    dailyTokenBudget: r.daily_token_budget,
    maxParallel: r.max_parallel,
    creditLimit: r.credit_limit,
    creditsUsed: r.credits_used,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
    revokedAt: r.revoked_at,
    logicalAlias: r.logical_alias,
    lastUsedAt: r.last_used_at,
    useCount: r.use_count,
  };
}

function toPublic(rec: ApiKeyRecord): ApiKeyPublic {
  // Strip keyHash explicitly so it can never leak through the public surface.
  const { keyHash: _omit, ...pub } = rec;
  void _omit;
  return pub;
}

// ─── Hashing ──────────────────────────────────────────────────────────────────────

/** sha256-hex of a plaintext token — the single source of truth for hashing. */
export function hashKey(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

// ─── Mint ─────────────────────────────────────────────────────────────────────────

export function mintKey(opts: MintOptions, defaults: KeyDefaults): MintResult {
  return mintKeyAt(opts, defaults, new Date());
}

/** Internal clock-injected mint used to keep staged plan and replacement timestamps coherent. */
function mintKeyAt(opts: MintOptions, defaults: KeyDefaults, now: Date): MintResult {
  // Reject non-integer / negative numeric limits BEFORE touching the DB. A negative
  // creditLimit is the dangerous case (it would read as "unlimited" in isCreditExhausted).
  assertNonNegativeInt("creditLimit", opts.creditLimit);
  assertNonNegativeInt("rpm", opts.rpm);
  assertNonNegativeInt("tpm", opts.tpm);
  assertNonNegativeInt("dailyTokenBudget", opts.dailyTokenBudget);
  assertNonNegativeInt("maxParallel", opts.maxParallel);
  assertNonNegativeInt("ttlSeconds", opts.ttlSeconds);
  const scope = opts.scope ?? defaultScopeForTier(opts.tier);
  if (opts.tier === "guest" && scope !== "inference" && scope !== "monitor") {
    throw new InvalidScopeError(opts.tier, scope);
  }
  const ttlSeconds = opts.ttlSeconds ?? MAX_KEY_LIFETIME_SECONDS[scope];
  const maximumSeconds = MAX_KEY_LIFETIME_SECONDS[scope];
  if (ttlSeconds > maximumSeconds) {
    throw new KeyLifetimePolicyError(scope, ttlSeconds, maximumSeconds);
  }

  const db = ksDb();
  const plaintextKey = `hs_${opts.tier}_${randomBytes(32).toString("base64url")}`;
  const keyHash = hashKey(plaintextKey);
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();

  const record: ApiKeyRecord = {
    alias: opts.alias,
    keyHash,
    tier: opts.tier,
    scope,
    modelAllowList: opts.modelAllowList ?? [],
    rpm: opts.rpm ?? defaults.rpm,
    tpm: opts.tpm ?? defaults.tpm,
    dailyTokenBudget: opts.dailyTokenBudget ?? defaults.dailyTokenBudget,
    maxParallel: opts.maxParallel ?? defaults.maxParallel,
    creditLimit: opts.creditLimit ?? 0,
    creditsUsed: 0,
    expiresAt,
    createdAt,
    revokedAt: null,
    logicalAlias: opts.logicalAlias ?? null,
    lastUsedAt: null,
    useCount: 0,
  };

  try {
    db.prepare(
      `INSERT INTO api_keys
         (alias, key_hash, tier, scope, model_allow_list, rpm, tpm, daily_token_budget,
          max_parallel, credit_limit, credits_used, expires_at, created_at, revoked_at, logical_alias,
          last_used_at, use_count)
       VALUES
         (@alias, @keyHash, @tier, @scope, @modelAllowList, @rpm, @tpm, @dailyTokenBudget,
          @maxParallel, @creditLimit, @creditsUsed, @expiresAt, @createdAt, @revokedAt, @logicalAlias,
          @lastUsedAt, @useCount)`
    ).run({
      alias: record.alias,
      keyHash: record.keyHash,
      tier: record.tier,
      scope: record.scope,
      modelAllowList: JSON.stringify(record.modelAllowList),
      rpm: record.rpm,
      tpm: record.tpm,
      dailyTokenBudget: record.dailyTokenBudget,
      maxParallel: record.maxParallel,
      creditLimit: record.creditLimit,
      creditsUsed: record.creditsUsed,
      expiresAt: record.expiresAt,
      createdAt: record.createdAt,
      revokedAt: record.revokedAt,
      logicalAlias: record.logicalAlias,
      lastUsedAt: record.lastUsedAt,
      useCount: record.useCount,
    });
  } catch (err) {
    // Translate ONLY the known UNIQUE-constraint collision into a typed, clean error so the
    // gateway can return a 409 without leaking the raw SQLite string. Anything else rethrows.
    const code = (err as { code?: string }).code;
    if (code === "SQLITE_CONSTRAINT_UNIQUE" || code === "SQLITE_CONSTRAINT_PRIMARYKEY") {
      throw new KeyAliasExistsError(record.alias);
    }
    throw err;
  }

  return { plaintextKey, record: toPublic(record) };
}

// ─── Lookup (timing-safe) ──────────────────────────────────────────────────────────

/**
 * Timing-safe lookup. Hashes the token once, then iterates ALL active rows doing a
 * constant-time compare against each stored hash, OR-ing matches without early return,
 * so the auth decision does not leak which hash matched (or whether one exists) through
 * timing. The hash index is reserved for admin CRUD, not this decision.
 */
export function lookupKey(plaintext: string, now: Date = new Date()): ApiKeyRecord | null {
  const db = ksDb();
  const ph = Buffer.from(hashKey(plaintext), "hex");
  const rows = db
    .prepare(`SELECT * FROM api_keys WHERE revoked_at IS NULL`)
    .all() as KeyRow[];

  let match: KeyRow | null = null;
  let found = false;
  for (const r of rows) {
    const rh = Buffer.from(r.key_hash, "hex");
    // timingSafeEqual requires equal-length buffers; sha256 hex is always 32 bytes.
    const eq = rh.length === ph.length && timingSafeEqual(rh, ph);
    if (eq) {
      found = true;
      match = r;
    }
  }
  if (!found || !match) return null;

  const rec = rowToRecord(match);
  if (rec.expiresAt !== null && new Date(rec.expiresAt).getTime() <= now.getTime()) {
    return null;
  }
  return rec;
}

// ─── Revoke ──────────────────────────────────────────────────────────────────────

/** Soft-revoke: set revoked_at = now. Returns false if alias unknown or already revoked. */
export function revokeKey(alias: string, now: Date = new Date()): boolean {
  const db = ksDb();
  const info = db
    .prepare(`UPDATE api_keys SET revoked_at = @ts WHERE alias = @alias AND revoked_at IS NULL`)
    .run({ alias, ts: now.toISOString() });
  return info.changes > 0;
}

// ─── Rotate (#99) ───────────────────────────────────────────────────────────────────

export interface RotateResult extends MintResult {
  /** Alias the new key was actually minted under (a collision-free member of the family). */
  newAlias: string;
  /** Prior active aliases in the family that this rotation revoked. */
  revokedAliases: string[];
}

/**
 * Find a collision-free alias for a rotated key (#99). Pure and overflow-proof: returns the
 * bare `<logical>` if free, else the lowest `<logical>-r<N>` (N≥2) not already present in ANY
 * state — the alias column is the table PRIMARY KEY, so a revoked row keeps occupying its name.
 * Scans incrementally (no numeric suffix parsing), so a crafted huge pre-existing suffix can
 * never push the index to Number.MAX_SAFE_INTEGER / Infinity.
 */
export function nextFreeAlias(
  logicalAlias: string,
  existingAliases: ReadonlySet<string> | readonly string[]
): string {
  const set = existingAliases instanceof Set ? existingAliases : new Set(existingAliases);
  if (!set.has(logicalAlias)) return logicalAlias;
  let n = 2;
  while (set.has(`${logicalAlias}-r${n}`)) n++;
  return `${logicalAlias}-r${n}`;
}

/**
 * Rotate the key behind a logical name (#99). Atomically (one transaction): revoke the active
 * key(s) for the name and mint a fresh one under a collision-free alias. This removes the
 * same-alias rotation footgun — `revoke A` + `mint A` used to fail on the second step (alias is
 * the PRIMARY KEY, so the revoked row still owns the name), and a naive `mint | grep` pipeline
 * would then clobber the Keychain with an empty value.
 *
 * The rotation family is COLUMN-DEFINED, not name-pattern-defined: a row belongs to logical name
 * `A` iff `logical_alias = A`, plus a legacy/never-rotated key whose bare `alias = A` (which
 * carries `logical_alias = NULL`). So an unrelated standalone key that merely *looks* like a
 * rotation (e.g. someone minted `A-r2` directly) is NEVER swept into A's family.
 *
 * Settings for the new key are INHERITED from the most-recent family member — active OR already
 * revoked, so the common "revoke-then-rotate" sequence needs no `--tier` — and individually
 * overridable via `opts`. A brand-new name has nothing to inherit, so `opts.tier` is required
 * there. The rotated key always starts with a clean credit balance and receives the scope's
 * bounded default lifetime unless `opts.ttlSeconds` selects a shorter allowed lifetime.
 */
export function rotateKey(
  logicalAlias: string,
  opts: Partial<Omit<MintOptions, "alias" | "logicalAlias">>,
  defaults: KeyDefaults
): RotateResult {
  const db = ksDb();

  const run = db.transaction((): RotateResult => {
    // Guard against rotating a CHILD alias instead of the logical name. After `rotate harness`
    // the active key is `harness-r2` (logical_alias='harness'). If the operator then runs
    // `rotate --alias harness-r2`, the family query below would miss it (it matches neither
    // arm), silently mint an orphan `harness-r2-r2`, and LEAVE harness-r2 active — so a key the
    // operator believes they rotated stays live. Detect that exact case and redirect. (A first
    // rotation tags the bare row with logical_alias === alias, so that legitimate self case
    // — logical_alias === logicalAlias — is allowed through.) (self-review #99.)
    const self = db
      .prepare(`SELECT logical_alias FROM api_keys WHERE alias = @logical`)
      .get({ logical: logicalAlias }) as { logical_alias: string | null } | undefined;
    if (self && self.logical_alias !== null && self.logical_alias !== logicalAlias) {
      throw new Error(
        `rotate: '${logicalAlias}' is a rotation of '${self.logical_alias}', not a logical name — ` +
          `run: keys rotate --alias ${self.logical_alias}`
      );
    }

    // Family = rows explicitly tagged with this logical name, plus a legacy/never-rotated key
    // whose bare alias equals the name. rowid is selected to break millisecond createdAt ties
    // deterministically (most-recent = created_at DESC, then rowid DESC).
    const rows = db
      .prepare(
        `SELECT rowid AS _rowid, * FROM api_keys
          WHERE logical_alias = @logical OR (logical_alias IS NULL AND alias = @logical)`
      )
      .all({ logical: logicalAlias }) as Array<KeyRow & { _rowid: number }>;
    const family = rows
      .map((r) => ({ rec: rowToRecord(r), rowid: r._rowid }))
      .sort((a, b) => b.rec.createdAt.localeCompare(a.rec.createdAt) || b.rowid - a.rowid);
    const current = family[0]?.rec;

    const tier = opts.tier ?? current?.tier;
    if (tier !== "owner" && tier !== "guest") {
      throw new Error(
        `rotate: no prior key for '${logicalAlias}' to inherit from — pass --tier owner|guest`
      );
    }
    const scope = opts.scope ?? current?.scope ?? defaultScopeForTier(tier);

    const allAliases = new Set(
      (db.prepare(`SELECT alias FROM api_keys`).all() as Array<{ alias: string }>).map((r) => r.alias)
    );
    const newAlias = nextFreeAlias(logicalAlias, allAliases);

    // Revoke active family members under ONE timestamp so the audit log reads as a single
    // atomic rotation, not N near-simultaneous events. If mintKey throws below (e.g. an invalid
    // override), the surrounding transaction rolls these revokes back — a failed rotation is a no-op.
    const revokeAt = new Date();
    const revokedAliases: string[] = [];
    for (const { rec } of family) {
      if (rec.revokedAt === null && revokeKey(rec.alias, revokeAt)) revokedAliases.push(rec.alias);
    }

    // Inherit from the current key; explicit opts win (nullish-coalescing preserves a 0 limit).
    // Credits start fresh (creditsUsed=0 via mintKey); ttl is NOT inherited.
    const minted = mintKey(
      {
        alias: newAlias,
        logicalAlias,
        tier,
        scope,
        modelAllowList: opts.modelAllowList ?? current?.modelAllowList,
        rpm: opts.rpm ?? current?.rpm,
        tpm: opts.tpm ?? current?.tpm,
        dailyTokenBudget: opts.dailyTokenBudget ?? current?.dailyTokenBudget,
        maxParallel: opts.maxParallel ?? current?.maxParallel,
        creditLimit: opts.creditLimit ?? current?.creditLimit,
        ttlSeconds: opts.ttlSeconds,
      },
      defaults
    );

    return { ...minted, newAlias, revokedAliases };
  });

  return run();
}

// ─── Staged rotation (#152) ───────────────────────────────────────────────────────

export type KeyRotationStatus = "staged" | "committed" | "aborted";

export interface KeyRotationPlan {
  planId: string;
  logicalAlias: string;
  replacementAlias: string;
  previousAliases: string[];
  stagedAt: string;
  overlapExpiresAt: string;
  status: KeyRotationStatus;
  baselineUseCount: number;
  preflightAt: string | null;
  preflightUseCount: number | null;
  preflightLastUsedAt: string | null;
  completedAt: string | null;
}

interface KeyRotationPlanRow {
  plan_id: string;
  logical_alias: string;
  replacement_alias: string;
  previous_aliases: string;
  staged_at: string;
  overlap_expires_at: string;
  status: string;
  baseline_use_count: number;
  preflight_at: string | null;
  preflight_use_count: number | null;
  preflight_last_used_at: string | null;
  completed_at: string | null;
}

function rotationPlanFromRow(row: KeyRotationPlanRow): KeyRotationPlan {
  return {
    planId: row.plan_id,
    logicalAlias: row.logical_alias,
    replacementAlias: row.replacement_alias,
    previousAliases: JSON.parse(row.previous_aliases) as string[],
    stagedAt: row.staged_at,
    overlapExpiresAt: row.overlap_expires_at,
    status: row.status as KeyRotationStatus,
    baselineUseCount: row.baseline_use_count,
    preflightAt: row.preflight_at,
    preflightUseCount: row.preflight_use_count,
    preflightLastUsedAt: row.preflight_last_used_at,
    completedAt: row.completed_at,
  };
}

function rotationFamilyRows(db: Database.Database, logicalAlias: string): Array<KeyRow & { _rowid: number }> {
  const self = db
    .prepare(`SELECT logical_alias FROM api_keys WHERE alias = @logical`)
    .get({ logical: logicalAlias }) as { logical_alias: string | null } | undefined;
  if (self && self.logical_alias !== null && self.logical_alias !== logicalAlias) {
    throw new Error(
      `rotation: '${logicalAlias}' is a rotation of '${self.logical_alias}', not a logical name`
    );
  }
  return db
    .prepare(
      `SELECT rowid AS _rowid, * FROM api_keys
        WHERE logical_alias = @logical OR (logical_alias IS NULL AND alias = @logical)`
    )
    .all({ logical: logicalAlias }) as Array<KeyRow & { _rowid: number }>;
}

export interface StageKeyRotationResult extends MintResult {
  newAlias: string;
  plan: KeyRotationPlan;
}

/**
 * Mint a replacement while leaving the current family active for a bounded overlap window.
 * Only one staged plan may exist per family. The new plaintext is returned once and is never
 * persisted in the plan.
 */
export function stageKeyRotation(
  logicalAlias: string,
  opts: Partial<Omit<MintOptions, "alias" | "logicalAlias">>,
  defaults: KeyDefaults,
  lifecycle: { now?: Date; overlapSeconds?: number } = {}
): StageKeyRotationResult {
  const db = ksDb();
  const now = lifecycle.now ?? new Date();
  const overlapSeconds = lifecycle.overlapSeconds ?? 3_600;
  assertNonNegativeInt("overlapSeconds", overlapSeconds);
  if (overlapSeconds < 60 || overlapSeconds > 24 * 60 * 60) {
    throw new InvalidParamError("overlapSeconds", overlapSeconds);
  }

  return db.transaction((): StageKeyRotationResult => {
    const existingPlan = db
      .prepare(`SELECT plan_id FROM key_rotation_plans WHERE logical_alias = ? AND status = 'staged'`)
      .get(logicalAlias) as { plan_id: string } | undefined;
    if (existingPlan) {
      throw new Error(`rotation: '${logicalAlias}' already has staged plan '${existingPlan.plan_id}'`);
    }

    const family = rotationFamilyRows(db, logicalAlias)
      .map((row) => ({ rec: rowToRecord(row), rowid: row._rowid }))
      .sort((a, b) => b.rec.createdAt.localeCompare(a.rec.createdAt) || b.rowid - a.rowid);
    const active = family.filter(({ rec }) =>
      rec.revokedAt === null
      && (rec.expiresAt === null || Date.parse(rec.expiresAt) > now.getTime())
    );
    const current = active[0]?.rec;
    if (!current) {
      throw new Error(`rotation: '${logicalAlias}' has no active key; mint a new credential instead`);
    }

    const tier = opts.tier ?? current.tier;
    const scope = opts.scope ?? current.scope;
    const replacementTtl = opts.ttlSeconds ?? MAX_KEY_LIFETIME_SECONDS[scope];
    if (replacementTtl < overlapSeconds) {
      throw new Error("rotation: replacement lifetime must cover the entire overlap window");
    }
    const allAliases = new Set(
      (db.prepare(`SELECT alias FROM api_keys`).all() as Array<{ alias: string }>).map((row) => row.alias)
    );
    const newAlias = nextFreeAlias(logicalAlias, allAliases);
    const minted = mintKeyAt(
      {
        alias: newAlias,
        logicalAlias,
        tier,
        scope,
        modelAllowList: opts.modelAllowList ?? current.modelAllowList,
        rpm: opts.rpm ?? current.rpm,
        tpm: opts.tpm ?? current.tpm,
        dailyTokenBudget: opts.dailyTokenBudget ?? current.dailyTokenBudget,
        maxParallel: opts.maxParallel ?? current.maxParallel,
        creditLimit: opts.creditLimit ?? current.creditLimit,
        ttlSeconds: replacementTtl,
      },
      defaults,
      now
    );
    const plan: KeyRotationPlan = {
      planId: `rot_${randomBytes(12).toString("base64url")}`,
      logicalAlias,
      replacementAlias: newAlias,
      previousAliases: active.map(({ rec }) => rec.alias),
      stagedAt: now.toISOString(),
      overlapExpiresAt: new Date(now.getTime() + overlapSeconds * 1_000).toISOString(),
      status: "staged",
      baselineUseCount: minted.record.useCount,
      preflightAt: null,
      preflightUseCount: null,
      preflightLastUsedAt: null,
      completedAt: null,
    };
    db.prepare(
      `INSERT INTO key_rotation_plans
        (plan_id, logical_alias, replacement_alias, previous_aliases, staged_at,
         overlap_expires_at, status, baseline_use_count, preflight_at, preflight_use_count,
         preflight_last_used_at, completed_at)
       VALUES
        (@planId, @logicalAlias, @replacementAlias, @previousAliases, @stagedAt,
         @overlapExpiresAt, @status, @baselineUseCount, @preflightAt, @preflightUseCount,
         @preflightLastUsedAt, @completedAt)`
    ).run({ ...plan, previousAliases: JSON.stringify(plan.previousAliases) });
    return { ...minted, newAlias, plan };
  })();
}

/**
 * Mechanically prove the staged replacement has authenticated through the running gateway.
 * handleRequest records successful minted-key requests after a 2xx/3xx response; this gate requires
 * a post-stage timestamp and use-count increase for the exact replacement alias. Merely
 * possessing or looking up the plaintext cannot satisfy it. Only sanitized counters/timestamps
 * are persisted, and commit refuses to run until this succeeds.
 */
export function preflightKeyRotation(
  planId: string,
  now: Date = new Date()
): KeyRotationPlan {
  const db = ksDb();
  return db.transaction(() => {
    const row = db.prepare(`SELECT * FROM key_rotation_plans WHERE plan_id = ?`).get(planId) as
      KeyRotationPlanRow | undefined;
    if (!row || row.status !== "staged") throw new Error("rotation preflight: plan is not staged");
    if (Date.parse(row.overlap_expires_at) <= now.getTime()) {
      throw new Error("rotation preflight: overlap window has expired; abort and stage again");
    }
    const replacement = db
      .prepare(`SELECT last_used_at, use_count, revoked_at, expires_at FROM api_keys WHERE alias = ?`)
      .get(row.replacement_alias) as {
        last_used_at: string | null;
        use_count: number;
        revoked_at: string | null;
        expires_at: string | null;
      } | undefined;
    if (
      !replacement
      || replacement.revoked_at !== null
      || (replacement.expires_at !== null && Date.parse(replacement.expires_at) <= now.getTime())
    ) {
      throw new Error("rotation preflight: replacement is not active");
    }
    if (
      replacement.last_used_at === null
      || Date.parse(replacement.last_used_at) < Date.parse(row.staged_at)
      || replacement.use_count <= row.baseline_use_count
    ) {
      throw new Error(
        "rotation preflight: replacement has no successful post-stage gateway authentication"
      );
    }
    const ts = now.toISOString();
    db.prepare(
      `UPDATE key_rotation_plans
          SET preflight_at = ?, preflight_use_count = ?, preflight_last_used_at = ?
        WHERE plan_id = ? AND status = 'staged'`
    ).run(ts, replacement.use_count, replacement.last_used_at, planId);
    return rotationPlanFromRow({
      ...row,
      preflight_at: ts,
      preflight_use_count: replacement.use_count,
      preflight_last_used_at: replacement.last_used_at,
    });
  })();
}

export function commitKeyRotation(
  planId: string,
  now: Date = new Date()
): { plan: KeyRotationPlan; revokedAliases: string[]; activeAlias: string } {
  const db = ksDb();
  return db.transaction(() => {
    const row = db.prepare(`SELECT * FROM key_rotation_plans WHERE plan_id = ?`).get(planId) as
      KeyRotationPlanRow | undefined;
    if (!row || row.status !== "staged") throw new Error("rotation commit: plan is not staged");
    if (Date.parse(row.overlap_expires_at) <= now.getTime()) {
      throw new Error("rotation commit: overlap window has expired; abort and stage again");
    }
    if (
      row.preflight_at === null
      || row.preflight_use_count === null
      || row.preflight_last_used_at === null
      || row.preflight_use_count <= row.baseline_use_count
      || Date.parse(row.preflight_last_used_at) < Date.parse(row.staged_at)
    ) {
      throw new Error("rotation commit: replacement preflight has not passed");
    }

    const replacement = db.prepare(`SELECT * FROM api_keys WHERE alias = ?`).get(row.replacement_alias) as
      KeyRow | undefined;
    if (
      !replacement
      || replacement.revoked_at !== null
      || (replacement.expires_at !== null && Date.parse(replacement.expires_at) <= now.getTime())
      || replacement.use_count < row.preflight_use_count
    ) {
      throw new Error("rotation commit: replacement is not active");
    }
    const previousAliases = JSON.parse(row.previous_aliases) as string[];
    const placeholders = previousAliases.map(() => "?").join(",");
    const previousRows = db.prepare(
      `SELECT alias, revoked_at, expires_at FROM api_keys WHERE alias IN (${placeholders})`
    ).all(...previousAliases) as Array<{ alias: string; revoked_at: string | null; expires_at: string | null }>;
    if (
      previousRows.length !== previousAliases.length
      || previousRows.some((previous) =>
        previous.revoked_at !== null
        || (previous.expires_at !== null && Date.parse(previous.expires_at) <= now.getTime()))
    ) {
      throw new Error("rotation commit: prior credential set changed; no revocation was performed");
    }

    const revokedAliases: string[] = [];
    for (const alias of previousAliases) {
      if (!revokeKey(alias, now)) throw new Error("rotation commit: atomic revoke failed");
      revokedAliases.push(alias);
    }
    const completedAt = now.toISOString();
    db.prepare(
      `UPDATE key_rotation_plans SET status = 'committed', completed_at = ?
        WHERE plan_id = ? AND status = 'staged'`
    ).run(completedAt, planId);
    const plan = rotationPlanFromRow({ ...row, status: "committed", completed_at: completedAt });
    return { plan, revokedAliases, activeAlias: row.replacement_alias };
  })();
}

export function abortKeyRotation(planId: string, now: Date = new Date()): KeyRotationPlan {
  const db = ksDb();
  return db.transaction(() => {
    const row = db.prepare(`SELECT * FROM key_rotation_plans WHERE plan_id = ?`).get(planId) as
      KeyRotationPlanRow | undefined;
    if (!row || row.status !== "staged") throw new Error("rotation abort: plan is not staged");
    const previousAliases = JSON.parse(row.previous_aliases) as string[];
    const placeholders = previousAliases.map(() => "?").join(",");
    const livePrevious = db.prepare(
      `SELECT COUNT(*) AS n FROM api_keys
        WHERE alias IN (${placeholders}) AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > ?)`
    ).get(...previousAliases, now.toISOString()) as { n: number };
    if (livePrevious.n !== previousAliases.length) {
      throw new Error("rotation abort: prior credential set is no longer active; manual recovery required");
    }
    if (!revokeKey(row.replacement_alias, now)) {
      throw new Error("rotation abort: replacement is not active");
    }
    const completedAt = now.toISOString();
    db.prepare(
      `UPDATE key_rotation_plans SET status = 'aborted', completed_at = ?
        WHERE plan_id = ? AND status = 'staged'`
    ).run(completedAt, planId);
    return rotationPlanFromRow({ ...row, status: "aborted", completed_at: completedAt });
  })();
}

export function listKeyRotations(): KeyRotationPlan[] {
  return (ksDb().prepare(`SELECT * FROM key_rotation_plans ORDER BY staged_at`).all() as KeyRotationPlanRow[])
    .map(rotationPlanFromRow);
}

// ─── List ─────────────────────────────────────────────────────────────────────────

export function listKeys(opts: { includeRevoked?: boolean } = {}): ApiKeyPublic[] {
  const db = ksDb();
  const sql = opts.includeRevoked
    ? `SELECT * FROM api_keys ORDER BY created_at`
    : `SELECT * FROM api_keys WHERE revoked_at IS NULL ORDER BY created_at`;
  const rows = db.prepare(sql).all() as KeyRow[];
  return rows.map((r) => toPublic(rowToRecord(r)));
}

/** Record a successful authenticated use without accepting or exposing token material. */
export function recordKeyUse(alias: string, now: Date = new Date()): boolean {
  const ts = now.toISOString();
  const info = ksDb()
    .prepare(
      `UPDATE api_keys
          SET last_used_at = @ts, use_count = use_count + 1
        WHERE alias = @alias
          AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > @ts)`
    )
    .run({ alias, ts });
  return info.changes === 1;
}

export type CredentialFinding =
  | "no_expiry"
  | "over_scoped"
  | "stale"
  | "unused"
  | "expired"
  | "revoked";

export interface CredentialInventoryEntry extends ApiKeyPublic {
  status: "active" | "expired" | "revoked";
  findings: CredentialFinding[];
}

export interface CredentialInventoryReport {
  generatedAt: string;
  staleAfterDays: number;
  summary: {
    total: number;
    active: number;
    expired: number;
    revoked: number;
    findings: Record<CredentialFinding, number>;
  };
  /** Public metadata only. The keystore hash is excluded by the ApiKeyPublic boundary. */
  keys: CredentialInventoryEntry[];
}

/**
 * Build a conservative, secret-safe inventory. Admin credentials are deliberately reported as
 * over-scoped review candidates: the operator must prove an owner-only administrative purpose;
 * service and harness consumers should migrate to agent, monitor, or inference scope.
 */
export function credentialInventory(opts: {
  now?: Date;
  staleAfterDays?: number;
  includeRevoked?: boolean;
} = {}): CredentialInventoryReport {
  const now = opts.now ?? new Date();
  const staleAfterDays = opts.staleAfterDays ?? 30;
  assertNonNegativeInt("staleAfterDays", staleAfterDays);
  const staleCutoffMs = now.getTime() - staleAfterDays * 24 * 60 * 60 * 1000;
  const source = listKeys({ includeRevoked: true });

  const all = source.map((key): CredentialInventoryEntry => {
    const expired = key.expiresAt !== null && Date.parse(key.expiresAt) <= now.getTime();
    const status = key.revokedAt !== null ? "revoked" : expired ? "expired" : "active";
    const findings: CredentialFinding[] = [];
    if (status === "revoked") findings.push("revoked");
    if (status === "expired") findings.push("expired");
    if (status === "active") {
      if (key.expiresAt === null) findings.push("no_expiry");
      if (key.scope === "admin") findings.push("over_scoped");
      if (key.useCount === 0 || key.lastUsedAt === null) {
        findings.push("unused");
      } else if (Date.parse(key.lastUsedAt) <= staleCutoffMs) {
        findings.push("stale");
      }
    }
    return { ...key, status, findings };
  });
  const keys = opts.includeRevoked ? all : all.filter((key) => key.status !== "revoked");
  const findingNames: CredentialFinding[] = [
    "no_expiry", "over_scoped", "stale", "unused", "expired", "revoked",
  ];
  return {
    generatedAt: now.toISOString(),
    staleAfterDays,
    summary: {
      total: keys.length,
      active: keys.filter((key) => key.status === "active").length,
      expired: keys.filter((key) => key.status === "expired").length,
      revoked: keys.filter((key) => key.status === "revoked").length,
      findings: Object.fromEntries(
        findingNames.map((name) => [name, keys.filter((key) => key.findings.includes(name)).length])
      ) as Record<CredentialFinding, number>,
    },
    keys,
  };
}

// ─── Credit accounting (lifetime, non-resetting) ────────────────────────────────────

/**
 * True when the key has a positive lifetime credit cap that has been reached or passed.
 * A creditLimit of 0 means unlimited, so it is never exhausted. Pure given the record.
 */
export function isCreditExhausted(rec: Pick<ApiKeyRecord, "creditLimit" | "creditsUsed">): boolean {
  return rec.creditLimit > 0 && rec.creditsUsed >= rec.creditLimit;
}

/**
 * Accrue actual tokens against a key's lifetime credit budget, keyed by its hash (the same
 * value the gateway already holds post-auth). Never resets; mirrors the quota ledger but for
 * the depleting credit cap. Unknown hashes are a no-op (the row may have been revoked).
 */
export function recordUsage(keyHash: string, tokens: number): void {
  if (tokens <= 0) return;
  ksDb()
    .prepare(`UPDATE api_keys SET credits_used = credits_used + @tokens WHERE key_hash = @keyHash`)
    .run({ keyHash, tokens });
}

/**
 * Atomically reserve `reserve` credits against a key's lifetime budget in a SINGLE conditional
 * UPDATE. This closes the check-then-accrue race that a snapshot-based isCreditExhausted gate
 * left open: two concurrent requests can no longer both pass a stale "under the limit" read and
 * then each accrue real usage, overspending the cap. The UPDATE only succeeds while the key is
 * still under its limit; SQLite serializes the writes, so at most enough concurrent requests to
 * cover the remaining budget reserve, and the rest see changes === 0 and are rejected before
 * any inference runs.
 *
 * Semantics:
 *   • creditLimit 0 (unlimited) → always reserves (still accrues, never blocks).
 *   • reserve <= 0 → treated as a pure admission probe (reserves nothing, ok iff under limit).
 *   • unknown / revoked hash → { ok: false } (no row updated).
 *
 * Reconcile the over/under-reservation after the call with reconcileCredits().
 */
export function reserveCredits(keyHash: string, reserve: number): { ok: boolean } {
  const amount = reserve > 0 ? reserve : 0;
  const info = ksDb()
    .prepare(
      `UPDATE api_keys
         SET credits_used = credits_used + @amount
       WHERE key_hash = @keyHash
         AND revoked_at IS NULL
         AND (credit_limit = 0 OR credits_used + @amount <= credit_limit)`
    )
    .run({ keyHash, amount });
  return { ok: info.changes > 0 };
}

/**
 * Reconcile a prior reserveCredits() against real usage: adjust credits_used by
 * (realTokens − reserved) so the net accrual equals real usage. delta may be negative (the
 * reservation over-estimated) — clamp at 0 so a key never goes below zero used. Mirrors the
 * reserve-then-reconcile pattern quota.ts uses for TPM. No-op when the numbers already match.
 */
export function reconcileCredits(keyHash: string, reserved: number, realTokens: number): void {
  const delta = realTokens - reserved;
  if (delta === 0) return;
  ksDb()
    .prepare(
      `UPDATE api_keys
         SET credits_used = MAX(0, credits_used + @delta)
       WHERE key_hash = @keyHash`
    )
    .run({ keyHash, delta });
}

// ─── Invites (one-time, invite-link → self-issue) ───────────────────────────────────

export interface InviteRow {
  label: string;
  code_hash: string;
  tier: string;
  credit_limit: number;
  model_allow_list: string;
  alias_prefix: string;
  created_at: string;
  redeemed_at: string | null;
  redeemed_key_alias: string | null;
}

export interface CreateInviteOptions {
  /** Human label/alias for the invite row (operator-facing). Must be unique. */
  label: string;
  tier: Tier;
  creditLimit: number; // 0 = unlimited
  modelAllowList?: string[];
  /** Prefix for the auto-generated key alias on redemption (e.g. "alice" → "alice-3f9a"). */
  aliasPrefix?: string;
}

export interface CreateInviteResult {
  /** Plaintext invite code, returned ONCE — only its sha256 hash is persisted. */
  code: string;
  label: string;
  tier: Tier;
  creditLimit: number;
  modelAllowList: string[];
}

/**
 * Create a one-time invite. The plaintext code (`inv_<base64url(32)>`) is returned ONCE and
 * never persisted — only sha256(code) is stored, mirroring api-key handling. Preset limits
 * (tier, creditLimit, model allow-list) are baked in and carried onto the key at redemption.
 */
export function createInvite(opts: CreateInviteOptions): CreateInviteResult {
  // Same guard as mintKey: a negative creditLimit baked into an invite would mint a key that
  // reads as "unlimited" on redemption. Reject before any DB write.
  assertNonNegativeInt("creditLimit", opts.creditLimit);

  const db = ksDb();
  const code = `inv_${randomBytes(32).toString("base64url")}`;
  const codeHash = hashKey(code);
  const createdAt = new Date().toISOString();
  const modelAllowList = opts.modelAllowList ?? [];
  const aliasPrefix = opts.aliasPrefix ?? "friend";

  try {
    db.prepare(
      `INSERT INTO invites
         (label, code_hash, tier, credit_limit, model_allow_list, alias_prefix, created_at)
       VALUES
         (@label, @codeHash, @tier, @creditLimit, @modelAllowList, @aliasPrefix, @createdAt)`
    ).run({
      label: opts.label,
      codeHash,
      tier: opts.tier,
      creditLimit: opts.creditLimit,
      modelAllowList: JSON.stringify(modelAllowList),
      aliasPrefix,
      createdAt,
    });
  } catch (err) {
    const sqlCode = (err as { code?: string }).code;
    if (sqlCode === "SQLITE_CONSTRAINT_UNIQUE" || sqlCode === "SQLITE_CONSTRAINT_PRIMARYKEY") {
      // The label collided (or, improbably, the code hash). Reuse the alias-exists shape so
      // callers get a clean typed error rather than a raw SQLite string.
      throw new KeyAliasExistsError(opts.label);
    }
    throw err;
  }

  return { code, label: opts.label, tier: opts.tier, creditLimit: opts.creditLimit, modelAllowList };
}

/**
 * Redeem an invite code → mint a fresh api key carrying the invite's tier / creditLimit /
 * model allow-list, mark the invite redeemed, and return the MintResult (plaintext key shown
 * once). STRICTLY one-time: an unknown OR already-redeemed code throws InviteInvalidError —
 * a single, uniform error so the endpoint cannot be used to enumerate valid codes.
 *
 * Lookup is timing-safe (constant-time scan over UNredeemed invites), mirroring lookupKey.
 */
export function redeemInvite(code: string, defaults: KeyDefaults): MintResult {
  const db = ksDb();
  const ph = Buffer.from(hashKey(code), "hex");
  const rows = db
    .prepare(`SELECT * FROM invites WHERE redeemed_at IS NULL`)
    .all() as InviteRow[];

  let match: InviteRow | null = null;
  let found = false;
  for (const r of rows) {
    const rh = Buffer.from(r.code_hash, "hex");
    const eq = rh.length === ph.length && timingSafeEqual(rh, ph);
    if (eq) {
      found = true;
      match = r;
    }
  }
  if (!found || !match) throw new InviteInvalidError();
  const inv = match;

  // Auto-generate a non-guessable, collision-resistant alias from the prefix.
  const shortRand = randomBytes(4).toString("hex");
  const alias = `${inv.alias_prefix || "friend"}-${shortRand}`;

  // Mint the key AND mark the invite redeemed inside ONE transaction so they are atomic:
  // if the mark-redeemed loses the concurrent-redeem race (0 rows), the whole tx rolls back —
  // the minted key never persists, so there is no orphan key and no compensating revoke. A
  // crash between the two writes likewise leaves nothing committed.
  const redeem = db.transaction((): MintResult => {
    const m = mintKey(
      {
        alias,
        tier: inv.tier as Tier,
        modelAllowList: JSON.parse(inv.model_allow_list) as string[],
        creditLimit: inv.credit_limit,
      },
      defaults
    );

    // Mark redeemed ONLY if still unredeemed (defence against a concurrent double-redeem):
    // the WHERE clause makes this atomic — a second racer updates 0 rows and we abort the tx.
    const info = db
      .prepare(
        `UPDATE invites
           SET redeemed_at = @ts, redeemed_key_alias = @alias
         WHERE label = @label AND redeemed_at IS NULL`
      )
      .run({ ts: new Date().toISOString(), alias, label: inv.label });
    if (info.changes === 0) {
      // Lost the race — throwing rolls back the mint above, so the loser walks away with
      // nothing. Caller surfaces the uniform InviteInvalidError.
      throw new InviteInvalidError();
    }
    return m;
  });

  return redeem();
}

/** List invites (operator-facing). Never returns code hashes by default. */
export interface InvitePublic {
  label: string;
  tier: Tier;
  creditLimit: number;
  modelAllowList: string[];
  aliasPrefix: string;
  createdAt: string;
  redeemedAt: string | null;
  redeemedKeyAlias: string | null;
}

export function listInvites(): InvitePublic[] {
  const db = ksDb();
  const rows = db.prepare(`SELECT * FROM invites ORDER BY created_at`).all() as InviteRow[];
  return rows.map((r) => ({
    label: r.label,
    tier: r.tier as Tier,
    creditLimit: r.credit_limit,
    modelAllowList: JSON.parse(r.model_allow_list) as string[],
    aliasPrefix: r.alias_prefix,
    createdAt: r.created_at,
    redeemedAt: r.redeemed_at,
    redeemedKeyAlias: r.redeemed_key_alias,
  }));
}
