/** Append-only incumbent-audit evidence reader and current-identity eligibility gate (#11). */
import { existsSync, readFileSync } from "node:fs";
import { evidenceIdentityFromServedModelCmd, type EvidenceIdentityBundle } from "./evidence-identity.js";
import type { IncumbentAuditRecord } from "./incumbent-audit.js";

export function readIncumbentAudits(path: string): IncumbentAuditRecord[] {
  if (!existsSync(path)) return [];
  const records: IncumbentAuditRecord[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    try {
      const r = JSON.parse(line) as IncumbentAuditRecord;
      if (r?.schemaVersion === 1 && r.source === "live-served-model" && typeof r.model === "string" && typeof r.auditedAt === "string") records.push(r);
    } catch { /* malformed append-only line is not evidence */ }
  }
  return records;
}

export interface IncumbentEligibility { eligibleModelIds: string[]; reasons: Record<string, string>; }

/** Parse a policy duration once; invalid policy must never widen routing eligibility. */
export function parseIncumbentAuditMaxAgeMs(raw: string | undefined, fallbackMs = 7 * 24 * 60 * 60 * 1000): number {
  const value = raw === undefined ? fallbackMs : Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error("INCUMBENT_AUDIT_MAX_AGE_MS must be a finite positive number of milliseconds");
  return value;
}

/** A model needs a recent completed audit whose observed command exactly matches now. */
export function eligibleIncumbents(
  servedCommands: ReadonlyMap<string, string | null>, records: readonly IncumbentAuditRecord[], nowMs: number, maxAgeMs: number
): IncumbentEligibility {
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) throw new Error("incumbent audit maximum age must be finite and positive");
  const eligibleModelIds: string[] = [];
  const reasons: Record<string, string> = Object.create(null);
  for (const [model, cmd] of servedCommands) {
    const latest = records.filter(r => r.model === model).sort((a, b) => b.auditedAt.localeCompare(a.auditedAt))[0];
    if (!cmd) { reasons[model] = "unavailable: no ready /running observation"; continue; }
    if (!latest) { reasons[model] = "stale: no incumbent audit record"; continue; }
    const age = nowMs - Date.parse(latest.auditedAt);
    if (latest.status !== "completed" || !Number.isFinite(age) || age < 0 || age > maxAgeMs) { reasons[model] = `stale: ${latest.status === "completed" ? "audit age exceeds policy" : latest.unavailableReason ?? "audit unavailable"}`; continue; }
    const current = evidenceIdentityFromServedModelCmd(cmd);
    if (JSON.stringify(current) !== JSON.stringify(latest.evidenceIdentity)) { reasons[model] = "stale: served artifact/configuration changed since audit"; continue; }
    eligibleModelIds.push(model);
  }
  return { eligibleModelIds, reasons };
}
