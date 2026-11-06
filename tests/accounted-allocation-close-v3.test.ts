import {expect,it,vi} from "vitest";
import * as fs from "node:fs/promises";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {canonicalNative} from "../src/homeserver/accounted-host-issuer.js";
import {openAccountedAllocationIntentLedgerV3,planAccountedAllocationLedgerV3Bootstrap} from "../src/homeserver/accounted-allocation-intent-v3.js";
const hooks=vi.hoisted(()=>({directory:"", handles:[] as any[], enter:null as null|(()=>void), release:null as null|Promise<void>, pauseAt:"read" as "read"|"sync"}));
vi.mock("node:fs/promises",async original=>{
 const actual=await original<typeof import("node:fs/promises")>();
 return {...actual,open:async(...args:Parameters<typeof actual.open>)=>{
  const handle=await actual.open(...args);
  if(String(args[0])===hooks.directory)hooks.handles.push(handle);
  const read=handle.read.bind(handle);
  handle.read=async(...params:any[])=>{
   if(String(args[0])===join(hooks.directory,"journal.json")&&hooks.enter&&hooks.pauseAt==="read"){
    const entered=hooks.enter;hooks.enter=null;entered();await hooks.release;
   }
   return (read as any)(...params);
  };
  const sync=handle.sync.bind(handle);
  handle.sync=async()=>{
   await sync();
   if(String(args[0]).startsWith(hooks.directory+"/")&&hooks.enter&&hooks.pauseAt==="sync"){
    const entered=hooks.enter;hooks.enter=null;entered();await hooks.release;
   }
  };
  return handle;
 }};
});
const uuid="11111111-1111-4111-8111-111111111111";
const hostBootId="22222222-2222-4222-8222-222222222222";
const H=(n:string)=>n.repeat(64);
const sha=(domain:string,value:unknown)=>createHash("sha256").update(domain+"\n"+canonicalNative(value)).digest("hex");
function accepted(overrides: Record<string, unknown> = {}): any {
  const allocationBody = {
    chargedMemoryMaxBytes: 16 * 1024 * 1024,
    swapMaxBytes: 0,
    cpuQuotaMicros: 1000,
    cpuPeriodMicros: 100000,
    tasksMax: 4,
    addressSpaceLimitBytes: 128 * 1024 * 1024,
  };
  const intent: any = {
    version: 1,
    host_boot_id: hostBootId,
    mandate_id: uuid,
    native_attempt_id: "a".repeat(32),
    request_id: "33333333-3333-4333-8333-333333333333",
    policy_attempt_id: "44444444-4444-4444-8444-444444444444",
    lease_id: H("5"),
    owner_authorization_digest: H("6"),
    owner_allocation: { ...allocationBody, digest: sha("gille-inference/accounted/owner-allocation/v1", allocationBody) },
    brokkr_source_revision: "b".repeat(40),
    brokkr_config_digest: H("7"),
    brokkr_release_digest: H("8"),
    descriptor_digest: "7d97cb1f350f1aaa25b9abfef518f5b8f5b42af77ace1dfa49216692e42f5bde",
    issuer_release_digest: H("9"),
    producer_release_digest: H("a"),
    producer_config_digest: H("b"),
    allocated_from_boottime_ns: "1000000000",
    allocated_until_boottime_ns: "31100000000",
  };
  return { ...intent, ...overrides };
}

for(const action of ["read","reserve-read","reserve-sync"] as const)it("closes both real directory FDs after concurrent "+action,async()=>{
 const ownerUid=process.geteuid!();if(ownerUid===0)throw Error("nonroot only");
 const directory=await fs.mkdtemp(join(await fs.realpath("/tmp"), "allocation-close-"));
 await fs.chmod(directory,0o700);hooks.directory=directory;hooks.pauseAt=action==="reserve-sync"?"sync":"read";
 const initial=planAccountedAllocationLedgerV3Bootstrap(hostBootId);
 await fs.writeFile(join(directory,"journal.json"),initial.bytes,{mode:0o600,flag:"wx"});
 const id=await fs.stat(directory,{bigint:true});
 const ledger=await openAccountedAllocationIntentLedgerV3({directory,ownerUid,initialVersion:initial.version,acceptedIntent:accepted(),directoryIdentity:{device:id.dev.toString(),inode:id.ino.toString()}});
 let release!:()=>void;hooks.release=new Promise<void>(resolve=>release=resolve);
 const entered=new Promise<void>(resolve=>hooks.enter=resolve);
 const pending=(action==="read"?ledger.read(new AbortController().signal):ledger.reserve(new AbortController().signal))
  .then(value=>({value,error:undefined}),error=>({value:undefined,error}));
 let closing:Promise<{error?:unknown}>|undefined;
 try{
  await entered;
  closing=ledger.close().then(()=>({}),error=>({error}));
  release();const result=await pending;const closed=await closing;
  expect(closed.error).toBeUndefined();expect(result.error).toBeUndefined();
  if(action!=="read")expect(result.value).toMatchObject({status:"reserved"});
  await ledger.close();
  expect(hooks.handles.map(h=>h.fd)).toEqual([-1,-1]);
  await expect(ledger.read(new AbortController().signal)).rejects.toMatchObject({code:"ledger_closed"});
 }finally{
  release();await pending;await closing;hooks.enter=null;hooks.release=null;
  for(const h of hooks.handles.splice(0))if(h.fd!==-1)await h.close();
  const stat=await fs.lstat(directory);if(!stat.isDirectory()||stat.uid!==ownerUid)throw Error("cleanup identity");
  await fs.rm(directory,{recursive:true});
 }
});
