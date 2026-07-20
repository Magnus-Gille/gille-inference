/**
 * Integration coverage for POST /admin/experiments/import (issue #8) over the live gateway:
 *   • admin-gated (guest → 403), same requireAdmin() idiom as every other /admin route.
 *   • a structurally malformed body → 400 invalid_request_error (never a 500).
 *   • a well-formed, admissible bundle → 200 with a per-arm "imported" disposition, and the
 *     evidence becomes visible on GET /ledger (the existing owner/monitor-gated reader).
 *   • a well-formed but business-inadmissible arm → 200 with that arm's specific rejection reason
 *     (a rejection is NOT an HTTP error — see experiment-import.ts's module doc).
 * Runs in its own process (vitest isolates files), with its own DB + env + module graph — same
 * lightweight harness as homeserver-maintenance-gateway.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../src/db.js";
import { contentDigest } from "../src/homeserver/evidence-identity.js";

let gatewayPort = 0;
let stopGateway: (() => Promise<void>) | null = null;
let ownerKey = "";
let guestKey = "";

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "hs-experiment-import-gw-test-"));
  initDb(join(dir, "test.db"));

  process.env["LMSTUDIO_BASE_URL"] = "http://127.0.0.1:1/v1"; // unused by this route
  process.env["HOMESERVER_HOST"] = "127.0.0.1";
  process.env["HOMESERVER_PORT"] = "0";
  process.env["HOMESERVER_MAX_INFLIGHT"] = "2";
  process.env["HOMESERVER_PER_REQUEST_MAX_TOKENS"] = "256";
  process.env["HOMESERVER_KEY_DEFAULT_RPM"] = "1000";
  process.env["HOMESERVER_KEY_DEFAULT_TPM"] = "1000000";
  delete process.env["HOMESERVER_API_KEYS"];
  delete process.env["HOMESERVER_ADMIN_API_KEYS"];

  const ks = await import("../src/homeserver/keystore.js");
  const defs = { rpm: 1000, tpm: 1_000_000, dailyTokenBudget: 0, maxParallel: 2 };
  ownerKey = ks.mintKey({ alias: "exp-import-owner", tier: "owner" }, defs).plaintextKey;
  guestKey = ks.mintKey({ alias: "exp-import-guest", tier: "guest", modelAllowList: ["m1"] }, defs).plaintextKey;

  const gw = await import("../src/homeserver/gateway.js");
  const handle = await gw.startGateway();
  gatewayPort = handle.port;
  stopGateway = handle.stop;
});

afterAll(async () => {
  if (stopGateway) await stopGateway();
});

function url(path: string): string {
  return `http://127.0.0.1:${gatewayPort}${path}`;
}
function auth(key: string): Record<string, string> {
  return { authorization: `Bearer ${key}`, "content-type": "application/json" };
}

function digestField(seed: string) {
  return { kind: "digest", id: `id-${seed}`, version: "v1", digest: contentDigest(seed), origin: "server-observed" };
}

function admissibleBundle(overrides: Record<string, unknown> = {}) {
  const seed = (overrides["experimentId"] as string) ?? "exp-gw-1";
  return {
    experimentId: seed,
    runId: "run-1",
    status: "completed",
    arms: [
      {
        armId: "champion",
        sampleId: "s1",
        taskType: "reason-gw",
        modelId: "model-gw",
        outcome: "pass",
        prompt: "gateway experiment prompt",
        evidenceIdentity: {
          modelArtifact: digestField(`${seed}-model`),
          configEpoch: digestField(`${seed}-config`),
          logicalTask: digestField(`${seed}-task`),
          renderedPrompt: digestField(`${seed}-prompt`),
          harness: digestField(`${seed}-harness`),
          taxonomyVersion: { kind: "label", label: "gille-inference/task-types@v1", origin: "operator-declared" },
          verifierRubric: digestField(`${seed}-verifier`),
          sampling: digestField(`${seed}-sampling`),
          toolPolicy: digestField(`${seed}-tools`),
          lane: "delegate",
        },
        verifier: { name: "tsGate", independent: true, mode: "deterministic" },
        exposure: { contaminationStatus: "clean" },
        policyEpoch: "epoch-v1",
        recordedAt: "2026-07-15T10:00:00.000Z",
      },
    ],
    ...overrides,
  };
}

function postImport(key: string, body: unknown): Promise<Response> {
  return fetch(url("/admin/experiments/import"), { method: "POST", headers: auth(key), body: JSON.stringify(body) });
}

describe("POST /admin/experiments/import (#8)", () => {
  it("is admin-gated — a guest key gets 403", async () => {
    const res = await postImport(guestKey, admissibleBundle({ experimentId: "exp-gw-auth" }));
    expect(res.status).toBe(403);
  });

  it("a malformed body is 400 invalid_request_error, not a 500", async () => {
    const res = await postImport(ownerKey, { experimentId: "exp-gw-bad" }); // missing runId/status/arms
    expect(res.status).toBe(400);
    const j = (await res.json()) as { error: { code: string } };
    expect(j.error.code).toBe("invalid_request_error");
  });

  it("admits a well-formed admissible bundle and makes it visible on GET /ledger", async () => {
    const res = await postImport(ownerKey, admissibleBundle({ experimentId: "exp-gw-admit" }));
    expect(res.status).toBe(200);
    const j = (await res.json()) as { arms: Array<{ status: string; delegationId?: string }> };
    expect(j.arms).toHaveLength(1);
    expect(j.arms[0]!.status).toBe("imported");

    const ledgerRes = await fetch(url("/ledger"), { headers: auth(ownerKey) });
    expect(ledgerRes.status).toBe(200);
    const ledgerBody = (await ledgerRes.json()) as {
      report: Array<{ taskType: string; modelId: string; passes: number }>;
    };
    const row = ledgerBody.report.find((r) => r.taskType === "reason-gw" && r.modelId === "model-gw");
    expect(row).toBeDefined();
    expect(row!.passes).toBe(1);
  });

  it("a business-inadmissible arm is a 200 with a specific rejection reason, not an HTTP error", async () => {
    const bundle = admissibleBundle({ experimentId: "exp-gw-reject" });
    (bundle.arms[0] as { exposure: { contaminationStatus: string } }).exposure = { contaminationStatus: "contaminated" };
    const res = await postImport(ownerKey, bundle);
    expect(res.status).toBe(200);
    const j = (await res.json()) as { arms: Array<{ status: string; reason?: string }> };
    expect(j.arms[0]!.status).toBe("rejected");
    expect(j.arms[0]!.reason).toBe("contaminated");
  });
});
