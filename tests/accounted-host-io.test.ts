import {describe, expect, it} from "vitest";
import {createHash} from "node:crypto";
import {execFileSync} from "node:child_process";
import {createAccountedHostIoBridge, recoverAccountedHelperFailureEnvelope, type AccountedIoInvocation} from "../src/homeserver/accounted-host-io.js";
import {canonicalNative} from "../src/homeserver/accounted-host-issuer.js";
const binding = {helperPath: "/opt/gille-inference-accounted/releases/"+"a".repeat(64)+"/accounted-host-io.py",
  configurationPath: "/etc/gille-inference-accounted/attempts/"+"b".repeat(32)+".json", configurationDigest: "c".repeat(64)};
describe("fixed IO helper bridge; synthetic executors only", () => {
  it("retains UNKNOWN from an ambiguous cgroup transport without an automatic retry", () => {
    for (const output of [null, '{"result":{},"status":"ok"}', '{"status":"arbitrary"}']) {
      let count = 0;
      const io = createAccountedHostIoBridge(binding, () => {count++; if(output === null) throw new Error("PRIVATE"); return output;});
      let failure: unknown;
      try {io.collectCgroupEnvelopeV1(new AbortController().signal);} catch(error) {failure = error;}
      expect(failure).toMatchObject({outcome:"unknown", operation:"collect_cgroup_envelope_v1"});
      expect(count).toBe(1);
    }
  });
  it("recovers only the exit-2 helper envelope from a real child process failure", () => {
    const run = (script: string, timeout = 5000) => {
      try {return execFileSync(process.execPath, ["-e", script], {encoding:"utf8", timeout, killSignal:"SIGKILL", stdio:["pipe","pipe","pipe"]});}
      catch (error) {return recoverAccountedHelperFailureEnvelope(error, 262144);}
    };
    const refusal = '{"phase":"validation","reason":"cgroup_effective_limit","status":"refused"}\n';
    expect(run(`process.stdout.write(${JSON.stringify(refusal)}); process.stderr.write("PRIVATE"); process.exit(2)`)).toBe(refusal);
    expect(() => run('process.stdout.write(\'{"reason":"root_linux_required","status":"refused"}\\n\'); process.exit(78)')).toThrow("helper_transport_failed");
    expect(() => run('process.stdout.write(\'{"status":"refused"}\'); process.exit(1)')).toThrow("helper_transport_failed");
    expect(() => run("setTimeout(() => {}, 10000)", 200)).toThrow("helper_transport_failed");
    expect(() => recoverAccountedHelperFailureEnvelope({status:2, signal:null, stdout:"x".repeat(11)}, 10)).toThrow("helper_transport_failed");
    expect(() => recoverAccountedHelperFailureEnvelope(null, 10)).toThrow("helper_transport_failed");
    const io = createAccountedHostIoBridge(binding, () => run(`process.stdout.write(${JSON.stringify(refusal)}); process.exit(2)`));
    let failure: unknown;
    try {io.collectCgroupEnvelopeV1(new AbortController().signal);} catch(error) {failure = error;}
    expect(failure).toMatchObject({outcome:"refused", code:"cgroup_effective_limit", operation:"collect_cgroup_envelope_v1"});
  });
  it("retains an explicit bounded physical cgroup refusal without retrying", () => {
    let count = 0;
    const io = createAccountedHostIoBridge(binding, () => {count++; return '{"phase":"validation","reason":"cgroup_effective_limit","status":"refused"}';});
    let failure: unknown;
    try {io.collectCgroupEnvelopeV1(new AbortController().signal);} catch(error) {failure = error;}
    expect(failure).toMatchObject({outcome:"refused", code:"cgroup_effective_limit", operation:"collect_cgroup_envelope_v1"});
    expect(count).toBe(1);
  });
  it("returns exact closed cgroup bytes with large inode integers and no request-selected arguments", () => {
    const limits={memory_bytes:16777216n,cpu_quota_us:1000n,cpu_period_us:100000n,pids_max:4n,swap_bytes:0n};
    const packet={version:1n,status:"observed",channel:"cgroup_envelope_v1",brokkr_config_digest:"a".repeat(64),
      value:{version:1n,kind:"cgroup_envelope_observation",attempt_id:"b".repeat(32),
        native_envelope:{version:1n,unit:"parent.slice",cgroup_path:"/parent.slice",cgroup_device:77n,cgroup_inode:9007199254740993n,limits},
        role_cgroups:(["worker","observer","recovery"] as const).map((role,i)=>({role,unit:role+".service",cgroup_path:"/parent.slice/"+role+".service",cgroup_device:77n,cgroup_inode:9007199254740994n+BigInt(i),limits})),
        observed_from_boottime_ns:9007199254740993n,observed_until_boottime_ns:9007199254740994n}};
    let call:AccountedIoInvocation|undefined;
    const io=createAccountedHostIoBridge(binding, invocation=>{call=invocation;return canonicalNative({status:"ok",result:packet});});
    expect(io.collectCgroupEnvelopeV1(new AbortController().signal)).toBe(canonicalNative(packet));
    expect(call!.arguments).toEqual(["-I","-S","-B",binding.helperPath,binding.configurationPath,binding.configurationDigest,"collect_cgroup_envelope_v1"]);
    expect(call!.input).toBe("");
    const aborted=new AbortController();aborted.abort();
    const unused=createAccountedHostIoBridge(binding,()=>{throw new Error("must not run");});
    expect(()=>unused.collectCgroupEnvelopeV1(aborted.signal)).toThrow();
  });
  it("uses a closed command, environment and bounds; never an ambient shell", () => {
    let call: AccountedIoInvocation | undefined;
    const io = createAccountedHostIoBridge(binding, invocation => {
      call = invocation; return '{"result":{"boottimeNs":"123","utc":"2030-01-01T00:00:00.000000Z"},"status":"ok"}\n';
    });
    expect(io.clock()).toEqual({boottimeNs:"123",utc:"2030-01-01T00:00:00.000000Z"});
    expect(call).toMatchObject({program:"/usr/bin/python3",arguments:["-I","-S","-B",binding.helperPath,binding.configurationPath,binding.configurationDigest,"clock"],timeoutMs:1000,maximumBytes:262144});
    expect(Object.keys(call!.environment).sort()).toEqual(["LANG","LC_ALL","PATH"]);
  });
  it("keeps native inode/nanosecond integers exact", () => {
    const io = createAccountedHostIoBridge(binding, () => '{"result":{"inode":9007199254740993},"status":"ok"}');
    expect(io.context()).toEqual({inode:9007199254740993n});
  });
  it("does not retry unknown writes or echo private error values", async () => {
    let count = 0;
    const io = createAccountedHostIoBridge(binding, () => {count++; throw new Error("PRIVATE_DIAGNOSTIC");});
    await expect(io.publish("{}", "123", new AbortController().signal)).rejects.toMatchObject({code:"helper_operation_unresolved",outcome:"unknown"});
    expect(count).toBe(1);
  });
  it("rejects helpers that return duplicate keys, floats, oversized or extra fields", () => {
    for (const raw of ['{"status":"ok","status":"ok","result":{}}','{"status":"ok","result":1.5}', 'x'.repeat(262145), '{"status":"ok","result":{},"extra":1}']) {
      const io = createAccountedHostIoBridge(binding, () => raw);
      expect(() => io.context()).toThrow();
    }
  });
  it("passes the exact deadline into v2 publication and refuses an already aborted call", async () => {
    const calls: AccountedIoInvocation[] = [];
    const digest = createHash("sha256").update('{"version":2}').digest("hex");
    const io = createAccountedHostIoBridge(binding, call => {calls.push(call);return '{"result":{"sha256":"'+digest+'","status":"published"},"status":"ok"}';});
    await io.publish('{"version":2}', "9007199254740993", new AbortController().signal);
    expect(calls[0].input).toBe('{"bytes":"{\\"version\\":2}","deadline_boottime_ns":9007199254740993}');
    const controller = new AbortController(); controller.abort();
    await expect(io.publish("{}", "123", controller.signal)).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });
  it("never acknowledges helper success with a different publication digest", async () => {
    const io = createAccountedHostIoBridge(binding, () => '{"result":{"sha256":"'+"d".repeat(64)+'","status":"published"},"status":"ok"}');
    await expect(io.publish('{"version":2}', "123", new AbortController().signal)).rejects.toMatchObject({code:"publication_ack_unverified",outcome:"unknown"});
  });
  it("keeps initialization unknown if a write may have completed before a lost acknowledgement", () => {
    for (const execute of [() => {throw new Error("lost acknowledgement");}, () => '{"result":{},"status":"ok"}']) {
      const io = createAccountedHostIoBridge(binding, execute);
      let failure: unknown;
      try {io.initializeClock();} catch (error) {failure=error;}
      expect(failure).toMatchObject({outcome:"unknown",operation:"initialize-clock"});
    }
  });
  it("keeps malformed publication acknowledgement unknown after the helper was invoked", async () => {
    const io = createAccountedHostIoBridge(binding, () => '{"result":{},"status":"ok"}');
    await expect(io.publish('{"version":2}', "123", new AbortController().signal)).rejects.toMatchObject({outcome:"unknown",operation:"publish"});
  });
  it("accepts a bounded configuration even when its string envelope exceeds the native wire bound", () => {
    const configuration = {padding:"x".repeat(65500)};
    const bytes = JSON.stringify(configuration);
    const envelope = JSON.stringify({result:{bytes},status:"ok"});
    expect(Buffer.byteLength(bytes)).toBeLessThanOrEqual(65536);
    expect(Buffer.byteLength(envelope)).toBeGreaterThan(65536);
    const io = createAccountedHostIoBridge(binding, () => envelope);
    expect(io.configuration()).toEqual(configuration);
  });
  it("binds the complete fixed self-test record and preserves unknown after an ambiguous record write", () => {
    const record={version:1,attempt_id:"b".repeat(32),issuer_release_digest:"a".repeat(64),issuer_config_digest:"c".repeat(64),
      boot_id:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",invocation_id:"d".repeat(32),self_test:true,admission_evidence:false};
    const bytes=JSON.stringify(record,Object.keys(record).sort());
    const raw=JSON.stringify({result:{bytes,sha256:createHash("sha256").update(bytes).digest("hex"),status:"recorded"},status:"ok"});
    const io=createAccountedHostIoBridge(binding,()=>raw);
    expect(io.recordSelfTest()).toEqual(record);
    for(const operation of ["recordSelfTest","ready"] as const){
      const broken=createAccountedHostIoBridge(binding,()=>{throw new Error("unknown");});
      let failure:unknown;try{broken[operation]();}catch(error){failure=error;}
      expect(failure).toMatchObject({outcome:"unknown",operation:operation==="ready"?"ready":"self-test-receipt"});
    }
  });
  it("checks create-only journal acknowledgements and never retries an unknown initialization", async () => {
    let calls=0;
    const origin="d".repeat(64),digest="e".repeat(64);
    const io=createAccountedHostIoBridge(binding,()=>{calls++;return JSON.stringify({result:{originVersion:origin,sha256:digest,status:"initialized"},status:"ok"});});
    await io.initializeJournal(origin,digest,new AbortController().signal);expect(calls).toBe(1);
    const broken=createAccountedHostIoBridge(binding,()=>{calls++;return '{"result":{},"status":"ok"}';});
    await expect(broken.initializeJournal(origin,digest,new AbortController().signal)).rejects.toMatchObject({outcome:"unknown",operation:"initialize-journal"});
    expect(calls).toBe(2);
    await expect(io.initializeJournal("invalid",digest,new AbortController().signal)).rejects.toThrow();expect(calls).toBe(2);
  });
  it("rejects arbitrary helper/configuration paths before invoking any executor", () => {
    for (const changed of [{helperPath:"/tmp/evil.py"},{configurationPath:"/etc/passwd"},{configurationDigest:"a".repeat(64)+"\n"}]) {
      let called = false;
      expect(() => createAccountedHostIoBridge({...binding,...changed}, () => {called=true;return "";})).toThrow();
      expect(called).toBe(false);
    }
  });
});
