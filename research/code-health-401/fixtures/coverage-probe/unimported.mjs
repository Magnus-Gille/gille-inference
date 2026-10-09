export function eligibleButUnimported(value) {
  if (value === "known") return "covered-only-if-loaded";
  return "eligible-source-uncovered";
}
