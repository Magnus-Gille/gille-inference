# Ornith-1.5-35B-A3B M5 release decision

Date: 2026-08-19

## Decision

Serve `ornith-1.5-35b` as an **explicit authenticated M5 model**. It is **not** an automatic
route: the generated routing table (`docs/m5-routing.json`) is generator-owned and was not
regenerated or hand-edited, so no traffic reaches this model unless a caller names it.

Owner explicitly authorized the roster change and restart on 2026-08-19 after being shown the
exact mutation object (target file, additive diff, Hub-verified artifact hash, runtime pin,
restart command, and rollback recipe). This mirrors the `qwen38-27b` precedent: qualify as an
explicit model first, defer any automatic route until the common coding-agent suite has compared
it against the incumbents.

### Prior-family history (issue #141)

Ornith-**1.0**-35B was evaluated on this box on 2026-07-05 and deliberately left
downloaded-but-unserved. The weekly Scout auto-eval returned verdict "winner" (probe passRate 1.0,
~68 tok/s), and a Gate-D head-to-head scored **Ornith-1.0-35B 8/10 vs qwen3.6-35B-A3B 9/10** on a
single seed — a statistical tie, with Ornith ~25% faster. The recorded conclusion was "validated
peer, don't displace qwen3.6 on 1-seed evidence," and promotion was explicitly reserved as the
owner's call. That 1.0 entry had been served from a `scratch` path on the unpinned dev build and
is absent from the current roster. The present release supersedes it with a stable model path and
a pinned runtime. The 8-vs-9 tie was never broken by a 3-seed rerun; that obligation carries
forward to 1.5 and is unresolved.

## Immutable inputs

- Official model: `ornith-ai/Ornith-1.5-35B-A3B`
- Model repo revision: `fbb995a79eedd569a5edc5f2af9644c0fa1124fc`
- GGUF repo: `ornith-ai/Ornith-1.5-35B-A3B-GGUF`
- GGUF repo revision: `5ae357e3eaf951ae221e8d784c71a8a3cdb6aa5f`
- Architecture: `Qwen3_5MoeForConditionalGeneration` (`qwen3_5_moe`), hybrid linear/full attention
  (full attention every 4th layer), 40 hidden layers, 256 experts / 8 active per token,
  35,951,822,704 total parameters (~35.5B total, MoE), one native MTP layer
  (`mtp_num_hidden_layers: 1`), 262,144-token native context, multimodal (vision) via a separate
  projector
- llama.cpp runtime: reused pinned release `9b05354ec6fb58b4e665e9a39ebc40285c015638` (same
  runtime qualified for `qwen38-27b` on 2026-08-14) — no rebuild required; the architecture is
  natively recognized (`qwen35moe` in `llama-bench` output)
- Relocatable Vulkan `llama-server` SHA-256:
  `ca3417ae3bd777f9e84a92f83dd2b64ea9e9cf95eebef5a4e78953f3cbd659d9` (byte-identical to the
  `qwen38-27b` release binary; origin-relative RUNPATH `$ORIGIN:` reconfirmed via `readelf -d`)
- Q4_K_M GGUF SHA-256: `ca6ea26329c88b78ffd90a85163be2e746c2fafd1024f56db47e499f117f9a7f`
  (21,713,462,848 bytes) — verified byte-for-byte against the Hub's published LFS OID
- BF16 multimodal-projector SHA-256:
  `d9ce31026d1cb1f3f8d5152e2e2a014d9d2b302b6c93a7dc07bb0a0487f52837` (902,822,016 bytes) —
  likewise verified against the Hub's published LFS OID
- Staged at `/home/magnus/models/ornith-1.5-35b/` on the M5 box (not a production path; not
  wired into `/etc/gille-inference/llama-swap/config.yaml`)

## Conversion and parity

The GGUF was pre-quantized upstream by `ornith-ai`, not converted in-house, so there is no
in-house BF16-vs-Q4_K_M parity pipeline to run for this release (unlike `qwen38-27b`, where the
GGUFs were built from the official safetensors). Parity evidence is narrower as a result:

- **Integrity**: both downloaded files' SHA-256 match the Hub's published LFS object hashes
  exactly — the bytes are the ones `ornith-ai` published, not corrupted or substituted.
- **Functional canary only**: one deterministic (temperature 0) coding prompt against the served
  Q4_K_M weights produced correct, well-formed output (a working memoized Fibonacci function) with
  a coherent separate `reasoning_content` block. This is a coherence check, not a quantization-loss
  measurement — no BF16 reference was run (the 71.1 GB BF16 file was not downloaded; disproportionate
  for a staging canary).
- Multimodal (image) input was not exercised despite the mmproj being wired into the canary server.

## Measured M5 result

All GPU runs used the repository-owned FIFO lease (`npm run homeserver -- gpu run`). No live
roster or service was changed; both runs targeted a standalone `llama-server` on a local
non-production port (18099), never `llama-swap`'s `:8091`.

| Arm | Prompt processing | Generation | Notes |
|---|---:|---:|---|
| Q4_K_M, Vulkan, ngl 999, pp512/tg128 | 1100.42 ± 5.36 tok/s | 76.59 ± 0.62 tok/s | 3 repeats, `llama-bench` |
| Q4_K_M, Q8 KV, 65536 ctx, native MTP depth 2, one coding canary | 68.04 tok/s (32-token prompt) | 84.49 tok/s effective | 66/104 draft tokens accepted (63.5%) |

The bare `tg128` throughput (76.59 tok/s) is already far above the dense `qwen38-27b` baseline
(12.87–23.21 tok/s) because only ~3B of the 35.5B total parameters are active per token; native
MTP lifts effective generation further (84.49 tok/s on the canary) at a draft-acceptance rate
comparable to the `qwen38-27b` range (57.6–71.2%). The pp512 figure is a bulk-prompt bench control,
not comparable to the 32-token canary's prompt-processing number.

Server startup, health check, one completions request, and shutdown all passed; the GPU lease was
acquired and released cleanly (`gpu status` reported idle immediately after).

## Serving contract (proposed, unvalidated for production)

- ID: `ornith-1.5-35b`
- Q4_K_M weights plus BF16 multimodal projector, 1,024-token minimum per image (same grounding
  floor as `qwen38-27b`)
- Vulkan / Mesa RADV, all layers offloaded
- 65,536 context (a conservative ceiling relative to the model's 262,144-token native window —
  not stress-tested at long context in this canary)
- Q8_0 K and V cache, Flash Attention on, one slot, ubatch 512, 2 GiB prompt cache
- Native MTP, draft depth 2
- Thinking on by default (model emits a `<think>…</think>` block); `llama-server` auto-detected
  and populated `reasoning_content` without an explicit `--reasoning-format` flag in this canary —
  production serving should still pass `--reasoning-format auto --reasoning auto` explicitly for
  robustness, matching the `qwen38-27b` contract
- Per-request `chat_template_kwargs: {"enable_thinking": false}` override was **not** tested in
  this canary — assumed available by template convention, not verified

```yaml
"ornith-1.5-35b":
  cmd: |
    <runtime-root>/releases/9b05354ec/bin/llama-server
    --host 127.0.0.1 --port ${PORT}
    -m <model-root>/ornith-1.5-35b/Ornith-1.5-35B-Q4_K_M.gguf
    -mm <model-root>/ornith-1.5-35b/mmproj-Ornith-1.5-35B-BF16.gguf
    --image-min-tokens 1024
    -ngl 999 -ub 512 -c 65536 -np 1 --jinja -fa on
    --spec-type draft-mtp --spec-draft-n-max 2
    --reasoning-format auto --reasoning auto
    --cache-ram 2048 -ctk q8_0 -ctv q8_0
  ttl: 1800
```

This stanza mirrors `llama-swap-large-models.example.yaml`'s placeholder convention
(`<runtime-root>`, `<model-root>`) and is not directly deployable; resolving the real paths and
applying it is the roster-change ceremony described below.

## Deployment record (2026-08-19)

Applied to the live roster on M5 under explicit owner authorization.

- **Backup**: `/home/magnus/llama-swap/config.yaml.bak.pre-ornith15-20260819-174745` (live config
  copied before any write, following the box's existing backup convention)
- **Change**: additive only — the stanza above appended to
  `/etc/gille-inference/llama-swap/config.yaml`; no existing model entry was modified. Candidate
  was YAML-validated (12 models parsed) and diffed against live before writing.
- **Permissions preserved**: written via `install -o root -g gille-llama-swap -m 0640`; applied
  bytes verified identical to the reviewed candidate (`cmp`).
- **Service**: `systemctl restart llama-swap` — active, restarted 17:48:53 UTC. Systemd memory
  limits were already in force and unchanged (`MemoryMax` 96 GiB, `MemorySwapMax` 0,
  `OOMPolicy=kill`).
- **Traffic impact**: none observed — `/running` was empty and no `llama-server` process was live
  at restart time.

Post-deploy verification:

| Check | Result |
|---|---|
| llama-swap model list | 12 models, `ornith-1.5-35b` present |
| Direct completion (llama-swap :8091) | correct linked-list reversal code |
| `reasoning_content` populated | yes — the `--reasoning-format auto --reasoning auto` delta did not regress it |
| Generation throughput (served config) | 74.97 tok/s, 145/260 draft tokens accepted (55.8%) |
| Regression: `qwen38-27b` still serves | yes — returned `OK`, model swap clean |
| Gateway `/healthz` (tailnet) | 200 |
| Gateway `/v1/models` unauthenticated | 401 — auth spine intact |
| **Authenticated gateway completion** | **PASS** (2026-08-20) — see below |

At deploy time the authenticated end-to-end probe was **not** performed: `HOMESERVER_OWNER_KEY` is
supplied from the operator's own environment and is deliberately not stored on the box, so that
session had no owner credential and did not attempt to obtain one.

**Closed on 2026-08-20** over the owner-authenticated M5 MCP path (`m5.list_models` / `m5.ask`,
which carries an owner-tier key to the gateway). `list_models` returned 12 models including
`ornith-1.5-35b`, and a temperature-0 `ask` returned a correct linked-list reversal
(26 prompt / 156 completion tokens, `finish_reason: stop`, `metered: true`). The owner-key →
gateway → model path is therefore exercised end to end. The equivalent raw-curl form:

```bash
« replace 100.64.0.10 with the M5's real tailnet address »
HOMESERVER_OWNER_KEY=… curl -sS http://100.64.0.10:8080/v1/chat/completions \
  -H "Authorization: Bearer $HOMESERVER_OWNER_KEY" -H 'Content-Type: application/json' \
  -d '{"model":"ornith-1.5-35b","messages":[{"role":"user","content":"ping"}],"max_tokens":16}'
```

Rollback (≈5 s, if needed):

```bash
sudo install -o root -g gille-llama-swap -m 0640 \
  /home/magnus/llama-swap/config.yaml.bak.pre-ornith15-20260819-174745 \
  /etc/gille-inference/llama-swap/config.yaml && sudo systemctl restart llama-swap
```

This rollback path was **not** exercised; it is the inverse of the verified-working apply command
against a byte-verified backup, not a tested recipe.

## Gate-D head-to-head (2026-08-19)

3 seeds × 10 tasks, `ARMS=pi`, harness held constant, run against `gate-d/check.sh` **after** the
#218 fix (every pi-arm run before that fix failed `G0-files` on the harness's own output).

| Arm | Pass | Median | Mean | Failure |
|---|---|---|---|---|
| ornith-1.5-35b, all 30 rows (**mixed transport**) | 29/30 | 29 s | 109 s | 1 `arm-error` (600 s cap) |
| qwen36-a3b, 30 rows (loopback) | 29/30 | 23 s | 24 s | 1 `G2-no-edit` |
| **ornith, 23 loopback rows only** | **23/23** | 22 s | 28 s | — |
| ornith, 7 gateway-via-Mac rows (excluded) | 6/7 | 354 s | 373 s | 1 `arm-error` |

**The headline 29/30-vs-29/30 is contaminated and must not be quoted as a clean result.** Ornith's
30 rows mix two transports: 7 carried over from a gateway-via-Mac run and 23 from box loopback.
qwen36 is uniformly loopback.

Two conclusions survive the contamination:

1. **Transport, not reasoning, dominated wall-clock.** Identical model and tasks: median 354 s via
   gateway-from-Mac versus 22 s on box loopback — ~16×. An earlier hypothesis in this session that
   Ornith was slow *because* it is a reasoning model was wrong; the loopback median is
   indistinguishable from non-reasoning qwen36 (22 s vs 23 s). Ornith's single failure was a 600 s
   cap hit on the slow path and would likely have passed on loopback.
2. **Gate-D r1 no longer discriminates between these two models.** Both sit at the ceiling
   (23/23 and 29/30). The #141 8-vs-9 tie is **not broken** — the battery is saturated, so a
   3-seed rerun cannot separate them. Breaking the tie needs a harder corpus (the r2 holdout set),
   not more seeds of r1.

Coverage caveat: the 23-row loopback subset covers tasks 03–10 only; tasks 01–02 exist solely as
gateway rows. So `23/23` is not full-battery coverage and is not directly comparable to qwen36's
30-row figure.

Raw rows: `data/gate-d-{ornith-1.5-35b,qwen36-a3b}-20260819.jsonl`.

## Remaining proof

The model is now reachable by name, but its *quality* is barely characterized. Serving it is not
evidence that it should be used. Outstanding before any route change or displacement of an
incumbent:

- **The 8-vs-9 Gate-D tie from #141 is still unbroken**, and the 3-seed rerun recorded above is
  why: both arms sit at the r1 ceiling (ornith 23/23 loopback, qwen36 29/30), so more r1 seeds
  cannot separate them. The specific missing measurement is a **harder corpus** — the r2 holdout
  set (`GATE_D_INCLUDE_HOLDOUT=1`) — not additional r1 repetitions. Beyond that battery the only
  quality signal for 1.5 is a single deterministic coding prompt.
- A broader comparison against the current production tiers (`gpt-oss-120b`, `qwen38-27b`) on the
  common coding-agent suite.
- KV-quant A/B (Q8_0 vs F16) — not measured here, unlike `qwen38-27b`'s explicit comparison. Q8_0
  was chosen by analogy to that release, not by measurement on this model.
- Long-context behaviour: served at 65,536 against a 262,144-token native window, never tested
  above a few hundred tokens.
- Multimodal: the projector is wired into the live stanza but **no image request was ever sent**,
  either in staging or post-deploy. Vision is configured-but-unverified.
- Per-request `enable_thinking: false` override — assumed by template convention, still untested.
- ~~The authenticated gateway probe recorded above.~~ Closed 2026-08-20 (see the deployment record).
- A private `grimnir-ops` entry recording this deployment, its backup path, and rollback recipe as
  durable operational state.
