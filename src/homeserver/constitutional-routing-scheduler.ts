import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { canonicalJson, digestJson } from "./autonomy-contract-v1.js";
import type { AuthoritySnapshot, RouteMutationPlan } from "./constitutional-routing-controller.js";

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const ID = /^[a-z][a-z0-9-]{2,40}$/;

export interface RouteMutationProposal {
  schema_version: 1;
  proposal_id: string;
  candidate: string;
  target_scope_digest: string;
  config_digest: string;
  evidence_digest: string;
  policy_digest: string;
  postconditions_digest: string;
  content_ref: string;
  proposal_digest: string;
}

export function parseRouteMutationProposal(value: unknown): RouteMutationProposal {
  const keys = [
    "schema_version", "proposal_id", "candidate", "target_scope_digest",
    "config_digest", "evidence_digest", "policy_digest",
    "postconditions_digest", "content_ref",
    "proposal_digest",
  ];
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== keys.sort().join(",")
  ) throw new Error("invalid closed micro-routing proposal");
  const proposal = value as Record<string, unknown>;
  if (
    proposal.schema_version !== 1
    || typeof proposal.proposal_id !== "string"
    || !ID.test(proposal.proposal_id)
    || typeof proposal.candidate !== "string"
    || ![
      proposal.target_scope_digest,
      proposal.config_digest,
      proposal.evidence_digest,
      proposal.policy_digest,
      proposal.postconditions_digest,
    ].every((digest) => typeof digest === "string" && DIGEST.test(digest))
    || typeof proposal.content_ref !== "string"
    || !/^ref:[a-z][a-z0-9-]{2,120}$/.test(proposal.content_ref)
    || proposal.proposal_digest !== digestJson(proposal, "proposal_digest")
  ) throw new Error("invalid micro-routing proposal fields");
  return proposal as unknown as RouteMutationProposal;
}

export function composeImmutablePlan(
  proposal: RouteMutationProposal,
  baseline: string,
  authority: AuthoritySnapshot,
  nowIso: string,
  nonce = randomUUID().replaceAll("-", "").slice(0, 12),
): RouteMutationPlan {
  const start = Date.parse(nowIso);
  if (
    !Number.isFinite(start)
    || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(nowIso)
    || new Date(start).toISOString().replace(".000Z", "Z") !== nowIso
  ) throw new Error("scheduler requires exact-second trusted UTC time");
  if (proposal.candidate === baseline) throw new Error("proposal candidate already matches baseline");
  const prefix = proposal.proposal_id.slice(0, 28);
  const suffix = nonce.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12);
  const timestamp = (offsetSeconds: number) => new Date(start + offsetSeconds * 1000)
    .toISOString().replace(".000Z", "Z");
  return {
    mutationId: `${prefix}-mutation`,
    attemptId: `${prefix}-${suffix}`,
    recoveryDisarmId: `${prefix}-disarm`,
    idempotencyKey: `${prefix}-idempotent`,
    journalId: `${prefix}-journal`,
    baseline,
    candidate: proposal.candidate,
    targetScopeDigest: proposal.target_scope_digest,
    configDigest: proposal.config_digest,
    evidenceDigest: proposal.evidence_digest,
    policyDigest: proposal.policy_digest,
    postconditionsDigest: proposal.postconditions_digest,
    recoveryDescriptorDigest: digestJson(authority),
    // W0.1 permits a one-hour watch and a one-hour whole-operation
    // deadline. The controller timer attempts commit at this exact boundary;
    // if it misses, the independent watchdog recovers instead.
    deadline: timestamp(3600),
    // Keep five minutes of deterministic timer/restart margin while staying
    // within the constitutional one-hour maximum.
    watchDeadline: timestamp(3300),
    contentRef: proposal.content_ref,
  };
}

/** O_EXCL + fsync: a proposal can create one plan but cannot replace it. */
export function persistImmutablePlan(path: string, plan: RouteMutationPlan): "created" | "same" {
  const bytes = `${canonicalJson(plan)}\n`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o770 });
  if (existsSync(path)) {
    if (readFileSync(path, "utf8") !== bytes) throw new Error("immutable constitutional plan already exists with different bytes");
    return "same";
  }
  const fd = openSync(path, "wx", 0o440);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const directory = openSync(dirname(path), "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
  return "created";
}

/**
 * A never-started immutable plan is authority for one bounded time window, not
 * a permanent scheduler tombstone. Remove it only after its exact UTC deadline
 * has elapsed so the next timer can compose a fresh plan from the standing
 * proposal and current baseline.
 */
export function removeExpiredImmutablePlan(path: string, nowIso: string): boolean {
  if (!existsSync(path)) return false;
  const now = Date.parse(nowIso);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<RouteMutationPlan>;
  const deadline = typeof parsed.deadline === "string" ? Date.parse(parsed.deadline) : Number.NaN;
  if (
    !Number.isFinite(now)
    || !Number.isFinite(deadline)
    || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(nowIso)
    || typeof parsed.deadline !== "string"
    || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(parsed.deadline)
  ) throw new Error("immutable constitutional plan has invalid scheduler time");
  if (now < deadline) return false;
  unlinkSync(path);
  const directory = openSync(dirname(path), "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
  return true;
}
