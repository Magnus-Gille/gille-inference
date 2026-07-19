import { distance, type Point } from "./geo.ts";

/** Return the candidate closest to `p` by Euclidean distance. (REFERENCE SOLUTION.) */
export function nearest(p: Point, candidates: Point[]): Point {
  let best = candidates[0]!;
  let bestD = distance(p, best);
  for (const c of candidates.slice(1)) {
    const d = distance(p, c);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}
