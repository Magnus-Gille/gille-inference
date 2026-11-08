import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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

function setup(extra: string[] = []) {
  const out = mkdtempSync(join(tmpdir(), "conv-"));
  const args = parseConversionArgs([
    "--staged-dir", "/models/q/rev", "--llama-dir", "/opt/llama.cpp",
    "--out-dir", out, "--name", "M", ...extra,
  ]);
  return { out, args, steps: planConversion(args) };
}

function fakeDeps(failId?: string): ConversionDependencies {
  return {
    llamaCommit: async () => COMMIT,
    run: async (bin, argv) => {
      const isConvert = bin === "python3";
      const target = isConvert ? argv[argv.indexOf("--outfile") + 1]! : argv[1]!;
      expect(target.endsWith(".partial")).toBe(true);
      writeFileSync(target, `data:${target.split("/").pop()}`);
      if (failId && ((failId === "convert-mmproj" && argv.includes("--mmproj")) || (failId.startsWith("quantize") && !isConvert))) {
        return { status: 3, stderr: "boom" };
      }
      return { status: 0 };
    },
  };
}

describe("executeConversion", () => {
  it("writes outputs and a manifest with hashes", async () => {
    const { out, args, steps } = setup(["--mmproj"]);
    const { manifestPath, manifest } = await executeConversion(args, steps, fakeDeps());
    const onDisk = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(onDisk).toEqual(manifest);
    expect(manifest.llamaCppCommit).toBe(COMMIT);
    expect(manifest.outputs).toHaveLength(3);
    for (const o of manifest.outputs) {
      const bytes = readFileSync(o.path);
      expect(o.bytes).toBe(bytes.length);
      expect(o.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    }
    expect(readdirSync(out).some((f) => f.endsWith(".partial") || f.endsWith(".tmp"))).toBe(false);
  });
  it("reports the failing step and leaves no partial", async () => {
    const { out, args, steps } = setup(["--mmproj"]);
    const error = await executeConversion(args, steps, fakeDeps("convert-mmproj")).catch((e) => e);
    expect(error).toBeInstanceOf(ConversionStepError);
    expect(error.stepId).toBe("convert-mmproj");
    expect(error.exitStatus).toBe(3);
    expect(error.message).toContain("boom");
    expect(readdirSync(out).filter((f) => f.endsWith(".partial"))).toEqual([]);
    expect(existsSync(join(out, "conversion-manifest.json"))).toBe(false);
  });
  it("refuses to overwrite existing outputs", async () => {
    const { out, args, steps } = setup();
    writeFileSync(join(out, "M-Q4_K_M.gguf"), "x");
    await expect(executeConversion(args, steps, fakeDeps())).rejects.toThrow(/refusing to overwrite/);
    expect(readdirSync(out)).toEqual(["M-Q4_K_M.gguf"]);
  });
});
