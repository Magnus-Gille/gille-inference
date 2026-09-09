import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync, statSync } from "node:fs";
import {
  evaluateM3Qualification,
  evaluateM3FirstCanaryQualification,
  M3_FIRST_CANARY_CONTRACT,
  M3_FIRST_CANARY_VERSION,
  M3_QUALIFICATION_CONTRACT,
  M3_QUALIFICATION_VERSION,
  type M3FirstCanaryInput,
  type M3QualificationInput,
} from "../src/homeserver/m3-qualification.js";

const MAX_INPUT_BYTES = 1024 * 1024;
const USAGE = "Usage: npx tsx scripts/qualify-m3.ts --input <path>";
const TOP_LEVEL_KEYS = new Set([
  "contract",
  "version",
  "evaluation",
  "window",
  "snapshot",
  "thresholds",
  "candidates",
]);
const FIRST_CANARY_TOP_LEVEL_KEYS = new Set([
  "contract",
  "version",
  "mode",
  "costDeferral",
  "evaluation",
  "window",
  "snapshot",
  "thresholds",
  "candidates",
]);
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasString(record: RecordValue, key: string): boolean {
  return typeof record[key] === "string";
}

function isQualificationV1Input(value: unknown): value is M3QualificationInput {
  if (!isRecord(value)) return false;
  if (![...Object.keys(value)].every((key) => TOP_LEVEL_KEYS.has(key))) return false;
  if (value.contract !== M3_QUALIFICATION_CONTRACT || value.version !== M3_QUALIFICATION_VERSION) return false;

  const evaluation = value.evaluation;
  const window = value.window;
  const snapshot = value.snapshot;
  const thresholds = value.thresholds;
  const candidates = value.candidates;
  if (!isRecord(evaluation) || !hasString(evaluation, "asOf")) return false;
  if (!isRecord(window) || !hasString(window, "start") || !hasString(window, "end")) return false;
  if (
    !isRecord(snapshot) ||
    !hasString(snapshot, "sha256") ||
    typeof snapshot.immutable !== "boolean" ||
    !hasString(snapshot, "observedAt")
  ) {
    return false;
  }
  if (thresholds !== null && !isRecord(thresholds)) return false;
  return Array.isArray(candidates) && candidates.every(isRecord);
}

function isFirstCanaryInput(value: unknown): value is M3FirstCanaryInput {
  if (!isRecord(value)) return false;
  if (![...Object.keys(value)].every((key) => FIRST_CANARY_TOP_LEVEL_KEYS.has(key))) return false;
  if (value.contract !== M3_FIRST_CANARY_CONTRACT || value.version !== M3_FIRST_CANARY_VERSION) return false;
  if (value.mode !== "cost-unassessed") return false;
  const costDeferral = value.costDeferral;
  if (
    !isRecord(costDeferral) ||
    Object.keys(costDeferral).some((key) => !["reason", "followUp"].includes(key)) ||
    !hasString(costDeferral, "reason") ||
    !TOKEN_RE.test(costDeferral.reason) ||
    costDeferral.followUp !== "issue-82"
  ) return false;

  const evaluation = value.evaluation;
  const window = value.window;
  const snapshot = value.snapshot;
  const thresholds = value.thresholds;
  const candidates = value.candidates;
  if (!isRecord(evaluation) || !hasString(evaluation, "asOf")) return false;
  if (!isRecord(window) || !hasString(window, "start") || !hasString(window, "end")) return false;
  if (
    !isRecord(snapshot) ||
    !hasString(snapshot, "sha256") ||
    typeof snapshot.immutable !== "boolean" ||
    !hasString(snapshot, "observedAt")
  ) return false;
  if (thresholds !== null && !isRecord(thresholds)) return false;
  return Array.isArray(candidates) && candidates.every(isRecord);
}

function parseArguments(args: string[]): { inputPath: string } | { help: true } | null {
  if (args.length === 1 && args[0] === "--help") return { help: true };
  if (
    args.length !== 2 ||
    args[0] !== "--input" ||
    args[1] === undefined ||
    args[1].length === 0 ||
    args[1].startsWith("-")
  ) {
    return null;
  }
  return { inputPath: args[1] };
}

function writeError(code: string): number {
  process.stderr.write(`${code}\n`);
  return 1;
}

function readBoundedFile(path: string): Buffer | string {
  try {
    if (!statSync(path).isFile()) return "E_INPUT_READ";
  } catch {
    return "E_INPUT_READ";
  }

  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    if (!fstatSync(descriptor).isFile()) return "E_INPUT_READ";

    const buffer = Buffer.allocUnsafe(MAX_INPUT_BYTES + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const bytesRead = readSync(descriptor, buffer, offset, buffer.byteLength - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return buffer.subarray(0, offset);
  } catch {
    return "E_INPUT_READ";
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // The read result already has a fixed error category; do not expose close details.
      }
    }
  }
}

function run(args: string[]): number {
  const parsed = parseArguments(args);
  if (parsed === null) {
    process.stderr.write("E_USAGE\n");
    return 2;
  }
  if ("help" in parsed) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const readResult = readBoundedFile(parsed.inputPath);
  if (typeof readResult === "string") return writeError(readResult);
  const inputBytes = readResult;
  if (inputBytes.byteLength > MAX_INPUT_BYTES) return writeError("E_INPUT_TOO_LARGE");

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(inputBytes.toString("utf8")) as unknown;
  } catch {
    return writeError("E_INPUT_JSON");
  }
  const v1 = isQualificationV1Input(parsedJson);
  const v2 = isFirstCanaryInput(parsedJson);
  if (!v1 && !v2) return writeError("E_INPUT_SCHEMA");

  let report: ReturnType<typeof evaluateM3Qualification> | ReturnType<typeof evaluateM3FirstCanaryQualification>;
  try {
    report = v2
      ? evaluateM3FirstCanaryQualification(parsedJson)
      : evaluateM3Qualification(parsedJson);
  } catch {
    return writeError("E_EVALUATION");
  }

  const inputSha256 = createHash("sha256").update(inputBytes).digest("hex");
  process.stdout.write(`${JSON.stringify({ inputSha256, report })}\n`);
  return 0;
}

process.exitCode = run(process.argv.slice(2));
