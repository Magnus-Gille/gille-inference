# Constitutional micro-routing (ADR-008 / W1)

The legacy autonomy timer remains useful for review, evidence evaluation, and standing proposals,
but is structurally shadow-only. Autonomous route writes use only the production composition in
`scripts/constitutional-routing-cli.ts`.

Production remains inert. The repository ships no live authorization, owner key, recovery private
key, protected checkpoint, kill-switch state, arming configuration, or enabled system-scope unit.
The ordinary gateway deploy does not install or enable the constitutional units.

## Authority and process split

`controller` runs under `gille-autonomy-controller`; the deadline watchdog runs under
`gille-autonomy-watchdog`; restore and demotion run under `gille-autonomy-recovery`. The three
accounts share only the narrowly required state or route-writer groups. Registration and action
use distinct systemd-owned AF_UNIX sockets, so the controller cannot invoke restore/demotion and
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

The prepared authority epoch is bound into recovery state. Rotation after prepare cannot turn an
old proposal into a cross-epoch write. Recovery authenticates the prepared signed records with its
root-owned pin and checkpoints, so later rotation cannot strand an already-written candidate.

The watchdog receives only an opaque recovery handle and two exact-receipt-bound operations:
candidate-to-preregistered-baseline restore, followed by `armed-* -> shadow` narrowing. The
recovery service accepts only the exact eligible `prepare`, `unknown`, or `revert` receipt. A live
third revision is classified as superseding state and is never overwritten. Notification is best
effort and cannot suppress restore or disarm.

## Durable state and fencing

The `journal-v1` resource is the ADR-008 journal envelope with a monotone digest-linked receipt chain. It
distinguishes prepared, applied, verified, watching, committed, unknown, reverted, disarmed, and
terminally blocked states. Controller state holds the candidate, opaque recovery handle, digests,
and prepared signed authority snapshot, but never baseline bytes. The recovery service captures
the exact baseline directly from the canonical route database and stores it only in its private
registry.

Recovery registration and the prepared journal are durable before route-table CAS. The attempt
index follows the recoverable journal, so a crash cannot consume an attempt without durable state
that the watchdog can reconcile. Missing or corrupt recovery material creates a durable target
block before parsing or clock access; no exception loop can leave a possibly active candidate
optimistically eligible.

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

The one-hour whole-operation deadline is independent of receipt cadence. The watch deadline is
five minutes earlier, leaving deterministic timer/restart jitter margin. Fresh protected liveness
is still bounded to fifteen minutes.

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
that database read-only. The recovery registry remains accessible only to
`gille-autonomy-recovery`. Missing unit conditions cleanly skip execution. Wrong-owner, writable,
malformed, oversized, stale, disarmed, or cryptographically invalid inputs fail closed.

Commands, after that ceremony, are deliberately pathless:

```bash
npm run autonomy:constitutional -- controller
npm run autonomy:constitutional -- watchdog
```

`controller` composes one immutable plan from the fixed proposal when none exists, begins it, and
on later timer activations commits only after the watch deadline. The independent watchdog
recovers at the absolute deadline.

## Fault evidence

The regression harness covers:

- real `SIGKILL` immediately after route write and before the apply receipt;
- real `SIGSTOP` after the controller's final client-side check but before its authoritative route
  transaction, route-local lease expiry and successor acquisition (with no separate claim step),
  then `SIGCONT`, with the stale controller rejected by the resource-local fence;
- observer failure during recovery;
- failed exact restore, which terminally blocks and is not retried;
- corrupt material before clock access;
- third-revision preservation;
- signer-oracle, target substitution, stale freshness, and wrong-identity refusal.

The successful process-fault cases end with exact baseline readback, signed target demotion, and
terminal disarm.
