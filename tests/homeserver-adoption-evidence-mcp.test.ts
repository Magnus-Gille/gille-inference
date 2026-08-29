import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getDb, initDb } from "../src/db.js";
import { createAccessLogger, setDefaultLogger } from "../src/homeserver/access-log.js";
import {
  MAX_ADOPTION_EVIDENCE_ROWS_PER_DAY,
  MAX_ADOPTION_REPORTS_PER_PRINCIPAL_WINDOW,
  parseAdoptionEvidence,
  recordAdoptionEvidence,
} from "../src/homeserver/adoption-evidence.js";

const DEFAULTS = { rpm: 1_000, tpm: 1_000_000, dailyTokenBudget: 0, maxParallel: 2 };
let gatewayPort = 0;
let stopGateway: (() => Promise<void>) | null = null;
let agentKey = "";
let guestKey = "";
let mintKey: typeof import("../src/homeserver/keystore.js").mintKey;
let accessLines: string[] = [];

function callBody(id: number, name: string, args: Record<string, unknown> = {}): unknown {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}

async function rpc(body: unknown, key: string): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${gatewayPort}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  return response.text();
}

const report = {
  harness: "codex_cli",
  execution_mode: "code_loop",
  traffic_purpose: "organic",
  result: "not_attempted",
  deterministic_check: "not_run",
  reviewer_usefulness: "not_reported",
  fallback_reason: "m5_auth_unavailable",
  eligible_opportunities: 2,
};

function tableCount(table: string): number {
  const exists = getDb().prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  if (!exists) return 0;
  return (getDb().prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "hs-adoption-evidence-mcp-"));
  initDb(join(dir, "test.db"));
  process.env["LMSTUDIO_BASE_URL"] = "http://127.0.0.1:9/v1";
  process.env["HOMESERVER_HOST"] = "127.0.0.1";
  process.env["HOMESERVER_PORT"] = "0";
  delete process.env["HOMESERVER_API_KEYS"];
  delete process.env["HOMESERVER_ADMIN_API_KEYS"];
  const { resetConfig } = await import("../src/homeserver/config.js");
  resetConfig();
  ({ mintKey } = await import("../src/homeserver/keystore.js"));
  agentKey = mintKey({ alias: "adoption-agent", tier: "owner", scope: "agent" }, DEFAULTS).plaintextKey;
  guestKey = mintKey({ alias: "adoption-guest", tier: "guest" }, DEFAULTS).plaintextKey;
  const { startGateway } = await import("../src/homeserver/gateway.js");
  const handle = await startGateway();
  gatewayPort = handle.port;
  stopGateway = handle.stop;
});

beforeEach(() => {
  for (const table of ["adoption_evidence", "request_log", "owner_request_log"]) {
    if (getDb().prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) {
      getDb().prepare(`DELETE FROM ${table}`).run();
    }
  }
  accessLines = [];
  setDefaultLogger(createAccessLogger((line) => accessLines.push(line)));
});

afterAll(async () => {
  if (stopGateway) await stopGateway();
  setDefaultLogger(createAccessLogger());
});

describe("record_adoption_evidence MCP tool (#136)", () => {
  it("allows a real owner-agent credential to submit a content-free observation", async () => {
    const raw = await rpc(callBody(1, "record_adoption_evidence", report), agentKey);
    expect(raw).not.toContain(agentKey);
    const parsed = JSON.parse(raw) as { result: { isError: boolean; structuredContent: unknown } };
    expect(parsed.result.isError).toBe(false);
    expect(parsed.result.structuredContent).toEqual({ accepted: true });
    expect(getDb().prepare("SELECT harness, execution_mode, traffic_purpose, fallback_reason, eligible_opportunities FROM adoption_evidence").get()).toEqual({
      harness: "codex_cli",
      execution_mode: "code_loop",
      traffic_purpose: "organic",
      fallback_reason: "m5_auth_unavailable",
      eligible_opportunities: 2,
    });
    expect(tableCount("request_log")).toBe(0);
    expect(tableCount("owner_request_log")).toBe(0);
    expect(accessLines).toEqual([]);
  });

  it("does not expose an identity, prompt, response, or path in the acceptance payload", async () => {
    const raw = await rpc(callBody(2, "record_adoption_evidence", report), agentKey);
    expect(raw).toContain("accepted");
    expect(raw).not.toMatch(/adoption-agent|prompt|response|path|repo|alias/i);
  });

  it("refuses an invalid adoption report without evidence or per-request correlation logs", async () => {
    const raw = await rpc(callBody(3, "record_adoption_evidence", { ...report, prompt: "never accept content" }), agentKey);
    const parsed = JSON.parse(raw) as { result: { isError: boolean } };
    expect(parsed.result.isError).toBe(true);
    expect(parsed.result).toMatchObject({
      structuredContent: {
        accepted: false,
        reason: "invalid_report",
        diagnostic: { code: "unknown_field" },
      },
    });
    expect(raw).toContain("invalid_report");
    expect(raw).not.toContain("never accept content");
    expect(tableCount("adoption_evidence")).toBe(0);
    expect(tableCount("request_log")).toBe(0);
    expect(tableCount("owner_request_log")).toBe(0);
    expect(accessLines).toEqual([]);
  });

  it("accepts schema-valid failed call and unusable partial-result observations", async () => {
    const unreachable = {
      ...report,
      execution_mode: "ask",
      result: "failed",
      deterministic_check: "pass",
      reviewer_usefulness: "not_reported",
      fallback_reason: "m5_unreachable",
      eligible_opportunities: 1,
    };
    const unusable = {
      ...unreachable,
      reviewer_usefulness: "redo",
      fallback_reason: "local_result_unusable",
    };

    for (const [id, observation] of [[4, unreachable], [5, unusable]] as const) {
      const response = JSON.parse(await rpc(callBody(id, "record_adoption_evidence", observation), agentKey)) as {
        result: { isError: boolean; structuredContent: unknown };
      };
      expect(response.result).toMatchObject({ isError: false, structuredContent: { accepted: true } });
    }

    expect(getDb().prepare(
      "SELECT result, deterministic_check, reviewer_usefulness, fallback_reason FROM adoption_evidence ORDER BY rowid"
    ).all()).toEqual([
      { result: "failed", deterministic_check: "pass", reviewer_usefulness: "not_reported", fallback_reason: "m5_unreachable" },
      { result: "failed", deterministic_check: "pass", reviewer_usefulness: "redo", fallback_reason: "local_result_unusable" },
    ]);
    expect(tableCount("request_log")).toBe(0);
    expect(tableCount("owner_request_log")).toBe(0);
    expect(accessLines).toEqual([]);
  });

  it("rate-bounds invisible invalid-report floods before schema rejection", async () => {
    const invalidFloodKey = mintKey({ alias: "adoption-invalid-flood-agent", tier: "owner", scope: "agent" }, DEFAULTS).plaintextKey;
    for (let i = 0; i < MAX_ADOPTION_REPORTS_PER_PRINCIPAL_WINDOW; i += 1) {
      const raw = await rpc(callBody(60 + i, "record_adoption_evidence", { ...report, path: "/never/persist" }), invalidFloodKey);
      expect(JSON.parse(raw)).toMatchObject({ result: { isError: true } });
    }
    const validAfterFlood = JSON.parse(await rpc(callBody(70, "record_adoption_evidence", report), invalidFloodKey)) as { result: { isError: boolean } };
    expect(validAfterFlood.result.isError).toBe(true);
    expect(validAfterFlood.result).toMatchObject({
      structuredContent: { accepted: false, reason: "principal_rate_limited" },
    });
    expect(tableCount("adoption_evidence")).toBe(0);
    expect(tableCount("request_log")).toBe(0);
    expect(accessLines).toEqual([]);
  });

  it("returns a stable redacted reason when the daily aggregate is full", async () => {
    const parsedReport = parseAdoptionEvidence(report);
    if (!parsedReport.ok) throw new Error("fixture must parse");
    for (let i = 0; i < MAX_ADOPTION_EVIDENCE_ROWS_PER_DAY; i += 1) {
      expect(recordAdoptionEvidence(parsedReport.value)).toBe(true);
    }
    const capacityKey = mintKey({ alias: "adoption-capacity-agent", tier: "owner", scope: "agent" }, DEFAULTS).plaintextKey;

    const raw = await rpc(callBody(80, "record_adoption_evidence", report), capacityKey);
    const response = JSON.parse(raw) as { result: { isError: boolean } };

    expect(response.result).toMatchObject({
      isError: false,
      structuredContent: { accepted: false, reason: "daily_capacity_reached" },
    });
    expect(raw).toContain("M5 inference result is unaffected");
    expect(raw).not.toContain("adoption-capacity-agent");
    expect(raw).not.toMatch(/prompt|response|path|alias/i);
    expect(tableCount("request_log")).toBe(0);
    expect(tableCount("owner_request_log")).toBe(0);
    expect(accessLines).toEqual([]);
  });

  it("returns a stable redacted reason when adoption evidence storage is unavailable", async () => {
    const storageKey = mintKey({ alias: "adoption-storage-agent", tier: "owner", scope: "agent" }, DEFAULTS).plaintextKey;
    const db = getDb();
    let raw = "";
    db.exec(`
      CREATE TEMP TRIGGER force_adoption_storage_failure
      BEFORE INSERT ON adoption_evidence
      BEGIN
        SELECT RAISE(ABORT, 'forced adoption storage failure');
      END;
    `);
    try {
      raw = await rpc(callBody(90, "record_adoption_evidence", report), storageKey);
    } finally {
      db.exec("DROP TRIGGER force_adoption_storage_failure");
    }
    const response = JSON.parse(raw) as { result: { isError: boolean } };

    expect(response.result).toMatchObject({
      isError: true,
      structuredContent: { accepted: false, reason: "storage_unavailable" },
    });
    expect(raw).not.toContain("adoption-storage-agent");
    expect(raw).not.toMatch(/sqlite|readonly database|prompt|response|path|alias|principal/i);
    expect(tableCount("adoption_evidence")).toBe(0);
    expect(tableCount("request_log")).toBe(0);
    expect(tableCount("owner_request_log")).toBe(0);
    expect(accessLines).toEqual([]);
  });

  it("bounds a valid reporter flood without persisting an identity or transport correlation", async () => {
    const floodKey = mintKey({ alias: "adoption-flood-agent", tier: "owner", scope: "agent" }, DEFAULTS).plaintextKey;
    const responses: Array<{ result: { isError: boolean } }> = [];
    for (let i = 0; i < MAX_ADOPTION_REPORTS_PER_PRINCIPAL_WINDOW + 1; i += 1) {
      responses.push(JSON.parse(await rpc(callBody(100 + i, "record_adoption_evidence", report), floodKey)) as { result: { isError: boolean } });
    }
    expect(responses.filter((response) => !response.result.isError)).toHaveLength(MAX_ADOPTION_REPORTS_PER_PRINCIPAL_WINDOW);
    expect(tableCount("adoption_evidence")).toBe(MAX_ADOPTION_REPORTS_PER_PRINCIPAL_WINDOW);
    expect(tableCount("request_log")).toBe(0);
    expect(tableCount("owner_request_log")).toBe(0);
    expect(accessLines).toEqual([]);
    const storedColumns = getDb().prepare("PRAGMA table_info(adoption_evidence)").all() as Array<{ name: string }>;
    expect(storedColumns.map((column) => column.name).join(" ")).not.toMatch(/id|alias|principal|request|prompt|response|path|repo/i);
  });

  it("keeps the reporting tool invisible to guest credentials", async () => {
    const list = await rpc({ jsonrpc: "2.0", id: 30, method: "tools/list" }, guestKey);
    const direct = await rpc(callBody(40, "record_adoption_evidence", report), guestKey);
    const unknown = await rpc(callBody(50, "unknown_tool", report), guestKey);
    expect(list).not.toContain("record_adoption_evidence");
    const directResult = JSON.parse(direct) as { result: unknown };
    const unknownResult = JSON.parse(unknown) as { result: unknown };
    expect(JSON.stringify(directResult.result).replace("record_adoption_evidence", "unknown_tool"))
      .toBe(JSON.stringify(unknownResult.result));
  });
});
