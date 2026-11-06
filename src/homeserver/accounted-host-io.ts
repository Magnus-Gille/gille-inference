/** Fixed root-helper transport. Injected executors are trusted code capabilities,
 * never deserialized request/config fields. No host action occurs at import.
 */
import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import {dirname} from "node:path";
import {canonicalNative, parseAccountedHelperJson, type IssuerClock} from "./accounted-host-issuer.js";
import {parseCgroupChannelV1} from "./accounted-cgroup-channel-v3.js";
import {parseCgroupKernelChargesV1} from "./accounted-kernel-counters-v1.js";

export interface AccountedIoInvocation {
  program: "/usr/bin/python3"; arguments: readonly string[];
  environment: Readonly<Record<string,string>>; workingDirectory: string;
  timeoutMs: 1000; maximumBytes: 262144; input: string;
}
export type AccountedIoExecutor = (invocation: Readonly<AccountedIoInvocation>) => string;
type Operation = "configuration"|"initialize-clock"|"clock"|"context"|"challenge"|"publish"|"self-test-receipt"|"ready"|"initialize-journal"|"collect_cgroup_envelope_v1"|"collect_cgroup_kernel_charges_v1";
type WriteOperation = "initialize-clock"|"publish"|"self-test-receipt"|"ready"|"initialize-journal";
export interface AccountedIoBinding {helperPath: string; configurationPath: string; configurationDigest: string}
export class AccountedHostIoError extends Error {
  constructor(readonly code: string, readonly outcome: "refused"|"unknown", readonly operation: string, cause?: unknown) {
    super(code, {cause}); this.name = "AccountedHostIoError";
  }
}
function need(value: unknown, code: string): asserts value {
  if (!value) throw new AccountedHostIoError(code, "refused", "configuration");
}
function object(value: unknown): Record<string,unknown> {
  need(value !== null && typeof value === "object" && !Array.isArray(value), "helper_result_shape");
  return value as Record<string,unknown>;
}
function exact(value: Record<string,unknown>, keys: string[]): void {
  need(Object.keys(value).sort().join(",") === [...keys].sort().join(","), "helper_result_shape");
}
function clockValue(value: unknown): IssuerClock {
  const c = object(value); exact(c, ["boottimeNs","utc"]);
  need(typeof c.boottimeNs === "string" && /^(0|[1-9][0-9]{0,18})$(?![\s\S])/.test(c.boottimeNs)
    && BigInt(c.boottimeNs) < 2n**63n && typeof c.utc === "string"
    && /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$(?![\s\S])/.test(c.utc), "helper_clock");
  return {boottimeNs:c.boottimeNs,utc:c.utc};
}

export function createAccountedHostIoBridge(binding: Readonly<AccountedIoBinding>, execute: AccountedIoExecutor) {
  // Snapshot primitive configuration before retaining it. It is configured by a
  // reviewed root loader; a request cannot select paths, programs or executors.
  const {helperPath, configurationPath, configurationDigest} = binding;
  need(typeof helperPath === "string" && /^\/opt\/gille-inference-accounted\/releases\/[0-9a-f]{64}\/accounted-host-io\.py$(?![\s\S])/.test(helperPath), "helper_path");
  need(typeof configurationPath === "string" && /^\/etc\/gille-inference-accounted\/attempts\/[0-9a-f]{32}\.json$(?![\s\S])/.test(configurationPath), "configuration_path");
  need(typeof configurationDigest === "string" && /^[0-9a-f]{64}$(?![\s\S])/.test(configurationDigest) && typeof execute === "function", "configuration_digest");
  function invoke(operation: Operation, input = ""): unknown {
    const mayWrite = ["publish","initialize-clock","self-test-receipt","ready","initialize-journal"].includes(operation);
    const consumedRead = operation === "collect_cgroup_envelope_v1" || operation === "collect_cgroup_kernel_charges_v1";
    let value: unknown;
    try {
      const raw = execute(Object.freeze({program:"/usr/bin/python3", arguments:Object.freeze(["-I","-S","-B",helperPath,configurationPath,configurationDigest,operation]),
        environment:Object.freeze({PATH:"/usr/bin:/bin",LANG:"C",LC_ALL:"C"}), workingDirectory:dirname(helperPath), timeoutMs:1000, maximumBytes:262144, input}));
      need(typeof raw === "string" && Buffer.byteLength(raw) <= 262144, "helper_output_bound");
      value = parseAccountedHelperJson(raw);
      const envelope = object(value);
      if (envelope.status !== "ok") {
        if (consumedRead) {
          need(envelope.status === "refused" || envelope.status === "unknown", "helper_failure_status");
          exact(envelope, ["status","reason", ...(envelope.phase === undefined ? [] : ["phase"])]);
          need(typeof envelope.reason === "string" && /^[a-z][a-z0-9_]{0,63}$(?![\s\S])/.test(envelope.reason)
            && (envelope.phase === undefined || typeof envelope.phase === "string"
              && /^[a-z][a-z0-9_]{0,63}$(?![\s\S])/.test(envelope.phase)), "helper_failure_shape");
        }
        const reason = typeof envelope.reason === "string" && /^[a-z][a-z0-9_]{0,63}$(?![\s\S])/.test(envelope.reason) ? envelope.reason : "helper_refused";
        throw new AccountedHostIoError(reason, envelope.status === "unknown" || mayWrite ? "unknown" : "refused", operation);
      }
      exact(envelope, ["result","status"]); return envelope.result;
    } catch (error) {
      if (error instanceof AccountedHostIoError && error.operation === operation) throw error;
      throw new AccountedHostIoError("helper_operation_unresolved", mayWrite || consumedRead ? "unknown" : "refused", operation, error);
    }
  }
  function writeAcknowledgement<T>(operation: WriteOperation, verify: () => T): T {
    try {return verify();}
    catch (error) {
      if (error instanceof AccountedHostIoError && error.operation === operation && error.outcome === "unknown") throw error;
      throw new AccountedHostIoError("helper_ack_unverified", "unknown", operation, error);
    }
  }
  function runtimeRecord(kind: "ready"|"self-test-receipt"): Record<string,unknown> {
    return writeAcknowledgement(kind, () => {
      const result = object(invoke(kind)); exact(result,["status","sha256","bytes"]);
      need(result.status === "recorded" && typeof result.bytes === "string" && Buffer.byteLength(result.bytes) <= 16384
        && result.sha256 === createHash("sha256").update(result.bytes).digest("hex"), "runtime_record_ack");
      const body: unknown = JSON.parse(result.bytes), record = object(body);
      need(canonicalNative(record) === result.bytes, "runtime_record_canonical");
      exact(record,["version","attempt_id","issuer_release_digest","issuer_config_digest","boot_id","invocation_id",
        ...(kind === "self-test-receipt" ? ["self_test","admission_evidence"] : [])]);
      const expectedAttempt = configurationPath.slice(configurationPath.lastIndexOf("/")+1,-5);
      const expectedRelease = helperPath.split("/")[4];
      need(record.version === 1 && record.attempt_id === expectedAttempt && record.issuer_release_digest === expectedRelease
        && record.issuer_config_digest === configurationDigest
        && typeof record.boot_id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$(?![\s\S])/.test(record.boot_id)
        && typeof record.invocation_id === "string" && /^[0-9a-f]{32}$(?![\s\S])/.test(record.invocation_id)
        && (kind !== "self-test-receipt" || (record.self_test === true && record.admission_evidence === false)), "runtime_record_binding");
      return Object.freeze(record);
    });
  }
  return Object.freeze({
    configuration(): unknown {
      const result = object(invoke("configuration")); exact(result,["bytes"]);
      need(typeof result.bytes === "string" && Buffer.byteLength(result.bytes) <= 65536, "configuration_bound");
      const parsed: unknown = JSON.parse(result.bytes);
      need(canonicalNative(parsed) === result.bytes, "configuration_not_lossless");
      return parsed;
    },
    initializeClock(): IssuerClock {return writeAcknowledgement("initialize-clock", () => clockValue(invoke("initialize-clock")));},
    clock(): IssuerClock {return clockValue(invoke("clock"));},
    context(): unknown {return invoke("context");},
    collectCgroupEnvelopeV1(signal: AbortSignal): string {
      signal.throwIfAborted();
      try {
        const raw = canonicalNative(invoke("collect_cgroup_envelope_v1"));
        parseCgroupChannelV1(raw);
        signal.throwIfAborted();
        return raw;
      } catch(error) {
        if(error instanceof AccountedHostIoError && error.operation === "collect_cgroup_envelope_v1") throw error;
        throw new AccountedHostIoError("cgroup_ack_unverified", "unknown", "collect_cgroup_envelope_v1", error);
      }
    },
    collectCgroupKernelChargesV1(signal:AbortSignal):string {
      signal.throwIfAborted();
      try {
        // Inner canonical JSON contains escaped kernel TAB/LF; outer bytes is
        // printable ASCII, preserving the existing strict helper codec.
        const result=object(invoke("collect_cgroup_kernel_charges_v1"));exact(result,["bytes"]);
        need(typeof result.bytes==="string" && Buffer.byteLength(result.bytes)<=65536,"kernel_packet_bound");
        parseCgroupKernelChargesV1(result.bytes);signal.throwIfAborted();return result.bytes;
      }catch(error){
        if(error instanceof AccountedHostIoError && error.operation==="collect_cgroup_kernel_charges_v1")throw error;
        throw new AccountedHostIoError("kernel_ack_unverified","unknown","collect_cgroup_kernel_charges_v1",error);
      }
    },
    ready(): Record<string,unknown> {return runtimeRecord("ready");},
    recordSelfTest(): Record<string,unknown> {return runtimeRecord("self-test-receipt");},
    async initializeJournal(originVersion:string,bytesSha256:string,signal:AbortSignal):Promise<void> {
      signal.throwIfAborted();
      need(typeof originVersion === "string" && /^[0-9a-f]{64}$(?![\s\S])/.test(originVersion)
        && typeof bytesSha256 === "string" && /^[0-9a-f]{64}$(?![\s\S])/.test(bytesSha256),"journal_bootstrap_expectation");
      writeAcknowledgement("initialize-journal",()=>{
        const result=object(invoke("initialize-journal"));exact(result,["status","originVersion","sha256"]);
        need(result.status === "initialized" && result.originVersion === originVersion && result.sha256 === bytesSha256,
          "journal_bootstrap_ack");
        signal.throwIfAborted();
      });
    },
    challenge(signal: AbortSignal): Promise<string> {
      signal.throwIfAborted();
      const result = object(invoke("challenge")); exact(result,["bytes"]);
      need(typeof result.bytes === "string" && result.bytes.length <= 16384, "challenge_bound");
      signal.throwIfAborted(); return Promise.resolve(result.bytes);
    },
    async publish(bytes: string, deadline: string, signal: AbortSignal): Promise<void> {
      signal.throwIfAborted();
      need(typeof bytes === "string" && Buffer.byteLength(bytes) > 0 && Buffer.byteLength(bytes) <= 65536
        && typeof deadline === "string" && /^[1-9][0-9]{0,18}$(?![\s\S])/.test(deadline) && BigInt(deadline) < 2n**63n, "publication_input");
      writeAcknowledgement("publish", () => {
        const result = object(invoke("publish",canonicalNative({bytes,deadline_boottime_ns:BigInt(deadline)})));
        exact(result,["sha256","status"]);
        if (result.status !== "published" || result.sha256 !== createHash("sha256").update(bytes).digest("hex")) {
          throw new AccountedHostIoError("publication_ack_unverified", "unknown", "publish");
        }
        signal.throwIfAborted();
      });
    },
  });
}

/** Production executor has no shell or inherited environment. An outer admitted
 * unit/watchdog and native timing proof remain mandatory: execFileSync itself
 * is neither an isolation boundary nor a guarantee against blocked kernel IO.
 */
export function executeAccountedHostIo(invocation: Readonly<AccountedIoInvocation>): string {
  need(process.platform === "linux" && typeof process.geteuid === "function" && process.geteuid() === 0, "root_linux_required");
  const environment: Record<string,string> = {...invocation.environment};
  const operation=invocation.arguments.at(-1);
  if(operation === "collect_cgroup_envelope_v1" || operation === "collect_cgroup_kernel_charges_v1") {
    // One explicitly public systemd field, never ambient environment copying.
    const publicInvocationId=process.env.INVOCATION_ID;
    if(typeof publicInvocationId !== "string" || !/^[0-9a-f]{32}$(?![\s\S])/.test(publicInvocationId))
      throw new AccountedHostIoError("public_invocation_unavailable", "refused", operation);
    environment.INVOCATION_ID=publicInvocationId;
  }
  return execFileSync(invocation.program, [...invocation.arguments], {
    shell:false, encoding:"utf8", env:environment, cwd:invocation.workingDirectory,
    timeout:invocation.timeoutMs, killSignal:"SIGKILL", maxBuffer:invocation.maximumBytes,
    input:invocation.input, stdio:["pipe","pipe","pipe"],
  });
}
