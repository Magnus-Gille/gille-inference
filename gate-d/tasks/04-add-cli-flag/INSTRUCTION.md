`test/cli.oracle.ts` fails. Add a `--json` flag to the CLI end-to-end: when `run`'s argv
contains `--json`, return JSON (add a `formatJson` function in `src/format.ts`) instead of the
text report. The existing text behaviour must be unchanged. Do not modify any file under `test/`.
