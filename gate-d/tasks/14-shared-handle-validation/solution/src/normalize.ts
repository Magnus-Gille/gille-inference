import { assertValidHandle } from "./validate.ts";

export function normalizeHandle(value: string): string {
  const normalized = value.trim().toLowerCase();
  assertValidHandle(normalized);
  return normalized;
}
