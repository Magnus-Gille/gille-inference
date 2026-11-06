import { createHash } from 'node:crypto';

const SCHEMA_VERSION = 1;
const LANE_ID = 'accounted-podman-info-v1';
const MAX_REASONS = 32;
const MAX_CLOCK_MICROS = 8640000000000000000000n;
const SHA256 = /^[0-9a-f]{64}$/;
const UTC_MICROSECONDS_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/;
const DOMAIN = Object.freeze({
  protectedManifest: 'gille-inference/accounted/protected-manifest/v1\n',
  ownerAllocation: 'gille-inference/accounted/owner-allocation/v1\n',
  controlPlaneAccounting: 'gille-inference/accounted/control-plane-accounting/v1\n',
  policyInput: 'gille-inference/accounted/policy-input/v1\n',
  policyDecision: 'gille-inference/accounted/policy-decision/v1\n',
});

const REASON_CODES = Object.freeze([
  'activity_unknown',
  'allocation_invalid',
  'allocation_mismatch',
  'baseline_invalid',
  'baseline_missing',
  'binding_mismatch',
  'clock_invalid',
  'conflicting_evidence',
  'control_plane_incomplete',
  'control_plane_unknown',
  'controls_conflict',
  'coverage_incomplete',
  'digest_mismatch',
  'expired',
  'future_observation',
  'gpu_access_forbidden',
  'lane_mismatch',
  'lease_held',
  'local_ipc_undefined',
  'malformed_input',
  'maintenance_active',
  'maintenance_unknown',
  'manifest_invalid',
  'missing_field',
  'observation_stale',
  'oom_drift',
  'oom_unknown',
  'payload_ip_network_forbidden',
  'protected_identity_drift',
  'protected_inventory_drift',
  'protected_restart_drift',
  'protected_service_unhealthy',
  'residency_drift',
  'schema_mismatch',
  'unknown_field',
  'work_active',
  'work_queued',
]);
const REASON_SET = new Set(REASON_CODES);
const STRUCTURAL_REASONS = new Set([
  'activity_unknown', 'allocation_invalid', 'baseline_invalid',
  'lane_mismatch', 'manifest_invalid', 'malformed_input', 'maintenance_unknown',
  'missing_field', 'oom_unknown', 'schema_mismatch', 'unknown_field',
]);
const BASELINE_INVALIDATING_REASONS = new Set([
  'activity_unknown', 'allocation_invalid', 'binding_mismatch', 'control_plane_incomplete',
  'control_plane_unknown', 'controls_conflict', 'coverage_incomplete', 'digest_mismatch',
  'lane_mismatch', 'local_ipc_undefined', 'malformed_input', 'maintenance_unknown',
  'manifest_invalid', 'missing_field', 'oom_unknown', 'schema_mismatch', 'unknown_field',
]);

const BINDING_KEYS = [
  'requestId', 'attemptId', 'hostId', 'actorUid', 'requestDigest', 'artifactSha256',
  'deadline', 'protectedManifestDigest', 'ownerAllocationDigest',
  'firstChargedInstructionDigest', 'controlPlaneAccountingDigest',
];
const ALLOCATION_KEYS = [
  'chargedMemoryMaxBytes', 'swapMaxBytes', 'cpuQuotaMicros', 'cpuPeriodMicros',
  'tasksMax', 'addressSpaceLimitBytes', 'digest',
];
const COVERAGE_KEYS = ['wholeTask', 'completeBeforeFirstWork'];
const ACCOUNTING_KEYS = ['status', 'scope', 'digest'];
const CONTROL_KEYS = ['gpuAccess', 'payloadIpNetwork', 'localIpcDefined'];
const SERVICE_KEYS = ['unit', 'active', 'invocationId', 'restarts'];
const OOM_SERVICE_KEYS = ['unit', 'kills'];

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function has(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function mark(state, reason) {
  if (REASON_SET.has(reason)) state.reasons.add(reason);
  if (STRUCTURAL_REASONS.has(reason)) state.structuralInvalid = true;
}

function markStructural(state, reason) {
  state.structuralInvalid = true;
  mark(state, reason);
}

function checkObject(value, keys, state, extraReason = 'malformed_input') {
  if (!isRecord(value)) {
    mark(state, extraReason);
    return false;
  }
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) mark(state, 'unknown_field');
  }
  for (const key of keys) {
    if (!has(value, key)) mark(state, 'missing_field');
  }
  return true;
}

function validBoundedString(value, max = 256) {
  return typeof value === 'string' && [...value].length > 0 && [...value].length <= max;
}

function validDigest(value) {
  return typeof value === 'string' && SHA256.test(value);
}

function validTimestamp(value) {
  return parseTimestampMicros(value) !== null;
}

function parseTimestampMicros(value) {
  if (typeof value !== 'string') return null;
  const match = UTC_MICROSECONDS_TIMESTAMP.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, fraction] = match;
  if (year === '0000') return null;
  const monthNumber = Number(month);
  const dayNumber = Number(day);
  const hourNumber = Number(hour);
  const minuteNumber = Number(minute);
  const secondNumber = Number(second);
  if (monthNumber < 1 || monthNumber > 12 || dayNumber < 1 || dayNumber > 31
      || hourNumber > 23 || minuteNumber > 59 || secondNumber > 59) return null;
  const millisText = `${year}-${month}-${day}T${hour}:${minute}:${second}.000Z`;
  const millis = Date.parse(millisText);
  if (!Number.isFinite(millis)) return null;
  const canonicalMillis = new Date(millis).toISOString();
  if (`${canonicalMillis.slice(0, 23)}Z` !== millisText) return null;
  return BigInt(millis) * 1000n + BigInt(fraction);
}

function canonicalStringify(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError('canonical JSON requires safe integers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`).join(',')}}`;
  }
  throw new TypeError('canonical JSON accepts JSON values only');
}

function digestDomain(domain, value) {
  return createHash('sha256').update(domain, 'utf8').update(canonicalStringify(value), 'utf8').digest('hex');
}

function withoutDigest(value) {
  if (!isRecord(value)) return value;
  const { digest: ignored, ...body } = value;
  return body;
}

function policyInputDigest(input) {
  return digestDomain(DOMAIN.policyInput, input);
}

function makeDecisionDigest(decision) {
  const { decisionDigest: ignored, ...body } = decision;
  return digestDomain(DOMAIN.policyDecision, body);
}

export { canonicalStringify };

export function digestProtectedManifest(manifest) {
  return digestDomain(DOMAIN.protectedManifest, withoutDigest(manifest));
}

export function digestOwnerAllocation(allocation) {
  return digestDomain(DOMAIN.ownerAllocation, withoutDigest(allocation));
}

export function digestControlPlaneAccounting(accounting) {
  return digestDomain(DOMAIN.controlPlaneAccounting, withoutDigest(accounting));
}

export function digestPolicyInput(input) {
  return policyInputDigest(input);
}

export function digestPolicyDecision(decision) {
  return makeDecisionDigest(decision);
}

function safeDigest(digestFn, value) {
  try {
    return digestFn(value);
  } catch {
    return null;
  }
}

function validClockMicros(value) {
  return typeof value === 'bigint' && value >= -MAX_CLOCK_MICROS && value <= MAX_CLOCK_MICROS;
}

function validNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function validateHeader(value, state) {
  if (!isRecord(value)) {
    mark(state, 'malformed_input');
    return false;
  }
  if (!has(value, 'schemaVersion')) mark(state, 'missing_field');
  if (!has(value, 'laneId')) mark(state, 'missing_field');
  if (value.schemaVersion !== SCHEMA_VERSION) mark(state, 'schema_mismatch');
  if (value.laneId !== LANE_ID) mark(state, 'lane_mismatch');
  return true;
}

function validateBindings(value, state) {
  if (!checkObject(value, BINDING_KEYS, state)) return false;
  for (const key of ['requestId', 'attemptId']) {
    if (typeof value[key] !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value[key])) markStructural(state, 'binding_mismatch');
  }
  if (typeof value.hostId !== 'string' || !/^[a-z][a-z0-9-]{0,62}$/.test(value.hostId)) markStructural(state, 'binding_mismatch');
  for (const key of [
    'requestDigest', 'artifactSha256', 'protectedManifestDigest', 'ownerAllocationDigest',
    'firstChargedInstructionDigest', 'controlPlaneAccountingDigest',
  ]) {
    if (!validDigest(value[key])) markStructural(state, 'binding_mismatch');
  }
  if (value.actorUid !== 1000 || !Number.isInteger(value.actorUid)) markStructural(state, 'binding_mismatch');
  if (!validTimestamp(value.deadline)) markStructural(state, 'binding_mismatch');
  return true;
}

function validateAllocation(value, state) {
  if (!checkObject(value, ALLOCATION_KEYS, state)) return false;
  if (!validPositiveInteger(value.chargedMemoryMaxBytes)
      || !validNonNegativeInteger(value.swapMaxBytes)
      || !validPositiveInteger(value.cpuQuotaMicros)
      || !validPositiveInteger(value.cpuPeriodMicros)
      || !validPositiveInteger(value.tasksMax)
      || !validPositiveInteger(value.addressSpaceLimitBytes)
      || !validDigest(value.digest)) {
    markStructural(state, 'allocation_invalid');
  }
  return true;
}

function validateCoverage(value, state) {
  if (!checkObject(value, COVERAGE_KEYS, state)) return false;
  if (!['complete', 'incomplete', 'unknown'].includes(value.wholeTask) || typeof value.completeBeforeFirstWork !== 'boolean') {
    markStructural(state, 'coverage_incomplete');
  } else if (value.wholeTask !== 'complete' || value.completeBeforeFirstWork !== true) {
    mark(state, 'coverage_incomplete');
  }
  return true;
}

function validateAccounting(value, state) {
  if (!checkObject(value, ACCOUNTING_KEYS, state)) return false;
  if (!['complete', 'incomplete', 'unknown'].includes(value.status)) markStructural(state, 'control_plane_incomplete');
  if (!['whole-task', 'partial', 'unknown'].includes(value.scope)) markStructural(state, 'control_plane_incomplete');
  if (value.status === 'unknown') mark(state, 'control_plane_unknown');
  else if (value.status !== 'complete') mark(state, 'control_plane_incomplete');
  if (value.scope !== 'whole-task') mark(state, 'digest_mismatch');
  if (!validDigest(value.digest)) markStructural(state, 'digest_mismatch');
  return true;
}

function validateControls(value, state) {
  if (!checkObject(value, CONTROL_KEYS, state)) return false;
  if (value.gpuAccess === true) mark(state, 'gpu_access_forbidden');
  else if (typeof value.gpuAccess !== 'boolean') markStructural(state, 'controls_conflict');
  if (value.payloadIpNetwork === true) mark(state, 'payload_ip_network_forbidden');
  else if (typeof value.payloadIpNetwork !== 'boolean') markStructural(state, 'controls_conflict');
  if (typeof value.localIpcDefined !== 'boolean') markStructural(state, 'controls_conflict');
  else if (value.localIpcDefined !== true) mark(state, 'local_ipc_undefined');
  return true;
}

function validateServices(value, state, reason = 'manifest_invalid') {
  if (!Array.isArray(value)) {
    markStructural(state, reason);
    return false;
  }
  if (value.length === 0) markStructural(state, reason);
  const units = new Set();
  for (const service of value) {
    if (!checkObject(service, SERVICE_KEYS, state, reason)) continue;
    if (!validBoundedString(service.unit, 256)
        || typeof service.active !== 'boolean'
        || !validBoundedString(service.invocationId, 256)
        || !validNonNegativeInteger(service.restarts)) {
      markStructural(state, reason);
    }
    if (units.has(service.unit)) mark(state, 'protected_inventory_drift');
    units.add(service.unit);
  }
  return true;
}

function validateOomCounters(value, state, protectedServices = null) {
  if (!isRecord(value)) {
    markStructural(state, 'oom_unknown');
    return false;
  }
  if (!checkObject(value, ['host', 'services'], state)) return false;
  if (!validNonNegativeInteger(value.host)) markStructural(state, 'oom_unknown');
  if (!Array.isArray(value.services)) {
    markStructural(state, 'oom_unknown');
    return false;
  }
  if (value.services.length === 0) markStructural(state, 'oom_unknown');
  const units = new Set();
  for (const service of value.services) {
    if (!checkObject(service, OOM_SERVICE_KEYS, state, 'oom_unknown')) continue;
    if (!validBoundedString(service.unit, 256) || !validNonNegativeInteger(service.kills)) markStructural(state, 'oom_unknown');
    if (units.has(service.unit)) mark(state, 'oom_unknown');
    units.add(service.unit);
  }
  if (Array.isArray(protectedServices)) {
    const protectedUnits = new Set(protectedServices.map((service) => service?.unit));
    if (protectedUnits.size !== protectedServices.length || units.size !== protectedUnits.size
        || [...protectedUnits].some((unit) => !units.has(unit))) {
      markStructural(state, 'oom_unknown');
    }
  }
  return true;
}

function validateResidency(value, state) {
  if (!checkObject(value, ['mode', 'models'], state)) return false;
  if (value.mode !== 'preserve' || !Array.isArray(value.models) || value.models.length === 0
      || value.models.some((model) => !validBoundedString(model, 256))) {
    markStructural(state, 'residency_drift');
  }
  if (Array.isArray(value.models) && new Set(value.models).size !== value.models.length) markStructural(state, 'residency_drift');
  return true;
}

function validateObservationResidency(value, state) {
  if (!checkObject(value, ['models'], state)) return false;
  if (!Array.isArray(value.models) || value.models.length === 0
      || value.models.some((model) => !validBoundedString(model, 256))) {
    markStructural(state, 'residency_drift');
  }
  if (Array.isArray(value.models) && new Set(value.models).size !== value.models.length) markStructural(state, 'residency_drift');
  return true;
}

function validatePlan(value, state) {
  if (!checkObject(value, [
    'schemaVersion', 'laneId', 'bindings', 'ownerAllocation', 'coverage',
    'controlPlaneAccounting', 'controls', 'observationMaxAgeMs', 'residency',
  ], state)) return false;
  validateHeader(value, state);
  validateBindings(value.bindings, state);
  validateAllocation(value.ownerAllocation, state);
  validateCoverage(value.coverage, state);
  validateAccounting(value.controlPlaneAccounting, state);
  validateControls(value.controls, state);
  if (!validPositiveInteger(value.observationMaxAgeMs)) markStructural(state, 'observation_stale');
  validateResidency(value.residency, state);
  return true;
}

function validateManifest(value, state) {
  if (!checkObject(value, ['schemaVersion', 'laneId', 'digest', 'services', 'oomCounters', 'residency'], state)) return false;
  validateHeader(value, state);
  if (!validDigest(value.digest)) markStructural(state, 'manifest_invalid');
  validateServices(value.services, state);
  validateResidency(value.residency, state);
  validateOomCounters(value.oomCounters, state, value.services);
  return true;
}

function validateActivity(value, state) {
  if (!checkObject(value, ['active', 'queued', 'leaseHeld'], state, 'activity_unknown')) return false;
  if (!validNonNegativeInteger(value.active) || !validNonNegativeInteger(value.queued)
      || typeof value.leaseHeld !== 'boolean') {
    markStructural(state, 'activity_unknown');
  }
  if (validNonNegativeInteger(value.active) && value.active > 0) mark(state, 'work_active');
  if (validNonNegativeInteger(value.queued) && value.queued > 0) mark(state, 'work_queued');
  if (value.leaseHeld === true) mark(state, 'lease_held');
  return true;
}

function validateObservation(value, state, { baseline = false } = {}) {
  const malformedReason = baseline ? 'baseline_invalid' : 'malformed_input';
  if (!checkObject(value, [
    'schemaVersion', 'laneId', 'bindings', 'observedAt', 'ownerAllocation', 'coverage',
    'controlPlaneAccounting', 'controls', 'work', 'maintenance', 'protectedServices',
    'residency', 'oomCounters',
  ], state, malformedReason)) return false;
  validateHeader(value, state);
  validateBindings(value.bindings, state);
  if (!validTimestamp(value.observedAt)) markStructural(state, 'observation_stale');
  validateAllocation(value.ownerAllocation, state);
  validateCoverage(value.coverage, state);
  validateAccounting(value.controlPlaneAccounting, state);
  validateControls(value.controls, state);
  if (!checkObject(value.work, ['gateway', 'backend'], state, 'activity_unknown')) return false;
  validateActivity(value.work.gateway, state);
  if (checkObject(value.work.backend, ['coverage', 'active', 'queued'], state, 'activity_unknown')) {
    if (!['complete', 'incomplete', 'unknown'].includes(value.work.backend.coverage)) markStructural(state, 'coverage_incomplete');
    else if (value.work.backend.coverage !== 'complete') mark(state, 'coverage_incomplete');
    if (!validNonNegativeInteger(value.work.backend.active) || !validNonNegativeInteger(value.work.backend.queued)) {
      markStructural(state, 'activity_unknown');
    }
    if (validNonNegativeInteger(value.work.backend.active) && value.work.backend.active > 0) mark(state, 'work_active');
    if (validNonNegativeInteger(value.work.backend.queued) && value.work.backend.queued > 0) mark(state, 'work_queued');
  }
  if (!checkObject(value.maintenance, ['active'], state, 'maintenance_unknown')) {
    return false;
  }
  if (typeof value.maintenance.active !== 'boolean') mark(state, 'maintenance_unknown');
  else if (value.maintenance.active) mark(state, 'maintenance_active');
  validateServices(value.protectedServices, state, 'manifest_invalid');
  validateObservationResidency(value.residency, state);
  validateOomCounters(value.oomCounters, state, value.protectedServices);
  return true;
}

function sameKeys(left, right, keys) {
  return keys.every((key) => left?.[key] === right?.[key]);
}

function sameBindings(left, right) {
  return isRecord(left) && isRecord(right) && sameKeys(left, right, BINDING_KEYS);
}

function sameAllocation(left, right) {
  return isRecord(left) && isRecord(right) && sameKeys(left, right, ALLOCATION_KEYS);
}

function sameServices(left, right, compare = 'all') {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  const a = new Map(left.map((entry) => [entry.unit, entry]));
  const b = new Map(right.map((entry) => [entry.unit, entry]));
  if (a.size !== b.size) return false;
  for (const [unit, service] of a) {
    const other = b.get(unit);
    if (!other) return false;
    if (compare === 'all' && !sameKeys(service, other, SERVICE_KEYS)) return false;
    if (compare === 'identity' && service.invocationId !== other.invocationId) return false;
    if (compare === 'restarts' && service.restarts !== other.restarts) return false;
  }
  return true;
}

function sameOom(left, right) {
  if (!isRecord(left) || !isRecord(right) || left.host !== right.host) return false;
  if (!Array.isArray(left.services) || !Array.isArray(right.services) || left.services.length !== right.services.length) return false;
  const a = new Map(left.services.map((entry) => [entry.unit, entry.kills]));
  const b = new Map(right.services.map((entry) => [entry.unit, entry.kills]));
  if (a.size !== b.size) return false;
  for (const [unit, kills] of a) if (b.get(unit) !== kills) return false;
  return true;
}

function sameModels(left, right) {
  return isRecord(left) && isRecord(right) && Array.isArray(left.models) && Array.isArray(right.models)
    && left.models.length === right.models.length && left.models.every((model, i) => model === right.models[i]);
}

function comparePlanBindings(plan, manifest, observation, state) {
  const bindings = plan?.bindings;
  if (!sameBindings(observation?.bindings, bindings)) mark(state, 'binding_mismatch');
  if (manifest?.digest !== bindings?.protectedManifestDigest) mark(state, 'digest_mismatch');
  if (manifest?.digest !== safeDigest(digestProtectedManifest, manifest)) mark(state, 'digest_mismatch');
  if (plan?.ownerAllocation?.digest !== bindings?.ownerAllocationDigest
      || observation?.ownerAllocation?.digest !== bindings?.ownerAllocationDigest) mark(state, 'digest_mismatch');
  if (plan?.ownerAllocation?.digest !== safeDigest(digestOwnerAllocation, plan?.ownerAllocation)
      || observation?.ownerAllocation?.digest !== safeDigest(digestOwnerAllocation, observation?.ownerAllocation)) {
    mark(state, 'digest_mismatch');
  }
  if (plan?.controlPlaneAccounting?.digest !== bindings?.controlPlaneAccountingDigest
      || observation?.controlPlaneAccounting?.digest !== bindings?.controlPlaneAccountingDigest) mark(state, 'digest_mismatch');
  if (plan?.controlPlaneAccounting?.digest !== safeDigest(digestControlPlaneAccounting, plan?.controlPlaneAccounting)
      || observation?.controlPlaneAccounting?.digest !== safeDigest(digestControlPlaneAccounting, observation?.controlPlaneAccounting)) {
    mark(state, 'digest_mismatch');
  }
  if (!sameAllocation(observation?.ownerAllocation, plan?.ownerAllocation)) mark(state, 'allocation_mismatch');
  if (!sameKeys(observation?.coverage, plan?.coverage, COVERAGE_KEYS)) mark(state, 'coverage_incomplete');
  if (!sameKeys(observation?.controlPlaneAccounting, plan?.controlPlaneAccounting, ACCOUNTING_KEYS)) {
    mark(state, 'conflicting_evidence');
  }
  if (!sameKeys(observation?.controls, plan?.controls, CONTROL_KEYS)) mark(state, 'controls_conflict');
  if (!sameModels(manifest?.residency, plan?.residency)) mark(state, 'residency_drift');
}

function compareManifest(manifest, observation, state) {
  if (!sameServices(manifest?.services, observation?.protectedServices, 'all')) {
    mark(state, 'protected_inventory_drift');
  }
  if (!sameOom(manifest?.oomCounters, observation?.oomCounters)) mark(state, 'oom_drift');
  if (Array.isArray(observation?.protectedServices) && Array.isArray(manifest?.services)) {
    if (!sameServices(manifest.services, observation.protectedServices, 'identity')) mark(state, 'protected_identity_drift');
    if (!sameServices(manifest.services, observation.protectedServices, 'restarts')) mark(state, 'protected_restart_drift');
    if (observation.protectedServices.some((service) => service.active !== true)) mark(state, 'protected_service_unhealthy');
  }
}

function compareClock(plan, observation, nowMicros, state) {
  if (!validClockMicros(nowMicros)) {
    mark(state, 'clock_invalid');
    return;
  }
  const observedMicros = parseTimestampMicros(observation?.observedAt);
  const deadlineMicros = parseTimestampMicros(plan?.bindings?.deadline);
  if (deadlineMicros !== null && (nowMicros > deadlineMicros || (observedMicros !== null && observedMicros > deadlineMicros))) {
    mark(state, 'expired');
  }
  if (observedMicros === null) return;
  if (observedMicros > nowMicros) mark(state, 'future_observation');
  if (validPositiveInteger(plan?.observationMaxAgeMs)
      && nowMicros - observedMicros > BigInt(plan.observationMaxAgeMs) * 1000n) {
    mark(state, 'observation_stale');
  }
}

function compareRestoration(plan, observation, baseline, state) {
  if (!sameServices(baseline?.protectedServices, observation?.protectedServices, 'all')) {
    mark(state, 'protected_inventory_drift');
  }
  if (!sameServices(baseline?.protectedServices, observation?.protectedServices, 'identity')) {
    mark(state, 'protected_identity_drift');
  }
  if (!sameServices(baseline?.protectedServices, observation?.protectedServices, 'restarts')) {
    mark(state, 'protected_restart_drift');
  }
  if (!sameOom(baseline?.oomCounters, observation?.oomCounters)) mark(state, 'oom_drift');
  if (!sameModels(baseline?.residency, observation?.residency)) mark(state, 'residency_drift');
  if (!sameModels(plan?.residency, baseline?.residency)
      || !sameModels(plan?.residency, observation?.residency)) mark(state, 'residency_drift');
  const baselineObserved = parseTimestampMicros(baseline?.observedAt);
  const observationObserved = parseTimestampMicros(observation?.observedAt);
  if (baselineObserved !== null && observationObserved !== null && baselineObserved > observationObserved) {
    mark(state, 'future_observation');
  }
}

function result(phase, state, inputDigest) {
  const reasons = [...state.reasons].sort().slice(0, MAX_REASONS);
  const decision = {
    schemaVersion: SCHEMA_VERSION,
    laneId: LANE_ID,
    phase,
    offlineOnly: true,
    executionAuthorized: false,
    admit: reasons.length === 0,
    inputDigest,
    reasons,
  };
  return { ...decision, decisionDigest: makeDecisionDigest(decision) };
}

function evaluate(input, nowMicros, phase) {
  const state = { reasons: new Set() };
  if (!validClockMicros(nowMicros)) mark(state, 'clock_invalid');
  const topKeys = phase === 'admission' ? ['plan', 'protectedManifest', 'observation']
    : ['plan', 'protectedManifest', 'observation', 'baseline'];
  if (!checkObject(input, topKeys, state)) return result(phase, state, null);
  if (phase === 'restoration' && !has(input, 'baseline')) mark(state, 'baseline_missing');
  validatePlan(input.plan, state);
  validateManifest(input.protectedManifest, state);
  validateObservation(input.observation, state);
  if (phase === 'restoration' && has(input, 'baseline')) {
    const baselineState = { reasons: new Set() };
    validateObservation(input.baseline, baselineState, { baseline: true });
    if (baselineState.structuralInvalid) state.structuralInvalid = true;
    for (const reason of baselineState.reasons) mark(state, reason);
    if ([...baselineState.reasons].some((reason) => BASELINE_INVALIDATING_REASONS.has(reason))) {
      mark(state, 'baseline_invalid');
    }
    if (!isRecord(input.baseline) || !isRecord(input.baseline.oomCounters)) mark(state, 'baseline_invalid');
  }
  if (state.structuralInvalid) return result(phase, state, null);
  comparePlanBindings(input.plan, input.protectedManifest, input.observation, state);
  compareManifest(input.protectedManifest, input.observation, state);
  compareClock(input.plan, input.observation, nowMicros, state);
  if (phase === 'restoration' && isRecord(input.baseline)) {
    comparePlanBindings(input.plan, input.protectedManifest, input.baseline, state);
    compareManifest(input.protectedManifest, input.baseline, state);
    compareClock(input.plan, input.baseline, nowMicros, state);
    compareRestoration(input.plan, input.observation, input.baseline, state);
  }
  if (phase === 'admission' && isRecord(input.plan?.residency) && !sameModels(input.plan.residency, input.observation?.residency)) {
    mark(state, 'residency_drift');
  }
  const inputDigest = state.structuralInvalid ? null : safeDigest(policyInputDigest, input);
  return result(phase, state, inputDigest);
}

export function evaluateAdmission(input, nowMs) {
  const nowMicros = Number.isSafeInteger(nowMs) ? BigInt(nowMs) * 1000n : null;
  return evaluate(input, nowMicros, 'admission');
}

export function evaluateRestoration(input, nowMs) {
  const nowMicros = Number.isSafeInteger(nowMs) ? BigInt(nowMs) * 1000n : null;
  return evaluate(input, nowMicros, 'restoration');
}

export function evaluateAdmissionAtMicros(input, nowMicros) {
  return evaluate(input, nowMicros, 'admission');
}

export function evaluateRestorationAtMicros(input, nowMicros) {
  return evaluate(input, nowMicros, 'restoration');
}

export function evaluateAdmissionAtTimestamp(input, nowWireTimestampR2) {
  return evaluateAdmissionAtMicros(input, parseTimestampMicros(nowWireTimestampR2));
}

export function evaluateRestorationAtTimestamp(input, nowWireTimestampR2) {
  return evaluateRestorationAtMicros(input, parseTimestampMicros(nowWireTimestampR2));
}

/**
 * Project the nested plan/observation bindings to Brokkr's proposed flat core.
 * This is a pure shape adapter only; it authenticates nothing and is not a
 * claim that this offline contract is wire-compatible with Brokkr.
 */
export function projectWireCore(bindings) {
  const source = isRecord(bindings) ? bindings : {};
  return {
    schemaVersion: SCHEMA_VERSION,
    laneId: LANE_ID,
    requestId: source.requestId,
    attemptId: source.attemptId,
    hostId: source.hostId,
    actorUid: source.actorUid,
    requestDigest: source.requestDigest,
    artifactSha256: source.artifactSha256,
    deadline: source.deadline,
    protectedManifestDigest: source.protectedManifestDigest,
    ownerAllocationDigest: source.ownerAllocationDigest,
    firstChargedInstructionDigest: source.firstChargedInstructionDigest,
    controlPlaneAccountingDigest: source.controlPlaneAccountingDigest,
  };
}

export { LANE_ID, SCHEMA_VERSION, REASON_CODES };
