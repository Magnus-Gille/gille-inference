import { describe, expect, it } from "vitest";

import {
  inspectModelRuntimeCompatibility,
  renderModelRuntimeCompatibilityMarkdown,
  type RuntimeCompatibilityInput,
} from "../src/homeserver/model-runtime-compatibility.js";

const REVISION = "0123456789abcdef0123456789abcdef01234567";
const RUNTIME = "89abcdef0123456789abcdef0123456789abcdef";

function sources(architecture = "Qwen3_5ForCausalLM"): Record<string, string> {
  const moe = architecture.includes("Moe");
  const arch = moe ? "QWEN35MOE" : "QWEN35";
  const lower = moe ? "qwen35moe" : "qwen35";
  const modelClass = moe ? "llama_model_qwen35moe" : "llama_model_qwen35";
  const converterClass = moe ? "Qwen3_5MoeTextModel" : "Qwen3_5TextModel";
  const modelFile = moe ? "src/models/qwen35moe.cpp" : "src/models/qwen35.cpp";
  return {
    "conversion/__init__.py": `"${architecture}": "qwen",\n`,
    "conversion/qwen.py": `@ModelBase.register("${architecture}")\nclass ${converterClass}:\n model_arch = gguf.MODEL_ARCH.${arch}\n`,
    "gguf-py/gguf/constants.py": `${arch} = auto()\nMODEL_ARCH.${arch}: "${lower}"\n`,
    "src/llama-arch.cpp": `{ LLM_ARCH_${arch}, "${lower}" },\n`,
    "src/llama-model.cpp": `case LLM_ARCH_${arch}: return new ${modelClass}(params);\n`,
    [modelFile]: `void ${modelClass}::load_arch_hparams() {}\nvoid ${modelClass}::build_arch_graph() {}\n${modelClass}::graph_mtp::graph_mtp() {}\nLLM_GRAPH_TYPE_DECODER_MTP\n`,
    "common/speculative.cpp": `qwen35 qwen35moe MTP common_speculative_impl_draft_mtp\n`,
  };
}

function input(overrides: Partial<RuntimeCompatibilityInput> = {}): RuntimeCompatibilityInput {
  return {
    release: {
      schemaVersion: 1,
      model: { id: "Qwen/Qwen3.8-27B", revision: REVISION },
      architecture: { architectures: ["Qwen3_5ForCausalLM"] },
      speculation: { nativeMtp: true },
    },
    requestedRuntimeCommit: RUNTIME,
    checkoutRuntimeCommit: RUNTIME,
    checkoutSourceClean: true,
    sources: sources(),
    ...overrides,
  };
}

describe("inspectModelRuntimeCompatibility", () => {
  it("proves dense Qwen3.5-family converter, GGUF, runtime, and MTP support from hashed sources", () => {
    const result = inspectModelRuntimeCompatibility(input());
    expect(result.supported).toBe(true);
    expect(result.selectedArchitecture).toBe("Qwen3_5ForCausalLM");
    expect(result.runtimeCommit).toBe(RUNTIME);
    expect(result.evidence.every((file) => /^[a-f0-9]{64}$/.test(file.sha256))).toBe(true);
    expect(result.evidence.every((file) => file.passed)).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it.each([
    "Qwen3_5ForConditionalGeneration",
    "Qwen3_5MoeForConditionalGeneration",
  ])("proves the official multimodal wrapper architecture %s through its text runtime", (architecture) => {
    const result = inspectModelRuntimeCompatibility(
      input({
        release: {
          ...input().release,
          architecture: { architectures: [architecture] },
        },
        sources: sources(architecture),
      })
    );

    expect(result.supported).toBe(true);
    expect(result.selectedArchitecture).toBe(architecture);
    expect(result.nativeMtpRequired).toBe(true);
    expect(result.evidence.every((file) => file.passed)).toBe(true);
    expect(result.evidence.map((item) => item.path)).toContain(
      architecture.includes("Moe") ? "src/models/qwen35moe.cpp" : "src/models/qwen35.cpp"
    );
  });

  it("proves the separate MoE implementation when the official config names it", () => {
    const architecture = "Qwen3_5MoeForCausalLM";
    const result = inspectModelRuntimeCompatibility(
      input({
        release: {
          ...input().release,
          architecture: { architectures: [architecture] },
        },
        sources: sources(architecture),
      })
    );
    expect(result.supported).toBe(true);
    expect(result.selectedArchitecture).toBe(architecture);
    expect(result.evidence.map((item) => item.path)).toContain("src/models/qwen35moe.cpp");
  });

  it("fails closed for an unknown or ambiguous official architecture", () => {
    const unknown = inspectModelRuntimeCompatibility(
      input({ release: { ...input().release, architecture: { architectures: ["Qwen3_8ForCausalLM"] } } })
    );
    expect(unknown.supported).toBe(false);
    expect(unknown.selectedArchitecture).toBeNull();
    expect(unknown.reasons.join(" ")).toMatch(/unsupported official architecture/);

    const ambiguous = inspectModelRuntimeCompatibility(
      input({
        release: {
          ...input().release,
          architecture: {
            architectures: ["Qwen3_5ForCausalLM", "Qwen3_5MoeForCausalLM"],
          },
        },
      })
    );
    expect(ambiguous.supported).toBe(false);
    expect(ambiguous.reasons.join(" ")).toMatch(/exactly one supported architecture/);
  });

  it("fails when conversion or runtime support exists alone", () => {
    const noRuntime = sources();
    delete noRuntime["src/llama-model.cpp"];
    const runtimeMissing = inspectModelRuntimeCompatibility(input({ sources: noRuntime }));
    expect(runtimeMissing.supported).toBe(false);
    expect(runtimeMissing.reasons.join(" ")).toMatch(/src\/llama-model\.cpp/);

    const noConverter = sources();
    delete noConverter["conversion/qwen.py"];
    const converterMissing = inspectModelRuntimeCompatibility(input({ sources: noConverter }));
    expect(converterMissing.supported).toBe(false);
    expect(converterMissing.reasons.join(" ")).toMatch(/conversion\/qwen\.py/);
  });

  it("requires explicit MTP evidence only when the release declares native MTP", () => {
    const withoutMtp = sources();
    withoutMtp["common/speculative.cpp"] = "ordinary speculative implementation\n";
    const mtp = inspectModelRuntimeCompatibility(input({ sources: withoutMtp }));
    expect(mtp.supported).toBe(false);
    expect(mtp.reasons.join(" ")).toMatch(/MTP/);

    const directOnly = inspectModelRuntimeCompatibility(
      input({
        release: { ...input().release, speculation: { nativeMtp: false } },
        sources: withoutMtp,
      })
    );
    expect(directOnly.supported).toBe(true);
  });

  it("rejects a checkout that does not equal the explicitly requested immutable commit", () => {
    const result = inspectModelRuntimeCompatibility(
      input({ checkoutRuntimeCommit: "f".repeat(40) })
    );
    expect(result.supported).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/runtime commit mismatch/);
  });

  it("rejects tracked modifications in compatibility-critical source files", () => {
    const result = inspectModelRuntimeCompatibility(input({ checkoutSourceClean: false }));
    expect(result.supported).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/tracked modifications/);
  });

  it("renders a human-readable fail-closed report", () => {
    const markdown = renderModelRuntimeCompatibilityMarkdown(inspectModelRuntimeCompatibility(input()));
    expect(markdown).toContain("Runtime compatibility: PASS");
    expect(markdown).toContain("Qwen3_5ForCausalLM");
    expect(markdown).toContain("Source SHA-256");
  });
});
