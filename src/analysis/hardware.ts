import type { ModelSpec } from "../types.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface HardwareSpec {
  name: string;
  memoryBandwidthGBs: number;
  totalRamGB: number;
  /** After OS overhead: ~15-20 GB for macOS, ~2 GB for Linux/NVIDIA. */
  usableRamGB: number;
  platform: "apple-silicon" | "nvidia" | "amd-apu" | "cloud";
}

// ─── Predefined hardware specs ────────────────────────────────────────────────

export const HARDWARE_SPECS: HardwareSpec[] = [
  {
    name: "Mac Studio M4 Max 128GB",
    memoryBandwidthGBs: 546,
    totalRamGB: 128,
    usableRamGB: 108,
    platform: "apple-silicon",
  },
  {
    name: "Mac Studio M3 Ultra 256GB",
    memoryBandwidthGBs: 819,
    totalRamGB: 256,
    usableRamGB: 230,
    platform: "apple-silicon",
  },
  {
    // Bosgame M5 / Framework Desktop class. Ryzen AI Max+ 395 + LPDDR5x-8000
    // 256-bit bus → 256 GB/s. Linux leaves more RAM free than macOS, but unified
    // memory is shared with the iGPU. Bandwidth confirmed against
    // kyuz0/amd-strix-halo-toolboxes benchmarks (Apr 2026): gpt-oss-120b mxfp4
    // hits 56 t/s on a 59 GiB MoE model via Vulkan RADV; Devstral 123B Q4 dense
    // hits 3 t/s on 70 GiB (≈83% of bandwidth-bound ceiling).
    name: "Strix Halo (Ryzen AI Max+ 395) 128GB",
    memoryBandwidthGBs: 256,
    totalRamGB: 128,
    usableRamGB: 115,
    platform: "amd-apu",
  },
  {
    name: "RTX 4090 (24GB VRAM)",
    memoryBandwidthGBs: 1008,
    totalRamGB: 24,
    usableRamGB: 22,
    platform: "nvidia",
  },
  {
    name: "RTX 5090 (32GB VRAM)",
    memoryBandwidthGBs: 1792,
    totalRamGB: 32,
    usableRamGB: 30,
    platform: "nvidia",
  },
  {
    name: "A100 80GB",
    memoryBandwidthGBs: 2039,
    totalRamGB: 80,
    usableRamGB: 78,
    platform: "cloud",
  },
];

// ─── Estimation functions ─────────────────────────────────────────────────────

/**
 * Estimate model memory footprint in GB at the given quantization bit-width.
 *
 * Formula: params × (quantBitsPerParam / 8) × 1.1 (KV cache & overhead)
 *
 * Useful reference bit-widths:
 * - Q4_K_M ≈ 4.5 bits
 * - Q8_0   ≈ 8 bits
 * - FP16   ≈ 16 bits
 */
export function estimateModelSizeGB(
  parametersBillions: number,
  quantBitsPerParam: number
): number {
  const bytesPerParam = quantBitsPerParam / 8;
  const paramsTotal = parametersBillions * 1e9;
  const baseBytes = paramsTotal * bytesPerParam;
  // 10% overhead for KV cache and activations.
  return (baseBytes * 1.1) / 1e9;
}

/**
 * Return true when the model fits within the hardware's usable RAM.
 */
export function fitsInMemory(
  parametersBillions: number,
  quantBits: number,
  hw: HardwareSpec
): boolean {
  const modelGB = estimateModelSizeGB(parametersBillions, quantBits);
  return modelGB <= hw.usableRamGB;
}

/**
 * Estimate single-user token generation throughput in tokens/second.
 *
 * Simplified formula:
 *   tok/s ≈ memoryBandwidthGBs / modelSizeGB
 *
 * This is the theoretical memory-bandwidth-bound ceiling; real-world numbers
 * are 60-80% of this due to compute overhead, KV-cache pressure, etc.
 */
export function estimateTokensPerSecond(
  modelSizeGB: number,
  hw: HardwareSpec
): number {
  if (modelSizeGB <= 0) return 0;
  return hw.memoryBandwidthGBs / modelSizeGB;
}

/**
 * Estimate how many concurrent users can each receive at least
 * `targetTokPerSec` tokens per second.
 *
 * Simplified linear model: total throughput / targetTokPerSec.
 * Real-world batching has sub-linear scaling, so this is an upper bound.
 */
export function estimateConcurrentUsers(
  modelSizeGB: number,
  hw: HardwareSpec,
  targetTokPerSec: number
): number {
  if (targetTokPerSec <= 0) return 0;
  const totalTokPerSec = estimateTokensPerSecond(modelSizeGB, hw);
  return Math.floor(totalTokPerSec / targetTokPerSec);
}

// ─── Report generation ────────────────────────────────────────────────────────

/**
 * Quantization presets for the hardware report.
 * Maps display name → bit-width used for estimateModelSizeGB.
 */
const QUANT_PRESETS: Array<{ label: string; bits: number }> = [
  { label: "Q4_K_M", bits: 4.5 },
  { label: "Q8_0", bits: 8 },
  { label: "FP16", bits: 16 },
];

/**
 * Generate a markdown hardware comparison table.
 *
 * For each model × hardware combination, shows:
 * - Whether the model fits at each quantization level
 * - Estimated tokens/second (for the first fitting quantization)
 * - Estimated concurrent users at 10 tok/s target
 */
export function generateHardwareReport(models: ModelSpec[]): string {
  const lines: string[] = [];
  const TARGET_TOK_PER_SEC = 10;

  lines.push("# Hardware Comparison");
  lines.push("");
  lines.push(
    `Concurrent user estimates assume each user receives ≥${TARGET_TOK_PER_SEC} tok/s.`
  );
  lines.push("Throughput estimates are theoretical upper bounds (bandwidth-bound model).");
  lines.push("");

  for (const model of models) {
    lines.push(`## ${model.shortName} (${model.parametersBillions}B params)`);
    lines.push("");
    lines.push(
      "| Hardware | RAM | " +
        QUANT_PRESETS.map((q) => q.label).join(" fits? | ") +
        " fits? | Best quant tok/s | Concurrent users (@10 tok/s) |"
    );
    lines.push(
      "| -------- | --- | " +
        QUANT_PRESETS.map(() => "------").join(" | ") +
        " | --------------- | ---------------------------- |"
    );

    for (const hw of HARDWARE_SPECS) {
      const fitCells = QUANT_PRESETS.map((q) =>
        fitsInMemory(model.parametersBillions, q.bits, hw) ? "Yes" : "No"
      );

      // Find the first quantization that fits for tok/s estimate.
      const bestQuant = QUANT_PRESETS.find((q) =>
        fitsInMemory(model.parametersBillions, q.bits, hw)
      );

      let tokPerSecCell = "—";
      let concurrentCell = "—";
      if (bestQuant) {
        const sizeGB = estimateModelSizeGB(
          model.parametersBillions,
          bestQuant.bits
        );
        const tokS = estimateTokensPerSecond(sizeGB, hw);
        tokPerSecCell = `${tokS.toFixed(1)} (${bestQuant.label})`;
        const concurrent = estimateConcurrentUsers(sizeGB, hw, TARGET_TOK_PER_SEC);
        concurrentCell = String(concurrent);
      }

      lines.push(
        `| ${hw.name} | ${hw.totalRamGB} GB | ${fitCells.join(" | ")} | ${tokPerSecCell} | ${concurrentCell} |`
      );
    }

    lines.push("");
  }

  return lines.join("\n");
}
