import {
  buildAdjudicationPrompt,
  buildRecallPrompt,
  parseAdjudications,
  parseReviewFindings,
  parseReviewSource,
  type Adjudication,
  type ReviewFinding,
} from "./review-cascade.js";

/** Default-off, owner-only background measurement lane (#132). */
export interface ReviewCascadeShadowConfig {
  mode: "off" | "shadow";
  gptModel: string;
  qwenModel: string;
  taskTypes: string[];
  maxTokens: number;
  timeoutMs: number;
}

export const DEFAULT_REVIEW_CASCADE_SHADOW: ReviewCascadeShadowConfig = {
  mode: "off",
  gptModel: "",
  qwenModel: "",
  taskTypes: ["code-review"],
  maxTokens: 2048,
  timeoutMs: 120_000,
};

export type CascadeTerminal = "completed" | "skipped" | "candidate-invalid" | "adjudication-invalid" | "error";

export interface ReviewCascadeShadowJob {
  taskType: string;
  /** Only a real minted owner key can set this. Guests never enter the lane. */
  ownerContent: boolean;
  /** Strict `line-id|source line` form; invalid source causes a no-model-call skip. */
  source: string;
}

export interface CascadeInference {
  ok: boolean;
  response?: string;
  error?: string;
  latencyMs?: number;
}

export interface ReviewCascadeDetails {
  source: string;
  findings: ReviewFinding[];
  adjudications: Adjudication[];
  gptLatencyMs: number | null;
  qwenLatencyMs: number | null;
}

export interface ReviewCascadeAggregate {
  terminal: CascadeTerminal;
  candidateCount: number;
  confirmed: number;
  refuted: number;
  insufficient: number;
  gpuOccupancyMs: number;
}

export interface ReviewCascadeShadowDeps {
  config: ReviewCascadeShadowConfig;
  /** Must count active real delegate work. Shadow work never reserves an admission slot. */
  queueDepth: () => number;
  infer: (modelId: string, prompt: string, cfg: ReviewCascadeShadowConfig) => Promise<CascadeInference>;
  /** Aggregate-only: implementation must never persist source, findings, or identities. */
  recordAggregate: (aggregate: ReviewCascadeAggregate) => void;
  /** Called only after `ownerContent` eligibility succeeds. */
  recordOwnerDetails: (details: ReviewCascadeDetails) => void;
}

export function reviewCascadeEligible(args: {
  config: ReviewCascadeShadowConfig;
  job: ReviewCascadeShadowJob;
  queueDepth: number;
  running: number;
}): { eligible: boolean; reason: string } {
  const { config, job, queueDepth, running } = args;
  if (config.mode !== "shadow") return { eligible: false, reason: "review cascade is off" };
  if (!job.ownerContent) return { eligible: false, reason: "guest/legacy content is never shadowed" };
  if (!config.gptModel || !config.qwenModel) return { eligible: false, reason: "cascade model ids are not configured" };
  if (!config.taskTypes.includes(job.taskType)) return { eligible: false, reason: "task type is not allow-listed" };
  if (!parseReviewSource(job.source).ok) return { eligible: false, reason: "source is not strictly line-addressable" };
  if (running > 0) return { eligible: false, reason: "another cascade is already running" };
  if (queueDepth > 0) return { eligible: false, reason: "real delegate work is queued" };
  return { eligible: true, reason: "review cascade eligible" };
}

let running = 0;
const pending = new Set<Promise<void>>();

/** Test join point; never needed by serving callers. */
export async function reviewCascadeShadowIdle(): Promise<void> {
  while (pending.size > 0) await Promise.all([...pending]);
}

export function resetReviewCascadeShadow(): void {
  running = 0;
  pending.clear();
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function aggregate(
  terminal: CascadeTerminal,
  findings: readonly ReviewFinding[] = [],
  adjudications: readonly Adjudication[] = [],
  occupancyMs = 0
): ReviewCascadeAggregate {
  return {
    terminal,
    candidateCount: findings.length,
    confirmed: adjudications.filter((a) => a.decision === "confirm").length,
    refuted: adjudications.filter((a) => a.decision === "refute").length,
    insufficient: adjudications.filter((a) => a.decision === "insufficient").length,
    gpuOccupancyMs: occupancyMs,
  };
}

/**
 * Fire-and-forget by contract. This function has no return value, no caller-visible effect, and
 * no route/action hooks. It never runs for guests, never blocks real work, and is disabled unless
 * explicitly configured as `shadow`.
 */
export function scheduleReviewCascadeShadow(job: ReviewCascadeShadowJob, deps: ReviewCascadeShadowDeps): void {
  const task = (async () => {
    await nextTick();
    const eligibility = reviewCascadeEligible({ config: deps.config, job, queueDepth: deps.queueDepth(), running });
    if (!eligibility.eligible) {
      deps.recordAggregate(aggregate("skipped"));
      return;
    }
    running++;
    let occupancyMs = 0;
    try {
      const recall = await deps.infer(deps.config.gptModel, buildRecallPrompt(job.source), deps.config);
      occupancyMs += recall.latencyMs ?? 0;
      if (!recall.ok || recall.response === undefined) {
        deps.recordAggregate(aggregate("error", [], [], occupancyMs));
        return;
      }
      const findings = parseReviewFindings(recall.response, job.source);
      if (!findings.ok) {
        deps.recordAggregate(aggregate("candidate-invalid", [], [], occupancyMs));
        return;
      }
      const precision = await deps.infer(
        deps.config.qwenModel,
        buildAdjudicationPrompt(job.source, findings.findings),
        deps.config
      );
      occupancyMs += precision.latencyMs ?? 0;
      if (!precision.ok || precision.response === undefined) {
        deps.recordAggregate(aggregate("error", findings.findings, [], occupancyMs));
        return;
      }
      const adjudications = parseAdjudications(precision.response, findings.findings.map((f) => f.id));
      if (!adjudications.ok) {
        deps.recordAggregate(aggregate("adjudication-invalid", findings.findings, [], occupancyMs));
        return;
      }
      deps.recordOwnerDetails({
        source: job.source,
        findings: findings.findings,
        adjudications: adjudications.adjudications,
        gptLatencyMs: recall.latencyMs ?? null,
        qwenLatencyMs: precision.latencyMs ?? null,
      });
      deps.recordAggregate(aggregate("completed", findings.findings, adjudications.adjudications, occupancyMs));
    } catch (error) {
      console.warn(`[review-cascade-shadow] evaluation failed: ${error instanceof Error ? error.message : String(error)}`);
      deps.recordAggregate(aggregate("error", [], [], occupancyMs));
    } finally {
      running--;
    }
  })();
  pending.add(task);
  void task.finally(() => pending.delete(task));
}
