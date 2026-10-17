import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildReleaseArchive,
  collectPublicRelease,
  inspectModelRelease,
  parseReleaseIngestionArgs,
  ReleaseUnavailableError,
  renderReleaseMarkdown,
  writeReleaseArchive,
  type HuggingFaceModelMetadata,
} from "../src/homeserver/model-release-ingestion.js";

const tempRoots: string[] = [];
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const FLAGSHIP_METADATA: HuggingFaceModelMetadata = {
  id: "Qwen/Qwen3.8-2.4T-A95B",
  sha: "207bd685a7e3696cfaff12ded7c6a7ea0f88c996",
  lastModified: "2026-08-12T10:24:04.000Z",
  private: false,
  gated: false,
  pipeline_tag: "text-generation",
  tags: ["transformers", "qwen3_5_moe_text", "text-generation", "license:other"],
  siblings: [
    { rfilename: "config.json" },
    { rfilename: "generation_config.json" },
    { rfilename: "tokenizer_config.json" },
    { rfilename: "tokenizer.json" },
    { rfilename: "model-00001-of-00213.safetensors" },
  ],
  safetensors: { total: 2_400_000_000_000 },
  cardData: { license: "other", license_name: "qwen3.8-max" },
};

const FLAGSHIP_CONFIG = {
  architectures: ["Qwen3_5MoeForCausalLM"],
  model_type: "qwen3_5_moe_text",
  hidden_size: 8192,
  intermediate_size: 0,
  moe_intermediate_size: 2048,
  shared_expert_intermediate_size: 2048,
  num_hidden_layers: 92,
  num_attention_heads: 64,
  num_key_value_heads: 4,
  num_experts: 512,
  num_experts_per_tok: 10,
  layer_types: ["linear_attention", "linear_attention", "linear_attention", "full_attention"],
  full_attention_interval: 4,
  mtp_num_hidden_layers: 1,
  max_position_embeddings: 262_144,
  vocab_size: 248_320,
  bos_token_id: 248_044,
  eos_token_id: 248_044,
};

describe("parseReleaseIngestionArgs", () => {
  it("defaults to the release-day Qwen3.8-27B target and a gitignored archive root", () => {
    expect(parseReleaseIngestionArgs([])).toEqual({
      model: "Qwen/Qwen3.8-27B",
      outDir: "data/model-releases",
    });
  });

  it("accepts an explicit model and output directory", () => {
    expect(
      parseReleaseIngestionArgs([
        "--model",
        "Qwen/Qwen3.8-2.4T-A95B",
        "--out-dir",
        "/tmp/qwen-release",
      ])
    ).toEqual({ model: "Qwen/Qwen3.8-2.4T-A95B", outDir: "/tmp/qwen-release" });
  });

  it("rejects malformed model ids, missing values, and unknown flags", () => {
    expect(() => parseReleaseIngestionArgs(["--model", "Qwen"])).toThrow(/owner\/model/);
    expect(() => parseReleaseIngestionArgs(["--model"])).toThrow(/requires a value/);
    expect(() => parseReleaseIngestionArgs(["--api-base", "https:\/\/example.com"])).toThrow(
      /unrecognized argument/
    );
  });
});

describe("inspectModelRelease", () => {
  it("extracts the public immutable Qwen3.8 flagship architecture without guessing active parameters", () => {
    const result = inspectModelRelease({
      metadata: FLAGSHIP_METADATA,
      config: FLAGSHIP_CONFIG,
      tokenizerConfig: { tokenizer_class: "Qwen2Tokenizer", model_max_length: 262_144 },
      generationConfig: { eos_token_id: 248_044 },
      modelCard: "- Number of Parameters: 2.4T in total and 95B activated\n",
    });

    expect(result.schemaVersion).toBe(1);
    expect(result.model).toMatchObject({
      id: "Qwen/Qwen3.8-2.4T-A95B",
      revision: FLAGSHIP_METADATA.sha,
      public: true,
      gated: false,
      sourceLastModified: FLAGSHIP_METADATA.lastModified,
    });
    expect(result.architecture).toMatchObject({
      topology: "moe",
      modelType: "qwen3_5_moe_text",
      architectures: ["Qwen3_5MoeForCausalLM"],
      totalParameters: 2_400_000_000_000,
      activeParameters: 95_000_000_000,
      numExperts: 512,
      numExpertsPerToken: 10,
      sharedExpert: true,
    });
    expect(result.architecture.activeParametersEvidence).toMatch(/official model card/i);
    expect(result.attention).toMatchObject({
      kind: "hybrid-linear-full",
      layerTypes: ["linear_attention", "full_attention"],
      fullAttentionInterval: 4,
      numAttentionHeads: 64,
      numKeyValueHeads: 4,
    });
    expect(result.speculation).toEqual({ nativeMtp: true, mtpHiddenLayers: 1 });
    expect(result.context.nativeMaxTokens).toBe(262_144);
    expect(result.tokenizer).toMatchObject({
      tokenizerClass: "Qwen2Tokenizer",
      vocabSize: 248_320,
      bosTokenId: 248_044,
      eosTokenIds: [248_044],
    });
    expect(result.modality).toMatchObject({ kind: "text", evidence: expect.any(String) });
    expect(result.license).toEqual({ id: "other", name: "qwen3.8-max" });
  });

  it("handles nested text_config and identifies a multimodal dense model", () => {
    const result = inspectModelRelease({
      metadata: {
        ...FLAGSHIP_METADATA,
        id: "Qwen/Qwen3.6-27B",
        pipeline_tag: "image-text-to-text",
        tags: ["image-text-to-text", "license:apache-2.0"],
        safetensors: { total: 27_000_000_000 },
      },
      config: {
        architectures: ["Qwen3_5ForConditionalGeneration"],
        model_type: "qwen3_5",
        vision_config: { model_type: "qwen3_5_vision" },
        text_config: {
          architectures: ["Qwen3_5ForCausalLM"],
          model_type: "qwen3_5_text",
          intermediate_size: 11_008,
          num_hidden_layers: 64,
          num_attention_heads: 32,
          num_key_value_heads: 8,
          max_position_embeddings: 262_144,
          vocab_size: 248_320,
        },
      },
      tokenizerConfig: null,
      generationConfig: null,
    });

    expect(result.architecture.topology).toBe("dense");
    expect(result.architecture.totalParameters).toBe(27_000_000_000);
    expect(result.architecture.activeParameters).toBe(27_000_000_000);
    expect(result.modality.kind).toBe("multimodal");
    expect(result.attention.kind).toBe("full");
  });

  it("keeps unsupported or missing claims explicitly unknown", () => {
    const result = inspectModelRelease({
      metadata: { ...FLAGSHIP_METADATA, safetensors: undefined, pipeline_tag: undefined, tags: [] },
      config: { architectures: ["FutureModel"], model_type: "future" },
      tokenizerConfig: null,
      generationConfig: null,
    });

    expect(result.architecture.topology).toBe("unknown");
    expect(result.architecture.totalParameters).toBeNull();
    expect(result.architecture.activeParameters).toBeNull();
    expect(result.attention.kind).toBe("unknown");
    expect(result.modality.kind).toBe("unknown");
    expect(result.context.nativeMaxTokens).toBeNull();
    expect(result.speculation).toEqual({ nativeMtp: false, mtpHiddenLayers: null });
  });

  it("attributes a model-card-only total to the official model card", () => {
    const metadata = structuredClone(FLAGSHIP_METADATA);
    delete metadata.safetensors;
    const result = inspectModelRelease({
      metadata,
      config: FLAGSHIP_CONFIG,
      tokenizerConfig: null,
      generationConfig: null,
      modelCard: "Number of Parameters: 2.4T in total and 95B activated",
    });

    expect(result.architecture.totalParameters).toBe(2.4e12);
    expect(result.architecture.totalParametersEvidence).toBe(
      "parameter total is stated in the official model card"
    );
  });
});

describe("release archive", () => {
  it("produces deterministic source hashes, JSON, and Markdown without including weight files", () => {
    const archive = buildReleaseArchive({
      metadata: FLAGSHIP_METADATA,
      sourceFiles: {
        "config.json": JSON.stringify(FLAGSHIP_CONFIG, null, 2) + "\n",
        "generation_config.json": "{\n  \"eos_token_id\": 248044\n}\n",
        "tokenizer_config.json": "{\n  \"tokenizer_class\": \"Qwen2Tokenizer\"\n}\n",
        "README.md": "- Number of Parameters: 2.4T in total and 95B activated\n",
      },
    });

    expect(Object.keys(archive.files).sort()).toEqual([
      "README.md",
      "REPORT.md",
      "config.json",
      "generation_config.json",
      "manifest.json",
      "release.json",
      "tokenizer_config.json",
    ]);
    expect(archive.files["manifest.json"]).toContain('"sha256"');
    expect(archive.files["release.json"]).toContain(FLAGSHIP_METADATA.sha);
    expect(archive.files["REPORT.md"]).toContain("Qwen3.8-2.4T-A95B");
    expect(JSON.stringify(archive)).not.toContain("model-00001-of-00213.safetensors");
    expect(archive.relativeDirectory).toBe(
      `Qwen--Qwen3.8-2.4T-A95B/${FLAGSHIP_METADATA.sha}`
    );
  });

  it("renders unknown values honestly", () => {
    const inspection = inspectModelRelease({
      metadata: { ...FLAGSHIP_METADATA, safetensors: undefined },
      config: { architectures: ["FutureModel"], model_type: "future" },
      tokenizerConfig: null,
      generationConfig: null,
    });
    const markdown = renderReleaseMarkdown(inspection);
    expect(markdown).toContain("Active parameters | unknown");
    expect(markdown).toContain("Topology | unknown");
  });
});

describe("collectPublicRelease", () => {
  function response(body: unknown, status = 200): Response {
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  it("pins every control-file request to the immutable Hub revision and never fetches weights", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/api/models/Qwen/Qwen3.8-2.4T-A95B")) return response(FLAGSHIP_METADATA);
      if (url.includes("/raw/")) {
        const filename = url.split("/").at(-1)!;
        if (filename === "config.json") return response(FLAGSHIP_CONFIG);
        if (filename === "generation_config.json") return response({ eos_token_id: 248_044 });
        if (filename === "tokenizer_config.json") return response({ tokenizer_class: "Qwen2Tokenizer" });
      }
      return response({ error: "not found" }, 404);
    });

    const archive = await collectPublicRelease("Qwen/Qwen3.8-2.4T-A95B", {
      fetchImpl,
      hubBaseUrl: "https://huggingface.test",
    });

    const requested = fetchImpl.mock.calls.map(([url]) => String(url));
    expect(requested).toHaveLength(4);
    expect(requested.slice(1).every((url) => url.includes(`/${FLAGSHIP_METADATA.sha}/`))).toBe(true);
    expect(requested.some((url) => url.includes("safetensors"))).toBe(false);
    expect(archive.inspection.model.revision).toBe(FLAGSHIP_METADATA.sha);
  });

  it("classifies a private/not-yet-public model response as release unavailable", async () => {
    const fetchImpl = vi.fn(async () => response({ error: "Invalid username or password." }, 401));
    await expect(
      collectPublicRelease("Qwen/Qwen3.8-27B", { fetchImpl, hubBaseUrl: "https://huggingface.test" })
    ).rejects.toEqual(expect.objectContaining<Partial<ReleaseUnavailableError>>({ statusCode: 401 }));
  });

  it("fails closed when metadata is gated or lacks an immutable revision", async () => {
    const gatedFetch = vi.fn(async () => response({ ...FLAGSHIP_METADATA, gated: "auto" }));
    await expect(
      collectPublicRelease(FLAGSHIP_METADATA.id, { fetchImpl: gatedFetch })
    ).rejects.toThrow(/gated/i);

    const unpinnedFetch = vi.fn(async () => response({ ...FLAGSHIP_METADATA, sha: null }));
    await expect(
      collectPublicRelease(FLAGSHIP_METADATA.id, { fetchImpl: unpinnedFetch })
    ).rejects.toThrow(/immutable/i);
  });
});

describe("writeReleaseArchive", () => {
  it("writes the complete deterministic archive and can be rerun safely", () => {
    const root = mkdtempSync(join(tmpdir(), "qwen-release-"));
    tempRoots.push(root);
    const archive = buildReleaseArchive({
      metadata: FLAGSHIP_METADATA,
      sourceFiles: { "config.json": JSON.stringify(FLAGSHIP_CONFIG) },
    });

    const first = writeReleaseArchive(root, archive);
    const second = writeReleaseArchive(root, archive);

    expect(first).toEqual(second);
    expect(first).toHaveLength(4);
    const releasePath = join(root, archive.relativeDirectory, "release.json");
    expect(JSON.parse(readFileSync(releasePath, "utf8")).model.revision).toBe(FLAGSHIP_METADATA.sha);
  });

  it("refuses to mutate an existing immutable revision when archived bytes differ", () => {
    const root = mkdtempSync(join(tmpdir(), "qwen-release-conflict-"));
    tempRoots.push(root);
    const archive = buildReleaseArchive({
      metadata: FLAGSHIP_METADATA,
      sourceFiles: { "config.json": JSON.stringify(FLAGSHIP_CONFIG) },
    });
    const written = writeReleaseArchive(root, archive);
    const configPath = written.find((path) => path.endsWith("/config.json"))!;
    writeFileSync(configPath, "mutated bytes");

    expect(() => writeReleaseArchive(root, archive)).toThrow(/immutable release archive conflict/);
  });
});
