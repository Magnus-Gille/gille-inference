import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { connect as netConnect } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../src/db.js";
import { getRequestLog } from "../src/homeserver/request-log.js";
import { getOwnerLog } from "../src/homeserver/owner-log.js";
import { renderMetrics } from "../src/homeserver/metrics.js";

/**
 * POST /v1/audio/transcriptions — OpenAI Whisper-compatible speech-to-text.
 *
 * A MOCK whisper-server stands in for the box's whisper-server (127.0.0.1:8092). It accepts the
 * multipart /inference POST and returns a verbose_json body with a KNOWN top-level `duration`,
 * so the test can assert the audio-seconds metering exactly. The unique transcript text
 * SECRET_TRANSCRIPT_MARKER is used to prove the transcript never lands in request_log / metrics.
 */

const KNOWN_DURATION = 12.3; // seconds → ceil = 13
const SECRET_TRANSCRIPT_MARKER = "ZZZ_SECRET_TRANSCRIPT_MARKER_ that must never be logged ZZZ";

let whisper: Server;
let whisperPort = 0;
// The duration the mock backend reports in its verbose_json. Tests override this to exercise the
// reconcile path (a valid duration) vs. the FAULT path (a bogus / zero / missing / over-cap value).
// `undefined` here means the backend OMITS the top-level `duration` field entirely.
let whisperDuration: number | undefined = KNOWN_DURATION;
// Records what the gateway forwarded so we can assert response_format=verbose_json is always sent.
let lastForwardedContentType = "";
let lastForwardedBody = Buffer.alloc(0);

function startWhisper(): Promise<void> {
  whisper = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (!(req.url || "").startsWith("/inference")) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    lastForwardedContentType = String(req.headers["content-type"] ?? "");
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      lastForwardedBody = Buffer.concat(chunks);
      // Whisper-server always returns verbose_json here (the gateway always asks for it).
      const payload: Record<string, unknown> = {
        task: "transcribe",
        language: "sv",
        text: SECRET_TRANSCRIPT_MARKER,
        segments: [
          { id: 0, start: 0.0, end: KNOWN_DURATION, text: SECRET_TRANSCRIPT_MARKER },
        ],
      };
      // Only include the top-level `duration` when set — `undefined` simulates a backend that
      // ignored verbose_json and omitted it entirely.
      if (whisperDuration !== undefined) payload["duration"] = whisperDuration;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    });
  });
  return new Promise((resolve) =>
    whisper.listen(0, "127.0.0.1", () => {
      whisperPort = (whisper.address() as { port: number }).port;
      resolve();
    })
  );
}

let startGateway: typeof import("../src/homeserver/gateway.js").startGateway;
let mintKey: typeof import("../src/homeserver/keystore.js").mintKey;
let lookupKey: typeof import("../src/homeserver/keystore.js").lookupKey;
let setConfig: typeof import("../src/homeserver/config.js").setConfig;
let resetQuotaWindows: typeof import("../src/homeserver/quota.js").resetQuotaWindows;

let gatewayPort = 0;
let stopGateway: (() => Promise<void>) | null = null;

// A second gateway whose whisper URL points at a dead port (connection refused on every call).
let deadPort = 0;
let downGatewayPort = 0;
let stopDownGateway: (() => Promise<void>) | null = null;

const RATE = 50; // HOMESERVER_AUDIO_CREDITS_PER_SECOND
// Small cap so the worst-case reservation (AUDIO_MAX_SECONDS * RATE) is easy to reason about in the
// overdraft test: 60 * 50 = 3000 credits reserved up-front before any transcription runs.
const AUDIO_MAX_SECONDS = 60;
const AUDIO_MAX_BYTES = 64 * 1024; // 64 KiB upload cap for the 413 test
const DEFAULTS = { rpm: 1000, tpm: 1_000_000, dailyTokenBudget: 0, maxParallel: 2 };

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "hs-audio-test-"));
  initDb(join(dir, "test.db"));
  await startWhisper();

  // A dead port for the upstream-down case.
  await new Promise<void>((resolve) => {
    const probe = createServer(() => {});
    probe.listen(0, "127.0.0.1", () => {
      deadPort = (probe.address() as { port: number }).port;
      probe.close(() => resolve());
    });
  });

  process.env["LMSTUDIO_BASE_URL"] = "http://127.0.0.1:1/v1"; // unused by these tests
  process.env["HOMESERVER_HOST"] = "127.0.0.1";
  process.env["HOMESERVER_PORT"] = "0";
  process.env["HOMESERVER_WHISPER_URL"] = `http://127.0.0.1:${whisperPort}`;
  process.env["HOMESERVER_AUDIO_CREDITS_PER_SECOND"] = String(RATE);
  process.env["HOMESERVER_AUDIO_MAX_SECONDS"] = String(AUDIO_MAX_SECONDS);
  process.env["HOMESERVER_AUDIO_MAX_BYTES"] = String(AUDIO_MAX_BYTES);
  process.env["HOMESERVER_KEY_DEFAULT_RPM"] = "1000";
  process.env["HOMESERVER_KEY_DEFAULT_TPM"] = "1000000";
  process.env["HOMESERVER_ADMIN_API_KEYS"] = "admin-static-key";
  process.env["HOMESERVER_API_KEYS"] = "legacy-user-key";

  const gw = await import("../src/homeserver/gateway.js");
  const ks = await import("../src/homeserver/keystore.js");
  const cfgMod = await import("../src/homeserver/config.js");
  const q = await import("../src/homeserver/quota.js");
  startGateway = gw.startGateway;
  mintKey = ks.mintKey;
  lookupKey = ks.lookupKey;
  setConfig = cfgMod.setConfig;
  resetQuotaWindows = q.resetQuotaWindows;

  const handle = await startGateway();
  gatewayPort = handle.port;
  stopGateway = handle.stop;

  // Second gateway pointed at the dead whisper port.
  cfgMod.setConfig({ whisperUrl: `http://127.0.0.1:${deadPort}` });
  const down = await startGateway();
  downGatewayPort = down.port;
  stopDownGateway = down.stop;

  // Restore the live whisper URL for the primary gateway.
  cfgMod.setConfig({ whisperUrl: `http://127.0.0.1:${whisperPort}` });
});

afterAll(async () => {
  if (stopGateway) await stopGateway();
  if (stopDownGateway) await stopDownGateway();
  await new Promise<void>((r) => whisper.close(() => r()));
});

beforeEach(() => {
  whisperDuration = KNOWN_DURATION;
  resetQuotaWindows();
});

/** Post a transcription request with a FormData body (Node's native FormData → binary-safe). */
async function transcribe(
  port: number,
  token: string | null,
  opts: { file?: Buffer; fields?: Record<string, string> } = {}
): Promise<Response> {
  const form = new FormData();
  if (opts.file !== undefined) {
    form.append("file", new Blob([opts.file], { type: "audio/wav" }), "clip.wav");
  }
  for (const [k, v] of Object.entries(opts.fields ?? {})) form.append(k, v);
  const headers: Record<string, string> = {};
  if (token !== null) headers["authorization"] = `Bearer ${token}`;
  return fetch(`http://127.0.0.1:${port}/v1/audio/transcriptions`, {
    method: "POST",
    headers,
    body: form,
  });
}

const fakeAudio = (): Buffer => Buffer.from("RIFF....WAVEfmt fake-audio-bytes", "utf-8");

/**
 * Send a raw HTTP/1.1 request over a TCP socket and return the parsed status line + body. Needed
 * for the Content-Length-mismatch (413) case, which fetch() forbids client-side. The server should
 * respond on the declared Content-Length without waiting for the full (never-sent) body.
 */
function rawPost(port: number, request: string): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host: "127.0.0.1", port }, () => {
      socket.write(request);
    });
    let buf = "";
    socket.setEncoding("utf-8");
    socket.on("data", (d: string) => {
      buf += d;
    });
    socket.on("error", reject);
    socket.on("close", () => {
      const statusLine = buf.split("\r\n", 1)[0] ?? "";
      const m = /HTTP\/1\.\d\s+(\d{3})/.exec(statusLine);
      const sep = buf.indexOf("\r\n\r\n");
      resolve({
        statusCode: m ? Number(m[1]) : 0,
        body: sep === -1 ? "" : buf.slice(sep + 4),
      });
    });
    // Safety: don't hang the suite if the server never responds.
    socket.setTimeout(5000, () => {
      socket.destroy();
      reject(new Error("rawPost timed out"));
    });
  });
}

function lastLog(alias: string): ReturnType<typeof getRequestLog>[number] | undefined {
  return getRequestLog(500).find((r) => r.alias === alias);
}

describe("POST /v1/audio/transcriptions", () => {
  it("rejects an unauthenticated request with 401", async () => {
    const res = await transcribe(gatewayPort, null, { file: fakeAudio() });
    expect(res.status).toBe(401);
    const j = (await res.json()) as { error: { code: string } };
    expect(j.error.code).toBe("invalid_api_key");
  });

  it("returns the default json shape {text} and debits ceil(duration)*rate credits", async () => {
    const k = mintKey({ alias: "aud-json", tier: "guest", creditLimit: 1_000_000 }, DEFAULTS);
    expect(lookupKey(k.plaintextKey)!.creditsUsed).toBe(0);

    const res = await transcribe(gatewayPort, k.plaintextKey, { file: fakeAudio() });
    expect(res.status).toBe(200);
    const j = (await res.json()) as Record<string, unknown>;
    // Default response_format=json → exactly {text}, no verbose fields.
    expect(j["text"]).toBe(SECRET_TRANSCRIPT_MARKER);
    expect(j["segments"]).toBeUndefined();
    expect(j["duration"]).toBeUndefined();

    // Metering: ceil(12.3)=13 * 50 = 650 credits.
    expect(lookupKey(k.plaintextKey)!.creditsUsed).toBe(Math.ceil(KNOWN_DURATION) * RATE);
  });

  it("always forwards response_format=verbose_json to the backend (so duration is available)", async () => {
    const k = mintKey({ alias: "aud-fwd", tier: "guest", creditLimit: 1_000_000 }, DEFAULTS);
    // Client asks for plain json, but the backend must still be asked for verbose_json.
    await transcribe(gatewayPort, k.plaintextKey, { file: fakeAudio(), fields: { response_format: "json" } });
    expect(lastForwardedContentType).toMatch(/multipart\/form-data/);
    const forwarded = lastForwardedBody.toString("utf-8");
    expect(forwarded).toMatch(/name="response_format"\r\n\r\nverbose_json/);
    // The audio file part was forwarded under name="file".
    expect(forwarded).toMatch(/name="file"/);
  });

  it("returns full verbose_json when the client requests it", async () => {
    const k = mintKey({ alias: "aud-verbose", tier: "guest", creditLimit: 1_000_000 }, DEFAULTS);
    const res = await transcribe(gatewayPort, k.plaintextKey, {
      file: fakeAudio(),
      fields: { response_format: "verbose_json" },
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as Record<string, unknown>;
    expect(j["text"]).toBe(SECRET_TRANSCRIPT_MARKER);
    expect(j["duration"]).toBe(KNOWN_DURATION);
    expect(Array.isArray(j["segments"])).toBe(true);
    expect(j["task"]).toBe("transcribe");
  });

  it("returns a plain-text body when response_format=text", async () => {
    const k = mintKey({ alias: "aud-text", tier: "guest", creditLimit: 1_000_000 }, DEFAULTS);
    const res = await transcribe(gatewayPort, k.plaintextKey, {
      file: fakeAudio(),
      fields: { response_format: "text" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const body = await res.text();
    expect(body.trim()).toBe(SECRET_TRANSCRIPT_MARKER);
  });

  it("rejects a missing file with a 400 OpenAI-shaped error", async () => {
    const k = mintKey({ alias: "aud-nofile", tier: "guest", creditLimit: 1_000_000 }, DEFAULTS);
    const res = await transcribe(gatewayPort, k.plaintextKey, { fields: { model: "whisper-1" } });
    expect(res.status).toBe(400);
    const j = (await res.json()) as { error: { code: string; param: string | null } };
    expect(j.error.code).toBe("invalid_request_error");
    expect(j.error.param).toBe("file");
    // No charge for a rejected request.
    expect(lookupKey(k.plaintextKey)!.creditsUsed).toBe(0);
  });

  it("rejects a near-cap key with 402 from the UP-FRONT reservation and never transcribes / overdrafts", async () => {
    // creditLimit below the worst-case reservation (AUDIO_MAX_SECONDS*RATE = 3000): the atomic
    // reserveCredits() up-front must fail, returning 402 BEFORE any transcription runs.
    const creditLimit = 100; // < 3000 worst-case → reservation cannot succeed
    const k = mintKey({ alias: "aud-nearcap", tier: "guest", creditLimit }, DEFAULTS);
    expect(lookupKey(k.plaintextKey)!.creditsUsed).toBe(0);

    const res = await transcribe(gatewayPort, k.plaintextKey, { file: fakeAudio() });
    expect(res.status).toBe(402);
    const j = (await res.json()) as { error: { code: string } };
    expect(j.error.code).toBe("credits_exhausted");

    // OVERDRAFT INVARIANT: the rejected request must not be transcribed and must not move the
    // credit ledger — creditsUsed stays 0 and never exceeds creditLimit.
    expect(lookupKey(k.plaintextKey)!.creditsUsed).toBe(0);
    expect(lookupKey(k.plaintextKey)!.creditsUsed).toBeLessThanOrEqual(creditLimit);
  });

  it("a long clip on a near-cap key can NEVER overdraft (creditsUsed <= creditLimit)", async () => {
    // Backend reports a duration ABOVE audioMaxSeconds — a bogus / over-cap value. Even so, the
    // up-front reservation (3000) already exceeds this small cap, so the request is refused 402 and
    // the ledger is untouched. This pins the HIGH overdraft finding.
    whisperDuration = AUDIO_MAX_SECONDS * 100; // wildly over the cap
    const creditLimit = 2999; // one short of the 3000 worst-case reservation
    const k = mintKey({ alias: "aud-longclip", tier: "guest", creditLimit }, DEFAULTS);

    const res = await transcribe(gatewayPort, k.plaintextKey, { file: fakeAudio() });
    expect(res.status).toBe(402);
    expect(lookupKey(k.plaintextKey)!.creditsUsed).toBeLessThanOrEqual(creditLimit);
    expect(lookupKey(k.plaintextKey)!.creditsUsed).toBe(0);
  });

  it("writes a content-blind request_log row (audio seconds + outcome, NO transcript)", async () => {
    const k = mintKey({ alias: "aud-log", tier: "guest", creditLimit: 1_000_000 }, DEFAULTS);
    const res = await transcribe(gatewayPort, k.plaintextKey, { file: fakeAudio() });
    expect(res.status).toBe(200);

    const row = lastLog("aud-log");
    expect(row).toBeDefined();
    expect(row!.route).toBe("/v1/audio/transcriptions");
    expect(row!.outcome).toBe("ok");
    expect(row!.status).toBe(200);
    // Audio seconds recorded (we reuse total_tokens to carry ceil(duration) seconds — a numeric,
    // content-blind field). 13 seconds.
    expect(row!.totalTokens).toBe(Math.ceil(KNOWN_DURATION));

    // PRIVACY: the transcript text appears NOWHERE in any request_log row.
    const allLogs = JSON.stringify(getRequestLog(500));
    expect(allLogs).not.toContain(SECRET_TRANSCRIPT_MARKER);
  });

  it("PRIVACY: the transcript text never appears in /metrics", async () => {
    const k = mintKey({ alias: "aud-metrics", tier: "guest", creditLimit: 1_000_000 }, DEFAULTS);
    await transcribe(gatewayPort, k.plaintextKey, { file: fakeAudio() });
    const metrics = renderMetrics();
    expect(metrics).not.toContain(SECRET_TRANSCRIPT_MARKER);
    // The audio-seconds counter incremented (content-blind, no per-user labels).
    expect(metrics).toContain("homeserver_audio_seconds_total");
  });

  it("PRIVACY: a GUEST's transcript is never stored in the owner-log", async () => {
    const before = getOwnerLog(1000).length;
    const k = mintKey({ alias: "aud-guest-owner", tier: "guest", creditLimit: 1_000_000 }, DEFAULTS);
    await transcribe(gatewayPort, k.plaintextKey, { file: fakeAudio() });
    const after = getOwnerLog(1000);
    // No new owner-log row for the guest, and the marker is absent from the entire owner-log.
    expect(after.length).toBe(before);
    expect(JSON.stringify(after)).not.toContain(SECRET_TRANSCRIPT_MARKER);
  });

  it("an OWNER's transcript IS stored in the owner-log (guarded capture mirrors chat)", async () => {
    const k = mintKey({ alias: "aud-owner", tier: "owner", creditLimit: 1_000_000 }, DEFAULTS);
    await transcribe(gatewayPort, k.plaintextKey, { file: fakeAudio() });
    const row = getOwnerLog(1000).find((r) => r.alias === "aud-owner");
    expect(row).toBeDefined();
    expect(row!.completion).toContain(SECRET_TRANSCRIPT_MARKER);
    expect(row!.route).toBe("audio");
  });

  it("upstream whisper down → 502 upstream_unavailable and 0 credits charged", async () => {
    const k = mintKey({ alias: "aud-down", tier: "guest", creditLimit: 1_000_000 }, DEFAULTS);
    expect(lookupKey(k.plaintextKey)!.creditsUsed).toBe(0);

    const res = await transcribe(downGatewayPort, k.plaintextKey, { file: fakeAudio() });
    expect(res.status).toBe(502);
    const j = (await res.json()) as { error: { code: string } };
    expect(j.error.code).toBe("upstream_unavailable");

    // Billing invariant: a failed call is never charged.
    expect(lookupKey(k.plaintextKey)!.creditsUsed).toBe(0);

    const row = lastLog("aud-down");
    expect(row!.outcome).toBe("upstream_unavailable");
    expect(row!.status).toBe(502);
  });

  it("accepts kb-whisper-large as a model alias and respects an empty allow-list", async () => {
    const k = mintKey({ alias: "aud-model", tier: "guest", creditLimit: 1_000_000 }, DEFAULTS);
    const res = await transcribe(gatewayPort, k.plaintextKey, {
      file: fakeAudio(),
      fields: { model: "kb-whisper-large" },
    });
    expect(res.status).toBe(200);
  });

  it("rejects a model outside the key's allow-list with 403", async () => {
    const k = mintKey(
      { alias: "aud-allow", tier: "guest", creditLimit: 1_000_000, modelAllowList: ["some-other-model"] },
      DEFAULTS
    );
    const res = await transcribe(gatewayPort, k.plaintextKey, {
      file: fakeAudio(),
      fields: { model: "whisper-1" },
    });
    expect(res.status).toBe(403);
    expect(lookupKey(k.plaintextKey)!.creditsUsed).toBe(0);
  });

  // ── Reserve→reconcile billing fidelity ──────────────────────────────────────────────

  it("reconciles a VALID duration DOWN to ceil(duration)*rate (refund correct, never the reservation)", async () => {
    whisperDuration = KNOWN_DURATION; // 12.3 → ceil 13 → 13*50 = 650
    const k = mintKey({ alias: "aud-reconcile", tier: "guest", creditLimit: 1_000_000 }, DEFAULTS);
    const res = await transcribe(gatewayPort, k.plaintextKey, { file: fakeAudio() });
    expect(res.status).toBe(200);
    // The worst-case reservation (3000) must be reconciled DOWN to the real cost (650), not left
    // sitting on the ledger.
    expect(lookupKey(k.plaintextKey)!.creditsUsed).toBe(Math.ceil(KNOWN_DURATION) * RATE);
  });

  it("charges the FULL reservation (never 0) when the backend reports a ZERO duration on a 2xx", async () => {
    whisperDuration = 0; // a bogus zero-duration 2xx — must NOT be a free ride
    const k = mintKey({ alias: "aud-zero", tier: "guest", creditLimit: 1_000_000 }, DEFAULTS);
    const res = await transcribe(gatewayPort, k.plaintextKey, { file: fakeAudio() });
    expect(res.status).toBe(200);
    // FAULT: zero/bogus duration on a 2xx → charge the worst-case reservation, NOT 0.
    expect(lookupKey(k.plaintextKey)!.creditsUsed).toBe(AUDIO_MAX_SECONDS * RATE);
  });

  it("charges the FULL reservation (never 0) when the backend OMITS duration on a 2xx", async () => {
    whisperDuration = undefined; // backend ignored verbose_json — no top-level duration
    const k = mintKey({ alias: "aud-missing", tier: "guest", creditLimit: 1_000_000 }, DEFAULTS);
    const res = await transcribe(gatewayPort, k.plaintextKey, { file: fakeAudio() });
    expect(res.status).toBe(200);
    expect(lookupKey(k.plaintextKey)!.creditsUsed).toBe(AUDIO_MAX_SECONDS * RATE);
  });

  it("clamps a duration ABOVE audioMaxSeconds to the cap (charges audioMaxSeconds*rate, not more)", async () => {
    whisperDuration = AUDIO_MAX_SECONDS + 5; // just over the cap
    const k = mintKey({ alias: "aud-overcap", tier: "guest", creditLimit: 1_000_000 }, DEFAULTS);
    const res = await transcribe(gatewayPort, k.plaintextKey, { file: fakeAudio() });
    expect(res.status).toBe(200);
    // A duration over the cap is a fault → charge the clamped worst case, never more than the cap.
    expect(lookupKey(k.plaintextKey)!.creditsUsed).toBe(AUDIO_MAX_SECONDS * RATE);
  });

  // ── RPM / TPM / daily quota enforcement (the audio route must not bypass rate limits) ──

  it("enforces per-key RPM on the audio route → 429 with Retry-After", async () => {
    // rpm 1 → first call admitted, second within the window rejected 429.
    const k = mintKey(
      { alias: "aud-rpm", tier: "guest", creditLimit: 1_000_000, rpm: 1, tpm: 1_000_000 },
      { ...DEFAULTS, rpm: 1 }
    );
    const first = await transcribe(gatewayPort, k.plaintextKey, { file: fakeAudio() });
    expect(first.status).toBe(200);
    const second = await transcribe(gatewayPort, k.plaintextKey, { file: fakeAudio() });
    expect(second.status).toBe(429);
    const j = (await second.json()) as { error: { code: string } };
    expect(j.error.code).toBe("rate_limit_exceeded");
    expect(second.headers.get("retry-after")).not.toBeNull();
    // A rate-limited request never ran → it is not charged.
    const usedAfter = lookupKey(k.plaintextKey)!.creditsUsed;
    expect(usedAfter).toBe(Math.ceil(KNOWN_DURATION) * RATE); // only the first (admitted) call
  });

  it("enforces per-key TPM on the audio route → 429", async () => {
    // tpm 1: even the worst-case audio-seconds reservation overflows a 1-token budget → 429.
    const k = mintKey(
      { alias: "aud-tpm", tier: "guest", creditLimit: 1_000_000, rpm: 1000, tpm: 1 },
      { ...DEFAULTS, tpm: 1 }
    );
    const res = await transcribe(gatewayPort, k.plaintextKey, { file: fakeAudio() });
    expect(res.status).toBe(429);
    const j = (await res.json()) as { error: { code: string } };
    expect(j.error.code).toBe("rate_limit_exceeded");
    // Rejected before transcription → not charged.
    expect(lookupKey(k.plaintextKey)!.creditsUsed).toBe(0);
  });

  // ── Upload hardening (DoS) ──────────────────────────────────────────────────────────

  it("rejects a Content-Length over the cap with 413 BEFORE buffering the body", async () => {
    const k = mintKey({ alias: "aud-413", tier: "guest", creditLimit: 1_000_000 }, DEFAULTS);
    // fetch() enforces Content-Length === body length client-side, so to declare a huge length while
    // sending a tiny body we speak HTTP/1.1 over a raw socket. The gateway must reject on the
    // declared Content-Length (413) BEFORE buffering the body.
    const declared = AUDIO_MAX_BYTES * 10;
    const raw = await rawPost(
      gatewayPort,
      [
        "POST /v1/audio/transcriptions HTTP/1.1",
        "Host: 127.0.0.1",
        `Authorization: Bearer ${k.plaintextKey}`,
        "Content-Type: multipart/form-data; boundary=----x",
        `Content-Length: ${declared}`,
        "Connection: close",
        "",
        "x".repeat(16), // far fewer bytes than declared; the gateway must not wait for them
      ].join("\r\n")
    );
    expect(raw.statusCode).toBe(413);
    expect(raw.body).toContain("payload_too_large");
    expect(lookupKey(k.plaintextKey)!.creditsUsed).toBe(0);
  });

  it("maps an oversized streamed body (no Content-Length) to 413, not 400", async () => {
    const k = mintKey({ alias: "aud-413-stream", tier: "guest", creditLimit: 1_000_000 }, DEFAULTS);
    // A body that exceeds AUDIO_MAX_BYTES once buffered. fetch sets Content-Length for a Buffer
    // body, so this also exercises the header path, but the assertion is the 413 mapping.
    const big = Buffer.alloc(AUDIO_MAX_BYTES + 1024, 0x61);
    const res = await fetch(`http://127.0.0.1:${gatewayPort}/v1/audio/transcriptions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${k.plaintextKey}`,
        "content-type": "multipart/form-data; boundary=----x",
      },
      body: big,
    });
    expect(res.status).toBe(413);
    expect(lookupKey(k.plaintextKey)!.creditsUsed).toBe(0);
  });

  // ── temperature validation ───────────────────────────────────────────────────────────

  it("rejects an out-of-range temperature with 400", async () => {
    const k = mintKey({ alias: "aud-temp", tier: "guest", creditLimit: 1_000_000 }, DEFAULTS);
    const res = await transcribe(gatewayPort, k.plaintextKey, {
      file: fakeAudio(),
      fields: { temperature: "5" }, // out of [0,1]
    });
    expect(res.status).toBe(400);
    const j = (await res.json()) as { error: { code: string; param: string | null } };
    expect(j.error.code).toBe("invalid_request_error");
    expect(j.error.param).toBe("temperature");
    expect(lookupKey(k.plaintextKey)!.creditsUsed).toBe(0);
  });

  it("accepts an in-range temperature and forwards it", async () => {
    const k = mintKey({ alias: "aud-temp-ok", tier: "guest", creditLimit: 1_000_000 }, DEFAULTS);
    const res = await transcribe(gatewayPort, k.plaintextKey, {
      file: fakeAudio(),
      fields: { temperature: "0.4" },
    });
    expect(res.status).toBe(200);
    expect(lastForwardedBody.toString("utf-8")).toMatch(/name="temperature"\r\n\r\n0\.4/);
  });
});
