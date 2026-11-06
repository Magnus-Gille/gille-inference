/** A no-admission startup probe for the SAME issuer bundle and helper runtime.
 * It is never an admission verifier, allocation, native fixture verdict or permit.
 */
import {z} from "zod";
import {ACCOUNTED_DESCRIPTOR, canonicalNative, parseNativeJson, type IssuerClock} from "./accounted-host-issuer.js";

const hex = z.string().regex(/^[0-9a-f]{64}$(?![\s\S])/);
const attempt = z.string().regex(/^[0-9a-f]{32}$(?![\s\S])/);
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$(?![\s\S])/);
const configSchema = z.object({
  version:z.literal(1),
  io:z.object({attempt_id:attempt,issuer_release_digest:hex,brokkr_config_digest:hex,
    descriptor_digest:z.literal(ACCOUNTED_DESCRIPTOR),protected_manifest_digest:hex,host_boot_id:uuid}).strict(),
  accepted:z.object({sourceRevision:z.string().regex(/^[0-9a-f]{40}$(?![\s\S])/),releaseId:hex,
    request:z.object({limits:z.object({addressSpaceLimitBytes:z.number().int().positive().safe()}).strict()}).strict()}).strict(),
  policy:z.object({mode:z.literal("self-test")}).strict(), registry:z.object({}).strict(),
}).strict();
const expectedSchema = z.object({attemptId:attempt,issuerReleaseDigest:hex,configurationDigest:hex}).strict();
export interface AccountedIssuerSelfTestIo {
  configuration(): unknown; context(): unknown;
  initializeClock(): IssuerClock; clock(): IssuerClock;
  recordSelfTest(): Record<string,unknown>;
}
function requireFact(value: unknown): asserts value {if (!value) throw new Error("issuer_self_test_binding");}
function clockValue(clock: IssuerClock): bigint {
  requireFact(typeof clock.boottimeNs === "string" && /^(0|[1-9][0-9]{0,18})$(?![\s\S])/.test(clock.boottimeNs)
    && typeof clock.utc === "string" && /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$(?![\s\S])/.test(clock.utc));
  const boot = BigInt(clock.boottimeNs); requireFact(boot < 2n**63n); return boot;
}

/** The branch calls only these startup operations. Callers pass a narrow frozen
 * facade; TypeScript types/facades are not an OS sandbox. The root helper also
 * rejects admission/replay initialization under a self-test configuration.
 */
export function runAccountedIssuerSelfTest(rawExpected: unknown, io: AccountedIssuerSelfTestIo) {
  const expected = expectedSchema.parse(JSON.parse(canonicalNative(rawExpected)));
  const configuration = configSchema.parse(JSON.parse(canonicalNative(io.configuration())));
  requireFact(configuration.io.attempt_id === expected.attemptId
    && configuration.io.issuer_release_digest === expected.issuerReleaseDigest);
  const context = parseNativeJson(canonicalNative(io.context())) as Record<string,unknown>;
  requireFact(context && context.version === 1n && context.attempt_id === expected.attemptId
    && context.config_digest === configuration.io.brokkr_config_digest
    && context.descriptor_digest === ACCOUNTED_DESCRIPTOR
    && context.source_revision === configuration.accepted.sourceRevision
    && context.release_id === configuration.accepted.releaseId
    && context.unit === `brokkr-accounted-eval-${expected.attemptId}.service`);
  const identity = context.identity as Record<string,unknown>;
  requireFact(identity && identity.boot_id === configuration.io.host_boot_id
    && typeof identity.invocation_id === "string" && /^[0-9a-f]{32}$(?![\s\S])/.test(identity.invocation_id));
  // The helper independently verifies this process's kernel cgroup/namespaces,
  // finite AS and exact effective limits BEFORE initializing the clock file.
  // Local injected-capability tests cannot establish any of those native facts.
  const initial = io.initializeClock(), last = io.clock();
  requireFact(clockValue(last) >= clockValue(initial));
  const receipt = JSON.parse(canonicalNative(io.recordSelfTest())) as Record<string,unknown>;
  requireFact(receipt.version === 1 && receipt.attempt_id === expected.attemptId
    && receipt.issuer_release_digest === expected.issuerReleaseDigest && receipt.issuer_config_digest === expected.configurationDigest
    && receipt.boot_id === identity.boot_id && receipt.invocation_id === identity.invocation_id
    && receipt.self_test === true && receipt.admission_evidence === false);
  return Object.freeze({status:"self_test_complete" as const,admissionPublished:false as const,
    executionAuthorized:false as const,attemptId:expected.attemptId,issuerReleaseDigest:expected.issuerReleaseDigest,
    configurationDigest:expected.configurationDigest,bootId:configuration.io.host_boot_id,
    invocationId:identity.invocation_id,observedBoottimeNs:last.boottimeNs});
}
