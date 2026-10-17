# llama-swap backend executable upgrade

This runbook covers a generic, operator-approved replacement of the `llama-swap`
backend executable. It is separate from the source-tree deployment performed by
`scripts/deploy-gateway.sh`; the gateway deploy script must not be used as a
backend installer and this runbook does not change the gateway release.

The candidate currently under assessment is llama-swap **v242**, from upstream
source commit `7aa7f52074d0aee99f9d1de8cea9cafb21289b67`. The artifact is the
[upstream v242 release](https://github.com/mostlygeek/llama-swap/releases/tag/v242)
(`linuxamd64`); its archive must have SHA-256
`ab33ed4e98e1325e870742c6741fd178b55cda034f5639d7541dd99fa19fc185`; the
extracted executable must have SHA-256
`393edbd01da1d1b474712c1fcf5a0e00905eb11c7b46462698ccfe746a3195d2`.
These identities describe a candidate under assessment. They are not a
deployment record or a claim that v242 is live.

## Scope and stop conditions

The change is limited to the bytes of the selected backend executable and the
service stop/start needed to replace and verify those bytes. It must not alter:

- the llama-swap roster or configuration;
- gateway source, gateway configuration, MCP configuration, credentials, or
  environment files;
- systemd unit files, drop-ins, isolation policy, users, groups, devices, or
  mount policy; or
- model files, runtime libraries, databases, logs, or routing decisions.

No generic installer is implied by this document. Use the reviewed operator
procedure and private deployment record for the concrete paths and commands.

The gateway's [`ActiveWindow`](../src/homeserver/maintenance-window.ts) is
process-local state. Do not assume a maintenance window survives a gateway
restart or authorizes a backend restart that propagates into the gateway; the
full affected service scope still needs its own exact approval and bounded
drain.

Stop and obtain a new decision if the candidate, archive, extracted executable,
live path, service identity, dependency graph, or baseline state differs from
the approved record. Refuse the operation when there is active model residency,
an active request or other unknown work, an unknown dependency or propagation
edge, or any requested scope expansion. The backend normally runs during
preflight; record its loaded identity and process identity, then require that
the approved apply plan includes a process check before replacement. Do not
infer that a clean Git merge means that a backend is
deployed, or that discovery, a synthetic readiness probe, or a reload proves
organic model use or adoption.

## Compatibility gate

Before approval, inspect the actual live configuration and any integration
surfaces that select or observe llama-swap. Do not use a stale public config
mirror as live configuration or overwrite live configuration from that mirror.
Check the selected compatibility facts without printing configuration values,
environment values, credentials, or other secrets:

- v242 rejects legacy profile-list formats; reject the candidate if the live
  configuration still depends on one.
- v242 removes `/api/metrics` and changes events, performance, and peer IDs;
  reject or separately assess any integration that depends on those surfaces.
- The tracked gateway does not use those removed or changed surfaces, but this
  must be verified against the live configuration and integrations before
  approval, using redacted keys, shapes, statuses, or exit codes only.

## Preflight: inventory dependencies and derive restart scope

Before asking for deployment approval, identify the actual executable and build
an impact inventory from the effective systemd dependency graph. Inspect the
unit and every transitive dependent, including reverse dependencies. Do not
dump a unit file or raw command line into the record; use selected, content-blind
properties and a reviewed redaction that retains only executable-path/argument
shape metadata while removing environment values, keys, tokens, passwords,
secrets, and private URLs:

```bash
systemctl show llama-swap.service \
  --property=Id,FragmentPath,DropInPaths,Requires,Requisite,Wants,PartOf,BindsTo,After,Before,Conflicts,PropagatesStopTo,StopPropagatedFrom,ActiveState,SubState,Result,ExecMainCode,ExecMainStatus,UnitFileState,MainPID,ControlPID,ControlGroup
systemctl list-dependencies --all llama-swap.service
systemctl list-dependencies --all --reverse llama-swap.service
```

Resolve the executable from `ExecStart` through a reviewed local redactor that
emits only the executable path and argument-shape metadata; never record the
raw `ExecStart` serialization or environment values. The following command
captures the property inside a Python subprocess and prints only `path=...`;
run it once for each unit and fail closed if the path is absent or ambiguous:

```bash
UNIT=llama-swap.service
python3 - "$UNIT" <<'PY'
import re
import subprocess
import sys

unit = sys.argv[1]
try:
    result = subprocess.run(
        ["systemctl", "show", unit, "-p", "ExecStart", "--value"],
        check=True,
        capture_output=True,
        text=True,
        timeout=10,
    )
except (OSError, subprocess.SubprocessError):
    raise SystemExit("refusing: could not inspect ExecStart")

paths = re.findall(r"(?:^|[;{\s])path=([^;\s}]+)", result.stdout)
if len(paths) != 1:
    raise SystemExit("refusing: ExecStart path absent or ambiguous")
print(f"path={paths[0]}")
PY
```

Do not add a command that prints the captured property, raw arguments, or
environment. Record only the returned path, separately reviewed argument-shape
metadata, and the current process/executable identity.

For each unit in the impact inventory, inspect the same relationship properties
and record its identity, `ActiveState`, `SubState`, `Result`,
`ExecMainCode`, `ExecMainStatus`, `UnitFileState`, `MainPID`, `ControlPID`,
`ControlGroup`, and relevant start/stop propagation. Record these properties as
reported by systemd: a wrapper exit status and a process killed by a signal can
produce different tuples; do not derive the tuple from a shell convention.
Include gateway, MCP-serving, tunnel,
socket, and other dependent units when the graph reaches them. Then derive the
precise stop/restart propagation set from effective `Requires`, `PartOf`,
`BindsTo`, and propagation edges. `After`, `Before`, `Wants`, network targets,
and tunnel units are ordering or availability context unless an actual
propagation edge or explicit approved dependency makes them part of the
mutation. Preserve those units when they are not in the precise set. A plan
that treats the whole dependency inventory as the stop scope is unsafe; a plan
that names only `llama-swap.service` is incomplete when propagation reaches
other services.

Capture the baseline before any stop or file mutation. Keep observations
content-blind: unit state, process identity, status code, timing, and aggregate
resident/not-resident state are sufficient. Do not copy prompts, responses,
bearer values, model request bodies, or high-cardinality user labels into the
record. If the baseline contains work that cannot be identified and bounded,
refuse the change.

Confirm all of the following before approval:

1. The backend has no resident model and no in-flight request, or the approved
   maintenance procedure has a separately recorded, bounded drain that proves
   the same condition.
2. The naturally running backend's loaded identity, resolved executable path,
   current `MainPID`, and `/proc/<pid>/exe` are recorded. The approval includes
   a process check before replacement and a refusal condition for any
   old-binary process; do not overwrite a running executable.
3. The original executable, its owner, mode, size, device, inode, and SHA-256
   are recorded. The planned backup destination is on the same filesystem, and
   its expected identity is the recorded original; creating and verifying the
   backup is an approved apply step before stopping or replacing anything.
4. The candidate source, archive, and extracted executable match the pinned
   identities in the release record.
5. The dependency impact inventory, precise stop/restart propagation set,
   expected temporary outage (including MCP transport interruption), baseline
   states, approved stop-result and cgroup predicate, bounded post-start
   readiness deadline, verification probes, and rollback target are written
   into the private operator record.

## Artifact and replacement contract

Verify the release inputs before installation. A source checkout must resolve to
`7aa7f52074d0aee99f9d1de8cea9cafb21289b67`; the downloaded official archive and
the extracted executable must match the SHA-256 values above. Record the
commands and resulting digests, without recording credentials or private URLs.
Do not substitute a mirror, a different archive, a rebuilt executable, or an
unreviewed platform artifact without a new assessment.

After the exact approval and before stopping the service or replacing the live
file, create the original backup on the same filesystem as the live executable.
Then verify that the backup's SHA-256, byte size, owner, and mode match the
recorded original, and record the verified identity in the private deployment
record. Keep the backup immutable for the duration of the change. A backup that
does not byte-for-byte identify the original is a hard stop; do not proceed to
stop or replace anything.

After the backup is verified, stage the candidate beside the live executable on
that same filesystem. Apply the original owner and mode to the staged file,
verify them, then atomically
rename the staged file into the live path only after the precise approved stop
set is stopped and no process still executes the old path. Do not write through
or truncate the live executable. Preserve its path and service identity; do not
introduce an alternative serving process or path, alter symlink targets, or
change runpaths and runtime dependencies as part of this upgrade.

## Just-in-time approval gate

The operator must obtain exact, just-in-time approval immediately before the
first stop or file mutation. The approval names:

- the pinned source commit, archive digest, executable digest, live executable
  path, and planned same-filesystem backup path with its expected identity
  (the recorded original digest and metadata; the backup is created and
  verified during the approved apply step);
- the dependency impact inventory, the precise stop/restart propagation set,
  and each affected unit's baseline state;
- the allowed mutation (same-filesystem atomic executable replacement plus the
  necessary stop/start), expected MCP interruption, verification commands, and
  the expiry or count limit; and
- the planned rollback backup path and expected identity, rollback trigger, and
  rollback procedure. This approval may preauthorize rollback when the trigger
  and scope are exact; if it does, a second confirmation is not required while
  those conditions hold.

Approval does not cover roster/configuration edits, credential changes,
isolation changes, gateway source deploys, model operations, or an expanded
dependency closure. Any such need requires a new approval and a new runbook.

## Apply and verify

Using the approved operator procedure:

1. Recheck the baseline, dependency impact inventory, precise propagation set,
   active work, residency, and process identity immediately before stopping
   anything. If any check changed, stop and re-approve.
2. Create the planned same-filesystem backup and verify its digest, byte size,
   owner, and mode against the recorded original. After that verification,
   stage the candidate beside the live executable, apply and verify the original
   owner and mode, and stop before any service mutation if either identity check
   fails.
3. Stop the approved propagation set in dependency-aware order. For every
   stopped unit, apply the exact stop predicate named in the approval:
   `ActiveState=inactive` alone is insufficient. For any allowed failed state, confirm the predeclared
   `Result`, `ExecMainCode`, and `ExecMainStatus` termination tuple. Also prove
   `MainPID=0`, no `ControlPID` remains, and the service cgroup contains no
   processes. A failed unit is not accepted merely because its main PID is zero; a
   failed result is acceptable only when that exact result tuple was
   predeclared and all quiescence checks pass. Any unknown result, populated
   cgroup, remaining control process, or unknown work fails closed. Confirm
   that no unapproved unit was stopped or started, and preserve inventory units
   outside the approved set.
4. Verify every relevant process again and require that no process executes the
   old executable. If any old-binary process remains, stop and escalate rather
   than replacing a running executable. Then atomically rename the
   staged candidate into the live path, and verify the live SHA-256, owner, mode,
   device, and path.
5. Start only the units that were active in the recorded baseline, using the
   approved dependency order. Do not turn an inactive service into an active
   one merely to make a probe pass. After each required start, poll the
   approved non-mutating health or listener check until the fixed, approved
   readiness deadline. `ActiveState=active` alone is not readiness; an expired
   or ambiguous readiness check fails closed. Never resend a model request as
   a readiness poll.
6. After readiness succeeds, verify process identity and executable digest,
   systemd state for the entire closure, backend health, and the gateway's
   authenticated capability seam. Use content-blind checks and do not send
   prompts or model requests.
7. Verify that MCP clients can reconnect after the expected transport
   interruption. A reconnect or synthetic readiness result is operational
   evidence only; it is not evidence of organic traffic, quality, routing
   adoption, or savings.
8. If every check passes, record the exact post-change states, digest, timing,
   and bounded outage. If any check fails, do not certify the upgrade; follow
   the approved rollback below.

The result must identify the executable digest and service state, not merely a
successful command or a merged revision. Keep the public record content-blind
and free of private host values, credentials, prompts, responses, and live
configuration bytes.

## Rollback

Rollback is an explicitly authorized action against the verified original
backup. It may be preauthorized in the same exact approval above, or authorized
separately before it starts. It is required when the post-change digest, process identity,
dependency state, backend health, gateway capability seam, or MCP reconnect
check fails, and it may not expand the approved scope.

1. Verify the recorded rollback authorization, exact backup identity, dependency
   inventory and propagation set, baseline states, and current absence of active
   work and model residency. Do not seek a second confirmation when the exact
   rollback was already preauthorized and the recorded trigger matches.
2. Stop the same approved propagation set and apply the same approved stop
   predicate: verify any required failed-state termination tuple, `MainPID=0`, no
   `ControlPID`, and an empty service cgroup before restoring. Verify that no
   process executes the candidate.
3. Restore the verified original backup by the same-filesystem atomic rename;
   preserve the original owner and mode and recheck its SHA-256 and metadata.
4. Restart only the units that were active in the original baseline. Poll the
   approved non-mutating readiness check until its fixed deadline; then verify
   the whole closure, backend health, gateway capability seam, and MCP
   reconnect. `ActiveState=active` alone is insufficient, and no model request
   is a readiness poll.
5. Record whether the original executable is restored byte-for-byte and leave
   the gateway running on that known-good backend state. Do not edit roster,
   configuration, credentials, isolation, or gateway source to make rollback
   pass.

If the stop predicate is unknown, a cgroup is populated, readiness expires, or
restoration, dependency state, or protected-service health is anomalous, keep
the affected scope contained and stop under the owner-controlled operations
procedure. If an apply failure matches an explicitly approved recovery trigger,
use that recovery within its original attempt limit. If recovery itself fails or
restoration is anomalous, stop and escalate; existing preauthorization does not
permit another recovery attempt. Do not retry with a broader
stop, guessed unit relationship, repeated model request, or unverified artifact.
