/**
 * Pure, content-blind summarization of the bounded Halogen pilot evidence.
 *
 * This module only evaluates supplied rows. It does not inspect a runner or establish production
 * qualification. The profile digest binds the model/runtime fields used to produce each row.
 */

export const HALOGEN_PILOT_REPETITIONS = [1, 2, 3] as const;
export const HALOGEN_PILOT_TEN_MINUTES_MS = 10 * 60 * 1_000;
export const HALOGEN_PILOT_CEILING_MS = 45 * 60 * 1_000;

export type HalogenPilotStatus = "hold" | "pilot-qualified";

export const HALOGEN_PILOT_REASON_CODES = [
  "invalid_input", "invalid_expected_task_ids", "invalid_row", "duplicate_row", "missing_row",
  "unexpected_row", "invalid_repetition", "invalid_profile_sha256", "mixed_profile_sha256",
  "invalid_runner_commit", "mixed_runner_commit", "checks_failed", "exit_not_pass", "timed_out",
  "disallowed_paths", "finish_not_stop", "wall_invalid", "wall_exceeds_ceiling",
  "first_edit_missing", "first_edit_invalid",
] as const;
export type HalogenPilotReasonCode = (typeof HALOGEN_PILOT_REASON_CODES)[number];

export interface HalogenPilotRow {
  id: string;
  task: string;
  repetition: number;
  pass: boolean;
  checksPassed: number;
  checksTotal: number;
  timedOut: boolean;
  exitClass: string;
  disallowedPathCount: number;
  wallMs: number;
  firstEditMs: number | null;
  finishReason: string | null;
  /** SHA-256 of the immutable model/runtime profile. */
  profileSha256: string;
  /** Full Git SHA for the runner that emitted this row. */
  runnerCommit: string;
}

export interface HalogenPilotSummary {
  /** Diagnostic supplied-evidence result; this never enables production routing. */
  status: HalogenPilotStatus;
  reasons: HalogenPilotReasonCode[];
  profileSha256: string | null;
  runnerCommit: string | null;
  rowCount: number;
  completedByTenMinutes: number;
  completedByCeiling: number;
}

type RecordLike = Record<string, unknown>;

function isRecord(value: unknown): value is RecordLike {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isToken(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isSafeNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isCommitSha(value: unknown): value is string {
  return typeof value === "string" && value.length === 40 && value === value.toLowerCase() && [...value].every((character) => "0123456789abcdef".includes(character));
}

function parseRow(value: unknown): HalogenPilotRow | null {
  if (!isRecord(value) || !isToken(value.id) || !isToken(value.task)) return null;
  if (!isSafeNonnegativeInteger(value.repetition)
    || !HALOGEN_PILOT_REPETITIONS.includes(value.repetition as 1 | 2 | 3)) return null;
  if (typeof value.pass !== "boolean" || typeof value.timedOut !== "boolean") return null;
  if (!isSafeNonnegativeInteger(value.checksPassed) || !isSafeNonnegativeInteger(value.checksTotal)
    || value.checksPassed > value.checksTotal) return null;
  if (!isToken(value.exitClass) || !isSafeNonnegativeInteger(value.disallowedPathCount)) return null;
  if (!isFiniteNumber(value.wallMs)) return null;
  if (value.firstEditMs !== null && !isFiniteNumber(value.firstEditMs)) return null;
  if (value.finishReason !== null && !isToken(value.finishReason)) return null;
  if (typeof value.profileSha256 !== "string" || typeof value.runnerCommit !== "string") return null;
  return value as unknown as HalogenPilotRow;
}

function isCompleted(row: HalogenPilotRow, limitMs: number): boolean {
  return row.pass === true && row.checksTotal > 0 && row.checksPassed === row.checksTotal
    && row.exitClass === "pass" && row.timedOut === false && row.finishReason === "stop"
    && row.disallowedPathCount === 0 && row.firstEditMs !== null
    && Number.isFinite(row.firstEditMs) && row.firstEditMs >= 0
    && Number.isFinite(row.wallMs) && row.wallMs > 0 && row.firstEditMs <= row.wallMs
    && row.wallMs <= limitMs;
}

function sortedReasons(reasons: Set<HalogenPilotReasonCode>): HalogenPilotReasonCode[] {
  return [...reasons].sort();
}

/**
 * Summarize exactly three repetitions of exactly three expected tasks.
 * Every malformed input path returns HOLD. A pilot-qualified result is only supplied pilot
 * evidence and is deliberately not a production qualification receipt.
 */
export function summarizeHalogenPilot(rows: unknown, expectedTaskIds: unknown): HalogenPilotSummary {
  const reasons = new Set<HalogenPilotReasonCode>();
  const expected = Array.isArray(expectedTaskIds) && expectedTaskIds.every(isToken)
    ? expectedTaskIds as string[] : null;
  if (expected === null || expected.length !== 3 || new Set(expected).size !== expected.length) {
    reasons.add("invalid_expected_task_ids");
  }

  const rawRows = Array.isArray(rows) ? rows : null;
  if (rawRows === null) reasons.add("invalid_input");
  const parsedRows: HalogenPilotRow[] = [];
  for (const rawRow of rawRows ?? []) {
    const row = parseRow(rawRow);
    if (row === null) reasons.add("invalid_row");
    else parsedRows.push(row);
  }

  const ids = new Set<string>();
  const slots = new Map<string, number>();
  const expectedSet = expected === null ? null : new Set(expected);
  for (const row of parsedRows) {
    if (ids.has(row.id)) reasons.add("duplicate_row");
    ids.add(row.id);
    const slot = row.task + "\u0000" + row.repetition;
    const count = (slots.get(slot) ?? 0) + 1;
    slots.set(slot, count);
    if (count > 1) reasons.add("duplicate_row");
    if (expectedSet !== null && !expectedSet.has(row.task)) reasons.add("unexpected_row");
    if (!HALOGEN_PILOT_REPETITIONS.includes(row.repetition as 1 | 2 | 3)) reasons.add("invalid_repetition");
  }
  if (expectedSet !== null) {
    for (const task of expectedSet) {
      for (const repetition of HALOGEN_PILOT_REPETITIONS) {
        if (!slots.has(task + "\u0000" + repetition)) reasons.add("missing_row");
      }
    }
  }

  const profiles = new Set<string>();
  const commits = new Set<string>();
  for (const row of parsedRows) {
    if (!isSha256(row.profileSha256)) reasons.add("invalid_profile_sha256");
    else profiles.add(row.profileSha256);
    if (!isCommitSha(row.runnerCommit)) reasons.add("invalid_runner_commit");
    else commits.add(row.runnerCommit);

    if (row.pass !== true || row.checksTotal <= 0 || row.checksPassed !== row.checksTotal) reasons.add("checks_failed");
    if (row.exitClass !== "pass") reasons.add("exit_not_pass");
    if (row.timedOut) reasons.add("timed_out");
    if (row.disallowedPathCount !== 0) reasons.add("disallowed_paths");
    if (row.finishReason !== "stop") reasons.add("finish_not_stop");
    if (!Number.isFinite(row.wallMs) || row.wallMs <= 0) reasons.add("wall_invalid");
    else if (row.wallMs > HALOGEN_PILOT_CEILING_MS) reasons.add("wall_exceeds_ceiling");
    if (row.firstEditMs === null) reasons.add("first_edit_missing");
    else if (!Number.isFinite(row.firstEditMs) || row.firstEditMs < 0 || row.firstEditMs > row.wallMs) reasons.add("first_edit_invalid");
  }
  if (profiles.size > 1) reasons.add("mixed_profile_sha256");
  if (commits.size > 1) reasons.add("mixed_runner_commit");

  const completedByTenMinutes = parsedRows.filter((row) => isCompleted(row, HALOGEN_PILOT_TEN_MINUTES_MS)).length;
  const completedByCeiling = parsedRows.filter((row) => isCompleted(row, HALOGEN_PILOT_CEILING_MS)).length;
  const completeMatrix = expected !== null
    && parsedRows.length === expected.length * HALOGEN_PILOT_REPETITIONS.length
    && reasons.size === 0;

  return {
    status: completeMatrix ? "pilot-qualified" : "hold",
    reasons: sortedReasons(reasons),
    profileSha256: profiles.size === 1 ? [...profiles][0]! : null,
    runnerCommit: commits.size === 1 ? [...commits][0]! : null,
    rowCount: parsedRows.length,
    completedByTenMinutes,
    completedByCeiling,
  };
}
