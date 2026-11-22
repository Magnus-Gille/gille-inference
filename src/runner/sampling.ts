/**
 * Effective-sampling resolution for local OpenAI-compatible backends (LM Studio / llama.cpp).
 *
 * Why this exists: the LM Studio client used to rewrite a requested `temperature <= 0` to 0.6
 * silently, and it never sent a seed. A run configured as "temperature 0" therefore actually ran
 * unseeded at 0.6, and nothing in a result row said so. Run records must describe the sampling that
 * was SENT to the backend, not the sampling that was requested.
 *
 * Decision (kept on purpose): the 0.6 floor itself stays the default. Greedy decoding sends some
 * reasoning/MoE models (Mellum2, qwen35-a3b) into repetition loops that run to the token cap, and
 * production delegation quality was measured with the floor in place. Removing it silently would be
 * the same class of bug in the other direction. Instead the floor is now:
 *   - explicit: callers can pass `temperatureFloor: false` (send literal 0) or another value;
 *   - visible: `temperatureFloorApplied` is true on every result where it changed the request;
 *   - recorded: `requestedTemperature` and the effective `temperature` are both returned.
 *
 * Seed: forwarded only when the caller sets one. No default seed here, because the delegate
 * format-retry (#164) relies on an identical retry being able to produce a different sample. Eval
 * runners own their seed policy (run-batch defaults to seed 1; extra trials vary it explicitly).
 */

/** Established safety floor applied to requested temperatures <= 0 on local backends. */
export const DEFAULT_LOCAL_TEMPERATURE_FLOOR = 0.6;

export interface SamplingRequest {
  temperature?: number;
  topP?: number;
  topK?: number;
  minP?: number;
  seed?: number;
  /**
   * Temperature used when the requested temperature is <= 0. `false` disables the floor and sends
   * the requested value as-is (true greedy decoding). Defaults to DEFAULT_LOCAL_TEMPERATURE_FLOOR.
   */
  temperatureFloor?: number | false;
}

/** The sampling parameters actually sent to the backend, plus what was asked for. */
export interface EffectiveSampling {
  /** Temperature the caller asked for (after the caller's own defaulting). */
  requestedTemperature: number;
  /** Temperature actually sent to the backend. */
  temperature: number;
  /** True when the floor replaced the requested temperature. */
  temperatureFloorApplied: boolean;
  /** Seed actually sent; null when none was sent (backend picks a random seed). */
  seed: number | null;
  topP: number | null;
  topK: number | null;
  minP: number | null;
}

export interface SamplingDefaults {
  temperature: number;
  topP?: number;
  topK?: number;
  minP?: number;
  temperatureFloor: number | false;
}

/** Pure: resolve what will be sent. Never throws; invalid seeds are a caller-validation concern. */
export function resolveEffectiveSampling(
  req: SamplingRequest,
  defaults: SamplingDefaults
): EffectiveSampling {
  const requestedTemperature = req.temperature ?? defaults.temperature;
  const floor = req.temperatureFloor ?? defaults.temperatureFloor;
  const temperatureFloorApplied = floor !== false && requestedTemperature <= 0;
  return {
    requestedTemperature,
    temperature: temperatureFloorApplied ? (floor as number) : requestedTemperature,
    temperatureFloorApplied,
    seed: req.seed ?? null,
    topP: req.topP ?? defaults.topP ?? null,
    topK: req.topK ?? defaults.topK ?? null,
    minP: req.minP ?? defaults.minP ?? null,
  };
}

/**
 * Largest seed that is really a fixed seed. llama.cpp stores seeds as uint32 and treats
 * 0xFFFFFFFF (and -1) as "pick a random seed", so a larger value would be recorded as seeded but
 * run random.
 */
export const MAX_SEED = 0xfffffffe;

/** True when `seed` is an integer in [0, MAX_SEED]. */
export function isValidSeed(seed: unknown): seed is number {
  return typeof seed === "number" && Number.isSafeInteger(seed) && seed >= 0 && seed <= MAX_SEED;
}

/** `seed + k`, wrapped into [0, MAX_SEED] so derived seeds (repeats, retries) stay valid. */
export function offsetSeed(seed: number, k: number): number {
  return (seed + k) % (MAX_SEED + 1);
}

const warnedFloorModels = new Set<string>();

/**
 * Log once per process and model that the temperature floor changed a request. Content-blind:
 * only the model id and the two numbers are logged.
 */
export function warnTemperatureFloorOnce(modelId: string, sampling: EffectiveSampling): void {
  if (!sampling.temperatureFloorApplied || warnedFloorModels.has(modelId)) return;
  warnedFloorModels.add(modelId);
  console.warn(
    `[sampling] ${modelId}: requested temperature ${sampling.requestedTemperature} raised to ` +
      `${sampling.temperature} by the local temperature floor (pass temperatureFloor:false for greedy). ` +
      `Recorded as temperatureFloorApplied=true.`
  );
}

/** Test-only: reset the once-per-model warning memory. */
export function resetTemperatureFloorWarningsForTest(): void {
  warnedFloorModels.clear();
}

/**
 * The sampling runLmStudioInference sends for these options (top_p 0.95 / top_k 20 defaults, the
 * 0.6 floor). Lives here, not in the client, so a caller that loses the result to a timeout or a
 * thrown abort can still record what the attempt was sent with.
 */
export function lmStudioEffectiveSampling(options: SamplingRequest): EffectiveSampling {
  return resolveEffectiveSampling(options, {
    temperature: 0,
    topP: 0.95,
    topK: 20,
    temperatureFloor: DEFAULT_LOCAL_TEMPERATURE_FLOOR,
  });
}
