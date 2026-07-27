# Roster proposal admission v1

`POST /v1/roster-proposals` is a content-blind, authenticated admission surface for Hugin. It
validates and durably records one bounded proposal for the `served-model-roster` axis. It has no
apply, re-arm, widening, routing, model-admin, download, deploy, restart, or configuration-writing
operation.

The exact wire schema and durable validator live in
`src/homeserver/roster-proposal.ts`. The contract version is
`gille-roster-proposal-v1`; unknown fields and non-canonical timestamps are rejected.

## Authority and identity

- The stable logical owner is `service:hugin`.
- POST requires a real minted owner key with that alias.
- The durable row separately binds the actual authenticated key hash. Key rotation does not change
  logical ownership, but a retry using a different key is a conflict rather than an exact retry.
- GET is scoped to the authenticated logical principal and never provides a list operation.

## Server-owned admission inputs

The caller supplies a complete candidate, but does not define current truth. Admission reads
separate server-owned observations for:

1. the configured catalogue;
2. the desired/servable roster (the mutation axis);
3. current artifact residency; and
4. the transient currently-running set.

`loaded` is not the mutation axis. Running state is recorded only as an observation for a future
apply-time precondition.

Every desired and candidate entry binds the full canonical identity tuple: model, alias, artifact,
quantization, serving template, context, serving configuration, evidence identity, and immutable
restore descriptor. The one-entry delta is recomputed over that entire tuple and must equal the
declared backend operation (`load`, `unload`, or `reload-config`). Backend capability is observed
server-side; unsupported combinations fail closed.

Restore descriptors are content-addressed opaque references resolved through a server-owned
registry. Canary requests similarly name a server-owned registry entry/version whose digest binds
route, configuration, verifier, and postconditions. Caller-chosen route or verifier material is not
accepted.

## Deliberately unavailable by default

Production admission currently rejects with `ROSTER_OBSERVER_UNAVAILABLE`. The default registry
seams are empty because gille-inference does not yet have a genuine server-observed template
identity source, immutable restore-descriptor resolver, desired-roster observer, or canary registry.
The implementation does not derive a template identity from a per-request rendered prompt and does
not fabricate private restore locators.

The injectable seams exist so the cross-repository contract and fail-closed behavior can land
before those private server-owned registries. Enabling production admission requires a separately
reviewed follow-up that supplies all observers and registries together.

`startGateway({ rosterAdmissionDependencies })` is the supported composition boundary for that
provider. A protected local deployment wrapper can inject the adapter from outside the repository;
only opaque refs, digests, and normalized observations cross the boundary. Private paths, locators,
template contents, and registry material must remain inside the provider and must not be written to
proposal rows, logs, environment dumps, or Git. Omitting the provider preserves the fail-closed
default.

## Durability and lifecycle

Rows move transactionally through:

`submitted → rejected`, or `submitted → accepted → armed → expired`.

Only one proposal may be armed for the axis. Expiration uses integer epoch milliseconds; canonical
UTC strings remain signed/display fields. Every insert, retry, scoped read, and expiry validates the
closed record: proposal/candidate/baseline/admission digests, mirrored columns, credential binding,
normalized delta, state/reason legality, and lifecycle-event tail. Any mismatch is treated as
durable corruption and fails closed.

An `armed` record is authorization data for a future actuator, not an applied change. This version
contains no actuator route.
