export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: unknown;
  params?: unknown;
}

export type McpEnvelopeParseResult =
  | { ok: true; message: JsonRpcRequest }
  | { ok: false; kind: "parse" | "invalid" };

export function parseMcpEnvelope(rawBody: string): McpEnvelopeParseResult {
  let msg: JsonRpcRequest;
  try {
    msg = JSON.parse(rawBody) as JsonRpcRequest;
  } catch {
    return { ok: false, kind: "parse" };
  }
  if (typeof msg !== "object" || msg === null || Array.isArray(msg) || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return { ok: false, kind: "invalid" };
  }
  return { ok: true, message: msg };
}
