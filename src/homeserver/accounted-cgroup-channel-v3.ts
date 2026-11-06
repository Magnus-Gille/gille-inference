/** Closed cgroup channel parsing and continuity. This validates supplied bytes;
 * only the fixed source-bound physical operation can authenticate observations.
 */
import {createHash} from "node:crypto";
import {z} from "zod";
import {canonicalNative,parseNativeJson} from "./accounted-host-issuer.js";
import {
  AccountedNativeV3Error,nativeCgroupLimitsV3Schema,nativeEnvelopeV3Schema,
  parseAccountedRunBindingV1,
  digestAccountedNativeEnvelopeV3,digestAccountedNativeRoleScopesV3,
  validateAccountedNativeScopesV3,type AccountedAggregateLimitsV3,
} from "./accounted-native-envelope-v3.js";

const digest=z.string().regex(/^[0-9a-f]{64}$(?![\s\S])/);
const attempt=z.string().regex(/^[0-9a-f]{32}$(?![\s\S])/);
const time=z.bigint().min(0n).max(2n**63n-1n);
const positive=time.refine(n=>n>0n);
const role=z.object({role:z.enum(["worker","observer","recovery"]),unit:z.string().min(1).max(256),
  cgroup_path:z.string().min(1).max(1024),cgroup_device:positive,cgroup_inode:positive,
  limits:nativeCgroupLimitsV3Schema}).strict();
export const cgroupObservationV1Schema=z.object({version:z.literal(1n),kind:z.literal("cgroup_envelope_observation"),
  attempt_id:attempt,native_envelope:nativeEnvelopeV3Schema,role_cgroups:z.array(role).length(3),
  observed_from_boottime_ns:time,observed_until_boottime_ns:time}).strict();
const envelope=z.object({version:z.literal(1n),status:z.literal("observed"),channel:z.literal("cgroup_envelope_v1"),
  brokkr_config_digest:digest,value:cgroupObservationV1Schema}).strict();
function need(value:unknown,code:string):asserts value {if(!value)throw new AccountedNativeV3Error(code);}
function native(raw:string):unknown {const v=parseNativeJson(raw);need(canonicalNative(v)===raw,"cgroup_noncanonical");return v;}
export function parseCgroupChannelV1(raw:string){return envelope.parse(native(raw));}

export interface CgroupChannelExpectationV1 {
  challengeJson:string;runBindingJson:string;allocation:AccountedAggregateLimitsV3;nowNs:bigint;maximumAgeNs:bigint;
}
export function validateCgroupChannelV1(raw:string,expected:CgroupChannelExpectationV1){
  const packet=parseCgroupChannelV1(raw),value=packet.value;
  const challenge=validateAccountedNativeScopesV3(expected.challengeJson,expected.allocation).challenge,
    run=parseAccountedRunBindingV1(expected.runBindingJson);
  need(typeof expected.nowNs==="bigint" && expected.nowNs>=0n && expected.nowNs<2n**63n
    && typeof expected.maximumAgeNs==="bigint" && expected.maximumAgeNs>0n && expected.maximumAgeNs<=5000000000n,"cgroup_clock_bounds");
  const challengeDigest=createHash("sha256").update(expected.challengeJson).digest("hex");
  need(packet.brokkr_config_digest===challenge.config_digest && run.brokkr_config_digest===challenge.config_digest
    && value.attempt_id===challenge.attempt_id && run.native_attempt_id===challenge.attempt_id
    && run.challenge_digest===challengeDigest && run.boot_id===challenge.identity.boot_id
    && run.brokkr_source_revision===challenge.source_revision && run.brokkr_release_digest===challenge.release_id
    && run.descriptor_digest===challenge.descriptor_digest,"cgroup_attempt_or_config_binding");
  need(run.native_envelope_digest===digestAccountedNativeEnvelopeV3(challenge.native_envelope)
    && run.native_role_scopes_digest===digestAccountedNativeRoleScopesV3(challenge.native_role_scopes),"cgroup_run_scope_binding");
  need(canonicalNative(value.native_envelope)===canonicalNative(challenge.native_envelope),"cgroup_parent_drift");
  const expectedRoles=challenge.native_role_scopes.map(r=>({role:r.role,unit:r.unit,
    cgroup_path:r.identity.cgroup_path,cgroup_device:r.identity.cgroup_device,
    cgroup_inode:r.identity.cgroup_inode,limits:r.limits}));
  need(canonicalNative(value.role_cgroups)===canonicalNative(expectedRoles),"cgroup_roles_drift");
  const from=value.observed_from_boottime_ns,until=value.observed_until_boottime_ns;
  need(run.allocated_from_boottime_ns<=from && from<=until && until-from<=1000000000n
    && until<=run.allocated_until_boottime_ns
    && until<=expected.nowNs && expected.nowNs-from<=expected.maximumAgeNs,"cgroup_observation_window");
  for(const scope of challenge.native_role_scopes)need(scope.started_boottime_lower_ns<=from
    && until<=scope.stop_by_boottime_ns,"cgroup_role_window");
  const stableProjectionJson=canonicalNative({version:value.version,kind:value.kind,attempt_id:value.attempt_id,
    native_envelope:value.native_envelope,role_cgroups:value.role_cgroups});
  return Object.freeze({packet,stableProjectionJson,fromNs:from,untilNs:until,
    physicalEvidenceVerified:false as const,executionAuthorized:false as const});
}
export function validateCgroupChannelPairV1(firstRaw:string,lastRaw:string,expected:CgroupChannelExpectationV1){
  const first=validateCgroupChannelV1(firstRaw,expected),last=validateCgroupChannelV1(lastRaw,expected);
  need(first.stableProjectionJson===last.stableProjectionJson,"cgroup_continuity_drift");
  need(last.fromNs>=first.untilNs,"cgroup_observation_order");
  return Object.freeze({first,last,stableProjectionJson:last.stableProjectionJson,
    physicalEvidenceVerified:false as const,executionAuthorized:false as const});
}
