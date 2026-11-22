import { performance } from 'node:perf_hooks';
import type { InferenceResult, InferenceOptions } from './openrouter-client.js';
import { resolveEffectiveSampling, type EffectiveSampling } from './sampling.js';

// Re-export types for convenience
export type { InferenceResult, InferenceOptions };

/**
 * Extended result for local inference — includes TTFT and tok/s metrics
 * that are only meaningful for local hardware benchmarking.
 */
export type LocalInferenceResult =
  | {
      ok: true;
      response: string;
      promptTokens: number;
      completionTokens: number;
      durationMs: number;
      ttftMs: number;        // time to first token
      tokensPerSecond: number; // completion_tokens / generation_time
      provider: 'local-ollama';
      /** Terminal provider reason when the backend exposes one. */
      finishReason?: string | null;
      /** Explicit false on a clean terminal response; omitted by backends without this signal. */
      truncated?: false;
      /** Sampling actually sent to the backend (see src/runner/sampling.ts). */
      sampling?: EffectiveSampling;
    }
  | {
      ok: false;
      error: string;
      /** Terminal provider reason when failure classification came from the completion itself. */
      finishReason?: string | null;
      /** True only when the provider explicitly reported a token-limit finish. */
      truncated?: true;
      /** Best-effort diagnostics retained without exposing or verifying the partial answer. */
      promptTokens?: number;
      completionTokens?: number;
      durationMs?: number;
      ttftMs?: number;
      /** Sampling actually sent to the backend, when the request got that far. */
      sampling?: EffectiveSampling;
    };

const DEFAULT_BASE_URL = 'http://localhost:11434';

// Minimum supported Ollama version for reliable think=false and Gemma4 support
export const MIN_OLLAMA_VERSION = '0.20.2';

function getBaseUrl(): string {
  return process.env['OLLAMA_BASE_URL'] ?? DEFAULT_BASE_URL;
}

/**
 * Check if Ollama is running and accessible.
 */
export async function checkOllamaHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${getBaseUrl()}/api/tags`);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * List models currently available in Ollama (pulled to disk).
 */
export async function listOllamaModels(): Promise<string[]> {
  try {
    const res = await fetch(`${getBaseUrl()}/api/tags`);
    if (!res.ok) return [];
    const data = await res.json() as { models?: Array<{ name: string }> };
    return (data.models ?? []).map((m) => m.name);
  } catch {
    return [];
  }
}

/**
 * List models currently loaded in Ollama GPU memory.
 * Uses GET /api/ps.
 */
export async function getLoadedModels(): Promise<string[]> {
  try {
    const res = await fetch(`${getBaseUrl()}/api/ps`);
    if (!res.ok) return [];
    const data = await res.json() as { models?: Array<{ name: string }> };
    return (data.models ?? []).map((m) => m.name);
  } catch {
    return [];
  }
}

/**
 * Pre-warm a model: load it into GPU memory and pin it there.
 * Returns the load duration in ms, or null on failure.
 *
 * Uses the empty-messages pattern: POST /api/chat with messages=[] and keep_alive=-1.
 * Ollama responds with {"done_reason":"load"} once the model is loaded.
 */
export async function warmModel(modelName: string): Promise<number | null> {
  const baseUrl = getBaseUrl();
  const start = performance.now();
  try {
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(600_000), // 10 min — large models can be slow to load from SSD
      body: JSON.stringify({ model: modelName, messages: [], keep_alive: -1 }),
    });
    if (!res.ok) return null;
    await res.json(); // wait for {"done_reason":"load"}
    return Math.round(performance.now() - start);
  } catch {
    return null;
  }
}

/**
 * Unload a model from GPU memory immediately.
 * Uses keep_alive=0 which evicts the model after the (empty) request completes.
 */
export async function unloadModel(modelName: string): Promise<void> {
  const baseUrl = getBaseUrl();
  try {
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({ model: modelName, messages: [], keep_alive: 0 }),
    });
    // Consume the body so the connection closes cleanly
    if (res.ok) await res.json();
  } catch {
    // Best-effort — if Ollama is gone, the model is already unloaded
  }
}

/**
 * Get the running Ollama version string (e.g. "0.20.2").
 * Returns null if Ollama is not reachable or the endpoint is missing.
 */
export async function getOllamaVersion(): Promise<string | null> {
  try {
    const res = await fetch(`${getBaseUrl()}/api/version`);
    if (!res.ok) return null;
    const data = await res.json() as { version?: string };
    return data.version ?? null;
  } catch {
    return null;
  }
}

/**
 * Run inference against a local Ollama instance using the streaming API
 * to capture time-to-first-token.
 */
export async function runLocalInference(
  modelName: string,
  prompt: string,
  options: InferenceOptions = {}
): Promise<LocalInferenceResult> {
  const {
    systemPrompt = 'You are a helpful expert software engineer. Respond with clear, well-structured answers. For coding tasks, provide working code with brief explanations.',
    maxTokens = 4096,
    temperature = 0.0,
    seed,
  } = options;
  // Ollama: no temperature floor (unchanged behaviour); seed goes in `options.seed`.
  const sampling = resolveEffectiveSampling(
    { temperature, seed },
    { temperature: 0, temperatureFloor: false }
  );

  const baseUrl = getBaseUrl();
  const startTime = performance.now();
  let ttftMs = 0;
  let firstTokenReceived = false;

  try {
    // Use Ollama's chat API with streaming to capture TTFT
    // No fetch timeout — local inference on thinking models can take 10+ minutes
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(1_800_000), // 30 minute timeout (cold-start + long generation on slow hardware)
      body: JSON.stringify({
        model: modelName,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt },
        ],
        stream: true,
        think: false,    // disable extended thinking — buffers entire chain before streaming, causing extreme TTFT
        keep_alive: -1,  // pin model in memory between tasks (overrides OLLAMA_KEEP_ALIVE default of 5m)
        options: {
          temperature: sampling.temperature,
          ...(sampling.seed !== null ? { seed: sampling.seed } : {}),
          num_predict: maxTokens,
        },
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      return { ok: false, sampling, error: `Ollama error ${res.status}: ${text.slice(0, 200)}` };
    }

    if (!res.body) {
      return { ok: false, sampling, error: 'No response body from Ollama' };
    }

    // Stream the response to capture TTFT
    const chunks: string[] = [];
    let promptTokens = 0;
    let completionTokens = 0;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const data = JSON.parse(line) as {
            message?: { content?: string };
            done?: boolean;
            prompt_eval_count?: number;
            eval_count?: number;
          };

          if (data.message?.content) {
            if (!firstTokenReceived) {
              ttftMs = Math.round(performance.now() - startTime);
              firstTokenReceived = true;
            }
            chunks.push(data.message.content);
          }

          if (data.done) {
            promptTokens = data.prompt_eval_count ?? 0;
            completionTokens = data.eval_count ?? 0;
          }
        } catch {
          // Skip malformed JSON lines
        }
      }
    }

    const durationMs = Math.round(performance.now() - startTime);
    const response = chunks.join('');

    if (!response || response.trim() === '') {
      return { ok: false, sampling, error: 'Empty response from Ollama' };
    }

    // Calculate generation tok/s (excluding prompt processing time)
    const generationTimeMs = durationMs - ttftMs;
    const tokensPerSecond = generationTimeMs > 0
      ? Math.round((completionTokens / generationTimeMs) * 1000 * 10) / 10
      : 0;

    return {
      ok: true,
      response,
      promptTokens,
      completionTokens,
      durationMs,
      ttftMs,
      tokensPerSecond,
      provider: 'local-ollama',
      sampling,
    };
  } catch (err) {
    if (err instanceof Error) {
      if (err.message.includes('ECONNREFUSED')) {
        return { ok: false, sampling, error: 'Ollama not running — start it with: ollama serve' };
      }
      return { ok: false, sampling, error: err.message };
    }
    return { ok: false, sampling, error: String(err) };
  }
}
