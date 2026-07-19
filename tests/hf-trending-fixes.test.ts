/** Regression tests for the post-Codex hf-trending fixes: MXFP4 recognition + QuantPick.parts. */
import { describe, it, expect } from "vitest";
import { parseQuant, pickQuant } from "../src/homeserver/hf-trending.js";
import type { GgufFile } from "../src/homeserver/scout-types.js";

const GB = 1024 ** 3;
const f = (rfilename: string, gb: number): GgufFile => ({ rfilename, quant: parseQuant(rfilename), sizeBytes: Math.round(gb * GB) });

describe("MXFP4 (gpt-oss class)", () => {
  it("parseQuant recognizes MXFP4", () => {
    expect(parseQuant("gpt-oss-120b-mxfp4-00001-of-00003.gguf")).toBe("MXFP4");
  });
  it("pickQuant selects a fitting MXFP4 model (no longer skipped)", () => {
    const pick = pickQuant([f("gpt-oss-120b-MXFP4.gguf", 60)], 62);
    expect(pick).not.toBeNull();
    expect(pick!.file.quant).toBe("MXFP4");
  });
});

describe("QuantPick.parts (definitive shard list)", () => {
  it("single file → one-element parts", () => {
    const pick = pickQuant([f("Model-Q4_K_M.gguf", 20)], 58);
    expect(pick!.parts).toEqual(["Model-Q4_K_M.gguf"]);
  });
  it("sharded → ordered parts of the SELECTED group only (no cross-group mixing)", () => {
    // Two different Q4_K_M shard groups in one repo + a smaller Q5 single.
    const files = [
      f("alpha-Q4_K_M-00001-of-00002.gguf", 25),
      f("alpha-Q4_K_M-00002-of-00002.gguf", 25),
      f("beta-Q4_K_M-00001-of-00002.gguf", 20),
      f("beta-Q4_K_M-00002-of-00002.gguf", 20),
    ];
    const pick = pickQuant(files, 58);
    expect(pick).not.toBeNull();
    // Whichever group is chosen, parts must all share ONE base — never a mix of alpha+beta.
    const bases = pick!.parts.map((p) => p.replace(/-\d{5}-of-\d{5}\.gguf$/, ""));
    expect(new Set(bases).size).toBe(1);
    expect(pick!.parts.length).toBe(2);
    // ordered
    expect(pick!.parts).toEqual([...pick!.parts].sort());
  });
});
