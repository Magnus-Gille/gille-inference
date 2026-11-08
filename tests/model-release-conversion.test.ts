import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  ConversionStepError,
  executeConversion,
  parseConversionArgs,
  planConversion,
  type ConversionDependencies,
} from "../src/homeserver/model-release-conversion.js";

const BASE = [
  "--staged-dir", "/models/q/rev",
  "--llama-dir", "/opt/llama.cpp",
  "--out-dir", "/out",
  "--name", "Qwen4-27B",
];
const COMMIT = "a".repeat(40);

describe("parseConversionArgs", () => {
  it("parses defaults", () => {
    const args = parseConversionArgs(BASE);
    expect(args).toMatchObject({
      quants: ["Q4_K_M"],
      mmproj: false,
      python: "python3",
      dryRun: false,
      quantizeBin: "/opt/llama.cpp/build/bin/llama-quantize",
    });
  });
  it("rejects unknown, duplicate, relative and bad values", () => {
    expect(() => parseConversionArgs([...BASE, "--bogus"])).toThrow(/unknown flag/);
    expect(() => parseConversionArgs([...BASE, "--name", "x"])).toThrow(/duplicate/);
    expect(() => parseConversionArgs([...BASE, "--dry-run", "--dry-run"])).toThrow(/duplicate/);
    expect(() => parseConversionArgs(BASE.map((v) => (v === "/out" ? "out" : v)))).toThrow(/absolute/);
    expect(() => parseConversionArgs([...BASE, "--quant", "Q4_K_M,Q2_K"])).toThrow(/unsupported/);
    expect(() => parseConversionArgs(BASE.map((v) => (v === "Qwen4-27B" ? "../x" : v)))).toThrow(/unsafe/);
    expect(() => parseConversionArgs(BASE.slice(0, 6))).toThrow(/--name is required/);
  });
});

describe("planConversion", () => {
  it("plans bf16 then quants", () => {
    const steps = planConversion(parseConversionArgs([...BASE, "--quant", "Q8_0,Q4_K_M"]));
    expect(steps.map((s) => s.id)).toEqual(["convert-bf16", "quantize-Q8_0", "quantize-Q4_K_M"]);
    expect(steps[0]).toEqual({
      id: "convert-bf16",
      bin: "python3",
      argv: ["/opt/llama.cpp/convert_hf_to_gguf.py", "/models/q/rev", "--outtype", "bf16", "--outfile", "/out/Qwen4-27B-BF16.gguf"],
      output: "/out/Qwen4-27B-BF16.gguf",
    });
    expect(steps[2]!.argv).toEqual(["/out/Qwen4-27B-BF16.gguf", "/out/Qwen4-27B-Q4_K_M.gguf", "Q4_K_M"]);
  });
  it("adds the mmproj step", () => {
    const steps = planConversion(parseConversionArgs([...BASE, "--mmproj"]));
    expect(steps.map((s) => s.id)).toEqual(["convert-bf16", "convert-mmproj", "quantize-Q4_K_M"]);
    expect(steps[1]!.argv).toContain("--mmproj");
    expect(steps[1]!.output).toBe("/out/mmproj-Qwen4-27B-BF16.gguf");
  });
});

const MODEL_REVISION = "b".repeat(40);
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

function setup(extra: string[] = [], stageManifest: string | null = defaultStageManifest()) {
  const root = mkdtempSync(join(tmpdir(), "conv-"));
  const out = join(root, "out");
  const staged = join(root, "staged");
  const llama = join(root, "llama");
  mkdirSync(out);
  mkdirSync(staged);
  mkdirSync(join(llama, "build", "bin"), { recursive: true });
  writeFileSync(join(llama, "convert_hf_to_gguf.py"), "# converter");
  writeFileSync(join(llama, "build", "bin", "llama-quantize"), "quantizer");
  writeFileSync(join(staged, "config.json"), STAGED_CONFIG);
  if (stageManifest !== null) writeFileSync(join(staged, "stage-manifest.json"), stageManifest);
  const args = parseConversionArgs([
    "--staged-dir", staged, "--llama-dir", llama,
    "--out-dir", out, "--name", "M", ...extra,
  ]);
  return { out, staged, llama, args, steps: planConversion(args) };
}

const STAGED_CONFIG = '{"architectures":["X"]}';

function defaultStageManifest(files: unknown[] = [stagedFile()]): string {
  return `${JSON.stringify({ schemaVersion: 1, model: "Qwen/Qwen4-27B", revision: MODEL_REVISION, totalBytes: STAGED_CONFIG.length, files }, null, 2)}\n`;
}

function stagedFile(overrides: Record<string, unknown> = {}) {
  return { path: "config.json", size: STAGED_CONFIG.length, sha256: sha(STAGED_CONFIG), kind: "control", ...overrides };
}

function fakeDeps(opts: { failId?: string; calls?: string[][]; onRun?: (target: string, bin: string) => void } = {}): ConversionDependencies {
  return {
    llamaCommit: async () => COMMIT,
    llamaSourceClean: async () => true,
    run: async (bin, argv) => {
      opts.calls?.push([bin, ...argv]);
      const isConvert = bin === "python3";
      const target = isConvert ? argv[argv.indexOf("--outfile") + 1]! : argv[1]!;
      expect(target).toContain(".conversion-run-");
      opts.onRun?.(target, bin);
      writeFileSync(target, `data:${target.split("/").pop()}`);
      const failId = opts.failId;
      if (failId && ((failId === "convert-mmproj" && argv.includes("--mmproj")) || (failId.startsWith("quantize") && !isConvert))) {
        return { status: 3, stderr: "boom" };
      }
      return { status: 0 };
    },
  };
}

const leftovers = (out: string) => readdirSync(out).filter((f) => f.startsWith(".conversion-run-") || f.endsWith(".partial") || f.endsWith(".tmp"));

describe("executeConversion", () => {
  it("writes outputs and a manifest with hashes and provenance", async () => {
    const { out, staged, llama, args, steps } = setup(["--mmproj"]);
    const { manifestPath, manifest } = await executeConversion(args, steps, fakeDeps());
    const raw = readFileSync(manifestPath, "utf8");
    expect(raw.endsWith("}\n")).toBe(true);
    expect(JSON.parse(raw)).toEqual(manifest);
    expect(manifest.llamaCppCommit).toBe(COMMIT);
    expect(manifest.model).toBe("Qwen/Qwen4-27B");
    expect(manifest.revision).toBe(MODEL_REVISION);
    expect(manifest.stageManifestSha256).toBe(sha(readFileSync(join(staged, "stage-manifest.json"), "utf8")));
    expect(manifest.converterSha256).toBe(sha("# converter"));
    expect(manifest.quantizerSha256).toBe(sha("quantizer"));
    expect(llama).toBeTruthy();
    expect(manifest.outputs).toHaveLength(3);
    for (const o of manifest.outputs) {
      const bytes = readFileSync(o.path);
      expect(o.path.startsWith(out)).toBe(true);
      expect(o.path).not.toContain(".conversion-run-");
      expect(o.bytes).toBe(bytes.length);
      expect(o.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    }
    expect(leftovers(out)).toEqual([]);
    expect(existsSync(join(out, ".conversion.lock"))).toBe(false);
  });
  it("reports the failing step and leaves nothing behind", async () => {
    const { out, args, steps } = setup(["--mmproj"]);
    const error = await executeConversion(args, steps, fakeDeps({ failId: "convert-mmproj" })).catch((e) => e);
    expect(error).toBeInstanceOf(ConversionStepError);
    expect(error.stepId).toBe("convert-mmproj");
    expect(error.exitStatus).toBe(3);
    expect(error.message).toContain("boom");
    expect(readdirSync(out)).toEqual([]);
  });
  it("can be retried after a failure at step 2", async () => {
    const { out, args, steps } = setup(["--mmproj"]);
    await expect(executeConversion(args, steps, fakeDeps({ failId: "convert-mmproj" }))).rejects.toBeInstanceOf(ConversionStepError);
    expect(readdirSync(out)).toEqual([]);
    const { manifest } = await executeConversion(args, steps, fakeDeps());
    expect(manifest.outputs).toHaveLength(3);
    expect(leftovers(out)).toEqual([]);
  });
  it("refuses to overwrite existing outputs", async () => {
    const { out, args, steps } = setup();
    writeFileSync(join(out, "M-Q4_K_M.gguf"), "x");
    await expect(executeConversion(args, steps, fakeDeps())).rejects.toThrow(/refusing to overwrite/);
    expect(readdirSync(out)).toEqual(["M-Q4_K_M.gguf"]);
  });
  it("fails naming the lock path when locked, runs nothing, and keeps the lock", async () => {
    const { out, args, steps } = setup();
    const lock = join(out, ".conversion.lock");
    writeFileSync(lock, "{}");
    const calls: string[][] = [];
    const error = await executeConversion(args, steps, fakeDeps({ calls })).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain(lock);
    expect(error.message).toMatch(/PID/);
    expect(calls).toEqual([]);
    expect(existsSync(lock)).toBe(true);
  });
  it("writes pid and createdAt in the lock while running and releases it after success and failure", async () => {
    const { out, args, steps } = setup();
    let seen: { pid?: number; createdAt?: string } = {};
    await executeConversion(args, steps, fakeDeps({ onRun: () => { seen = JSON.parse(readFileSync(join(out, ".conversion.lock"), "utf8")); } }));
    expect(seen.pid).toBe(process.pid);
    expect(typeof seen.createdAt).toBe("string");
    expect(existsSync(join(out, ".conversion.lock"))).toBe(false);
    const second = setup();
    await expect(executeConversion(second.args, second.steps, fakeDeps({ failId: "quantize-Q4_K_M" }))).rejects.toBeInstanceOf(ConversionStepError);
    expect(existsSync(join(second.out, ".conversion.lock"))).toBe(false);
  });
  it("points quantize input into the run dir", async () => {
    const { args, steps } = setup();
    const calls: string[][] = [];
    await executeConversion(args, steps, fakeDeps({ calls }));
    const quant = calls.find((c) => c[0] !== "python3")!;
    expect(quant[1]).toContain(".conversion-run-");
    expect(quant[1]!.endsWith("M-BF16.gguf")).toBe(true);
    expect(quant[2]).toContain(".conversion-run-");
  });
  it("does not replace a final created mid-run and unlinks its own finals", async () => {
    const { out, args, steps } = setup(["--mmproj"]);
    const rival = join(out, "M-Q4_K_M.gguf");
    const deps = fakeDeps({ onRun: (_t, bin) => { if (bin !== "python3") writeFileSync(rival, "rival"); } });
    await expect(executeConversion(args, steps, deps)).rejects.toThrow();
    expect(readFileSync(rival, "utf8")).toBe("rival");
    expect(readdirSync(out)).toEqual(["M-Q4_K_M.gguf"]);
  });
  it.each([
    ["missing stage manifest", null],
    ["malformed json", "{nope"],
    ["wrong schema", JSON.stringify({ schemaVersion: 2, model: "Qwen/Q", revision: MODEL_REVISION })],
    ["bad model", JSON.stringify({ schemaVersion: 1, model: "../x", revision: MODEL_REVISION })],
    ["bad revision", JSON.stringify({ schemaVersion: 1, model: "Qwen/Q", revision: "main" })],
  ])("fails closed before any step: %s", async (_label, content) => {
    const { out, args, steps } = setup([], content);
    const calls: string[][] = [];
    await expect(executeConversion(args, steps, fakeDeps({ calls }))).rejects.toThrow(/stage-manifest/);
    expect(calls).toEqual([]);
    expect(readdirSync(out)).toEqual([]);
  });
  it("fails closed on null or malformed llama commit", async () => {
    for (const commit of [null, "abc"]) {
      const { out, args, steps } = setup();
      const calls: string[][] = [];
      const deps = { ...fakeDeps({ calls }), llamaCommit: async () => commit };
      await expect(executeConversion(args, steps, deps)).rejects.toThrow(/commit/);
      expect(calls).toEqual([]);
      expect(readdirSync(out)).toEqual([]);
    }
  });
  it("fails closed on a dirty llama.cpp checkout", async () => {
    const { out, args, steps } = setup();
    const calls: string[][] = [];
    const deps = { ...fakeDeps({ calls }), llamaSourceClean: async () => false };
    await expect(executeConversion(args, steps, deps)).rejects.toThrow(/clean|dirty|modif/i);
    expect(calls).toEqual([]);
    expect(readdirSync(out)).toEqual([]);
  });
});

describe("executeConversion review round 2", () => {
  it("rejects a stage manifest without files, with unsafe paths or bad hashes", async () => {
    for (const files of [[], [stagedFile({ path: "../x" })], [stagedFile({ path: "/abs" })], [stagedFile({ sha256: "x" })]]) {
      const { args, steps } = setup([], defaultStageManifest(files));
      const calls: string[][] = [];
      await expect(executeConversion(args, steps, fakeDeps({ calls }))).rejects.toThrow(/stage-manifest/);
      expect(calls).toEqual([]);
    }
  });

  it("rejects staged files that are missing, resized or unlisted before any step", async () => {
    const cases: Array<(staged: string) => void> = [
      (staged) => writeFileSync(join(staged, "config.json"), "changed size"),
      (staged) => writeFileSync(join(staged, "extra.safetensors"), "x"),
      (staged) => rmSync(join(staged, "config.json")),
    ];
    for (const mutate of cases) {
      const { staged, args, steps } = setup();
      mutate(staged);
      const calls: string[][] = [];
      await expect(executeConversion(args, steps, fakeDeps({ calls }))).rejects.toThrow(/staged/);
      expect(calls).toEqual([]);
    }
  });

  it("verifies hashes only with --verify-hashes and records which check ran", async () => {
    const tampered = (verify: string[]) => {
      const ctx = setup(verify);
      writeFileSync(join(ctx.staged, "config.json"), STAGED_CONFIG.replace("X", "Y")); // same size
      return ctx;
    };
    const sizeOnly = tampered([]);
    const { manifest } = await executeConversion(sizeOnly.args, sizeOnly.steps, fakeDeps());
    expect(manifest.stagedFilesVerified).toBe("size");
    const full = tampered(["--verify-hashes"]);
    await expect(executeConversion(full.args, full.steps, fakeDeps())).rejects.toThrow(/sha256/);
  });

  it("refuses to publish when the converter changes during the run", async () => {
    const { out, llama, args, steps } = setup();
    const deps = fakeDeps({ onRun: () => writeFileSync(join(llama, "convert_hf_to_gguf.py"), "# swapped") });
    await expect(executeConversion(args, steps, deps)).rejects.toThrow(/converterSha256 changed/);
    expect(readdirSync(out)).toEqual([]);
  });

  it("refuses to publish when the llama.cpp commit changes during the run", async () => {
    const { out, args, steps } = setup();
    let n = 0;
    const deps = { ...fakeDeps(), llamaCommit: async () => (n++ === 0 ? COMMIT : "c".repeat(40)) };
    await expect(executeConversion(args, steps, deps)).rejects.toThrow(/llamaCppCommit changed/);
    expect(readdirSync(out)).toEqual([]);
  });

  it("reports a successful publish with a warning when run-dir cleanup fails", async () => {
    const { out, args, steps } = setup();
    const deps = { ...fakeDeps(), removeRunDir: () => { throw new Error("EBUSY"); } };
    const { manifestPath, warnings } = await executeConversion(args, steps, deps);
    expect(existsSync(manifestPath)).toBe(true);
    expect(warnings.join(" ")).toMatch(/remove run directory .*EBUSY/);
    expect(existsSync(join(out, ".conversion.lock"))).toBe(false);
  });

  it("keeps the step error type and appends cleanup failures to it", async () => {
    const { out, args, steps } = setup(["--mmproj"]);
    const deps = { ...fakeDeps({ failId: "convert-mmproj" }), removeRunDir: () => { throw new Error("EBUSY"); } };
    const error = await executeConversion(args, steps, deps).catch((e) => e);
    expect(error).toBeInstanceOf(ConversionStepError);
    expect(error.message).toMatch(/convert-mmproj.*cleanup also failed: remove run directory .*EBUSY/s);
    expect(existsSync(join(out, ".conversion.lock"))).toBe(false);
  });
});
