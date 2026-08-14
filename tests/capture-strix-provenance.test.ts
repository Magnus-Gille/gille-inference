import { describe, expect, it, vi } from "vitest";

import { parseCaptureArgs, runCaptureStrixProvenance } from "../scripts/capture-strix-provenance.js";

const ARGV = [
  "--pid", "123", "--model-artifact", "/models/model.gguf", "--runtime-commit", "b".repeat(40),
  "--backend", "vulkan", "--quant", "Q4_K_M", "--context", "65536", "--kv-k", "q8_0",
  "--kv-v", "q8_0", "--fa", "on", "--batch", "2048", "--ubatch", "512",
  "--parallelism", "1", "--speculation", "none", "--draft-depth", "none", "--out", "provenance.json",
];

describe("capture Strix provenance", () => {
  it("parses an explicit process/config contract", () => {
    expect(parseCaptureArgs(ARGV)).toMatchObject({ pid: 123, backend: "vulkan", contextSize: 65536, draftDepth: null });
    expect(() => parseCaptureArgs([...ARGV, "--pid", "456"])).toThrow(/duplicate/);
  });

  it("hashes process inputs without storing paths or raw command arguments", async () => {
    const write = vi.fn();
    const exit = await runCaptureStrixProvenance(ARGV, {
      hashFile: async (path) => path.includes("models") ? "a".repeat(64) : "c".repeat(64),
      readProcExe: () => "/opt/llama-server",
      readProcArgs: () => Buffer.from("llama-server\0--model\0/private/model.gguf\0"),
      kernel: () => "6.14.0",
      mesa: () => "25.2.0",
      rocm: () => null,
      write,
      stdout: vi.fn(),
      stderr: vi.fn(),
    });
    expect(exit).toBe(0);
    const json = write.mock.calls[0]![1] as string;
    expect(json).toContain('"modelArtifactSha256": "' + "a".repeat(64));
    expect(json).not.toContain("/private/model.gguf");
    expect(json).not.toContain("/opt/llama-server");
  });
});
