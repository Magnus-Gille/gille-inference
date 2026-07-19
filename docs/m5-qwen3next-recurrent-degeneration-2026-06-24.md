# M5 resilience — Qwen3-Next `?????` degeneration on mid-stream disconnect (2026-06-24)

**Status:** Root cause identified at HIGH confidence (source-grounded against llama.cpp master).
**Fix #1 (gateway poison-clear) + Fix #2 (degeneracy watchdog) IMPLEMENTED 2026-06-24** — see the two
"Implementation" sections below. Surfaced during Gate D execution
(`docs/gate-d-execution-findings-2026-06-24.md`).

## Symptom

When a streaming client disconnects **abruptly mid-generation** from the box's
`qwen3-coder-next-80b`, the running llama-server enters a **persistent** bad state: every
subsequent `/v1/chat/completions` — even a trivial fresh `reply ok` — returns a long run of a
single repeated token (`?????…`), `finish_reason: "stop"`, normal-looking usage. It does **not**
self-recover. A model **reload** (swap out → fresh load) fully restores it.

**Discriminator:** `mellum` (full-attention MoE) on the *identical* stack never degenerates. **Only
the Qwen3-Next hybrid model does.**

## Root cause (HIGH confidence — read from llama.cpp master source)

Qwen3-Next-80B-A3B is a **hybrid** architecture: ~12 layers are **Gated-DeltaNet linear-attention**
blocks that hold a fixed-size **recurrent (SSM-style) state** in llama.cpp's separate
`llama_memory_recurrent` store — *not* the positional KV cache.

1. On client disconnect, llama-server issues `SERVER_TASK_TYPE_CANCEL` → `slot.release()` → sets
   `IDLE` + `reset()`. `reset()` only zeroes counters/text buffers; it does **not** clear the
   backend GGML buffer holding the recurrent state (this is intentional, to allow prompt-cache
   reuse via `cache_prompt`).
2. **Full-attention KV (mellum):** safe — the next request does a partial `seq_rm(p0,-1)` and
   cleanly overwrites later positions. → never degenerates.
3. **Recurrent memory (Qwen3-Next):** monolithic and **cannot be partially truncated**
   (`common_context_can_seq_rm` → `RS` type; `llama_memory_recurrent::seq_rm` can't partial-trim).
   The abrupt disconnect interrupts a decode **mid-write** to the recurrent state; `release()`/
   `reset()` leave that half-updated SSM state in the buffer, while the slot's recorded
   prompt/checkpoints describe a *consistent* state that no longer matches the physical buffer.
4. The next request's cache-reuse path tries to reuse/trim, but a partial `seq_rm` on RS-type
   memory can't scrub the dirty recurrent seed and nothing forces `clear(data=true)`. The
   corrupted SSM state feeds the forward pass → garbage hidden state → a single-token run.
5. **Reload** zero-inits the buffer → restores. `/slots/reset` would be the in-process cure but
   historically 501s (llama.cpp issue #17200), so reload is the only recovery on this build.

Box specifics: llama.cpp llama-server build **8086439** (~Jun 2026), Vulkan/RADV STRIX_HALO,
single-slot, `-ngl 99 -ub 512 -c 32768 --jinja -fa off`; llama-swap v227.

## Reproduction notes (why naive repros are negative)

A simple `curl --max-time` disconnect on a *fresh, unique* prompt does **not** reproduce it — the
mechanism needs the disconnect to interrupt a decode **mid-write** to the recurrent state **and**
the next request to hit the **cache-reuse path** (shared prefix). The original corruption happened
under real harness load (aider/pi/opencode reuse a shared system-prompt prefix across multi-turn
requests → cache-reuse active). This is why the agentic harnesses triggered it but trivial probes
didn't.

## Second, distinct finding — gateway slot wedge on concurrent abrupt disconnect

A repro that fired **two concurrent** large streams and SIGKILL'd them wedged the **gateway** into
box-wide `server_busy` (all models), persisting until a `home-gateway` restart. The llama-server
stayed healthy — so the gateway held/leaked admission slots for orphaned upstream generations that
the abrupt client disconnect didn't cancel. **This took the box fully offline for all users until
restart.** It shares a remedy with the degeneration fix: on client disconnect, the gateway should
abort/clean up the upstream work (and, for recurrent models, unload).

## Ranked fixes (from a 4-angle source-grounded research pass)

1. **Gateway proactive poison-clear (RECOMMENDED — high confidence, small effort, in OUR code).**
   `src/homeserver/gateway.ts` already detects abrupt disconnect (`res.on('close')` →
   `clientAborted`, ~3 sites) and already has `unloadModel()` (llamaswap-admin). On disconnect of a
   streaming request **to a recurrent-model allowlist** (so mellum / full-attention models are
   never reloaded), fire-and-forget `unloadModel(<id>)` with a ~30–60 s per-model cooldown → the
   next request loads a clean model. Also resolves the gateway-wedge finding (unload frees the
   held slot). Reversible; no production config change to llama-swap.
2. **Gateway degeneracy watchdog + unload + single retry (high conf, medium effort) — backstop.**
   While relaying the SSE stream, track decoded output; if a recurrent model emits a long
   single-token run (e.g. `≥N` identical consecutive tokens / single-token-ratio over a window),
   unload and (optionally) retry once. Catches the *silent* case where no disconnect was seen.
   Must be tuned to not false-positive on legitimately repetitive output (code, tables, number
   runs) — restrict to recurrent models + a conservative threshold.
3. **Disable cross-request prompt-cache/checkpoint reuse for qwen3-coder-next ONLY (medium, trivial,
   config).** Add `--cache-ram 0` and/or `--ctx-checkpoints 0` to that model's llama-swap launch
   args so each request rebuilds memory from scratch and never restores a stale recurrent buffer.
   Trade-off: loses the prompt-cache speedup (slower TTFT on shared prefixes). Production config +
   model restart.
4. **Bump llama.cpp past build 8086439 (medium).** Community reports cite ~build 8123 (`f75c4e8bf`)
   fixing Qwen3-Next cache invalidation. Validate against a real repro before pinning; re-run the
   box throughput/coherence probes for regressions.
5. **Upstream `clear-on-cancel-for-recurrent` patch (medium).** In the `SERVER_TASK_TYPE_CANCEL` /
   `slot.release()` path, when the slot was actively generating AND the model uses recurrent memory,
   force `common_context_seq_rm(ctx, slot.id, -1, -1)` (full clear). The targeted upstream fix;
   worth filing upstream regardless of which local mitigation we ship.

## Recommendation

Ship **#1 (gateway poison-clear)** as the primary fix — highest confidence, small, in our code,
reversible, and it also closes the gateway-wedge gap. Add **#2 (degeneracy watchdog)** as the
backstop for the silent (no-disconnect) case. Consider **#4 (llama.cpp bump)** opportunistically as
the real upstream cure, validated against a proper repro. **#3** is a quick stopgap if a fix is
needed before the gateway change ships, at a prompt-cache perf cost.

## Implementation (Fix #1 — shipped 2026-06-24)

`src/homeserver/poison-clear.ts` — `poisonClearOnDisconnect(model, recurrentModelIds, cooldownMs)`:
on an abrupt client disconnect of an allow-listed recurrent `model`, fire-and-forget
`unloadModel(model)` (via the `model-admin` backend facade → llama-swap `POST /api/models/unload/:id`).
The next request to that model auto-spawns a clean llama-server. Detached + best-effort: an unload
failure never crashes the request path. A small per-model state machine balances three concerns:
- **Recover** — the FIRST disconnect (out of cooldown) fires immediately; recovery is never delayed.
- **Anti-thrash / DoS** — an `inFlight` guard collapses a concurrent burst to one unload (also
  remedies the concurrent-disconnect gateway wedge: the unload frees the orphaned upstream work), and
  the cooldown caps unloads to one per window.
- **No silent drop** — a disconnect inside the cooldown window OR while an earlier unload is still
  in flight is NOT dropped (which would re-introduce the permanent brick: a second abrupt disconnect
  re-poisons the model, and if all later traffic completes cleanly nothing re-triggers a clear). It
  schedules a single TRAILING unload at the window boundary which fires UNCONDITIONALLY (the backend
  unload is idempotent), so any window with ≥1 disconnect ends clean — dirty time is bounded by
  `cooldownMs`, never permanent, and the guarantee does NOT depend on how long any unload takes. A
  FAILED unload clears the cooldown so the next disconnect retries promptly. (The re-poison-within-
  cooldown hole was found by the cross-model Codex review of the first cut; an adversarial self-review
  then hardened the in-flight handling — defer-not-skip, unconditional trailing, boundary timestamp —
  so the "ends clean" invariant no longer relies on the unload completing quickly.)

Wired into `gateway.ts` `handleChatProxy` at all THREE `clientAborted` sites (initial fetch abort,
mid-stream abort = the primary trigger, and non-streaming body-read abort), keyed on the exact
upstream `parsed.model` so what we serve is what we unload. Full-attention models (mellum, …) are
never in the allow-list → never unloaded (matches the discriminator). Tradeoff (intentional): the
unload is process-global, so a concurrent request to the SAME recurrent model is cut short — but it
was already at risk of the dirty state and degrades gracefully (terminal SSE frame / billed 0), which
is strictly better than serving `?????` to everyone until a human restarts the box.

**Config** (`config.ts`):
- `HOMESERVER_RECURRENT_MODEL_IDS` (CSV) — default `qwen3-coder-next-80b`; set to `""` to disable.
- `HOMESERVER_POISON_CLEAR_COOLDOWN_MS` — default `60000` (1 min). The trailing-unload design caps
  unloads to one per window at ANY value, so this is no longer a DoS knob (a client cannot thrash the
  model however fast it disconnects) — it is a recovery-latency vs reload-frequency dial. 1 min sits
  above the observed ~22–38 s cold-load of the 80B, bounds the worst-case dirty window to ≤1 min, and
  caps attacker-forced reloads to ≤1/min.

**Observability:** `homeserver_poison_clear_total{model,outcome}` (`outcome` = `ok`|`failed`) — a
rising `failed` count means the box could not self-heal and may need a manual restart.

**Tests:** `tests/homeserver-poison-clear.test.ts` (unit: allow-list gating, cooldown boundary,
per-model independence, burst-collapse, unload-failure handling, metric outcomes) +
`tests/homeserver-poison-clear-gateway.test.ts` (integration: a real mid-stream disconnect unloads
the recurrent model; a non-recurrent model is left alone).

## Implementation (Fix #2 — degeneracy watchdog, shipped 2026-06-24)

The SILENT backstop for the no-disconnect case: a request that completes "cleanly" (finish_reason
`stop`, normal usage) whose body is a `?????` run, because it reused a recurrent buffer that an
EARLIER disconnect dirtied — there is no disconnect on THIS request, so the disconnect-keyed Fix #1
never fires and the box keeps serving garbage until a human restarts it.

`src/homeserver/degeneracy-watchdog.ts` — `DegeneracyWatchdog(threshold)`: a pure, allocation-light
streaming detector. `feed(content)` ingests decoded `delta.content` slices and latches `tripped`
once a run of `threshold` **consecutive identical non-whitespace characters** is seen (runs carry
across delta/chunk boundaries, so `??`+`???` is a run of 5). **Whitespace is a run breaker** — the
biggest source of long legitimate identical-char runs is whitespace (deep indentation, blank-line
runs), so those never trip; the tradeoff is that a whitespace-separated degenerate token isn't caught
(the observed symptom is a contiguous `?????` run, and Fix #1 still covers the common trigger).
`threshold <= 0` disables it.

Wired into `gateway.ts` `handleChatProxy`'s SSE relay tap (the SAME tap that already extracts content
for TTFT + owner-log): for an allow-listed **recurrent** model only (full-attention models are immune
→ no watchdog), each decoded slice is fed to the watchdog. On the first trip the relay aborts like an
upstream failure (`degenerateGone` AbortController → destroy the upstream stream), then — because the
200 + SSE headers are already on the wire and cannot become a 5xx — emits a terminal
`upstream_error` "degenerate response … please retry" frame + `[DONE]`, bills **0** (a garbage
completion is not a valid response), records outcome `degenerate`, and forces a poison-clear via
`requestPoisonClear(...,"degeneracy watchdog")`. That call shares the SAME per-model cooldown state as
the disconnect path, so a disconnect + a watchdog trip for one model collapse to one unload per window.

**Scope:** covers both transports. The primary arm is the streaming SSE relay (where the
recurrent-cache-reuse harness load actually triggers this — aborts mid-stream on the trip). Two
secondary arms close the silent gaps a cross-model review flagged: (a) a NON-streaming `?????`
completion (the watchdog runs once over `message.content` after the body is sent — can't change the
already-sent body, but still bills 0 + forces a poison-clear), and (b) the final newline-less SSE
frame on the clean-end path (fed to the watchdog so a degeneration confined to the trailing frame
can't slip past the mid-stream tap). All three arms share the one per-model poison-clear cooldown.

**Config** (`config.ts`): `HOMESERVER_DEGENERACY_RUN_THRESHOLD` — default `400` (no legitimate
text/code/table has 400 identical non-whitespace chars in a row; the degeneration emits thousands).
Set `0` to disable. Gated additionally by `HOMESERVER_RECURRENT_MODEL_IDS` (empty → no recurrent
models → watchdog never constructed).

**Observability:** `homeserver_degeneracy_detected_total{model}` — counts SILENT-path trips,
distinct from the disconnect-keyed `homeserver_poison_clear_total` (the unload's own ok/failed result
is still accounted there).

**Tests:** `tests/homeserver-degeneracy-watchdog.test.ts` (11 unit: trip threshold, run-across-chunks,
latching, whitespace-breaker, indentation/table-rule non-trips, threshold-0 disable) +
`tests/homeserver-poison-clear-gateway.test.ts` (integration: a recurrent model's degenerate run
aborts + unloads; a non-recurrent model streams the same run through untouched and bills it).

**Still open (follow-ups, not shipped here):** #4 llama.cpp bump (the upstream cure), #5 upstream
clear-on-cancel patch.
