import { M5ClientError, credentialRemediation, redactText } from "./m5-client.mjs";

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

function bridgeError(error, profile) {
  if (!(error instanceof M5ClientError)) {
    return { message: "The MCP bridge request failed." };
  }
  const credentialFailure = error.code === "missing_credential" || error.code === "rejected_credential";
  return {
    message: credentialFailure
      ? `${error.code === "missing_credential" ? "The selected profile has no usable Keychain credential." : "The gateway rejected the selected profile credential."} ${error.remediation ?? credentialRemediation(profile)}`
      : error.message,
    data: {
      m5_code: error.code,
      ...(credentialFailure ? { remediation: error.remediation ?? credentialRemediation(profile) } : {}),
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

export function createMcpStdioBridge({ client, profile }) {
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
      try {
        const response = await client.rpc(message);
        if (notification) return null;
        if (response === null) {
          return rpcError(
            message.id,
            -32603,
            "The MCP gateway returned an empty response for a request.",
          );
        }
        return JSON.stringify(response);
      } catch (error) {
        if (notification) return null;
        const failure = bridgeError(error, profile);
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
