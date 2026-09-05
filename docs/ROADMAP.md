# Roadmap

**Last updated:** 2026-09-05

**Architecture:** [`architecture.md`](./architecture.md)

**Execution detail:** repository issues and pull requests. Private operator handoffs are not
tracked in this repository.

## Direction

The project has moved from evaluating a possible hardware purchase to operating and improving the
inference/evidence subsystem beneath Grimnir.

The objective is not to make every call local. It is to move bounded work onto owned compute when
privacy policy permits and capability evidence says quality will hold, while keeping the strongest
available model in the human-facing Conductor seat.

## Phases

| Phase | Outcome | State |
|---|---|---|
| 1. Model and hardware evaluation | Screen local candidates and decide whether to acquire hardware | **Complete** |
| 2. Production M5 serving | Authenticated gateway, llama-swap, admission, quotas, metrics, resilience | **Complete/deployed** |
| 3. Capability routing | Task taxonomy, verifiers, ledger, routing table, safe regression handling | **Complete/deployed** for eligible lanes |
| 4. Hybrid migration gates | Decide frontier versus local Conductor, local leaves, harness, serving | **Complete**: hybrid GO, local Conductor NO-GO |
| 5. Learning from real work | Owner-only harvest, shadow policy, cost traces, trustworthy promotion | **In progress/shadow** |
| 6. Durable fleet delegation | Hugin task lifecycle, node/provider routing, bounded agentic leaves | **Deployed; expired adoption trial needs outcome reconciliation in M2** |
| 7. Trust-aware resilience | End-to-end sensitivity and tested local/controlled/general-external fallback | **Partial** |
| 8. Evidence-maintained capability substrate | Manual model evaluation, guarded roster decisions, regression detection, actionable observability | **Partial/deployed** |

Hugin's expired validation window and pre-registered keep/reduce/remove thresholds are in
[`hugin-role-validation.md`](./hugin-role-validation.md).

## Near-term proof obligations

### Ordered delivery milestones

Execute M1 → M2 → M3. Each milestone has a finite acceptance boundary; a merged PR is
source evidence, not deployment or demonstrated organic usefulness. Individual implementation
leaves use separate worktrees, regression tests, independent review, and a PR before merge.
The Conductor owns integration, quality, and any separately authorized operational action.
Current issue bodies and acceptance evidence win over historical issue titles.

| Milestone | Finished outcome | State |
|---|---|---|
| **M1 — Paired quality-protected release** | The schema-grounding gateway and matching client are released together, verified, and recoverable | **Active:** [#277](https://github.com/Magnus-Gille/gille-inference/pull/277) and client 1.3.6 preparation [#278](https://github.com/Magnus-Gille/gille-inference/pull/278) merged; paired rollout not yet accepted |
| **M2 — Auditable usefulness baseline** | Exact model/task feedback works and a reproducible organic-use report states what is proven, failed, or unknown | **Next:** [#243](https://github.com/Magnus-Gille/gille-inference/issues/243), [#245](https://github.com/Magnus-Gille/gille-inference/issues/245) |
| **M3 — One qualified automatic lane** | One narrow lane completes a predeclared canary and receives an evidence-backed keep/revert decision | **Gated:** [#85](https://github.com/Magnus-Gille/gille-inference/issues/85); other lanes remain shadow |

#### M1 activities and acceptance

1. Finish the reviewed version/package contract in #278. Verify exact client archive contents,
   package/CLI version parity, focused client/bridge/package tests, typechecks and CI. Retain the
   already-reviewed #277 behavioral regression evidence; do not call packaging tests model evals.
2. Record an immutable paired release and verified previous client/gateway rollback artifacts.
   Check compatibility for long-lived MCP bridges and outstanding v8 code-loop work before the
   v9 switch. Do not assume a package install updates an already-running bridge.
3. Obtain just-in-time approval for the exact artifact, publication/install actions, release SHA,
   target, canonical deploy/verify commands and paired rollback. Coordinate an idle window with
   other sessions and preserve bandwidth headroom; do not interrupt their downloads or jobs.
4. Publish and verify the package bytes, install the accepted client, refresh affected clients
   with their owners, and deploy through the authoritative [runbook](../deploy/README.md).
5. Verify source identity, health, authenticated capability and client/gateway contract parity.
   Record an explicitly authorized bounded smoke for both a rejected schema-mismatched result
   and a valid result, or keep that live behavioral proof visibly outstanding. Such smoke is
   synthetic compatibility evidence, not organic model quality. On failure, restore the accepted
   previous gateway/client pair and verify it; a restored old pair is not M1 success.

**Done when:** review/CI/package gates pass, the paired install and production verification pass,
the compatibility smoke passes, and a sanitized release receipt links the evidence. Exact operator
paths, live state, credentials and deployment coordination stay in the private operations tracker
or local handoff. No roster, routing, model, host-profile or credential rotation is included.

**Expected benefit:** reject some wrong generated tests before acceptance, with clearer failure
diagnostics and less downstream rework. Extra verification can add latency; no claim of faster
tokens, reduced memory use or measured organic savings follows from shipping this milestone.

#### M2 activities and acceptance

1. Reconcile existing #243/#245 implementations and missing acceptance evidence before coding.
   Keep the already-shipped measurement-epoch repairs; never invent historical attribution.
2. Implement #243's owner-authorized opaque feedback handle bound to the exact model/task
   execution. Cover synchronous and durable asynchronous results, retry/restart idempotence,
   conflicting feedback rejection and access isolation. Keep usefulness separate from a
   deterministic verifier result; feedback alone must not change routing.
3. Add content-blind model × task × source × usefulness reporting, including absent feedback,
   eligibility/attempt denominators, policy epochs, retention and unknown attribution. Test
   joins, duplicate/conflicting submissions, missing rows and privacy boundaries with fixtures.
   Export only closed low-cardinality dimensions with an explicit unknown bucket, never raw labels.
4. Complete #245's reproducible read-only evidence bundle and publish the sanitized report.
   Preserve its predeclared target of at least 20 eligible organic opportunities and at least
   60% useful completions among attempts; separate organic work, synthetic probes and evaluation.
   This is the overdue 2026-08-28 review: freeze and record the historical trial bounds plus a
   separate current-policy snapshot cutoff before export. Produce the decision from that fixed
   bundle without waiting for additional samples; insufficient evidence means HOLD, not GO.
   Report pass/fail/unknowable rather than manufacturing enough favorable samples. A new
   collection window must be declared prospectively, not substituted for the overdue review.
5. Record queue/busy rates, latency, operator rework, feedback coverage and cost provenance where
   available. Missing cost or memory measurements remain unknown, not zero or inferred savings.
   Open tightly scoped follow-ups for gaps that prevent a decision.
6. Reconcile the Hugin trial that ended 2026-08-22 against its existing keep/reduce/remove
   contract. Link the owning repository's recorded decision, or record the exact evidence gap
   and route a bounded follow-up to that owner. Do not extend the trial silently, change Hugin
   here, or count direct M5 work and synthetic smoke as durable Hugin demand.

**Done when:** #243's tests/review and authorized rollout are accepted, and #245 has a reproducible
report with explicit denominators, missingness and a next decision, plus an explicit Hugin
outcome/gap handoff. An honest negative or
unknowable report completes the measurement milestone, but cannot authorize M3 promotion.

**Expected benefit:** know which model/task pairs actually save work, instead of optimizing for
attempt counts, syntactically valid output or impressive benchmark scores.

#### M3 activities and acceptance

1. Select exactly one low-blast-radius, non-judgment-bearing task lane from current evidence.
   Predeclare the #85 quality/sample, availability, latency and cost gates, observation window,
   trusted behavioral verifier, canary ceiling, watchdog and keep/revert rules before enabling it.
2. Calibrate the relevant marginal/amortized costs in
   [#82](https://github.com/Magnus-Gille/gille-inference/issues/82). Separate verified displaced
   frontier work from shadow projections; report cost per accepted task, including retries and
   verification. Keep privacy/destination eligibility ahead of cost optimization.
3. Resolve the selected lane's blocking availability and authority prerequisites. Test outage,
   cancellation, restart/recovery, contention and rollback before the operational decision.
4. Only after the evidence gate passes and the exact operational change is authorized, use the
   fail-closed routing writer/diff path for a bounded canary. Observe the predeclared window and
   publish a keep/revert decision with quality, latency, availability and cost evidence.

**Done when:** the qualified canary has completed its observation and a verified keep or revert
decision is recorded. A pre-canary HOLD is safe progress but leaves M3 incomplete. Expanding to
other lanes needs a new acceptance decision; no generic local Conductor or autonomous review.

### Prioritized supporting backlog

These are concrete follow-up activities, not prerequisites that silently expand M1. Reconcile
implemented portions before opening a new PR. Use the smallest issue-scoped change first.

| Order | Activity / existing tickets | Completion evidence and placement |
|---|---|---|
| P0, parallel triage | Audit remaining credential-lifecycle/provisioning acceptance: [#152](https://github.com/Magnus-Gille/gille-inference/issues/152), [#184](https://github.com/Magnus-Gille/gille-inference/issues/184), [#56](https://github.com/Magnus-Gille/gille-inference/issues/56); scope private review authority in [#249](https://github.com/Magnus-Gille/gille-inference/issues/249) | Secret-safe inventory and consumer tests; narrow scopes, overlap/rollback and retired-key rejection for separately approved rotations. No private-review expansion before its authority contract is accepted. Escalate a confirmed active risk ahead of feature work. |
| P1, M2 support | Close remaining diagnostic gaps in [#242](https://github.com/Magnus-Gille/gille-inference/issues/242); define durable queue [#63](https://github.com/Magnus-Gille/gille-inference/issues/63), upstream owner priority [#18](https://github.com/Magnus-Gille/gille-inference/issues/18), exclusive maintenance [#196](https://github.com/Magnus-Gille/gille-inference/issues/196) | Redacted failure diagnostics; deterministic queue/restart/cancel/preemption tests. Measure busy/retry reduction against a baseline; don't claim parallel GPU capacity. Implement only selected blockers before M2/M3 acceptance. |
| P1, quality exclusions | Preserve negative regressions for unsafe/inaccurate assistance: [#237](https://github.com/Magnus-Gille/gille-inference/issues/237), [#228](https://github.com/Magnus-Gille/gille-inference/issues/228), [#25](https://github.com/Magnus-Gille/gille-inference/issues/25) | Wrong-answer controls remain rejected; these judgment-bearing tasks stay excluded from automatic promotion without trusted ground truth. |
| P2, after baseline | Certify effective context [#125](https://github.com/Magnus-Gille/gille-inference/issues/125), query-aware provenance [#126](https://github.com/Magnus-Gille/gille-inference/issues/126), decoding [#124](https://github.com/Magnus-Gille/gille-inference/issues/124), verifier-guided compute [#127](https://github.com/Magnus-Gille/gille-inference/issues/127), model pairing [#128](https://github.com/Magnus-Gille/gille-inference/issues/128) | One intervention at a time on saved comparable tasks; quality, wall time, memory and cost per accepted result. Retain failures and compare against an unchanged baseline. |
| P2, serving lifecycle | Protected observer [#113](https://github.com/Magnus-Gille/gille-inference/issues/113), transactional roster [#217](https://github.com/Magnus-Gille/gille-inference/issues/217), readiness evidence [#250](https://github.com/Magnus-Gille/gille-inference/issues/250) | Test full serving contracts, synthetic labels and rollback; route cross-repository work to its owner. Source merge does not promote a live model. |
| P3, bounded research | Architecture-specific backend [#129](https://github.com/Magnus-Gille/gille-inference/issues/129), speculation [#130](https://github.com/Magnus-Gille/gille-inference/issues/130), host profile [#195](https://github.com/Magnus-Gille/gille-inference/issues/195), LocalAI [#212](https://github.com/Magnus-Gille/gille-inference/issues/212), DwarfStar [#262](https://github.com/Magnus-Gille/gille-inference/issues/262), scout [#181](https://github.com/Magnus-Gille/gille-inference/issues/181), exploration hypothesis [#252](https://github.com/Magnus-Gille/gille-inference/issues/252) | Predeclared isolated A/B study and GO/HOLD report under a separately approved evaluation envelope; no competing GPU jobs, production changes or relaxed memory safeguards. |
| P3, client reach | Windows support [#266](https://github.com/Magnus-Gille/gille-inference/issues/266) | Native secret-safe provisioning/transport/package tests and documented support boundaries, in a separate client worktree. |

Parallelism is for independent tests, fixtures, evidence inventories and scoped implementations.
It does not authorize concurrent production operations, overlapping file ownership or extra GPU
experiments. Hugin/fleet value and end-to-end trust obligations below remain in force.

### Evidence integrity

- Preserve structured OpenAI message content in agentic owner traffic.
- Version task interpretation and judge policy so corrected semantics can be re-applied safely.
- Accumulate a clean current-policy sample before enabling production harvest.
- Keep judgment-quality lanes behind trusted-verifier allow-lists.

### Hugin value

- Dogfood recurring tasks that genuinely benefit from durability or macro-routing.
- Measure useful completion, continuation after L1 closes, operator attention saved, and operational
  maintenance.
- Keep generic mini-Conductor expansion frozen unless a narrow task shows a measured quality,
  availability, cost, or repeatability advantage.
- Keep direct M5 access available; do not inflate Hugin usage by forcing interactive inference
  through it.

### Trust and fallback

- Carry sensitivity and allowed destinations from L1 through Hugin, gateway, harness, judges, and
  evidence.
- Distinguish owned/local, controlled external such as Berget, and general external providers.
- Test explicit outage/fallback behavior without silently weakening data policy.

### Economics

- Base savings on verified displaced frontier calls.
- Calibrate local energy/amortization assumptions against real utilization.
- Report shadow projections separately from realized savings and total hardware ROI.

## Longer horizon

- Re-test the local Conductor seat only when a specific intervention targets the measured
  under-reading and gap-blindness failures.
- Expand local agentic execution when task envelopes, cages, and verifiers support it—not merely
  because a larger model is available.
- Allow model and harness rosters to change underneath stable task, policy, and evidence contracts.
- Keep Grimnir useful during individual provider, subscription, hardware, and geopolitical failure
  modes without promising a quality level the fallback has not earned.

## Explicit non-goals

- Replacing Claude Code/Codex with a weaker local clone for ideological symmetry.
- Turning Hugin into a second general-purpose Conductor.
- Duplicating the capability ledger in Hugin.
- Sending sensitive work to a cheaper but ineligible destination.
- Claiming autonomous self-improvement from shadow evidence.
