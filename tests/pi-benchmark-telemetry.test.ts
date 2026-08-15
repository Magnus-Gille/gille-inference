import { describe, expect, it } from "vitest";

import {
  createPiBenchmarkTelemetry,
  observePiBenchmarkLine,
} from "../scripts/pi-benchmark-telemetry.js";

describe("Pi benchmark telemetry", () => {
  it("extracts content-blind agent metrics and assistant inference time", () => {
    const state = createPiBenchmarkTelemetry();
    const events: Array<[number, object]> = [
      [0, { type: "turn_start" }],
      [5, { type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "secret" }] } }],
      [15, { type: "message_update", delta: "secret" }],
      [35, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "secret" }] } }],
      [40, { type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: { path: "/private/repo" } }],
      [45, { type: "tool_execution_end", toolCallId: "read-1", toolName: "read", isError: false }],
      [50, { type: "turn_end", message: { usage: { input: 120, output: 30 } } }],
      [60, { type: "turn_start" }],
      [70, { type: "message_start", message: { role: "assistant" } }],
      [95, { type: "message_end", message: { role: "assistant" } }],
      [100, { type: "turn_end", message: { usage: { input: 150, output: 40 } } }],
    ];
    for (const [observedMs, event] of events) {
      observePiBenchmarkLine(state, JSON.stringify(event), observedMs);
    }

    expect(state.summary()).toEqual({
      turns: 2,
      toolCalls: 1,
      promptTokens: 270,
      completionTokens: 70,
      modelInferenceMs: 55,
      timedModelMessages: 2,
      unparseableLines: 0,
    });
    expect(JSON.stringify(state.summary())).not.toContain("secret");
    expect(JSON.stringify(state.summary())).not.toContain("/private/repo");
  });

  it("fails open to null timing while retaining counters for older Pi event streams", () => {
    const state = createPiBenchmarkTelemetry();
    observePiBenchmarkLine(state, "not-json", 1);
    observePiBenchmarkLine(state, JSON.stringify({ type: "turn_start" }), 2);
    observePiBenchmarkLine(state, JSON.stringify({
      type: "tool_execution_start",
      toolCallId: "bash-1",
      toolName: "bash",
    }), 3);
    observePiBenchmarkLine(state, JSON.stringify({
      type: "turn_end",
      message: { usage: { input: 10, output: 4 } },
    }), 4);

    expect(state.summary()).toEqual({
      turns: 1,
      toolCalls: 1,
      promptTokens: 10,
      completionTokens: 4,
      modelInferenceMs: null,
      timedModelMessages: 0,
      unparseableLines: 1,
    });
  });

  it("does not count incomplete or non-assistant message spans as model time", () => {
    const state = createPiBenchmarkTelemetry();
    observePiBenchmarkLine(state, JSON.stringify({ type: "message_start", message: { role: "user" } }), 10);
    observePiBenchmarkLine(state, JSON.stringify({ type: "message_end", message: { role: "user" } }), 20);
    observePiBenchmarkLine(state, JSON.stringify({ type: "message_start", message: { role: "assistant" } }), 30);

    expect(state.summary().modelInferenceMs).toBeNull();
    expect(state.summary().timedModelMessages).toBe(0);
  });
});
