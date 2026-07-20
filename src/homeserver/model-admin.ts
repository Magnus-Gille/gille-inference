/**
 * Backend-selection facade for model admin operations.
 *
 * Reads `loadConfig().backend` AT CALL TIME (not at import time) so that
 * `setConfig({ backend })` takes effect within the same process — critical for tests.
 *
 * Default (or any unrecognized value) routes to llama-swap.
 * Set HOMESERVER_BACKEND=lmstudio to route to the DEPRECATED LM Studio adapter (#146,
 * kept for one release only).
 */

import { loadConfig } from "./config.js";
import * as lmStudio from "./lmstudio-admin.js";
import * as llamaSwap from "./llamaswap-admin.js";

export type { ModelInfo, LoadResult, LoadOptions } from "./lmstudio-admin.js";

function backend(): typeof lmStudio {
  return loadConfig().backend === "llamaswap" ? llamaSwap : lmStudio;
}

export function listModels(): Promise<import("./lmstudio-admin.js").ModelInfo[]> {
  return backend().listModels();
}

export function getLoaded(): Promise<Array<{ key: string; contextLength: number | null }>> {
  return backend().getLoaded();
}

/**
 * Genuinely observed served-model command string for `modelId` on the active backend, or null
 * when not running / not observable (#5). Feeds `evidenceIdentityFromServedModelCmd` — never
 * used to fabricate an identity, only to honestly report what was (or wasn't) observed.
 */
export function getRunningCmd(modelId: string): Promise<string | null> {
  return backend().getRunningCmd(modelId);
}

export function loadModel(
  modelKey: string,
  opts?: import("./lmstudio-admin.js").LoadOptions
): Promise<import("./lmstudio-admin.js").LoadResult> {
  return backend().loadModel(modelKey, opts);
}

export function unloadModel(modelKey?: string): Promise<{ ok: boolean; message: string }> {
  return backend().unloadModel(modelKey);
}

export function ensureLoaded(
  modelKey: string,
  minContext?: number,
  opts?: import("./lmstudio-admin.js").LoadOptions
): Promise<import("./lmstudio-admin.js").LoadResult> {
  return backend().ensureLoaded(modelKey, minContext, opts);
}

export function downloadModel(
  modelKey: string,
  opts?: { wait?: boolean; timeoutMs?: number }
): Promise<{ ok: boolean; started: boolean; message: string }> {
  return backend().downloadModel(modelKey, opts);
}
