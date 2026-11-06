/** Pure parsing and continuity checks for selected cgroup kernel charge counters.
 * This validates supplied bytes only; it does not collect or authenticate physical I/O.
 */
import {z} from "zod";
import {canonicalNative} from "./accounted-host-issuer.js";
import {
  AccountedNativeV3Error,
} from "./accounted-native-envelope-v3.js";
import {
  cgroupObservationV1Schema,validateCgroupChannelPairV1,validateCgroupChannelV1,
  type CgroupChannelExpectationV1,
} from "./accounted-cgroup-channel-v3.js";

const attempt=z.string().regex(/^[0-9a-f]{32}$(?![\s\S])/);
const count=z.bigint().min(0n).max(2n**63n-1n);
const rawText=z.string();
const sampleSchema=z.object({
  scope:z.enum(["parent","worker","observer","recovery"]),
  cgroup_device:z.bigint().min(1n).max(2n**63n-1n),cgroup_inode:z.bigint().min(1n).max(2n**63n-1n),
  cpu_stat:rawText,memory_stat:rawText,memory_current:rawText,memory_events_local:rawText,
  pids_current:rawText,pids_events_local:rawText,
}).strict();
const passSchema=z.object({observed_from_boottime_ns:count,observed_until_boottime_ns:count,
  scope_samples:z.array(sampleSchema).length(4)}).strict();
const packetSchema=z.object({version:z.literal(1n),status:z.literal("observed"),channel:z.literal("cgroup_kernel_charges_v1"),
  brokkr_config_digest:z.string().regex(/^[0-9a-f]{64}$(?![\s\S])/),
  value:z.object({version:z.literal(1n),kind:z.literal("cgroup_kernel_charges_observation"),attempt_id:attempt,
    native_envelope:cgroupObservationV1Schema.shape.native_envelope,
    role_cgroups:cgroupObservationV1Schema.shape.role_cgroups,
    observed_from_boottime_ns:count,observed_until_boottime_ns:count,passes:z.array(passSchema).length(2)}).strict(),
}).strict();
export type CgroupKernelChargesPacketV1=z.infer<typeof packetSchema>;

type FlatFile="cpu_stat"|"memory_stat"|"memory_events_local"|"pids_events_local";
type FileName=FlatFile|"memory_current"|"pids_current";
type FlatValues=Record<string,bigint>;
type UnclaimedKeys=Record<FileName,string[]>;
interface ParsedScope {scope:"parent"|"worker"|"observer"|"recovery";cpu_stat:FlatValues;memory_stat:FlatValues;memory_current:bigint;memory_events_local:FlatValues;pids_current:bigint;pids_events_local:FlatValues;unclaimedKeys:UnclaimedKeys}
interface ParsedPass {observedFromBoottimeNs:bigint;observedUntilBoottimeNs:bigint;scopes:ParsedScope[]}
const SCOPE_ORDER=["parent","worker","observer","recovery"] as const;
const REQUIRED:Record<FlatFile,readonly string[]>={
  cpu_stat:["usage_usec","user_usec","system_usec","nr_periods","nr_throttled","throttled_usec","nr_bursts","burst_usec"],
  memory_stat:["anon","file","kernel","sock"],
  memory_events_local:["low","high","max","oom","oom_kill","oom_group_kill"],
  pids_events_local:["max"],
};
const MONOTONIC:readonly FlatFile[]=["cpu_stat","memory_events_local","pids_events_local"];
function need(value:unknown,code:string):asserts value {if(!value)throw new AccountedNativeV3Error(code);}
function fail(code:string,cause?:unknown):never {
  const error=new AccountedNativeV3Error(code);
  if(cause!==undefined)Object.defineProperty(error,"cause",{value:cause});
  throw error;
}
function preserveOr(error:unknown,fallback:string):never {
  if(error instanceof AccountedNativeV3Error)throw error;
  fail(fallback,error);
}
/** Kernel file payloads contain escaped TAB/LF. Keep native integer, duplicate,
 * and canonical rules while allowing those characters in decoded string values.
 */
function parseKernelJson(raw:string):unknown {
  need(typeof raw==="string" && raw.length<=65536 && /^[\x09\x0a\x0d\x20-\x7e]*$/.test(raw),"kernel_native_json");
  let i=0,nodes=0;
  const space=()=>{while(/[\t\r\n ]/.test(raw[i]??"x"))i++;};
  function string(allowRawWhitespace:boolean):string {
    const start=i++;let escaped=false;
    for(;i<raw.length;i++) {
      const c=raw[i];
      if(!escaped&&c==='"') {
        let value:unknown;try {value=JSON.parse(raw.slice(start,++i));} catch {fail("kernel_native_json");}
        need(typeof value==="string" && (allowRawWhitespace?/^[\x09\x0a\x20-\x7e]*$/:/^[\x20-\x7e]*$/).test(value),"kernel_native_json");return value;
      }
      if(!escaped&&c==="\\")escaped=true;else escaped=false;
    }
    return fail("kernel_native_json");
  }
  const rawFields=new Set(["cpu_stat","memory_stat","memory_current","memory_events_local","pids_current","pids_events_local"]);
  function parse(depth:number,allowRawWhitespace=false):unknown {
    space();need(++nodes<=2048&&depth<=12,"kernel_native_json");
    if(raw[i]==='"')return string(allowRawWhitespace);
    if(raw[i]==="{") {
      i++;space();const object:Record<string,unknown>=Object.create(null);if(raw[i]==="}"){i++;return object;}
      for(;;) {
        space();need(raw[i]==='"',"kernel_native_json");const key=string(false);need(/^[\x20-\x7e]*$/.test(key),"kernel_native_json");
        need(!Object.hasOwn(object,key),"kernel_native_json");space();need(raw[i++]===":","kernel_native_json");object[key]=parse(depth+1,rawFields.has(key));
        space();const end=raw[i++];if(end==="}")return object;need(end===",","kernel_native_json");
      }
    }
    if(raw[i]==="[") {
      i++;space();const array:unknown[]=[];if(raw[i]==="]"){i++;return array;}
      for(;;){array.push(parse(depth+1));space();const end=raw[i++];if(end==="]")return array;need(end===",","kernel_native_json");}
    }
    const token=/^-?(?:0|[1-9][0-9]*)/.exec(raw.slice(i))?.[0];
    need(token&&token.length<=20,"kernel_native_json");i+=token.length;return BigInt(token);
  }
  const value=parse(0);space();need(i===raw.length,"kernel_native_json");return value;
}
function canonicalKernel(value:unknown):string {
  let nodes=0,size=0;const seen=new Set<object>();
  function encode(item:unknown,depth:number):string {
    need(++nodes<=2048&&depth<=12,"kernel_native_json");
    if(typeof item==="bigint"){need(item>=-(2n**63n)&&item<=2n**63n-1n,"kernel_native_json");return item.toString();}
    if(typeof item==="string"){size+=item.length;need(size<=65536&&/^[\x09\x0a\x20-\x7e]*$/.test(item),"kernel_native_json");return JSON.stringify(item);}
    if(item===null||typeof item==="boolean")return String(item);
    need(typeof item==="object"&&!seen.has(item),"kernel_native_json");seen.add(item);
    let output:string;
    if(Array.isArray(item))output="["+item.map(child=>encode(child,depth+1)).join(",")+"]";
    else {
      const keys=Object.keys(item as Record<string,unknown>);for(const key of keys){size+=key.length;need(size<=65536&&/^[\x20-\x7e]*$/.test(key),"kernel_native_json");}
      output="{"+keys.sort().map(key=>JSON.stringify(key)+":"+encode((item as Record<string,unknown>)[key],depth+1)).join(",")+"}";
    }
    seen.delete(item);return output;
  }
  return encode(value,0);
}
function native(raw:string):unknown {
  const parsed=parseKernelJson(raw);
  need(canonicalKernel(parsed)===raw,"kernel_noncanonical");
  return parsed;
}
function parseFlat(raw:string,file:FlatFile):{values:FlatValues;unclaimed:string[]} {
  need(raw.length<=65536,"kernel_raw_bound");
  need(raw.length>0,"kernel_raw_empty");
  need(/^[\x09\x0a\x20-\x7e]+$/.test(raw) && raw.trim()===raw,"kernel_raw_encoding");
  const rows=raw.split("\n");need(rows.length<=256,"kernel_rows_bound");
  const values:FlatValues=Object.create(null);
  for(const row of rows) {
    const match=/^([^ \t]+)[\t ]+(\S+)$/.exec(row);
    need(match,"kernel_raw_row");
    const [,key,token]=match;need(/^[a-z][a-z0-9_.]{0,95}$/.test(key),"kernel_key_invalid");
    need(!Object.hasOwn(values,key),"kernel_duplicate_key");
    need(/^(0|[1-9][0-9]{0,18})$/.test(token),"kernel_numeric_syntax");
    const number=BigInt(token);need(number<=2n**63n-1n,"kernel_counter_range");values[key]=number;
  }
  const required=REQUIRED[file];
  for(const key of required)need(Object.hasOwn(values,key),"kernel_missing_selected_key");
  const unclaimed=Object.keys(values).filter(key=>!required.includes(key)).sort();
  const selected:FlatValues=Object.create(null);for(const key of required)selected[key]=values[key];
  return {values:selected,unclaimed};
}
function parseScalar(raw:string):bigint {
  need(raw.length>0,"kernel_raw_empty");need(raw.length<=65536,"kernel_raw_bound");
  need(/^(0|[1-9][0-9]{0,18})$/.test(raw),"kernel_scalar_syntax");
  const value=BigInt(raw);need(value<=2n**63n-1n,"kernel_counter_range");return value;
}
function profile(scope:ParsedScope):UnclaimedKeys {return scope.unclaimedKeys;}
function profiles(pass:ParsedPass):UnclaimedKeys[] {return pass.scopes.map(profile);}
function same(a:unknown,b:unknown):boolean {return canonicalNative(a)===canonicalNative(b);}
function checkCounters(previous:ParsedPass,next:ParsedPass):void {
  for(let i=0;i<4;i++) {
    const a=previous.scopes[i],b=next.scopes[i];
    for(const file of MONOTONIC)for(const key of REQUIRED[file])
      need(b[file][key]>=a[file][key],"kernel_counter_regression");
  }
}
function limitsAt(packet:CgroupKernelChargesPacketV1,index:number) {
  return index===0?packet.value.native_envelope.limits:packet.value.role_cgroups[index-1].limits;
}
function parsePacketContent(packet:CgroupKernelChargesPacketV1):ParsedPass[] {
  const value=packet.value,overallFrom=value.observed_from_boottime_ns,overallUntil=value.observed_until_boottime_ns;
  need(overallFrom<=overallUntil && overallUntil-overallFrom<=1000000000n,"kernel_observation_window");
  const passes:ParsedPass[]=value.passes.map(pass=>{
    need(overallFrom<=pass.observed_from_boottime_ns && pass.observed_from_boottime_ns<=pass.observed_until_boottime_ns
      && pass.observed_until_boottime_ns<=overallUntil,"kernel_observation_window");
    const scopes:ParsedScope[]=pass.scope_samples.map((sample,index)=>{
      need(sample.scope===SCOPE_ORDER[index],"kernel_sample_identity");
      const identity=index===0?value.native_envelope:value.role_cgroups[index-1];
      need(sample.cgroup_device===identity.cgroup_device && sample.cgroup_inode===identity.cgroup_inode,"kernel_sample_identity");
      const cpu=parseFlat(sample.cpu_stat,"cpu_stat"),memory=parseFlat(sample.memory_stat,"memory_stat"),events=parseFlat(sample.memory_events_local,"memory_events_local"),pidsEvents=parseFlat(sample.pids_events_local,"pids_events_local");
      const memoryCurrent=parseScalar(sample.memory_current),pidsCurrent=parseScalar(sample.pids_current),limits=limitsAt(packet,index);
      for(const key of REQUIRED.memory_stat)need(memory.values[key]<=limits.memory_bytes,"kernel_gauge_cap");
      need(memoryCurrent<=limits.memory_bytes && pidsCurrent<=limits.pids_max,"kernel_gauge_cap");
      const unclaimedKeys:UnclaimedKeys={cpu_stat:cpu.unclaimed,memory_stat:memory.unclaimed,memory_current:[],memory_events_local:events.unclaimed,pids_current:[],pids_events_local:pidsEvents.unclaimed};
      return {scope:sample.scope,cpu_stat:cpu.values,memory_stat:memory.values,memory_current:memoryCurrent,memory_events_local:events.values,pids_current:pidsCurrent,pids_events_local:pidsEvents.values,unclaimedKeys};
    });
    return {observedFromBoottimeNs:pass.observed_from_boottime_ns,observedUntilBoottimeNs:pass.observed_until_boottime_ns,scopes};
  });
  need(passes[1].observedFromBoottimeNs>=passes[0].observedUntilBoottimeNs,"kernel_pass_order");
  for(let i=0;i<4;i++)need(same(profiles(passes[0])[i],profiles(passes[1])[i]),"kernel_unclaimed_profile_drift");
  checkCounters(passes[0],passes[1]);
  return passes;
}
/** Parse the fixed canonical native envelope and its selected cgroup file values. */
export function parseCgroupKernelChargesV1(raw:string):CgroupKernelChargesPacketV1 {
  const value=native(raw);let packet:CgroupKernelChargesPacketV1;
  try {packet=packetSchema.parse(value);} catch(error) {fail("kernel_payload_schema",error);}
  parsePacketContent(packet);
  return packet;
}
function oldProjection(packet:CgroupKernelChargesPacketV1):string {
  const value=packet.value;
  return canonicalNative({version:packet.version,status:packet.status,channel:"cgroup_envelope_v1",brokkr_config_digest:packet.brokkr_config_digest,
    value:{version:value.version,kind:"cgroup_envelope_observation",attempt_id:value.attempt_id,native_envelope:value.native_envelope,role_cgroups:value.role_cgroups,
      observed_from_boottime_ns:value.observed_from_boottime_ns,observed_until_boottime_ns:value.observed_until_boottime_ns}});
}
const SEMANTICS={scopeOrder:SCOPE_ORDER,selectedCounters:MONOTONIC.map(file=>({file,keys:REQUIRED[file]})),
  selectedGauges:{memory_stat:REQUIRED.memory_stat,memory_current:["value"],pids_current:["value"]},
  accountingScope:"selected cgroup kernel charge semantics; parent and role scopes overlap and are not additive"};
function stableProjection(oldProjectionJson:string,parsed:ParsedPass[]):string {
  const unclaimedKeyProfiles=profiles(parsed[0]);
  return canonicalNative({cgroupStableProjection:parseKernelJson(oldProjectionJson),unclaimedKeyProfiles,semantics:SEMANTICS});
}
export interface ValidatedCgroupKernelChargesV1 {
  packet:CgroupKernelChargesPacketV1;parsedPasses:ParsedPass[];stableProjectionJson:string;
  physicalEvidenceVerified:false;executionAuthorized:false;
}
function validateParsed(packet:CgroupKernelChargesPacketV1,expected:CgroupChannelExpectationV1):ValidatedCgroupKernelChargesV1 {
  const projection=oldProjection(packet);
  let oldResult;
  try {oldResult=validateCgroupChannelV1(projection,expected);} catch(error) {preserveOr(error,"kernel_binding_invalid");}
  const parsedPasses=parsePacketContent(packet);
  return Object.freeze({packet,parsedPasses,stableProjectionJson:stableProjection(oldResult.stableProjectionJson,parsedPasses),physicalEvidenceVerified:false,executionAuthorized:false});
}
export function validateCgroupKernelChargesV1(raw:string,expected:CgroupChannelExpectationV1):ValidatedCgroupKernelChargesV1 {
  return validateParsed(parseCgroupKernelChargesV1(raw),expected);
}
export interface ValidatedCgroupKernelChargesPairV1 {
  first:ValidatedCgroupKernelChargesV1;last:ValidatedCgroupKernelChargesV1;stableProjectionJson:string;
  physicalEvidenceVerified:false;executionAuthorized:false;
}
export function validateCgroupKernelChargesPairV1(firstRaw:string,lastRaw:string,expected:CgroupChannelExpectationV1):ValidatedCgroupKernelChargesPairV1 {
  const first=validateCgroupKernelChargesV1(firstRaw,expected),last=validateCgroupKernelChargesV1(lastRaw,expected);
  need(first.stableProjectionJson===last.stableProjectionJson,"kernel_continuity_drift");
  const firstProjection=oldProjection(first.packet),lastProjection=oldProjection(last.packet);
  try {validateCgroupChannelPairV1(firstProjection,lastProjection,expected);} catch(error) {preserveOr(error,"kernel_binding_invalid");}
  checkCounters(first.parsedPasses[1],last.parsedPasses[0]);
  return Object.freeze({first,last,stableProjectionJson:last.stableProjectionJson,physicalEvidenceVerified:false,executionAuthorized:false});
}
