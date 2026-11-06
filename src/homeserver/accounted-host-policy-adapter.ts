/**
 * Pure candidate adapter. The injected verifier and context are trusted dependencies, never
 * request fields. This module authenticates no transport, collects nothing and grants no permit.
 */
import { createHash } from "node:crypto";
import { types } from "node:util";
import { z } from "zod";
import {
  canonicalStringify, evaluateAdmissionAtTimestamp, evaluateRestorationAtTimestamp, projectWireCore,
  type AccountedPolicyDecision,
} from "../../contracts/accounted-host-policy-v1/accounted-host-policy.mjs";

const LANE = "accounted-podman-info-v1";
const hex = z.string().length(64).regex(/^[0-9a-f]{64}$/);
const uuid = z.string().length(36).regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const host = z.string().regex(/^[a-z][a-z0-9-]{0,62}$(?![\s\S])/);
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$(?![\s\S])/);
const count = z.number().int().nonnegative().safe();
const positive = z.number().int().positive().safe();
const phase = z.enum(["admission", "restoration"]);

function wireMicros(value: string): bigint | null {
  if (value.length !== 27 || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$/.test(value)
      || value.startsWith("0000-")) return null;
  const base = value.slice(0, 19) + ".000Z", ms = Date.parse(base);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== base) return null;
  return BigInt(ms) * 1000n + BigInt(value.slice(20, 26));
}
const stamp = z.string().refine(value => wireMicros(value) !== null);
const limitsShape = {
  chargedMemoryMaxBytes: positive, swapMaxBytes: count, cpuQuotaMicros: positive,
  cpuPeriodMicros: positive, tasksMax: positive, addressSpaceLimitBytes: positive,
};
const limits = z.object(limitsShape).strict();
const bindingsShape = {
  requestId: uuid, attemptId: uuid, hostId: host, actorUid: z.literal(1000),
  requestDigest: hex, artifactSha256: hex, deadline: stamp, protectedManifestDigest: hex,
  ownerAllocationDigest: hex, firstChargedInstructionDigest: hex, controlPlaneAccountingDigest: hex,
};
const bindings = z.object(bindingsShape).strict();
const requestSchema = z.object({
  schemaVersion: z.literal(1), laneId: z.literal(LANE), ...bindingsShape,
  limits, workMaxSeconds: positive.max(30), stopMaxSeconds: positive.max(5), totalMaxSeconds: positive.max(90),
}).strict().superRefine((r, ctx) => {
  // Protocol ceilings are not a discovered allocation. Exact owner allocation is checked below.
  if (r.limits.chargedMemoryMaxBytes > 536870912 || r.limits.swapMaxBytes !== 0 || r.limits.tasksMax > 64
      || BigInt(r.limits.cpuQuotaMicros) * 10n > BigInt(r.limits.cpuPeriodMicros)
      || r.workMaxSeconds + r.stopMaxSeconds > r.totalMaxSeconds) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "request ceiling exceeded" });
  }
});
const acceptedPolicy = z.object({
  artifactSha256: hex, protectedManifestDigest: hex, ownerAllocationDigest: hex,
  firstChargedInstructionDigest: hex, controlPlaneAccountingDigest: hex,
}).strict();
const seenAttempt = z.object({phase, requestId: uuid, attemptId: uuid}).strict();
const contextSchema = z.object({
  schemaVersion: z.literal(1), phase, issuerId: id, hostId: host, actorUid: z.literal(1000),
  hostBootIdSha256: hex, observerInstanceSha256: hex, expectedNonceSha256: hex,
  expectedSequence: positive, lastSequence: count, seenEvidenceDigests: z.array(hex).max(4096),
  seenAttempts: z.array(seenAttempt).max(4096), now: stamp, nowMonotonicMicros: count,
  maxEvidenceAgeMicros: positive, expiresAt: stamp, expectedRequestDigest: hex,
  acceptedPolicy, baselineDigest: hex.nullable(),
}).strict();
const bodySchema = z.object({
  schemaVersion: z.literal(1), source: z.literal("owner-issued-accounted-policy-v1"), phase,
  issuerId: id, hostId: host, actorUid: z.literal(1000), hostBootIdSha256: hex,
  observerInstanceSha256: hex, nonceSha256: hex, sequence: positive,
  observedAt: stamp, observedMonotonicMicros: count, policyInput: z.unknown(),
}).strict();
const verifiedSchema = z.object({state: z.literal("verified"), body: bodySchema, bodyDigest: hex}).strict();
const inputViewSchema = z.object({
  plan: z.object({bindings, ownerAllocation: limits.extend({digest: hex}).strict(), observationMaxAgeMs: positive}).passthrough(),
  observation: z.object({observedAt: stamp}).passthrough(),
  baseline: z.object({observedAt: stamp}).passthrough().optional(),
}).passthrough();

/** Bounds JSON before copying/hashing; getters, classes, cycles and unsafe numbers are refused. */
function snapshot(value: unknown): unknown {
  const seen = new WeakSet<object>();
  let nodes = 0, textBytes = 0;
  function walk(v: unknown, depth: number): unknown {
    if (++nodes > 20000 || depth > 32) throw new TypeError("json_bound_exceeded");
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "number" && Number.isSafeInteger(v)) return v;
    if (typeof v === "string") {
      textBytes += Buffer.byteLength(v);
      if (textBytes > 524288) throw new TypeError("json_bound_exceeded");
      return v;
    }
    if (typeof v !== "object" || v === null || types.isProxy(v) || seen.has(v)) throw new TypeError("json_invalid");
    seen.add(v);
    const proto = Object.getPrototypeOf(v), array = Array.isArray(v);
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) throw new TypeError("json_invalid");
    if (array && v.length > 4096) throw new TypeError("json_bound_exceeded");
    const descriptors = Object.getOwnPropertyDescriptors(v), keys = Reflect.ownKeys(descriptors);
    if (array && (keys.length !== v.length + 1 || Array.from({length:v.length}, (_, i) => String(i)).some(k => !Object.hasOwn(descriptors, k)))) throw new TypeError("json_invalid");
    if (keys.length > 4097) throw new TypeError("json_bound_exceeded");
    const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      if (typeof key !== "string") throw new TypeError("json_invalid");
      if (array && key === "length") continue;
      const d = descriptors[key];
      if (!d.enumerable || !Object.hasOwn(d, "value")) throw new TypeError("json_invalid");
      textBytes += Buffer.byteLength(key);
      if (textBytes > 524288) throw new TypeError("json_bound_exceeded");
      copy[key] = walk(d.value, depth + 1);
    }
    seen.delete(v);
    // Copy only validated descriptors. Never call a method or reread a value on the input.
    return array ? Array.from({length:v.length}, (_, i) => copy[String(i)]) : copy;
  }
  return walk(value, 0);
}
function digest(domain: string, value: unknown): string {
  return createHash("sha256").update(domain + canonicalStringify(snapshot(value))).digest("hex");
}
export function digestAccountedRequest(value: unknown): string {
  const parsed = requestSchema.parse(snapshot(value));
  const {requestDigest: _ownDigest, ...body} = parsed;
  return createHash("sha256").update(canonicalStringify(body)).digest("hex");
}
export function digestAccountedOwnerEvidence(value: unknown): string {
  return digest("gille-inference/accounted/owner-evidence/v1\n", value);
}
export function digestAccountedBaseline(value: unknown): string {
  return digest("gille-inference/accounted/accepted-baseline/v1\n", value);
}
export interface OwnerEvidenceExpectation {
  issuerId: string; requestDigest: string; phase: "admission" | "restoration";
}
/** Real issuer/channel verification is an external authority dependency, not implemented here. */
export type OwnerEvidenceVerifier = (envelope: unknown, expected: Readonly<OwnerEvidenceExpectation>) => unknown;
export interface ReplayCommit {
  expectedStateDigest: string; expectedLastSequence: number; sequence: number; bodyDigest: string;
  phase: "admission" | "restoration"; requestId: string; attemptId: string; requestDigest: string; nonceSha256: string;
}
export interface AccountedHostAdapterDecision {
  compatible: boolean; offlineOnly: true; executionAuthorized: false; requiresAtomicReplayCommit: true;
  reasons: string[]; policyDecision: AccountedPolicyDecision | null; replayCommit: ReplayCommit | null;
}

/** All clock/config/replay facts must come from a trusted owner context, never the request. */
export function evaluateAccountedHostPolicyAdapter(
  rawRequest: unknown, ownerEnvelope: unknown, rawContext: unknown, verifier?: OwnerEvidenceVerifier,
): AccountedHostAdapterDecision {
  const reasons = new Set<string>();
  let policyDecision: AccountedPolicyDecision | null = null, replayCommit: ReplayCommit | null = null;
  const report = (): AccountedHostAdapterDecision => ({compatible: reasons.size === 0 && policyDecision?.admit === true,
    offlineOnly: true, executionAuthorized: false, requiresAtomicReplayCommit: true,
    reasons: [...reasons].sort(), policyDecision, replayCommit});
  let requestCopy: unknown, contextCopy: unknown;
  try { requestCopy = snapshot(rawRequest); } catch { reasons.add("invalid_request"); return report(); }
  try { contextCopy = snapshot(rawContext); } catch { reasons.add("invalid_context"); return report(); }
  const rp = requestSchema.safeParse(requestCopy), cp = contextSchema.safeParse(contextCopy);
  if (!rp.success) reasons.add("invalid_request");
  if (!cp.success) reasons.add("invalid_context");
  if (!rp.success || !cp.success) return report();
  const request = rp.data, context = cp.data;
  if (digestAccountedRequest(request) !== request.requestDigest) reasons.add("request_digest_mismatch");
  if (context.expectedRequestDigest !== request.requestDigest || context.hostId !== request.hostId) reasons.add("request_owner_binding_mismatch");
  for (const key of Object.keys(context.acceptedPolicy) as (keyof typeof context.acceptedPolicy)[]) {
    if (request[key] !== context.acceptedPolicy[key]) reasons.add("accepted_policy_mismatch");
  }
  const now = wireMicros(context.now)!, expiry = wireMicros(context.expiresAt)!;
  if (now >= expiry) reasons.add("owner_policy_expired");
  if (wireMicros(request.deadline)! > expiry) reasons.add("request_outlives_owner_policy");
  if (new Set(context.seenEvidenceDigests).size !== context.seenEvidenceDigests.length
      || new Set(context.seenAttempts.map(v => `${v.phase}:${v.requestId}:${v.attemptId}`)).size !== context.seenAttempts.length) reasons.add("replay_state_invalid");
  if (typeof verifier !== "function") reasons.add("verifier_unavailable");
  if (reasons.size) return report();
  let verifiedCopy: unknown;
  try {
    verifiedCopy = snapshot(verifier!(ownerEnvelope, Object.freeze({issuerId: context.issuerId, requestDigest: request.requestDigest, phase: context.phase})));
  } catch {
    // Only this external-verifier/JSON boundary is contained; no provider error body is echoed.
    reasons.add("owner_verifier_failed"); return report();
  }
  const parsed = verifiedSchema.safeParse(verifiedCopy);
  if (!parsed.success) { reasons.add("owner_evidence_unverified"); return report(); }
  const {body, bodyDigest} = parsed.data;
  if (digestAccountedOwnerEvidence(body) !== bodyDigest) reasons.add("evidence_digest_mismatch");
  if (body.issuerId !== context.issuerId || body.hostId !== context.hostId || body.actorUid !== context.actorUid
      || body.hostBootIdSha256 !== context.hostBootIdSha256 || body.observerInstanceSha256 !== context.observerInstanceSha256
      || body.phase !== context.phase) reasons.add("evidence_identity_mismatch");
  if (body.nonceSha256 !== context.expectedNonceSha256) reasons.add("nonce_mismatch");
  if (body.sequence !== context.expectedSequence || BigInt(context.expectedSequence) !== BigInt(context.lastSequence) + 1n) reasons.add("sequence_mismatch");
  if (context.seenEvidenceDigests.includes(bodyDigest)) reasons.add("evidence_replayed");
  if (context.seenAttempts.some(v => v.phase === context.phase && v.requestId === request.requestId && v.attemptId === request.attemptId)) reasons.add("attempt_replayed");
  const wallAge = now - wireMicros(body.observedAt)!, monoAge = BigInt(context.nowMonotonicMicros) - BigInt(body.observedMonotonicMicros);
  if (wallAge < 0n || monoAge < 0n) reasons.add("evidence_future");
  if (wallAge > BigInt(context.maxEvidenceAgeMicros) || monoAge > BigInt(context.maxEvidenceAgeMicros)) reasons.add("evidence_stale");
  const input = inputViewSchema.safeParse(body.policyInput);
  if (!input.success) reasons.add("policy_input_invalid");
  if (!input.success || reasons.size) return report();
  const view = input.data;
  if (canonicalStringify(projectWireCore(view.plan.bindings)) !== canonicalStringify(projectWireCore(request))) reasons.add("policy_request_mismatch");
  if (body.observedAt !== view.observation.observedAt) reasons.add("observation_time_unbound");
  if (BigInt(view.plan.observationMaxAgeMs) * 1000n > BigInt(context.maxEvidenceAgeMicros)) reasons.add("observation_window_too_wide");
  const {digest: _allocationDigest, ...allocationLimits} = view.plan.ownerAllocation;
  if (canonicalStringify(allocationLimits) !== canonicalStringify(request.limits)) reasons.add("request_limits_mismatch");
  if (context.phase === "restoration") {
    if (context.baselineDigest === null || !view.baseline || digestAccountedBaseline(view.baseline) !== context.baselineDigest) reasons.add("baseline_unbound");
  } else if (context.baselineDigest !== null) reasons.add("baseline_unexpected");
  if (reasons.size) return report();
  try {
    policyDecision = context.phase === "admission"
      ? evaluateAdmissionAtTimestamp(body.policyInput, context.now)
      : evaluateRestorationAtTimestamp(body.policyInput, context.now);
  } catch {
    // A malformed-data kernel failure is a named refusal, never an implicit permission.
    reasons.add("policy_kernel_failed"); return report();
  }
  if (!policyDecision.admit) { reasons.add("policy_refused"); return report(); }
  replayCommit = {
    expectedStateDigest: digest("gille-inference/accounted/replay-state/v1\n", {
      hostBootIdSha256: context.hostBootIdSha256, observerInstanceSha256: context.observerInstanceSha256,
      lastSequence: context.lastSequence, seenEvidenceDigests: context.seenEvidenceDigests, seenAttempts: context.seenAttempts,
    }), expectedLastSequence: context.lastSequence, sequence: body.sequence, bodyDigest,
    phase: context.phase, requestId: request.requestId, attemptId: request.attemptId, requestDigest: request.requestDigest, nonceSha256: body.nonceSha256,
  };
  return report();
}
