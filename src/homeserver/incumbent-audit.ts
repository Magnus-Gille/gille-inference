/**
 * Advisory-only deterministic audit of a model that is serving now (#11).
 *
 * This deliberately neither loads/unloads models nor touches routing.  The caller must already
 * hold the shared GPU lease; an audit records the observed command before probing so a result can
 * never be inherited by a changed artifact/configuration.
 */
import { evidenceIdentityFromServedModelCmd, type EvidenceIdentityBundle } from "./evidence-identity.js";
import { runProbes, type ChatFn } from "./probe-runner.js";
import type { Probe } from "./probes.js";
import type { ProbeRunSummary } from "./scout-types.js";

export interface IncumbentAuditRecord {
  schemaVersion: 1;
  source: "live-served-model";
  auditedAt: string;
  model: string;
  trigger: string;
  probeBatteryVersion: string;
  corpusFingerprint: string;
  /** Command observed before probes; this is always the exact artifact/configuration tested. */
  servedCommand: string | null;
  /** A second observation after probes, retained when it differs or post-observation fails. */
  postAuditServedCommand?: string | null;
  evidenceIdentity: Pick<EvidenceIdentityBundle, "modelArtifact" | "configEpoch">;
  status: "completed" | "unavailable";
  unavailableReason?: string;
  summary?: ProbeRunSummary;
}

export interface AuditIncumbentOptions {
  model: string;
  endpoint: string;
  trigger: string;
  probes: Probe[];
  probeBatteryVersion: string;
  corpusFingerprint: string;
  getRunningCmd: (model: string) => Promise<string | null>;
  repeats?: number;
  apiKey?: string;
  timeoutMs?: number;
  chat?: ChatFn;
  now?: () => Date;
}

/** Run one audit.  Missing /running evidence is a durable unavailable result, never a guess. */
export async function auditIncumbent(opts: AuditIncumbentOptions): Promise<IncumbentAuditRecord> {
  const auditedAt = (opts.now ?? (() => new Date()))().toISOString();
  let servedCommand: string | null;
  try {
    servedCommand = await opts.getRunningCmd(opts.model);
  } catch (err) {
    return unavailable(opts, auditedAt, null, `served-model observation failed: ${String(err)}`);
  }
  if (!servedCommand) return unavailable(opts, auditedAt, null, "model was not ready in /running");

  const evidenceIdentity = evidenceIdentityFromServedModelCmd(servedCommand);
  const summary = await runProbes({
    model: opts.model, endpoint: opts.endpoint, probes: opts.probes, repeats: opts.repeats,
    apiKey: opts.apiKey, timeoutMs: opts.timeoutMs, chat: opts.chat,
  });
  // The pre-probe observation identifies the thing tested only if it still names the same
  // artifact/configuration after the serial battery. Never emit completed evidence across a swap.
  let finalCommand: string | null;
  try {
    finalCommand = await opts.getRunningCmd(opts.model);
  } catch (err) {
    return unavailable(opts, auditedAt, servedCommand, `served-model post-audit observation failed: ${String(err)}`, { summary });
  }
  if (finalCommand !== servedCommand) {
    return unavailable(opts, auditedAt, servedCommand, "served artifact/configuration changed during audit", { postAuditServedCommand: finalCommand, summary });
  }
  return {
    schemaVersion: 1, source: "live-served-model", auditedAt, model: opts.model, trigger: opts.trigger,
    probeBatteryVersion: opts.probeBatteryVersion, corpusFingerprint: opts.corpusFingerprint,
    servedCommand, evidenceIdentity, status: "completed", summary,
  };
}

function unavailable(
  opts: AuditIncumbentOptions, auditedAt: string, servedCommand: string | null, unavailableReason: string,
  diagnostic: Pick<IncumbentAuditRecord, "postAuditServedCommand" | "summary"> = {}
): IncumbentAuditRecord {
  return {
    schemaVersion: 1, source: "live-served-model", auditedAt, model: opts.model, trigger: opts.trigger,
    probeBatteryVersion: opts.probeBatteryVersion, corpusFingerprint: opts.corpusFingerprint,
    servedCommand, evidenceIdentity: evidenceIdentityFromServedModelCmd(servedCommand),
    status: "unavailable", unavailableReason, ...diagnostic,
  };
}
