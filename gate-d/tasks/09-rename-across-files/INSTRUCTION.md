Rename the exported symbol `widget` to `gadget` EVERYWHERE in `src/` — its definition in
`src/core.ts` and every usage/import/re-export in `src/a.ts`, `src/b.ts`, `src/index.ts`.
After the rename `test/rename.oracle.ts` must pass and the word `widget` must not remain in
`src/`. Do not modify any file under `test/`.
