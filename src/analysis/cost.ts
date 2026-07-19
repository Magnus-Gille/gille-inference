// ─── Types ────────────────────────────────────────────────────────────────────

export interface UsageProfile {
  name: string;
  tokensPerMonth: number;
  description: string;
}

export interface HardwareOption {
  name: string;
  purchasePriceSEK: number;
  memoryBandwidthGBs: number;
  ramGB: number;
  /** Estimated electricity cost per month in SEK. */
  monthlyElectricitySEK: number;
  /** Number of months over which to amortize the purchase price. */
  depreciationMonths: number;
  /**
   * For cloud/rental options: monthly rental cost in SEK.
   * When set, purchasePriceSEK is ignored for monthly cost calculation.
   */
  monthlyRentalSEK?: number;
}

export interface CostComparisonItem {
  hardware: HardwareOption;
  /** Purchase / depreciationMonths + electricity (or monthlyRentalSEK + electricity). */
  monthlyAmortizedSEK: number;
  /**
   * Months until hardware becomes cheaper than API, or null if API is always
   * cheaper (or hardware cost >= API cost from month 1).
   */
  breakEvenMonths: number | null;
  /** Cumulative savings after 36 months (negative = loss compared to API). */
  savingsAfter36Months: number;
}

export interface CostComparison {
  usageProfile: UsageProfile;
  apiMonthlyCostSEK: number;
  hardwareOptions: CostComparisonItem[];
}

// ─── Predefined constants ─────────────────────────────────────────────────────

export const USAGE_PROFILES: UsageProfile[] = [
  {
    name: "light",
    tokensPerMonth: 10_000_000,
    description: "~10M tokens/month — casual personal use, a few tasks per day",
  },
  {
    name: "moderate",
    tokensPerMonth: 100_000_000,
    description: "~100M tokens/month — daily coding delegation, active use",
  },
  {
    name: "heavy",
    tokensPerMonth: 1_000_000_000,
    description: "~1B tokens/month — multiple users, continuous delegation",
  },
  {
    name: "very-heavy",
    tokensPerMonth: 5_000_000_000,
    description:
      "~5B tokens/month — co-op with 3-5 active users, hackathon events",
  },
];

/**
 * Monthly rental for the cloud A100 option (8 h/day on RunPod/Lambda/Vast.ai).
 * ~$5-7/h × 8h × 30 days ≈ $1200-1680 USD ≈ 13k-18k SEK.  We use a
 * conservative 3000 SEK as a low-cost Vast.ai estimate.
 */
const CLOUD_A100_MONTHLY_RENTAL_SEK = 3_000;

export const HARDWARE_OPTIONS: HardwareOption[] = [
  {
    name: "Mac Studio M4 Max 128GB",
    purchasePriceSEK: 40_000,
    memoryBandwidthGBs: 546,
    ramGB: 128,
    monthlyElectricitySEK: 100,
    depreciationMonths: 36,
  },
  {
    name: "Mac Studio M3 Ultra 256GB",
    purchasePriceSEK: 95_000,
    memoryBandwidthGBs: 819,
    ramGB: 256,
    monthlyElectricitySEK: 150,
    depreciationMonths: 36,
  },
  {
    // Bosgame M5 Mini, Ryzen AI Max+ 395 + 128GB unified LPDDR5x-8000 + 2TB,
    // observed at 25,790 SEK (May 2026). ~120W TDP under sustained inference
    // → ~150 SEK/month at 1.20 SEK/kWh, 24/7 of which ~30% is full load.
    name: "Strix Halo Mini (Ryzen AI Max+ 395) 128GB",
    purchasePriceSEK: 25_790,
    memoryBandwidthGBs: 256,
    ramGB: 128,
    monthlyElectricitySEK: 150,
    depreciationMonths: 36,
  },
  {
    name: "RTX 4090 Workstation (24GB)",
    purchasePriceSEK: 25_000,
    memoryBandwidthGBs: 1008,
    ramGB: 24,
    monthlyElectricitySEK: 300,
    depreciationMonths: 36,
  },
  {
    name: "Cloud GPU (A100 80GB, 8h/day)",
    purchasePriceSEK: 0,
    memoryBandwidthGBs: 2039,
    ramGB: 80,
    monthlyElectricitySEK: 0,
    depreciationMonths: 1,
    monthlyRentalSEK: CLOUD_A100_MONTHLY_RENTAL_SEK,
  },
];

// ─── Calculation ──────────────────────────────────────────────────────────────

/**
 * Calculate API monthly cost in SEK for a given usage profile and model pricing.
 *
 * Simplification: assume 30% of tokens are input, 70% are output.
 */
function apiMonthlyCostSEK(
  tokensPerMonth: number,
  pricing: { inputPricePerMToken: number; outputPricePerMToken: number },
  usdToSek: number
): number {
  const inputTokens = tokensPerMonth * 0.3;
  const outputTokens = tokensPerMonth * 0.7;
  const costUSD =
    (inputTokens / 1_000_000) * pricing.inputPricePerMToken +
    (outputTokens / 1_000_000) * pricing.outputPricePerMToken;
  return costUSD * usdToSek;
}

/**
 * Calculate monthly amortized hardware cost in SEK.
 *
 * For rental options (monthlyRentalSEK set), that value plus electricity is
 * used.  For owned hardware, purchasePriceSEK / depreciationMonths +
 * electricity.
 */
export function monthlyAmortizedCostSEK(hw: HardwareOption): number {
  if (hw.monthlyRentalSEK !== undefined) {
    return hw.monthlyRentalSEK + hw.monthlyElectricitySEK;
  }
  return hw.purchasePriceSEK / hw.depreciationMonths + hw.monthlyElectricitySEK;
}

/**
 * Calculate cost comparisons for all usage profiles and hardware options.
 *
 * @param modelId         The model being analysed (for labelling only).
 * @param modelPricing    Input/output price per million tokens in USD.
 * @param usdToSek        USD → SEK exchange rate (default 10.5).
 */
export function calculateCostComparison(
  _modelId: string,
  modelPricing: { inputPricePerMToken: number; outputPricePerMToken: number },
  usdToSek = 10.5
): CostComparison[] {
  return USAGE_PROFILES.map((profile) => {
    const apiCost = apiMonthlyCostSEK(
      profile.tokensPerMonth,
      modelPricing,
      usdToSek
    );

    const hardwareOptions: CostComparisonItem[] = HARDWARE_OPTIONS.map((hw) => {
      const hwMonthlyCost = monthlyAmortizedCostSEK(hw);
      const monthlySaving = apiCost - hwMonthlyCost;

      let breakEvenMonths: number | null = null;
      if (monthlySaving > 0 && hw.purchasePriceSEK > 0) {
        // Months until cumulative savings offset the upfront purchase.
        breakEvenMonths = hw.purchasePriceSEK / monthlySaving;
      }
      // For rental/cloud options (purchasePriceSEK === 0) break-even is
      // immediate if the monthly rental is cheaper than API — so 0.
      if (monthlySaving > 0 && hw.purchasePriceSEK === 0) {
        breakEvenMonths = 0;
      }

      // Cumulative savings after 36 months vs continuing to pay API.
      // savingsAfter36Months = total_api_cost - total_hw_cost - upfront
      // = monthlySaving * 36 - purchasePriceSEK
      const savingsAfter36Months =
        monthlySaving * 36 - hw.purchasePriceSEK;

      return {
        hardware: hw,
        monthlyAmortizedSEK: hwMonthlyCost,
        breakEvenMonths,
        savingsAfter36Months,
      };
    });

    return {
      usageProfile: profile,
      apiMonthlyCostSEK: apiCost,
      hardwareOptions,
    };
  });
}

// ─── Report generation ────────────────────────────────────────────────────────

function formatSEK(amount: number): string {
  return `${Math.round(amount).toLocaleString("sv-SE")} SEK`;
}

function formatMonths(months: number | null): string {
  if (months === null) return "never";
  if (months === 0) return "immediate";
  if (months > 360) return ">30 years";
  const rounded = Math.ceil(months);
  return `${rounded} months`;
}

/**
 * Generate a markdown report summarising cost comparisons for a model.
 *
 * @param modelId     OpenRouter model ID for the report heading.
 * @param comparisons Output of calculateCostComparison().
 */
export function generateCostReport(
  modelId: string,
  comparisons: CostComparison[]
): string {
  const lines: string[] = [];

  lines.push(`# Cost Analysis: ${modelId}`);
  lines.push("");
  lines.push(
    "> **Framing:** Continuing to pay OpenRouter API is the baseline. " +
      "Hardware is only justified when privacy, availability, concurrent-user serving, " +
      "or token volume tips the balance."
  );
  lines.push("");
  lines.push(
    "_All results labelled **hosted proxy upper bound** — not local quality._"
  );
  lines.push("");

  for (const comparison of comparisons) {
    const { usageProfile, apiMonthlyCostSEK: apiCost, hardwareOptions } =
      comparison;

    lines.push(`## Usage profile: ${usageProfile.name}`);
    lines.push("");
    lines.push(`_${usageProfile.description}_`);
    lines.push("");
    lines.push(`**API monthly cost:** ${formatSEK(apiCost)}`);
    lines.push("");

    lines.push(
      "| Hardware | Monthly HW cost | Break-even | Savings after 36 months |"
    );
    lines.push(
      "|----------|----------------|------------|------------------------|"
    );

    for (const item of hardwareOptions) {
      lines.push(
        `| ${item.hardware.name} | ${formatSEK(item.monthlyAmortizedSEK)} | ${formatMonths(item.breakEvenMonths)} | ${formatSEK(item.savingsAfter36Months)} |`
      );
    }

    lines.push("");
  }

  return lines.join("\n");
}
