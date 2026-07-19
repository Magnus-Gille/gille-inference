import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb, getDb } from "../src/db.js";

/**
 * Feedback endpoint suite: POST /portal/feedback
 *
 * Isolated suite with its own HOMESERVER_FEEDBACK_FILE and low per-IP limit so throttle
 * behaviour can be tested. Config is cached at first import so all env vars are set BEFORE
 * any dynamic import. A fresh throwaway DB is used per the project convention.
 *
 * Covers:
 *  1. Valid text → 200 + a JSONL line appended to the feedback file with correct fields.
 *  2. Empty / whitespace-only text → 400 (enveloped).
 *  3. Over-length text → 400 (enveloped).
 *  4. Rapid repeats from same IP → 429 with Retry-After.
 *  5. Authenticated POST records the alias; unauthenticated → alias null.
 *  6. Portal HTML contains the feedback textarea + submit button.
 *  7. Feedback text NEVER appears in /metrics output (F3: also not in request_log).
 *  8. page field is capped at 512 chars (F1).
 *  9. Disk-write failure NEVER surfaces as an HTTP error — POST still returns 200 (F2).
 * 10. text validation uses trimmed basis consistently (F4).
 */

const FEEDBACK_LIMIT = 3; // HOMESERVER_FEEDBACK_RPM for this suite

let feedbackFile: string;

let mintKey: typeof import("../src/homeserver/keystore.js").mintKey;
let gatewayPort = 0;
let stopGateway: (() => Promise<void>) | null = null;
let resetRateWindows: typeof import("../src/homeserver/quota.js").resetRateWindows;

const DEFAULTS = { rpm: 1000, tpm: 1_000_000, dailyTokenBudget: 0, maxParallel: 2 };

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "hs-feedback-test-"));
  feedbackFile = join(dir, "feedback.jsonl");
  initDb(join(dir, "test.db"));

  process.env["HOMESERVER_HOST"] = "127.0.0.1";
  process.env["HOMESERVER_PORT"] = "0";
  process.env["HOMESERVER_FEEDBACK_FILE"] = feedbackFile;
  process.env["HOMESERVER_FEEDBACK_RPM"] = String(FEEDBACK_LIMIT);
  // High public-surface throttle so portal GET / redeem tests are not affected.
  process.env["HOMESERVER_REDEEM_RPM"] = "10000";
  process.env["HOMESERVER_PUBLIC_WINDOW_MS"] = "600000";
  // Point LM Studio somewhere harmless — no inference runs in this suite.
  process.env["LMSTUDIO_BASE_URL"] = "http://127.0.0.1:1/v1";
  delete process.env["HOMESERVER_API_KEYS"];
  delete process.env["HOMESERVER_ADMIN_API_KEYS"];

  const ks = await import("../src/homeserver/keystore.js");
  mintKey = ks.mintKey;
  // Seed a store key so the gateway does not bootstrap implicit-admin on loopback.
  mintKey({ alias: "feedback-seed-owner", tier: "owner" }, DEFAULTS);

  const quota = await import("../src/homeserver/quota.js");
  resetRateWindows = quota.resetRateWindows;

  const gw = await import("../src/homeserver/gateway.js");
  const handle = await gw.startGateway();
  gatewayPort = handle.port;
  stopGateway = handle.stop;
});

afterAll(async () => {
  if (stopGateway) await stopGateway();
});

// Reset per-IP rate windows between tests so throttle tests don't bleed into each other.
beforeEach(() => {
  resetRateWindows();
});

function url(path: string): string {
  return `http://127.0.0.1:${gatewayPort}${path}`;
}

function postFeedback(text: string, key?: string, page?: string): Promise<Response> {
  const body: Record<string, unknown> = { text };
  if (page !== undefined) body["page"] = page;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key) headers["authorization"] = `Bearer ${key}`;
  return fetch(url("/portal/feedback"), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function readFeedbackLines(): Array<Record<string, unknown>> {
  if (!existsSync(feedbackFile)) return [];
  return readFileSync(feedbackFile, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

// ─── Core happy path ────────────────────────────────────────────────────────────────────

describe("POST /portal/feedback — happy path", () => {
  it("valid text → 200 { ok: true } and appends a JSONL line", async () => {
    const res = await postFeedback("Something broke on the redeem page", undefined, "/portal");
    expect(res.status).toBe(200);
    const j = (await res.json()) as { ok: boolean };
    expect(j.ok).toBe(true);

    const lines = readFeedbackLines();
    const last = lines[lines.length - 1]!;
    expect(typeof last["ts"]).toBe("number");
    expect(last["text"]).toBe("Something broke on the redeem page");
    expect(last["alias"]).toBeNull();
    expect(last["page"]).toBe("/portal");
  });

  it("appended line has ts, text, alias, userAgent, page fields", async () => {
    const res = await postFeedback("Test message for field check");
    expect(res.status).toBe(200);

    const lines = readFeedbackLines();
    const last = lines[lines.length - 1]!;
    expect(Object.keys(last).sort()).toEqual(["alias", "page", "text", "ts", "userAgent"].sort());
    expect(typeof last["ts"]).toBe("number");
    expect(last["ts"]).toBeGreaterThan(0);
  });

  it("authenticated POST records the alias instead of null", async () => {
    const { plaintextKey, record } = mintKey({ alias: "fb-auth-user", tier: "guest", creditLimit: 0 }, DEFAULTS);
    const res = await postFeedback("I am logged in", plaintextKey, "/");
    expect(res.status).toBe(200);

    const lines = readFeedbackLines();
    const last = lines[lines.length - 1]!;
    expect(last["alias"]).toBe(record.alias);
    expect(last["text"]).toBe("I am logged in");
  });

  it("multiple valid POSTs each append a new line (accumulate)", async () => {
    const before = readFeedbackLines().length;
    await postFeedback("line A");
    await postFeedback("line B");
    const after = readFeedbackLines();
    expect(after.length).toBe(before + 2);
  });

  it("page field is optional — omitting it leaves page null", async () => {
    const res = await postFeedback("no page given");
    expect(res.status).toBe(200);
    const lines = readFeedbackLines();
    const last = lines[lines.length - 1]!;
    // page may be null or undefined when omitted
    expect(last["page"] === null || last["page"] === undefined).toBe(true);
  });
});

// ─── Validation errors ──────────────────────────────────────────────────────────────────

describe("POST /portal/feedback — validation", () => {
  it("empty string → 400 enveloped", async () => {
    const res = await postFeedback("");
    expect(res.status).toBe(400);
    const j = (await res.json()) as { error: { code: string; type: string } };
    expect(j.error.type).toBe("invalid_request_error");
  });

  it("whitespace-only text → 400 enveloped", async () => {
    const res = await postFeedback("   \n\t  ");
    expect(res.status).toBe(400);
    const j = (await res.json()) as { error: { code: string } };
    expect(j.error.type).toBe("invalid_request_error");
  });

  it("missing text field → 400 enveloped", async () => {
    const res = await fetch(url("/portal/feedback"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ page: "/foo" }), // no text
    });
    expect(res.status).toBe(400);
  });

  it("text over 4000 chars → 400 enveloped", async () => {
    const long = "x".repeat(4001);
    const res = await postFeedback(long);
    expect(res.status).toBe(400);
    const j = (await res.json()) as { error: { code: string; message: string } };
    expect(j.error.type).toBe("invalid_request_error");
  });

  it("text at exactly 4000 chars → 200 (boundary)", async () => {
    const exactly = "a".repeat(4000);
    const res = await postFeedback(exactly);
    expect(res.status).toBe(200);
  });
});

// ─── Per-IP throttle ────────────────────────────────────────────────────────────────────

describe("POST /portal/feedback — per-IP throttle", () => {
  it("first LIMIT requests pass; the (LIMIT+1)th is 429 with Retry-After", async () => {
    for (let i = 0; i < FEEDBACK_LIMIT; i++) {
      const r = await postFeedback(`allowed attempt ${i}`);
      expect(r.status).toBe(200);
    }
    const blocked = await postFeedback("this should be throttled");
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBeTruthy();
    const j = (await blocked.json()) as { error: { code: string; type: string } };
    expect(j.error.code).toBe("rate_limit_exceeded");
    expect(j.error.type).toBe("rate_limit_error");
  });
});

// ─── Portal HTML content ────────────────────────────────────────────────────────────────

describe("Portal HTML — feedback UI", () => {
  it("GET /portal HTML contains the feedback textarea", async () => {
    const res = await fetch(url("/portal"));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("<textarea");
    expect(body).toContain("feedback");
  });

  it("GET /portal HTML contains a submit button for the feedback form", async () => {
    const res = await fetch(url("/portal"));
    const body = await res.text();
    // The button for feedback submission.
    expect(body).toContain("/portal/feedback");
  });
});

// ─── Metrics do NOT contain feedback text ───────────────────────────────────────────────

describe("Metrics isolation", () => {
  it("feedback text does NOT appear in /metrics output", async () => {
    const SENTINEL = "unique_sentinel_string_xzq99";
    const { plaintextKey } = mintKey({ alias: "fb-metrics-owner", tier: "owner" }, DEFAULTS);
    await postFeedback(SENTINEL, plaintextKey);

    // Fetch metrics — must be authenticated (admin endpoint).
    const metricsRes = await fetch(url("/metrics"), {
      headers: { authorization: `Bearer ${plaintextKey}` },
    });
    expect(metricsRes.status).toBe(200);
    const metricsBody = await metricsRes.text();
    expect(metricsBody).not.toContain(SENTINEL);
  });

  // F3: sentinel must also be absent from the durable content-blind request_log table.
  it("feedback text does NOT appear in the durable request_log (F3)", async () => {
    const SENTINEL = "unique_sentinel_rlog_f3_xqz77";
    const { plaintextKey } = mintKey({ alias: "fb-rlog-owner", tier: "owner" }, DEFAULTS);
    await postFeedback(SENTINEL, plaintextKey);

    // Fetch /metrics to confirm it's absent there too (belt-and-suspenders).
    const metricsRes = await fetch(url("/metrics"), {
      headers: { authorization: `Bearer ${plaintextKey}` },
    });
    expect(metricsRes.status).toBe(200);
    const metricsBody = await metricsRes.text();
    expect(metricsBody).not.toContain(SENTINEL);

    // Crucially: the sentinel must NOT appear in any serialised column of request_log.
    // We cast all text columns to a combined string and LIKE-search for the sentinel.
    const db = getDb();
    const hit = db
      .prepare(
        `SELECT COUNT(*) AS n FROM request_log
         WHERE CAST(route AS TEXT) LIKE @s
            OR CAST(alias AS TEXT) LIKE @s
            OR CAST(outcome AS TEXT) LIKE @s
            OR CAST(error_class AS TEXT) LIKE @s`
      )
      .get({ s: `%${SENTINEL}%` }) as { n: number };
    expect(hit.n).toBe(0);
  });
});

// ─── F1: page field is capped at 512 chars ──────────────────────────────────────────────

describe("POST /portal/feedback — page field truncation (F1)", () => {
  it("a page value over 512 chars is stored truncated to <= 512 chars", async () => {
    const longPage = "/".repeat(600);
    const res = await postFeedback("feedback with long page", undefined, longPage);
    expect(res.status).toBe(200);

    const lines = readFeedbackLines();
    const last = lines[lines.length - 1]!;
    const stored = last["page"] as string;
    expect(typeof stored).toBe("string");
    expect(stored.length).toBeLessThanOrEqual(512);
    expect(stored.length).toBe(512); // exactly capped
  });

  it("a page value at exactly 512 chars is stored verbatim (boundary)", async () => {
    const exactPage = "p".repeat(512);
    const res = await postFeedback("feedback with exact page", undefined, exactPage);
    expect(res.status).toBe(200);

    const lines = readFeedbackLines();
    const last = lines[lines.length - 1]!;
    expect(last["page"]).toBe(exactPage);
  });

  it("a page value under 512 chars is stored verbatim (short path)", async () => {
    const shortPage = "/portal/redeem";
    const res = await postFeedback("feedback with short page", undefined, shortPage);
    expect(res.status).toBe(200);

    const lines = readFeedbackLines();
    const last = lines[lines.length - 1]!;
    expect(last["page"]).toBe(shortPage);
  });
});

// ─── F2: disk-write failure NEVER surfaces as an HTTP error ─────────────────────────────

describe("POST /portal/feedback — write failure resilience (F2)", () => {
  it("POST returns 200 {ok:true} even when the feedback file path is unwritable (F2)", async () => {
    // Save the original path and point HOMESERVER_FEEDBACK_FILE at a DIRECTORY
    // so appendFileSync will throw EISDIR — simulating a disk/permission failure.
    const originalPath = process.env["HOMESERVER_FEEDBACK_FILE"];
    const dir = mkdtempSync(join(tmpdir(), "hs-feedback-dir-"));
    // dir itself is a directory — writing to it will fail with EISDIR.
    process.env["HOMESERVER_FEEDBACK_FILE"] = dir;
    try {
      const res = await postFeedback("this write will fail");
      expect(res.status).toBe(200);
      const j = (await res.json()) as { ok: boolean };
      expect(j.ok).toBe(true);
    } finally {
      // Restore to not affect subsequent tests.
      if (originalPath !== undefined) {
        process.env["HOMESERVER_FEEDBACK_FILE"] = originalPath;
      } else {
        delete process.env["HOMESERVER_FEEDBACK_FILE"];
      }
    }
  });
});

// ─── F4: validation uses trimmed basis consistently ─────────────────────────────────────

describe("POST /portal/feedback — consistent trim-based validation (F4)", () => {
  it("text of exactly 4000 non-whitespace chars → 200 (trimmed length == stored length)", async () => {
    const exactly = "b".repeat(4000);
    const res = await postFeedback(exactly);
    expect(res.status).toBe(200);
  });

  it("text with leading/trailing whitespace padding raw length to 4001 but trimmed <= 4000 → 200", async () => {
    // ' ' + 3999 'c's + ' ' == raw length 4001, trimmed length 3999 — should pass.
    const padded = " " + "c".repeat(3999) + " ";
    expect(padded.length).toBe(4001);
    expect(padded.trim().length).toBe(3999);
    const res = await postFeedback(padded);
    expect(res.status).toBe(200);
  });

  it("trimmed text of 4001 chars → 400 (over limit regardless of outer whitespace)", async () => {
    // Build a purely non-whitespace string of 4001 chars.
    const long = "d".repeat(4001);
    const res = await postFeedback(long);
    expect(res.status).toBe(400);
  });
});
