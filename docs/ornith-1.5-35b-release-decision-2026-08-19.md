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

### Contamination audit of the #218 regression window (2026-08-20)

PR #219 flagged an open question: every pi-arm Gate-D run between 2026-08-15 and the fix failed
`G0-files` on the harness's own output, so did any of those invalid rows get ingested as model
capability signal? Audited all three sinks. **None was contaminated.**

| Sink | Verdict | Basis |
|---|---|---|
| Capability ledger (`delegations`) | **clean** | 4,520 rows; zero contain `gate-d` or `g0-files` in `verifier`, `task_type`, `model_id`, `source`, `notes`, or `error_class`. Every row since 2026-08-14 has `source` of `mcp-ask` or `code-loop`. The 6 `ornith` rows are `mcp-ask` with `verifier` NULL and `outcome='unverified'` — structurally incapable of carrying a pass/fail verdict |
| `docs/m5-routing.json` | **clean** | Committed exactly once (initial public release) with `generatedAt` 2026-07-07 — five weeks before the regression — and never modified since. Independently, Gate-D is not among its four declared `sources` |
| Model-Scout registry | **clean** | 8 entries, newest 2026-07-27, all predating the regression. Verdicts derive from `probe-runner` pass rates, never from Gate-D |

The structural reason is stronger than the row counts: **Gate-D has no write path into any of them.**
The `pi` arm calls the plain OpenAI-compatible chat-completions endpoint, while `recordDelegation()`
is reachable only from the orchestrator's `/delegate`, `code-loop`, MCP, deep-research, and
cartography. `check.sh`'s verdict is written to a local JSONL row and never returns to the gateway,
so a Gate-D grade — correct or spurious — cannot become capability evidence by any route.

Two incidental findings surfaced during the audit and are **not** fixed here:

- **`EVAL_DB_PATH` is an operator trap.** The gateway unit sets
  `EVAL_DB_PATH=/home/magnus/home-server-eval/data/eval.db`, but systemd
  `BindPaths=/var/lib/gille-inference/gateway/data:/home/magnus/home-server-eval/data:rbind`
  rebinds that directory inside the service namespace. Outside the namespace the documented path
  resolves to an unrelated 122 KB stub with 6 tables and no `delegations` table at all, while the
  live ledger (22 tables, 4,520 delegations) is at `/var/lib/gille-inference/gateway/data/eval.db`.
  Anyone auditing via the documented variable silently reads the wrong database.
- **`docs/m5-routing.json`'s provenance manifest is unresolvable.** All four `sources` cite
  `/srv/gille-inference/data/...`, a path `AGENTS.md` already records as non-existent on the box.
  The table is also six weeks stale relative to a ledger that has since roughly tripled.

## r2 holdout tie-break (2026-08-20)

The section above named the r2 holdout corpus as the specific missing measurement. It was run:
4 fresh model-unseen holdouts (tasks 11–14) × 3 repetitions × 2 models, `ARMS=pi`, box loopback
throughout, under `GATE_D_INCLUDE_HOLDOUT=1` and the post-#218 `check.sh`. Every row carries
`corpusRevision: gate-d-r2` and `holdout: true`.

| Arm | Pass | Median | Mean |
|---|---|---|---|
| ornith-1.5-35b | 8/12 (66.7 %) | 56 s | 59 s |
| qwen36-a3b | **9/12 (75.0 %)** | 36 s | 46 s |

Per task (pass/3):

| Task | ornith-1.5-35b | qwen36-a3b |
|---|---|---|
| 11-node-path-containment | 2/3 (1 × `G4-oracle`) | 3/3 |
| 12-add-csv-cli-format | 3/3 | 2/3 (1 × `G5-structural`) |
| 13-type-safe-slug-tests | 3/3 | 3/3 |
| 14-shared-handle-validation | **0/3** (3 × `G5-structural`) | 1/3 (`G4-oracle`, `G5-structural`) |

**The tie is still not broken.** Fisher's exact test on 8/12 vs 9/12 gives **p = 1.000** — a
one-run difference across twelve trials is indistinguishable from noise. The attempt reproduced
the *same* 8-vs-9 non-result as #141, for a different reason: r1 could not separate the models
because both sat at the ceiling; r2 has genuine headroom (neither model is near 12/12) but the two
land on top of each other inside it. The models also trade wins — ornith takes task 12, qwen36
takes 11 and 14 — which is what comparable capability with per-task variance looks like, not a
latent ordering waiting for more samples.

What r2 *did* buy is a real capability signal r1 never surfaced:

- **Cross-file wiring is a shared weakness.** Task 14 asks the model to strengthen
  `src/validate.ts` and wire it through `src/normalize.ts`; combined, the two models passed
  **1 of 6** attempts, almost all failing `G5-structural`. This is not an under-specified task —
  the required `assertValidHandle` symbol is already exported by the seed, so the contract is
  discoverable. Both models tend to strengthen the validator without importing it into the
  normalizer.
- qwen36-a3b remains meaningfully faster on the same transport (36 s vs 56 s median).

Consumption note: holdouts 11–14 are now **spent** for `ornith-1.5-35b` and `qwen36-a3b`. They are
no longer model-unseen for this pair and must not be reused as fresh evidence for either. Breaking
this tie now requires either a new holdout revision or a different discriminator — a suite that
weights multi-file wiring, where the two models are most likely to actually diverge, would be the
higher-information choice over more repetitions of anything they both already pass.

Raw rows: `data/gate-d-r2-{ornith-1.5-35b,qwen36-a3b}-20260820.jsonl` (local, gitignored).

## Remaining proof

The model is now reachable by name, but its *quality* is barely characterized. Serving it is not
evidence that it should be used. Outstanding before any route change or displacement of an
incumbent:

- **The 8-vs-9 Gate-D tie from #141 is still unbroken**, now on two independent batteries: r1
  cannot separate the models because both sit at its ceiling, and r2 — run 2026-08-20, the
  measurement previously named as missing — returned 8/12 vs 9/12 at **p = 1.000**. Both corpora
  are now exhausted as discriminators for this pair (r2's holdouts are spent). The next useful
  measurement is a *different* discriminator, not a further repetition: multi-file wiring is the
  axis where these two models are most likely to actually diverge.
- A broader comparison against the current production tiers (`gpt-oss-120b`, `qwen38-27b`) on the
  common coding-agent suite.
- KV-quant A/B (Q8_0 vs F16) — not measured here, unlike `qwen38-27b`'s explicit comparison. Q8_0
  was chosen by analogy to that release, not by measurement on this model.
- ~~Long-context behaviour~~ / ~~Multimodal~~ / ~~`enable_thinking: false`~~ / ~~authenticated
  gateway probe~~ — all four closed 2026-08-20; see **Serving-contract verification** below.
- ~~A private `grimnir-ops` entry recording this deployment, its backup path, and rollback
  recipe.~~ Filed 2026-08-20 as `grimnir-ops#4` (private tracker).

## Serving-contract verification (2026-08-20)

Every item below was an explicitly configured-but-unverified assumption in the 2026-08-19 record.
All four now have direct evidence. Requests went to `llama-swap` on the box (`:8091`) except the
gateway probe, which deliberately exercised the authenticated remote path.

| Assumption | Result | Evidence |
|---|---|---|
| Owner-key → gateway → model works | **PASS** | Owner-authenticated M5 MCP path: `list_models` returned 12 models incl. `ornith-1.5-35b`; a temperature-0 `ask` returned correct code (26 prompt / 156 completion tokens, `finish_reason: stop`, `metered: true`) |
| Vision (BF16 projector actually wired) | **PASS** | A synthetic 724×276 PNG of the four-digit number `7341` returned exactly `7341` |
| Long context above a few hundred tokens | **PASS** | Needle-in-haystack at **54,681 prompt tokens** (83 % of the served 65,536 window), needle at 62 % depth, retrieved verbatim; 108 s wall |
| Context ceiling fails closed | **PASS** | An 83,601-token request was refused with `exceed_context_size_error`, not silently truncated |
| `chat_template_kwargs: {"enable_thinking": false}` | **PASS** | Honoured. Same prompt, same correct answer: 84 completion tokens + a 171-char `reasoning_content` by default, vs **4 completion tokens and no `reasoning_content`** with the override — ~21× cheaper. Also honoured inside a multimodal request |

Two methodological notes, because both change how much the results are worth:

1. **The vision ground truth was verified before use.** The test image was rendered by a hand-coded
   5×7 bitmap font (no PIL/ImageMagick on the box) and then *looked at* before being sent — a
   buggy renderer would otherwise have scored a harness defect as a model failure.
2. **The image demonstrably reached the projector.** `prompt_tokens` was 1,070, above the
   `--image-min-tokens 1024` floor. A silently-dropped image would have produced a ~20-token
   prompt, so the token count — not just the correct answer — is what rules out a lucky guess.

Still open from this section: the KV-quant A/B (Q8_0 vs F16) remains unmeasured on this model.
