import { normalizeHandle } from "./normalize.ts";

export function lookupKey(raw: string): string {
  return `member:${normalizeHandle(raw)}`;
}
