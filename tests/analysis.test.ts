import { describe, it, expect } from "vitest";
import { scoreToNumeric, averageScores } from "../src/analysis/stats.js";
import {
  calculateCostComparison,
  monthlyAmortizedCostSEK,
  USAGE_PROFILES,
  HARDWARE_OPTIONS,
} from "../src/analysis/cost.js";
import {
  estimateModelSizeGB,
  fitsInMemory,
  estimateTokensPerSecond,
  estimateConcurrentUsers,
  HARDWARE_SPECS,
} from "../src/analysis/hardware.js";

// ─── stats.ts ─────────────────────────────────────────────────────────────────

describe("scoreToNumeric", () => {
  it("maps fail → 0", () => {
    expect(scoreToNumeric("fail")).toBe(0);
  });

  it("maps acceptable → 1", () => {
    expect(scoreToNumeric("acceptable")).toBe(1);
  });

  it("maps good → 2", () => {
    expect(scoreToNumeric("good")).toBe(2);
  });
});

describe("averageScores", () => {
  it("returns 0 for empty array", () => {
    expect(averageScores([])).toBe(0);
  });

  it("correctly averages a single all-good score", () => {
    const scores = [{ correctness: "good" as const, completeness: "good" as const, quality: "good" as const }];
    expect(averageScores(scores)).toBe(2);
  });

  it("correctly averages mixed scores", () => {
    // correctness=good(2), completeness=acceptable(1), quality=fail(0) → avg = 1.0
    const scores = [{ correctness: "good" as const, completeness: "acceptable" as const, quality: "fail" as const }];
    expect(averageScores(scores)).toBeCloseTo(1.0);
  });
});

// ─── cost.ts ─────────────────────────────────────────────────────────────────

describe("monthlyAmortizedCostSEK", () => {
  it("correctly amortizes owned hardware", () => {
    const hw = HARDWARE_OPTIONS.find((h) => h.name === "Mac Studio M4 Max 128GB")!;
    // 40000 / 36 + 100 = 1111.11 + 100 ≈ 1211
    const cost = monthlyAmortizedCostSEK(hw);
    expect(cost).toBeCloseTo(40_000 / 36 + 100, 1);
  });

  it("uses monthlyRentalSEK for cloud/rental options", () => {
    const hw = HARDWARE_OPTIONS.find((h) => h.name.includes("A100"))!;
    expect(hw.monthlyRentalSEK).toBeDefined();
    const cost = monthlyAmortizedCostSEK(hw);
    // Should be rental + electricity, not 0/1 + electricity
    expect(cost).toBe(hw.monthlyRentalSEK! + hw.monthlyElectricitySEK);
  });
});

describe("calculateCostComparison", () => {
  const pricing = { inputPricePerMToken: 0.10, outputPricePerMToken: 0.30 };
  const usdToSek = 10.5;

  it("returns one comparison per usage profile", () => {
    const result = calculateCostComparison("test/model", pricing, usdToSek);
    expect(result.length).toBe(USAGE_PROFILES.length);
  });

  it("each comparison contains all hardware options", () => {
    const result = calculateCostComparison("test/model", pricing, usdToSek);
    for (const comparison of result) {
      expect(comparison.hardwareOptions.length).toBe(HARDWARE_OPTIONS.length);
    }
  });

  it("break-even is null when API cost is cheaper than hardware", () => {
    // Light usage: 10M tokens/month
    // API cost: (3M * 0.10 + 7M * 0.30) / 1M * 10.5 = (0.3 + 2.1) * 10.5 = 25.2 SEK
    // Hardware (Mac Studio M4 Max): ~1211 SEK/month → hardware is always more expensive
    const result = calculateCostComparison("test/model", pricing, usdToSek);
    const lightComparison = result.find((c) => c.usageProfile.name === "light")!;
    const macStudio = lightComparison.hardwareOptions.find(
      (h) => h.hardware.name === "Mac Studio M4 Max 128GB"
    )!;
    expect(macStudio.breakEvenMonths).toBeNull();
  });

  it("break-even is positive when API cost exceeds hardware cost", () => {
    // Heavy usage: 1B tokens/month with moderate price model
    // API cost: (300M * 0.10 + 700M * 0.30) / 1M * 10.5 = (30 + 210) * 10.5 = 2520 SEK/month
    // Mac Studio M4 Max: ~1211 SEK/month → API is more expensive → break-even should be positive
    const result = calculateCostComparison("test/model", pricing, usdToSek);
    const heavyComparison = result.find((c) => c.usageProfile.name === "heavy")!;
    const macStudio = heavyComparison.hardwareOptions.find(
      (h) => h.hardware.name === "Mac Studio M4 Max 128GB"
    )!;
    expect(macStudio.breakEvenMonths).not.toBeNull();
    expect(macStudio.breakEvenMonths!).toBeGreaterThan(0);
  });

  it("cloud A100 has immediate break-even when API > rental", () => {
    // Very heavy usage: 5B tokens/month
    // API cost: (1.5B * 0.10 + 3.5B * 0.30) / 1M * 10.5 = (150 + 1050) * 10.5 = 12600 SEK
    // A100 rental: 3000 SEK → API is way more expensive
    const result = calculateCostComparison("test/model", pricing, usdToSek);
    const vhComparison = result.find((c) => c.usageProfile.name === "very-heavy")!;
    const a100 = vhComparison.hardwareOptions.find(
      (h) => h.hardware.name.includes("A100")
    )!;
    expect(a100.breakEvenMonths).toBe(0); // immediate for zero-purchase-price options
  });

  it("savings after 36 months is negative when API is cheaper (light usage)", () => {
    const result = calculateCostComparison("test/model", pricing, usdToSek);
    const lightComparison = result.find((c) => c.usageProfile.name === "light")!;
    const macStudio = lightComparison.hardwareOptions.find(
      (h) => h.hardware.name === "Mac Studio M4 Max 128GB"
    )!;
    expect(macStudio.savingsAfter36Months).toBeLessThan(0);
  });
});

// ─── hardware.ts ─────────────────────────────────────────────────────────────

describe("estimateModelSizeGB", () => {
  it("70B at Q4 (~4.5 bits) is approximately 40 GB", () => {
    // 70B × (4.5/8) × 1.1 = 70e9 × 0.5625 × 1.1 / 1e9 = 43.3 GB
    const size = estimateModelSizeGB(70, 4.5);
    expect(size).toBeGreaterThan(38);
    expect(size).toBeLessThan(50);
  });

  it("7B at Q8 is approximately 8 GB", () => {
    // 7B × (8/8) × 1.1 = 7.7 GB
    const size = estimateModelSizeGB(7, 8);
    expect(size).toBeCloseTo(7.7, 0);
  });

  it("32B at Q4 fits the expected range (~19-20 GB)", () => {
    // 32B × 0.5625 × 1.1 = 19.8 GB
    const size = estimateModelSizeGB(32, 4.5);
    expect(size).toBeGreaterThan(18);
    expect(size).toBeLessThan(22);
  });
});

describe("fitsInMemory", () => {
  const macStudio128 = HARDWARE_SPECS.find(
    (h) => h.name === "Mac Studio M4 Max 128GB"
  )!;
  const rtx4090 = HARDWARE_SPECS.find(
    (h) => h.name === "RTX 4090 (24GB VRAM)"
  )!;

  it("70B Q4 fits in Mac Studio 128GB (usable 108GB)", () => {
    // ~43 GB < 108 GB
    expect(fitsInMemory(70, 4.5, macStudio128)).toBe(true);
  });

  it("405B Q4 does NOT fit in Mac Studio 128GB", () => {
    // 405B × 0.5625 × 1.1 ≈ 250 GB > 108 GB
    expect(fitsInMemory(405, 4.5, macStudio128)).toBe(false);
  });

  it("70B Q4 does NOT fit in RTX 4090 (22GB usable)", () => {
    // ~43 GB > 22 GB
    expect(fitsInMemory(70, 4.5, rtx4090)).toBe(false);
  });

  it("7B Q4 fits in RTX 4090", () => {
    // ~4.3 GB < 22 GB
    expect(fitsInMemory(7, 4.5, rtx4090)).toBe(true);
  });
});

describe("estimateTokensPerSecond", () => {
  it("returns a positive number for a valid model + hardware combo", () => {
    const macStudio128 = HARDWARE_SPECS.find(
      (h) => h.name === "Mac Studio M4 Max 128GB"
    )!;
    const modelSizeGB = estimateModelSizeGB(14, 8); // ~15.4 GB
    const tps = estimateTokensPerSecond(modelSizeGB, macStudio128);
    expect(tps).toBeGreaterThan(0);
    expect(isFinite(tps)).toBe(true);
  });

  it("returns 0 for modelSizeGB = 0", () => {
    const hw = HARDWARE_SPECS[0]!;
    expect(estimateTokensPerSecond(0, hw)).toBe(0);
  });

  it("14B Q8 on M4 Max 128GB gives ~35+ tok/s", () => {
    // 546 GB/s / ~15.4 GB ≈ 35 tok/s
    const macStudio128 = HARDWARE_SPECS.find(
      (h) => h.name === "Mac Studio M4 Max 128GB"
    )!;
    const sizeGB = estimateModelSizeGB(14, 8);
    const tps = estimateTokensPerSecond(sizeGB, macStudio128);
    expect(tps).toBeGreaterThan(30);
  });
});

describe("estimateConcurrentUsers", () => {
  it("returns correct number at 10 tok/s target", () => {
    const macStudio128 = HARDWARE_SPECS.find(
      (h) => h.name === "Mac Studio M4 Max 128GB"
    )!;
    // 14B Q8: ~35 tok/s → 3 concurrent users at 10 tok/s
    const sizeGB = estimateModelSizeGB(14, 8);
    const users = estimateConcurrentUsers(sizeGB, macStudio128, 10);
    expect(users).toBeGreaterThanOrEqual(3);
  });

  it("returns 0 when targetTokPerSec is 0", () => {
    const hw = HARDWARE_SPECS[0]!;
    expect(estimateConcurrentUsers(10, hw, 0)).toBe(0);
  });

  it("returns a whole number (floor)", () => {
    const hw = HARDWARE_SPECS[0]!;
    const result = estimateConcurrentUsers(10, hw, 3);
    expect(Number.isInteger(result)).toBe(true);
  });
});
