import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const unit = readFileSync(new URL("../deploy/systemd/gille-embeddinggemma2.service", import.meta.url), "utf8");
const multimodalUnit = readFileSync(new URL("../deploy/systemd/gille-embeddinggemma2-multimodal.service", import.meta.url), "utf8");

describe("EmbeddingGemma 2 sidecar unit", () => {
  it("fits a full context in one physical batch for non-splittable embeddings", () => {
    const command = unit.match(/^ExecStart=(.+)$/m)?.[1];
    expect(command).toBeDefined();
    const argv = command!.split(/\s+/);
    const value = (flag: string): number => {
      const index = argv.indexOf(flag);
      expect(index).toBeGreaterThan(-1);
      const parsed = Number(argv[index + 1]);
      expect(Number.isSafeInteger(parsed)).toBe(true);
      return parsed;
    };

    expect(argv).toContain("--embedding");
    expect(argv).not.toContain("--mmproj");
    const context = value("-c");
    const logicalBatch = value("-b");
    const physicalBatch = value("-ub");
    expect(physicalBatch).toBeGreaterThanOrEqual(context);
    expect(logicalBatch).toBeGreaterThanOrEqual(physicalBatch);
  });

  it("keeps projector activation in a separate CPU-only unit template", () => {
    const command = multimodalUnit.match(/^ExecStart=(.+)$/m)?.[1];
    expect(command).toBeDefined();
    const argv = command!.split(/\s+/);
    expect(argv[argv.indexOf("--mmproj") + 1]).toBe("/operator-resolve/models/mmproj-embeddinggemma-2-BF16.gguf");
    expect(argv).toContain("--no-mmproj-offload");
    expect(argv.slice(argv.indexOf("--mmproj-device"), argv.indexOf("--mmproj-device") + 2))
      .toEqual(["--mmproj-device", "none"]);
    expect(argv.slice(argv.indexOf("-ngl"), argv.indexOf("-ngl") + 2)).toEqual(["-ngl", "0"]);
    expect(multimodalUnit).toContain("MemoryMax=8G");
    expect(multimodalUnit).toContain("MemorySwapMax=0");
    expect(multimodalUnit).toContain("PrivateDevices=true");
  });
});
