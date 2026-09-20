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

  function spooledClient() {
    return createM5Client({
      gatewayUrl: "http://private.invalid:8080",
      endpoint: "private",
      profile: "codex",
      credentialStore: { resolve: async () => SECRET },
      fetch: refusedFetch(),
      adoptionSpool: createFileAdoptionSpool({ spoolDir }),
    });
  }

  it("spools a validated report on transport failure and names the recovery", async () => {
    const client = await spooledClient();
    const failure = await client.reportAdoption(VALID_REPORT).then(
      () => { throw new Error("expected failure"); },
      (error: unknown) => error as M5ClientError,
    );
    expect(failure.code).toBe("network_failure");
    const serialized = JSON.parse(JSON.stringify(failure.toJSON("codex")));
    expect(serialized.error.evidence_recovery.status).toBe("spooled");
    expect(serialized.error.evidence_recovery.spool_id).toMatch(/^adoption-/);
    expect(serialized.error.evidence_recovery.action).toBe("retry_same_tool_call");
    expect(JSON.stringify(stored(spoolDir))).not.toContain(SECRET);
  });

  it("never spools an invalid report", async () => {
    const client = await spooledClient();
    const failure = await client.reportAdoption({ nope: true }).then(
      () => { throw new Error("expected failure"); },
      (error: unknown) => error as M5ClientError,
    );
    expect(failure.code).toBe("invalid_adoption_report");
    expect(listSpoolFiles(spoolDir)).toHaveLength(0);
  });
});

function stored(spoolDir: string): unknown {
  const files = listSpoolFiles(spoolDir);
  expect(files).toHaveLength(1);
  return JSON.parse(readFileSync(join(spoolDir, files[0] as string), "utf8"));
}

function listSpoolFiles(spoolDir: string): string[] {
  return readdirSync(spoolDir).filter((name) => name.startsWith("adoption-"));
}

describe("CLI route failures (#242)", () => {
  function sink() {
    let value = "";
    return { stream: { write(chunk: string) { value += chunk; return true; } }, text: () => value };
  }

  async function runCli(argv: string[], config: unknown) {
    const output = sink();
    const error = sink();
    const exitCode = await m5main(argv, {
      input: Readable.from([]),
      output: output.stream,
      error: error.stream,
      configLoader: () => config,
      credentialStore: { resolve: async () => SECRET },
    });
    return { exitCode, body: JSON.parse(error.text()) };
  }

  it("routes a missing profile to the provision flow", async () => {
    const { exitCode, body } = await runCli(["--profile", "nope", "models"], { version: 1, profiles: {} });
    expect(exitCode).toBe(1);
    expect(body.error.code).toBe("unknown_profile");
    expect(body.error.remediation).toContain("m5 --profile nope provision");
  });

  it("names public_route_unconfigured for a missing private path", async () => {
    const { exitCode, body } = await runCli(
      ["--profile", "codex", "--private", "models"],
      { version: 1, profiles: { codex: { publicGatewayUrl: "https://public.invalid" } } },
    );
    expect(exitCode).toBe(1);
    expect(body.error.code).toBe("endpoint_not_configured");
    expect(body.error.failure_layer).toBe("public_route_unconfigured");
    expect(body.error.retryable).toBe(false);
    expect(body.error.remediation).toContain("m5 --profile codex doctor");
  });
});
