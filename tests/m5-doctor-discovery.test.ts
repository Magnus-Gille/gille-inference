import { describe, expect, it } from "vitest";
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
}: DiagnoseOptions = {}) {
  let askCalls = 0;
  const result = await diagnoseProfile({
    profile: "codex",
    profileConfig: PROFILE,
    credentialStore: {
      resolve: async () => {
        if (credential === null) {
          throw new M5ClientError("missing_credential", `missing ${SECRET}`);
        }
        return credential;
      },
    },
    timeoutMs: failure === "public_timeout" ? 1_000 : 10_000,
    fetch: async (input, init) => {
      const url = String(input);
      const isPrivate = url.startsWith(PROFILE.privateGatewayUrl);
      const endpoint = isPrivate ? "private" : "public";
      if (url.endsWith("/portal/me")) {
        if (!isPrivate && rejectPublic !== undefined) {
          return new Response("", { status: rejectPublic });
        }
        return jsonResponse({ alias: "doctor-agent", tier: "owner", scope: "agent" });
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
        throw new Error(`ask must not be called: ${SECRET} ${LOCATOR}`);
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
  expect(askCalls).toBe(0);
  return result;
}

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
      status: "healthy",
      profile: "codex",
      credential: "present",
      model_discovery: { public: "available", private: "available" },
      inference: { public: "not_checked", private: "not_checked" },
      endpoints: { public: "healthy", private: "healthy" },
      connector: { status: "unsupported" },
    });
    expect(result).not.toHaveProperty("discovery_failure");
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
