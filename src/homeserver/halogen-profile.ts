/** Pinned, lab-only Halogen profile (#317). No I/O and no production authority. */
import { createHash } from 'node:crypto';
import { z } from 'zod';

export const HALOGEN_IMAGE = 'ghcr.io/peonist-ai/halogen-flash-server@sha256:2322c4d91cd90aae628ac02f7dfd158f078b59789786cdb3297a7bcba2eb0cea';
export const HALOGEN_MODEL_REVISION = 'ce9480a4155465ae670c2c5e5663a5aedc0712c3';
export const halogenProfileSchema = z.object({
  schemaVersion: z.literal(1),
  model: z.literal('qwen38-flash-next'),
  image: z.literal(HALOGEN_IMAGE),
  modelRevision: z.literal(HALOGEN_MODEL_REVISION),
  context: z.union([z.literal(32768), z.literal(65536)]),
  maxTokens: z.literal(16384),
  slots: z.literal(1),
  cacheMode: z.union([z.literal(1), z.literal(2)]),
  temperature: z.literal(1),
  topP: z.literal(0.95),
  topK: z.literal(20),
  minP: z.literal(0),
  presencePenalty: z.literal(0),
  thinking: z.literal(true),
  preserveThinking: z.literal(true),
  reasoningEffort: z.literal('xhigh'),
  mtp: z.literal(true),
  maxTaskSeconds: z.literal(2700),
}).strict();
export type HalogenProfile = z.infer<typeof halogenProfileSchema>;
export const HALOGEN_PILOT_PROFILE: HalogenProfile = {
  schemaVersion: 1, model: 'qwen38-flash-next', image: HALOGEN_IMAGE,
  modelRevision: HALOGEN_MODEL_REVISION, context: 32768, maxTokens: 16384,
  slots: 1, cacheMode: 1, temperature: 1, topP: 0.95, topK: 20, minP: 0,
  presencePenalty: 0, thinking: true, preserveThinking: true, reasoningEffort: 'xhigh',
  mtp: true, maxTaskSeconds: 2700,
};
export function halogenProfileHash(input: unknown): string {
  const profile = halogenProfileSchema.parse(input);
  return createHash('sha256').update(JSON.stringify(profile)).digest('hex');
}
export function halogenEnvironment(input: unknown): Record<string, string> {
  const p = halogenProfileSchema.parse(input);
  return {
    HALOGEN_MODEL_ID: p.model,
    HALOGEN_CTX: String(p.context), HALOGEN_KV_POOL_POSITIONS: String(p.context),
    HALOGEN_KV_SLOTS: '1', HALOGEN_KV_POOL_FIT: '0', HALOGEN_MAX_TOK: '16384',
    HALOGEN_PROMPT_CACHE: String(p.cacheMode), HALOGEN_COMPOSABLE_CONTEXT: '0',
    HALOGEN_DRAFTER_DEFAULT: '1', HALOGEN_PLD: '0',
    HALOGEN_MAX_TOKENS_DEFAULT: String(p.maxTokens), HALOGEN_MAX_TOKENS_CAP: String(p.maxTokens),
    HALOGEN_TEMPERATURE: '1', HALOGEN_TOP_P: '0.95', HALOGEN_TOP_K: '20',
    HALOGEN_MIN_P: '0', HALOGEN_PRESENCE_PENALTY: '0', HALOGEN_ENABLE_THINKING: '1',
    HALOGEN_REASONING_EFFORT: p.reasoningEffort,
    HALOGEN_CHECKPOINT: '/models/qwen38-flash-next-w4b.hgn',
    HALOGEN_CK_OVERLAY: '/models/qwen38-flash-next-w4b.overlay.hgn',
    HALOGEN_TOKENIZER: '/models/tokenizer', HF_HUB_OFFLINE: '1',
  };
}
/** Enforce the experiment profile at the trusted client boundary; never silently inherit defaults. */
export function halogenRequest(input: unknown, messages: unknown[]): Record<string, unknown> {
  const p = halogenProfileSchema.parse(input);
  return {
    model: p.model, messages, max_tokens: p.maxTokens,
    temperature: p.temperature, top_p: p.topP, top_k: p.topK, min_p: p.minP,
    presence_penalty: p.presencePenalty, reasoning_effort: p.reasoningEffort,
    chat_template_kwargs: { enable_thinking: p.thinking, preserve_thinking: p.preserveThinking },
    stream: false,
  };
}
