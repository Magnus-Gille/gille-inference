/** Explicit v3 wire checks. Structural consistency is NOT physical observation,
 * allocation authority, producer authentication or permission to execute.
 */
import {createHash} from "node:crypto";
import {z} from "zod";
import {ACCOUNTED_DESCRIPTOR, canonicalNative, parseNativeJson} from "./accounted-host-issuer.js";

const digest = z.string().regex(/^[0-9a-f]{64}$(?![\s\S])/);
const attempt = z.string().regex(/^[0-9a-f]{32}$(?![\s\S])/);
const revision = z.string().regex(/^[0-9a-f]{40}$(?![\s\S])/);
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$(?![\s\S])/);
const unsigned = z.bigint().min(0n).max(2n**63n-1n);
const positive = unsigned.refine(value=>value>0n);
const text = z.string().min(1).max(1024);
const identity = z.object({
  boot_id:uuid, invocation_id:attempt, cgroup_path:text,
  cgroup_device:positive, cgroup_inode:positive,
  namespace_inodes:z.object({mnt:positive,net:positive,ipc:positive,pid:positive}).strict(),
}).strict();
const workerLimits = z.object({
  memory_bytes:z.bigint().min(16777216n).max(469762048n),
  cpu_quota_us:z.bigint().min(1n).max(9000n), cpu_period_us:z.literal(100000n),
  pids_max:z.bigint().min(4n).max(56n),
}).strict();
export const nativeCgroupLimitsV3Schema = z.object({
  memory_bytes:z.bigint().min(1n).max(536870912n),
  cpu_quota_us:z.bigint().min(1n).max(10000n), cpu_period_us:z.literal(100000n),
  pids_max:z.bigint().min(1n).max(64n), swap_bytes:z.literal(0n),
}).strict();
export const nativeEnvelopeV3Schema = z.object({
  version:z.literal(1n), unit:text, cgroup_path:text, cgroup_device:positive,
  cgroup_inode:positive, limits:nativeCgroupLimitsV3Schema,
}).strict();
const roleScope = z.object({
  role:z.enum(["worker","observer","recovery"]),unit:text,identity,limits:nativeCgroupLimitsV3Schema,
  address_space_limit_bytes:positive, started_boottime_lower_ns:unsigned,
  stop_by_boottime_ns:positive,
}).strict();
export const nativeRoleScopesV3Schema = z.array(roleScope).length(3);
export const challengeV2Schema = z.object({
  version:z.literal(2n),attempt_id:attempt,unit:text,source_revision:revision,
  release_id:digest,config_digest:digest,descriptor_digest:z.literal(ACCOUNTED_DESCRIPTOR),
  identity,limits:workerLimits,observed_boottime_ns:unsigned,
  native_envelope:nativeEnvelopeV3Schema,native_role_scopes:nativeRoleScopesV3Schema,
}).strict();
export const runBindingV1Schema = z.object({
  version:z.literal(1n),mandate_id:uuid,native_attempt_id:attempt,request_id:uuid,policy_attempt_id:uuid,
  challenge_digest:digest,owner_envelope_digest:digest,brokkr_source_revision:revision,
  brokkr_config_digest:digest,brokkr_release_digest:digest,descriptor_digest:z.literal(ACCOUNTED_DESCRIPTOR),
  issuer_release_digest:digest,producer_release_digest:digest,producer_config_digest:digest,boot_id:uuid,
  observer_instance_digest:digest,sequence:z.bigint().min(1n).max(4096n),
  native_envelope_digest:digest,native_role_scopes_digest:digest,lease_id:digest,ledger_revision:digest,
  allocated_from_boottime_ns:unsigned,allocated_until_boottime_ns:positive,
}).strict();
const aggregate = z.object({
  chargedMemoryMaxBytes:z.number().int().min(16777216).safe().max(536870912),
  swapMaxBytes:z.literal(0),cpuQuotaMicros:z.number().int().positive().max(10000),
  cpuPeriodMicros:z.literal(100000),tasksMax:z.number().int().min(4).max(64),
  addressSpaceLimitBytes:z.number().int().positive().safe(),
}).strict();
export type AccountedChallengeV2 = z.infer<typeof challengeV2Schema>;
export type AccountedNativeEnvelopeV3 = z.infer<typeof nativeEnvelopeV3Schema>;
export type AccountedNativeRoleScopesV3 = z.infer<typeof nativeRoleScopesV3Schema>;
export type AccountedRunBindingV1 = z.infer<typeof runBindingV1Schema>;
export type AccountedAggregateLimitsV3 = z.infer<typeof aggregate>;
export class AccountedNativeV3Error extends Error {
  constructor(readonly code:string) {super(code);}
}
function need(value:unknown,code:string):asserts value {if(!value)throw new AccountedNativeV3Error(code);}
function canonicalValue(raw:string):unknown {
  const value=parseNativeJson(raw);need(canonicalNative(value)===raw,"v3_noncanonical_native");return value;
}
export function parseAccountedChallengeV2(raw:string):AccountedChallengeV2 {
  return challengeV2Schema.parse(canonicalValue(raw));
}
export function parseAccountedNativeEnvelopeV3(raw:string):AccountedNativeEnvelopeV3 {
  return nativeEnvelopeV3Schema.parse(canonicalValue(raw));
}
export function parseAccountedNativeRoleScopesV3(raw:string):AccountedNativeRoleScopesV3 {
  return nativeRoleScopesV3Schema.parse(canonicalValue(raw));
}
export function parseAccountedRunBindingV1(raw:string):AccountedRunBindingV1 {
  const value=runBindingV1Schema.parse(canonicalValue(raw));
  need(value.allocated_until_boottime_ns>value.allocated_from_boottime_ns,"v3_lease_interval");
  return value;
}
const domains={
  envelope:"brokkr/accounted/native-envelope/v1\n",
  roles:"brokkr/accounted/native-role-scopes/v1\n",
  run:"brokkr/accounted/run-binding/v1\n",
} as const;
function hash(domain:keyof typeof domains,value:unknown):string {
  return createHash("sha256").update(domains[domain]).update(canonicalNative(value)).digest("hex");
}
export const digestAccountedNativeEnvelopeV3=(value:AccountedNativeEnvelopeV3):string=>
  hash("envelope",parseAccountedNativeEnvelopeV3(canonicalNative(value)));
export const digestAccountedNativeRoleScopesV3=(value:AccountedNativeRoleScopesV3):string=>
  hash("roles",parseAccountedNativeRoleScopesV3(canonicalNative(value)));
export const digestAccountedRunBindingV1=(value:AccountedRunBindingV1):string=>
  hash("run",parseAccountedRunBindingV1(canonicalNative(value)));

function allocation(value:unknown):AccountedAggregateLimitsV3 {
  // The legacy policy allocation has safe Number fields, not native BigInts.
  // Canonicalization first rejects proxies/getters/classes and unsafe numbers.
  const raw=canonicalNative(value);
  need(value!==null && typeof value==="object" && !Array.isArray(value),"v3_allocation_shape");
  const properties=Object.getOwnPropertyDescriptors(value);
  need(Object.values(properties).every(p=>"value" in p && typeof p.value==="number"),"v3_allocation_number");
  return aggregate.parse(JSON.parse(raw));
}

/** Check explicit parent/roles and allocation consistency. The returned values
 * still require an independent actual physical collector and source verifier.
 */
export function validateAccountedNativeScopesV3(rawChallenge:string,rawAllocation:unknown) {
  const challenge=parseAccountedChallengeV2(rawChallenge), limits=allocation(rawAllocation);
  const envelope=challenge.native_envelope,roles=challenge.native_role_scopes;
  const parent=`brokkr_accounted_${challenge.attempt_id}.slice`;
  need(envelope.unit===parent && envelope.cgroup_path===`/${parent}`,"v3_parent_binding");
  const map={memory_bytes:"chargedMemoryMaxBytes",cpu_quota_us:"cpuQuotaMicros",
    cpu_period_us:"cpuPeriodMicros",pids_max:"tasksMax",swap_bytes:"swapMaxBytes"} as const;
  for(const [native,policy] of Object.entries(map) as Array<[keyof typeof map,typeof map[keyof typeof map]]>) {
    need(envelope.limits[native]===BigInt(limits[policy]),"v3_aggregate_limits_mismatch");
  }
  const expectedRoles=["worker","observer","recovery"] as const;
  const units=expectedRoles.map(role=>role==="worker"?`brokkr-accounted-eval-${challenge.attempt_id}.service`:
    `brokkr-accounted-${role}-${challenge.attempt_id}.service`);
  const inodes=new Set([envelope.cgroup_inode.toString()]),invocations=new Set<string>();
  for(let i=0;i<roles.length;i++) {
    const role=roles[i],id=role.identity;
    need(role.role===expectedRoles[i] && role.unit===units[i],"v3_role_order_or_unit");
    need(id.cgroup_path===`${envelope.cgroup_path}/${role.unit}` && id.cgroup_device===envelope.cgroup_device,
      "v3_role_parent_membership");
    need(id.boot_id===challenge.identity.boot_id,"v3_role_boot");
    need(!inodes.has(id.cgroup_inode.toString()) && !invocations.has(id.invocation_id),"v3_role_alias");
    inodes.add(id.cgroup_inode.toString());invocations.add(id.invocation_id);
    need(role.address_space_limit_bytes===BigInt(limits.addressSpaceLimitBytes),"v3_role_address_space");
    need(role.started_boottime_lower_ns<=challenge.observed_boottime_ns
      && challenge.observed_boottime_ns<role.stop_by_boottime_ns,"v3_role_live_window");
  }
  const worker=roles[0];
  need(roles[1].identity.namespace_inodes.pid===roles[2].identity.namespace_inodes.pid
    && worker.identity.namespace_inodes.pid!==roles[1].identity.namespace_inodes.pid,"v3_role_pid_namespaces");
  need(challenge.unit===worker.unit && canonicalNative(challenge.identity)===canonicalNative(worker.identity),"v3_worker_identity");
  for(const key of ["memory_bytes","cpu_quota_us","cpu_period_us","pids_max"] as const) {
    need(challenge.limits[key]===worker.limits[key],"v3_worker_limits");
  }
  for(const key of ["memory_bytes","cpu_quota_us","pids_max"] as const) {
    need(roles.reduce((sum,role)=>sum+role.limits[key],0n)<=envelope.limits[key],"v3_role_sum_exceeds_parent");
  }
  return Object.freeze({challenge,nativeEnvelopeDigest:digestAccountedNativeEnvelopeV3(envelope),
    nativeRoleScopesDigest:digestAccountedNativeRoleScopesV3(roles),
    physicalEvidenceVerified:false as const,executionAuthorized:false as const});
}

/** Absolute full lease interval; never add its full duration to admission-now.
 * The caller separately binds these values to accepted owner/source records.
 */
export function validateAccountedLeaseV3(binding:AccountedRunBindingV1,
  roles:AccountedNativeRoleScopesV3,nowNs:bigint,ownerDeadlineNs:bigint,
  hostExpiresNs:bigint,requestTotalSeconds:number,wholeTaskMaxSeconds:number) {
  const run=parseAccountedRunBindingV1(canonicalNative(binding));
  const roleValues=parseAccountedNativeRoleScopesV3(canonicalNative(roles));
  need(typeof nowNs==="bigint" && nowNs>=0n && nowNs<2n**63n
    && typeof ownerDeadlineNs==="bigint" && ownerDeadlineNs>0n && ownerDeadlineNs<2n**63n
    && typeof hostExpiresNs==="bigint" && hostExpiresNs>0n && hostExpiresNs<2n**63n,"v3_clock_bound");
  need(Number.isSafeInteger(requestTotalSeconds) && requestTotalSeconds>=30 && requestTotalSeconds<=90
    && Number.isSafeInteger(wholeTaskMaxSeconds),"v3_whole_task_bound");
  const start=run.allocated_from_boottime_ns,end=run.allocated_until_boottime_ns;
  const seconds=(end-start+999999999n)/1000000000n;
  need(seconds>=30n && seconds<=90n && seconds===BigInt(wholeTaskMaxSeconds)
    && seconds<=BigInt(requestTotalSeconds),"v3_whole_task_duration");
  need(start<=nowNs && nowNs<end && end<=ownerDeadlineNs && end<=hostExpiresNs,"v3_lease_clock_window");
  for(const role of roleValues)need(start<=role.started_boottime_lower_ns && role.started_boottime_lower_ns<=nowNs
    && nowNs+35000000000n<=role.stop_by_boottime_ns
    && role.stop_by_boottime_ns<=end,"v3_role_lease_window");
  need(nowNs+35000000000n<=end,"v3_insufficient_permit_window");
  return Object.freeze({startNs:start,endNs:end,wholeSeconds:wholeTaskMaxSeconds,
    physicalEvidenceVerified:false as const,executionAuthorized:false as const});
}
