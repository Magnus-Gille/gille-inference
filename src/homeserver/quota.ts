import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { getDb } from "../db.js";

/**
 * Per-key quota enforcement.
 *
 *   • RPM / TPM — in-memory sliding windows (60s) per alias. Cheap, reset on restart.
 *   • daily token budget — persisted to a sibling table so it survives a restart within
 *     the same UTC day.
 *
 * checkQuota() is the pre-admission gate: it counts the request against RPM immediately
 * and checks TPM/daily against *estimated* tokens (prompt + max_tokens cap) so an
 * over-budget call is rejected before it runs. recordUsage() reconciles the real token
 * count after the call completes. Both are pure given `now` for testability.
 *
 * Semantics for `0`:
 *   • rpm: 0 → block every request (no requests permitted).
 *   • tpm: 0 → unlimited tokens per minute.
 *   • dailyTokenBudget: 0 → unlimited daily tokens.
 */

const WINDOW_MS = 60_000;

export interface QuotaLimits {
  rpm: number;
  tpm: number;
  dailyTokenBudget: number; // 0 = unlimited
}

export interface QuotaSnapshot {
  rpmUsed: number;
  rpmLimit: number;
  tpmUsed: number;
  tpmLimit: number;
  dailyUsed: number;
  dailyLimit: number;
  resetSeconds: number; // seconds until the binding window frees a slot
}

/**
 * A reservation handle returned on a successful checkQuota(). Lets recordUsage() reconcile the
 * EXACT event it admitted — by id, not "the latest ring entry" — which is the only correct target
 * under concurrent same-alias requests (M1). It also carries the daily tokens that were RESERVED
 * (debited) at admission, so recordUsage() can adjust the persisted daily counter by
 * (actual − reserved) rather than double-counting.
 */
export interface QuotaReservation {
  alias: string;
  eventId: string;
  reservedDaily: number;
  day: string;
}

export type QuotaDecision =
  | { ok: true; snapshot: QuotaSnapshot; reservation: QuotaReservation }
  | {
      ok: false;
      reason: "rpm" | "tpm" | "daily";
      retryAfterSeconds: number;
      snapshot: QuotaSnapshot;
    };

interface UsageEvent {
  id: string;
  ts: number;
  tokens: number;
}

// alias → ring of recent {ts, tokens}, pruned to WINDOW_MS on each access.
const windows = new Map<string, UsageEvent[]>();

// ─── Daily table (persisted) ───────────────────────────────────────────────────────

let _quotaInit = false;

function ensureSchema(db: Database.Database): void {
  if (_quotaInit) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS key_usage_daily (
      alias  TEXT NOT NULL,
      day    TEXT NOT NULL,
      tokens INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (alias, day)
    );
  `);
  _quotaInit = true;
}

function quotaDb(): Database.Database {
  const db = getDb();
  ensureSchema(db);
  return db;
}

export function dayKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10); // UTC YYYY-MM-DD
}

function dailyUsed(alias: string, nowMs: number): number {
  const row = quotaDb()
    .prepare(`SELECT tokens FROM key_usage_daily WHERE alias = ? AND day = ?`)
    .get(alias, dayKey(nowMs)) as { tokens: number } | undefined;
  return row?.tokens ?? 0;
}

/**
 * Atomically reserve `reserve` daily tokens for (alias, day) and return the new total IN THE SAME
 * statement sequence under SQLite's serialized writes. This is the reservation-safe daily gate
 * (M1): two concurrent same-alias requests can no longer both read a stale `used` and then both
 * proceed — each one debits first, then the caller checks the post-debit total against the budget
 * and rolls its own reserve back if it overflowed. `dailyBudget === 0` means unlimited, so we still
 * reserve (to track usage) but never reject.
 */
function reserveDaily(alias: string, day: string, reserve: number): number {
  const db = quotaDb();
  const tx = db.transaction((): number => {
    db.prepare(
      `INSERT INTO key_usage_daily (alias, day, tokens)
       VALUES (@alias, @day, @tokens)
       ON CONFLICT(alias, day) DO UPDATE SET tokens = tokens + excluded.tokens`
    ).run({ alias, day, tokens: reserve });
    const row = db
      .prepare(`SELECT tokens FROM key_usage_daily WHERE alias = ? AND day = ?`)
      .get(alias, day) as { tokens: number } | undefined;
    return row?.tokens ?? 0;
  });
  return tx();
}

/** Adjust a (alias, day) daily counter by `delta` (may be negative), clamped at 0. */
function adjustDaily(alias: string, day: string, delta: number): void {
  if (delta === 0) return;
  quotaDb()
    .prepare(
      `UPDATE key_usage_daily SET tokens = MAX(0, tokens + @delta)
       WHERE alias = @alias AND day = @day`
    )
    .run({ alias, day, delta });
}

function secondsToUtcMidnight(nowMs: number): number {
  const d = new Date(nowMs);
  const next = Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate() + 1,
    0,
    0,
    0,
    0
  );
  return Math.max(1, Math.ceil((next - nowMs) / 1000));
}

// ─── Window helpers ─────────────────────────────────────────────────────────────────

function pruned(alias: string, nowMs: number): UsageEvent[] {
  const ring = windows.get(alias) ?? [];
  const cutoff = nowMs - WINDOW_MS;
  const live = ring.filter((e) => e.ts > cutoff);
  windows.set(alias, live);
  return live;
}

/** seconds until the oldest event in the window leaves it (≥1). */
function windowRetry(live: UsageEvent[], nowMs: number): number {
  if (live.length === 0) return 1;
  const oldest = live[0]!.ts;
  const freesAt = oldest + WINDOW_MS;
  return Math.max(1, Math.ceil((freesAt - nowMs) / 1000));
}

// ─── Pre-admission check ─────────────────────────────────────────────────────────────

export function checkQuota(
  alias: string,
  limits: QuotaLimits,
  estTokens: number,
  now: number = Date.now()
): QuotaDecision {
  const live = pruned(alias, now);
  const rpmUsed = live.length;
  const tpmUsed = live.reduce((s, e) => s + e.tokens, 0);
  const used = dailyUsed(alias, now);

  const snapshot: QuotaSnapshot = {
    rpmUsed: rpmUsed + 1, // this request
    rpmLimit: limits.rpm,
    tpmUsed: tpmUsed + estTokens,
    tpmLimit: limits.tpm,
    dailyUsed: used,
    dailyLimit: limits.dailyTokenBudget,
    resetSeconds: windowRetry(live, now),
  };

  // RPM: 0 = block-all; otherwise this request must fit under the limit.
  if (limits.rpm === 0 || rpmUsed + 1 > limits.rpm) {
    return {
      ok: false,
      reason: "rpm",
      retryAfterSeconds: windowRetry(live, now),
      snapshot,
    };
  }

  // TPM: 0 = unlimited.
  if (limits.tpm > 0 && tpmUsed + estTokens > limits.tpm) {
    return {
      ok: false,
      reason: "tpm",
      retryAfterSeconds: windowRetry(live, now),
      snapshot,
    };
  }

  // Daily (M1): reserve atomically, THEN check the post-reserve total. Reserving first closes the
  // check-then-act race two concurrent requests could otherwise win against a stale snapshot read.
  // A request that overflows rolls its own reservation back so it leaves nothing behind.
  const day = dayKey(now);
  const reserveAmount = estTokens > 0 ? estTokens : 0;
  const dailyAfter = reserveDaily(alias, day, reserveAmount);
  if (limits.dailyTokenBudget > 0 && dailyAfter > limits.dailyTokenBudget) {
    adjustDaily(alias, day, -reserveAmount); // roll back this request's reservation
    return {
      ok: false,
      reason: "daily",
      retryAfterSeconds: secondsToUtcMidnight(now),
      snapshot,
    };
  }

  // Admitted — count the request against RPM/TPM immediately (estimate reconciled later). The
  // event carries a unique id so recordUsage() reconciles THIS event, not "the latest ring entry".
  const eventId = randomUUID();
  const ring = windows.get(alias) ?? [];
  ring.push({ id: eventId, ts: now, tokens: estTokens });
  windows.set(alias, ring);

  return {
    ok: true,
    snapshot,
    reservation: { alias, eventId, reservedDaily: reserveAmount, day },
  };
}

// ─── Post-call reconciliation ────────────────────────────────────────────────────────

/**
 * Commit actual usage after a call completes.
 *
 * Reservation-safe path (M1): when the `reservation` handle from checkQuota() is passed, the TPM
 * estimate is reconciled on the EXACT admitted event (by id — correct under concurrent same-alias
 * requests, unlike "the latest ring entry"), and the persisted daily counter is adjusted by
 * (actual − reservedDaily) since the estimate was already debited at admission.
 *
 * Legacy path (no reservation): reconcile the latest ring entry and ADD actual to the daily total.
 * Kept so direct callers / older tests that never reserved keep their prior semantics.
 */
export function recordUsage(
  alias: string,
  actualTokens: number,
  now: number = Date.now(),
  reservation?: QuotaReservation
): void {
  const ring = windows.get(alias);
  if (reservation) {
    // Reconcile the specific admitted event by id.
    if (ring) {
      const ev = ring.find((e) => e.id === reservation.eventId);
      if (ev) ev.tokens = actualTokens;
    }
    // Daily was reserved (debited) at admission; adjust by the over/under-reservation only.
    adjustDaily(alias, reservation.day, actualTokens - reservation.reservedDaily);
    return;
  }

  // Legacy path: reconcile the latest in-window event, then add actual to the daily total.
  if (ring && ring.length > 0) {
    ring[ring.length - 1]!.tokens = actualTokens;
  }
  quotaDb()
    .prepare(
      `INSERT INTO key_usage_daily (alias, day, tokens)
       VALUES (@alias, @day, @tokens)
       ON CONFLICT(alias, day) DO UPDATE SET tokens = tokens + excluded.tokens`
    )
    .run({ alias, day: dayKey(now), tokens: actualTokens });
}

/** Test/ops hook: wipe all in-memory windows (daily table untouched). */
export function resetQuotaWindows(): void {
  windows.clear();
}

// ─── Generic per-bucket request throttle (e.g. per-IP, unauthenticated surface) ───────

/**
 * Standalone sliding-window request throttle, reusing the same prune-and-count mechanism as
 * checkQuota but with a configurable window and no token/daily semantics. Used to throttle
 * the unauthenticated public surface (e.g. POST /portal/redeem) per client IP as
 * defence-in-depth behind any upstream WAF.
 *
 * `limit` is the max requests permitted per `windowMs`; `limit <= 0` disables the throttle
 * (always allowed). On admit the call is counted immediately. Pure given `now` for testability.
 * Buckets live in a separate namespace from the per-key quota windows so they never collide.
 */
const rateBuckets = new Map<string, number[]>();

export interface RateWindowDecision {
  ok: boolean;
  retryAfterSeconds: number;
}

export function checkRateWindow(
  bucket: string,
  limit: number,
  windowMs: number,
  now: number = Date.now()
): RateWindowDecision {
  if (limit <= 0) return { ok: true, retryAfterSeconds: 0 };
  const cutoff = now - windowMs;
  const live = (rateBuckets.get(bucket) ?? []).filter((ts) => ts > cutoff);
  if (live.length >= limit) {
    const oldest = live[0]!;
    const retry = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
    rateBuckets.set(bucket, live);
    return { ok: false, retryAfterSeconds: retry };
  }
  live.push(now);
  rateBuckets.set(bucket, live);
  return { ok: true, retryAfterSeconds: 0 };
}

/** Test/ops hook: wipe all in-memory rate buckets (the per-key quota windows are untouched). */
export function resetRateWindows(): void {
  rateBuckets.clear();
}
