/** Parse a TCP port: base-10 non-negative integer string; throw otherwise. (REFERENCE SOLUTION.) */
export function parsePort(s: string): number {
  if (!/^\d+$/.test(s)) throw new Error(`invalid port: ${JSON.stringify(s)}`);
  return Number(s);
}
