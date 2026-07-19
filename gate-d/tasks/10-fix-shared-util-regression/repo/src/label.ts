import { clean } from "./util.ts";
/** Compensates for the missing trim with a local `.trim()` — must keep working. */
export function label(s: string): string {
  return clean(s).trim().toUpperCase();
}
