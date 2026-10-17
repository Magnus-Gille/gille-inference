import type { QuotaDecision } from "./quota.js";

interface QuotaFailureCommon {
  reason: "rpm" | "tpm" | "daily";
  window: "60s" | "utc_day";
  limit: number;
  requested: number;
  counted: false;
  retry_after_seconds: number;
}

export type QuotaFailureDetail = QuotaFailureCommon & (
  | { scope: "key"; used_before: number }
  | { scope: "shared_static_tier"; used_before?: never }
);

export interface QuotaFailurePrincipal {
  alias: string;
  keyHash: string | null;
}

export interface QuotaFailureDescription {
  quota: QuotaFailureDetail;
  message: string;
  rateLimit: { limit: number; remaining?: number; resetSeconds: number };
}

type FailedQuota = Extract<QuotaDecision, { ok: false }>;
export type QuotaMeterUnit = "tokens" | "audio_seconds" | "image_units";

const SHARED_STATIC_ALIASES = new Set(["static:user", "static:admin", "static:monitor"]);

/** The existing quota bucket identity; never includes another caller's usage. */
export function quotaScopeForPrincipal(principal: QuotaFailurePrincipal): "key" | "shared_static_tier" {
  return principal.keyHash === null || SHARED_STATIC_ALIASES.has(principal.alias) ? "shared_static_tier" : "key";
}

/** Build caller-safe HTTP/MCP details from the same failed quota decision. */
export function describeQuotaFailure(
  failed: FailedQuota,
  meteredAmount: number,
  principal: QuotaFailurePrincipal,
  unit: QuotaMeterUnit = "tokens",
): QuotaFailureDescription {
  const { reason, snapshot, retryAfterSeconds } = failed;
  const limit = reason === "rpm"
    ? snapshot.rpmLimit
    : reason === "tpm"
      ? snapshot.tpmLimit
      : snapshot.dailyLimit;
  const requested = reason === "rpm" ? 1 : meteredAmount;
  const shared = quotaScopeForPrincipal(principal) === "shared_static_tier";
  const common: QuotaFailureCommon = {
    reason,
    window: reason === "daily" ? "utc_day" : "60s",
    limit,
    requested,
    counted: false,
    retry_after_seconds: retryAfterSeconds,
  };
  const usedBefore = reason === "rpm"
    ? Math.max(0, snapshot.rpmUsed - 1)
    : reason === "tpm"
      ? Math.max(0, snapshot.tpmUsed - meteredAmount)
      : snapshot.dailyUsed;
  const quota: QuotaFailureDetail = shared
    ? { ...common, scope: "shared_static_tier" }
    : { ...common, scope: "key", used_before: usedBefore };

  const prefix = quota.scope === "key" ? "Per-key" : "Shared static-tier";
  const subject = quota.scope === "key" ? "your own API key" : "the shared static-tier bucket";
  const unitLabel = unit === "audio_seconds"
    ? { singular: "audio second", plural: "audio seconds" }
    : unit === "image_units"
      ? { singular: "image unit", plural: "image units" }
      : { singular: "token", plural: "tokens" };
  const basis = reason === "rpm"
    ? `${limit} ${limit === 1 ? "request" : "requests"} per minute`
    : reason === "tpm"
      ? `${limit} ${limit === 1 ? unitLabel.singular : unitLabel.plural} per minute`
      : `${limit} ${limit === 1 ? unitLabel.singular : unitLabel.plural} per UTC day`;
  const estimate = reason === "rpm" ? "" : unit === "audio_seconds"
    ? ` The worst-case request was estimated at ${requested} audio seconds.`
    : unit === "image_units"
      ? ` The request includes ${requested} ${requested === 1 ? unitLabel.singular : unitLabel.plural}.`
      : ` The request was estimated at ${requested} tokens.`;
  const retryUnit = retryAfterSeconds === 1 ? "second" : "seconds";
  const retryGuidance = reason === "rpm" && limit === 0
    ? "The configured request allowance is zero; contact the gateway operator. A retry delay will not restore request capacity."
    : reason === "daily"
      ? `The UTC-day budget resets in ${retryAfterSeconds} ${retryUnit}; retry after ${retryAfterSeconds} ${retryUnit}.`
      : `The next quota-window expiry is in ${retryAfterSeconds} ${retryUnit}; retry after ${retryAfterSeconds} ${retryUnit}.`;
  const message = `${prefix} ${reason} limit reached. This applies to ${subject}, which permits ${basis}.${estimate} This rejected request was not counted. ${retryGuidance}`;

  return {
    quota,
    message,
    rateLimit: {
      limit,
      ...(quota.scope === "key" ? { remaining: Math.max(0, limit - usedBefore) } : {}),
      resetSeconds: retryAfterSeconds,
    },
  };
}
