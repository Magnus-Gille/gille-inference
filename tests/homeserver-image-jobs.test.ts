import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb, getDb } from "../src/db.js";
import { AdmissionController } from "../src/homeserver/admission.js";
import { setConfig, type HomeserverConfig } from "../src/homeserver/config.js";
import { mintKey, lookupKey, reserveCredits } from "../src/homeserver/keystore.js";
import { checkQuota, resetQuotaWindows, type QuotaLimits } from "../src/homeserver/quota.js";
import {
  startImageWorker,
  submitImageJob,
  getImageJob,
  cancelImageJob,
  imageJobColumns,
  ensureImageJobsSchema,
  type ImageJobSubmission,
} from "../src/homeserver/image-jobs.js";
import type { ParsedImageRequest } from "../src/homeserver/image-request.js";

/**
 * Unit tests for the async image-job store + single-slot worker, driven directly (no HTTP). Covers
 * the content-blind schema invariant, worker serialization, the reserve/reconcile refund paths, and
 * restart recovery.
 */

// ── Mock sidecar with a controllable gate (for the serialization test) ──
let sidecar: Server;
let sidecarPort = 0;
let concurrent = 0;
let maxConcurrent = 0;
let gateEnabled = false;
let releaseGate: (() => void) | null = null;
let mode: "ok" | "fault" | "overreturn" = "ok";

function armGate(): void {
  gateEnabled = true;
}
function openGate(): void {
  gateEnabled = false;
  if (releaseGate) releaseGate();
  releaseGate = null;
}

function startSidecar(): Promise<void> {
  sidecar = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as { n?: number };
      if (gateEnabled) {
        await new Promise<void>((resolve) => {
          releaseGate = resolve;
        });
      }
      concurrent--;
      if (mode === "fault") {
        res.writeHead(500);
        res.end("boom");
        return;
      }
      const reqN = body.n ?? 1;
      // "overreturn" simulates a misbehaving sidecar handing back MORE images than requested.
      const count = mode === "overreturn" ? reqN + 1 : reqN;
      const data = Array.from({ length: count }, (_, i) => ({
        b64_json: Buffer.from(`img-${i}`).toString("base64"),
      }));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ created: 0, data }));
    });
  });
  return new Promise((resolve) =>
    sidecar.listen(0, "127.0.0.1", () => {
      sidecarPort = (sidecar.address() as { port: number }).port;
      resolve();
    })
  );
}

let cfg: HomeserverConfig;
let controller: AdmissionController;
let stopWorker: (() => void) | null = null;

const LIMITS: QuotaLimits = { rpm: 1000, tpm: 0, dailyTokenBudget: 0 };
const PRICE = 200; // credits per balanced image

beforeAll(async () => {
  initDb(join(mkdtempSync(join(tmpdir(), "hs-imgjobs-")), "test.db"));
  await startSidecar();
  cfg = setConfig({
    imageUrl: `http://127.0.0.1:${sidecarPort}`,
    imageJobTimeoutMs: 5000,
    imageGpuSlots: 1,
    imageResultDir: join(mkdtempSync(join(tmpdir(), "hs-imgres-")), "out"),
    imageResultTtlMs: 3_600_000,
    imageCreditsPerImage: { fast: 100, balanced: PRICE, high: 300 },
  });
  ensureImageJobsSchema();
});

afterAll(async () => {
  if (stopWorker) stopWorker();
  await new Promise<void>((r) => sidecar.close(() => r()));
});

beforeEach(() => {
  resetQuotaWindows();
  maxConcurrent = 0;
  concurrent = 0;
  gateEnabled = false;
  releaseGate = null;
  mode = "ok";
});

function freshController(): AdmissionController {
  return new AdmissionController({ maxInflight: 2, ownerQueueMaxMs: 2000, retryAfterAtCapSeconds: 1 });
}

function parsed(n: number): ParsedImageRequest {
  return { model: "image-balanced", tier: "balanced", sync: false, prompt: "a cat", n, size: "1024x1024", responseFormat: "b64_json" };
}

/** Mint a key, take the up-front worst-case reservation the gateway would have taken, build a sub. */
function makeSub(alias: string, n: number, opts: { capped?: boolean } = {}): { sub: ImageJobSubmission; keyHash: string } {
  const capped = opts.capped ?? true;
  const k = mintKey({ alias, tier: "guest", creditLimit: capped ? 1_000_000 : 0 }, { rpm: 1000, tpm: 0, dailyTokenBudget: 0, maxParallel: 2 });
  const keyHash = lookupKey(k.plaintextKey)!.keyHash!;
  const reserved = n * PRICE;
  if (capped) expect(reserveCredits(keyHash, reserved).ok).toBe(true);
  const q = checkQuota(alias, LIMITS, n);
  if (!q.ok) throw new Error("quota unexpectedly rejected");
  const sub: ImageJobSubmission = {
    parsed: parsed(n),
    alias,
    keyHash,
    lane: "guest",
    creditsReserved: capped ? reserved : 0,
    capped,
    creditsPerImage: PRICE,
    quotaReservation: q.reservation,
    backendModel: "sd3.5-large-turbo",
    ownerCapture: false,
  };
  return { sub, keyHash };
}

async function waitForStatus(id: string, principal: { keyHash: string; alias: string }, want: string, timeoutMs = 4000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = getImageJob(id, principal);
    if (v && v.status === want) return v.status;
    if (Date.now() > deadline) return v?.status ?? "missing";
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("image_jobs — content-blind schema", () => {
  it("has NO prompt / size / bytes / response column", () => {
    const cols = imageJobColumns();
    for (const forbidden of ["prompt", "size", "bytes", "b64", "image", "response", "completion", "messages", "content"]) {
      expect(cols).not.toContain(forbidden);
    }
    // It DOES carry accounting + status columns.
    expect(cols).toEqual(expect.arrayContaining(["status", "n", "credits_reserved", "credits_charged", "error_class"]));
  });
});

describe("image_jobs — worker lifecycle", () => {
  beforeEach(() => {
    controller = freshController();
    const w = startImageWorker(cfg, controller);
    stopWorker = w.stop;
  });
  afterEach(() => {
    if (stopWorker) stopWorker();
    stopWorker = null;
  });

  it("runs a job to success and charges delivered × price", async () => {
    const { sub, keyHash } = makeSub("job-ok", 2);
    const view = submitImageJob(controller, sub);
    expect(view.status).toBe("queued");
    expect(view.id).toMatch(/^imgjob_/);
    const status = await waitForStatus(view.id, { keyHash, alias: "job-ok" }, "succeeded");
    expect(status).toBe("succeeded");
    const got = getImageJob(view.id, { keyHash, alias: "job-ok" })!;
    expect(got.data).toHaveLength(2);
    // reserved 2*200=400, delivered 2 → charged 400; net creditsUsed == 400.
    expect(lookupKey2(keyHash).creditsUsed).toBe(400);
  });

  it("clamps billing + result to n when the sidecar over-returns", async () => {
    mode = "overreturn"; // sidecar hands back n+1 images for an n=1 request
    const { sub, keyHash } = makeSub("job-over", 1);
    const view = submitImageJob(controller, sub);
    const status = await waitForStatus(view.id, { keyHash, alias: "job-over" }, "succeeded");
    expect(status).toBe("succeeded");
    const got = getImageJob(view.id, { keyHash, alias: "job-over" })!;
    expect(got.data).toHaveLength(1); // clamped to requested n, not the 2 returned
    // reserved 1*200=200; a sidecar returning 2 must NOT bill 400.
    expect(lookupKey2(keyHash).creditsUsed).toBe(200);
  });

  it("serializes dispatch — the sidecar never sees two jobs at once", async () => {
    armGate();
    const a = makeSub("ser-a", 1);
    const b = makeSub("ser-b", 1);
    const va = submitImageJob(controller, a.sub);
    const vb = submitImageJob(controller, b.sub);
    // Let the worker pick up the first job and block it on the gate.
    await new Promise((r) => setTimeout(r, 100));
    openGate();
    await waitForStatus(va.id, { keyHash: a.keyHash, alias: "ser-a" }, "succeeded");
    await waitForStatus(vb.id, { keyHash: b.keyHash, alias: "ser-b" }, "succeeded");
    expect(maxConcurrent).toBe(1);
  });

  it("refunds fully when the sidecar faults", async () => {
    mode = "fault";
    const { sub, keyHash } = makeSub("job-fault", 3);
    expect(lookupKey2(keyHash).creditsUsed).toBe(3 * PRICE); // reserved up-front
    const view = submitImageJob(controller, sub);
    const status = await waitForStatus(view.id, { keyHash, alias: "job-fault" }, "failed");
    expect(status).toBe("failed");
    expect(lookupKey2(keyHash).creditsUsed).toBe(0); // full refund
  });

  it("cancels a running job and refunds (idempotent)", async () => {
    armGate();
    const { sub, keyHash } = makeSub("job-cancel", 2);
    const view = submitImageJob(controller, sub);
    await new Promise((r) => setTimeout(r, 100)); // worker now blocked on the gate
    const c1 = cancelImageJob(controller, view.id, { keyHash, alias: "job-cancel" });
    expect(c1).toEqual({ found: true, status: "cancelled" });
    expect(lookupKey2(keyHash).creditsUsed).toBe(0); // refunded
    // Idempotent second cancel.
    const c2 = cancelImageJob(controller, view.id, { keyHash, alias: "job-cancel" });
    expect(c2.found).toBe(true);
    expect(lookupKey2(keyHash).creditsUsed).toBe(0);
    openGate();
  });

  it("scopes reads to the creator (cross-key → null)", async () => {
    const { sub, keyHash } = makeSub("owner-key", 1);
    const view = submitImageJob(controller, sub);
    const otherKey = mintKey({ alias: "other-key", tier: "guest", creditLimit: 0 }, { rpm: 1000, tpm: 0, dailyTokenBudget: 0, maxParallel: 2 });
    const otherHash = lookupKey(otherKey.plaintextKey)!.keyHash!;
    expect(getImageJob(view.id, { keyHash: otherHash, alias: "other-key" })).toBeNull();
    expect(getImageJob(view.id, { keyHash, alias: "owner-key" })).not.toBeNull();
  });
});

/** Same as makeSub but an OWNER-lane submission (mirrors gateway construction for owner keys). */
function makeOwnerSub(alias: string, n: number): { sub: ImageJobSubmission; keyHash: string } {
  const k = mintKey({ alias, tier: "owner", creditLimit: 0 }, { rpm: 1000, tpm: 0, dailyTokenBudget: 0, maxParallel: 2 });
  const keyHash = lookupKey(k.plaintextKey)!.keyHash!;
  const q = checkQuota(alias, LIMITS, n);
  if (!q.ok) throw new Error("quota unexpectedly rejected");
  const sub: ImageJobSubmission = {
    parsed: parsed(n),
    alias,
    keyHash,
    lane: "owner",
    creditsReserved: 0,
    capped: false,
    creditsPerImage: PRICE,
    quotaReservation: q.reservation,
    backendModel: "sd3.5-large-turbo",
    ownerCapture: false,
  };
  return { sub, keyHash };
}

// #108 follow-up (found via an overnight discovery sweep): submission is maintenance-gated for
// guests, but the async worker's OWN admission request always uses lane:"owner" (image-jobs.ts
// acquireSlot) regardless of who actually submitted the job — so a guest job already queued
// before maintenance mode engages was never actually blocked from EXECUTING during the window,
// only from being newly submitted. These tests cover the fix: processJob() now pauses a queued
// guest job while maintenance is on, re-checking until it's off (or the job is cancelled).
describe("image_jobs — maintenance mode pauses queued GUEST jobs (#108 follow-up)", () => {
  beforeEach(() => {
    controller = freshController();
    const w = startImageWorker(cfg, controller);
    stopWorker = w.stop;
  });
  afterEach(() => {
    controller.setMaintenanceMode(false); // never leak maintenance state into a later test
    if (stopWorker) stopWorker();
    stopWorker = null;
  });

  it("a guest job queued while maintenance is on does not run until it's turned off", async () => {
    armGate();
    const a = makeSub("maint-a", 1);
    const b = makeSub("maint-b", 1);
    const va = submitImageJob(controller, a.sub);
    const vb = submitImageJob(controller, b.sub);
    await new Promise((r) => setTimeout(r, 100)); // worker picks up A, blocks it on the gate; B queues behind

    controller.setMaintenanceMode(true);
    openGate(); // let A finish — A was already running before maintenance engaged, so it's unaffected
    await waitForStatus(va.id, { keyHash: a.keyHash, alias: "maint-a" }, "succeeded");

    // B is next in line but is a guest job and maintenance is now on — it must NOT start.
    await new Promise((r) => setTimeout(r, 400));
    expect((await getImageJob(vb.id, { keyHash: b.keyHash, alias: "maint-b" }))?.status).toBe("queued");

    controller.setMaintenanceMode(false);
    const status = await waitForStatus(vb.id, { keyHash: b.keyHash, alias: "maint-b" }, "succeeded");
    expect(status).toBe("succeeded");
  });

  it("an OWNER job is NOT head-of-line-blocked by an earlier-queued, paused GUEST job", async () => {
    armGate();
    const blocker = makeSub("maint-hol-blocker", 1);
    const vBlocker = submitImageJob(controller, blocker.sub);
    await new Promise((r) => setTimeout(r, 100)); // worker dispatches the blocker, blocks on the gate

    controller.setMaintenanceMode(true);
    const g = makeSub("maint-hol-guest", 1);
    const o = makeOwnerSub("maint-hol-owner", 1);
    const vg = submitImageJob(controller, g.sub); // queues behind the blocker, will be paused
    const vo = submitImageJob(controller, o.sub); // queues behind the paused guest job

    openGate(); // blocker was already running before maintenance engaged — runs to completion
    await waitForStatus(vBlocker.id, { keyHash: blocker.keyHash, alias: "maint-hol-blocker" }, "succeeded");

    // The owner job must proceed despite arriving AFTER a still-paused guest job — never head-of-
    // line-blocked. The guest job stays queued the whole time (maintenance is still on).
    const ownerStatus = await waitForStatus(vo.id, { keyHash: o.keyHash, alias: "maint-hol-owner" }, "succeeded");
    expect(ownerStatus).toBe("succeeded");
    expect((await getImageJob(vg.id, { keyHash: g.keyHash, alias: "maint-hol-guest" }))?.status).toBe("queued");

    controller.setMaintenanceMode(false);
    await waitForStatus(vg.id, { keyHash: g.keyHash, alias: "maint-hol-guest" }, "succeeded");
  });

  it("cancelling a guest job paused for maintenance still cancels + refunds promptly", async () => {
    armGate();
    const blocker = makeSub("maint-cancel-blocker", 1);
    const target = makeSub("maint-cancel-target", 2);
    const vBlocker = submitImageJob(controller, blocker.sub);
    const vTarget = submitImageJob(controller, target.sub);
    await new Promise((r) => setTimeout(r, 100)); // blocker running+gated; target queued behind it

    controller.setMaintenanceMode(true);
    openGate();
    await waitForStatus(vBlocker.id, { keyHash: blocker.keyHash, alias: "maint-cancel-blocker" }, "succeeded");
    await new Promise((r) => setTimeout(r, 150)); // target is now the paused-for-maintenance guest job

    const c = cancelImageJob(controller, vTarget.id, { keyHash: target.keyHash, alias: "maint-cancel-target" });
    expect(c).toEqual({ found: true, status: "cancelled" });
    expect(lookupKey2(target.keyHash).creditsUsed).toBe(0); // refunded even though it never ran
  });
});

describe("image_jobs — restart recovery", () => {
  it("marks an orphaned running row failed and refunds its reserved credits", () => {
    const k = mintKey({ alias: "orphan", tier: "guest", creditLimit: 1_000_000 }, { rpm: 1000, tpm: 0, dailyTokenBudget: 0, maxParallel: 2 });
    const keyHash = lookupKey(k.plaintextKey)!.keyHash!;
    const reserved = 5 * PRICE;
    reserveCredits(keyHash, reserved);
    expect(lookupKey2(keyHash).creditsUsed).toBe(reserved);
    // Simulate a crash mid-flight: a 'running' row with no in-memory spec.
    getDb()
      .prepare(
        `INSERT INTO image_jobs (id, ts, alias, key_hash, tier, model, status, n, credits_reserved, expires_at)
         VALUES ('imgjob_orphan', ?, 'orphan', ?, 'guest', 'image-balanced', 'running', 5, ?, ?)`
      )
      .run(Date.now(), keyHash, reserved, Date.now() + 3_600_000);

    const c = freshController();
    const w = startImageWorker(cfg, c); // runs recovery
    const row = getDb().prepare(`SELECT status, error_class FROM image_jobs WHERE id = 'imgjob_orphan'`).get() as {
      status: string;
      error_class: string | null;
    };
    expect(row.status).toBe("failed");
    expect(row.error_class).toBe("interrupted");
    expect(lookupKey2(keyHash).creditsUsed).toBe(0); // refunded
    w.stop();
  });

  it("also refunds the daily quota reservation on restart recovery", () => {
    const alias = "orphan-quota";
    const k = mintKey({ alias, tier: "guest", creditLimit: 1_000_000 }, { rpm: 1000, tpm: 0, dailyTokenBudget: 0, maxParallel: 2 });
    const keyHash = lookupKey(k.plaintextKey)!.keyHash!;
    const reserved = 4 * PRICE;
    reserveCredits(keyHash, reserved);
    // Take a real daily quota reservation (4 image-units), as the gateway handler does at submit.
    const q = checkQuota(alias, LIMITS, 4);
    if (!q.ok) throw new Error("quota unexpectedly rejected");
    const day = q.reservation.day;
    expect(dailyTokens(alias, day)).toBe(4); // reserved up-front
    // Crash mid-flight: a 'running' row carrying the quota handles, with no in-memory spec.
    getDb()
      .prepare(
        `INSERT INTO image_jobs
           (id, ts, alias, key_hash, tier, model, status, n, credits_reserved, quota_alias, quota_day, quota_reserved_daily, expires_at)
         VALUES ('imgjob_orphan_q', ?, ?, ?, 'guest', 'image-balanced', 'running', 4, ?, ?, ?, ?, ?)`
      )
      .run(Date.now(), alias, keyHash, reserved, alias, day, q.reservation.reservedDaily, Date.now() + 3_600_000);

    const c = freshController();
    const w = startImageWorker(cfg, c); // runs recovery
    expect(lookupKey2(keyHash).creditsUsed).toBe(0); // credits refunded (prior behavior)
    expect(dailyTokens(alias, day)).toBe(0);          // daily quota ALSO refunded (the fix)
    w.stop();
  });

  it("the no-spec cancel path also refunds the daily quota", () => {
    const alias = "cancel-nospec";
    const k = mintKey({ alias, tier: "guest", creditLimit: 1_000_000 }, { rpm: 1000, tpm: 0, dailyTokenBudget: 0, maxParallel: 2 });
    const keyHash = lookupKey(k.plaintextKey)!.keyHash!;
    const reserved = 3 * PRICE;
    reserveCredits(keyHash, reserved);
    const q = checkQuota(alias, LIMITS, 3);
    if (!q.ok) throw new Error("quota unexpectedly rejected");
    const day = q.reservation.day;
    const c = freshController();
    const w = startImageWorker(cfg, c); // recovery runs now; the row below is inserted AFTER
    // A 'running' row with NO in-memory spec (its worker process is gone), carrying the quota handles.
    getDb()
      .prepare(
        `INSERT INTO image_jobs
           (id, ts, alias, key_hash, tier, model, status, n, credits_reserved, quota_alias, quota_day, quota_reserved_daily, expires_at)
         VALUES ('imgjob_cancel_nospec', ?, ?, ?, 'guest', 'image-balanced', 'running', 3, ?, ?, ?, ?, ?)`
      )
      .run(Date.now(), alias, keyHash, reserved, alias, day, q.reservation.reservedDaily, Date.now() + 3_600_000);
    const res = cancelImageJob(c, "imgjob_cancel_nospec", { keyHash, alias });
    expect(res.status).toBe("cancelled");
    expect(lookupKey2(keyHash).creditsUsed).toBe(0); // credits refunded
    expect(dailyTokens(alias, day)).toBe(0);          // daily quota refunded (the fix)
    w.stop();
  });

  it("refunds daily for a pre-migration orphan row (NULL quota_day/reserved) via n+ts fallback", () => {
    const alias = "orphan-premig";
    const k = mintKey({ alias, tier: "guest", creditLimit: 1_000_000 }, { rpm: 1000, tpm: 0, dailyTokenBudget: 0, maxParallel: 2 });
    const keyHash = lookupKey(k.plaintextKey)!.keyHash!;
    const reserved = 2 * PRICE;
    reserveCredits(keyHash, reserved);
    const ts = Date.now();
    const q = checkQuota(alias, LIMITS, 2, ts); // reserve 2 daily on dayKey(ts)
    if (!q.ok) throw new Error("quota unexpectedly rejected");
    const day = q.reservation.day;
    expect(dailyTokens(alias, day)).toBe(2);
    // Pre-migration orphan: quota_day / quota_reserved_daily are NULL → recovery infers from n + ts.
    getDb()
      .prepare(
        `INSERT INTO image_jobs
           (id, ts, alias, key_hash, tier, model, status, n, credits_reserved, quota_alias, expires_at)
         VALUES ('imgjob_premig', ?, ?, ?, 'guest', 'image-balanced', 'running', 2, ?, ?, ?)`
      )
      .run(ts, alias, keyHash, reserved, alias, ts + 3_600_000);
    const c = freshController();
    const w = startImageWorker(cfg, c); // recovery
    expect(lookupKey2(keyHash).creditsUsed).toBe(0);
    expect(dailyTokens(alias, day)).toBe(0); // refunded via fallback (reservedDaily=n=2, day=dayKey(ts))
    w.stop();
  });
});

// Read the persisted daily quota counter for an alias/day (what recovery must refund).
function dailyTokens(alias: string, day: string): number {
  const row = getDb()
    .prepare(`SELECT tokens FROM key_usage_daily WHERE alias = ? AND day = ?`)
    .get(alias, day) as { tokens: number } | undefined;
  return row?.tokens ?? 0;
}

// Local helper (avoids a non-null assertion littering each call site).
function lookupKey2(keyHash: string): { creditsUsed: number } {
  const row = getDb().prepare(`SELECT credits_used FROM api_keys WHERE key_hash = ?`).get(keyHash) as { credits_used: number };
  return { creditsUsed: row.credits_used };
}
