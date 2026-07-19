export interface Point {
  x: number;
  y: number;
}

/** Euclidean distance between two points. (REFERENCE SOLUTION.) */
export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
