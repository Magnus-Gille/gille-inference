`test/nearest.oracle.ts` fails. Implement two things so it passes:
1. `distance(a, b)` in `src/geo.ts` — the Euclidean distance between two points.
2. `nearest(p, candidates)` in `src/index.ts` — return the candidate closest to `p`.
   `index.ts` must IMPORT and USE `distance` from `./geo.ts` (do not re-implement the
   distance math inside `index.ts`).
Do not modify any file under `test/`.
