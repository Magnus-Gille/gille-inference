import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  ACCOUNTED_DESCRIPTOR, BROKKR_R3_MANIFEST, SHARED_COMPONENTS, canonicalNative, parseNativeJson,
  createAccountedIssuerPersistence, issueAccountedHostAdmission, createAccountedIssuerV2,
  type AccountedIssuerProviders, type IssuerDurableStorage,
} from "../src/homeserver/accounted-host-issuer.js";
import { digestAccountedRequest, digestAccountedOwnerEvidence } from "../src/homeserver/accounted-host-policy-adapter.js";
import { digestOwnerAllocation } from "../contracts/accounted-host-policy-v1/accounted-host-policy.mjs";
import { main as issuerMain } from "../scripts/accounted-host-issuer.js";
const H = (x: string) => x.repeat(64);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const NOW = "2030-01-01T00:00:00.000000Z", END = "2030-01-01T00:01:00.000000Z";
const BOOT = 9007199254740993n; // Explicitly exceeds JavaScript's safe integer nanoseconds.

/** Every value/provider/storage in this file is SYNTHETIC, never a host attestation. */
function fixture() {
  const input = JSON.parse(readFileSync(new URL("../contracts/accounted-host-policy-v1/examples/positive-input.json", import.meta.url), "utf8"));
  Object.assign(input.plan.ownerAllocation, {chargedMemoryMaxBytes: 67108864, cpuQuotaMicros: 10000, cpuPeriodMicros: 100000, tasksMax: 16, addressSpaceLimitBytes: 134217728});
  input.plan.ownerAllocation.digest = digestOwnerAllocation(input.plan.ownerAllocation);
  Object.assign(input.plan.bindings, {deadline: END, ownerAllocationDigest: input.plan.ownerAllocation.digest});
  const {digest: _digest, ...limits} = input.plan.ownerAllocation;
  const request = {schemaVersion: 1, laneId: input.plan.laneId, ...input.plan.bindings, limits, workMaxSeconds: 20, stopMaxSeconds: 5, totalMaxSeconds: 90};
  request.requestDigest = digestAccountedRequest(request); input.plan.bindings.requestDigest = request.requestDigest;
  input.observation.bindings = structuredClone(input.plan.bindings);
  input.observation.ownerAllocation = structuredClone(input.plan.ownerAllocation); input.observation.observedAt = NOW;
  const nativeAttempt = "a".repeat(32), identity = {
    boot_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", invocation_id: "b".repeat(32), cgroup_device: 27n, cgroup_inode: BOOT + 1n,
    cgroup_path: `/system.slice/brokkr-accounted-eval-${nativeAttempt}.service`, namespace_inodes: {mnt: 12n, net: 13n, ipc: 14n, pid: 15n},
  };
  const challenge = {version: 1n, attempt_id: nativeAttempt, unit: `brokkr-accounted-eval-${nativeAttempt}.service`, source_revision: "c".repeat(40), release_id: H("d"), config_digest: H("e"), descriptor_digest: ACCOUNTED_DESCRIPTOR,
    identity, limits: {memory_bytes: 67108864n, cpu_quota_us: 10000n, cpu_period_us: 100000n, pids_max: 16n}, observed_boottime_ns: BOOT};
  const challengeDigest = sha(canonicalNative(challenge));
  const accepted = {version: 1, brokkrManifestDigest: BROKKR_R3_MANIFEST, nativeAttemptId: nativeAttempt, requestId: request.requestId, policyAttemptId: request.attemptId,
    sourceRevision: challenge.source_revision, releaseId: challenge.release_id, configDigest: challenge.config_digest,
    descriptorDigest: ACCOUNTED_DESCRIPTOR, issuerReleaseDigest: H("f"), deadlineBoottimeNs: (BOOT + 60000000000n).toString(), maxEvidenceAgeNs: "5000000000", request};
  const body = {schemaVersion: 1, source: "owner-issued-accounted-policy-v1", phase: "admission", issuerId: "fixture-owner", hostId: request.hostId, actorUid: 1000,
    hostBootIdSha256: sha(identity.boot_id), observerInstanceSha256: H("2"), nonceSha256: challengeDigest, sequence: 1,
    observedAt: NOW, observedMonotonicMicros: Number(BOOT / 1000n), policyInput: input};
  const context = {schemaVersion: 1, phase: "admission", issuerId: body.issuerId, hostId: request.hostId, actorUid: 1000, hostBootIdSha256: body.hostBootIdSha256,
    observerInstanceSha256: body.observerInstanceSha256, expectedNonceSha256: challengeDigest, expectedSequence: 1, lastSequence: 0,
    seenEvidenceDigests: [], seenAttempts: [], now: NOW, nowMonotonicMicros: body.observedMonotonicMicros, maxEvidenceAgeMicros: 5000000, expiresAt: END,
    expectedRequestDigest: request.requestDigest, acceptedPolicy: {artifactSha256: request.artifactSha256, protectedManifestDigest: request.protectedManifestDigest, ownerAllocationDigest: request.ownerAllocationDigest,
      firstChargedInstructionDigest: request.firstChargedInstructionDigest, controlPlaneAccountingDigest: request.controlPlaneAccountingDigest}, baselineDigest: null};
  const host = {state: "verified", challengeDigest, requestDigest: request.requestDigest, issuerReleaseDigest: accepted.issuerReleaseDigest, nativeIdentityJson: canonicalNative(identity), observedBoottimeNs: BOOT.toString(), expiresBoottimeNs: accepted.deadlineBoottimeNs,
    swapMaxBytes: 0, addressSpaceLimitBytes: limits.addressSpaceLimitBytes, wholeTaskMaxSeconds: 45, firstChargedInstructionDigest: request.firstChargedInstructionDigest,
    shared: SHARED_COMPONENTS.map((component, i) => ({component, accounting_record_digest: H(String(i)), allocation_record_digest: H(String(i + 1))})), ownerEnvelope: {synthetic: true}, ownerContext: context};
  let state: any = {schemaVersion: 1, hostBootIdSha256: body.hostBootIdSha256, observerInstanceSha256: body.observerInstanceSha256, lastSequence: 0, seenEvidenceDigests: [], seenAttempts: [], claims: []};
  const publications = new Map<string, string>(); let casCount = 0;
  const storage: IssuerDurableStorage = {
    async read(signal) { signal.throwIfAborted(); return {version: sha(canonicalNative(state)), state: structuredClone(state)}; },
    async compareAndSwap(version, next, signal) { signal.throwIfAborted(); if (version !== sha(canonicalNative(state))) return false; state = structuredClone(next); casCount++; return true; },
    async publishOnce(attempt, bytes, _deadline, signal) { signal.throwIfAborted(); if (publications.has(attempt)) throw new Error("exists"); publications.set(attempt, bytes); },
  };
  const f = {input, request, accepted, challenge, identity, host, body, context, storage, publications, boot: BOOT, utc: NOW,
    state: () => structuredClone(state), casCount: () => casCount};
  const providers: AccountedIssuerProviders = {
    clock: () => ({boottimeNs: f.boot.toString(), utc: f.utc}), readChallenge: async () => canonicalNative(challenge),
    collect: async () => ({opaque: "SYNTHETIC"}), verifyHostEvidence: () => host,
    verifyOwnerEvidence: () => ({state: "verified", body, bodyDigest: digestAccountedOwnerEvidence(body)}), persistence: createAccountedIssuerPersistence(storage),
  };
  return {...f, providers, setClock: (boot: bigint, utc = NOW) => {f.boot = boot; f.utc = utc;}};
}
const issue = (f: ReturnType<typeof fixture>) => issueAccountedHostAdmission(f.accepted, f.providers);
describe("strict consumer v2; no fallback to legacy admission", () => {
  const consumer = H("8");
  it("binds the actual configured source manifest and persists the exact consumer deadline", async () => {
    const f = fixture(); f.accepted.brokkrManifestDigest = consumer; f.accepted.maxEvidenceAgeNs = "1000000";
    expect((await createAccountedIssuerV2(consumer)(f.accepted, f.providers)).status).toBe("published");
    const raw = f.publications.get(f.accepted.nativeAttemptId)!;
    const admission: any = parseNativeJson(raw);
    expect(admission.version).toBe(2n);
    expect(admission.publication_deadline_boottime_ns).toBe(BOOT + 1000000n);
    expect(f.state().claims[0].admissionDigest).toBe(sha(raw));
  });
  it("does not accept a request-selected different manifest or fall back to R3", async () => {
    for (const manifest of [BROKKR_R3_MANIFEST, H("7")]) {
      const f = fixture(); f.accepted.brokkrManifestDigest = manifest;
      expect(await createAccountedIssuerV2(consumer)(f.accepted, f.providers)).toMatchObject({status:"refused", attemptConsumed:false});
      expect(f.publications.size).toBe(0);
    }
  });
  it("requires a concrete trusted digest before configuring a v2 issuer", () => {
    for (const digest of ["", "x".repeat(64), consumer+"\n", undefined]) {
      expect(() => createAccountedIssuerV2(digest as string)).toThrow();
    }
  });
  it("late durable commit cannot expose a fresh-looking v2 admission", async () => {
    const f = fixture(); f.accepted.brokkrManifestDigest = consumer; f.accepted.maxEvidenceAgeNs = "1000000";
    const original = f.storage.compareAndSwap;
    let calls = 0;
    f.storage.compareAndSwap = async (...args) => {
      const result = await original(...args);
      if (++calls === 2) f.setClock(BOOT+1000000n, "2030-01-01T00:00:00.001000Z");
      return result;
    };
    expect(await createAccountedIssuerV2(consumer)(f.accepted, f.providers)).toMatchObject({status:"refused", attemptConsumed:true});
    expect(f.publications.size).toBe(0);
  });
});
function rebind(f: ReturnType<typeof fixture>) {
  f.request.requestDigest = digestAccountedRequest(f.request); f.input.plan.bindings.requestDigest = f.request.requestDigest;
  f.input.observation.bindings = structuredClone(f.input.plan.bindings); f.context.expectedRequestDigest = f.request.requestDigest; f.host.requestDigest = f.request.requestDigest;
}
describe("LOCAL issuer; no live providers or authority", () => {
  it("refuses with no providers and invokes nothing", async () => {
    expect(await issueAccountedHostAdmission({})).toMatchObject({status: "refused", reason: "providers_unavailable", attemptConsumed: false, executionAuthorized: false});
  });
  it("CLI remains closed without collecting facts, accepting JSON providers or initializing state", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {expect(await issuerMain()).toBe(2); expect(JSON.parse(String(write.mock.calls[0][0]))).toMatchObject({reason: "providers_unavailable", attemptConsumed: false, executionAuthorized: false});}
    finally {write.mockRestore();}
  });
  it("projects synthetic verified evidence exactly to R3; preserves distinct native/policy IDs and >2^53 integers", async () => {
    const f = fixture(), r = await issue(f); expect(r.status).toBe("published"); expect(r.offlineOnly).toBe(true); expect(r.executionAuthorized).toBe(false);
    const raw = f.publications.get(f.accepted.nativeAttemptId)!;
    const record: any = parseNativeJson(raw);
    expect(record.cgroup_inode).toBe(BOOT + 1n); expect(record.issued_boottime_ns).toBe(BOOT); expect(record.expires_boottime_ns).toBe(BOOT + 35000000000n);
    expect(record.attempt_id).toBe(f.accepted.nativeAttemptId); expect(record.attempt_id).not.toBe(f.request.attemptId);
    expect(Object.keys(record).sort()).toEqual(["version","attempt_id","config_digest","descriptor_digest","boot_id","invocation_id","cgroup_device","cgroup_inode","issued_boottime_ns","expires_boottime_ns","limits","coverage","protected_manifest_digest","issuer_release_digest","namespace_inodes"].sort());
    expect(f.state().lastSequence).toBe(1); expect(f.state().claims[0].committed).toBe(true); expect(f.casCount()).toBe(2);
    expect(r.admissionDigest).toBe(sha(raw));
  });
  it("refuses the replay even through a fresh journal instance", async () => {
    const f = fixture(); expect((await issue(f)).status).toBe("published");
    f.providers.persistence = createAccountedIssuerPersistence(f.storage);
    expect((await issue(f)).status).toBe("refused"); expect(f.publications.size).toBe(1); expect(f.state().lastSequence).toBe(1);
  });
  it("refuses requested time ceilings below R3's actual20/5/30 before consuming", async () => {
    const f = fixture(); Object.assign(f.request, {workMaxSeconds: 1, stopMaxSeconds: 1, totalMaxSeconds: 2}); rebind(f);
    expect(await issue(f)).toMatchObject({status: "refused", attemptConsumed: false}); expect(f.publications.size).toBe(0);
  });
  it("requires actual whole-task lifetime rather than only R3's30second runtime", async () => {
    const f = fixture(); f.request.totalMaxSeconds = 40; rebind(f);
    expect((await issue(f)).status).toBe("refused"); expect(f.publications.size).toBe(0);
  });
  it("missing independently verified whole-task lifetime fails closed", async () => {
    const f = fixture(); delete (f.host as any).wholeTaskMaxSeconds;
    expect((await issue(f)).status).toBe("refused"); expect(f.publications.size).toBe(0);
  });
  it("uses the issuer's current trusted clock when collection has taken time", async () => {
    const f = fixture(); f.providers.collect = async () => {f.setClock(BOOT + 1000n, "2030-01-01T00:00:00.000001Z"); return {};};
    expect((await issue(f)).status).toBe("published");
  });
  it("concurrent issuers cannot both consume/publish the same attempt", async () => {
    const f = fixture(); const rs = await Promise.all([issue(f), issue(f)]);
    expect(rs.filter(r => r.status === "published")).toHaveLength(1); expect(f.publications.size).toBe(1);
  });
  it("passes the strictest freshness deadline through to atomic publication", async () => {
    const f = fixture(), original = f.storage.publishOnce; let deadline = "";
    f.accepted.maxEvidenceAgeNs = "1000000";
    f.storage.publishOnce = async (...args) => {deadline = args[2]; return original(...args);};
    expect((await issue(f)).status).toBe("published"); expect(deadline).toBe((BOOT + 1000000n).toString());
  });
  it("late publication acknowledgement stays unknown even if bytes were published", async () => {
    const f = fixture(), original = f.storage.publishOnce;
    f.accepted.maxEvidenceAgeNs = "1000000";
    f.storage.publishOnce = async (...args) => {await original(...args); f.setClock(BOOT + 1000000n, "2030-01-01T00:00:00.001000Z");};
    expect((await issue(f)).status).toBe("unknown"); expect(f.publications.size).toBe(1); expect(f.state().lastSequence).toBe(1);
  });
  it("a consumed native ID cannot be relabelled as another policy attempt", async () => {
    const f = fixture(); expect((await issue(f)).status).toBe("published");
    const p = createAccountedIssuerPersistence(f.storage), binding = {...f.state().claims[0]};
    delete binding.reservationId; delete binding.committed; delete binding.admissionDigest;
    binding.policyAttemptId = "99999999-9999-4999-8999-999999999999";
    expect(await p.reserve(binding, new AbortController().signal)).toBeNull();
  });
  it.each(["nativeAttemptId", "requestId", "policyAttemptId", "descriptorDigest", "brokkrManifestDigest", "sourceRevision", "configDigest", "releaseId"])("rejects accepted %s mismatch before publication", async key => {
    const f = fixture(); (f.accepted as any)[key] = key.endsWith("Id") ? "9".repeat(32) : H("9");
    expect((await issue(f)).status).toBe("refused"); expect(f.publications.size).toBe(0);
  });
  it.each(["boot_id", "invocation_id", "cgroup_inode", "namespace_inodes"])("rejects changed independently verified %s", async key => {
    const f = fixture(), id: any = structuredClone(f.identity);
    id[key] = key === "cgroup_inode" ? 999n : key === "namespace_inodes" ? {...id[key], mnt: 999n} : "d".repeat(32);
    f.host.nativeIdentityJson = canonicalNative(id); expect((await issue(f)).status).toBe("refused"); expect(f.publications.size).toBe(0);
  });
  it.each(["addressSpaceLimitBytes", "swapMaxBytes", "firstChargedInstructionDigest"])("never fills missing policy fact %s from a native default", async key => {
    const f = fixture(); delete (f.host as any)[key]; expect((await issue(f)).status).toBe("refused"); expect(f.publications.size).toBe(0);
  });
  it.each(SHARED_COMPONENTS)("refuses missing %s coverage", async name => {
    const f = fixture(); f.host.shared = f.host.shared.filter(r => r.component !== name); expect((await issue(f)).status).toBe("refused"); expect(f.publications.size).toBe(0);
  });
  it("refuses duplicate coverage even when list length remains six", async () => {
    const f = fixture(); f.host.shared[5] = f.host.shared[0]; expect((await issue(f)).reason).toBe("coverage_incomplete");
  });
  it.each(["oom", "busy", "maintenance", "allocation"])("refuses policy %s drift and permanently consumes the attempt", async kind => {
    const f = fixture();
    if (kind === "oom") f.input.observation.oomCounters.host++;
    if (kind === "busy") f.input.observation.work.gateway.active++;
    if (kind === "maintenance") f.input.observation.maintenance.active = true;
    if (kind === "allocation") f.input.observation.ownerAllocation.tasksMax++;
    expect((await issue(f)).status).toBe("refused"); expect(f.publications.size).toBe(0); expect(f.state().claims).toHaveLength(1);
    f.input.observation.maintenance.active = false; expect((await issue(f)).status).toBe("refused");
  });
  it("refuses two independently valid collections whose external accounting changed", async () => {
    const f = fixture(); let calls = 0;
    f.providers.collect = async () => {if (++calls === 2) f.host.shared[0].accounting_record_digest = H("9"); return {};};
    expect((await issue(f)).reason).toBe("observation_drift"); expect(f.publications.size).toBe(0);
  });
  it("refuses an expired/future host proof", async () => {
    const f = fixture(); f.host.observedBoottimeNs = (BOOT + 1n).toString(); expect((await issue(f)).reason).toBe("host_evidence_stale");
  });
  it("refuses a challenge at the strict five second boundary", async () => {
    const f = fixture(); f.challenge.observed_boottime_ns = BOOT - 5000000000n; expect((await issue(f)).reason).toBe("challenge_stale");
  });
  it("bounds hung providers, consumes ambiguous reservation, and never schedules publication", async () => {
    vi.useFakeTimers(); try {
      const f = fixture(); f.providers.persistence.reserve = () => new Promise(() => {});
      const pending = issue(f); await vi.advanceTimersByTimeAsync(5001);
      expect(await pending).toMatchObject({status: "unknown", attemptConsumed: true}); expect(f.publications.size).toBe(0);
    } finally {vi.useRealTimers();}
  });
  it("lost publication acknowledgement is UNKNOWN and does not permit replay", async () => {
    const f = fixture(), original = f.storage.publishOnce;
    f.storage.publishOnce = async (...a) => {await original(...a); throw new Error("lost receipt");};
    expect((await issue(f)).status).toBe("unknown"); expect(f.publications.size).toBe(1);
    expect((await issue(f)).status).toBe("refused");
  });
  it("does not publish after a failed durable CAS", async () => {
    const f = fixture(), original = f.storage.compareAndSwap; let calls = 0;
    f.storage.compareAndSwap = async (...a) => ++calls === 2 ? false : original(...a);
    expect((await issue(f)).reason).toBe("replay_commit_refused"); expect(f.publications.size).toBe(0); expect(f.state().claims).toHaveLength(1);
  });
  it("rechecks evidence freshness after a slow durable commit before publication", async () => {
    const f = fixture(), original = f.storage.compareAndSwap; let calls = 0;
    f.accepted.maxEvidenceAgeNs = "1000000";
    f.storage.compareAndSwap = async (...args) => {
      const result = await original(...args);
      if (++calls === 2) f.setClock(BOOT + 2000000n, "2030-01-01T00:00:00.002000Z");
      return result;
    };
    expect((await issue(f)).status).toBe("refused"); expect(f.publications.size).toBe(0);
    expect(f.state().claims[0].committed).toBe(true); // Durable consumption is never rolled back.
  });
  it.each(["owner", "policy"])("preserves the stricter %s evidence window after durable commit", async source => {
    const f = fixture(), original = f.storage.compareAndSwap; let calls = 0;
    if (source === "owner") {f.context.maxEvidenceAgeMicros = 1000; f.input.plan.observationMaxAgeMs = 1;}
    else f.input.plan.observationMaxAgeMs = 1;
    f.storage.compareAndSwap = async (...args) => {
      const result = await original(...args);
      if (++calls === 2) f.setClock(BOOT + 2000000n, "2030-01-01T00:00:00.002000Z");
      return result;
    };
    expect((await issue(f)).status).toBe("refused"); expect(f.publications.size).toBe(0);
  });
  it("unknown commit outcome keeps consumed state and does not publish", async () => {
    const f = fixture(), original = f.storage.compareAndSwap; let calls = 0;
    f.storage.compareAndSwap = async (...a) => {const r = await original(...a); if (++calls === 2) throw new Error("lost CAS receipt"); return r;};
    expect((await issue(f)).status).toBe("unknown"); expect(f.publications.size).toBe(0); expect(f.state().lastSequence).toBe(1);
  });
  it("does not initialize a missing durable journal", async () => {
    const f = fixture(); f.storage.read = async () => {throw new Error("missing");};
    expect((await issue(f)).status).toBe("unknown"); expect(f.publications.size).toBe(0);
  });
  it("bounds the native TTL by the owner's actual UTC authorization", async () => {
    const f = fixture(); f.request.deadline = "2030-01-01T00:00:30.000000Z";
    f.request.requestDigest = digestAccountedRequest(f.request); Object.assign(f.input.plan.bindings, {deadline: f.request.deadline, requestDigest: f.request.requestDigest});
    f.input.observation.bindings = structuredClone(f.input.plan.bindings); f.context.expectedRequestDigest = f.request.requestDigest; f.host.requestDigest = f.request.requestDigest;
    expect((await issue(f)).reason).toBe("whole_task_window_unproved"); expect(f.publications.size).toBe(0);
  });
  it("refuses unsafe numeric/coercing inputs without invoking getters/proxies", async () => {
    const f = fixture(); let traps = 0; f.accepted.request = new Proxy(f.request, {ownKeys(){traps++;return [];}});
    expect((await issue(f)).status).toBe("refused"); expect(traps).toBe(0);
    const bad = fixture(); Object.defineProperty(bad.accepted, "request", {get(){traps++;return bad.request;}});
    expect((await issue(bad)).status).toBe("refused"); expect(traps).toBe(0);
  });
});
describe("lossless native JSON boundary", () => {
  it("canonicalization never invokes accessors or proxy traps", () => {
    let hits = 0; const getter = {get value(){hits++;return 1;}};
    expect(() => canonicalNative(getter)).toThrow(); expect(hits).toBe(0);
    expect(() => canonicalNative(new Proxy({}, {ownKeys(){hits++;return [];}}))).toThrow(); expect(hits).toBe(0);
  });
  it.each(['{"a":1,"a":2}', '{"n":1e3}', '{"n":1.2}', '{"n":01}', '{"n":NaN}', '{"n":true}', '{"n":null}', '{"n":922337203685477580800}', '"\\u00e4"', '{"a":1} trailing', ' '.repeat(65537)].map((raw, index) => ({raw, index})))("refuses malformed or nonnative JSON case $index", ({raw}) => {
    expect(() => parseNativeJson(raw)).toThrow();
  });
  it("keeps exact large integers through decode/canonicalization", () => {
    const raw = '{"inode":9007199254740993,"ns":9223372036854775807}';
    expect(canonicalNative(parseNativeJson(raw))).toBe(raw);
  });
});
