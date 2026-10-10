# G1 observer review bundle

The offline checker binds the material submitted for G1 review to one digest. It checks structure,
ceilings, expiry and artifact bytes. It does **not** approve a mutation, execute commands, authenticate
host evidence, interpret an AppArmor policy, establish that a binary came from a claimed build, or
qualify a Linux observer. A passing result always includes `authorizesMutation: false`.

This is a G0 prerequisite for the [integration plan](controlled-install-m5-integration-plan.md),
not its complete executable packet/launcher. The native observer, effective Linux policy tests,
authenticated host channel and transactional execution remain separate work. In particular, an
artifact named `linuxQualification` can contain false claims: the reviewer must inspect its evidence.

## Content and checking

A private directory contains `packet.json` and ten distinct regular files, one for each role:

| Role | Required review material |
|---|---|
| `observer` | Exact candidate native executable |
| `unit` | Exact observer unit, including effective resource and identity restrictions |
| `apparmor` | Enforcing profile for that executable and its bounded read surface |
| `busPolicy` | Method-filtered, read-only systemd access |
| `polkitPolicy` | Explicit denial of service mutations for the observer identity |
| `hostManifest` | Complete accepted inventory, identities and classified exclusions |
| `buildProvenance` | Source/toolchain/input hashes and reproducible artifact verification |
| `linuxQualification` | Positive visibility and negative access/syscall tests on the exact candidate |
| `operations` | Exact launcher and commands: preflight, create/start, verify, stop and cleanup |
| `rollback` | Exact rollback commands and protected-state/OOM restoration checks |

The strict schema is `observerReviewPacketSchema` in
[`observer-review-bundle.ts`](../src/homeserver/observer-review-bundle.ts). Each artifact has a flat
filename, byte count and SHA-256. The packet includes the accepted 40-character release, named host
and boot identity, prior gateway release, protected unit invocation/executable/configuration hashes,
OOM baselines and resident models. Exact target paths, unit prefix/name, profile and an **existing**
dedicated non-root UID/GID are required. This G1 scope does not provision accounts. If a suitable
identity is absent, stop and propose its exact provisioning/removal as a separately reviewed scope
change before asking the owner to approve M5 changes.

The schema fixes the proposed privilege ceiling and fail-closed safeguards; it bounds observer
memory to 128 MiB, CPU to 25%, tasks to 32, output to 64 MiB and the window to 20 minutes, with one
run and no retry after mutation. Smaller concrete limits are allowed. These are review constraints,
not proof of kernel enforcement. All named target paths must be absent before creation; the
eventual host preflight must verify absence, dedicated identity, host binding, current protected
state, effective policy and maintenance exclusion. The offline checker cannot verify them.

The checker rejects duplicate JSON keys (including escaped spellings) and invalid UTF-8 before
schema validation. Compute the digest of an already constructed packet object with
`observerReviewPacketDigest(packet)`. The hash uses the repository's RFC 8785 canonical JSON routine,
so object key order and whitespace do not
change the digest; array order and every accepted field do. Record that digest through the review
and owner-approval channel independently of the directory. Do not trust a digest file delivered
alongside unreviewed material as proof of approval.

```sh
npx tsx scripts/check-observer-review-bundle.ts /absolute/private/bundle EXPECTED_SHA256
```

Exit status is 0 for valid structure/integrity at the local check time, 1 for rejected material and
2 for invalid CLI arguments. Output contains fixed reasons and the parsed packet's digest, never
artifact contents or private paths. A digest or time-window mismatch stops before artifact reads.
Any subsequent change requires a new digest and review; expiry or host changes require refreshed
evidence and owner approval. No actual M5 bundle or host-specific baseline is committed here.

## File boundary and remaining execution obligations

Packet JSON is limited to 1 MiB, each artifact to 64 MiB, and the artifact total to 128 MiB. Reads
reject non-regular files, final-component symlinks and hardlinks; compare descriptor/path identity
and metadata before/after bounded reading; and check the bundle directory for change. Artifact
names cannot contain path separators or collide after ASCII case folding. Parent directories of the supplied bundle path are resolved
once (for example `/tmp` on macOS). This is not protection against an adversarial filesystem or a
promise that files will remain unchanged after checking. Keep the review directory private.

The future privileged executor must use its own confined, immutable staging and verify the approved
bytes again at use time. It must not turn this result, a self-declared receipt or arbitrary text in
`operations` into execution authority. Review must match every command and target to the typed
envelope, inspect build/qualification evidence, and verify rollback. No shell executor is included.

The next M5 approval remains G1 only: the exact candidate release/digest, host, existing identity,
owned unit/profile/files, bounded privileges/resources/window, explicit mutations and commands,
verification and rollback. G2 production replacements/restarts, G3 canary and G4 installation remain
distinct approvals under the integration plan. A general instruction to continue local G0 work does
not authorize those actions.
