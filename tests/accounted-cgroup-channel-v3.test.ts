import {createHash} from "node:crypto";
import {describe, expect, it} from "vitest";
import {canonicalNative} from "../src/homeserver/accounted-host-issuer.js";
import {
  digestAccountedNativeEnvelopeV3,
  digestAccountedNativeRoleScopesV3,
} from "../src/homeserver/accounted-native-envelope-v3.js";
import {
  parseCgroupChannelV1,
  validateCgroupChannelPairV1,
  validateCgroupChannelV1,
} from "../src/homeserver/accounted-cgroup-channel-v3.js";

const attemptId = "a".repeat(32);
const parentUnit = `brokkr_accounted_${attemptId}.slice`;
const parentPath = `/${parentUnit}`;
const workerUnit = `brokkr-accounted-eval-${attemptId}.service`;
const observerUnit = `brokkr-accounted-observer-${attemptId}.service`;
const recoveryUnit = `brokkr-accounted-recovery-${attemptId}.service`;
const bootId = "11111111-1111-4111-8111-111111111111";
const uuidA = "22222222-2222-4222-8222-222222222222";
const uuidB = "33333333-3333-4333-8333-333333333333";
const uuidC = "44444444-4444-4444-8444-444444444444";
const revision = "b".repeat(40);
const configDigest = "c".repeat(64);
const releaseDigest = "d".repeat(64);
const descriptor = "7d97cb1f350f1aaa25b9abfef518f5b8f5b42af77ace1dfa49216692e42f5bde";

const workerLimits = () => ({memory_bytes: 64n * 1024n * 1024n, cpu_quota_us: 2000n, cpu_period_us: 100000n, pids_max: 4n, swap_bytes: 0n});
const observerLimits = () => ({memory_bytes: 32n * 1024n * 1024n, cpu_quota_us: 1000n, cpu_period_us: 100000n, pids_max: 4n, swap_bytes: 0n});
const recoveryLimits = () => ({memory_bytes: 32n * 1024n * 1024n, cpu_quota_us: 1000n, cpu_period_us: 100000n, pids_max: 4n, swap_bytes: 0n});
const parentLimits = () => ({memory_bytes: 128n * 1024n * 1024n, cpu_quota_us: 9000n, cpu_period_us: 100000n, pids_max: 12n, swap_bytes: 0n});

function identity(path: string, inode: bigint, invocation: string) {
  return {boot_id: bootId, invocation_id: invocation, cgroup_path: path, cgroup_device: 77n, cgroup_inode: inode,
    namespace_inodes: {mnt: inode + 10n, net: inode + 11n, ipc: inode + 12n, pid: inode === 101n ? 114n : 115n}};
}

function challengeValue() {
  const workerIdentity = identity(`${parentPath}/${workerUnit}`, 101n, "1".repeat(32));
  return {
    version: 2n, attempt_id: attemptId, unit: workerUnit, source_revision: revision,
    release_id: releaseDigest, config_digest: configDigest, descriptor_digest: descriptor,
    identity: workerIdentity,
    limits: {memory_bytes: 64n * 1024n * 1024n, cpu_quota_us: 2000n, cpu_period_us: 100000n, pids_max: 4n},
    observed_boottime_ns: 200n,
    native_envelope: {version: 1n, unit: parentUnit, cgroup_path: parentPath, cgroup_device: 77n, cgroup_inode: 100n, limits: parentLimits()},
    native_role_scopes: [
      {role: "worker" as const, unit: workerUnit, identity: workerIdentity, limits: workerLimits(), address_space_limit_bytes: 16n * 1024n * 1024n, started_boottime_lower_ns: 50n, stop_by_boottime_ns: 500n},
      {role: "observer" as const, unit: observerUnit, identity: identity(`${parentPath}/${observerUnit}`, 102n, "2".repeat(32)), limits: observerLimits(), address_space_limit_bytes: 16n * 1024n * 1024n, started_boottime_lower_ns: 50n, stop_by_boottime_ns: 500n},
      {role: "recovery" as const, unit: recoveryUnit, identity: identity(`${parentPath}/${recoveryUnit}`, 103n, "3".repeat(32)), limits: recoveryLimits(), address_space_limit_bytes: 16n * 1024n * 1024n, started_boottime_lower_ns: 50n, stop_by_boottime_ns: 500n},
    ],
  };
}

function allocation() {
  return {chargedMemoryMaxBytes: 128 * 1024 * 1024, swapMaxBytes: 0, cpuQuotaMicros: 9000, cpuPeriodMicros: 100000, tasksMax: 12, addressSpaceLimitBytes: 16 * 1024 * 1024};
}

function runBinding(challengeJson: string, challenge: ReturnType<typeof challengeValue>) {
  return canonicalNative({
    version: 1n, mandate_id: uuidA, native_attempt_id: attemptId, request_id: uuidB, policy_attempt_id: uuidC,
    challenge_digest: createHash("sha256").update(challengeJson).digest("hex"), owner_envelope_digest: "e".repeat(64),
    brokkr_source_revision: revision, brokkr_config_digest: configDigest, brokkr_release_digest: releaseDigest,
    descriptor_digest: descriptor, issuer_release_digest: "f".repeat(64), producer_release_digest: "1".repeat(64),
    producer_config_digest: "2".repeat(64), boot_id: bootId, observer_instance_digest: "3".repeat(64), sequence: 1n,
    native_envelope_digest: digestAccountedNativeEnvelopeV3(challenge.native_envelope),
    native_role_scopes_digest: digestAccountedNativeRoleScopesV3(challenge.native_role_scopes),
    lease_id: "4".repeat(64), ledger_revision: "5".repeat(64), allocated_from_boottime_ns: 50n, allocated_until_boottime_ns: 1000n,
  });
}

function fixture() {
  const challenge = challengeValue();
  const challengeJson = canonicalNative(challenge);
  const bindingJson = runBinding(challengeJson, challenge);
  const expected = {challengeJson, runBindingJson: bindingJson, allocation: allocation(), nowNs: 300n, maximumAgeNs: 5_000_000_000n};
  return {challenge, challengeJson, bindingJson, expected};
}

function roleCgroups(challenge: ReturnType<typeof challengeValue>) {
  return challenge.native_role_scopes.map(role => ({role: role.role, unit: role.unit, cgroup_path: role.identity.cgroup_path,
    cgroup_device: role.identity.cgroup_device, cgroup_inode: role.identity.cgroup_inode, limits: role.limits}));
}

function channelValue(challenge: ReturnType<typeof challengeValue>, from = 100n, until = 200n) {
  return {version: 1n, status: "observed" as const, channel: "cgroup_envelope_v1" as const, brokkr_config_digest: configDigest,
    value: {version: 1n, kind: "cgroup_envelope_observation" as const, attempt_id: attemptId,
      native_envelope: challenge.native_envelope, role_cgroups: roleCgroups(challenge),
      observed_from_boottime_ns: from, observed_until_boottime_ns: until}};
}

function rawChannel(challenge: ReturnType<typeof challengeValue>, from = 100n, until = 200n) {
  return canonicalNative(channelValue(challenge, from, until));
}

function expectRefusal(action: () => unknown) { expect(action).toThrow(); }

it("refuses a cgroup read taking more than the fixed one-second observation bound", () => {
  const {challenge} = fixture();
  challenge.native_role_scopes.forEach(role => { role.stop_by_boottime_ns = 10_000_000_000n; });
  const challengeJson = canonicalNative(challenge);
  const binding = JSON.parse(runBinding(challengeJson, challenge));
  binding.allocated_until_boottime_ns = 10_000_000_000;
  const expected = {challengeJson, runBindingJson: canonicalNative(binding), allocation: allocation(), nowNs: 2_000_000_000n, maximumAgeNs: 5_000_000_000n};
  expectRefusal(() => validateCgroupChannelV1(rawChannel(challenge, 100n, 1_000_000_101n), expected));
});

describe("cgroup channel closed payload", () => {
  it("accepts the exact observed payload and exposes no authority flags", () => {
    const {challenge, expected} = fixture();
    const result = validateCgroupChannelV1(rawChannel(challenge), expected);
    expect(result.packet.status).toBe("observed");
    expect(result.physicalEvidenceVerified).toBe(false);
    expect(result.executionAuthorized).toBe(false);
  });

  it("refuses unknown channel, status, extra, and missing fields", () => {
    const {challenge, expected} = fixture();
    expectRefusal(() => parseCgroupChannelV1(rawChannel(challenge).replace("cgroup_envelope_v1", "other")));
    expectRefusal(() => parseCgroupChannelV1(rawChannel(challenge).replace('"status":"observed"', '"status":"unknown"')));
    const extra = channelValue(challenge) as any;
    extra.value.extra = 1n;
    expectRefusal(() => validateCgroupChannelV1(canonicalNative(extra), expected));
    const missing = channelValue(challenge) as any;
    delete missing.value.role_cgroups;
    expectRefusal(() => validateCgroupChannelV1(canonicalNative(missing), expected));
  });

  it("refuses duplicate, noncanonical, floating, and boolean encodings", () => {
    const {challenge} = fixture();
    const raw = rawChannel(challenge);
    expectRefusal(() => parseCgroupChannelV1(raw.replace('"version":1', '"version":1,"version":1')));
    expectRefusal(() => parseCgroupChannelV1(raw.replace(",", ", ")));
    expectRefusal(() => parseCgroupChannelV1(raw.replace('"version":1', '"version":1.0')));
    expectRefusal(() => parseCgroupChannelV1(raw.replace('"version":1', '"version":true')));
  });

  it("refuses AS and invocation claims that are outside this cgroup-only channel", () => {
    const {challenge} = fixture();
    const value = channelValue(challenge) as any;
    value.value.role_cgroups[0].address_space_limit_bytes = 1n;
    value.value.role_cgroups[0].invocation_id = "1".repeat(32);
    expectRefusal(() => parseCgroupChannelV1(canonicalNative(value)));
  });
});

describe("cgroup channel bindings and drift", () => {
  it("binds config, attempt, source revision, release, boot, and run challenge digest", () => {
    const {challenge, expected, bindingJson} = fixture();
    const result = validateCgroupChannelV1(rawChannel(challenge), expected);
    expect(result.packet.brokkr_config_digest).toBe(configDigest);
    expect(bindingJson).toContain(attemptId);
  });

  it("refuses config and attempt drift", () => {
    const {challenge, expected} = fixture();
    const badConfig = {...expected, challengeJson: canonicalNative({...challenge, config_digest: "9".repeat(64)})};
    expectRefusal(() => validateCgroupChannelV1(rawChannel(challenge), badConfig));
    const badAttempt = channelValue(challenge) as any;
    badAttempt.value.attempt_id = "b".repeat(32);
    expectRefusal(() => validateCgroupChannelV1(canonicalNative(badAttempt), expected));
  });

  it("refuses source or run binding drift", () => {
    const {challenge, expected} = fixture();
    const changedBinding = JSON.parse(expected.runBindingJson, (_key, value) => value);
    changedBinding.brokkr_source_revision = "a".repeat(40);
    const bad = {...expected, runBindingJson: canonicalNative(changedBinding)};
    expectRefusal(() => validateCgroupChannelV1(rawChannel(challenge), bad));
  });

  it("refuses parent and role limit or identity drift", () => {
    const {challenge, expected} = fixture();
    const parent = channelValue(challenge) as any;
    parent.value.native_envelope.limits.memory_bytes = 64n * 1024n * 1024n;
    expectRefusal(() => validateCgroupChannelV1(canonicalNative(parent), expected));
    const role = channelValue(challenge) as any;
    role.value.role_cgroups[1].limits.pids_max = 5n;
    expectRefusal(() => validateCgroupChannelV1(canonicalNative(role), expected));
    const identityDrift = channelValue(challenge) as any;
    identityDrift.value.role_cgroups[2].cgroup_inode = 999n;
    expectRefusal(() => validateCgroupChannelV1(canonicalNative(identityDrift), expected));
  });

  it("refuses aliases, reordered roles, and non-direct membership", () => {
    const {challenge, expected} = fixture();
    const alias = channelValue(challenge) as any;
    alias.value.role_cgroups[1].cgroup_inode = alias.value.role_cgroups[0].cgroup_inode;
    expectRefusal(() => validateCgroupChannelV1(canonicalNative(alias), expected));
    const reordered = channelValue(challenge) as any;
    [reordered.value.role_cgroups[0], reordered.value.role_cgroups[1]] = [reordered.value.role_cgroups[1], reordered.value.role_cgroups[0]];
    expectRefusal(() => validateCgroupChannelV1(canonicalNative(reordered), expected));
    const nested = channelValue(challenge) as any;
    nested.value.role_cgroups[2].cgroup_path += "/nested.slice";
    expectRefusal(() => validateCgroupChannelV1(canonicalNative(nested), expected));
  });

  it("refuses challenge role sums that exceed the accepted parent", () => {
    const {challenge, expected} = fixture();
    challenge.native_role_scopes[1].limits.memory_bytes = 128n * 1024n * 1024n;
    const changed = {...expected, challengeJson: canonicalNative(challenge)};
    expectRefusal(() => validateCgroupChannelV1(rawChannel(challenge), changed));
  });
});

describe("cgroup observation windows and continuity", () => {
  it("accepts fresh timestamps that change while the stable projection remains fixed", () => {
    const {challenge, expected} = fixture();
    const first = rawChannel(challenge, 100n, 200n);
    const last = rawChannel(challenge, 200n, 300n);
    const result = validateCgroupChannelPairV1(first, last, expected);
    expect(result.first.fromNs).toBe(100n);
    expect(result.last.untilNs).toBe(300n);
    expect(result.first.stableProjectionJson).toBe(result.last.stableProjectionJson);
  });

  it("does not require raw observation digests to be identical", () => {
    const {challenge, expected} = fixture();
    const first = rawChannel(challenge, 100n, 200n);
    const last = rawChannel(challenge, 200n, 300n);
    expect(createHash("sha256").update(first).digest("hex")).not.toBe(createHash("sha256").update(last).digest("hex"));
    expect(() => validateCgroupChannelPairV1(first, last, expected)).not.toThrow();
  });

  it("refuses future, stale, and lease-outside observations", () => {
    const {challenge, expected} = fixture();
    expectRefusal(() => validateCgroupChannelV1(rawChannel(challenge, 301n, 302n), expected));
    expectRefusal(() => validateCgroupChannelV1(rawChannel(challenge, 0n, 1n), {...expected, nowNs: 6_000_000_001n}));
    expectRefusal(() => validateCgroupChannelV1(rawChannel(challenge, 40n, 60n), expected));
    expectRefusal(() => validateCgroupChannelV1(rawChannel(challenge, 900n, 1001n), expected));
  });

  it("refuses observations outside role lifetime", () => {
    const {challenge, expected} = fixture();
    const changed = structuredClone(challenge);
    changed.native_role_scopes[2].stop_by_boottime_ns = 250n;
    const changedExpected = {...expected, challengeJson: canonicalNative(changed)};
    expectRefusal(() => validateCgroupChannelV1(rawChannel(changed, 100n, 300n), changedExpected));
  });

  it("refuses projection drift, overlap, and backwards ordering in a pair", () => {
    const {challenge, expected} = fixture();
    const drift = channelValue(challenge, 200n, 300n) as any;
    drift.value.native_envelope.cgroup_inode = 999n;
    expectRefusal(() => validateCgroupChannelPairV1(rawChannel(challenge, 100n, 200n), canonicalNative(drift), expected));
    expectRefusal(() => validateCgroupChannelPairV1(rawChannel(challenge, 100n, 250n), rawChannel(challenge, 200n, 300n), expected));
    expectRefusal(() => validateCgroupChannelPairV1(rawChannel(challenge, 200n, 300n), rawChannel(challenge, 100n, 200n), expected));
  });
});
