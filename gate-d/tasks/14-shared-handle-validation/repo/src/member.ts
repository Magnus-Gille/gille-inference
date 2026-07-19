import { normalizeHandle } from "./normalize.ts";

export function memberTag(raw: string): string {
  return `@${normalizeHandle(raw)}`;
}
