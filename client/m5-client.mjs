import { execFile as nodeExecFile } from "node:child_process";

export const M5_CLIENT_VERSION = "1.1.0";
export const REQUIRED_AGENT_TOOLS = Object.freeze([
  "list_models",
  "ask",
  "code_loop_start",
  "code_loop_status",
  "code_loop_result",
]);

const TOKEN_PATTERNS = [
  /\bBearer\s+[^\s"',}]+/gi,
  /\bhs_[A-Za-z0-9._~-]+/g,
];

/**
 * Error safe to serialize or print. Details are deliberately content-free.
 */
export class M5ClientError extends Error {
  constructor(code, message, options = {}) {
    super(redactText(message));
    this.name = "M5ClientError";
    this.code = code;
    if (options.httpStatus !== undefined) this.httpStatus = options.httpStatus;
    if (options.workId !== undefined) this.workId = options.workId;
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.httpStatus === undefined ? {} : { http_status: this.httpStatus }),
        ...(this.workId === undefined ? {} : { work_id: this.workId }),
      },
    };
  }
}

export function redactText(value, secrets = []) {
  let text = typeof value === "string" ? value : String(value ?? "");
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length > 0) {
      text = text.split(secret).join("[REDACTED]");
    }
  }
  for (const pattern of TOKEN_PATTERNS) text = text.replace(pattern, "[REDACTED]");
  return text;
}

function redactValue(value, secrets) {
  if (typeof value === "string") return redactText(value, secrets);
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, secrets));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, redactValue(entry, secrets)]),
    );
  }
  return value;
}

function safeError(error, secrets) {
  if (error instanceof M5ClientError) {
    return new M5ClientError(error.code, redactText(error.message, secrets), {
      httpStatus: error.httpStatus,
      workId: error.workId,
    });
  }
  return new M5ClientError(
    "client_error",
    redactText(error instanceof Error ? error.message : "M5 client request failed.", secrets),
  );
}

function profileAccount(profile) {
  if (!/^[a-z][a-z0-9_-]{0,31}$/i.test(profile)) {
    throw new M5ClientError(
      "invalid_profile",
      "Profile names must contain only letters, digits, underscores, and hyphens.",
    );
  }
  return `gateway-agent-${profile.toLowerCase()}`;
}

/**
 * The token is captured from Keychain stdout inside this adapter. It is never placed in
 * environment variables, argv, config, logs, or a child process after resolution.
 */
export function createKeychainCredentialStore({
  execFile = nodeExecFile,
  service = "gille-inference",
  timeoutMs = 5_000,
} = {}) {
  const boundedTimeoutMs =
    Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : 5_000;
  return {
    async resolve(profile) {
      const account = profileAccount(profile);
      return new Promise((resolve, reject) => {
        execFile(
          "security",
          ["find-generic-password", "-s", service, "-a", account, "-w"],
          {
            encoding: "utf8",
            maxBuffer: 4096,
            timeout: boundedTimeoutMs,
            killSignal: "SIGTERM",
          },
          (error, stdout) => {
            if (error) {
              const timedOut =
                error.killed === true || error.code === "ETIMEDOUT";
              if (timedOut) {
                reject(
                  new M5ClientError(
                    "credential_timeout",
                    "The selected Keychain credential lookup timed out.",
                  ),
                );
                return;
              }
              if (error.code !== 44 && error.code !== "44") {
                reject(
                  new M5ClientError(
                    "credential_unavailable",
                    "The macOS Keychain credential service is unavailable.",
                  ),
                );
                return;
              }
              reject(
                new M5ClientError(
                  "missing_credential",
                  "No credential is present for the selected Keychain profile.",
                ),
              );
              return;
            }
            const token = String(stdout).trim();
            if (token.length === 0) {
              reject(
                new M5ClientError(
                  "missing_credential",
                  "The selected Keychain profile contains an empty credential.",
                ),
              );
              return;
            }
            resolve(token);
          },
        );
      });
    },
  };
}

function containsCredentialField(value) {
  if (!value || typeof value !== "object") return false;
  for (const [key, entry] of Object.entries(value)) {
    if (/^(key|token|authorization|bearer|credential|secret)$/i.test(key)) return true;
    if (containsCredentialField(entry)) return true;
  }
  return false;
}

function normalizeGatewayUrl(raw, field, { allowHttp = false } = {}) {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new M5ClientError("invalid_config", `${field} must be an absolute HTTP(S) URL.`);
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new M5ClientError("invalid_config", `${field} must be an absolute HTTP(S) URL.`);
  }
  const protocolAllowed =
    parsed.protocol === "https:" || (allowHttp && parsed.protocol === "http:");
  if (!protocolAllowed || parsed.username || parsed.password) {
    throw new M5ClientError(
      "invalid_config",
      allowHttp
        ? `${field} must be an HTTP(S) URL without embedded credentials.`
        : `${field} must use HTTPS without embedded credentials.`,
    );
  }
  if (parsed.search || parsed.hash) {
    throw new M5ClientError(
      "invalid_config",
      `${field} must not contain query parameters or a fragment.`,
    );
  }
  return parsed.origin;
}

export function validateProfileConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new M5ClientError("invalid_config", "The selected profile configuration is invalid.");
  }
  const allowedFields = new Set(["publicGatewayUrl", "privateGatewayUrl"]);
  const unexpectedFields = Object.keys(config).filter(
    (field) => !allowedFields.has(field),
  );
  if (unexpectedFields.length > 0 || containsCredentialField(config)) {
    throw new M5ClientError(
      "invalid_config",
      "Only publicGatewayUrl and privateGatewayUrl are allowed; credential material and extra fields are forbidden.",
    );
  }
  const publicGatewayUrl = normalizeGatewayUrl(
    config.publicGatewayUrl,
    "publicGatewayUrl",
  );
  const privateGatewayUrl =
    config.privateGatewayUrl === undefined
      ? undefined
      : normalizeGatewayUrl(config.privateGatewayUrl, "privateGatewayUrl", {
          allowHttp: true,
        });
  return { publicGatewayUrl, ...(privateGatewayUrl ? { privateGatewayUrl } : {}) };
}

function rpcErrorMessage(response) {
  const message =
    response &&
    typeof response === "object" &&
    response.error &&
    typeof response.error === "object" &&
    typeof response.error.message === "string"
      ? response.error.message
      : "The MCP gateway returned an error.";
  return message;
}

function toolPayload(result) {
  if (!result || typeof result !== "object") {
    throw new M5ClientError("malformed_mcp", "The MCP tool result is malformed.");
  }
  if (result.isError === true) {
    const text = Array.isArray(result.content)
      ? result.content.find((entry) => entry?.type === "text")?.text
      : undefined;
    throw new M5ClientError(
      "tool_error",
      typeof text === "string" ? text : "The MCP tool reported an error.",
    );
  }
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = Array.isArray(result.content)
    ? result.content.find((entry) => entry?.type === "text")?.text
    : undefined;
  if (typeof text !== "string") {
    throw new M5ClientError("malformed_mcp", "The MCP tool returned no text content.");
  }
  return text;
}

function parseModels(text) {
  if (typeof text !== "string") {
    throw new M5ClientError("malformed_mcp", "The model catalogue response is malformed.");
  }
  if (/^No models are available/i.test(text)) return [];
  return text
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .map((line) => {
      const [id, ...description] = line.slice(2).split(/\s+—\s+/);
      return { id: id.trim(), description: description.join(" — ").trim() };
    })
    .filter((model) => model.id.length > 0);
}

function validateWorkId(workId) {
  if (typeof workId !== "string" || !/^cl-[A-Za-z0-9._-]+$/.test(workId)) {
    throw new M5ClientError("invalid_work_id", "A valid code-loop work_id is required.");
  }
}

function validateCodeResult(result) {
  if (!result || typeof result !== "object") {
    throw new M5ClientError("invalid_code_result", "The code-loop result is malformed.");
  }
  if (result.status === "running") return result;
  if (
    typeof result.status !== "string" ||
    typeof result.diff !== "string" ||
    !result.check ||
    typeof result.check !== "object" ||
    typeof result.check.ran !== "boolean"
  ) {
    throw new M5ClientError(
      "invalid_code_result",
      "A terminal code-loop result must include a diff and verification evidence.",
    );
  }
  return result;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolve the selected credential once, then retain it only in closure scope.
 */
export async function createM5Client({
  gatewayUrl,
  profile,
  endpoint = "public",
  credentialStore = createKeychainCredentialStore(),
  fetch: fetchImpl = globalThis.fetch,
  timeoutMs = 30_000,
  sleep = delay,
}) {
  if (endpoint !== "public" && endpoint !== "private") {
    throw new M5ClientError(
      "invalid_config",
      "The gateway endpoint kind must be public or private.",
    );
  }
  const origin = normalizeGatewayUrl(gatewayUrl, "gatewayUrl", {
    allowHttp: endpoint === "private",
  });
  let token;
  try {
    token = await credentialStore.resolve(profile);
  } catch (error) {
    if (error instanceof M5ClientError) throw error;
    throw new M5ClientError(
      "credential_unavailable",
      "The selected Keychain credential could not be resolved.",
    );
  }
  if (typeof token !== "string" || token.length === 0) {
    throw new M5ClientError("missing_credential", "The selected credential is empty.");
  }

  let nextId = 1;
  let sessionId = null;
  const secrets = [token];

  async function request(message, retrySession = true) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${origin}/mcp`, {
        method: "POST",
        redirect: "error",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          authorization: `Bearer ${token}`,
          "user-agent": `m5-cli/${M5_CLIENT_VERSION}`,
          ...(sessionId === null ? {} : { "mcp-session-id": sessionId }),
        },
        body: JSON.stringify(message),
        signal: controller.signal,
      });

      if ((response.status === 404 || response.status === 410) && sessionId !== null && retrySession) {
        sessionId = null;
        return request(message, false);
      }
      if (response.status === 401 || response.status === 403) {
        throw new M5ClientError(
          "rejected_credential",
          "The gateway rejected the selected credential.",
          { httpStatus: response.status },
        );
      }
      if (response.status >= 400) {
        throw new M5ClientError(
          "upstream_http_error",
          `The MCP gateway returned HTTP ${response.status}.`,
          { httpStatus: response.status },
        );
      }

      const returnedSession = response.headers.get("mcp-session-id");
      if (returnedSession) sessionId = returnedSession;
      // Keep the same abort deadline active through body consumption. Fetch resolving headers
      // is not completion: a peer can otherwise hold this sequential stdio bridge forever.
      const text = await response.text();
      if (text.trim() === "") {
        if (message.id === undefined || message.id === null) return null;
        throw new M5ClientError(
          "empty_response",
          "The MCP gateway returned an empty response for a request.",
        );
      }

      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new M5ClientError(
          "malformed_mcp",
          "The MCP gateway returned malformed JSON.",
        );
      }
      if (
        !parsed ||
        typeof parsed !== "object" ||
        Array.isArray(parsed) ||
        parsed.jsonrpc !== "2.0"
      ) {
        throw new M5ClientError(
          "malformed_mcp",
          "The MCP gateway returned a malformed JSON-RPC envelope.",
        );
      }
      const hasResult = Object.prototype.hasOwnProperty.call(parsed, "result");
      const hasError = Object.prototype.hasOwnProperty.call(parsed, "error");
      const validError =
        !hasError ||
        (parsed.error &&
          typeof parsed.error === "object" &&
          typeof parsed.error.code === "number" &&
          typeof parsed.error.message === "string");
      if (
        hasResult === hasError ||
        !validError ||
        (message.id !== undefined &&
          message.id !== null &&
          parsed.id !== message.id)
      ) {
        throw new M5ClientError(
          "malformed_mcp",
          "The MCP gateway returned a malformed JSON-RPC envelope.",
        );
      }
      return redactValue(parsed, secrets);
    } catch (error) {
      if (controller.signal.aborted) {
        throw new M5ClientError("timeout", "The M5 gateway request timed out.");
      }
      if (error instanceof M5ClientError) throw error;
      throw new M5ClientError(
        "network_failure",
        redactText(
          error instanceof Error ? error.message : "The M5 gateway is unreachable.",
          secrets,
        ),
      );
    } finally {
      clearTimeout(timer);
    }
  }

  const client = {
    async rpc(message) {
      try {
        return await request(message);
      } catch (error) {
        throw safeError(error, secrets);
      }
    },

    async tool(name, args) {
      const id = nextId++;
      const response = await client.rpc({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: args },
      });
      if (response?.error) {
        throw new M5ClientError(
          "mcp_error",
          redactText(rpcErrorMessage(response), secrets),
        );
      }
      try {
        return redactValue(toolPayload(response?.result), secrets);
      } catch (error) {
        throw safeError(error, secrets);
      }
    },

    async models() {
      const payload = await client.tool("list_models", {});
      const models = parseModels(payload);
      if (
        models.length === 0 &&
        !(typeof payload === "string" && /^No models are available/i.test(payload))
      ) {
        throw new M5ClientError(
          "malformed_mcp",
          "The model catalogue response is malformed.",
        );
      }
      return { models };
    },

    async ask(input) {
      if (
        !input ||
        typeof input !== "object" ||
        typeof input.model !== "string" ||
        typeof input.prompt !== "string"
      ) {
        throw new M5ClientError(
          "invalid_input",
          "ask requires JSON with non-empty model and prompt strings.",
        );
      }
      const text = await client.tool("ask", input);
      if (typeof text !== "string") {
        throw new M5ClientError("malformed_mcp", "The ask tool returned malformed content.");
      }
      return { model: input.model, text };
    },

    async codeStatus(workId) {
      validateWorkId(workId);
      const result = await client.tool("code_loop_status", { work_id: workId });
      if (!result || typeof result !== "object" || typeof result.status !== "string") {
        throw new M5ClientError(
          "invalid_code_status",
          "The code-loop status response is malformed.",
        );
      }
      return { work_id: workId, ...result };
    },

    async codeResult(workId) {
      validateWorkId(workId);
      const result = await client.tool("code_loop_result", { work_id: workId });
      return { work_id: workId, ...validateCodeResult(result) };
    },

    async codeRun(input) {
      if (
        !input ||
        typeof input !== "object" ||
        typeof input.instruction !== "string" ||
        !Array.isArray(input.files) ||
        input.files.length === 0
      ) {
        throw new M5ClientError(
          "invalid_input",
          "code run requires JSON with instruction and non-empty inline seed files.",
        );
      }
      const { wait, ...requestInput } = input;
      const started = await client.tool("code_loop_start", requestInput);
      if (!started || typeof started !== "object") {
        throw new M5ClientError(
          "invalid_code_start",
          "The code-loop start response is malformed.",
        );
      }
      if (started.ok === false || started.refusal) return started;
      const workId = started.work_id;
      validateWorkId(workId);
      if (started.result !== undefined) return validateCodeResult(started.result);
      if (wait === false) return started;

      const waitConfig = wait && typeof wait === "object" ? wait : {};
      const waitTimeoutMs =
        Number.isFinite(waitConfig.timeout_ms) && waitConfig.timeout_ms > 0
          ? waitConfig.timeout_ms
          : 15 * 60_000;
      const pollMs =
        Number.isFinite(waitConfig.poll_ms) && waitConfig.poll_ms > 0
          ? waitConfig.poll_ms
          : 1_000;
      const deadline = Date.now() + waitTimeoutMs;
      while (Date.now() <= deadline) {
        const status = await client.codeStatus(workId);
        if (status.status !== "running") return client.codeResult(workId);
        await sleep(pollMs);
      }
      throw new M5ClientError(
        "code_wait_timeout",
        "The code-loop is still running after the local wait timeout.",
        { workId },
      );
    },
  };

  return Object.freeze(client);
}

function safeDoctorResult(result) {
  return redactValue(result, []);
}

async function identityRequest(baseUrl, token, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${baseUrl}/portal/me`, {
      redirect: "error",
      headers: {
        authorization: `Bearer ${token}`,
        "user-agent": `m5-cli/${M5_CLIENT_VERSION}`,
      },
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) {
      throw new M5ClientError(
        "rejected_credential",
        "The gateway rejected the selected credential.",
      );
    }
    if (!response.ok) {
      throw new M5ClientError(
        "network_failure",
        `The gateway identity check returned HTTP ${response.status}.`,
      );
    }
    try {
      return await response.json();
    } catch {
      throw new M5ClientError(
        "malformed_identity",
        "The gateway identity response is malformed.",
      );
    }
  } catch (error) {
    if (controller.signal.aborted) {
      throw new M5ClientError("network_failure", "The gateway identity check timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function endpointDoctor({
  baseUrl,
  endpoint,
  profile,
  token,
  credentialStore,
  fetchImpl,
  timeoutMs,
}) {
  const identity = await identityRequest(baseUrl, token, fetchImpl, timeoutMs);
  const client = await createM5Client({
    gatewayUrl: baseUrl,
    endpoint,
    profile,
    credentialStore,
    fetch: fetchImpl,
    timeoutMs,
  });
  const response = await client.rpc({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {},
  });
  if (response?.error || !Array.isArray(response?.result?.tools)) {
    throw new M5ClientError(
      "malformed_mcp",
      "The MCP tools catalogue response is malformed.",
    );
  }
  return {
    identity: {
      alias: identity?.alias,
      tier: identity?.tier,
      scope: identity?.scope,
    },
    tools: response.result.tools
      .map((tool) => tool?.name)
      .filter((name) => typeof name === "string")
      .sort(),
  };
}

export async function diagnoseProfile({
  profile,
  profileConfig,
  credentialStore = createKeychainCredentialStore(),
  fetch: fetchImpl = globalThis.fetch,
  timeoutMs = 10_000,
}) {
  const config = validateProfileConfig(profileConfig);
  let token;
  try {
    token = await credentialStore.resolve(profile);
  } catch (error) {
    if (error instanceof M5ClientError && error.code === "missing_credential") {
      return safeDoctorResult({
        status: "missing_credential",
        profile,
        credential: "missing",
        endpoints: { public: "not_checked", private: "not_checked" },
      });
    }
    const status =
      error instanceof M5ClientError &&
      ["credential_timeout", "credential_unavailable"].includes(error.code)
        ? error.code
        : "credential_unavailable";
    return safeDoctorResult({
      status,
      profile,
      credential: "unavailable",
      endpoints: { public: "not_checked", private: "not_checked" },
    });
  }

  const internalStore = { resolve: async () => token };
  let publicProbe;
  try {
    publicProbe = await endpointDoctor({
      baseUrl: config.publicGatewayUrl,
      endpoint: "public",
      profile,
      token,
      credentialStore: internalStore,
      fetchImpl,
      timeoutMs,
    });
  } catch (error) {
    const safe = safeError(error, [token]);
    const status =
      safe.code === "rejected_credential" ? "rejected_credential" : "network_failure";
    return safeDoctorResult({
      status,
      profile,
      credential: "present",
      endpoints: { public: status, private: "not_checked" },
    });
  }

  if (publicProbe.identity.tier !== "owner" || !["agent", "admin"].includes(publicProbe.identity.scope)) {
    return safeDoctorResult({
      status: "wrong_scope",
      profile,
      credential: "present",
      identity: {
        tier: publicProbe.identity.tier ?? "unknown",
        scope: publicProbe.identity.scope ?? "unknown",
      },
      endpoints: { public: "healthy", private: "not_checked" },
    });
  }

  const publicMissing = REQUIRED_AGENT_TOOLS.filter(
    (tool) => !publicProbe.tools.includes(tool),
  );
  if (publicMissing.length > 0) {
    return safeDoctorResult({
      status: "missing_tools",
      profile,
      credential: "present",
      missing_tools: publicMissing,
      endpoints: { public: "missing_tools", private: "not_checked" },
    });
  }

  if (!config.privateGatewayUrl) {
    return safeDoctorResult({
      status: "healthy",
      profile,
      credential: "present",
      endpoints: { public: "healthy", private: "not_configured" },
    });
  }

  let privateProbe;
  try {
    privateProbe = await endpointDoctor({
      baseUrl: config.privateGatewayUrl,
      endpoint: "private",
      profile,
      token,
      credentialStore: internalStore,
      fetchImpl,
      timeoutMs,
    });
  } catch (error) {
    const safe = safeError(error, [token]);
    const status =
      safe.code === "rejected_credential" ? "rejected_credential" : "network_failure";
    return safeDoctorResult({
      status,
      profile,
      credential: "present",
      endpoints: { public: "healthy", private: status },
    });
  }

  const privateMissing = REQUIRED_AGENT_TOOLS.filter(
    (tool) => !privateProbe.tools.includes(tool),
  );
  if (privateMissing.length > 0) {
    return safeDoctorResult({
      status: "missing_tools",
      profile,
      credential: "present",
      missing_tools: privateMissing,
      endpoints: { public: "healthy", private: "missing_tools" },
    });
  }

  if (
    JSON.stringify(publicProbe.identity) !== JSON.stringify(privateProbe.identity) ||
    JSON.stringify(publicProbe.tools) !== JSON.stringify(privateProbe.tools)
  ) {
    return safeDoctorResult({
      status: "path_parity_failed",
      profile,
      credential: "present",
      endpoints: { public: "healthy", private: "drift" },
    });
  }

  return safeDoctorResult({
    status: "healthy",
    profile,
    credential: "present",
    identity: {
      tier: publicProbe.identity.tier,
      scope: publicProbe.identity.scope,
    },
    tools: REQUIRED_AGENT_TOOLS,
    endpoints: { public: "healthy", private: "healthy" },
  });
}
