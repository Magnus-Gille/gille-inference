import { formatText, type Row } from "./format.ts";

const DATA: Row[] = [
  { name: "alpha", value: 1 },
  { name: "beta", value: 2 },
];

/**
 * Run the CLI. `run(["report"])` returns a text report.
 * TODO: support a `--json` flag — `run(["report", "--json"])` should return JSON instead of text.
 * (Currently the flag is ignored and text is always returned.)
 */
export function run(argv: string[]): string {
  const _wantsJson = argv.includes("--json");
  return formatText(DATA);
}
