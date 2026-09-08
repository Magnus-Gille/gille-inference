/**
 * Pure, offline M3 qualification.  This module evaluates an operator-supplied
 * content-blind evidence snapshot.  It does not read the database, route work,
 * activate a candidate, or establish that an attestation is independently true.
 */

import { DEFAULT_JUDGMENT_QUALITY_TASK_TYPES } from "./config.js";
import { isKnownTaskType } from "./taxonomy.js";
import { classifyVerifierKind } from "./verifier-classification.js";

export const M3_QUALIFICATION_CONTRACT = "m5-m3-qualification-v1" as const;
export const M3_QUALIFICATION_VERSION = 1 as const;

export type QualificationSignalStatus = "measured" | "unknown" | "unproven";
export type QualificationSignalProvenance = "independently-verified" | "operator-attested";

export interface QualificationMeasuredSignal<T> {
  status: "measured";
  value: T;
  sampleSize: number;
  source: string;
  provenance: QualificationSignalProvenance;
}

export interface QualificationMissingSignal {
  status: "unknown" | "unproven";
  reason: string;
}

export type QualificationSignal<T> = QualificationMeasuredSignal<T> | QualificationMissingSignal;

export type QualificationTrafficPurpose = "organic" | "evaluation" | "synthetic" | "unknown";
export type QualificationDataClass =
  | "local-only"
  | "controlled-external-ok"
  | "external-ok"
  | "public";
export type QualificationDestinationClass =
  | "owned-local"
  | "controlled-external"
  | "general-external";
export type QualificationVerifierKind = "truth-oriented" | "mechanical-format" | "ungraded";

export interface QualificationThresholdReview {
  reviewerId: string;
  reviewedAt: string;
  decisionRef: string;
}

export interface QualificationThresholds {
  version: string;
  rationale: string;
  review: QualificationThresholdReview;
  expectedPolicyStamp: string;
  acceptedTaskTypes: string[];
  maxEvidenceAgeMs: number;
  minOrganicOpportunities: number;
  minOrganicAttempts: number;
  minQualityRate: number;
  minFeedbackCoverage: number;
  maxErrorRate: number;
  maxP90LatencyMs: number;
  maxBusyRate: number;
  maxCostPerAcceptedUsd: number;
  maxLocalToBaselineRatio: number | null;
}

export interface QualificationWindow {
  start: string;
  end: string;
}

export interface QualificationSnapshot {
  sha256: string;
  immutable: true;
  observedAt: string;
}

export interface QualificationCandidateKey {
  taskType: string;
  nodeId: string;
  modelId: string;
  lane: string;
  verifier: string;
}

export interface QualificationCandidateIdentity {
  evidenceIdentitySha256: string;
  artifactSha256: string;
  runtimeSha256: string;
  verifierSha256: string;
}

export interface QualificationCandidateEligibility {
  nonJudgmentLane: boolean;
  dataClass: QualificationDataClass;
  destinationClass: QualificationDestinationClass;
}

export interface QualificationVerifierIdentity {
  kind: QualificationVerifierKind;
  trusted: boolean;
  trustPolicyId: string;
}

export interface QualificationPurposeEvidence {
  /** Every bucket has an explicit candidate binding; only organic is gated. */
  candidateBound: boolean;
  opportunities: QualificationSignal<number>;
  attempts: QualificationSignal<number>;
  useful: QualificationSignal<number>;
  feedback: {
    assessed: QualificationSignal<number>;
    pass: QualificationSignal<number>;
    partial: QualificationSignal<number>;
    redo: QualificationSignal<number>;
    wrong: QualificationSignal<number>;
  };
}

export interface QualificationSafetyEvidence {
  boundedTaskType: QualificationSignal<boolean>;
  lowBlastRadius: QualificationSignal<boolean>;
  rollbackPathTested: QualificationSignal<boolean>;
  watchdogPathTested: QualificationSignal<boolean>;
}

export interface QualificationCostEvidence {
  localCostPerAcceptedUsd: QualificationSignal<number>;
  baselineCostPerAcceptedUsd: QualificationSignal<number>;
  localProvenance: string;
  baselineProvenance: string;
  calibrated: QualificationSignal<boolean>;
  exactOneCostCoverage: QualificationSignal<boolean>;
}

export interface M3QualificationCandidate {
  key: QualificationCandidateKey;
  identity: QualificationCandidateIdentity;
  eligibility: QualificationCandidateEligibility;
  policy: { fullStamps: string[] };
  verifier: QualificationVerifierIdentity;
  safety: QualificationSafetyEvidence;
  samples: Record<QualificationTrafficPurpose, QualificationPurposeEvidence>;
  /** Rate and latency sample sizes are bound to organic attempts below. */
  qualityRate: QualificationSignal<number>;
  errorRate: QualificationSignal<number>;
  p90LatencyMs: QualificationSignal<number>;
  /** Busy rate is bound to organic opportunities. */
  busyRate: QualificationSignal<number>;
  cost: QualificationCostEvidence;
}

export interface M3QualificationInput {
  contract: typeof M3_QUALIFICATION_CONTRACT;
  version: 1;
  evaluation: { asOf: string };
  window: QualificationWindow;
  snapshot: QualificationSnapshot;
  thresholds: QualificationThresholds | null;
  candidates: M3QualificationCandidate[];
}

export interface QualificationSignalSummary {
  status: QualificationSignalStatus;
  value: number | boolean | null;
  sampleSize: number | null;
}

export interface QualificationPurposeSummary {
  candidateBound: boolean | null;
  opportunities: QualificationSignalSummary;
  attempts: QualificationSignalSummary;
  useful: QualificationSignalSummary;
  assessed: QualificationSignalSummary;
  pass: QualificationSignalSummary;
  partial: QualificationSignalSummary;
  redo: QualificationSignalSummary;
  wrong: QualificationSignalSummary;
}

export interface QualificationCandidateReport {
  key: QualificationCandidateKey;
  identity: QualificationCandidateIdentity;
  diagnostic: "PASS" | "HOLD";
  reasons: string[];
  policyStatus: "matched" | "missing" | "stale" | "mixed" | "invalid";
  eligibility: {
    nonJudgmentLane: boolean | null;
    dataClass: QualificationDataClass | null;
    destinationClass: QualificationDestinationClass | null;
  };
  verifier: {
    kind: QualificationVerifierKind | null;
    trusted: boolean | null;
    trustPolicyId: string;
  };
  safety: {
    boundedTaskType: QualificationSignalSummary;
    lowBlastRadius: QualificationSignalSummary;
    rollbackPathTested: QualificationSignalSummary;
    watchdogPathTested: QualificationSignalSummary;
  };
  costProvenance: { local: string; baseline: string };
  evidence: {
    organic: QualificationPurposeSummary;
    evaluation: QualificationPurposeSummary;
    synthetic: QualificationPurposeSummary;
    unknown: QualificationPurposeSummary;
    qualityRate: QualificationSignalSummary;
    errorRate: QualificationSignalSummary;
    p90LatencyMs: QualificationSignalSummary;
    busyRate: QualificationSignalSummary;
    localCostPerAcceptedUsd: QualificationSignalSummary;
    baselineCostPerAcceptedUsd: QualificationSignalSummary;
    calibrated: QualificationSignalSummary;
    exactOneCostCoverage: QualificationSignalSummary;
  };
}

export interface QualificationThresholdSummary {
  version: string;
  acceptedTaskTypes: string[];
  maxEvidenceAgeMs: number;
  minOrganicOpportunities: number;
  minOrganicAttempts: number;
  minQualityRate: number;
  minFeedbackCoverage: number;
  maxErrorRate: number;
  maxP90LatencyMs: number;
  maxBusyRate: number;
  maxCostPerAcceptedUsd: number;
  maxLocalToBaselineRatio: number | null;
}

export interface M3QualificationDecision {
  contract: typeof M3_QUALIFICATION_CONTRACT;
  version: 1;
  evidenceBasis: "operator-supplied";
  evaluationAsOf: string;
  window: QualificationWindow;
  snapshot: { sha256: string; observedAt: string };
  thresholds: QualificationThresholdSummary | null;
  candidates: QualificationCandidateReport[];
  analysisVerdict: "HOLD" | "GO";
  selectedCandidate: QualificationCandidateKey | null;
  reasons: string[];
  /** Qualification is diagnostic only; activation is owned by lifecycle policy. */
  enablingDecision: null;
}

type AnyRecord = Record<string, unknown>;
type NumericSignalField = "count" | "rate" | "latency" | "cost";
type SummaryKind = "count" | "rate" | "nonnegative" | "boolean";

const SHA256_RE = /^sha256:[a-f0-9]{64}$/;
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
// Keep this in sync with harvest.ts's exported HARVEST_JUDGE_POLICY/buildJudgePolicyStamp
// contract without importing harvest.ts (which has a broad ledger dependency). The full stamp
// is compared to the operator-supplied expectedPolicyStamp below; a prefix check alone is not
// sufficient because the context budget is part of grading semantics.
const CURRENT_HARVEST_POLICY = "ctx-tools-parts-v1";
const POLICY_STAMP_RE = new RegExp(`^${CURRENT_HARVEST_POLICY}\\|ctx=(0|[1-9]\\d{0,15})$`);
const TEXT_RE = /^[^\u0000-\u001f\u007f]{1,1024}$/u;
const PURPOSES: QualificationTrafficPurpose[] = ["organic", "evaluation", "synthetic", "unknown"];
const KEY_FIELDS: Array<keyof QualificationCandidateKey> = [
  "taskType",
  "nodeId",
  "modelId",
  "lane",
  "verifier",
];
const IDENTITY_FIELDS: Array<keyof QualificationCandidateIdentity> = [
  "evidenceIdentitySha256",
  "artifactSha256",
  "runtimeSha256",
  "verifierSha256",
];

function isRecord(value: unknown): value is AnyRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN_RE.test(value);
}

function isText(value: unknown): value is string {
  return typeof value === "string" && TEXT_RE.test(value);
}

function isCanonicalPolicyStamp(value: unknown): value is string {
  if (typeof value !== "string" || !POLICY_STAMP_RE.test(value)) return false;
  const contextChars = Number(value.slice(value.indexOf("=") + 1));
  return Number.isSafeInteger(contextChars) && contextChars >= 0;
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isFiniteNonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isRate(value: unknown): value is number {
  return isFiniteNonnegative(value) && value <= 1;
}

function parseCanonicalIso(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    return null;
  }
  const millis = Date.parse(value);
  return Number.isFinite(millis) && new Date(millis).toISOString() === value ? millis : null;
}

function digest(value: unknown): value is string {
  return typeof value === "string" && SHA256_RE.test(value);
}

function sortedReasons(reasons: Iterable<string>): string[] {
  return [...new Set(reasons)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function safeKey(raw: unknown): QualificationCandidateKey {
  const record = isRecord(raw) ? raw : {};
  return {
    taskType: isToken(record.taskType) ? record.taskType : "",
    nodeId: isToken(record.nodeId) ? record.nodeId : "",
    modelId: isToken(record.modelId) ? record.modelId : "",
    lane: isToken(record.lane) ? record.lane : "",
    verifier: isToken(record.verifier) ? record.verifier : "",
  };
}

function keyString(key: QualificationCandidateKey): string {
  return KEY_FIELDS.map((field) => key[field]).join("\u001f");
}

function safeIdentity(raw: unknown): QualificationCandidateIdentity {
  const record = isRecord(raw) ? raw : {};
  return {
    evidenceIdentitySha256: digest(record.evidenceIdentitySha256) ? record.evidenceIdentitySha256 : "",
    artifactSha256: digest(record.artifactSha256) ? record.artifactSha256 : "",
    runtimeSha256: digest(record.runtimeSha256) ? record.runtimeSha256 : "",
    verifierSha256: digest(record.verifierSha256) ? record.verifierSha256 : "",
  };
}

function safeDataClass(value: unknown): QualificationDataClass | null {
  return value === "local-only" || value === "controlled-external-ok" || value === "external-ok" || value === "public"
    ? value
    : null;
}

function safeDestinationClass(value: unknown): QualificationDestinationClass | null {
  return value === "owned-local" || value === "controlled-external" || value === "general-external"
    ? value
    : null;
}

function safeVerifierKind(value: unknown): QualificationVerifierKind | null {
  return value === "truth-oriented" || value === "mechanical-format" || value === "ungraded" ? value : null;
}

function signalStatus(value: unknown): QualificationSignalStatus {
  if (!isRecord(value)) return "unknown";
  if (value.status === "measured") return "measured";
  if (value.status === "unproven") return "unproven";
  return "unknown";
}

function summarizeSignal(value: unknown, kind: SummaryKind): QualificationSignalSummary {
  const record = isRecord(value) ? value : {};
  const status = signalStatus(value);
  if (status !== "measured") return { status, value: null, sampleSize: null };
  const sampleSize = isSafeInteger(record.sampleSize) ? record.sampleSize : null;
  const validSampleSize = sampleSize !== null && (kind === "count" ? sampleSize >= 0 : sampleSize >= 1);
  const validValue = kind === "boolean"
    ? typeof record.value === "boolean"
    : kind === "count"
      ? isSafeInteger(record.value)
      : kind === "rate"
        ? isRate(record.value)
        : isFiniteNonnegative(record.value);
  if (!validSampleSize || !validValue || record.provenance !== "independently-verified" || !isToken(record.source)) {
    return { status: "unproven", value: null, sampleSize };
  }
  return { status, value: record.value as number | boolean, sampleSize };
}

function signalSampleSize(value: unknown): number | null {
  const record = isRecord(value) ? value : {};
  return signalStatus(value) === "measured" && isSafeInteger(record.sampleSize) ? record.sampleSize : null;
}

function addSignalReason(
  raw: unknown,
  field: string,
  reasons: string[],
  required: boolean,
): QualificationSignalStatus | null {
  const status = signalStatus(raw);
  if (status === "unknown") {
    if (required) reasons.push(`missing_${field}`);
    return null;
  }
  if (status === "unproven") {
    if (required) reasons.push(`unproven_${field}`);
    return null;
  }
  const record = isRecord(raw) ? raw : {};
  if (record.provenance !== "independently-verified" || !isToken(record.source)) {
    if (required) reasons.push(`unproven_${field}`);
    return null;
  }
  if (!isSafeInteger(record.sampleSize)) {
    reasons.push("invalid_metric");
    return null;
  }
  return status;
}

function readNumber(
  raw: unknown,
  field: string,
  kind: NumericSignalField,
  reasons: string[],
  required: boolean,
): number | null {
  if (addSignalReason(raw, field, reasons, required) === null) return null;
  const record = raw as AnyRecord;
  const value = record.value;
  const valid = kind === "count" ? isSafeInteger(value) : kind === "rate" ? isRate(value) : isFiniteNonnegative(value);
  if (!valid) {
    reasons.push("invalid_metric");
    return null;
  }
  if (kind !== "count" && (record.sampleSize as number) < 1) {
    reasons.push("invalid_metric");
    return null;
  }
  return value as number;
}

function readBoolean(raw: unknown, field: string, reasons: string[], required: boolean): boolean | null {
  if (addSignalReason(raw, field, reasons, required) === null) return null;
  const record = raw as AnyRecord;
  if ((record.sampleSize as number) < 1) {
    reasons.push("invalid_metric");
    return null;
  }
  if (typeof record.value !== "boolean") {
    reasons.push("invalid_metric");
    return null;
  }
  return record.value;
}

function purposeSummary(raw: unknown): QualificationPurposeSummary {
  const record = isRecord(raw) ? raw : {};
  const feedback = isRecord(record.feedback) ? record.feedback : {};
  return {
    candidateBound: typeof record.candidateBound === "boolean" ? record.candidateBound : null,
    opportunities: summarizeSignal(record.opportunities, "count"),
    attempts: summarizeSignal(record.attempts, "count"),
    useful: summarizeSignal(record.useful, "count"),
    assessed: summarizeSignal(feedback.assessed, "count"),
    pass: summarizeSignal(feedback.pass, "count"),
    partial: summarizeSignal(feedback.partial, "count"),
    redo: summarizeSignal(feedback.redo, "count"),
    wrong: summarizeSignal(feedback.wrong, "count"),
  };
}

function thresholdSummary(raw: QualificationThresholds): QualificationThresholdSummary {
  return {
    version: isToken(raw.version) ? raw.version : "",
    acceptedTaskTypes: Array.isArray(raw.acceptedTaskTypes) ? raw.acceptedTaskTypes.filter(isToken).sort() : [],
    maxEvidenceAgeMs: isSafeInteger(raw.maxEvidenceAgeMs) ? raw.maxEvidenceAgeMs : 0,
    minOrganicOpportunities: isSafeInteger(raw.minOrganicOpportunities) ? raw.minOrganicOpportunities : 0,
    minOrganicAttempts: isSafeInteger(raw.minOrganicAttempts) ? raw.minOrganicAttempts : 0,
    minQualityRate: isRate(raw.minQualityRate) ? raw.minQualityRate : 0,
    minFeedbackCoverage: isRate(raw.minFeedbackCoverage) ? raw.minFeedbackCoverage : 0,
    maxErrorRate: isRate(raw.maxErrorRate) ? raw.maxErrorRate : 0,
    maxP90LatencyMs: isFiniteNonnegative(raw.maxP90LatencyMs) ? raw.maxP90LatencyMs : 0,
    maxBusyRate: isRate(raw.maxBusyRate) ? raw.maxBusyRate : 0,
    maxCostPerAcceptedUsd: isFiniteNonnegative(raw.maxCostPerAcceptedUsd) ? raw.maxCostPerAcceptedUsd : 0,
    maxLocalToBaselineRatio: raw.maxLocalToBaselineRatio === null || isFiniteNonnegative(raw.maxLocalToBaselineRatio)
      ? raw.maxLocalToBaselineRatio
      : null,
  };
}

function validateThresholds(raw: unknown): { thresholds: QualificationThresholds | null; reasons: string[] } {
  if (!isRecord(raw)) return { thresholds: null, reasons: ["invalid_thresholds"] };
  const review = isRecord(raw.review) ? raw.review : {};
  const valid =
    isToken(raw.version) &&
    isText(raw.rationale) &&
    isToken(review.reviewerId) &&
    parseCanonicalIso(review.reviewedAt) !== null &&
    isToken(review.decisionRef) &&
    isCanonicalPolicyStamp(raw.expectedPolicyStamp) &&
    Array.isArray(raw.acceptedTaskTypes) &&
    raw.acceptedTaskTypes.length > 0 &&
    raw.acceptedTaskTypes.every(isToken) &&
    raw.acceptedTaskTypes.every(isKnownTaskType) &&
    new Set(raw.acceptedTaskTypes).size === raw.acceptedTaskTypes.length &&
    isSafeInteger(raw.maxEvidenceAgeMs) &&
    isSafeInteger(raw.minOrganicOpportunities) &&
    isSafeInteger(raw.minOrganicAttempts) &&
    isRate(raw.minQualityRate) &&
    isRate(raw.minFeedbackCoverage) &&
    isRate(raw.maxErrorRate) &&
    isFiniteNonnegative(raw.maxP90LatencyMs) &&
    isRate(raw.maxBusyRate) &&
    isFiniteNonnegative(raw.maxCostPerAcceptedUsd) &&
    (raw.maxLocalToBaselineRatio === null || isFiniteNonnegative(raw.maxLocalToBaselineRatio));
  return valid ? { thresholds: raw as unknown as QualificationThresholds, reasons: [] } : { thresholds: null, reasons: ["invalid_thresholds"] };
}

function destinationAllowed(dataClass: unknown, destinationClass: unknown): boolean {
  if (dataClass === "local-only") return destinationClass === "owned-local";
  if (dataClass === "controlled-external-ok") return destinationClass === "owned-local" || destinationClass === "controlled-external";
  if (dataClass === "external-ok" || dataClass === "public") {
    return destinationClass === "owned-local" || destinationClass === "controlled-external" || destinationClass === "general-external";
  }
  return false;
}

function validatePurpose(
  raw: unknown,
  purpose: QualificationTrafficPurpose,
  reasons: string[],
): { values: Partial<Record<string, number>>; candidateBound: boolean | null } {
  const record = isRecord(raw) ? raw : {};
  const feedback = isRecord(record.feedback) ? record.feedback : {};
  const required = purpose === "organic";
  const values: Partial<Record<string, number>> = {};
  const fields: Array<[string, unknown]> = [
    ["opportunities", record.opportunities],
    ["attempts", record.attempts],
    ["useful", record.useful],
    ["assessed", feedback.assessed],
    ["pass", feedback.pass],
    ["partial", feedback.partial],
    ["redo", feedback.redo],
    ["wrong", feedback.wrong],
  ];
  for (const [field, signal] of fields) {
    const value = readNumber(signal, `${purpose}_${field}`, "count", reasons, required);
    if (value !== null) values[field] = value;
  }
  const candidateBound = typeof record.candidateBound === "boolean" ? record.candidateBound : null;
  if (candidateBound === null) reasons.push("invalid_input");
  if (purpose === "organic" && candidateBound !== true) reasons.push("organic_provenance_unbound");

  const opportunities = values.opportunities;
  const attempts = values.attempts;
  const useful = values.useful;
  const assessed = values.assessed;
  const pass = values.pass;
  const partial = values.partial;
  const redo = values.redo;
  const wrong = values.wrong;
  if (attempts !== undefined && opportunities !== undefined && attempts > opportunities) reasons.push("inconsistent_counts");
  if (useful !== undefined && attempts !== undefined && useful > attempts) reasons.push("inconsistent_counts");
  if (assessed !== undefined && attempts !== undefined && assessed > attempts) reasons.push("inconsistent_counts");
  if (
    assessed !== undefined &&
    pass !== undefined &&
    partial !== undefined &&
    redo !== undefined &&
    wrong !== undefined &&
    pass + partial + redo + wrong !== assessed
  ) {
    reasons.push("inconsistent_counts");
  }
  return { values, candidateBound };
}

function validateCandidate(raw: unknown, thresholds: QualificationThresholds | null): QualificationCandidateReport {
  const candidate = isRecord(raw) ? raw : {};
  const reasons: string[] = [];
  const key = safeKey(candidate.key);
  const identity = safeIdentity(candidate.identity);
  if (KEY_FIELDS.some((field) => !isToken(isRecord(candidate.key) ? candidate.key[field] : undefined))) {
    reasons.push("invalid_identity");
  }
  if (IDENTITY_FIELDS.some((field) => !digest(isRecord(candidate.identity) ? candidate.identity[field] : undefined))) {
    reasons.push("invalid_identity");
  }

  const eligibility = isRecord(candidate.eligibility) ? candidate.eligibility : {};
  const dataClass = eligibility.dataClass;
  const destinationClass = eligibility.destinationClass;
  if (
    typeof eligibility.nonJudgmentLane !== "boolean" ||
    !["local-only", "controlled-external-ok", "external-ok", "public"].includes(dataClass as string) ||
    !["owned-local", "controlled-external", "general-external"].includes(destinationClass as string)
  ) {
    reasons.push("invalid_eligibility");
  } else {
    if (eligibility.nonJudgmentLane !== true) reasons.push("ineligible_candidate");
    if (!destinationAllowed(dataClass, destinationClass)) reasons.push("incompatible_data_destination");
  }
  if (!isKnownTaskType(key.taskType)) reasons.push("unknown_task_type");
  if (DEFAULT_JUDGMENT_QUALITY_TASK_TYPES.includes(key.taskType)) reasons.push("judgment_task_type");
  if (thresholds !== null && !thresholds.acceptedTaskTypes.includes(key.taskType)) reasons.push("task_type_not_allowed");

  const policy = isRecord(candidate.policy) ? candidate.policy : {};
  const rawStamps = policy.fullStamps;
  let policyStatus: QualificationCandidateReport["policyStatus"] = "invalid";
  if (!Array.isArray(rawStamps) || rawStamps.some((stamp) => !isCanonicalPolicyStamp(stamp))) {
    reasons.push("invalid_policy");
  } else {
    const stamps = [...new Set(rawStamps)];
    if (stamps.length === 0) {
      policyStatus = "missing";
      reasons.push("missing_policy");
    } else if (stamps.length > 1) {
      policyStatus = "mixed";
      reasons.push("mixed_policy");
    } else if (thresholds === null || stamps[0] !== thresholds.expectedPolicyStamp) {
      policyStatus = "stale";
      reasons.push("stale_policy");
    } else {
      policyStatus = "matched";
    }
  }

  const verifier = isRecord(candidate.verifier) ? candidate.verifier : {};
  const claimedKind = safeVerifierKind(verifier.kind);
  // The key's verifier is the actual label identity. A caller-supplied kind is only an
  // attestation and cannot turn jsonValid/answerIs (or any other mechanical label) into truth.
  const actualKind = classifyVerifierKind(key.verifier || null) as QualificationVerifierKind;
  if (actualKind === "mechanical-format" || actualKind === "ungraded") reasons.push("format_only_verifier");
  if (claimedKind === null || claimedKind !== actualKind) reasons.push("verifier_kind_mismatch");
  if (
    actualKind !== "truth-oriented" ||
    verifier.trusted !== true ||
    !isToken(verifier.trustPolicyId)
  ) {
    reasons.push("untrusted_verifier");
  }

  const safety = isRecord(candidate.safety) ? candidate.safety : {};
  const safetyFields: Array<[string, unknown, string, string]> = [
    ["boundedTaskType", safety.boundedTaskType, "bounded_task_type", "unsafe_task_type"],
    ["lowBlastRadius", safety.lowBlastRadius, "low_blast_radius", "high_blast_radius"],
    ["rollbackPathTested", safety.rollbackPathTested, "rollback_path", "rollback_path_untested"],
    ["watchdogPathTested", safety.watchdogPathTested, "watchdog_path", "watchdog_path_untested"],
  ];
  for (const [, signal, field, falseReason] of safetyFields) {
    const value = readBoolean(signal, field, reasons, true);
    if (value === false) reasons.push(falseReason);
  }

  const samples = isRecord(candidate.samples) ? candidate.samples : {};
  const validatedPurposes: Record<QualificationTrafficPurpose, ReturnType<typeof validatePurpose>> = {
    organic: validatePurpose(samples.organic, "organic", reasons),
    evaluation: validatePurpose(samples.evaluation, "evaluation", reasons),
    synthetic: validatePurpose(samples.synthetic, "synthetic", reasons),
    unknown: validatePurpose(samples.unknown, "unknown", reasons),
  };

  const qualityRate = readNumber(candidate.qualityRate, "quality", "rate", reasons, true);
  if (qualityRate !== null && thresholds !== null && qualityRate < thresholds.minQualityRate) reasons.push("insufficient_quality");
  const errorRate = readNumber(candidate.errorRate, "error_rate", "rate", reasons, true);
  if (errorRate !== null && thresholds !== null && errorRate > thresholds.maxErrorRate) reasons.push("error_rate_exceeded");
  const latency = readNumber(candidate.p90LatencyMs, "latency", "latency", reasons, true);
  if (latency !== null && thresholds !== null && latency > thresholds.maxP90LatencyMs) reasons.push("latency_exceeded");
  const busy = readNumber(candidate.busyRate, "busy_signal", "rate", reasons, true);
  if (busy !== null && thresholds !== null && busy > thresholds.maxBusyRate) reasons.push("busy_rate_exceeded");

  const cost = isRecord(candidate.cost) ? candidate.cost : {};
  if (!isToken(cost.localProvenance) || !isToken(cost.baselineProvenance)) reasons.push("invalid_cost");
  const localCost = readNumber(cost.localCostPerAcceptedUsd, "cost", "cost", reasons, true);
  const baselineCost = readNumber(cost.baselineCostPerAcceptedUsd, "baseline_cost", "cost", reasons, true);
  const calibrated = readBoolean(cost.calibrated, "cost_calibration", reasons, true);
  const exactCoverage = readBoolean(cost.exactOneCostCoverage, "cost_coverage", reasons, true);
  if (calibrated === false) reasons.push("uncalibrated_cost");
  if (exactCoverage === false) reasons.push("invalid_cost_coverage");
  if (localCost !== null && thresholds !== null && localCost > thresholds.maxCostPerAcceptedUsd) reasons.push("cost_exceeded");
  if (thresholds?.maxLocalToBaselineRatio !== null && thresholds?.maxLocalToBaselineRatio !== undefined) {
    if (baselineCost === null || baselineCost <= 0 || localCost === null) {
      reasons.push("invalid_cost");
    } else if (localCost / baselineCost > thresholds.maxLocalToBaselineRatio) {
      reasons.push("cost_ratio_exceeded");
    }
  }

  const organic = validatedPurposes.organic.values;
  if (
    thresholds !== null &&
    (organic.opportunities === undefined || organic.attempts === undefined ||
      organic.opportunities < thresholds.minOrganicOpportunities ||
      organic.attempts < thresholds.minOrganicAttempts)
  ) {
    reasons.push("insufficient_organic_sample");
  }
  if (organic.attempts !== undefined && organic.attempts > 0 && organic.assessed !== undefined) {
    if (organic.assessed / organic.attempts < (thresholds?.minFeedbackCoverage ?? 1)) reasons.push("insufficient_feedback");
  } else {
    reasons.push("missing_feedback");
  }

  const qualitySampleSize = signalSampleSize(candidate.qualityRate);
  if (qualitySampleSize !== null && organic.attempts !== undefined && qualitySampleSize !== organic.attempts) {
    reasons.push("quality_denominator_mismatch");
  }
  const errorSampleSize = signalSampleSize(candidate.errorRate);
  if (errorSampleSize !== null && organic.attempts !== undefined && errorSampleSize !== organic.attempts) {
    reasons.push("error_denominator_mismatch");
  }
  const latencySampleSize = signalSampleSize(candidate.p90LatencyMs);
  if (latencySampleSize !== null && organic.attempts !== undefined && latencySampleSize !== organic.attempts) {
    reasons.push("latency_denominator_mismatch");
  }
  const busySampleSize = signalSampleSize(candidate.busyRate);
  if (busySampleSize !== null && organic.opportunities !== undefined && busySampleSize !== organic.opportunities) {
    reasons.push("busy_denominator_mismatch");
  }
  const organicPass = organic.pass;
  const localCostSampleSize = signalSampleSize(cost.localCostPerAcceptedUsd);
  const baselineCostSampleSize = signalSampleSize(cost.baselineCostPerAcceptedUsd);
  if (organicPass !== undefined) {
    if (localCostSampleSize !== null && localCostSampleSize !== organicPass) reasons.push("cost_denominator_mismatch");
    if (baselineCostSampleSize !== null && baselineCostSampleSize !== organicPass) reasons.push("cost_denominator_mismatch");
  }
  if (localCostSampleSize !== null && baselineCostSampleSize !== null && localCostSampleSize !== baselineCostSampleSize) {
    reasons.push("cost_denominator_mismatch");
  }

  const eligibilityReport = {
    nonJudgmentLane: typeof eligibility.nonJudgmentLane === "boolean" ? eligibility.nonJudgmentLane : null,
    dataClass: safeDataClass(dataClass),
    destinationClass: safeDestinationClass(destinationClass),
  } satisfies QualificationCandidateReport["eligibility"];
  const verifierReport = {
    kind: actualKind,
    trusted: typeof verifier.trusted === "boolean" ? verifier.trusted : null,
    trustPolicyId: isToken(verifier.trustPolicyId) ? verifier.trustPolicyId : "",
  } satisfies QualificationCandidateReport["verifier"];
  const safetyReport = {
    boundedTaskType: summarizeSignal(safety.boundedTaskType, "boolean"),
    lowBlastRadius: summarizeSignal(safety.lowBlastRadius, "boolean"),
    rollbackPathTested: summarizeSignal(safety.rollbackPathTested, "boolean"),
    watchdogPathTested: summarizeSignal(safety.watchdogPathTested, "boolean"),
  } satisfies QualificationCandidateReport["safety"];
  const costProvenance = {
    local: isToken(cost.localProvenance) ? cost.localProvenance : "",
    baseline: isToken(cost.baselineProvenance) ? cost.baselineProvenance : "",
  };

  const report: QualificationCandidateReport = {
    key,
    identity,
    diagnostic: reasons.length === 0 && thresholds !== null ? "PASS" : "HOLD",
    reasons: sortedReasons(reasons),
    policyStatus,
    eligibility: eligibilityReport,
    verifier: verifierReport,
    safety: safetyReport,
    costProvenance,
    evidence: {
      organic: purposeSummary(samples.organic),
      evaluation: purposeSummary(samples.evaluation),
      synthetic: purposeSummary(samples.synthetic),
      unknown: purposeSummary(samples.unknown),
      qualityRate: summarizeSignal(candidate.qualityRate, "rate"),
      errorRate: summarizeSignal(candidate.errorRate, "rate"),
      p90LatencyMs: summarizeSignal(candidate.p90LatencyMs, "nonnegative"),
      busyRate: summarizeSignal(candidate.busyRate, "rate"),
      localCostPerAcceptedUsd: summarizeSignal(cost.localCostPerAcceptedUsd, "nonnegative"),
      baselineCostPerAcceptedUsd: summarizeSignal(cost.baselineCostPerAcceptedUsd, "nonnegative"),
      calibrated: summarizeSignal(cost.calibrated, "boolean"),
      exactOneCostCoverage: summarizeSignal(cost.exactOneCostCoverage, "boolean"),
    },
  };
  return report;
}

function invalidWindowValue(raw: unknown): QualificationWindow {
  const record = isRecord(raw) ? raw : {};
  return {
    start: typeof record.start === "string" && parseCanonicalIso(record.start) !== null ? record.start : "",
    end: typeof record.end === "string" && parseCanonicalIso(record.end) !== null ? record.end : "",
  };
}

function invalidSnapshotValue(raw: unknown): { sha256: string; observedAt: string } {
  const record = isRecord(raw) ? raw : {};
  return {
    sha256: digest(record.sha256) ? record.sha256 : "",
    observedAt: typeof record.observedAt === "string" && parseCanonicalIso(record.observedAt) !== null ? record.observedAt : "",
  };
}

function emptyReport(): QualificationCandidateReport {
  const empty: QualificationSignalSummary = { status: "unknown", value: null, sampleSize: null };
  const purpose: QualificationPurposeSummary = {
    candidateBound: null,
    opportunities: empty,
    attempts: empty,
    useful: empty,
    assessed: empty,
    pass: empty,
    partial: empty,
    redo: empty,
    wrong: empty,
  };
  return {
    key: { taskType: "", nodeId: "", modelId: "", lane: "", verifier: "" },
    identity: { evidenceIdentitySha256: "", artifactSha256: "", runtimeSha256: "", verifierSha256: "" },
    diagnostic: "HOLD",
    reasons: ["invalid_input"],
    policyStatus: "invalid",
    eligibility: { nonJudgmentLane: null, dataClass: null, destinationClass: null },
    verifier: { kind: null, trusted: null, trustPolicyId: "" },
    safety: {
      boundedTaskType: empty,
      lowBlastRadius: empty,
      rollbackPathTested: empty,
      watchdogPathTested: empty,
    },
    costProvenance: { local: "", baseline: "" },
    evidence: {
      organic: purpose,
      evaluation: purpose,
      synthetic: purpose,
      unknown: purpose,
      qualityRate: empty,
      errorRate: empty,
      p90LatencyMs: empty,
      busyRate: empty,
      localCostPerAcceptedUsd: empty,
      baselineCostPerAcceptedUsd: empty,
      calibrated: empty,
      exactOneCostCoverage: empty,
    },
  };
}

export function evaluateM3Qualification(input: M3QualificationInput): M3QualificationDecision {
  const raw = input as unknown;
  const record = isRecord(raw) ? raw : {};
  const globalReasons: string[] = [];
  if (record.contract !== M3_QUALIFICATION_CONTRACT || record.version !== M3_QUALIFICATION_VERSION) globalReasons.push("invalid_input");

  const evaluation = isRecord(record.evaluation) ? record.evaluation : {};
  const asOfMillis = parseCanonicalIso(evaluation.asOf);
  const asOf = asOfMillis === null ? "" : (evaluation.asOf as string);
  if (asOfMillis === null) globalReasons.push("invalid_input");

  const window = invalidWindowValue(record.window);
  const startMillis = parseCanonicalIso(window.start);
  const endMillis = parseCanonicalIso(window.end);
  if (startMillis === null || endMillis === null || startMillis >= endMillis) globalReasons.push("invalid_window");
  if (asOfMillis !== null && endMillis !== null && endMillis > asOfMillis) globalReasons.push("window_after_asof");

  const snapshot = invalidSnapshotValue(record.snapshot);
  const snapshotRecord = isRecord(record.snapshot) ? record.snapshot : {};
  const observedMillis = parseCanonicalIso(snapshot.observedAt);
  if (!digest(snapshotRecord.sha256) || snapshotRecord.immutable !== true || observedMillis === null) globalReasons.push("invalid_snapshot");
  if (asOfMillis !== null && observedMillis !== null) {
    if (observedMillis > asOfMillis) globalReasons.push("snapshot_after_asof");
  }
  if (endMillis !== null && observedMillis !== null && observedMillis < endMillis) {
    globalReasons.push("snapshot_before_window_end");
  }

  const thresholdValue = record.thresholds;
  let thresholds: QualificationThresholds | null = null;
  if (thresholdValue === null) {
    globalReasons.push("missing_thresholds");
  } else {
    const validated = validateThresholds(thresholdValue);
    thresholds = validated.thresholds;
    globalReasons.push(...validated.reasons);
  }
  if (thresholds !== null && startMillis !== null) {
    const reviewedMillis = parseCanonicalIso(thresholds.review.reviewedAt);
    if (reviewedMillis !== null && reviewedMillis >= startMillis) globalReasons.push("review_after_window");
  }
  if (thresholds !== null && asOfMillis !== null && observedMillis !== null) {
    const age = asOfMillis - observedMillis;
    if (age < 0 || age > thresholds.maxEvidenceAgeMs) globalReasons.push("stale_snapshot");
  }
  if (thresholds !== null && asOfMillis !== null && endMillis !== null) {
    const age = asOfMillis - endMillis;
    if (age > thresholds.maxEvidenceAgeMs) globalReasons.push("stale_window");
  }

  const rawCandidates = Array.isArray(record.candidates) ? record.candidates : [];
  if (!Array.isArray(record.candidates)) globalReasons.push("invalid_input");
  const reports: QualificationCandidateReport[] = [];
  for (const rawCandidate of rawCandidates) {
    reports.push(validateCandidate(rawCandidate, thresholds));
  }
  reports.sort((left, right) => {
    const leftKey = keyString(left.key);
    const rightKey = keyString(right.key);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  const keyCounts = new Map<string, number>();
  for (const report of reports) {
    const stableKey = keyString(report.key);
    keyCounts.set(stableKey, (keyCounts.get(stableKey) ?? 0) + 1);
  }
  for (const report of reports) {
    if ((keyCounts.get(keyString(report.key)) ?? 0) > 1) {
      report.reasons = sortedReasons([...report.reasons, "duplicate_candidate"]);
      report.diagnostic = "HOLD";
    }
  }
  const identityCounts = new Map<string, number>();
  for (const report of reports) {
    if (IDENTITY_FIELDS.every((field) => digest(report.identity[field]))) {
      const identityKey = IDENTITY_FIELDS.map((field) => report.identity[field]).join("\u001f");
      identityCounts.set(identityKey, (identityCounts.get(identityKey) ?? 0) + 1);
    }
  }
  for (const report of reports) {
    const identityKey = IDENTITY_FIELDS.map((field) => report.identity[field]).join("\u001f");
    if ((identityCounts.get(identityKey) ?? 0) > 1) {
      report.reasons = sortedReasons([...report.reasons, "duplicate_identity"]);
      report.diagnostic = "HOLD";
    }
  }
  const passing = reports.filter((report) => report.diagnostic === "PASS");
  if (passing.length > 1) globalReasons.push("multiple_passing_candidates");
  const hasGlobalHold = globalReasons.length > 0;
  const analysisVerdict = !hasGlobalHold && passing.length === 1 ? "GO" : "HOLD";
  const selected = analysisVerdict === "GO" ? passing[0]?.key ?? null : null;

  return {
    contract: M3_QUALIFICATION_CONTRACT,
    version: M3_QUALIFICATION_VERSION,
    evidenceBasis: "operator-supplied",
    evaluationAsOf: asOf,
    window,
    snapshot,
    thresholds: thresholds === null ? null : thresholdSummary(thresholds),
    candidates: reports,
    analysisVerdict,
    selectedCandidate: selected,
    reasons: sortedReasons(globalReasons),
    enablingDecision: null,
  };
}
