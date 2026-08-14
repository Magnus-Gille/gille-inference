import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runStrixBenchmark } from "../scripts/strix-benchmark.js";
import type { LlamaBenchRow, StrixTelemetry } from "../src/homeserver/strix-benchmark.js";

const ARGV = [
  "--llama-bench", "/bin/llama-bench",
  "--model", "/models/qwen.gguf",
  "--model-id", "Qwen/Qwen3-Coder-30B-A3B",
  "--quant", "Q4_K_S",
  "--backend", "vulkan",
  "--out", "/tmp/strix-result",
];

const tempRoots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function rows(missingLast = false): LlamaBenchRow[] {
  const result: LlamaBenchRow[] = [];
  for (const depth of [0, 8192, 32768, 65536, 131072]) {
    for (const phase of ["pp", "tg"] as const) {
      if (missingLast && depth === 131072 && phase === "tg") continue;
      result.push({
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
        n_prompt: phase === "pp" ? 512 : 0,
        n_gen: phase === "tg" ? 128 : 0,
        n_depth: depth,
        avg_ts: phase === "pp" ? 1200 : 100,
        stddev_ts: 1,
      });
    }
  }
  return result;
}

const telemetry: StrixTelemetry = {
  peakRssBytes: null,
  availableRamBeforeBytes: null,
  availableRamAfterBytes: null,
  maxTemperatureC: null,
  averagePowerW: null,
};

function deps(inputRows: LlamaBenchRow[]) {
  return {
    hashModel: vi.fn(async () => "a".repeat(64)),
    execute: vi.fn(async () => ({ rows: inputRows, telemetry })),
    systemSnapshot: vi.fn(() => ({ kernel: "7.0.0", mesaVersion: "26.2.0", rocmVersion: "7.2.1" })),
    writeReport: vi.fn(() => ({ jsonPath: "/tmp/strix-result.json", markdownPath: "/tmp/strix-result.md" })),
    now: vi.fn().mockReturnValueOnce("2026-08-14T12:00:00.000Z").mockReturnValueOnce("2026-08-14T12:10:00.000Z"),
    stdout: vi.fn(),
    stderr: vi.fn(),
  };
}

describe("runStrixBenchmark", () => {
  it("hashes, executes, validates full coverage, and writes the JSON/Markdown pair", async () => {
    const dependencies = deps(rows());
    expect(await runStrixBenchmark(ARGV, dependencies)).toBe(0);
    expect(dependencies.hashModel).toHaveBeenCalledWith("/models/qwen.gguf");
    expect(dependencies.writeReport).toHaveBeenCalledTimes(1);
    expect(JSON.parse(dependencies.stdout.mock.calls[0]![0])).toEqual({
      status: "complete",
      jsonPath: "/tmp/strix-result.json",
      markdownPath: "/tmp/strix-result.md",
      modelSha256: "a".repeat(64),
      rows: 10,
    });
  });

  it("fails without writing when any required PP/TG/context cell is missing", async () => {
    const dependencies = deps(rows(true));
    expect(await runStrixBenchmark(ARGV, dependencies)).toBe(1);
    expect(dependencies.writeReport).not.toHaveBeenCalled();
    expect(dependencies.stderr.mock.calls[0]![0]).toMatch(/missing TG coverage.*131072/i);
  });

  it("runs an actual argv-only fake binary and atomically writes the JSON/Markdown pair", async () => {
    const root = mkdtempSync(join(tmpdir(), "strix-benchmark-cli-"));
    tempRoots.push(root);
    const binary = join(root, "llama-bench");
    const model = join(root, "model.gguf");
    const out = join(root, "result");
    writeFileSync(model, "small deterministic GGUF fixture");
    writeFileSync(
      binary,
      `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify(rows()))});\n`
    );
    chmodSync(binary, 0o755);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const exitCode = await runStrixBenchmark([
      "--llama-bench", binary,
      "--model", model,
      "--model-id", "Qwen/Qwen3-Coder-30B-A3B",
      "--quant", "Q4_K_S",
      "--backend", "vulkan",
      "--out", out,
    ]);

    expect(exitCode).toBe(0);
    const report = JSON.parse(readFileSync(`${out}.json`, "utf8"));
    expect(report.results).toHaveLength(10);
    expect(report.model.artifactSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(readFileSync(`${out}.md`, "utf8")).toContain("| 131,072 | 1,200.0 | 100.0 |");
  });
});
