/**
 * Issue #74 acceptance criterion 4 — GET /v1/capabilities/review-lane.
 *
 * Directly invokes the gateway handler so the endpoint contract stays testable in sandboxes that
 * cannot bind a real loopback port.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../src/db.js";
import { createDirectGatewayHarness, type DirectGatewayHarness } from "./helpers/direct-gateway.js";

let harness: DirectGatewayHarness;
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

  harness = createDirectGatewayHarness();
});

interface CapabilityResponse {
  endpoint: string;
  contract_version: string;
  generated_at: string;
  reviewerUsefulnessRecording: {
    available: boolean;
    method: string;
    endpoint: string;
    taskTypes: string[];
    closedValues: string[];
    reviewerIdentity: string;
  };
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
    const r = await harness.invoke({ method: "GET", path: "/v1/capabilities/review-lane" });
    expect(r.status).toBe(401);
  });

  it("an owner key gets both known lanes and the reviewer-usefulness recorder advertisement", async () => {
    const r = await harness.invoke({
      method: "GET",
      path: "/v1/capabilities/review-lane",
      token: ownerKey,
    });
    expect(r.status).toBe(200);
    const j = r.json as CapabilityResponse;
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
    expect(j.reviewerUsefulnessRecording).toEqual({
      available: true,
      method: "PUT",
      endpoint: "/ledger/{id}/reviewer-usefulness",
      taskTypes: ["review-bounded"],
      closedValues: ["pass", "partial", "redo", "wrong"],
      reviewerIdentity: "authenticated logical alias",
    });
  });

  it("a guest key gets the same capability advertisement (content-blind, no privileged info)", async () => {
    const r = await harness.invoke({
      method: "GET",
      path: "/v1/capabilities/review-lane",
      token: guestKey,
    });
    expect(r.status).toBe(200);
    const j = r.json as CapabilityResponse;
    expect(j.lanes["review-bounded"]!.eligible).toBe("local-advisory");
    expect(j.reviewerUsefulnessRecording.available).toBe(true);
  });

  it("an explicit ?taskType= for an unknown type is echoed back as frontier-only", async () => {
    const r = await harness.invoke({
      method: "GET",
      path: "/v1/capabilities/review-lane?taskType=code-implement",
      token: ownerKey,
    });
    const j = r.json as CapabilityResponse;
    expect(j.lanes["code-implement"]!.eligible).toBe("frontier-only");
  });

  it("trims an untrimmed ?taskType= instead of reporting the generic fallback", async () => {
    const r = await harness.invoke({
      method: "GET",
      path: "/v1/capabilities/review-lane?taskType=%20review-bounded%20",
      token: ownerKey,
    });
    expect(r.status).toBe(200);
    const j = r.json as CapabilityResponse;
    expect(Object.keys(j.lanes)).not.toContain(" review-bounded ");
    expect(j.lanes["review-bounded"]!.eligible).toBe("local-advisory");
    expect(j.lanes["review-bounded"]!.advisoryOnly).toBe(true);
    expect(j.lanes["review-bounded"]!.promoted).toBe(false);
  });

  it("does not advertise a case variant as a known lane (it is genuinely a different bucket)", async () => {
    const r = await harness.invoke({
      method: "GET",
      path: "/v1/capabilities/review-lane?taskType=Review-Bounded",
      token: ownerKey,
    });
    expect(r.status).toBe(200);
    const j = r.json as CapabilityResponse;
    expect(j.lanes["Review-Bounded"]!.eligible).toBe("frontier-only");
    expect(j.lanes["Review-Bounded"]!.reason).toMatch(/no local-eligible review lane/i);
    expect(j.lanes["review-bounded"]!.eligible).toBe("local-advisory");
  });
});
