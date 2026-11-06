import {describe,expect,it} from "vitest";
import {main} from "../scripts/accounted-host-issuer-live.js";
function fixture(){
  const calls:unknown[]=[],output:string[]=[],digest="a".repeat(64),attempt="b".repeat(32),configurationDigest="c".repeat(64);
  const args=[`/etc/gille-inference-accounted/attempts/${attempt}.json`,configurationDigest,"--self-test"];
  const dependencies={platform:"linux",effectiveUid:0,entryPath:`/opt/gille-inference-accounted/releases/${digest}/accounted-host-issuer.mjs`,
    openIo:(binding:unknown)=>{calls.push(binding);return {} as any;},
    selfTest:((expected:unknown)=>{calls.push(expected);return {status:"self_test_complete",admissionPublished:false,executionAuthorized:false};}) as any,
    write:(value:string)=>{output.push(value);}};
  return {calls,output,digest,attempt,configurationDigest,args,dependencies};
}
describe("fixed issuer entry; pure wiring tests without host execution",()=>{
  it("refuses nonroot/nonLinux before invoking any helper",()=>{
    for(const delta of [{platform:"darwin"},{effectiveUid:1000}]){
      const f=fixture();expect(main(f.args,{...f.dependencies,...delta})).toBe(78);expect(f.calls).toEqual([]);
    }
  });
  it("does not start an incomplete diagnostic pipeline or arbitrary mode",()=>{
    for(const delta of [(f:ReturnType<typeof fixture>)=>f.args.slice(0,2),()=>["x","y","--publish"]]){
      const f=fixture();expect(main(delta(f),f.dependencies)).toBe(2);expect(f.calls).toEqual([]);
    }
  });
  it("binds the exact root configuration, expected digest and SAME bundle release",()=>{
    const f=fixture();expect(main(f.args,f.dependencies)).toBe(0);
    expect(f.calls).toEqual([{helperPath:`/opt/gille-inference-accounted/releases/${f.digest}/accounted-host-io.py`,
      configurationPath:f.args[0],configurationDigest:f.configurationDigest},
      {attemptId:f.attempt,issuerReleaseDigest:f.digest,configurationDigest:f.configurationDigest}]);
    expect(JSON.parse(f.output[0])).toMatchObject({admissionPublished:false,executionAuthorized:false});
  });
  it("retains unknown after a potentially completed audit write without echoing exception text",()=>{
    const f=fixture();f.dependencies.selfTest=()=>{throw new Error("PRIVATE_DIAGNOSTIC");};
    expect(main(f.args,f.dependencies)).toBe(2);expect(f.output.join("")).not.toContain("PRIVATE_DIAGNOSTIC");
    expect(JSON.parse(f.output[0])).toMatchObject({status:"unknown",admissionPublished:false,executionAuthorized:false});
  });
  it("never allows source-tree or requester-selected entry/helper paths",()=>{
    const f=fixture();f.dependencies.entryPath="/tmp/issuer.mjs";
    expect(main(f.args,f.dependencies)).toBe(2);expect(f.calls).toEqual([]);
  });
  it("does not pass publishing or journal initialization operations to the startup branch",()=>{
    const f=fixture();let keys:string[]=[];
    f.dependencies.selfTest=((_expected:unknown,io:object)=>{keys=Object.keys(io);return {status:"self_test_complete",admissionPublished:false,executionAuthorized:false};}) as any;
    expect(main(f.args,f.dependencies)).toBe(0);
    expect(keys.sort()).toEqual(["configuration","context","initializeClock","clock","recordSelfTest"].sort());
    expect(keys).not.toContain("publish");expect(keys).not.toContain("initializeJournal");
  });
});
