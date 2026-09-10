# llama.cpp v0.4.0 upgrade assessment (issue #280)

**Date:** 2026-09-10
**Owner:** gille-inference (serving/runtime integration)
**Issue:** [#280 — Assess software-platform updates, starting with llama.cpp v0.4.0](https://github.com/Magnus-Gille/gille-inference/issues/280)
**Recommendation:** **HOLD** — no upgrade without a fresh live baseline and measured M5 evidence (details below).
**Live changes:** none. This document is proposed assessment only: nothing here is tested or deployed.

## Candidate identity (pinned, official sources)

| Component | Candidate | Source |
|---|---|---|
| llama.cpp | `v0.4.0`, tag commit `5266f24`, published 2026-09-04 | https://github.com/ggml-org/llama.cpp/releases/tag/v0.4.0 |
| ggml (bundled) | `v0.23.0` | https://github.com/ggml-org/ggml/releases/tag/v0.23.0 |

A release tag is not proof of improvement on the M5. Every benefit claim below is a hypothesis
until measured under the bounded plan in §6. Pin immutable commits (not floating tags) for any
evaluation build.

## Version matrix (2026-09-10)

“Live” means the production M5. Exact live SHAs, build flags, operator paths, and service
versions are private deployment state and are **not** inventoried here; they belong in the
private deployment ticket per `../deploy/README.md`. `Proposed` / `tested` / `deployed` are kept
distinct throughout: this document is `proposed` only.

| Component | Repo-pinned / documented | Live (production M5) | Candidate | Evidence gap |
|---|---|---|---|---|
| llama.cpp serving runtime | `9a3bf2b84` for the 2026-07-28 `qwen35-122b-a10b` release; `9b05354ec` for the 2026-08-14 `qwen38-27b` RC (`../deploy/README.md`) | Unknown freshness from this checkout — requires private-ticket inventory | `v0.4.0` (`5266f24`) | Live build SHA, flags, backend libs; last dated public observation (`8086439`, 2026-06-17, issue #181 ops note) is stale and must not be treated as current |
| llama-swap | Reviewable example config in `deploy/`; roster is mutable production state, not a repo input | Unknown from this checkout — private ticket owns it | No change proposed | Installed version, active config digest, resident roster |
| Gateway / harness | `m5` client `1.3.5` (`client/m5-client.mjs`); gateway source at this checkout | Release-gated separately; not inventoried here | No change proposed | Live gateway release identity |
| Node/npm platform | Repo runs strict TS via `tsx`; `package.json` engines unconstrained (`20+` per `AGENTS.md`) | Unknown from this checkout | No change proposed | Live Node build, `tsx`/library versions |
| JS dependencies | `better-sqlite3 ^12.8.0`, `openai ^4.104.0`, `tsx ^4.19.0`, `zod ^3.23.0`; dev `vitest ^3.2.7`, `typescript ^5.7.0`, `@types/node ^22.13.0` (`package.json`) | N/A (source-pinned) | No change proposed | None for the assessment; upgrades split into component PRs if ever approved |
| PostCSS advisory | `postcss@8.5.8` nested under the dev-only `vitest → vite` chain; `npm audit --omit=dev` clean on 2026-09-10 in this checkout | Not a deployed inference-runtime component | No action | None — recorded here only so it is not conflated with a runtime vulnerability (per #280) |

## What v0.4.0 actually changes (official notes, M5-relevant slice)

Grouped by relevance to the M5's pinned Vulkan serving path on Strix Halo/gfx1151. PR numbers
are upstream's. Anything not listed here was judged hardware-inapplicable or out of scope;
in particular **video/multimodal input, Apple RDMA/RPC transport, and new-model support are
not M5 benefits** (the gateway has no image input path; vision is an explicit non-goal).

### Directly relevant — measure before claiming

- **Vulkan backend:** FA dequant-path fix (#28190); Strix Halo mat-vec batch tuning (#27909);
  `VK_KHR_shader_bfloat16` gating (#28155); `mul_mat_id` K-padding (#27925); view-alias
  dependency fix (#27812). Hypothesis: prompt-processing/throughput or correctness movement on
  served architectures. Requires the §6 bake-off on the M5.
- **Load/memory behavior:** on-demand lazy tensor reading + `--lazy-mode` (#27794, #27969);
  no-RAM-peak-at-load (#27483); quantizer RAM cap + row-slab streaming (#27795, #27830).
  Hypothesis: lower cold-load peak memory on 128 GiB unified memory. Measure peak RSS during
  cold load of the exact pinned models — product reasoning is not measurement.
- **KV/cache behavior:** KV-cell token tracking (#27762) with a **session/state version bump**
  (old saved state is incompatible — rollback constraint); KV-restore optimization (#27991);
  n-gram history lookup (#28040); early sequence-scan stop (#28011). Hypotheses: latency and
  long-context reuse movement. The version bump must be treated as a compatibility break in
  any rollback plan.
- **Server contract (review required, not automatic):** per-slot context limits
  (`--kv-unified-per-slot`, #24124); `preserve_reasoning` default-on (#28174); rejection of
  prefilled assistant tool calls (#27626); empty-object JSON-schema grammar fix (#28279).
  The first three can change slot semantics and prompt/tool/stream behavior for served
  thinking/tool models. Each needs a contract review against the gateway's prompt/tool/stream
  path and harness usage before any evaluation build enables it; the schema fix is a
  correctness candidate to verify through the OpenAI-compatible path, not assume.

### Notable but conditional

- **ggml 0.23.0:** sparse flash attention for DeepSeek-V4/GLM and Qwen4exp (#27970), RPC
  event/async APIs, allocation-dependency tracking. Only interesting where it overlaps served
  architectures (see #262 DwarfStar/DS4 evidence); the Qwen3.8-Flash-Next (`qwen4exp`)
  support itself is initial with optimizations pending (#27742) and that model is not served.
- **ROCm 10.0.0** (#27803) plus HIP tuning: input to the architecture-specific bake-off owned
  by #129, not a reason to switch backends. The M5 serves the pinned Vulkan path; support is
  not speed.
- **Speculation-adjacent:** DFlash2 (#27816), fused DFlash encoder (#27310), synthetic spec
  acceptance options (#27711, benchmark-only). Coordinate with #130; do not add speculative
  flags to the live roster from this issue.
- **BoringSSL update** (0.20260903.0, #28354): noted; no confirmed CVE or M5 failure is cited
  here, so it does **not** qualify as a confirmed security need for early action. If a
  security advisory lands, re-assess immediately under the security/reliability lane.

### Explicitly out of scope / deferred

- New-model support (Qwen3.8-Flash-Next initial, Nemotron-3-Puzzle, nanbeige), video/audio I/O
  options, `mtmd` multimodal helpers, UI/MCP-policy changes: hardware- or product-inapplicable
  to the M5 serving contract. They must not become M5 benefit claims.
- OS/driver/host changes (tuned profiles, kernel, IOMMU, GPU memory carve-out): owned by the
  infrastructure repository, not this ticket (see #195 for the host-profile question).

## Ranking

| Rank | Item | Expected benefit | Effort / risk | Gap |
|---|---|---|---|---|
| Defer (default) | Full v0.4.0 adoption | Unproven on M5 | High: state-format break, server-contract deltas, rebuild + requalify every served model | Live baseline freshness; all §6 measurements |
| Useful feature candidate | Vulkan Strix Halo tuning + FA fix | Possible TTFT/throughput or correctness fix on served archs | Medium: isolated eval build, no live change | §6 measurements on pinned models |
| Useful feature candidate | Lazy load + RAM-peak work | Possible cold-start peak-memory relief | Medium: same isolated eval | Peak-memory measurements, cold + warm |
| Compatibility review first | Per-slot limits, `preserve_reasoning`, prefilled-tool-call rejection, schema fix | Avoid silent contract regression; schema fix may help structured output | Low (review) then measured | Gateway/harness usage review; prompt/tool/stream verdicts |
| Performance hypotheses | KV/state work, n-gram lookup, quantizer streaming | Latency/throughput movement | Medium: same isolated eval | §6 measurements; state-compat handling |
| Security watch, no action | BoringSSL bump | Unknown | Low to track | Confirmed advisory or M5 failure — absent, so no early action |
| Development-only, no action | PostCSS 8.5.8 (dev chain) | None for serving | None | None — do not conflate with runtime |

## Bounded isolated A/B evaluation plan (reproducible)

Runs only under a separately approved resource/time envelope with the shared GPU lease held.
No live roster, routing, credential, or isolation changes. Reuses evidence from #129, #130,
#195, #212, #262 instead of starting competing GPU studies.

- **Builds:** baseline = pinned live-equivalent build from the private ticket (exact SHA +
  flags + backend libs recorded); candidate = immutable `v0.4.0` (`5266f24`) build with the
  same recorded provenance. Isolated build/run directories; never the live runtime, drivers,
  kernel, or service.
- **Models:** identical pinned artifacts, quantization, context, and serving flags per model
  (start with the currently served precision/CPU-sensitive lanes); state/session caches
  rebuilt per build (versions are incompatible across the bump).
- **Workload:** identical prompts and verifiers, including tool-call and structured-output
  cases covering the §3 server-contract deltas; cold-load and warm cases; prompt-cache
  behavior noted.
- **Metrics (raw, preserved with failed runs):** correctness/useful completion per verifier,
  TTFT, end-to-end latency, sustained throughput, cold-load peak memory, OOM/error rate with
  classified errors, cost per accepted task. No shadow projections as savings.
- **Thresholds (pre-register before measuring):**
  - **GO** (to a component-scoped rollout PR, still separately approved): correctness parity
    or better on every verifier, no contract regression on tool/stream/schema cases,
    statistically meaningful improvement on at least one operational dimension, clean
    rollback rehearsal, source/library identity checks passing.
  - **HOLD** (default): any missing baseline evidence, mixed results, unreviewed contract
    delta, or unrun rollback rehearsal.
  - **NO-GO:** correctness or contract regression, OOM/stability regression, or state-compat
    surprise outside the plan.
- **Rollback artifacts (required before any experiment):** exact previous runtime bundle
  identity, roster/config backup, restoration + health-check procedure from `../deploy/README.md`,
  and a rehearsed restore. Production installation/restart additionally requires exact
  release/target/action/verification/rollback approval; roster, routing, credentials, and
  isolation limits are preserved.

## Recommendation

**HOLD.** The candidate is real and the M5-relevant slice is worth measuring, but three facts
block any upgrade conclusion today: (1) the live baseline freshness is not established in
public evidence; (2) no v0.4.0 measurement exists on the M5's pinned models and Vulkan path;
(3) the session/state version bump and server-contract deltas make this a requalification, not
a drop-in. The next step is the §6 isolated evaluation under an approved GPU-lease envelope —
scheduled after the M2 usefulness baseline per #280 priority unless a confirmed
security/reliability issue intervenes. If approved, split implementation into
component-scoped PRs (e.g. contract review, eval harness, runtime bundle) rather than one
flag-day upgrade.

## Coordination

- #129 (Vulkan vs ROCm bake-off), #130 (speculation), #195 (host profile), #212 (LocalAI),
  #217 (transactional roster promotion), #262 (DwarfStar/DS4 requal): reuse their evidence;
  this ticket owns the cross-component assessment, not duplicate backend experiments.
- Route OS/driver/host-maintenance changes to the owning infrastructure repository and other
  services to their owners. The `./ROADMAP.md` milestone order (M2 → M3, M4/M5 tooling
  independent) is unchanged.
