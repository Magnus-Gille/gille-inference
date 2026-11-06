# Accounted owner-evidence adapter (local candidate)

`src/homeserver/accounted-host-policy-adapter.ts` is a pure bridge to the unchanged
Accounted R4 policy kernel. It has no collector, CLI, network, process, filesystem,
signing-key, installation or production-route integration. No host inventory,
resource allocation or permission is discovered or created.

The request and opaque evidence envelope are untrusted. The context and synchronous
owner-evidence verifier are separate trusted dependencies. There is no default
verifier. In particular, a request containing `trusted: true` or an issuer label
does not authenticate anything. A real verifier/channel and a current owner-issued
context are still missing live components; test verifiers are synthetic fixtures.

## Input and integrity

The adapter checks the existing Brokkr request core, limits and duration ceilings.
It hashes the complete request excluding only `requestDigest`, using sorted compact
UTF-8 JSON with no trailing newline. Core IDs and timestamps use the shared exact
formats: lowercase UUIDs, ASCII host IDs, and six fractional UTC digits in years
0001–9999. No timestamp rounding, offsets, trailing newlines or implicit clock are
accepted. CPU ratios use integer arithmetic.

The trusted context pins the exact approved request digest, actor UID1000, host and
boot, issuer, observer instance, policy digests, challenge, sequence, expiry and
replay history. It must not be assembled from requester claims. No UID1001 access
inventory or allocation is reused. Request limits must equal the explicit verified
whole-task allocation, including control-plane accounting; ceilings are not proof
that the allocation exists. Missing allocation, coverage or first-instruction proof
fails closed through the context checks and R4 kernel.

The injected verifier returns a verified body and its digest. The adapter checks
that body against the owner context, exact request and R4 input, and checks both
wall-clock and monotonic freshness. A fresh envelope cannot relabel an old R4
observation. The R4 observation window cannot exceed the owner context's window.
For restoration, the context must additionally pin the entire accepted baseline's
digest. Baseline time and all original R4 restoration rules remain unchanged.

New adapter-only digest domains end with a literal newline before the canonical
JSON body; there is no trailing newline after the body:

- `gille-inference/accounted/owner-evidence/v1` hashes the complete verified body.
- `gille-inference/accounted/accepted-baseline/v1` hashes the accepted baseline.
- `gille-inference/accounted/replay-state/v1` hashes the expected boot/observer,
  previous sequence, evidence-digest history and attempt history for a replay CAS.

These do not redefine Brokkr receipt digests or Accounted result bytes. Known schema
keys are ASCII. JSON is bounded and copied before use; proxies, accessors, classes, cycles,
sparse/extended arrays, unsafe numbers and oversized/deep input are refused.
Snapshots are constructed from validated data descriptors, without rereading input values.

## Result and replay boundary

`compatible: true` is a conditional policy result under the supplied trusted
provider/context. `offlineOnly: true` and `executionAuthorized: false` are always
returned. It is not a live host result, capacity proof or execution permit. R4's
own decision and digest are preserved, including its separate no-authority flag.
Refusals contain bounded reason codes rather than raw evidence or verifier errors.

A successful result includes `replayCommit`, bound to the complete request digest,
phase, attempt, nonce, evidence digest, sequence and expected previous replay-state
digest. A future trusted host must atomically validate/commit this proposal before
any use by an actuator. This module does not provide durable storage, reserve a
slot, authenticate a caller, or close a check/commit race. Admission and restoration
have separate attempt entries. Missing/old/replayed evidence is refused; a refusal
is not retry authority and must not reset trusted history.

## Local validation and remaining gaps

The tests reuse the content-free shared R4 fixture from the completed Accounted
manifest `4bfff37ae33649bb465bfafe73c4288f2aee84b23cff5c8112d2df62f9469bf6`.
The unchanged admission decision digest remains
`7c22637df6d62cb8cfddeb204a02a0e662320b6acac70361b817feb0dfe0baa7`.
Other fixtures test malformed input, provenance/identity and digest substitution,
replay, timing, resource limits, incomplete accounting, OOM/residency drift and
baseline replacement. Fixture host/service values do not represent a real host.

The authorized endpoint is a reviewed local patch. It does not install an issuer,
collector, trusted ledger, admission service or first-instruction-contained launcher,
and does not establish any real allocation or native Accounted result. Those require
separate source/integration proof and explicit host authorization. The prior completed
R4 kernel, shared payload and existing production guard modules are not modified.

## LOCAL issuer candidate (Brokkr R3)

`src/homeserver/accounted-host-issuer.ts` implements an issuer workflow and one-way replay journal transitions. `scripts/accounted-host-issuer.ts` is a closed entry point: it returns exit2/providers_unavailable before any host I/O. It accepts no JSON providers, arbitrary paths or credential routes. This is a reviewed-local-patch candidate, not an installed issuer or execution permit.

The caller supplies accepted owner configuration and separately configured trusted capabilities: root-sealed challenge reader, independent current evidence collector, host-evidence verifier, owner-evidence verifier, clock bridge, durable CAS storage and atomic no-replace root0600 publisher. **None has a default implementation or memory fallback.** In particular, the journal has real one-way reserve/commit checks but depends on an external durable storage capability; the synthetic test storage is not a production backend. Missing capability or missing/stale/unverified facts refuses. This patch collects no actual inventory, signs nothing, installs no storage/provider and grants no resource allocation.

The native consumer is pinned to reviewed Brokkr R3 manifest `af7e8d1cd41ad4fb5750b54bbcb6c25ec3394bc5ddde7e7a6a27e6326621f49d`, patch `5693cd736e3b2e215d0e23723d6198ab0e2d6587b0485dbf88b49939bdc6a6d4`. R2-to-R3 changes are stored-status dispatch and tri-state rootless/returncode receipts; config/challenge/admission/clocks are unchanged. R3 stored status is not fresh liveness or restoration. The fixed descriptor remains `7d97cb1f350f1aaa25b9abfef518f5b8f5b42af77ace1dfa49216692e42f5bde`, UID1000, unchanged HOME/PATH/XDG and Podman semantics.

Accepted configuration explicitly correlates distinct native32hex, requestUUID and policy-attemptUUID. It pins source/release/config/descriptor/issuer digests. The bounded native ASCII integer JSON parser rejects duplicates, floating numbers, non-ASCII strings and excess size/depth while preserving nanoseconds and inode integers above2^53. No UUID, release or artifact identity is guessed from another. R3 fixes payload/stop/runtime windows at20/5/30 seconds, so tighter requested ceilings are refused before consumption. Its30seconds excludes pre-admission/setup and the outer unit stop/backstop. An explicit independently verified wholeTaskMaxSeconds must cover that entire lifetime, fit the requested total and actual owner deadlines, and remain stable across collections; no numeric value is inferred from R3 runtime alone. Four native limit fields must exactly match policy memory/CPU/tasks; swap and address-space limits require independently verified explicit values. R3 itself does not enforce the policy address-space field: an actual issuer must refuse that fact unless a separately accepted mechanism proves it, or the owners approve a concrete actuator delta.

Host evidence must independently authenticate native boot/invocation/cgroup/namespaces and effective limits, first charged instruction, all six shared accounting/allocation records (bootstrap, transport, service_manager, kernel, admission_issuer, recovery), complete accepted protected inventory, current activity/maintenance/OOM/residency and actual allocation. Digest syntax alone never verifies their underlying records. `verifyHostEvidence` is the explicit external trust boundary for those facts; `verifyOwnerEvidence` authenticates the R4 policy input. Requester claims cannot supply either capability. Existing partial collectors/old receipts/UID1001 inventory cannot be relabelled complete. Both independent evidence collections must pass unchanged R4/adaptor checks and agree on boundary/allocation/coverage.

A trusted CLOCK_BOOTTIME/UTC bridge is required. Native nanoseconds stay bigint/lossless; R4 uses explicit safe integer microseconds. Wall/boottime drift over one microsecond from the accepted sampled bridge refuses; the provider must establish that bridge, not merely sample unrelated clocks. The issuer supplies the current evaluation clock without changing the evidence timestamp. All accepted, verified-owner and R4 observation freshness windows remain in force after durable commit and constrain the actual publication deadline. Evidence timestamps and both policy/owner deadlines constrain publication; a fixed35second native TTL must fit the actual approved window, retaining30seconds at publication. Five-second challenge and caller wait limits are never extended. The publisher must enforce the supplied strictest deadline at the actual atomic write, not only at function entry. No slow synchronous or uncancellable provider is a new isolation boundary.

The root storage capability must authenticate its existing state and atomically CAS across processes; no state initializer, pruning, rearming or boot reset exists here. Claims reserve both native and policy attempts. CAS commits the actual persisted replay state before publication; crashes/failed policy leave the attempt consumed. Publication must be atomic no-replace and must not expose a partially written or temporarily multilink admission to R3. Node's overwrite-capable rename or a visible link/unlink interval is not a substitute. Storage durability, ownership/path safety, deadline enforcement and actual no-replace mechanism remain independently reviewed integration obligations. Unknown reservation/commit/publication outcomes report unknown and require reconciliation; no retry or automatic deletion is attempted.

Results always retain offlineOnly:true/executionAuthorized:false. `published` acknowledges only the configured provider's publication receipt; it does not verify a live host or authorize execution. Bounded reason plus stage is returned without raw evidence/errors. Real restoration/cleanup and post-run R4 checks remain a separate trusted host integration; this issuer does not turn terminal/status receipts into restoration proof. No collector, allocation, durable backend, filesystem publisher, installed executable, M5 capability or live test was produced by the LOCAL mandate. Before any host use, those exact missing integrations, artifacts, paths, effects, allocation/coverage, protected baseline, single writer, finite window and recovery require the separate concrete approval.

## LOCAL file CAS backend candidate

`src/homeserver/accounted-issuer-file-storage.ts` supplies physical-file `read` and `compareAndSwap` operations for the unchanged `IssuerDurableStorage` interface. `publishOnce` always refuses with `publisher_unavailable`. It installs no files/providers and changes neither the issuer CLI nor policy contracts. There is no SQLite dependency, migration, state initializer or fallback memory store.

Opening requires trusted owner configuration: an existing canonical absolute storage directory, explicit owner UID equal to the process effective UID, and the exact accepted bootstrap version. An elevated caller therefore cannot select an actor-owned directory by changing an option. Unprivileged tests use their own UID and synthetic temporary files. The directory must be0700, files0600/regular/singlelink on its filesystem; ancestors must belong to root or that owner and have no group/world write, with a root-owned sticky shared parent allowed under POSIX entry protection. Symlinks, foreign owners, unsafe modes, changed parent/directory/FD/path identities, oversized files and noncanonical or corrupt records refuse. Ownership/mode checks alone do not attest ACL/MAC policy, mount semantics or complete host trust: the actual privileged loader, root path/bootstrap acceptance and Linux/filesystem environment remain separate reviewed integration obligations. Config options must never come from requester fields.

The pure `encodeInitialAccountedIssuerFileRecord` only encodes an explicitly supplied fixture/artifact; it never creates or adopts state. The backend requires the exact already-provisioned `journal.json`. Each bounded canonical JSON record binds payload digest, monotonic decimal revision, parent version and accepted origin. Its opaque64hex version binds revision and bytes, preventing content ABA. At most8192CAS transitions are supported (two per4096issuer claims); exhaustion refuses without pruning or resetting. This is a code safety ceiling, not approved host disk capacity.

A CAS rechecks its expected version, creates an exclusive per-version intent receipt, syncs it and the directory, then rechecks the bound old state under that ownership. It writes/syncs a new private singlelink temporary record, atomically replaces the journal, and syncs the directory. A completion receipt is created withO_EXCL, written and synced, followed by directory sync before success. No completion rename can overwrite an unknown competing file. Calls using an old version cannot win again. These guarantees assume a local filesystem honoring the required rename/fsync semantics and trusted same-UID writers using this protocol; this is not a sandbox against a malicious privileged peer. A real host path must prevent unauthorized writers and overlapping owner maintenance before use.

Intent and completion receipts remain as bounded audit history; this backend never unlinks them or any temporary file. A stale/partial intent, missing/partial completion, replaced directory, failed write/sync, or ambiguous transition is quarantined. There is no PID/TTL unlock, rearm, rollback, automatic cleanup, bootstrap or repair. An explicit readback can validate a fully written completion after a lost acknowledgement and sync that exact receipt and directory before treating the transition as durable. It does not reconstruct missing bytes, clear a lock or repeat a write. Thus `read` is a durability readback withfsync, not a pure host metadata probe. An incomplete transition remains unavailable until separately authorized reconciliation.

Atomic replacement of the private journal does not implement admission publication. R3's root0600/no-replace/deadline publication and its singlelink requirements remain absent; no link/unlink workaround or partial admission is exposed. All actual collectors/verifiers, current allocation/protected inventory/control-plane facts, root bootstrap, host durability proof, native capability, installation and execution authority remain missing. The issuer's existing fail-closed CLI and no-execution-authority flags are unchanged.

Tests use only synthetic temporary directories and records: close/reopen persistence, version/ABA/rollback guards, real bounded separate-process contention under an explicit minimal environment, issuer reservation reuse after reopening, corrupt/missing/oversized state, symlink/hardlink/mode/owner/parent changes, injected write/sync/rename/completion collisions, abort and readback of unknown outcomes. The test child is confined by its pinned directory contract and process environment, not claimed as an OS security cage. Local tests do not simulate power failure or prove M5 ACLs, root trust, storage hardware, or durability. Retain unsupported-capability failures instead of relaxing guards.

## R2 local strict-v2 I/O and startup candidate

The original R3 pure issuer entrypoint remains pinned to its original consumer and version1 wire. `createAccountedIssuerV2` instead requires an explicit trusted consumer-manifest digest from accepted owner configuration. It refuses a different request-selected manifest and emits version2 plus `publication_deadline_boottime_ns`. The exact deadline is included before the admission digest and durable replay commit; it is never extended after commit. The unchanged R4 policy kernel and fixed Accounted descriptor are preserved.

`scripts/lib/accounted_host_io.py` supplies actual Linux CLOCK_BOOTTIME/UTC bridge sampling, existing-private-directory reads through pinned directory FDs, and libc `renameat2(RENAME_NOREPLACE)` plus file/directory fsync. No overwrite-capable rename or link/unlink fallback exists. Clock sampling has bounded uncertainty, which consumes the one-microsecond drift budget instead of expanding it. Actual M5 clock, filesystem, syscall, ACL/MAC and timing behavior remain native proof obligations. Successful userspace deadline checks do not impose a kernel syscall deadline: a late or interrupted publication is unknown, retained and unacknowledged. The strict-v2 consumer must independently reject expired publication deadlines. No precise atomic first-payload-instruction deadline is claimed.

The root/Linux helper CLI accepts only a fixed per-attempt root configuration path, exact configuration SHA and a closed operation name. Owner configuration/admission bytes use canonical ASCII JSON without LF. Brokkr context/challenge/config files use canonical JSON plus exactly one LF; their dedicated decoder preserves native integers above2^53. The challenge nonce/digest binds canonical JSON value bytes without that journal LF. Root0600 configuration files may be read from Brokkr's root0755 nonwritable parent through a read-only directory handle; that handle cannot publish. Private writable directories remain root0700, with regular root0600 single-link files. A successful read or matching digest is not complete host/protected-inventory authentication.

V2 admission publication targets only `/run/brokkr-accounted/admissions/<attempt>/admission.json`, beneath a private per-attempt parent. Clock, ready and self-test receipts use the assigned root-owned attempt directory. Replay storage remains shared across the accepted attempts under `/var/lib/brokkr-accounted/issuer/<mandate-uuid>/`; per-attempt independent journals are not substituted. `planAccountedIssuerJournalBootstrap` produces a pure, deterministic empty-state artifact bound to the accepted boot and observer. Explicit `initialize-journal` validates exactly those bytes and performs a create-only publication into an already provisioned empty directory. Existing state, unknown temporary files or another epoch require reconciliation; there is no automatic initializer on backend open, adoption, replay reset, pruning or boot fallback.

`accounted-host-io.ts` uses one fixed Python executable/helper/argument protocol, a minimal environment, finite subprocess/output bounds and no shell. A helper failure or malformed/lost acknowledgement after any clock/journal/audit/admission write remains unknown. These subprocess limits are not an isolation boundary or proof that blocked kernel I/O terminates on schedule. An admitted parent unit, independent recovery and actual timing evidence remain required.

The staged `scripts/accounted-host-issuer-live.ts` implements only the explicit `--self-test` branch. It binds the same bundle release, root configuration and source/native context, initializes and rechecks the clock, and creates the fixed eight-field root self-test receipt with `self_test:true, admission_evidence:false`. The branch receives a narrow facade and has no publication/replay call path; the facade and TypeScript types are not an OS sandbox. The helper additionally refuses admission and journal initialization for self-test configuration. This result cannot become admission or rootless-success evidence. The normal diagnostic branch explicitly refuses with `live_provider_integration_required`; it does not emit ready or mint a permit from incomplete inputs.

Still missing are actual accepted complete protected/resident inventory, real allocation and independently verifiable six-component accounting records, their current trusted collectors/verifiers, the finished diagnostic orchestration, privileged deployment/source binding and native proof of startup/limits/cleanup/restoration. Root JSON assertions or digest-shaped strings do not fill these gaps. The local R2 work does not authorize a new host observation, installation, key action, native run, publication or merge. A complete fixed evaluation envelope remains a separate owner decision after real host evidence exists.

### Immutable issuer artifact verification (local component)

The root helper now verifies the complete code-only release before any helper
operation, including configuration reads and write-capable clock, replay, audit
or publication operations. Its own lexical path must be the accepted digest's
`accounted-host-io.py`. A missing manifest or any mismatch refuses; there is no
legacy bundle fallback. The diagnostic entrypoint remains closed pending real
host providers.

Each `/opt/gille-inference-accounted/releases/<digest>/` directory must have mode
0555 and exactly three root-owned, regular, single-link files with mode 0444:
`issuer-release.json`, `accounted-host-issuer.mjs`, and `accounted-host-io.py`.
Existing directory-FD and ancestor trust checks apply; each file's full bytes,
size, stable identity and hash are checked. This does not establish hostile-root
resistance, ACL/MAC safety, filesystem durability or native enforcement.

The canonical ASCII/no-LF manifest is limited to 4096 bytes and contains only
version 1, kind `accounted-issuer-code-release`, repository
`Magnus-Gille/gille-inference`, a declared 40-character source revision, and exact
SHA256/positive size entries for the two payloads (each at most 524288 bytes).
The directory digest is SHA256 of the domain
`gille-inference/accounted/issuer-code-release/v1\n` followed by those canonical
manifest bytes. Configuration, registry and host observations are excluded, so
code closure → release digest → Brokkr config → issuer config → launch pin has
no configuration/hash back-edge.

A declared revision is not a verified Git archive or compilation receipt. The
physical verifier binds bytes to an externally accepted artifact digest; its
receipt explicitly keeps compilation provenance and execution authorization
false. The existing accepted configuration's `sourceRevision` names Brokkr and
is never substituted for the issuer's source revision. A separate trusted caller
may additionally require an expected issuer revision when verifying artifacts.

`verify_recovery_artifacts` fully reads and verifies two distinct, explicitly
bound candidate/recovery artifacts. It never chooses an active release, switches
configuration, deletes files, repairs a journal, or performs rollback. Its receipt
keeps activation, configuration recovery and native restoration unverified.
This component is useful for checking a future recovery baseline, not proof that
the running service or its data could already be restored.

No release writer, privileged installer, accepted 40-character issuer release,
source build receipt, host allocation, protected/resident baseline, installed
configuration, native probe or execution authority is created by these APIs.
Installation still needs a source-bound accepted candidate and an explicitly
approved bootstrap/unit/resource boundary before its first owned instruction.
