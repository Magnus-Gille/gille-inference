import {
  parseExecutionTrafficPurpose,
  type ExecutionTrafficPurpose,
} from "./execution-feedback-contract.js";

export interface NormalizedAskArgs<OutputProfile extends string = string> {
  model: string;
  prompt: string;
  system?: string;
  outputProfile?: OutputProfile;
  delegatorModelId?: string;
  trafficPurpose: ExecutionTrafficPurpose;
  files?: string[];
  temperature?: number;
  topP?: number;
  topK?: number;
  minP?: number;
}

export type AskArgumentNormalizationResult<OutputProfile extends string = string> =
  | { ok: true; value: NormalizedAskArgs<OutputProfile> }
  | { ok: false; message: string };

/**
 * Normalize only the ask tool's syntax. Authorization, file access, and all metered work remain
 * in mcp.ts. The validation sequence is part of the public MCP behavior and is intentionally
 * kept in the same order as the original callTool branch.
 */
export function normalizeAskArgs<OutputProfile extends string>(
  args: Record<string, unknown>,
  completeWithinBudgetProfile: OutputProfile,
): AskArgumentNormalizationResult<OutputProfile> {
  const model = typeof args["model"] === "string" ? args["model"] : "";
  const prompt = typeof args["prompt"] === "string" ? args["prompt"] : "";
  const system = typeof args["system"] === "string" ? args["system"] : undefined;

  const rawOutputProfile = args["output_profile"];
  if (rawOutputProfile !== undefined && rawOutputProfile !== completeWithinBudgetProfile) {
    return {
      ok: false,
      message: `'output_profile' must be '${completeWithinBudgetProfile}' when supplied.`,
    };
  }
  const outputProfile = rawOutputProfile === completeWithinBudgetProfile
    ? completeWithinBudgetProfile
    : undefined;

  const rawDelegatorModelId = args["delegator_model_id"] ?? args["delegatorModelId"];
  if (
    rawDelegatorModelId !== undefined &&
    (typeof rawDelegatorModelId !== "string" || rawDelegatorModelId.trim() === "")
  ) {
    return { ok: false, message: "'delegator_model_id' must be a non-empty string when supplied." };
  }
  const delegatorModelId = typeof rawDelegatorModelId === "string" ? rawDelegatorModelId : undefined;

  const trafficPurpose = parseExecutionTrafficPurpose(args["traffic_purpose"]);
  if (!trafficPurpose.ok) return { ok: false, message: "Invalid traffic_purpose." };

  if (model === "" || prompt === "") {
    return { ok: false, message: "Both 'model' and 'prompt' are required." };
  }

  const samplerSpecs = [
    ["temperature", 0, 2, false],
    ["top_p", 0, 1, false],
    ["top_k", 0, Number.MAX_SAFE_INTEGER, true],
    ["min_p", 0, 1, false],
  ] as const;
  for (const [field, min, max, integer] of samplerSpecs) {
    const value = args[field];
    if (value === undefined) continue;
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < min ||
      value > max ||
      (integer && !Number.isInteger(value))
    ) {
      return {
        ok: false,
        message: `'${field}' must be ${integer ? "an integer" : "a number"} in [${min}, ${max}].`,
      };
    }
  }

  let files: string[] | undefined;
  if (args["files"] !== undefined) {
    const raw = args["files"];
    if (!Array.isArray(raw) || raw.length === 0 || !raw.every((file) => typeof file === "string" && file.length > 0)) {
      return { ok: false, message: "'files' must be a non-empty array of absolute path strings." };
    }
    files = raw as string[];
  }

  return {
    ok: true,
    value: {
      model,
      prompt,
      system,
      outputProfile,
      delegatorModelId,
      trafficPurpose: trafficPurpose.value,
      files,
      temperature: typeof args["temperature"] === "number" ? args["temperature"] : undefined,
      topP: typeof args["top_p"] === "number" ? args["top_p"] : undefined,
      topK: typeof args["top_k"] === "number" ? args["top_k"] : undefined,
      minP: typeof args["min_p"] === "number" ? args["min_p"] : undefined,
    },
  };
}
