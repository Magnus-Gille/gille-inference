# Deploying the BosGame M5 home-inference gateway

Operator runbook for exposing the home-inference box to a handful of trusted
external users (best-effort), while keeping your own overnight work first-class.

Hardware anchor: **BosGame M5 — AMD Ryzen AI Max+ 395 "Strix Halo", 128 GB
unified LPDDR5X** (single serial compute stream; ~215–256 GB/s; MoE-first).

## Topology

```
friend ──HTTPS──▶ Cloudflare edge ──Tunnel (outbound-only)──▶ <gateway host>:8080
                  (TLS, DDoS, WAF)        cloudflared            gateway.ts
                                                                  │ auth (per-key bearer)
                                                                  │ admission (owner ≻ guest → 503)
                                                                  │ quota (RPM/TPM/daily → 429)
                                                                  ▼
                                                          127.0.0.1:8091  llama-swap / llama-server
                                                          (one iGPU, serial)
```

**Access-control posture (corrected 2026-07-20, issue #23 — read this before assuming the old
"loopback only" claim below it in git history):** the gateway does **not** bind loopback-only in
production. `HOMESERVER_HOST` (`src/homeserver/config.ts`) is configured to the box's Tailscale
interface, so the process is reachable at both `127.0.0.1:8080` **and** `http://<tailnet-ip>:8080`
— both were verified live on 2026-07-19/20. This document previously asserted a strict
loopback-only invariant; that claim was wrong for the live box and is retracted here. What is
actually true:

- Every route that returns more than a coarse content-blind aggregate still requires
  `Authorization: Bearer <key>` — see the Gateway API table in
  [`../src/homeserver/README.md`](../src/homeserver/README.md). Reaching the tailnet listener does
  not let a caller mint keys, read `/ledger`, or call `/v1/chat/completions` without one.
- A small, deliberately unauthenticated set of routes is reachable on the tailnet listener exactly
  as it already was on loopback: `GET /healthz`, `GET /` / `GET /portal`, `POST /portal/redeem`
  (the one-time invite code is itself the credential), `GET /portal/stats`, and
  `GET /portal/model-evals.json`. These were already unauthenticated on the loopback+Tunnel path;
  the tailnet bind does not add a new unauthenticated surface, it changes who can reach the
  existing one.
- The startup safety net still holds: `startGateway()` refuses to bind any non-loopback host
  (tailnet included) unless at least one API key is configured (env or minted) — see
  `src/homeserver/gateway.ts`. An accidentally keyless box cannot silently expose the LAN/tailnet.
- This document makes **no claim** about Tailscale ACL configuration on the box — that was not
  verified as part of issue #23. Do not publish the box's tailnet address in docs, tickets, issues,
  or commits; treat it as private operator infrastructure and reference it as `<tailnet-ip>` or via
  the `m5` ssh alias instead.
- The Cloudflare Tunnel path in the diagram above (for external friend access) is a separate,
  additional inbound path and is unaffected by this correction; it was not re-verified as part of
  issue #23 either, and this document makes no new claim about its current state.

## Build vs configure

| Layer | How | Notes |
|---|---|---|
| Transport / TLS / DDoS | **configure** Cloudflare Tunnel | `cloudflared`, see `cloudflared/config.example.yml` |
| Edge rate-limit | **configure** Cloudflare WAF rules on `/v1/*` **and** `/portal/redeem` | free tier; blunt per-IP volumetric cap. `/portal/redeem` is the unauthenticated invite surface — see step 5 |
| Identity + quota + admission | **built** — `src/homeserver/gateway.ts` | per-key bearer, owner≻guest, 429/503 |
| Model serving / hot-swap | **deployed** llama-swap → llama-server | binds loopback; gateway is the stable serving seam |

## Order of operations

1. **Run the gateway** (loopback): `tsx src/homeserver/cli.ts serve`
   - Configure it first via env — see `env.example`. Copy to `.env`, `chmod 600`.
2. **Mint the first owner key for yourself** (loopback bootstrap):
   ```bash
   tsx src/homeserver/cli.ts keys mint --alias laptop --tier owner
   ```
   The plaintext key is shown **once**; only its SHA-256 hash is stored.
3. **Mint a guest key per friend** (see `ONBOARDING.md`).
4. **Stand up the Tunnel**: `cloudflared tunnel create llm`, route DNS
   `inference.example.com`, point ingress at `http://127.0.0.1:8080`, run as a service.
5. **Add the WAF rate-limit rules** (REQUIRED) + enable Bot Fight Mode in the
   Cloudflare dashboard. Add **two** rules:
   - `/v1/*` — blunt per-IP volumetric cap on the inference surface.
   - `/portal/redeem` — e.g. **>10 requests / 10 min per IP → block**. This is the
     unauthenticated invite-redemption endpoint; without it an attacker can brute-force
     invite codes. The gateway also enforces an in-app per-IP throttle
     (`HOMESERVER_REDEEM_RPM`, default 10 / 10 min) as defence-in-depth, but the WAF rule
     is the primary control and is **not optional**. See `cloudflared/config.example.yml`.
6. **Smoke-test** end-to-end with `stream=true` (see `ONBOARDING.md`).
7. **Hand a friend** their key + `https://inference.example.com/v1` + `ONBOARDING.md`.

## Live deployment (authoritative)

This is the single authoritative description of how the M5 gateway is actually deployed and kept
up to date. Every other document (`AGENTS.md`'s "Deploying the M5 gateway" section, runbooks under
`docs/`) points here instead of repeating these facts — if you find a stale copy elsewhere, fix it
to point here rather than re-describing the topology.

**Live facts** (verified 2026-07-19/20, issue #23):

- systemd unit: `home-gateway.service`
- `WorkingDirectory`: `/home/magnus/home-server-eval`
- `ExecStart`: `<WorkingDirectory>/node_modules/.bin/tsx src/homeserver/cli.ts serve`
- The live tree at that path is a **plain rsync'd copy, not a git checkout** —
  `git -C /home/magnus/home-server-eval rev-parse` fails with "not a git repository". There is no
  local history to diff against on the box; `.deployed-commit` (below) is the only record of
  deployed identity.
- Current baseline: commit **`8caf400`** ("feat: add LearningTaskContract gateway handshake
  (#20)"), content-verified against `canonical/main` by sha256-comparing
  `src/homeserver/learning-task-contract.ts` and `src/homeserver/gateway.ts` on 2026-07-19.
- `/srv/gille-inference` — previously documented in `AGENTS.md` as the live path — **does not
  exist** on the box and is not this unit's `WorkingDirectory`. That claim was wrong; this section
  is now the source of truth. (`CONTRIBUTING.md` also uses `/srv/gille-inference` as a *reserved
  placeholder path* for docs/tests, the same way it uses `example.com` — that usage is intentional
  and unrelated to this correction.)

### Deploying

```bash
# from a clean checkout of canonical/main (or a worktree of the exact commit you intend to ship)
scripts/deploy-gateway.sh deploy
```

The script (issue #23) is the repo-owned replacement for manual rsync + restart + hand-checked
hashes. It fails closed: it refuses a dirty or non-addressable source tree, refuses when the live
unit's `WorkingDirectory` doesn't match what it's about to sync into, seeds `docs/m5-routing.json`
copy-if-absent without ever overwriting a live/adopted table (issue #44), preflights the ExecStart
interpreter before restarting (issue #30 — see below), restarts the unit only when the payload
actually changed, probes local health (best-effort) and tailnet health plus an authenticated
capability endpoint, and writes `.deployed-commit` with the exact 40-char SHA **only** after every
check passes — any failure leaves the marker absent rather than certifying an ambiguous state.

A real deploy needs three env vars with no safe default (the script refuses to "certify" a
deployment it did not actually probe):

| Var | Purpose |
|---|---|
| `DEPLOY_HEALTH_TAILNET_URL` | `http://<tailnet-ip>:8080/healthz` — export it locally; never commit the literal address |
| `DEPLOY_CAPABILITY_URL` | `http://<tailnet-ip>:8080/v1/capabilities/learning-task` — cheap authenticated smoke test, no model call |
| `HOMESERVER_OWNER_KEY` (or the var named by `DEPLOY_CAPABILITY_KEY_ENV`) | An owner-tier bearer key. Read from the environment; never printed, logged, or passed on the command line. |

`DEPLOY_HEALTH_LOCAL_URL` has **no default** (issue #30 — the gateway binds only the tailnet
interface, so a default loopback probe could never legitimately answer); set it explicitly only if
something in your environment actually listens on loopback. `DEPLOY_HEALTH_TAILNET_URL` above is
the mandatory probe of the box's real listener and is unaffected.

`DEPLOY_REMOTE_HOST` defaults to the `m5` ssh alias and `DEPLOY_REMOTE_DIR` defaults to
`/home/magnus/home-server-eval`; override either if the live topology ever changes. Run
`scripts/deploy-gateway.sh --help`, or read the script's own header comment, for the full env var
list, the exact rsync exclude list (and why each entry is there — native `node_modules` are never
shipped from the operator's laptop; they're installed fresh on the box), and the fail-closed
marker-invalidate/write ordering.

**Routing-table adoption survives deploys (issue #44).** `docs/m5-routing.json` is excluded from
the main rsync and only ever seeded with `rsync --ignore-existing` afterward: a fresh box with no
table gets the committed copy; a box with any existing table — including one written by the #7
routing-lifecycle CLI's `adopt` — is never touched. Before this fix, every deploy silently reverted
an adopted table back to whatever happened to be committed (see "Adopting a routing-table change"
below).

**ExecStart interpreter preflight (issue #30).** The unit's `ExecStart` runs `tsx`
(`node_modules/.bin/tsx`), which is production runtime, not a dev-only tool — `npm ci --omit=dev`
used to strip it, so a restart crash-looped with `203/EXEC` until a manual full `npm ci`. `tsx` now
lives in `package.json`'s `dependencies` (not `devDependencies`), so the default install keeps it;
belt-and-braces, the script also refuses to restart the unit at all if the live `ExecStart`
interpreter is missing or not executable right before every restart, leaving the box on its
last-good build instead of crash-looping.

Preview any deploy first:

```bash
scripts/deploy-gateway.sh dry-run
```

`dry-run` prints the exact plan (including the literal rsync command) and still performs the
read-only `WorkingDirectory` check, so a path mismatch is caught before a real deploy would hit it.
Add `DEPLOY_DRY_RUN_OFFLINE=1` for a fully offline plan (no network at all).

### Verifying what's actually deployed

```bash
scripts/deploy-gateway.sh verify
```

Read-only — never syncs, restarts, or writes anything. Reports the `.deployed-commit` marker plus a
content spot-check (sha256 of `src/homeserver/learning-task-contract.ts` and
`src/homeserver/gateway.ts` against that commit in your local checkout), so a stale marker or a
hand-edited file on the box shows up as an explicit `MISMATCH` instead of a false green.

### Rollback

The unit is not a git checkout, so "rollback" means **redeploy a known-good commit**, not
`git revert` on the box:

```bash
git worktree add /tmp/gille-rollback <known-good-sha>   # e.g. 8caf400, the current baseline
cd /tmp/gille-rollback
npm ci
scripts/deploy-gateway.sh deploy
```

The current known-good baseline is **`8caf400`**. Update this line whenever a new deploy is
accepted (i.e. whenever `.deployed-commit` changes on the box), so a future rollback always has a
concrete target without needing to reconstruct one — the box itself keeps no deploy history.

### MCP-restart caveat

The gateway process also serves `/mcp` (`src/homeserver/mcp.ts`). A restart drops every live MCP
transport — Claude Code / Codex sessions reconnect on their next call, but anything mid-flight over
that specific connection is interrupted. **Async `code_loop` jobs are not affected**: they persist
in the durable SQLite store (`src/homeserver/code-loop.ts`) and survive the restart; only the live
transport, not the job, is dropped. `scripts/deploy-gateway.sh deploy` restarts only when rsync
actually transferred a content change (or `DEPLOY_FORCE_RESTART=1`), specifically to avoid
unnecessary MCP churn on a no-op deploy.

### Credential-safe authenticated capability smoke test

`scripts/deploy-gateway.sh deploy`'s capability probe calls
`GET /v1/capabilities/learning-task` with `Authorization: Bearer $HOMESERVER_OWNER_KEY` (the env
var name is configurable via `DEPLOY_CAPABILITY_KEY_ENV`) and checks only the HTTP status code. The
key is read from the environment, never placed on the command line, and never appears in the
script's stdout/stderr (covered by a regression test in `tests/deploy-gateway.test.ts`). Run the
same check by hand for a one-off:

```bash
curl -fsS -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer ${HOMESERVER_OWNER_KEY}" \
  "http://<tailnet-ip>:8080/v1/capabilities/learning-task"
```

### Adopting a routing-table change (routing-lifecycle-cli.ts)

`scripts/routing-lifecycle-cli.ts` (issue #7) is the reviewed GENERATE → VALIDATE → REVIEW →
DEPLOY/RELOAD → CANARY → ROLLBACK lifecycle for `docs/m5-routing.json`. `review` never mutates
anything; `adopt` is the only mutating command and requires a recorded human approval
(`--approved-by`/`--reason`/`--decision-ref`) — there is no flag that skips it.

**First live adoption (2026-07-20, grimnir#88) found two operability gaps, both caught safely by the
fail-closed rollback with zero production impact** — issues #37 and #38 fixed both:

1. **The live #6 calibration gate is now wired in.** `review` (and `adopt`'s re-validation) evaluate
   the current calibration gate from ledger evidence instead of defaulting to `null`. A `null` or
   `HOLD` gate is most restrictive and REFUSES any route change explained only by organic-judge
   evidence — this was already true of the underlying `validateCandidate` logic; #37 was that the
   CLI never sourced a live gate to check it against. Pass `--calibration-gate <path>` to use a
   specific, previously human-reviewed decision (e.g. one with a recorded `enabling`) instead of the
   live computation.
2. **`adopt` now resolves the gateway URL and admin key without manual flags**, so a cron/no-flag
   adoption on the box works once the environment below is set:
   - **Gateway URL** — `--gateway-url` (explicit) > `GATEWAY_URL` env (explicit) > the gateway's OWN
     configured listener (`HOMESERVER_HOST`/`HOMESERVER_PORT`, the exact host/port `gateway.ts`
     binds — see `resolveGatewayUrl` in the script). In the live deployment `HOMESERVER_HOST` is
     already set to the box's tailnet interface (issue #23), so this now resolves the REAL listener
     automatically instead of defaulting to `http://127.0.0.1:8080` while the gateway binds only the
     tailnet address.
   - **Admin key** — `ROUTING_LIFECYCLE_ADMIN_KEY` is checked first; `HOMESERVER_OWNER_KEY` (the same
     owner-tier bearer-key convention this runbook already uses for the capability smoke test above)
     is the fallback. **Neither is guaranteed to be present in the deployed gateway `.env` today** —
     confirm on the box and add whichever is missing:
     ```bash
     tsx src/homeserver/cli.ts keys mint --alias routing-lifecycle-cli --tier owner
     # add the printed key to /home/magnus/home-server-eval/.env as ROUTING_LIFECYCLE_ADMIN_KEY=<key>
     # (or reuse an existing HOMESERVER_OWNER_KEY value already exported for deploy-gateway.sh)
     ```
     A missing key produces an actionable `reload-failed` error naming both env vars — never a
     hardcoded/fabricated key, and never a silent skip of authentication.

**What the deployed `.env` must contain for a zero-flag/cron `adopt`:** `ROUTING_LIFECYCLE_ADMIN_KEY`
(or `HOMESERVER_OWNER_KEY`) set to an owner-tier bearer key, and `HOMESERVER_HOST` set to the box's
tailnet interface (already true per the "Access-control posture" note above this file). Nothing else
is required — `--gateway-url` and `--calibration-gate` remain available as explicit overrides for a
one-off or non-standard run.

```bash
# review (dry-run, safe to run any time — never mutates anything)
tsx scripts/routing-lifecycle-cli.ts review --out /tmp/routing-review.json

# adopt (the ONLY mutating command — requires a human-recorded approval)
tsx scripts/routing-lifecycle-cli.ts adopt --artifact /tmp/routing-review.json \
  --approved-by <name> --reason "<why>" --decision-ref <issue/PR>
```

## Configuration

All knobs are environment variables — see [`env.example`](./env.example).
The ones that shape best-effort behaviour:

| Var | Default | Meaning |
|---|---|---|
| `HOMESERVER_PORT` | `8080` | gateway listen port (loopback) |
| `HOMESERVER_MAX_INFLIGHT` | `2` | global GPU slots; guests get `503` past this |
| `HOMESERVER_OWNER_QUEUE_MAX_MS` | `5000` | how long an owner request may queue before `503` |
| `HOMESERVER_BUSY_RETRY_AFTER_S` | `2` | `Retry-After` seconds on `503` |
| `HOMESERVER_PER_REQUEST_MAX_TOKENS` | `12288` | fleet default and ordinary-model hard `max_tokens` cap |
| `HOMESERVER_MODEL_MAX_TOKENS` | `vibethinker-3b=32768` | comma-separated exact-model explicit-request ceilings; omitted requests still use the fleet default |
| `HOMESERVER_KEY_DEFAULT_{RPM,TPM,DAILY_TOKENS,MAX_PARALLEL}` | `60 / 60000 / 0 / 1` | quota defaults for newly-minted keys |

> **Note on `DAILY_TOKENS=0`** — `0` means *unlimited*. For guest keys you
> almost always want an explicit non-zero `--daily` at mint time, so a leaked
> key is damage-capped (see `SLA.md` §6). The mint command takes per-key
> overrides; the env defaults are just the fallback.

## Post-deployment evolution

The M5, Qwen3-Coder-Next-80B, llama-swap backend, production gateway, and load/soak gates are live.
Current work concerns evidence quality, routing policy, model-roster evolution, and trust-aware
fallback rather than arrival provisioning. See [`../docs/ROADMAP.md`](../docs/ROADMAP.md) and the
repository's open issues.

## See also

- [`ONBOARDING.md`](./ONBOARDING.md) — what you send a friend.
- [`SLA.md`](./SLA.md) — the published best-effort service level.
- [`../src/homeserver/README.md`](../src/homeserver/README.md) — component internals + full gateway API table.
