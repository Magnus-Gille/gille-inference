import { formatText, type Row } from "./format.ts";

const DATA: Row[] = [{ name: "alpha", value: 1 }, { name: "beta", value: 2 }];

export function run(_argv: string[]): string {
  return formatText(DATA);
}
