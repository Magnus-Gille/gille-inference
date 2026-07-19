/** Sum all numbers in the array. (REFERENCE SOLUTION — used only to self-verify the oracle.) */
export function sum(xs: number[]): number {
  return xs.reduce((acc, x) => acc + x, 0);
}
