import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  canonicalStringify,
  digestControlPlaneAccounting,
  digestOwnerAllocation,
  digestPolicyDecision,
  digestProtectedManifest,
  evaluateAdmission,
  evaluateAdmissionAtMicros,
  evaluateAdmissionAtTimestamp,
  evaluateRestoration,
  evaluateRestorationAtMicros,
  evaluateRestorationAtTimestamp,
  projectWireCore,
} from '../accounted-host-policy.mjs';

const NOW = Date.parse('2030-01-01T00:00:00.000Z');
const DEADLINE = '2030-01-01T00:00:10.000000Z';
const OBSERVED = '2029-12-31T23:59:59.000000Z';
const digest = (char) => char.repeat(64);

function bindings() {
  const ownerAllocationDigest = allocation().digest;
  const controlPlaneAccountingDigest = accounting().digest;
  const protectedManifestDigest = manifest().digest;
  return {
    requestId: '11111111-1111-4111-8111-111111111111',
    attemptId: '22222222-2222-4222-8222-222222222222',
    hostId: 'fixture-host-alpha',
    requestDigest: digest('a'),
    artifactSha256: digest('b'),
    actorUid: 1000,
    deadline: DEADLINE,
    protectedManifestDigest,
    ownerAllocationDigest,
    firstChargedInstructionDigest: digest('e'),
    controlPlaneAccountingDigest,
  };
}

function allocation() {
  const body = {
    chargedMemoryMaxBytes: 1000001,
    swapMaxBytes: 0,
    cpuQuotaMicros: 12500,
    cpuPeriodMicros: 1000000,
    tasksMax: 7,
    addressSpaceLimitBytes: 2000001,
  };
  return { ...body, digest: digestOwnerAllocation(body) };
}

function accounting() {
  const body = { status: 'complete', scope: 'whole-task' };
  return { ...body, digest: digestControlPlaneAccounting(body) };
}

function services() {
  return [
    { unit: 'fixture-alpha.service', active: true, invocationId: 'fixture-invocation-a', restarts: 0 },
    { unit: 'fixture-beta.service', active: true, invocationId: 'fixture-invocation-b', restarts: 0 },
  ];
}

function oomCounters() {
  return {
    host: 0,
    services: [
      { unit: 'fixture-alpha.service', kills: 0 },
      { unit: 'fixture-beta.service', kills: 0 },
    ],
  };
}

function manifest() {
  const body = {
    schemaVersion: 1,
    laneId: 'accounted-podman-info-v1',
    services: services(),
    residency: { mode: 'preserve', models: ['fixture-model-a'] },
    oomCounters: oomCounters(),
  };
  return { ...body, digest: digestProtectedManifest(body) };
}

function makeInput() {
  const b = bindings();
  const protectedManifest = manifest();
  const plan = {
    schemaVersion: 1,
    laneId: 'accounted-podman-info-v1',
    bindings: b,
    ownerAllocation: allocation(),
    coverage: { wholeTask: 'complete', completeBeforeFirstWork: true },
    controlPlaneAccounting: accounting(),
    controls: { gpuAccess: false, payloadIpNetwork: false, localIpcDefined: true },
    observationMaxAgeMs: 5000,
    residency: { mode: 'preserve', models: ['fixture-model-a'] },
  };
  const observation = {
    schemaVersion: 1,
    laneId: 'accounted-podman-info-v1',
    bindings: structuredClone(b),
    observedAt: OBSERVED,
    ownerAllocation: structuredClone(plan.ownerAllocation),
    coverage: structuredClone(plan.coverage),
    controlPlaneAccounting: structuredClone(plan.controlPlaneAccounting),
    controls: structuredClone(plan.controls),
    work: {
      gateway: { active: 0, queued: 0, leaseHeld: false },
      backend: { coverage: 'complete', active: 0, queued: 0 },
    },
    maintenance: { active: false },
    protectedServices: services(),
    residency: { models: ['fixture-model-a'] },
    oomCounters: oomCounters(),
  };
  return { plan, protectedManifest, observation };
}

test('valid admission is structural only and never execution authorization', () => {
  const input = makeInput();
  const result = evaluateAdmission(input, NOW);
  assert.equal(result.admit, true);
  assert.equal(result.offlineOnly, true);
  assert.equal(result.executionAuthorized, false);
  assert.equal(typeof result.inputDigest, 'string');
  const { decisionDigest, ...decision } = result;
  assert.equal(decisionDigest, digestPolicyDecision(decision));
});

test('unknown fields and absent allocation values fail closed without defaults', () => {
  const input = makeInput();
  input.plan.unexpected = 'fixture-secret-content';
  delete input.observation.ownerAllocation.chargedMemoryMaxBytes;
  const result = evaluateAdmission(input, NOW);
  assert.equal(result.admit, false);
  assert.deepEqual([...result.reasons].sort(), result.reasons);
  assert.ok(result.reasons.includes('unknown_field'));
  assert.ok(result.reasons.includes('allocation_invalid'));
  assert.equal(result.inputDigest, null);
  assert.equal(JSON.stringify(result).includes('fixture-secret-content'), false);
});

test('nested bindings project to the exact proposed flat core without authorization', () => {
  const input = makeInput();
  assert.deepEqual(projectWireCore(input.plan.bindings), {
    schemaVersion: 1,
    laneId: 'accounted-podman-info-v1',
    requestId: '11111111-1111-4111-8111-111111111111',
    attemptId: '22222222-2222-4222-8222-222222222222',
    hostId: 'fixture-host-alpha',
    actorUid: 1000,
    requestDigest: digest('a'),
    artifactSha256: digest('b'),
    deadline: DEADLINE,
    protectedManifestDigest: manifest().digest,
    ownerAllocationDigest: allocation().digest,
    firstChargedInstructionDigest: digest('e'),
    controlPlaneAccountingDigest: accounting().digest,
  });
});

test('tampering a manifest body with the old digest is rejected', () => {
  const input = makeInput();
  input.protectedManifest.services[0].invocationId = 'fixture-invocation-tampered';
  const result = evaluateAdmission(input, NOW);
  assert.equal(result.admit, false);
  assert.ok(result.reasons.includes('digest_mismatch'));
});

test('microsecond timestamps compare exactly and reject wrong shape', () => {
  const input = makeInput();
  input.plan.bindings.deadline = '2030-01-01T00:00:00.000001Z';
  input.observation.bindings.deadline = input.plan.bindings.deadline;
  const justBefore = evaluateAdmission(input, NOW);
  assert.equal(justBefore.reasons.includes('expired'), false);
  input.plan.bindings.deadline = '2030-01-01T00:00:00.000000Z';
  input.observation.bindings.deadline = input.plan.bindings.deadline;
  const oneMillisecondLater = evaluateAdmission(input, Date.parse('2030-01-01T00:00:00.001Z'));
  assert.ok(oneMillisecondLater.reasons.includes('expired'));
  input.plan.bindings.deadline = '2030-01-01T00:00:00.000001Z';
  input.observation.bindings.deadline = input.plan.bindings.deadline;
  input.observation.observedAt = '2030-01-01T00:00:00.123456Z';
  const future = evaluateAdmission(input, NOW);
  assert.ok(future.reasons.includes('future_observation'));
  input.plan.bindings.deadline = '2030-01-01T00:00:00.123455Z';
  input.observation.bindings.deadline = input.plan.bindings.deadline;
  const sixDigitDifference = evaluateAdmission(input, NOW);
  assert.ok(sixDigitDifference.reasons.includes('expired'));
  input.plan.bindings.deadline = '2030-01-01T00:00:00.123456Z';
  input.observation.bindings.deadline = input.plan.bindings.deadline;
  const exactMicrosecond = evaluateAdmission(input, NOW);
  assert.equal(exactMicrosecond.reasons.includes('expired'), false);
  input.observation.observedAt = '2029-12-31T23:59:59.000Z';
  const wrongShape = evaluateAdmission(input, NOW);
  assert.ok(wrongShape.reasons.includes('observation_stale'));
  for (const invalidDeadline of [
    '2030-02-30T00:00:00.000000Z',
    '2030-01-01T00:00:00.12345Z',
    '2030-01-01T00:00:00.000000+00:00',
  ]) {
    const invalid = makeInput();
    invalid.plan.bindings.deadline = invalidDeadline;
    invalid.observation.bindings.deadline = invalidDeadline;
    const invalidResult = evaluateAdmission(invalid, NOW);
    assert.ok(invalidResult.reasons.includes('binding_mismatch'), invalidDeadline);
    assert.equal(invalidResult.inputDigest, null);
  }
});

test('BigInt microsecond clocks and exact timestamp adapters preserve 1us boundaries', () => {
  const input = makeInput();
  input.plan.bindings.deadline = '2030-01-01T00:00:00.000001Z';
  input.observation.bindings.deadline = input.plan.bindings.deadline;
  const baseMicros = BigInt(NOW) * 1000n;
  assert.equal(evaluateAdmissionAtMicros(input, baseMicros).reasons.includes('expired'), false);
  assert.ok(evaluateAdmissionAtMicros(input, baseMicros + 2n).reasons.includes('expired'));
  assert.equal(
    evaluateAdmissionAtTimestamp(input, '2030-01-01T00:00:00.000000Z').reasons.includes('expired'),
    false,
  );
  assert.ok(evaluateAdmissionAtTimestamp(input, '2030-01-01T00:00:00.000002Z').reasons.includes('expired'));
  assert.ok(evaluateAdmissionAtMicros(input, 'not-a-bigint').reasons.includes('clock_invalid'));
  assert.ok(evaluateAdmissionAtTimestamp(input, '2030-01-01T00:00:00.000000+00:00').reasons.includes('clock_invalid'));
  const restoration = makeInput();
  restoration.baseline = structuredClone(restoration.observation);
  assert.equal(evaluateRestorationAtMicros(restoration, baseMicros).admit, true);
  assert.equal(evaluateRestorationAtTimestamp(restoration, '2030-01-01T00:00:00.000000Z').admit, true);
});

test('canonical hashing sorts keys, preserves Unicode, and rejects floats', () => {
  assert.equal(canonicalStringify({ z: 'å', a: 1 }), '{"a":1,"z":"å"}');
  assert.equal(canonicalStringify({ a: 1, z: 'å' }), '{"a":1,"z":"å"}');
  assert.throws(() => canonicalStringify({ value: 1.5 }), /safe integers/);
});

test('observation bindings, coverage, and control-plane accounting must agree', () => {
  const input = makeInput();
  input.observation.bindings.requestDigest = digest('9');
  input.observation.coverage.wholeTask = 'unknown';
  input.observation.controlPlaneAccounting.status = 'unknown';
  const result = evaluateAdmission(input, NOW);
  assert.ok(result.reasons.includes('binding_mismatch'));
  assert.ok(result.reasons.includes('coverage_incomplete'));
  assert.ok(result.reasons.includes('control_plane_unknown'));
});

test('unknown observation residency fields fail closed', () => {
  const input = makeInput();
  input.observation.residency.extra = 'fixture-content';
  const result = evaluateAdmission(input, NOW);
  assert.equal(result.admit, false);
  assert.ok(result.reasons.includes('unknown_field'));
  assert.equal(JSON.stringify(result).includes('fixture-content'), false);
});

test('busy, conflicting, future, stale, and expired evidence is rejected', () => {
  const input = makeInput();
  input.plan.controls.gpuAccess = true;
  input.observation.controls.payloadIpNetwork = true;
  input.observation.controls.localIpcDefined = false;
  input.observation.observedAt = '2030-01-01T00:00:20.000000Z';
  input.observation.work.gateway.active = 1;
  input.observation.work.backend.queued = 1;
  input.observation.maintenance.active = true;
  const result = evaluateAdmission(input, NOW);
  for (const reason of [
    'gpu_access_forbidden', 'payload_ip_network_forbidden', 'local_ipc_undefined',
    'future_observation', 'work_active', 'work_queued', 'maintenance_active', 'expired',
  ]) assert.ok(result.reasons.includes(reason), reason);
  assert.deepEqual([...result.reasons].sort(), result.reasons);
  assert.ok(result.reasons.length <= 32);
});

test('restoration rejects protected identity, restart, OOM, and residency drift', () => {
  const input = makeInput();
  const baseline = structuredClone(input.observation);
  input.baseline = baseline;
  input.observation.protectedServices[0].invocationId = 'fixture-invocation-changed';
  input.observation.protectedServices[1].restarts = 1;
  input.observation.oomCounters.host = 1;
  input.observation.residency.models = ['fixture-model-other'];
  const result = evaluateRestoration(input, NOW);
  for (const reason of ['protected_identity_drift', 'protected_restart_drift', 'oom_drift', 'residency_drift']) {
    assert.ok(result.reasons.includes(reason), reason);
  }
  assert.equal(result.executionAuthorized, false);
});

test('restoration binds baseline bindings, allocation, time, and residency to the plan', () => {
  const requestChanged = makeInput();
  requestChanged.baseline = structuredClone(requestChanged.observation);
  requestChanged.baseline.bindings.requestId = '33333333-3333-4333-8333-333333333333';
  assert.equal(evaluateRestoration(requestChanged, NOW).admit, false);

  const allocationChanged = makeInput();
  allocationChanged.baseline = structuredClone(allocationChanged.observation);
  allocationChanged.baseline.ownerAllocation.tasksMax = 8;
  assert.equal(evaluateRestoration(allocationChanged, NOW).admit, false);

  const timeChanged = makeInput();
  timeChanged.baseline = structuredClone(timeChanged.observation);
  timeChanged.baseline.observedAt = '2031-01-01T00:00:00.000000Z';
  assert.equal(evaluateRestoration(timeChanged, NOW).admit, false);

  const residencyChanged = makeInput();
  residencyChanged.baseline = structuredClone(residencyChanged.observation);
  residencyChanged.baseline.residency.models = ['fixture-model-other'];
  residencyChanged.observation.residency.models = ['fixture-model-other'];
  assert.equal(evaluateRestoration(residencyChanged, NOW).admit, false);
});

test('protected services require exactly one OOM counter each', () => {
  const input = makeInput();
  input.protectedManifest.oomCounters.services = [];
  input.observation.oomCounters.services = [];
  input.protectedManifest.digest = digestProtectedManifest(input.protectedManifest);
  input.plan.bindings.protectedManifestDigest = input.protectedManifest.digest;
  input.observation.bindings.protectedManifestDigest = input.protectedManifest.digest;
  const result = evaluateAdmission(input, NOW);
  assert.equal(result.admit, false);
  assert.ok(result.reasons.includes('oom_unknown'));
});

test('null nested entries fail closed without throwing or echoing content', () => {
  for (const mutate of [
    (input) => { input.observation.protectedServices[0] = null; },
    (input) => { input.observation.oomCounters.services[0] = null; },
  ]) {
    const input = makeInput();
    mutate(input);
    assert.doesNotThrow(() => evaluateAdmission(input, NOW));
    const result = evaluateAdmission(input, NOW);
    assert.equal(result.admit, false);
    assert.equal(result.inputDigest, null);
  }
});

test('safe integer bounds and invalid control types produce null input digests', () => {
  const oversized = makeInput();
  oversized.plan.ownerAllocation.tasksMax = Number.MAX_SAFE_INTEGER + 1;
  oversized.observation.ownerAllocation.tasksMax = Number.MAX_SAFE_INTEGER + 1;
  const oversizedResult = evaluateAdmission(oversized, NOW);
  assert.equal(oversizedResult.inputDigest, null);
  assert.ok(oversizedResult.reasons.includes('allocation_invalid'));

  const invalidControl = makeInput();
  invalidControl.plan.controls.localIpcDefined = 'true';
  invalidControl.observation.controls.localIpcDefined = 'true';
  const invalidControlResult = evaluateAdmission(invalidControl, NOW);
  assert.equal(invalidControlResult.inputDigest, null);
  assert.ok(invalidControlResult.reasons.includes('controls_conflict'));
});

test('malformed baseline, unknown counters, and stale observation reject restoration', () => {
  const input = makeInput();
  input.baseline = { ...input.observation, oomCounters: null };
  const result = evaluateRestoration(input, NOW);
  assert.ok(result.reasons.includes('baseline_invalid'));
  assert.ok(result.reasons.includes('oom_unknown'));
});

test('unlisted enums and malformed baseline fields never receive an input digest', () => {
  for (const change of [
    x => { x.plan.coverage.wholeTask = 'unlisted'; },
    x => { x.observation.work.backend.coverage = 'unlisted'; },
    x => { x.observation.controlPlaneAccounting.status = 123; },
    x => { x.observation.controlPlaneAccounting.scope = 123; },
  ]) {
    const input = makeInput(); change(input);
    assert.equal(evaluateAdmission(input, NOW).inputDigest, null);
  }
  for (const change of [
    x => { x.baseline.observedAt = 123; },
    x => { x.baseline.observedAt = '2030-02-31T00:00:00.000000Z'; },
    x => { x.baseline.residency.models = 123; },
  ]) {
    const input = makeInput(); input.baseline = structuredClone(input.observation); change(input);
    assert.equal(evaluateRestoration(input, NOW).inputDigest, null);
  }
});

test('Unicode string bounds count code points consistently with JSON Schema', () => {
  const input = makeInput();
  const id = '😀'.repeat(129);
  for (const s of input.protectedManifest.services) s.invocationId = id;
  for (const s of input.observation.protectedServices) s.invocationId = id;
  input.protectedManifest.digest = digestProtectedManifest(input.protectedManifest);
  input.plan.bindings.protectedManifestDigest = input.protectedManifest.digest;
  input.observation.bindings.protectedManifestDigest = input.protectedManifest.digest;
  assert.equal(evaluateAdmission(input, NOW).admit, true);
});

test('shared calendar supports years 0001 through 9999 and rejects year zero', () => {
  const input = makeInput();
  input.plan.bindings.deadline = '0000-01-01T00:00:10.000000Z';
  input.observation.bindings.deadline = input.plan.bindings.deadline;
  input.observation.observedAt = '0000-01-01T00:00:00.000000Z';
  const result = evaluateAdmissionAtTimestamp(input, '0000-01-01T00:00:00.000000Z');
  assert.equal(result.admit, false);
  assert.equal(result.inputDigest, null);
  assert.ok(result.reasons.includes('clock_invalid'));
  for (const year of ['0001', '9999']) {
    input.plan.bindings.deadline = `${year}-01-01T00:00:10.000000Z`;
    input.observation.bindings.deadline = input.plan.bindings.deadline;
    input.observation.observedAt = `${year}-01-01T00:00:00.000000Z`;
    assert.equal(evaluateAdmissionAtTimestamp(input, `${year}-01-01T00:00:00.000000Z`).admit, true);
  }
});

test('malformed JSON activity objects fail closed without numeric coercion', () => {
  for (const section of ['gateway','backend']) for (const key of ['active','queued']) {
    for (const phase of ['admission','restoration']) {
      const input = makeInput();
      if (phase === 'restoration') input.baseline = structuredClone(input.observation);
      (phase === 'restoration' ? input.baseline : input.observation).work[section][key] = {toString:null,valueOf:null};
      const check = phase === 'restoration' ? evaluateRestoration : evaluateAdmission;
      assert.doesNotThrow(() => check(input, NOW));
      const result = check(input,NOW);
      assert.equal(result.admit,false);
      assert.equal(result.inputDigest,null);
    }
  }
});
