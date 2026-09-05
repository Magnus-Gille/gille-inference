/** Owner-authored behavioral oracles, not model-authored assertions or keyword scans. */
export interface CodeLoopSchemaCheck {
  name: string;
  command: string;
}

export interface CodeLoopSchemaGrounding {
  schema_version: 1;
  state: "not-requested" | "passed" | "failed" | "skipped";
  checks: Array<{
    name: string;
    ran: boolean;
    exit_code: number | null;
    output_tail: string;
  }>;
}

const NAME = /^[a-z0-9][a-z0-9._:-]{0,79}$/;

export function validateSchemaChecks(value: unknown): string | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) {
    return "`schema_checks` must contain 1–8 owner-authored named behavioral checks.";
  }
  const names = new Set<string>();
  let bytes = 0;
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item) ||
        Object.keys(item).length !== 2 || !Object.hasOwn(item, "name") || !Object.hasOwn(item, "command")) {
      return "Each schema check must contain exactly name and command.";
    }
    if (typeof item.name !== "string" || !NAME.test(item.name) || names.has(item.name)) {
      return "Schema check names must be unique lowercase identifiers (1–80 characters).";
    }
    names.add(item.name);
    if (typeof item.command !== "string" || !item.command.trim() || item.command.includes("\0")) {
      return "Each schema check command must be nonblank and contain no NUL bytes.";
    }
    const size = Buffer.byteLength(item.command, "utf8");
    bytes += size;
    if (size > 8192 || bytes > 32768) return "Schema check commands exceed the 8192-byte per-check or 32768-byte total limit.";
  }
  return null;
}

export function skippedSchemaGrounding(checks: readonly CodeLoopSchemaCheck[]): CodeLoopSchemaGrounding {
  return {
    schema_version: 1,
    state: checks.length ? "skipped" : "not-requested",
    checks: checks.map(({ name }) => ({ name, ran: false, exit_code: null, output_tail: "" })),
  };
}

/** Validate durable evidence before returning it. A withheld artifact cannot reappear on recovery. */
export function isSchemaGroundingResult(value: unknown, diff: string, summary: string): value is CodeLoopSchemaGrounding {
  if (!value || typeof value !== "object") return false;
  const g = value as CodeLoopSchemaGrounding;
  if (g.schema_version !== 1 || !Array.isArray(g.checks) || g.checks.length > 8) return false;
  if (g.state === "not-requested") return g.checks.length === 0;
  if (!["passed", "failed", "skipped"].includes(g.state) || !g.checks.length) return false;
  const names = new Set<string>();
  for (const c of g.checks) {
    if (!c || typeof c.name !== "string" || !NAME.test(c.name) || names.has(c.name) ||
        typeof c.ran !== "boolean" || typeof c.output_tail !== "string" || c.output_tail.length > 4096 ||
        !(c.exit_code === null || (Number.isInteger(c.exit_code) && c.exit_code >= 0 && c.exit_code <= 255)) ||
        (!c.ran && c.exit_code !== null)) return false;
    names.add(c.name);
  }
  const allPassed = g.checks.every(c => c.ran && c.exit_code === 0);
  if (g.state === "passed") return allPassed;
  return !allPassed && diff === "" && summary === "" &&
    (g.state !== "skipped" || g.checks.every(c => !c.ran));
}
