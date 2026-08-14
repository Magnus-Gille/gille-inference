import { describe, expect, it } from "vitest";

import {
  aggregateServerBatches,
  evaluateServerOutput,
  parsePrometheusSpeculation,
  parseStrixServerBenchmarkArgs,
  speculationDelta,
  validateServerFixtures,
  validateServerProvenance,
  type StrixServerBatch,
} from "../src/homeserver/strix-server-benchmark.js";

describe("parseStrixServerBenchmarkArgs", () => {
  it("requires explicit endpoint/model/fixtures/output and defaults to the release matrix", () => {
    const plan = parseStrixServerBenchmarkArgs([
      "--base-url", "http://127.0.0.1:8091/v1",
      "--model", "qwen3.6-35b-a3b",
      "--fixtures", "benchmarks/strix-agent-fixtures.json",
      "--provenance", "data/strix/provenance.json",
      "--out", "data/strix/server-qwen36",
    ]);
    expect(plan).toMatchObject({
      baseUrl: "http://127.0.0.1:8091/v1",
      model: "qwen3.6-35b-a3b",
      concurrency: [1, 2, 4, 8],
      repetitions: 3,
      timeoutMs: 300_000,
      metricsUrl: "http://127.0.0.1:8091/metrics",
      apiKeyEnv: null,
      provenancePath: "data/strix/provenance.json",
    });
  });

  it("keeps credentials out of argv and rejects unsafe plans", () => {
    const base = [
      "--base-url", "https://inference.example.com/v1",
      "--model", "mellum",
      "--fixtures", "fixtures.json",
      "--provenance", "provenance.json",
      "--out", "result",
    ];
    expect(() => parseStrixServerBenchmarkArgs([...base, "--api-key", "secret"])).toThrow(/unrecognized/);
    expect(() => parseStrixServerBenchmarkArgs([...base, "--concurrency", "1,0"])).toThrow(/positive/);
    expect(() => parseStrixServerBenchmarkArgs([...base, "--api-key-env", "BAD-NAME"])).toThrow(/environment/i);
  });

  it("requires immutable runtime and model provenance", () => {
    const provenance = validateServerProvenance({
      schemaVersion: 1,
      modelArtifactSha256: "a".repeat(64),
      runtimeCommit: "b".repeat(40),
      runtimeBinarySha256: "c".repeat(64),
      serverArgsSha256: "d".repeat(64),
      backend: "vulkan",
      quant: "Q4_K_M",
      kernel: "6.14.0",
      mesaVersion: "25.2.0",
      rocmVersion: null,
      contextSize: 65536,
      kvTypeK: "q8_0",
      kvTypeV: "q8_0",
      flashAttention: "on",
      batch: 2048,
      ubatch: 512,
      parallelism: 1,
      speculation: "none",
      draftDepth: null,
      cacheRamMiB: 8192,
      contextCheckpoints: 32,
      checkpointMinStep: 8192,
      cacheIdleSlots: "on",
    });
    expect(provenance.backend).toBe("vulkan");
    expect(() => validateServerProvenance({ ...provenance, runtimeCommit: "main" })).toThrow(/full Git revision/);
  });
});

describe("server fixtures and deterministic oracles", () => {
  const fixtures = validateServerFixtures([
    {
      id: "code",
      taskType: "code",
      request: { messages: [{ role: "user", content: "Return x" }] },
      oracle: { kind: "contains_all", values: ["const", "x"] },
    },
    {
      id: "json",
      taskType: "json",
      request: { messages: [{ role: "user", content: "JSON" }], response_format: { type: "json_object" } },
      oracle: { kind: "json_fields", fields: { answer: 42, ok: true } },
    },
    {
      id: "tool",
      taskType: "tool",
      request: {
        messages: [{ role: "user", content: "Use lookup" }],
        tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
      },
      oracle: { kind: "tool_name", name: "lookup" },
    },
  ]);

  it("accepts a bounded fixture contract and evaluates output without a model judge", () => {
    expect(fixtures).toHaveLength(3);
    expect(evaluateServerOutput(fixtures[0]!.oracle, { content: "const x = 1", toolNames: [] })).toBe(true);
    expect(evaluateServerOutput(fixtures[1]!.oracle, { content: '{"answer":42,"ok":true}', toolNames: [] })).toBe(true);
    expect(evaluateServerOutput(fixtures[2]!.oracle, { content: "", toolNames: ["lookup"] })).toBe(true);
    expect(evaluateServerOutput(fixtures[2]!.oracle, { content: "lookup", toolNames: [] })).toBe(false);
  });

  it("rejects request fields that could override the controlled benchmark envelope", () => {
    expect(() => validateServerFixtures([{ ...fixtures[0], request: { ...fixtures[0]!.request, model: "other" } }])).toThrow(/request field/i);
    expect(() => validateServerFixtures([{ ...fixtures[0], id: "../escape" }])).toThrow(/fixture id/i);
  });
});

describe("speculation metrics and aggregation", () => {
  it("sums labelled Prometheus counters and computes an honest delta", () => {
    const before = parsePrometheusSpeculation(`
llamacpp:spec_decode_num_draft_tokens_total 100
llamacpp:spec_decode_num_accepted_tokens_total{model="a"} 60
llamacpp:spec_decode_num_drafts_total 20
`);
    const after = parsePrometheusSpeculation(`
llamacpp:spec_decode_num_draft_tokens_total 140
llamacpp:spec_decode_num_accepted_tokens_total{model="a"} 90
llamacpp:spec_decode_num_drafts_total 28
`);
    expect(speculationDelta(before, after)).toEqual({
      draftTokens: 40,
      acceptedTokens: 30,
      verificationSteps: 8,
      acceptanceRate: 0.75,
    });
  });

  it("reports completed useful work per minute and aggregate throughput by workload/concurrency", () => {
    const batches: StrixServerBatch[] = [
      {
        fixtureId: "code", taskType: "code", concurrency: 2, repetition: 0, wallMs: 2_000,
        speculation: { draftTokens: 20, acceptedTokens: 10, verificationSteps: 5, acceptanceRate: 0.5 },
        requests: [
          { ok: true, oraclePass: true, ttftMs: 100, totalMs: 1_800, promptTokens: 10, completionTokens: 50, promptTokensPerSecond: 1000, predictedTokensPerSecond: 60, cachedPromptTokens: 0, outputSha256: "a".repeat(64), finishReason: "stop", errorClass: null },
          { ok: true, oraclePass: false, ttftMs: 200, totalMs: 2_000, promptTokens: 10, completionTokens: 50, promptTokensPerSecond: 900, predictedTokensPerSecond: 55, cachedPromptTokens: 8, outputSha256: "b".repeat(64), finishReason: "stop", errorClass: null },
        ],
      },
    ];
    const [summary] = aggregateServerBatches(batches);
    expect(summary).toMatchObject({
      fixtureId: "code",
      concurrency: 2,
      requests: 2,
      successfulRequests: 2,
      oraclePasses: 1,
      aggregateTokensPerSecond: 50,
      usefulCompletionsPerMinute: 30,
      acceptanceRate: 0.5,
      cacheHitRate: 0.5,
    });
    expect(summary!.p95TtftMs).toBe(200);
  });
});
