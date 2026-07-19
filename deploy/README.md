# Deploying the BosGame M5 home-inference gateway

Operator runbook for exposing the home-inference box to a handful of trusted
external users (best-effort), while keeping your own overnight work first-class.

Hardware anchor: **BosGame M5 — AMD Ryzen AI Max+ 395 "Strix Halo", 128 GB
unified LPDDR5X** (single serial compute stream; ~215–256 GB/s; MoE-first).

## Topology

```
friend ──HTTPS──▶ Cloudflare edge ──Tunnel (outbound-only)──▶ 127.0.0.1:8080
                  (TLS, DDoS, WAF)        cloudflared            gateway.ts
                                                                  │ auth (per-key bearer)
                                                                  │ admission (owner ≻ guest → 503)
                                                                  │ quota (RPM/TPM/daily → 429)
                                                                  ▼
                                                          127.0.0.1:8091  llama-swap / llama-server
                                                          (one iGPU, serial)
```

**Security invariant:** the gateway and the model backend bind **loopback only**.
The *only* inbound path is Cloudflare Tunnel → gateway. There are **no open
ports** on the box or router. If you ever set `HOMESERVER_HOST=0.0.0.0`, the
gateway refuses to start unless at least one API key (env or minted) exists.

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
