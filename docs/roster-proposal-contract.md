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
- POST requires a real minted key in that logical rotation family.
- The durable row separately binds the actual authenticated key hash. Key rotation does not change
  logical ownership. An exact byte-identical retry after rotation returns the original immutable
  record and its original credential audit binding; a new proposal binds the new credential.
- GET is scoped to the authenticated logical principal and never provides a list operation.
- This service credential is route-scoped before generic dispatch. Even though the keystore tier is
  `owner`, it receives `403` on inference, model administration, routing reload, maintenance, key
  administration, public routes, and every surface except proposal POST and exact own-GET.

## Server-owned admission inputs

The caller supplies a complete candidate, but does not define current truth. Admission accepts one
closed, atomic `gille-roster-server-observation-v1` from the protected provider. That single
content-addressed object contains:

1. the configured catalogue;
2. the canonical backend capability;
3. the desired/servable roster (the mutation axis);
4. current artifact residency; and
5. the transient currently-running set.

`loaded` is not the mutation axis. Running state is recorded only as an observation for a future
apply-time precondition.

The object also carries its actual canonical `observed_at`, an opaque versioned
`observation_epoch`, and a digest over the complete closed shape. Admission recomputes that digest,
rejects duplicate catalogue/desired/resident/running identities, enforces desired bounds, requires
every desired entry to be resident, and requires `running ⊆ resident`. Catalogue, desired,
resident, and running arrays use canonical ordering.

Every desired and candidate entry binds the full canonical identity tuple: model, alias, artifact,
quantization, serving template, context, serving configuration, evidence identity, and immutable
restore descriptor. The one-entry delta is recomputed over that entire tuple and must equal the
declared backend operation (`load`, `unload`, or `reload-config`). Backend capability is observed
server-side and must exactly equal the implementation-owned canonical capability recomputed from
backend, operations, alias control, and context control. A self-consistent digest over a widened
capability does not authorize it.

Restore descriptors are content-addressed opaque references resolved through a server-owned
registry. Canary requests similarly name a server-owned registry entry/version whose digest binds
route, configuration, verifier, and postconditions. Caller-chosen route or verifier material is not
accepted.

Admission verifies evidence, template identities, restore descriptors, and canary definitions as
content-addressed data while the final observation fence is held. Returned identities must match
their requested values and their canonical recomputations; evidence first/last metadata must be
canonical and monotone. Every prior desired entry must still be resident and have an exactly
resolvable restore descriptor before a reload or removal can arm.

Immediately before persistence, gille-inference calls
`withServerObservationFence(expectedToken, syncCallback)`. The provider must hold the same local
roster-state lock or lease honored by every catalogue/backend/desired/resident/running mutator while
it confirms the exact epoch+digest and synchronously invokes the callback. Gille rejects invalid,
changed, missing, asynchronous, escaped, zero-call, or multiple-call fence behavior; the SQLite
transaction rolls back any tentative arm on a fence protocol failure. The callback performs
content-addressed registry/evidence validation, the final protected-clock/expiry check, and the
SQLite decision transaction before the provider releases the lock.

## Deliberately unavailable by default

Production admission currently rejects with `ROSTER_OBSERVER_UNAVAILABLE`. The default registry
and fence seams are empty because gille-inference does not yet have a genuine atomic roster
observer, common mutator lock, server-observed template identity source, immutable
restore-descriptor resolver, or canary registry.
The implementation does not derive a template identity from a per-request rendered prompt and does
not fabricate private restore locators.

The injectable seams exist so the cross-repository contract and fail-closed behavior can land
before those private server-owned registries. Enabling production admission requires the separately
reviewed #113 follow-up to supply the atomic observer, all registries, and the common lock used by
both the observation fence and all five-state mutators.

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
UTC strings remain signed/display fields. The durable baseline preserves the provider's actual
observation timestamp, epoch, and digest. A separate immutable `decisionAt` records the final
protected-clock sample taken inside the fence/SQLite transaction; later lifecycle updates change
`updatedAt`, not `decisionAt`. Every insert, retry, scoped read, and expiry validates the
closed record: proposal/candidate/baseline/admission digests, mirrored columns, credential binding,
normalized delta, state/reason legality, and lifecycle-event tail. Any mismatch is treated as
durable corruption and fails closed.

An `armed` record is authorization data for a future actuator, not an applied change. This version
contains no actuator route. W5b must reuse the same provider fence and revalidate the persisted
observation epoch+digest plus content-addressed identities before any mutation.

## Cross-repository sequencing

`tests/fixtures/gille-roster-proposal-v1-seed.json` is a gille-owned seed/interchange example. It is
not output from a real Hugin serializer and is not cross-repository compatibility evidence. Grimnir
issue #108 remains open until this schema merges, Hugin implements the producer, and
gille-inference consumes Hugin's byte-pinned positive and adversarial fixtures.
