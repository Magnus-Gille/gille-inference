import { createHash } from "node:crypto";
import {
  closeSync,
  createReadStream,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join, normalize, relative } from "node:path";

export const CONVERSION_QUANT_ALLOWLIST = ["Q8_0", "Q6_K", "Q5_K_M", "Q4_K_M"] as const;
const SAFE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const COMMIT_RE = /^[a-f0-9]{40}$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface ConversionArgs {
  stagedDir: string;
  llamaDir: string;
  quantizeBin: string;
  outDir: string;
  name: string;
  quants: string[];
  mmproj: boolean;
  python: string;
  dryRun: boolean;
  /** Re-hash every staged file against stage-manifest.json (slow for large weights). */
  verifyHashes: boolean;
}

export interface ConversionStep {
  id: string;
  bin: string;
  argv: string[];
  output: string;
}

export interface ConversionOutputRecord {
  stepId: string;
  path: string;
  bytes: number;
  sha256: string;
}

export interface ConversionManifest {
  schemaVersion: 1;
  stagedDir: string;
  model: string;
  revision: string;
  stageManifestSha256: string;
  stagedFilesVerified: "size" | "sha256";
  llamaCppCommit: string;
  converterSha256: string;
  quantizerSha256: string;
  steps: ConversionStep[];
  outputs: ConversionOutputRecord[];
}

export interface StepRunResult {
  status: number | null;
  stderr?: string;
}

export interface ConversionDependencies {
  /** Runs one command without a shell. Must not throw for a nonzero exit. */
  run: (bin: string, argv: string[]) => Promise<StepRunResult>;
  /** Returns the llama.cpp HEAD commit, or null when unavailable. */
  llamaCommit: (llamaDir: string) => Promise<string | null>;
  /** True only when the llama.cpp checkout has no tracked modifications. */
  llamaSourceClean: (llamaDir: string) => Promise<boolean>;
  /** Removes the run-owned directory; injectable so cleanup failures can be tested. */
  removeRunDir?: (path: string) => void;
}

export interface ConversionResult {
  manifestPath: string;
  manifest: ConversionManifest;
  /** Non-fatal problems after a complete publish (e.g. run-dir or lock cleanup). */
  warnings: string[];
}

export class ConversionStepError extends Error {
  constructor(
    readonly stepId: string,
    readonly exitStatus: number | null,
    readonly stderr: string
  ) {
    super(
      `conversion step ${stepId} failed with exit status ${exitStatus ?? "none"}` +
        (stderr ? `: ${stderr.slice(-2000)}` : "")
    );
    this.name = "ConversionStepError";
  }
}

const VALUE_FLAGS = [
  "--staged-dir",
  "--llama-dir",
  "--quantize-bin",
  "--out-dir",
  "--name",
  "--quant",
  "--python",
] as const;
const BOOLEAN_FLAGS = ["--mmproj", "--dry-run", "--verify-hashes"] as const;

function requireAbsolute(flag: string, value: string): string {
  if (!isAbsolute(value) || value.includes("\0")) throw new Error(`${flag} must be an absolute path`);
  const normalized = normalize(value);
  if (normalized.split("/").includes("..")) throw new Error(`${flag} must not contain ..`);
  return normalized;
}

export function parseConversionArgs(argv: string[]): ConversionArgs {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]!;
    if ((BOOLEAN_FLAGS as readonly string[]).includes(flag)) {
      if (flags.has(flag)) throw new Error(`duplicate flag: ${flag}`);
      flags.add(flag);
    } else if ((VALUE_FLAGS as readonly string[]).includes(flag)) {
      if (values.has(flag)) throw new Error(`duplicate flag: ${flag}`);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
      values.set(flag, value);
      i += 1;
    } else {
      throw new Error(`unknown flag: ${flag}`);
    }
  }
  const need = (flag: string): string => {
    const value = values.get(flag);
    if (value === undefined) throw new Error(`${flag} is required`);
    return value;
  };
  const stagedDir = requireAbsolute("--staged-dir", need("--staged-dir"));
  const llamaDir = requireAbsolute("--llama-dir", need("--llama-dir"));
  const outDir = requireAbsolute("--out-dir", need("--out-dir"));
  const quantizeRaw = values.get("--quantize-bin");
  const quantizeBin = quantizeRaw
    ? requireAbsolute("--quantize-bin", quantizeRaw)
    : join(llamaDir, "build", "bin", "llama-quantize");
  const name = need("--name");
  if (!SAFE_NAME_RE.test(name) || name.includes("..")) throw new Error(`unsafe --name: ${name}`);
  const quants = (values.get("--quant") ?? "Q4_K_M").split(",");
  for (const quant of quants) {
    if (!(CONVERSION_QUANT_ALLOWLIST as readonly string[]).includes(quant)) {
      throw new Error(`unsupported --quant: ${quant} (allowed: ${CONVERSION_QUANT_ALLOWLIST.join(",")})`);
    }
  }
  if (new Set(quants).size !== quants.length) throw new Error("duplicate value in --quant");
  const pythonRaw = values.get("--python") ?? "python3";
  const python = pythonRaw === "python3" ? pythonRaw : requireAbsolute("--python", pythonRaw);
  return {
    stagedDir,
    llamaDir,
    quantizeBin,
    outDir,
    name,
    quants,
    mmproj: flags.has("--mmproj"),
    python,
    dryRun: flags.has("--dry-run"),
    verifyHashes: flags.has("--verify-hashes"),
  };
}

export function planConversion(args: ConversionArgs): ConversionStep[] {
  const converter = join(args.llamaDir, "convert_hf_to_gguf.py");
  const bf16 = join(args.outDir, `${args.name}-BF16.gguf`);
  const steps: ConversionStep[] = [
    {
      id: "convert-bf16",
      bin: args.python,
      argv: [converter, args.stagedDir, "--outtype", "bf16", "--outfile", bf16],
      output: bf16,
    },
  ];
  if (args.mmproj) {
    const mmproj = join(args.outDir, `mmproj-${args.name}-BF16.gguf`);
    steps.push({
      id: "convert-mmproj",
      bin: args.python,
      argv: [converter, args.stagedDir, "--mmproj", "--outtype", "bf16", "--outfile", mmproj],
      output: mmproj,
    });
  }
  for (const quant of args.quants) {
    const output = join(args.outDir, `${args.name}-${quant}.gguf`);
    steps.push({
      id: `quantize-${quant}`,
      bin: args.quantizeBin,
      argv: [bf16, output, quant],
      output,
    });
  }
  return steps;
}

export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/** Unlink a path; only "already absent" is ignored, every other failure propagates. */
function removeIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Attach secondary cleanup failures to the primary error without changing its type. */
function withCleanupFailures(primary: unknown, cleanup: string[]): unknown {
  if (cleanup.length === 0) return primary;
  const note = `; cleanup also failed: ${cleanup.join("; ")}`;
  if (primary instanceof Error) {
    primary.message += note;
    return primary;
  }
  return new Error(`${String(primary)}${note}`);
}

function acquireLock(lockPath: string, plannedOutputs: string[]): () => void {
  let fd: number;
  try {
    fd = openSync(lockPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        `conversion lock exists: ${lockPath}; another conversion may be running. ` +
          `Verify the owning PID recorded in it is gone before removing the lock manually`
      );
    }
    throw error;
  }
  try {
    // plannedOutputs lets an operator recovering from a killed run remove exactly this run's files.
    writeFileSync(fd, `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), plannedOutputs })}\n`);
  } catch (error) {
    closeSync(fd);
    try {
      removeIfPresent(lockPath);
    } catch (cleanupError) {
      throw withCleanupFailures(error, [`remove lock ${lockPath}: ${describe(cleanupError)}`]);
    }
    throw error;
  }
  closeSync(fd);
  return () => removeIfPresent(lockPath);
}

interface StageFile {
  path: string;
  size: number;
  sha256: string;
}

interface StageProvenance {
  model: string;
  revision: string;
  stageManifestSha256: string;
  files: StageFile[];
}

const SHA256_RE = /^[a-f0-9]{64}$/;
const STAGE_MANIFEST = "stage-manifest.json";

function readStageManifest(stagedDir: string): StageProvenance {
  const path = join(stagedDir, STAGE_MANIFEST);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`${STAGE_MANIFEST} is required at ${path}: ${describe(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${STAGE_MANIFEST} at ${path} is not valid JSON: ${describe(error)}`);
  }
  const m = parsed as
    | { schemaVersion?: unknown; model?: unknown; revision?: unknown; files?: unknown }
    | null;
  if (!m || typeof m !== "object" || m.schemaVersion !== 1) {
    throw new Error(`${STAGE_MANIFEST} at ${path} must have schemaVersion 1`);
  }
  if (typeof m.model !== "string" || !MODEL_RE.test(m.model)) {
    throw new Error(`${STAGE_MANIFEST} at ${path} has an invalid model`);
  }
  if (typeof m.revision !== "string" || !COMMIT_RE.test(m.revision)) {
    throw new Error(`${STAGE_MANIFEST} at ${path} has an invalid revision (need 40 lowercase hex)`);
  }
  if (!Array.isArray(m.files) || m.files.length === 0) {
    throw new Error(`${STAGE_MANIFEST} at ${path} must list the staged files`);
  }
  const seen = new Set<string>();
  const files = m.files.map((entry: unknown, index: number): StageFile => {
    const f = entry as { path?: unknown; size?: unknown; sha256?: unknown } | null;
    const filePath = f?.path;
    if (
      typeof filePath !== "string" ||
      filePath === "" ||
      filePath === "." ||
      isAbsolute(filePath) ||
      filePath.includes("\0") ||
      normalize(filePath) !== filePath ||
      filePath.split("/").includes("..") ||
      filePath === STAGE_MANIFEST
    ) {
      throw new Error(`${STAGE_MANIFEST} at ${path} has an unsafe file path at index ${index}`);
    }
    if (typeof f?.size !== "number" || !Number.isSafeInteger(f.size) || f.size < 0) {
      throw new Error(`${STAGE_MANIFEST} at ${path} has an invalid size for ${filePath}`);
    }
    if (typeof f?.sha256 !== "string" || !SHA256_RE.test(f.sha256)) {
      throw new Error(`${STAGE_MANIFEST} at ${path} has an invalid sha256 for ${filePath}`);
    }
    if (seen.has(filePath)) throw new Error(`${STAGE_MANIFEST} at ${path} lists ${filePath} twice`);
    seen.add(filePath);
    return { path: filePath, size: f.size, sha256: f.sha256 };
  });
  return {
    model: m.model,
    revision: m.revision,
    stageManifestSha256: createHash("sha256").update(raw).digest("hex"),
    files,
  };
}

function listRegularFiles(root: string, dir = root): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...listRegularFiles(root, full));
    else if (entry.isFile()) found.push(relative(root, full));
    else throw new Error(`staged directory contains a non-regular entry: ${full}`);
  }
  return found;
}

/**
 * Prove the staged directory holds exactly the manifest's files at their recorded sizes, and
 * optionally their recorded SHA-256. Staging already verified hashes on publish; sizes are the
 * cheap default re-check, `--verify-hashes` the full one.
 */
async function verifyStagedFiles(
  stagedDir: string,
  stage: StageProvenance,
  hashes: boolean
): Promise<void> {
  const expected = new Map(stage.files.map((file) => [file.path, file]));
  const present = new Set(listRegularFiles(stagedDir).filter((path) => path !== STAGE_MANIFEST));
  const unexpected = [...present].filter((path) => !expected.has(path));
  if (unexpected.length > 0) {
    throw new Error(`staged directory has files not in ${STAGE_MANIFEST}: ${unexpected.sort().join(", ")}`);
  }
  // Every listed entry must be one of the enumerated regular files (a directory never is).
  const absent = [...expected.keys()].filter((path) => !present.has(path));
  if (absent.length > 0) {
    throw new Error(`staged file(s) missing or not regular files: ${absent.sort().join(", ")}`);
  }
  for (const file of stage.files) {
    const full = join(stagedDir, file.path);
    let size: number;
    try {
      size = statSync(full).size;
    } catch (error) {
      throw new Error(`staged file ${file.path} is missing: ${describe(error)}`);
    }
    if (size !== file.size) {
      throw new Error(`staged file ${file.path} is ${size} bytes, manifest records ${file.size}`);
    }
    if (hashes && (await sha256File(full)) !== file.sha256) {
      throw new Error(`staged file ${file.path} does not match its recorded sha256`);
    }
  }
}

interface ToolIdentity {
  llamaCppCommit: string;
  converterSha256: string;
  quantizerSha256: string;
}

async function identifyTools(args: ConversionArgs, deps: ConversionDependencies): Promise<ToolIdentity> {
  const llamaCppCommit = await deps.llamaCommit(args.llamaDir);
  if (!llamaCppCommit || !COMMIT_RE.test(llamaCppCommit)) {
    throw new Error("llama.cpp commit is unavailable or not a 40-hex SHA; refusing to convert");
  }
  if (!(await deps.llamaSourceClean(args.llamaDir))) {
    throw new Error(`llama.cpp checkout ${args.llamaDir} is not clean (tracked modifications); refusing to convert`);
  }
  return {
    llamaCppCommit,
    converterSha256: await sha256File(join(args.llamaDir, "convert_hf_to_gguf.py")),
    quantizerSha256: await sha256File(args.quantizeBin),
  };
}

export async function executeConversion(
  args: ConversionArgs,
  steps: ConversionStep[],
  deps: ConversionDependencies
): Promise<ConversionResult> {
  mkdirSync(args.outDir, { recursive: true });
  if (lstatSync(args.outDir).isSymbolicLink()) throw new Error("--out-dir must not be a symbolic link");
  const lockPath = join(args.outDir, ".conversion.lock");
  const manifestPath = join(args.outDir, "conversion-manifest.json");
  const release = acquireLock(lockPath, [...steps.map((s) => s.output), manifestPath]);
  const removeRunDir = deps.removeRunDir ?? ((path: string) => rmSync(path, { recursive: true, force: true }));
  let runDir: string | undefined;
  const linked: string[] = [];
  let published = false;
  let primary: { error: unknown } | null = null;
  const warnings: string[] = [];
  let result: ConversionResult | undefined;
  try {
    for (const path of [manifestPath, ...steps.map((s) => s.output)]) {
      if (existsSync(path)) throw new Error(`refusing to overwrite existing output: ${path}`);
    }
    const stage = readStageManifest(args.stagedDir);
    await verifyStagedFiles(args.stagedDir, stage, args.verifyHashes);
    const tools = await identifyTools(args, deps);

    runDir = mkdtempSync(join(args.outDir, ".conversion-run-"));
    const inRun = (path: string) => join(runDir!, basename(path));
    const finals = new Map<string, string>(); // final path -> run path, for earlier steps
    const outputs: ConversionOutputRecord[] = [];
    for (const step of steps) {
      const runOutput = inRun(step.output);
      const argv = step.argv.map((arg) =>
        arg === step.output ? runOutput : (finals.get(arg) ?? arg)
      );
      let stepResult: StepRunResult;
      try {
        stepResult = await deps.run(step.bin, argv);
      } catch (error) {
        throw new ConversionStepError(step.id, null, describe(error));
      }
      if (stepResult.status !== 0) {
        throw new ConversionStepError(step.id, stepResult.status, stepResult.stderr ?? "");
      }
      if (!existsSync(runOutput)) {
        throw new ConversionStepError(step.id, 0, `step produced no output file ${runOutput}`);
      }
      finals.set(step.output, runOutput);
      outputs.push({
        stepId: step.id,
        path: step.output,
        bytes: statSync(runOutput).size,
        sha256: await sha256File(runOutput),
      });
    }

    // The recorded identity must still describe what ran: re-check tools and inputs before publish.
    const after = await identifyTools(args, deps);
    for (const key of ["llamaCppCommit", "converterSha256", "quantizerSha256"] as const) {
      if (after[key] !== tools[key]) {
        throw new Error(`${key} changed during conversion; refusing to publish`);
      }
    }
    if (readStageManifest(args.stagedDir).stageManifestSha256 !== stage.stageManifestSha256) {
      throw new Error(`${STAGE_MANIFEST} changed during conversion; refusing to publish`);
    }
    await verifyStagedFiles(args.stagedDir, stage, false);

    const manifest: ConversionManifest = {
      schemaVersion: 1,
      stagedDir: args.stagedDir,
      model: stage.model,
      revision: stage.revision,
      stageManifestSha256: stage.stageManifestSha256,
      stagedFilesVerified: args.verifyHashes ? "sha256" : "size",
      llamaCppCommit: tools.llamaCppCommit,
      converterSha256: tools.converterSha256,
      quantizerSha256: tools.quantizerSha256,
      steps,
      outputs,
    };
    const runManifest = inRun(manifestPath);
    writeFileSync(runManifest, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    // No-replace publish: linkSync fails with EEXIST rather than overwriting a rival file.
    // The manifest is linked last, so a final without a manifest marks an incomplete publish.
    for (const [final, source] of [...finals, [manifestPath, runManifest] as [string, string]]) {
      linkSync(source, final);
      linked.push(final);
    }
    published = true;
    result = { manifestPath, manifest, warnings };
  } catch (error) {
    primary = { error };
  }

  const cleanupFailures: string[] = [];
  if (!published) {
    for (const path of linked) {
      try {
        removeIfPresent(path);
      } catch (error) {
        cleanupFailures.push(`roll back ${path}: ${describe(error)}`);
      }
    }
  }
  if (runDir) {
    try {
      removeRunDir(runDir);
    } catch (error) {
      cleanupFailures.push(`remove run directory ${runDir}: ${describe(error)}`);
    }
  }
  try {
    release();
  } catch (error) {
    cleanupFailures.push(`remove lock ${lockPath}: ${describe(error)}`);
  }

  if (primary) throw withCleanupFailures(primary.error, cleanupFailures);
  // Everything is published and the manifest is complete: cleanup trouble is a warning, not a
  // failure, so the operator is never told to rerun a conversion that already succeeded.
  warnings.push(...cleanupFailures);
  return result!;
}
