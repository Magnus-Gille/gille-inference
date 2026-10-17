import { describe, expect, it } from "vitest";
import { parseTokenizeResponse } from "../src/homeserver/tokenize-response.js";

describe("parseTokenizeResponse", () => {
  it("parses Swedish and English pieces while preserving order and whitespace", () => {
    const input = {
      tokens: [
        { id: 10, piece: "Hej" },
        { id: 11, piece: " " },
        { id: 12, piece: "världen" },
        { id: 13, piece: "!" },
      ],
      has_more: false,
    };
    expect(parseTokenizeResponse(input)).toEqual({
      count: 4,
      tokens: [10, 11, 12, 13],
      pieces: ["Hej", " ", "världen", "!"],
    });
  });

  it("accepts byte fallbacks and preserves repeated token IDs and pieces", () => {
    const input = {
      tokens: [
        { id: 7, piece: [195] },
        { id: 7, piece: [161] },
        { id: 7, piece: [195] },
      ],
    };
    const parsed = parseTokenizeResponse(input);
    expect(parsed).toEqual({
      count: 3,
      tokens: [7, 7, 7],
      pieces: [[195], [161], [195]],
    });
    expect(parsed?.pieces[0]).not.toBe((input.tokens[0] as { piece: number[] }).piece);
  });

  it("accepts an empty token list", () => {
    expect(parseTokenizeResponse({ tokens: [] })).toEqual({ count: 0, tokens: [], pieces: [] });
  });

  it("returns fresh result arrays", () => {
    const inputTokens = [{ id: 1, piece: [65] }];
    const parsed = parseTokenizeResponse({ tokens: inputTokens });
    expect(parsed).not.toBeNull();
    expect(parsed?.tokens).not.toBe(inputTokens);
    expect(parsed?.pieces).not.toBe(inputTokens);
    expect(parsed?.pieces[0]).not.toBe(inputTokens[0].piece);
  });

  it("rejects malformed roots and entries", () => {
    const invalid: unknown[] = [
      null,
      [],
      {},
      { tokens: "not-an-array" },
      { tokens: [{ id: 1 }] },
      { tokens: [{ piece: "x" }] },
      { tokens: [[{ id: 1, piece: "x" }]] },
      { tokens: [{ id: 1, piece: "x", extra: true }] },
      { tokens: [{ id: 1, piece: 65 }] },
      { tokens: [{ id: -1, piece: "x" }] },
      { tokens: [{ id: 2_147_483_648, piece: "x" }] },
      { tokens: [{ id: 1.5, piece: "x" }] },
      { tokens: [{ id: 1, piece: [256] }] },
      { tokens: [{ id: 1, piece: [-1] }] },
      { tokens: [{ id: 1, piece: [1.25] }] },
    ];
    for (const value of invalid) expect(parseTokenizeResponse(value)).toBeNull();
  });

  it("rejects unpaired UTF-16 surrogates but preserves valid pairs", () => {
    expect(parseTokenizeResponse({ tokens: [{ id: 1, piece: "\ud800" }] })).toBeNull();
    expect(parseTokenizeResponse({ tokens: [{ id: 1, piece: "\udc00" }] })).toBeNull();
    expect(parseTokenizeResponse({ tokens: [{ id: 1, piece: "😀" }] })).toEqual({
      count: 1,
      tokens: [1],
      pieces: ["😀"],
    });
  });

  it("enforces token and UTF-8 piece byte caps", () => {
    expect(parseTokenizeResponse({
      tokens: Array.from({ length: 32_769 }, (_, id) => ({ id: id % 2_147_483_648, piece: "" })),
    })).toBeNull();
    expect(parseTokenizeResponse({
      tokens: [{ id: 1, piece: "a".repeat(131_073) }],
    })).toBeNull();
    expect(parseTokenizeResponse({
      tokens: [{ id: 1, piece: [0].concat(new Array(131_072).fill(0)) }],
    })).toBeNull();
    expect(parseTokenizeResponse({
      tokens: [{ id: 1, piece: "a".repeat(131_072) }, { id: 2, piece: [0] }],
    })).toBeNull();
  });
});
