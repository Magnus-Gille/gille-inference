# Gateway credential lifecycle

This runbook is the public, secret-free engineering contract for inventorying and migrating M5
gateway credentials. Live aliases may be operationally sensitive; publish only sanitized counts,
status codes, plan IDs, and the accepted revision. Never publish a token, keystore hash, private
endpoint, secret-store locator, or raw environment/configuration dump.

## Scope and lifetime policy

Every newly minted key expires. Omitting `--ttl` selects the maximum below; a larger value is
rejected before any row is written. Rows created before this policy may still have no expiry so
they can authenticate during a staged migration, but `keys inventory` flags them.

| Consumer | Tier / scope | Maximum lifetime | Notes |
|---|---|---:|---|
| Human owner break-glass or an operator route that genuinely requires admin | `owner/admin` | 30 days | Admin is explicit and exceptional; a new owner key defaults to `agent`. |
| Claude, Codex, Pi, code-loop, or another bounded owner harness | `owner/agent` | 90 days | Preserves owner privacy/admission while denying `/admin/*`, `/delegate`, and `/ledger`. |
| Heimdall or another read-only observer | `guest/monitor` | 365 days | Only successful `GET /healthz`, `/models*`, `/metrics`, `/ledger*`, and `/ops/summary` requests are allowed. |
| Ordinary inference client | `guest/inference` | 365 days | No operator or evidence-reading authority. |

A service that temporarily needs an existing admin-only API is still `owner/admin`, limited to 30
days, and remains an `over_scoped` inventory finding until a route-specific scope removes that
exception. Tier never implies admin authority. Existing rows whose stored scope is null retain the
old owner-to-admin interpretation only for compatibility during migration.

## Redacted inventory

Run on the authoritative gateway host without reading `.env` or dumping SQLite:

```bash
npx tsx src/homeserver/cli.ts keys inventory --stale-days 30
npx tsx src/homeserver/cli.ts keys inventory --stale-days 30 --all --json
```

The command opens the existing SQLite store read-only: it does not create directories, initialise
schema, run migrations, or read `.env`; static fallback lists are only counted. The report contains aliases,
lifecycle timestamps, use counts, and findings, but no plaintext or hash. `unused` means the
running gateway has never completed an allowed request for that minted key; `stale` means its last
successful request is older than the threshold. `over_scoped` is a conservative review flag on
active admin keys. Static fallback credentials cannot carry lifecycle metadata, so the report gives
only the **count** configured in each list (`legacyStaticCredentialCounts`: admin, user, monitor,
read from the process environment of the command; `.env` is not read, so run it where the
gateway's environment is loaded). Values are never printed, hashed or fingerprinted.

```bash
npx tsx src/homeserver/cli.ts keys inventory --static [--json]   # counts + kill-switch state only; needs no database
npx tsx src/homeserver/cli.ts keys inventory --plan [--json]     # per-key worksheet + static counts
```

`--plan` lists alias, tier, scope, created/last-used/expiry, findings and one suggested action:
`retire` (never used, or stale), `rotate` (active admin without expiry: stage a bounded
replacement), `narrow` (active admin with expiry), `keep+expiry` (no expiry), `keep`, or
`none` (already inactive). A recently created, still-unused key is kept rather than retired. The
static lists always read "migrate to minted keys".

## Narrowing a key in place

`keys restrict` lowers the scope and/or sets or shortens the expiry of an existing minted key
without touching its key material or rotating it:

```bash
npx tsx src/homeserver/cli.ts keys restrict --alias <alias> --scope agent --expires-in 2592000 --dry-run
npx tsx src/homeserver/cli.ts keys restrict --alias <alias> --scope agent --expires-in 2592000
```

The allowed order is `admin` to `agent`, `inference` or `monitor`, and `agent` to `inference`
(`monitor` and `inference` are incomparable, and `agent` does not cover `monitor`'s reads). A
widening scope, a later expiry, a lifetime above the resulting scope's maximum, a revoked or
expired key, or a key in a staged rotation is refused. One guarded transactional update changes
only `scope` and `expires_at`. Use it for consumers that already have the right credential but
too much authority; use staged rotation when the consumer must receive a new secret.

## Retiring static env keys

1. Run `keys inventory --static` and note the counts per list.
2. Migrate each static consumer to a minted key through the staged workflow below
   (admin consumers: re-check whether they need admin at all; prefer `agent`, `monitor` or `inference`).
3. Set `HOMESERVER_DISABLE_STATIC_KEYS` to the list(s) that are fully migrated (for example
   `user,monitor`), restart the gateway, and read the single startup line: it states the switch
   state and the counts being ignored. An invalid value aborts startup without being echoed.
4. From each former static consumer, send the content-free probe with the old static value and
   expect `401 invalid_api_key`; confirm the minted replacement still succeeds.
5. Rollback is removing the variable (or setting `off`) and restarting; the static values remain
   in the environment until you delete them.

Deploying the code is a separate owner step; the switch defaults to off, so deploy alone changes
no authentication behaviour.

## Staged consumer migration

Work through one logical consumer at a time. Do not revoke first and do not place a credential in
argv, a pipe assembled from shell history, logs, a ticket, chat, or a scratch file.

1. Record the pre-migration inventory counts and identify the consumer's current logical alias,
   required allowed route, current secret store, and rollback method. Confirm that at least one
   independent owner/admin recovery credential remains valid throughout the change.
2. Stage a bounded replacement. The example is a harness; choose the table's exact tier/scope and
   an overlap between 60 seconds and 24 hours:

   ```bash
   npx tsx src/homeserver/cli.ts keys stage --alias <logical-alias> \
     --scope agent --ttl 7776000 --overlap 3600
   ```

   The replacement is shown once. Enter it directly into the consumer's approved secret-store
   prompt, then update only that consumer to select the replacement. The prior credential remains
   active during overlap.
3. From the migrated consumer, run its normal content-free, allowed capability probe against the
   authoritative gateway. A rejected, forbidden, or unknown-route request does not advance
   preflight evidence. Then persist the gateway-observed proof:

   ```bash
   npx tsx src/homeserver/cli.ts keys preflight --plan <plan-id>
   ```

   Preflight succeeds only when the exact replacement alias has a post-stage successful
   authenticated protected-route request and increased use count. Public `200` routes such as
   `/healthz`, `/hs`, or `/portal*`, plus anonymous `401` and forbidden `403` requests, do not
   advance proof. Knowing the replacement plaintext or looking it up in the local database is
   insufficient.
4. If consumer setup or preflight fails, point the consumer back to its prior secret and abort:

   ```bash
   npx tsx src/homeserver/cli.ts keys abort --plan <plan-id>
   ```

   Abort atomically revokes only the replacement and refuses to claim rollback if the prior set is
   no longer active. Verify the prior consumer probe before retrying with a new plan.
5. After preflight passes, commit inside the overlap window:

   ```bash
   npx tsx src/homeserver/cli.ts keys commit --plan <plan-id>
   ```

   Commit atomically verifies the persisted preflight and unchanged family, revokes the prior
   aliases, and keeps the replacement. Any failed check rolls back the transaction.
6. Use the old consumer secret store—not copied output—to send the retired credential only to the
   same content-free capability probe. Acceptance requires `401 invalid_api_key`. Record only the
   status. Confirm the replacement still succeeds and rerun the redacted inventory.

`keys rotations` lists sanitized plan state. The older `keys rotate` command remains available for
the already-reviewed issue #98 owner-key recovery path, but it revokes and replaces in one
transaction and therefore does not provide consumer overlap. Use the staged workflow for ordinary
planned migration.

### Dedicated `gateway-owner` migration

Do not remove the current owner/admin access merely because inventory flags it. At its next
owner-attended rotation, stage an explicit `owner/admin` replacement, update the canonical
password-manager/Keychain item through its prompt, run both approved `m5-auth --check` transport
checks, run `keys preflight`, and only then commit. If either transport reaches a different gateway
or fails, abort the staged plan and restore the prior selector before investigating. Issue #98's
retired-key `401` proof remains required after commit.

## Provisioning a new owner-agent profile (issue #184)

A missing named profile (for example the `codex` credential in issue #242) is repaired through
the guided `m5 provision` ceremony — never by copying a bearer between configs, keychains, or
machines. The ceremony owns the public-profile configuration, the correct live-key mint path,
Keychain persistence, and final verification in one owner-attended flow:

```bash
m5 --profile <name> \
  --public-gateway-url https://inference.example.com \
  --m5-host <user>@<m5-host> \
  provision
```

Prerequisites: macOS with the `m5` client, a non-interactive owner-authorized SSH path to the M5
host that permits the fixed live-gateway key command, and an HTTPS public gateway URL. The SSH
target must be a simple host or `user@host` value; anything else is rejected before any state
changes.

What the ceremony does, in order:

1. Validates the profile name and the public HTTPS gateway URL and writes only the non-secret
   profile to the local `m5` config (atomically, preserving the existing file mode). An existing
   profile with a different public URL is refused rather than silently replaced.
2. Refuses when the `gille-inference` / `gateway-agent-<profile>` Keychain item already exists.
   Reconcile ownership of the existing item through the staged migration above first; the
   ceremony never overwrites or merges credentials.
3. Mints exactly one distinct `tier=owner`, `scope=agent` credential (90-day maximum lifetime
   per the table above) inside the live gateway mount namespace — not the SSH login shell's
   default data directory — over the fixed remote command. The bearer travels only on process
   stdin into the Keychain prompt path; it never appears in argv, environment, config, files,
   terminal output, logs, or diagnostics, and the ceremony returns no bearer or alias.
4. Any mint, output-validation, or Keychain-store failure revokes the exact fresh alias with
   bounded retries. A `*_revocation_unknown` outcome means revocation could not be confirmed:
   list recent `agent-<profile>-<stamp>` aliases through the redacted live inventory and revoke
   any orphan before retrying. No failure mode leaves an unreported credential.
5. Finishes by running `m5 --profile <name> doctor` and reporting only the structured, redacted
   result. Provisioning is complete only when `doctor` reports `healthy`.

Collision and failure recovery: `keychain_item_exists` means another credential already owns
the profile — stop, determine which consumer it serves via the redacted inventory, and either
keep it or migrate it through the staged workflow before retrying. `mint_failed_*` and
`keychain_store_failed_*` outcomes state whether the fresh alias was revoked; for any
`*_revocation_unknown` outcome, confirm on the live host that the timestamped
`agent-<profile>-<stamp>` alias is gone before retrying. `profile_url_conflict` means the
local profile points at a different gateway; change it explicitly outside provisioning.

The public `m5-auth --check` requires an explicitly configured `M5_GATEWAY_URL`,
`M5_OPENAI_BASE_URL`, or legacy `M5_BASE_URL`; missing configuration exits `2`
before credential access and must not be treated as evidence of a stale key.
The separate `m5-auth --check --tailnet` selects the private route explicitly.
