# Keep-warm / cold-swap friction on the `ask` tool — design note (2026-07-01)

**Status:** design note only. No code or config changed by this doc. Written during an
unattended overnight session; flagging for owner review, not a decision.

## Finding

RQ6/RQ7 ask: how much real usage can be offloaded to the M5, and how should routing work? A
live query of `request_log` (2026-06-18 → 2026-07-01, read-only, on the box) shows the answer
isn't "the models can't do the work" — it's that the `ask` MCP tool (the thing this very
CLAUDE.md tells every Claude Code session to prefer for bounded sub-tasks) is barely used
*organically*:

| day type | `/mcp` + `/mcp/ask` calls |
|---|---|
| heavy benchmark/experiment days (06-23, 06-27, 06-28) | 848–1886/day |
| ordinary days (06-20, 06-21, 06-24, 06-25, 06-29, 06-30, 07-01) | 8–76/day |

Capability is way ahead of adoption. The infra works (routing table, disagreement gate,
ledger, `ask` tool) — it just isn't reached for very often in normal day-to-day sessions,
including this one, until this investigation prompted checking.

## Hypothesis: cold-swap latency is a real, underexamined disincentive

`/etc/llama-swap/config.yaml` gives every one of the 7 served models the same `ttl: 1800`
(30-minute idle auto-unload), and only ONE model is resident at a time (llama-swap's whole
design is a hot-*swap* proxy in front of a single `llama-server` process — confirmed via its
README's "if the wrong upstream server is running, it will be replaced"). There is no
per-model "always-on"/pinned option in `llama-swap --help` or its README; the closest feature
is `hooks` to run something once at llama-swap **startup**, which doesn't survive a later
30-minute idle window.

Two already-measured data points from this project's own history (not re-measured tonight,
to avoid an unnecessary live GPU experiment mid-OOM-caution): a cold mellum↔80b swap costs
**~38s** on the first per-type-routing call (2026-06-23 T3 work) and **~8-10s**
per swap in the Gate E free-arm run (2026-06-24). Either number is a real,
noticeable tax on a call that would otherwise be a sub-second `ask()`.

**Live-checked this session:** at investigation time, the model actually resident in
llama-swap was `qwen3-30b-instruct` — NOT `mellum`. This directly contradicts an implicit
assumption baked into this repo's own `CLAUDE.md` guidance ("prefer `mellum` (non-thinking)
for latency-sensitive short tasks" — true of the *model*, but silently assumes mellum is
*loaded*, which it frequently isn't, given nightly cron jobs (`gate-chat-replay` uses
`qwen3-30b-instruct`, `weekly-model-scout` loads whatever candidate it's testing) and any
other owner traffic routinely evict it.

## Why "just pin mellum, ttl:never-expire" is NOT the obvious fix

The tempting fix — give mellum an effectively-infinite `ttl` — has a real cost that isn't
obvious until you account for llama-swap's single-resident-model architecture: pinning
mellum doesn't stop OTHER traffic from evicting it (a `qwen3-30b-instruct` chat request, a
nightly cron job, a disagreement-gate secondary call to `qwen3-coder-next-80b`, a Model Scout
benchmark) — it only stops mellum's OWN idle timer from evicting itself. The very next
non-mellum request still forces a swap away, and the request AFTER that (back to mellum) still
pays the swap cost. Given the model breakdown shows real traffic to `qwen3-30b-instruct`
(2864 calls), `qwen3-coder-next-80b` (865), `gemma4` (635), `qwen35-a3b` (561), and
`gpt-oss-120b` (523) over the same 2-week window, mellum is very much NOT the only thing
touching the shared GPU. A naive pin trades "mellum sometimes cold" for "everything else swaps
back to mellum more often, for a benefit that only lands when two consecutive `ask()` calls
are both mellum-targeted" — not a clear win, and it actively works against the nightly jobs
and other owner traffic that need the GPU for other models.

## A more promising direction: warm the caller's session, not the server's default

Instead of changing the box's serving policy (which fights the shared-GPU constraint), the
cheaper, lower-risk fix is on the CALLING side: a Claude Code session that anticipates using
`ask()` could fire one lightweight warm-up call to its preferred model near session start,
amortizing the cold-swap cost once per session instead of paying it on every cold ad-hoc call.
This sidesteps the multi-tenant tradeoff entirely — it costs nothing to OTHER traffic, and it's
a behavioral/prompting change (a CLAUDE.md note), not a server-side config change with blast
radius on guests and cron jobs.

## Recommendations (not implemented tonight)

1. **Don't change the live TTL/pinning config unattended** — the tradeoff above needs a real
   decision from the owner, not an autonomous call on a box that already had one incident
   tonight.
2. **Fix the CLAUDE.md guidance inaccuracy**: "prefer `mellum`... for latency-sensitive short
   tasks" should be honest that mellum is not reliably warm, and that a cold `ask()` call can
   cost 8–40s. A future session could soften this to something like "prefer mellum when
   already-warm; if this is your first `ask()` this session, expect a possible cold-start."
3. **Consider a session-start warm-up convention** (documented, not automated) — a Claude Code
   session that plans to use `ask()` fires one cheap warm-up call early, rather than waiting for
   the first real task to eat the cold-swap cost.
4. **Verify `ttl` semantics against llama-swap's actual source/docs before relying on any
   pin option** — `configuration.md` isn't vendored locally in `/etc/llama-swap/`; whether `ttl:0`
   or an omitted `ttl` means "never expire" was not confirmed this session (flagged, not
   asserted, to avoid shipping a doc based on an unverified guess).
5. **If a real fix is wanted, measure first**: a controlled A/B (mellum pinned vs. default TTL,
   over a week of real cron + owner traffic) would show whether pinning actually reduces
   *aggregate* swap count, or just relocates it — cheap to build on top of the existing
   `gate-chat-replay`/offloadability-trend infrastructure already logging to Heimdall nightly.

## Related

- **MEASURED 2026-07-02** — recommendation #5 ("measure first") is now answered:
  `docs/swap-latency-results-2026-07-02.md` records the full cold-swap matrix
  (`scripts/measure-swap-latency.ts`, `--repeats 2`, zero contamination). Headline: the 8–40s
  estimate above is confirmed and refined — mellum cold-start ~6–15s (median 10.5s), big-model
  swaps 40–60s (gpt-oss-120b median 51s), warm calls ~0.1–0.3s (a 66–234× cold/warm ratio
  observed across samples).
  Per recommendation #2, "prefer mellum for latency-sensitive short tasks" should be read as
  "prefer mellum **when already warm**; a cold first call costs ~6–15s (measured), and
  big-model swaps cost 40–60s."
- Logged as a Munin finding, `projects/gille-inference`, 2026-07-01 (tags:
  rq6, rq7, offload-adoption, keep-warm).
- `docs/m5-qwen3next-recurrent-degeneration-2026-06-24.md` — a different, already-fixed
  degeneration mode on the SAME model that also touches TTL/reload behavior (disconnect-triggered
  SSM corruption, not cold-start latency — unrelated bug, same config file).
