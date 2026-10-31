/** Lifetime credit balance projection safe to return to the owning caller. */
export type CreditBalanceStatus = "unlimited" | "ok" | "low" | "exhausted";

export interface CreditBalanceInput {
  /** Positive lifetime cap; zero means unlimited. */
  creditLimit: number;
  /** Usage including any in-flight reservation. */
  creditsUsed: number;
}

export interface CreditBalanceDescription {
  remaining: number | null;
  status: CreditBalanceStatus;
  percentUsed: number | null;
  resets: false;
  includesReservations: true;
}

/**
 * Describe a lifetime credit balance without reading or mutating account state.
 *
 * Credit limits are non-resetting. A zero (or otherwise non-positive legacy value) is the
 * existing unlimited sentinel; finite percentages are bounded for safe presentation when a
 * caller observes usage at or beyond its cap.
 */
export function describeCreditBalance({
  creditLimit,
  creditsUsed,
}: CreditBalanceInput): CreditBalanceDescription {
  if (creditLimit <= 0) {
    return {
      remaining: null,
      status: "unlimited",
      percentUsed: null,
      resets: false,
      includesReservations: true,
    };
  }

  const remaining = Math.max(0, creditLimit - creditsUsed);
  const percentUsed = Math.min(100, Math.max(0, (creditsUsed / creditLimit) * 100));
  const status: Exclude<CreditBalanceStatus, "unlimited"> =
    creditsUsed >= creditLimit ? "exhausted" : percentUsed >= 80 ? "low" : "ok";

  return {
    remaining,
    status,
    percentUsed,
    resets: false,
    includesReservations: true,
  };
}
