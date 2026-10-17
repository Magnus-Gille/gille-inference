/** Proof reconciliation for an explicitly accepted host boundary; never discovers or authorizes one. */
import { z } from "zod";
import { performance } from "node:perf_hooks";
import { installBackendInventorySchema, hashInstallBackendInventory, type InstallBackendInventory } from "./install-backend-inventory.js";

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().nonnegative().safe();
const timestamp = z.string().datetime();
export const installCoverageBindingSchema = z.object({
  schemaVersion: z.literal(1), inventorySha256: digest, boundaryIdentitySha256: digest,
  expiresAt: timestamp, maxObservationAgeMs: z.number().int().min(1).max(60_000),
}).strict();
export const installInventoryReceiptSchema = z.object({
  source: z.literal("host-inventory-v1"), state: z.enum(["observed", "unknown"]),
  observedAt: timestamp, hostBootIdSha256: digest, inventorySha256: digest,
  boundaryIdentitySha256: digest, scope: z.literal("all-host-inference"),
  backendIds: z.array(id).max(64), ingressIds: z.array(id).max(128),
  unclassifiedBackendCount: count.nullable(), unclassifiedIngressCount: count.nullable(),
}).strict();
export const installActivityReceiptSchema = z.object({
  id, source: z.enum(["backend-work-v1", "backend-stopped-v1", "ingress-work-v1", "ingress-fence-v1", "unavailable"]),
  state: z.enum(["observed", "unknown"]), observedAt: timestamp,
  hostBootIdSha256: digest, inventorySha256: digest,
  identityBeforeSha256: digest.nullable(), identityAfterSha256: digest.nullable(),
  active: count.nullable(), queued: count.nullable(), loading: count.nullable(),
  fenceExpiresAt: timestamp.optional(),
}).strict();
export const installCoverageEvidenceSchema = z.object({
  schemaVersion: z.literal(1), inventoryBefore: installInventoryReceiptSchema,
  backends: z.array(installActivityReceiptSchema).max(64),
  ingresses: z.array(installActivityReceiptSchema).max(128),
  inventoryAfter: installInventoryReceiptSchema,
}).strict();
type Binding = z.infer<typeof installCoverageBindingSchema>;
type InventoryReceipt = z.infer<typeof installInventoryReceiptSchema>;
export type InstallCoverageEvidence = z.infer<typeof installCoverageEvidenceSchema>;
type Code = "invalid-inventory" | "invalid-binding" | "invalid-evidence" | "invalid-clock" | "binding-expired"
  | "inventory-unbound" | "inventory-unknown" | "host-mismatch" | "boundary-mismatch" | "inventory-mismatch"
  | "unclassified-work" | "not-fresh" | "sample-order" | "backend-set-mismatch" | "ingress-set-mismatch"
  | "unsupported-source" | "activity-unknown" | "identity-changed" | "fence-expired" | "invalid-fence"
  | "backend-busy" | "ingress-busy" | "timeout" | "cancelled" | "observation-failed"
  | "input-read-failed" | "policy-rejection";
export interface InstallCoverageReport {
  source: "install-coverage-check-v1";
  coverage: "complete" | "unknown";
  activity: "idle" | "busy" | "unknown";
  observedAt: string | null;
  inventorySha256: string | null;
  reasons: Array<{ code: Code; component?: string }>;
}
const report = (code?: Code): InstallCoverageReport => ({
  source: "install-coverage-check-v1", coverage: "unknown", activity: "unknown",
  observedAt: null, inventorySha256: null, reasons: code ? [{ code }] : [],
});
const sameSet = (a: string[], b: string[]): boolean => new Set(a).size === a.length && a.length === b.length && a.every(value => b.includes(value));
const fresh = (value: string, binding: Binding, now: number): boolean => {
  const age = now - Date.parse(value);
  return age >= 0 && age <= binding.maxObservationAgeMs;
};
function inventoryReasons(receipt: InventoryReceipt, inventory: InstallBackendInventory, binding: Binding, now: number): Code[] {
  const reasons: Code[] = [];
  if (receipt.state !== "observed") reasons.push("inventory-unknown");
  if (!fresh(receipt.observedAt, binding, now)) reasons.push("not-fresh");
  if (receipt.hostBootIdSha256 !== inventory.hostBootIdSha256) reasons.push("host-mismatch");
  if (receipt.inventorySha256 !== binding.inventorySha256) reasons.push("inventory-mismatch");
  if (receipt.boundaryIdentitySha256 !== binding.boundaryIdentitySha256) reasons.push("boundary-mismatch");
  if (!sameSet(receipt.backendIds, inventory.backends.map(value => value.id)) ||
      !sameSet(receipt.ingressIds, inventory.ingresses.map(value => value.id))) reasons.push("inventory-mismatch");
  if (receipt.unclassifiedBackendCount !== 0 || receipt.unclassifiedIngressCount !== 0) reasons.push("unclassified-work");
  return reasons;
}

/** Trusted adapters must measure receipts independently. JSON validation cannot authenticate their claims. */
export function evaluateInstallCoverage(manifest: unknown, accepted: unknown, input: unknown, nowMs = Date.now()): InstallCoverageReport {
  const inv = installBackendInventorySchema.safeParse(manifest);
  if (!inv.success) return report("invalid-inventory");
  const bind = installCoverageBindingSchema.safeParse(accepted);
  if (!bind.success) return report("invalid-binding");
  const output = report();
  output.inventorySha256 = hashInstallBackendInventory(inv.data);
  const binding = bind.data;
  if (!Number.isFinite(nowMs)) return report("invalid-clock");
  if (Date.parse(binding.expiresAt) <= nowMs) output.reasons.push({ code: "binding-expired" });
  if (output.inventorySha256 !== binding.inventorySha256) output.reasons.push({ code: "inventory-unbound" });
  if (output.reasons.length) return output;
  const parsed = installCoverageEvidenceSchema.safeParse(input);
  if (!parsed.success) { output.reasons.push({ code: "invalid-evidence" }); return output; }
  const evidence = parsed.data;
  const beforeTime = Date.parse(evidence.inventoryBefore.observedAt);
  const afterTime = Date.parse(evidence.inventoryAfter.observedAt);
  output.observedAt = evidence.inventoryBefore.observedAt;
  for (const receipt of [evidence.inventoryBefore, evidence.inventoryAfter]) {
    for (const code of inventoryReasons(receipt, inv.data, binding, nowMs)) output.reasons.push({ code });
  }
  if (beforeTime > afterTime) output.reasons.push({ code: "sample-order" });
  let busy = false;
  for (const [kind, expected, receipts] of [
    ["backend", inv.data.backends.map(value => value.id), evidence.backends],
    ["ingress", inv.data.ingresses.map(value => value.id), evidence.ingresses],
  ] as const) {
    if (!sameSet(receipts.map(value => value.id), expected)) output.reasons.push({ code: kind === "backend" ? "backend-set-mismatch" : "ingress-set-mismatch" });
    for (const receipt of receipts) {
      // Never echo IDs not present in the validated, accepted topology.
      const component = expected.includes(receipt.id) ? receipt.id : undefined;
      const add = (code: Code): void => { output.reasons.push({ code, ...(component ? { component } : {}) }); };
      if (!fresh(receipt.observedAt, binding, nowMs)) add("not-fresh");
      const sampledAt = Date.parse(receipt.observedAt);
      if (sampledAt < beforeTime || sampledAt > afterTime) add("sample-order");
      if (receipt.hostBootIdSha256 !== inv.data.hostBootIdSha256) add("host-mismatch");
      if (receipt.inventorySha256 !== binding.inventorySha256) add("inventory-mismatch");
      const allowed = kind === "backend" ? ["backend-work-v1", "backend-stopped-v1"] : ["ingress-work-v1", "ingress-fence-v1"];
      if (!allowed.includes(receipt.source)) add("unsupported-source");
      if (receipt.state !== "observed" || [receipt.active, receipt.queued, receipt.loading].some(value => value === null)) add("activity-unknown");
      if (!receipt.identityBeforeSha256 || receipt.identityBeforeSha256 !== receipt.identityAfterSha256) add("identity-changed");
      if (receipt.source === "ingress-fence-v1") {
        // A fence must both prevent entry and have drained work; a Boolean "enabled" is insufficient.
        if (!receipt.fenceExpiresAt || Date.parse(receipt.fenceExpiresAt) <= nowMs) add("fence-expired");
        if (receipt.active !== 0 || receipt.queued !== 0 || receipt.loading !== 0) add("invalid-fence");
      } else if (receipt.fenceExpiresAt !== undefined) add("invalid-fence");
      if (receipt.source === "backend-stopped-v1" && (receipt.active !== 0 || receipt.queued !== 0 || receipt.loading !== 0)) add("activity-unknown");
      if ([receipt.active, receipt.queued, receipt.loading].some(value => value !== null && value > 0)) {
        busy = true; add(kind === "backend" ? "backend-busy" : "ingress-busy");
      }
    }
  }
  if (output.reasons.every(value => value.code === "backend-busy" || value.code === "ingress-busy")) {
    output.coverage = "complete";
    output.activity = busy ? "busy" : "idle";
  }
  return output;
}

export interface InstallCoverageCollectors {
  /** Full approved boundary scan, independently measured; never echo the expected manifest/hash. */
  inventory(signal: AbortSignal): Promise<unknown>;
  backend(target: InstallBackendInventory["backends"][number], signal: AbortSignal): Promise<unknown>;
  ingress(target: InstallBackendInventory["ingresses"][number], signal: AbortSignal): Promise<unknown>;
}

/** Read-only orchestration seam. No default host adapter exists; partial metrics cannot supply these receipts. */
export async function observeInstallCoverage(
  manifest: unknown, accepted: unknown, collectors: InstallCoverageCollectors,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<InstallCoverageReport> {
  const inv = installBackendInventorySchema.safeParse(manifest);
  if (!inv.success) return report("invalid-inventory");
  const bind = installCoverageBindingSchema.safeParse(accepted);
  if (!bind.success) return report("invalid-binding");
  if (hashInstallBackendInventory(inv.data) !== bind.data.inventorySha256) return report("inventory-unbound");
  if (Date.parse(bind.data.expiresAt) <= Date.now()) return report("binding-expired");
  const timeoutMs = opts.timeoutMs ?? 5000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new Error("invalid observation timeout");
  const abort = new AbortController();
  const bindingRemainingMs = Date.parse(bind.data.expiresAt) - Date.now();
  const effectiveMs = Math.max(0, Math.min(timeoutMs, bindingRemainingMs));
  const deadlineAt = performance.now() + effectiveMs;
  const deadlineReason: Code = bindingRemainingMs <= timeoutMs ? "binding-expired" : "timeout";
  let reason: Code = "timeout";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolveStopped!: (value: InstallCoverageReport) => void;
  const stopped = new Promise<InstallCoverageReport>(resolve => { resolveStopped = resolve; });
  const stop = (code: Code): void => {
    if (abort.signal.aborted) return;
    reason = code; abort.abort(); resolveStopped(report(code));
  };
  const cancelled = (): void => stop("cancelled");
  const check = (): void => {
    if (Date.parse(bind.data.expiresAt) <= Date.now()) stop("binding-expired");
    if (performance.now() >= deadlineAt) stop(deadlineReason);
    if (abort.signal.aborted) throw new Error("observation stopped");
  };
  const read = async (op: () => Promise<unknown>): Promise<unknown> => {
    check(); const value = await op(); check();
    // Preserve each receipt even when an adapter reuses a mutable object on its next call.
    const copy = structuredClone(value); check(); return copy;
  };
  opts.signal?.addEventListener("abort", cancelled, { once: true });
  if (opts.signal?.aborted) cancelled();
  timer = setTimeout(() => stop(deadlineReason), effectiveMs);
  const run = async (): Promise<InstallCoverageReport> => {
    try {
      const before = await read(() => collectors.inventory(abort.signal));
      const checked = installInventoryReceiptSchema.safeParse(before);
      if (!checked.success) return report("invalid-evidence");
      const reasons = inventoryReasons(checked.data, inv.data, bind.data, Date.now());
      if (reasons.length) return { ...report(), reasons: reasons.map(code => ({ code })) };
      const backends: unknown[] = [], ingresses: unknown[] = [];
      for (const target of inv.data.backends) backends.push(await read(() => collectors.backend(structuredClone(target), abort.signal)));
      for (const target of inv.data.ingresses) ingresses.push(await read(() => collectors.ingress(structuredClone(target), abort.signal)));
      const after = await read(() => collectors.inventory(abort.signal));
      check();
      return evaluateInstallCoverage(inv.data, bind.data, { schemaVersion: 1, inventoryBefore: before, backends, ingresses, inventoryAfter: after });
    } catch { return report(abort.signal.aborted ? reason : "observation-failed"); }
  };
  try { return await Promise.race([run(), stopped]); }
  finally {
    clearTimeout(timer); opts.signal?.removeEventListener("abort", cancelled); abort.abort();
  }
}
