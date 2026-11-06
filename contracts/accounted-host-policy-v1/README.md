# Accounted host policy v1

This directory defines the offline structural contract for lane
`accounted-podman-info-v1`. It is a compatibility checker, not an authenticator,
host probe, launcher, or cleanup controller.

## Canonical shape

`schemas/accounted-host-policy-v1.schema.json` is the versioned structural schema.
The implementation in `accounted-host-policy.mjs` accepts these exact objects:

- `plan`: `schemaVersion`, `laneId`, the eleven-field `bindings` object,
  `ownerAllocation`, whole-task `coverage`, `controlPlaneAccounting`, fixed
  `controls`, positive `observationMaxAgeMs`, and preserved `residency`.
- `protectedManifest`: `schemaVersion`, `laneId`, `digest`, fixed `services`
  (`unit`, `active`, `invocationId`, `restarts`), and `oomCounters` (`host` and
  per-service `kills`), plus the matching preserved `residency` set.
- `observation`: the plan bindings and allocation/coverage/accounting/controls,
  an `observedAt` timestamp, gateway/backend activity, maintenance state,
  protected service identities and restart counts, residency models, and OOM
  counters.
- restoration additionally requires `baseline`, which has the observation shape.

The owner allocation is explicit (`chargedMemoryMaxBytes`, `swapMaxBytes`,
`cpuQuotaMicros`, `cpuPeriodMicros`, `tasksMax`, `addressSpaceLimitBytes`, and
its digest). These are integer limits; `swapMaxBytes` may be zero. There are no
implicit resource defaults. Whole-task coverage must be complete before first work, and
control-plane accounting must be explicitly complete for the whole task.
Controls must state `gpuAccess: false`, `payloadIpNetwork: false`, and
`localIpcDefined: true`. Unknown, stale, future, expired, busy, conflicting,
or drifted evidence fails closed.

Deadlines and observation timestamps are exactly UTC
`YYYY-MM-DDTHH:mm:ss.ffffffZ` in Gregorian years 0001–9999; missing/non-six-digit fractions and offsets are not accepted. The
injected `nowMs` remains an integer runtime clock value, and comparisons retain
all six fractional digits as integer microseconds.

The JSON schema's timestamp pattern constrains the field ranges; the runtime
also performs canonical calendar validation, so impossible dates such as
February 30 are refused. Runtime validation additionally requires the OOM
counter unit set to match the protected-service unit set exactly once each;
that cross-array relationship cannot be expressed by this JSON schema alone.

## Deterministic evidence digests

The pure SHA-256 helpers canonicalize JSON with recursively sorted object keys,
compact separators, UTF-8 text without ASCII escaping, and safe integer-only
numbers. There is no trailing newline in the canonical body. The domain prefixes
are fixed and include a newline:

- `gille-inference/accounted/protected-manifest/v1` — manifest body excluding
  only its own `digest`, including its protected residency set.
- `gille-inference/accounted/owner-allocation/v1` — allocation body excluding
  only its own `digest`.
- `gille-inference/accounted/control-plane-accounting/v1` — accounting body
  excluding only its own `digest`.
- `gille-inference/accounted/policy-input/v1` — a structurally valid input.
- `gille-inference/accounted/policy-decision/v1` — result body excluding only
  `decisionDigest`; that body includes `inputDigest`, so the decision hash is
  acyclic and binds the exact evidence fingerprint.

The checker recomputes the first three evidence digests and rejects labels that
do not match their bodies. These hashes do not authenticate receipts or prove
that the declared capacity exists.

`inputDigest` is null whenever structural validation finds malformed types,
unknown/missing fields, invalid timestamps, or other schema-shape errors. A
well-shaped input that is refused for policy reasons (for example, busy work)
may still receive an input digest. `decisionDigest` is always a bounded
decision fingerprint and never grants authority.

## API and result

```js
import { evaluateAdmission, evaluateRestoration } from './accounted-host-policy.mjs';

const admission = evaluateAdmission({ plan, protectedManifest, observation }, nowMs);
const restoration = evaluateRestoration(
  { plan, protectedManifest, observation, baseline },
  nowMs,
);

// Exact-R2 wire-clock callback forms:
const atWireTime = evaluateAdmissionAtTimestamp(input, nowWireTimestampR2);
const atExactMicros = evaluateAdmissionAtMicros(input, nowMicros);
```

`nowMs` is injected so evaluation is deterministic. The backward-compatible
`nowMs` forms cannot represent a sub-millisecond current clock. Callback code
that receives the exact R2 wire timestamp should use
`evaluateAdmissionAtTimestamp`/`evaluateRestorationAtTimestamp`; code that
already has an integer clock should use the corresponding `AtMicros` form with
a `bigint`. All forms share the exact microsecond core and reject invalid
clocks with a bounded `clock_invalid` result. All evaluators are pure:
they do not read files, inspect processes, use the network, or authenticate
input. Results contain only fixed fields and bounded sorted reason codes:

```json
{
  "schemaVersion": 1,
  "laneId": "accounted-podman-info-v1",
  "phase": "admission",
  "offlineOnly": true,
  "executionAuthorized": false,
  "admit": false,
  "inputDigest": null,
  "reasons": ["observation_stale"],
  "decisionDigest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}
```

`executionAuthorized` is always false, including when `admit` is true. The
positive result means only that the supplied values are structurally and
policy-compatible for this offline check. It does not prove that a service is
installed, available, running, isolated, or safe to restart.

## Proposed flat-core projection

The plan and observation retain nested `bindings` for this contract. The pure
`projectWireCore(bindings)` adapter exports the exact proposed flat core shape:

`schemaVersion`, `laneId`, `requestId`, `attemptId`, `hostId`, `actorUid`,
`requestDigest`, `artifactSha256`, `deadline`, `protectedManifestDigest`,
`ownerAllocationDigest`, `firstChargedInstructionDigest`, and
`controlPlaneAccountingDigest`.

The `wireCoreProjection` schema definition documents that shape. This is an
explicit projection only; it does not claim wire compatibility with Brokkr,
authenticate the values, or authorize execution.

## Required external proof boundary

An owning actuator must perform a separate trusted owner-receipt verification
before using this result. That verifier must bind the request, attempt, host,
artifact, actor UID 1000, deadline, protected-manifest digest, owner-allocation
digest, first-charged-instruction digest, and control-plane-accounting digest.
The host adapter must independently prove the current allocation, complete
whole-task coverage, explicit control-plane accounting, fixed protected-service
inventory and identities, current activity/maintenance state, residency, and
OOM counters. A launcher and cleanup controller must separately prove bounded
start, restoration, and cleanup behavior, including refusal on protected
inventory or identity/restart/OOM/residency drift.

This contract deliberately does not implement those trusted transport,
authentication, host-adapter, launcher, or cleanup proofs.

## Synthetic examples

`examples/` contains content-free fixture inputs and results, including a
positive admission, a negative admission, and manifest digests. Fixture host
and service identifiers are deliberately synthetic and do not describe a
real inventory or allocation.

## Checks

The synthetic suite is dependency-free:

```bash
node --test contracts/accounted-host-policy-v1/tests/accounted-host-policy.mjs
node --check contracts/accounted-host-policy-v1/accounted-host-policy.mjs
```

Shared wire request/attempt IDs are lowercase UUIDs, and host IDs match `[a-z][a-z0-9-]{0,62}`. JSON Schema string lengths count Unicode code points. The schema includes date-time format validation; consumers must enable format assertion, while the runtime always validates calendar dates.
