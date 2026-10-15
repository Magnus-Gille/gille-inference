import { describe, expect, it, vi } from "vitest";
import {
  M5ClientError,
  diagnoseProfile,
  transportRemediation,
} from "../client/m5-client.mjs";

const SECRET = "hs_doctor_discovery_secret_must_not_escape";
const LOCATOR = "https://private-gateway.invalid:8443";
const MODEL = "mellum-private-test-model";
const ERROR_TEXT = "upstream catalogue failure must not escape";
const PROFILE = {
  publicGatewayUrl: "https://public-gateway.invalid",
  privateGatewayUrl: "http://private-gateway.invalid:8080",
};
const REQUIRED_TOOLS = [
  "list_models",
  "ask",
  "code_loop_start",
  "code_loop_status",
  "code_loop_result",
  "record_adoption_evidence",
];

const NETWORK_DIAGNOSTIC_CODES = new Set([
  "dns_failure",
  "connection_refused",
  "route_unreachable",
  "connection_reset",
  "connect_timeout",
  "tls_failure",
  "network_failure",
  "gateway_http_error",
]);
const FAILURE_LAYERS = new Set([
  "authentication",
  "gateway_transport",
  "gateway_health",
  "gateway_protocol",
]);

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function rpcResult(id: number, result: unknown): Response {
  return jsonResponse({ jsonrpc: "2.0", id, result });
}

type DiscoveryFailure =
  | "public_refused"
  | "public_refused_with_malicious_remediation"
  | "private_refused"
  | "public_timeout"
  | "public_http_503"
  | "public_malicious_metadata"
  | "public_tool_error"
  | "public_rejected_discovery"
  | "private_rejected_discovery";

type DiagnoseOptions = {
  failure?: DiscoveryFailure;
  credential?: string | null;
  publicTools?: string[];
  privateTools?: string[];
  rejectPublic?: number;
  publicTransport?: string;
  privateTransport?: string;
  publicObservation?: unknown;
  privateObservation?: unknown;
  inferenceProbe?: { route: "public" | "private"; model: string };
  askFailure?: boolean;
  askSuccess?: boolean;
  askTemporaryFailure?: boolean;
  profileConfig?: { publicGatewayUrl: string; privateGatewayUrl?: string };
  visitedEndpoints?: string[];
  timeoutMs?: number;
};

function discoveryFailureForEndpoint(
  endpoint: "public" | "private",
  failure: DiscoveryFailure | undefined,
): DiscoveryFailure | undefined {
  if (failure === undefined) return undefined;
  if (failure.startsWith("private_")) return endpoint === "private" ? failure : undefined;
  return endpoint === "public" ? failure : undefined;
}

async function diagnose({
  failure,
  credential = SECRET,
  publicTools = REQUIRED_TOOLS,
  privateTools = publicTools,
  rejectPublic,
  publicTransport = "available",
  privateTransport = publicTransport,
  publicObservation,
  privateObservation,
  inferenceProbe,
  askFailure = false,
  askSuccess = false,
  askTemporaryFailure = false,
  profileConfig = PROFILE,
  visitedEndpoints,
  timeoutMs = failure === "public_timeout" ? 1_000 : 10_000,
}: DiagnoseOptions = {}) {
  let askCalls = 0;
  const askEndpoints: string[] = [];
  const result = await diagnoseProfile({
    profile: "codex",
    profileConfig,
    // Make private-route failure classification deterministic across hosts with and without
    // a configured Tailscale CLI. These tests exercise the gateway transport, not host state.
    localProbes: { tailnet: async () => "up" },
    credentialStore: {
      resolve: async () => {
        if (credential === null) {
          throw new M5ClientError("missing_credential", `missing ${SECRET}`);
        }
        return credential;
      },
    },
    timeoutMs,
    inferenceProbe,
    fetch: async (input, init) => {
      const url = String(input);
      const isPrivate = Boolean(profileConfig.privateGatewayUrl) && url.startsWith(profileConfig.privateGatewayUrl);
      const endpoint = isPrivate ? "private" : "public";
      visitedEndpoints?.push(endpoint);
      if (url.endsWith("/portal/me")) {
        if (!isPrivate && rejectPublic !== undefined) {
          return rejectPublic === 530
            ? new Response("<title>Error 1033</title>", {
                status: 530, headers: { server: "cloudflare" },
              })
            : new Response("", { status: rejectPublic });
        }
        return jsonResponse({
          alias: "doctor-agent", tier: "owner", scope: "agent",
          ...((isPrivate ? privateObservation : publicObservation) === undefined ? {} : {
            inferenceObservation: isPrivate ? privateObservation : publicObservation,
          }),
        });
      }
      if (url.endsWith("/healthz")) {
        expect(init?.headers).not.toHaveProperty("authorization");
        return jsonResponse({ ok: true, codeLoopTransport: isPrivate ? privateTransport : publicTransport });
      }

      const request = JSON.parse(String(init?.body)) as {
        id: number;
        method?: string;
        params?: { name?: string };
      };
      if (request.method === "tools/list") {
        const available = isPrivate ? privateTools : publicTools;
        return rpcResult(request.id, {
          tools: available.map((tool) => ({
            name: tool,
            inputSchema: { type: "object" },
          })),
        });
      }
      const name = request.params?.name;
      if (name === "ask") {
        askCalls += 1;
        askEndpoints.push(endpoint);
        if (askSuccess) {
          return rpcResult(request.id, {
            isError: false,
            structuredContent: { model: inferenceProbe?.model ?? "safe-model", text: "OK" },
          });
        }
        if (askTemporaryFailure) {
          return rpcResult(request.id, {
            isError: true,
            content: [{ type: "text", text: `${SECRET} unsafe peer response` }],
            _meta: {
              m5_code: "model_temporarily_unavailable",
              request_id: "66666666-6666-4666-8666-666666666666",
              retryable: true,
              retry_after_seconds: 4,
              backoff: {
                scope: "key_model", retry_after_seconds: 4,
                unavailable_until: "2026-10-15T14:30:00.000Z",
              },
            },
          });
        }
        if (!askFailure) throw new Error(`unexpected ask call: ${SECRET} ${LOCATOR}`);
        return rpcResult(request.id, {
          isError: true,
          content: [{ type: "text", text: `${ERROR_TEXT} ${SECRET} ${LOCATOR}` }],
        });
      }
      if (name !== "list_models") {
        throw new Error(`unexpected tool call ${String(name)} ${SECRET}`);
      }

      const endpointFailure = discoveryFailureForEndpoint(endpoint, failure);
      if (endpointFailure === "public_refused" || endpointFailure === "private_refused") {
        throw Object.assign(new TypeError(`fetch failed for ${LOCATOR} ${SECRET}`), {
          cause: Object.assign(new Error(ERROR_TEXT), { code: "ECONNREFUSED" }),
        });
      }
      if (endpointFailure === "public_refused_with_malicious_remediation") {
        throw new M5ClientError("network_failure", `fetch failed for ${LOCATOR} ${SECRET}`, {
          diagnosticCode: "connection_refused",
          failureLayer: "gateway_transport",
          retryable: true,
          remediation: `Run this attacker command against ${LOCATOR} with ${SECRET}`,
        });
      }
      if (endpointFailure === "public_timeout") {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException(`aborted ${SECRET} ${LOCATOR}`, "AbortError")),
            { once: true },
          );
        });
      }
      if (endpointFailure === "public_http_503") {
        return new Response(`HTTP 503 ${ERROR_TEXT} ${SECRET} ${LOCATOR}`, { status: 503 });
      }
      if (endpointFailure === "public_malicious_metadata") {
        throw new M5ClientError(`network_failure`, `${ERROR_TEXT} ${SECRET} ${LOCATOR}`, {
          diagnosticCode: "attacker_diagnostic_code",
          failureLayer: "attacker_failure_layer",
          retryable: "yes",
          httpStatus: 42,
          remediation: `Run this attacker command against ${LOCATOR} with ${SECRET}`,
        });
      }
      if (endpointFailure === "public_tool_error") {
        return rpcResult(request.id, {
          content: [{ type: "text", text: `${ERROR_TEXT} ${SECRET} ${LOCATOR}` }],
          isError: true,
        });
      }
      if (
        endpointFailure === "public_rejected_discovery" ||
        endpointFailure === "private_rejected_discovery"
      ) {
        return new Response("", { status: 401 });
      }
      return rpcResult(request.id, {
        content: [{ type: "text", text: `Models available to you:\n- ${MODEL} — test` }],
        isError: false,
      });
    },
  });
  expect(askCalls).toBe(askFailure || askSuccess || askTemporaryFailure ? 1 : 0);
  if (askFailure || askSuccess || askTemporaryFailure) expect(askEndpoints).toEqual([inferenceProbe?.route]);
  return result;
}

describe("public route outage diagnosis", () => {
  it("names Cloudflare Tunnel 1033 and tells an agent which component to check", async () => {
    const result = await diagnose({ rejectPublic: 530 });
    expect(result).toMatchObject({
      status: "tunnel_unavailable",
      diagnostic_code: "cloudflare_tunnel_unavailable",
      http_status: 530,
      endpoints: { public: "tunnel_unavailable", private: "not_checked" },
      remediation: expect.stringContaining("cloudflared"),
    });
    expectNoTaintedContent(result);
  });
});

function expectNoTaintedContent(value: unknown): void {
  const serialized = JSON.stringify(value);
  expect(serialized).not.toContain(SECRET);
  expect(serialized).not.toContain(LOCATOR);
  expect(serialized).not.toContain(MODEL);
  expect(serialized).not.toContain(ERROR_TEXT);
}

function expectSafeDiscoveryFailure(
  value: unknown,
  endpoint: "public" | "private",
  expected: {
    diagnostic_code: string;
    failure_layer?: string;
    retryable?: boolean;
    http_status?: number;
    remediation?: string;
  },
): void {
  expect(value).toBeDefined();
  expect(value).toMatchObject({ endpoint, ...expected });
  const failure = value as Record<string, unknown>;
  expect(NETWORK_DIAGNOSTIC_CODES.has(String(failure.diagnostic_code))).toBe(true);
  if (failure.failure_layer !== undefined) {
    expect(FAILURE_LAYERS.has(String(failure.failure_layer))).toBe(true);
  }
  if (failure.retryable !== undefined) expect(typeof failure.retryable).toBe("boolean");
  if (failure.http_status !== undefined) {
    expect(Number.isInteger(failure.http_status)).toBe(true);
    expect(Number(failure.http_status)).toBeGreaterThanOrEqual(100);
    expect(Number(failure.http_status)).toBeLessThanOrEqual(599);
  }
  if (failure.remediation !== undefined) {
    expect(failure.remediation).toBe(transportRemediation("codex"));
  }
  expectNoTaintedContent(value);
}

describe("m5 doctor model-discovery diagnostics", () => {
  it("probes a healthy selected private route without touching an unavailable public route", async () => {
    const visited: string[] = [];
    const result = await diagnose({
      failure: "public_refused",
      inferenceProbe: { route: "private", model: "safe-model" },
      askSuccess: true,
      visitedEndpoints: visited,
    });
    expect(visited.length).toBeGreaterThan(0);
    expect(new Set(visited)).toEqual(new Set(["private"]));
    expect(result).toMatchObject({
      status: "mcp_reachable",
      inference: { public: "not_checked", private: "succeeded" },
      inference_probe: { status: "succeeded", route: "private", model: "safe-model" },
      endpoints: { public: "not_checked", private: "healthy" },
    });
    expectNoTaintedContent(result);
  });

  it("never touches the unselected private route for a selected public probe", async () => {
    const visited: string[] = [];
    const result = await diagnose({
      inferenceProbe: { route: "public", model: "safe-model" },
      askSuccess: true,
      visitedEndpoints: visited,
    });
    expect(visited.length).toBeGreaterThan(0);
    expect(new Set(visited)).toEqual(new Set(["public"]));
    expect(result).toMatchObject({
      inference: { public: "succeeded", private: "not_checked" },
      inference_probe: { status: "succeeded", route: "public", model: "safe-model" },
      endpoints: { public: "healthy", private: "not_checked" },
    });
  });

  it("validates the exported inferenceProbe contract before credential or network access", async () => {
    for (const inferenceProbe of [
      null,
      {},
      { route: "sideways", model: "safe-model" },
      { route: "public", model: "bad model" },
      { route: "public", model: "safe-model", extra: true },
    ]) {
      let credentialCalls = 0;
      let fetchCalls = 0;
      await expect(diagnoseProfile({
        profile: "codex",
        profileConfig: PROFILE,
        inferenceProbe: inferenceProbe as never,
        credentialStore: { resolve: async () => { credentialCalls += 1; return SECRET; } },
        fetch: async () => { fetchCalls += 1; throw new Error("unexpected fetch"); },
      })).rejects.toMatchObject({ code: "invalid_args" });
      expect(credentialCalls).toBe(0);
      expect(fetchCalls).toBe(0);
    }
  });

  it("does not ask when the selected catalogue does not advertise ask", async () => {
    const result = await diagnose({
      publicTools: REQUIRED_TOOLS.filter((tool) => tool !== "ask"),
      inferenceProbe: { route: "public", model: "safe-model" },
    });
    expect(result).toMatchObject({
      status: "missing_tools",
      inference_probe: {
        status: "not_checked", route: "public", model: "safe-model",
        diagnostic_code: "ask_not_advertised",
      },
    });
    expect(result.inference).toEqual({ public: "not_checked", private: "not_checked" });
  });

  it("keeps an explicit probe not_checked when catalogue gates fail", async () => {
    const result = await diagnose({
      failure: "public_refused",
      inferenceProbe: { route: "public", model: "safe-model" },
    });
    expect(result).toMatchObject({
      status: "model_discovery_unavailable",
      inference: { public: "not_checked", private: "not_checked" },
      inference_probe: { status: "not_checked", route: "public", model: "safe-model" },
      health_scope: "mcp_catalogue_only",
    });
    expect(result.inference_probe).not.toHaveProperty("checked_at");
  });

  it("reports a sanitized explicit inference failure and preserves historical observation", async () => {
    const result = await diagnose({
      inferenceProbe: { route: "private", model: "safe-model" },
      askFailure: true,
      publicObservation: {
        source: "request_log", scope: "m5_global", status: "observed",
        lastSuccessfulAt: "2026-10-08T12:34:56.000Z",
      },
      privateObservation: {
        source: "request_log", scope: "m5_global", status: "observed",
        lastSuccessfulAt: "2026-10-08T12:34:56.000Z",
      },
    });
    expect(result).toMatchObject({
      status: "degraded",
      health_scope: "mcp_catalogue_and_inference_probe",
      inference: { public: "not_checked", private: "failed" },
      inference_probe: {
        status: "failed", route: "private", model: "safe-model", diagnostic_code: "tool_error",
      },
      inference_observation: {
        scope: "m5_global",
        public: { status: "not_checked", last_successful_at: null },
        private: { status: "observed", last_successful_at: "2026-10-08T12:34:56.000Z" },
      },
    });
    expect(Number.isSafeInteger(result.inference_probe.elapsed_ms)).toBe(true);
    expectNoTaintedContent(result);
  });

  it("projects temporary model failure into doctor without exposing backoff or request id", async () => {
    const result = await diagnose({
      inferenceProbe: { route: "private", model: "safe-model" },
      askTemporaryFailure: true,
    });
    expect(result).toMatchObject({
      status: "degraded",
      inference: { public: "not_checked", private: "failed" },
      inference_probe: {
        status: "failed", route: "private", model: "safe-model",
        diagnostic_code: "model_temporarily_unavailable",
      },
    });
    expect(result.inference_probe).not.toHaveProperty("backoff");
    expect(result.inference_probe).not.toHaveProperty("request_id");
    expect(JSON.stringify(result)).not.toContain("66666666-6666-4666-8666-666666666666");
    expect(JSON.stringify(result)).not.toContain("unavailable_until");
    expectNoTaintedContent(result);
  });

  it("caps the explicit selected-route request timeout at 30 seconds", async () => {
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      await diagnose({
        inferenceProbe: { route: "public", model: "safe-model" },
        askSuccess: true,
        timeoutMs: 120_000,
      });
      const delays = timeoutSpy.mock.calls.map(([, delay]) => Number(delay));
      expect(delays).toContain(30_000);
      expect(delays.every((delay) => delay <= 30_000)).toBe(true);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it("labels historical successful inference without claiming current readiness", async () => {
    const observation = {
      source: "request_log", scope: "m5_global", status: "observed",
      lastSuccessfulAt: "2026-10-08T12:34:56.000Z",
    };
    const result = await diagnose({ publicObservation: observation, privateObservation: observation });
    expect(result).toMatchObject({
      inference: { public: "not_checked", private: "not_checked" },
      inference_observation: {
        source: "request_log", scope: "m5_global",
        public: { status: "observed", last_successful_at: observation.lastSuccessfulAt },
        private: { status: "observed", last_successful_at: observation.lastSuccessfulAt },
      },
    });
  });

  it("does not echo malformed or absent inference observation metadata", async () => {
    const result = await diagnose({
      publicObservation: {
        source: "request_log", scope: "m5_global", status: "observed",
        lastSuccessfulAt: `${LOCATOR}/${SECRET}`,
      },
    });
    expect(result).toMatchObject({
      inference_observation: {
        public: { status: "invalid", last_successful_at: null },
        private: { status: "not_supported", last_successful_at: null },
      },
    });
    expectNoTaintedContent(result);

    const inconsistent = await diagnose({
      publicObservation: {
        source: "request_log", scope: "m5_global", status: "none",
        lastSuccessfulAt: "2026-10-08T12:34:56.000Z",
      },
    });
    expect(inconsistent.inference_observation.public).toEqual({ status: "invalid", last_successful_at: null });
  });

  it.each(["none", "disabled", "unavailable"] as const)(
    "preserves a safe %s historical observation without inventing a timestamp",
    async (status) => {
      const observation = {
        source: "request_log", scope: "m5_global", status, lastSuccessfulAt: null,
      };
      const result = await diagnose({ publicObservation: observation, privateObservation: observation });
      expect(result.inference).toEqual({ public: "not_checked", private: "not_checked" });
      expect(result.inference_observation).toMatchObject({
        public: { status, last_successful_at: null },
        private: { status, last_successful_at: null },
      });
    }
  );

  it("retains the existing public top-level diagnosis and adds a safe refusal detail", async () => {
    const result = await diagnose({ failure: "public_refused" });

    expect(result).toMatchObject({
      status: "model_discovery_unavailable",
      diagnostic_code: "model_discovery_unavailable",
      model_discovery: { public: "unavailable", private: "not_checked" },
      inference: { public: "not_checked", private: "not_checked" },
      endpoints: { public: "model_discovery_unavailable", private: "not_checked" },
      connector: { status: "unsupported" },
    });
    expectSafeDiscoveryFailure(result.discovery_failure, "public", {
      diagnostic_code: "connection_refused",
      failure_layer: "gateway_transport",
      retryable: true,
    });
  });

  it("adds the same scoped detail for a private discovery refusal", async () => {
    const result = await diagnose({ failure: "private_refused" });

    expect(result).toMatchObject({
      status: "model_discovery_unavailable",
      diagnostic_code: "model_discovery_unavailable",
      model_discovery: { public: "available", private: "unavailable" },
      inference: { public: "not_checked", private: "not_checked" },
      endpoints: { public: "healthy", private: "model_discovery_unavailable" },
      connector: { status: "unsupported" },
    });
    expectSafeDiscoveryFailure(result.discovery_failure, "private", {
      diagnostic_code: "connection_refused",
      failure_layer: "gateway_transport",
      retryable: true,
    });
  });

  it("classifies a real request abort as a connect timeout", async () => {
    const result = await diagnose({ failure: "public_timeout" });

    expect(result).toMatchObject({
      status: "model_discovery_unavailable",
      diagnostic_code: "model_discovery_unavailable",
      model_discovery: { public: "unavailable", private: "not_checked" },
      inference: { public: "not_checked", private: "not_checked" },
    });
    expectSafeDiscoveryFailure(result.discovery_failure, "public", {
      diagnostic_code: "connect_timeout",
      failure_layer: "gateway_transport",
      retryable: true,
    });
  });

  it("classifies an HTTP 503 as gateway health with bounded status metadata", async () => {
    const result = await diagnose({ failure: "public_http_503" });

    expect(result).toMatchObject({
      status: "model_discovery_unavailable",
      diagnostic_code: "model_discovery_unavailable",
      model_discovery: { public: "unavailable", private: "not_checked" },
      inference: { public: "not_checked", private: "not_checked" },
    });
    expectSafeDiscoveryFailure(result.discovery_failure, "public", {
      diagnostic_code: "gateway_http_error",
      failure_layer: "gateway_health",
      retryable: true,
      http_status: 503,
      remediation: transportRemediation("codex"),
    });
  });

  it("uses fixed local remediation for an allowlisted transport code", async () => {
    const result = await diagnose({ failure: "public_refused_with_malicious_remediation" });

    expect(result).toMatchObject({
      status: "model_discovery_unavailable",
      diagnostic_code: "model_discovery_unavailable",
      model_discovery: { public: "unavailable", private: "not_checked" },
    });
    expectSafeDiscoveryFailure(result.discovery_failure, "public", {
      diagnostic_code: "connection_refused",
      failure_layer: "gateway_transport",
      retryable: true,
      remediation: transportRemediation("codex"),
    });
  });

  it("falls back to the stable discovery code when error metadata is malicious", async () => {
    const result = await diagnose({ failure: "public_malicious_metadata" });

    expect(result).toMatchObject({
      status: "model_discovery_unavailable",
      diagnostic_code: "model_discovery_unavailable",
      model_discovery: { public: "unavailable", private: "not_checked" },
    });
    expect(result.discovery_failure).toEqual({
      endpoint: "public",
      diagnostic_code: "model_discovery_unavailable",
    });
    expectNoTaintedContent(result);
  });

  it("does not copy an MCP error response into discovery_failure", async () => {
    const result = await diagnose({ failure: "public_tool_error" });

    expect(result).toMatchObject({
      status: "model_discovery_unavailable",
      diagnostic_code: "model_discovery_unavailable",
      model_discovery: { public: "unavailable", private: "not_checked" },
    });
    expect(result.discovery_failure).toEqual({
      endpoint: "public",
      diagnostic_code: "model_discovery_unavailable",
    });
    expectNoTaintedContent(result);
  });

  it("does not add discovery_failure to healthy output", async () => {
    const result = await diagnose();

    expect(result).toMatchObject({
      status: "mcp_reachable",
      health_scope: "mcp_catalogue_only",
      client_version: "1.5.4",
      profile: "codex",
      credential: "present",
      model_discovery: { public: "available", private: "available" },
      inference: { public: "not_checked", private: "not_checked" },
      code_loop_transport: { public: "available", private: "available" },
      endpoints: { public: "healthy", private: "healthy" },
      connector: { status: "unsupported" },
    });
    expect(result).not.toHaveProperty("discovery_failure");
    expectNoTaintedContent(result);
  });

  it("retains historical observations while a code-loop transport outage stays degraded", async () => {
    const result = await diagnose({
      publicTransport: "unavailable", privateTransport: "unavailable",
      publicObservation: {
        source: "request_log", scope: "m5_global", status: "observed",
        lastSuccessfulAt: "2026-10-08T12:34:56.000Z",
      },
      privateObservation: {
        source: "request_log", scope: "m5_global", status: "none", lastSuccessfulAt: null,
      },
    });
    expect(result).toMatchObject({
      status: "degraded",
      code_loop_transport: { public: "unavailable", private: "unavailable" },
      inference: { public: "not_checked", private: "not_checked" },
      inference_observation: {
        public: { status: "observed", last_successful_at: "2026-10-08T12:34:56.000Z" },
        private: { status: "none", last_successful_at: null },
      },
    });
    expectNoTaintedContent(result);
  });

  it("reports a dead code-loop transport without claiming inference was checked", async () => {
    const result = await diagnose({ publicTransport: "unavailable", privateTransport: "unavailable" });
    expect(result).toMatchObject({
      status: "degraded",
      code_loop_transport: { public: "unavailable", private: "unavailable" },
      inference: { public: "not_checked", private: "not_checked" },
    });
    expectNoTaintedContent(result);
  });

  it("does not trust an unknown transport label from the gateway", async () => {
    const result = await diagnose({ publicTransport: `unavailable ${SECRET} ${LOCATOR}` });
    expect(result).toMatchObject({ code_loop_transport: { public: "unknown", private: "unknown" } });
    expectNoTaintedContent(result);
  });

  it("does not add discovery_failure before identity and tools succeed", async () => {
    const identityFailure = await diagnose({ rejectPublic: 503 });
    expect(identityFailure).toMatchObject({
      status: "busy",
      model_discovery: { public: "not_checked", private: "not_checked" },
    });
    expect(identityFailure).not.toHaveProperty("discovery_failure");

    const missingTools = await diagnose({ publicTools: ["list_models"] });
    expect(missingTools).toMatchObject({
      status: "missing_tools",
      model_discovery: { public: "available", private: "not_checked" },
    });
    expect(missingTools).not.toHaveProperty("discovery_failure");
    expectNoTaintedContent(identityFailure);
    expectNoTaintedContent(missingTools);
  });

  it.each([
    ["public", "public_rejected_discovery", { public: "not_checked", private: "not_checked" }, { public: "rejected_credential", private: "not_checked" }],
    ["private", "private_rejected_discovery", { public: "available", private: "not_checked" }, { public: "healthy", private: "rejected_credential" }],
  ] as const)(
    "preserves a %s list_models HTTP 401 as rejected credential without discovery detail",
    async (_endpoint, failure, modelDiscovery, endpoints) => {
      const result = await diagnose({ failure });

      expect(result).toMatchObject({
        status: "rejected_credential",
        auth_layer: "gateway_credential",
        model_discovery: modelDiscovery,
        endpoints,
        connector: { status: "unsupported" },
      });
      expect(result).not.toHaveProperty("discovery_failure");
      expectNoTaintedContent(result);
    },
  );

  it("preserves missing and rejected credential top-level flows without discovery detail", async () => {
    const missing = await diagnose({ credential: null });
    expect(missing).toMatchObject({
      status: "missing_credential",
      model_discovery: { public: "not_checked", private: "not_checked" },
      connector: { status: "unsupported" },
    });
    expect(missing).not.toHaveProperty("discovery_failure");

    const rejected = await diagnose({ rejectPublic: 401 });
    expect(rejected).toMatchObject({
      status: "rejected_credential",
      auth_layer: "gateway_credential",
      model_discovery: { public: "not_checked", private: "not_checked" },
    });
    expect(rejected).not.toHaveProperty("discovery_failure");
    expectNoTaintedContent(missing);
    expectNoTaintedContent(rejected);
  });
});
