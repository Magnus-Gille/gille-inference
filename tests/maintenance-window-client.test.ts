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
        runChild: async (_command, opened, signal) => {
          observedRunningModels = opened?.runningModels;
          expect(signal.aborted).toBe(false);
          return 0;
        },
        fetch: async (_input, init) => {
          if (init?.method === "GET") return json(200, { active: false, evidence: null });
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          requests.push(body);
          if (body.action === "open") {
            return json(201, {
              token: "opaque-release-token",
              evidence: { mode: "exclusive", startedAt: "1970-01-01T00:00:01.000Z", expiresAt: "1970-01-01T00:01:00.000Z", runningModels: [] },
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
          return json(201, { token: "token", evidence: { mode: "exclusive", startedAt: "x", expiresAt: "2099-01-01T00:00:00.000Z", runningModels: [] } });
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

  it("aborts child work before the server-owned TTL can release exclusion", async () => {
    let observedAbort = false;
    const evidence = await runMaintenanceWindowCommand(
      {
        baseUrl: "http://m5",
        ttlSeconds: 60,
        drainTimeoutSeconds: 5,
        abortBeforeExpirySeconds: 0.04,
        command: ["long-job"],
      },
      {
        apiKey: "key",
        now: () => 0,
        runChild: async (_command, _opened, signal) => new Promise<number>((resolve) => {
          signal.addEventListener("abort", () => { observedAbort = true; resolve(143); }, { once: true });
        }),
        fetch: async (_input, init) => {
          if (init?.method === "GET") return json(200, { active: false });
          const body = JSON.parse(String(init?.body)) as { action: string };
          if (body.action === "close") return json(200, { restored: true });
          return json(201, {
            token: "token",
            evidence: {
              mode: "exclusive",
              startedAt: "1970-01-01T00:00:00.000Z",
              expiresAt: "1970-01-01T00:00:00.050Z",
              runningModels: [],
            },
          });
        },
      },
    );
    expect(observedAbort).toBe(true);
    expect(evidence.childExitCode).toBe(143);
    expect(evidence.restored).toBe(true);
  });

  it("rejects a cleanup reserve that could extend child work past the TTL", async () => {
    await expect(runMaintenanceWindowCommand(
      {
        baseUrl: "http://m5",
        ttlSeconds: 60,
        drainTimeoutSeconds: 5,
        abortBeforeExpirySeconds: -1,
        command: ["job"],
      },
      { apiKey: "key", fetch, runChild: async () => 0 },
    )).rejects.toThrow(/abortBeforeExpirySeconds/);
  });

  it("aborts a hung opening request before a maintenance token exists", async () => {
    const termination = new AbortController();
    let childRan = false;
    const opening = runMaintenanceWindowCommand(
      { baseUrl: "http://m5", ttlSeconds: 60, drainTimeoutSeconds: 5, command: ["job"] },
      {
        apiKey: "key",
        signal: termination.signal,
        runChild: async () => { childRan = true; return 0; },
        fetch: async (_input, init) => new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        }),
      },
    );
    termination.abort(new Error("model evaluation interrupted by SIGTERM"));
    await expect(opening).rejects.toThrow(/interrupted by SIGTERM/);
    expect(childRan).toBe(false);
  });
  it("closes after success when cleanup release is proved", async () => {
    const actions: string[] = [];
    const evidence = await runMaintenanceWindowCommand(
      { baseUrl: "http://m5", ttlSeconds: 60, drainTimeoutSeconds: 5, command: ["ok"] },
      {
        apiKey: "key",
        canReleaseWindow: () => true,
        runChild: async () => 0,
        fetch: async (_input, init) => {
          if (init?.method === "GET") return json(200, { active: false });
          const body = JSON.parse(String(init?.body)) as { action: string };
          actions.push(body.action);
          if (body.action === "open") {
            return json(201, {
              token: "close-token-success",
              evidence: { mode: "exclusive", startedAt: "x", expiresAt: "2099-01-01T00:00:00.000Z", runningModels: [] },
            });
          }
          return json(200, { restored: true });
        },
      },
    );
    expect(actions).toEqual(["open", "close"]);
    expect(evidence.restored).toBe(true);
  });

  it("closes after a child failure when cleanup release is proved", async () => {
    let closed = false;
    await expect(runMaintenanceWindowCommand(
      { baseUrl: "http://m5", ttlSeconds: 60, drainTimeoutSeconds: 5, command: ["bad"] },
      {
        apiKey: "key",
        canReleaseWindow: () => true,
        runChild: async () => { throw new Error("child failed"); },
        fetch: async (_input, init) => {
          if (init?.method === "GET") return json(200, { active: false });
          const body = JSON.parse(String(init?.body)) as { action: string };
          if (body.action === "close") { closed = true; return json(200, { restored: true }); }
          return json(201, { token: "close-token-failure", evidence: { mode: "exclusive", startedAt: "x", expiresAt: "2099-01-01T00:00:00.000Z", runningModels: [] } });
        },
      },
    )).rejects.toThrow("child failed");
    expect(closed).toBe(true);
  });

  it("retains exclusion without close or status checks when release cannot be proved", async () => {
    const requests: string[] = [];
    const retained = await runMaintenanceWindowCommand(
      { baseUrl: "http://m5", ttlSeconds: 60, drainTimeoutSeconds: 5, command: ["ok"] },
      {
        apiKey: "key",
        canReleaseWindow: () => false,
        runChild: async () => 0,
        fetch: async (_input, init) => {
          if (init?.method === "GET") requests.push("status");
          else requests.push(JSON.parse(String(init?.body)).action);
          return json(201, {
            token: "opaque-retained-token",
            evidence: { mode: "exclusive", startedAt: "x", expiresAt: "2099-01-01T00:00:00.000Z", runningModels: [] },
          });
        },
      },
    ).catch((error: unknown) => error);
    expect(retained).toBeInstanceOf(Error);
    expect((retained as Error).message).toContain("retained until server expiry");
    expect((retained as Error).message).not.toContain("opaque-retained-token");
    expect(requests).toEqual(["open"]);
  });

  it("retains exclusion and preserves the child cause when release cannot be proved", async () => {
    const childError = new Error("child failed");
    const requests: string[] = [];
    const retained = await runMaintenanceWindowCommand(
      { baseUrl: "http://m5", ttlSeconds: 60, drainTimeoutSeconds: 5, command: ["bad"] },
      {
        apiKey: "key",
        canReleaseWindow: () => false,
        runChild: async () => { throw childError; },
        fetch: async (_input, init) => {
          if (init?.method === "GET") requests.push("status");
          else requests.push(JSON.parse(String(init?.body)).action);
          return json(201, {
            token: "opaque-retained-failure-token",
            evidence: { mode: "exclusive", startedAt: "x", expiresAt: "2099-01-01T00:00:00.000Z", runningModels: [] },
          });
        },
      },
    ).catch((error: unknown) => error);
    expect(retained).toBeInstanceOf(Error);
    expect((retained as Error).message).toContain("operator intervention required");
    expect((retained as Error).message).not.toContain("opaque-retained-failure-token");
    expect((retained as Error & { cause?: unknown }).cause).toBe(childError);
    expect(requests).toEqual(["open"]);
  });

  it("does not invoke release gating when opening returns no token", async () => {
    let releaseGateCalls = 0;
    const result = runMaintenanceWindowCommand(
      { baseUrl: "http://m5", ttlSeconds: 60, drainTimeoutSeconds: 5, command: ["ok"] },
      {
        apiKey: "key",
        canReleaseWindow: () => { releaseGateCalls++; return false; },
        runChild: async () => 0,
        fetch: async () => json(201, {
          evidence: { mode: "exclusive", startedAt: "x", expiresAt: "2099-01-01T00:00:00.000Z", runningModels: [] },
        }),
      },
    );
    await expect(result).rejects.toThrow("malformed maintenance-window response");
    expect(releaseGateCalls).toBe(0);
  });

});
