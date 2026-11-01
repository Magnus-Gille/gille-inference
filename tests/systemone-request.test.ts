import { describe, expect, it } from "vitest";
import { isSystemOneDecisionModel, parseSystemOneBody, SystemOneRequestError, SystemOneResponseError,
  systemOneTokenReservation, validateSystemOneResponse } from "../src/homeserver/systemone-request.js";
import { systemOneBillableTokens, systemOneModelContract } from "../src/homeserver/systemone-request.js";

const base = {
  model: "clef-flash",
  state: { message: "Checkout is unavailable" },
  questions: {
    urgent: { type: "noul", instructions: "Is this urgent?" },
    team: { type: "choice", instructions: "Which team?", criteria: {
      billing: "Payment issues", support: "Technical issues",
    } },
    impact: { type: "score", instructions: "How severe?", criteria: ["none", "minor", "major"] },
  },
};

describe("System One customer request", () => {
  it.each([7, 8, 16])("accepts %i Nimble questions with an explicit enforced input bound", count => {
    const req = parseSystemOneBody(JSON.stringify({ ...base, model: "bespoke-nimble-9b", input_token_limit: 2048,
      questions: Object.fromEntries(Array.from({ length: count }, (_, i) => [`q${i}`, base.questions.urgent])) }));
    expect(systemOneTokenReservation(req)).toBe(count * 2048);
  });
  it.each([0, -1, 1.5, 8193, "2048"])("rejects an unsafe Nimble input bound %s", input_token_limit => {
    expect(() => parseSystemOneBody(JSON.stringify({ ...base, model: "bespoke-nimble-9b", input_token_limit })))
      .toThrow(SystemOneRequestError);
  });
  it("refuses a reduced reservation on a runtime that does not enforce it", () => {
    expect(() => parseSystemOneBody(JSON.stringify({ ...base, input_token_limit: 2048 }))).toThrow(SystemOneRequestError);
  });
  it.each(["clef-flash", "bespoke-nimble-9b", "pplx-decider-v1-27b"])(
    "keeps known decision model %s out of chat when enablement is missing",
    (model) => expect(isSystemOneDecisionModel(model, [])).toBe(true),
  );
  it("preserves a typed text/JSON decision request", () => {
    expect(parseSystemOneBody(JSON.stringify(base)).body).toEqual(base);
  });

  const wideChoiceModels = ["bespoke-nimble-9b", "clef-flash", "pplx-decider-v1-27b"];
  it.each(wideChoiceModels.flatMap(model => [26, 27, 31, 255].map(count => [model, count] as const)))
    ("accepts %s with %i choice options", (model, count) => {
      const criteria = Object.fromEntries(Array.from({ length: count }, (_, i) => [`option-${i}`, `Option ${i}`]));
      const req = parseSystemOneBody(JSON.stringify({ ...base, model, questions: {
        route: { type: "choice", instructions: "Select the best route.", criteria },
      } }));
      expect(Object.keys((req.body.questions.route as { criteria: object }).criteria)).toHaveLength(count);
      expect(systemOneModelContract(req.model).maxChoiceOptions).toBe(255);
    });

  it.each(wideChoiceModels)("rejects 256 choice options for %s with model-specific guidance", model => {
    const criteria = Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`option-${i}`, `Option ${i}`]));
    try {
      parseSystemOneBody(JSON.stringify({ ...base, model, questions: {
        route: { type: "choice", instructions: "Select the best route.", criteria },
      } }));
      expect.fail("256 choices were accepted");
    } catch (error) {
      expect(error).toBeInstanceOf(SystemOneRequestError);
      expect((error as Error).message).toContain("2 to 255");
    }
  });

  it.each(["future-decision-model"])("keeps the legacy 26-choice cap for %s", model => {
    const criteria = Object.fromEntries(Array.from({ length: 27 }, (_, i) => [`option-${i}`, `Option ${i}`]));
    expect(systemOneModelContract(model).maxChoiceOptions).toBe(26);
    try {
      parseSystemOneBody(JSON.stringify({ ...base, model, questions: {
        route: { type: "choice", instructions: "Select the best route.", criteria },
      } }));
      expect.fail(`27 choices were accepted for ${model}`);
    } catch (error) {
      expect(error).toBeInstanceOf(SystemOneRequestError);
      expect((error as Error).message).toContain("2 to 26");
    }
  });

  it.each(wideChoiceModels)("rejects a later malformed score after 255 valid choices for %s", model => {
    const criteria = Object.fromEntries(Array.from({ length: 255 }, (_, i) => [`option-${i}`, `Option ${i}`]));
    try {
      parseSystemOneBody(JSON.stringify({ ...base, model, questions: {
        wide: { type: "choice", instructions: "Select a route.", criteria },
        invalid: { type: "score", instructions: "Score this.", criteria: [] },
      } }));
      expect.fail("malformed second question was accepted");
    } catch (error) {
      expect(error).toBeInstanceOf(SystemOneRequestError);
      expect((error as SystemOneRequestError).param).toBe("questions");
      expect((error as Error).message).toContain("Score needs 2 to 10");
    }
  });

  it.each(wideChoiceModels)("rejects an oversized first choice before later validation for %s", model => {
    const criteria = Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`option-${i}`, `Option ${i}`]));
    try {
      parseSystemOneBody(JSON.stringify({ ...base, model, questions: {
        wide: { type: "choice", instructions: "Select a route.", criteria },
        invalid: { type: "score", instructions: "Score this.", criteria: [] },
      } }));
      expect.fail("256 choice options were accepted");
    } catch (error) {
      expect(error).toBeInstanceOf(SystemOneRequestError);
      expect((error as SystemOneRequestError).param).toBe("questions.wide.criteria");
      expect((error as Error).message).toContain("2 to 255");
    }
  });

  it.each([
    { criteria: ["billing", "support"] },
    { choices: ["billing", "support"] },
    { options: { billing: "Payment", support: "Technical" } },
    {},
  ])("explains the required choice criteria object for malformed options %j", (options) => {
    try {
      parseSystemOneBody(JSON.stringify({ ...base, questions: {
        route: { type: "choice", instructions: "Which team?", ...options },
      } }));
      expect.fail("malformed choice was accepted");
    } catch (error) {
      expect(error).toBeInstanceOf(SystemOneRequestError);
      expect((error as SystemOneRequestError).param).toBe("questions.route.criteria");
      expect((error as Error).message).toContain("criteria object");
      expect((error as Error).message).toContain('{"billing":"Payment issue","support":"Technical issue"}');
    }
  });

  it.each([
    ["no questions", { ...base, questions: {} }],
    ["runtime pin", { ...base, keep_alive: "24h" }],
    ["image array", { ...base, state: [{ type: "image_url", image_url: "file:///tmp/a" }] }],
    ["missing choice options", { ...base, questions: {
      team: { type: "choice", instructions: "Which team?", criteria: { only: "one" } },
    } }],
    ["more score levels than runtime supports", { ...base, questions: {
      impact: { type: "score", instructions: "How severe?", criteria: Array.from({ length: 11 }, (_, i) => `level ${i}`) },
    } }],
    ["unknown question field", { ...base, questions: {
      urgent: { type: "noul", instructions: "Urgent?", stream: true },
    } }],
  ])("rejects %s before model work", (_name, body) => {
    expect(() => parseSystemOneBody(JSON.stringify(body))).toThrow(SystemOneRequestError);
  });
});

describe("System One upstream response", () => {
  const request = parseSystemOneBody(JSON.stringify(base));
  const response = {
    answers: {
      urgent: { type: "noul", noul: 0.9 },
      team: { type: "choice", choice: "support", probabilities: { billing: 0.1, support: 0.9 }, confidence: 0.8 },
      impact: { type: "score", score: 1.2, probabilities: { "0": 0.1, "1": 0.6, "2": 0.3 }, confidence: 0.5 },
    },
    usage: { input_tokens: 24, output_tokens: 0 },
  };

  it("reserves Clef's shared context and validates typed usage", () => {
    expect(systemOneTokenReservation(request)).toBe(8192);
    expect(validateSystemOneResponse(response, request)).toBe(24);
  });

  it("reserves separate contexts for a future per-question decision model", () => {
    const other = parseSystemOneBody(JSON.stringify({ ...base, model: "another-decision-model" }));
    expect(systemOneTokenReservation(other)).toBe(3 * 8192);
  });
  it("keeps exact compute usage while charging a proven native shared prefix once", () => {
    const native = parseSystemOneBody(JSON.stringify({ ...base, model: "bespoke-nimble-9b" }));
    expect(systemOneBillableTokens({ usage: { billable_input_tokens: 12, shared_prefix_tokens: 6 } }, native, 24)).toBe(12);
    expect(systemOneBillableTokens(response, native, 24)).toBe(24);
    for (const usage of [{ billable_input_tokens: 0, shared_prefix_tokens: 12 },
      { billable_input_tokens: 12 }, { billable_input_tokens: 12, shared_prefix_tokens: 99 }]) {
      expect(() => systemOneBillableTokens({ usage }, native, 24)).toThrow(SystemOneResponseError);
    }
    expect(() => systemOneBillableTokens({ usage: { billable_input_tokens: 12, shared_prefix_tokens: 6 } }, request, 24))
      .toThrow(SystemOneResponseError);
  });
  it("publishes configured context scopes without claiming measured context", () => {
    expect(systemOneModelContract("clef-flash")).toMatchObject({ contextScope: "shared_request", maxQuestions: 16, inputTokenLimitSupported: false });
    expect(systemOneModelContract("bespoke-nimble-9b")).toMatchObject({ contextScope: "per_question", inputTokenLimitSupported: true,
      qualification: "configured_not_measured" });
  });

  it.each(["bespoke-nimble-9b", "clef-flash", "pplx-decider-v1-27b"])("validates a complete 31-option distribution for %s", model => {
    const criteria = Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`option-${i}`, `Option ${i}`]));
    const nimble = parseSystemOneBody(JSON.stringify({ ...base, model,
      ...(model === "bespoke-nimble-9b" ? { input_token_limit: 8192 } : {}),
      questions: { route: { type: "choice", instructions: "Select the best route.", criteria } } }));
    expect(systemOneTokenReservation(nimble)).toBe(8192);
    const probabilities = Object.fromEntries(Object.keys(criteria).map((key, i) => [key, i === 0 ? 1 : 0]));
    expect(validateSystemOneResponse({ answers: { route: { type: "choice", choice: "option-0", probabilities,
      confidence: 1 } }, usage: { input_tokens: 8192, output_tokens: 0 } }, nimble)).toBe(8192);
    expect(() => validateSystemOneResponse({ answers: { route: { type: "choice", choice: "option-0", probabilities,
      confidence: 1 } }, usage: { input_tokens: 8193, output_tokens: 0 } }, nimble)).toThrow(SystemOneResponseError);
  });

  it.each([
    ["out-of-range noul", { ...response, answers: { ...response.answers, urgent: { type: "noul", noul: 2 } } }],
    ["missing choice probabilities", { ...response, answers: { ...response.answers, team: { type: "choice", choice: "support" } } }],
    ["non-normalized score", { ...response, answers: { ...response.answers, impact: {
      ...response.answers.impact, probabilities: { "0": 0.1, "1": 0.1, "2": 0.1 },
    } } }],
    ["usage above reservation", { ...response, usage: { input_tokens: 8193, output_tokens: 0 } }],
  ])("rejects %s", (_name, payload) => {
    expect(() => validateSystemOneResponse(payload, request)).toThrow(SystemOneResponseError);
  });
});
