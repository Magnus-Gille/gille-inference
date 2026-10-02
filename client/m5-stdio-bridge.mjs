import { isAbsolute } from "node:path";
import { runBuild } from "./m5-build.mjs";
import {
  M5ClientError,
  classifyAskRefusal,
  createFileAdoptionSpool,
  credentialRemediation,
  gatewayHttpRemediation,
  localTailnetRemediation,
  redactText,
  spoolAdoptionOutageReport,
  transportRemediation,
} from "./m5-client.mjs";

function rpcError(id, code, message, data) {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message: redactText(message),
      ...(data === undefined ? {} : { data: redactValue(data) }),
    },
  });
}

function redactValue(value) {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactValue(entry)]));
  }
  return value;
}

function isAdoptionReport(message) {
  return message?.method === "tools/call" &&
    message?.params?.name === "record_adoption_evidence";
}

const BUILD_CODES = new Set([
  "build_macos_only", "build_timeout", "build_worker_failure", "build_protocol_error",
]);

// The gateway's ask refusals for host-memory admission carry only fixed text (#350). Expose the
// machine-readable code beside the untouched result so a caller can branch without parsing prose.
function annotateAskRefusal(message, response) {
  const result = response?.result;
  if (message?.method !== "tools/call" || message?.params?.name !== "ask" ||
      !result || typeof result !== "object" || result.isError !== true ||
      result.structuredContent !== undefined) return response;
  const text = Array.isArray(result.content) ? result.content.find(entry => entry?.type === "text")?.text : undefined;
  // A newer gateway already says so itself; leave its `_meta` as sent.
  if (result._meta && typeof result._meta === "object" && typeof result._meta.m5_code === "string") return response;
  const refusal = classifyAskRefusal(text);
  if (refusal === null) return response;
  return {
    ...response,
    result: {
      ...result,
      _meta: {
        ...(result._meta && typeof result._meta === "object" && !Array.isArray(result._meta) ? result._meta : {}),
        m5_code: refusal.code,
        retryable: refusal.retryable,
        ...(refusal.retryAfterSeconds === undefined ? {} : { retry_after_seconds: refusal.retryAfterSeconds }),
      },
    },
  };
}

function isCodeLoopResult(message) {
  return message?.method === "tools/call" &&
    message?.params?.name === "code_loop_result";
}

function isRetryableResultTransport(error) {
  return error instanceof M5ClientError &&
    error.retryable === true &&
    (error.code === "network_failure" || error.code === "timeout" || error.code === "upstream_http_error");
}

// Some MCP hosts render only error.message and discard JSON-RPC error.data. Keep
// the actionable diagnosis in both places, with a closed vocabulary so an upstream
// response cannot put arbitrary content or a locator into the visible message.
const VISIBLE_DIAGNOSTICS = new Set([
  "dns_failure", "connection_refused", "route_unreachable", "connection_reset",
  "connect_timeout", "tls_failure", "network_failure", "gateway_http_error",
  "cloudflare_tunnel_unavailable", "cloudflare_origin_unresolved",
]);
const VISIBLE_LAYERS = new Set([
  "authentication", "gateway_transport", "gateway_health", "gateway_protocol",
  "connector_transport", "local_tailnet_unavailable", "public_route_unconfigured",
  "private_route_unconfigured",
]);

function visibleFailureSuffix(error, failureLayer) {
  if (!VISIBLE_DIAGNOSTICS.has(error.diagnosticCode) && !VISIBLE_LAYERS.has(failureLayer)) {
    return "";
  }
  const diagnostic = VISIBLE_DIAGNOSTICS.has(error.diagnosticCode)
    ? error.diagnosticCode : "unknown";
  const layer = VISIBLE_LAYERS.has(failureLayer) ? failureLayer : "unknown";
  return ` [diagnostic_code=${diagnostic}; failure_layer=${layer}; retryable=${error.retryable === true}]`;
}

// Closed copy of the client's evidence-recovery shape (#242). Only a valid spooled /
// spool-failed outcome travels; anything else falls back to the legacy contract so a
// malformed carrier can never smuggle a locator or free-form text into bridge output.
function validEvidenceRecovery(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (value.action !== "retry_same_tool_call") return undefined;
  if (value.status === "spooled") {
    if (typeof value.spool_id !== "string" || !/^adoption-[0-9]{8}T[0-9]{6}-[0-9a-f]{8}$/.test(value.spool_id)) {
      return undefined;
    }
    return { status: "spooled", spool_id: value.spool_id, action: "retry_same_tool_call" };
  }
  if (value.status === "spool_failed") {
    return { status: "spool_failed", action: "retry_same_tool_call" };
  }
  return undefined;
}

async function bridgeError(error, profile, message, { resultRetryAttempted = false, adoptionSpool } = {}) {
  if (!(error instanceof M5ClientError)) {
    return { message: "The MCP bridge request failed." };
  }
  const credentialFailure = error.code === "missing_credential" || error.code === "rejected_credential";
  const gatewayTransportFailure = error.code === "network_failure" || error.code === "timeout";
  const transportFailure = gatewayTransportFailure || error.code === "upstream_http_error";
  const remediation = credentialFailure
    ? credentialRemediation(profile)
    : error.code === "upstream_http_error"
      ? gatewayHttpRemediation(profile, error.diagnosticCode)
      : error.failureLayer === "local_tailnet_unavailable"
        ? localTailnetRemediation(profile)
      : gatewayTransportFailure
      ? transportRemediation(profile)
      : error.remediation;
  const failureLayer = gatewayTransportFailure && error.failureLayer !== "local_tailnet_unavailable"
    ? "connector_transport"
    : error.failureLayer;
  // A spooled adoption report survives the outage it reports on (#242): prefer the
  // client's closed recovery shape, else spool the caller's own content-free arguments
  // here, else keep the legacy contract. Nothing but the closed shape ever travels.
  let evidenceRecovery;
  if (isAdoptionReport(message) && transportFailure) {
    evidenceRecovery =
      validEvidenceRecovery(error.evidenceRecovery) ??
      (await spoolAdoptionOutageReport(adoptionSpool, {
        profile,
        report: message?.params?.arguments,
        failure: { code: error.code, diagnosticCode: error.diagnosticCode },
      })) ?? {
        status: "not_recorded",
        action: "retry_same_tool_call",
      };
  }
  const visibleMessage = credentialFailure
    ? `${error.code === "missing_credential" ? "The selected profile has no usable Keychain credential." : "The gateway rejected the selected profile credential."} ${remediation}`
    : error.message;
  return {
    message: `${visibleMessage}${visibleFailureSuffix(error, failureLayer)}`,
    data: {
      m5_code: error.code,
      ...(error.diagnosticCode === undefined ? {} : { diagnostic_code: error.diagnosticCode }),
      ...(failureLayer === undefined ? {} : { failure_layer: failureLayer }),
      ...(error.httpStatus === undefined ? {} : { http_status: error.httpStatus }),
      ...(error.retryable === undefined ? {} : { retryable: error.retryable }),
      ...(remediation === undefined ? {} : { remediation }),
      ...(evidenceRecovery === undefined ? {} : { evidence_recovery: evidenceRecovery }),
      ...(isCodeLoopResult(message) && resultRetryAttempted
        ? {
            result_recovery: {
              status: "retry_exhausted",
              automatic_retries: 1,
              action: isRetryableResultTransport(error)
                ? "retry_same_work_id"
                : "follow_error_remediation",
            },
          }
        : {}),
    },
  };
}

function validMessage(message) {
  return (
    message &&
    typeof message === "object" &&
    !Array.isArray(message) &&
    message.jsonrpc === "2.0" &&
    typeof message.method === "string" &&
    (message.id === undefined ||
      message.id === null ||
      typeof message.id === "string" ||
      typeof message.id === "number")
  );
}

export function createMcpStdioBridge({ client, profile, adoptionSpool = createFileAdoptionSpool(), buildConfig, buildRunner = runBuild }) {
  return Object.freeze({
    async handleLine(line) {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return rpcError(null, -32700, "Parse error");
      }
      if (!validMessage(message)) {
        return rpcError(null, -32600, "Invalid Request");
      }
      const notification = message.id === undefined || message.id === null;
      let resultRetryAttempted = false;
      try {
        let response;
        if (message.method === "tools/call" && message.params?.name === "build_run") {
          if (notification) return null;
          if (!buildConfig) throw new M5ClientError("build_unavailable", "Local build is not configured.");
          const args = message.params.arguments;
          if (!args || typeof args !== "object" || Array.isArray(args) || typeof args.cwd !== "string" || !isAbsolute(args.cwd) ||
              Object.keys(args).some(key => !["cwd", "command", "pull", "toolchain"].includes(key)) ||
              !Array.isArray(args.command) || args.command.length === 0 || args.command.some(value => typeof value !== "string") ||
              (args.pull !== undefined && (!Array.isArray(args.pull) || args.pull.some(value => typeof value !== "string"))) ||
              (args.toolchain !== undefined && typeof args.toolchain !== "string")) {
            throw new M5ClientError("invalid_args", "build_run requires absolute cwd, command string array, optional toolchain, and optional pull paths.");
          }
          const quiet = { write() { return true; } };
          let result;
          try {
            result = await buildRunner({ cwd: args.cwd, command: args.command, toolchain: args.toolchain, pull: args.pull ?? [], config: buildConfig, stdout: quiet, stderr: quiet, outputLimit: 1024 * 1024, captureOutput: true });
          } catch (error) {
            // Pass the build client's own refusal through, as the CLI prints it (#357). m5-build.mjs
            // never forwards free-form remote worker text into these messages, so this stays safe.
            if (error instanceof M5ClientError || !(error instanceof Error)) throw error;
            throw new M5ClientError(BUILD_CODES.has(error.buildCode) ? error.buildCode : "build_failed", error.message);
          }
          response = { jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: JSON.stringify(result) }], isError: result.exit_code !== 0 } };
        } else {
          try {
            response = await client.rpc(message);
        } catch (error) {
          if (!notification && isCodeLoopResult(message) && isRetryableResultTransport(error)) {
            resultRetryAttempted = true;
            response = await client.rpc(message);
          } else {
            throw error;
          }
          }
        }
        if (notification) return null;
        response = annotateAskRefusal(message, response);
        if (response === null) {
          return rpcError(
            message.id,
            -32603,
            "The MCP gateway returned an empty response for a request.",
          );
        }
        if (message.method === "tools/list" && buildConfig && response?.result?.tools && !response.result.tools.some(tool => tool.name === "build_run")) {
          response.result.tools = [...response.result.tools, {
            name: "build_run",
            description: "Run a local M5 build over the configured SSH build worker; never uses gateway credentials.",
            inputSchema: { type: "object", additionalProperties: false, required: ["cwd", "command"], properties: {
              cwd: { type: "string", description: "Absolute local git worktree path." },
              command: { type: "array", items: { type: "string" }, description: "Literal command argv." },
              toolchain: { type: "string" }, pull: { type: "array", items: { type: "string" } },
            } },
          }];
        }
        return JSON.stringify(response);
      } catch (error) {
        if (notification) return null;
        const failure = await bridgeError(error, profile, message, { resultRetryAttempted, adoptionSpool });
        return rpcError(message.id, -32603, failure.message, failure.data);
      }
    },
  });
}

/**
 * Newline-delimited JSON-RPC stdio pump. Only JSON-RPC responses reach stdout.
 */
export async function runMcpStdioBridge({
  bridge,
  input = process.stdin,
  output = process.stdout,
}) {
  input.setEncoding?.("utf8");
  let buffered = "";
  for await (const chunk of input) {
    buffered += String(chunk);
    while (true) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) break;
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (line.length === 0) continue;
      const response = await bridge.handleLine(line);
      if (response !== null) output.write(`${response}\n`);
    }
  }
  const finalLine = buffered.trim();
  if (finalLine.length > 0) {
    const response = await bridge.handleLine(finalLine);
    if (response !== null) output.write(`${response}\n`);
  }
}
