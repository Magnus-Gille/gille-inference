import type { ModelSpec } from '../types.js';

// ─── Model registry ───────────────────────────────────────────────────────────

export const MODELS: ModelSpec[] = [
  {
    id: 'qwen/qwen3-14b',
    shortName: 'Qwen3-14B',
    family: 'qwen3',
    parametersBillions: 14,
    contextLength: 128_000,
    openRouterPricePerMInputToken: 0.14,
    openRouterPricePerMOutputToken: 0.56,
    fitsIn128GB: true,
    fitsIn256GB: true,
    estimatedTokPerSec128GB: 80,
    estimatedTokPerSec256GB: 80,
  },
  // NOTE: deepseek/deepseek-r1-distill-qwen-14b removed from OpenRouter as of March 2026
  {
    id: 'qwen/qwen3-32b',
    shortName: 'Qwen3-32B',
    family: 'qwen3',
    parametersBillions: 32,
    contextLength: 128_000,
    openRouterPricePerMInputToken: 0.10,
    openRouterPricePerMOutputToken: 0.30,
    fitsIn128GB: true,
    fitsIn256GB: true,
    quantizationNote: 'Q4_K_M on 128GB, Q8_0 on 256GB',
    estimatedTokPerSec128GB: 40,
    estimatedTokPerSec256GB: 45,
  },
  {
    id: 'deepseek/deepseek-r1-distill-qwen-32b',
    shortName: 'DS-R1-32B',
    family: 'deepseek-r1',
    parametersBillions: 32,
    contextLength: 32_768,
    openRouterPricePerMInputToken: 0.14,
    openRouterPricePerMOutputToken: 0.56,
    fitsIn128GB: true,
    fitsIn256GB: true,
    quantizationNote: 'Q4_K_M',
    estimatedTokPerSec128GB: 35,
    estimatedTokPerSec256GB: 45,
  },
  {
    id: 'meta-llama/llama-3.3-70b-instruct',
    shortName: 'Llama3.3-70B',
    family: 'llama',
    parametersBillions: 70,
    contextLength: 128_000,
    openRouterPricePerMInputToken: 0.20,
    openRouterPricePerMOutputToken: 0.80,
    fitsIn128GB: true,
    fitsIn256GB: true,
    quantizationNote: 'Q4_K_M only on 128GB',
    estimatedTokPerSec128GB: 18,
    estimatedTokPerSec256GB: 20,
  },
  {
    id: 'qwen/qwen3-235b-a22b',
    shortName: 'Qwen3-235B-MoE',
    family: 'qwen3',
    parametersBillions: 235,
    contextLength: 128_000,
    openRouterPricePerMInputToken: 0.13,
    openRouterPricePerMOutputToken: 0.60,
    fitsIn128GB: false,
    fitsIn256GB: true,
    quantizationNote: 'Q4_K_M, MoE 22B active params',
    estimatedTokPerSec256GB: 30,
  },
  // ─── Coding-specific models ──────────────────────────────────────────────────

  {
    id: 'qwen/qwen-2.5-coder-32b-instruct',
    shortName: 'Qwen2.5-Coder-32B',
    family: 'qwen-coder',
    parametersBillions: 32,
    contextLength: 32_768,
    openRouterPricePerMInputToken: 0.66,
    openRouterPricePerMOutputToken: 1.00,
    fitsIn128GB: true,
    fitsIn256GB: true,
    quantizationNote: 'Dense 32B coding-specific. Q4_K_M on 128GB, Q8_0 on 256GB',
    estimatedTokPerSec128GB: 40,
    estimatedTokPerSec256GB: 45,
  },
  // ─── MiniMax ─────────────────────────────────────────────────────────────────

  {
    id: 'minimax/minimax-m2.5-20260211',
    shortName: 'MiniMax-M2.5',
    family: 'minimax',
    parametersBillions: 309,
    contextLength: 196_608,
    openRouterPricePerMInputToken: 0.19,
    openRouterPricePerMOutputToken: 1.15,
    fitsIn128GB: false,
    fitsIn256GB: true,
    quantizationNote: 'MoE 15B active. Aggressive quant needed for 256GB',
    estimatedTokPerSec256GB: 25,
  },

  // ─── GLM / Zhipu ────────────────────────────────────────────────────────────

  {
    id: 'z-ai/glm-4.7-flash',
    shortName: 'GLM-4.7-Flash',
    family: 'glm',
    parametersBillions: 30,
    contextLength: 202_752,
    openRouterPricePerMInputToken: 0.06,
    openRouterPricePerMOutputToken: 0.40,
    fitsIn128GB: true,
    fitsIn256GB: true,
    quantizationNote: 'MoE ~3B active. Tiny footprint — fast utility model',
    estimatedTokPerSec128GB: 120,
    estimatedTokPerSec256GB: 120,
  },

  // ─── New models (March 2026 research) ──────────────────────────────────────

  {
    id: 'qwen/qwen3-coder-next',
    shortName: 'Qwen3-Coder-Next',
    family: 'qwen-coder',
    parametersBillions: 80,
    contextLength: 262_144,
    openRouterPricePerMInputToken: 0.12,
    openRouterPricePerMOutputToken: 0.75,
    fitsIn128GB: true,
    fitsIn256GB: true,
    quantizationNote: 'MoE 3B active — only 46GB at Q4! Best RAM efficiency. SWE-Bench 70.6%',
    estimatedTokPerSec128GB: 100,
    estimatedTokPerSec256GB: 100,
  },
  {
    id: 'mistralai/devstral-2512',
    shortName: 'Devstral-2',
    family: 'mistral',
    parametersBillions: 123,
    contextLength: 262_144,
    openRouterPricePerMInputToken: 0.40,
    openRouterPricePerMOutputToken: 2.00,
    fitsIn128GB: true,
    fitsIn256GB: true,
    quantizationNote: 'Dense 123B — ~70GB at Q4, fits 128GB. SWE-Bench 72.2%',
    estimatedTokPerSec128GB: 8,
    estimatedTokPerSec256GB: 10,
  },
  {
    id: 'openai/gpt-oss-120b',
    shortName: 'GPT-oss-120B',
    family: 'gpt-oss',
    parametersBillions: 117,
    contextLength: 128_000,
    openRouterPricePerMInputToken: 0.30,
    openRouterPricePerMOutputToken: 1.20,
    fitsIn128GB: true,
    fitsIn256GB: true,
    quantizationNote: 'MoE 5.1B active — 80GB native MXFP4. Metal reference impl from OpenAI',
    estimatedTokPerSec128GB: 60,
    estimatedTokPerSec256GB: 60,
  },
  {
    id: 'nvidia/nemotron-3-super-120b-a12b',
    shortName: 'Nemotron-3-Super',
    family: 'nvidia',
    parametersBillions: 120,
    contextLength: 128_000,
    openRouterPricePerMInputToken: 0.15,
    openRouterPricePerMOutputToken: 0.40,
    fitsIn128GB: true,
    fitsIn256GB: true,
    quantizationNote: 'Hybrid Mamba-Transformer MoE, 12B active — ~65GB at Q4. Released Mar 11 2026',
    estimatedTokPerSec128GB: 50,
    estimatedTokPerSec256GB: 50,
  },
  // NOTE: microsoft/phi-4-reasoning not available on OpenRouter as of March 2026

  // ─── Gemma 4 (April 2026) ───────────────────────────────────────────────────
  // NOTE: google/gemma-4-e2b is NOT available on OpenRouter as of April 2026 — local only.
  // 50 existing cloud runs in DB use old id 'google/gemma-4-26b-a4b'; new runs use the -it suffix.

  {
    id: 'google/gemma-4-e2b',
    shortName: 'Gemma4-E2B',
    family: 'gemma4',
    parametersBillions: 5.1,
    contextLength: 128_000,
    openRouterPricePerMInputToken: 0,    // not on OpenRouter
    openRouterPricePerMOutputToken: 0,
    fitsIn128GB: true,
    fitsIn256GB: true,
    quantizationNote: '2.3B effective (5.1B with embeddings). Edge model — fits Pi 5 8GB. Local-only.',
    estimatedTokPerSec128GB: 150,
    estimatedTokPerSec256GB: 150,
  },
  {
    id: 'google/gemma-4-26b-a4b-it',
    shortName: 'Gemma4-26B-A4B',
    family: 'gemma4',
    parametersBillions: 26,
    contextLength: 262_144,
    openRouterPricePerMInputToken: 0.13,
    openRouterPricePerMOutputToken: 0.40,
    fitsIn128GB: true,
    fitsIn256GB: true,
    quantizationNote: 'MoE 3.8B active — ~18GB at Q4. 256K context',
    estimatedTokPerSec128GB: 90,
    estimatedTokPerSec256GB: 90,
  },

  {
    id: 'qwen/qwen3.5-35b-a3b',
    shortName: 'Qwen3.5-35B-A3B',
    family: 'qwen3',
    parametersBillions: 35,
    contextLength: 262_144,
    openRouterPricePerMInputToken: 0.16,
    openRouterPricePerMOutputToken: 1.30,
    fitsIn128GB: true,
    fitsIn256GB: true,
    quantizationNote: 'MoE 3B active — MLX backend in Ollama (safetensors). ~23GB at native precision.',
    estimatedTokPerSec128GB: 100,
    estimatedTokPerSec256GB: 100,
  },
  {
    // JetBrains Mellum2 — 12B MoE, 2.5B active. Apache 2.0. Local-only (LM Studio GGUF Q8_0).
    // id matches the LM Studio API model identifier so --provider lmstudio resolves directly.
    id: 'mellum2-12b-a2.5b-thinking',
    shortName: 'Mellum2-12B-A2.5B',
    family: 'mellum',
    parametersBillions: 12,
    contextLength: 32_768, // loaded context in LM Studio (model max 131K)
    openRouterPricePerMInputToken: 0, // local-only, not on OpenRouter
    openRouterPricePerMOutputToken: 0,
    fitsIn128GB: true,
    fitsIn256GB: true,
    quantizationNote: 'GGUF Q8_0 (~12.9GB) via LM Studio. MoE 2.5B active of 12B.',
    estimatedTokPerSec128GB: 35,
    estimatedTokPerSec256GB: 40,
  },
  {
    // JetBrains Mellum2 — Instruct variant (no reasoning channel). The fast sub-agent/router tier.
    // Same 12B MoE / 2.5B active as Thinking, but emits directly in `content` — no <think> overhead.
    // id matches the LM Studio API model identifier so --provider lmstudio resolves directly.
    id: 'mellum2-12b-a2.5b-instruct',
    shortName: 'Mellum2-12B-Instruct',
    family: 'mellum',
    parametersBillions: 12,
    contextLength: 32_768, // loaded context in LM Studio (model max 131K)
    openRouterPricePerMInputToken: 0, // local-only, not on OpenRouter
    openRouterPricePerMOutputToken: 0,
    fitsIn128GB: true,
    fitsIn256GB: true,
    quantizationNote: 'GGUF Q8_0 (~12.9GB) via LM Studio. MoE 2.5B active of 12B. Instruct (no-think).',
    estimatedTokPerSec128GB: 35,
    estimatedTokPerSec256GB: 40,
  },
  {
    // Qwen3-Coder-Next 80B — escalation-coder tier for the BosGame 128GB box.
    // Beats Qwen3-Coder-Next in SWE-bench Verified (70.6%). BosGame-only: ~48.5GB Q4_K_M
    // won't fit a 32GB Air. Tool-call reliability in llama.cpp verified (no open blocking issues
    // as of 2026-06-14 sweep). Download: hf download Qwen/Qwen3-Coder-Next-80B-Instruct-GGUF
    // id matches expected LM Studio model identifier; verify on first load.
    id: 'qwen3-coder-next-80b',
    shortName: 'Qwen3-Coder-Next-80B',
    family: 'qwen3',
    parametersBillions: 80,
    contextLength: 32_768,
    openRouterPricePerMInputToken: 0,
    openRouterPricePerMOutputToken: 0,
    fitsIn128GB: true,
    fitsIn256GB: true,
    quantizationNote: 'GGUF Q4_K_M (~48.5GB). BosGame-only (won\'t fit 32GB Air). 70.6% SWE-bench Verified.',
    estimatedTokPerSec128GB: 75,
    estimatedTokPerSec256GB: 100,
  },
  {
    // Google Gemma 4 12B Unified — encoder-free, vision+tool+reasoning. Local-only (LM Studio GGUF Q6_K).
    // id matches the LM Studio API model identifier so --provider lmstudio resolves directly.
    // Reasoning model: needs a higher token budget than instruct models.
    id: 'google/gemma-4-12b',
    shortName: 'Gemma-4-12B',
    family: 'gemma4',
    parametersBillions: 12,
    contextLength: 32_768,
    openRouterPricePerMInputToken: 0, // local-only, not on OpenRouter
    openRouterPricePerMOutputToken: 0,
    fitsIn128GB: true,
    fitsIn256GB: true,
    quantizationNote: 'GGUF Q6_K (~9.96GB) via LM Studio. Unified dense 12B, vision+tool+reasoning.',
    estimatedTokPerSec128GB: 9,
    estimatedTokPerSec256GB: 12,
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function getModelById(id: string): ModelSpec | undefined {
  return MODELS.find((m) => m.id === id);
}

export function getModelsByFamily(family: string): ModelSpec[] {
  return MODELS.filter((m) => m.family === family);
}

export function getLocalModels(ramGB: 128 | 256): ModelSpec[] {
  if (ramGB === 128) {
    return MODELS.filter((m) => m.fitsIn128GB);
  }
  return MODELS.filter((m) => m.fitsIn256GB);
}
