# The bounded local-review lane (`review-bounded`) — issue #74

**Status:** implemented, default merge-safe (advisory-only, unpromoted).
**Source of truth:** `src/homeserver/review-bounded.ts` (contract/prompt/verifier),
`src/homeserver/taxonomy.ts` (task-type registration), `src/homeserver/delegate-policy.ts`
(`isAdvisoryOnlyTaskType`, the promotion gate), `src/homeserver/ledger.ts`
(`recordReviewerUsefulness`), `src/homeserver/gateway.ts`
(`GET /v1/capabilities/review-lane`).

## The decision

`code-review` — open-ended, whole-patch PR review — **stays frontier-only**, unchanged. Nothing in
this document or its implementation weakens that gap type: it remains in
`docs/m5-routing.json`'s `escalateToFrontier` list, and it remains in
`DEFAULT_JUDGMENT_QUALITY_TASK_TYPES` (`config.ts`) with an empty trusted-verifier allowlist, so
`decideDelegatePolicy` can never certify it locally.

A **new, narrow, distinct task type** — `review-bounded` — MAY route locally for exactly three
bounded review subtasks:

1. **classify-findings** — given already-identified findings (the hard "find it" work was already
   done by a frontier reviewer), classify each as `confirmed` / `refuted` / `needs-info` against a
   diff excerpt.
2. **detect-anti-pattern** — does one fixed, named anti-pattern appear in a code excerpt, and where.
3. **verify-output-shape** — does a candidate output structurally match a required schema.

Every review-bounded prompt must carry the fixed contract markers `review-bounded.ts` defines
(`REVIEW_BOUNDED_CONTRACT_MARKER`, `subtaskKindMarker`, `REVIEW_BOUNDED_SCHEMA_MARKER`) and its
response must validate against the exact structured schema for the subtask kind
(`parseReviewBoundedOutput`). This is what makes the boundary **bounded-vs-open-ended**, not
**model-capability-in-general**: an ordinary open-ended review ask — even a near-miss one that
happens to mention "classify" or "anti-pattern" in passing prose — carries none of these markers
and classifies as `code-review` (or another type), never `review-bounded`. See
`tests/taxonomy-review-bounded-classification.test.ts` for the route-stability proof.

Local output from `review-bounded` is **advisory evidence only** — never an authoritative
merge/decision gate — until an operator explicitly promotes it via
`HOMESERVER_DELEGATE_POLICY_PROMOTED_ADVISORY_TASK_TYPES` after a measured pass rate.
`delegate-policy.ts`'s `decideDelegatePolicy` enforces this as a hard guardrail that runs **after**
every other evidence check (samples, success rate, error rate, latency): even a lane that clears
every one of those thresholds still returns `shadow`, never `allow`, while unpromoted. The default
promoted list is empty, so a fresh checkout cannot silently start treating review-bounded output as
authoritative merely by accumulating passing ledger rows.

**Task-type spelling does not weaken that guardrail (#80).** `isAdvisoryOnlyTaskType` and the
promotion test canonicalize their own input (`normalizeTaskType` in `task-type-identity.ts`: trim +
case-fold), so `"review-bounded "` or `"Review-Bounded"` resolves to the same advisory-only lane
regardless of how a caller spelled it — and an operator promotion written with stray whitespace or
different case still promotes the canonical lane. Case-folding is safe because every task-type id in
`taxonomy.ts` is a lowercase kebab literal, so it can only map a variant onto a canonical id, never
invent one. Ingress itself (`orchestrator.resolveTaskType`, used by both `/delegate` and
`code-loop.ts`) trims but otherwise preserves an explicit caller-supplied bucket verbatim, keeping
the #155 policy intact; canonicalization applies to the policy/lookup comparisons, not to the
recorded ledger bucket.

## The evidence (grimnir session 2026-07-24, recorded on gille-inference#25)

Five M5 review calls on real merged PRs, all on `qwen3-coder-next-80b`:

- **4/4 BOUNDED single-question reviews — all useful and correct:**
  - Two action-pin SHA/semantics verifications (hugin#317, skuld#12).
  - One docs-consistency review including correct substring-edge reasoning about
    `"HS_API_KEY"` vs `"$HS_API_KEY"` (gille-inference#77).
  - One threshold-helper review of HTML-escaping + old-vs-new classification semantics with one
    terminology finding that was **correctly declined** (heimdall#21).
- **1 WHOLE-PATCH adversarial review — all four findings wrong:** a ~160-line safety-relevant
  watchdog diff (gille-inference#78) came back `NEEDS_CHANGES` with 4 findings. **All four were
  refuted on validation**, and one proposed "fix" would have removed safety-relevant claim-token
  fencing.

This is a five-call, single-session datapoint — not a statistically powered study. It is the reason
the boundary drawn here is **bounded-vs-open-ended**, not a general claim that the local model is
(or is not) a capable reviewer. The evaluation set below exists specifically so this claim can be
re-measured mechanically at scale, rather than resting on five hand-checked calls forever.

## The prompt contract and structured output schema

See `src/homeserver/review-bounded.ts` for the authoritative types. Every response is a single JSON
object; every prompt requests exactly one subtask:

| Subtask | Required response shape |
|---|---|
| `classify-findings` | `{"contract":"gille-inference.review-bounded/v1","subtask":"classify-findings","classifications":[{"id":"<finding id>","verdict":"confirmed\|refuted\|needs-info"}]}` |
| `detect-anti-pattern` | `{"contract":"gille-inference.review-bounded/v1","subtask":"detect-anti-pattern","pattern_id":"<id>","detected":true\|false,"locations":["..."]}` |
| `verify-output-shape` | `{"contract":"gille-inference.review-bounded/v1","subtask":"verify-output-shape","matches_schema":true\|false,"violations":["..."]}` |

Because every field is typed and closed (`zod` discriminated union, `.strict()` semantics via exact
literal/enum fields), `reviewBoundedVerifier(kind, expected)` grades a candidate output completely
mechanically — no frontier judge in the loop — against an exact expected structured output. The
checked-in evaluation set (`tests/fixtures/review-bounded/eval-set.json`, exercised by
`tests/homeserver-review-bounded.test.ts`) pins six such exact-expected-output fixtures, two per
subtask kind, each with a deliberately-wrong candidate the verifier must not grade as `pass`.

## Evidence recording (wired into the existing ledger, not a parallel store)

A `review-bounded` delegation writes to the **same** `delegations` table every other task type
uses, via the same `recordDelegation` call:

- **Local model + tokens + verifier outcome** — already-existing `delegations` columns
  (`model_id`, `prompt_tokens`, `completion_tokens`, `outcome`, `verifier`). No new columns needed.
- **Delegator model + cost** — already-existing `delegation_costs` table
  (`delegation-cost.ts`), joined by `delegation_id` = the same ledger id `recordDelegation`
  returns. Populated whenever the caller passes `delegatorModelId` and cost logging is on
  (`HOMESERVER_DELEGATION_COST_LOG`, unchanged by this ticket).
- **Reviewer usefulness (`pass`\|`partial`\|`redo`\|`wrong`)** — the one genuinely new dimension
  (#74's explicit ask). Added as four new nullable `delegations` columns via the same additive
  `ALTER TABLE ... ADD COLUMN` migration pattern every prior ledger schema change uses
  (`reviewer_usefulness`, `reviewer_usefulness_notes`, `reviewer_usefulness_by`,
  `reviewer_usefulness_ts`), written after the fact via `recordReviewerUsefulness(ledgerId, ...)`
  once a reviewer has actually checked the output — exactly the workflow the grimnir 2026-07-24
  session followed by hand for the five calls above. `getDelegationById` surfaces the fields for
  read-back/joins, matching its existing role as "the join target from a held ledger id back to its
  exact evidence row" (#227).

A reviewer's usefulness verdict may legitimately disagree with the deterministic verifier
`outcome` — a schema-valid ("pass") structured output can still be judged not useful in practice,
exactly like gille-inference#78's four schema-fine-but-substantively-wrong findings.

## Preflight / capability discovery

`GET /v1/capabilities/review-lane` (see `docs/gateway-api-contract.md`) lets an orchestrator ask
which lane a task type will get before spending a `/delegate` round trip. It always reports both
known lanes — `code-review` (`frontier-only`) and `review-bounded` (`local-advisory`,
`advisoryOnly` until `promoted`) — so a caller never waits on a local review result for a task type
that will always escalate.

## Default merge-safety

Every piece of this change preserves today's behavior on a fresh checkout with no configuration:

- `review-bounded` is a **new** task type with **no existing production traffic** — nothing that
  used to classify as `code-review` (or anything else) starts classifying as `review-bounded`,
  because the classifier only matches the fixed contract markers no real historical prompt
  contains (route-stability tests above).
- `docs/m5-routing.json` is untouched — `review-bounded` is simply absent from it, so
  `routeViaTable` (`orchestrator.ts`) falls through to the pre-existing unknown-lane policy exactly
  like any other unrouted task type (e.g. `memory-decision` before it earned a route).
- `delegatePolicy.promotedAdvisoryTaskTypes` defaults to empty
  (`HOMESERVER_DELEGATE_POLICY_PROMOTED_ADVISORY_TASK_TYPES` unset), so `decideDelegatePolicy` can
  never return `allow` for `review-bounded` on a fresh checkout, regardless of how much evidence
  accumulates.
- `code-review`'s frontier-escalation gap type, `DEFAULT_JUDGMENT_QUALITY_TASK_TYPES` membership,
  and empty trusted-verifier allowlist are all unchanged.

## What this ticket deliberately leaves out

- **No change to the frozen `LearningTaskContract` v1 wire taxonomy**
  (`learning-task-contract.ts`'s `TASK_TYPE_IDS`, pinned to
  `taxonomy_version: "gille-inference-task-types-2026-07-19-v1"`). `review-bounded` is not yet
  stampable by Hugin through that contract; adding it requires a deliberate taxonomy-version bump
  in a future ticket, not a silent addition to a versioned wire enum.
- **No regeneration of `docs/m5-routing.json`.** The evidence-based routing-table generator
  (`routing-table-generator.ts`) would currently emit `review-bounded` as a zero-evidence pending
  hole; regenerating the table is a separate, evidence-gated operational action, not part of this
  code change.
- **No production ledger backfill.** The five 2026-07-24 evidence rows (gille-inference#25) are not
  retroactively written into the live ledger by this PR — `recordReviewerUsefulness` makes that
  possible operationally, but doing so is a deployment/data action outside a code PR.
- **No touching of the autonomy controller or adoption-watchdog.** Out of scope by explicit
  instruction; this lane's promotion is a manual, per-box operator decision
  (`promotedAdvisoryTaskTypes`), not an autonomous one.
