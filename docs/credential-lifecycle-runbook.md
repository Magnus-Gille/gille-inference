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
schema, run migrations, or inspect `.env`/static fallback values. The report contains aliases,
lifecycle timestamps, use counts, and findings, but no plaintext or hash. `unused` means the
running gateway has never completed an allowed request for that minted key; `stale` means its last
successful request is older than the threshold. `over_scoped` is a conservative review flag on
active admin keys. Static fallback credentials cannot carry lifecycle metadata and are deliberately
reported as `not_inspected`; migrate them to minted scoped keys through the normal backed-up
deployment procedure without copying their values into an inventory command.

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

The public `m5-auth --check` requires an explicitly configured `M5_GATEWAY_URL`,
`M5_OPENAI_BASE_URL`, or legacy `M5_BASE_URL`; missing configuration exits `2`
before credential access and must not be treated as evidence of a stale key.
The separate `m5-auth --check --tailnet` selects the private route explicitly.
