import { describe, expect, it } from "vitest";
import {
  childEnvironmentWithoutMaintenanceKey,
  parseMaintenanceWindowArgs,
  runMaintenanceWindowCommand,
} from "../src/homeserver/maintenance-window-client.js";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("maintenance window client", () => {
  it("always restores and never returns the opaque token as evidence", async () => {
    const requests: Array<Record<string, unknown>> = [];
    let observedRunningModels: unknown;
    const evidence = await runMaintenanceWindowCommand(
      { baseUrl: "http://127.0.0.1:8080", ttlSeconds: 60, drainTimeoutSeconds: 5, command: ["true"] },
      {
        apiKey: "secret-admin-key",
        now: () => 2_000,
        runChild: async (_command, opened) => {
          observedRunningModels = opened?.runningModels;
          return 0;
        },
        fetch: async (_input, init) => {
          if (init?.method === "GET") return json(200, { active: false, evidence: null });
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          requests.push(body);
          if (body.action === "open") {
            return json(201, {
              token: "opaque-release-token",
              evidence: { mode: "exclusive", startedAt: "1970-01-01T00:00:01.000Z", runningModels: [] },
            });
          }
          return json(200, { restored: true });
        },
      },
    );
    expect(requests.map((request) => request.action)).toEqual(["open", "close"]);
    expect(JSON.stringify(evidence)).not.toContain("opaque-release-token");
    expect(JSON.stringify(evidence)).not.toContain("secret-admin-key");
    expect(evidence).toMatchObject({ mode: "exclusive", childExitCode: 0, restored: true });
    expect(observedRunningModels).toEqual([]);
  });

  it("restores even when the child fails", async () => {
    let restored = false;
    await expect(runMaintenanceWindowCommand(
      { baseUrl: "http://m5", ttlSeconds: 60, drainTimeoutSeconds: 5, command: ["bad"] },
      {
        apiKey: "key",
        runChild: async () => { throw new Error("spawn failed"); },
        fetch: async (_input, init) => {
          if (init?.method === "GET") return json(200, { active: false });
          const body = JSON.parse(String(init?.body)) as { action: string };
          if (body.action === "close") { restored = true; return json(200, { restored: true }); }
          return json(201, { token: "token", evidence: { mode: "exclusive", startedAt: "x", runningModels: [] } });
        },
      },
    )).rejects.toThrow("spawn failed");
    expect(restored).toBe(true);
  });

  it("restores when the gateway returns a token but malformed evidence", async () => {
    let restored = false;
    await expect(runMaintenanceWindowCommand(
      { baseUrl: "http://m5", ttlSeconds: 60, drainTimeoutSeconds: 5, command: ["true"] },
      {
        apiKey: "key",
        runChild: async () => 0,
        fetch: async (_input, init) => {
          if (init?.method === "GET") return json(200, { active: false });
          const body = JSON.parse(String(init?.body)) as { action: string };
          if (body.action === "close") { restored = true; return json(200, { restored: true }); }
          return json(201, { token: "token", evidence: { mode: "wrong" } });
        },
      },
    )).rejects.toThrow("malformed maintenance-window evidence");
    expect(restored).toBe(true);
  });

  it("parses only bounded flags before the command separator", () => {
    expect(parseMaintenanceWindowArgs([
      "--ttl-seconds", "120", "--drain-timeout-seconds", "10", "--", "npm", "test",
    ])).toMatchObject({ ttlSeconds: 120, drainTimeoutSeconds: 10, command: ["npm", "test"] });
    expect(() => parseMaintenanceWindowArgs(["--ttl-seconds", "0", "--", "true"])).toThrow();
    expect(() => parseMaintenanceWindowArgs(["--unknown", "x", "--", "true"])).toThrow();
    expect(() => parseMaintenanceWindowArgs([
      "--base-url", "https://secret@example.test", "--", "true",
    ])).toThrow(/without credentials/);
    expect(() => parseMaintenanceWindowArgs([
      "--ttl-seconds", "10", "--ttl-seconds", "20", "--", "true",
    ])).toThrow(/duplicate/);
  });

  it("does not pass the maintenance credential to the child environment", () => {
    expect(childEnvironmentWithoutMaintenanceKey({
      M5_MAINTENANCE_KEY: "do-not-inherit",
      PATH: "/usr/bin",
    })).toEqual({ PATH: "/usr/bin" });
  });
});
