/**
 * Parse a TCP port: a base-10 non-negative integer string (e.g. "8080", "0080").
 * Must THROW for anything that is not pure decimal digits.
 *
 * BUG: `parseInt` auto-detects hex ("0x1F" → 31), tolerates trailing junk ("12.9" → 12),
 * and returns NaN (never throws) for non-numeric input ("nope" → NaN).
 */
export function parsePort(s: string): number {
  return parseInt(s);
}
