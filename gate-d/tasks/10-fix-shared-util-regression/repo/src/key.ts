import { clean } from "./util.ts";
/** Canonical key — relies on `clean` to fully normalise (no local compensation). */
export function key(s: string): string {
  return clean(s);
}
