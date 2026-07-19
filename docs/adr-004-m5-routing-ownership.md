# ADR-004: M5 routing ownership — Hugin macro-routes nodes, homeserver micro-routes models, the ledger is the one knowledge base

- **Status:** Accepted, implemented, and live-validated
- **Date:** 2026-06-16
- **Last reconciled:** 2026-07-11
- **Deciders:** project owner
- **Context repos:** `hugin`, `gille-inference` (`src/homeserver/`), `grimnir`
- **Supersedes:** nothing. **Related:** [`bosgame-m5-architecture.md`](./bosgame-m5-architecture.md).
- **Provenance:** the original context and code references were verified on 2026-06-16. The M5,
  llama-swap gateway, Hugin integration, ledger routing, and explicit Orin backend have since shipped.
  Historical pre-arrival details are retained below where they explain the decision; current
  architecture is [`architecture.md`](./architecture.md).

## Context

> **Amendment — 2026-07-10, issue #206 (Orin Nano): Hugin-owned routing retained.**
>
> The gateway is not promoted to a fleet dispatcher. Hugin remains the only macro-router and
> decides whether a task targets `m5`, `orin`, laptop, Pi, or frontier. To give trusted callers one
> authenticated serving surface without a second routing brain, the gateway accepts an *explicit*
> `node: "orin"` (raw OpenAI chat) or `nodeId: "orin"` (`/delegate`) hint. It never selects Orin
> by itself. `nodeId:"orin"` is accepted only for the configured `qwen2.5-coder:3b` and configured
> eligible task types; unsuitable, offline, timeout, and busy cases surface a bounded OpenAI error
> or an escalated delegation. Hugin consumes that result and re-routes to M5 or frontier. This is a
> retry/fallback contract, not autonomous gateway node selection.
>
> The homeserver SQLite ledger remains the single authoritative capability ledger. Every evidence
> row has `node_id` (`m5` for historical rows; `orin` for the remote backend), so identical model
> names can never combine evidence across hardware. Content-blind request logs and metrics likewise
> stamp the actual node. The shared Orin/drone GPU is protected by keeping the gateway's normal
> auth, per-key quotas, and owner-preempting admission spine in front of the remote hop; Hugin must
> also treat Orin's returned busy/unavailable result as a macro-routing signal rather than retrying
> blindly.

At decision time, two independent routing layers existed and had **never coordinated**:

1. **Hugin** (`hugin/src/router.ts`, `runtime-registry.ts`, `ollama-executor.ts`) — the live task dispatcher. `routeTask(input): RouterDecision` selects a runtime from `RUNTIME_REGISTRY` by a static pipeline: trust filter → availability → `autoEligible` → capability filter → model-affinity → sort by `costModel` then `trustTier` then `modelSize`. It then invokes the runtime directly via `executeOllamaTask()` (OpenAI-compat `/v1/chat/completions`, or Ollama-native `/api/chat` for reasoning families). **No verifier, no learned signal — the registry is static config.**

2. **Homeserver** (`src/homeserver/orchestrator.ts` `delegate()`, `ledger.ts`, `taxonomy.ts`, `verifier.ts`) — the M5-targeted serving spine. `delegate(task): DelegationOutcome` does `classifyTask()` → ledger-gated `shouldDelegate()` → `runLmStudioInference()` (AbortController timeout) → optional `verifier()` → `recordDelegation()` to the `delegations` SQLite table → escalates to a frontier model when `shouldDelegate()` blocks a frozen verdict (`not_viable` *or* `marginal`) or the local attempt returns a `fail`/`error` outcome. **This is the learned router and the capability knowledge base** — it directly answers RQ7 ("which node+model is best per task type").

The **BosGame M5 (Strix Halo, 128GB)** was the intended flagship local node. It is now deployed
behind the gateway and represented in the fleet. The failure mode this ADR prevented remains
relevant: two routing brains building divergent capability databases would make RQ7 unanswerable.

The two layers are **not duplicates — they are different altitudes** of the same decision. This ADR
keeps that seam stable as nodes, models, and harnesses change.

## Decision

Adopt a three-part ownership split, with the **ledger as the single source of truth** for capability:

| Concern | Owner | Mechanism |
|---|---|---|
| **Intake + macro-routing** (*which node/provider?*) | **Hugin** | Hugin selects among eligible nodes/providers for durable tasks; the M5 is one runtime behind the homeserver gateway. |
| **Micro-routing** (*which model on the M5?*) + serial-GPU admission + external gateway/keystore/quota | **Homeserver** | `orchestrator.delegate()` + `admission.ts` + `gateway.ts` + `keystore.ts`. |
| **Capability knowledge base** (*is node N/model M viable for task_type T?*) | **Homeserver `ledger.ts`** | Single DB. Hugin consumes or submits evidence through the gateway contract; it does **not** maintain a competing capability truth. |

This decision governs the durable delegated-task path. It does **not** require interactive clients
or an L1 Conductor to traverse Hugin before calling the authenticated M5 OpenAI/MCP surfaces.

Concretely:

### 1. Hugin treats the M5 as one node behind the gateway (macro)

The gateway is the only M5 serving surface Hugin needs to know about. Hugin uses the configured
gateway URL and an owner-tier credential; external clients use the same admission spine through the
published gateway surface.

**Historical implementation note.** This was real work rather than a registry-only change. It
required the Hugin gateway runtime/provider, URL and Bearer-auth path, registry entry, and dual
dispatch handling. Those foundations are now implemented; the original required shape was:

- Extend the `DispatcherRuntime` union (`runtime-registry.ts:13`) with `"homeserver"` (currently closed: `"claude"|"codex"|"ollama"|"openrouter"|"pi-harness"`).
- Extend `Provider` with `"homeserver-gateway"`.
- Add a `baseUrl` carrier for non-Ollama HTTP runtimes — `ollamaHost` is closed to `"pi"|"laptop"|"orin"` in the registry/pipeline types (the raw task parser accepts a free string, but host resolution only knows that three-host map), and `ollama-executor.ts` builds its URL from `OllamaHost.baseUrl` only. The M5 needs its own URL field + an env var (e.g. `HOMESERVER_GATEWAY_URL`).
- Add a **Bearer-auth executor**: `ollama-executor.ts` has no `Authorization` header path. The gateway requires `Bearer hs_owner_…`. Hugin holds an **owner-tier** key (it is the trusted orchestrator, not a guest).
- Register the node:
  ```ts
  {
    id: "lmstudio-m5",
    dispatcherRuntime: "homeserver",      // NEW variant
    provider: "homeserver-gateway",       // NEW variant
    trustTier: "trusted",
    costModel: "free",
    modelSize: "large",
    capabilities: ["code", "tools", "structured-output"],
    egress: "local",
    autoEligible: true,
    family: "one-shot",
    // baseUrl resolved from HOMESERVER_GATEWAY_URL
  }
  ```

### 2. Two call paths into the M5 — pick by intent

The gateway already exposes both (verified live in `gateway.ts`):

| Path | Endpoint | Auth | Returns | Use for |
|---|---|---|---|---|
| **Raw inference** | `POST /v1/chat/completions` | permitted key tier | OpenAI chat completion | latency-sensitive passthrough and agent inner loops; operational/owner-shadow evidence but no synchronous verifier verdict |
| **Verified delegation** | `POST /delegate` | **owner only** | `DelegationOutcome` (verified, ledger-recorded) | **nightly/autonomous local sub-tasks** — runs the verifier and teaches the ledger |

**Rule:** Hugin routes **nightly/autonomous local sub-tasks through `/delegate`**, not raw `/v1/chat/completions`. This is the only way the ledger observes real traffic and RQ7's feedback loop closes. The executor must handle both response shapes (chat-completion vs `DelegationOutcome`).

### 3. Capability evidence is centralized, never replicated

- Homeserver `ledger.ts` stays the owner of the `delegations` table and verdict logic
  (`getVerdict`, `shouldDelegate`, freeze-on-failure at `maxFails`/`maxSamples`). External probe,
  harvest, or Hugin-produced evidence becomes capability evidence only through the gateway/repo's
  defined write or import path.
- Hugin's macro-router consumes `GET /ledger` as a **capability signal**: *the M5 is viable for `task_type T` if any M5-resident model has a `viable` verdict for T.* The gateway then micro-selects the specific model.
- Hugin may retain operational task outcomes: lease, attempt, duration, delivery, backend errors,
  and whether a Hugin-level workflow accepted a result. Those records must not be interpreted as a
  second node/model/task capability ledger.
- **Do NOT** create a second capability verdict store in Hugin. One capability DB, one truth.

### 4. Micro-routing selects from adopted evidence

The routing-table path now maps task types to an adopted serving-model identity and is enabled on the
live box. llama-swap owns residency and switching. Unknown, frontier, and regressed routes remain
explicit rather than silently choosing the first loaded model.

## The minimal interface every inference node must expose

So the macro-router can treat all nodes uniformly:

| Capability | Ollama nodes (pi/laptop/orin) | M5 gateway | Normalize to |
|---|---|---|---|
| Inference | `POST /v1/chat/completions` ✅ | `POST /v1/chat/completions` ✅ | `/v1/chat/completions` |
| Model list | `GET /api/tags` | `GET /models` | router adapter maps both |
| Health | (none) ❌ | `GET /healthz` ✅ | add a probe for Ollama hosts |
| Verified delegate + learning | ❌ (not available) | `POST /delegate` ✅ | M5-only; raw nodes stay unlearned for now |
| Model mgmt (load/unload/swap) | `ollama pull/rm` | `/admin/models/{load,unload,download}` (LM Studio `lms` CLI) ✅ | homeserver-owned; M5-only |

## Target end-to-end routing flow

```
task ─▶ Hugin: classify sensitivity + capabilities (router.ts)
      ─▶ Hugin macro-router: candidate nodes (trust/availability/cost)
           └─ for local nodes, consult GET /ledger for task_type viability
      ─▶ pick node
           ├─ M5 + autonomous/nightly  ─▶ POST /delegate (owner key)
           │      └─ homeserver: ledger-gate ─▶ pick best M5 model (by verdict)
           │         ─▶ admission (owner preempts guest, serial GPU)
           │         ─▶ model load/swap owned by llama-swap on M5, NOT the gateway (see follow-up #3)
           │         ─▶ run ─▶ verify ─▶ recordDelegation()  ── ledger learns
           ├─ M5 + interactive passthrough ─▶ POST /v1/chat/completions
           └─ other node/provider ─▶ its adapter (only when task policy permits)
```

## Consequences

**Positive**
- One routing DB. RQ7 stays answerable; the nightly loop teaches a single ledger.
- The M5 is a clean node abstraction for Hugin; external users hit the *same* gateway as the orchestrator, so admission/quota are uniform.
- Clear blast radius: external exposure is the gateway only; Hugin stays internal/trusted.

**Negative / cost**
- Real (bounded) work in Hugin: two union extensions + a baseUrl carrier + a Bearer executor. Not a config line.
- Nodes without verifier-backed imports remain *unlearned* for autonomous capability routing. Orin
  can now execute behind the gateway with node-stamped evidence, but unverified runs still do not
  create viable verdicts.
- Hugin must hold and protect an owner-tier gateway key.

**Neutral**
- Hugin need not be present for direct interactive use. That is resilience and separation of
  concerns, not a bypass of the durable-task architecture.

## Alternatives considered

1. **Fold homeserver routing into Hugin (one router, one repo).** Rejected: Hugin's router is static-config + trust/cost; it has no verifier, no learned verdicts, no serial-GPU admission, no multi-tenant keystore. Rebuilding all of that in Hugin throws away the strongest, most-tested code in the fleet.
2. **Fold Hugin into homeserver (gateway becomes the only orchestrator).** Rejected: Hugin owns intake, the Munin task lifecycle (lease/CAS), signing, and multi-node dispatch (pi/laptop/orin/cloud). The M5 gateway is single-node by design. Homeserver shouldn't grow a fleet dispatcher.
3. **Replicate the ledger into Hugin (each keeps its own).** Rejected outright — this is precisely the divergence this ADR exists to prevent.

## Historical open questions and current disposition

- **Backend:** settled on llama-swap/llama-server for production. LM Studio administration is
  deprecated compatibility code.
- **Fleet identity:** the M5 and Orin are represented in Grimnir's node catalogue.
- **Task signing:** remains Hugin-owned security policy and must retain replay protection before any
  broader untrusted intake.
- **Delegation envelope:** sensitivity, destinations, budgets, acceptance, and nested harness
  authority are specified in [`task-delegation-contract.md`](./task-delegation-contract.md) but not
  yet fully encoded end to end.

## Required follow-up (tracked, not in this ADR's scope)

1. ✅ **Done** (grimnir #29): `grimnir/services.json` gained a `nodes` array (M5/Orin/laptop/skald/pi/nas with `role`) + `QUERY=nodes`. The Hugin ollama-hosts / `heimdall.config.json` derive-or-cross-check remains a deferred coupling change. *(grimnir)*
2. ✅ **Done** (#9): gateway per-request structured access logging (`access-log.ts`) + a `delegate_decision` line in `delegate()`. *(gille-inference)*
3. ~~Wire `setActiveModel()` to serialize model swaps in the gateway.~~ **Resolved — not built: the gateway does NOT own model swapping.** The M5 topology is `gateway → llama-swap → llama-server`, so llama-swap (or LM Studio in the dev path) holds co-resident models and swaps them, routed by the request's `model` field. Building gateway-side swap serialization would fight llama-swap for ownership. `setActiveModel()`/`wouldSwapModel` are kept as inert, documented, test-covered hooks (`admission.ts`) for a hypothetical future where the gateway owns swap. *(gille-inference)*
4. ✅ **Done:** document the `GET /ledger` and `GET /models` JSON contracts in
   [`gateway-api-contract.md`](./gateway-api-contract.md). *(gille-inference)*
5. ✅ **Done:** implement the Hugin gateway runtime, configured URL, Bearer executor, M5 entry, and
   dual raw/delegate paths. *(hugin)*
6. **Current:** preserve the single-capability-ledger boundary as Hugin adds operational verdicts
   and new providers; make the distinction explicit in schemas and dashboards. *(hugin + this repo)*
