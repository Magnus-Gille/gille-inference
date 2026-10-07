import { describe, expect, it } from "vitest";
import { parseSystemOneBody, SystemOneRequestError, SystemOneResponseError,
  systemOneTokenReservation, validateSystemOneResponse } from "../src/homeserver/systemone-request.js";

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
  it("preserves a typed text/JSON decision request", () => {
    expect(parseSystemOneBody(JSON.stringify(base)).body).toEqual(base);
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
