import { describe, expect, it, vi } from "vitest";

import { runStrixServerBenchmark } from "../scripts/strix-server-benchmark.js";

const ARGV = [
  "--base-url", "http://127.0.0.1:8091/v1",
  "--model", "test-model",
  "--fixtures", "fixtures.json",
  "--provenance", "provenance.json",
  "--out", "result",
  "--concurrency", "1",
  "--repetitions", "1",
];

const FIXTURES = JSON.stringify([
  {
    id: "exact",
    taskType: "reasoning",
    request: { messages: [{ role: "user", content: "answer" }] },
    oracle: { kind: "exact", value: "42" },
  },
]);

const PROVENANCE = JSON.stringify({
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
  speculation: "draft-mtp",
  draftDepth: 2,
});

function sse(content = "42"): Response {
  const chunks = [
    { choices: [{ delta: { content }, finish_reason: null }] },
    {
      choices: [{ delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 4 } },
      timings: { prompt_per_second: 1000, predicted_per_second: 80, cache_n: 4 },
    },
  ];
  return new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("runStrixServerBenchmark", () => {
  it("captures stream timings, cache/speculation evidence, and stores no model output", async () => {
    let metricsCalls = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/metrics")) {
        metricsCalls++;
        const offset = metricsCalls === 1 ? 0 : 10;
        return new Response([
          `llamacpp:spec_decode_num_draft_tokens_total ${100 + offset}`,
          `llamacpp:spec_decode_num_accepted_tokens_total ${60 + offset * 0.8}`,
          `llamacpp:spec_decode_num_drafts_total ${20 + offset * 0.2}`,
        ].join("\n"));
      }
      return sse();
    });
    const writePair = vi.fn(() => ({ jsonPath: "/tmp/report.json", markdownPath: "/tmp/report.md" }));
    const stdout = vi.fn();
    const exit = await runStrixServerBenchmark(ARGV, {
      fetchImpl: fetchImpl as typeof fetch,
      now: vi.fn().mockReturnValueOnce("2026-08-14T10:00:00.000Z").mockReturnValue("2026-08-14T10:00:01.000Z"),
      stdout,
      stderr: vi.fn(),
      readFile: (path) => path === "fixtures.json" ? FIXTURES : PROVENANCE,
      writePair,
    });

    expect(exit).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const [prefix, json, markdown] = writePair.mock.calls[0]!;
    expect(prefix).toBe("result");
    expect(json).not.toContain('"content":"42"');
    expect(json).toContain('"acceptanceRate": 0.8');
    expect(json).toContain('"cachedPromptTokens": 4');
    expect(markdown).toContain("Useful/min");
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('"status":"complete"'));
  });

  it("returns a distinct nonzero status when transport completed but a request failed", async () => {
    const exit = await runStrixServerBenchmark([...ARGV, "--metrics-url", "none"], {
      fetchImpl: vi.fn(async () => new Response("busy", { status: 503 })) as typeof fetch,
      now: () => "2026-08-14T10:00:00.000Z",
      stdout: vi.fn(),
      stderr: vi.fn(),
      readFile: (path) => path === "fixtures.json" ? FIXTURES : PROVENANCE,
      writePair: vi.fn(() => ({ jsonPath: "r.json", markdownPath: "r.md" })),
    });
    expect(exit).toBe(2);
  });
});
