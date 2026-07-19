`test/util.oracle.ts` fails on `key`: `clean` in `src/util.ts` collapses internal whitespace but
does not trim the ends. Fix `clean` so `key` is correct — WITHOUT breaking `format` or `label`,
which already compensate and must stay green. Do not modify any file under `test/`.
