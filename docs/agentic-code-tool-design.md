# Design: `code_loop` — owner-only sandboxed pi-driven agentic coding tool on M5

**Issue:** #116 · **Acceptance (§11): ✅ PASSED 2026-07-02** — Gate D through code_loop: rounds 8/9/10 of 10, median 9 ≥ bar 9, same-day direct baseline 10/10 (`docs/gate-d-code-loop-acceptance-2026-07-02.md`) · **Status:** FINAL (synthesized from three candidate designs + three adversarial judge lenses) · **Date:** 2026-07-02

---

## 1. Chosen architecture and why

**Chosen: pi-as-supervised-subprocess, routed through the gateway, inside a mandatory Phase-1 OS cage, with an async job API.** This is the `pi-subprocess` candidate's skeleton with the security posture of `native-driver` and the operational corrections of `free-choice` grafted on.

The judge verdicts decide this cleanly:

- **Operations and delivery lenses both ranked pi-subprocess first** (6.5, 7) and both *verified in-repo* its two load-bearing bets: (a) routing every loop turn through the gateway really does deliver per-turn `owner_request_log` (`gateway.ts:791`), content-blind `request_log`, admission, credits, the degeneracy watchdog and poison-clear (`gateway.ts:815-819`) with **zero new logging or recovery code** — constraints 3 and 4 satisfied by existing incident-hardened machinery; (b) it reproduces the **exact configuration that measured 10/10 on Gate D** (`gate-d/run.sh:53-54`), so capability risk is near zero and the long-term owned code surface is the smallest.
- **The security lens ranked native-driver first** — but its top strengths are *portable*: the strict owner gate, byte-identical invisibility, protected-path exit verification, and OS-level capability minimization are all adopted here. Its *architecture* is not, because both other lenses found it fatal on this box: it bypasses the gateway (losing watchdog/poison-clear for a known-degenerating recurrent model **and** deleting the RQ6/RQ7 dataset from Phase 1), runs the loop inside the live gateway heap (largest blast radius on an OOM-prone box), and re-fights the harness-quality battle Gate D already measured — with real risk of landing at aider's 6/10.
- **free-choice's architecture is rejected** on two verified grounds: its no-bash flag list (`--tools read,edit,write,grep,find,ls`) names tools pi does not have (pi has exactly `read`/`write`/`edit`/`bash` — `docs/gate-de-evaluation-plan.md`, "pi" section), and its outer-loop check-feedback shape structurally rebuilds aider's 6/10 architecture while citing pi's 10/10 as evidence. But its *corrections* were the best fact-checking in the set and are all adopted: the tailnet base URL, the no-admission-wrap deadlock analysis, maintenance-mode refusal, stale-sandbox sweep, sandbox growth cap, and the `AgentEngine` seam for a later pi-vs-native A/B.

**The single biggest change from all three candidates:** the OS cage (filesystem + network + memory confinement) and the async job API move from "Phase 2 / later" into **hard Phase-1 ship gates**. Every judge lens independently flagged that shipping without them is unacceptable: the security lens because any code execution as the gateway uid can read `.env` and `eval.db`; the operations lens because a 600–900 s synchronous MCP call dies at the Cloudflare edge (~100 s) while the box burns GPU to completion.

### Ideas stolen from the losing designs (survived judging)

| From | Idea |
|---|---|
| native-driver | `tier==="owner" && keyHash!==null` gate (the `owner-log.ts:13` guard); byte-identical unknown-tool error; protected-path exit-time re-verification; ≥9/10 gate-d acceptance discipline before default-on; closed-command-execution philosophy (applied to `check_cmd`) |
| free-choice | Tailnet gateway URL (never loopback); do NOT wrap the outer call in admission (deadlock at `maxParallel=1`, `config.ts:313`); maintenance-mode refusal; stale-sandbox startup sweep; sandbox >50 MB growth abort; dedicated `PI_CODING_AGENT_DIR` instead of squatting `~/.pi`; `AgentEngine` seam (Later); readiness-aware degenerate-round retry (corrected: readiness-polled, not fixed 10 s — the ops lens showed 10 s is shorter than a poison-clear reload) |

---

## 2. Architecture overview

Three owner-only MCP tools on the existing gateway (`POST /mcp`) — `code_loop_start`, `code_loop_status`, `code_loop_result` — manage an **async job** that wraps a **pi subprocess installed on the box**, pointed back at the gateway's own `/v1` (the **configured bind host** — the tailnet IP on the live box, never a hardcoded loopback) with a dedicated owner-tier service key. The harness materializes caller-supplied seed files into a throwaway sandbox with its **own `git init`** (the gate-d fixture-corruption fix), spawns pi inside an **OS cage** (systemd resource/network scope + bwrap filesystem view) under wall-clock/turn/token caps, then harvests `git diff` + pi's final message. The caller polls status and fetches the result — a diff, changed-file set, and summary — and applies the diff itself. **The box never mutates a live checkout.**

Routing pi through the gateway (not llama-swap `:8091`) is load-bearing: every loop turn automatically transits owner-lane admission, metrics, `request_log`, **`owner_request_log`** (the RQ6/RQ7 dataset), poison-clear, and the degeneracy watchdog — the production spine, not a reimplementation.

```
Claude Code (laptop) ──MCP──▶ gateway /mcp  code_loop_start ──▶ job table + sandbox (data/code-loop-work/<id>)
                                                │
                                                ▼  spawn (caged: systemd-run scope + bwrap)
                                          pi --provider inference-local --model qwen3-coder-next-80b
                                          --no-session --print --mode json  (cwd = sandbox)
                                                │  each turn
                                                ▼
                              gateway /v1/chat/completions (owner key `code-loop-<ts>`)
                              → admission, owner_request_log, watchdog, poison-clear, metrics
                                                │
                                                ▼
                                        llama-swap :8091 → qwen3-coder-next-80b
```

---

## 3. Components

### New files

| Path | Contents |
|---|---|
| `src/homeserver/code-loop-types.ts` | Frozen contract: `CodeLoopRequest`, `CodeLoopJob`, `CodeLoopResult`, `CodeLoopDeps` (DI: spawn fn, clock, chat-readiness probe), `AgentEngine` interface (pi is the only Phase-1 implementation) |
| `src/homeserver/code-loop.ts` | `startCodeLoop()` / `getJob()` / `getResult()`: job table, sandbox lifecycle (seed → nested `git init` → run → harvest → retain), cap enforcement, single-run mutex, `acquireGpuLease` wrap, maintenance-mode refusal, startup sweep, `recordDelegation()` write |
| `src/homeserver/pi-engine.ts` | pi spawn (caged argv construction), NDJSON event monitor (turn/token accounting), degenerate-round retry state machine |
| `src/homeserver/code-loop-cage.ts` | Builds the confinement argv (systemd-run scope props + bwrap FS spec) + the **cage self-test** (§6) |
| `tests/code-loop.test.ts` | Offline unit tests (fake spawn, canned NDJSON fixtures) |
| `deploy/pi-models.json.example` | Template for the box-side pi provider config (baseUrl rendered from `HomeserverConfig`, never hardcoded) |

### Changed files

| Path | Change |
|---|---|
| `src/homeserver/mcp.ts` | `toolDefs()` (`:91`) gains a `principal` parameter; the three `code_loop_*` tools appear **only** when `principal.tier === "owner" && principal.keyHash !== null`; thread principal through the `tools/list` branch (`:611`); `callTool()` (`:515`) dispatch re-checks the same guard and returns the **byte-identical unknown-tool error** to non-owners — invisible, not just forbidden |
| `src/homeserver/config.ts` | `HOMESERVER_CODE_LOOP` (`on\|off`, default **off**), `HOMESERVER_CODE_LOOP_PI_BIN`, `HOMESERVER_CODE_LOOP_API_KEY`, `HOMESERVER_CODE_LOOP_WORKROOT` (default `./data/code-loop-work`), `HOMESERVER_CODE_LOOP_MODEL` (default `qwen3-coder-next-80b`), cap defaults/maxima, `HOMESERVER_CODE_LOOP_CONFINEMENT` (`required` default; `off` only for offline tests) |
| `src/homeserver/README.md` | Tool table entry + provisioning runbook |
| `src/homeserver/portal.html` | **Explicitly no change** — owner-only, invisible to guests, no public surface (state this in the PR per the repo rule) |
| `gate-d/run.sh` | Later phase: fourth arm `wrapped` invoking the tool end-to-end (acceptance gate, §11) |

### Box provisioning (one-time, in the README runbook)

1. Pin-install pi **outside the rsync root**. The package is **`@mariozechner/pi-coding-agent`** (NOT `@mariozechner/pi`, an unrelated `pi-pods` tool — the `@earendil-works` rename speculation did NOT apply). **Verified on the box 2026-07-02: `@mariozechner/pi-coding-agent@0.70.2`** (matches Gate D's 10/10 run), installed via `npm install -g @mariozechner/pi-coding-agent@0.70.2` (npm prefix `-g` = `~/.local` on the box → binary `/home/inference/.local/bin/pi`) → `HOMESERVER_CODE_LOOP_PI_BIN=/home/inference/.local/bin/pi`. Pin the exact version.
2. `PI_CODING_AGENT_DIR=/home/inference/pi-agent-home` holding `models.json` (pi ALSO creates its own `auth.json` credential store there — observed on the box 2026-07-02 — so the dir must NEVER be bound into the cage wholesale; the cage ro-binds ONLY `<dir>/models.json`): provider `inference-local`, **`baseUrl` = `http://127.0.0.1:<HOMESERVER_CODE_LOOP_FORWARD_PORT>/v1`** (default `http://127.0.0.1:18080/v1`) — the **in-cage loopback forward**, NOT the tailnet IP (the cage's pasta namespace blocks the tailnet IP; the loopback port is forwarded to a host relay that bridges to the real gateway — see §6). `api: "openai-completions"`, `apiKey: "HS_API_KEY"`, `authHeader: true`, compat flags per `docs/gate-de-evaluation-plan.md`. Template: `deploy/pi-models.json.example`.
3. Mint the service key with a **fresh timestamped alias** — `keys mint --alias code-loop-$(date +%Y%m%d-%H%M%S) --tier owner` (`keys mint` REJECTS reused aliases even after revocation) — with model allow-list `[qwen3-coder-next-80b]` and TPM/daily quotas as a defense-in-depth backstop → `.env` as `HOMESERVER_CODE_LOOP_API_KEY`. A real keystore key (non-null `keyHash`) is what makes `owner_request_log` fire per turn (`gateway.ts:791`); implicit-admin would silently skip it.
4. `apt install bubblewrap passt` (bwrap + pasta — the two new system deps) and run the **cage self-test** (§6): `HOMESERVER_HOST=<tailnet-ip> npx tsx src/homeserver/cli.ts code-loop cage-test` (or `--gateway-url http://<tailnet-ip>:8080`). **Verified PASS on the box 2026-07-02.**
5. Record one real pi session's NDJSON to a fixture **before** the monitor is written (§11).

---

## 4. Caller-facing API contract

All three tools: owner-gated, invisible to guests, each individual call returns in well under the Cloudflare ~100 s edge limit — this is why the job API is Phase 1, not Later.

### `code_loop_start`

```json
{
  "client_run_id": "hugin-gate-d-pair-001",
  "instruction": "string (required — the task prompt)",
  "files": [{"path": "src/x.ts", "content": "..."}],
  "check_cmd": "npx --no-install tsx test/oracle.ts",
  "protected": ["test/**", "tsconfig.json"],
  "task_type": "code-implement",
  "caps": {"wall_s": 480, "turns": 24, "completion_tokens": 60000, "edit_deadline_turn": 6}
}
```

- `files`: required in Phase 1; ≤64 files, ≤2 MB total, relative paths only.
- `client_run_id`: optional, caller-supplied durable idempotency key. The server binds it by
  exclusive create to a canonical `sha256:` request fingerprint before any paid execution. The
  same id+fingerprint recovers the original work id/status/result across response loss or gateway
  restart; a different fingerprint is an explicit `conflict`. Omission retains legacy
  non-idempotent submission behavior, advertised in the response capabilities, while the server
  still assigns an unreachable internal durable identity so result retention never trusts sandbox
  metadata. A content-blind SQLite
  singleton provides the separate cross-process paid-run lease: `BEGIN IMMEDIATE` makes dead-owner
  takeover atomic, and release deletes only its matching owner token/work id.
- `check_cmd`: optional, owner-authored (never model-generated), run in the sandbox **inside the same cage** post-loop, 120 s cap.
- `protected`: optional globs; violations detected at exit (§6), never silently passed.
- `caps` are clamped to hard maxima `wall_s ≤ 900`, `turns ≤ 40`, `completion_tokens ≤ 120000`. Default wall-clock is 480 s (delivery-lens must-fix), sized to tolerate 1–2 mid-loop model swaps (§8). `edit_deadline_turn` is optional, strictly positive, and must be ≤ effective `turns`; omission preserves the original prompt/behavior. When present, a stable policy wrapper asks for the first edit/write by that overall turn and the monitor deterministically returns `cap-exceeded` + `failure_kind:edit-deadline` if no successful mutation event arrives.

Returns immediately with `work_id`, `status`, `client_run_id`, `request_fingerprint`, `recovered`,
and versioned capabilities. A terminal idempotent retry also carries the original `result`. A new
request can be refused as `busy`, `lease-unavailable`, `maintenance`, `disabled`,
`cage-unavailable`, `invalid-request`, or `conflict`. Same-id recovery is checked before `busy`, so
an ambiguous retry never starts or spends twice.

### `code_loop_status`

`{"work_id": "..."}` → `{"status": "running" | <terminal>, "usage": {"turns": 7, "wall_ms": 183000, "completion_tokens": 21384}}`

### `code_loop_result`

`{"work_id": "..."}` → the full result (fetchable repeatedly until the TTL sweep reclaims the sandbox):

```json
{
  "status": "completed" | "cap-exceeded" | "degenerate" | "arm-error" | "orphaned",
  "diff": "unified git diff vs seed commit, ≤200KB (truncated flag if over)",
  "changed_files": ["src/x.ts"],
  "protected_violations": [],
  "summary": "pi's final assistant message (≤2KB)",
  "check": {"ran": true, "exit_code": 0, "output_tail": "last 4KB"} ,
  "usage": {"turns": 7, "wall_ms": 183000, "prompt_tokens": 41200, "completion_tokens": 21384},
  "execution": {
    "schema_version": 1,
    "model": "qwen3-coder-next-80b",
    "engine": "pi",
    "harness_version": "code-loop-pi-2026-07-14-v6",
    "effective_caps": {"wall_s": 480, "turns": 24, "completion_tokens": 60000, "edit_deadline_turn": 6},
    "capabilities": {"start_idempotency": "client-run-id-v1", "agent_checks": "pi-bash-events-v3"}
  },
  "telemetry": {
    "schema_version": 1,
    "first_edit_turn": 2,
    "edit_start_ms": 12345,
    "phase_ms": {"inspect": 12345, "edit": 45678, "check": 321},
    "mutation_evidence": "tool-call",
    "observability_coverage": 1
  },
  "agent_checks": {
    "schema_version": 3,
    "source": "pi-bash-events",
    "state": "attempted",
    "unparseable_lines": 0,
    "coverage_loss_events": 0,
    "work_id": "cl-20260702-abc123",
    "attempts": [{
      "order": 1,
      "kind": "typescript",
      "command_fingerprint": "sha256:<digest>",
      "started_ms": 50123,
      "ended_ms": 51800,
      "status": "passed",
      "exit_code": null
    }]
  },
  "work_id": "cl-20260702-abc123"
}
```

Semantics:
- The owner-visible `code_loop_start` tools/list description advertises the exact pre-paid
  contract `contract[harness=code-loop-pi-2026-07-14-v6;agent_checks=pi-bash-events-v3;schema=3;max_attempts=1000]`, so an orchestrator can fail before inference against an old gateway.
- **The diff is the deliverable** (hard constraint 5). The caller reviews and applies it (`git apply`) to its own checkout. Nothing on the box ever touches a live repo.
- Ground truth for the diff is always git (`git add -A && git diff --cached <seed-sha>` in the sandbox), never pi's event claims.
- First-edit timing is taken from the pinned pi NDJSON `tool_execution_start` for `edit`/`write`, but becomes trusted only when the matching `tool_execution_end` succeeds. A git diff without that pair is reported as `mutation_evidence:"diff-only"`; timing fields stay absent. Retry turns and elapsed time are aggregated from the original attempt, while `phase_ms.check` measures only the M5-side owner check.
- `agent_checks` is immutable, content-blind **agent-side** evidence from actual pi `bash`
  `tool_execution_start`/`tool_execution_end` pairs. It records only a normalized kind, command
  digest, relative timing, order, result status, and observed exit code. Pi 0.70.2 does not emit a
  success exit code, so a successful event reports `exit_code:null`; a failed event accepts only
  pi's anchored process-generated `Command exited with code N` suffix. Repeated attempts are
  append-only up to the shared producer/consumer bound of 1,000 attempts; overflow is dropped,
  increments `coverage_loss_events`, and therefore makes the state `partial`. Missing checks remain
  `state:"none"` only when event coverage was complete.
  Unparseable NDJSON, refused check-shaped shell commands, uncorrelated bash events, or absent
  engine telemetry make the state `unobservable` (no attempts) or `partial` (some attempts). The
  `coverage_loss_events` counter is content-blind, so callers never confuse absent and unreadable
  evidence even if the model summary claims tests passed. It never
  exposes command text, paths, source, prompt, stdout/stderr, or secrets. The gateway-owned
  post-loop `check_cmd` remains the separate `check` field.
- On every non-`completed` terminal status the diff is still harvested best-effort — a partial diff is data and possibly still useful.
- `status` describes the *run*; verification lives in `check`. There is deliberately no `"pass"` status: `completed` + `check.exit_code === 0` is the only pass signal, and absence of a `check_cmd` can never be reported as verified (this fixes free-choice's self-contradicting status enum).

---

## 5. Seeding + result-return semantics

**Phase 1 seeding: inline file subset only.** The calling Claude Code session curates the files the task touches plus what's needed to build/test — matching how L1 already scopes sub-tasks. This is deliberately the smallest thing that works; git-URL / tarball seeding is Later.

Sandbox lifecycle:

1. `mkdtempSync` under `HOMESERVER_CODE_LOOP_WORKROOT` (default `data/code-loop-work/` — under the deploy dir so `npx --no-install` in `check_cmd` resolves `node_modules` by walk-up, the gate-d trick; under `data/` so rsync deploys never touch it).
2. Each seed path is validated with a **hardened** containment check: the lexical `resolveContained()` pattern (`improve-loop.ts:66`) **plus** realpath verification of the parent directory against the sandbox realpath before every write, and `wx`-flag creation (no following of pre-existing entries). The judges established `resolveContained()` alone is pure-lexical — **no design may claim it stops symlink escapes**; here it doesn't need to, because seed writes are realpath-verified and *runtime* writes are contained by the OS cage (§6), not by lexical checks.
3. `git init` + throwaway identity + `commit -m seed`. The sandbox has its **own git root** — the gate-d fixture-corruption lesson (aider once escaped to the parent repo root); the nested root means no tool inside can walk up to another repo, and it doubles as the diff baseline.
4. Run (§2) → harvest diff + changed files (changed-file paths re-validated for containment on the way out).
5. **Retention: the sandbox (including the pi NDJSON log and a `.meta.json` job record) is retained on ALL statuses, including `completed`**, until a periodic 24 h TTL sweep reclaims it. Idempotent runs additionally persist a content-minimal caller binding and terminal result under the workroot, outside the model-writable sandbox. The binding stores no request/prompt/file contents—only caller id, canonical digest, server id, state/usage, and the already-authorized result. A `cl-*` directory left by a crash before durable claim/meta is TTL-reclaimed from its non-symlink directory mtime; a fresh directory is retained.

**Gateway restart mid-run:** the startup sweep finds `.meta.json` records with status `running` and no live process → stops the recorded transient scope unit if present and marks both sandbox meta and the durable caller binding `orphaned`. A same-id retry recovers that state instead of duplicating execution. A terminal result is returned only when it matches the current immutable harness/evidence contract; an older or over-bound cached result is compacted to `terminal-unavailable`, never relabelled as current evidence. An interrupted run has no fabricated result.

---

## 6. Security model

### Enforcement points

| Control | Mechanism | Where |
|---|---|---|
| Owner-only | `principal.tier === "owner" && principal.keyHash !== null` (the exact `owner_request_log` guard, `owner-log.ts:13` / `gateway.ts:791` — excludes implicit-admin and legacy static keys) | `mcp.ts` — both `toolDefs(principal)` filtering **and** `callTool()` dispatch |
| Invisibility | Guests never see the tools in `tools/list`; direct `tools/call` returns the **byte-identical unknown-tool error** (never "forbidden", which leaks existence) | `mcp.ts:515` dispatch |
| Feature flag | `HOMESERVER_CODE_LOOP=off` default — a deploy without box provisioning is inert | `config.ts` |
| Seed containment | Hardened lexical + realpath + `wx` checks (§5) | `code-loop.ts` |
| Runtime containment | The OS cage (below) — **not** lexical checks; pi's `write`/`edit`/`bash` are unmediated subprocess operations, so containment must be at the OS layer | `code-loop-cage.ts` |
| Protected paths | Exit-time diff of `protected` globs against the seed commit → any touch lands in `protected_violations` and disqualifies `check` pass (native-driver's belt-and-braces, adapted: with pi we cannot mediate writes in-process, so exit verification is the honest enforcement point) | `code-loop.ts` |
| Env scrubbing | pi is spawned with a minimal env: `PATH`, `HOME=<sandbox>`, `PI_CODING_AGENT_DIR`, `HS_API_KEY=<service key>`. No `OPENROUTER_API_KEY`, no gateway `.env` inheritance. `--no-session` ⇒ no pi session artifacts. `check_cmd` gets `PATH`/`HOME` only — not even `HS_API_KEY` | `pi-engine.ts` |
| Key blast radius | Service key is owner-tier but model-allow-listed to the 80b with TPM/daily quotas; rotation runbook uses fresh timestamped aliases | keystore |

### The Phase-1 OS cage (mandatory — the security lens's central shared must-fix)

The gateway runs as the dedicated `inference` service user, which owns the runtime environment and
`data/eval.db` (live keystore + credits). Any code execution as that uid — pi's bash, **or**
`check_cmd` importing model-edited source, which is RCE by construction — must therefore be
OS-confined *before this tool runs at all*, not in Phase 2. Both pi and `check_cmd` run inside the
same cage.

> **IMPLEMENTATION FINDING (2026-07-02, verified on the box):** the original two-mechanism plan (`systemd-run --user --scope` for resource **and** network, `bwrap` for filesystem) **does not enforce egress** on this box. `systemd-run --user --scope -p IPAddressDeny=any` is **silently accepted but not enforced** — an unprivileged user systemd manager cannot install the cgroup BPF egress firewall. A `/bin/true` primitive test passes (exit 0) yet real egress stays OPEN; only a probe that makes an actual outbound connection reveals it. The cage therefore uses **three** mechanisms, each empirically verified enforced:

- **`systemd-run --user --scope`** — **resource caps only**: `MemoryMax=8G`, `TasksMax=256`, `CPUWeight` modest. Bounds the subprocess *tree* (the 2026-07-01 OOM lesson — a runaway `tsc`/fork-bomb turn cannot take the box down). The `IPAddress*` properties are **deliberately absent** — they are no-ops in a user scope.
- **`pasta -T <forwardPort>`** (passt) — **network egress**: runs the child in a fresh user+net namespace with **no general outbound route** (all egress blocked) and forwards **only one loopback port** to the host loopback, where a per-run Node relay (`startGatewayRelay`) bridges to the real gateway (`HOMESERVER_HOST:PORT`). The caged pi's *only* reachable destination is the gateway callback, at `http://127.0.0.1:<forwardPort>/v1` in-namespace. No `--config-net` (which would grant general NAT egress). This is the change that makes egress-blocking actually hold on this box.
  - **The relay is a PATH-ALLOWLISTED HTTP forwarder, not a raw byte-pipe** (adversarial-review escalation, 2026-07-02). The service key is owner-tier (⇒ `isAdmin` on the gateway), so a raw pipe would let a prompt-injected pi reach `POST /admin/keys` (persist a key), model load/unload, maintenance toggle, key revoke — nullifying the cage's egress win with an over-broad forward. `startGatewayRelay` therefore parses HTTP and forwards **only** `POST /v1/chat/completions`, `GET /v1/models` (read-only, content-blind), and `GET /healthz` (the self-test's unauthenticated liveness arm); **every other method+path → `403 code_loop relay: path not allowed` without any upstream connection** (`homeserver_code_loop_relay_denied_total` increments), and non-HTTP/garbage closes the socket. Request + response stream both ways (SSE-safe); the bearer header pi already sends is forwarded unchanged. This narrows the **Open Q6** exposure to a safe-by-construction floor: the owner key remains powerful, but the cage's *only* network path can no longer reach any admin route regardless of the tier decision — Q6 (a `service` tier that logs like owner but can't touch admin surfaces) remains worthwhile as defense-in-depth before enabling.
- **`bwrap --share-net`** — **filesystem**: shares pasta's restricted netns (**never** `--unshare-net`/`--unshare-all`, which would make a fresh empty netns and cut off the gateway), read-only view of `/usr`, `/lib`, `/etc` (toolchain), **tmpfs over `/home/inference`** (hides `.env`, `eval.db`, SSH keys, everything), read-only bind of `/srv/gille-inference/node_modules` (so `check_cmd`'s `npx --no-install` walk-up works), and a **read-write bind of the sandbox only**.

**Cage self-test (ship gate):** `code-loop-cage.ts` exposes a probe that runs inside the exact cage argv (with the relay up) and asserts: cannot read `/srv/gille-inference/.env`; cannot write to the read-only toolchain (`/usr`); cannot reach an external IP (`1.1.1.1:443`); **can** reach the gateway `/healthz` (HTTP 200 through the forward). It runs at provisioning time (`homeserver code-loop cage-test`, with `HOMESERVER_HOST=<tailnet-ip>` or `--gateway-url`) and at every job start; with `HOMESERVER_CODE_LOOP_CONFINEMENT=required` (the default), a failing probe refuses the job with `cage-unavailable`. The design never *claims* confinement — it *tests* it (**verified PASS on the box 2026-07-02**; a wrong gateway URL correctly FAILS the gateway arm). If the cage cannot be made to pass on some future box's kernel, the documented fallback is: verify the installed pi version's tool-restriction flag (e.g. `--exclude-tools bash`) actually exists, ship no-bash with harness-run `check_cmd` only, and accept the capability haircut until the cage works — an unbounded bash tree on the serving box is not an acceptable interim state, even owner-only (ops-lens must-fix, verbatim intent).

### On bash — honest position

pi's four tools are `read`/`write`/`edit`/`bash`; the read→edit→**run** loop with bash is the measured 10/10 configuration, and removing it demonstrably risks regressing to the 6/10 outer-loop shape. The issue's trust boundary says "no arbitrary shell." This design's reading: **a caged shell is not an arbitrary shell** — inside the cage, bash can see only the sandbox and a read-only toolchain, reach only the gateway, and is memory/task/wall-clock bounded; the residual risk (prompt-injection via seeded file content steering an owner-tier gateway key that can only call the allow-listed 80b) is explicitly accepted and logged per-turn. This interpretation is flagged as **Open Question 1** for the project owner. The security lens's strongest alternative (a dedicated unprivileged uid) is Open Question 2.

---

## 7. Bounds

| Bound | Default | Hard max | Enforced by |
|---|---|---|---|
| Wall clock | 480 s | 900 s | Harness timer → SIGTERM then SIGKILL on the process group; scope stop as backstop |
| Turns | 24 | 40 | NDJSON monitor counting turn events, kill on breach |
| Completion tokens | 60 000 | 120 000 | NDJSON monitor summing usage; service-key TPM/daily quota as gateway-side backstop |
| Per-check runtime | 120 s | — | `check_cmd` timeout |
| Seed size | ≤64 files / 2 MB | — | Rejected at `start` |
| Sandbox growth | 50 MB | — | Checked periodically during the run → abort (`cap-exceeded`) |
| Diff size | 200 KB returned | — | Truncated + flag; full diff stays in retained sandbox |
| Subprocess memory / tasks | 8 G / 256 | — | systemd scope `MemoryMax`/`TasksMax` |
| Concurrency | exactly 1 run | — | Module-level mutex; second `start` → `busy` (no parallel spawns — 2026-07-01 OOM lesson) |

Cap breach ⇒ `cap-exceeded`, diff still harvested, sandbox retained.

---

## 8. GPU + admission integration

- **GPU lease (whole run):** `acquireGpuLease({model, purpose: "code-loop", …})` (`gpu-lease.ts:318`) wraps the entire run with a 60 s acquire timeout (else `lease-unavailable`); `onLeaseLost` → SIGTERM the process group → `arm-error`, diff harvested. This sequences correctly against the 03:00 nightly gate-chat-replay and Sunday scout/sweep crons — the only coherent lease story among the candidates (ops lens). The serving path never acquires the lease, so there is **no deadlock** taking it in-process (free-choice's contrary claim was fact-checked false).
- **No outer admission hold:** the `code_loop_start` call itself is never wrapped in `runChatCompletion`/admission — at `maxParallel=1` (`config.ts:313`) that would deadlock against pi's own inner turns, and holding a slot for a whole run would 503 all guests for minutes (native-driver's fatal availability flaw). Instead, **each inner pi turn rides normal owner-lane admission per call** — guests are preempted per-turn, bounded and fair.
- **Maintenance mode:** `start` refuses (`maintenance`) when bench/maintenance mode is engaged (the model-scout window; hook the same flag the gateway consults, `gateway.ts:2371-2372`).
- **Swap-thrash policy (decided + documented, per ops must-fix):** the GPU lease does not gate *interactive* gateway traffic, so an interleaved `ask` to mellum mid-loop causes an 80b↔mellum swap pair. Phase 1 **accepts** this: the default 480 s wall-clock is sized for 1–2 swaps; a `homeserver_code_loop_active` gauge plus a counter of other-model requests admitted while a loop is active make the cost visible in metrics; the owner's practical rule is "don't fire mellum asks during a run you care about." A prefer-no-swap admission affinity is Later.
- All loop turns hit one model through one serial pipeline — no swap thrash from the loop itself, matching the serial GPU.

---

## 9. Logging / data collection (RQ6/RQ7 — first-class goal)

- **Per turn, for free (verified by two judge lenses):** every pi→gateway call lands in `request_log` (content-blind: alias/tier/model/ttft/tokens) and **`owner_request_log`** (full prompt + completion — `gateway.ts:791` fires because the service key is a real keystore owner key with `keyHash !== null`) under the `code-loop-<ts>` alias. This is the Claude→local agentic-delegation dataset the project exists to collect, cleanly separable from interactive `ask` traffic, with zero new logging code and zero drift risk.
- **Per run:** one `recordDelegation()` row (`ledger.ts:152`): `task_type` from the request, `model_id`, `source: "code-loop"` (so `getVerdict()` learns agentic-loop capability as a separate evidence lane from single-shot), tokens/latency aggregated from NDJSON events, `verifier: "check-cmd"` when supplied. Outcome mapping: `check_cmd` exit 0 → `pass`; nonzero → `fail`; no `check_cmd` → `unverified`; cap kill → `error/timeout`; spawn/lease/cage failure → `error/infra`; **degeneracy abort → `error/infra`** (serving-layer pathology — must not poison the 80b's capability verdict).
- **Per run artifacts:** pi's NDJSON event log + `.meta.json` retained in the sandbox for the TTL window (post-mortems, fixture mining).
- **Metrics:** `homeserver_code_loop_runs_total{status}`, `homeserver_code_loop_active`, interleaved-other-model counter (§8) — content-blind, consistent with `metrics.ts` discipline.
- Once ≥8 verified runs exist: add the `code-implement`-agentic vs single-shot comparison to `docs/m5-routing.json` — the actual RQ7 payoff.

---

## 10. Failure handling

- **Degenerate turn (recurrent-model "?????"):** the gateway's degeneracy watchdog aborts the stream and poison-clear reloads the model — the production machinery, not a reimplementation (`gateway.ts:815-819`; `poison-clear.ts`). Harness behavior on top: if pi errors/exits after a suspected degeneracy event, **poll gateway model readiness (up to 300 s)** — readiness-based, not a fixed 10 s backoff, which the ops lens showed is shorter than a poison-clear reload — then re-invoke pi **once** in the same sandbox with a continuation prompt ("previous attempt aborted; workspace preserved; continue"); a second failure is terminal `degenerate` with partial diff. The wrapper also scans pi's final text for a ≥400-char identical run (the watchdog threshold) as a belt-and-braces status check.
- **Pre-ship verification (ops must-fix): DONE 2026-07-03 — a gap was found and fixed.** Synthesized the exact gateway retry-frame (`{"error":…"degenerate response and was reset…"}` + `[DONE]` + clean close, `gateway.ts:1034-1037`) against a live pi 0.70.2 session (`scripts/`-style probe). Result: **pi surfaces the abort structurally as a `turn_end` with `stopReason:"error"` + `errorMessage`, but STILL EXITS 0.** The harness success gate keyed on exit-0 + no-char-run therefore *silently accepted the truncated turn as `completed`* — exactly the failure this check existed to catch. Fix: added the per-turn integrity check the note anticipated — `turnErrorOf()` parses `stopReason:"error"` from `turn_end`; a run with any errored turn can no longer be `completed` (routes to the readiness-poll + single retry when the error is a recognizable degeneracy, else surfaces as `arm-error`). Verified end-to-end: real `makePiEngine` + real pi + the synthesized frame now returns `degenerate`, not `completed` (`tests/homeserver-code-loop-engine.test.ts` §10 cases + a live e2e driver).
- **Cap breach:** SIGTERM→SIGKILL on the process group; because a mid-stream kill is an abrupt client disconnect *at the gateway*, disconnect-keyed poison-clear fires automatically — no manual `reset_model()` dance.
- **NDJSON hygiene:** unparseable lines tolerated (counted, never fatal); the event contract is unversioned, so the monitor is written against a **recorded fixture from a real box session**, pinned into the test suite (delivery must-fix).
- **Spawn/cage/lease failures:** immediate structured refusal at `start`; never a half-run.
- **Gateway restart mid-run:** startup sweep → `orphaned` + best-effort harvest (§5).
- **Client disconnect:** irrelevant by construction — the job API decouples the run from any single MCP call; the ledger write and sandbox retention happen regardless of whether anyone is polling.

---

## 11. Test plan

**Unit (offline, vitest, fake spawn — red/green first):**
1. Owner gating: guest principal ⇒ `tools/list` omits all three tools; guest `tools/call` ⇒ byte-identical unknown-tool error (assert exact bytes against a real unknown tool's error).
2. Seed containment: reject `../x`, `/etc/x`, and a symlink-parent escape (write failing tests first).
3. Caps: canned NDJSON streams triggering turn/token breach ⇒ kill + `cap-exceeded` + diff harvested.
4. Diff harvest from a real tmp sandbox after fake-pi writes/modifies files; changed-file containment re-validation; `protected` glob violation detection at exit.
5. Job lifecycle: start/status/result; single-flight `busy`; orphan sweep on a synthetic stale `.meta.json`; result re-fetchable; TTL reclaim.
6. Outcome-mapping table (status × check → ledger outcome), including degeneracy → `error/infra`.
7. Degenerate-retry state machine with a scripted readiness probe.

**Fixture (red/green):** seed gate-d task 01's shape, fake pi applies the known solution, assert `check_cmd` pass → ledger `pass`.

**Box integration (manual, gpu-run-wrapped where CLI-driven):**
1. **Cage self-test** passes on the live box (secrets unreadable, egress blocked, gateway reachable) — ship gate.
2. Record one real pi NDJSON session → pin as fixture → then write/verify the monitor against it.
3. One real end-to-end run from a laptop Claude Code session via the live MCP: verify `owner_request_log` rows under the service alias, ledger row `source=code-loop`, sandbox retention, result fetch after the run completes.
4. Forced degeneracy / mid-run kill: verify poison-clear fires and the retry path behaves (§10).

**Acceptance gate (before default-on / routing-table entries — native-driver's discipline):** run the full 10-task gate-d battery *through the shipped tool* as a fourth arm (`wrapped`), `check.sh` grading unchanged. Expectation ≥9/10; a material regression vs raw pi's 10/10 means the seeding/cage/gateway-indirection layers cost capability and must be diagnosed before the tool's data is trusted for RQ7 comparisons.

---

## 12. Phase 1 (this session) vs Later

**Phase 1 (ship gates, in order):**
1. Box provisioning: pinned pi vendor install (+ verify package scope/version and available tool-restriction flags), `PI_CODING_AGENT_DIR` + `models.json` rendered with the tailnet gateway host, timestamped-alias service key mint (allow-listed + quota'd), `apt install bubblewrap`.
2. `code-loop-cage.ts` + **cage self-test passing on the box** (hard gate — fallback per §6 if not).
3. Record real pi NDJSON fixture; verify pi's aborted-stream behavior (§10).
4. `code-loop-types.ts`, `code-loop.ts`, `pi-engine.ts`: inline-files seeding, async job triple, caps, mutex + gpu-lease + maintenance refusal, retention + sweep, diff contract, ledger row, metrics.
5. `mcp.ts` owner-gated tool exposure (invisible + identical-error); `config.ts` flags (default `off`).
6. Unit tests + fixture test green; README update; rsync deploy + gateway restart; one live end-to-end smoke from a laptop session.

**Later:**
- Gate-d `wrapped` arm + ≥9/10 acceptance run; then `docs/m5-routing.json` agentic-vs-single-shot entry (the RQ7 payoff).
- Dedicated unprivileged uid for the cage (pending Open Question 2); prefer-no-swap admission affinity; Heimdall panel from `source=code-loop` ledger rows.
- Git-URL / tarball seeding for larger contexts.
- Native in-process `AgentEngine` implementation for a pi-vs-native A/B under identical sandbox + grading (free-choice's seam — itself prime RQ7 harness-vs-model data), only *after* pi-subprocess data shows where pi falls short.
- Optional no-bash mode as a config knob once pi's tool-restriction flags are verified.
- `/v1/responses` shim etc. remain out of scope (per gate-de plan).

---

## 13. Open questions for the project owner

1. **Bash-in-cage vs no-bash.** The issue says "no arbitrary shell"; this design ships pi's bash *inside* a tested OS cage (sandbox-only FS view, gateway-only egress, memory/task caps) on the argument that a caged shell isn't arbitrary — preserving the exact 10/10 configuration. The alternative (no-bash + harness-run `check_cmd`) is strictly safer but risks the 6/10 outer-loop regression and depends on an unverified pi flag. Which reading of the trust boundary do you want?
2. **Dedicated unprivileged uid.** The security lens's strongest ask is running the agent as a separate user, which needs sudoers provisioning by you. Is the bwrap + systemd-scope cage (with the self-test) sufficient for Phase 1, or do you want to hold unattended use until a `code-loop` user exists?
3. **MCP registration path.** With the async job API, the existing Cloudflare-fronted `https://inference.example.com/mcp` registration works (all calls are short). Do you also want an owner-only tailnet MCP registration on the laptop for latency/robustness, or keep one registration?
4. **Interleaved-usage policy.** Mid-run owner `ask`s to mellum cost an 80b↔mellum swap pair each. Phase 1 accepts + meters this; do you want the prefer-no-swap admission affinity prioritized instead?
5. **Wall-clock ceiling.** 480 s default / 900 s hard max is sized for gate-d-class sub-tasks. With async in place there's no transport reason not to raise the ceiling for bigger tasks — raise it now or after the first real-usage data?
6. **Owner-tier service key scope.** The key is owner-tier (required for `owner_request_log`) but allow-listed to the 80b with quotas. Comfortable with an owner-tier credential living in the caged subprocess env, or do you want a keystore change (e.g. a `service` tier that logs like owner but can't touch admin surfaces) before ship?

---

## Appendix: judge must-fix traceability

| # | Must-fix (lens) | Disposition |
|---|---|---|
| S1 | OS-level FS isolation in Phase 1 (dedicated uid or ProtectHome/ReadWritePaths/IPAddressDeny equivalent) | **Addressed** — mandatory cage + self-test ship gate (§6); dedicated uid → Open Q2 |
| S2 | Check-runs on model-authored code = RCE; zero secret access + no egress, OS-enforced | **Addressed** — `check_cmd` runs inside the same cage; tmpfs hides `.env`/`eval.db`; egress blocked (§6) |
| S3 | `resolveContained` is lexical (no realpath), guards seeding only; mediate runtime writes; fix the false symlink claim | **Addressed** — realpath + `wx` hardening on seeds (§5); runtime containment via the cage, explicitly not lexical (§6); no symlink claim is made anywhere |
| S4 | Owner gate `tier==="owner" && keyHash!==null` + byte-identical unknown-tool error | **Addressed** — §6 table; exact-bytes unit test (§11) |
| S5 | Egress blocked (gateway-only) in Phase 1 — owner key exfiltration path | **Addressed** — `IPAddressDeny=any` + gateway-host allow, cage self-test asserts it (§6); key additionally allow-listed + quota'd |
| S6 | Direct `:8091` loses watchdog/poison-clear | **Addressed by architecture** — all turns transit the gateway (§2) |
| O1 | Sync tools/call dies at Cloudflare ~100 s; async or verified tailnet path in Phase 1 | **Addressed** — async job triple is Phase 1 (§4); tailnet registration → Open Q3 |
| O2 | pi baseUrl must be the configured bind host (tailnet), not loopback; don't rebind; reconcile IPAddressAllow | **Addressed** — §3 provisioning step 2, §6 cage allow rule |
| O3 | Bound the subprocess tree Phase 1 (MemoryMax/TasksMax) or ship no-bash | **Addressed** — scope properties (§6, §7); no-bash fallback documented |
| O4 | Retain sandbox + return work_id on ALL statuses incl. completed | **Addressed** — §5 retention + 24 h TTL sweep |
| O5 | Empirically verify pi's behavior on a watchdog-aborted stream before trusting loop state | **DONE 2026-07-03** — verified live; found pi exits 0 on a degeneracy abort (stopReason:"error" only) so the harness silently completed the truncated turn; fixed with the `turnErrorOf` per-turn integrity check (§10) |
| O6 | Decide + document mid-loop swap-thrash policy + metric | **Addressed** — §8 (accept + meter); affinity → Later + Open Q4 |
| O7 | Adopt maintenance-mode refusal, stale-sandbox sweep, growth cap | **Addressed** — §4 refusals, §5 sweep, §7 growth cap |
| O8 | Gate-d battery through the shipped tool as acceptance gate | **Addressed** — §11 acceptance gate (≥9/10 before default-on) |
| D1 | Tailnet base URL (= O2) | **Addressed** (see O2) |
| D2 | OS confinement Phase 1 (= S1/O3) | **Addressed** (see S1) |
| D3 | Record real NDJSON + verify models.json env-var expansion before writing the monitor; pin fixture | **Addressed** — §3 step 5, §10, §11 |
| D4 | Default wall ≤480 s; define orphaned-run semantics | **Addressed** — §7 default; §5/§10 orphan handling (async makes ledger/diff survive disconnects by construction) |
| D5 | Byte-identical unknown-tool error (= S4) | **Addressed** (see S4) |
| D6 | Adopt degenerate-round retry + maintenance refusal | **Addressed, corrected** — readiness-polled retry (not fixed 10 s; the two lenses conflicted and ops' cold-reload objection wins) (§10); maintenance refusal (§8) |
| D7 | `keys mint` rejects reused aliases — timestamped alias runbook | **Addressed** — §3 step 3 |
