import { execFile as nodeExecFile } from "node:child_process";
import { createHash } from "node:crypto";

export const M5_CLIENT_VERSION = "1.3.2";
export const REQUIRED_AGENT_TOOLS = Object.freeze([
  "list_models",
  "ask",
  "code_loop_start",
  "code_loop_status",
  "code_loop_result",
  "record_adoption_evidence",
]);

const CREDENTIAL_FAILURE_CODES = new Set(["missing_credential", "rejected_credential"]);
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

/** The standalone client cannot inspect an interactive host connector session. */
const UNSUPPORTED_CONNECTOR_DIAGNOSTIC = Object.freeze({
  status: "unsupported",
  reason: "Host connector session state is not inspectable by the standalone m5 client.",
});

const ADOPTION_REPORT_FIELDS = Object.freeze([
  "harness",
  "execution_mode",
  "traffic_purpose",
  "result",
  "deterministic_check",
  "reviewer_usefulness",
  "fallback_reason",
  "eligible_opportunities",
]);
const ADOPTION_HARNESSES = new Set(["claude", "codex_cli", "codex_app", "pi", "direct_cli", "evaluation_runner"]);
const ADOPTION_EXECUTION_MODES = new Set(["ask", "code_loop", "delegate"]);
const ADOPTION_TRAFFIC_PURPOSES = new Set(["organic", "evaluation", "synthetic"]);
const ADOPTION_RESULTS = new Set(["completed", "refused", "failed", "not_attempted"]);
const ADOPTION_CHECKS = new Set(["pass", "fail", "not_run"]);
const ADOPTION_USEFULNESS = new Set(["pass", "partial", "redo", "wrong", "not_reported"]);
const ADOPTION_FALLBACKS = new Set([
  "none", "m5_tool_missing", "m5_auth_unavailable", "m5_unreachable", "m5_busy", "m5_refused", "local_result_unusable", "other_known",
]);
const ADOPTION_ACK_FIELDS = Object.freeze([
  "accepted",
  "telemetry_recorded",
  "retention",
  "inference_availability",
  "reason",
  "retry_telemetry",
  "diagnostic",
]);
const ADOPTION_RETENTIONS = new Set(["retained", "aggregated", "dropped"]);
const ADOPTION_REASONS = new Set([
  "invalid_report",
  "telemetry_daily_cap",
  "telemetry_rate_limited",
  "storage_unavailable",
]);
const ADOPTION_DIAGNOSTIC_CODES = new Set([
  "invalid_shape",
  "unknown_field",
  "invalid_field",
  "invalid_invariant",
]);
const ADOPTION_DIAGNOSTIC_FIELDS = new Set(ADOPTION_REPORT_FIELDS);
const ADOPTION_DIAGNOSTIC_INVARIANTS = new Set([
  "completed_requires_no_fallback",
  "noncompleted_requires_fallback",
  "unobserved_result_requires_unobserved_assessment",
]);
const MAX_BLIND_CONTEXT_ROOTS = 128;

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
    // JSON.stringify invokes toJSON with the containing property key, not the profile that
    // created this error. Keep the profile out of enumerable error data while retaining it for
    // the canonical credential remediation used by library consumers.
    Object.defineProperty(this, "_profile", {
      value: typeof options.profile === "string" ? options.profile : undefined,
      enumerable: false,
      writable: false,
      configurable: false,
    });
    if (options.httpStatus !== undefined) this.httpStatus = options.httpStatus;
    if (options.workId !== undefined) this.workId = options.workId;
    if (NETWORK_DIAGNOSTIC_CODES.has(options.diagnosticCode)) {
      this.diagnosticCode = options.diagnosticCode;
    }
    if (FAILURE_LAYERS.has(options.failureLayer)) this.failureLayer = options.failureLayer;
    if (typeof options.retryable === "boolean") this.retryable = options.retryable;
    if (CREDENTIAL_FAILURE_CODES.has(code)) {
      // Credential failures have one owner-attended recovery action. Do not retain a
      // gateway- or caller-supplied remediation: it may contain a locator, credential, or
      // an unsafe command, and both the CLI and bridge serialize this object directly.
      this.remediation = credentialRemediation(options.profile);
    } else if (options.remediation !== undefined) {
      this.remediation = redactText(options.remediation);
    }
  }

  toJSON(profileOrPropertyKey) {
    const profile = this._profile ?? (
      typeof profileOrPropertyKey === "string" && profileOrPropertyKey.length > 0
        ? profileOrPropertyKey
        : undefined
    );
    const remediation = CREDENTIAL_FAILURE_CODES.has(this.code)
      ? credentialRemediation(profile)
      : this.remediation;
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.httpStatus === undefined ? {} : { http_status: this.httpStatus }),
        ...(this.workId === undefined ? {} : { work_id: this.workId }),
        ...(this.diagnosticCode === undefined ? {} : { diagnostic_code: this.diagnosticCode }),
        ...(this.failureLayer === undefined ? {} : { failure_layer: this.failureLayer }),
        ...(this.retryable === undefined ? {} : { retryable: this.retryable }),
        ...(remediation === undefined ? {} : { remediation }),
      },
    };
  }
}

function safeProfileForDiagnostic(profile) {
  return typeof profile === "string" && /^[a-z][a-z0-9_-]{0,31}$/i.test(profile)
    ? profile
    : "selected";
}

/** One redacted recovery action shared by doctor, direct CLI errors, and the stdio bridge. */
export function credentialRemediation(profile) {
  const selected = safeProfileForDiagnostic(profile);
  const command = selected === "selected" ? "m5 doctor" : `m5 --profile ${selected} doctor`;
  return `Restore the selected profile credential through the owner-attended Keychain recovery/rotation procedure, then rerun: ${command}.`;
}

/** Fixed, locator-free recovery text shared by direct and connector transport failures. */
export function transportRemediation(profile) {
  const selected = safeProfileForDiagnostic(profile);
  const command = selected === "selected" ? "m5 doctor" : `m5 --profile ${selected} doctor`;
  return `Retry the same operation once. If it still fails, run ${command}; the standalone doctor tests the configured profile path and explicitly reports that it cannot inspect the host connector session itself.`;
}

function networkDiagnosticCode(error) {
  const codes = [];
  let current = error;
  // Fetch/undici normally use one or two cause links. Keep traversal bounded so a hostile or
  // malformed Error with a self-referential cause cannot hang the long-lived stdio bridge.
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    if (typeof current.code === "string") codes.push(current.code.toUpperCase());
    current = current.cause;
  }
  if (codes.some((code) => code === "ENOTFOUND" || code === "EAI_AGAIN")) return "dns_failure";
  if (codes.includes("ECONNREFUSED")) return "connection_refused";
  if (codes.some((code) => code === "ENETUNREACH" || code === "EHOSTUNREACH")) return "route_unreachable";
  if (codes.some((code) => code === "ECONNRESET" || code === "EPIPE" || code === "UND_ERR_SOCKET")) {
    return "connection_reset";
  }
  if (codes.some((code) => code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT")) {
    return "connect_timeout";
  }
  if (codes.some((code) =>
    code.startsWith("ERR_TLS_") ||
    code.startsWith("CERT_") ||
    code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
    code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE"
  )) {
    return "tls_failure";
  }
  return "network_failure";
}

function credentialFailureMessage(code, profile) {
  const reason = code === "missing_credential"
    ? "The selected profile has no usable Keychain credential."
    : "The gateway rejected the selected profile credential.";
  return `${reason} ${credentialRemediation(profile)}`;
}

function credentialErrorOptions(code, profile, options = {}) {
  return CREDENTIAL_FAILURE_CODES.has(code)
    ? { ...options, remediation: credentialRemediation(profile), profile }
    : options;
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

function safeError(error, secrets, profile) {
  if (error instanceof M5ClientError) {
    const message = CREDENTIAL_FAILURE_CODES.has(error.code)
      ? credentialFailureMessage(error.code, profile)
      : redactText(error.message, secrets);
    return new M5ClientError(error.code, message, credentialErrorOptions(error.code, profile, {
      httpStatus: error.httpStatus,
      workId: error.workId,
      diagnosticCode: error.diagnosticCode,
      failureLayer: error.failureLayer,
      retryable: error.retryable,
      remediation: error.remediation,
    }));
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

function hasOnlyKeys(value, expectedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === expectedKeys.length && expectedKeys.every((key) => keys.includes(key));
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

function toolText(result) {
  return Array.isArray(result?.content)
    ? result.content.find((entry) => entry?.type === "text")?.text
    : undefined;
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

function parseAskCapabilities(value) {
  if (!hasOnlyKeys(value, ["files_enabled", "files_reason", "resolved_root_count"])) {
    return null;
  }
  const { files_enabled, files_reason, resolved_root_count } = value;
  const validReason =
    files_reason === "enabled" ||
    files_reason === "owner_tier_required" ||
    files_reason === "unconfigured" ||
    files_reason === "no_resolved_roots";
  if (
    typeof files_enabled !== "boolean" ||
    !validReason ||
    !(
      resolved_root_count === null ||
      (Number.isSafeInteger(resolved_root_count) && resolved_root_count >= 0 && resolved_root_count <= MAX_BLIND_CONTEXT_ROOTS)
    )
  ) {
    return null;
  }
  if (files_enabled) {
    if (files_reason !== "enabled" || resolved_root_count === null || resolved_root_count < 1) {
      return null;
    }
  } else if (files_reason === "owner_tier_required") {
    if (resolved_root_count !== null) {
      return null;
    }
  } else if (
    (files_reason !== "unconfigured" && files_reason !== "no_resolved_roots")
    || resolved_root_count !== 0
  ) {
    return null;
  }
  return { files_enabled, files_reason, resolved_root_count };
}

function parseStructuredModelsPayload(payload) {
  if (!hasOnlyKeys(payload, ["models", "ask_capabilities"])) {
    throw new M5ClientError(
      "malformed_mcp",
      "The model catalogue response is malformed.",
    );
  }
  if (!Array.isArray(payload.models)) {
    throw new M5ClientError(
      "malformed_mcp",
      "The model catalogue response is malformed.",
    );
  }
  const models = payload.models.map((entry) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      !hasOnlyKeys(entry, ["id", "description"]) ||
      typeof entry.id !== "string" ||
      typeof entry.description !== "string"
    ) {
      throw new M5ClientError(
        "malformed_mcp",
        "The model catalogue response is malformed.",
      );
    }
    return { id: entry.id, description: entry.description };
  });
  const askCapabilities = parseAskCapabilities(payload.ask_capabilities);
  if (askCapabilities === null) {
    throw new M5ClientError(
      "malformed_mcp",
      "The model catalogue response is malformed.",
    );
  }
  return { models, ask_capabilities: askCapabilities };
}

function emptyAskUsage() {
  return {
    prompt_tokens: null,
    completion_tokens: null,
    total_tokens: null,
    reasoning_tokens: null,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
  };
}

const ASK_TRUNCATION_FINISH_REASON = "length";

function nonNegativeIntegerOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function normalizeAskUsage(usage) {
  if (usage === undefined || usage === null) return emptyAskUsage();
  if (typeof usage !== "object" || Array.isArray(usage)) {
    throw new M5ClientError("malformed_mcp", "The ask tool returned malformed usage metadata.");
  }
  const promptTokens = nonNegativeIntegerOrNull(usage.prompt_tokens);
  const completionTokens = nonNegativeIntegerOrNull(usage.completion_tokens);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens:
      nonNegativeIntegerOrNull(usage.total_tokens) ??
      (promptTokens !== null && completionTokens !== null ? promptTokens + completionTokens : null),
    reasoning_tokens: nonNegativeIntegerOrNull(usage.reasoning_tokens),
    cache_creation_input_tokens: nonNegativeIntegerOrNull(usage.cache_creation_input_tokens),
    cache_read_input_tokens: nonNegativeIntegerOrNull(usage.cache_read_input_tokens),
  };
}

function normalizeAskPayload(payload, fallbackModel) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new M5ClientError("malformed_mcp", "The ask tool returned malformed content.");
  }
  const model =
    typeof payload.model === "string" && payload.model.length > 0
      ? payload.model
      : fallbackModel;
  if (typeof model !== "string" || model.length === 0) {
    throw new M5ClientError("malformed_mcp", "The ask tool omitted the model id.");
  }
  if (typeof payload.text !== "string") {
    throw new M5ClientError("malformed_mcp", "The ask tool returned malformed content.");
  }
  const finishReason =
    payload.finish_reason === undefined || payload.finish_reason === null
      ? null
      : typeof payload.finish_reason === "string"
        ? payload.finish_reason
        : (() => {
            throw new M5ClientError("malformed_mcp", "The ask tool returned malformed finish-reason metadata.");
          })();
  let truncated =
    payload.truncated === undefined || payload.truncated === null
      ? null
      : typeof payload.truncated === "boolean"
        ? payload.truncated
        : (() => {
            throw new M5ClientError("malformed_mcp", "The ask tool returned malformed truncation metadata.");
          })();
  if (truncated === null) truncated = finishReason === null ? null : finishReason === ASK_TRUNCATION_FINISH_REASON;
  if (truncated === true && finishReason !== ASK_TRUNCATION_FINISH_REASON) {
    throw new M5ClientError(
      "malformed_mcp",
      "The ask tool returned unsupported truncation metadata.",
    );
  }
  if (truncated === false && finishReason === ASK_TRUNCATION_FINISH_REASON) {
    throw new M5ClientError(
      "malformed_mcp",
      "The ask tool returned conflicting truncation metadata.",
    );
  }
  const metered =
    payload.metered === undefined || payload.metered === null
      ? true
      : typeof payload.metered === "boolean"
        ? payload.metered
        : (() => {
            throw new M5ClientError("malformed_mcp", "The ask tool returned malformed metering metadata.");
          })();
  return {
    model,
    text: payload.text,
    finish_reason: finishReason,
    truncated,
    metered,
    usage: normalizeAskUsage(payload.usage),
  };
}

function toolResultText(result) {
  const text = Array.isArray(result?.content)
    ? result.content.find((entry) => entry?.type === "text")?.text
    : undefined;
  return typeof text === "string" ? text : "The MCP tool reported an error.";
}

function isSupportedAskTruncation(payload) {
  return payload.truncated === true && payload.finish_reason === ASK_TRUNCATION_FINISH_REASON;
}

function validateWorkId(workId) {
  if (typeof workId !== "string" || !/^cl-[A-Za-z0-9._-]+$/.test(workId)) {
    throw new M5ClientError("invalid_work_id", "A valid code-loop work_id is required.");
  }
}

/**
 * The standalone distributed client must reject content-bearing or malformed adoption reports
 * before it resolves a Keychain credential or serializes any request. The gateway repeats this
 * same closed contract authoritatively; it cannot share the TypeScript source without breaking the
 * npm client's standalone installation boundary.
 */
function isValidAdoptionReport(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const keys = Object.keys(input);
  if (keys.length !== ADOPTION_REPORT_FIELDS.length || keys.some((key) => !ADOPTION_REPORT_FIELDS.includes(key))) return false;
  if (
    !ADOPTION_HARNESSES.has(input.harness) ||
    !ADOPTION_EXECUTION_MODES.has(input.execution_mode) ||
    !ADOPTION_TRAFFIC_PURPOSES.has(input.traffic_purpose) ||
    !ADOPTION_RESULTS.has(input.result) ||
    !ADOPTION_CHECKS.has(input.deterministic_check) ||
    !ADOPTION_USEFULNESS.has(input.reviewer_usefulness) ||
    !ADOPTION_FALLBACKS.has(input.fallback_reason) ||
    !Number.isInteger(input.eligible_opportunities) ||
    input.eligible_opportunities < 0 ||
    input.eligible_opportunities > 10_000
  ) {
    return false;
  }
  if (input.result === "completed") return input.fallback_reason === "none";
  if (input.fallback_reason === "none") return false;
  return (
    (input.result !== "refused" && input.result !== "not_attempted") ||
    (input.deterministic_check === "not_run" && input.reviewer_usefulness === "not_reported")
  );
}

function isValidAdoptionDiagnostic(diagnostic) {
  if (!diagnostic || typeof diagnostic !== "object" || Array.isArray(diagnostic)) return false;
  if (!ADOPTION_DIAGNOSTIC_CODES.has(diagnostic.code)) return false;
  if (diagnostic.code === "invalid_shape" || diagnostic.code === "unknown_field") {
    return hasOnlyKeys(diagnostic, ["code"]);
  }
  if (diagnostic.code === "invalid_field") {
    return hasOnlyKeys(diagnostic, ["code", "field"]) && ADOPTION_DIAGNOSTIC_FIELDS.has(diagnostic.field);
  }
  if (diagnostic.code === "invalid_invariant") {
    return hasOnlyKeys(diagnostic, ["code", "invariant"]) && ADOPTION_DIAGNOSTIC_INVARIANTS.has(diagnostic.invariant);
  }
  return false;
}

function normalizeAdoptionAcknowledgement(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new M5ClientError(
      "invalid_adoption_report",
      "The gateway returned a malformed adoption-report acknowledgement.",
    );
  }

  const keys = Object.keys(result);
  if (
    keys.some((key) => !ADOPTION_ACK_FIELDS.includes(key)) ||
    typeof result.accepted !== "boolean"
  ) {
    throw new M5ClientError(
      "invalid_adoption_report",
      "The gateway returned a malformed adoption-report acknowledgement.",
    );
  }

  const hasDiagnostic = Object.prototype.hasOwnProperty.call(result, "diagnostic");
  if (
    (hasDiagnostic && result.reason !== "invalid_report") ||
    (hasDiagnostic && !isValidAdoptionDiagnostic(result.diagnostic))
  ) {
    throw new M5ClientError(
      "invalid_adoption_report",
      "The gateway returned an unsupported adoption-report diagnostic.",
    );
  }

  // During the rolling upgrade, old gateways report unscoped refusal reasons. Treat them as
  // dropped telemetry acknowledgements at the client boundary so callers cannot mistake a
  // telemetry write limit or storage failure for ask/code_loop/model or owner inference
  // capacity exhaustion. Keep this mapping inside the closed acknowledgement-field contract.
  if (result.accepted === false && result.reason === "daily_capacity_reached") {
    return {
      accepted: false,
      telemetry_recorded: false,
      retention: "dropped",
      inference_availability: "unaffected",
      reason: "telemetry_daily_cap",
      retry_telemetry: "next_utc_day",
    };
  }
  if (result.accepted === false && result.reason === "principal_rate_limited") {
    return {
      accepted: false,
      telemetry_recorded: false,
      retention: "dropped",
      inference_availability: "unaffected",
      reason: "telemetry_rate_limited",
    };
  }
  if (result.accepted === false && result.reason === "storage_unavailable") {
    return {
      accepted: false,
      telemetry_recorded: false,
      retention: "dropped",
      inference_availability: "unaffected",
      reason: "storage_unavailable",
    };
  }

  // A pre-contract gateway only returned { accepted: true }. Keep that response compatible;
  // enriched acknowledgements below are validated and returned without dropping telemetry
  // scope or retention evidence.
  if (keys.length === 1 && result.accepted === true) return { accepted: true };

  const expected = result.retention;
  if (!ADOPTION_RETENTIONS.has(expected)) {
    throw new M5ClientError(
      "invalid_adoption_report",
      "The gateway returned an unsupported adoption-report acknowledgement.",
    );
  }

  if (expected === "retained") {
    if (
      result.accepted !== true ||
      result.telemetry_recorded !== true ||
      result.inference_availability !== "unaffected" ||
      Object.prototype.hasOwnProperty.call(result, "reason") ||
      Object.prototype.hasOwnProperty.call(result, "retry_telemetry")
    ) {
      throw new M5ClientError(
        "invalid_adoption_report",
        "The gateway returned an unsupported retained adoption-report acknowledgement.",
      );
    }
  } else if (expected === "aggregated") {
    if (
      result.accepted !== true ||
      result.telemetry_recorded !== true ||
      result.inference_availability !== "unaffected" ||
      result.reason !== "telemetry_daily_cap" ||
      result.retry_telemetry !== "next_utc_day"
    ) {
      throw new M5ClientError(
        "invalid_adoption_report",
        "The gateway returned an unsupported aggregated adoption-report acknowledgement.",
      );
    }
  } else if (
    result.accepted !== false ||
    result.telemetry_recorded !== false ||
    !ADOPTION_REASONS.has(result.reason) ||
    (result.inference_availability !== undefined && result.inference_availability !== "unaffected") ||
    (result.retry_telemetry !== undefined && result.retry_telemetry !== "next_utc_day") ||
    (result.reason !== "invalid_report" && hasDiagnostic)
  ) {
    throw new M5ClientError(
      "invalid_adoption_report",
      "The gateway returned an unsupported dropped adoption-report acknowledgement.",
    );
  }

  return Object.fromEntries(
    ADOPTION_ACK_FIELDS
      .filter((field) => Object.prototype.hasOwnProperty.call(result, field))
      .map((field) => [field, result[field]]),
  );
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
  let nextId = 1;
  let sessionId = null;
  let token;
  let tokenPromise;
  const secrets = [];

  async function resolveToken() {
    if (token !== undefined) return token;
    if (tokenPromise) return tokenPromise;
    const pending = (async () => {
      let resolved;
      try {
        resolved = await credentialStore.resolve(profile);
      } catch (error) {
        if (error instanceof M5ClientError) throw error;
        throw new M5ClientError(
          "credential_unavailable",
          "The selected Keychain credential could not be resolved.",
        );
      }
      if (typeof resolved !== "string" || resolved.length === 0) {
        throw new M5ClientError("missing_credential", "The selected credential is empty.");
      }
      token = resolved;
      secrets.push(resolved);
      return resolved;
    })();
    tokenPromise = pending;
    try {
      return await pending;
    } catch (error) {
      // A long-lived stdio bridge must recover when Keychain was briefly unavailable. Do not cache
      // the rejected promise (or its error); a later RPC gets one fresh credential resolution.
      if (tokenPromise === pending) tokenPromise = undefined;
      throw error;
    }
  }

  async function request(message, retrySession = true) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resolvedToken = await resolveToken();
      const response = await fetchImpl(`${origin}/mcp`, {
        method: "POST",
        redirect: "error",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          authorization: `Bearer ${resolvedToken}`,
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
          credentialFailureMessage("rejected_credential", profile),
          credentialErrorOptions("rejected_credential", profile, {
            httpStatus: response.status,
            failureLayer: "authentication",
            retryable: false,
          }),
        );
      }
      if (response.status >= 400) {
        throw new M5ClientError(
          "upstream_http_error",
          `The MCP gateway returned HTTP ${response.status}.`,
          {
            httpStatus: response.status,
            diagnosticCode: "gateway_http_error",
            failureLayer: "gateway_health",
            retryable: response.status === 408 || response.status === 429 || response.status >= 500,
            remediation: transportRemediation(profile),
          },
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
          Number.isInteger(parsed.error.code) &&
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
        throw new M5ClientError("timeout", "The M5 gateway request timed out.", {
          diagnosticCode: "connect_timeout",
          failureLayer: "gateway_transport",
          retryable: true,
          remediation: transportRemediation(profile),
        });
      }
      if (error instanceof M5ClientError) throw error;
      const diagnosticCode = networkDiagnosticCode(error);
      throw new M5ClientError(
        "network_failure",
        `The M5 gateway transport failed (${diagnosticCode}).`,
        {
          diagnosticCode,
          failureLayer: "gateway_transport",
          retryable: true,
          remediation: transportRemediation(profile),
        },
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
        throw safeError(error, secrets, profile);
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
        throw safeError(error, secrets, profile);
      }
    },

    async models() {
      try {
        const id = nextId++;
        const response = await client.rpc({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name: "list_models", arguments: {} },
        });
        if (response?.error) {
          throw new M5ClientError(
            "mcp_error",
            redactText(rpcErrorMessage(response), secrets),
          );
        }
        const result = response?.result;
        if (!result || typeof result !== "object") {
          throw new M5ClientError(
            "malformed_mcp",
            "The MCP tool result is malformed.",
          );
        }
        if (result.isError === true) {
          const text = toolText(result);
          throw new M5ClientError(
            "tool_error",
            typeof text === "string" ? text : "The MCP tool reported an error.",
          );
        }

        if (Object.prototype.hasOwnProperty.call(result, "structuredContent")) {
          return parseStructuredModelsPayload(result.structuredContent);
        }

        const text = toolText(result);
        const models = parseModels(text);
        if (
          models.length === 0 &&
          !(typeof text === "string" && /^No models are available/i.test(text))
        ) {
          throw new M5ClientError(
            "malformed_mcp",
            "The model catalogue response is malformed.",
          );
        }
        return { models };
      } catch (error) {
        throw safeError(error, secrets, profile);
      }
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
      const id = nextId++;
      const response = await client.rpc({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: "ask", arguments: input },
      });
      if (response?.error) {
        throw new M5ClientError(
          "mcp_error",
          redactText(rpcErrorMessage(response), secrets),
        );
      }
      const result = redactValue(response?.result, secrets);
      if (!result || typeof result !== "object") {
        throw new M5ClientError("malformed_mcp", "The ask tool returned malformed content.");
      }
      if (result.isError === true) {
        if (result.structuredContent !== undefined) {
          try {
            const structured = normalizeAskPayload(result.structuredContent, input.model);
            if (isSupportedAskTruncation(structured)) return structured;
          } catch {
            // A broken structured error payload must not mask the real tool_error content.
          }
        }
        throw new M5ClientError(
          "tool_error",
          toolResultText(result),
        );
      }
      if (result.structuredContent !== undefined) {
        return normalizeAskPayload(result.structuredContent, input.model);
      }
      const text = Array.isArray(result.content)
        ? result.content.find((entry) => entry?.type === "text")?.text
        : undefined;
      if (typeof text !== "string") {
        throw new M5ClientError("malformed_mcp", "The ask tool returned malformed content.");
      }
      return {
        model: input.model,
        text,
        finish_reason: null,
        truncated: null,
        metered: true,
        usage: emptyAskUsage(),
      };
    },

    async reportAdoption(input) {
      if (!isValidAdoptionReport(input)) {
        throw new M5ClientError(
          "invalid_adoption_report",
          "adoption report must use the closed, content-free evidence contract.",
        );
      }
      try {
        // Adoption refusals are still useful acknowledgements. Read the structured result even
        // when an older gateway marks a telemetry-only refusal as an MCP tool error; ask and
        // code-loop tool errors retain their existing strict client.tool() semantics.
        const id = nextId++;
        const response = await client.rpc({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name: "record_adoption_evidence", arguments: input },
        });
        if (response?.error) {
          throw new M5ClientError(
            "mcp_error",
            redactText(rpcErrorMessage(response), secrets),
          );
        }
        const result = response?.result;
        if (result?.structuredContent !== undefined) {
          return normalizeAdoptionAcknowledgement(result.structuredContent);
        }
        if (result?.isError === true) {
          throw new M5ClientError("tool_error", toolResultText(result));
        }
        throw new M5ClientError(
          "invalid_adoption_report",
          "The gateway returned a malformed adoption-report acknowledgement.",
        );
      } catch (error) {
        throw safeError(error, secrets, profile);
      }
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
  return redactValue({
    connector: { ...UNSUPPORTED_CONNECTOR_DIAGNOSTIC },
    ...result,
  }, []);
}

async function identityRequest(baseUrl, token, profile, fetchImpl, timeoutMs) {
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
        credentialFailureMessage("rejected_credential", profile),
        credentialErrorOptions("rejected_credential", profile, {
          failureLayer: "authentication",
          retryable: false,
        }),
      );
    }
    if (!response.ok) {
      throw new M5ClientError(
        "upstream_http_error",
        `The gateway identity check returned HTTP ${response.status}.`,
        {
          httpStatus: response.status,
          diagnosticCode: "gateway_http_error",
          failureLayer: "gateway_health",
          retryable: response.status === 408 || response.status === 429 || response.status >= 500,
          remediation: transportRemediation(profile),
        },
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
      throw new M5ClientError("timeout", "The gateway identity check timed out.", {
        diagnosticCode: "connect_timeout",
        failureLayer: "gateway_transport",
        retryable: true,
        remediation: transportRemediation(profile),
      });
    }
    if (error instanceof M5ClientError) throw error;
    const diagnosticCode = networkDiagnosticCode(error);
    throw new M5ClientError(
      "network_failure",
      `The gateway identity check transport failed (${diagnosticCode}).`,
      {
        diagnosticCode,
        failureLayer: "gateway_transport",
        retryable: true,
        remediation: transportRemediation(profile),
      },
    );
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
  const identity = await identityRequest(baseUrl, token, profile, fetchImpl, timeoutMs);
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
  const tools = response.result.tools
    .map((tool) => tool?.name)
    .filter((name) => typeof name === "string")
    .sort();
  // list_models is a content-free catalogue/discovery check. It does not exercise the model
  // backend: ask is metered and doctor deliberately never issues an inference probe.
  let modelDiscovery = { status: "not_advertised", model_count: null };
  if (tools.includes("list_models")) {
    try {
      const models = await client.models();
      modelDiscovery = {
        status: "available",
        model_count: models.models.length,
        // Keep the actual allow-list internal. Doctor only needs a stable, content-free value
        // to compare public/private paths and must not echo model IDs to callers.
        model_digest: modelCatalogueDigest(models.models),
      };
    } catch (error) {
      // Preserve authentication failures so the doctor keeps its auth-layer diagnosis and
      // canonical remediation. Other failures are explicitly scoped to model discovery.
      if (error instanceof M5ClientError && CREDENTIAL_FAILURE_CODES.has(error.code)) throw error;
      modelDiscovery = {
        status: "unavailable",
        model_count: null,
        model_digest: null,
        failure_code: "model_discovery_unavailable",
        http_status: error instanceof M5ClientError ? error.httpStatus : undefined,
      };
    }
  }
  return {
    identity: {
      alias: identity?.alias,
      tier: identity?.tier,
      scope: identity?.scope,
    },
    tools,
    model_discovery: modelDiscovery,
  };
}

function modelCatalogueDigest(models) {
  const ids = models.map((model) => model.id).sort();
  return createHash("sha256").update(JSON.stringify(ids)).digest("hex");
}

function doctorEndpointFailure(error, profile, secrets) {
  const safe = safeError(error, secrets, profile);
  let status = "unavailable";
  if (safe.code === "rejected_credential") {
    status = "rejected_credential";
  } else if (safe.code === "timeout") {
    status = "timeout";
  } else if (safe.code === "upstream_http_error") {
    if (safe.httpStatus === 503) status = "busy";
    else if (safe.httpStatus === 504 || safe.httpStatus === 408) status = "timeout";
    else if (safe.httpStatus >= 500) status = "backend_failure";
    else status = "backend_failure";
  } else if (safe.code === "tool_error" || safe.code === "mcp_error") {
    if (/\b(?:server\s+)?busy\b/i.test(safe.message)) status = "busy";
    else if (/\b(?:timed?\s*out|timeout)\b/i.test(safe.message)) status = "timeout";
    else status = "backend_failure";
  } else if (safe.code === "network_failure") {
    // `network_failure` was the original public doctor status. Keep it stable for callers while
    // retaining the richer diagnostic code for newer consumers.
    status = "network_failure";
  } else if (safe.code === "malformed_mcp" || safe.code === "malformed_identity") {
    status = "backend_failure";
  } else if (safe.code === "model_discovery_unavailable") {
    status = "model_discovery_unavailable";
  }
  return {
    safe,
    status,
    ...(safe.httpStatus === undefined ? {} : { http_status: safe.httpStatus }),
  };
}

function doctorCredentialResult({ profile, status, credential, endpoints }) {
  return safeDoctorResult({
    status,
    profile,
    credential,
    auth_layer: "profile_keychain",
    ...(status === "missing_credential" || status === "rejected_credential"
      ? { remediation: credentialRemediation(profile) }
      : {}),
    model_discovery: { public: "not_checked", private: "not_checked" },
    inference: { public: "not_checked", private: "not_checked" },
    endpoints,
  });
}

function doctorCapabilityFields(
  publicProbe,
  privateProbe,
  { publicStatus = "not_checked", privateStatus = "not_checked" } = {},
) {
  return {
    // `available` means only that the content-free model catalogue was returned. It is not
    // an inference/readiness claim.
    model_discovery: {
      public: publicProbe?.model_discovery?.status ?? publicStatus,
      private: privateProbe?.model_discovery?.status ?? privateStatus,
    },
    // Doctor never calls `ask`: that path is metered, so readiness remains explicitly unknown.
    inference: { public: "not_checked", private: "not_checked" },
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
      return doctorCredentialResult({
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
    return doctorCredentialResult({
      status,
      profile,
      credential: "unavailable",
      endpoints: { public: "not_checked", private: "not_checked" },
    });
  }
  if (typeof token !== "string" || token.length === 0) {
    return doctorCredentialResult({
      profile,
      status: "missing_credential",
      credential: "missing",
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
    const failure = doctorEndpointFailure(error, profile, [token]);
    const status = failure.status;
    return safeDoctorResult({
      status,
      profile,
      credential: "present",
      ...(status === "rejected_credential"
        ? { auth_layer: "gateway_credential", remediation: credentialRemediation(profile) }
        : {}),
      ...(failure.safe.code === "rejected_credential"
        ? {}
        : { diagnostic_code: failure.safe.diagnosticCode ?? failure.safe.code }),
      ...(failure.http_status === undefined ? {} : { http_status: failure.http_status }),
      ...doctorCapabilityFields(null, null, {
        publicStatus: failure.safe.code === "model_discovery_unavailable" ? "unavailable" : "not_checked",
      }),
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
      ...doctorCapabilityFields(publicProbe, null),
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
      identity: {
        tier: publicProbe.identity.tier ?? "unknown",
        scope: publicProbe.identity.scope ?? "unknown",
      },
      missing_tools: publicMissing,
      ...doctorCapabilityFields(publicProbe, null),
      endpoints: { public: "missing_tools", private: "not_checked" },
    });
  }

  if (publicProbe.model_discovery.status === "unavailable") {
    return safeDoctorResult({
      status: "model_discovery_unavailable",
      profile,
      credential: "present",
      identity: {
        tier: publicProbe.identity.tier,
        scope: publicProbe.identity.scope,
      },
      diagnostic_code: publicProbe.model_discovery.failure_code,
      ...(publicProbe.model_discovery.http_status === undefined
        ? {}
        : { http_status: publicProbe.model_discovery.http_status }),
      ...doctorCapabilityFields(publicProbe, null),
      endpoints: { public: "model_discovery_unavailable", private: "not_checked" },
    });
  }

  if (!config.privateGatewayUrl) {
    return safeDoctorResult({
      status: "healthy",
      profile,
      credential: "present",
      ...doctorCapabilityFields(publicProbe, null),
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
    const failure = doctorEndpointFailure(error, profile, [token]);
    const status = failure.status;
    return safeDoctorResult({
      status,
      profile,
      credential: "present",
      ...(status === "rejected_credential"
        ? { auth_layer: "gateway_credential", remediation: credentialRemediation(profile) }
        : {}),
      ...(failure.safe.code === "rejected_credential"
        ? {}
        : { diagnostic_code: failure.safe.diagnosticCode ?? failure.safe.code }),
      ...(failure.http_status === undefined ? {} : { http_status: failure.http_status }),
      ...doctorCapabilityFields(publicProbe, null, {
        privateStatus: failure.safe.code === "model_discovery_unavailable" ? "unavailable" : "not_checked",
      }),
      endpoints: { public: "healthy", private: status },
    });
  }

  if (privateProbe.identity.tier !== "owner" || !["agent", "admin"].includes(privateProbe.identity.scope)) {
    return safeDoctorResult({
      status: "wrong_scope",
      profile,
      credential: "present",
      identity: {
        tier: privateProbe.identity.tier ?? "unknown",
        scope: privateProbe.identity.scope ?? "unknown",
      },
      ...doctorCapabilityFields(publicProbe, privateProbe),
      endpoints: { public: "healthy", private: "wrong_scope" },
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
      identity: {
        tier: privateProbe.identity.tier ?? "unknown",
        scope: privateProbe.identity.scope ?? "unknown",
      },
      missing_tools: privateMissing,
      ...doctorCapabilityFields(publicProbe, privateProbe),
      endpoints: { public: "healthy", private: "missing_tools" },
    });
  }

  if (privateProbe.model_discovery.status === "unavailable") {
    return safeDoctorResult({
      status: "model_discovery_unavailable",
      profile,
      credential: "present",
      identity: {
        tier: privateProbe.identity.tier,
        scope: privateProbe.identity.scope,
      },
      diagnostic_code: privateProbe.model_discovery.failure_code,
      ...(privateProbe.model_discovery.http_status === undefined
        ? {}
        : { http_status: privateProbe.model_discovery.http_status }),
      ...doctorCapabilityFields(publicProbe, privateProbe),
      endpoints: { public: "healthy", private: "model_discovery_unavailable" },
    });
  }

  if (
    JSON.stringify(publicProbe.identity) !== JSON.stringify(privateProbe.identity) ||
    JSON.stringify(publicProbe.tools) !== JSON.stringify(privateProbe.tools) ||
    JSON.stringify(publicProbe.model_discovery) !== JSON.stringify(privateProbe.model_discovery)
  ) {
    return safeDoctorResult({
      status: "path_parity_failed",
      profile,
      credential: "present",
      ...doctorCapabilityFields(publicProbe, privateProbe),
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
    ...doctorCapabilityFields(publicProbe, privateProbe),
    endpoints: { public: "healthy", private: "healthy" },
  });
}
