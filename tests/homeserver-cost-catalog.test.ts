import { describe, it, expect } from "vitest";
import {
  DEFAULT_PREMIUM_BASELINE_MODEL_ID,
  estimateTokenCostUsd,
  inspectModelTokenPrice,
  lookupModelTokenPrice,
} from "../src/homeserver/cost-catalog.js";

describe("homeserver cost catalog", () => {
  it("prices the fixed premium baseline (Claude Fable 5)", () => {
    const price = lookupModelTokenPrice(DEFAULT_PREMIUM_BASELINE_MODEL_ID);
    expect(price?.inputUsdPerMTok).toBe(10);
    expect(price?.outputUsdPerMTok).toBe(50);
  });

  it("normalizes provider-prefixed model ids", () => {
    expect(lookupModelTokenPrice("anthropic/claude-fable-5")?.outputUsdPerMTok).toBe(50);
    expect(lookupModelTokenPrice("openai/gpt-5.4-mini")?.outputUsdPerMTok).toBe(4.5);
  });

  it("normalizes common hyphenated vendor version ids", () => {
    expect(lookupModelTokenPrice("anthropic/claude-opus-4-5")?.outputUsdPerMTok).toBe(25);
    expect(lookupModelTokenPrice("anthropic/claude-sonnet-4-6")?.outputUsdPerMTok).toBe(15);
    expect(lookupModelTokenPrice("openai/gpt-5-4-mini")?.outputUsdPerMTok).toBe(4.5);
  });

  it("normalizes dated Anthropic SDK model ids", () => {
    expect(lookupModelTokenPrice("claude-haiku-4-5-20251001")?.outputUsdPerMTok).toBe(5);
    expect(lookupModelTokenPrice("anthropic/claude-sonnet-5-20260929")?.outputUsdPerMTok).toBe(10);
  });

  it("estimates prompt/output token cost in USD", () => {
    // Fable: 1M input at $10 + 1M output at $50.
    expect(estimateTokenCostUsd("claude-fable-5", 1_000_000, 1_000_000)).toBe(60);
  });

  it("prices each newly evidenced paid delegator from a first-party tariff", () => {
    expect(lookupModelTokenPrice("anthropic/claude-opus-5")?.outputUsdPerMTok).toBe(25);
    expect(lookupModelTokenPrice("openai/gpt-5")?.inputUsdPerMTok).toBe(1.25);
    expect(lookupModelTokenPrice("openai/gpt-5.6-sol")).toMatchObject({
      inputUsdPerMTok: 4,
      outputUsdPerMTok: 20,
      checkedAt: "2026-08-29",
      validUntil: "2026-09-28",
    });
    expect(lookupModelTokenPrice("openai/gpt-5.6")).toMatchObject({
      inputUsdPerMTok: 4,
      outputUsdPerMTok: 20,
    });
  });

  it("does not substitute a reseller or local-model rate for an official vendor tariff", () => {
    expect(inspectModelTokenPrice("qwen3-30b-instruct").kind).toBe("unavailable");
    expect(lookupModelTokenPrice("qwen/qwen3-coder-next")).toBeNull();
  });

  it("fails closed after a catalog entry expires", () => {
    const status = inspectModelTokenPrice("openai/gpt-5", { now: new Date("2026-09-29T00:00:00.000Z") });
    expect(status.kind).toBe("stale");
    expect(lookupModelTokenPrice("openai/gpt-5", new Date("2026-09-29T00:00:00.000Z"))).toBeNull();
  });

  it("keeps Sonnet 5 at the now-standard introductory tariff", () => {
    expect(lookupModelTokenPrice("claude-sonnet-5")).toMatchObject({
      inputUsdPerMTok: 2,
      outputUsdPerMTok: 10,
    });
    expect(inspectModelTokenPrice("claude-sonnet-5-standard").kind).toBe("missing");
  });

  it("returns null for unknown or local-only models", () => {
    expect(lookupModelTokenPrice("does-not-exist")).toBeNull();
    expect(estimateTokenCostUsd("does-not-exist", 10, 10)).toBeNull();
  });
});
