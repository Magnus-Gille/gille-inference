import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../src/db.js";
import { recordDelegation } from "../src/homeserver/ledger.js";
import { bindExecutionFeedback } from "../src/homeserver/execution-feedback.js";
import { mintKey } from "../src/homeserver/keystore.js";
import {
  createAccessLogger,
  defaultLogger,
  setDefaultLogger,
} from "../src/homeserver/access-log.js";
import { createDirectGatewayHarness, type DirectGatewayHarness } from "./helpers/direct-gateway.js";

let harness: DirectGatewayHarness;
let agent = "";
let other = "";
const denied: string[] = [];
const accessLines: string[] = [];
const originalDefaultLogger = defaultLogger;
const defaults = { rpm: 1000, tpm: 1_000_000, dailyTokenBudget: 0, maxParallel: 2 };
beforeAll(() => {
  initDb(join(mkdtempSync(join(tmpdir(), "feedback-route-")), "test.db"));
  process.env["HOMESERVER_HOST"] = "127.0.0.1";
  delete process.env["HOMESERVER_API_KEYS"];
  process.env["HOMESERVER_ADMIN_API_KEYS"] = "static-test-admin";
  delete process.env["HOMESERVER_MONITOR_API_KEYS"];
  agent = mintKey({ alias: "feedback-agent", tier: "owner", scope: "agent" }, defaults).plaintextKey;
  other = mintKey({ alias: "other-owner", tier: "owner", scope: "admin" }, defaults).plaintextKey;
  for (const [alias, tier, scope] of [
    ["guest-feedback", "guest", "inference"], ["monitor-feedback", "owner", "monitor"],
    ["inference-feedback", "owner", "inference"],
  ] as const) denied.push(mintKey({ alias, tier, scope }, defaults).plaintextKey);
  denied.push("static-test-admin");
  setDefaultLogger(createAccessLogger((line) => accessLines.push(line)));
  harness = createDirectGatewayHarness();
});
afterAll(() => setDefaultLogger(originalDefaultLogger));
beforeEach(() => {
  accessLines.length = 0;
});
function handle(trafficPurpose: "organic" | "evaluation" | "synthetic" | "unknown" = "organic") {
  const ledgerId = recordDelegation({ taskType: "summarize", modelId: "test-model", prompt: "private",
    source: "mcp-ask", keyAlias: "feedback-agent", outcome: "unverified" });
  return bindExecutionFeedback({ ledgerId,
    owner: { alias: "feedback-agent", keyHash: createHash("sha256").update(agent).digest("hex") },
    surface: "ask", trafficPurpose, outputAvailable: true })!;
}
function write(token: string | undefined, id: string, body: Record<string, unknown> = { usefulness: "pass" }) {
  return harness.invoke({ method: "PUT", path: `/execution-feedback/${id}`, token,
    headers: { "content-type": "application/json" }, body });
}
function writeRaw(token: string | undefined, id: string, body: string, contentType = "application/json") {
  return harness.invoke({ method: "PUT", path: `/execution-feedback/${id}`, token,
    headers: { "content-type": contentType }, body });
}
describe("owner execution feedback route", () => {
  it("rejects an oversized body without recording feedback or echoing private content", async () => {
    const id = handle();
    const result = await writeRaw(agent, id, JSON.stringify({ usefulness: "pass", private: "x".repeat(2048) }));
    expect(result.status).toBe(413);
    expect(result.text).not.toContain(id);
    expect(result.text).not.toContain("x".repeat(100));
    expect((await write(agent, id)).status).toBe(201);
  });
  it("allows only the submitting owner key, with idempotent retries and conflicts", async () => {
    const id = handle();
    expect((await write(other, id)).status).toBe(404);
    expect((await write(agent, id)).status).toBe(201);
    expect((await write(agent, id)).json).toEqual({ kind: "unchanged" });
    expect((await write(agent, id, { usefulness: "wrong" })).status).toBe(409);
  });
  it("denies guest, monitor, inference, static and unauthenticated callers", async () => {
    const id = handle();
    for (const token of denied) expect((await write(token, id)).status).toBe(403);
    expect((await write(undefined, id)).status).toBe(401);
  });
  it("rejects unknown fields without echoing content, identity or handle", async () => {
    const id = handle();
    const result = await write(agent, id, { usefulness: "pass", "private/path/secret": "private body" });
    expect(result.status).toBe(400);
    for (const value of [id, "private/path/secret", "private body", "feedback-agent"]) {
      expect(result.text).not.toContain(value);
    }
  });
  it("normalizes the route log and never logs the opaque handle or request body", async () => {
    const id = handle();
    const body = JSON.stringify({ usefulness: "pass", "private/path/secret": "private body" });
    const result = await writeRaw(agent, id, body);
    expect(result.status).toBe(400);
    const records = accessLines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      event: "gateway_request",
      method: "PUT",
      route: "/execution-feedback/:handle",
      status: 400,
    });
    for (const value of [id, body, "private/path/secret", "private body"]) {
      expect(accessLines.join("\n")).not.toContain(value);
    }
  });
  it("returns 404 for malformed and unknown UUID-shaped handles", async () => {
    expect((await write(agent, "not-a-uuid")).status).toBe(404);
    expect((await write(agent, "00000000-0000-4000-8000-000000000000")).status).toBe(404);
  });
  it("returns 400 for malformed JSON and 409 for non-organic or unavailable rows", async () => {
    const id = handle();
    expect((await writeRaw(agent, id, "{\"usefulness\":", "application/json")).status).toBe(400);
    for (const purpose of ["unknown", "evaluation", "synthetic"] as const) {
      const purposeHandle = handle(purpose);
      const result = await write(agent, purposeHandle);
      expect(result.status).toBe(409);
      expect(result.json).toEqual({ kind: "ineligible" });
      expect(result.text).not.toContain(purposeHandle);
    }
  });
});
