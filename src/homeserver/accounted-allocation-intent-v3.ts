/** Physical, host-global reservation primitive. An intent is NOT allocation,
 * native activation, cleanup, owner authority or permission to execute.
 * No initialization, expiry release, recovery, CLI or default loader is supplied.
 */
import {createHash} from "node:crypto";
import {z} from "zod";
import * as fs from "node:fs/promises";
import {constants} from "node:fs";
import {ACCOUNTED_DESCRIPTOR,canonicalNative} from "./accounted-host-issuer.js";
import {encodeInitialAccountedIssuerFileRecord,openAccountedIssuerFileStorage} from "./accounted-issuer-file-storage.js";

const hex=z.string().regex(/^[0-9a-f]{64}$(?![\s\S])/);
const uuid=z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$(?![\s\S])/);
const NS_PATTERN=/^(0|[1-9][0-9]{0,18})$(?![\s\S])/;
const ns=z.string().regex(NS_PATTERN).refine(value=>NS_PATTERN.test(value)&&BigInt(value)<2n**63n);
const limits=z.object({chargedMemoryMaxBytes:z.number().int().min(16777216).max(536870912),
  swapMaxBytes:z.literal(0),cpuQuotaMicros:z.number().int().min(1).max(10000),cpuPeriodMicros:z.literal(100000),
  tasksMax:z.number().int().min(4).max(64),addressSpaceLimitBytes:z.number().int().positive().safe(),digest:hex}).strict();
const intentSchema=z.object({version:z.literal(1),host_boot_id:uuid,mandate_id:uuid,
  native_attempt_id:z.string().regex(/^[0-9a-f]{32}$(?![\s\S])/),request_id:uuid,policy_attempt_id:uuid,
  lease_id:hex,owner_authorization_digest:hex,owner_allocation:limits,
  brokkr_source_revision:z.string().regex(/^[0-9a-f]{40}$(?![\s\S])/),brokkr_config_digest:hex,
  brokkr_release_digest:hex,descriptor_digest:z.literal(ACCOUNTED_DESCRIPTOR),issuer_release_digest:hex,
  producer_release_digest:hex,producer_config_digest:hex,
  allocated_from_boottime_ns:ns,allocated_until_boottime_ns:ns}).strict();
type Intent=z.infer<typeof intentSchema>;
const reservationSchema=z.object({intent:intentSchema,intentDigest:hex}).strict();
const stateSchema=z.object({schemaVersion:z.literal(1),kind:z.literal("accounted-allocation-intent-ledger"),
  hostBootId:uuid,reservation:reservationSchema.nullable()}).strict();
type State=z.infer<typeof stateSchema>;
export const ACCOUNTED_ALLOCATION_LEDGER_V3_DIRECTORY="/var/lib/gille-inference-accounted/allocations";
export class AccountedAllocationIntentError extends Error {
  constructor(readonly code:string,readonly outcome:"refused"|"unknown",readonly attemptConsumed:boolean,cause?:unknown){
    super(code,{cause});this.name="AccountedAllocationIntentError";
  }
}
function need(value:unknown,code:string):asserts value{
  if(!value)throw new AccountedAllocationIntentError(code,"refused",false);
}
const digest=(domain:string,value:unknown)=>createHash("sha256").update(domain+"\n").update(canonicalNative(value)).digest("hex");
function snapshot(value:unknown):unknown{
  const raw=canonicalNative(value);need(Buffer.byteLength(raw)<=16384,"intent_bound");
  const parsed:unknown=JSON.parse(raw);need(canonicalNative(parsed)===raw,"intent_not_lossless");return parsed;
}
function validateIntent(value:unknown):Intent{
  const intent=intentSchema.parse(snapshot(value));
  const from=BigInt(intent.allocated_from_boottime_ns),until=BigInt(intent.allocated_until_boottime_ns);
  const duration=(until-from+999999999n)/1000000000n;
  need(until>from && duration>=30n && duration<=90n,"intent_lease_interval");
  const {digest:allocationDigest,...body}=intent.owner_allocation;
  // Same unchanged R4 domain; these six fields contain only safe integers.
  need(allocationDigest===digest("gille-inference/accounted/owner-allocation/v1",body),"intent_allocation_digest");
  return intent;
}
export function digestAccountedAllocationIntentV3(value:unknown):string{
  return digest("gille-inference/accounted/allocation-intent/v1",validateIntent(value));
}
function validateState(value:unknown,hostBootId:string):State{
  const state=stateSchema.parse(value);need(state.hostBootId===hostBootId,"ledger_boot_binding");
  if(state.reservation){
    const intent=validateIntent(state.reservation.intent);
    need(intent.host_boot_id===state.hostBootId
      && state.reservation.intentDigest===digestAccountedAllocationIntentV3(intent),"ledger_intent_binding");
  }
  return state;
}

/** Pure initial bytes only. Installation must create and authenticate them
 * separately; opening an absent or quarantined ledger never initializes it.
 */
export function planAccountedAllocationLedgerV3Bootstrap(hostBootId:string){
  const state:State={schemaVersion:1,kind:"accounted-allocation-intent-ledger",hostBootId:uuid.parse(hostBootId),reservation:null};
  return {...encodeInitialAccountedIssuerFileRecord(state),state};
}
export interface AccountedAllocationIntentOptions{
  /** Trusted static owner configuration; never deserialized requester options.
   * The future production loader must use one fixed HOST-GLOBAL root directory.
   */
  directory:string;ownerUid:number;initialVersion:string;acceptedIntent:unknown;
  /** Actual shared directory identity from the accepted host installation
   * receipt, not a per-mandate self-observation or requester declaration.
   * Mandatory for root; non-root filesystem tests may also exercise this pin.
   */
  directoryIdentity?:{device:string;inode:string};
}
export interface AccountedAllocationIntentReceipt{
  status:"reserved"|"refused";reason:string;intentDigest:string;ledgerRevision:string;
  attemptConsumed:true;actualAllocationVerified:false;executionAuthorized:false;
}

export async function openAccountedAllocationIntentLedgerV3(options:Readonly<AccountedAllocationIntentOptions>){
  const {directory,ownerUid,initialVersion}=options;
  // An elevated caller cannot create per-mandate ledger islands. Own-UID
  // filesystem tests have no root authority; the backend also checks real EUID.
  if(ownerUid===0)need(directory===ACCOUNTED_ALLOCATION_LEDGER_V3_DIRECTORY,"ledger_global_directory");
  const identity=options.directoryIdentity===undefined?null:
    z.object({device:ns,inode:ns.refine(value=>NS_PATTERN.test(value)&&BigInt(value)>0n)}).strict().parse(snapshot(options.directoryIdentity));
  if(ownerUid===0)need(identity!==null,"ledger_directory_pin_required");
  // Retain only canonical immutable bytes, never caller-owned nested objects.
  const accepted=validateIntent(options.acceptedIntent),pin=canonicalNative(accepted);
  const intentDigest=digestAccountedAllocationIntentV3(accepted),hostBootId=accepted.host_boot_id;
  const opened=await openAccountedIssuerFileStorage({directory,ownerUid,initialVersion});
  let directoryPin:Awaited<ReturnType<typeof fs.open>>|undefined;
  async function assertPin(signal:AbortSignal){
    if(identity===null)return;
    signal.throwIfAborted();need(directoryPin!==undefined,"ledger_directory_identity");
    const [held,named]=await Promise.all([directoryPin.stat({bigint:true}),fs.lstat(directory,{bigint:true})]);
    signal.throwIfAborted();
    for(const sample of [held,named])need(sample.isDirectory() && sample.uid===BigInt(ownerUid)
      && (sample.mode&0o7777n)===0o700n && sample.dev===BigInt(identity.device)
      && sample.ino===BigInt(identity.inode),"ledger_directory_identity");
  }
  try{
    if(identity!==null){
      directoryPin=await fs.open(directory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      await assertPin(new AbortController().signal);
    }
  }catch(error){
    try{await directoryPin?.close();}finally{await opened.close();}
    throw error;
  }
  let closed=false,closeRequested=false,active=0;
  let closing:Promise<void>|undefined,drained:(()=>void)|undefined;
  async function operation<T>(action:()=>Promise<T>):Promise<T>{
    need(!closed&&!closeRequested,"ledger_closed");active++;
    try{return await action();}
    finally{active--;if(active===0){const resolve=drained;drained=undefined;resolve?.();}}
  }
  async function current(signal:AbortSignal){
    need(!closed,"ledger_closed");
    await assertPin(signal);
    const view=await opened.storage.read(signal);
    await assertPin(signal);
    return {version:view.version,state:validateState(view.state,hostBootId)};
  }
  return Object.freeze({
    async read(signal:AbortSignal){
      return operation(async()=>{
      const view=await current(signal);
      // A fresh detached snapshot; no mutable alias to accepted configuration.
      return {ledgerRevision:view.version,hostBootId,reservation:view.state.reservation,
        actualAllocationVerified:false as const,executionAuthorized:false as const};
      });
    },
    async reserve(signal:AbortSignal):Promise<AccountedAllocationIntentReceipt>{
      signal.throwIfAborted(); // An already cancelled call performs no write.
      return operation(async()=>{
      try{
        const view=await current(signal);
        const receipt=(status:"reserved"|"refused",reason:string,version:string):AccountedAllocationIntentReceipt=>
          ({status,reason,intentDigest,ledgerRevision:version,attemptConsumed:true,actualAllocationVerified:false,executionAuthorized:false});
        if(view.state.reservation!==null)return receipt("refused","global_reservation_exists",view.version);
        const intent=validateIntent(JSON.parse(pin));
        const next:State={...view.state,reservation:{intent,intentDigest}};
        // Checking the WHOLE host-global state and acquiring it are one CAS.
        // Never scan independent lease files and then O_EXCL only one lease ID.
        const changed=await opened.storage.compareAndSwap(view.version,next,signal);
        if(!changed)return receipt("refused","global_reservation_conflict",view.version);
        const observed=await current(signal);
        need(observed.state.reservation?.intentDigest===intentDigest
          && canonicalNative(observed.state.reservation.intent)===pin,"reservation_readback");
        return receipt("reserved","intent_persisted",observed.version);
      }catch(error){
        // Preserve the actual cause internally, while exposing a bounded public
        // code. Files/locks survive uncertainty; never retry, release or reset.
        throw new AccountedAllocationIntentError("reservation_unresolved","unknown",true,error);
      }
      });
    },
    async close(){
      if(closed)return;
      closeRequested=true;
      if(closing)return closing;
      closing=(async()=>{
        // Keep BOTH pins alive while a read/CAS is in flight. Closing forbids
        // new work but never interrupts an atomic transition or loses cleanup.
        if(active>0)await new Promise<void>(resolve=>{drained=resolve;});
        await opened.close();await directoryPin?.close();closed=true;
      })();
      try{await closing;}catch(error){closing=undefined;throw error;}
    },
  });
}
