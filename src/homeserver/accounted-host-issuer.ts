/** LOCAL issuer candidate. No installed collector, persistence backend or execution authority.
 * The providers below are trusted capabilities, never deserialized request fields.
 */
import { createHash } from "node:crypto";
import { types } from "node:util";
import { z } from "zod";
import {
  digestAccountedOwnerEvidence, digestAccountedRequest, evaluateAccountedHostPolicyAdapter,
  type OwnerEvidenceVerifier, type ReplayCommit,
} from "./accounted-host-policy-adapter.js";

export const BROKKR_R3_MANIFEST = "af7e8d1cd41ad4fb5750b54bbcb6c25ec3394bc5ddde7e7a6a27e6326621f49d";
export const ACCOUNTED_DESCRIPTOR = "7d97cb1f350f1aaa25b9abfef518f5b8f5b42af77ace1dfa49216692e42f5bde";
export const SHARED_COMPONENTS = ["bootstrap", "transport", "service_manager", "kernel", "admission_issuer", "recovery"] as const;
const hex = z.string().regex(/^[0-9a-f]{64}$(?![\s\S])/);
const hex32 = z.string().regex(/^[0-9a-f]{32}$(?![\s\S])/);
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$(?![\s\S])/);
const ns = z.string().regex(/^(0|[1-9][0-9]{0,18})$(?![\s\S])/).refine(s => BigInt(s) <= 2n ** 63n - 1n);
const count = z.number().int().nonnegative().safe();
const acceptedSchema = z.object({
  version: z.literal(1), brokkrManifestDigest: hex,
  nativeAttemptId: hex32, requestId: uuid, policyAttemptId: uuid,
  sourceRevision: z.string().regex(/^[0-9a-f]{40}$(?![\s\S])/), releaseId: hex,
  configDigest: hex, descriptorDigest: z.literal(ACCOUNTED_DESCRIPTOR), issuerReleaseDigest: hex,
  deadlineBoottimeNs: ns, maxEvidenceAgeNs: ns, request: z.unknown(),
}).strict();
const nativeLimits = z.object({
  memory_bytes: z.bigint().min(16777216n).max(536870912n), cpu_quota_us: z.bigint().min(1n).max(10000n),
  cpu_period_us: z.literal(100000n), pids_max: z.bigint().min(4n).max(64n),
}).strict();
const inode = z.bigint().min(0n).max(2n ** 63n - 1n);
const identitySchema = z.object({
  boot_id: uuid, invocation_id: hex32, cgroup_device: inode, cgroup_inode: inode,
  cgroup_path: z.string(), namespace_inodes: z.object({mnt: inode, net: inode, ipc: inode, pid: inode}).strict(),
}).strict();
const challengeSchema = z.object({
  version: z.literal(1n), attempt_id: hex32, unit: z.string(), source_revision: z.string(),
  release_id: hex, config_digest: hex, descriptor_digest: hex, identity: identitySchema,
  limits: nativeLimits, observed_boottime_ns: inode,
}).strict();
type Challenge = z.infer<typeof challengeSchema>;
const sharedRecord = z.object({
  component: z.enum(SHARED_COMPONENTS), accounting_record_digest: hex, allocation_record_digest: hex,
}).strict();
const verifiedHostSchema = z.object({
  state: z.literal("verified"), challengeDigest: hex, requestDigest: hex,
  issuerReleaseDigest: hex, nativeIdentityJson: z.string().max(8192),
  observedBoottimeNs: ns, expiresBoottimeNs: ns,
  swapMaxBytes: count, addressSpaceLimitBytes: count,
  // Includes pre-admission/bootstrap and the actual outer stop/backstop, not just supervise()30s.
  wholeTaskMaxSeconds: z.number().int().min(30).max(90),
  firstChargedInstructionDigest: hex, shared: z.array(sharedRecord).length(6),
  // The verifier must verify the records behind these digests, not just their syntax.
  ownerEnvelope: z.unknown(), ownerContext: z.unknown(),
}).strict();
type VerifiedHost = z.infer<typeof verifiedHostSchema>;
export interface IssuerClock { boottimeNs: string; utc: string }
export interface IssuerExpectation {
  challengeDigest: string; requestDigest: string; nativeAttemptId: string;
  requestId: string; policyAttemptId: string; issuerReleaseDigest: string;
}
export interface IssuerReservation extends IssuerExpectation { reservationId: string }
export interface IssuerPersistence {
  /** Atomic durable claim of BOTH native and policy-attempt identities. Existing/unknown never rearms. */
  reserve(binding: Readonly<IssuerExpectation>, signal: AbortSignal): Promise<IssuerReservation | null>;
  /** Atomic CAS of the actual persisted replay state; consume before publishing. Crash leaves consumed. */
  commit(reservation: Readonly<IssuerReservation>, replay: Readonly<ReplayCommit>, admissionDigest: string, signal: AbortSignal): Promise<boolean>;
  /** Root0600 atomic no-replace publication, enforcing deadline at the write. Never overwrite/retry. */
  publish(reservation: Readonly<IssuerReservation>, bytes: string, deadlineBoottimeNs: string, signal: AbortSignal): Promise<void>;
}
export interface AccountedIssuerProviders {
  clock(): IssuerClock;
  readChallenge(signal: AbortSignal): Promise<string>;
  collect(expected: Readonly<IssuerExpectation>, signal: AbortSignal): Promise<unknown>;
  /** Independently authenticate current facts/allocation/complete six-component records and native identity/limits. */
  verifyHostEvidence(envelope: unknown, expected: Readonly<IssuerExpectation>): unknown;
  verifyOwnerEvidence: OwnerEvidenceVerifier;
  persistence: IssuerPersistence;
}
export interface AccountedIssuerResult {
  status: "refused" | "published" | "unknown"; reason: string;
  stage: "providers" | "accepted" | "challenge" | "reserve" | "evidence" | "commit" | "publish";
  offlineOnly: true; executionAuthorized: false; attemptConsumed: boolean;
  admissionDigest: string | null;
}
/** Root-sealed durable CAS and atomic publication are external capabilities, NOT JSON input.
 * No memory fallback, state initializer or filesystem backend is installed by this candidate.
 */
export interface IssuerDurableStorage {
  read(signal: AbortSignal): Promise<{version: string; state: unknown}>;
  compareAndSwap(version: string, state: unknown, signal: AbortSignal): Promise<boolean>;
  publishOnce(attemptId: string, bytes: string, deadlineBoottimeNs: string, signal: AbortSignal): Promise<void>;
}
const expectationSchema = z.object({
  challengeDigest: hex, requestDigest: hex, nativeAttemptId: hex32,
  requestId: uuid, policyAttemptId: uuid, issuerReleaseDigest: hex,
}).strict();
const claimSchema = expectationSchema.extend({reservationId: hex, committed: z.boolean(), admissionDigest: hex.nullable()}).strict();
const journalSchema = z.object({
  schemaVersion: z.literal(1), hostBootIdSha256: hex, observerInstanceSha256: hex,
  lastSequence: count, seenEvidenceDigests: z.array(hex).max(4096),
  seenAttempts: z.array(z.object({phase: z.literal("admission"), requestId: uuid, attemptId: uuid}).strict()).max(4096),
  claims: z.array(claimSchema).max(4096),
}).strict();
function replayStateDigest(s: z.infer<typeof journalSchema>): string {
  const {schemaVersion: _version, claims: _claims, ...body} = s;
  // Same domain and canonical JSON as the unchanged adapter's replayCommit.
  return sha("gille-inference/accounted/replay-state/v1\n" + canonicalNative(body));
}
/** Actual one-way journal transitions. Storage must implement durable atomic CAS across processes. */
export function createAccountedIssuerPersistence(storage: IssuerDurableStorage): IssuerPersistence {
  async function read(signal: AbortSignal) {
    signal.throwIfAborted();
    const value = await storage.read(signal), state = journalSchema.parse(copy(value.state));
    need(typeof value.version === "string" && /^[0-9a-f]{64}$/.test(value.version), "journal_version");
    need(new Set(state.seenEvidenceDigests).size === state.seenEvidenceDigests.length
      && new Set(state.seenAttempts.map(a => a.requestId + ":" + a.attemptId)).size === state.seenAttempts.length
      && new Set(state.claims.map(c => c.nativeAttemptId)).size === state.claims.length
      && new Set(state.claims.map(c => c.policyAttemptId)).size === state.claims.length, "journal_duplicate");
    return {version: value.version, state};
  }
  return {
    async reserve(raw, signal) {
      const binding = expectationSchema.parse(copy(raw)), {version, state} = await read(signal);
      if (state.claims.length >= 4096 || state.claims.some(c => c.nativeAttemptId === binding.nativeAttemptId
        || c.policyAttemptId === binding.policyAttemptId || c.requestId === binding.requestId)
        || state.seenAttempts.some(a => a.attemptId === binding.policyAttemptId || a.requestId === binding.requestId)) return null;
      const reservationId = digestAccountedOwnerEvidence({version, binding});
      state.claims.push({...binding, reservationId, committed: false, admissionDigest: null});
      signal.throwIfAborted();
      return await storage.compareAndSwap(version, state, signal) ? {...binding, reservationId} : null;
    },
    async commit(reservation, replay, admissionDigest, signal) {
      hex.parse(admissionDigest);
      const {version, state} = await read(signal), claim = state.claims.find(c => c.reservationId === reservation.reservationId);
      if (!claim || claim.committed || !Object.keys(expectationSchema.shape).every(k => claim[k as keyof IssuerExpectation] === reservation[k as keyof IssuerExpectation])
        || replay.phase !== "admission" || replay.requestId !== claim.requestId || replay.attemptId !== claim.policyAttemptId
        || replay.requestDigest !== claim.requestDigest || replay.nonceSha256 !== claim.challengeDigest
        || replay.expectedStateDigest !== replayStateDigest(state) || replay.expectedLastSequence !== state.lastSequence
        || replay.sequence !== state.lastSequence + 1 || state.seenEvidenceDigests.includes(replay.bodyDigest)
        || state.seenEvidenceDigests.length >= 4096 || state.seenAttempts.length >= 4096) return false;
      claim.committed = true; claim.admissionDigest = admissionDigest;
      state.lastSequence = replay.sequence; state.seenEvidenceDigests.push(hex.parse(replay.bodyDigest));
      state.seenAttempts.push({phase: "admission", requestId: replay.requestId, attemptId: replay.attemptId});
      signal.throwIfAborted(); return storage.compareAndSwap(version, state, signal);
    },
    async publish(reservation, bytes, deadline, signal) {
      ns.parse(deadline);
      const {state} = await read(signal), claim = state.claims.find(c => c.reservationId === reservation.reservationId);
      need(claim?.committed && claim.admissionDigest === sha(bytes)
        && Object.keys(expectationSchema.shape).every(k => claim[k as keyof IssuerExpectation] === reservation[k as keyof IssuerExpectation]), "publication_uncommitted");
      signal.throwIfAborted(); await storage.publishOnce(claim.nativeAttemptId, bytes, deadline, signal);
    },
  };
}
class Refusal extends Error { constructor(readonly code: string) { super(code); } }
function need(test: unknown, code: string): asserts test { if (!test) throw new Refusal(code); }
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
function utcMicros(s: unknown): bigint {
  need(typeof s === "string" && /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$/.test(s) && !s.startsWith("0000"), "clock_utc");
  const base = s.slice(0, 19) + ".000Z", ms = Date.parse(base);
  need(Number.isFinite(ms) && new Date(ms).toISOString() === base, "clock_utc");
  return BigInt(ms) * 1000n + BigInt(s.slice(20, 26));
}
const floorMicros = (n: bigint) => n >= 0n ? n / 1000n : (n - 999n) / 1000n;

/** Snapshot descriptors, never invoke caller getters/proxies or retain mutable inputs. */
function copy(value: unknown): unknown {
  let nodes = 0, bytes = 0;
  const seen = new Set<object>();
  function walk(v: unknown, depth: number): unknown {
    need(++nodes <= 20000 && depth <= 32, "input_bound");
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "string") { bytes += Buffer.byteLength(v); need(bytes <= 524288, "input_bound"); return v; }
    if (typeof v === "number") { need(Number.isSafeInteger(v), "input_number"); return v; }
    need(typeof v === "object" && v !== null && !types.isProxy(v) && !seen.has(v), "input_object");
    need(Object.getPrototypeOf(v) === (Array.isArray(v) ? Array.prototype : Object.prototype) || Object.getPrototypeOf(v) === null, "input_prototype");
    seen.add(v);
    const desc = Object.getOwnPropertyDescriptors(v), keys = Reflect.ownKeys(desc);
    need(keys.every(k => typeof k === "string"), "input_key");
    const out: Record<string, unknown> | unknown[] = Array.isArray(v) ? [] : Object.create(null);
    for (const key of keys as string[]) {
      if (Array.isArray(v) && key === "length") continue;
      bytes += Buffer.byteLength(key); need(bytes <= 524288, "input_bound");
      const d = desc[key]; need("value" in d && d.enumerable, "input_accessor");
      if (Array.isArray(v)) need(/^(0|[1-9][0-9]*)$/.test(key) && Number(key) < v.length, "input_array");
      Object.defineProperty(out, key, {value: walk(d.value, depth + 1), enumerable: true, writable: true, configurable: true});
    }
    if (Array.isArray(v)) need(Object.keys(out).length === v.length, "input_array");
    seen.delete(v); return out;
  }
  return walk(value, 0);
}

/** R3 ASCII canonical JSON, preserving every native integer including nanoseconds >2^53. */
export function canonicalNative(value: unknown): string {
  let nodes = 0, size = 0; const seen = new Set<object>();
  function encode(v: unknown, depth: number): string {
    need(++nodes <= 20000 && depth <= 32, "native_bound");
    if (typeof v === "bigint") { need(v >= -(2n ** 63n) && v <= 2n ** 63n - 1n, "native_integer"); return v.toString(); }
    if (typeof v === "number") { need(Number.isSafeInteger(v), "native_number"); return String(v); }
    if (typeof v === "string") { size += v.length; need(size <= 524288 && /^[\x20-\x7e]*$/.test(v), "native_ascii"); return JSON.stringify(v); }
    if (v === null || typeof v === "boolean") return String(v);
    need(typeof v === "object" && v !== null && !types.isProxy(v) && !seen.has(v), "native_object");
    const array = Array.isArray(v), proto = Object.getPrototypeOf(v);
    need(proto === (array ? Array.prototype : Object.prototype) || proto === null, "native_prototype");
    seen.add(v); const desc = Object.getOwnPropertyDescriptors(v), keys = Reflect.ownKeys(desc);
    need(keys.every(k => typeof k === "string"), "native_key");
    const strings = (keys as string[]).filter(k => !array || k !== "length");
    for (const k of strings) { size += k.length; need(size <= 524288 && /^[\x20-\x7e]*$/.test(k) && "value" in desc[k] && desc[k].enumerable, "native_accessor"); }
    let output: string;
    if (array) {
      const length = desc.length.value as number;
      need(strings.length === length && strings.every(k => /^(0|[1-9][0-9]*)$/.test(k) && Number(k) < length), "native_array");
      output = "[" + Array.from({length}, (_, i) => encode(desc[String(i)].value, depth + 1)).join(",") + "]";
    } else output = "{" + strings.sort().map(k => JSON.stringify(k) + ":" + encode(desc[k].value, depth + 1)).join(",") + "}";
    seen.delete(v); return output;
  }
  return encode(value, 0);
}
/** Strict bounded ASCII integer JSON; duplicates, floats and unsafe coercion are refused. */
export function parseNativeJson(raw: string): unknown {
  return parseBoundedIntegerJson(raw, 65536);
}
/** Larger fixed metadata envelope, NOT a wider native challenge/admission wire. */
export function parseAccountedHelperJson(raw: string): unknown {
  return parseBoundedIntegerJson(raw, 262144);
}
function parseBoundedIntegerJson(raw: string, maximumBytes: number): unknown {
  need(typeof raw === "string" && raw.length <= maximumBytes && /^[\x09\x0a\x0d\x20-\x7e]*$/.test(raw), "native_json_bound");
  let i = 0, nodes = 0;
  const space = () => { while (/[\t\r\n ]/.test(raw[i] ?? "x")) i++; };
  function str(): string {
    const start = i++; let escaped = false;
    for (; i < raw.length; i++) {
      const c = raw[i];
      if (!escaped && c === '"') { const s: unknown = JSON.parse(raw.slice(start, ++i)); need(typeof s === "string" && /^[\x20-\x7e]*$/.test(s), "native_ascii"); return s; }
      if (!escaped && c === "\\") escaped = true; else escaped = false;
    }
    throw new Refusal("native_string");
  }
  function val(depth: number): unknown {
    space(); need(++nodes <= 2048 && depth <= 12, "native_json_bound");
    if (raw[i] === '"') return str();
    if (raw[i] === "{") {
      i++; space(); const out: Record<string, unknown> = Object.create(null);
      if (raw[i] === "}") { i++; return out; }
      for (;;) {
        space(); need(raw[i] === '"', "native_key"); const k = str();
        need(!Object.hasOwn(out, k), "native_duplicate"); space(); need(raw[i++] === ":", "native_colon");
        out[k] = val(depth + 1); space(); const end = raw[i++]; if (end === "}") return out; need(end === ",", "native_separator");
      }
    }
    if (raw[i] === "[") {
      i++; space(); const out: unknown[] = []; if (raw[i] === "]") { i++; return out; }
      for (;;) { out.push(val(depth + 1)); space(); const end = raw[i++]; if (end === "]") return out; need(end === ",", "native_separator"); }
    }
    const token = /^-?(?:0|[1-9][0-9]*)/.exec(raw.slice(i))?.[0];
    need(token && token.length <= 20, "native_integer"); i += token.length; return BigInt(token);
  }
  const value = val(0); space(); need(i === raw.length, "native_trailing"); return value;
}
function challengeFrom(raw: string): Challenge { return challengeSchema.parse(parseNativeJson(raw)); }
function nativeLimitsMatch(c: Challenge, r: Record<string, unknown>): void {
  const l = r.limits as Record<string, number>;
  for (const [native, policy] of [["memory_bytes", "chargedMemoryMaxBytes"], ["cpu_quota_us", "cpuQuotaMicros"], ["cpu_period_us", "cpuPeriodMicros"], ["pids_max", "tasksMax"]] as const) {
    need(c.limits[native] === BigInt(l[policy]), "limits_mismatch");
  }
}

/** Legacy R3 pure entrypoint. Live v2 callers must use an explicitly configured v2 issuer. */
export async function issueAccountedHostAdmission(rawAccepted: unknown, providers?: AccountedIssuerProviders): Promise<AccountedIssuerResult> {
  return issueWithConsumer(rawAccepted, providers, {manifestDigest: BROKKR_R3_MANIFEST, admissionVersion: 1});
}
/** Trusted owner configuration, never a consumer digest selected by the request.
 * No provider or authority is created by this pure function. A new consumer
 * release must be independently reviewed and explicitly accepted before use.
 */
export function createAccountedIssuerV2(consumerManifestDigest: string): (rawAccepted: unknown, providers?: AccountedIssuerProviders) => Promise<AccountedIssuerResult> {
  const manifestDigest = hex.parse(consumerManifestDigest);
  return (rawAccepted, providers) => issueWithConsumer(rawAccepted, providers, {manifestDigest, admissionVersion: 2});
}
async function issueWithConsumer(rawAccepted: unknown, providers: AccountedIssuerProviders | undefined,
  consumer: {manifestDigest: string; admissionVersion: 1 | 2}): Promise<AccountedIssuerResult> {
  let consumed = false, publicationStarted = false, persistencePending = false, admissionDigest: string | null = null;
  let stage: AccountedIssuerResult["stage"] = "providers";
  const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
  const result = (status: AccountedIssuerResult["status"], reason: string): AccountedIssuerResult => ({status, reason, stage, offlineOnly: true, executionAuthorized: false, attemptConsumed: consumed, admissionDigest});
  try {
    need(providers && typeof providers.clock === "function" && typeof providers.readChallenge === "function"
      && typeof providers.collect === "function" && typeof providers.verifyHostEvidence === "function"
      && typeof providers.verifyOwnerEvidence === "function" && providers.persistence
      && typeof providers.persistence.reserve === "function" && typeof providers.persistence.commit === "function"
      && typeof providers.persistence.publish === "function", "providers_unavailable");
    stage = "accepted";
    const p = providers, accepted = acceptedSchema.parse(copy(rawAccepted));
    need(accepted.brokkrManifestDigest === consumer.manifestDigest, "consumer_release_mismatch");
    const request = copy(accepted.request) as Record<string, unknown>;
    need(digestAccountedRequest(request) === request.requestDigest && request.requestId === accepted.requestId
      && request.attemptId === accepted.policyAttemptId && request.actorUid === 1000, "request_binding");
    // R3 cannot enforce tighter payload/stop/runtime windows than its fixed20/5/30 implementation.
    need((request.workMaxSeconds as number) >= 20 && (request.stopMaxSeconds as number) >= 5
      && (request.totalMaxSeconds as number) >= 30, "unsupported_native_timing");
    const clock = (): {boot: bigint; utc: string} => { const c = copy(p.clock()) as IssuerClock; utcMicros(c.utc); return {boot: BigInt(ns.parse(c.boottimeNs)), utc: c.utc}; };
    const start = clock(), ownerDeadline = BigInt(accepted.deadlineBoottimeNs);
    need(BigInt(accepted.maxEvidenceAgeNs) > 0n && BigInt(accepted.maxEvidenceAgeNs) <= 5000000000n, "freshness_bound");
    need(start.boot < ownerDeadline, "owner_expired");
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Refusal("operation_timeout")); }, 5000); });
    const run = <T>(operation: Promise<T>) => Promise.race([operation, timeout]);
    let previous = start.boot;
    const checkClock = () => {
      const c = clock(); need(c.boot >= previous && c.boot < start.boot + 5000000000n && c.boot < ownerDeadline, "clock_or_deadline");
      const delta = utcMicros(c.utc) - utcMicros(start.utc) - floorMicros(c.boot - start.boot);
      need(delta >= -1n && delta <= 1n, "clock_bridge_drift"); previous = c.boot; return c;
    };
    stage = "challenge";
    const challenge = challengeFrom(await run(p.readChallenge(controller.signal)));
    need(challenge.attempt_id === accepted.nativeAttemptId && challenge.unit === `brokkr-accounted-eval-${accepted.nativeAttemptId}.service`
      && challenge.identity.cgroup_path === `/system.slice/${challenge.unit}` && challenge.source_revision === accepted.sourceRevision
      && challenge.release_id === accepted.releaseId && challenge.config_digest === accepted.configDigest
      && challenge.descriptor_digest === accepted.descriptorDigest, "challenge_binding");
    nativeLimitsMatch(challenge, request);
    const current = checkClock();
    need(challenge.observed_boottime_ns <= current.boot && current.boot - challenge.observed_boottime_ns < 5000000000n, "challenge_stale");
    const expectation = Object.freeze({challengeDigest: sha(canonicalNative(challenge)), requestDigest: request.requestDigest as string,
      nativeAttemptId: accepted.nativeAttemptId, requestId: accepted.requestId, policyAttemptId: accepted.policyAttemptId, issuerReleaseDigest: accepted.issuerReleaseDigest});
    // Any ambiguous reservation result is consumed. No finally block deletes/rearms state.
    consumed = true;
    stage = "reserve";
    persistencePending = true;
    const reservation = await run(p.persistence.reserve(expectation, controller.signal));
    persistencePending = false;
    need(reservation && typeof reservation.reservationId === "string" && /^[0-9a-f]{64}$/.test(reservation.reservationId)
      && Object.keys(expectation).every(k => reservation[k as keyof IssuerExpectation] === expectation[k as keyof IssuerExpectation]), "attempt_consumed_or_reservation_invalid");
    const reserved = Object.freeze({...expectation, reservationId: reservation.reservationId});
    function verify(envelope: unknown): {host: VerifiedHost; replay: ReplayCommit; freshUntilNs: bigint} {
      const host = verifiedHostSchema.parse(copy(p.verifyHostEvidence(envelope, expectation)));
      need(host.challengeDigest === expectation.challengeDigest && host.requestDigest === expectation.requestDigest
        && host.issuerReleaseDigest === accepted.issuerReleaseDigest && canonicalNative(identitySchema.parse(parseNativeJson(host.nativeIdentityJson))) === canonicalNative(challenge.identity), "host_binding");
      const c = checkClock(), observed = BigInt(host.observedBoottimeNs);
      need(observed >= challenge.observed_boottime_ns && observed <= c.boot && c.boot - observed <= BigInt(accepted.maxEvidenceAgeNs)
        && BigInt(host.expiresBoottimeNs) > c.boot, "host_evidence_stale");
      const components = new Set(host.shared.map(v => v.component));
      need(components.size === 6 && SHARED_COMPONENTS.every(s => components.has(s)), "coverage_incomplete");
      const limits = request.limits as Record<string, number>;
      need(host.swapMaxBytes === limits.swapMaxBytes && host.addressSpaceLimitBytes === limits.addressSpaceLimitBytes
        && host.firstChargedInstructionDigest === request.firstChargedInstructionDigest, "unproved_policy_limit_or_boundary");
      const context = copy(host.ownerContext) as Record<string, unknown>;
      need(context.phase === "admission" && context.hostBootIdSha256 === sha(challenge.identity.boot_id)
        && context.expectedNonceSha256 === expectation.challengeDigest, "owner_clock_or_native_binding");
      // now is the trusted issuer's evaluation clock, not the evidence's earlier sample time.
      context.now = c.utc; context.nowMonotonicMicros = Number(c.boot / 1000n);
      need(host.wholeTaskMaxSeconds <= (request.totalMaxSeconds as number)
        && c.boot + BigInt(host.wholeTaskMaxSeconds) * 1000000000n <= ownerDeadline
        && c.boot + BigInt(host.wholeTaskMaxSeconds) * 1000000000n <= BigInt(host.expiresBoottimeNs)
        && utcMicros(c.utc) + BigInt(host.wholeTaskMaxSeconds) * 1000000n <= utcMicros(request.deadline)
        && utcMicros(c.utc) + BigInt(host.wholeTaskMaxSeconds) * 1000000n <= utcMicros(context.expiresAt), "whole_task_window_unproved");
      const verifiedOwner = copy(p.verifyOwnerEvidence(host.ownerEnvelope, Object.freeze({issuerId: context.issuerId as string, requestDigest: expectation.requestDigest, phase: "admission"})));
      const decision = evaluateAccountedHostPolicyAdapter(request, host.ownerEnvelope, context, () => verifiedOwner);
      need(decision.compatible && decision.replayCommit, "policy_refused");
      const ownerBody = (verifiedOwner as {body: {observedMonotonicMicros: number; observedAt: string; policyInput: {plan: {observationMaxAgeMs: number}}}}).body;
      need(BigInt(ownerBody.observedMonotonicMicros) === observed / 1000n
        && utcMicros(ownerBody.observedAt) === utcMicros(start.utc) + floorMicros(observed - start.boot), "observation_clock_unbound");
      const ownerAgeUs = BigInt(context.maxEvidenceAgeMicros as number), policyAgeUs = BigInt(ownerBody.policyInput.plan.observationMaxAgeMs) * 1000n;
      const freshUntilNs = [observed + BigInt(accepted.maxEvidenceAgeNs),
        (BigInt(ownerBody.observedMonotonicMicros) + ownerAgeUs) * 1000n,
        start.boot + (utcMicros(ownerBody.observedAt) + ownerAgeUs - utcMicros(start.utc)) * 1000n,
        start.boot + (utcMicros(ownerBody.observedAt) + policyAgeUs - utcMicros(start.utc)) * 1000n]
        .reduce((a, b) => a < b ? a : b);
      return {host, replay: decision.replayCommit, freshUntilNs};
    }
    stage = "evidence";
    const first = verify(await run(p.collect(expectation, controller.signal)));
    const last = verify(await run(p.collect(expectation, controller.signal)));
    // Fresh timestamps may advance; binding/allocation/coverage must not change during collection.
    const stable = (v: VerifiedHost) => digestAccountedOwnerEvidence({nativeIdentityJson: canonicalNative(parseNativeJson(v.nativeIdentityJson)), shared: [...v.shared].sort((a,b) => a.component < b.component ? -1 : 1), swapMaxBytes: v.swapMaxBytes, addressSpaceLimitBytes: v.addressSpaceLimitBytes, wholeTaskMaxSeconds: v.wholeTaskMaxSeconds, firstChargedInstructionDigest: v.firstChargedInstructionDigest});
    need(stable(first.host) === stable(last.host) && first.replay.expectedStateDigest === last.replay.expectedStateDigest, "observation_drift");
    const issueClock = checkClock(), issued = issueClock.boot, expires = issued + 35000000000n;
    need(expires <= ownerDeadline && expires <= BigInt(last.host.expiresBoottimeNs), "insufficient_authorized_window");
    const ownerContext = last.host.ownerContext as Record<string, unknown>;
    need(utcMicros(issueClock.utc) + 35000000n <= utcMicros(request.deadline)
      && utcMicros(issueClock.utc) + 35000000n <= utcMicros(ownerContext.expiresAt), "utc_window_too_short");
    // Compute before durable commit, so the persisted digest includes the exact
    // strict v2 consumer deadline. No later deadline extension/re-encoding.
    const publicationDeadline = [challenge.observed_boottime_ns + 5000000000n, start.boot + 5000000000n,
      last.freshUntilNs, ownerDeadline, expires - 30000000000n]
      .reduce((a, b) => a < b ? a : b);
    const native = {version: BigInt(consumer.admissionVersion), attempt_id: accepted.nativeAttemptId, config_digest: accepted.configDigest,
      descriptor_digest: accepted.descriptorDigest, boot_id: challenge.identity.boot_id, invocation_id: challenge.identity.invocation_id,
      cgroup_device: challenge.identity.cgroup_device, cgroup_inode: challenge.identity.cgroup_inode,
      namespace_inodes: challenge.identity.namespace_inodes, issued_boottime_ns: issued, expires_boottime_ns: expires,
      limits: challenge.limits, coverage: {owned_cgroup: challenge.identity.cgroup_path, shared: last.host.shared},
      protected_manifest_digest: request.protectedManifestDigest, issuer_release_digest: accepted.issuerReleaseDigest,
      ...(consumer.admissionVersion === 2 ? {publication_deadline_boottime_ns: publicationDeadline} : {})};
    const bytes = canonicalNative(native); admissionDigest = sha(bytes);
    stage = "commit";
    persistencePending = true;
    const committed = await run(p.persistence.commit(reserved, Object.freeze({...last.replay}), admissionDigest, controller.signal));
    persistencePending = false; need(committed, "replay_commit_refused");
    const publishClock = checkClock();
    need(publishClock.boot < challenge.observed_boottime_ns + 5000000000n && publishClock.boot - issued <= 5000000000n
      && expires - publishClock.boot >= 30000000000n, "publication_late");
    need(publishClock.boot < last.freshUntilNs, "publication_evidence_stale");
    need(publishClock.boot < publicationDeadline, "publication_late");
    stage = "publish";
    publicationStarted = true;
    await run(p.persistence.publish(reserved, bytes, publicationDeadline.toString(), controller.signal));
    need(checkClock().boot < publicationDeadline, "publication_ack_late");
    return result("published", "provider_publication_acknowledged");
  } catch (error) {
    return result(publicationStarted || persistencePending ? "unknown" : "refused", error instanceof Refusal ? error.code : error instanceof z.ZodError ? "invalid_input_or_evidence" : "issuer_dependency_failed");
  } finally { if (timer) clearTimeout(timer); controller.abort(); }
}
