import { describe, expect, it } from "vitest";

import {
  buildLlamaBenchArgs,
  makeStrixBenchmarkReport,
  normalizeLlamaBenchRows,
  parseStrixBenchmarkArgs,
  renderStrixBenchmarkMarkdown,
  type LlamaBenchRow,
} from "../src/homeserver/strix-benchmark.js";

const SHA256 = "a".repeat(64);

describe("parseStrixBenchmarkArgs", () => {
  it("parses a reproducible direct Vulkan plan with the required context depths", () => {
    const args = parseStrixBenchmarkArgs([
      "--llama-bench",
      "/opt/llama.cpp/llama-bench",
      "--model",
      "/models/qwen.gguf",
      "--model-id",
      "Qwen/Qwen3-Coder-30B-A3B",
      "--quant",
      "Q4_K_S",
      "--backend",
      "vulkan",
      "--out",
      "data/strix/qwen-coder-vulkan",
    ]);

    expect(args).toMatchObject({
      llamaBenchPath: "/opt/llama.cpp/llama-bench",
      modelPath: "/models/qwen.gguf",
      modelId: "Qwen/Qwen3-Coder-30B-A3B",
      quant: "Q4_K_S",
      backend: "vulkan",
      contexts: [8192, 32768, 65536, 131072],
      kvTypeK: "q8_0",
      kvTypeV: "q8_0",
      flashAttention: "on",
      batch: 2048,
      ubatch: 512,
      parallelism: 1,
      speculation: "none",
      ppTokens: 512,
      tgTokens: 128,
      repetitions: 5,
    });
  });

  it("supports an explicit 256K context and KV/backend matrix values", () => {
    const args = parseStrixBenchmarkArgs([
      "--llama-bench", "/bin/llama-bench",
      "--model", "/models/qwen.gguf",
      "--model-id", "Qwen/Qwen3.6-35B-A3B",
      "--quant", "ROCmFP4-balanced",
      "--backend", "hip",
      "--contexts", "8192,32768,65536,131072,262144",
      "--kv-k", "bf16",
      "--kv-v", "q4_0",
      "--fa", "auto",
      "--batch", "4096",
      "--ubatch", "1024",
      "--repetitions", "3",
      "--out", "/tmp/strix",
    ]);
    expect(args.contexts.at(-1)).toBe(262144);
    expect(args).toMatchObject({ backend: "hip", kvTypeK: "bf16", kvTypeV: "q4_0", batch: 4096, ubatch: 1024 });
  });

  it("fails closed for missing required coverage, unsupported speculation/parallelism, or unknown flags", () => {
    const base = [
      "--llama-bench", "/bin/llama-bench",
      "--model", "/models/qwen.gguf",
      "--model-id", "Qwen/Qwen3.6-35B-A3B",
      "--quant", "Q4_K_M",
      "--backend", "vulkan",
      "--out", "/tmp/strix",
    ];
    expect(() => parseStrixBenchmarkArgs([...base, "--contexts", "8192,32768"])).toThrow(/required context/i);
    expect(() => parseStrixBenchmarkArgs([...base, "--parallelism", "2"])).toThrow(/parallelism 1/);
    expect(() => parseStrixBenchmarkArgs([...base, "--speculation", "mtp"])).toThrow(/direct llama-bench/i);
    expect(() => parseStrixBenchmarkArgs([...base, "--bogus"])).toThrow(/unrecognized argument/);
  });
});

describe("buildLlamaBenchArgs", () => {
  it("builds argv without a shell and includes short plus every populated context depth", () => {
    const plan = parseStrixBenchmarkArgs([
      "--llama-bench", "/bin/llama-bench",
      "--model", "/models/qwen.gguf",
      "--model-id", "Qwen/Qwen3.6-35B-A3B",
      "--quant", "Q4_K_M",
      "--backend", "vulkan",
      "--out", "/tmp/strix",
    ]);
    expect(buildLlamaBenchArgs(plan)).toEqual([
      "-m", "/models/qwen.gguf",
      "-p", "512",
      "-n", "128",
      "-d", "0,8192,32768,65536,131072",
      "-b", "2048",
      "-ub", "512",
      "-ctk", "q8_0",
      "-ctv", "q8_0",
      "-fa", "on",
      "-ngl", "-1",
      "-r", "5",
      "-o", "json",
    ]);
  });
});

const ROWS: LlamaBenchRow[] = [
  {
    build_commit: "deadbeef",
    build_number: 7000,
    cpu_info: "AMD Ryzen AI Max+ 395",
    gpu_info: "AMD Radeon 8060S",
    backends: "Vulkan",
    model_filename: "/models/qwen.gguf",
    model_type: "qwen moe",
    model_size: 18_000_000_000,
    model_n_params: 30_000_000_000,
    n_batch: 2048,
    n_ubatch: 512,
    type_k: "q8_0",
    type_v: "q8_0",
    flash_attn: 1,
    n_prompt: 512,
    n_gen: 0,
    n_depth: 8192,
    avg_ts: 1200,
    stddev_ts: 10,
  },
  {
    build_commit: "deadbeef",
    build_number: 7000,
    cpu_info: "AMD Ryzen AI Max+ 395",
    gpu_info: "AMD Radeon 8060S",
    backends: "Vulkan",
    model_filename: "/models/qwen.gguf",
    model_type: "qwen moe",
    model_size: 18_000_000_000,
    model_n_params: 30_000_000_000,
    n_batch: 2048,
    n_ubatch: 512,
    type_k: "q8_0",
    type_v: "q8_0",
    flash_attn: 1,
    n_prompt: 0,
    n_gen: 128,
    n_depth: 8192,
    avg_ts: 101.5,
    stddev_ts: 0.8,
  },
];

describe("llama-bench normalization and report", () => {
  it("normalizes PP/TG separately and leaves TTFT/acceptance explicitly null", () => {
    const normalized = normalizeLlamaBenchRows(ROWS, "vulkan");
    expect(normalized).toEqual([
      expect.objectContaining({ phase: "pp", contextDepth: 8192, tokens: 512, tokensPerSecond: 1200, ttftMs: null, acceptanceRate: null }),
      expect.objectContaining({ phase: "tg", contextDepth: 8192, tokens: 128, tokensPerSecond: 101.5, ttftMs: null, acceptanceRate: null }),
    ]);
  });

  it("rejects mixed runtime commits or the wrong measured backend", () => {
    expect(() => normalizeLlamaBenchRows([{ ...ROWS[0]!, build_commit: "other" }, ROWS[1]!], "vulkan")).toThrow(/runtime commit/i);
    expect(() => normalizeLlamaBenchRows(ROWS, "hip")).toThrow(/backend/i);
  });

  it("renders a machine report and an honest human-readable matrix", () => {
    const plan = parseStrixBenchmarkArgs([
      "--llama-bench", "/bin/llama-bench",
      "--model", "/models/qwen.gguf",
      "--model-id", "Qwen/Qwen3-Coder-30B-A3B",
      "--quant", "Q4_K_S",
      "--backend", "vulkan",
      "--out", "/tmp/strix",
    ]);
    const report = makeStrixBenchmarkReport({
      plan,
      modelSha256: SHA256,
      rows: ROWS,
      startedAt: "2026-08-14T12:00:00.000Z",
      finishedAt: "2026-08-14T12:10:00.000Z",
      system: { kernel: "7.0.0", mesaVersion: "26.2.0", rocmVersion: "7.2.1" },
      telemetry: { peakRssBytes: 20_000_000_000, availableRamBeforeBytes: 90_000_000_000, availableRamAfterBytes: 89_000_000_000, maxTemperatureC: 72, averagePowerW: null },
    });
    expect(report.runtime).toMatchObject({ commit: "deadbeef", backend: "Vulkan", kernel: "7.0.0" });
    expect(report.model.artifactSha256).toBe(SHA256);
    expect(report.measurementLimits).toMatchObject({ ttft: expect.stringMatching(/not measured/i), acceptanceRate: expect.stringMatching(/not applicable/i) });
    const markdown = renderStrixBenchmarkMarkdown(report);
    expect(markdown).toContain("Qwen/Qwen3-Coder-30B-A3B");
    expect(markdown).toContain("| 8,192 | 1,200.0 | 101.5 |");
    expect(markdown).toContain("TTFT is not measured");
  });
});
