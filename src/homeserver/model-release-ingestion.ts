import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve, sep } from "node:path";

type JsonObject = Record<string, unknown>;

export interface HuggingFaceModelMetadata {
  id: string;
  sha: string | null;
  lastModified?: string;
  private?: boolean;
  gated?: boolean | string;
  pipeline_tag?: string;
  tags?: string[];
  siblings?: Array<{ rfilename: string }>;
  safetensors?: { total?: number };
  cardData?: { license?: string; license_name?: string };
}

export interface ReleaseIngestionArgs {
  model: string;
  outDir: string;
}

export type ArchitectureTopology = "dense" | "moe" | "unknown";
export type AttentionKind = "full" | "hybrid-linear-full" | "sliding-full" | "unknown";
export type ModalityKind = "text" | "multimodal" | "unknown";

export interface ModelReleaseInspection {
  schemaVersion: 1;
  model: {
    id: string;
    revision: string;
    public: boolean;
    gated: boolean;
    sourceLastModified: string | null;
  };
  architecture: {
    topology: ArchitectureTopology;
    topologyEvidence: string;
    modelType: string | null;
    architectures: string[];
    totalParameters: number | null;
    totalParametersEvidence: string;
    activeParameters: number | null;
    activeParametersEvidence: string;
    numExperts: number | null;
    numExpertsPerToken: number | null;
    sharedExpert: boolean | null;
    hiddenSize: number | null;
    numHiddenLayers: number | null;
  };
  attention: {
    kind: AttentionKind;
    evidence: string;
    layerTypes: string[];
    fullAttentionInterval: number | null;
    numAttentionHeads: number | null;
    numKeyValueHeads: number | null;
  };
  speculation: {
    nativeMtp: boolean;
    mtpHiddenLayers: number | null;
  };
  context: {
    nativeMaxTokens: number | null;
  };
  tokenizer: {
    tokenizerClass: string | null;
    vocabSize: number | null;
    bosTokenId: number | null;
    eosTokenIds: number[];
    artifacts: string[];
  };
  modality: {
    kind: ModalityKind;
    evidence: string;
  };
  license: {
    id: string | null;
    name: string | null;
  };
}

export interface ReleaseArchive {
  relativeDirectory: string;
  files: Record<string, string>;
  inspection: ModelReleaseInspection;
}

const DEFAULT_MODEL = "Qwen/Qwen3.8-27B";
const DEFAULT_OUT_DIR = "data/model-releases";
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const REVISION_RE = /^[a-f0-9]{40}$/;
const ARCHIVABLE_SOURCE_FILES = new Set([
  "config.json",
  "generation_config.json",
  "tokenizer_config.json",
  "special_tokens_map.json",
  "chat_template.jinja",
  "README.md",
]);
const DEFAULT_HUB_BASE_URL = "https://huggingface.co";
const METADATA_MAX_BYTES = 4 * 1024 * 1024;
const CONTROL_FILE_MAX_BYTES = 2 * 1024 * 1024;

export class ReleaseUnavailableError extends Error {
  constructor(
    model: string,
    readonly statusCode: number
  ) {
    super(`official model release is not publicly available: ${model} (HTTP ${statusCode})`);
    this.name = "ReleaseUnavailableError";
  }
}

function requiredValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function validateModelId(model: string): void {
  if (!MODEL_ID_RE.test(model)) {
    throw new Error(`model must use the owner/model form, got "${model}"`);
  }
}

export function parseReleaseIngestionArgs(argv: string[]): ReleaseIngestionArgs {
  let model = DEFAULT_MODEL;
  let outDir = DEFAULT_OUT_DIR;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!;
    if (argument === "--model") {
      model = requiredValue(argv, index, argument);
      index++;
    } else if (argument === "--out-dir") {
      outDir = requiredValue(argv, index, argument);
      index++;
    } else {
      throw new Error(`unrecognized argument: ${argument}`);
    }
  }
  validateModelId(model);
  if (outDir.trim().length === 0) throw new Error("--out-dir must not be empty");
  return { model, outDir };
}

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function asPositiveNumber(value: unknown): number | null {
  const number = asNumber(value);
  return number !== null && number > 0 ? number : null;
}

function asStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function eosIds(...values: unknown[]): number[] {
  for (const value of values) {
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) return [value];
    if (Array.isArray(value)) {
      const ids = value.filter(
        (item): item is number => typeof item === "number" && Number.isInteger(item) && item >= 0
      );
      if (ids.length > 0) return unique(ids.map(String)).map(Number);
    }
  }
  return [];
}

function topologyFor(textConfig: JsonObject, architectures: string[], modelType: string | null): {
  topology: ArchitectureTopology;
  evidence: string;
} {
  const numExperts = asPositiveNumber(textConfig["num_experts"]);
  const names = [...architectures, modelType ?? ""].join(" ").toLowerCase();
  if (numExperts !== null || names.includes("moe")) {
    return {
      topology: "moe",
      evidence: numExperts !== null ? "config.num_experts is present" : "model type or architecture names MoE",
    };
  }
  if (asPositiveNumber(textConfig["intermediate_size"]) !== null) {
    return {
      topology: "dense",
      evidence: "config.intermediate_size is present and no MoE expert fields are present",
    };
  }
  return { topology: "unknown", evidence: "config does not prove dense or MoE topology" };
}

function attentionFor(textConfig: JsonObject): ModelReleaseInspection["attention"] {
  const layerTypes = unique(asStrings(textConfig["layer_types"]));
  const hasLinear = layerTypes.some((value) => value.includes("linear"));
  const hasFull = layerTypes.some((value) => value.includes("full"));
  const hasSliding = layerTypes.some((value) => value.includes("sliding"));
  const heads = asPositiveNumber(textConfig["num_attention_heads"]);
  let kind: AttentionKind = "unknown";
  let evidence = "config does not identify the attention layout";
  if (hasLinear && hasFull) {
    kind = "hybrid-linear-full";
    evidence = "config.layer_types contains both linear and full attention";
  } else if (hasSliding && hasFull) {
    kind = "sliding-full";
    evidence = "config.layer_types contains both sliding and full attention";
  } else if (hasFull || (layerTypes.length === 0 && heads !== null)) {
    kind = "full";
    evidence = hasFull
      ? "config.layer_types identifies full attention"
      : "attention heads are present without a hybrid or sliding layout";
  }
  return {
    kind,
    evidence,
    layerTypes,
    fullAttentionInterval: asPositiveNumber(textConfig["full_attention_interval"]),
    numAttentionHeads: heads,
    numKeyValueHeads: asPositiveNumber(textConfig["num_key_value_heads"]),
  };
}

function modalityFor(
  metadata: HuggingFaceModelMetadata,
  config: JsonObject,
  architectures: string[],
  modelType: string | null
): ModelReleaseInspection["modality"] {
  const tags = metadata.tags ?? [];
  const names = [...architectures, modelType ?? "", metadata.pipeline_tag ?? "", ...tags]
    .join(" ")
    .toLowerCase();
  if (asObject(config["vision_config"]) !== null || names.includes("image") || names.includes("conditionalgeneration")) {
    return { kind: "multimodal", evidence: "vision config, pipeline, tag, or architecture is present" };
  }
  if (metadata.pipeline_tag === "text-generation" || modelType?.endsWith("_text") === true) {
    return { kind: "text", evidence: "official pipeline or model type identifies a text model" };
  }
  return { kind: "unknown", evidence: "metadata and config do not prove model modality" };
}

export function inspectModelRelease(input: {
  metadata: HuggingFaceModelMetadata;
  config: JsonObject;
  tokenizerConfig: JsonObject | null;
  generationConfig: JsonObject | null;
  modelCard?: string | null;
}): ModelReleaseInspection {
  validateModelId(input.metadata.id);
  const revision = input.metadata.sha;
  if (revision === null || !REVISION_RE.test(revision)) {
    throw new Error(`model metadata lacks an immutable 40-character revision: ${revision ?? "(none)"}`);
  }

  const nestedTextConfig = asObject(input.config["text_config"]);
  const textConfig = nestedTextConfig ?? input.config;
  const topArchitectures = asStrings(input.config["architectures"]);
  const textArchitectures = asStrings(textConfig["architectures"]);
  const architectures = unique(textArchitectures.length > 0 ? textArchitectures : topArchitectures);
  const modelType = asString(textConfig["model_type"]) ?? asString(input.config["model_type"]);
  const topology = topologyFor(textConfig, architectures, modelType);
  const modelCardParameters = parseModelCardParameters(input.modelCard ?? null);
  const metadataTotal = asPositiveNumber(input.metadata.safetensors?.total);
  const configTotal =
    asPositiveNumber(textConfig["num_parameters"]) ??
    asPositiveNumber(input.config["num_parameters"]);
  const totalParameters =
    metadataTotal ?? configTotal ?? modelCardParameters.total;
  const explicitActive =
    asPositiveNumber(textConfig["num_active_parameters"]) ??
    asPositiveNumber(textConfig["num_active_params"]) ??
    asPositiveNumber(input.config["num_active_parameters"]);
  const activeParameters =
    explicitActive ?? modelCardParameters.active ?? (topology.topology === "dense" ? totalParameters : null);
  const mtpHiddenLayers =
    asPositiveNumber(textConfig["mtp_num_hidden_layers"]) ??
    asPositiveNumber(input.config["mtp_num_hidden_layers"]);
  const tokenizerConfig = input.tokenizerConfig ?? {};
  const generationConfig = input.generationConfig ?? {};
  const tokenizerArtifacts = (input.metadata.siblings ?? [])
    .map((item) => item.rfilename)
    .filter((name) => /(^|\/)(tokenizer|vocab|merges|special_tokens|chat_template)/i.test(name))
    .sort();
  const licenseTag = (input.metadata.tags ?? []).find((tag) => tag.startsWith("license:"));
  const licenseId = input.metadata.cardData?.license ?? licenseTag?.slice("license:".length) ?? null;

  return {
    schemaVersion: 1,
    model: {
      id: input.metadata.id,
      revision,
      public: input.metadata.private !== true,
      gated: input.metadata.gated !== false && input.metadata.gated !== undefined,
      sourceLastModified: input.metadata.lastModified ?? null,
    },
    architecture: {
      topology: topology.topology,
      topologyEvidence: topology.evidence,
      modelType,
      architectures,
      totalParameters,
      totalParametersEvidence:
        totalParameters === null
          ? "parameter total is not present in config or Hub safetensors metadata"
          : metadataTotal !== null
            ? "Hugging Face safetensors metadata"
            : configTotal !== null
              ? "model config"
              : "parameter total is stated in the official model card",
      activeParameters,
      activeParametersEvidence:
        explicitActive !== null
          ? "active parameter count is present in config"
          : modelCardParameters.active !== null
            ? "active parameter count is stated in the official model card"
          : topology.topology === "dense" && totalParameters !== null
            ? "dense topology makes active parameters equal total parameters"
            : "active parameter count is not present in config and is not inferred for MoE/unknown topology",
      numExperts: asPositiveNumber(textConfig["num_experts"]),
      numExpertsPerToken: asPositiveNumber(textConfig["num_experts_per_tok"]),
      sharedExpert:
        asPositiveNumber(textConfig["shared_expert_intermediate_size"]) !== null
          ? true
          : topology.topology === "moe"
            ? null
            : false,
      hiddenSize: asPositiveNumber(textConfig["hidden_size"]),
      numHiddenLayers: asPositiveNumber(textConfig["num_hidden_layers"]),
    },
    attention: attentionFor(textConfig),
    speculation: { nativeMtp: mtpHiddenLayers !== null, mtpHiddenLayers },
    context: {
      nativeMaxTokens:
        asPositiveNumber(textConfig["max_position_embeddings"]) ??
        asPositiveNumber(tokenizerConfig["model_max_length"]),
    },
    tokenizer: {
      tokenizerClass: asString(tokenizerConfig["tokenizer_class"]),
      vocabSize: asPositiveNumber(textConfig["vocab_size"]),
      bosTokenId:
        asNumber(tokenizerConfig["bos_token_id"]) ??
        asNumber(textConfig["bos_token_id"]) ??
        asNumber(input.config["bos_token_id"]),
      eosTokenIds: eosIds(
        generationConfig["eos_token_id"],
        tokenizerConfig["eos_token_id"],
        textConfig["eos_token_id"],
        input.config["eos_token_id"]
      ),
      artifacts: tokenizerArtifacts,
    },
    modality: modalityFor(input.metadata, input.config, topArchitectures, asString(input.config["model_type"])),
    license: { id: licenseId, name: input.metadata.cardData?.license_name ?? null },
  };
}

function formatNumber(value: number | null): string {
  return value === null ? "unknown" : value.toLocaleString("en-US");
}

function formatNullable(value: string | number | null): string {
  return value === null ? "unknown" : String(value);
}

export function renderReleaseMarkdown(inspection: ModelReleaseInspection): string {
  const lines = [
    `# ${inspection.model.id} release inspection`,
    "",
    `Immutable revision: \`${inspection.model.revision}\``,
    "",
    "| Field | Value |",
    "|---|---|",
    `| Public | ${inspection.model.public ? "yes" : "no"} |`,
    `| Gated | ${inspection.model.gated ? "yes" : "no"} |`,
    `| License | ${inspection.license.name ?? inspection.license.id ?? "unknown"} |`,
    `| Modality | ${inspection.modality.kind} |`,
    `| Topology | ${inspection.architecture.topology} |`,
    `| Total parameters | ${formatNumber(inspection.architecture.totalParameters)} |`,
    `| Active parameters | ${formatNumber(inspection.architecture.activeParameters)} |`,
    `| Experts | ${formatNullable(inspection.architecture.numExperts)} |`,
    `| Experts per token | ${formatNullable(inspection.architecture.numExpertsPerToken)} |`,
    `| Attention | ${inspection.attention.kind} |`,
    `| Native MTP | ${inspection.speculation.nativeMtp ? "yes" : "no"} |`,
    `| MTP hidden layers | ${formatNullable(inspection.speculation.mtpHiddenLayers)} |`,
    `| Native context | ${formatNumber(inspection.context.nativeMaxTokens)} |`,
    `| Tokenizer class | ${inspection.tokenizer.tokenizerClass ?? "unknown"} |`,
    `| Vocabulary | ${formatNumber(inspection.tokenizer.vocabSize)} |`,
    "",
    "## Evidence and limits",
    "",
    `- Topology: ${inspection.architecture.topologyEvidence}.`,
    `- Total parameters: ${inspection.architecture.totalParametersEvidence}.`,
    `- Active parameters: ${inspection.architecture.activeParametersEvidence}.`,
    `- Attention: ${inspection.attention.evidence}.`,
    `- Modality: ${inspection.modality.evidence}.`,
    "- This archive contains configuration/control files only; model weights are never fetched or stored.",
  ];
  return `${lines.join("\n")}\n`;
}

function parseJsonFile(sourceFiles: Record<string, string>, name: string, required: boolean): JsonObject | null {
  const content = sourceFiles[name];
  if (content === undefined) {
    if (required) throw new Error(`${name} is required`);
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(content);
    const object = asObject(parsed);
    if (object === null) throw new Error("root must be an object");
    return object;
  } catch (error) {
    throw new Error(`${name} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function parameterCount(value: string, suffix: string): number | null {
  const parsed = Number(value);
  const multiplier = ({ K: 1e3, M: 1e6, B: 1e9, T: 1e12 } as const)[suffix.toUpperCase() as "K" | "M" | "B" | "T"];
  if (!Number.isFinite(parsed) || parsed <= 0 || multiplier === undefined) return null;
  return parsed * multiplier;
}

function parseModelCardParameters(modelCard: string | null): { total: number | null; active: number | null } {
  if (modelCard === null) return { total: null, active: null };
  const match = modelCard.match(
    /Number of Parameters:\s*([0-9]+(?:\.[0-9]+)?)\s*([KMBT])\s+in total\s+and\s+([0-9]+(?:\.[0-9]+)?)\s*([KMBT])\s+activated/i
  );
  if (match === null) return { total: null, active: null };
  return {
    total: parameterCount(match[1]!, match[2]!),
    active: parameterCount(match[3]!, match[4]!),
  };
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function buildReleaseArchive(input: {
  metadata: HuggingFaceModelMetadata;
  sourceFiles: Record<string, string>;
}): ReleaseArchive {
  validateModelId(input.metadata.id);
  if (input.metadata.sha === null || !REVISION_RE.test(input.metadata.sha)) {
    throw new Error("model metadata must contain an immutable 40-character revision");
  }
  const sourceEntries = Object.entries(input.sourceFiles).sort(([left], [right]) => left.localeCompare(right));
  for (const [name] of sourceEntries) {
    if (!ARCHIVABLE_SOURCE_FILES.has(name)) {
      throw new Error(`refusing to archive unsupported or weight-like file: ${name}`);
    }
  }
  const config = parseJsonFile(input.sourceFiles, "config.json", true)!;
  const tokenizerConfig = parseJsonFile(input.sourceFiles, "tokenizer_config.json", false);
  const generationConfig = parseJsonFile(input.sourceFiles, "generation_config.json", false);
  const inspection = inspectModelRelease({
    metadata: input.metadata,
    config,
    tokenizerConfig,
    generationConfig,
    modelCard: input.sourceFiles["README.md"] ?? null,
  });
  const manifest = {
    schemaVersion: 1,
    model: input.metadata.id,
    revision: input.metadata.sha,
    sourceFiles: Object.fromEntries(
      sourceEntries.map(([name, content]) => [
        name,
        { sha256: sha256(content), bytes: Buffer.byteLength(content, "utf8") },
      ])
    ),
  };
  const files: Record<string, string> = Object.fromEntries(sourceEntries);
  files["release.json"] = stableJson(inspection);
  files["REPORT.md"] = renderReleaseMarkdown(inspection);
  files["manifest.json"] = stableJson(manifest);
  return {
    relativeDirectory: `${input.metadata.id.replace("/", "--")}/${input.metadata.sha}`,
    files,
    inspection,
  };
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function hubModelPath(model: string): string {
  validateModelId(model);
  return model.split("/").map(encodeURIComponent).join("/");
}

async function boundedResponseText(response: Response, maxBytes: number, label: string): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`${label} exceeds ${maxBytes} byte limit`);
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      throw new Error(`${label} exceeds ${maxBytes} byte limit`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function parseMetadata(content: string, requestedModel: string): HuggingFaceModelMetadata {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`Hub metadata is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const object = asObject(parsed);
  if (object === null || object["id"] !== requestedModel) {
    throw new Error(`Hub metadata did not identify requested model ${requestedModel}`);
  }
  const siblings = Array.isArray(object["siblings"])
    ? object["siblings"]
        .map((item) => asObject(item)?.["rfilename"])
        .filter((item): item is string => typeof item === "string")
        .map((rfilename) => ({ rfilename }))
    : [];
  const safetensors = asObject(object["safetensors"]);
  const cardData = asObject(object["cardData"]);
  return {
    id: requestedModel,
    sha: asString(object["sha"]),
    lastModified: asString(object["lastModified"]) ?? undefined,
    private: typeof object["private"] === "boolean" ? object["private"] : undefined,
    gated:
      typeof object["gated"] === "boolean" || typeof object["gated"] === "string"
        ? object["gated"]
        : undefined,
    pipeline_tag: asString(object["pipeline_tag"]) ?? undefined,
    tags: asStrings(object["tags"]),
    siblings,
    safetensors:
      safetensors === null ? undefined : { total: asPositiveNumber(safetensors["total"]) ?? undefined },
    cardData:
      cardData === null
        ? undefined
        : {
            license: asString(cardData["license"]) ?? undefined,
            license_name: asString(cardData["license_name"]) ?? undefined,
          },
  };
}

export async function collectPublicRelease(
  model: string,
  options: { fetchImpl?: FetchLike; hubBaseUrl?: string } = {}
): Promise<ReleaseArchive> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const hubBaseUrl = (options.hubBaseUrl ?? DEFAULT_HUB_BASE_URL).replace(/\/+$/, "");
  const modelPath = hubModelPath(model);
  const metadataResponse = await fetchImpl(`${hubBaseUrl}/api/models/${modelPath}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if ([401, 403, 404].includes(metadataResponse.status)) {
    throw new ReleaseUnavailableError(model, metadataResponse.status);
  }
  if (!metadataResponse.ok) {
    throw new Error(`Hub metadata request failed for ${model}: HTTP ${metadataResponse.status}`);
  }
  const metadata = parseMetadata(
    await boundedResponseText(metadataResponse, METADATA_MAX_BYTES, "Hub metadata"),
    model
  );
  if (metadata.private === true) throw new Error(`refusing private model metadata for ${model}`);
  if (metadata.gated !== false && metadata.gated !== undefined) {
    throw new Error(`refusing gated model release for ${model}`);
  }
  if (metadata.sha === null || !REVISION_RE.test(metadata.sha)) {
    throw new Error(`Hub metadata lacks an immutable revision for ${model}`);
  }

  const availableFiles = new Set((metadata.siblings ?? []).map((item) => item.rfilename));
  if (!availableFiles.has("config.json")) {
    throw new Error(`public release metadata does not list required config.json for ${model}`);
  }
  const selectedFiles = [...ARCHIVABLE_SOURCE_FILES].filter((name) => availableFiles.has(name)).sort();
  const sourceFiles: Record<string, string> = {};
  for (const name of selectedFiles) {
    const response = await fetchImpl(`${hubBaseUrl}/${modelPath}/raw/${metadata.sha}/${name}`, {
      headers: { accept: name.endsWith(".json") ? "application/json" : "text/plain" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      throw new Error(`pinned control-file request failed for ${name}: HTTP ${response.status}`);
    }
    sourceFiles[name] = await boundedResponseText(response, CONTROL_FILE_MAX_BYTES, name);
  }
  return buildReleaseArchive({ metadata, sourceFiles });
}

function assertArchiveFileName(name: string): void {
  if (name.length === 0 || name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
    throw new Error(`unsafe archive file name: ${name}`);
  }
}

export function writeReleaseArchive(root: string, archive: ReleaseArchive): string[] {
  const resolvedRoot = resolve(root);
  const targetDirectory = resolve(resolvedRoot, archive.relativeDirectory);
  if (targetDirectory !== resolvedRoot && !targetDirectory.startsWith(`${resolvedRoot}${sep}`)) {
    throw new Error(`release archive escapes output root: ${archive.relativeDirectory}`);
  }
  mkdirSync(targetDirectory, { recursive: true });
  const written: string[] = [];
  for (const [name, content] of Object.entries(archive.files).sort(([left], [right]) => left.localeCompare(right))) {
    assertArchiveFileName(name);
    const target = resolve(targetDirectory, name);
    if (existsSync(target)) {
      if (readFileSync(target, "utf8") !== content) {
        throw new Error(`immutable release archive conflict at ${target}`);
      }
      written.push(target);
      continue;
    }
    const temporary = resolve(targetDirectory, `.${name}.${process.pid}.${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
      renameSync(temporary, target);
    } catch (error) {
      try {
        unlinkSync(temporary);
      } catch {
        // The temporary file may not have been created; preserve the original error.
      }
      throw error;
    }
    written.push(target);
  }
  return written;
}
