# Image / Vision / Text tiers on the M5 — Phase 2 & 3 runbook (GATED)

This is the **operator runbook** for bringing the new modalities live on `inference.example.com`. The
**gateway code (Phase 1)** is already merged and is **inert** until `HOMESERVER_IMAGE_URL` is set —
so nothing here changed the live box. The steps below are **box-ops**: they touch the production M5,
`sudo`, experimental ROCm nightlies, and a production restart. Run them in a hands-on session, not
autonomously.

> **Top risk — ROCm #6182 (gfx1151 / kernel 7.0.x):** unrecoverable HSA "Memory in use" on large HIP
> model loads, no fix across ROCm versions, while **Vulkan works**. The T2I backend may not run under
> ROCm on this box. The acceptance gate below is a *real FLUX generation* — if it reproduces #6182,
> fall back to the **Vulkan `sd-server` + `--vae-on-cpu`/tiled-VAE** path (the Vulkan failure is the
> final VAE alloc, which CPU/tiled VAE sidesteps).

---

## Tier → model map (advertise these ids)

| Modality | fast | balanced | high |
|---|---|---|---|
| **T2I** (`/v1/images/generations`) | `image-fast` = SDXL-Turbo / Z-Image-Turbo | `image-balanced` = SD3.5-Large-Turbo GGUF | `image-high` = **FLUX.1-schnell (Apache-2.0, default)** / FLUX.1-dev (non-commercial) |
| **I2T** (vision, `/v1/chat/completions`) | `vision-fast` = Moondream2 | `vision-balanced` = reuse gemma-4-26B+mmproj / Qwen2.5-VL-7B | `vision-high` = InternVL3-14B / Qwen2.5-VL-32B |
| **T2T** (`/v1/chat/completions`) | `text-fast` = Mellum | `text-balanced` = Qwen3-Coder-Next-80B | `text-high` = gpt-oss-120b |

**License flag:** FLUX.1-dev / FLUX.2-dev are **non-commercial** — expose them only behind owner keys
or a non-commercial banner. The commercial-safe default high tier is **FLUX.1-schnell**.

---

## Phase 2 — I2T (vision) + T2T tiers (config-only; no gateway code)

Vision already works via llama.cpp multimodal over Vulkan; the chat proxy passes `image_url` parts
through unchanged. T2T tiers are llama-swap aliases. **This is a `config.yaml` edit + a llama-swap
restart (a production blip) → gated.**

1. Add the vision entries (`-m … --mmproj …`) and T2T `aliases:` to the box's llama-swap
   `config.yaml`.
2. `ssh m5 'sudo systemctl restart llama-swap'` — verify `GET /v1/models` on `:8091` lists the new
   ids, and the gateway's `GET /v1/models` reflects them (chat backend is auto-discovered).
3. **Dogfood I2T end-to-end:** `POST /v1/chat/completions` with an `image_url` part against the box —
   validates the vision tier with no new backend.

---

## Phase 3 — T2I backend on the box (the sd-server sidecar)

1. **ROCm userspace only** (TheRock nightly for gfx1151). **Never** touch `amdgpu-dkms` / RADV.
   Prefer the kyuz0 strix-halo toolbox container for isolation + trivial rollback. Snapshot first:
   `dpkg -l | grep -E 'rocm|amdgpu|mesa'`.
2. **Acceptance gate (do this BEFORE committing the tier):** generate a *real FLUX image*, not just
   `rocminfo`. If #6182 reproduces → switch to the **Vulkan `sd-server` + `--vae-on-cpu`/tiled-VAE**
   build; consider kernel 6.18.9+.
3. **`sd-server`** (stable-diffusion.cpp; OpenAI-shaped `POST /v1/images/generations`) as
   `image-server.service` on `127.0.0.1:8093`, env `HSA_USE_SVM=0 HSA_ENABLE_SDMA=0`
   (+ `HSA_OVERRIDE_GFX_VERSION=11.5.1` only if needed). Mirror `whisper-server.service`.
   **Loopback-only.**
4. **Models** (~65–75 GB): T2I shared (t5xxl / clip_l / vae) + per-tier weights.
5. **Wire the gateway:** rsync the repo to `/srv/gille-inference` (per the CLAUDE.md deploy
   block — never sync `data/` or `.env`), then in `.env` set:
   ```
   HOMESERVER_IMAGE_URL=http://127.0.0.1:8093
   # optional overrides — see deploy/env.example for the full list:
   HOMESERVER_IMAGE_MODEL_FAST=sdxl-turbo
   HOMESERVER_IMAGE_MODEL_BALANCED=sd3.5-large-turbo
   HOMESERVER_IMAGE_MODEL_HIGH=flux.1-schnell
   ```
   `ssh m5 'sudo systemctl restart home-gateway'` — verify `GET /v1/models` now lists
   `image-fast/balanced/high`, and a fast-tier `POST /v1/images/generations` returns `200` with
   `data[].b64_json`.

### Concurrency note (already handled in code)
The gateway runs a **single-slot diffusion worker** that acquires the shared admission slot (owner
lane) only around the sidecar dispatch. So a 1–5 min FLUX job never wedges the 2-slot LLM budget:
owner chat preempts, an honest guest at cap gets `503 + Retry-After`. Per-job timeout is
`HOMESERVER_IMAGE_JOB_TIMEOUT_MS`.

---

## Phase 3.5 — update the public portal (do this WITH the deploy, not before)

`src/homeserver/portal.html` is the public face of what is **actually served**. Phase 1 deliberately
did **not** touch it (the routes 404 until the env is set — advertising them would be a lie). The
moment `HOMESERVER_IMAGE_URL` is live, update the portal in the **same** change:

- **"What's running":** add a Text→Image paragraph (the three tiers, that high-tier/FLUX is async and
  may take 1–5 min, the per-image pricing, and the FLUX.1-dev non-commercial caveat if exposed).
- **"How to use it":** add a `curl` example for `POST /v1/images/generations` (fast sync) and the
  `imgjob_…` poll/cancel flow for the async tiers; note `response_format` is `b64_json` only.
- Keep `src/homeserver/README.md`'s endpoint table + `docs/gateway-api-contract.md` consistent (these
  were already updated in the Phase 1 PR).

> **Deploy caveat:** `portalHtml()` caches the file in memory at first request, so a portal-only edit
> is **NOT** zero-downtime — it needs `sudo systemctl restart home-gateway`.

---

## Verification checklist (on the box, after Phase 3)

- [ ] `GET /v1/models` lists `image-fast`, `image-balanced`, `image-high` (and the vision/T2T ids).
- [ ] Fast tier: `POST /v1/images/generations {model:"image-fast"}` → `200` with `b64_json`.
- [ ] Async tier: `POST {model:"image-high"}` → `202 imgjob_…`; `GET …/jobs/{id}` → `succeeded` + data.
- [ ] Cancel: `DELETE …/jobs/{id}` on a queued job → `cancelled`, credits refunded.
- [ ] Overdraft: a near-cap guest key → `402` with no sidecar hit.
- [ ] Owner chat still responsive while a FLUX job runs (preempt works); a capped guest gets `503`.
- [ ] `GET /metrics` shows `homeserver_images_total{model="…"}`; no prompt/bytes anywhere in
      `request_log` / metrics / a guest's owner-log.
- [ ] Portal "What's running" + docs reflect the live tiers.
