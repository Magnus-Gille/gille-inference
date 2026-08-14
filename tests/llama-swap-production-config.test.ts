import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const roster = readFileSync(
  new URL("../deploy/llama-swap-large-models.example.yaml", import.meta.url),
  "utf8"
);
const memory = readFileSync(
  new URL("../deploy/systemd/llama-swap-memory.conf", import.meta.url),
  "utf8"
);

describe("tracked llama-swap production contract", () => {
  it("uses public placeholders rather than live operator paths", () => {
    expect(roster).toContain("<runtime-root>");
    expect(roster).toContain("<model-root>");
    expect(roster).not.toContain("/home/");
    expect(roster).not.toContain("/Users/");
  });

  it("keeps GPT-OSS as the 64K large-model tier with bounded prompt cache", () => {
    expect(roster).toMatch(
      /"gpt-oss-120b":[\s\S]*?-c 65536 -np 1 --jinja -fa on[\s\S]*?--cache-ram 2048 -ctk f16 -ctv f16/
    );
  });

  it("serves Qwen3.8 as a pinned 64K multimodal native-MTP model", () => {
    expect(roster).toMatch(
      /"qwen38-27b":[\s\S]*?releases\/9b05354ec\/bin\/llama-server[\s\S]*?Qwen3\.8-27B-Q4_K_M\.gguf[\s\S]*?-mm [^\n]*mmproj-Qwen3\.8-27B-BF16\.gguf[\s\S]*?--image-min-tokens 1024[\s\S]*?-c 65536 -np 1 --jinja -fa on[\s\S]*?--spec-type draft-mtp --spec-draft-n-max 2[\s\S]*?--reasoning-format auto --reasoning auto[\s\S]*?--cache-ram 2048 -ctk q8_0 -ctv q8_0/
    );
  });

  it("bounds the shared llama-swap cgroup without swap", () => {
    expect(memory).toContain("MemoryMax=96G");
    expect(memory).toContain("MemorySwapMax=0");
    expect(memory).toContain("OOMPolicy=kill");
  });
});
