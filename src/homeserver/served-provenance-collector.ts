/**
 * Read-only, process-local provenance for one already-running llama-server.
 *
 * This module deliberately observes process state.  It never talks to the HTTP API, starts a
 * runtime, loads a model, or treats a checksum as proof that those bytes were loaded into GPU
 * memory.  The latter is why every stable artifact observation is marked `unproven`.
 */
import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  readlinkSync,
  readdirSync,
  statSync,
} from "node:fs";
import { arch, cpus, release as kernelRelease, totalmem } from "node:os";
import { basename, dirname, join, posix, resolve } from "node:path";

export const SERVED_PROVENANCE_REASONS = [
  "pid-invalid",
  "process-unavailable",
  "process-not-llama-server",
  "proc-stat-unavailable",
  "proc-cmdline-unavailable",
  "proc-exe-unavailable",
  "process-view-unavailable",
  "process-view-changed",
  "process-identity-changed",
  "cmdline-changed",
  "executable-changed",
  "model-flag-missing",
  "model-flag-ambiguous",
  "projector-flag-ambiguous",
  "artifact-path-unavailable",
  "artifact-remote",
  "artifact-missing",
  "artifact-not-regular",
  "artifact-hash-failed",
  "artifact-changed",
  "artifact-shards-unavailable",
  "unsupported-model-loader-feature",
  "runtime-unavailable",
  "runtime-changed",
  "launch-flag-ambiguous",
  "launch-flag-invalid",
  "environment-unavailable",
] as const;

export type ServedProvenanceReason = (typeof SERVED_PROVENANCE_REASONS)[number];
export type ServedProvenanceFreshness = "fresh" | "stale" | "unavailable";
export type ServedArtifactBinding = "unproven" | "stale";

export interface ServedArtifactObservation {
  sha256: string | null;
  binding: ServedArtifactBinding;
}

export type ServedProjectorObservation =
  | ServedArtifactObservation
  | { kind: "unknown" }
  | { kind: "not-applicable" };

export interface ServedLaunchFlags {
  contextSize: number | null;
  parallelism: number | null;
  temperature: number | null;
  topP: number | null;
  topK: number | null;
  minP: number | null;
  predictLimit: number | null;
}

export interface ServedEnvironmentObservation {
  osRelease: string | null;
  arch: string | null;
  cpuCount: number | null;
  memoryBytes: number | null;
}

export interface ServedProcessProvenance {
  capturedAt: string;
  freshness: ServedProvenanceFreshness;
  reasons: ServedProvenanceReason[];
  weights: ServedArtifactObservation[];
  projector: ServedProjectorObservation;
  runtimeSha256: string | null;
  launchFlags: ServedLaunchFlags;
  environment: ServedEnvironmentObservation;
}

/** The small metadata subset needed to detect path/inode changes around one hash. */
export interface ServedArtifactStat {
  dev: string;
  ino: string;
  mode: string;
  size: number;
  mtimeNs: string;
  ctimeNs: string;
}

/**
 * Injectable reads keep the collector deterministic on macOS and in unit tests.  The default
 * implementation is Linux `/proc`; no dependency is allowed to return raw process data in the
 * collector result.
 */
export interface ServedProvenanceCollectorDeps {
  now?: () => string;
  readProcStat?: (pid: number) => string;
  readProcCmdline?: (pid: number) => Buffer | string[];
  readProcExe?: (pid: number) => string;
  /** Path in the target process view used to hash the executable (usually /proc/PID/exe). */
  readProcExePath?: (pid: number) => string;
  readProcCwd?: (pid: number) => string;
  readProcRoot?: (pid: number) => string;
  readProcMountNamespace?: (pid: number) => string;
  readSelfMountNamespace?: () => string;
  readProcRootIdentity?: (pid: number) => ServedArtifactStat;
  readSelfRootIdentity?: () => ServedArtifactStat;
  readArtifactStat?: (path: string) => ServedArtifactStat;
  hashArtifact?: (path: string, expectedPathStat?: ServedArtifactStat) => string;
  listArtifactDirectory?: (path: string) => string[];
  readKernelRelease?: () => string;
  getArch?: () => string;
  getCpuCount?: () => number;
  getMemoryBytes?: () => number;
}

interface ProcessSnapshot {
  startTime: string;
  cmdline: string[];
  cmdlineBytes: string;
  exe: string;
}

interface HashObservation {
  sha256: string | null;
  changed: boolean;
  unavailable: boolean;
}

interface ParsedArgs {
  model: string | null;
  modelCount: number;
  projector: string | null;
  projectorCount: number;
  artifactInvalid: boolean;
  unsupported: boolean;
  remoteArtifact: boolean;
  splitModel: boolean;
  launchFlags: ServedLaunchFlags;
  launchAmbiguous: boolean;
  launchInvalid: boolean;
}

interface ArtifactFsStat {
  dev: bigint | number;
  ino: bigint | number;
  mode: bigint | number;
  size: bigint | number;
  mtimeNs?: bigint | number;
  ctimeNs?: bigint | number;
  isFile?: () => boolean;
}

const MODEL_FLAGS = new Set(["-m", "--model"]);
const PROJECTOR_FLAGS = new Set(["--mmproj"]);
const CONTEXT_FLAGS = new Set(["-c", "--ctx-size", "--context-size"]);
const PARALLEL_FLAGS = new Set(["-np", "--parallel", "--parallelism"]);
const TEMPERATURE_FLAGS = new Set(["--temp", "--temperature"]);
const TOP_P_FLAGS = new Set(["--top-p"]);
const TOP_K_FLAGS = new Set(["--top-k"]);
const MIN_P_FLAGS = new Set(["--min-p"]);
const PREDICT_FLAGS = new Set(["-n", "--n-predict", "--predict"]);

// These flags select additional or remotely resolved weights.  We intentionally do not attempt
// to recover their values: the resulting artifact set would otherwise look complete when it is
// not.
const UNSUPPORTED_MODEL_FLAGS = new Set([
  "-mu",
  "--model-url",
  "--mmproj-url",
  "-hf",
  "-hfr",
  "--hf-repo",
  "--hf-file",
  "--model-repo",
  "-dr",
  "--docker-repo",
  "--model-draft",
  "--draft-model",
  "-md",
  "--draft",
  "--lora",
  "--lora-scaled",
  "--adapter",
  "--adapter-file",
  "--control-vector",
  "--control-vector-scaled",
  "--model-split",
  "--split-model",
]);

const ALL_VALUE_FLAGS = new Set([
  ...MODEL_FLAGS,
  ...PROJECTOR_FLAGS,
  ...CONTEXT_FLAGS,
  ...PARALLEL_FLAGS,
  ...TEMPERATURE_FLAGS,
  ...TOP_P_FLAGS,
  ...TOP_K_FLAGS,
  ...MIN_P_FLAGS,
  ...PREDICT_FLAGS,
  ...UNSUPPORTED_MODEL_FLAGS,
]);

const DEFAULT_DEPS: Required<Pick<
  ServedProvenanceCollectorDeps,
  "readProcStat" | "readProcCmdline" | "readProcExe" | "readProcExePath" | "readProcCwd" | "readProcRoot" |
  "readProcMountNamespace" | "readSelfMountNamespace" | "readProcRootIdentity" | "readSelfRootIdentity" |
  "readArtifactStat" | "hashArtifact" | "listArtifactDirectory" | "readKernelRelease" |
  "getArch" | "getCpuCount" | "getMemoryBytes"
>> = {
  readProcStat: (pid) => readFileSync(`/proc/${pid}/stat`, "utf8"),
  readProcCmdline: (pid) => readFileSync(`/proc/${pid}/cmdline`),
  readProcExe: (pid) => readlinkSync(`/proc/${pid}/exe`, "utf8"),
  readProcCwd: (pid) => `/proc/${pid}/cwd`,
  readProcRoot: (pid) => `/proc/${pid}/root`,
  readProcExePath: (pid) => `/proc/${pid}/exe`,
  readProcMountNamespace: (pid) => readlinkSync(`/proc/${pid}/ns/mnt`, "utf8"),
  readSelfMountNamespace: () => readlinkSync("/proc/self/ns/mnt", "utf8"),
  readProcRootIdentity: (pid) => artifactStat(statSync(`/proc/${pid}/root`, { bigint: true })),
  readSelfRootIdentity: () => artifactStat(statSync("/", { bigint: true })),
  readArtifactStat: (path) => artifactStat(statSync(path, { bigint: true })),
  hashArtifact: (path, expected) => hashArtifactFromReadOnlyFd(path, expected,
    /^\/proc\/\d+\/exe$/.test(path)),
  listArtifactDirectory: (path) => readdirSync(path),
  readKernelRelease: kernelRelease,
  getArch: arch,
  getCpuCount: () => cpus().length,
  getMemoryBytes: totalmem,
};

function mergedDeps(deps: ServedProvenanceCollectorDeps): typeof DEFAULT_DEPS & ServedProvenanceCollectorDeps {
  return { ...DEFAULT_DEPS, ...deps };
}

function asSafePid(pid: number): boolean {
  return Number.isSafeInteger(pid) && pid > 0;
}

function cleanReasons(reasons: ServedProvenanceReason[]): ServedProvenanceReason[] {
  return [...new Set(reasons)].sort();
}

function safeCapturedAt(now: (() => string) | undefined): string {
  try {
    const value = now?.() ?? new Date().toISOString();
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? new Date(0).toISOString() : parsed.toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

function emptyLaunchFlags(): ServedLaunchFlags {
  return {
    contextSize: null,
    parallelism: null,
    temperature: null,
    topP: null,
    topK: null,
    minP: null,
    predictLimit: null,
  };
}

function emptyEnvironment(): ServedEnvironmentObservation {
  return { osRelease: null, arch: null, cpuCount: null, memoryBytes: null };
}

function artifactStat(stat: ArtifactFsStat): ServedArtifactStat {
  const bigintValue = (value: bigint | number | undefined): string => {
    if (typeof value === "bigint") return value.toString(10);
    return typeof value === "number" && Number.isFinite(value) ? String(value) : "unknown";
  };
  return {
    dev: bigintValue(stat.dev),
    ino: bigintValue(stat.ino),
    mode: stat.mode.toString(8),
    size: typeof stat.size === "bigint"
      ? (stat.size <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(stat.size) : -1)
      : Number.isSafeInteger(stat.size) ? stat.size : -1,
    mtimeNs: bigintValue(stat.mtimeNs),
    ctimeNs: bigintValue(stat.ctimeNs),
  };
}

function sameStat(left: ServedArtifactStat, right: ServedArtifactStat): boolean {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs;
}

function isRegular(stat: ServedArtifactStat): boolean {
  // The S_IFREG type bits are portable across the supported Node platforms.
  return (Number.parseInt(stat.mode, 8) & 0o170000) === 0o100000;
}

function hashArtifactFromReadOnlyFd(path: string, expectedPathStat?: ServedArtifactStat, followSymlink = false): string {
  let fd: number | undefined;
  try {
    const noFollow = followSymlink ? 0 : fsConstants.O_NOFOLLOW;
    fd = openSync(path, fsConstants.O_RDONLY | noFollow | fsConstants.O_NONBLOCK);
    const before = artifactStat(fstatSync(fd, { bigint: true }));
    if (!isRegular(before) || before.size <= 0) throw new Error("not a regular non-empty file");
    if (expectedPathStat !== undefined && !sameStat(expectedPathStat, before)) {
      throw Object.assign(new Error("artifact identity changed before reading"), { code: "ARTIFACT_CHANGED" });
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    while (true) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
    const after = artifactStat(fstatSync(fd, { bigint: true }));
    if (!sameStat(before, after)) {
      throw Object.assign(new Error("artifact changed while reading"), { code: "ARTIFACT_CHANGED" });
    }
    return hash.digest("hex");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function parseStartTime(stat: string): string | null {
  const close = stat.lastIndexOf(")");
  if (close < 0) return null;
  const fields = stat.slice(close + 1).trim().split(/\s+/);
  // The remainder starts at field 3 (state); starttime is field 22, index 19 here.
  const startTime = fields[19];
  return startTime && /^\d+$/.test(startTime) ? startTime : null;
}

function normalizeCmdline(raw: Buffer | string[]): { values: string[]; bytes: string } {
  if (Array.isArray(raw)) {
    const values = raw.map((value) => String(value));
    return { values, bytes: values.join("\0") };
  }
  const values = raw.toString("utf8").split("\0");
  if (values.at(-1) === "") values.pop();
  return { values, bytes: raw.toString("base64") };
}

function readSnapshot(pid: number, deps: ReturnType<typeof mergedDeps>): ProcessSnapshot {
  const rawStat = deps.readProcStat(pid);
  const startTime = parseStartTime(rawStat);
  if (startTime === null) throw new Error("invalid process stat");
  const normalized = normalizeCmdline(deps.readProcCmdline(pid));
  if (normalized.values.length === 0) throw new Error("empty process command line");
  const exe = deps.readProcExe(pid).trim();
  if (!exe) throw new Error("empty process executable");
  return { startTime, cmdline: normalized.values, cmdlineBytes: normalized.bytes, exe };
}

function executableIsLlamaServer(exe: string): boolean {
  const leaf = basename(exe).replace(/\s+\(deleted\)$/, "");
  return leaf === "llama-server";
}

function splitInlineFlag(token: string): { flag: string; value: string } | null {
  const separator = token.indexOf("=");
  if (separator <= 0) return null;
  const flag = token.slice(0, separator);
  if (!ALL_VALUE_FLAGS.has(flag)) return null;
  return { flag, value: token.slice(separator + 1) };
}

function isRemoteArtifact(value: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:|https?:\/\/)/i.test(value) || value.startsWith("//");
}

function finiteNumber(raw: string): number | null {
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags = emptyLaunchFlags();
  const counts = new Map<string, number>();
  const values = new Map<string, string>();
  let unsupported = false;
  let remoteArtifact = false;
  let splitModel = false;
  let artifactInvalid = false;
  let launchAmbiguous = false;
  let launchInvalid = false;

  const canonical = (flag: string): string => {
    if (MODEL_FLAGS.has(flag)) return "model";
    if (PROJECTOR_FLAGS.has(flag)) return "projector";
    if (CONTEXT_FLAGS.has(flag)) return "contextSize";
    if (PARALLEL_FLAGS.has(flag)) return "parallelism";
    if (TEMPERATURE_FLAGS.has(flag)) return "temperature";
    if (TOP_P_FLAGS.has(flag)) return "topP";
    if (TOP_K_FLAGS.has(flag)) return "topK";
    if (MIN_P_FLAGS.has(flag)) return "minP";
    if (PREDICT_FLAGS.has(flag)) return "predictLimit";
    return flag;
  };

  for (let index = 1; index < argv.length; index++) {
    const token = argv[index]!;
    const inline = splitInlineFlag(token);
    const rawFlag = inline?.flag ?? token;
    if (isUnsupportedModelFlag(rawFlag)) {
      unsupported = true;
      if (rawFlag === "--model-split" || rawFlag === "--split-model") splitModel = true;
      const candidate = inline?.value ?? argv[index + 1];
      if (candidate !== undefined && isRemoteArtifact(candidate)) remoteArtifact = true;
      if (inline === null && index + 1 < argv.length && !argv[index + 1]!.startsWith("-")) index++;
      continue;
    }
    const knownValueFlag = ALL_VALUE_FLAGS.has(rawFlag);
    if (!knownValueFlag) {
      continue;
    }

    const key = canonical(rawFlag);
    let value = inline?.value;
    if (value === undefined) {
      value = argv[index + 1];
      const numericValue = value !== undefined && finiteNumber(value) !== null;
      if (value === undefined || (value.startsWith("-") && !isRemoteArtifact(value) &&
        !((CONTEXT_FLAGS.has(rawFlag) || PARALLEL_FLAGS.has(rawFlag) || TEMPERATURE_FLAGS.has(rawFlag) ||
          TOP_P_FLAGS.has(rawFlag) || TOP_K_FLAGS.has(rawFlag) || MIN_P_FLAGS.has(rawFlag) ||
          PREDICT_FLAGS.has(rawFlag)) && numericValue))) {
        if (key === "model" || key === "projector") {
          artifactInvalid = true;
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        if (key !== "model" && key !== "projector") launchInvalid = true;
        continue;
      }
      index++;
    }
    if (value === "") {
      if (key === "model" || key === "projector") {
        artifactInvalid = true;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      else launchInvalid = true;
      continue;
    }

    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    if (key === "model" || key === "projector") {
      if (isRemoteArtifact(value)) remoteArtifact = true;
      if (key === "model" && /-\d{5}-of-\d{5}(?:\.[^/]*)?$/i.test(posix.basename(value))) splitModel = true;
      if (!values.has(key)) values.set(key, value);
      continue;
    }
    const parsed = finiteNumber(value);
    if (parsed === null) {
      launchInvalid = true;
      continue;
    }
    const outputKey = key as keyof ServedLaunchFlags;
    if (count > 1) {
      launchAmbiguous = true;
      flags[outputKey] = null;
    } else {
      flags[outputKey] = parsed;
    }
  }

  return {
    model: values.get("model") ?? null,
    modelCount: counts.get("model") ?? 0,
    projector: values.get("projector") ?? null,
    projectorCount: counts.get("projector") ?? 0,
    artifactInvalid,
    unsupported,
    remoteArtifact,
    splitModel,
    launchFlags: flags,
    launchAmbiguous,
    launchInvalid,
  };
}

function isUnsupportedModelFlag(flag: string): boolean {
  if (!flag.startsWith("-")) return false;
  if (UNSUPPORTED_MODEL_FLAGS.has(flag)) return true;
  // llama-server has acquired several spelling variants for speculative decoding and
  // adapters over time.  Treat any explicit draft/LoRA/adapter selector as opaque rather
  // than risking a false complete weight inventory.
  return /(?:^|[-_])(draft|lora|adapter)(?:[-_=]|$)/i.test(flag);
}

function resolveProcessPath(pid: number, raw: string, deps: ReturnType<typeof mergedDeps>): string | null {
  if (!raw || raw.includes("\0") || isRemoteArtifact(raw)) return null;
  // Do not lexically normalize traversal through /proc/PID/cwd: that loses the kernel's
  // magic-link resolution and could hash a host path outside the target process view.
  if (raw.split(/[\\/]+/).includes("..")) return null;
  try {
    const root = deps.readProcRoot(pid);
    const cwd = deps.readProcCwd(pid);
    const candidate = raw.startsWith("/")
      ? resolve(root, `.${raw}`)
      : resolve(cwd, raw);
    const rootPrefix = resolve(root) + "/";
    if (raw.startsWith("/") && candidate !== resolve(root) && !candidate.startsWith(rootPrefix)) return null;
    return candidate;
  } catch {
    return null;
  }
}

function processViewIsCompatible(pid: number, deps: ReturnType<typeof mergedDeps>): boolean {
  try {
    if (deps.readProcMountNamespace!(pid) !== deps.readSelfMountNamespace!()) return false;
    const targetRoot = deps.readProcRootIdentity!(pid);
    const selfRoot = deps.readSelfRootIdentity!();
    return targetRoot.dev === selfRoot.dev && targetRoot.ino === selfRoot.ino;
  } catch {
    return false;
  }
}

function splitShardPaths(path: string, deps: ReturnType<typeof mergedDeps>): string[] | null {
  const leaf = posix.basename(path);
  const match = leaf.match(/^(.*)-(\d{5})-of-(\d{5})(\.[^/]*)$/i);
  if (!match) return [path];
  const prefix = match[1]!;
  const suffix = match[4]!;
  const total = Number(match[3]);
  if (!Number.isSafeInteger(total) || total <= 0 || total > 256) return null;
  const directory = dirname(path);
  try {
    const names = new Set(deps.listArtifactDirectory(directory));
    const paths: string[] = [];
    for (let index = 1; index <= total; index++) {
      const shard = `${prefix}-${String(index).padStart(5, "0")}-of-${String(total).padStart(5, "0")}${suffix}`;
      if (!names.has(shard)) return null;
      paths.push(join(directory, shard));
    }
    return paths;
  } catch {
    return null;
  }
}

function observeArtifact(path: string, deps: ReturnType<typeof mergedDeps>): HashObservation {
  try {
    const before = deps.readArtifactStat(path);
    if (!isRegular(before) || before.size <= 0) return { sha256: null, changed: false, unavailable: true };
    const digest = deps.hashArtifact(path, before);
    const after = deps.readArtifactStat(path);
    if (!sameStat(before, after)) return { sha256: null, changed: true, unavailable: false };
    if (!/^[a-f0-9]{64}$/i.test(digest)) return { sha256: null, changed: false, unavailable: true };
    return { sha256: digest.toLowerCase(), changed: false, unavailable: false };
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error &&
      (error as { code?: unknown }).code === "ARTIFACT_CHANGED") {
      return { sha256: null, changed: true, unavailable: false };
    }
    return { sha256: null, changed: false, unavailable: true };
  }
}

function runtimePath(
  pid: number,
  beforeExe: string,
  deps: ReturnType<typeof mergedDeps>,
  overrides: ServedProvenanceCollectorDeps,
): string {
  // The default must stay in the target process view.  Tests and callers with an injected
  // executable reader may provide a matching fixture path instead.
  if (overrides.readProcExePath !== undefined) return overrides.readProcExePath(pid);
  if (overrides.readProcExe !== undefined) return beforeExe;
  return deps.readProcExePath!(pid);
}

function markArtifact(
  observation: HashObservation,
  reasons: ServedProvenanceReason[],
): ServedArtifactObservation {
  if (observation.changed) {
    reasons.push("artifact-changed");
    return { sha256: null, binding: "stale" };
  }
  if (observation.unavailable) {
    reasons.push("artifact-hash-failed");
    return { sha256: null, binding: "unproven" };
  }
  return { sha256: observation.sha256, binding: "unproven" };
}

function environmentObservation(deps: ReturnType<typeof mergedDeps>, reasons: ServedProvenanceReason[]): ServedEnvironmentObservation {
  const environment = emptyEnvironment();
  try {
    const value = deps.readKernelRelease().trim();
    if (value) environment.osRelease = value.slice(0, 200);
  } catch { /* fixed reason below */ }
  try {
    const value = deps.getArch().trim();
    if (value) environment.arch = value.slice(0, 40);
  } catch { /* fixed reason below */ }
  try {
    const value = deps.getCpuCount();
    if (Number.isSafeInteger(value) && value > 0) environment.cpuCount = value;
  } catch { /* fixed reason below */ }
  try {
    const value = deps.getMemoryBytes();
    if (Number.isSafeInteger(value) && value > 0) environment.memoryBytes = value;
  } catch { /* fixed reason below */ }
  if (Object.values(environment).some((value) => value === null)) reasons.push("environment-unavailable");
  return environment;
}

function identityChanged(before: ProcessSnapshot, after: ProcessSnapshot): ServedProvenanceReason[] {
  const reasons: ServedProvenanceReason[] = [];
  if (before.startTime !== after.startTime) reasons.push("process-identity-changed");
  if (before.cmdlineBytes !== after.cmdlineBytes) reasons.push("cmdline-changed");
  if (before.exe !== after.exe) reasons.push("executable-changed");
  return reasons;
}

function unavailableResult(capturedAt: string, reasons: ServedProvenanceReason[], environment: ServedEnvironmentObservation = emptyEnvironment()): ServedProcessProvenance {
  return {
    capturedAt,
    freshness: "unavailable",
    reasons: cleanReasons(reasons),
    weights: [],
    projector: { kind: "unknown" },
    runtimeSha256: null,
    launchFlags: emptyLaunchFlags(),
    environment,
  };
}

/** Capture private, read-only observations about one already-running llama-server process. */
export function captureServedProcess(
  pid: number,
  dependencyOverrides: ServedProvenanceCollectorDeps = {},
): ServedProcessProvenance {
  const deps = mergedDeps(dependencyOverrides);
  const capturedAt = safeCapturedAt(dependencyOverrides.now);
  const reasons: ServedProvenanceReason[] = [];
  const environment = environmentObservation(deps, reasons);
  if (!asSafePid(pid)) return unavailableResult(capturedAt, ["pid-invalid", ...reasons], environment);

  let before: ProcessSnapshot;
  try {
    before = readSnapshot(pid, deps);
  } catch {
    return unavailableResult(capturedAt, ["process-unavailable", ...reasons], environment);
  }
  if (!executableIsLlamaServer(before.exe)) {
    return unavailableResult(capturedAt, ["process-not-llama-server", ...reasons], environment);
  }

  const parsed = parseArgs(before.cmdline);
  if (parsed.modelCount === 0) reasons.push("model-flag-missing");
  if (parsed.modelCount > 1) reasons.push("model-flag-ambiguous");
  if (parsed.projectorCount > 1) reasons.push("projector-flag-ambiguous");
  if (parsed.artifactInvalid) reasons.push("artifact-path-unavailable");
  if (parsed.unsupported) reasons.push("unsupported-model-loader-feature");
  if (parsed.remoteArtifact) reasons.push("artifact-remote");
  if (parsed.launchAmbiguous) reasons.push("launch-flag-ambiguous");
  if (parsed.launchInvalid) reasons.push("launch-flag-invalid");

  const weights: ServedArtifactObservation[] = [];
  const processViewAvailable = processViewIsCompatible(pid, deps);
  if (parsed.model !== null && parsed.modelCount === 1 && !parsed.remoteArtifact && !processViewAvailable) {
    reasons.push("process-view-unavailable");
    weights.push({ sha256: null, binding: "unproven" });
  } else if (parsed.model !== null && parsed.modelCount === 1 && !parsed.remoteArtifact) {
    const modelPath = resolveProcessPath(pid, parsed.model, deps);
    if (modelPath === null) {
      reasons.push("artifact-path-unavailable");
      weights.push({ sha256: null, binding: "unproven" });
    } else {
      const paths = parsed.splitModel ? splitShardPaths(modelPath, deps) : [modelPath];
      if (paths === null) {
        reasons.push("artifact-shards-unavailable");
        weights.push({ sha256: null, binding: "unproven" });
      } else {
        for (const path of paths) weights.push(markArtifact(observeArtifact(path, deps), reasons));
      }
    }
  } else if (parsed.modelCount > 0) {
    weights.push({ sha256: null, binding: "unproven" });
  }

  // Command-line absence does not prove that a projector was not selected through an
  // environment/config mechanism that this content-blind collector intentionally does not read.
  let projector: ServedProjectorObservation = { kind: "unknown" };
  if (parsed.projectorCount > 0) {
    if (parsed.projectorCount !== 1 || parsed.projector === null || parsed.remoteArtifact) {
      projector = { kind: "unknown" };
      reasons.push(parsed.remoteArtifact ? "artifact-remote" : "projector-flag-ambiguous");
    } else {
      if (!processViewAvailable) {
        projector = { kind: "unknown" };
        reasons.push("process-view-unavailable");
      } else {
        const projectorPath = resolveProcessPath(pid, parsed.projector, deps);
        if (projectorPath === null) {
          projector = { kind: "unknown" };
          reasons.push("artifact-path-unavailable");
        } else {
          projector = markArtifact(observeArtifact(projectorPath, deps), reasons);
        }
      }
    }
  }

  let runtimeSha256: string | null = null;
  try {
    const runtime = observeArtifact(runtimePath(pid, before.exe, deps, dependencyOverrides), deps);
    if (runtime.changed) reasons.push("runtime-changed");
    else if (runtime.unavailable) reasons.push("runtime-unavailable");
    else runtimeSha256 = runtime.sha256;
  } catch {
    reasons.push("runtime-unavailable");
  }

  let after: ProcessSnapshot;
  try {
    after = readSnapshot(pid, deps);
    reasons.push(...identityChanged(before, after));
    if (!executableIsLlamaServer(after.exe)) reasons.push("process-not-llama-server");
  } catch {
    reasons.push("process-identity-changed");
    after = before;
  }

  // The target mount namespace/root must remain the same for the entire observation. A view
  // change after hashing invalidates the snapshot even when each individual hash was stable.
  if (processViewAvailable && !processViewIsCompatible(pid, deps)) {
    reasons.push("process-view-changed");
  }

  return finalizeCapture(capturedAt, reasons, weights, projector, runtimeSha256, parsed.launchFlags, environment);
}

function finalizeCapture(
  capturedAt: string,
  reasons: ServedProvenanceReason[],
  weights: ServedArtifactObservation[],
  projector: ServedProjectorObservation,
  runtimeSha256: string | null,
  launchFlags: ServedLaunchFlags,
  environment: ServedEnvironmentObservation,
): ServedProcessProvenance {
  const cleanedReasons = cleanReasons(reasons);
  const stale = cleanedReasons.some((reason) =>
    reason === "process-identity-changed" || reason === "cmdline-changed" || reason === "executable-changed" ||
    reason === "artifact-changed" || reason === "runtime-changed" || reason === "process-view-changed",
  );
  const unavailable = cleanedReasons.some((reason) =>
    reason === "process-unavailable" || reason === "model-flag-missing" || reason === "model-flag-ambiguous" ||
    reason === "artifact-path-unavailable" || reason === "artifact-remote" || reason === "artifact-hash-failed" ||
    reason === "artifact-shards-unavailable" || reason === "unsupported-model-loader-feature" ||
    reason === "process-view-unavailable" ||
    reason === "runtime-unavailable" || reason === "launch-flag-ambiguous" || reason === "launch-flag-invalid",
  );
  return {
    capturedAt,
    freshness: stale ? "stale" : unavailable ? "unavailable" : "fresh",
    reasons: cleanedReasons,
    weights,
    projector,
    runtimeSha256,
    launchFlags,
    environment,
  };
}
