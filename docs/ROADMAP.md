# Roadmap

**Last updated:** 2026-11-06

**Architecture:** [`architecture.md`](./architecture.md)

**Execution detail:** Plane `INFER` tickets (`https://tickets.gille.ai/gille/browse/INFER-N/`; a migrated
GitHub issue `#N` is `INFER-N`) and repository pull requests. Private operator handoffs are not
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
| **M1 — Paired quality-protected release** | The schema-grounding gateway and matching client are released together, verified, and recoverable | **Complete (2026-09-06):** client 1.3.6 / gateway v9 paired acceptance passed; [sanitized release receipt](https://github.com/Magnus-Gille/gille-inference/issues/285#issuecomment-5561882175). Readiness INFER-284 resolved by [#290](https://github.com/Magnus-Gille/gille-inference/pull/290) |
| **M2 — Auditable usefulness and provenance** | Exact model/task feedback, organic-use evidence, cost provenance with unknowns preserved, and a served-model provenance snapshot state what is proven, failed, or unknown | **Evidence/report acceptance complete; milestone release pending:** INFER-243 (feedback join) and INFER-245 (historical [UNKNOWABLE/HOLD report](m2-adoption-review.md)) are done. INFER-293 is done after a fresh but incomplete operator snapshot ([comment 5600506798](https://github.com/Magnus-Gille/gille-inference/issues/293#issuecomment-5600506798)); implementation [PR #294](https://github.com/Magnus-Gille/gille-inference/pull/294) and process-view documentation [PR #302](https://github.com/Magnus-Gille/gille-inference/pull/302) provide traceability, loaded-model binding remains unproven and unknowns are preserved. Open: INFER-82 (cost calibration, deferred outside M2 pending suitable measured energy evidence) and INFER-512 (this roadmap refresh). Fresh prospective organic evidence is tracked in M3 INFER-308 |
| **M3 — First bounded routing canary** | One narrow lane completes a predeclared canary and receives an evidence-backed keep/revert decision | **Decision unchanged (HOLD) since September; no lane qualified.** Completed: qualification report INFER-286 (HOLD), first-canary v2 evaluator contract INFER-304 and candidate-bound evidence export INFER-306. Parent INFER-85 and INFER-287 (canary/rollback integration), INFER-288 (live canary and keep/revert) and INFER-308 (prospective organic evidence) remain open and gated. Quality exclusions INFER-237, INFER-228, INFER-25 stay open. Other lanes remain shadow |
| **M4 — Reliable cross-platform agent access** | Supported M5 agent setup and recovery are repeatable on macOS and Windows | **Independent workstream, in progress:** guided provisioning INFER-184 is done. Open: on-box agent access INFER-450 (in progress), client rollout INFER-498, connector/outage diagnostics INFER-242, Windows support INFER-266 and remote build/test INFER-347 |
| **M5 — Controlled runtime and model upgrades** | Runtime-update evaluation and hand-picked model promotion have controlled, recoverable paths | **Independent tooling/evaluation:** transactional roster promotion INFER-217 and the upgrade assessment INFER-280 are done. Open: exclusive maintenance INFER-196, protected roster observer INFER-113 and readiness outcomes INFER-250. Measured performance experiments follow the M2 baseline |
| **M6 — Memory safety and admission** | Host memory is admitted, contained and diagnosable so one model start cannot take down the host | **Partial; enforcement not yet on:** after the 2026-10-01 host OOM, whole-host memory admission runs in shadow mode ([#351](https://github.com/Magnus-Gille/gille-inference/pull/351)), the model runtime is the preferred OOM victim ([#366](https://github.com/Magnus-Gille/gille-inference/pull/366)) and cumulative OOM evidence is in protected diagnostics ([#398](https://github.com/Magnus-Gille/gille-inference/pull/398)). Open: INFER-350 (caller-facing OOM/resource readiness), INFER-354 (`MemoryMin` review), INFER-355 (GPU memory held outside the service), INFER-352 (calibrate admission, validate enforce), INFER-345 (production model pins and budgets), INFER-409 (activity-aware install admission), INFER-342 (resident model for interactive use) and INFER-376 (resident versus serving diagnostics). Admission for non-chat model starts landed earlier in INFER-353 |
| **M7 — Credential lifecycle and authority** | Gateway credentials are least-scope, expiring and rotatable, and private-review authority is explicit | **Open (new):** INFER-152 (expire and least-scope legacy credentials), INFER-341 (hardware-presence for privileged keys), INFER-56 (dedicated key for a consolidation job), INFER-249 (scoped private-repo review authority), INFER-511 (host-owner policy candidate: land or retire; in progress) and INFER-513 (non-blocking hardening from its review) |
| **M8 — Guest serving contract correctness** | Guest-facing serving behaves as documented: stable model identity, accurate errors and limits, visible capture behavior | **Open (new); builds on the guest-serving fixes INFER-500, INFER-501, INFER-502, INFER-503, INFER-504, INFER-505, INFER-506, INFER-507, INFER-509 (batch limits, context overflow including Clef, billing, credit headroom and replenishment, retryable failures, usable-context publication, 255 choice options; closed by 2026-11-06).** Open: INFER-510 (post-deploy overflow probe for every served model), INFER-343 (canonical model identity and aliases), INFER-344 (effective content-capture behavior), INFER-125 (effective context certification), INFER-63 (durable admit-then-queue contract), INFER-18 (owner priority through contention), INFER-477 (runbook re-pin step) and INFER-326 (re-run identity friction) |
| **R — Envelope-gated evaluations** | A pool, not an ordered milestone: model, runtime and harness experiments run only under a separately approved evaluation envelope | **Open pool, nothing scheduled:** INFER-124, INFER-126, INFER-127, INFER-128, INFER-129, INFER-130, INFER-195, INFER-212, INFER-262, INFER-181, INFER-252, INFER-317, INFER-333, INFER-346, INFER-421, INFER-495, INFER-508, INFER-283. Each needs a predeclared isolated A/B and a GO/HOLD report; none changes production |

**Current status (2026-11-06).** M2 evidence/report acceptance remains complete through the [historical adoption review](m2-adoption-review.md); the milestone release receipt is still pending, and report acceptance does not establish organic usefulness or qualify M3. M3 is unchanged: HOLD, no lane qualified, with the strict v1 evaluator cost-gated and the [first-canary v2 contract](m3-qualification.md) separating non-cost canary eligibility from full economic qualification without supplying missing production evidence. Prospective candidate-bound observations in INFER-308 precede INFER-287/INFER-288. For INFER-82, no plug-level meter/UPS measurement is connected and a purchase remains undecided, so it stays open and outside M2; unknown costs remain unknown, with no savings or economic qualification claim and no product-TDP substitute. The conditional 2026-09-09 to 09-16 [INFER-245 window](https://github.com/Magnus-Gille/gille-inference/issues/245#issuecomment-5584785708) did not start because its genuine-task feedback precondition was unmet before the boundary; any replacement window must be declared prospectively. The owner-declined [Hugin #165](https://github.com/Magnus-Gille/hugin/issues/165) trial was not reopened; its outcome/gap was handed off in [INFER-245 comment 5584071494](https://github.com/Magnus-Gille/gille-inference/issues/245#issuecomment-5584071494).

**Since September.** Work shifted to guest serving and host safety: the SystemOne/guest serving fixes INFER-500, INFER-501, INFER-502, INFER-503, INFER-504, INFER-505, INFER-506, INFER-507, INFER-509 closed by 2026-11-06 (including the Clef overflow fix, where an over-context request returned an opaque 502 instead of `context_length_exceeded`), and new modules M6-M8 collect the memory, credential and serving-contract backlog that had no milestone. These are source and ticket closures, not evidence of routing quality.

**Planned cycles.** Sprint 1 (2026-11-09 to 11-20): INFER-511, INFER-512, INFER-510, INFER-498, INFER-450, INFER-354, INFER-350, INFER-152, INFER-343. Sprint 2 (2026-11-23 to 12-04): INFER-355, INFER-352, INFER-345, INFER-409, INFER-56, INFER-249, INFER-125, INFER-344, INFER-242. Cycle membership is a scheduling aid and does not change a ticket's acceptance boundary.

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
   INFER-284, then finish the reviewed
   version/package contract in #278. The explicit-write fixture in
   [#282](https://github.com/Magnus-Gille/gille-inference/pull/282) exists but does not substitute
   for paired acceptance. Verify exact client archive contents,
   package/CLI version parity, focused client/bridge/package tests, typechecks and CI. Retain the
   already-reviewed #277 behavioral regression evidence; do not call packaging tests model evals.
2. Complete paired acceptance in INFER-285;
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

INFER-82 remains open but is deferred outside
this M2 boundary. Resume its calibration only with suitable measured energy evidence and a declared
comparison; model specifications or product TDP are not substitutes for measured wall energy. Until
then, unknown costs remain unknown and do not support savings or economic qualification claims.

1. Reconcile existing
   INFER-243/INFER-245
   implementations and missing acceptance evidence before coding. The INFER-245 exporter is already
   shipped per its issue comment and
   [PR #256](https://github.com/Magnus-Gille/gille-inference/pull/256)/
   [PR #275](https://github.com/Magnus-Gille/gille-inference/pull/275);
   keep the already-shipped measurement-epoch repairs and do not rebuild the exporter. The exact
   feedback work is merged and reviewed green in [PR #292](https://github.com/Magnus-Gille/gille-inference/pull/292).
   Never invent historical attribution. INFER-243's fresh canonical read-only deployed verification is
   recorded in its sanitized [closure comment](https://github.com/Magnus-Gille/gille-inference/issues/243#issuecomment-5575645568).
2. Record acceptance evidence for INFER-243's owner-authorized opaque feedback handle bound to the
   exact model/task execution. Cover synchronous and durable asynchronous results,
   retry/restart idempotence, conflicting feedback rejection and access isolation. Keep
   usefulness separate from a deterministic verifier result; feedback alone must not change
   routing.
3. Add content-blind model × task × source × usefulness reporting, including absent feedback,
   eligibility/attempt denominators, policy epochs, retention and unknown attribution. Test
   joins, duplicate/conflicting submissions, missing rows and privacy boundaries with fixtures.
   Export only closed low-cardinality dimensions with an explicit unknown bucket, never raw labels.
4. Produce INFER-245's reproducible bounded read-only report and threshold decision from the shipped
   exporter, then publish the sanitized report.
   Preserve its predeclared target of at least 20 eligible organic opportunities and at least
   60% useful completions among attempts; separate organic work, synthetic probes and evaluation.
   This is the overdue 2026-08-28 review: freeze and record the historical trial bounds plus a
   separate current-policy snapshot cutoff before export. Produce the decision from that fixed
   bundle without waiting for additional samples; insufficient evidence means HOLD, not GO.
   Report pass/fail/unknowable rather than manufacturing enough favorable samples. A new
   collection window must be declared prospectively, not substituted for the overdue review.
   The current evidence gap is recorded in the [INFER-245 gap comment](https://github.com/Magnus-Gille/gille-inference/issues/245#issuecomment-5575664993).
5. Implement and verify INFER-293's
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

**Done when:** INFER-243's merged implementation has accepted review, test and any separately
authorized rollout evidence; INFER-245 has a reproducible report with explicit denominators,
missingness and a next decision; INFER-293 has its versioned export, evidence-integrity tests,
sanitized retention example/instructions and one operator-verified snapshot; and the Hugin
outcome/gap handoff is explicit. If the INFER-293 snapshot is pending, record implementation complete
but operational validation outstanding and leave M2 open. An honest, reproducible negative or
unknowable INFER-245 report satisfies that report's acceptance, but cannot qualify M3. Remaining M2
acceptance retains the INFER-243/INFER-245/INFER-293 and Hugin outcome requirements; INFER-82 remains open outside M2.

**Expected benefit:** know which model/task pairs actually save work, instead of optimizing for
attempt counts, syntactically valid output or impressive benchmark scores.

#### M3 activities and acceptance

1. Select and qualify exactly one low-blast-radius, non-judgment-bearing task lane from current
   evidence under INFER-286.
   Predeclare the INFER-85 quality/sample, availability, latency and, where applicable, cost gates,
   observation window, trusted behavioral verifier, canary ceiling, watchdog and keep/revert rules
   before enabling it. The current strict evaluator remains cost-gated and its historical HOLD is
   unchanged. See the versioned first-canary evaluator contract in INFER-304.
2. A first canary may be qualified on quality, reliability and latency with cost explicitly
   unassessed only after explicit reviewed evaluator support as specified in INFER-304. Without that support, cost remains a
   gate. Where cost is assessed, separate verified displaced frontier work from shadow projections
   and report cost per accepted task, including retries and verification. Unknown cost is not zero,
   a savings claim or an economic qualification, and product TDP/specifications do not substitute
   for measured energy evidence. Keep privacy/destination eligibility ahead of cost optimization.
   This exception changes only cost assessment; identity/provenance, organic evidence, the trusted
   verifier, data/authority, resource ceilings, rollback and JIT authorization gates remain required.
   The INFER-293 provenance work is an M2 evidence-integrity obligation, not a blanket M3 blocker;
   only a selected lane's specific missing identity evidence can add a qualification dependency.
3. Resolve the selected lane's blocking availability and authority prerequisites. Test outage,
   cancellation, restart/recovery, contention and rollback before the operational decision.
4. Complete canary integration and tests in
   INFER-287 before seeking operational
   approval. After the evidence gate passes and the exact operational change is authorized, run
   the bounded live canary through the fail-closed routing writer/diff path and record its
   keep/revert outcome in INFER-288 with
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
| P0, M7 | Credential lifecycle: INFER-152, INFER-341, INFER-56; scope private review authority in INFER-249 and the host-policy candidate INFER-511 | Secret-safe inventory and consumer tests; narrow scopes, overlap/rollback and retired-key rejection for separately approved rotations. No private-review expansion before its authority contract is accepted. INFER-184 (provisioning CLI) is done. Escalate a confirmed active risk ahead of feature work. |
| P0, M6 | Memory safety: INFER-350, INFER-354, INFER-355, then INFER-352, INFER-345, INFER-409, INFER-342, INFER-376 | Deterministic admission, containment and diagnostic tests; calibrate from shadow evidence before enforcing. Do not weaken memory safeguards for performance work. |
| P1, M8 | Guest serving: INFER-510, INFER-343, INFER-344, then INFER-125, INFER-63, INFER-18, INFER-477, INFER-326 | Per-model overflow probe, canonical identity and effective-capture tests; deterministic queue/restart/cancel/preemption tests for INFER-63/INFER-18. Measure busy/retry reduction against a baseline; don't claim parallel GPU capacity. |
| P1, M4 | Agent access: INFER-450, INFER-498, INFER-242 | Redacted failure diagnostics and a repeatable rollout/recovery path. |
| P1, quality exclusions | Preserve negative regressions for unsafe/inaccurate assistance: INFER-237, INFER-228, INFER-25 | Wrong-answer controls remain rejected; these judgment-bearing tasks stay excluded from automatic promotion without trusted ground truth. |
| P2, M5 | Maintenance and serving lifecycle: INFER-196, INFER-113, INFER-250 (INFER-217 is done) | Test full serving contracts, synthetic labels and rollback; route cross-repository work to its owner. Source merge does not promote a live model. |
| P2, R, after baseline | Decoding INFER-124, query-aware provenance INFER-126, verifier-guided compute INFER-127, model pairing INFER-128 | One intervention at a time on saved comparable tasks; quality, wall time, memory and cost per accepted result. Retain failures and compare against an unchanged baseline. |
| P3, R, bounded research | Backend INFER-129, speculation INFER-130, host profile INFER-195, LocalAI INFER-212, DwarfStar INFER-262, scout INFER-181, exploration hypothesis INFER-252, model evaluations INFER-317, INFER-333, INFER-421, INFER-346, execution profile INFER-495, media publishing INFER-283 | Predeclared isolated A/B study and GO/HOLD report under a separately approved evaluation envelope; no competing GPU jobs, production changes or relaxed memory safeguards. |
| P3, client reach | Windows support INFER-266 and remote build/test INFER-347 | Native secret-safe provisioning/transport/package tests and documented support boundaries, in a separate client worktree. |

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
