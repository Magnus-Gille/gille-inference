import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const {
  createPiBenchmarkTelemetry,
  observePiBenchmarkLine,
} = await import(pathToFileURL(resolve(process.cwd(), "scripts/pi-benchmark-telemetry.ts")).href);

describe("hidden Pi telemetry contract", () => {
  it("separates the complete model turn from the post-first-event stream", () => {
    const telemetry = createPiBenchmarkTelemetry();
    const observe = (at: number, event: object): void => {
      observePiBenchmarkLine(telemetry, JSON.stringify(event), at);
    };

    observe(10, { type: "turn_start" });
    observe(11, { type: "message_start", message: { role: "user", content: "private prompt" } });
    observe(12, { type: "message_end", message: { role: "user", content: "private prompt" } });
    observe(30, { type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "private answer" }] } });
    observe(50, { type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: { path: "/private/path" } });
    observe(70, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "private answer" }] } });
    observe(90, { type: "turn_end", message: { usage: { input: 100, output: 25 } } });

    expect(telemetry.summary()).toEqual({
      turns: 1,
      toolCalls: 1,
      promptTokens: 100,
      completionTokens: 25,
      modelTurnMs: 60,
      timedModelTurns: 1,
      assistantStreamMs: 40,
      timedAssistantMessages: 1,
      unparseableLines: 0,
    });
    const visible = JSON.stringify(telemetry.summary());
    expect(visible).not.toContain("private");
    expect(visible).not.toContain("call-1");
  });

  it("keeps independently missing timing spans null and counts parse gaps", () => {
    const noStart = createPiBenchmarkTelemetry();
    observePiBenchmarkLine(noStart, "not-json", 1);
    observePiBenchmarkLine(noStart, JSON.stringify({ type: "turn_start" }), 10);
    observePiBenchmarkLine(noStart, JSON.stringify({ type: "message_end", message: { role: "assistant" } }), 45);
    expect(noStart.summary()).toMatchObject({
      modelTurnMs: 35,
      timedModelTurns: 1,
      assistantStreamMs: null,
      timedAssistantMessages: 0,
      unparseableLines: 1,
    });

    const incomplete = createPiBenchmarkTelemetry();
    observePiBenchmarkLine(incomplete, JSON.stringify({ type: "turn_start" }), 5);
    observePiBenchmarkLine(incomplete, JSON.stringify({ type: "message_start", message: { role: "assistant" } }), 20);
    expect(incomplete.summary()).toMatchObject({
      modelTurnMs: null,
      timedModelTurns: 0,
      assistantStreamMs: null,
      timedAssistantMessages: 0,
    });
  });
});
