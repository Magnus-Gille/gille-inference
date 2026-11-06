import {describe,expect,it} from "vitest";
import {createAccountedHostIoBridge,type AccountedIoInvocation} from "../src/homeserver/accounted-host-io.js";
import {parseCgroupKernelChargesV1} from "../src/homeserver/accounted-kernel-counters-v1.js";
import {raw} from "./fixtures/accounted-kernel-fixture-v1.js";
const binding={helperPath:"/opt/gille-inference-accounted/releases/"+"a".repeat(64)+"/accounted-host-io.py",
  configurationPath:"/etc/gille-inference-accounted/attempts/"+"b".repeat(32)+".json",configurationDigest:"c".repeat(64)};
describe("fixed kernel channel transport; synthetic executors only",()=>{
  it("preserves raw TAB/LF through a printable inner JSON byte-string without weakening the helper codec",()=>{
    const bytes=raw();let invocation:AccountedIoInvocation|undefined;
    expect(bytes.includes("\n")).toBe(false);expect(bytes.includes("\\n")).toBe(true);
    const io=createAccountedHostIoBridge(binding,call=>{invocation=call;return JSON.stringify({result:{bytes},status:"ok"})+"\n";});
    const observed=io.collectCgroupKernelChargesV1(new AbortController().signal);
    expect(observed).toBe(bytes);
    expect(parseCgroupKernelChargesV1(observed).value.passes[0].scope_samples[0].cpu_stat).toContain("\n");
    expect(invocation!.arguments).toEqual(["-I","-S","-B",binding.helperPath,binding.configurationPath,binding.configurationDigest,"collect_cgroup_kernel_charges_v1"]);
    expect(invocation!.input).toBe("");
    expect(Object.keys(invocation!.environment).sort()).toEqual(["LANG","LC_ALL","PATH"]);
  });
  it.each([null,'{"result":{},"status":"ok"}','{"result":{"bytes":"{}"},"status":"ok"}','{"status":"arbitrary"}'])
  ("retains ambiguous or malformed acknowledgement UNKNOWN without retry",output=>{
    let count=0;const io=createAccountedHostIoBridge(binding,()=>{count++;if(output===null)throw new Error("synthetic transport failure");return output;});
    let failure:unknown;try{io.collectCgroupKernelChargesV1(new AbortController().signal);}catch(error){failure=error;}
    expect(failure).toMatchObject({outcome:"unknown",operation:"collect_cgroup_kernel_charges_v1"});expect(count).toBe(1);
  });
  it("preserves an explicit known refusal and does not invoke after an already cancelled signal",()=>{
    let count=0;const io=createAccountedHostIoBridge(binding,()=>{count++;return '{"phase":"validation","reason":"kernel_io_refused","status":"refused"}';});
    let failure:unknown;try{io.collectCgroupKernelChargesV1(new AbortController().signal);}catch(error){failure=error;}
    expect(failure).toMatchObject({code:"kernel_io_refused",outcome:"refused",operation:"collect_cgroup_kernel_charges_v1"});
    const aborted=new AbortController();aborted.abort();expect(()=>io.collectCgroupKernelChargesV1(aborted.signal)).toThrow();expect(count).toBe(1);
  });
});
