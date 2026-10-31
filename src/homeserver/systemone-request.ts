/** Bounded, text/JSON-only request contract for the customer decision-model surface. */
// Classification must survive a missing enablement setting while a model remains in the
// llama-swap roster. Add each reviewed decision-model ID here before it can be served.
const KNOWN_DECISION_MODELS = new Set(["clef-flash", "bespoke-nimble-9b", "pplx-decider-v1-27b"]);

export function isSystemOneDecisionModel(model: string, enabledModels: readonly string[]): boolean {
  return KNOWN_DECISION_MODELS.has(model) || enabledModels.includes(model);
}

export class SystemOneRequestError extends Error {
  constructor(readonly param: string, message: string) {
    super(message);
    this.name = "SystemOneRequestError";
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface SystemOneRequest {
  model: string;
  body: { model: string; state: unknown; questions: Record<string, unknown>; input_token_limit?: number };
}

export class SystemOneResponseError extends Error {}

const CHOICE_CRITERIA_HELP = 'Choice needs a criteria object with 2 to 26 named options, e.g. '
  + '{"billing":"Payment issue","support":"Technical issue"}. '
  + 'Option names use letters A-Z/a-z, digits, underscores or hyphens (1 to 64 characters); descriptions are strings or null.';

/** The first serving contract fixes ctx=8192. */
export const SYSTEMONE_MAX_TOKENS_PER_QUESTION = 8192;

/** Maximum raw UTF-8 JSON request body accepted by the System One gateway surface. */
export const SYSTEMONE_MAX_BODY_BYTES = 256 * 1024;

export function systemOneTokenReservation(request: SystemOneRequest): number {
  // Clef reads all questions in one prompt. Other System One models may evaluate them separately.
  if (request.model === "clef-flash") return SYSTEMONE_MAX_TOKENS_PER_QUESTION;
  return Object.keys(request.body.questions).length * (request.body.input_token_limit ?? SYSTEMONE_MAX_TOKENS_PER_QUESTION);
}

/** Configured bounds, not a claim of measured usable context or current residency. */
export function systemOneModelContract(model: string) {
  return { model, maxQuestions: 16, maxBodyBytes: SYSTEMONE_MAX_BODY_BYTES,
    contextTokens: SYSTEMONE_MAX_TOKENS_PER_QUESTION,
    contextScope: model === "clef-flash" ? "shared_request" : "per_question",
    inputTokenLimitSupported: model === "bespoke-nimble-9b",
    billingPolicy: model === "bespoke-nimble-9b" ? "shared_prefix_once_when_reported" : "input_tokens",
    qualification: "configured_not_measured" };
}

/** Explicit native accounting metadata is optional for backwards compatibility. */
export function systemOneBillableTokens(payload: unknown, request: SystemOneRequest, inputTokens: number): number {
  if (!record(payload) || !record(payload["usage"])) throw new SystemOneResponseError("invalid usage");
  const usage = payload["usage"];
  if (usage["billable_input_tokens"] === undefined && usage["shared_prefix_tokens"] === undefined) return inputTokens;
  const billable = usage["billable_input_tokens"], shared = usage["shared_prefix_tokens"];
  const count = Object.keys(request.body.questions).length;
  if (request.model !== "bespoke-nimble-9b" || typeof billable !== "number" || !Number.isSafeInteger(billable) ||
      typeof shared !== "number" || !Number.isSafeInteger(shared) || shared < 0 || shared > Math.floor(inputTokens / count) ||
      billable <= 0 || billable !== inputTokens - (count - 1) * shared) {
    throw new SystemOneResponseError("invalid billable usage");
  }
  return billable;
}

function probability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function distribution(value: unknown, keys: string[]): boolean {
  if (!record(value) || Object.keys(value).length !== keys.length ||
    keys.some((key) => !probability(value[key]))) return false;
  const total = keys.reduce((sum, key) => sum + (value[key] as number), 0);
  return Math.abs(total - 1) <= 0.02;
}

/** Reject malformed upstream decisions before exposing or charging a customer response. */
export function validateSystemOneResponse(payload: unknown, request: SystemOneRequest): number {
  if (!record(payload) || !record(payload["answers"]) || !record(payload["usage"])) {
    throw new SystemOneResponseError("invalid System One response");
  }
  const inputTokens = payload["usage"]["input_tokens"];
  if (typeof inputTokens !== "number" || !Number.isSafeInteger(inputTokens) || inputTokens <= 0 ||
    inputTokens > systemOneTokenReservation(request) || payload["usage"]["output_tokens"] !== 0) {
    throw new SystemOneResponseError("invalid System One token usage");
  }
  const answers = payload["answers"];
  const questions = request.body.questions;
  if (Object.keys(answers).length !== Object.keys(questions).length) {
    throw new SystemOneResponseError("System One answer count mismatch");
  }
  for (const [id, questionValue] of Object.entries(questions)) {
    const answer = answers[id];
    if (!record(questionValue) || !record(answer) || answer["type"] !== questionValue["type"]) {
      throw new SystemOneResponseError("System One answer type mismatch");
    }
    if (questionValue["type"] === "noul") {
      if (!probability(answer["noul"])) throw new SystemOneResponseError("invalid noul probability");
    } else if (questionValue["type"] === "choice") {
      const criteria = questionValue["criteria"] as Record<string, unknown>;
      const keys = Object.keys(criteria);
      if (typeof answer["choice"] !== "string" || !keys.includes(answer["choice"]) ||
        !distribution(answer["probabilities"], keys) || !probability(answer["confidence"])) {
        throw new SystemOneResponseError("invalid choice distribution");
      }
    } else if (questionValue["type"] === "score") {
      const levels = questionValue["criteria"] as unknown[];
      const keys = levels.map((_, index) => String(index));
      if (typeof answer["score"] !== "number" || !Number.isFinite(answer["score"]) ||
        answer["score"] < 0 || answer["score"] > levels.length - 1 ||
        !distribution(answer["probabilities"], keys) || !probability(answer["confidence"])) {
        throw new SystemOneResponseError("invalid score distribution");
      }
    }
  }
  return inputTokens;
}

export function parseSystemOneBody(raw: string): SystemOneRequest {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new SystemOneRequestError("body", "Body must be valid JSON.");
  }
  if (!record(value)) throw new SystemOneRequestError("body", "Body must be a JSON object.");
  if (Object.keys(value).some((key) => !["model", "state", "questions", "input_token_limit"].includes(key))) {
    throw new SystemOneRequestError("body", "Only model, state, questions, and Nimble input_token_limit are supported.");
  }
  const model = value["model"];
  if (typeof model !== "string" || model.length === 0) {
    throw new SystemOneRequestError("model", "A model ID is required.");
  }
  const inputLimit = value["input_token_limit"];
  if (inputLimit !== undefined && (model !== "bespoke-nimble-9b" || typeof inputLimit !== "number" ||
      !Number.isSafeInteger(inputLimit) || inputLimit < 1 || inputLimit > SYSTEMONE_MAX_TOKENS_PER_QUESTION)) {
    throw new SystemOneRequestError("input_token_limit", "Only Nimble accepts input_token_limit: an integer from 1 to 8192, enforced on every complete prompt before inference.");
  }
  const state = value["state"];
  if (state === null || state === undefined || typeof state === "number" || typeof state === "boolean") {
    throw new SystemOneRequestError("state", "State must be text or structured JSON.");
  }
  if (typeof state === "string" && state.length === 0) {
    throw new SystemOneRequestError("state", "State must not be empty.");
  }
  // Images require a separately tested multimodal serving contract. The runtime treats ordinary
  // JSON objects as text; arrays and the separate top-level images field are excluded here.
  if (Array.isArray(state)) {
    throw new SystemOneRequestError("state", "Array state and images are not supported.");
  }
  const questions = value["questions"];
  if (!record(questions) || Object.keys(questions).length < 1 || Object.keys(questions).length > 16) {
    throw new SystemOneRequestError("questions", "Supply 1 to 16 named questions.");
  }
  for (const [id, question] of Object.entries(questions)) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || !record(question)) {
      throw new SystemOneRequestError("questions", "Question IDs must be short names with object values.");
    }
    if (Object.keys(question).some((key) => !["type", "instructions", "criteria"].includes(key))) {
      if (question["type"] === "choice" &&
          (Object.hasOwn(question, "choices") || Object.hasOwn(question, "options"))) {
        throw new SystemOneRequestError(`questions.${id}.criteria`, CHOICE_CRITERIA_HELP);
      }
      throw new SystemOneRequestError("questions", "Unsupported question field.");
    }
    if (typeof question["instructions"] !== "string" || question["instructions"].trim().length === 0) {
      throw new SystemOneRequestError("questions", "Each question needs instructions.");
    }
    const type = question["type"];
    const criteria = question["criteria"];
    if (type === "choice") {
      if (!record(criteria) || Object.keys(criteria).length < 2 || Object.keys(criteria).length > 26 ||
        Object.keys(criteria).some((key) => !/^[A-Za-z0-9_-]{1,64}$/.test(key)) ||
        Object.values(criteria).some((item) => item !== null && typeof item !== "string")) {
        throw new SystemOneRequestError(`questions.${id}.criteria`, CHOICE_CRITERIA_HELP);
      }
    } else if (type === "score") {
      if (!Array.isArray(criteria) || criteria.length < 2 || criteria.length > 10 ||
        criteria.some((item) => typeof item !== "string")) {
        throw new SystemOneRequestError("questions", "Score needs 2 to 10 level descriptions.");
      }
    } else if (type === "noul") {
      if (criteria !== undefined && (!record(criteria) ||
        Object.keys(criteria).some((key) => key !== "true" && key !== "false") ||
        Object.values(criteria).some((item) => typeof item !== "string"))) {
        throw new SystemOneRequestError("questions", "Noul criteria must describe true and false.");
      }
    } else {
      throw new SystemOneRequestError("questions", "Question type must be choice, score, or noul.");
    }
  }
  return { model, body: { model, state, questions, ...(typeof inputLimit === "number" ? { input_token_limit: inputLimit } : {}) } };
}
