export type StrixLongGenerationRuntime = "production" | "candidate";

export interface StrixLongGenerationSample {
  runtime: StrixLongGenerationRuntime;
  ok: boolean;
  finishReason: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  outputSha256: string | null;
  outputBytes: number;
  responseBytes: number;
  ttftMs: number | null;
  totalMs: number;
  predictedTokensPerSecond: number | null;
  serverArgsSha256: string;
  serverLogSha256: string;
  serverLogBytes: number;
}

export interface StrixLongGenerationEvaluation {
  decision: "pass" | "reject";
  reasons: string[];
  minimumCompletionTokens: number;
  outputHashesMatch: boolean;
  completionTokensMatch: boolean;
  serverArgsMatch: boolean;
  deploymentAuthorized: false;
}

const CONTROLLED_ARGS = new Set([
  "-m", "--model", "--host", "--no-host", "--port", "--reuse-port",
  "-ctk", "--cache-type-k", "-ctv", "--cache-type-v",
  "--mmap", "--no-mmap", "--metrics", "--log-file", "--log-prompts-dir",
]);

export function buildLongGenerationServerArgs(input: {
  port: number;
  modelPath: string;
  commonArgs: string[];
  kvK: "f16" | "q8_0";
  kvV: "f16" | "q8_0";
}): string[] {
  for (const item of input.commonArgs) {
    const flag = item.split("=", 1)[0]!;
    if (CONTROLLED_ARGS.has(flag) || /^--(?:spec|draft)/.test(flag)) {
      throw new Error(`${flag} is controlled by the long-generation runner`);
    }
  }
  return [
    "--host", "127.0.0.1", "--port", String(input.port), "-m", input.modelPath,
    ...input.commonArgs,
    "-ctk", input.kvK, "-ctv", input.kvV,
    "--mmap", "--metrics",
  ];
}

export function evaluateLongGenerationEquivalence(
  production: StrixLongGenerationSample,
  candidate: StrixLongGenerationSample,
  minimumCompletionTokens: number,
): StrixLongGenerationEvaluation {
  if (!Number.isInteger(minimumCompletionTokens) || minimumCompletionTokens < 1) {
    throw new Error("minimumCompletionTokens must be a positive integer");
  }
  if (production.runtime !== "production" || candidate.runtime !== "candidate") {
    throw new Error("long-generation samples must be production then candidate");
  }
  const reasons: string[] = [];
  for (const sample of [production, candidate]) {
    if (!sample.ok) reasons.push(`${sample.runtime} long generation was not transport-complete`);
    if (sample.finishReason !== "length") reasons.push(`${sample.runtime} long generation did not finish at the requested token limit`);
    if (sample.completionTokens === null || sample.completionTokens < minimumCompletionTokens) {
      reasons.push(`${sample.runtime} long generation did not reach the ${minimumCompletionTokens}-token minimum`);
    }
    if (sample.outputSha256 === null) reasons.push(`${sample.runtime} long generation is missing an output hash`);
  }
  const outputHashesMatch = production.outputSha256 !== null && production.outputSha256 === candidate.outputSha256;
  if (!outputHashesMatch) reasons.push("production and candidate long-generation output hashes differ");
  const completionTokensMatch = production.completionTokens !== null && production.completionTokens === candidate.completionTokens;
  if (!completionTokensMatch) reasons.push("production and candidate completion-token counts differ");
  if (production.promptTokens === null || production.promptTokens <= 0 || production.promptTokens !== candidate.promptTokens) {
    reasons.push("production and candidate prompt-token counts differ or are missing");
  }
  const serverArgsMatch = production.serverArgsSha256 === candidate.serverArgsSha256;
  if (!serverArgsMatch) reasons.push("production and candidate server arguments differ");
  return {
    decision: reasons.length === 0 ? "pass" : "reject",
    reasons: reasons.length === 0
      ? ["stock and patched Q8-KV runtimes produced byte-identical deterministic long generations"]
      : reasons,
    minimumCompletionTokens,
    outputHashesMatch,
    completionTokensMatch,
    serverArgsMatch,
    deploymentAuthorized: false,
  };
}
