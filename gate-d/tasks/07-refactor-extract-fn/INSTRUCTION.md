`src/report.ts` computes the subtotal with the same `reduce` duplicated in `summary` and
`detailed`. Refactor: extract a single `subtotal(lines)` helper and call it from both functions,
so the subtotal `reduce` appears only once. Behaviour must not change — `test/report.oracle.ts`
must stay green. Do not modify any file under `test/`.
