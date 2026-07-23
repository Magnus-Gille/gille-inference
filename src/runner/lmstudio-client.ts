import OpenAI from 'openai';
import { performance } from 'node:perf_hooks';
import type { InferenceOptions } from './openrouter-client.js';
import type { LocalInferenceResult } from './local-client.js';

/**
 * LM Studio inference client.
 *
 * LM Studio exposes an OpenAI-compatible server (default http://localhost:1234/v1),
 * unlike Ollama's native /api/chat. The model must already be loaded in LM Studio
 * (e.g. via `lms load <id>`); this client does NOT warm/unload — LM Studio manages
 * residency itself. Streams the completion to capture TTFT and tok/s, mirroring the
 * local-ollama metrics so downstream analysis is identical.
 */

const DEFAULT_BASE_URL = 'http://localhost:1234/v1';

function getBaseUrl(): string {
  return process.env['LMSTUDIO_BASE_URL'] ?? DEFAULT_BASE_URL;
}

function createClient(): OpenAI {
  return new OpenAI({
    baseURL: getBaseUrl(),
    apiKey: process.env['LMSTUDIO_API_KEY'] ?? 'lm-studio', // LM Studio ignores the key
  });
}

/** Check the LM Studio server is reachable and report the loaded model ids. */
export async function listLmStudioModels(): Promise<string[]> {
  try {
    const res = await fetch(`${getBaseUrl()}/models`);
    if (!res.ok) return [];
    const data = (await res.json()) as { data?: Array<{ id: string }> };
    return (data.data ?? []).map((m) => m.id);
  } catch {
    return [];
  }
}

export async function runLmStudioInference(
  modelId: string,
  prompt: string,
  options: InferenceOptions & { signal?: AbortSignal } = {}
): Promise<LocalInferenceResult> {
  const { systemPrompt, maxTokens = 4096, temperature = 0.0, responseFormat } = options;
  // Sampler floor for reasoning/MoE models: greedy decoding (temp 0) sends models
  // like Mellum2 into degenerate repetition loops that run to the token cap. Apply
  // the recommended sampler (top_p/top_k) and clamp temperature off zero.
  const topP = options.topP ?? 0.95;
  const topK = options.topK ?? 20;
  const minP = options.minP;
  const effectiveTemp = temperature <= 0 ? 0.6 : temperature;

  const client = createClient();

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  } else {
    messages.push({
      role: 'system',
      content:
        'You are a helpful expert software engineer. Respond with clear, well-structured answers. For coding tasks, provide working code with brief explanations.',
    });
  }
  messages.push({ role: 'user', content: prompt });

  const start = performance.now();
  let firstTokenAt: number | null = null;
  let content = '';

  try {
    const stream = await client.chat.completions.create({
      model: modelId,
      messages,
      max_tokens: maxTokens,
      temperature: effectiveTemp,
      top_p: topP,
      // top_k is not in the OpenAI type but LM Studio honors it; pass through.
      top_k: topK,
      ...(minP !== undefined ? { min_p: minP } : {}),
      // Grammar-constrained structured output (#166). Only sent when the caller/task supplies one:
      // for gpt-oss-120b a json_object/json_schema format engages llama.cpp's constrained decoder and
      // prevents the harmony/PEG 500; omitting it entirely preserves the unconstrained default.
      ...(responseFormat ? { response_format: responseFormat } : {}),
      stream: true,
      stream_options: { include_usage: true },
    } as OpenAI.Chat.ChatCompletionCreateParamsStreaming & { top_k: number; min_p?: number },
      options.signal ? { signal: options.signal } : undefined);

    let promptTokens = 0;
    let completionTokens = 0;
    let reasoningChars = 0;
    let finishReason: string | null = null;

    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      const choiceDelta = choice?.delta as
        | (OpenAI.Chat.ChatCompletionChunk.Choice.Delta & {
            reasoning_content?: string | null;
            reasoning?: string | null;
          })
        | undefined;
      // Thinking models (Mellum2) stream reasoning in a separate channel. Count it
      // toward TTFT (generation has started) but keep it out of the stored answer.
      const reasoningDelta = choiceDelta?.reasoning_content ?? choiceDelta?.reasoning;
      if (reasoningDelta) {
        if (firstTokenAt === null) firstTokenAt = performance.now();
        reasoningChars += reasoningDelta.length;
      }
      const delta = choiceDelta?.content;
      if (delta) {
        if (firstTokenAt === null) firstTokenAt = performance.now();
        content += delta;
      }
      if (chunk.usage) {
        promptTokens = chunk.usage.prompt_tokens ?? promptTokens;
        completionTokens = chunk.usage.completion_tokens ?? completionTokens;
      }
      if (typeof choice?.finish_reason === 'string') {
        finishReason = choice.finish_reason;
      }
    }
    void reasoningChars; // (available for diagnostics; not persisted)

    const end = performance.now();
    const durationMs = Math.round(end - start);
    const ttftMs = firstTokenAt !== null ? Math.round(firstTokenAt - start) : durationMs;

    // A token-limit terminal reason means the visible content is not a complete answer. This is
    // true both when reasoning consumed the whole budget (empty content) and when the answer was
    // cut mid-token. Never pass the stump to a verifier: surface the provider signal explicitly so
    // /delegate records capability-relevant `truncated` evidence and can escalate/retry upstream.
    if (finishReason === 'length') {
      return {
        ok: false,
        error:
          `LM Studio completion truncated: finish_reason=length, max_tokens=${maxTokens}, ` +
          `completion_tokens=${completionTokens}, visible_content_chars=${content.length}`,
        finishReason,
        truncated: true,
        promptTokens,
        completionTokens,
        durationMs,
        ttftMs,
      };
    }

    if (!content || content.trim() === '') {
      return { ok: false, error: 'Empty response from LM Studio model' };
    }

    // tok/s over the generation phase (after first token), the meaningful local metric.
    const genSeconds = firstTokenAt !== null ? (end - firstTokenAt) / 1000 : durationMs / 1000;
    const tokensPerSecond =
      completionTokens > 0 && genSeconds > 0
        ? Math.round((completionTokens / genSeconds) * 10) / 10
        : 0;

    return {
      ok: true,
      response: content,
      promptTokens,
      completionTokens,
      durationMs,
      ttftMs,
      tokensPerSecond,
      provider: 'local-ollama', // reuse the local result tag so analysis treats it as local hardware
      finishReason,
      truncated: false,
    };
  } catch (err) {
    if (err instanceof Error) return { ok: false, error: `LM Studio error: ${err.message}` };
    return { ok: false, error: String(err) };
  }
}
