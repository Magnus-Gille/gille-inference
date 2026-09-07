#!/usr/bin/env tsx

import { pathToFileURL } from "node:url";

import {
  collectServedProvenance,
  SERVED_PROVENANCE_REASON_CODES,
  servedProvenanceSchema,
  type Evidence,
  type EnvironmentSnapshot,
  type EffectiveConfiguration,
  type LaunchConfiguration,
  type ServedArtifact,
  type ServedProvenance,
  type ServedProvenanceBinding,
  type ServedProvenanceInput,
} from "../src/homeserver/served-provenance.js";
import {
  captureServedProcess,
  type ServedProcessProvenance,
} from "../src/homeserver/served-provenance-collector.js";

const ALIAS_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const GATEWAY_BUILD_PATTERN = /^[a-f0-9]{40}$/;

export const SERVED_PROVENANCE_ERROR_CODES = {
  invalidArguments: "PROVENANCE_INVALID_ARGUMENTS",
  internal: "PROVENANCE_INTERNAL_ERROR",
} as const;

export interface CaptureServedProvenanceArgs {
  readonly pid: number;
  readonly alias: string;
  readonly gatewayBuild: string | null;
}

class InvalidArgumentsError extends Error {}

function invalid(): never {
  throw new InvalidArgumentsError();
}

function positivePid(value: string): number {
  if (!/^\d+$/.test(value)) invalid();
  const pid = Number(value);
  if (!Number.isSafeInteger(pid) || pid <= 0) invalid();
  return pid;
}

/** Parse the deliberately small, strict public command line. */
export function parseCaptureServedProvenanceArgs(argv: readonly string[]): CaptureServedProvenanceArgs {
  const values = new Map<string, string>();
  const allowed = new Set(["--pid", "--alias", "--gateway-build"]);
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === undefined || !allowed.has(flag)) invalid();
    if (values.has(flag)) invalid();
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) invalid();
    values.set(flag, value);
    index++;
  }

  const pidValue = values.get("--pid");
  const alias = values.get("--alias");
  if (pidValue === undefined || alias === undefined || !ALIAS_PATTERN.test(alias)) invalid();

  const gatewayBuild = values.get("--gateway-build") ?? null;
  if (gatewayBuild !== null && !GATEWAY_BUILD_PATTERN.test(gatewayBuild)) invalid();
  return { pid: positivePid(pidValue), alias, gatewayBuild };
}

export const SERVED_PROVENANCE_HELP = `Usage: npm run provenance:served -- --pid POSITIVE --alias SAFE_ALIAS [--gateway-build 40lowerhex]

Capture one read-only, content-blind served-model provenance snapshot. Valid captures emit one JSON
snapshot to stdout. The snapshot may be incomplete; inspect completeness, freshness, reasons, and
evidence binding/source fields before use. Invalid arguments and internal failures use fixed error
codes on stderr. The command does not write files or make network, HTTP, MCP, or auth calls.`;

export interface CaptureServedProvenanceDependencies {
  readonly captureProcess?: (pid: number) => ServedProcessProvenance;
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
}

const DEFAULT_DEPENDENCIES: Required<CaptureServedProvenanceDependencies> = {
  captureProcess: captureServedProcess,
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
};

function bindingFor(observation: ServedProcessProvenance, binding: ServedProvenanceBinding): ServedProvenanceBinding {
  return observation.freshness === "stale" ? "stale" : binding;
}

function evidenceForHash(
  sha256: string | null,
  reason: "required-evidence-unknown" | "observation-unavailable" = "required-evidence-unknown",
): Evidence<string> {
  return sha256 === null
    ? { source: "unknown", reason }
    : { source: "observed", value: sha256 };
}

function artifactFor(
  observation: ServedProcessProvenance,
  sha256: string | null,
  binding: ServedProvenanceBinding = "unproven",
): ServedArtifact {
  return {
    contentSha256: evidenceForHash(sha256, observation.freshness === "unavailable" ? "observation-unavailable" : "required-evidence-unknown"),
    binding: bindingFor(observation, binding),
  };
}

const SAFE_OS_RELEASE = /^[A-Za-z0-9._-]{1,64}$/;
const SAFE_ARCH = /^[A-Za-z0-9._-]{1,32}$/;

function environmentForObservation(observation: ServedProcessProvenance): Evidence<EnvironmentSnapshot> {
  const { osRelease, arch, cpuCount, memoryBytes } = observation.environment;
  if (
    osRelease === null || !SAFE_OS_RELEASE.test(osRelease) ||
    arch === null || !SAFE_ARCH.test(arch) ||
    !Number.isSafeInteger(cpuCount) || cpuCount <= 0 ||
    !Number.isSafeInteger(memoryBytes) || memoryBytes <= 0
  ) {
    return {
      source: "unknown",
      reason: observation.freshness === "unavailable" ? "observation-unavailable" : "required-evidence-unknown",
    };
  }
  return {
    source: "observed",
    value: {
      os: osRelease,
      arch,
      cpuCount,
      memoryBytes,
      // The collector does not observe scheduler or cgroup ceilings. Null is an explicit
      // unknown, never an assertion of unlimited capacity.
      resourceCeilings: { cpuCount: null, memoryBytes: null },
    },
  };
}

function launchConfigurationForObservation(observation: ServedProcessProvenance): LaunchConfiguration {
  const launchUnavailable = observation.freshness === "unavailable"
    || observation.reasons.includes("launch-flag-ambiguous")
    || observation.reasons.includes("launch-flag-invalid");
  const value = (candidate: number | null): Evidence<number> => {
    // A missing argv flag does not prove the runtime default. An unavailable, ambiguous, or
    // invalid launch observation cannot establish any launch value either.
    if (launchUnavailable || candidate === null) {
      return { source: "unknown", reason: observation.freshness === "unavailable" ? "observation-unavailable" : "required-evidence-unknown" };
    }
    return { source: "observed", value: candidate };
  };
  return {
    contextSize: value(observation.launchFlags.contextSize),
    parallelism: value(observation.launchFlags.parallelism),
    temperature: value(observation.launchFlags.temperature),
    topP: value(observation.launchFlags.topP),
    topK: value(observation.launchFlags.topK),
    minP: value(observation.launchFlags.minP),
    predictLimit: value(observation.launchFlags.predictLimit),
  };
}

function inputFromObservation(
  args: CaptureServedProvenanceArgs,
  observation: ServedProcessProvenance,
): ServedProvenanceInput {
  const gatewayBuild = args.gatewayBuild === null
    ? { source: "unknown" as const, reason: "required-evidence-unknown" as const }
    : { source: "operator-declared" as const, value: args.gatewayBuild };
  const projector = "kind" in observation.projector && observation.projector.kind === "not-applicable"
    ? { kind: "not-applicable" as const }
    : "sha256" in observation.projector
      ? artifactFor(observation, observation.projector.sha256, observation.projector.binding)
      : { kind: "unknown" as const, reason: "required-evidence-unknown" as const };
  const unknownNumber = <T>(): Evidence<T> => ({ source: "unknown", reason: "required-evidence-unknown" });
  const effectiveConfiguration: EffectiveConfiguration = {
    contextTokens: unknownNumber<number>(),
    defaults: {
      maxTokens: unknownNumber<number>(),
      temperature: unknownNumber<number>(),
      topP: unknownNumber<number | null>(),
      topK: unknownNumber<number | null>(),
      minP: unknownNumber<number | null>(),
    },
    limits: {
      maxTokens: unknownNumber<number>(),
      maxInputTokens: unknownNumber<number | null>(),
      maxOutputTokens: unknownNumber<number | null>(),
    },
  };

  return {
    modelAlias: args.alias,
    observedAt: observation.capturedAt,
    freshness: observation.freshness,
    artifacts: {
      weights: observation.weights.map((weight) => artifactFor(observation, weight.sha256, weight.binding)),
      projector,
      runtimeBinary: artifactFor(observation, observation.runtimeSha256),
      // This is never observed by the process collector. A supplied value remains a declaration.
      gatewayBuild: {
        sha: gatewayBuild,
        binding: bindingFor(observation, "unproven"),
      },
    },
    identities: {
      quantization: { source: "unknown", reason: "required-evidence-unknown" },
      tokenizer: { source: "unknown", reason: "required-evidence-unknown" },
      chatTemplate: { source: "unknown", reason: "required-evidence-unknown" },
    },
    // Launch flags remain separate from effective runtime defaults and limits; process argv is not
    // proof of the runtime's effective configuration, so every effective field stays unknown.
    effectiveConfiguration,
    launchConfiguration: launchConfigurationForObservation(observation),
    environment: environmentForObservation(observation),
  };
}

export function snapshotFromObservation(
  args: CaptureServedProvenanceArgs,
  observation: ServedProcessProvenance,
): ServedProvenance {
  const snapshot = collectServedProvenance(inputFromObservation(args, observation));
  // The schema owns the closed reason allowlist. Preserve collector distinctions when the
  // coordinated schema exposes them, while silently dropping no unrecognized diagnostic text.
  const allowedReasons = new Set<string>(SERVED_PROVENANCE_REASON_CODES);
  const reasons = [...new Set([
    ...snapshot.reasons,
    ...observation.reasons.filter((reason) => allowedReasons.has(reason)),
  ])];
  return servedProvenanceSchema.parse({ ...snapshot, reasons });
}

export function runCaptureServedProvenance(
  argv: readonly string[],
  dependencies: CaptureServedProvenanceDependencies = {},
): number {
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  if (argv.length === 1 && argv[0] === "--help") {
    deps.stdout(SERVED_PROVENANCE_HELP);
    return 0;
  }

  let args: CaptureServedProvenanceArgs;
  try {
    args = parseCaptureServedProvenanceArgs(argv);
  } catch (error) {
    if (error instanceof InvalidArgumentsError) {
      deps.stderr(SERVED_PROVENANCE_ERROR_CODES.invalidArguments);
      return 1;
    }
    deps.stderr(SERVED_PROVENANCE_ERROR_CODES.internal);
    return 1;
  }

  try {
    const observation = deps.captureProcess(args.pid);
    const snapshot = snapshotFromObservation(args, observation);
    deps.stdout(JSON.stringify(snapshot));
    return 0;
  } catch {
    deps.stderr(SERVED_PROVENANCE_ERROR_CODES.internal);
    return 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runCaptureServedProvenance(process.argv.slice(2));
}
