import {
  DEFAULT_JUDGMENT_QUALITY_TASK_TYPES,
  type DelegatePolicyConfig,
  type PolicyConfig,
} from "./config.js";
import { getLaneEvidence, type LaneEvidence } from "./ledger.js";
import { isTrustedJudgmentVerifier, verifierBaseName } from "./verifier-classification.js";

export type DelegatePolicyAction = "allow" | "shadow" | "deny";

export interface DelegatePolicyDecision {
  action: DelegatePolicyAction;
  reason: string;
  mode: DelegatePolicyConfig["mode"];
  evidence: LaneEvidence;
  requiredSuccessRate: number;
  productionSource: boolean;
}

export interface DelegatePolicyInput {
  taskType: string;
  modelId: string;
  nodeId?: "m5" | "orin";
  verifierName?: string | null;
  hasVerifier: boolean;
  source?: string | null;
  explicitModelOverride?: boolean;
  policy: PolicyConfig;
  delegatePolicy: DelegatePolicyConfig;
}

export interface DecideDelegatePolicyInput extends DelegatePolicyInput {
  evidence: LaneEvidence;
}

const BROAD_TASK_TYPES: ReadonlySet<string> = new Set(["other", "unknown"]);
const LOW_RISK_TASK_TYPES: ReadonlySet<string> = new Set(["rewrite", "summarize", "translate"]);
const LEARNING_SOURCE_PREFIXES = ["probe", "cartography", "harvest", "backfill", "model-scout", "gate-"];
const LEARNING_SOURCES: ReadonlySet<string> = new Set([
  "extra-probes",
  "probe-import",
  "m5-cartography",
]);

function emptyEvidence(taskType: string, modelId: string, verifierName: string | null): LaneEvidence {
  return {
    taskType,
    modelId,
    verifier: normalizeVerifierName(verifierName),
    attempts: 0,
    passes: 0,
    partials: 0,
    fails: 0,
    errors: 0,
    successRate: 0,
    errorRate: 0,
    p50LatencyMs: null,
    p90LatencyMs: null,
    latestTs: null,
    sources: {},
  };
}

function normalizeVerifierName(name: string | null | undefined): string | null {
  const trimmed = name?.trim();
  const baseName = trimmed ? verifierBaseName(trimmed) : null;
  if (!trimmed || baseName === "none" || baseName === "custom") return null;
  return trimmed;
}

export function isLearningSource(source: string | null | undefined): boolean {
  if (!source) return false;
  return LEARNING_SOURCES.has(source) || LEARNING_SOURCE_PREFIXES.some((prefix) => source.startsWith(prefix));
}

export function requiredSuccessRateForTask(
  taskType: string,
  cfg: DelegatePolicyConfig
): number {
  return LOW_RISK_TASK_TYPES.has(taskType) ? cfg.lowRiskSuccessRate : cfg.minSuccessRate;
}

export function decideDelegatePolicy(input: DecideDelegatePolicyInput): DelegatePolicyDecision {
  const cfg = input.delegatePolicy;
  const verifierName = normalizeVerifierName(input.verifierName);
  const requiredSuccessRate = requiredSuccessRateForTask(input.taskType, cfg);
  const productionSource = !isLearningSource(input.source);

  const base = {
    mode: cfg.mode,
    evidence: input.evidence,
    requiredSuccessRate,
    productionSource,
  };

  if (cfg.mode === "off") {
    return { ...base, action: "allow", reason: "delegate-policy off" };
  }

  if (!productionSource) {
    return {
      ...base,
      action: "allow",
      reason: `learning source ${input.source} bypasses production delegate policy`,
    };
  }

  if (BROAD_TASK_TYPES.has(input.taskType)) {
    return {
      ...base,
      action: "deny",
      reason: `${input.taskType} is too broad for automatic production delegation`,
    };
  }

  if (!input.hasVerifier || verifierName === null) {
    return {
      ...base,
      action: "shadow",
      reason: "no verifier-backed lane; production should escalate until checking is cheap",
    };
  }

  const judgmentTypes = input.policy.judgmentQualityTaskTypes ?? DEFAULT_JUDGMENT_QUALITY_TASK_TYPES;
  if (
    judgmentTypes.includes(input.taskType) &&
    !isTrustedJudgmentVerifier(verifierName, new Set(input.policy.trustedVerifiersForJudgment ?? []))
  ) {
    return {
      ...base,
      action: "deny",
      reason: `${input.taskType} requires a trusted judgment verifier`,
    };
  }

  if (input.evidence.attempts < cfg.minSamples) {
    return {
      ...base,
      action: "shadow",
      reason: `insufficient verified lane evidence (${input.evidence.attempts}/${cfg.minSamples})`,
    };
  }

  if (input.evidence.successRate < requiredSuccessRate) {
    return {
      ...base,
      action: "deny",
      reason: `lane success rate ${input.evidence.successRate.toFixed(3)} < ${requiredSuccessRate}`,
    };
  }

  if (input.evidence.errorRate > cfg.maxErrorRate) {
    return {
      ...base,
      action: "deny",
      reason: `lane error rate ${input.evidence.errorRate.toFixed(3)} > ${cfg.maxErrorRate}`,
    };
  }

  if (input.evidence.p90LatencyMs === null) {
    return {
      ...base,
      action: "shadow",
      reason: "missing p90 latency evidence; cannot prove delegation is efficient",
    };
  }

  if (input.evidence.p90LatencyMs > cfg.maxP90LatencyMs) {
    return {
      ...base,
      action: "deny",
      reason: `lane p90 latency ${input.evidence.p90LatencyMs}ms > ${cfg.maxP90LatencyMs}ms`,
    };
  }

  return {
    ...base,
    action: "allow",
    reason: `certified lane: ${input.evidence.attempts} samples, success ${input.evidence.successRate.toFixed(3)}, p90 ${input.evidence.p90LatencyMs}ms`,
  };
}

export function evaluateDelegatePolicy(input: DelegatePolicyInput): DelegatePolicyDecision {
  const verifierName = normalizeVerifierName(input.verifierName);
  const evidence =
    input.delegatePolicy.mode === "off" || isLearningSource(input.source)
      ? emptyEvidence(input.taskType, input.modelId, verifierName)
      : getLaneEvidence(input.taskType, input.modelId, verifierName, input.policy, input.nodeId ?? "m5");
  return decideDelegatePolicy({ ...input, evidence });
}
