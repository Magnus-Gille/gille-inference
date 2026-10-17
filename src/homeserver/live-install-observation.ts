/**
 * Pure v2 live-evidence contract. Parsing is NOT authentication or host discovery. Only a reviewed
 * collector bound to its authenticated channel may supply these observations to a host runner.
 * No conversion from saved v1 diagnostics, service-control operation or execution permit lives here.
 */
import { z } from "zod";
import { controlledInstallObservationSchema, controlledInstallPlanSchema } from "./controlled-install.js";
import { installProducerIdentitySchema, installProducerSnapshotSchema } from "./install-producer-activity.js";

const count = z.number().int().nonnegative().safe();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const unit = z.string().regex(/^[a-zA-Z0-9_.@-]+\.service$/);
const legacyShape = controlledInstallObservationSchema.innerType().shape;
const distinct = (values: string[]) => new Set(values).size === values.length;
const sameSet = (left: string[], right: string[]) => left.length === right.length && left.every(value => right.includes(value));

export const liveInstallPlanSchema = z.object({
  schemaVersion: z.literal(2),
  install: controlledInstallPlanSchema,
  binding: z.object({
    hostBootIdSha256: digest, manifestSha256: digest, runIdSha256: digest,
    producers: z.array(installProducerIdentitySchema).min(1).max(256),
    protectedUnits: z.array(unit).min(1).max(128),
  }).strict(),
}).strict().superRefine((p, ctx) => {
  if (!distinct(p.binding.producers.map(value => value.producerId)) || !distinct(p.binding.protectedUnits)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "duplicate binding identity" });
  }
});
export type LiveInstallPlan = z.infer<typeof liveInstallPlanSchema>;

export const liveInstallObservationSchema = controlledInstallObservationSchema.innerType()
  .omit({ backend: true }).extend({
    source: z.literal("host-probe-v2"), observedMonotonicMs: count,
    hostBootIdSha256: digest, manifestSha256: digest, coverage: z.enum(["complete", "unknown"]),
    observer: z.object({ instanceSha256: digest, sequence: count, requestNonceSha256: digest }).strict(),
    installLease: z.object({ runIdSha256: digest, held: z.boolean() }).strict(),
    gpuLease: z.discriminatedUnion("state", [
      z.object({ state: z.literal("free"), owner: z.null() }).strict(),
      z.object({ state: z.literal("unknown"), owner: z.null() }).strict(),
      z.object({ state: z.literal("held"), owner: z.object({
        ownerIdSha256: digest, purpose: z.enum(["inference", "maintenance", "other"]),
      }).strict() }).strict(),
    ]),
    producers: z.array(installProducerSnapshotSchema).min(1).max(256),
    protectedServices: z.array(legacyShape.protectedServices.element.extend({ oomKills: count.nullable() })).min(1).max(128),
  }).strict().superRefine((o, ctx) => {
    if (!distinct(o.residentModels) || !distinct(o.producers.map(value => value.producerId)) ||
        !distinct(o.protectedServices.map(value => value.unit))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "duplicate observation identity" });
    }
  });
export type LiveInstallObservation = z.infer<typeof liveInstallObservationSchema>;

/** Both clocks come from the host runner, never from the producer or request body. */
export const liveInstallClockSchema = z.object({
  wallMs: count, monotonicMs: count, expectedNonceSha256: digest,
}).strict();
export type LiveInstallClock = z.infer<typeof liveInstallClockSchema>;
export interface LiveInstallDecision {
  admit: boolean;
  reasons: string[];
  source: "host-probe-v2" | null;
  observedAt: string | null;
}

function snapshotReasons(p: LiveInstallPlan, o: LiveInstallObservation, clock: LiveInstallClock): string[] {
  const reasons: string[] = [], plan = p.install, binding = p.binding;
  const wallAge = clock.wallMs - Date.parse(o.observedAt), monoAge = clock.monotonicMs - o.observedMonotonicMs;
  if (wallAge < 0 || monoAge < 0 || wallAge > plan.timing.maxObservationAgeMs || monoAge > plan.timing.maxObservationAgeMs) reasons.push("observation-not-fresh");
  if (o.releaseSha !== plan.releaseSha || o.inputsSha256 !== plan.inputsSha256) reasons.push("identity-mismatch");
  if (o.hostBootIdSha256 !== binding.hostBootIdSha256 || o.manifestSha256 !== binding.manifestSha256) reasons.push("host-binding-mismatch");
  if (!o.installLease.held || o.installLease.runIdSha256 !== binding.runIdSha256) reasons.push("installation-lease-unverified");
  if (o.gpuLease.state !== "free" || o.gateway.leaseHeld !== false) reasons.push("gpu-not-free");
  if (o.gateway.active === null || o.gateway.queued === null) reasons.push("gateway-activity-unknown");
  else if (o.gateway.active > 0 || o.gateway.queued > 0) reasons.push("gateway-busy");
  if (o.coverage !== "complete") reasons.push("coverage-unknown");
  if (!sameSet(o.producers.map(value => value.producerId), binding.producers.map(value => value.producerId))) reasons.push("producer-inventory-mismatch");
  for (const producer of o.producers) {
    const expected = binding.producers.find(value => value.producerId === producer.producerId);
    if (!expected || producer.instanceSha256 !== expected.instanceSha256 || producer.buildSha256 !== expected.buildSha256 || producer.configSha256 !== expected.configSha256) reasons.push("producer-identity-mismatch");
    if (producer.active === null || producer.queued === null || producer.loading === null || producer.workStarted === null) reasons.push("producer-activity-unknown");
    else if (producer.active > 0 || producer.queued > 0 || producer.loading > 0) reasons.push("producer-busy");
  }
  if (o.maintenanceActive !== false) reasons.push("maintenance-not-idle");
  const r = o.resources, approved = plan.resources;
  if (!r.limitsVerified || r.memoryMaxBytes !== approved.memoryMaxBytes || r.cpuQuotaPercent !== approved.cpuQuotaPercent || r.tasksMax !== approved.tasksMax) reasons.push("resource-limits-unverified");
  if (r.availableMemoryBytes === null || r.availableMemoryBytes < approved.memoryMaxBytes + approved.reserveBytes) reasons.push("memory-headroom");
  if (r.cpuIdlePercent === null || r.cpuIdlePercent < approved.minCpuIdlePercent) reasons.push("cpu-headroom");
  if (o.oomKills === null || o.protectedServices.some(value => value.oomKills === null)) reasons.push("oom-unknown");
  if (!sameSet(o.protectedServices.map(value => value.unit), binding.protectedUnits)) reasons.push("protected-inventory-mismatch");
  if (o.protectedServices.some(value => !value.active)) reasons.push("protected-service-unhealthy");
  return reasons;
}

/**
 * Two distinct, fresh, idle observations are mandatory. Thereafter previous must be the last
 * accepted sample of this run, never an arbitrary replacement baseline. This pure predicate does
 * not authenticate its input, reserve resources, arbitrate maintenance or stop a cgroup.
 */
export function evaluateLiveInstall(input: unknown, evidence: unknown, previous: unknown, hostClock: unknown): LiveInstallDecision {
  const p = liveInstallPlanSchema.safeParse(input), o = liveInstallObservationSchema.safeParse(evidence);
  const b = liveInstallObservationSchema.safeParse(previous), c = liveInstallClockSchema.safeParse(hostClock);
  const reasons: string[] = [];
  const result = (): LiveInstallDecision => ({ admit: reasons.length === 0, reasons: [...new Set(reasons)], source: o.success ? o.data.source : null, observedAt: o.success ? o.data.observedAt : null });
  if (!p.success) reasons.push("invalid-plan");
  if (!o.success) reasons.push("invalid-observation");
  if (!b.success) reasons.push("invalid-baseline");
  if (!c.success) reasons.push("invalid-clock");
  if (!p.success || !o.success || !b.success || !c.success) return result();
  const plan = p.data, current = o.data, prior = b.data, clock = c.data;
  if (Date.parse(plan.install.expiresAt) <= clock.wallMs) reasons.push("approval-expired");
  reasons.push(...snapshotReasons(plan, current, clock));
  reasons.push(...snapshotReasons(plan, prior, clock).map(reason => `baseline-${reason}`));
  if (current.observer.requestNonceSha256 !== clock.expectedNonceSha256 || current.observer.requestNonceSha256 === prior.observer.requestNonceSha256) reasons.push("observer-challenge-mismatch");
  if (current.observer.instanceSha256 !== prior.observer.instanceSha256) reasons.push("observer-restarted");
  if (current.observer.sequence <= prior.observer.sequence || current.observedMonotonicMs <= prior.observedMonotonicMs || Date.parse(current.observedAt) < Date.parse(prior.observedAt)) reasons.push("observation-continuity-lost");
  for (const producer of current.producers) {
    const before = prior.producers.find(value => value.producerId === producer.producerId);
    if (!before || before.workStarted !== producer.workStarted) reasons.push("work-started");
  }
  if (current.oomKills !== prior.oomKills) reasons.push("oom-drift");
  for (const service of current.protectedServices) {
    const before = prior.protectedServices.find(value => value.unit === service.unit);
    if (!before || service.invocationId !== before.invocationId || service.restarts !== before.restarts) reasons.push("protected-service-drift");
    if (before && service.oomKills !== before.oomKills) reasons.push("protected-oom-drift");
  }
  if (plan.install.residency === "preserve" && !sameSet(current.residentModels, prior.residentModels)) reasons.push("residency-drift");
  return result();
}

export interface LiveInstallSessionResult {
  state: "priming" | "admitted" | "revoked";
  decision: LiveInstallDecision;
  permitUntilMonotonicMs: number | null;
}

/**
 * Keeps the last accepted sample and latches any failure. A live caller cannot refresh an old
 * observation by moving its baseline or merely sending a heartbeat. This is a host-runner policy
 * primitive, NOT the independent OS deadman: a process outside the runner must enforce expiry.
 */
export class LiveInstallEvidenceSession {
  private readonly plan: LiveInstallPlan;
  private previous: LiveInstallObservation | null = null;
  private lastClock: LiveInstallClock | null = null;
  private permitUntil: number | null = null;
  private revoked = false;

  constructor(input: unknown) {
    const parsed = liveInstallPlanSchema.safeParse(input);
    if (!parsed.success) throw new Error("invalid-live-install-plan");
    this.plan = parsed.data;
  }

  private reject(reason: string): LiveInstallSessionResult {
    this.revoked = true;
    this.permitUntil = null;
    return { state: "revoked", decision: { admit: false, reasons: [reason], source: null, observedAt: null }, permitUntilMonotonicMs: null };
  }

  observe(evidence: unknown, hostClock: unknown): LiveInstallSessionResult {
    if (this.revoked) return this.reject("session-revoked");
    const o = liveInstallObservationSchema.safeParse(evidence), c = liveInstallClockSchema.safeParse(hostClock);
    if (!o.success) return this.reject("invalid-observation");
    if (!c.success) return this.reject("invalid-clock");
    const current = o.data, clock = c.data;
    if (this.lastClock && (clock.monotonicMs < this.lastClock.monotonicMs || clock.wallMs < this.lastClock.wallMs)) return this.reject("clock-continuity-lost");
    // Once a permit lapses it cannot be revived, even with a new apparently healthy sample.
    if (this.permitUntil !== null && clock.monotonicMs >= this.permitUntil) return this.reject("permit-expired");
    if (Date.parse(this.plan.install.expiresAt) <= clock.wallMs) return this.reject("approval-expired");
    if (!this.previous) {
      const reasons = snapshotReasons(this.plan, current, clock);
      if (current.observer.requestNonceSha256 !== clock.expectedNonceSha256) reasons.push("observer-challenge-mismatch");
      if (reasons.length) {
        this.revoked = true;
        return { state: "revoked", decision: { admit: false, reasons: [...new Set(reasons)], source: current.source, observedAt: current.observedAt }, permitUntilMonotonicMs: null };
      }
      this.previous = current;
      this.lastClock = clock;
      return { state: "priming", decision: { admit: false, reasons: ["second-observation-required"], source: current.source, observedAt: current.observedAt }, permitUntilMonotonicMs: null };
    }
    const decision = evaluateLiveInstall(this.plan, current, this.previous, clock);
    if (!decision.admit) {
      this.revoked = true;
      this.permitUntil = null;
      return { state: "revoked", decision, permitUntilMonotonicMs: null };
    }
    const evidenceDeadline = current.observedMonotonicMs + this.plan.install.timing.maxObservationAgeMs;
    const approvalDeadline = clock.monotonicMs + Date.parse(this.plan.install.expiresAt) - clock.wallMs;
    if (!Number.isSafeInteger(evidenceDeadline) || !Number.isSafeInteger(approvalDeadline)) return this.reject("invalid-clock");
    this.permitUntil = Math.min(evidenceDeadline, approvalDeadline);
    if (this.permitUntil <= clock.monotonicMs) return this.reject("permit-expired");
    this.previous = current;
    this.lastClock = clock;
    return { state: "admitted", decision, permitUntilMonotonicMs: this.permitUntil };
  }

  /** Reading never renews a permit. The host deadman must still act if this process disappears. */
  check(hostClock: unknown): LiveInstallSessionResult {
    if (this.revoked) return this.reject("session-revoked");
    const c = liveInstallClockSchema.safeParse(hostClock);
    if (!c.success) return this.reject("invalid-clock");
    if (this.lastClock && (c.data.monotonicMs < this.lastClock.monotonicMs || c.data.wallMs < this.lastClock.wallMs)) return this.reject("clock-continuity-lost");
    if (Date.parse(this.plan.install.expiresAt) <= c.data.wallMs) return this.reject("approval-expired");
    if (this.permitUntil !== null && c.data.monotonicMs >= this.permitUntil) return this.reject("permit-expired");
    this.lastClock = c.data;
    const admitted = this.permitUntil !== null;
    return { state: admitted ? "admitted" : "priming", decision: {
      admit: admitted, reasons: admitted ? [] : ["second-observation-required"],
      source: this.previous?.source ?? null, observedAt: this.previous?.observedAt ?? null,
    }, permitUntilMonotonicMs: this.permitUntil };
  }

  revoke(): LiveInstallSessionResult { return this.reject("operator-revoked"); }
}
