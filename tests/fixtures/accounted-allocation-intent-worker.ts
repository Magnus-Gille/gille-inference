/** Test-only, nonroot two-process filesystem-CAS probe; no production loader. */
import {openAccountedAllocationIntentLedgerV3,AccountedAllocationIntentError} from "../../src/homeserver/accounted-allocation-intent-v3.js";

const timer=setTimeout(()=>{process.exitCode=2;process.disconnect?.();},4000);
const send=(value:unknown)=>{if(!process.send)throw new Error("test_ipc_required");process.send(value);};
const receive=()=>new Promise<unknown>(resolve=>process.once("message",resolve));
async function main(){
  if(typeof process.geteuid!=="function" || process.geteuid()===0)throw new Error("nonroot_test_required");
  const incoming=receive();send({phase:"awaiting_request"});
  const raw=await incoming;
  if(raw===null || typeof raw!=="object" || Buffer.byteLength(JSON.stringify(raw))>32768)throw new Error("test_request");
  const request=raw as Record<string,unknown>;
  if(Object.keys(request).sort().join(",")!=="acceptedIntent,directory,directoryIdentity,initialVersion,ownerUid"
    || request.directory!==process.env.ALLOCATION_TEST_DIRECTORY || request.ownerUid!==process.geteuid()
    || typeof request.directory!=="string" || typeof request.initialVersion!=="string")throw new Error("test_request");
  const opened=await openAccountedAllocationIntentLedgerV3({directory:request.directory,
    ownerUid:request.ownerUid as number,initialVersion:request.initialVersion,acceptedIntent:request.acceptedIntent,
    directoryIdentity:request.directoryIdentity as {device:string;inode:string}});
  try{
    const before=await opened.read(new AbortController().signal);
    const go=receive();send({phase:"ready",version:before.ledgerRevision,empty:before.reservation===null});
    if(await go!=="go")throw new Error("test_go");
    try{send({phase:"result",receipt:await opened.reserve(new AbortController().signal)});}
    catch(error){
      if(!(error instanceof AccountedAllocationIntentError) || error.outcome!=="unknown")throw error;
      send({phase:"result",receipt:{status:"unknown",code:error.code,outcome:error.outcome,attemptConsumed:error.attemptConsumed}});
    }
  }finally{await opened.close();}
}
main().then(()=>{clearTimeout(timer);process.disconnect?.();}).catch(()=>{
  clearTimeout(timer);process.exitCode=2;send({phase:"unexpected_failure"});process.disconnect?.();
});
