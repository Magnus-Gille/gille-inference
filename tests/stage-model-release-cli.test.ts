import { describe, expect, it, vi } from "vitest";

import { runModelReleaseStaging } from "../scripts/stage-model-release.js";
import type { ModelStagePlan } from "../src/homeserver/model-release-staging.js";

const REVISION = "0123456789abcdef0123456789abcdef01234567";
const PLAN: ModelStagePlan = {
  schemaVersion: 1,
  model: "Qwen/Qwen3.8-27B",
  revision: REVISION,
  files: [
    {
      path: "model.safetensors",
      size: 123,
      kind: "weight",
      expectedSha256: "a".repeat(64),
      url: `https://huggingface.co/Qwen/Qwen3.8-27B/resolve/${REVISION}/model.safetensors`,
    },
  ],
  totalBytes: 123,
};

describe("runModelReleaseStaging", () => {
  it("passes the exact revision and reserve through and emits one machine-readable result", async () => {
    const collect = vi.fn(async () => PLAN);
    const stage = vi.fn(async () => ({
      status: "staged" as const,
      directory: `/models/Qwen--Qwen3.8-27B/${REVISION}`,
      manifestPath: `/models/Qwen--Qwen3.8-27B/${REVISION}/stage-manifest.json`,
      totalBytes: 123,
    }));
    const lines: string[] = [];
    const code = await runModelReleaseStaging(
      [
        "--revision",
        REVISION,
        "--out-root",
        "/models",
        "--min-free-after-gib",
        "64",
      ],
      { collect, stage, stdout: (line) => lines.push(line), stderr: vi.fn() }
    );
    expect(code).toBe(0);
    expect(collect).toHaveBeenCalledWith("Qwen/Qwen3.8-27B", REVISION);
    expect(stage).toHaveBeenCalledWith(PLAN, "/models", { minFreeAfterBytes: 64 * 1024 ** 3 });
    expect(JSON.parse(lines[0]!)).toMatchObject({
      status: "staged",
      model: "Qwen/Qwen3.8-27B",
      revision: REVISION,
      files: 1,
      totalBytes: 123,
    });
  });

  it("fails closed before collection for an unpinned revision", async () => {
    const collect = vi.fn();
    const errors: string[] = [];
    const code = await runModelReleaseStaging(
      ["--revision", "main", "--out-root", "/models"],
      { collect, stage: vi.fn(), stdout: vi.fn(), stderr: (line) => errors.push(line) }
    );
    expect(code).toBe(1);
    expect(collect).not.toHaveBeenCalled();
    expect(errors[0]).toMatch(/40-character/);
  });
});
