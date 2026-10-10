/** Operator-only CPU installation guard. Observations are evidence, never authorization. */
import { z } from "zod";

const count = z.number().int().nonnegative().safe();
const positive = z.number().int().positive().safe();
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const limits = {
  memoryMaxBytes: positive,
  cpuQuotaPercent: z.number().finite().positive(),
  tasksMax: positive,
};
export const controlledInstallPlanSchema = z.object({
  schemaVersion: z.literal(1),
  releaseSha: sha,
  inputsSha256: digest,
  expiresAt: z.string().datetime(),
  residency: z.enum(["preserve", "allow-idle-changes"]),
  resources: z.object({ ...limits, reserveBytes: count, minCpuIdlePercent: z.number().min(0).max(100) }).strict(),
  timing: z.object({
    pollMs: positive, observationTimeoutMs: positive, maxObservationAgeMs: positive,
    maxRunMs: positive, stopTimeoutMs: positive, cleanupTimeoutMs: positive,
  }).strict(),
}).strict().superRefine((plan, ctx) => {
  // Node clamps overflowing timers to 1 ms; never silently reinterpret an approved bound.
  if (Object.values(plan.timing).some(ms => ms > 2_147_483_647)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "timer exceeds supported bound" });
  }
  if (!Number.isSafeInteger(plan.resources.memoryMaxBytes + plan.resources.reserveBytes)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "memory budget exceeds supported bound" });
  }
});
export type ControlledInstallPlan = z.infer<typeof controlledInstallPlanSchema>;

export const controlledInstallObservationSchema = z.object({
  observedAt: z.string().datetime(), source: z.literal("host-probe-v1"),
  releaseSha: sha, inputsSha256: digest,
  residentModels: z.array(z.string().regex(/^[a-zA-Z0-9._/-]{1,128}$/)).max(256),
  gateway: z.object({ active: count.nullable(), queued: count.nullable(), leaseHeld: z.boolean().nullable() }).strict(),
  backend: z.object({ coverage: z.enum(["complete", "unknown"]), active: count.nullable(), queued: count.nullable() }).strict(),
  resources: z.object({
    ...limits, availableMemoryBytes: count.nullable(), cpuIdlePercent: z.number().min(0).max(100).nullable(),
    limitsVerified: z.boolean(),
  }).strict(),
  oomKills: count.nullable(),
  protectedServices: z.array(z.object({
    unit: z.string().regex(/^[a-zA-Z0-9_.@-]+\.service$/), active: z.boolean(),
    invocationId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/), restarts: count,
  }).strict()).min(1).max(128),
  maintenanceActive: z.boolean().nullable(),
}).strict().superRefine((observation, ctx) => {
  for (const values of [observation.residentModels, observation.protectedServices.map(s => s.unit)]) {
    if (new Set(values).size !== values.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "duplicate inventory item" });
    }
  }
});
export type ControlledInstallObservation = z.infer<typeof controlledInstallObservationSchema>;
export interface InstallDecision {
  admit: boolean;
  reasons: string[];
  observedAt: string | null;
  source: "host-probe-v1" | null;
}
const sameSet = (a: string[], b: string[]): boolean => {
  const right = new Set(b);
  return a.length === b.length && a.every(value => right.has(value));
};

/** Pure decision; safe diagnostics deliberately omit arbitrary input strings and error messages. */
export function evaluateControlledInstall(
  input: unknown, evidence: unknown, prior?: unknown, nowMs = Date.now(),
): InstallDecision {
  const p = controlledInstallPlanSchema.safeParse(input);
  const o = controlledInstallObservationSchema.safeParse(evidence);
  const b = prior === undefined ? undefined : controlledInstallObservationSchema.safeParse(prior);
  const reasons: string[] = [];
  if (!p.success) reasons.push("invalid-plan");
  if (!o.success) reasons.push("invalid-observation");
  if (b && !b.success) reasons.push("invalid-baseline");
  const decision = (): InstallDecision => ({
    admit: reasons.length === 0, reasons,
    observedAt: o.success ? o.data.observedAt : null, source: o.success ? o.data.source : null,
  });
  if (!p.success || !o.success || (b && !b.success)) return decision();
  const plan = p.data, obs = o.data;
  if (!Number.isFinite(nowMs)) reasons.push("invalid-clock");
  const remaining = Date.parse(plan.expiresAt) - nowMs;
  if (remaining <= 0) reasons.push("approval-expired");
  const age = nowMs - Date.parse(obs.observedAt);
  if (age < 0 || age > plan.timing.maxObservationAgeMs) reasons.push("observation-not-fresh");
  if (obs.releaseSha !== plan.releaseSha || obs.inputsSha256 !== plan.inputsSha256) reasons.push("identity-mismatch");
  if (obs.gateway.active === null || obs.gateway.queued === null || obs.gateway.leaseHeld === null) reasons.push("gateway-activity-unknown");
  else if (obs.gateway.active > 0 || obs.gateway.queued > 0 || obs.gateway.leaseHeld) reasons.push("gateway-busy");
  if (obs.backend.coverage !== "complete" || obs.backend.active === null || obs.backend.queued === null) reasons.push("backend-activity-unknown");
  else if (obs.backend.active > 0 || obs.backend.queued > 0) reasons.push("backend-busy");
  if (obs.maintenanceActive !== false) reasons.push("maintenance-not-idle");
  if (!obs.resources.limitsVerified || (Object.keys(limits) as Array<keyof typeof limits>)
    .some(key => obs.resources[key] !== plan.resources[key])) reasons.push("resource-limits-unverified");
  if (obs.resources.availableMemoryBytes === null ||
      obs.resources.availableMemoryBytes < plan.resources.memoryMaxBytes + plan.resources.reserveBytes) reasons.push("memory-headroom");
  if (obs.resources.cpuIdlePercent === null || obs.resources.cpuIdlePercent < plan.resources.minCpuIdlePercent) reasons.push("cpu-headroom");
  if (obs.oomKills === null) reasons.push("oom-unknown");
  if (obs.protectedServices.some(service => !service.active)) reasons.push("protected-service-unhealthy");
  if (b?.success) {
    const baseline = b.data;
    if (baseline.releaseSha !== plan.releaseSha || baseline.inputsSha256 !== plan.inputsSha256) reasons.push("baseline-identity-mismatch");
    if (obs.oomKills !== baseline.oomKills) reasons.push("oom-drift");
    if (!sameSet(obs.protectedServices.map(s => s.unit), baseline.protectedServices.map(s => s.unit)) ||
        obs.protectedServices.some(service => {
          const previous = baseline.protectedServices.find(s => s.unit === service.unit);
          return !previous || service.invocationId !== previous.invocationId || service.restarts !== previous.restarts;
        })) reasons.push("protected-service-drift");
    if (plan.residency === "preserve" && !sameSet(obs.residentModels, baseline.residentModels)) reasons.push("residency-drift");
  }
  return decision();
}

export interface ControlledInstallOperations {
  /** Fresh complete probe, including direct backend coverage and enforced limits. No mutations. */
  observe(signal: AbortSignal): Promise<unknown>;
  /** Only the preapproved CPU work. Must propagate cancellation to the whole owned workload. */
  run(signal: AbortSignal): Promise<void>;
  /** Resolve only after ALL owned work has stopped. Sending a signal alone is not proof. */
  stop(signal: AbortSignal): Promise<void>;
  /** Idempotent cleanup of this run's owned artifacts only; no model eviction/restart. */
  cleanup(signal: AbortSignal): Promise<void>;
  /** Verify owned cleanup and protected-state preservation; do not undo natural model TTL changes. */
  verifyRestoration(baseline: ControlledInstallObservation, signal: AbortSignal): Promise<void>;
}
export interface InstallRunResult {
  status: "completed" | "rejected" | "stopped" | "restoration-failed";
  reasons: string[];
  baseline: ControlledInstallObservation | null;
  restored: boolean;
  /** Bounded diagnostics: retain the stopping observation even after a successful final probe. */
  checks: { admission: InstallDecision | null; stop: InstallDecision | null; final: InstallDecision | null };
}

/** Bound even a defective adapter that ignores its signal. Keep its late rejection handled. */
async function bounded<T>(op: (signal: AbortSignal) => Promise<T>, ms: number, parent?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let abort: (() => void) | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => { controller.abort(); reject(new Error("operation-cancelled")); };
    parent?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(abort, ms);
    if (parent?.aborted) abort();
  });
  try {
    // Attach both rejection handlers even when the parent's signal was already aborted.
    return await Promise.race([Promise.resolve().then(() => { controller.signal.throwIfAborted(); return op(controller.signal); }), cancelled]);
  } finally {
    clearTimeout(timer);
    if (abort) parent?.removeEventListener("abort", abort);
  }
}

/**
 * This is not a lock, authorization mechanism or installer. A reviewed host adapter owns immutable
 * input/host binding, OS resource containment, exclusion from other installers and whole-workload
 * shutdown. Never feed a saved probe to a live run or equate an empty lease with backend idleness.
 */
export async function runControlledInstall(
  input: unknown, op: ControlledInstallOperations, signal?: AbortSignal,
): Promise<InstallRunResult> {
  const parsed = controlledInstallPlanSchema.safeParse(input);
  const result: InstallRunResult = {
    status: "rejected", reasons: [], baseline: null, restored: false,
    checks: { admission: null, stop: null, final: null },
  };
  if (!parsed.success) return { ...result, reasons: ["invalid-plan"] };
  const plan = parsed.data, t = plan.timing;
  let preflight: unknown;
  try { preflight = await bounded(s => op.observe(s), t.observationTimeoutMs, signal); }
  catch { return { ...result, reasons: [signal?.aborted ? "operator-cancelled" : "observation-failed"] }; }
  const admission = evaluateControlledInstall(plan, preflight);
  result.checks.admission = admission;
  if (!admission.admit) return { ...result, reasons: admission.reasons };
  const baseline = controlledInstallObservationSchema.parse(preflight);
  result.baseline = baseline;
  // Reserve time for stop, cleanup, restoration verification and final observation BEFORE expiry.
  const reserve = t.stopTimeoutMs + 2 * t.cleanupTimeoutMs + t.observationTimeoutMs;
  const workMs = Math.min(t.maxRunMs, Date.parse(plan.expiresAt) - Date.now() - reserve);
  if (workMs <= 0 || signal?.aborted) return { ...result, reasons: [signal?.aborted ? "operator-cancelled" : "insufficient-approved-time"] };
  const workAbort = new AbortController();
  let stopReason: string[] = [];
  let stopResolve!: () => void;
  const stopped = new Promise<void>(resolve => { stopResolve = resolve; });
  const stop = (reasons: string[]): void => {
    if (stopReason.length) return;
    stopReason = reasons;
    workAbort.abort();
    stopResolve();
  };
  const cancel = (): void => stop(["operator-cancelled"]);
  signal?.addEventListener("abort", cancel, { once: true });
  const deadline = setTimeout(() => stop(["work-deadline"]), workMs);
  const watchdog = (async () => {
    while (!workAbort.signal.aborted) {
      try {
        await new Promise<void>(resolve => {
          const done = (): void => {
            clearTimeout(timer);
            workAbort.signal.removeEventListener("abort", done);
            resolve();
          };
          const timer = setTimeout(done, t.pollMs);
          workAbort.signal.addEventListener("abort", done, { once: true });
          if (workAbort.signal.aborted) done();
        });
        if (workAbort.signal.aborted) break;
        const observation = await bounded(s => op.observe(s), t.observationTimeoutMs, workAbort.signal);
        if (workAbort.signal.aborted) break;
        const check = evaluateControlledInstall(plan, observation, baseline);
        if (!check.admit) { result.checks.stop = check; stop(check.reasons); }
      } catch {
        if (!workAbort.signal.aborted) stop(["observation-failed"]);
      }
    }
  })();
  let completed = false;
  try {
    if (signal?.aborted) cancel();
    const work = Promise.resolve().then(async () => {
      workAbort.signal.throwIfAborted();
      await op.run(workAbort.signal);
      completed = true;
    }).catch(() => stop(["work-failed"]));
    await Promise.race([work, stopped]);
  } finally {
    workAbort.abort();
    clearTimeout(deadline);
    signal?.removeEventListener("abort", cancel);
    await watchdog;
  }
  result.status = completed && stopReason.length === 0 ? "completed" : "stopped";
  result.reasons = stopReason;
  // Stop also on normal completion: a successful launcher can leave descendants or services alive.
  try { await bounded(s => op.stop(s), t.stopTimeoutMs); }
  catch { return { ...result, status: "restoration-failed", reasons: [...result.reasons, "stop-unverified"] }; }
  try {
    await bounded(s => op.cleanup(s), t.cleanupTimeoutMs);
    await bounded(s => op.verifyRestoration(baseline, s), t.cleanupTimeoutMs);
  } catch { return { ...result, status: "restoration-failed", reasons: [...result.reasons, "restoration-unverified"] }; }
  try {
    const final = await bounded(s => op.observe(s), t.observationTimeoutMs);
    const check = evaluateControlledInstall(plan, final, baseline);
    result.checks.final = check;
    if (!check.admit) return { ...result, status: "restoration-failed", reasons: [...result.reasons, ...check.reasons] };
  } catch { return { ...result, status: "restoration-failed", reasons: [...result.reasons, "final-observation-failed"] }; }
  result.restored = true;
  return result;
}
