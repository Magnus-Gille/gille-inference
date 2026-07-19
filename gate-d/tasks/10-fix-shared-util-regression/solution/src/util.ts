/** Normalise whitespace AND trim ends. (REFERENCE SOLUTION — the one-line shared fix.) */
export function clean(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}
