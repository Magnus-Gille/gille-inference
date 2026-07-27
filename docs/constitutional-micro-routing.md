# Constitutional micro-routing (ADR-008 / W1)

The legacy autonomy timer remains useful for review, evidence evaluation, and standing proposals,
but is structurally shadow-only: its composition always supplies an active kill switch before the
legacy actuation loop. Autonomous route writes use only
`scripts/constitutional-routing-cli.ts`.

- The legacy autonomy timer evaluates in shadow mode and cannot actuate an autonomous route.
- The independent constitutional watchdog checks in-flight work every 60 seconds.
- Production remains inert until the owner installs protected authority configuration, a recovery
  signing helper, and separately arms the exact micro-routing target.

The repository intentionally contains no live authorization, owner key, recovery private key,
protected checkpoint, kill-switch state, or arming configuration.

## Authority and process split

`begin` and `commit` run as the controller identity. They can compare-and-swap the route table from
the journaled baseline to the exact candidate, but they do not receive a recovery signing
capability. Before both apply and commit they re-read:

- the owner-signed authorization and independently pinned public key;
- the protected authorization and runtime-narrowing checkpoints;
- the exact owner-controlled coverage binding and five distinct identities;
- kill-switch state, current config/evidence/policy/postcondition digests, trusted time, and
  liveness.

The prepared authority epoch is bound into the recovery descriptor. Rotation after prepare cannot
silently turn an old proposal into a cross-epoch write, while a recovery worker can still validate
the immutable prepared epoch and restore its baseline.

The watchdog is a separate oneshot process driven by
`gille-constitutional-watchdog.timer`. It receives only:

1. the pre-registered baseline bound by the journal;
2. a restore operation constrained to that baseline; and
3. an owner-installed helper that signs an `armed-* -> shadow` runtime-narrowing entry.

Notification is best effort and runs only after recovery state is durable. It cannot suppress
restore or disarm.

## Durable state

The authoritative `journal-v1.json` is an exact ADR-008 journal envelope with a monotone,
digest-linked receipt chain. It distinguishes prepared, applied, verified, watching, committed,
unknown, reverted, disarmed, and terminally-blocked state. A mode-0600 sidecar holds the exact
baseline and candidate bytes needed for R-exact recovery; its digests and prepared authority
snapshot are checked against the journal before use.

Recovery bytes and the prepared journal are durable before the route-table CAS. The attempt index
is written only after the recoverable journal, so a crash cannot consume an attempt without leaving
state the watchdog can reconcile.

Any unknown state, deadline, silence bound, kill switch, invariant failure, or restore failure
causes recovery or terminal blocking. A local target block is persisted before recovery. If signed
demotion cannot be completed, that block remains authoritative for future admission; no optimistic
retry or re-arm occurs.

## Owner-installed configuration

The watchdog service reads `%h/.config/gille-inference/autonomy.env`. A future arming ceremony must
install both that file and the independently fixed
`%h/.config/gille-inference/authority-config.json`, then set:

```text
GILLE_AUTONOMY_DATA_DIR=/absolute/persistent/data
GILLE_AUTONOMY_TABLE_PATH=/absolute/live/m5-routing.json
```

The closed authority config names absolute, service-account-owned, non-group/world-writable files
for authorization, constitution, coverage, owner attestations, recovery registry, pinned owner
public key, both protected checkpoints, kill switch, liveness, current digests, verifier binary,
recovery-signer binary, and protected clock-health record. Missing, malformed, writable, oversized, stale, disarmed, or
cryptographically invalid inputs fail closed.

Deploy installs and enables the timer, but both owner-installed files are systemd conditions. A
disarmed installation is therefore cleanly skipped rather than failing every minute. Arming is an
owner ceremony: install the fixed config and environment atomically with restrictive ownership and
modes, run one manual `watchdog` status check, then `systemctl --user start
gille-constitutional-watchdog.service`. Removing either file cleanly disarms subsequent timer runs.

Commands:

```bash
npm run autonomy:constitutional -- begin --data-dir /absolute/path --table /absolute/path --plan /absolute/plan.json
npm run autonomy:constitutional -- commit --data-dir /absolute/path --table /absolute/path
npm run autonomy:constitutional -- watchdog --data-dir /absolute/path --table /absolute/path
```

`begin` requires a content-blind, exact-digest-bound verifier proof and leaves the operation in
`watch`. `commit` consumes the persisted plan and recovery material rather than accepting new
candidate decisions from its caller.

## Fault evidence

The test harness uses real child processes:

- `SIGKILL` immediately after the external route write and before the apply receipt;
- `SIGSTOP` after entering the watch phase while a separate watchdog passes the absolute deadline;
- notification failure during recovery;
- failed exact restore, which terminally blocks and is not retried;
- concurrent attempts, stale liveness, kill switch, and invalid authority refusal.

Both process faults end in exact baseline readback, signed target demotion, and terminal disarm in
the successful recovery case.
