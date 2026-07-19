/**
 * probe-runner.test.ts — test-first (red→green) for src/homeserver/probe-runner.ts
 *
 * NO real network calls. Stubs injected via the `chat` seam and globalThis.fetch.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  summarize,
  runProbes,
  makeChatFn,
  type ChatCallResult,
} from "../src/homeserver/probe-runner.js";
import type { ProbeRunResult } from "../src/homeserver/scout-types.js";
import type { Probe } from "../src/homeserver/probes.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeResult(
  overrides: Partial<ProbeRunResult> = {}
): ProbeRunResult {
  return {
    probeId: "p1",
    taskType: "qa-factual",
    verifierName: "answerIs",
    repeat: 1,
    outcome: "pass",
    score: 1,
    latencyMs: 100,
    tokPerSec: 20,
    notes: null,
    ...overrides,
  };
}

function makeProbe(
  id: string,
  taskType: string,
  expectedAnswer: string,
  opts: Partial<Pick<Probe, "systemPrompt" | "maxTokens" | "temperature">> = {}
): Probe {
  return {
    id,
    taskType,
    prompt: `What is ${expectedAnswer}?`,
    verifier: (out: string) =>
      out.includes(expectedAnswer)
        ? { outcome: "pass", score: 1 }
        : { outcome: "fail", score: 0 },
    verifierName: "inline-answerIs",
    ...opts,
  };
}

function stubChat(outputMap: Record<string, string>): (model: string, probe: Probe) => Promise<ChatCallResult> {
  return async (_model, probe) => {
    const output = outputMap[probe.id] ?? "";
    return {
      output,
      latencyMs: 50,
      tokPerSec: 30,
      promptTokens: 10,
      completionTokens: 5,
      reasoningChars: null,
    };
  };
}

// ─── summarize() ─────────────────────────────────────────────────────────────

describe("summarize", () => {
  it("correctly tallies pass/partial/fail/error counts", () => {
    const results: ProbeRunResult[] = [
      makeResult({ outcome: "pass", score: 1, tokPerSec: 20 }),
      makeResult({ outcome: "partial", score: 0.5, taskType: "code-gen", tokPerSec: 25 }),
      makeResult({ outcome: "fail", score: 0, taskType: "code-gen", tokPerSec: null }),
      makeResult({ outcome: "error", score: 0, tokPerSec: null }),
      makeResult({ outcome: "unverified", score: null, tokPerSec: 10 }),
    ];

    const s = summarize("mymodel", "http://localhost:8080/v1", results);

    expect(s.model).toBe("mymodel");
    expect(s.endpoint).toBe("http://localhost:8080/v1");
    expect(s.totalRuns).toBe(5);
    expect(s.pass).toBe(1);
    expect(s.partial).toBe(1);
    expect(s.fail).toBe(1);
    // error + unverified both count as "error" bucket
    expect(s.error).toBe(2);
    expect(s.passRate).toBe(1 / 5);
  });

  it("computes avgTokPerSec as mean of non-null values, rounded 1dp", () => {
    const results: ProbeRunResult[] = [
      makeResult({ tokPerSec: 20 }),
      makeResult({ tokPerSec: 30 }),
      makeResult({ tokPerSec: null }),
    ];
    const s = summarize("m", "http://e/v1", results);
    // mean(20, 30) = 25.0
    expect(s.avgTokPerSec).toBe(25.0);
  });

  it("returns null avgTokPerSec when all values are null", () => {
    const results = [makeResult({ tokPerSec: null })];
    expect(summarize("m", "e", results).avgTokPerSec).toBeNull();
  });

  it("groups byTaskType and sorts alphabetically", () => {
    const results: ProbeRunResult[] = [
      makeResult({ taskType: "translate", outcome: "pass", score: 1 }),
      makeResult({ taskType: "code-gen", outcome: "fail", score: 0 }),
      makeResult({ taskType: "code-gen", outcome: "pass", score: 1 }),
      makeResult({ taskType: "translate", outcome: "error", score: 0 }),
    ];
    const s = summarize("m", "e", results);
    expect(s.byTaskType.map((t) => t.taskType)).toEqual(["code-gen", "translate"]);

    const cg = s.byTaskType.find((t) => t.taskType === "code-gen")!;
    expect(cg.attempts).toBe(2);
    expect(cg.passes).toBe(1);
    expect(cg.fails).toBe(1);
    expect(cg.errors).toBe(0);
    expect(cg.passRate).toBeCloseTo(0.5);

    const tr = s.byTaskType.find((t) => t.taskType === "translate")!;
    expect(tr.attempts).toBe(2);
    expect(tr.passes).toBe(1);
    expect(tr.errors).toBe(1);
    expect(tr.passRate).toBeCloseTo(0.5);
  });

  it("passRate is 0 when totalRuns is 0", () => {
    const s = summarize("m", "e", []);
    expect(s.passRate).toBe(0);
    expect(s.totalRuns).toBe(0);
  });

  it("includes all results in the results array", () => {
    const r1 = makeResult({ probeId: "a" });
    const r2 = makeResult({ probeId: "b", outcome: "fail", score: 0 });
    const s = summarize("m", "e", [r1, r2]);
    expect(s.results).toHaveLength(2);
  });

  it("keeps finish_reason counts separate from transport errors", () => {
    const s = summarize("m", "e", [
      makeResult({ finishReason: "stop" }),
      makeResult({ finishReason: "length", truncated: true }),
      makeResult({ finishReason: null }),
      makeResult({ outcome: "error", latencyMs: null, finishReason: null }),
    ]);
    expect(s.finishReasons).toEqual({ length: 1, missing: 1, stop: 1 });
  });
});

// ─── runProbes() ──────────────────────────────────────────────────────────────

describe("runProbes", () => {
  it("returns a summary with correct run count (repeats × probes)", async () => {
    const probes: Probe[] = [
      makeProbe("p1", "qa-factual", "42"),
      makeProbe("p2", "translate", "bonjour"),
    ];
    const chat = stubChat({ p1: "42", p2: "hello" });
    const s = await runProbes({ model: "mymodel", endpoint: "http://h/v1", probes, repeats: 3, chat });
    expect(s.totalRuns).toBe(6); // 2 probes × 3 repeats
  });

  it("calls onResult for every run", async () => {
    const probes: Probe[] = [makeProbe("p1", "qa-factual", "Paris")];
    const chat = stubChat({ p1: "Paris" });
    const called: ProbeRunResult[] = [];
    await runProbes({ model: "m", endpoint: "http://h/v1", probes, chat, onResult: (r) => called.push(r) });
    expect(called).toHaveLength(1);
    expect(called[0]!.outcome).toBe("pass");
  });

  it("records an error result when chat throws, without aborting subsequent probes", async () => {
    let calls = 0;
    const chat = async (_model: string, probe: Probe): Promise<ChatCallResult> => {
      calls++;
      if (probe.id === "p-fail") throw new Error("timeout");
      return { output: "ok", latencyMs: 10, tokPerSec: null, promptTokens: null, completionTokens: null, reasoningChars: null };
    };
    const probes: Probe[] = [
      makeProbe("p-fail", "qa-factual", "ok"),
      makeProbe("p-ok", "code-gen", "ok"),
    ];
    const s = await runProbes({ model: "m", endpoint: "http://h/v1", probes, chat });
    expect(calls).toBe(2);
    expect(s.error).toBe(1);
    expect(s.pass).toBe(1);
    const errResult = s.results.find((r) => r.probeId === "p-fail")!;
    expect(errResult.outcome).toBe("error");
    expect(errResult.notes).toContain("timeout");
    expect(errResult.latencyMs).toBeNull();
    expect(errResult.tokPerSec).toBeNull();
  });

  it("uses repeat index starting at 1", async () => {
    const probes: Probe[] = [makeProbe("p1", "qa-factual", "x")];
    const chat = stubChat({ p1: "x" });
    const s = await runProbes({ model: "m", endpoint: "http://h/v1", probes, repeats: 2, chat });
    const reps = s.results.map((r) => r.repeat);
    expect(reps).toEqual([1, 2]);
  });

  it("summary from runProbes matches calling summarize() on same results", async () => {
    const probes: Probe[] = [
      makeProbe("p1", "qa-factual", "y"),
      makeProbe("p2", "code-gen", "z"),
    ];
    const chat = stubChat({ p1: "y is great", p2: "no match" });
    const s = await runProbes({ model: "mymodel", endpoint: "http://h/v1", probes, chat });
    const expected = summarize("mymodel", "http://h/v1", s.results);
    expect(s.pass).toBe(expected.pass);
    expect(s.fail).toBe(expected.fail);
    expect(s.passRate).toBe(expected.passRate);
  });

  it("records empty output as an explicit error diagnostic", async () => {
    const probes = [makeProbe("empty", "triage", "ready")];
    const chat = async (): Promise<ChatCallResult> => ({
      output: "   ",
      latencyMs: 10,
      tokPerSec: null,
      promptTokens: 5,
      completionTokens: 0,
      reasoningChars: null,
      finishReason: "stop",
    });
    const s = await runProbes({ model: "m", endpoint: "e", probes, chat });
    expect(s.error).toBe(1);
    expect(s.emptyOutputs).toBe(1);
    expect(s.results[0]).toMatchObject({
      outcome: "error",
      emptyOutput: true,
      truncated: false,
      finishReason: "stop",
      notes: "empty output",
    });
  });

  it("keeps failed review probes in the seeded-bug recall denominator", async () => {
    const reviewProbe: Probe = {
      id: "review-ground-truth",
      taskType: "code-review",
      prompt: "review this",
      verifierName: "reviewGroundTruth",
      reviewExpectedFindings: 3,
      verifier: () => ({ outcome: "error", score: 0, errorClass: "parse" }),
    };
    let calls = 0;
    const chat = async (): Promise<ChatCallResult> => {
      calls++;
      if (calls === 1) throw new Error("transport failed");
      return {
        output: calls === 2 ? "" : "malformed",
        latencyMs: 10,
        tokPerSec: null,
        promptTokens: 5,
        completionTokens: 0,
        reasoningChars: null,
        finishReason: "stop",
      };
    };
    const s = await runProbes({
      model: "m",
      endpoint: "e",
      probes: [reviewProbe],
      repeats: 3,
      chat,
    });
    expect(s.error).toBe(3);
    expect(s.reviewMetrics).toMatchObject({
      seededBugs: 9,
      truePositives: 0,
      recall: 0,
    });
    expect(s.results.every((r) => r.reviewMetrics?.expectedFindings === 3)).toBe(true);
  });

  it("records finish_reason=length as truncation even when content verifies", async () => {
    const probes = [makeProbe("cut", "qa-factual", "42")];
    const chat = async (): Promise<ChatCallResult> => ({
      output: "42",
      latencyMs: 10,
      tokPerSec: null,
      promptTokens: 5,
      completionTokens: 5,
      reasoningChars: null,
      finishReason: "length",
    });
    const s = await runProbes({ model: "m", endpoint: "e", probes, chat });
    expect(s.pass).toBe(1);
    expect(s.truncations).toBe(1);
    expect(s.finishReasons).toEqual({ length: 1 });
    expect(s.results[0]).toMatchObject({ truncated: true, finishReason: "length" });
  });
});

// ─── makeChatFn() ────────────────────────────────────────────────────────────

describe("makeChatFn", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockFetch(responseBody: object, status = 200) {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: async () => responseBody,
      text: async () => JSON.stringify(responseBody),
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  const successBody = {
    choices: [{ message: { content: "hello world" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
    timings: { predicted_per_second: 42.5 },
  };

  it("omits Authorization header when apiKey is empty", async () => {
    const fetchMock = mockFetch(successBody);
    const chat = makeChatFn({ endpoint: "http://localhost:8080/v1" });
    const probe = makeProbe("x", "qa-factual", "hello");
    await chat("some-model", probe);

    const [_url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBeUndefined();
  });

  it("captures the OpenAI-compatible finish_reason", async () => {
    mockFetch(successBody);
    const chat = makeChatFn({ endpoint: "http://localhost:8080/v1" });
    const result = await chat("some-model", makeProbe("finish", "qa-factual", "hello"));
    expect(result.finishReason).toBe("stop");
  });

  it("includes Authorization header when apiKey is provided", async () => {
    const fetchMock = mockFetch(successBody);
    const chat = makeChatFn({ endpoint: "http://localhost:8080/v1", apiKey: "sk-test" });
    await chat("m", makeProbe("y", "qa-factual", "world"));

    const [_url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer sk-test");
  });

  it("throws on non-200 response", async () => {
    mockFetch({ error: "bad" }, 400);
    const chat = makeChatFn({ endpoint: "http://localhost:8080/v1", apiKey: "k" });
    await expect(chat("m", makeProbe("z", "qa-factual", "x"))).rejects.toThrow("HTTP 400");
  });

  it("parses tokPerSec from timings.predicted_per_second", async () => {
    mockFetch(successBody);
    const chat = makeChatFn({ endpoint: "http://localhost:8080/v1" });
    const result = await chat("m", makeProbe("a", "qa-factual", "x"));
    expect(result.tokPerSec).toBe(42.5);
  });

  it("falls back to completion_tokens / latency when timings absent", async () => {
    const body = {
      choices: [{ message: { content: "hi" } }],
      usage: { prompt_tokens: 10, completion_tokens: 100 },
    };
    mockFetch(body);
    const chat = makeChatFn({ endpoint: "http://localhost:8080/v1" });
    const result = await chat("m", makeProbe("b", "qa-factual", "x"));
    // completion_tokens=100 / (latencyMs/1000) — latency is unpredictable; just check it's a number
    expect(result.tokPerSec).not.toBeNull();
    expect(typeof result.tokPerSec).toBe("number");
  });

  it("strips trailing slash from endpoint", async () => {
    const fetchMock = mockFetch(successBody);
    const chat = makeChatFn({ endpoint: "http://localhost:8080/v1/" });
    await chat("m", makeProbe("c", "qa-factual", "x"));
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("http://localhost:8080/v1/chat/completions");
  });

  it("sets temperature from probe.temperature when provided", async () => {
    const fetchMock = mockFetch(successBody);
    const chat = makeChatFn({ endpoint: "http://localhost:8080/v1" });
    const probe = makeProbe("d", "qa-factual", "x", { temperature: 0.7 });
    await chat("m", probe);
    const [_url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.temperature).toBe(0.7);
  });

  it("includes systemPrompt in messages when provided", async () => {
    const fetchMock = mockFetch(successBody);
    const chat = makeChatFn({ endpoint: "http://localhost:8080/v1" });
    const probe = makeProbe("e", "qa-factual", "x", { systemPrompt: "Be terse." });
    await chat("m", probe);
    const [_url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.messages[0]).toEqual({ role: "system", content: "Be terse." });
    expect(body.messages[1].role).toBe("user");
  });
});
