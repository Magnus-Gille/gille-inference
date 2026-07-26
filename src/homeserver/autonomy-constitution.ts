/**
 * ADR-008 admission seam. This is deliberately a fail-closed *precondition* for
 * the older autonomy controller: it never widens coverage and shadow remains
 * useful for proposals but cannot write a route.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const GRIMNIR_CONSTITUTION_DIGEST = "sha256:76b0f28adca0046fad9f1d3d4b3a57046f9a1d11ee2ed232bbc495d2ab663bd0";

type UnknownRecord = Record<string, unknown>;
function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function digestWithout(value: UnknownRecord, field: string): string {
  const copy = { ...value };
  delete copy[field];
  return `sha256:${createHash("sha256").update(canonical(copy)).digest("hex")}`;
}

export interface ConstitutionalAdmission {
  allowed: boolean;
  reason: string;
}

/** Validates the pinned W0 artifact and one owner-controlled registry snapshot. */
export function microRoutingAdmission(constitutionPath: string, coveragePath: string): ConstitutionalAdmission {
  let constitution: UnknownRecord;
  let coverage: UnknownRecord;
  try {
    constitution = JSON.parse(readFileSync(constitutionPath, "utf8")) as UnknownRecord;
    coverage = JSON.parse(readFileSync(coveragePath, "utf8")) as UnknownRecord;
  } catch (error) {
    return { allowed: false, reason: `constitution-unavailable:${error instanceof Error ? error.message : String(error)}` };
  }
  if (constitution.kind !== "autonomy-constitution" || constitution.schema_version !== "v1" || constitution.constitution_digest !== GRIMNIR_CONSTITUTION_DIGEST || digestWithout(constitution, "constitution_digest") !== GRIMNIR_CONSTITUTION_DIGEST) {
    return { allowed: false, reason: "constitution-tampered-or-unapproved" };
  }
  if (coverage.kind !== "autonomy-coverage-registry" || coverage.schema_version !== "v1" || coverage.constitution_digest !== GRIMNIR_CONSTITUTION_DIGEST || typeof coverage.registry_digest !== "string" || digestWithout(coverage, "registry_digest") !== coverage.registry_digest) {
    return { allowed: false, reason: "coverage-tampered-or-unapproved" };
  }
  if (coverage.global_state !== "armed") return { allowed: false, reason: "coverage-disarmed" };
  const domain = Array.isArray(coverage.domains) ? coverage.domains.find((entry) => isRecord(entry) && entry.domain === "micro-routing") : undefined;
  if (!isRecord(domain) || domain.owner !== "gille-inference" || domain.recovery_class !== "R-exact" || domain.coverage !== "armed-canary") return { allowed: false, reason: "micro-routing-not-armed-canary" };
  return { allowed: true, reason: "admitted" };
}
