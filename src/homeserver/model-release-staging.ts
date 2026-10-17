import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

type JsonObject = Record<string, unknown>;

export interface HuggingFaceStageMetadata {
  id: string;
  sha: string | null;
  private?: boolean;
  gated?: boolean | string;
}

export interface HuggingFaceTreeEntry {
  type?: string;
  path: string;
  size?: number;
  lfs?: { oid?: string; size?: number };
}

export interface ModelStageFile {
  path: string;
  size: number;
  kind: "control" | "weight";
  expectedSha256: string | null;
  url: string;
}

export interface ModelStagePlan {
  schemaVersion: 1;
  model: string;
  revision: string;
  files: ModelStageFile[];
  totalBytes: number;
}

export interface ModelStageArgs {
  model: string;
  revision: string;
  outRoot: string;
  minFreeAfterBytes: number;
}

export interface ModelStageResult {
  status: "staged" | "already-staged";
  directory: string;
  manifestPath: string;
  totalBytes: number;
}

interface BuildPlanInput {
  model: string;
  revision: string;
  metadata: HuggingFaceStageMetadata;
  tree: HuggingFaceTreeEntry[];
  weightIndex?: string | null;
}

interface StageDependencies {
  availableBytes?: (path: string) => number;
  download?: (file: ModelStageFile, destination: string) => Promise<void>;
  minFreeAfterBytes?: number;
}

interface StageManifestFile {
  path: string;
  size: number;
  sha256: string;
  kind: "control" | "weight";
}

interface StageManifest {
  schemaVersion: 1;
  model: string;
  revision: string;
  totalBytes: number;
  files: StageManifestFile[];
}

const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const REVISION_RE = /^[a-f0-9]{40}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const GIB = 1024 ** 3;
const DEFAULT_MODEL = "Qwen/Qwen3.8-27B";
const DEFAULT_FREE_RESERVE = 128 * GIB;
const HUB_BASE = "https://huggingface.co";
const MAX_METADATA_BYTES = 4 * 1024 * 1024;
const MAX_TREE_BYTES = 32 * 1024 * 1024;
const MAX_INDEX_BYTES = 64 * 1024 * 1024;
const TREE_PAGE_LIMIT = 100;
const MAX_TREE_PAGES = 100;
const MAX_TREE_ENTRIES = 10_000;
const CONTROL_FILES = new Set([
  "added_tokens.json",
  "chat_template.jinja",
  "config.json",
  "generation_config.json",
  "merges.txt",
  "model.safetensors.index.json",
  "preprocessor_config.json",
  "processor_config.json",
  "special_tokens_map.json",
  "tokenizer.json",
  "tokenizer.model",
  "tokenizer_config.json",
  "video_preprocessor_config.json",
  "vocab.json",
]);
const TOKENIZER_FILES = new Set([
  "merges.txt",
  "tokenizer.json",
  "tokenizer.model",
  "tokenizer_config.json",
  "vocab.json",
]);

function requiredValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function safeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function validateModel(model: string): void {
  if (!MODEL_ID_RE.test(model)) throw new Error(`model must use owner/model form, got "${model}"`);
}

function validateRevision(revision: string): void {
  if (!REVISION_RE.test(revision)) {
    throw new Error("--revision must be an immutable lowercase 40-character Git revision");
  }
}

export function parseModelStageArgs(argv: string[]): ModelStageArgs {
  let model = DEFAULT_MODEL;
  let revision: string | null = null;
  let outRoot: string | null = null;
  let minFreeAfterBytes = DEFAULT_FREE_RESERVE;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!;
    if (argument === "--model") {
      model = requiredValue(argv, index, argument);
      index++;
    } else if (argument === "--revision") {
      revision = requiredValue(argv, index, argument);
      index++;
    } else if (argument === "--out-root") {
      outRoot = requiredValue(argv, index, argument);
      index++;
    } else if (argument === "--min-free-after-gib") {
      const raw = requiredValue(argv, index, argument);
      const gib = Number(raw);
      if (!Number.isSafeInteger(gib) || gib < 0) {
        throw new Error("--min-free-after-gib must be a non-negative integer");
      }
      minFreeAfterBytes = gib * GIB;
      if (!Number.isSafeInteger(minFreeAfterBytes)) throw new Error("free-space reserve is too large");
      index++;
    } else {
      throw new Error(`unrecognized argument: ${argument}`);
    }
  }
  validateModel(model);
  if (revision === null) throw new Error("--revision is required");
  validateRevision(revision);
  if (outRoot === null || outRoot.trim().length === 0) throw new Error("--out-root is required");
  return { model, revision, outRoot, minFreeAfterBytes };
}

function assertSafeRelativePath(path: string): void {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    throw new Error(`unsafe artifact path: ${path}`);
  }
}

function artifactUrl(model: string, revision: string, path: string): string {
  const encodedModel = model.split("/").map(encodeURIComponent).join("/");
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  return `${HUB_BASE}/${encodedModel}/resolve/${revision}/${encodedPath}`;
}

function treeMap(entries: HuggingFaceTreeEntry[]): Map<string, HuggingFaceTreeEntry> {
  const map = new Map<string, HuggingFaceTreeEntry>();
  for (const entry of entries) {
    if (entry.type !== undefined && entry.type !== "file") continue;
    assertSafeRelativePath(entry.path);
    if (map.has(entry.path)) throw new Error(`duplicate tree entry: ${entry.path}`);
    map.set(entry.path, entry);
  }
  return map;
}

function referencedShards(weightIndex: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(weightIndex);
  } catch (error) {
    throw new Error(`invalid model.safetensors.index.json: ${error instanceof Error ? error.message : String(error)}`);
  }
  const weightMap = asObject(asObject(parsed)?.["weight_map"]);
  if (weightMap === null || Object.keys(weightMap).length === 0) {
    throw new Error("model.safetensors.index.json has no non-empty weight_map");
  }
  const shards = new Set<string>();
  for (const value of Object.values(weightMap)) {
    if (typeof value !== "string") throw new Error("weight_map shard names must be strings");
    assertSafeRelativePath(value);
    if (!value.endsWith(".safetensors")) throw new Error(`unsafe non-safetensors shard: ${value}`);
    shards.add(value);
  }
  return [...shards].sort();
}

function fileFromTree(
  entry: HuggingFaceTreeEntry,
  model: string,
  revision: string,
  kind: "control" | "weight"
): ModelStageFile {
  const size = safeInteger(entry.size, `${entry.path} size`);
  let expectedSha256: string | null = null;
  if (kind === "weight") {
    const lfsSize = safeInteger(entry.lfs?.size, `${entry.path} LFS size`);
    if (lfsSize !== size) throw new Error(`${entry.path} tree and LFS size differ`);
    const oid = entry.lfs?.oid;
    if (typeof oid !== "string" || !SHA256_RE.test(oid)) {
      throw new Error(`${entry.path} lacks a valid LFS SHA-256 oid`);
    }
    expectedSha256 = oid;
  } else if (entry.lfs !== undefined) {
    const lfsSize = safeInteger(entry.lfs.size, `${entry.path} LFS size`);
    if (lfsSize !== size) throw new Error(`${entry.path} tree and LFS size differ`);
    const oid = entry.lfs.oid;
    if (typeof oid !== "string" || !SHA256_RE.test(oid)) {
      throw new Error(`${entry.path} lacks a valid LFS SHA-256 oid`);
    }
    expectedSha256 = oid;
  }
  return {
    path: entry.path,
    size,
    kind,
    expectedSha256,
    url: artifactUrl(model, revision, entry.path),
  };
}

export function buildModelStagePlan(input: BuildPlanInput): ModelStagePlan {
  validateModel(input.model);
  validateRevision(input.revision);
  if (input.metadata.id !== input.model) {
    throw new Error(`metadata model mismatch: expected ${input.model}, got ${input.metadata.id}`);
  }
  if (input.metadata.sha !== input.revision) {
    throw new Error(`metadata revision mismatch: expected ${input.revision}, got ${input.metadata.sha ?? "null"}`);
  }
  if (input.metadata.private !== false || input.metadata.gated !== false) {
    throw new Error("model must be explicitly public and ungated before staging");
  }

  const entries = treeMap(input.tree);
  if (!entries.has("config.json")) throw new Error("release tree lacks required config.json");
  if (![...TOKENIZER_FILES].some((path) => entries.has(path))) {
    throw new Error("release tree lacks a recognized tokenizer artifact");
  }

  const selected: ModelStageFile[] = [];
  for (const path of [...CONTROL_FILES].sort()) {
    const entry = entries.get(path);
    if (entry !== undefined) selected.push(fileFromTree(entry, input.model, input.revision, "control"));
  }

  const indexEntry = entries.get("model.safetensors.index.json");
  const singleEntry = entries.get("model.safetensors");
  if (indexEntry !== undefined && singleEntry !== undefined) {
    throw new Error("release tree ambiguously contains both indexed and single-file weights");
  }
  if (indexEntry !== undefined) {
    if (input.weightIndex === undefined || input.weightIndex === null) {
      throw new Error("indexed release requires the pinned model.safetensors.index.json content");
    }
    for (const path of referencedShards(input.weightIndex)) {
      const entry = entries.get(path);
      if (entry === undefined) throw new Error(`release tree is missing shard referenced by index: ${path}`);
      selected.push(fileFromTree(entry, input.model, input.revision, "weight"));
    }
  } else if (singleEntry !== undefined) {
    selected.push(fileFromTree(singleEntry, input.model, input.revision, "weight"));
  } else {
    throw new Error("release tree has neither model.safetensors nor model.safetensors.index.json");
  }

  selected.sort((left, right) => left.path.localeCompare(right.path));
  const uniquePaths = new Set(selected.map((file) => file.path));
  if (uniquePaths.size !== selected.length) throw new Error("stage plan contains duplicate files");
  const totalBytes = selected.reduce((sum, file) => {
    const total = sum + file.size;
    if (!Number.isSafeInteger(total)) throw new Error("artifact total exceeds safe integer range");
    return total;
  }, 0);
  return { schemaVersion: 1, model: input.model, revision: input.revision, files: selected, totalBytes };
}

async function boundedResponse(response: Response, maximumBytes: number, label: string): Promise<string> {
  if (!response.ok) throw new Error(`${label} request failed with HTTP ${response.status}`);
  const length = response.headers.get("content-length");
  if (length !== null && Number(length) > maximumBytes) throw new Error(`${label} exceeds byte limit`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maximumBytes) throw new Error(`${label} exceeds byte limit`);
  return new TextDecoder().decode(bytes);
}

function nextTreePage(linkHeader: string | null): string | null {
  if (linkHeader === null) return null;
  for (const part of linkHeader.split(",")) {
    const match = part.match(/^\s*<([^>]+)>\s*;\s*rel="?next"?\s*$/i);
    if (match) return match[1]!;
  }
  return null;
}

function validateTreePageUrl(urlText: string, encodedModel: string, revision: string): string {
  const url = new URL(urlText);
  const expectedPath = `/api/models/${encodedModel}/tree/${revision}`;
  if (
    url.origin !== HUB_BASE ||
    url.pathname !== expectedPath ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    url.searchParams.get("recursive") !== "true" ||
    url.searchParams.get("expand") !== "true" ||
    url.searchParams.get("limit") !== String(TREE_PAGE_LIMIT)
  ) {
    throw new Error(`unsafe release-tree pagination URL: ${urlText}`);
  }
  for (const key of url.searchParams.keys()) {
    if (!["recursive", "expand", "limit", "cursor"].includes(key)) {
      throw new Error(`unexpected release-tree pagination parameter: ${key}`);
    }
  }
  return url.href;
}

export async function collectPublicStagePlan(
  model: string,
  revision: string,
  fetchImpl: typeof fetch = fetch
): Promise<ModelStagePlan> {
  validateModel(model);
  validateRevision(revision);
  const encodedModel = model.split("/").map(encodeURIComponent).join("/");
  const metadataResponse = await fetchImpl(`${HUB_BASE}/api/models/${encodedModel}`, {
    headers: { accept: "application/json" },
  });
  const metadata = JSON.parse(
    await boundedResponse(metadataResponse, MAX_METADATA_BYTES, "model metadata")
  ) as HuggingFaceStageMetadata;
  let treePageUrl: string | null = validateTreePageUrl(
    `${HUB_BASE}/api/models/${encodedModel}/tree/${revision}?recursive=true&expand=true&limit=${TREE_PAGE_LIMIT}`,
    encodedModel,
    revision
  );
  const seenPages = new Set<string>();
  const typedTree: HuggingFaceTreeEntry[] = [];
  while (treePageUrl !== null) {
    if (seenPages.has(treePageUrl)) throw new Error("release-tree pagination cycle detected");
    if (seenPages.size >= MAX_TREE_PAGES) throw new Error("release tree exceeds page limit");
    seenPages.add(treePageUrl);
    const treeResponse = await fetchImpl(treePageUrl, { headers: { accept: "application/json" } });
    const tree = JSON.parse(await boundedResponse(treeResponse, MAX_TREE_BYTES, "release tree")) as unknown;
    if (!Array.isArray(tree)) throw new Error("release tree response must be an array");
    typedTree.push(...(tree as HuggingFaceTreeEntry[]));
    if (typedTree.length > MAX_TREE_ENTRIES) throw new Error("release tree exceeds entry limit");
    const next = nextTreePage(treeResponse.headers.get("link"));
    treePageUrl = next === null ? null : validateTreePageUrl(next, encodedModel, revision);
  }
  let weightIndex: string | null = null;
  if (typedTree.some((entry) => entry.path === "model.safetensors.index.json")) {
    const indexResponse = await fetchImpl(
      artifactUrl(model, revision, "model.safetensors.index.json"),
      { headers: { accept: "application/json" }, redirect: "follow" }
    );
    weightIndex = await boundedResponse(indexResponse, MAX_INDEX_BYTES, "weight index");
  }
  return buildModelStagePlan({ model, revision, metadata, tree: typedTree, weightIndex });
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolvePromise);
  });
  return hash.digest("hex");
}

function defaultAvailableBytes(path: string): number {
  const stats = statfsSync(path, { bigint: true });
  const bytes = stats.bavail * stats.bsize;
  if (bytes > BigInt(Number.MAX_SAFE_INTEGER)) return Number.MAX_SAFE_INTEGER;
  return Number(bytes);
}

function defaultDownload(file: ModelStageFile, destination: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      "curl",
      [
        "--fail",
        "--location",
        "--proto",
        "=https",
        "--proto-redir",
        "=https",
        "--retry",
        "5",
        "--retry-all-errors",
        "--continue-at",
        "-",
        "--output",
        destination,
        file.url,
      ],
      { stdio: ["ignore", "inherit", "inherit"] }
    );
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`curl failed for ${file.path} (${signal ?? `exit ${code ?? "unknown"}`})`));
    });
  });
}

function ensureDirectoryWithoutSymlinks(root: string, relativePath: string): string {
  assertSafeRelativePath(relativePath);
  let current = root;
  for (const part of relativePath.split("/")) {
    current = join(current, part);
    if (existsSync(current)) {
      const info = lstatSync(current);
      if (info.isSymbolicLink()) throw new Error(`refusing symbolic link in staging path: ${current}`);
      if (!info.isDirectory()) throw new Error(`staging path component is not a directory: ${current}`);
    } else {
      mkdirSync(current);
    }
  }
  return current;
}

function destinationFor(incoming: string, path: string): string {
  assertSafeRelativePath(path);
  const destination = resolve(incoming, path);
  if (!destination.startsWith(`${resolve(incoming)}${sep}`)) throw new Error(`unsafe artifact path: ${path}`);
  const parentRelative = dirname(path);
  if (parentRelative !== ".") ensureDirectoryWithoutSymlinks(incoming, parentRelative);
  if (existsSync(destination) && lstatSync(destination).isSymbolicLink()) {
    throw new Error(`refusing symbolic link at artifact destination: ${destination}`);
  }
  return destination;
}

async function verifyFile(file: ModelStageFile, path: string): Promise<StageManifestFile> {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${file.path} is not a regular file`);
  if (info.size !== file.size) {
    throw new Error(`${file.path} size mismatch: expected ${file.size}, got ${info.size}`);
  }
  const sha256 = await sha256File(path);
  if (file.expectedSha256 !== null && sha256 !== file.expectedSha256) {
    throw new Error(`${file.path} SHA-256 mismatch: expected ${file.expectedSha256}, got ${sha256}`);
  }
  return { path: file.path, size: file.size, sha256, kind: file.kind };
}

function stableManifest(manifest: StageManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function validateStagePlan(plan: ModelStagePlan): void {
  if (plan.schemaVersion !== 1) throw new Error("unsupported stage-plan schema");
  validateModel(plan.model);
  validateRevision(plan.revision);
  let totalBytes = 0;
  let previousPath: string | null = null;
  for (const file of plan.files) {
    assertSafeRelativePath(file.path);
    safeInteger(file.size, `${file.path} size`);
    if (file.kind !== "control" && file.kind !== "weight") {
      throw new Error(`unsupported stage artifact kind: ${String(file.kind)}`);
    }
    if (file.expectedSha256 !== null && !SHA256_RE.test(file.expectedSha256)) {
      throw new Error(`${file.path} has an invalid expected SHA-256`);
    }
    if (file.kind === "weight" && file.expectedSha256 === null) {
      throw new Error(`${file.path} weight lacks an expected SHA-256`);
    }
    if (file.url !== artifactUrl(plan.model, plan.revision, file.path)) {
      throw new Error(`${file.path} source URL is not pinned to the requested official revision`);
    }
    if (previousPath !== null && previousPath.localeCompare(file.path) >= 0) {
      throw new Error("stage-plan file paths must be unique and sorted");
    }
    previousPath = file.path;
    totalBytes += file.size;
    if (!Number.isSafeInteger(totalBytes)) throw new Error("artifact total exceeds safe integer range");
  }
  if (totalBytes !== plan.totalBytes) {
    throw new Error(`stage-plan byte total mismatch: expected ${totalBytes}, got ${plan.totalBytes}`);
  }
}

function existingDestinationFor(base: string, path: string): string {
  assertSafeRelativePath(path);
  const destination = resolve(base, path);
  if (!destination.startsWith(`${resolve(base)}${sep}`)) throw new Error(`unsafe artifact path: ${path}`);
  let current = base;
  for (const part of dirname(path).split("/")) {
    if (part === ".") continue;
    current = join(current, part);
    const info = lstatSync(current);
    if (info.isSymbolicLink()) throw new Error(`refusing symbolic link in staged path: ${current}`);
    if (!info.isDirectory()) throw new Error(`staged path component is not a directory: ${current}`);
  }
  const info = lstatSync(destination);
  if (info.isSymbolicLink()) throw new Error(`refusing symbolic link at staged artifact: ${destination}`);
  return destination;
}

async function verifyPublished(plan: ModelStagePlan, finalDirectory: string): Promise<StageManifest> {
  if (lstatSync(finalDirectory).isSymbolicLink()) throw new Error("published model directory is a symbolic link");
  const manifestPath = join(finalDirectory, "stage-manifest.json");
  const recorded = JSON.parse(readFileSync(manifestPath, "utf8")) as StageManifest;
  if (
    recorded.schemaVersion !== 1 ||
    recorded.model !== plan.model ||
    recorded.revision !== plan.revision ||
    recorded.totalBytes !== plan.totalBytes ||
    !Array.isArray(recorded.files)
  ) {
    throw new Error("existing staged manifest does not match the requested release");
  }
  const expectedPaths = plan.files.map((file) => file.path);
  const recordedPaths = recorded.files.map((file) => file.path);
  if (JSON.stringify(recordedPaths) !== JSON.stringify(expectedPaths)) {
    throw new Error("existing staged manifest file set does not match the requested release");
  }
  for (let index = 0; index < plan.files.length; index++) {
    const verified = await verifyFile(
      plan.files[index]!,
      existingDestinationFor(finalDirectory, plan.files[index]!.path)
    );
    const prior = recorded.files[index]!;
    if (
      prior.path !== verified.path ||
      prior.size !== verified.size ||
      prior.kind !== verified.kind ||
      prior.sha256 !== verified.sha256
    ) {
      throw new Error(`existing staged artifact differs from manifest: ${verified.path}`);
    }
  }
  return recorded;
}

export async function stageModelRelease(
  plan: ModelStagePlan,
  outRoot: string,
  dependencies: StageDependencies = {}
): Promise<ModelStageResult> {
  validateStagePlan(plan);
  if (outRoot.trim().length === 0) throw new Error("staging output root must not be empty");
  mkdirSync(outRoot, { recursive: true });
  if (lstatSync(outRoot).isSymbolicLink()) throw new Error("staging output root must not be a symbolic link");
  const canonicalRoot = realpathSync(outRoot);
  const modelDirectory = ensureDirectoryWithoutSymlinks(
    canonicalRoot,
    plan.model.replace("/", "--")
  );
  const finalDirectory = join(modelDirectory, plan.revision);
  const manifestPath = join(finalDirectory, "stage-manifest.json");
  if (existsSync(finalDirectory)) {
    await verifyPublished(plan, finalDirectory);
    return { status: "already-staged", directory: finalDirectory, manifestPath, totalBytes: plan.totalBytes };
  }

  const availableBytes = (dependencies.availableBytes ?? defaultAvailableBytes)(canonicalRoot);
  const reserve = dependencies.minFreeAfterBytes ?? DEFAULT_FREE_RESERVE;
  if (!Number.isSafeInteger(availableBytes) || availableBytes < 0) {
    throw new Error("available disk bytes must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(reserve) || reserve < 0) {
    throw new Error("free-space reserve must be a non-negative safe integer");
  }
  if (plan.totalBytes > availableBytes - reserve) {
    throw new Error(
      `staging would violate free-space reserve: need ${plan.totalBytes} bytes with ${reserve} bytes reserved, have ${availableBytes}`
    );
  }

  const incoming = ensureDirectoryWithoutSymlinks(modelDirectory, `.incoming-${plan.revision}`);
  const download = dependencies.download ?? defaultDownload;
  const incomingManifest = join(incoming, "stage-manifest.json");
  if (existsSync(incomingManifest)) {
    const info = lstatSync(incomingManifest);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error("interrupted stage manifest is not a regular file");
    }
    unlinkSync(incomingManifest);
  }
  const manifestFiles: StageManifestFile[] = [];
  for (const file of plan.files) {
    const destination = destinationFor(incoming, file.path);
    let verified: StageManifestFile | null = null;
    if (existsSync(destination) && file.expectedSha256 !== null) {
      try {
        verified = await verifyFile(file, destination);
      } catch {
        const size = statSync(destination).size;
        if (size >= file.size) unlinkSync(destination);
      }
    } else if (existsSync(destination)) {
      unlinkSync(destination);
    }
    if (verified === null) {
      await download(file, destination);
      try {
        verified = await verifyFile(file, destination);
      } catch (error) {
        if (file.expectedSha256 === null || !existsSync(destination)) throw error;
        unlinkSync(destination);
        await download(file, destination);
        verified = await verifyFile(file, destination);
      }
    }
    manifestFiles.push(verified);
  }

  const manifest: StageManifest = {
    schemaVersion: 1,
    model: plan.model,
    revision: plan.revision,
    totalBytes: plan.totalBytes,
    files: manifestFiles,
  };
  writeFileSync(incomingManifest, stableManifest(manifest), { flag: "wx" });
  try {
    renameSync(incoming, finalDirectory);
  } catch (error) {
    if (!existsSync(finalDirectory)) throw error;
    await verifyPublished(plan, finalDirectory);
  }
  return { status: "staged", directory: finalDirectory, manifestPath, totalBytes: plan.totalBytes };
}
