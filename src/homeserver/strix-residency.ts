import type { StrixResidentEntry } from "./strix-combined-experiment.js";

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const RESTORE_TIMEOUT_MS = 600_000;

export interface StrixResidencyDependencies {
  fetch: typeof fetch;
  sleep(milliseconds: number): Promise<void>;
  now(): number;
}

const DEFAULT_DEPENDENCIES: StrixResidencyDependencies = {
  fetch,
  sleep: async (milliseconds) => await new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)),
  now: Date.now,
};

async function readBounded(response: Response, limit = MAX_RESPONSE_BYTES): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > limit) {
      await reader.cancel();
      throw new Error(`response exceeds ${limit} bytes`);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

export async function runningSnapshot(
  origin: string,
  dependencies: StrixResidencyDependencies = DEFAULT_DEPENDENCIES,
): Promise<StrixResidentEntry[]> {
  const response = await dependencies.fetch(`${origin}/running`, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`llama-swap /running returned ${response.status}`);
  const parsed = JSON.parse(await readBounded(response)) as unknown;
  if (parsed === null || typeof parsed !== "object" || !Array.isArray((parsed as { running?: unknown }).running)) {
    throw new Error("llama-swap returned malformed residency evidence");
  }
  const entries = (parsed as { running: unknown[] }).running;
  if (!entries.every((entry) => entry !== null && typeof entry === "object" &&
    typeof (entry as StrixResidentEntry).model === "string" && typeof (entry as StrixResidentEntry).state === "string")) {
    throw new Error("llama-swap returned malformed residency entries");
  }
  return entries as StrixResidentEntry[];
}

export async function unloadAll(
  origin: string,
  dependencies: StrixResidencyDependencies = DEFAULT_DEPENDENCIES,
): Promise<void> {
  const response = await dependencies.fetch(`${origin}/api/models/unload`, {
    method: "POST", signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`llama-swap unload returned ${response.status}`);
  await readBounded(response, 4_096);
  const deadline = dependencies.now() + 120_000;
  while (dependencies.now() < deadline) {
    if ((await runningSnapshot(origin, dependencies)).length === 0) return;
    await dependencies.sleep(250);
  }
  throw new Error("llama-swap did not become empty after unload");
}

function exactRestoreAnswer(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as { choices?: Array<{ message?: { content?: unknown } }> };
    return parsed.choices?.[0]?.message?.content?.toString().trim() === "OK";
  } catch {
    return false;
  }
}

export async function restoreResidency(
  origin: string,
  initial: StrixResidentEntry[],
  dependencies: StrixResidencyDependencies = DEFAULT_DEPENDENCIES,
): Promise<void> {
  await unloadAll(origin, dependencies);
  const ready = initial.filter((entry) => entry.state === "ready");
  if (ready.length === 0) return;
  if (ready.length !== 1) throw new Error("cannot restore more than one initially ready model on the serial GPU");
  const model = ready[0]!.model;
  const response = await dependencies.fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(RESTORE_TIMEOUT_MS),
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "Reply with exactly OK." }],
      max_tokens: 8,
      temperature: 0,
      seed: 1,
      stream: false,
    }),
  });
  const body = await readBounded(response);
  if (!response.ok) throw new Error(`restoring ${model} returned ${response.status}`);
  if (!exactRestoreAnswer(body)) throw new Error(`restored model ${model} failed the exact OK smoke test`);
  const deadline = dependencies.now() + RESTORE_TIMEOUT_MS;
  while (dependencies.now() < deadline) {
    const current = await runningSnapshot(origin, dependencies);
    if (current.length === 1 && current[0]!.model === model && current[0]!.state === "ready") return;
    await dependencies.sleep(500);
  }
  throw new Error(`restored model ${model} did not reach the ready state`);
}
