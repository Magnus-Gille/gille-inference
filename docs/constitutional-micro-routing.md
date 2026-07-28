# Constitutional micro-routing (ADR-008 / W1)

W1 consumes the complete ADR-008 v2 bundle pinned at merged Grimnir revision
`16edee0a5a0111f0142569f5b0cf2f90e807060c`. The canonical constitution digest is
`sha256:836aba8abbc48e05294dac301354ec6b1aa21307b992db78202342ce29aa8dc1`; the
checked-in disarmed production coverage digest is
`sha256:b7303c8f02b03b7330a0fc49cd685428a28ddd2d6306e0c47a7fd24e5c0c3cbd`.
Constitution, coverage, journal schemas, conformance fixtures, and provenance live under
`contracts/grimnir-autonomy-v2/`. Owner authorization, recovery-worker authorization, and runtime
narrowing intentionally retain their shared v1 envelopes. The frozen v1 bundle remains available
only for historical validation. It was never deployed as a W1 recovery protocol, so the privileged
recovery service accepts journal-v2 only; this avoids ambiguous v1/v2 epoch dispatch.

The legacy autonomy timer remains useful for review, evidence evaluation, and standing proposals,
but is structurally shadow-only. Autonomous route writes use only the production composition in
`scripts/constitutional-routing-cli.ts`.

Production remains inert. The repository ships no live authorization, owner key, recovery private
key, protected checkpoint, kill-switch state, arming configuration, or enabled system-scope unit.
The ordinary gateway deploy does not install or enable the constitutional units.

## Authority and process split

`controller` runs under `gille-autonomy-controller`; the deadline watchdog runs under
`gille-autonomy-watchdog`; restore and demotion run under `gille-autonomy-recovery`. The three
accounts share only the narrowly required state group. Only the recovery identity has route-writer
filesystem access. Registration and action use distinct systemd-owned AF_UNIX sockets: the
controller can request only an authenticated preregistered candidate CAS, while the watchdog can
request only block, exact restore, and demotion. The controller cannot invoke restore/demotion and
the watchdog cannot register arbitrary baselines.

All authority inputs, including the owner public-key pin and both anti-rollback checkpoints, are
root-owned, non-writable regular files below `/etc/gille-inference/autonomy`. `ProtectSystem`,
`ReadOnlyPaths`, distinct UIDs, and explicit root-ownership checks keep them outside controller,
watchdog, and recovery write authority.

Before apply and commit, the controller re-reads:

- owner-signed authorization and the independently pinned public key;
- authorization and runtime-narrowing checkpoints;
- the exact owner-controlled coverage binding and five distinct identities;
- kill-switch state, config/evidence/policy/postcondition digests, trusted time, and liveness.

The prepared authority epoch is bound into the recovery service's private registration record
after it authenticates the prepared journal against the then-current root-owned pin and
checkpoints. Rotation after prepare cannot turn an old proposal into a cross-epoch write, and
recovery validates later unknown/revert receipts against that retained authenticated epoch rather
than substituting newer pins or checkpoints that could strand an already-written candidate.

The watchdog receives only an opaque recovery handle and two exact-receipt-bound operations:
candidate-to-preregistered-baseline restore, followed by `armed-* -> shadow` narrowing. The
recovery service accepts only the exact eligible `prepare`, `unknown`, or `revert` receipt. A live
third revision is classified as superseding state and is never overwritten. Notification is best
effort and cannot suppress restore or disarm. Only a `watch` receipt may remain active between
watchdog passes. An interrupted `prepare`, `apply`, or `verify` receipt is reconciled immediately,
including when the candidate CAS succeeded but its socket response was lost.

## Durable state and fencing

The `journal-v2` resource is the ADR-008 journal envelope with a monotone digest-linked receipt chain. It
distinguishes prepared, applied, verified, watching, committed, unknown, reverted, disarmed, and
terminally blocked states. Controller state holds the candidate, opaque recovery handle, digests,
and prepared signed authority snapshot, but never baseline bytes. The recovery service captures
the exact baseline directly from the canonical route database and stores it only in its private
registry.

Recovery registration and the prepared journal are durable before route-table CAS. Preregistration
authenticates the prepared journal before the controller can persist the returned opaque handle in
recovery material; every later privileged journal read requires that material. The attempt
index follows the recoverable journal, so a crash cannot consume an attempt without durable state
that the watchdog can reconcile. Missing or corrupt recovery material creates both a durable state
record and an unowned resource-local serving block before clock access. Because that guard cannot
be authenticated to an exact journal owner, no watchdog pass may clear it automatically; owner
intervention is required even if controller-owned material is later repaired. The gateway treats
a blocked route database as FRONTIER, so no exception loop can leave a possibly active candidate
optimistically eligible.

The candidate CAS also persists its exact journal, attempt, binding, target, candidate digest,
and absolute `not_after` deadline in that same fenced route-database transaction. The serving
reader independently returns FRONTIER at the deadline even if the watchdog, recovery service, or
their socket is unavailable; a reboot without a continuous monotonic anchor also fails closed
rather than trusting a rolled-back RTC. Exact revert clears this record atomically with baseline
restore. Exact commit first persists its terminal receipt, then clears it through a fenced,
idempotent reconciliation that the watchdog can repeat after a crash.

The writer mutex is an expiring monotonic fenced lease. Each acquisition advances a durable epoch,
mints an unguessable token, and records the boot ID. Journal/state writes compare the state lease
in the same SQLite transaction that mutates the authoritative state resource. The route database
holds its own effect-authoritative lease beside the route value, and route CAS compares that lease
inside the same `BEGIN IMMEDIATE` transaction as the value mutation. Controller takeover acquires
the route lease before the state lease. Watchdog takeover asks the restore-only recovery service to
acquire and hold that route-local lease before the watchdog advances state; the watchdog never
gains route filesystem access. Thus there is no state-acquisition-to-route-claim gap. No database
transaction is held around caller code, so a `SIGSTOP`ed process cannot pin recovery. A resumed
stale controller is rejected by the resource transaction even when it was stopped after its final
client-side check. If a watchdog dies without releasing its recovery-service session, a new
acquisition is refused while the lease is current and advances to a new epoch after expiry.

The immutable attempt deadline is at most 4200 seconds after the durable `prepare` receipt. Apply,
candidate readback, verifier success, and the durable `watch` receipt must complete within the
first 300 seconds. That persisted watch receipt—not a precomputed plan timestamp—anchors at least
3600 seconds of observation. Commit then has at most 300 seconds of grace and must also remain
within the attempt deadline. Only `watch` may wait between timer activations; interrupted
`prepare`, `apply`, or `verify`, a missed commit grace, and an exceeded total deadline all enter
recovery. The 900-second maximum silence is an independently advancing liveness heartbeat, not a
synthetic journal phase or receipt cadence. Every watchdog pass rechecks protected liveness,
current digests, the prepared authority epoch, and the independently bound candidate proof.
`maxAttempts` is the durable lifetime allowance in the attempt index; `maxAttemptsPerWindow` is a
separate rolling rate limit. Neither resets the other.

## Owner-installed configuration

A separate explicit root ceremony must create the service accounts/groups, state directories,
socket units, services, and timers, then install:

- `/etc/gille-inference/autonomy/autonomy.env`;
- `/etc/gille-inference/autonomy/authority-config.json`, conforming to
  `deploy/constitutional-authority-config-v1.schema.json`;
- `/etc/gille-inference/autonomy/recovery-config.json`, conforming to
  `deploy/constitutional-recovery-config-v1.schema.json`; and
- every referenced authority record, public pin, checkpoint, freshness record, verifier, and
  recovery signer below the protected root.

The owner-supplied recovery signer is an arming prerequisite, not an optional notification hook.
It must sign and durably persist the narrowed ledger plus protected checkpoint before returning
them. This repository deliberately ships neither that helper nor its key. If the closed recovery
config, root-owned executable, or persistence implementation is absent, the recovery service
cannot start, preregistration fails before route apply, and production W1 remains unarmed. The
systemd socket units may exist before their service is ready, but the recovery process performs no
operation and accepts no request until it has required a bounded root-owned regular executable and
sent the non-mutating closed readiness request
`{"kind":"constitutional-recovery-signer-readiness","schema_version":1}`; the only accepted response
is `{"kind":"constitutional-recovery-signer-readiness","schema_version":1,"ready":true}`. After a
demotion call, the watchdog independently rereads the protected ledger, registry, and checkpoint.
It keeps both target blocks in place unless those durable bytes match the helper response, validate
under the current protected owner authorization, and end at the exact recovery receipt and target.

Targets are compiled and schema-fixed. Flags and environment variables cannot substitute them:

```text
state:      /var/lib/gille-inference/autonomy
proposal:   /var/lib/gille-inference/proposals/micro-routing.json
plan:       /var/lib/gille-inference/autonomy/immutable-plan.json
route:      /var/lib/gille-inference/routing/m5-routing.db
recovery:   /var/lib/gille-inference/autonomy-recovery
```

The owner ceremony must provision the shared state directory for `gille-autonomy-state`, the
dedicated route directory for `gille-routing-writers`, initialize `m5-routing.db` from the current
reviewed JSON route bytes, and set the live gateway's
`HOMESERVER_ROUTING_TABLE_PATH=/var/lib/gille-inference/routing/m5-routing.db`. The gateway opens
that database read-only, including its SQLite WAL view. The database and sibling `-wal`/`-shm`
files live under `/var/lib`, outside the ordinary gateway rsync payload; the deploy also excludes
all SQLite database/WAL patterns defensively. The recovery registry remains accessible only to
`gille-autonomy-recovery`. Missing unit conditions cleanly skip execution. Wrong-owner, writable,
malformed, oversized, stale, disarmed, or cryptographically invalid inputs fail closed.

Commands, after that ceremony, are deliberately pathless:

```bash
npm run autonomy:constitutional -- controller
npm run autonomy:constitutional -- watchdog
```

`controller` composes one immutable plan from the fixed proposal when none exists, begins it, and
on later timer activations commits only after 3600 seconds measured from the durable watch
receipt. The independent watchdog recovers after missed commit grace, total deadline, kill switch,
or failed protected watch gate.

## Fault evidence

The regression harness covers:

- real `SIGKILL` immediately after route write and before the apply receipt;
- real `SIGSTOP` after the controller's final client-side check but before its authoritative route
  transaction, route-local lease expiry and successor acquisition (with no separate claim step),
  then `SIGCONT`, with the stale controller rejected by the resource-local fence;
- observer failure during recovery;
- failed exact restore, which terminally blocks and is not retried;
- corrupt material before clock access;
- live serving fallback while the resource-local block is set;
- protected-authority rotation after prepare and response-loss replay under a successor fence;
- the production curl/AF_UNIX controller and watchdog clients, including apply-response loss;
- stale liveness or failed proof during the active watch window;
- third-revision preservation;
- signer-oracle, target substitution, stale freshness, and wrong-identity refusal.

The successful process-fault cases end with exact baseline readback, signed target demotion, and
terminal disarm.
