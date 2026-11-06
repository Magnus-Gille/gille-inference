# Host-global allocation intent primitive

This component atomically persists one accepted reservation intent. It does not
grant an allocation, validate current BOOTTIME, create a production directory,
activate resources, initialize storage, release a lease or authorize execution.
Actual owner authority, current clock/host state, applied controller/process
limits and complete required accounting remain independent mandatory gates.

`planAccountedAllocationLedgerV3Bootstrap` returns initial bytes and their accepted
file-journal version. Installation/initialization is a separate protected action.
Opening an absent, corrupt, different-boot or quarantined journal never adopts or
repairs it. The physical CAS backend is the existing file storage implementation;
no SQLite or SQL is introduced.

For UID0 the directory is fixed to
`/var/lib/gille-inference-accounted/allocations`. It is host-global, rather than
one directory per mandate.
Root configuration must additionally supply the shared directory's device/inode
from the accepted host installation receipt. A held directory FD and named path
are compared to that pin before/after reads and CAS acknowledgement. A different
physical directory at the same lexical path cannot be adopted. The expected pin
is not obtained from a per-mandate self-observation or requester declaration.
The underlying backend checks actual effective UID,
private directory/file ownership, modes, single links, pinned identities and
durable transitions. Non-root tests explicitly use their own UID and files; they
cannot supply a root authority assertion or override the production directory.

The closed state has `schemaVersion:1`, kind
`accounted-allocation-intent-ledger`, `hostBootId`, and one nullable `reservation`.
A reservation contains the complete closed accepted intent and its separate
domain-separated digest. Its lease ID is an identifier, not an authorization
token. BOOTTIME nanoseconds are explicitly canonical decimal strings in this
internal journal, preserving values beyond Number's safe range. Native B wire
integers remain integers; no wire version or R4 schema is reinterpreted.

The intent pins mandate/request/attempt/lease IDs, boot, static owner authorization,
the unchanged R4 owner allocation/digest, source/config/releases and the finite
lease interval. Constructor inputs are snapshotted. `reserve` accepts only an
AbortSignal; a requester cannot supply a different intent at acquisition time.

Inspecting the entire global state and acquiring the reservation use one CAS.
Distinct mandates cannot both win by creating independent lease files. Existing
reservations refuse, including duplicate IDs and expired intervals. There is no
time/PID-based unlocking, automatic retry, deletion or recovery. A partial/unknown
transition retains its files and is UNKNOWN. Readback is required before the
reserved acknowledgement. Error causes remain internal; public error codes are
bounded. `attemptConsumed` instructs the caller not to retry; it does not replace
the separate durable native-start and admission replay gates.

Receipts always retain `actualAllocationVerified:false` and
`executionAuthorized:false`. The later real allocator must independently verify
activation/lease/current-host/owned/external evidence before producing allocation
records. This primitive supplies no activation/release handler or default
production loader, and must never be relabelled as those missing capabilities.
