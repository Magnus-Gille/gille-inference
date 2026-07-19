/**
 * Issue #166 — the /delegate `responseFormat` validator (parseResponseFormat).
 *
 * A caller (e.g. ratatoskr triage) may supply an explicit response_format to get a hard well-formed-JSON
 * guarantee. Untrusted input, so it is validated to an allow-list of the three OpenAI shapes and
 * reconstructed minimally (unknown fields are never forwarded to llama.cpp). Pure — no server needed.
 */
import { describe, it, expect } from "vitest";
import { parseResponseFormat } from "../src/homeserver/gateway.js";

describe("parseResponseFormat — /delegate structured-output validation (#166)", () => {
  it("accepts { type: 'text' } and { type: 'json_object' }", () => {
    expect(parseResponseFormat({ type: "text" })).toEqual({ ok: true, value: { type: "text" } });
    expect(parseResponseFormat({ type: "json_object" })).toEqual({
      ok: true,
      value: { type: "json_object" },
    });
  });

  it("accepts a well-formed json_schema and reconstructs a minimal value (drops unknown fields)", () => {
    const out = parseResponseFormat({
      type: "json_schema",
      json_schema: { name: "verdict", schema: { type: "object" }, strict: true },
      bogusTopLevel: "ignored",
    });
    expect(out).toEqual({
      ok: true,
      value: {
        type: "json_schema",
        json_schema: { name: "verdict", schema: { type: "object" }, strict: true },
      },
    });
  });

  it("omits strict when not a boolean", () => {
    const out = parseResponseFormat({
      type: "json_schema",
      json_schema: { name: "v", schema: {} },
    });
    expect(out.ok).toBe(true);
    if (out.ok && out.value && out.value.type === "json_schema") {
      expect(out.value.json_schema).not.toHaveProperty("strict");
    }
  });

  it("rejects a non-object, an unknown type, and a missing/blank schema name", () => {
    expect(parseResponseFormat("json").ok).toBe(false);
    expect(parseResponseFormat(null).ok).toBe(false);
    expect(parseResponseFormat({ type: "yaml" }).ok).toBe(false);
    expect(parseResponseFormat({ type: "json_schema", json_schema: { schema: {} } }).ok).toBe(false);
    expect(
      parseResponseFormat({ type: "json_schema", json_schema: { name: "", schema: {} } }).ok
    ).toBe(false);
  });

  it("enforces the OpenAI json_schema name contract ([A-Za-z0-9_-], ≤64) so a clean 400 beats a downstream failure", () => {
    const mk = (name: string) =>
      parseResponseFormat({ type: "json_schema", json_schema: { name, schema: {} } });
    // valid: letters, digits, underscore, hyphen
    expect(mk("triage_verdict-v2").ok).toBe(true);
    // invalid: whitespace / disallowed chars / too long
    expect(mk("has space").ok).toBe(false);
    expect(mk("has.dot").ok).toBe(false);
    expect(mk("a".repeat(65)).ok).toBe(false);
    // boundary: exactly 64 is allowed
    expect(mk("a".repeat(64)).ok).toBe(true);
  });

  it("rejects a json_schema whose schema is missing or not an object", () => {
    expect(parseResponseFormat({ type: "json_schema", json_schema: { name: "v" } }).ok).toBe(false);
    expect(
      parseResponseFormat({ type: "json_schema", json_schema: { name: "v", schema: [] } }).ok
    ).toBe(false);
  });
});
