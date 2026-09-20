import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  M5ClientError,
  createM5Client,
  diagnoseProfile,
  localTailnetRemediation,
  provisionRemediation,
  createFileAdoptionSpool,
  defaultTailnetProbe,
} from "../client/m5-client.mjs";
import { main as m5main } from "../client/m5.mjs";

const SECRET = "hs_owner_this-must-never-escape";

function refusedFetch() {
  return async () => {
    const error = new Error("connect ECONNREFUSED 127.0.0.1:8080") as Error & { code?: string };
    error.code = "ECONNREFUSED";
    throw error;
  };
}

function privateClient(options: {
  fetch?: typeof fetch;
  tailnet?: () => Promise<string>;
  evidenceSpoolDir?: string;
}) {
  return createM5Client({
    gatewayUrl: "http://private.invalid:8080",
    endpoint: "private",
    profile: "codex",
    credentialStore: { resolve: async () => SECRET },
    fetch: options.fetch ?? refusedFetch(),
    ...(options.tailnet === undefined ? {} : { localProbes: { tailnet: options.tailnet } }),
    ...(options.evidenceSpoolDir === undefined ? {} : { evidenceSpoolDir: options.evidenceSpoolDir }),
  });
}

const VALID_REPORT = {
  harness: "direct_cli",
  execution_mode: "ask",
  traffic_purpose: "organic",
  result: "completed",
  deterministic_check: "pass",
  reviewer_usefulness: "pass",
  fallback_reason: "none",
  eligible_opportunities: 1,
};

describe("connector failing layers (#242)", () => {
  it("names local_tailnet_unavailable with recovery when tailnet is down on the private path", async () => {
    const client = await privateClient({ tailnet: async () => "down" });
    const failure = await client.models().then(
      () => { throw new Error("expected failure"); },
      (error: unknown) => error as M5ClientError,
    );
    expect(failure).toBeInstanceOf(M5ClientError);
    expect(failure.code).toBe("network_failure");
    expect(failure.failureLayer).toBe("local_tailnet_unavailable");
    expect(failure.retryable).toBe(false);
    const serialized = JSON.stringify(failure.toJSON("codex"));
    expect(serialized).toContain("local_tailnet_unavailable");
    expect(serialized).toMatch(/tailscale/i);
    expect(serialized).toContain("m5 --profile codex doctor");
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain("private.invalid");
  });

  it("keeps gateway_transport when tailnet state is unknown", async () => {
    const client = await privateClient({ tailnet: async () => "unknown" });
    const failure = await client.models().then(
      () => { throw new Error("expected failure"); },
      (error: unknown) => error as M5ClientError,
    );
    expect(failure.failureLayer).toBe("gateway_transport");
  });

  it("never consults tailnet state on the public path", async () => {
    const tailnet = vi.fn(async () => "down");
    const client = await createM5Client({
      gatewayUrl: "https://public.invalid",
      profile: "codex",
      credentialStore: { resolve: async () => SECRET },
      fetch: refusedFetch(),
      localProbes: { tailnet },
    });
    const failure = await client.models().then(
      () => { throw new Error("expected failure"); },
      (error: unknown) => error as M5ClientError,
    );
    expect(tailnet).not.toHaveBeenCalled();
    expect(failure.failureLayer).toBe("gateway_transport");
  });

  it("falls back to gateway_transport when the probe itself misbehaves", async () => {
    const client = await privateClient({
      tailnet: async () => { throw new Error("probe exploded"); },
    });
    const failure = await client.models().then(
      () => { throw new Error("expected failure"); },
      (error: unknown) => error as M5ClientError,
    );
    expect(failure.failureLayer).toBe("gateway_transport");
  });

  it("routes missing-profile repair to the secret-safe provision flow", () => {
    expect(provisionRemediation("codex")).toContain("m5 --profile codex provision");
    expect(provisionRemediation("codex")).not.toContain(SECRET);
    expect(localTailnetRemediation("codex")).toContain("m5 --profile codex doctor");
  });
});

describe("doctor tailnet reporting (#242)", () => {
  const profileConfig = {
    publicGatewayUrl: "https://public.invalid",
    privateGatewayUrl: "http://private.invalid:8080",
  };
  const REQUIRED = ["list_models", "ask", "code_loop_start", "code_loop_status", "code_loop_result", "record_adoption_evidence"];

  // Healthy public path, dead private path: the classic tailnet-stopped shape.
  function splitFetch() {
    return async (input: unknown, init?: { body?: unknown }) => {
      const url = String(input);
      if (!url.startsWith("http://private.invalid")) {
        if (url.endsWith("/portal/me")) {
          return new Response(JSON.stringify({ alias: "codex-agent", tier: "owner", scope: "agent" }), { status: 200 });
        }
        const request = JSON.parse(String((init as { body?: unknown })?.body)) as { id: number; params?: { name?: string } };
        if (request.params?.name === "list_models") {
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: "Models available to you:\n- mellum — test" }], isError: false } }), { status: 200 });
        }
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { tools: REQUIRED.map((name) => ({ name, inputSchema: { type: "object" } })) } }), { status: 200 });
      }
      const error = new Error("connect ECONNREFUSED 127.0.0.1:8080") as Error & { code?: string };
      error.code = "ECONNREFUSED";
      throw error;
    };
  }

  it("reports tailnet_unavailable for a dead private path when tailnet is down", async () => {
    const result = await diagnoseProfile({
      profile: "codex",
      profileConfig,
      credentialStore: { resolve: async () => SECRET },
      fetch: splitFetch() as typeof fetch,
      localProbes: { tailnet: async () => "down" },
    });
    expect(result.status).toBe("tailnet_unavailable");
    expect(result.endpoints).toMatchObject({ public: "healthy", private: "tailnet_unavailable" });
    expect(JSON.stringify(result)).toMatch(/tailscale/i);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain("private.invalid");
  });

  it("maps a private identity timeout to the local layer when tailnet is down", async () => {
    const hangingPrivate = async (input: unknown, init?: { body?: unknown; signal?: AbortSignal }) => {
      const url = String(input);
      if (url.startsWith("http://private.invalid")) {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      }
      return splitFetch()(url, init);
    };
    const result = await diagnoseProfile({
      profile: "codex",
      profileConfig: {
        publicGatewayUrl: "https://public.invalid",
        privateGatewayUrl: "http://private.invalid:8080",
      },
      credentialStore: { resolve: async () => SECRET },
      fetch: hangingPrivate as typeof fetch,
      timeoutMs: 1000,
      localProbes: { tailnet: async () => "down" },
    });
    expect(result.endpoints).toMatchObject({ public: "healthy", private: "tailnet_unavailable" });
  });

  it("keeps the existing network_failure status when tailnet state is unknown", async () => {
    const result = await diagnoseProfile({
      profile: "codex",
      profileConfig,
      credentialStore: { resolve: async () => SECRET },
      fetch: splitFetch() as typeof fetch,
      localProbes: { tailnet: async () => "unknown" },
    });
    expect(result.status).toBe("network_failure");
    expect(result.endpoints).toMatchObject({ public: "healthy", private: "network_failure" });
  });
});

describe("adoption evidence spool (#242)", () => {
  let spoolDir: string;
  beforeEach(() => {
    spoolDir = mkdtempSync(join(tmpdir(), "m5-spool-test-"));
  });
  afterEach(() => {
    rmSync(spoolDir, { recursive: true, force: true });
  });

  function spooledClient(tailnet: () => Promise<string>) {
    return createM5Client({
      gatewayUrl: "http://private.invalid:8080",
      endpoint: "private",
      profile: "codex",
      credentialStore: { resolve: async () => SECRET },
      fetch: refusedFetch(),
      localProbes: { tailnet },
      adoptionSpool: createFileAdoptionSpool({ spoolDir }),
    });
  }

  function spooledPayloads(dir: string): unknown[] {
    return readdirSync(dir)
      .filter((name) => name.startsWith("adoption-"))
      .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")));
  }

  it("spools on transport failure with unknown tailnet and names the recovery", async () => {
    const client = await spooledClient(async () => "unknown");
    const failure = await client.reportAdoption(VALID_REPORT).then(
      () => { throw new Error("expected failure"); },
      (error: unknown) => error as M5ClientError,
    );
    expect(failure.code).toBe("network_failure");
    const serialized = JSON.parse(JSON.stringify(failure.toJSON("codex")));
    expect(serialized.error.evidence_recovery.status).toBe("spooled");
    expect(serialized.error.evidence_recovery.spool_id).toMatch(/^adoption-/);
    expect(serialized.error.evidence_recovery.action).toBe("retry_same_tool_call");
    const payloads = spooledPayloads(spoolDir);
    expect(payloads).toHaveLength(1);
    expect(JSON.stringify(payloads)).not.toContain(SECRET);
  });

  it("still spools when the tailnet layer makes the failure non-retryable", async () => {
    const client = await spooledClient(async () => "down");
    const failure = await client.reportAdoption(VALID_REPORT).then(
      () => { throw new Error("expected failure"); },
      (error: unknown) => error as M5ClientError,
    );
    expect(failure.failureLayer).toBe("local_tailnet_unavailable");
    expect(failure.retryable).toBe(false);
    const serialized = JSON.parse(JSON.stringify(failure.toJSON("codex")));
    expect(serialized.error.evidence_recovery.status).toBe("spooled");
    expect(spooledPayloads(spoolDir)).toHaveLength(1);
  });

  it("never spools an invalid report", async () => {
    const client = await spooledClient(async () => "unknown");
    const failure = await client.reportAdoption({ nope: true }).then(
      () => { throw new Error("expected failure"); },
      (error: unknown) => error as M5ClientError,
    );
    expect(failure.code).toBe("invalid_adoption_report");
    expect(spooledPayloads(spoolDir)).toHaveLength(0);
  });
});

describe("tailnet probe semantics (#242)", () => {
  function fakeExec(outcome: { error?: { code?: unknown; killed?: boolean } }) {
    return ((_cmd: string, _args: string[], _opts: unknown, cb: (error: unknown) => void) => {
      cb(outcome.error ?? null);
    }) as never;
  }

  it.each([
    ["clean exit", {}, "up"],
    ["non-zero exit", { error: { code: 1 } }, "down"],
    ["missing CLI", { error: { code: "ENOENT" } }, "unknown"],
    ["permission error", { error: { code: "EACCES" } }, "unknown"],
    ["timeout kill", { error: { code: "ETIMEDOUT", killed: true } }, "unknown"],
  ])("default probe maps %s to %s", async (_label, outcome, expected) => {
    await expect(defaultTailnetProbe(fakeExec(outcome))).resolves.toBe(expected);
  });

  it("maps a private-path timeout to the local layer when tailnet is down", async () => {
    const client = await createM5Client({
      gatewayUrl: "http://private.invalid:8080",
      endpoint: "private",
      profile: "codex",
      credentialStore: { resolve: async () => SECRET },
      fetch: (_input: unknown, init?: { signal?: AbortSignal }) =>
        new Promise(((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const error = new Error("aborted") as Error & { code?: string };
            error.code = "ETIMEDOUT";
            reject(error);
          });
        }) as never),
      timeoutMs: 1_000,
      localProbes: { tailnet: async () => "down" },
    });
    const failure = await client.models().then(
      () => { throw new Error("expected failure"); },
      (error: unknown) => error as M5ClientError,
    );
    expect(failure.code).toBe("timeout");
    expect(failure.failureLayer).toBe("local_tailnet_unavailable");
  });

  it("keeps gateway_transport for a reset after response headers arrived", async () => {
    const client = await createM5Client({
      gatewayUrl: "http://private.invalid:8080",
      endpoint: "private",
      profile: "codex",
      credentialStore: { resolve: async () => SECRET },
      fetch: async () => ({
        status: 200,
        headers: new Headers(),
        text: () => Promise.reject(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })),
      }),
      localProbes: { tailnet: async () => "down" },
    });
    const failure = await client.models().then(
      () => { throw new Error("expected failure"); },
      (error: unknown) => error as M5ClientError,
    );
    expect(failure.failureLayer).toBe("gateway_transport");
    expect(failure.remediation).not.toMatch(/no request reached/i);
  });
});
