import { describe, expect, it } from "vitest";
import { digestAccountedBaseline, digestAccountedRequest, digestAccountedOwnerEvidence, evaluateAccountedHostPolicyAdapter } from "../src/homeserver/accounted-host-policy-adapter.js";
// Frozen content-free shared fixture from Accounted manifest4bfff37a…, not live host facts.
const sharedRequest = {
  "actorUid": 1000,
  "artifactSha256": "56261f97e54b7aacd59eb1324e9b9888c88eaeeef7bda092f7bede3a4685545e",
  "attemptId": "22222222-2222-4222-8222-222222222222",
  "controlPlaneAccountingDigest": "c33ee0d90380c6693c8ee9ddffd28ba59a465db001e7b0a5dabb53262f1cdd8e",
  "deadline": "2030-01-01T00:01:00.000001Z",
  "firstChargedInstructionDigest": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  "hostId": "m5",
  "laneId": "accounted-podman-info-v1",
  "limits": {
    "addressSpaceLimitBytes": 9007199254740991,
    "chargedMemoryMaxBytes": 536870912,
    "cpuPeriodMicros": 1000000,
    "cpuQuotaMicros": 12500,
    "swapMaxBytes": 0,
    "tasksMax": 64
  },
  "ownerAllocationDigest": "f207f1124be9a4f40e03d61a06401187d977e55e12778759c35d5b76bf006999",
  "protectedManifestDigest": "733194b4f9cee2cc7f309bd1c28785ecba3b3cd087ad5bc39e05f982ba8ed622",
  "requestDigest": "108f2feed361c38311fe0853e741260fc2eb909d0fd142bdaf2c877544dccbc1",
  "requestId": "11111111-1111-4111-8111-111111111111",
  "schemaVersion": 1,
  "stopMaxSeconds": 5,
  "totalMaxSeconds": 90,
  "workMaxSeconds": 20
};
const sharedInput = {
  "observation": {
    "bindings": {
      "actorUid": 1000,
      "artifactSha256": "56261f97e54b7aacd59eb1324e9b9888c88eaeeef7bda092f7bede3a4685545e",
      "attemptId": "22222222-2222-4222-8222-222222222222",
      "controlPlaneAccountingDigest": "c33ee0d90380c6693c8ee9ddffd28ba59a465db001e7b0a5dabb53262f1cdd8e",
      "deadline": "2030-01-01T00:01:00.000001Z",
      "firstChargedInstructionDigest": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      "hostId": "m5",
      "ownerAllocationDigest": "f207f1124be9a4f40e03d61a06401187d977e55e12778759c35d5b76bf006999",
      "protectedManifestDigest": "733194b4f9cee2cc7f309bd1c28785ecba3b3cd087ad5bc39e05f982ba8ed622",
      "requestDigest": "108f2feed361c38311fe0853e741260fc2eb909d0fd142bdaf2c877544dccbc1",
      "requestId": "11111111-1111-4111-8111-111111111111"
    },
    "controlPlaneAccounting": {
      "digest": "c33ee0d90380c6693c8ee9ddffd28ba59a465db001e7b0a5dabb53262f1cdd8e",
      "scope": "whole-task",
      "status": "complete"
    },
    "controls": {
      "gpuAccess": false,
      "localIpcDefined": true,
      "payloadIpNetwork": false
    },
    "coverage": {
      "completeBeforeFirstWork": true,
      "wholeTask": "complete"
    },
    "laneId": "accounted-podman-info-v1",
    "maintenance": {
      "active": false
    },
    "observedAt": "2030-01-01T00:00:00.000001Z",
    "oomCounters": {
      "host": 0,
      "services": [
        {
          "kills": 0,
          "unit": "example-core.service"
        }
      ]
    },
    "ownerAllocation": {
      "addressSpaceLimitBytes": 9007199254740991,
      "chargedMemoryMaxBytes": 536870912,
      "cpuPeriodMicros": 1000000,
      "cpuQuotaMicros": 12500,
      "digest": "f207f1124be9a4f40e03d61a06401187d977e55e12778759c35d5b76bf006999",
      "swapMaxBytes": 0,
      "tasksMax": 64
    },
    "protectedServices": [
      {
        "active": true,
        "invocationId": "44444444444444444444444444444444",
        "restarts": 0,
        "unit": "example-core.service"
      }
    ],
    "residency": {
      "models": [
        "example-model"
      ]
    },
    "schemaVersion": 1,
    "work": {
      "backend": {
        "active": 0,
        "coverage": "complete",
        "queued": 0
      },
      "gateway": {
        "active": 0,
        "leaseHeld": false,
        "queued": 0
      }
    }
  },
  "plan": {
    "bindings": {
      "actorUid": 1000,
      "artifactSha256": "56261f97e54b7aacd59eb1324e9b9888c88eaeeef7bda092f7bede3a4685545e",
      "attemptId": "22222222-2222-4222-8222-222222222222",
      "controlPlaneAccountingDigest": "c33ee0d90380c6693c8ee9ddffd28ba59a465db001e7b0a5dabb53262f1cdd8e",
      "deadline": "2030-01-01T00:01:00.000001Z",
      "firstChargedInstructionDigest": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      "hostId": "m5",
      "ownerAllocationDigest": "f207f1124be9a4f40e03d61a06401187d977e55e12778759c35d5b76bf006999",
      "protectedManifestDigest": "733194b4f9cee2cc7f309bd1c28785ecba3b3cd087ad5bc39e05f982ba8ed622",
      "requestDigest": "108f2feed361c38311fe0853e741260fc2eb909d0fd142bdaf2c877544dccbc1",
      "requestId": "11111111-1111-4111-8111-111111111111"
    },
    "controlPlaneAccounting": {
      "digest": "c33ee0d90380c6693c8ee9ddffd28ba59a465db001e7b0a5dabb53262f1cdd8e",
      "scope": "whole-task",
      "status": "complete"
    },
    "controls": {
      "gpuAccess": false,
      "localIpcDefined": true,
      "payloadIpNetwork": false
    },
    "coverage": {
      "completeBeforeFirstWork": true,
      "wholeTask": "complete"
    },
    "laneId": "accounted-podman-info-v1",
    "observationMaxAgeMs": 5000,
    "ownerAllocation": {
      "addressSpaceLimitBytes": 9007199254740991,
      "chargedMemoryMaxBytes": 536870912,
      "cpuPeriodMicros": 1000000,
      "cpuQuotaMicros": 12500,
      "digest": "f207f1124be9a4f40e03d61a06401187d977e55e12778759c35d5b76bf006999",
      "swapMaxBytes": 0,
      "tasksMax": 64
    },
    "residency": {
      "mode": "preserve",
      "models": [
        "example-model"
      ]
    },
    "schemaVersion": 1
  },
  "protectedManifest": {
    "digest": "733194b4f9cee2cc7f309bd1c28785ecba3b3cd087ad5bc39e05f982ba8ed622",
    "laneId": "accounted-podman-info-v1",
    "oomCounters": {
      "host": 0,
      "services": [
        {
          "kills": 0,
          "unit": "example-core.service"
        }
      ]
    },
    "residency": {
      "mode": "preserve",
      "models": [
        "example-model"
      ]
    },
    "schemaVersion": 1,
    "services": [
      {
        "active": true,
        "invocationId": "44444444444444444444444444444444",
        "restarts": 0,
        "unit": "example-core.service"
      }
    ]
  }
};

const H = (c: string) => c.repeat(64);
const NOW = "2030-01-01T00:00:00.000001Z";
function fixture() {
 const request = structuredClone(sharedRequest), input: typeof sharedInput & {baseline?: typeof sharedInput.observation} = structuredClone(sharedInput);
 const body = { schemaVersion: 1, source: "owner-issued-accounted-policy-v1", phase: "admission", issuerId: "fixture-owner", hostId: request.hostId, actorUid: 1000, hostBootIdSha256: H("1"), observerInstanceSha256: H("2"), nonceSha256: H("3"), sequence: 1, observedAt: input.observation.observedAt, observedMonotonicMicros: 1000000, policyInput: input };
 const context = { schemaVersion: 1, phase: "admission", issuerId: body.issuerId, hostId: request.hostId, actorUid: 1000, hostBootIdSha256: body.hostBootIdSha256, observerInstanceSha256: body.observerInstanceSha256, expectedNonceSha256: body.nonceSha256, expectedSequence: 1, lastSequence: 0, seenEvidenceDigests: [] as string[], seenAttempts: [] as {phase:string;requestId:string;attemptId:string}[], now: NOW, nowMonotonicMicros: 1000001, maxEvidenceAgeMicros: 5000000, expiresAt: "2030-01-01T00:02:00.000001Z", expectedRequestDigest: request.requestDigest, acceptedPolicy: { protectedManifestDigest: request.protectedManifestDigest, ownerAllocationDigest: request.ownerAllocationDigest, firstChargedInstructionDigest: request.firstChargedInstructionDigest, controlPlaneAccountingDigest: request.controlPlaneAccountingDigest, artifactSha256: request.artifactSha256 }, baselineDigest: null as string|null };
 const verified = () => ({state:"verified",body,bodyDigest:digestAccountedOwnerEvidence(body)});
 return {request,input,body,context,verified};
}
describe("Accounted trusted-input adapter (LOCAL synthetic only)", () => {
 it("maps the actual frozen shared fixture without altering R4 decision bytes", () => {
  const f=fixture(), result=evaluateAccountedHostPolicyAdapter(f.request,{opaque:"test-envelope"},f.context,f.verified);
  expect(result.compatible).toBe(true);
  expect(result.policyDecision?.decisionDigest).toBe("7c22637df6d62cb8cfddeb204a02a0e662320b6acac70361b817feb0dfe0baa7");
  expect(result.offlineOnly).toBe(true);expect(result.executionAuthorized).toBe(false);expect(result.requiresAtomicReplayCommit).toBe(true);
 });
 it("requester assertions cannot replace an explicit owner verifier", () => {
  const f=fixture();const result=evaluateAccountedHostPolicyAdapter(f.request,{state:"verified",trusted:true,body:f.body},f.context);
  expect(result.compatible).toBe(false);expect(result.reasons).toContain("verifier_unavailable");
 });
});

describe("bounded JSON inputs", () => {
 it("bounds oversized object keys as well as values", () => {
  expect(() => digestAccountedOwnerEvidence({["x".repeat(524289)]:true})).toThrow();
 });
 it("does not silently drop sparse arrays or non-index properties", () => {
  const extra=Object.assign([], {hiddenField:true});
  expect(() => digestAccountedOwnerEvidence(extra)).toThrow();
  expect(() => digestAccountedOwnerEvidence(new Array(1))).toThrow();
 });
 it("never invokes an array prototype supplied by the caller", () => {
  let invoked=0;const a: unknown[]=[];Object.setPrototypeOf(a,{map(){invoked++;return [];}});
  expect(() => digestAccountedOwnerEvidence(a)).toThrow();expect(invoked).toBe(0);
 });
});

describe("owner provenance, binding and replay", () => {
 it.each(["issuerId","hostId","hostBootIdSha256","observerInstanceSha256","nonceSha256"])("rejects mismatched %s even from the configured verifier", key => {
  const f=fixture();const body={...f.body,[key]:key.endsWith("Sha256")?H("9"):"wrong-owner"};
  const r=evaluateAccountedHostPolicyAdapter(f.request,{},f.context,()=>({state:"verified",body,bodyDigest:digestAccountedOwnerEvidence(body)}));
  expect(r.compatible).toBe(false);expect(r.replayCommit).toBeNull();
 });
 it("rejects an owner-body digest mismatch", () => {
  const f=fixture();const r=evaluateAccountedHostPolicyAdapter(f.request,{},f.context,()=>({...f.verified(),bodyDigest:H("0")}));
  expect(r.reasons).toContain("evidence_digest_mismatch");
 });
 it("binds the complete request digest including resource/timing terms", () => {
  const f=fixture();f.request.stopMaxSeconds=4;
  expect(evaluateAccountedHostPolicyAdapter(f.request,{},f.context,f.verified).reasons).toContain("request_digest_mismatch");
 });
 it("requires current owner-approved policy digests rather than requester labels", () => {
  const f=fixture();f.context.acceptedPolicy.ownerAllocationDigest=H("8");
  expect(evaluateAccountedHostPolicyAdapter(f.request,{},f.context,f.verified).reasons).toContain("accepted_policy_mismatch");
 });
 it("rejects both receipt replay and request/attempt replay", () => {
  const f=fixture();f.context.seenEvidenceDigests.push(digestAccountedOwnerEvidence(f.body));
  expect(evaluateAccountedHostPolicyAdapter(f.request,{},f.context,f.verified).reasons).toContain("evidence_replayed");
  f.context.seenEvidenceDigests=[];f.context.seenAttempts.push({phase:"admission",requestId:f.request.requestId,attemptId:f.request.attemptId});
  expect(evaluateAccountedHostPolicyAdapter(f.request,{},f.context,f.verified).reasons).toContain("attempt_replayed");
 });
 it("does not silently reset or skip the trusted observation sequence", () => {
  const f=fixture();f.body.sequence=2;
  expect(evaluateAccountedHostPolicyAdapter(f.request,{},f.context,f.verified).reasons).toContain("sequence_mismatch");
  f.body.sequence=3;f.context.expectedSequence=3;
  expect(evaluateAccountedHostPolicyAdapter(f.request,{},f.context,f.verified).reasons).toContain("sequence_mismatch");
 });
 it("returns a replay CAS proposal bound to the exact request, never an execution permit", () => {
  const f=fixture();const r=evaluateAccountedHostPolicyAdapter(f.request,{},f.context,f.verified);
  expect(r.replayCommit?.requestDigest).toBe(f.request.requestDigest);expect(r.replayCommit?.expectedLastSequence).toBe(0);
  expect(r.replayCommit?.expectedStateDigest).toMatch(/^[a-f0-9]{64}$/);expect(r.executionAuthorized).toBe(false);
 });
 it("copies trusted context and request before invoking the verifier", () => {
  const f=fixture();const original=f.request.requestDigest;
  const r=evaluateAccountedHostPolicyAdapter(f.request,{},f.context,()=>{f.request.requestDigest=H("0");f.context.expectedRequestDigest=H("0");return f.verified();});
  expect(r.compatible).toBe(true);expect(r.replayCommit?.requestDigest).toBe(original);
 });
 it("refuses unavailable, throwing, asynchronous or malformed verifiers without echo", () => {
  const f=fixture();
  for(const verifier of [()=>null,()=>({state:"unknown"}),()=>Promise.resolve(f.verified()),()=>{throw Error("SYNTHETIC_DO_NOT_ECHO");}]) {
   const r=evaluateAccountedHostPolicyAdapter(f.request,{},f.context,verifier);expect(r.compatible).toBe(false);expect(JSON.stringify(r)).not.toContain("SYNTHETIC_DO_NOT_ECHO");
  }
 });
});

describe("clocks, allocation and complete-chain policy", () => {
 it.each(["0000-01-01T00:00:00.000001Z","2030-01-01T00:00:00.000001Z\n","2030-01-01T00:00:00.000Z","2030-01-01T00:00:00.000001+00:00","2030-02-30T00:00:00.000001Z"])("refuses noncanonical/invalid clocks %j", now => {
  const f=fixture();expect(evaluateAccountedHostPolicyAdapter(f.request,{}, {...f.context,now},f.verified).compatible).toBe(false);
 });
 it("retains single-microsecond freshness boundaries and both clocks", () => {
  const f=fixture();f.body.observedAt=NOW;f.input.observation.observedAt=NOW;f.context.now="2030-01-01T00:00:05.000002Z";
  expect(evaluateAccountedHostPolicyAdapter(f.request,{},f.context,f.verified).reasons).toContain("evidence_stale");
  f.context.now=NOW;f.context.nowMonotonicMicros=999999;
  expect(evaluateAccountedHostPolicyAdapter(f.request,{},f.context,f.verified).reasons).toContain("evidence_future");
 });
 it("does not freshen an old observation with a fresh wrapper timestamp", () => {
  const f=fixture();f.body.observedAt="2030-01-01T00:00:00.000000Z";
  expect(evaluateAccountedHostPolicyAdapter(f.request,{},f.context,f.verified).reasons).toContain("observation_time_unbound");
 });
 it("refuses expiry and requests that outlive their owner policy", () => {
  const f=fixture();f.context.expiresAt=NOW;
  expect(evaluateAccountedHostPolicyAdapter(f.request,{},f.context,f.verified).reasons).toContain("owner_policy_expired");
  f.context.expiresAt="2030-01-01T00:00:30.000001Z";
  expect(evaluateAccountedHostPolicyAdapter(f.request,{},f.context,f.verified).reasons).toContain("request_outlives_owner_policy");
 });
 it("requires exact declared whole-task allocation, not spare parent capacity", () => {
  const f=fixture();f.request.limits.tasksMax=32;f.request.requestDigest=digestAccountedRequest(f.request);f.context.expectedRequestDigest=f.request.requestDigest;
  f.input.plan.bindings.requestDigest=f.request.requestDigest;f.input.observation.bindings.requestDigest=f.request.requestDigest;
  expect(evaluateAccountedHostPolicyAdapter(f.request,{},f.context,f.verified).reasons).toContain("request_limits_mismatch");
 });
 it("refuses a per-request CPU limit above the protocol ceiling without floating arithmetic", () => {
  const f=fixture();f.request.limits.cpuQuotaMicros=900719925474100;f.request.limits.cpuPeriodMicros=9007199254740991;
  expect(evaluateAccountedHostPolicyAdapter(f.request,{},f.context,f.verified).reasons).toContain("invalid_request");
 });
 it("never borrows the access account UID or silently fills allocation/coverage gaps", () => {
  const f=fixture();expect(evaluateAccountedHostPolicyAdapter({...f.request,actorUid:1001},{},f.context,f.verified).compatible).toBe(false);
  f.input.plan.coverage.wholeTask="unknown";
  const r=evaluateAccountedHostPolicyAdapter(f.request,{},f.context,f.verified);expect(r.compatible).toBe(false);expect(r.reasons).toContain("policy_refused");
 });
 it("refuses protected identity, OOM, residency and control-plane drift", () => {
  for(const change of [
   (f: ReturnType<typeof fixture>)=>{f.input.observation.protectedServices[0].invocationId="wrong";},
   (f: ReturnType<typeof fixture>)=>{f.input.observation.oomCounters.host++;},
   (f: ReturnType<typeof fixture>)=>{f.input.observation.residency.models=["wrong-model"];},
   (f: ReturnType<typeof fixture>)=>{f.input.observation.controlPlaneAccounting.status="unknown";},
  ]) {
   const f=fixture();change(f);const r=evaluateAccountedHostPolicyAdapter(f.request,{},f.context,f.verified);expect(r.compatible).toBe(false);expect(r.replayCommit).toBeNull();
  }
 });
 it("requires a trusted immutable baseline digest for restoration", () => {
  const f=fixture();f.body.phase="restoration";f.context.phase="restoration";f.input.baseline=structuredClone(f.input.observation);
  expect(evaluateAccountedHostPolicyAdapter(f.request,{},f.context,f.verified).reasons).toContain("baseline_unbound");
  f.context.baselineDigest=digestAccountedBaseline(f.input.baseline);
  const r=evaluateAccountedHostPolicyAdapter(f.request,{},f.context,f.verified);expect(r.compatible).toBe(true);expect(r.policyDecision?.phase).toBe("restoration");
  f.input.baseline.protectedServices[0].invocationId="replaced";
  expect(evaluateAccountedHostPolicyAdapter(f.request,{},f.context,f.verified).reasons).toContain("baseline_unbound");
 });
});

describe("review regression: snapshot uses validated descriptor data", () => {
 it("rejects a proxy before invoking traps or hashing a second unbounded value", () => {
  let reads=0;
  const input=new Proxy({field:"short"},{get(target,key,receiver){if(key==="field"){reads++;return "x".repeat(524289);}return Reflect.get(target,key,receiver);}});
  expect(()=>digestAccountedOwnerEvidence(input)).toThrow();expect(reads).toBe(0);
 });
});
