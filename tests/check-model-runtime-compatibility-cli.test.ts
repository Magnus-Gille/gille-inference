import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  collectRuntimeCompatibilityInput,
  parseRuntimeCompatibilityArgs,
  runRuntimeCompatibilityCheck,
} from "../scripts/check-model-runtime-compatibility.js";
import type {
  ModelRuntimeCompatibilityReport,
  RuntimeCompatibilityInput,
} from "../src/homeserver/model-runtime-compatibility.js";

const MODEL_REVISION = "0123456789abcdef0123456789abcdef01234567";
const RUNTIME_REVISION = "89abcdef0123456789abcdef0123456789abcdef";

describe("parseRuntimeCompatibilityArgs", () => {
  it("requires explicit release, checkout, runtime revision, and output directory", () => {
    expect(() => parseRuntimeCompatibilityArgs([])).toThrow(/runtime-revision/);
    expect(() =>
      parseRuntimeCompatibilityArgs([
        "--release-json",
        "release.json",
        "--llama-dir",
        "/src/llama.cpp",
        "--runtime-revision",
        "main",
        "--out-dir",
        "/tmp/report",
      ])
    ).toThrow(/40-character/);
    expect(
      parseRuntimeCompatibilityArgs([
        "--release-json",
        "release.json",
        "--llama-dir",
        "/src/llama.cpp",
        "--runtime-revision",
        RUNTIME_REVISION,
        "--out-dir",
        "/tmp/report",
      ])
    ).toEqual({
      releaseJson: "release.json",
      llamaDir: "/src/llama.cpp",
      runtimeRevision: RUNTIME_REVISION,
      outDir: "/tmp/report",
    });
  });
});

describe("collectRuntimeCompatibilityInput", () => {
  it("does not accept an untracked working-tree source as evidence for the pinned commit", () => {
    const root = mkdtempSync(join(tmpdir(), "runtime-compatibility-"));
    execFileSync("git", ["init", "-q", root]);
    writeFileSync(join(root, "README.md"), "pinned checkout\n");
    execFileSync("git", ["-C", root, "add", "README.md"]);
    execFileSync("git", [
      "-C", root,
      "-c", "user.name=Runtime Test",
      "-c", "user.email=runtime@example.invalid",
      "commit", "-qm", "fixture",
    ]);
    const revision = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    mkdirSync(join(root, "src", "models"), { recursive: true });
    writeFileSync(
      join(root, "src", "models", "qwen35.cpp"),
      "llama_model_qwen35::load_arch_hparams llama_model_qwen35::build_arch_graph\n",
    );
    const releaseJson = join(root, "release.json");
    writeFileSync(releaseJson, JSON.stringify({
      schemaVersion: 1,
      model: { id: "Qwen/Qwen3.8-27B", revision: MODEL_REVISION },
      architecture: { architectures: ["Qwen3_5ForCausalLM"] },
      speculation: { nativeMtp: false },
    }));

    const collected = collectRuntimeCompatibilityInput({
      releaseJson,
      llamaDir: root,
      runtimeRevision: revision,
      outDir: join(root, "out"),
    });

    expect(collected.sources["src/models/qwen35.cpp"]).toBeUndefined();
  });
});

describe("runRuntimeCompatibilityCheck", () => {
  const args = [
    "--release-json",
    "release.json",
    "--llama-dir",
    "/src/llama.cpp",
    "--runtime-revision",
    RUNTIME_REVISION,
    "--out-dir",
    "/tmp/report",
  ];
  const collected: RuntimeCompatibilityInput = {
    release: {
      schemaVersion: 1,
      model: { id: "Qwen/Qwen3.8-27B", revision: MODEL_REVISION },
      architecture: { architectures: ["Qwen3_5ForCausalLM"] },
      speculation: { nativeMtp: true },
    },
    requestedRuntimeCommit: RUNTIME_REVISION,
    checkoutRuntimeCommit: RUNTIME_REVISION,
    checkoutSourceClean: true,
    sources: {},
  };
  const report: ModelRuntimeCompatibilityReport = {
    schemaVersion: 1,
    model: "Qwen/Qwen3.8-27B",
    modelRevision: MODEL_REVISION,
    requestedRuntimeCommit: RUNTIME_REVISION,
    runtimeCommit: RUNTIME_REVISION,
    checkoutSourceClean: true,
    selectedArchitecture: "Qwen3_5ForCausalLM",
    nativeMtpRequired: true,
    supported: true,
    reasons: [],
    evidence: [],
  };

  it("writes both reports and returns zero only for a fully supported checkout", async () => {
    const lines: string[] = [];
    const collect = vi.fn(() => collected);
    const inspect = vi.fn(() => report);
    const write = vi.fn(() => ["/tmp/report/compatibility.json", "/tmp/report/REPORT.md"]);
    const code = await runRuntimeCompatibilityCheck(args, {
      collect,
      inspect,
      write,
      stdout: (line) => lines.push(line),
      stderr: vi.fn(),
    });
    expect(code).toBe(0);
    expect(collect).toHaveBeenCalledWith({
      releaseJson: "release.json",
      llamaDir: "/src/llama.cpp",
      runtimeRevision: RUNTIME_REVISION,
      outDir: "/tmp/report",
    });
    expect(write).toHaveBeenCalledWith("/tmp/report", report);
    expect(JSON.parse(lines[0]!)).toMatchObject({ status: "compatible", architecture: "Qwen3_5ForCausalLM" });
  });

  it("still writes evidence but returns two for an unsupported runtime", async () => {
    const incompatible = { ...report, supported: false, reasons: ["missing runtime evidence"] };
    const write = vi.fn(() => ["compatibility.json", "REPORT.md"]);
    const code = await runRuntimeCompatibilityCheck(args, {
      collect: () => collected,
      inspect: () => incompatible,
      write,
      stdout: vi.fn(),
      stderr: vi.fn(),
    });
    expect(code).toBe(2);
    expect(write).toHaveBeenCalledWith("/tmp/report", incompatible);
  });
});
