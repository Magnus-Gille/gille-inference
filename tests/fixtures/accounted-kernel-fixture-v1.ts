import {createHash} from "node:crypto";
import {canonicalNative} from "../../src/homeserver/accounted-host-issuer.js";
import {digestAccountedNativeEnvelopeV3,digestAccountedNativeRoleScopesV3} from "../../src/homeserver/accounted-native-envelope-v3.js";

const attemptId = "a".repeat(32), parentUnit = `brokkr_accounted_${attemptId}.slice`, parentPath = `/${parentUnit}`;
const workerUnit = `brokkr-accounted-eval-${attemptId}.service`, observerUnit = `brokkr-accounted-observer-${attemptId}.service`, recoveryUnit = `brokkr-accounted-recovery-${attemptId}.service`;
const bootId = "11111111-1111-4111-8111-111111111111", revision = "b".repeat(40), configDigest = "c".repeat(64), releaseDigest = "d".repeat(64), descriptor = "7d97cb1f350f1aaa25b9abfef518f5b8f5b42af77ace1dfa49216692e42f5bde";
const parentLimits = () => ({memory_bytes: 128n * 1024n * 1024n, cpu_quota_us: 9000n, cpu_period_us: 100000n, pids_max: 12n, swap_bytes: 0n});
const childLimits = (memory: bigint, cpu: bigint, pids: bigint) => ({memory_bytes: memory, cpu_quota_us: cpu, cpu_period_us: 100000n, pids_max: pids, swap_bytes: 0n});
export function identity(path: string, inode: bigint, invocation: string) { return {boot_id: bootId, invocation_id: invocation, cgroup_path: path, cgroup_device: 77n, cgroup_inode: inode, namespace_inodes: {mnt: inode + 10n, net: inode + 11n, ipc: inode + 12n, pid: inode === 101n ? 114n : 115n}}; }
export function challengeValue() {
  const wi = identity(`${parentPath}/${workerUnit}`, 101n, "1".repeat(32));
  return {version: 2n, attempt_id: attemptId, unit: workerUnit, source_revision: revision, release_id: releaseDigest, config_digest: configDigest, descriptor_digest: descriptor,
    identity: wi, limits: {memory_bytes: 64n * 1024n * 1024n, cpu_quota_us: 2000n, cpu_period_us: 100000n, pids_max: 4n}, observed_boottime_ns: 200n,
    native_envelope: {version: 1n, unit: parentUnit, cgroup_path: parentPath, cgroup_device: 77n, cgroup_inode: 100n, limits: parentLimits()},
    native_role_scopes: [
      {role: "worker" as const, unit: workerUnit, identity: wi, limits: childLimits(64n * 1024n * 1024n, 2000n, 4n), address_space_limit_bytes: 16n * 1024n * 1024n, started_boottime_lower_ns: 50n, stop_by_boottime_ns: 500n},
      {role: "observer" as const, unit: observerUnit, identity: identity(`${parentPath}/${observerUnit}`, 102n, "2".repeat(32)), limits: childLimits(32n * 1024n * 1024n, 1000n, 4n), address_space_limit_bytes: 16n * 1024n * 1024n, started_boottime_lower_ns: 50n, stop_by_boottime_ns: 500n},
      {role: "recovery" as const, unit: recoveryUnit, identity: identity(`${parentPath}/${recoveryUnit}`, 103n, "3".repeat(32)), limits: childLimits(32n * 1024n * 1024n, 1000n, 4n), address_space_limit_bytes: 16n * 1024n * 1024n, started_boottime_lower_ns: 50n, stop_by_boottime_ns: 500n},
    ]};
}
export function allocation() { return {chargedMemoryMaxBytes: 128 * 1024 * 1024, swapMaxBytes: 0, cpuQuotaMicros: 9000, cpuPeriodMicros: 100000, tasksMax: 12, addressSpaceLimitBytes: 16 * 1024 * 1024}; }
export function expectedValue() {
  const challenge = challengeValue(), challengeJson = canonicalNative(challenge);
  const binding = {version: 1n, mandate_id: "22222222-2222-4222-8222-222222222222", native_attempt_id: attemptId, request_id: "33333333-3333-4333-8333-333333333333", policy_attempt_id: "44444444-4444-4444-8444-444444444444",
    challenge_digest: createHash("sha256").update(challengeJson).digest("hex"), owner_envelope_digest: "e".repeat(64), brokkr_source_revision: revision, brokkr_config_digest: configDigest, brokkr_release_digest: releaseDigest,
    descriptor_digest: descriptor, issuer_release_digest: "f".repeat(64), producer_release_digest: "1".repeat(64), producer_config_digest: "2".repeat(64), boot_id: bootId, observer_instance_digest: "3".repeat(64), sequence: 1n,
    native_envelope_digest: digestAccountedNativeEnvelopeV3(challenge.native_envelope), native_role_scopes_digest: digestAccountedNativeRoleScopesV3(challenge.native_role_scopes), lease_id: "4".repeat(64), ledger_revision: "5".repeat(64), allocated_from_boottime_ns: 50n, allocated_until_boottime_ns: 1000n};
  return {challenge, expected: {challengeJson, runBindingJson: canonicalNative(binding), allocation: allocation(), nowNs: 400n, maximumAgeNs: 5_000_000_000n}};
}
const cpu = (n: bigint) => `usage_usec ${100n+n}\nuser_usec ${80n+n}\nsystem_usec 7\nnr_periods ${10n+n}\nnr_throttled ${2n+n}\nthrottled_usec ${5n+n}\nnr_bursts ${n}\nburst_usec ${n}`;
const memoryStat = (n: bigint) => `anon ${10n+n}\nfile ${20n+n}\nkernel ${30n+n}\nsock ${n}`;
const memoryEvents = (n: bigint) => `low ${n}\nhigh ${n}\nmax ${n}\noom ${n}\noom_kill ${n}\noom_group_kill ${n}`;
const pidsEvents = (n: bigint) => `max ${n}`;
export function roleScopes(challenge: ReturnType<typeof challengeValue>) { return challenge.native_role_scopes.map(r => ({role: r.role, unit: r.unit, cgroup_path: r.identity.cgroup_path, cgroup_device: r.identity.cgroup_device, cgroup_inode: r.identity.cgroup_inode, limits: r.limits})); }
export function makePacket(from = 100n, until = 200n, counterBase = 0n) {
  const {challenge} = expectedValue();
  const scopes = [{scope: "parent", cgroup_device: 77n, cgroup_inode: 100n, memoryLimit: 128n * 1024n * 1024n, pidsLimit: 12n},
    {scope: "worker", cgroup_device: 77n, cgroup_inode: 101n, memoryLimit: 64n * 1024n * 1024n, pidsLimit: 4n},
    {scope: "observer", cgroup_device: 77n, cgroup_inode: 102n, memoryLimit: 32n * 1024n * 1024n, pidsLimit: 4n},
    {scope: "recovery", cgroup_device: 77n, cgroup_inode: 103n, memoryLimit: 32n * 1024n * 1024n, pidsLimit: 4n}];
  const makePass = (base: bigint, lo: bigint, hi: bigint) => ({observed_from_boottime_ns: lo, observed_until_boottime_ns: hi,
      scope_samples: scopes.map((s, i) => ({scope: s.scope, cgroup_device: s.cgroup_device, cgroup_inode: s.cgroup_inode, cpu_stat: cpu(base + BigInt(i)), memory_stat: memoryStat(base), memory_current: String(1_000_000n + base), memory_events_local: memoryEvents(base), pids_current: String(2n), pids_events_local: pidsEvents(base)}))});
  return {version: 1n, status: "observed" as const, channel: "cgroup_kernel_charges_v1" as const, brokkr_config_digest: configDigest,
    value: {version: 1n, kind: "cgroup_kernel_charges_observation" as const, attempt_id: attemptId, native_envelope: challenge.native_envelope, role_cgroups: roleScopes(challenge),
      observed_from_boottime_ns: from, observed_until_boottime_ns: until, passes: [makePass(counterBase, from + 10n, from + 20n), makePass(counterBase + 1n, from + 70n, from + 80n)]}};
}
export function canonicalPacket(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null || typeof value !== "object") return String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalPacket).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map(key => `${JSON.stringify(key)}:${canonicalPacket((value as Record<string, unknown>)[key])}`).join(",")}}`;
}
export function raw(packet = makePacket()) { return canonicalPacket(packet); }
