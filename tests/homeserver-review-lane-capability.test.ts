/**
 * Issue #74 acceptance criterion 4 — GET /v1/capabilities/review-lane.
 *
 * The orchestrator-facing preflight: ask which lane a task type will get BEFORE sending a prompt,
 * so it never waits on a local review result that will not come. Modeled on the existing
 * `/v1/capabilities/learning-task` endpoint's shape (a versioned, GET, content-blind capability
 * advertisement) but far lighter — no HMAC epoch/replay machinery, since this is a static,
 * no-I/O lookup, not a durable admission handshake.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../src/db.js";

let gatewayPort = 0;
let stopGateway: (() => Promise<void>) | null = null;
let ownerKey = "";
let guestKey = "";
const DEFAULTS = { rpm: 1000, tpm: 1_000_000, dailyTokenBudget: 0, maxParallel: 2 };

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "hs-review-lane-cap-test-"));
  initDb(join(dir, "test.db"));

  process.env["HOMESERVER_HOST"] = "127.0.0.1";
  process.env["HOMESERVER_PORT"] = "0";
  delete process.env["HOMESERVER_API_KEYS"];
  delete process.env["HOMESERVER_ADMIN_API_KEYS"];
  delete process.env["HOMESERVER_DELEGATE_POLICY_PROMOTED_ADVISORY_TASK_TYPES"];

  const ks = await import("../src/homeserver/keystore.js");
  ownerKey = ks.mintKey({ alias: "review-lane-owner", tier: "owner" }, DEFAULTS).plaintextKey;
  guestKey = ks.mintKey({ alias: "review-lane-guest", tier: "guest" }, DEFAULTS).plaintextKey;

  const gw = await import("../src/homeserver/gateway.js");
  const handle = await gw.startGateway();
  gatewayPort = handle.port;
  stopGateway = handle.stop;
});

afterAll(async () => {
  if (stopGateway) await stopGateway();
});

const url = (path: string): string => `http://127.0.0.1:${gatewayPort}${path}`;

interface CapabilityResponse {
  endpoint: string;
  contract_version: string;
  generated_at: string;
  lanes: Record<
    string,
    {
      taskType: string;
      eligible: "local-advisory" | "frontier-only";
      advisoryOnly: boolean;
      promoted: boolean;
      subtaskKinds?: string[];
      reason: string;
    }
  >;
}

describe("GET /v1/capabilities/review-lane", () => {
  it("401s without a key", async () => {
    const r = await fetch(url("/v1/capabilities/review-lane"));
    expect(r.status).toBe(401);
  });

  it("an owner key gets both known lanes: code-review frontier-only, review-bounded local-advisory", async () => {
    const r = await fetch(url("/v1/capabilities/review-lane"), {
      headers: { Authorization: `Bearer ${ownerKey}` },
    });
    expect(r.status).toBe(200);
    const j = (await r.json()) as CapabilityResponse;
    expect(j.endpoint).toBe("/v1/capabilities/review-lane");
    expect(j.lanes["code-review"]!.eligible).toBe("frontier-only");
    expect(j.lanes["code-review"]!.advisoryOnly).toBe(false);
    expect(j.lanes["review-bounded"]!.eligible).toBe("local-advisory");
    expect(j.lanes["review-bounded"]!.advisoryOnly).toBe(true);
    expect(j.lanes["review-bounded"]!.promoted).toBe(false);
    expect(j.lanes["review-bounded"]!.subtaskKinds).toEqual([
      "classify-findings",
      "detect-anti-pattern",
      "verify-output-shape",
    ]);
  });

  it("a guest key gets the same capability advertisement (content-blind, no privileged info)", async () => {
    const r = await fetch(url("/v1/capabilities/review-lane"), {
      headers: { Authorization: `Bearer ${guestKey}` },
    });
    expect(r.status).toBe(200);
    const j = (await r.json()) as CapabilityResponse;
    expect(j.lanes["review-bounded"]!.eligible).toBe("local-advisory");
  });

  it("an explicit ?taskType= for an unknown type is echoed back as frontier-only", async () => {
    const r = await fetch(url("/v1/capabilities/review-lane?taskType=code-implement"), {
      headers: { Authorization: `Bearer ${ownerKey}` },
    });
    const j = (await r.json()) as CapabilityResponse;
    expect(j.lanes["code-implement"]!.eligible).toBe("frontier-only");
  });

  // #80: the preflight must resolve `?taskType=` the way INGRESS does (trim only), so an untrimmed
  // spelling reports its real lane instead of the generic "no local-eligible lane" fallback.
  it("trims an untrimmed ?taskType= instead of reporting the generic fallback", async () => {
    const r = await fetch(url("/v1/capabilities/review-lane?taskType=%20review-bounded%20"), {
      headers: { Authorization: `Bearer ${ownerKey}` },
    });
    expect(r.status).toBe(200);
    const j = (await r.json()) as CapabilityResponse;
    expect(Object.keys(j.lanes)).not.toContain(" review-bounded ");
    expect(j.lanes["review-bounded"]!.eligible).toBe("local-advisory");
    expect(j.lanes["review-bounded"]!.advisoryOnly).toBe(true);
    expect(j.lanes["review-bounded"]!.promoted).toBe(false);
  });

  // ...but it must NOT case-fold: routing and the evidence bucket key off the recorded spelling,
  // so advertising `Review-Bounded` as the canonical lane would promise a route it will not get.
  it("does not advertise a case variant as a known lane (it is genuinely a different bucket)", async () => {
    const r = await fetch(url("/v1/capabilities/review-lane?taskType=Review-Bounded"), {
      headers: { Authorization: `Bearer ${ownerKey}` },
    });
    expect(r.status).toBe(200);
    const j = (await r.json()) as CapabilityResponse;
    expect(j.lanes["Review-Bounded"]!.eligible).toBe("frontier-only");
    expect(j.lanes["Review-Bounded"]!.reason).toMatch(/no local-eligible review lane/i);
    // The canonical lane is still advertised on every response, unchanged.
    expect(j.lanes["review-bounded"]!.eligible).toBe("local-advisory");
  });
});
