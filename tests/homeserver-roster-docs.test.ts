import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const portal = readFileSync(new URL("../src/homeserver/portal.html", import.meta.url), "utf8");
const readme = readFileSync(new URL("../src/homeserver/README.md", import.meta.url), "utf8");

const servedModelIds = [
  "mellum",
  "qwen3-30b-instruct",
  "gemma4",
  "qwen36-a3b",
  "vibethinker-3b",
  "qwen3-coder-next-80b",
  "gpt-oss-120b",
  "qwen35-122b-a10b",
  "muse-glimmer-30b",
  "nemotron-3.5-lightning-30b-a3b",
  "qwen38-27b",
  "ornith-1.5-35b",
] as const;

describe("production roster documentation", () => {
  it("advertises the verified 12 chat and 3 decision models in both operator-facing truth surfaces", () => {
    const portalRoster = portal.match(/WHAT'S RUNNING[\s\S]*?NEW MODEL EVALUATIONS/)?.[0] ?? "";
    const readmeRoster = readme.match(/### Production text roster[\s\S]*?## Coordinating heavy GPU jobs/)?.[0] ?? "";

    expect(portalRoster).not.toBe("");
    expect(readmeRoster).not.toBe("");
    expect(readmeRoster).toContain("15 entries: the twelve chat models");
    for (const modelId of servedModelIds) {
      expect(portalRoster, `portal roster is missing ${modelId}`).toContain(modelId);
      expect(readmeRoster, `homeserver README roster is missing ${modelId}`).toContain(modelId);
    }
    for (const modelId of ["clef-flash", "bespoke-nimble-9b", "pplx-decider-v1-27b"]) {
      expect(portalRoster).toContain(modelId);
      expect(readmeRoster).toContain(modelId);
    }
  });

  it("describes evaluation as manual evidence, never autonomous promotion", () => {
    expect(portal).toContain("Operators can explicitly evaluate");
    expect(portal).toContain("never an automatic roster change");
    expect(portal).not.toContain("Every week the box");
    expect(portal).not.toContain("promoted automatically");
    expect(readme).not.toContain("weekly Model Scout");
  });

  it("documents System One and EmbeddingGemma as conditionally granted typed access", () => {
    const clefRosterCopy = readme.match(/The `clef-flash`, `bespoke-nimble-9b`, and `pplx-decider-v1-27b` System One decision models[\s\S]*?automatic delegation[^\n]*\./)?.[0] ?? "";

    expect(clefRosterCopy).toContain("Customer");
    expect(clefRosterCopy).toContain("explicit grant");
    expect(clefRosterCopy).toContain("authenticated `GET /v1/models`");
    expect(clefRosterCopy).toContain("before calling");
    expect(clefRosterCopy).toContain("`POST /v1/systemone`");
    expect(clefRosterCopy.replace(/\s+/g, " ")).toContain("near `1` means yes and near `0` means no");
    expect(clefRosterCopy).toContain("not chat text");
    const embeddingCopy = readme.match(/`embeddinggemma-2` is a separate proposed embedding service[\s\S]*?customer-facing availability check\./)?.[0] ?? "";
    expect(embeddingCopy).toContain("remains unavailable until");
    expect(embeddingCopy).toContain("explicit key grant");
    expect(embeddingCopy).toContain("BF16 GGUF");
    expect(portal).toContain("/v1/embeddings");
  });
});
