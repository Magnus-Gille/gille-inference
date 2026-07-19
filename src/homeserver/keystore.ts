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

export interface ApiKeyRecord {
  alias: string;
  keyHash: string;
  tier: Tier;
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
      model_allow_list   TEXT NOT NULL DEFAULT '[]',
      rpm                INTEGER NOT NULL,
      tpm                INTEGER NOT NULL,
      daily_token_budget INTEGER NOT NULL DEFAULT 0,
      max_parallel       INTEGER NOT NULL DEFAULT 1,
      expires_at         TEXT,
      created_at         TEXT NOT NULL,
      revoked_at         TEXT
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
    // The index backs rotateKey's family lookup (no full scan under the write lock). Created
    // UNCONDITIONALLY (IF NOT EXISTS) — NOT only alongside the column-add — so a DB that already
    // has the column but is missing the index (partial/manual migration) still gets it. (Codex #99.)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_api_keys_logical_alias ON api_keys(logical_alias)`);
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
}

function rowToRecord(r: KeyRow): ApiKeyRecord {
  return {
    alias: r.alias,
    keyHash: r.key_hash,
    tier: r.tier as Tier,
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
  // Reject non-integer / negative numeric limits BEFORE touching the DB. A negative
  // creditLimit is the dangerous case (it would read as "unlimited" in isCreditExhausted).
  assertNonNegativeInt("creditLimit", opts.creditLimit);
  assertNonNegativeInt("rpm", opts.rpm);
  assertNonNegativeInt("tpm", opts.tpm);
  assertNonNegativeInt("dailyTokenBudget", opts.dailyTokenBudget);
  assertNonNegativeInt("maxParallel", opts.maxParallel);
  assertNonNegativeInt("ttlSeconds", opts.ttlSeconds);

  const db = ksDb();
  const plaintextKey = `hs_${opts.tier}_${randomBytes(32).toString("base64url")}`;
  const keyHash = hashKey(plaintextKey);
  const now = new Date();
  const createdAt = now.toISOString();
  const expiresAt =
    opts.ttlSeconds !== undefined
      ? new Date(now.getTime() + opts.ttlSeconds * 1000).toISOString()
      : null;

  const record: ApiKeyRecord = {
    alias: opts.alias,
    keyHash,
    tier: opts.tier,
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
  };

  try {
    db.prepare(
      `INSERT INTO api_keys
         (alias, key_hash, tier, model_allow_list, rpm, tpm, daily_token_budget,
          max_parallel, credit_limit, credits_used, expires_at, created_at, revoked_at, logical_alias)
       VALUES
         (@alias, @keyHash, @tier, @modelAllowList, @rpm, @tpm, @dailyTokenBudget,
          @maxParallel, @creditLimit, @creditsUsed, @expiresAt, @createdAt, @revokedAt, @logicalAlias)`
    ).run({
      alias: record.alias,
      keyHash: record.keyHash,
      tier: record.tier,
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
 * there. The rotated key always starts with a clean credit balance and no expiry unless
 * `opts.ttlSeconds` is given.
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

// ─── List ─────────────────────────────────────────────────────────────────────────

export function listKeys(opts: { includeRevoked?: boolean } = {}): ApiKeyPublic[] {
  const db = ksDb();
  const sql = opts.includeRevoked
    ? `SELECT * FROM api_keys ORDER BY created_at`
    : `SELECT * FROM api_keys WHERE revoked_at IS NULL ORDER BY created_at`;
  const rows = db.prepare(sql).all() as KeyRow[];
  return rows.map((r) => toPublic(rowToRecord(r)));
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
