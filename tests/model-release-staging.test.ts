import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildModelStagePlan,
  collectPublicStagePlan,
  parseModelStageArgs,
  stageModelRelease,
  type HuggingFaceTreeEntry,
  type ModelStagePlan,
} from "../src/homeserver/model-release-staging.js";

const REVISION = "0123456789abcdef0123456789abcdef01234567";
const CONFIG = Buffer.from('{"model_type":"qwen3_5_text"}\n');
const TOKENIZER = Buffer.from('{"tokenizer_class":"Qwen2Tokenizer"}\n');
const INDEX = Buffer.from(
  JSON.stringify({
    metadata: { total_size: 7 },
    weight_map: {
      "model.embed_tokens.weight": "model-00001-of-00002.safetensors",
      "model.layers.0.weight": "model-00002-of-00002.safetensors",
    },
  }) + "\n"
);
const SHARD_A = Buffer.from("abc");
const SHARD_B = Buffer.from("defg");

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function lfs(path: string, content: Buffer): HuggingFaceTreeEntry {
  return {
    type: "file",
    path,
    size: content.length,
    lfs: { oid: sha256(content), size: content.length },
  };
}

function tree(): HuggingFaceTreeEntry[] {
  return [
    { type: "file", path: "config.json", size: CONFIG.length },
    { type: "file", path: "tokenizer_config.json", size: TOKENIZER.length },
    { type: "file", path: "model.safetensors.index.json", size: INDEX.length },
    lfs("model-00001-of-00002.safetensors", SHARD_A),
    lfs("model-00002-of-00002.safetensors", SHARD_B),
  ];
}

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("parseModelStageArgs", () => {
  it("requires an immutable revision and explicit output root", () => {
    expect(() => parseModelStageArgs([])).toThrow(/--revision/);
    expect(() => parseModelStageArgs(["--revision", REVISION])).toThrow(/--out-root/);
    expect(
      parseModelStageArgs([
        "--model",
        "Qwen/Qwen3.8-27B",
        "--revision",
        REVISION,
        "--out-root",
        "/models/releases",
        "--min-free-after-gib",
        "96",
      ])
    ).toEqual({
      model: "Qwen/Qwen3.8-27B",
      revision: REVISION,
      outRoot: "/models/releases",
      minFreeAfterBytes: 96 * 1024 ** 3,
    });
    expect(() =>
      parseModelStageArgs([
        "--revision",
        "main",
        "--out-root",
        "/models/releases",
      ])
    ).toThrow(/40-character/);
  });
});

describe("buildModelStagePlan", () => {
  it("selects only control files and the exact indexed LFS shards", () => {
    const plan = buildModelStagePlan({
      model: "Qwen/Qwen3.8-27B",
      revision: REVISION,
      metadata: { id: "Qwen/Qwen3.8-27B", sha: REVISION, private: false, gated: false },
      tree: [...tree(), { type: "file", path: "modeling_qwen.py", size: 123 }],
      weightIndex: INDEX.toString("utf8"),
    });

    expect(plan.files.map((file) => file.path)).toEqual([
      "config.json",
      "model-00001-of-00002.safetensors",
      "model-00002-of-00002.safetensors",
      "model.safetensors.index.json",
      "tokenizer_config.json",
    ]);
    expect(plan.files.filter((file) => file.kind === "weight")).toHaveLength(2);
    expect(plan.totalBytes).toBe(CONFIG.length + TOKENIZER.length + INDEX.length + 7);
  });

  it("rejects unpinned/private metadata, unsafe index paths, missing shards, and malformed LFS proofs", () => {
    const base = {
      model: "Qwen/Qwen3.8-27B",
      revision: REVISION,
      metadata: { id: "Qwen/Qwen3.8-27B", sha: REVISION, private: false, gated: false },
      tree: tree(),
      weightIndex: INDEX.toString("utf8"),
    };
    expect(() => buildModelStagePlan({ ...base, metadata: { ...base.metadata, private: true } })).toThrow(
      /public and ungated/
    );
    expect(() => buildModelStagePlan({ ...base, metadata: { ...base.metadata, sha: "f".repeat(40) } })).toThrow(
      /revision mismatch/
    );
    expect(() =>
      buildModelStagePlan({
        ...base,
        weightIndex: JSON.stringify({ weight_map: { tensor: "../escape.safetensors" } }),
      })
    ).toThrow(/unsafe/);
    expect(() => buildModelStagePlan({ ...base, tree: tree().slice(0, -1) })).toThrow(/missing shard/);
    const malformed = tree();
    malformed[3] = { ...malformed[3]!, lfs: { oid: "bad", size: SHARD_A.length } };
    expect(() => buildModelStagePlan({ ...base, tree: malformed })).toThrow(/LFS SHA-256/);
  });
});

describe("collectPublicStagePlan", () => {
  it("collects metadata, tree, and index only from the exact pinned revision", async () => {
    let treePage = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/api/models/Qwen/Qwen3.8-27B")) {
        return new Response(
          JSON.stringify({ id: "Qwen/Qwen3.8-27B", sha: REVISION, private: false, gated: false }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url.includes(`/tree/${REVISION}?`)) {
        treePage++;
        const headers =
          treePage === 1
            ? {
                "content-type": "application/json",
                link: `<https://huggingface.co/api/models/Qwen/Qwen3.8-27B/tree/${REVISION}?expand=true&recursive=true&limit=100&cursor=next>; rel="next"`,
              }
            : { "content-type": "application/json" };
        return new Response(JSON.stringify(treePage === 1 ? tree().slice(0, 3) : tree().slice(3)), {
          status: 200,
          headers,
        });
      }
      if (url.includes(`/resolve/${REVISION}/model.safetensors.index.json`)) {
        return new Response(INDEX, { status: 200 });
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    const plan = await collectPublicStagePlan("Qwen/Qwen3.8-27B", REVISION, fetchImpl as typeof fetch);
    expect(plan.revision).toBe(REVISION);
    expect(plan.files.filter((file) => file.kind === "weight")).toHaveLength(2);
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toHaveLength(4);
    expect(fetchImpl.mock.calls.every(([url]) => !String(url).includes("/resolve/main/"))).toBe(true);
  });

  it("rejects an untrusted next-page URL instead of following it", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/api/models/Qwen/Qwen3.8-27B")) {
        return new Response(
          JSON.stringify({ id: "Qwen/Qwen3.8-27B", sha: REVISION, private: false, gated: false }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify(tree()), {
        status: 200,
        headers: { link: '<https://evil.example/api/next>; rel="next"' },
      });
    });
    await expect(
      collectPublicStagePlan("Qwen/Qwen3.8-27B", REVISION, fetchImpl as typeof fetch)
    ).rejects.toThrow(/unsafe release-tree pagination URL/);
  });
});

describe("stageModelRelease", () => {
  function plan(): ModelStagePlan {
    return buildModelStagePlan({
      model: "Qwen/Qwen3.8-27B",
      revision: REVISION,
      metadata: { id: "Qwen/Qwen3.8-27B", sha: REVISION, private: false, gated: false },
      tree: tree(),
      weightIndex: INDEX.toString("utf8"),
    });
  }

  it("verifies every artifact and atomically publishes a deterministic manifest", async () => {
    const root = mkdtempSync(join(tmpdir(), "model-stage-"));
    roots.push(root);
    const content = new Map<string, Buffer>([
      ["config.json", CONFIG],
      ["tokenizer_config.json", TOKENIZER],
      ["model.safetensors.index.json", INDEX],
      ["model-00001-of-00002.safetensors", SHARD_A],
      ["model-00002-of-00002.safetensors", SHARD_B],
    ]);
    const download = vi.fn(async (file: { path: string }, destination: string) => {
      writeFileSync(destination, content.get(file.path)!);
    });

    const result = await stageModelRelease(plan(), root, {
      availableBytes: () => 10_000,
      download,
      minFreeAfterBytes: 1_000,
    });

    expect(result.status).toBe("staged");
    expect(download).toHaveBeenCalledTimes(5);
    const manifest = JSON.parse(readFileSync(join(result.directory, "stage-manifest.json"), "utf8"));
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      model: "Qwen/Qwen3.8-27B",
      revision: REVISION,
      totalBytes: plan().totalBytes,
    });
    expect(manifest.files).toHaveLength(5);
    expect(manifest.files.every((file: { sha256: string }) => /^[a-f0-9]{64}$/.test(file.sha256))).toBe(true);
    expect(readFileSync(join(result.directory, "model-00002-of-00002.safetensors"))).toEqual(SHARD_B);

    const second = await stageModelRelease(plan(), root, {
      availableBytes: () => 10_000,
      download,
      minFreeAfterBytes: 1_000,
    });
    expect(second.status).toBe("already-staged");
    expect(download).toHaveBeenCalledTimes(5);
  });

  it("fails before downloading when the reserved free-space floor cannot be preserved", async () => {
    const root = mkdtempSync(join(tmpdir(), "model-stage-"));
    roots.push(root);
    const download = vi.fn();
    await expect(
      stageModelRelease(plan(), root, {
        availableBytes: () => plan().totalBytes + 99,
        download,
        minFreeAfterBytes: 100,
      })
    ).rejects.toThrow(/free-space reserve/);
    expect(download).not.toHaveBeenCalled();
  });

  it("rejects tampered totals and artifact source URLs before disk or network work", async () => {
    const root = mkdtempSync(join(tmpdir(), "model-stage-"));
    roots.push(root);
    const tamperedTotal = plan();
    tamperedTotal.totalBytes--;
    const download = vi.fn();
    await expect(stageModelRelease(tamperedTotal, root, { download })).rejects.toThrow(/byte total mismatch/);
    const tamperedUrl = plan();
    tamperedUrl.files[0] = { ...tamperedUrl.files[0]!, url: "https://evil.example/artifact" };
    await expect(stageModelRelease(tamperedUrl, root, { download })).rejects.toThrow(/not pinned/);
    expect(download).not.toHaveBeenCalled();
  });

  it("rejects a corrupted LFS shard and never publishes the final directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "model-stage-"));
    roots.push(root);
    const content = new Map<string, Buffer>([
      ["config.json", CONFIG],
      ["tokenizer_config.json", TOKENIZER],
      ["model.safetensors.index.json", INDEX],
      ["model-00001-of-00002.safetensors", Buffer.from("BAD")],
      ["model-00002-of-00002.safetensors", SHARD_B],
    ]);
    await expect(
      stageModelRelease(plan(), root, {
        availableBytes: () => 10_000,
        minFreeAfterBytes: 1_000,
        download: async (file, destination) => writeFileSync(destination, content.get(file.path)!),
      })
    ).rejects.toThrow(/SHA-256 mismatch/);
    expect(() => readFileSync(join(root, "Qwen--Qwen3.8-27B", REVISION, "stage-manifest.json"))).toThrow();
  });

  it("rejects symlinks inside an interrupted incoming directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "model-stage-"));
    roots.push(root);
    const incoming = join(root, "Qwen--Qwen3.8-27B", `.incoming-${REVISION}`);
    mkdirSync(incoming, { recursive: true });
    const target = join(root, "outside");
    mkdirSync(target);
    await import("node:fs").then(({ symlinkSync }) => symlinkSync(target, join(incoming, "nested")));
    const modified = plan();
    modified.files = [
      ...modified.files,
      {
        path: "nested/config.json",
        size: CONFIG.length,
        kind: "control",
        expectedSha256: null,
        url: `https://huggingface.co/Qwen/Qwen3.8-27B/resolve/${REVISION}/nested/config.json`,
      },
    ].sort((a, b) => a.path.localeCompare(b.path));
    modified.totalBytes += CONFIG.length;
    const content = new Map<string, Buffer>([
      ["config.json", CONFIG],
      ["tokenizer_config.json", TOKENIZER],
      ["model.safetensors.index.json", INDEX],
      ["model-00001-of-00002.safetensors", SHARD_A],
      ["model-00002-of-00002.safetensors", SHARD_B],
    ]);
    await expect(
      stageModelRelease(modified, root, {
        availableBytes: () => 10_000,
        minFreeAfterBytes: 1_000,
        download: async (file, destination) => writeFileSync(destination, content.get(file.path)!),
      })
    ).rejects.toThrow(/symbolic link/);
  });
});
