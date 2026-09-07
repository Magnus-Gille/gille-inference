/**
 * Small, content-blind schema for exact execution feedback.
 *
 * This module intentionally contains no persistence, identity, timestamp, or free-text fields.
 * Callers can only report one of the closed usefulness values for an already-bound execution.
 */

export const EXECUTION_TRAFFIC_PURPOSES = ["organic", "evaluation", "synthetic"] as const;
export type ExecutionTrafficPurpose = (typeof EXECUTION_TRAFFIC_PURPOSES)[number] | "unknown";

export function parseExecutionTrafficPurpose(value: unknown):
  | { ok: true; value: ExecutionTrafficPurpose }
  | { ok: false } {
  if (value === undefined) return { ok: true, value: "unknown" };
  if (
    typeof value === "string" &&
    (EXECUTION_TRAFFIC_PURPOSES as readonly string[]).includes(value)
  ) {
    return { ok: true, value: value as ExecutionTrafficPurpose };
  }
  return { ok: false };
}

export const EXECUTION_FEEDBACK_VALUES = ["pass", "partial", "redo", "wrong"] as const;
export type ExecutionFeedbackValue = (typeof EXECUTION_FEEDBACK_VALUES)[number];

export const EXECUTION_FEEDBACK_EPOCH = "organic-exact-feedback-v1" as const;

export function parseExecutionFeedback(value: unknown):
  | { ok: true; value: ExecutionFeedbackValue }
  | { ok: false; error: "invalid_shape" | "unknown_field" | "invalid_usefulness" } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "invalid_shape" };
  }

  const record = value as Record<string, unknown>;
  // Reflect over all own keys, including non-enumerable and symbol keys. The schema is exactly
  // one own string field; no caller-supplied key or value is ever copied into the error result.
  if (Reflect.ownKeys(record).some((key) => key !== "usefulness")) {
    return { ok: false, error: "unknown_field" };
  }
  if (!Object.hasOwn(record, "usefulness")) {
    return { ok: false, error: "invalid_usefulness" };
  }

  const usefulness = record["usefulness"];
  if (
    typeof usefulness !== "string" ||
    !(EXECUTION_FEEDBACK_VALUES as readonly string[]).includes(usefulness)
  ) {
    return { ok: false, error: "invalid_usefulness" };
  }
  return { ok: true, value: usefulness as ExecutionFeedbackValue };
}
