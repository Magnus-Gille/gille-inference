import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const unit = readFileSync(new URL("../deploy/systemd/gille-embeddinggemma2.service", import.meta.url), "utf8");

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
    const context = value("-c");
    const logicalBatch = value("-b");
    const physicalBatch = value("-ub");
    expect(physicalBatch).toBeGreaterThanOrEqual(context);
    expect(logicalBatch).toBeGreaterThanOrEqual(physicalBatch);
  });
});
