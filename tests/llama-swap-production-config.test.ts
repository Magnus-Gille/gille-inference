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

  it("serves Qwen as a pinned 32K reasoning-off precision specialist", () => {
    expect(roster).toMatch(
      /"qwen35-122b-a10b":[\s\S]*?releases\/9a3bf2b84\/bin\/llama-server[\s\S]*?-c 32768 -np 1 --jinja -fa on[\s\S]*?--reasoning-format auto --reasoning off[\s\S]*?--cache-ram 2048 -ctk f16 -ctv f16/
    );
  });

  it("bounds the shared llama-swap cgroup without swap", () => {
    expect(memory).toContain("MemoryMax=96G");
    expect(memory).toContain("MemorySwapMax=0");
    expect(memory).toContain("OOMPolicy=kill");
  });
});
