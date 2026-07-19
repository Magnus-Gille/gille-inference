import OpenAI from 'openai';
import { performance } from 'node:perf_hooks';

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * OpenAI-shaped structured-output `response_format` (text | json_object | json_schema).
 * Threaded through to the LOCAL llama.cpp chat call to engage grammar-constrained decoding;
 * this is what structurally prevents gpt-oss-120b's harmony/PEG HTTP-500 on JSON-shaped tasks (#166).
 */
export type ResponseFormat = OpenAI.Chat.Completions.ChatCompletionCreateParams["response_format"];

export type InferenceResult =
  | {
      ok: true;
      response: string;
      promptTokens: number;
      completionTokens: number;
      durationMs: number;
      provider?: string;
    }
  | { ok: false; error: string };

export interface InferenceOptions {
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  /** Nucleus sampling — used by local providers (LM Studio). Ignored by OpenRouter path. */
  topP?: number;
  /** Top-k sampling — used by local providers (LM Studio). Ignored by OpenRouter path. */
  topK?: number;
  /** Min-p sampling — used by local providers (LM Studio / llama.cpp). Ignored by OpenRouter. */
  minP?: number;
  /**
   * Structured-output `response_format` forwarded to the LOCAL (LM Studio / llama.cpp) chat call.
   * A json_object / json_schema value engages grammar-constrained decoding, which structurally
   * prevents gpt-oss-120b's harmony/PEG HTTP-500 on JSON-shaped tasks (#166 — the robust fix behind
   * the #164 retry band-aid). Ignored by the OpenRouter path.
   */
  responseFormat?: ResponseFormat;
}

// ─── Client ───────────────────────────────────────────────────────────────────

function createClient(): OpenAI {
  const apiKey = process.env['OPENROUTER_API_KEY'];
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY environment variable is not set');
  }

  return new OpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey,
    defaultHeaders: {
      'HTTP-Referer': 'https://github.com/magnusgille/gille-inference',
      'X-Title': 'Gille Inference',
    },
  });
}

// ─── Retry logic ──────────────────────────────────────────────────────────────

const RETRY_DELAYS_MS = [1000, 2000, 4000];

function isRetryableError(err: unknown): boolean {
  if (err instanceof OpenAI.APIError) {
    return err.status === 429 || (err.status !== undefined && err.status >= 500);
  }
  return false;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function runInference(
  modelId: string,
  prompt: string,
  options: InferenceOptions = {}
): Promise<InferenceResult> {
  const {
    systemPrompt,
    maxTokens = 4096,
    temperature = 0.0,
  } = options;

  const client = createClient();

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  } else {
    messages.push({ role: 'system', content: 'You are a helpful expert software engineer. Respond with clear, well-structured answers. For coding tasks, provide working code with brief explanations.' });
  }
  messages.push({ role: 'user', content: prompt });

  let lastError: unknown;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      await sleep(RETRY_DELAYS_MS[attempt - 1]!);
    }

    const start = performance.now();

    try {
      const completion = await client.chat.completions.create({
        model: modelId,
        messages,
        max_tokens: maxTokens,
        temperature,
      });

      const durationMs = Math.round(performance.now() - start);
      const choice = completion.choices[0];

      if (!choice) {
        return { ok: false, error: 'No choices in response' };
      }

      // Some models (especially reasoning models like DeepSeek R1) may put
      // content in non-standard fields. Try multiple locations.
      const msg = choice.message as unknown as Record<string, unknown>;
      const content = (msg.content as string | null)
        ?? (msg.reasoning_content as string | null)
        ?? null;

      if (!content || content.trim() === '') {
        const finishReason = choice.finish_reason ?? 'unknown';
        return { ok: false, error: `Empty response from model (finish_reason: ${finishReason})` };
      }

      return {
        ok: true,
        response: content,
        promptTokens: completion.usage?.prompt_tokens ?? 0,
        completionTokens: completion.usage?.completion_tokens ?? 0,
        durationMs,
        provider: (completion as unknown as { provider?: string }).provider,
      };
    } catch (err) {
      lastError = err;
      if (!isRetryableError(err) || attempt === RETRY_DELAYS_MS.length) {
        break;
      }
    }
  }

  if (lastError instanceof OpenAI.APIError) {
    return { ok: false, error: `OpenRouter API error ${lastError.status}: ${lastError.message}` };
  }
  if (lastError instanceof Error) {
    return { ok: false, error: lastError.message };
  }
  return { ok: false, error: String(lastError) };
}
