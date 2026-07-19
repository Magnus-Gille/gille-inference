import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../src/db.js";
import {
  checkQuota,
  recordUsage,
  resetQuotaWindows,
  type QuotaLimits,
} from "../src/homeserver/quota.js";

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "hs-quota-test-"));
  initDb(join(dir, "test.db"));
});

beforeEach(() => {
  resetQuotaWindows();
});

let n = 0;
function alias(): string {
  return `q-${n++}`;
}

const T0 = 1_700_000_000_000; // fixed base ms

describe("quota sliding windows", () => {
  it("RPM: blocks the 3rd request in-window, frees after 60s slide", () => {
    const a = alias();
    const limits: QuotaLimits = { rpm: 2, tpm: 1_000_000, dailyTokenBudget: 0 };
    expect(checkQuota(a, limits, 1, T0).ok).toBe(true);
    expect(checkQuota(a, limits, 1, T0 + 1000).ok).toBe(true);
    const third = checkQuota(a, limits, 1, T0 + 2000);
    expect(third.ok).toBe(false);
    if (!third.ok) {
      expect(third.reason).toBe("rpm");
      expect(third.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    }
    // Advance past the window of the oldest event → slot frees.
    const later = checkQuota(a, limits, 1, T0 + 61_000);
    expect(later.ok).toBe(true);
  });

  it("TPM: blocks when estimated tokens exceed the per-minute budget", () => {
    const a = alias();
    const limits: QuotaLimits = { rpm: 1000, tpm: 1000, dailyTokenBudget: 0 };
    expect(checkQuota(a, limits, 600, T0).ok).toBe(true);
    const over = checkQuota(a, limits, 600, T0 + 500);
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.reason).toBe("tpm");
  });

  it("daily: recordUsage accumulates to budget; resets on a new UTC day", () => {
    const a = alias();
    const limits: QuotaLimits = { rpm: 1000, tpm: 1_000_000, dailyTokenBudget: 1000 };
    // Pre-admission ok at start of day.
    expect(checkQuota(a, limits, 100, T0).ok).toBe(true);
    recordUsage(a, 1000, T0);
    const blocked = checkQuota(a, limits, 1, T0 + 1000);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.reason).toBe("daily");
      expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    }
    // Next UTC day → counter resets.
    const nextDay = T0 + 24 * 60 * 60 * 1000 + 1000;
    expect(checkQuota(a, limits, 1, nextDay).ok).toBe(true);
  });

  it("dailyTokenBudget 0 means unlimited; never trips daily", () => {
    const a = alias();
    const limits: QuotaLimits = { rpm: 1000, tpm: 1_000_000, dailyTokenBudget: 0 };
    recordUsage(a, 10_000_000, T0);
    expect(checkQuota(a, limits, 1, T0 + 1000).ok).toBe(true);
  });

  it("tpm 0 = unlimited tokens; rpm 0 blocks every request", () => {
    const aT = alias();
    expect(
      checkQuota(aT, { rpm: 1000, tpm: 0, dailyTokenBudget: 0 }, 9_999_999, T0).ok
    ).toBe(true);

    const aR = alias();
    const r = checkQuota(aR, { rpm: 0, tpm: 1_000_000, dailyTokenBudget: 0 }, 1, T0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("rpm");
  });

  it("snapshot fields populate on both ok and reject", () => {
    const a = alias();
    const limits: QuotaLimits = { rpm: 2, tpm: 1000, dailyTokenBudget: 5000 };
    const ok = checkQuota(a, limits, 10, T0);
    expect(ok.snapshot.rpmLimit).toBe(2);
    expect(ok.snapshot.tpmLimit).toBe(1000);
    expect(ok.snapshot.dailyLimit).toBe(5000);
    expect(ok.snapshot.rpmUsed).toBeGreaterThanOrEqual(1);

    checkQuota(a, limits, 10, T0 + 100);
    const rej = checkQuota(a, limits, 10, T0 + 200);
    expect(rej.ok).toBe(false);
    expect(rej.snapshot.rpmUsed).toBeGreaterThanOrEqual(2);
    expect(rej.snapshot.rpmLimit).toBe(2);
  });

  // ─── M1: reservation-safe daily budget under concurrency ───────────────────────────
  it("M1: daily budget is RESERVED at admission, so two racing requests cannot both pass", () => {
    const a = alias();
    // Budget 1000; each request estimates 600. Without reservation BOTH would pass the snapshot
    // read (used=0). With reservation, the first reserves 600 (now 600 used), the second sees
    // 600+600>1000 and is rejected — only the within-budget one is admitted.
    const limits: QuotaLimits = { rpm: 1000, tpm: 1_000_000, dailyTokenBudget: 1000 };
    const first = checkQuota(a, limits, 600, T0);
    expect(first.ok).toBe(true);
    const second = checkQuota(a, limits, 600, T0 + 1);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("daily");
  });

  it("M1: checkQuota returns a reservation handle on success", () => {
    const a = alias();
    const limits: QuotaLimits = { rpm: 1000, tpm: 1_000_000, dailyTokenBudget: 5000 };
    const d = checkQuota(a, limits, 100, T0);
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(d.reservation).toBeDefined();
      expect(typeof d.reservation.eventId).toBe("string");
      expect(d.reservation.reservedDaily).toBe(100);
    }
  });

  it("M1: reconciling by reservation handle adjusts the daily counter by (actual - reserved)", () => {
    const a = alias();
    const limits: QuotaLimits = { rpm: 1000, tpm: 1_000_000, dailyTokenBudget: 1000 };
    // Reserve 600; real usage was only 50. After reconcile, daily should reflect 50, so a second
    // 600-token request now fits (50 + 600 <= 1000).
    const first = checkQuota(a, limits, 600, T0);
    expect(first.ok).toBe(true);
    if (first.ok) recordUsage(a, 50, T0 + 10, first.reservation);
    const second = checkQuota(a, limits, 600, T0 + 20);
    expect(second.ok).toBe(true);
  });

  it("M1: a rejected request reserves NOTHING against the daily budget", () => {
    const a = alias();
    const limits: QuotaLimits = { rpm: 1000, tpm: 1_000_000, dailyTokenBudget: 1000 };
    // First reserves 900. Second (estimate 600) would overflow → rejected, must NOT leave its 600
    // reserved. A third 50-token request must still fit (900 + 50 <= 1000).
    const first = checkQuota(a, limits, 900, T0);
    expect(first.ok).toBe(true);
    const second = checkQuota(a, limits, 600, T0 + 1);
    expect(second.ok).toBe(false);
    const third = checkQuota(a, limits, 50, T0 + 2);
    expect(third.ok).toBe(true);
  });

  it("M1: reconciliation targets the event by id, not the latest ring entry", () => {
    const a = alias();
    const limits: QuotaLimits = { rpm: 1000, tpm: 10_000, dailyTokenBudget: 0 };
    // Two concurrent same-alias requests. Reconcile the FIRST after the SECOND was admitted.
    const r1 = checkQuota(a, limits, 1000, T0);
    const r2 = checkQuota(a, limits, 2000, T0 + 1);
    expect(r1.ok && r2.ok).toBe(true);
    // Reconcile request 1 to its real usage (100). This must adjust r1's event, not r2's (the
    // latest ring entry). r2's 2000 estimate stays until r2 is reconciled.
    if (r1.ok) recordUsage(a, 100, T0 + 2, r1.reservation);
    // TPM window now holds 100 (r1) + 2000 (r2) = 2100. A 7900-token request fits (2100+7900=10000).
    const probe = checkQuota(a, limits, 7900, T0 + 3);
    expect(probe.ok).toBe(true);
    // But an 7901-token request would exceed (2100+7901>10000).
    resetQuotaWindows();
    // (re-establish to assert the negative cleanly)
    const b = alias();
    const r1b = checkQuota(b, limits, 1000, T0);
    const r2b = checkQuota(b, limits, 2000, T0 + 1);
    expect(r1b.ok && r2b.ok).toBe(true);
    if (r1b.ok) recordUsage(b, 100, T0 + 2, r1b.reservation);
    const over = checkQuota(b, limits, 7901, T0 + 3);
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.reason).toBe("tpm");
  });
});
