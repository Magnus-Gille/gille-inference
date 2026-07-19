import { formatText, formatJson, type Row } from "./format.ts";

const DATA: Row[] = [
  { name: "alpha", value: 1 },
  { name: "beta", value: 2 },
];

export function run(argv: string[]): string {
  return argv.includes("--json") ? formatJson(DATA) : formatText(DATA);
}
