import type { ResponseFormat } from "../runner/openrouter-client.js";

/**
 * Validate an optional structured-output format for /delegate and MCP ask (#166).
 * Accepts only the three OpenAI shapes and
 * reconstructs a minimal well-formed value (never forwards unknown fields from an untrusted body):
 *   { type: "text" } | { type: "json_object" } | { type: "json_schema", json_schema: { name, schema, strict? } }
 * A grammar-constrained json_schema is the strongest way to stop gpt-oss-120b's harmony 500; a bad
 * value gets a clean edge-validation error rather than a downstream llama.cpp error. PURE (no I/O).
 */
export function parseResponseFormat(
  value: unknown,
  fieldName = "responseFormat",
): { ok: true; value: ResponseFormat } | { ok: false; message: string } {
  if (value === null || typeof value !== "object") {
    return { ok: false, message: `'${fieldName}' must be an object.` };
  }
  const t = (value as Record<string, unknown>)["type"];
  if (t === "text" || t === "json_object") {
    return { ok: true, value: { type: t } };
  }
  if (t === "json_schema") {
    const js = (value as Record<string, unknown>)["json_schema"];
    if (js === null || typeof js !== "object") {
      return { ok: false, message: `'${fieldName}.json_schema' must be an object.` };
    }
    const name = (js as Record<string, unknown>)["name"];
    const schema = (js as Record<string, unknown>)["schema"];
    const strict = (js as Record<string, unknown>)["strict"];
    // Match OpenAI's json_schema.name contract ([A-Za-z0-9_-], ≤64) so a bad name gets a clean 400
    // here rather than a downstream llama.cpp failure — the whole point of validating at the edge.
    if (typeof name !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
      return {
        ok: false,
        message: `'${fieldName}.json_schema.name' must match [A-Za-z0-9_-] and be 1–64 characters.`,
      };
    }
    if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
      return { ok: false, message: `'${fieldName}.json_schema.schema' must be an object.` };
    }
    return {
      ok: true,
      value: {
        type: "json_schema",
        json_schema: {
          name,
          schema: schema as Record<string, unknown>,
          ...(typeof strict === "boolean" ? { strict } : {}),
        },
      },
    };
  }
  return {
    ok: false,
    message: `'${fieldName}.type' must be one of: text, json_object, json_schema.`,
  };
}
