import {describe, expect, it} from "vitest";
import {canonicalNative} from "../src/homeserver/accounted-host-issuer.js";
import {
  AccountedNativeV3Error,
  parseAccountedChallengeV2,
  parseAccountedNativeEnvelopeV3,
  parseAccountedNativeRoleScopesV3,
  parseAccountedRunBindingV1,
  validateAccountedLeaseV3,
  validateAccountedNativeScopesV3,
} from "../src/homeserver/accounted-native-envelope-v3.js";

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
const digestA = "c".repeat(64);
const digestB = "d".repeat(64);

const workerLimits = () => ({memory_bytes: 64n * 1024n * 1024n, cpu_quota_us: 2000n, cpu_period_us: 100000n, pids_max: 4n, swap_bytes: 0n});
const observerLimits = () => ({memory_bytes: 32n * 1024n * 1024n, cpu_quota_us: 1000n, cpu_period_us: 100000n, pids_max: 4n, swap_bytes: 0n});
const recoveryLimits = () => ({memory_bytes: 32n * 1024n * 1024n, cpu_quota_us: 1000n, cpu_period_us: 100000n, pids_max: 4n, swap_bytes: 0n});
const parentLimits = () => ({memory_bytes: 128n * 1024n * 1024n, cpu_quota_us: 9000n, cpu_period_us: 100000n, pids_max: 12n, swap_bytes: 0n});

function identity(path: string, inode: bigint, invocation: string) {
  return {
    boot_id: bootId,
    invocation_id: invocation,
    cgroup_path: path,
    cgroup_device: 77n,
    cgroup_inode: inode,
    namespace_inodes: {mnt: inode + 10n, net: inode + 11n, ipc: inode + 12n, pid: inode === 101n ? 114n : 115n},
  };
}

function challengeValue(observed = 200n) {
  const workerIdentity = identity(`${parentPath}/${workerUnit}`, 101n, "1".repeat(32));
  const roles = [
    {role: "worker" as const, unit: workerUnit, identity: workerIdentity, limits: workerLimits(), address_space_limit_bytes: 16n * 1024n * 1024n, started_boottime_lower_ns: 100n, stop_by_boottime_ns: 300n},
    {role: "observer" as const, unit: observerUnit, identity: identity(`${parentPath}/${observerUnit}`, 102n, "2".repeat(32)), limits: observerLimits(), address_space_limit_bytes: 16n * 1024n * 1024n, started_boottime_lower_ns: 100n, stop_by_boottime_ns: 300n},
    {role: "recovery" as const, unit: recoveryUnit, identity: identity(`${parentPath}/${recoveryUnit}`, 103n, "3".repeat(32)), limits: recoveryLimits(), address_space_limit_bytes: 16n * 1024n * 1024n, started_boottime_lower_ns: 100n, stop_by_boottime_ns: 300n},
  ];
  return {
    version: 2n,
    attempt_id: attemptId,
    unit: workerUnit,
    source_revision: revision,
    release_id: digestA,
    config_digest: digestB,
    descriptor_digest: "7d97cb1f350f1aaa25b9abfef518f5b8f5b42af77ace1dfa49216692e42f5bde",
    identity: workerIdentity,
    limits: {memory_bytes: 64n * 1024n * 1024n, cpu_quota_us: 2000n, cpu_period_us: 100000n, pids_max: 4n},
    observed_boottime_ns: observed,
    native_envelope: {version: 1n, unit: parentUnit, cgroup_path: parentPath, cgroup_device: 77n, cgroup_inode: 100n, limits: parentLimits()},
    native_role_scopes: roles,
  };
}

function rawChallenge(value = challengeValue()) { return canonicalNative(value); }
function allocationValue() {
  return {chargedMemoryMaxBytes: 128 * 1024 * 1024, swapMaxBytes: 0, cpuQuotaMicros: 9000, cpuPeriodMicros: 100000, tasksMax: 12, addressSpaceLimitBytes: 16 * 1024 * 1024};
}
function expectRefusal(action: () => unknown) { expect(action).toThrow(); }

it("requires the worker private PID namespace and one shared observer/recovery PID namespace", () => {
  const split = challengeValue();
  split.native_role_scopes[2].identity.namespace_inodes.pid = 999n;
  expectRefusal(() => validateAccountedNativeScopesV3(rawChallenge(split), allocationValue()));
  const shared = challengeValue();
  shared.native_role_scopes[1].identity.namespace_inodes.pid = shared.identity.namespace_inodes.pid;
  shared.native_role_scopes[2].identity.namespace_inodes.pid = shared.identity.namespace_inodes.pid;
  expectRefusal(() => validateAccountedNativeScopesV3(rawChallenge(shared), allocationValue()));
});

it("preserves the B v3 legacy worker reserve ceilings", () => {
  const value = challengeValue();
  value.limits.cpu_quota_us = value.native_role_scopes[0].limits.cpu_quota_us = 9001n;
  value.native_envelope.limits.cpu_quota_us = 10000n;
  value.native_role_scopes[1].limits.cpu_quota_us = value.native_role_scopes[2].limits.cpu_quota_us = 1n;
  expectRefusal(() => validateAccountedNativeScopesV3(rawChallenge(value), {...allocationValue(), cpuQuotaMicros: 10000}));
});

function bindingValue(from = 100n, until = 35_000_000_100n) {
  return {
    version: 1n,
    mandate_id: uuidA,
    native_attempt_id: attemptId,
    request_id: uuidB,
    policy_attempt_id: uuidC,
    challenge_digest: digestA,
    owner_envelope_digest: digestB,
    brokkr_source_revision: revision,
    brokkr_config_digest: digestA,
    brokkr_release_digest: digestB,
    descriptor_digest: "7d97cb1f350f1aaa25b9abfef518f5b8f5b42af77ace1dfa49216692e42f5bde",
    issuer_release_digest: digestA,
    producer_release_digest: digestB,
    producer_config_digest: digestA,
    boot_id: bootId,
    observer_instance_digest: digestB,
    sequence: 1n,
    native_envelope_digest: digestA,
    native_role_scopes_digest: digestB,
    lease_id: "e".repeat(64),
    ledger_revision: "f".repeat(64),
    allocated_from_boottime_ns: from,
    allocated_until_boottime_ns: until,
  };
}

function leaseRoles(start = 100n, stop = 35_000_000_100n) {
  return challengeValue().native_role_scopes.map(role => ({...role, started_boottime_lower_ns: start, stop_by_boottime_ns: stop}));
}

describe("explicit v3 native wire parsing", () => {
  it("refuses a legacy v1 challenge", () => {
    const value = {...challengeValue(), version: 1n};
    expectRefusal(() => parseAccountedChallengeV2(canonicalNative(value)));
  });

  it("refuses duplicate keys and noncanonical JSON", () => {
    const raw = rawChallenge();
    expectRefusal(() => parseAccountedChallengeV2(raw.replace('"version":2', '"version":2,"version":2')));
    expectRefusal(() => parseAccountedChallengeV2(raw.replace(",", ", ")));
  });

  it("refuses floating-point and boolean integer substitutions", () => {
    const raw = rawChallenge();
    expectRefusal(() => parseAccountedChallengeV2(raw.replace('"version":2', '"version":2.0')));
    expectRefusal(() => parseAccountedChallengeV2(raw.replace('"version":2', '"version":true')));
  });

  it("preserves integers beyond Number safe range exactly", () => {
    const value = challengeValue(9007199254740993n);
    expect(parseAccountedChallengeV2(canonicalNative(value)).observed_boottime_ns).toBe(9007199254740993n);
  });

  it("accepts the closed native envelope shape and refuses unknown keys", () => {
    const envelope = challengeValue().native_envelope;
    expect(parseAccountedNativeEnvelopeV3(canonicalNative(envelope)).cgroup_inode).toBe(100n);
    expectRefusal(() => parseAccountedNativeEnvelopeV3(canonicalNative({...envelope, extra: 1n})));
  });

  it("accepts exactly three ordered role scopes and refuses missing roles", () => {
    const roles = challengeValue().native_role_scopes;
    expect(parseAccountedNativeRoleScopesV3(canonicalNative(roles))).toHaveLength(3);
    expectRefusal(() => parseAccountedNativeRoleScopesV3(canonicalNative(roles.slice(0, 2))));
  });
});

describe("explicit v3 scope consistency", () => {
  it("accepts exact aggregate limits while retaining worker limits separately", () => {
    const result = validateAccountedNativeScopesV3(rawChallenge(), allocationValue());
    expect(result.physicalEvidenceVerified).toBe(false);
    expect(result.executionAuthorized).toBe(false);
    expect(result.nativeEnvelopeDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(result.nativeRoleScopesDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses aggregate limits copied from the worker instead of the parent", () => {
    expectRefusal(() => validateAccountedNativeScopesV3(rawChallenge(), {...allocationValue(), chargedMemoryMaxBytes: 64 * 1024 * 1024}));
  });

  it("refuses child memory sums above the parent", () => {
    const value = challengeValue();
    value.native_role_scopes[1].limits.memory_bytes = 128n * 1024n * 1024n;
    expectRefusal(() => validateAccountedNativeScopesV3(rawChallenge(value), allocationValue()));
  });

  it("refuses child CPU sums above the parent", () => {
    const value = challengeValue();
    value.native_role_scopes[1].limits.cpu_quota_us = 9000n;
    expectRefusal(() => validateAccountedNativeScopesV3(rawChallenge(value), allocationValue()));
  });

  it("refuses child PID sums above the parent", () => {
    const value = challengeValue();
    value.native_role_scopes[1].limits.pids_max = 64n;
    expectRefusal(() => validateAccountedNativeScopesV3(rawChallenge(value), allocationValue()));
  });

  it("requires exact role address-space limits", () => {
    const value = challengeValue();
    value.native_role_scopes[2].address_space_limit_bytes = 32n * 1024n * 1024n;
    expectRefusal(() => validateAccountedNativeScopesV3(rawChallenge(value), allocationValue()));
  });

  it("refuses role unit aliases and order changes", () => {
    const alias = challengeValue();
    alias.native_role_scopes[1].unit = workerUnit;
    expectRefusal(() => validateAccountedNativeScopesV3(rawChallenge(alias), allocationValue()));
    const reordered = challengeValue();
    [reordered.native_role_scopes[0], reordered.native_role_scopes[1]] = [reordered.native_role_scopes[1], reordered.native_role_scopes[0]];
    expectRefusal(() => validateAccountedNativeScopesV3(rawChallenge(reordered), allocationValue()));
  });

  it("refuses cgroup inode aliases, wrong parent device, and non-direct children", () => {
    const inodeAlias = challengeValue();
    inodeAlias.native_role_scopes[1].identity.cgroup_inode = 101n;
    expectRefusal(() => validateAccountedNativeScopesV3(rawChallenge(inodeAlias), allocationValue()));
    const wrongDevice = challengeValue();
    wrongDevice.native_role_scopes[2].identity.cgroup_device = 78n;
    expectRefusal(() => validateAccountedNativeScopesV3(rawChallenge(wrongDevice), allocationValue()));
    const nested = challengeValue();
    nested.native_role_scopes[2].identity.cgroup_path += "/nested.slice";
    expectRefusal(() => validateAccountedNativeScopesV3(rawChallenge(nested), allocationValue()));
  });

  it("refuses invocation aliases across worker and observer roles", () => {
    const value = challengeValue();
    value.native_role_scopes[1].identity.invocation_id = value.native_role_scopes[0].identity.invocation_id;
    expectRefusal(() => validateAccountedNativeScopesV3(rawChallenge(value), allocationValue()));
  });
});

describe("closed run binding and finite lease", () => {
  it("accepts a closed binding with bounded sequence and exact nanoseconds", () => {
    const binding = parseAccountedRunBindingV1(canonicalNative(bindingValue()));
    expect(binding.sequence).toBe(1n);
    expect(binding.allocated_until_boottime_ns).toBe(35_000_000_100n);
  });

  it("refuses binding extras, booleans, and sequence outside 1..4096", () => {
    expectRefusal(() => parseAccountedRunBindingV1(canonicalNative({...bindingValue(), extra: 1n})));
    expectRefusal(() => parseAccountedRunBindingV1(canonicalNative({...bindingValue(), sequence: true})));
    expectRefusal(() => parseAccountedRunBindingV1(canonicalNative({...bindingValue(), sequence: 0n})));
    expectRefusal(() => parseAccountedRunBindingV1(canonicalNative({...bindingValue(), sequence: 4097n})));
  });

  it("refuses a non-positive or reversed run interval", () => {
    expectRefusal(() => parseAccountedRunBindingV1(canonicalNative(bindingValue(100n, 100n))));
    expectRefusal(() => parseAccountedRunBindingV1(canonicalNative(bindingValue(200n, 100n))));
  });

  it("accepts an absolute 35-second lease ending exactly at now plus permit", () => {
    const result = validateAccountedLeaseV3(bindingValue(), leaseRoles(), 100n, 36_000_000_000n, 36_000_000_000n, 35, 35);
    expect(result.startNs).toBe(100n);
    expect(result.endNs).toBe(35_000_000_100n);
    expect(result.wholeSeconds).toBe(35);
    expect(result.physicalEvidenceVerified).toBe(false);
    expect(result.executionAuthorized).toBe(false);
  });

  it("refuses double-counted permit windows", () => {
    const short = bindingValue(100n, 35_000_000_099n);
    expectRefusal(() => validateAccountedLeaseV3(short, leaseRoles(), 100n, 36_000_000_000n, 36_000_000_000n, 35, 35));
  });

  it("refuses duration, owner, and host bounds outside the accepted window", () => {
    expectRefusal(() => validateAccountedLeaseV3(bindingValue(100n, 29_000_000_100n), leaseRoles(), 100n, 36_000_000_000n, 36_000_000_000n, 30, 30));
    expectRefusal(() => validateAccountedLeaseV3(bindingValue(100n, 35_000_000_100n), leaseRoles(), 100n, 35_000_000_099n, 36_000_000_000n, 35, 35));
    expectRefusal(() => validateAccountedLeaseV3(bindingValue(100n, 35_000_000_100n), leaseRoles(), 100n, 36_000_000_000n, 35_000_000_099n, 35, 35));
  });

  it("refuses role intervals outside the full lease", () => {
    const startsTooEarly = leaseRoles(99n, 35_000_000_000n);
    expectRefusal(() => validateAccountedLeaseV3(bindingValue(), startsTooEarly, 100n, 36_000_000_000n, 36_000_000_000n, 35, 35));
    const stopsTooLate = leaseRoles(1000n, 35_000_000_101n);
    expectRefusal(() => validateAccountedLeaseV3(bindingValue(), stopsTooLate, 100n, 36_000_000_000n, 36_000_000_000n, 35, 35));
  });
});


describe("v3 actual role window regressions",()=>{
  it("counts full resident interval once even after admission has started",()=>{
    const second=1000000000n;
    const run=bindingValue(0n,60n*second);
    const roles=leaseRoles(0n,60n*second);
    expect(validateAccountedLeaseV3(run,roles,10n*second,60n*second,60n*second,60,60).endNs).toBe(60n*second);
  });
  it("refuses a role whose deterministic deadline precedes the full permit",()=>{
    const second=1000000000n;
    const run=bindingValue(0n,60n*second);
    const roles=leaseRoles(0n,60n*second);roles[2].stop_by_boottime_ns=40n*second;
    expect(()=>validateAccountedLeaseV3(run,roles,10n*second,60n*second,60n*second,60,60)).toThrow();
  });
  it("refuses a future role start even when it fits the overall lease",()=>{
    const second=1000000000n;
    expect(()=>validateAccountedLeaseV3(bindingValue(0n,60n*second),leaseRoles(11n*second,60n*second),10n*second,60n*second,60n*second,60,60)).toThrow();
  });
});
