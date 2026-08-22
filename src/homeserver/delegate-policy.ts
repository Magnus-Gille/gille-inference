import {
  DEFAULT_JUDGMENT_QUALITY_TASK_TYPES,
  type DelegatePolicyConfig,
  type PolicyConfig,
} from "./config.js";
import {
  getLaneEvidence,
  normalizedVerifierName as normalizedLedgerVerifierName,
  type LaneEvidence,
} from "./ledger.js";
import { isTrustedJudgmentVerifier, parseVerifierComponents } from "./verifier-classification.js";
import { isPromotedAdvisoryTaskType, normalizeTaskType, policyTaskTypeIdentity } from "./task-type-identity.js";
import { isKnownTaskType } from "./taxonomy.js";

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

// #91: these sets are compared against the CANONICAL policy identity (see `policyTaskTypeIdentity`
// in task-type-identity.ts), not the raw caller-supplied spelling — a case/whitespace variant of a
// known taxonomy id (e.g. "Other") must land in the same bucket as its canonical id for this lookup,
// or a caller could dodge the broad/low-risk classification purely by spelling.
const BROAD_TASK_TYPES: ReadonlySet<string> = new Set(["other", "unknown"]);
const LOW_RISK_TASK_TYPES: ReadonlySet<string> = new Set(["rewrite", "summarize", "translate"]);

/**
 * Task types whose local output must never become an automatic production merge/decision gate,
 * EVEN AFTER satisfying every other evidence threshold below — issue #74. `review-bounded`'s
 * verifier is a deterministic structural check (see review-bounded.ts), so it can accumulate
 * certified-lane evidence exactly like any other task type; this set is the extra, independent
 * guardrail that keeps that evidence advisory-only until an operator explicitly promotes it via
 * `delegatePolicy.promotedAdvisoryTaskTypes` (a measured-pass-rate decision, not a code change).
 * The promoted list defaults to empty, so a fresh checkout can never silently start treating
 * review-bounded output as authoritative merely by accumulating passing rows.
 */
const ADVISORY_ONLY_TASK_TYPES: ReadonlySet<string> = new Set(["review-bounded"]);

/**
 * True when `taskType`'s local output is advisory-only-by-construction (see the set above).
 *
 * #80: normalizes its OWN input (trim + case-fold) rather than trusting every caller to have
 * canonicalized first. This guardrail is the independent last line of defense, so it must hold
 * even when an ingress path forgets — and normalizing can only ever catch MORE input here.
 */
export function isAdvisoryOnlyTaskType(taskType: string): boolean {
  return ADVISORY_ONLY_TASK_TYPES.has(normalizeTaskType(taskType));
}
// Keep the historical model-scout prefix so old evidence remains classifiable; new evaluation
// producers should use model-evaluation or the more specific evidence-source names.
const LEARNING_SOURCE_PREFIXES = ["probe", "cartography", "harvest", "backfill", "model-evaluation", "model-scout", "gate-"];
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
  const normalized = normalizedLedgerVerifierName(name);
  if (normalized === null) return null;

  // `custom` is the orchestrator's policy-generic marker for an unnamed verifier. Keep the
  // existing policy behavior for a custom-only lane, while allowing it alongside a real named
  // verifier in a valid combined label. The ledger helper above has already rejected malformed,
  // empty, plus-only, and all-sentinel labels using the shared parser.
  const components = parseVerifierComponents(normalized);
  if (components.length === 0 || components.every((component) => component === "custom")) return null;
  return normalized;
}

export function isLearningSource(source: string | null | undefined): boolean {
  if (!source) return false;
  return LEARNING_SOURCES.has(source) || LEARNING_SOURCE_PREFIXES.some((prefix) => source.startsWith(prefix));
}

/**
 * `taskType` here is expected to already be a resolved policy identity (see
 * `policyTaskTypeIdentity` in task-type-identity.ts) — `decideDelegatePolicy` below is the only
 * caller and resolves it before calling in.
 */
export function requiredSuccessRateForTask(
  taskType: string,
  cfg: DelegatePolicyConfig
): number {
  return LOW_RISK_TASK_TYPES.has(taskType) ? cfg.lowRiskSuccessRate : cfg.minSuccessRate;
}

export function decideDelegatePolicy(input: DecideDelegatePolicyInput): DelegatePolicyDecision {
  const cfg = input.delegatePolicy;
  const verifierName = normalizeVerifierName(input.verifierName);
  // #91: resolve ONCE to the canonical policy identity — a case/whitespace variant of a known
  // taxonomy id (e.g. "Code-Review") is treated as that id for every gate below, so it cannot dodge
  // the judgment-verifier deny, the broad/low-risk classification, or the required success rate
  // purely by spelling. A spelling that does not normalize to a known id is left at its #155 ingress
  // identity and falls through to the unknown-lane policy exactly as before.
  const policyTaskType = policyTaskTypeIdentity(input.taskType, isKnownTaskType);
  const requiredSuccessRate = requiredSuccessRateForTask(policyTaskType, cfg);
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

  if (BROAD_TASK_TYPES.has(policyTaskType)) {
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
    judgmentTypes.includes(policyTaskType) &&
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

  // #74: the lane just cleared every evidence gate above (samples, success rate, error rate,
  // latency) — but an advisory-only task type still cannot become an automatic production
  // decision gate until an operator explicitly promotes it. This check runs LAST, deliberately
  // after every other deny/shadow diagnostic, so a genuinely broken lane still reports its real
  // blocking reason instead of always saying "advisory-only".
  if (
    isAdvisoryOnlyTaskType(input.taskType) &&
    !isPromotedAdvisoryTaskType(input.taskType, cfg.promotedAdvisoryTaskTypes)
  ) {
    return {
      ...base,
      action: "shadow",
      reason:
        `${input.taskType} cleared certified-lane evidence (${input.evidence.attempts} samples, ` +
        `success ${input.evidence.successRate.toFixed(3)}) but is advisory-only until promoted via ` +
        "delegatePolicy.promotedAdvisoryTaskTypes (#74)",
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
  // #91: read evidence from the same canonical policy identity `decideDelegatePolicy` gates
  // against below — a lane's evidence key is (taskType, modelId, nodeId, verifier), so a case
  // variant of a known task type reads and writes the REAL lane's evidence, not a parallel bucket
  // that a caller could grow independently of the canonical lane's track record (#95).
  const policyTaskType = policyTaskTypeIdentity(input.taskType, isKnownTaskType);
  const evidence =
    input.delegatePolicy.mode === "off" || isLearningSource(input.source)
      ? emptyEvidence(policyTaskType, input.modelId, verifierName)
      : getLaneEvidence(policyTaskType, input.modelId, verifierName, input.policy, input.nodeId ?? "m5");
  return decideDelegatePolicy({ ...input, evidence });
}
