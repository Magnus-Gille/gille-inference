import {describe,expect,it} from "vitest";
import {ACCOUNTED_DESCRIPTOR} from "../src/homeserver/accounted-host-issuer.js";
import {runAccountedIssuerSelfTest} from "../src/homeserver/accounted-issuer-self-test.js";
function fixture() {
  const attemptId="a".repeat(32),issuerReleaseDigest="b".repeat(64),configurationDigest="c".repeat(64);
  const expected={attemptId,issuerReleaseDigest,configurationDigest};
  const config={version:1,io:{attempt_id:attemptId,issuer_release_digest:issuerReleaseDigest,brokkr_config_digest:"d".repeat(64),
    descriptor_digest:ACCOUNTED_DESCRIPTOR,protected_manifest_digest:"e".repeat(64),host_boot_id:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"},
    accepted:{sourceRevision:"f".repeat(40),releaseId:"1".repeat(64),request:{limits:{addressSpaceLimitBytes:17179869184}}},
    policy:{mode:"self-test"},registry:{}};
  const context={version:1,attempt_id:attemptId,unit:`brokkr-accounted-eval-${attemptId}.service`,
    config_digest:config.io.brokkr_config_digest,descriptor_digest:ACCOUNTED_DESCRIPTOR,
    source_revision:config.accepted.sourceRevision,release_id:config.accepted.releaseId,
    identity:{boot_id:config.io.host_boot_id,invocation_id:"2".repeat(32)}};
  const calls:string[]=[];
  const io={configuration:()=>{calls.push("configuration");return config;},context:()=>{calls.push("context");return context;},
    initializeClock:()=>{calls.push("initialize-clock");return {boottimeNs:"123",utc:"2030-01-01T00:00:00.000000Z"};},
    clock:()=>{calls.push("clock");return {boottimeNs:"124",utc:"2030-01-01T00:00:00.000000Z"};},
    recordSelfTest:()=>{calls.push("self-test-receipt");return {version:1,attempt_id:attemptId,issuer_release_digest:issuerReleaseDigest,
      issuer_config_digest:configurationDigest,boot_id:config.io.host_boot_id,invocation_id:context.identity.invocation_id,
      self_test:true,admission_evidence:false};}};
  return {expected,config,context,calls,io};
}
describe("issuer runtime self-test; never admission",()=>{
  it("uses only fixed startup capabilities and never claims execution authority",()=>{
    const f=fixture();expect(runAccountedIssuerSelfTest(f.expected,f.io)).toMatchObject({status:"self_test_complete",admissionPublished:false,executionAuthorized:false});
    expect(f.calls).toEqual(["configuration","context","initialize-clock","clock","self-test-receipt"]);
  });
  it("rejects diagnostic-mode or extra provider data before clock initialization",()=>{
    for(const change of [(f:ReturnType<typeof fixture>)=>{f.config.policy.mode="diagnostic";},
      (f:ReturnType<typeof fixture>)=>{Object.assign(f.config.registry,{verifier:"pretend"});}]){
      const f=fixture();change(f);expect(()=>runAccountedIssuerSelfTest(f.expected,f.io)).toThrow();
      expect(f.calls).toEqual(["configuration"]);
    }
  });
  it("binds startup to the accepted source, config, boot and invocation before writes",()=>{
    for(const key of ["source_revision","release_id","config_digest","attempt_id"]){
      const f=fixture();(f.context as Record<string,unknown>)[key]="invalid";
      expect(()=>runAccountedIssuerSelfTest(f.expected,f.io)).toThrow();expect(f.calls).toEqual(["configuration","context"]);
    }
  });
  it("refuses a regressing native clock without any publication path",()=>{
    const f=fixture();f.io.clock=()=>({boottimeNs:"122",utc:"2030-01-01T00:00:00.000000Z"});
    expect(()=>runAccountedIssuerSelfTest(f.expected,f.io)).toThrow();
  });
  it("rejects an audit record that could be confused with admission evidence",()=>{
    const f=fixture(),record=f.io.recordSelfTest();
    f.io.recordSelfTest=()=>({...record,admission_evidence:true});
    expect(()=>runAccountedIssuerSelfTest(f.expected,f.io)).toThrow();
  });
});
