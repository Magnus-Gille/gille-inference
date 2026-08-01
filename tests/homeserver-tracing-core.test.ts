import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface JoinFixture {
  trace_id: string;
  hugin_root_span_id: string;
  gateway_parent_span_id: string;
  gateway_span_id: string;
  version: string;
  flags: string;
  task_type: string;
  lane: string;
  retry_ordinal: number;
}

const fixture = JSON.parse(
  readFileSync(join(process.cwd(), "tests/fixtures/tracing/hugin-gateway-join-tuple.json"), "utf8"),
) as JoinFixture;

let runWithSyntheticTraceForTests: typeof import("../src/homeserver/tracing.js").runWithSyntheticTraceForTests;
let withTraceSpan: typeof import("../src/homeserver/tracing.js").withTraceSpan;
let currentTraceHeaders: typeof import("../src/homeserver/tracing.js").currentTraceHeaders;
let recordReadinessObservation: typeof import("../src/homeserver/tracing.js").recordReadinessObservation;
let recordCompletedSpan: typeof import("../src/homeserver/tracing.js").recordCompletedSpan;
let flushTracingForTests: typeof import("../src/homeserver/tracing.js").flushTracingForTests;
let setTracingTestHooks: typeof import("../src/homeserver/tracing.js").setTracingTestHooks;
let resetTracingTestHooks: typeof import("../src/homeserver/tracing.js").resetTracingTestHooks;

function stringifyRecords(records: readonly unknown[]): string {
  return JSON.stringify(records);
}

beforeEach(async () => {
  const tracing = await import("../src/homeserver/tracing.js");
  runWithSyntheticTraceForTests = tracing.runWithSyntheticTraceForTests;
  withTraceSpan = tracing.withTraceSpan;
  currentTraceHeaders = tracing.currentTraceHeaders;
  recordReadinessObservation = tracing.recordReadinessObservation;
  recordCompletedSpan = tracing.recordCompletedSpan;
  flushTracingForTests = tracing.flushTracingForTests;
  setTracingTestHooks = tracing.setTracingTestHooks;
  resetTracingTestHooks = tracing.resetTracingTestHooks;
  resetTracingTestHooks();
});

afterEach(() => {
  resetTracingTestHooks();
  vi.restoreAllMocks();
});

describe("content-blind tracing core", () => {
  it("joins the Hugin fixture, propagates W3C headers, and serializes only allowlisted fields", async () => {
    setTracingTestHooks({
      now: vi
        .fn<() => number>()
        .mockReturnValueOnce(Date.parse("2026-08-01T12:00:00Z"))
        .mockReturnValueOnce(Date.parse("2026-08-01T12:00:01Z"))
        .mockReturnValueOnce(Date.parse("2026-08-01T12:00:02Z"))
        .mockReturnValueOnce(Date.parse("2026-08-01T12:00:03Z"))
        .mockReturnValueOnce(Date.parse("2026-08-01T12:00:04Z"))
        .mockReturnValueOnce(Date.parse("2026-08-01T12:00:05Z"))
        .mockReturnValue(Date.parse("2026-08-01T12:00:06Z")),
      nextSpanId: vi
        .fn<() => string>()
        .mockReturnValueOnce(fixture.gateway_span_id)
        .mockReturnValueOnce("1111111111111111")
        .mockReturnValueOnce("2222222222222222"),
    });

    await runWithSyntheticTraceForTests(
      {
        traceparent: `${fixture.version}-${fixture.trace_id}-${fixture.gateway_parent_span_id}-${fixture.flags}`,
        taskType: fixture.task_type,
        lane: fixture.lane,
        retryOrdinal: fixture.retry_ordinal,
        release: "git-ff797087",
        instanceId: "test-gateway",
        exportEnabled: true,
      },
      async () => {
        const headers = currentTraceHeaders();
        expect(headers["traceparent"]).toBe(
          `${fixture.version}-${fixture.trace_id}-${fixture.gateway_span_id}-${fixture.flags}`,
        );
        await withTraceSpan(
          "inference",
          {
            taskType: fixture.task_type,
            lane: fixture.lane,
            retryOrdinal: fixture.retry_ordinal,
            modelArtifactIdentity: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          },
          async () => {
            recordCompletedSpan("ttft", {
              taskType: fixture.task_type,
              lane: fixture.lane,
              retryOrdinal: fixture.retry_ordinal,
              startedAtMs: Date.parse("2026-08-01T12:00:02Z"),
              endedAtMs: Date.parse("2026-08-01T12:00:03Z"),
              outcome: "ok",
            });
          },
        );
        recordReadinessObservation("gateway", "ok", {
          taskType: fixture.task_type,
          lane: fixture.lane,
          retryOrdinal: fixture.retry_ordinal,
        });
      },
      { outcome: "ok" },
    );

    const records = await flushTracingForTests();
    const spans = records.filter((record) => (record as { kind?: string }).kind === "trace-span") as Array<{
      trace_id: string;
      span_id: string;
      parent_span_id?: string;
      phase: string;
      task_type?: string;
      lane?: string;
      retry_ordinal?: number;
      release?: string;
      model_artifact_identity?: string;
    }>;
    expect(spans.map((span) => span.phase)).toEqual(expect.arrayContaining(["gateway", "inference", "ttft"]));
    expect(spans[0]?.trace_id).toBe(fixture.trace_id);
    expect(spans[0]?.span_id).toBe(fixture.gateway_span_id);
    expect(spans[0]?.parent_span_id).toBe(fixture.gateway_parent_span_id);
    expect(spans[0]?.task_type).toBe(fixture.task_type);
    expect(spans[0]?.lane).toBe(fixture.lane);
    expect(spans[0]?.retry_ordinal).toBe(fixture.retry_ordinal);
    expect(spans[0]?.release).toBe("git-ff797087");
    expect(spans.find((span) => span.phase === "inference")?.model_artifact_identity).toContain("sha256:");

    const readiness = records.find((record) => (record as { kind?: string }).kind === "service-observation") as
      | {
          outcome: string;
          slot_id: string;
          trace?: { trace_id: string; span_id: string };
        }
      | undefined;
    expect(readiness).toMatchObject({
      outcome: "ok",
      slot_id: "gateway-ready",
      trace: { trace_id: fixture.trace_id },
    });
  });

  it("treats malformed trace context as a safe new trace and never serializes private strings", async () => {
    setTracingTestHooks({
      now: vi
        .fn<() => number>()
        .mockReturnValueOnce(Date.parse("2026-08-01T13:00:00Z"))
        .mockReturnValueOnce(Date.parse("2026-08-01T13:00:01Z"))
        .mockReturnValueOnce(Date.parse("2026-08-01T13:00:02Z"))
        .mockReturnValue(Date.parse("2026-08-01T13:00:03Z")),
      nextTraceId: vi.fn<() => string>().mockReturnValue("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
      nextSpanId: vi
        .fn<() => string>()
        .mockReturnValueOnce("bbbbbbbbbbbbbbbb")
        .mockReturnValueOnce("cccccccccccccccc"),
      exporter: vi.fn(async () => {
        throw new Error("https://private.example/internal?token=secret");
      }),
    });

    await expect(
      runWithSyntheticTraceForTests(
        {
          traceparent: "malformed-parent",
          taskType: fixture.task_type,
          lane: fixture.lane,
          exportEnabled: true,
        },
        async () => {
          await expect(
            withTraceSpan(
              "inference",
              {
                taskType: fixture.task_type,
                lane: fixture.lane,
                errorClass: "upstream_timeout",
              },
              async () => {
                throw new Error("prompt=SECRET-PROMPT https://private.example/internal?token=secret");
              },
            ),
          ).rejects.toThrow("prompt=SECRET-PROMPT");
        },
        { outcome: "error", errorClass: "upstream_timeout" },
      ),
    ).resolves.toBeUndefined();

    const records = await flushTracingForTests();
    const joined = stringifyRecords(records);
    expect(joined).toContain("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(joined).not.toContain("SECRET-PROMPT");
    expect(joined).not.toContain("private.example");
    expect(joined).not.toContain("token=secret");
    expect(joined).not.toContain("stack");
    expect(joined).not.toContain("message");
    expect(joined).toContain("upstream_timeout");
  });
});
