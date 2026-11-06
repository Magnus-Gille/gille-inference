import {createHash} from "node:crypto";
import {describe, expect, it} from "vitest";
import {canonicalNative} from "../src/homeserver/accounted-host-issuer.js";
import {digestAccountedNativeEnvelopeV3,digestAccountedNativeRoleScopesV3} from "../src/homeserver/accounted-native-envelope-v3.js";
import {parseCgroupKernelChargesV1,validateCgroupKernelChargesPairV1,validateCgroupKernelChargesV1} from "../src/homeserver/accounted-kernel-counters-v1.js";

const attemptId = "a".repeat(32), parentUnit = `brokkr_accounted_${attemptId}.slice`, parentPath = `/${parentUnit}`;
const workerUnit = `brokkr-accounted-eval-${attemptId}.service`, observerUnit = `brokkr-accounted-observer-${attemptId}.service`, recoveryUnit = `brokkr-accounted-recovery-${attemptId}.service`;
const bootId = "11111111-1111-4111-8111-111111111111", revision = "b".repeat(40), configDigest = "c".repeat(64), releaseDigest = "d".repeat(64), descriptor = "7d97cb1f350f1aaa25b9abfef518f5b8f5b42af77ace1dfa49216692e42f5bde";
const parentLimits = () => ({memory_bytes: 128n * 1024n * 1024n, cpu_quota_us: 9000n, cpu_period_us: 100000n, pids_max: 12n, swap_bytes: 0n});
const childLimits = (memory: bigint, cpu: bigint, pids: bigint) => ({memory_bytes: memory, cpu_quota_us: cpu, cpu_period_us: 100000n, pids_max: pids, swap_bytes: 0n});
function identity(path: string, inode: bigint, invocation: string) { return {boot_id: bootId, invocation_id: invocation, cgroup_path: path, cgroup_device: 77n, cgroup_inode: inode, namespace_inodes: {mnt: inode + 10n, net: inode + 11n, ipc: inode + 12n, pid: inode === 101n ? 114n : 115n}}; }
function challengeValue() {
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
function allocation() { return {chargedMemoryMaxBytes: 128 * 1024 * 1024, swapMaxBytes: 0, cpuQuotaMicros: 9000, cpuPeriodMicros: 100000, tasksMax: 12, addressSpaceLimitBytes: 16 * 1024 * 1024}; }
function expectedValue() {
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
function roleScopes(challenge: ReturnType<typeof challengeValue>) { return challenge.native_role_scopes.map(r => ({role: r.role, unit: r.unit, cgroup_path: r.identity.cgroup_path, cgroup_device: r.identity.cgroup_device, cgroup_inode: r.identity.cgroup_inode, limits: r.limits})); }
function makePacket(from = 100n, until = 200n, counterBase = 0n) {
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
function canonicalPacket(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null || typeof value !== "object") return String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalPacket).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map(key => `${JSON.stringify(key)}:${canonicalPacket((value as Record<string, unknown>)[key])}`).join(",")}}`;
}
function raw(packet = makePacket()) { return canonicalPacket(packet); }
function expectCode(action: () => unknown, code: string) { expect(action).toThrowError(expect.objectContaining({code})); }

describe("cgroup kernel charges closed packet", () => {
  it("accepts realistic two-pass raw files with bigint timestamps and never grants authority", () => {
    const {expected} = expectedValue(), result = validateCgroupKernelChargesV1(raw(), expected);
    expect(result.packet.value.observed_from_boottime_ns).toBe(100n);
    expect(result.parsedPasses[1].scopes[0].cpu_stat.usage_usec).toBe(101n);
    expect(result.physicalEvidenceVerified).toBe(false);
    expect(result.executionAuthorized).toBe(false);
  });
  it("accepts TAB separators in stripped flat files", () => {
    const p=makePacket();for(const pass of p.value.passes)for(const sample of pass.scope_samples)sample.cpu_stat=sample.cpu_stat.replaceAll(" ","\t");
    expect(()=>parseCgroupKernelChargesV1(raw(p))).not.toThrow();
  });
  it("accepts exact native integer precision above 2^53", () => {
    const p = makePacket(); p.value.observed_from_boottime_ns = 9_007_199_254_740_993n; p.value.observed_until_boottime_ns = p.value.observed_from_boottime_ns + 100n;
    p.value.passes[0].observed_from_boottime_ns = p.value.observed_from_boottime_ns; p.value.passes[0].observed_until_boottime_ns = p.value.observed_from_boottime_ns + 10n;
    p.value.passes[1].observed_from_boottime_ns = p.value.observed_from_boottime_ns + 50n; p.value.passes[1].observed_until_boottime_ns = p.value.observed_until_boottime_ns;
    const result = parseCgroupKernelChargesV1(raw(p));
    expect(result.value.observed_from_boottime_ns).toBe(9_007_199_254_740_993n);
  });
  it("rejects unknown or missing payload and sample fields", () => {
    const {expected} = expectedValue(), extra = makePacket() as any; extra.value.extra = 1n;
    expectCode(() => validateCgroupKernelChargesV1(raw(extra), expected), "kernel_payload_schema");
    const missing = makePacket() as any; delete missing.value.passes;
    expectCode(() => validateCgroupKernelChargesV1(raw(missing), expected), "kernel_payload_schema");
    const sampleExtra = makePacket() as any; sampleExtra.value.passes[0].scope_samples[0].provider_verified = 1n;
    expectCode(() => validateCgroupKernelChargesV1(raw(sampleExtra), expected), "kernel_payload_schema");
    const controlOutsideFile = makePacket(); controlOutsideFile.value.native_envelope.unit += "\n";
    expectCode(() => parseCgroupKernelChargesV1(raw(controlOutsideFile)), "kernel_native_json");
  });
  it("rejects duplicate keys, noncanonical bytes, floats, and booleans", () => {
    const good = raw();
    expectCode(() => parseCgroupKernelChargesV1(good.replace('"version":1', '"version":1,"version":1')), "kernel_native_json");
    expectCode(() => parseCgroupKernelChargesV1(good.replace(",", ", ")), "kernel_noncanonical");
    expectCode(() => parseCgroupKernelChargesV1(good.replace('"version":1', '"version":1.0')), "kernel_native_json");
    expectCode(() => parseCgroupKernelChargesV1(good.replace('"version":1', '"version":true')), "kernel_native_json");
  });
  it("enforces the total 65536-byte native packet bound", () => {
    expectCode(() => parseCgroupKernelChargesV1(raw() + " ".repeat(65536)), "kernel_native_json");
  });
});

describe("kernel flat file parser", () => {
  it("returns sorted dotted optional keys as unclaimed metadata", () => {
    const p = makePacket();
    for (const pass of p.value.passes) for (const sample of pass.scope_samples) sample.cpu_stat += "\nz.extra 5\na.extra 9";
    p.value.passes[1].scope_samples[0].cpu_stat=p.value.passes[1].scope_samples[0].cpu_stat.replace("z.extra 5","z.extra 0");
    const parsed = parseCgroupKernelChargesV1(raw(p));
    const {expected} = expectedValue(), checked = validateCgroupKernelChargesV1(raw(p), expected);
    expect(parsed.value.kind).toBe("cgroup_kernel_charges_observation");
    expect(checked.parsedPasses[0].scopes[0].unclaimedKeys.cpu_stat).toEqual(["a.extra", "z.extra"]);
  });
  it("rejects duplicate stat keys", () => {
    const p = makePacket(); p.value.passes[0].scope_samples[0].cpu_stat += "\nusage_usec 999";
    expectCode(() => parseCgroupKernelChargesV1(raw(p)), "kernel_duplicate_key");
  });
  it("bounds flat files to 256 rows", () => {
    const p=makePacket();p.value.passes[0].scope_samples[0].cpu_stat+="\n"+Array.from({length:249},(_,i)=>`extra${i} 1`).join("\n");
    expectCode(()=>parseCgroupKernelChargesV1(raw(p)),"kernel_rows_bound");
  });
  it("rejects malformed, floating, negative, and out-of-range stat values", () => {
    const floating = makePacket(); floating.value.passes[0].scope_samples[0].cpu_stat = "usage_usec 1.5";
    expectCode(() => parseCgroupKernelChargesV1(raw(floating)), "kernel_numeric_syntax");
    const negative = makePacket(); negative.value.passes[0].scope_samples[0].cpu_stat = "usage_usec -1";
    expectCode(() => parseCgroupKernelChargesV1(raw(negative)), "kernel_numeric_syntax");
    const overflow = makePacket(); overflow.value.passes[0].scope_samples[0].cpu_stat = `usage_usec ${2n**63n}`;
    expectCode(() => parseCgroupKernelChargesV1(raw(overflow)), "kernel_counter_range");
  });
  it("requires every selected key and refuses empty or untrimmed raw values", () => {
    const missing = makePacket(); missing.value.passes[0].scope_samples[0].cpu_stat = "usage_usec 1";
    expectCode(() => parseCgroupKernelChargesV1(raw(missing)), "kernel_missing_selected_key");
    const empty = makePacket(); empty.value.passes[0].scope_samples[0].memory_stat = "";
    expectCode(() => parseCgroupKernelChargesV1(raw(empty)), "kernel_raw_empty");
    const untrimmed = makePacket(); untrimmed.value.passes[0].scope_samples[0].pids_events_local = "max 1\n";
    expectCode(() => parseCgroupKernelChargesV1(raw(untrimmed)), "kernel_raw_encoding");
  });
  it("accepts no CPU equality assumption between usage, user and system", () => {
    const p = makePacket(); p.value.passes[1].scope_samples[0].cpu_stat = "usage_usec 1000\nuser_usec 81\nsystem_usec 7\nnr_periods 11\nnr_throttled 3\nthrottled_usec 6\nnr_bursts 1\nburst_usec 1";
    expect(() => parseCgroupKernelChargesV1(raw(p))).not.toThrow();
  });
});

describe("sample binding, clocks, and selected counter semantics", () => {
  it("binds fixed parent and ordered role device/inode identities", () => {
    const badId = makePacket(); badId.value.passes[0].scope_samples[1].cgroup_inode = 100n;
    expectCode(() => parseCgroupKernelChargesV1(raw(badId)), "kernel_sample_identity");
    const reordered = makePacket(); [reordered.value.passes[0].scope_samples[1], reordered.value.passes[0].scope_samples[2]] = [reordered.value.passes[0].scope_samples[2], reordered.value.passes[0].scope_samples[1]];
    expectCode(() => parseCgroupKernelChargesV1(raw(reordered)), "kernel_sample_identity");
  });
  it("enforces pass containment, ordering, and the one-second overall window", () => {
    const reversed = makePacket(); reversed.value.passes[1].observed_from_boottime_ns = 115n;
    expectCode(() => parseCgroupKernelChargesV1(raw(reversed)), "kernel_pass_order");
    const outside = makePacket(); outside.value.passes[1].observed_until_boottime_ns = 201n;
    expectCode(() => parseCgroupKernelChargesV1(raw(outside)), "kernel_observation_window");
    const long = makePacket(100n, 1_000_000_101n);
    expectCode(() => parseCgroupKernelChargesV1(raw(long)), "kernel_observation_window");
  });
  it("requires monotonic CPU and event counters across the two passes", () => {
    const cpuReset = makePacket(); cpuReset.value.passes[1].scope_samples[0].cpu_stat = "usage_usec 99\nuser_usec 80\nsystem_usec 7\nnr_periods 11\nnr_throttled 3\nthrottled_usec 6\nnr_bursts 1\nburst_usec 1";
    expectCode(() => parseCgroupKernelChargesV1(raw(cpuReset)), "kernel_counter_regression");
    const eventReset = makePacket(); eventReset.value.passes[0].scope_samples[0].memory_events_local = memoryEvents(5n); eventReset.value.passes[1].scope_samples[0].memory_events_local = memoryEvents(4n);
    expectCode(() => parseCgroupKernelChargesV1(raw(eventReset)), "kernel_counter_regression");
  });
  it("allows gauges to fall while enforcing memory and pid caps", () => {
    const falling = makePacket(); falling.value.passes[1].scope_samples[0].memory_current = "900000"; falling.value.passes[1].scope_samples[0].pids_current = "1"; falling.value.passes[1].scope_samples[0].memory_stat = memoryStat(0n);
    expect(() => parseCgroupKernelChargesV1(raw(falling))).not.toThrow();
    const memoryOver = makePacket(); memoryOver.value.passes[0].scope_samples[1].memory_current = String(64n * 1024n * 1024n + 1n);
    expectCode(() => parseCgroupKernelChargesV1(raw(memoryOver)), "kernel_gauge_cap");
    const memoryStatOver = makePacket(); memoryStatOver.value.passes[0].scope_samples[1].memory_stat = memoryStat(0n).replace("kernel 30", `kernel ${64n * 1024n * 1024n + 1n}`);
    expectCode(() => parseCgroupKernelChargesV1(raw(memoryStatOver)), "kernel_gauge_cap");
    const pidsOver = makePacket(); pidsOver.value.passes[0].scope_samples[1].pids_current = "5";
    expectCode(() => parseCgroupKernelChargesV1(raw(pidsOver)), "kernel_gauge_cap");
  });
  it("refuses unclaimed key profile drift between passes", () => {
    const p = makePacket(); p.value.passes[1].scope_samples[0].cpu_stat += "\noptional.counter 1";
    expectCode(() => parseCgroupKernelChargesV1(raw(p)), "kernel_unclaimed_profile_drift");
  });
});

describe("bound validation and paired continuity", () => {
  it("uses the accepted native challenge, run binding, limits, and freshness validator", () => {
    const {expected} = expectedValue();
    expectCode(() => validateCgroupKernelChargesV1(raw(), {...expected, nowNs: 10n}), "cgroup_observation_window");
    const wrong = makePacket(); wrong.brokkr_config_digest = "9".repeat(64);
    expectCode(() => validateCgroupKernelChargesV1(raw(wrong), expected), "cgroup_attempt_or_config_binding");
  });
  it("accepts fresh paired packets with changing raw counter values and timestamps", () => {
    const {expected} = expectedValue(), first = raw(makePacket(100n, 200n)), second = raw(makePacket(200n, 300n, 2n));
    expect(createHash("sha256").update(first).digest("hex")).not.toBe(createHash("sha256").update(second).digest("hex"));
    const result = validateCgroupKernelChargesPairV1(first, second, expected);
    expect(result.first.parsedPasses[1].scopes[0].cpu_stat.usage_usec).toBe(101n);
    expect(result.last.parsedPasses[0].scopes[0].cpu_stat.usage_usec).toBe(102n);
    expect(result.physicalEvidenceVerified).toBe(false); expect(result.executionAuthorized).toBe(false);
  });
  it("refuses counter resets and identity/profile drift across packets", () => {
    const {expected} = expectedValue(), first = makePacket(100n, 200n), reset = makePacket(200n, 300n, 2n);
    reset.value.passes[0].scope_samples[0].cpu_stat = cpu(0n);
    expectCode(() => validateCgroupKernelChargesPairV1(raw(first), raw(reset), expected), "kernel_counter_regression");
    const profile = makePacket(200n, 300n); profile.value.passes.forEach(pass => pass.scope_samples[0].cpu_stat += "\nextra 1");
    expectCode(() => validateCgroupKernelChargesPairV1(raw(first), raw(profile), expected), "kernel_continuity_drift");
    const inode = makePacket(200n, 300n); inode.value.passes.forEach(pass => pass.scope_samples[0].cgroup_inode = 999n);
    expect(() => validateCgroupKernelChargesPairV1(raw(first), raw(inode), expected)).toThrow();
  });
  it("requires nonoverlapping whole-packet observation intervals", () => {
    const {expected} = expectedValue();
    expectCode(() => validateCgroupKernelChargesPairV1(raw(makePacket(100n, 200n)), raw(makePacket(199n, 300n)), expected), "cgroup_observation_order");
  });
});
