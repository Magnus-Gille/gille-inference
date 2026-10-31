import { describe, expect, it } from "vitest";
import { describeCreditBalance } from "../src/homeserver/account-balance.js";

describe("describeCreditBalance", () => {
  it("describes unlimited balances without exposing a numeric remainder", () => {
    expect(describeCreditBalance({ creditLimit: 0, creditsUsed: 999_999 })).toEqual({
      remaining: null,
      status: "unlimited",
      percentUsed: null,
      resets: false,
      includesReservations: true,
    });
  });

  it("reports capped balances, low at 80%, and exhaustion at the cap", () => {
    expect(describeCreditBalance({ creditLimit: 1000, creditsUsed: 100 })).toEqual({
      remaining: 900,
      status: "ok",
      percentUsed: 10,
      resets: false,
      includesReservations: true,
    });
    expect(describeCreditBalance({ creditLimit: 1000, creditsUsed: 800 })).toMatchObject({
      remaining: 200,
      status: "low",
      percentUsed: 80,
    });
    expect(describeCreditBalance({ creditLimit: 1000, creditsUsed: 1500 })).toMatchObject({
      remaining: 0,
      status: "exhausted",
      percentUsed: 100,
    });
  });

  it("clamps capped percentage and remaining values without mutating input", () => {
    const input = { creditLimit: 1000, creditsUsed: -20 };
    expect(describeCreditBalance(input)).toMatchObject({ remaining: 1020, percentUsed: 0, status: "ok" });
    expect(input).toEqual({ creditLimit: 1000, creditsUsed: -20 });
  });
});
