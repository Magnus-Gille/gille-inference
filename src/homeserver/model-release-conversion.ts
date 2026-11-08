import { createHash, randomUUID } from "node:crypto";
import {
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, normalize } from "node:path";

export const CONVERSION_QUANT_ALLOWLIST = ["Q8_0", "Q6_K", "Q5_K_M", "Q4_K_M"] as const;
const SAFE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const COMMIT_RE = /^[a-f0-9]{40}$/;

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
  llamaCppCommit: string | null;
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
const BOOLEAN_FLAGS = ["--mmproj", "--dry-run"] as const;

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

function removeQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Absent is fine; never mask the original failure.
  }
}

function atomicWrite(path: string, content: string): void {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } catch (error) {
    removeQuietly(temporary);
    throw error;
  }
}

export async function executeConversion(
  args: ConversionArgs,
  steps: ConversionStep[],
  deps: ConversionDependencies
): Promise<{ manifestPath: string; manifest: ConversionManifest }> {
  mkdirSync(args.outDir, { recursive: true });
  if (lstatSync(args.outDir).isSymbolicLink()) throw new Error("--out-dir must not be a symbolic link");
  const manifestPath = join(args.outDir, "conversion-manifest.json");
  for (const path of [manifestPath, ...steps.map((s) => s.output)]) {
    if (existsSync(path)) throw new Error(`refusing to overwrite existing output: ${path}`);
  }
  const rawCommit = await deps.llamaCommit(args.llamaDir);
  const llamaCppCommit = rawCommit && COMMIT_RE.test(rawCommit) ? rawCommit : null;

  const outputs: ConversionOutputRecord[] = [];
  for (const step of steps) {
    const partial = `${step.output}.partial`;
    removeQuietly(partial);
    const argv = step.argv.map((arg) => (arg === step.output ? partial : arg));
    let result: StepRunResult;
    try {
      result = await deps.run(step.bin, argv);
    } catch (error) {
      removeQuietly(partial);
      throw new ConversionStepError(step.id, null, error instanceof Error ? error.message : String(error));
    }
    if (result.status !== 0) {
      removeQuietly(partial);
      throw new ConversionStepError(step.id, result.status, result.stderr ?? "");
    }
    if (!existsSync(partial)) {
      throw new ConversionStepError(step.id, 0, `step produced no output file ${partial}`);
    }
    renameSync(partial, step.output);
    outputs.push({
      stepId: step.id,
      path: step.output,
      bytes: statSync(step.output).size,
      sha256: await sha256File(step.output),
    });
  }
  const manifest: ConversionManifest = {
    schemaVersion: 1,
    stagedDir: args.stagedDir,
    llamaCppCommit,
    steps,
    outputs,
  };
  atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifestPath, manifest };
}
