# Roadmap

**Last updated:** 2026-09-09

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
| 6. Durable fleet delegation | Hugin task lifecycle, node/provider routing, bounded agentic leaves | **Deployed; trial outcome/gap handed off, no trial reopened** |
| 7. Trust-aware resilience | End-to-end sensitivity and tested local/controlled/general-external fallback | **Partial** |
| 8. Evidence-maintained capability substrate | Manual model evaluation, guarded roster decisions, regression detection, actionable observability | **Partial/deployed** |

Hugin's expired validation window and pre-registered keep/reduce/remove thresholds are in
[`hugin-role-validation.md`](./hugin-role-validation.md).

## Near-term proof obligations

### Ordered delivery milestones

Execute M1 → M2 → M3 for the bounded routing path. M4 and M5 are independent workstreams with
the sequencing stated below. Each milestone has a finite acceptance boundary; a merged PR is
source evidence, not deployment or demonstrated organic usefulness. Individual implementation
leaves use separate worktrees, regression tests, independent review, and a PR before merge.
The Conductor owns integration, quality, and any separately authorized operational action.
Current issue bodies and acceptance evidence win over historical issue titles.

| Milestone | Finished outcome | State |
|---|---|---|
| **M1 — Paired quality-protected release** | The schema-grounding gateway and matching client are released together, verified, and recoverable | **Complete (2026-09-06):** client 1.3.6 / gateway v9 paired acceptance passed; [sanitized release receipt](https://github.com/Magnus-Gille/gille-inference/issues/285#issuecomment-5561882175). Readiness [#284](https://github.com/Magnus-Gille/gille-inference/issues/284) resolved by [#290](https://github.com/Magnus-Gille/gille-inference/pull/290) |
| **M2 — Auditable usefulness and provenance** | Exact model/task feedback, organic-use evidence, cost provenance with unknowns preserved, and a served-model provenance snapshot state what is proven, failed, or unknown | **Evidence/report acceptance complete; milestone release pending:** [#243](https://github.com/Magnus-Gille/gille-inference/issues/243) is closed after fresh canonical read-only deployed verification, with the sanitized closure record in [comment 5575645568](https://github.com/Magnus-Gille/gille-inference/issues/243#issuecomment-5575645568). [#293](https://github.com/Magnus-Gille/gille-inference/issues/293) is closed after a fresh but incomplete operator snapshot in [comment 5600506798](https://github.com/Magnus-Gille/gille-inference/issues/293#issuecomment-5600506798); implementation [PR #294](https://github.com/Magnus-Gille/gille-inference/pull/294) and process-view documentation [PR #302](https://github.com/Magnus-Gille/gille-inference/pull/302) provide traceability. Loaded-model binding remains unproven and unknowns are preserved. [#82](https://github.com/Magnus-Gille/gille-inference/issues/82) remains open but is deferred outside M2 pending suitable measured energy evidence, and [#245](https://github.com/Magnus-Gille/gille-inference/issues/245) has a [reproducible historical UNKNOWABLE/HOLD report](m2-adoption-review.md). Fresh prospective organic evidence is tracked separately in M3 [#308](https://github.com/Magnus-Gille/gille-inference/issues/308). |
| **M3 — First bounded routing canary** | One narrow lane completes a predeclared canary and receives an evidence-backed keep/revert decision | **Gated/HOLD:** parent [#85](https://github.com/Magnus-Gille/gille-inference/issues/85): the [#286](https://github.com/Magnus-Gille/gille-inference/issues/286) qualification report was delivered with a HOLD decision; [#287](https://github.com/Magnus-Gille/gille-inference/issues/287) and [#288](https://github.com/Magnus-Gille/gille-inference/issues/288) remain gated, and no lane is qualified. The strict v1 evaluator still cost-gates; [#304](https://github.com/Magnus-Gille/gille-inference/issues/304) adds a separate first-canary v2 contract with cost explicitly unassessed. No live candidate is qualified. [#306](https://github.com/Magnus-Gille/gille-inference/issues/306) tracks candidate-bound organic evidence export; other lanes remain shadow. #293 is not a blanket M3 blocker |
| **M4 — Reliable cross-platform agent access** | Supported M5 agent setup and recovery are repeatable on macOS and Windows | **Independent workstream:** guided provisioning [#184](https://github.com/Magnus-Gille/gille-inference/issues/184), connector/outage diagnostics [#242](https://github.com/Magnus-Gille/gille-inference/issues/242), and Windows distribution/credential-backend support [#266](https://github.com/Magnus-Gille/gille-inference/issues/266) |
| **M5 — Controlled runtime and model upgrades** | Runtime-update evaluation and hand-picked model promotion have controlled, recoverable paths | **Independent tooling/evaluation:** exclusive maintenance [#196](https://github.com/Magnus-Gille/gille-inference/issues/196), transactional roster promotion [#217](https://github.com/Magnus-Gille/gille-inference/issues/217), and the upgrade assessment [#280](https://github.com/Magnus-Gille/gille-inference/issues/280). Measured performance experiments follow the M2 baseline |

**Current M2/M3 status (2026-09-09).** M2 evidence/report acceptance is complete through the [historical adoption review](m2-adoption-review.md); the milestone release remains pending. Report acceptance does not establish organic usefulness or qualify M3. For [#82](https://github.com/Magnus-Gille/gille-inference/issues/82), the owner confirmed that no plug-level meter/UPS measurement is connected; a possible purchase remains undecided, and model specifications are not measured wall-energy evidence. #82 therefore remains open and deferred outside M2; resume it only with suitable measured energy evidence. Unknown costs remain unknown, with no savings or economic qualification claim and no product-TDP substitute. The conditional 2026-09-09–16 [#245 window](https://github.com/Magnus-Gille/gille-inference/issues/245#issuecomment-5584785708) did not start because its genuine-task feedback precondition was unmet before the boundary; any replacement window must be declared prospectively. The owner-declined [Hugin #165](https://github.com/Magnus-Gille/hugin/issues/165) trial was not reopened; its outcome/gap was handed off in [#245 comment 5584071494](https://github.com/Magnus-Gille/gille-inference/issues/245#issuecomment-5584071494). The strict v1 evaluator remains cost-gated and the historical M3 HOLD is unchanged. The explicit [first-canary v2 contract](m3-qualification.md) separates non-cost canary eligibility from full economic qualification; it does not supply missing production evidence. Next is [#306](https://github.com/Magnus-Gille/gille-inference/issues/306), reviewed non-cost thresholds and the prospective candidate-bound observations in [#308](https://github.com/Magnus-Gille/gille-inference/issues/308) before #287/#288. The historical #245 report is accepted as UNKNOWABLE/HOLD; this does not substitute for fresh observations. M2 still needs its milestone release receipt, and M3 remains gated.

#### M1 activities and acceptance — historical contract (completed 2026-09-06)

**Accepted outcome (2026-09-06):** the
[published receipt](https://github.com/Magnus-Gille/gille-inference/issues/285#issuecomment-5561882175)
records reviewed source/package gates, the explicitly approved paired installation, canonical
deployment verification, and both strict synthetic compatibility controls. The positive control
returned the exact allowed diff after compile and nonzero-test schema success. The negative
control compiled, failed the intended schema assertion, and withheld its diff and summary.
Both jobs completed cleanup, and final health, version and source verification passed.

Known-good gateway/client rollback artifacts were verified before the switch. Rollback readiness
is artifact/baseline verification here, not a claim that rollback was newly exercised in this
successful attempt. Idle work/bridge checks preceded the switch; disk installation was not
treated as refreshing an already-running bridge. The pre-switch check found no active code-loop
units, so there was no in-flight v8 code-loop work to carry across the v9 switch; this is an
idle-window result, not evidence that mixed-version in-flight execution is supported. Exact
operational evidence stays private.

The numbered contract below is the historical M1 acceptance boundary completed on 2026-09-06,
not a current task list. Its imperative verbs describe the requirements for that completed
acceptance, not future instructions. The conditional rollback requirement was not triggered.
Source history
remains in [#277](https://github.com/Magnus-Gille/gille-inference/pull/277),
[#278](https://github.com/Magnus-Gille/gille-inference/pull/278),
[#282](https://github.com/Magnus-Gille/gille-inference/pull/282), and
[#290](https://github.com/Magnus-Gille/gille-inference/pull/290). The latter records Claude Fable 5.1
review, CI, focused tests, and the passing bounded-parallel full suite, with the initial timeout
failures and reruns disclosed. Those checks are regression evidence, not model evaluations.

1. Complete bounded readiness source work in
   [#284](https://github.com/Magnus-Gille/gille-inference/issues/284), then finish the reviewed
   version/package contract in #278. The explicit-write fixture in
   [#282](https://github.com/Magnus-Gille/gille-inference/pull/282) exists but does not substitute
   for paired acceptance. Verify exact client archive contents,
   package/CLI version parity, focused client/bridge/package tests, typechecks and CI. Retain the
   already-reviewed #277 behavioral regression evidence; do not call packaging tests model evals.
2. Complete paired acceptance in [#285](https://github.com/Magnus-Gille/gille-inference/issues/285);
   source readiness alone is not acceptance: all gates must meet the M1 boundary.
   Record an immutable paired release and verified previous
   client/gateway rollback artifacts.
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

[#82](https://github.com/Magnus-Gille/gille-inference/issues/82) remains open but is deferred outside
this M2 boundary. Resume its calibration only with suitable measured energy evidence and a declared
comparison; model specifications or product TDP are not substitutes for measured wall energy. Until
then, unknown costs remain unknown and do not support savings or economic qualification claims.

1. Reconcile existing
   [#243](https://github.com/Magnus-Gille/gille-inference/issues/243)/[#245](https://github.com/Magnus-Gille/gille-inference/issues/245)
   implementations and missing acceptance evidence before coding. The #245 exporter is already
   shipped per its issue comment and
   [PR #256](https://github.com/Magnus-Gille/gille-inference/pull/256)/
   [PR #275](https://github.com/Magnus-Gille/gille-inference/pull/275);
   keep the already-shipped measurement-epoch repairs and do not rebuild the exporter. The exact
   feedback work is merged and reviewed green in [PR #292](https://github.com/Magnus-Gille/gille-inference/pull/292).
   Never invent historical attribution. #243's fresh canonical read-only deployed verification is
   recorded in its sanitized [closure comment](https://github.com/Magnus-Gille/gille-inference/issues/243#issuecomment-5575645568).
2. Record acceptance evidence for #243's owner-authorized opaque feedback handle bound to the
   exact model/task execution. Cover synchronous and durable asynchronous results,
   retry/restart idempotence, conflicting feedback rejection and access isolation. Keep
   usefulness separate from a deterministic verifier result; feedback alone must not change
   routing.
3. Add content-blind model × task × source × usefulness reporting, including absent feedback,
   eligibility/attempt denominators, policy epochs, retention and unknown attribution. Test
   joins, duplicate/conflicting submissions, missing rows and privacy boundaries with fixtures.
   Export only closed low-cardinality dimensions with an explicit unknown bucket, never raw labels.
4. Produce #245's reproducible bounded read-only report and threshold decision from the shipped
   exporter, then publish the sanitized report.
   Preserve its predeclared target of at least 20 eligible organic opportunities and at least
   60% useful completions among attempts; separate organic work, synthetic probes and evaluation.
   This is the overdue 2026-08-28 review: freeze and record the historical trial bounds plus a
   separate current-policy snapshot cutoff before export. Produce the decision from that fixed
   bundle without waiting for additional samples; insufficient evidence means HOLD, not GO.
   Report pass/fail/unknowable rather than manufacturing enough favorable samples. A new
   collection window must be declared prospectively, not substituted for the overdue review.
   The current evidence gap is recorded in [the #245 gap comment](https://github.com/Magnus-Gille/gille-inference/issues/245#issuecomment-5575664993).
5. Implement and verify [#293](https://github.com/Magnus-Gille/gille-inference/issues/293)'s
   versioned, sanitized, read-only operator JSON export for exactly one already-served model
   through an authorized operator workflow. Bind weights and any applicable projector to actual
   content checksums or verified immutable artifact identities tied to the serving instance;
   include runtime, tokenizer/chat-template, quantization, gateway, context/decoding and bounded
   hardware/resource evidence with observed, declared and unknown fields separated. Collection
   must be explicit and outside inference requests, with freshness and cache invalidation defined.
   Replacement/restart races or unavailable evidence must produce incomplete/stale output, never
   a false complete claim. Exclude private paths, raw launch commands, credentials and
   request/response content, and do not add a client-facing API in this release.
6. Record queue/busy rates, latency, operator rework, feedback coverage and cost provenance where
   available. Missing cost or memory measurements remain unknown, not zero or inferred savings.
   Do not make savings or economic qualification claims from unknown cost. Open tightly scoped
   follow-ups for gaps that prevent a decision.
7. Reconcile the Hugin trial that ended 2026-08-22 against its existing keep/reduce/remove
   contract. Link the owning repository's recorded decision, or record the exact evidence gap
   and route a bounded follow-up to that owner. Do not extend the trial silently, change Hugin
   here, or count direct M5 work and synthetic smoke as durable Hugin demand.

**Done when:** #243's merged implementation has accepted review, test and any separately
authorized rollout evidence; #245 has a reproducible report with explicit denominators,
missingness and a next decision; #293 has its versioned export, evidence-integrity tests,
sanitized retention example/instructions and one operator-verified snapshot; and the Hugin
outcome/gap handoff is explicit. If the #293 snapshot is pending, record implementation complete
but operational validation outstanding and leave M2 open. An honest, reproducible negative or
unknowable #245 report satisfies that report's acceptance, but cannot qualify M3. Remaining M2
acceptance retains the #243/#245/#293 and Hugin outcome requirements; #82 remains open outside M2.

**Expected benefit:** know which model/task pairs actually save work, instead of optimizing for
attempt counts, syntactically valid output or impressive benchmark scores.

#### M3 activities and acceptance

1. Select and qualify exactly one low-blast-radius, non-judgment-bearing task lane from current
   evidence under [#286](https://github.com/Magnus-Gille/gille-inference/issues/286).
   Predeclare the #85 quality/sample, availability, latency and, where applicable, cost gates,
   observation window, trusted behavioral verifier, canary ceiling, watchdog and keep/revert rules
   before enabling it. The current strict evaluator remains cost-gated and its historical HOLD is
   unchanged. See the versioned first-canary evaluator contract in [#304](https://github.com/Magnus-Gille/gille-inference/issues/304).
2. A first canary may be qualified on quality, reliability and latency with cost explicitly
   unassessed only after explicit reviewed evaluator support as specified in [#304](https://github.com/Magnus-Gille/gille-inference/issues/304). Without that support, cost remains a
   gate. Where cost is assessed, separate verified displaced frontier work from shadow projections
   and report cost per accepted task, including retries and verification. Unknown cost is not zero,
   a savings claim or an economic qualification, and product TDP/specifications do not substitute
   for measured energy evidence. Keep privacy/destination eligibility ahead of cost optimization.
   This exception changes only cost assessment; identity/provenance, organic evidence, the trusted
   verifier, data/authority, resource ceilings, rollback and JIT authorization gates remain required.
   The #293 provenance work is an M2 evidence-integrity obligation, not a blanket M3 blocker;
   only a selected lane's specific missing identity evidence can add a qualification dependency.
3. Resolve the selected lane's blocking availability and authority prerequisites. Test outage,
   cancellation, restart/recovery, contention and rollback before the operational decision.
4. Complete canary integration and tests in
   [#287](https://github.com/Magnus-Gille/gille-inference/issues/287) before seeking operational
   approval. After the evidence gate passes and the exact operational change is authorized, run
   the bounded live canary through the fail-closed routing writer/diff path and record its
   keep/revert outcome in [#288](https://github.com/Magnus-Gille/gille-inference/issues/288) with
   quality, reliability, latency, availability and the declared cost status (measured or explicitly
   unassessed under reviewed evaluator support).

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
- Keep unknown costs unknown; do not claim savings, economic qualification or hardware ROI without
  suitable measured energy evidence. Report shadow projections separately from realized savings.

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
