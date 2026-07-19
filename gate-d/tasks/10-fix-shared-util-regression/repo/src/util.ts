/**
 * Normalise whitespace: collapse internal runs of whitespace to a single space.
 * BUG: it does NOT trim leading/trailing whitespace. Some callers compensate with `.trim()`;
 * the `key` caller does not, and is therefore broken for padded input.
 */
export function clean(s: string): string {
  return s.replace(/\s+/g, " ");
}
