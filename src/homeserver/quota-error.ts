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

const SHARED_STATIC_ALIASES = new Set(["static:user", "static:admin", "static:monitor"]);

/** Build caller-safe HTTP/MCP details from the same failed quota decision. */
export function describeQuotaFailure(
  failed: FailedQuota,
  estTokens: number,
  principal: QuotaFailurePrincipal,
): QuotaFailureDescription {
  const { reason, snapshot, retryAfterSeconds } = failed;
  const limit = reason === "rpm"
    ? snapshot.rpmLimit
    : reason === "tpm"
      ? snapshot.tpmLimit
      : snapshot.dailyLimit;
  const requested = reason === "rpm" ? 1 : estTokens;
  const shared = principal.keyHash === null || SHARED_STATIC_ALIASES.has(principal.alias);
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
      ? Math.max(0, snapshot.tpmUsed - estTokens)
      : snapshot.dailyUsed;
  const quota: QuotaFailureDetail = shared
    ? { ...common, scope: "shared_static_tier" }
    : { ...common, scope: "key", used_before: usedBefore };

  const prefix = quota.scope === "key" ? "Per-key" : "Shared static-tier";
  const subject = quota.scope === "key" ? "your own API key" : "the shared static-tier bucket";
  const basis = reason === "rpm"
    ? `${limit} ${limit === 1 ? "request" : "requests"} per minute`
    : reason === "tpm"
      ? `${limit} ${limit === 1 ? "token" : "tokens"} per minute`
      : `${limit} ${limit === 1 ? "token" : "tokens"} per UTC day`;
  const estimate = reason === "rpm" ? "" : ` The request was estimated at ${requested} tokens.`;
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
