/**
 * shadow-lane.ts — collect local-model evidence on router-ESCALATED task types, without ever
 * trusting the output (issue #234).
 *
 * ## The absorbing state it exists to break (#199)
 *
 * The router escalates a task type to frontier when the ledger has no evidence that a local model
 * can do it. But escalation means NO local call is made — so no new evidence is ever recorded, so
 * the verdict can never change. The 2026-07-12 m5h harvest confirmed it empirically: 8/8
 * code-review / code-edit leaves were auto-escalated to frontier with zero local attempt. A model
 * that has since become viable (a new qwen3-coder quant, a bigger context) can never prove it.
 *
 * The shadow lane is the escape hatch: when the router escalates, ALSO run the configured local
 * candidate — in the background, after the caller already has their frontier answer — grade it, and
 * record the result as a ledger row FLAGGED `shadow`.
 *
 * ## What makes it safe (the #156 lesson, applied)
 *
 * #156 is what happens when weak evidence is allowed to reach a verdict: mellum passed a structural
 * `nonEmpty` verifier on every code review while finding 0 of 34 real seeded bugs, and the routing
 * table read that as `passRate 1.0`. So this lane is built so its evidence CANNOT do that:
 *
 *   - the shadow output is never returned to the caller and never replaces the frontier answer;
 *   - shadow rows are excluded from every evidence reader that drives routing (ledger.getVerdict /
 *     getLaneEvidence / ledgerReport) unless a caller explicitly opts in with `includeShadow`;
 *   - grading against the frontier answer is a token-similarity heuristic, so its verifier name is
 *     classified `mechanical-format` (verifier-classification.ts) — a shadow "pass" is a CANDIDATE
 *     signal, not proof of production quality.
 *
 * Deciding what to DO with the accumulated candidate evidence (promotion) is deliberately NOT here —
 * that is #158's gate, which must apply its misconfig checks before anything is promoted.
 *
 * ## What makes it cheap
 *
 * The shadow never delays the caller: it is scheduled fire-and-forget AFTER the escalated response
 * is built, and it runs only when the delegate queue is empty, at most one at a time. On a busy box
 * it simply never fires. It holds no gateway admission slot, so a request that arrives mid-shadow
 * still contends for the GPU with it — bounding that properly is the owner-priority lane of #108.
 */
import { disagreementScore } from "./disagreement-gate.js";
import type { Outcome } from "./ledger.js";
import type { Verifier, VerifyResult } from "./verifier.js";

// ── Config ────────────────────────────────────────────────────────────────────────

export type ShadowMode = "off" | "on";

export interface ShadowLaneConfig {
  /** "off" (default) → the lane never runs and this module is inert. */
  mode: ShadowMode;
  /** Explicit local candidate model id. "" → fall back to whatever model is currently loaded. */
  model: string;
  /** If non-empty, ONLY these task types are shadowed. Empty = every escalated task type. */
  taskTypes: string[];
  /**
   * EFFECTIVE token budget for the shadow call, already resolved by the caller — the orchestrator
   * passes the same budget the real task would have had unless an operator set an explicit cap. A
   * shadow budget SMALLER than the real one silently manufactures fail evidence (the candidate
   * truncates and is graded on the stump), so the default is to inherit, not to skimp.
   */
  maxTokens: number;
  /** Wall-clock ceiling for the shadow call (ms). */
  timeoutMs: number;
  /** Frontier-agreement ≥ this → the shadow row is graded `pass`. Only used when no verifier exists. */
  agreementThreshold: number;
}

export interface ShadowEligibility {
  eligible: boolean;
  reason: string;
}

/**
 * Verifier name recorded when a shadow row was graded by AGREEMENT WITH THE FRONTIER ANSWER rather
 * than by a real task verifier. Deliberately listed in verifier-classification's
 * MECHANICAL_FORMAT_VERIFIERS: it is a deterministic token-similarity comparison against an expected
 * string, so — like `exact` / `answerIs` — a pass means "looks like the frontier answer", not "is
 * correct". Naming it honestly is what lets #233's format-only discount weigh it correctly if this
 * evidence is ever explicitly included in a rollup.
 */
export const SHADOW_FRONTIER_VERIFIER = "shadow-vs-frontier";

/** `source` stamped on every shadow ledger row — the queryable provenance of candidate evidence. */
export const SHADOW_SOURCE = "shadow";

// ── Eligibility (pure) ────────────────────────────────────────────────────────────

/**
 * Should we spend a background local call on this escalated leaf?
 *
 * The queue MUST be empty. The shadow lane is strictly the lowest-priority work on the box: its
 * whole justification is that it costs nothing anyone is waiting for. A single in-flight delegation
 * means a caller is waiting on the serial GPU right now, and a shadow call would contend with it —
 * so we skip, unconditionally, and wait for the next escalated leaf on an idle box. Evidence
 * gathering is never worth degrading a real request.
 */
export function shadowEligible(args: {
  config: ShadowLaneConfig;
  taskType: string;
  /** True when the delegation actually called a local model (real evidence already exists). */
  delegated: boolean;
  /** Number of delegate() calls currently in flight, EXCLUDING this one. */
  queueDepth: number;
  /** Number of shadow evaluations currently running. */
  running: number;
}): ShadowEligibility {
  const { config, taskType, delegated, queueDepth, running } = args;

  if (config.mode === "off") {
    return { eligible: false, reason: "shadow lane off" };
  }
  if (delegated) {
    return { eligible: false, reason: "local model already attempted — real evidence recorded" };
  }
  if (config.taskTypes.length > 0 && !config.taskTypes.includes(taskType)) {
    return { eligible: false, reason: `task type ${taskType} not in shadow lane allow-list` };
  }
  if (running >= 1) {
    return { eligible: false, reason: "a shadow evaluation is already running (max 1 concurrent)" };
  }
  if (queueDepth > 0) {
    return {
      eligible: false,
      reason: `delegate queue non-empty (${queueDepth} in flight) — never contend with real traffic`,
    };
  }

  return { eligible: true, reason: "shadow lane eligible" };
}

// ── Grading (pure apart from the caller-supplied verifier) ────────────────────────

export interface ShadowGrade {
  outcome: Outcome;
  score: number | null;
  /** What actually graded the row — a real verifier's name, SHADOW_FRONTIER_VERIFIER, or "none". */
  verifierName: string;
  notes?: string;
}

/** Agreement ∈ [0,1] between the shadow answer and the frontier answer (1 = same answer). */
function frontierAgreement(shadowOutput: string, frontierOutput: string): number {
  return 1 - disagreementScore(shadowOutput, frontierOutput);
}

/**
 * Grade a shadow output. Precedence is deliberate:
 *
 *   1. a real task VERIFIER, when the caller supplied one, is authoritative — it is deterministic
 *      ground truth and beats any similarity heuristic;
 *   2. otherwise, if the caller's frontier answer is available, grade on AGREEMENT with it: the
 *      frontier answer is the best reference we have for a leaf that was escalated precisely
 *      because we did not trust the local model with it;
 *   3. otherwise `unverified` — we refuse to invent a verdict out of nothing (that is exactly the
 *      #156 inflation this lane must not repeat).
 *
 * The frontier agreement is ALWAYS recorded in the notes, even when a verifier decided the outcome,
 * because the verifier-vs-frontier delta is itself the interesting signal for a future promotion gate.
 */
export async function gradeShadowOutput(args: {
  output: string;
  verifier?: Verifier;
  verifierName?: string;
  frontierOutput?: string;
  agreementThreshold: number;
}): Promise<ShadowGrade> {
  const { output, verifier, verifierName, frontierOutput, agreementThreshold } = args;
  const agreement =
    frontierOutput !== undefined && frontierOutput !== ""
      ? frontierAgreement(output, frontierOutput)
      : null;
  const agreeNote = agreement !== null ? `agree=${agreement.toFixed(2)}` : undefined;

  if (verifier) {
    const vr: VerifyResult = await verifier(output);
    return {
      outcome: vr.outcome,
      score: vr.score,
      verifierName: verifierName ?? "custom",
      notes: [vr.notes, agreeNote].filter(Boolean).join(" | ") || undefined,
    };
  }

  if (agreement !== null) {
    return {
      outcome: agreement >= agreementThreshold ? "pass" : "fail",
      score: Math.round(agreement * 100) / 100,
      verifierName: SHADOW_FRONTIER_VERIFIER,
      notes: agreeNote,
    };
  }

  // No verifier and no frontier reference: the shadow ran, but nothing can honestly grade it.
  return { outcome: "unverified", score: null, verifierName: "none" };
}

// ── The lane itself (fire-and-forget I/O, dependency-injected) ────────────────────

export interface ShadowJob {
  taskType: string;
  nodeId: "m5" | "orin";
  prompt: string;
  systemPrompt?: string;
  verifier?: Verifier;
  verifierName?: string;
  /** True when delegate() actually called a local model — such a leaf is never shadowed. */
  delegated: boolean;
  /** The frontier answer the caller received, when there was one. The grading reference. */
  frontierOutput?: string;
  /** Why the router escalated — carried into the ledger notes so the row explains itself. */
  escalationReason: string;
  keyAlias?: string | null;
}

export interface ShadowInference {
  ok: boolean;
  response?: string;
  error?: string;
  latencyMs?: number;
  ttftMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  tokPerSec?: number;
}

export interface ShadowDeps {
  config: ShadowLaneConfig;
  /** Delegations in flight RIGHT NOW, excluding any that already returned. */
  queueDepth: () => number;
  /** Resolve the candidate model: the configured one, else the loaded one, else null. */
  resolveModelId: () => Promise<string | null>;
  /** Run the candidate. Must never throw — a shadow failure is recorded, not propagated. */
  infer: (modelId: string, job: ShadowJob, config: ShadowLaneConfig) => Promise<ShadowInference>;
  /** Write the (shadow-flagged) ledger row. */
  record: (row: ShadowLedgerRow) => void;
  /** Content-blind metric hook. */
  onOutcome?: (outcome: "pass" | "partial" | "fail" | "error" | "unverified" | "skipped") => void;
}

export interface ShadowLedgerRow {
  taskType: string;
  nodeId: "m5" | "orin";
  modelId: string;
  prompt: string;
  outcome: Outcome;
  score: number | null;
  verifier: string;
  latencyMs?: number | null;
  ttftMs?: number | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  tokPerSec?: number | null;
  /** Always true — the flag that keeps this row out of every default rollup. */
  shadow: true;
  /** Always true — the CALLER's task was escalated; that is the precondition for a shadow. */
  escalated: true;
  source: string;
  keyAlias?: string | null;
  notes?: string;
}

/** Shadow evaluations currently running. The "max 1 concurrent" bound. */
let running = 0;
/** Scheduled-but-unfinished shadow evaluations — the test hook's join point. */
const pending = new Set<Promise<void>>();

/** Test hook: wait until every scheduled shadow evaluation has settled. */
export async function shadowLaneIdle(): Promise<void> {
  while (pending.size > 0) {
    await Promise.all([...pending]);
  }
}

/** Test hook: drop all lane state (never call this on a live box). */
export function resetShadowLane(): void {
  running = 0;
  pending.clear();
}

/** Defer past the caller's return so the shadow can never delay the response it rides on. */
function nextTick(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * Schedule a shadow evaluation. FIRE-AND-FORGET BY CONTRACT: returns synchronously, never throws,
 * and the caller's response is already built by the time the evaluation starts. Everything inside is
 * best-effort — a broken candidate model must degrade the box's LEARNING, never its SERVING.
 */
export function scheduleShadowEvaluation(job: ShadowJob, deps: ShadowDeps): void {
  const task = (async () => {
    // Yield first: the delegate() call that scheduled us must fully return (and drop out of the
    // queue-depth count) before we decide whether the box is idle.
    await nextTick();

    const elig = shadowEligible({
      config: deps.config,
      taskType: job.taskType,
      delegated: job.delegated,
      queueDepth: deps.queueDepth(),
      running,
    });
    if (!elig.eligible) {
      deps.onOutcome?.("skipped");
      return;
    }

    running++;
    try {
      const modelId = await deps.resolveModelId();
      if (!modelId) {
        deps.onOutcome?.("skipped");
        return;
      }
      const res = await deps.infer(modelId, job, deps.config);
      if (!res.ok || res.response === undefined) {
        deps.record({
          taskType: job.taskType,
          nodeId: job.nodeId,
          modelId,
          prompt: job.prompt,
          outcome: "error",
          score: null,
          verifier: job.verifierName ?? (job.verifier ? "custom" : "none"),
          shadow: true,
          escalated: true,
          source: SHADOW_SOURCE,
          keyAlias: job.keyAlias ?? null,
          notes: [`shadow(#234): ${job.escalationReason}`, res.error].filter(Boolean).join(" | "),
        });
        deps.onOutcome?.("error");
        return;
      }

      const grade = await gradeShadowOutput({
        output: res.response,
        verifier: job.verifier,
        verifierName: job.verifierName,
        frontierOutput: job.frontierOutput,
        agreementThreshold: deps.config.agreementThreshold,
      });

      deps.record({
        taskType: job.taskType,
        nodeId: job.nodeId,
        modelId,
        prompt: job.prompt,
        outcome: grade.outcome,
        score: grade.score,
        verifier: grade.verifierName,
        latencyMs: res.latencyMs ?? null,
        ttftMs: res.ttftMs ?? null,
        promptTokens: res.promptTokens ?? null,
        completionTokens: res.completionTokens ?? null,
        tokPerSec: res.tokPerSec ?? null,
        shadow: true,
        escalated: true,
        source: SHADOW_SOURCE,
        keyAlias: job.keyAlias ?? null,
        notes: [`shadow(#234): ${job.escalationReason}`, grade.notes].filter(Boolean).join(" | "),
      });
      deps.onOutcome?.(grade.outcome);
    } catch (err) {
      // The lane is best-effort. Surface the failure (never a bare swallow) but never propagate it:
      // an unhandled rejection here would take down a gateway that is serving fine.
      console.warn(
        `[shadow-lane] evaluation failed for ${job.taskType}: ${err instanceof Error ? err.message : String(err)}`
      );
      deps.onOutcome?.("error");
    } finally {
      running--;
    }
  })();

  pending.add(task);
  void task.finally(() => pending.delete(task));
}
